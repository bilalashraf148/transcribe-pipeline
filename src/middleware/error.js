import { rmAudio } from '../paths.js';

/**
 * Terminal error handler. Express only recognises it with all four arguments,
 * so `_next` must stay even though it is unused.
 */
export function errorHandler(err, req, res, _next) {
  if (req.jobId) rmAudio(req.jobId); // don't leave partial uploads behind
  const status = err.code === 'LIMIT_FILE_SIZE' ? 413 : err.status || 500;
  res.status(status).json({ error: err.message });
}
