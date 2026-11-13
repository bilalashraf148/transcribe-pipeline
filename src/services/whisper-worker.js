import { parentPort, workerData } from 'node:worker_threads';
import { pipeline } from '@huggingface/transformers';

// Model is loaded once per worker thread, off the main event loop.
const asr = await pipeline('automatic-speech-recognition', workerData.model);
parentPort.postMessage({ type: 'ready' });

parentPort.on('message', async ({ id, pcm, language }) => {
  try {
    const opts = { return_timestamps: true, chunk_length_s: 30, stride_length_s: 5 };
    if (language) Object.assign(opts, { language, task: 'transcribe' });
    const out = await asr(pcm, opts);
    const segments = (out.chunks ?? [])
      .map((c) => {
        const start = c.timestamp[0] ?? 0;
        return { start, end: c.timestamp[1] ?? start, text: c.text.trim() };
      })
      .filter((s) => s.text);
    parentPort.postMessage({ id, segments });
  } catch (e) {
    parentPort.postMessage({ id, error: e.message });
  }
});
