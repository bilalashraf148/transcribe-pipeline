// End-to-end smoke test: generates audio with ffmpeg, runs the real server code.
// Usage: ENGINE=mock npm test   (or ENGINE=whisper for the real model)
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tp-'));
process.env.STORAGE_DIR = path.join(dir, 'storage');
process.env.CHUNK_SECONDS = '10'; // force multi-chunk on a short file
process.env.ENGINE ??= 'mock';

const { config } = await import('../src/config.js');
const { createEngine } = await import('../src/services/engine.js');
const { Queue } = await import('../src/services/queue.js');
const { buildApp } = await import('../src/server.js');
const { store } = await import('../src/db.js');

const gen = (name, args) => {
  const f = path.join(dir, name);
  execFileSync('ffmpeg', ['-v', 'error', '-y', ...args, f]);
  return f;
};
const wav = gen('a.wav', ['-f', 'lavfi', '-i', 'sine=frequency=440:duration=25']);
const mp3 = gen('b.mp3', ['-f', 'lavfi', '-i', 'sine=frequency=330:duration=6']);
const bad = path.join(dir, 'bad.mp3');
fs.writeFileSync(bad, 'this is not audio');

const engine = createEngine(config);
const queue = new Queue(engine);
queue.start();
const server = buildApp(queue).listen(0);
const base = `http://localhost:${server.address().port}/v1/transcriptions`;

const post = async (file, extra = {}, headers = {}) => {
  const fd = new FormData();
  fd.append('audio', new Blob([fs.readFileSync(file)]), path.basename(file));
  for (const [k, v] of Object.entries(extra)) fd.append(k, v);
  return fetch(base, { method: 'POST', body: fd, headers });
};
const wait = async (id) => {
  for (let i = 0; i < 600; i++) {
    const j = await (await fetch(`${base}/${id}`)).json();
    if (['completed', 'failed'].includes(j.status)) return j;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error('timeout');
};

try {
  // concurrent uploads of different formats
  const [r1, r2, r3] = await Promise.all([post(wav, {}, { 'Idempotency-Key': 'k1' }), post(mp3), post(bad)]);
  assert.equal(r1.status, 202);
  const [j1, j2, j3] = await Promise.all([r1, r2, r3].map(async (r) => wait((await r.json()).id)));

  assert.equal(j1.status, 'completed');
  assert.equal(j1.duration > 24 && j1.duration < 26, true);
  const starts = j1.segments.map((s) => s.start);
  assert.deepEqual(starts, [...starts].sort((a, b) => a - b), 'segments ordered across chunks');
  assert.equal(j2.status, 'completed');
  assert.equal(j3.status, 'failed'); // corrupt file: permanent, not retried
  assert.equal(j3.attempts, 1);

  // idempotency
  const dup = await post(wav, {}, { 'Idempotency-Key': 'k1' });
  assert.equal((await dup.json()).id, j1.id);

  // formats
  const srt = await (await fetch(`${base}/${j1.id}?format=srt`)).text();
  assert.match(srt, /^1\n00:00:00,000 --> /);
  assert.match(await (await fetch(`${base}/${j1.id}?format=vtt`)).text(), /^WEBVTT/);

  // validation + delete
  const r4 = await post(path.join(dir, 'a.wav'));
  assert.equal(r4.status, 202);
  assert.equal((await wait((await r4.json()).id)).status, 'completed'); // drain before teardown
  const txt = path.join(dir, 'x.txt');
  fs.writeFileSync(txt, 'hi');
  assert.equal((await post(txt)).status, 415);
  assert.equal((await fetch(`${base}/${j1.id}`, { method: 'DELETE' })).status, 204);
  assert.equal((await fetch(`${base}/${j1.id}`)).status, 404);

  console.log(`OK (engine=${config.engine})`);
  console.log(JSON.stringify(j1.segments.slice(0, 4), null, 1));
} finally {
  await queue.stop();
  await new Promise((resolve) => server.close(resolve)); // stop accepting new uploads
  await queue.idle(); // let anything already running finish writing
  await engine.close();
  store.close(); // release the SQLite handle, otherwise Windows refuses to delete the dir
  fs.rmSync(dir, { recursive: true, force: true });
  process.exit(process.exitCode ?? 0);
}
