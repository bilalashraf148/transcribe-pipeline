import { config } from '../config.js';
import { store } from '../db.js';

/** Liveness plus a small JSON metrics snapshot (both unauthenticated). */
export function healthController(queue) {
  return {
    health: (_req, res) => res.json({ ok: true }),
    metrics: (_req, res) =>
      res.json({ jobs: store.counts(), running: queue.running.size, concurrency: config.concurrency }),
  };
}
