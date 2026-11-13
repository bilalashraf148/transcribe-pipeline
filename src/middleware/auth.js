import { config } from '../config.js';

/** Opt-in API-key gate. Empty API_KEY means auth is disabled. */
export function apiKeyAuth(req, res, next) {
  if (config.apiKey && req.get('x-api-key') !== config.apiKey) {
    return res.status(401).json({ error: 'invalid or missing API key' });
  }
  next();
}
