import { spawn } from 'node:child_process';
import { PermanentError } from '../config.js';

function run(cmd, args) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args);
    const out = [];
    let err = '';
    p.stdout.on('data', (b) => out.push(b));
    p.stderr.on('data', (b) => (err += b));
    p.on('error', (e) => reject(new Error(`${cmd} failed to start: ${e.message}`))); // transient/infra
    p.on('close', (code) => resolve({ code, out: Buffer.concat(out), err }));
  });
}

/** Validate the file is decodable audio and return its duration in seconds. */
export async function probe(file) {
  const { code, out, err } = await run('ffprobe', [
    '-v', 'error', '-select_streams', 'a:0',
    '-show_entries', 'stream=codec_name:format=duration',
    '-of', 'json', file,
  ]);
  if (code !== 0) throw new PermanentError(`Not a valid media file: ${err.trim().slice(0, 200)}`);
  const info = JSON.parse(out.toString() || '{}');
  if (!info.streams?.length) throw new PermanentError('No audio stream found');
  const duration = parseFloat(info.format?.duration);
  if (!Number.isFinite(duration) || duration <= 0) throw new PermanentError('Could not determine audio duration');
  return { duration };
}

/**
 * Decode [start, start+length) of ANY supported format straight to
 * 16 kHz mono float32 PCM (what Whisper expects). No temp files; memory is
 * bounded by the chunk length (10 min ≈ 38 MB).
 */
export async function decodeSlice(file, start, length) {
  const { code, out, err } = await run('ffmpeg', [
    '-v', 'error', '-ss', String(Math.max(0, start)), '-t', String(length),
    '-i', file, '-vn', '-ac', '1', '-ar', '16000', '-f', 'f32le', 'pipe:1',
  ]);
  if (code !== 0) throw new PermanentError(`Decode failed: ${err.trim().slice(0, 200)}`);
  // copy into an aligned buffer so Float32Array is valid and transferable
  const pcm = new Float32Array(out.length >> 2);
  new Uint8Array(pcm.buffer).set(out.subarray(0, pcm.length * 4));
  return pcm;
}
