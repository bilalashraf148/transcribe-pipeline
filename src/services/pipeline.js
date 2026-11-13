import { config } from '../config.js';
import { store } from '../db.js';
import { audioFile } from '../paths.js';
import { probe, decodeSlice } from './audio.js';

/**
 * Process one job. Long audio is split into `chunkSeconds` pieces decoded on
 * demand. Each piece is decoded with a small overlap on both sides so words at
 * the boundary aren't cut; a segment is kept only by the piece that owns its
 * midpoint, which de-duplicates the overlap. Every finished piece is
 * checkpointed, so a retry resumes where it stopped.
 */
export async function processJob(job, engine) {
  const { chunkSeconds: C, overlapSeconds: O } = config;
  const file = audioFile(job);
  const { duration } = await probe(file);
  const total = Math.ceil(duration / C);
  store.setInfo(job.id, duration, total);

  const done = store.doneChunks(job.id);
  for (let idx = 0; idx < total; idx++) {
    if (done.has(idx)) continue;

    const start = idx * C;
    const end = Math.min(duration, start + C);
    const from = Math.max(0, start - O);
    const to = Math.min(duration, end + O);

    const pcm = await decodeSlice(file, from, to - from);
    const raw = pcm.length ? await engine.run(pcm, { language: job.language }) : [];

    const segments = raw
      .map((s) => ({ start: round(s.start + from), end: round(s.end + from), text: s.text }))
      .filter((s) => {
        const mid = (s.start + s.end) / 2;
        return mid >= start && (idx === total - 1 || mid < end);
      });

    store.saveChunk(job.id, idx, segments); // checkpoint
    store.heartbeat(job.id);
  }
}

const round = (n) => Math.round(n * 1000) / 1000;
