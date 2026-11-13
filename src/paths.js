import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';

/** Per-job directory holding the original upload. */
export const audioDir = (id) => path.join(config.storageDir, 'audio', id);

/**
 * Absolute path of a job's stored audio, derived rather than trusted.
 *
 * New rows store only the basename ("original.mp4"), so the path stays valid
 * when STORAGE_DIR or the whole project moves. Rows written before that change
 * hold an absolute path; those are still honoured. A missing value falls back
 * to the upload convention `original<ext>`.
 */
export function audioFile(job) {
  const stored = job.audio_path;
  if (stored && path.isAbsolute(stored)) return stored;
  if (stored) return path.join(audioDir(job.id), stored);
  return path.join(audioDir(job.id), 'original' + path.extname(job.original_name || '').toLowerCase());
}

/** Remove a job's audio directory. Safe to call twice, retries transient locks. */
export const rmAudio = (id) =>
  fs.rmSync(audioDir(id), { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
