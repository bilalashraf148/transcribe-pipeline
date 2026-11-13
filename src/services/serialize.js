import { store } from '../db.js';

export function serialize(job, { withSegments = true } = {}) {
  const out = {
    id: job.id,
    status: job.status,
    originalName: job.original_name,
    language: job.language,
    duration: job.duration,
    attempts: job.attempts,
    error: job.error,
    progress: job.total_chunks ? store.doneChunks(job.id).size / job.total_chunks : 0,
    // false => the upload is gone, so a re-run would need a fresh upload
    audioRetained: !job.audio_deleted_at,
    createdAt: new Date(job.created_at).toISOString(),
    updatedAt: new Date(job.updated_at).toISOString(),
  };
  if (job.status === 'completed' && withSegments) {
    out.segments = store.segments(job.id);
    out.text = out.segments.map((s) => s.text).join(' ');
  }
  return out;
}
