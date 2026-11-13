import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { config } from './config.js';

fs.mkdirSync(config.storageDir, { recursive: true });
const db = new Database(path.join(config.storageDir, 'jobs.db'));
db.pragma('journal_mode = WAL');

db.exec(`
CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY,
  status TEXT NOT NULL,              -- queued | processing | completed | failed
  original_name TEXT,
  audio_path TEXT NOT NULL,
  language TEXT,
  webhook_url TEXT,
  idempotency_key TEXT UNIQUE,
  duration REAL,
  total_chunks INTEGER,
  attempts INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  next_run_at INTEGER NOT NULL DEFAULT 0,
  heartbeat INTEGER,
  audio_deleted_at INTEGER,          -- set once the upload is removed from disk
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status, next_run_at);
-- one row per processed audio chunk = checkpoint; retries skip finished chunks
CREATE TABLE IF NOT EXISTS chunks (
  job_id TEXT NOT NULL,
  idx INTEGER NOT NULL,
  segments TEXT NOT NULL,
  PRIMARY KEY (job_id, idx)
);
`);

// Migration for databases created before audio cleanup existed.
const jobColumns = new Set(db.prepare('PRAGMA table_info(jobs)').all().map((c) => c.name));
if (!jobColumns.has('audio_deleted_at')) db.exec('ALTER TABLE jobs ADD COLUMN audio_deleted_at INTEGER');

const now = () => Date.now();
const q = (sql) => db.prepare(sql);

const stmts = {
  insert: q(`INSERT INTO jobs (id,status,original_name,audio_path,language,webhook_url,idempotency_key,created_at,updated_at)
             VALUES (@id,'queued',@original_name,@audio_path,@language,@webhook_url,@idempotency_key,@t,@t)`),
  get: q('SELECT * FROM jobs WHERE id = ?'),
  byKey: q('SELECT * FROM jobs WHERE idempotency_key = ?'),
  list: q('SELECT * FROM jobs WHERE (@status IS NULL OR status = @status) ORDER BY created_at DESC LIMIT @limit OFFSET @offset'),
  count: q('SELECT COUNT(*) AS n FROM jobs WHERE status = ?'),
  counts: q('SELECT status, COUNT(*) AS n FROM jobs GROUP BY status'),
  nextQueued: q(`SELECT id FROM jobs WHERE status='queued' AND next_run_at <= ? ORDER BY created_at LIMIT 1`),
  claim: q(`UPDATE jobs SET status='processing', attempts=attempts+1, heartbeat=@t, updated_at=@t WHERE id=@id AND status='queued'`),
  heartbeat: q('UPDATE jobs SET heartbeat=?, updated_at=? WHERE id=?'),
  setInfo: q('UPDATE jobs SET duration=?, total_chunks=?, updated_at=? WHERE id=?'),
  complete: q(`UPDATE jobs SET status='completed', error=NULL, updated_at=? WHERE id=?`),
  // Deliberately does not touch updated_at: cleanup is bookkeeping, not job progress.
  markAudioDeleted: q('UPDATE jobs SET audio_deleted_at=? WHERE id=?'),
  completedWithAudio: q('SELECT id FROM jobs WHERE status=\'completed\' AND audio_deleted_at IS NULL'),
  fail: q(`UPDATE jobs SET status='failed', error=?, updated_at=? WHERE id=?`),
  requeue: q(`UPDATE jobs SET status='queued', error=?, next_run_at=?, updated_at=? WHERE id=?`),
  manualRetry: q(`UPDATE jobs SET status='queued', attempts=0, error=NULL, next_run_at=0, updated_at=? WHERE id=? AND status='failed'`),
  stalled: q(`UPDATE jobs SET status='queued', error='recovered after worker stall', updated_at=@t
              WHERE status='processing' AND heartbeat < @cutoff AND id NOT IN (SELECT value FROM json_each(@running))`),
  recoverAll: q(`UPDATE jobs SET status='queued', error='recovered after restart', updated_at=? WHERE status='processing'`),
  saveChunk: q('INSERT OR REPLACE INTO chunks (job_id, idx, segments) VALUES (?,?,?)'),
  doneChunks: q('SELECT idx FROM chunks WHERE job_id = ?'),
  chunks: q('SELECT segments FROM chunks WHERE job_id = ? ORDER BY idx'),
  delJob: q('DELETE FROM jobs WHERE id = ?'),
  delChunks: q('DELETE FROM chunks WHERE job_id = ?'),
};

export const store = {
  createJob: (j) => stmts.insert.run({ webhook_url: null, language: null, idempotency_key: null, ...j, t: now() }),
  getJob: (id) => stmts.get.get(id),
  getByKey: (k) => stmts.byKey.get(k),
  listJobs: ({ status = null, limit = 20, offset = 0 }) => stmts.list.all({ status, limit, offset }),
  queuedCount: () => stmts.count.get('queued').n,
  counts: () => Object.fromEntries(stmts.counts.all().map((r) => [r.status, r.n])),

  /** Atomically move the oldest runnable job to 'processing'. */
  claimNext() {
    return db.transaction(() => {
      const row = stmts.nextQueued.get(now());
      if (!row) return null;
      stmts.claim.run({ id: row.id, t: now() });
      return stmts.get.get(row.id);
    })();
  },
  heartbeat: (id) => stmts.heartbeat.run(now(), now(), id),
  setInfo: (id, duration, chunks) => stmts.setInfo.run(duration, chunks, now(), id),
  complete: (id) => stmts.complete.run(now(), id),
  markAudioDeleted: (id) => stmts.markAudioDeleted.run(now(), id),
  completedWithAudio: () => stmts.completedWithAudio.all().map((r) => r.id),
  fail: (id, err) => stmts.fail.run(String(err).slice(0, 1000), now(), id),
  requeue: (id, err, runAt) => stmts.requeue.run(String(err).slice(0, 1000), runAt, now(), id),
  manualRetry: (id) => stmts.manualRetry.run(now(), id).changes > 0,
  recoverAll: () => stmts.recoverAll.run(now()).changes,
  recoverStalled: (runningIds, stallMs) =>
    stmts.stalled.run({ t: now(), cutoff: now() - stallMs, running: JSON.stringify([...runningIds]) }).changes,

  saveChunk: (id, idx, segments) => stmts.saveChunk.run(id, idx, JSON.stringify(segments)),
  doneChunks: (id) => new Set(stmts.doneChunks.all(id).map((r) => r.idx)),
  segments(id) {
    return stmts.chunks.all(id).flatMap((r) => JSON.parse(r.segments)).map((s, i) => ({ id: i, ...s }));
  },
  deleteJob: (id) => db.transaction(() => { stmts.delChunks.run(id); stmts.delJob.run(id); })(),

  /** Release the file handle (and checkpoint the WAL). Tests need this before deleting storage. */
  close: () => db.close(),
};
