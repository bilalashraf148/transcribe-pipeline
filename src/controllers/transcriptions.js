import crypto from 'node:crypto';
import path from 'node:path';
import { config } from '../config.js';
import { store } from '../db.js';
import { serialize } from '../services/serialize.js';
import { toSrt, toVtt } from '../services/format.js';
import { rmAudio } from '../paths.js';

/**
 * HTTP handlers for /v1/transcriptions. The queue is injected so these stay
 * free of module-level singletons and are trivially testable.
 */
export function transcriptionsController(queue) {
  return {
    /**
     * Cheap checks (idempotency replay, backpressure) run BEFORE the body is
     * consumed, so a rejected upload costs zero bytes.
     */
    preflight(req, res, next) {
      const key = req.get('idempotency-key');
      const existing = key && store.getByKey(key);
      if (existing) return res.status(200).json(serialize(existing, { withSegments: false }));
      if (store.queuedCount() >= config.maxQueue) {
        return res.status(429).set('Retry-After', '30').json({ error: 'queue full, retry later' });
      }
      req.jobId = crypto.randomUUID();
      next();
    },

    create(req, res) {
      if (!req.file) return res.status(400).json({ error: "multipart field 'audio' is required" });
      const { language, webhook_url } = req.body;
      if (webhook_url && !/^https?:\/\//i.test(webhook_url)) {
        rmAudio(req.jobId);
        return res.status(400).json({ error: 'webhook_url must be http(s)' });
      }
      store.createJob({
        id: req.jobId,
        original_name: req.file.originalname,
        // Basename only: the directory is derived from the job id, so the DB
        // stays valid when STORAGE_DIR or the project moves.
        audio_path: path.basename(req.file.path),
        language: language || null,
        webhook_url: webhook_url || null,
        idempotency_key: req.get('idempotency-key') || null,
      });
      queue.tick();
      res
        .status(202)
        .location(`/v1/transcriptions/${req.jobId}`)
        .json(serialize(store.getJob(req.jobId), { withSegments: false }));
    },

    list(req, res) {
      const limit = Math.min(+req.query.limit || 20, 100);
      const offset = +req.query.offset || 0;
      const jobs = store.listJobs({ status: req.query.status || null, limit, offset });
      res.json({ data: jobs.map((j) => serialize(j, { withSegments: false })), limit, offset });
    },

    get(req, res) {
      const job = store.getJob(req.params.id);
      if (!job) return res.status(404).json({ error: 'not found' });
      const fmt = req.query.format || 'json';
      if (fmt === 'json') return res.json(serialize(job));
      if (job.status !== 'completed') return res.status(409).json({ error: `job is ${job.status}` });
      const segs = store.segments(job.id);
      if (fmt === 'srt') return res.type('application/x-subrip').send(toSrt(segs));
      if (fmt === 'vtt') return res.type('text/vtt').send(toVtt(segs));
      res.status(400).json({ error: 'format must be json|srt|vtt' });
    },

    retry(req, res) {
      if (!store.manualRetry(req.params.id)) return res.status(409).json({ error: 'only failed jobs can be retried' });
      queue.tick();
      res.status(202).json(serialize(store.getJob(req.params.id), { withSegments: false }));
    },

    remove(req, res) {
      const job = store.getJob(req.params.id);
      if (!job) return res.status(404).json({ error: 'not found' });
      if (job.status === 'processing') return res.status(409).json({ error: 'job is processing' });
      rmAudio(job.id);
      store.deleteJob(job.id);
      res.status(204).end();
    },
  };
}
