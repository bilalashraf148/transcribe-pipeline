import './env.js'; // must stay first: populates process.env before config.js loads
import express from 'express';
import { pathToFileURL } from 'node:url';
import { config } from './config.js';
import { createEngine } from './services/engine.js';
import { Queue } from './services/queue.js';
import { buildRouter, mountHealth } from './routes.js';
import { errorHandler } from './middleware/error.js';

/**
 * Assemble the Express app. The queue is injected, so the app can be built in
 * tests without spawning workers or binding a port.
 */
export function buildApp(queue) {
  const app = express();

  mountHealth(app, queue); // unauthenticated: /health, /metrics
  app.use('/v1', buildRouter(queue));
  app.use(errorHandler);

  return app;
}

// ---- boot
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const engine = createEngine(config);
  const queue = new Queue(engine);
  queue.start();
  const server = buildApp(queue).listen(config.port, () =>
    console.log(`listening on :${config.port} (engine=${config.engine}, concurrency=${config.concurrency})`));

  const shutdown = async () => {
    await queue.stop();
    server.close();
    await engine.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
