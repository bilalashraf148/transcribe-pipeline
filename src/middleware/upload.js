import fs from 'node:fs';
import path from 'node:path';
import multer from 'multer';
import { config } from '../config.js';
import { audioDir } from '../paths.js';

// ---- upload: streamed straight to its final location, never buffered in RAM
export const upload = multer({
  limits: { fileSize: config.maxFileBytes, files: 1 },
  storage: multer.diskStorage({
    destination(req, _file, cb) {
      fs.mkdirSync(audioDir(req.jobId), { recursive: true });
      cb(null, audioDir(req.jobId));
    },
    filename: (_req, file, cb) => cb(null, 'original' + path.extname(file.originalname).toLowerCase()),
  }),
  fileFilter(_req, file, cb) {
    const ok = config.allowedExt.has(path.extname(file.originalname).toLowerCase());
    cb(ok ? null : Object.assign(new Error('Unsupported file type'), { status: 415 }), ok);
  },
});
