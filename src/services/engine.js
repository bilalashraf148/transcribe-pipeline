import { Worker } from 'node:worker_threads';

/** Deterministic fake engine for tests / demos (no model download). */
class MockEngine {
  async run(pcm) {
    const secs = pcm.length / 16000;
    const segs = [];
    for (let t = 0, i = 0; t < secs; t += 5, i++) {
      segs.push({ start: t, end: Math.min(t + 5, secs), text: `mock segment ${i}` });
    }
    return segs;
  }
  async close() {}
}

/** Pool of worker threads, each holding one loaded Whisper model. */
class WhisperPool {
  constructor(size, model) {
    this.model = model;
    this.slots = Array.from({ length: size }, () => this.spawn());
    this.waiters = [];
    this.seq = 0;
  }

  spawn() {
    const slot = { busy: false, pending: null };
    slot.worker = new Worker(new URL('./whisper-worker.js', import.meta.url), { workerData: { model: this.model } });
    slot.ready = new Promise((resolve, reject) => {
      slot.worker.once('message', (m) => m.type === 'ready' && resolve());
      slot.worker.once('error', reject);
    });
    slot.worker.on('message', (m) => {
      if (m.type === 'ready' || !slot.pending) return;
      const { resolve, reject } = slot.pending;
      slot.pending = null;
      m.error ? reject(new Error(m.error)) : resolve(m.segments);
    });
    slot.worker.on('exit', () => {
      // crash => fail the in-flight call (retryable) and replace the worker
      slot.pending?.reject(new Error('whisper worker crashed'));
      slot.pending = null;
      const i = this.slots.indexOf(slot);
      if (i >= 0 && !this.closed) this.slots[i] = this.spawn();
    });
    slot.worker.on('error', () => {});
    return slot;
  }

  acquire() {
    const free = this.slots.find((s) => !s.busy);
    if (free) { free.busy = true; return Promise.resolve(free); }
    return new Promise((res) => this.waiters.push(res));
  }

  release(slot) {
    const next = this.waiters.shift();
    if (next) next(slot); else slot.busy = false;
  }

  async run(pcm, { language } = {}) {
    const slot = await this.acquire();
    try {
      await slot.ready;
      return await new Promise((resolve, reject) => {
        slot.pending = { resolve, reject };
        slot.worker.postMessage({ id: ++this.seq, pcm, language }, [pcm.buffer]); // zero-copy
      });
    } finally {
      this.release(slot);
    }
  }

  async close() {
    this.closed = true;
    await Promise.all(this.slots.map((s) => s.worker.terminate()));
  }
}

export function createEngine(config) {
  return config.engine === 'mock' ? new MockEngine() : new WhisperPool(config.concurrency, config.model);
}
