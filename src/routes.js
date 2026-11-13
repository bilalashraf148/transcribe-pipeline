import express from 'express';
import { apiKeyAuth } from './middleware/auth.js';
import { upload } from './middleware/upload.js';
import { healthController } from './controllers/health.js';
import { transcriptionsController } from './controllers/transcriptions.js';

/**
 * Route table. Kept separate from the app so the wiring is readable in one
 * screen and `buildApp` stays free of route details.
 */
export function buildRouter(queue) {
  const v1 = express.Router();
  const tx = transcriptionsController(queue);

  v1.use(apiKeyAuth);

  v1.post('/transcriptions', tx.preflight, upload.single('audio'), tx.create);
  v1.get('/transcriptions', tx.list);
  v1.get('/transcriptions/:id', tx.get);
  v1.post('/transcriptions/:id/retry', tx.retry);
  v1.delete('/transcriptions/:id', tx.remove);

  return v1;
}

export function mountHealth(app, queue) {
  const { health, metrics } = healthController(queue);
  app.get('/health', health);
  app.get('/metrics', metrics);
}
