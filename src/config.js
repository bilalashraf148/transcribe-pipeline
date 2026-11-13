import path from 'node:path';

const env = process.env;
const num = (v, d) => (Number.isFinite(+v) && v !== undefined && v !== '' ? +v : d);

export const config = {
  port: num(env.PORT, 3000),
  apiKey: env.API_KEY || '', // empty = auth disabled
  storageDir: path.resolve(env.STORAGE_DIR || 'storage'),
  engine: env.ENGINE || 'whisper', // 'whisper' | 'mock'
  model: env.WHISPER_MODEL || 'Xenova/whisper-tiny',
  concurrency: num(env.CONCURRENCY, 2),
  maxQueue: num(env.MAX_QUEUE, 100),
  maxAttempts: num(env.MAX_ATTEMPTS, 4),
  maxFileBytes: num(env.MAX_FILE_MB, 500) * 1e6,
  chunkSeconds: num(env.CHUNK_SECONDS, 600),
  overlapSeconds: 2,
  stallSeconds: 60,
  // Delete the upload as soon as its transcript is finished. Failed jobs keep
  // their audio so a retry can resume from the last checkpoint.
  deleteAudioOnComplete: env.DELETE_AUDIO_ON_COMPLETE !== 'false',
  webhookSecret: env.WEBHOOK_SECRET || '',
  allowedExt: new Set(['.wav', '.mp3', '.m4a', '.flac', '.ogg', '.opus', '.aac', '.webm', '.mp4', '.mov', '.aiff']),
};

export class PermanentError extends Error {
  constructor(msg) {
    super(msg);
    this.permanent = true; // never retried
  }
}
