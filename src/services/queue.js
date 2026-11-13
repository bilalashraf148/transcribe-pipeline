import crypto from 'node:crypto';
import { config } from '../config.js';
import { store } from '../db.js';
import { rmAudio } from '../paths.js';
import { processJob } from './pipeline.js';
import { serialize } from './serialize.js';

/**
 * SQLite-backed job queue. State lives in the DB, so jobs survive restarts.
 * (For multiple machines, swap this for BullMQ/Redis; the rest is unchanged.)
 */
export class Queue {
  constructor(engine) {
    this.engine = engine;
    this.running = new Set();
    this.pending = new Set(); // promises for in-flight jobs, so shutdown can wait
    this.stopping = false;
  }

  start() {
    const n = store.recoverAll(); // jobs left 'processing' by a crash/restart
    if (n) console.log(`recovered ${n} interrupted job(s)`);
    this.sweepAudio(); // completed before the last shutdown, but audio still on disk
    this.timer = setInterval(() => {
      store.recoverStalled(this.running, config.stallSeconds * 1000);
      this.tick();
    }, 1000);
    this.tick();
  }

  tick() {
    while (!this.stopping && this.running.size < config.concurrency) {
      const job = store.claimNext();
      if (!job) break;
      this.run(job);
    }
  }

  async run(job) {
    const p = this.execute(job);
    this.pending.add(p);
    p.then(() => this.pending.delete(p), () => this.pending.delete(p));
    return p;
  }

  async execute(job) {
    this.running.add(job.id);
    const hb = setInterval(() => store.heartbeat(job.id), 5000);
    try {
      await processJob(job, this.engine);
      store.complete(job.id); // durable first: a crash here leaks one file, never a transcript
      this.discardAudio(job.id);
      this.notify(job.id);
    } catch (err) {
      const give_up = err.permanent || job.attempts >= config.maxAttempts;
      if (give_up) {
        store.fail(job.id, err.message); // dead-letter: stays 'failed' until POST /:id/retry
        console.error(`job ${job.id} failed permanently: ${err.message}`);
        this.notify(job.id);
      } else {
        const backoff = Math.min(2 ** job.attempts * 1000, 60000) * (0.5 + Math.random() / 2); // jitter
        store.requeue(job.id, err.message, Date.now() + backoff);
        console.warn(`job ${job.id} attempt ${job.attempts} failed (${err.message}); retry in ${Math.round(backoff)}ms`);
      }
    } finally {
      clearInterval(hb);
      this.running.delete(job.id);
      this.tick();
    }
  }

  /**
   * Delete a completed job's upload. Best-effort: the transcript is already
   * durable, so a locked file (Defender, an open handle) must never fail the
   * job. The row is marked only once the directory is actually gone, so the
   * boot sweep retries whatever this could not remove.
   */
  discardAudio(id) {
    if (!config.deleteAudioOnComplete) return;
    try {
      rmAudio(id);
      store.markAudioDeleted(id);
    } catch (err) {
      console.warn(`could not delete audio for ${id}: ${err.message}`);
    }
  }

  /** Finish cleanup for jobs completed before a crash, or before the flag was enabled. */
  sweepAudio() {
    if (!config.deleteAudioOnComplete) return;
    const ids = store.completedWithAudio();
    if (ids.length) console.log(`removing audio for ${ids.length} completed job(s)`);
    for (const id of ids) this.discardAudio(id);
  }

  /** Best-effort signed webhook on terminal states. */
  async notify(id) {
    const job = store.getJob(id);
    if (!job?.webhook_url) return;
    const body = JSON.stringify(serialize(job, { withSegments: false }));
    const headers = { 'content-type': 'application/json' };
    if (config.webhookSecret) {
      headers['x-signature'] = crypto.createHmac('sha256', config.webhookSecret).update(body).digest('hex');
    }
    try {
      await fetch(job.webhook_url, { method: 'POST', headers, body, signal: AbortSignal.timeout(10000) });
    } catch (e) {
      console.warn(`webhook for ${id} failed: ${e.message}`);
    }
  }

  /** Resolves once every in-flight job has settled (used by tests before closing the DB). */
  idle() {
    return Promise.allSettled([...this.pending]).then(() => {});
  }

  async stop() {
    this.stopping = true;
    clearInterval(this.timer);
    // interrupted jobs are re-queued from their checkpoints on next start
  }
}
