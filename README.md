# transcribe-pipeline

Local speech-to-text service: upload an audio or video file, get back a transcript with
per-segment timestamps, as JSON, SRT or VTT.

Built on [Transformers.js](https://github.com/huggingface/transformers.js) running Whisper in
worker threads, with ffmpeg for format normalisation, a SQLite-backed job queue, and Express for
the HTTP surface.

---

## Highlights

- **Any common format in** — WAV, MP3, M4A, FLAC, OGG, Opus, AAC, WebM, MP4, MOV, AIFF. Video
  containers work too; only the audio stream is used.
- **Async by default** — `POST` returns `202` with a job id immediately; the client polls.
- **Timestamps** — every segment carries `start`/`end` in seconds, and the full result renders to
  SRT or VTT on demand.
- **Long files** — audio is decoded in 600-second slices with overlap, so memory stays flat
  regardless of file length.
- **Crash-safe** — each slice is checkpointed; a retry or restart resumes at the first unfinished
  slice instead of starting over.
- **Retries with a brain** — transient failures back off exponentially with jitter; corrupt media
  fails immediately and is never retried.
- **No audio hoarding** — the upload is deleted as soon as its transcript is stored, so disk usage
  settles back to the size of the database. Failed jobs keep their file for `retry`.

---

## Requirements

| Requirement | Notes |
|---|---|
| **Node.js ≥ 20** | Developed on Node 26 |
| **ffmpeg + ffprobe on PATH** | Used for probing, decoding and chunking. Must be the executables, not just installed |
| Disk | Uploads land in `storage/`; model weights cache under `node_modules/` (~150 MB for `whisper-tiny`, ~1 GB for `small`) |
| Network | First run only, to download model weights from Hugging Face |

No Redis, no Postgres, no object storage. The queue is a SQLite table and the upload stays on local
disk only until its transcript is written — everything runs in one process.

Windows install:

```powershell
winget install --id OpenJS.NodeJS.LTS -e
winget install --id Gyan.FFmpeg -e
# open a new terminal so PATH refreshes
```

---

## Quick start

```bash
npm install
cp .env.example .env     # optional; every value has a default
npm start
```

> On Windows PowerShell, `curl` is an alias for `Invoke-WebRequest` — use `curl.exe` for the
> multipart examples below, and `npm.cmd` if script execution is restricted.

```
listening on :3000 (engine=whisper, concurrency=2)
```

Transcribe something:

```bash
curl -X POST http://127.0.0.1:3000/v1/transcriptions \
  -F "audio=@test/fixtures/speech-7s.mp4"
```

```json
{
  "id": "f878624f-0061-4164-b9a4-5ed65e813907",
  "status": "processing",
  "originalName": "speech-7s.mp4",
  "language": null,
  "duration": null,
  "attempts": 1,
  "error": null,
  "progress": 0,
  "audioRetained": true,
  "createdAt": "2026-11-13T10:07:16.455Z",
  "updatedAt": "2026-11-13T10:07:16.455Z"
}
```

The dispatcher claims the job synchronously before responding, so a `202` body is usually already
`processing` with `attempts: 1` rather than `queued`.

Poll until `status` is `completed` or `failed`:

```bash
curl http://127.0.0.1:3000/v1/transcriptions/f878624f-0061-4164-b9a4-5ed65e813907
```

```json
{
  "id": "f878624f-0061-4164-b9a4-5ed65e813907",
  "status": "completed",
  "originalName": "speech-7s.mp4",
  "language": null,
  "duration": 7.073733,
  "attempts": 1,
  "error": null,
  "progress": 1,
  "audioRetained": false,
  "segments": [
    { "id": 0, "start": 0, "end": 3.72, "text": "Despite working out five times a week and counting my calories, those pesky sugar cravings" },
    { "id": 1, "start": 3.72, "end": 7.08, "text": "would randomly creep in and one cookie would spiral into a huge binge." }
  ],
  "text": "Despite working out five times a week and counting my calories, those pesky sugar cravings would randomly creep in and one cookie would spiral into a huge binge."
}
```

`audioRetained: false` on a completed job means the upload was deleted; the transcript is the
permanent artifact, so transcribing the same media again requires a fresh upload.

Subtitles:

```bash
curl "http://127.0.0.1:3000/v1/transcriptions/<id>?format=srt" -o out.srt
curl "http://127.0.0.1:3000/v1/transcriptions/<id>?format=vtt" -o out.vtt
```

The HTTP server starts listening immediately, but the worker threads load the model in the
background right after boot — a request that lands before they are ready simply waits. The weights
are cached on disk, so that cost is once per boot, not per job.

---

## Configuration

`.env` is loaded automatically at startup (`src/env.js`, imported first by `src/server.js`).
Real environment variables always win over the file, so a one-off override needs no edit:

```bash
PORT=4200 npm start
```

| Variable | Default | Description |
|---|---|---|
| `PORT` | `3000` | HTTP port. `0` picks a free port |
| `API_KEY` | *(empty)* | When set, `/v1/*` requires `x-api-key`. Empty disables auth |
| `STORAGE_DIR` | `storage` | Root for `jobs.db` and uploaded audio. Relative to the working directory |
| `ENGINE` | `whisper` | `whisper` for the real model, `mock` for deterministic fake output |
| `WHISPER_MODEL` | `Xenova/whisper-tiny` | Hugging Face id. `tiny` → `base` → `small` → `medium` as accuracy/RAM rise |
| `CONCURRENCY` | `2` | Parallel jobs **and** worker threads. Each thread holds its own model copy, so memory is the real limit |
| `MAX_FILE_MB` | `500` | Upload cap; larger requests get `413` |
| `MAX_QUEUE` | `100` | Queued-job cap; beyond it new uploads get `429` |
| `MAX_ATTEMPTS` | `4` | Total attempts before a job is marked `failed` |
| `CHUNK_SECONDS` | `600` | Slice size for decoding and checkpointing. Keep stable across retries — checkpoints are keyed by slice index |
| `DELETE_AUDIO_ON_COMPLETE` | `true` | Remove the upload as soon as its transcript is stored. Failed jobs keep theirs so `retry` can resume. Any value other than `false` means on |
| `WEBHOOK_SECRET` | *(empty)* | HMAC-SHA256 key for signing webhook bodies |

Fixed, not configurable: 2 s decode overlap, 60 s stall timeout, and the extension whitelist
(`.wav .mp3 .m4a .flac .ogg .opus .aac .webm .mp4 .mov .aiff`).

---

## API

Base path `/v1`. All errors are `{ "error": "message" }`.

| Method | Path | Description |
|---|---|---|
| `POST` | `/v1/transcriptions` | Multipart upload (`audio` field). `202` + `Location`, or `200` on an idempotent replay |
| `GET` | `/v1/transcriptions` | List, newest first. `?limit=20&offset=0&status=completed` |
| `GET` | `/v1/transcriptions/:id` | Job status/progress, plus `segments` and `text` once completed |
| `GET` | `/v1/transcriptions/:id?format=srt\|vtt` | Subtitle rendering. `409` if not completed |
| `POST` | `/v1/transcriptions/:id/retry` | Requeue a `failed` job; resumes from its checkpoint |
| `DELETE` | `/v1/transcriptions/:id` | Remove audio and rows. `409` while processing |
| `GET` | `/health` | `{"ok":true}` |
| `GET` | `/metrics` | `{"jobs":{...},"running":0,"concurrency":2}` |

### `POST /v1/transcriptions`

| Field | Required | Description |
|---|---|---|
| `audio` | yes | The file. Streamed straight to disk, never buffered in memory |
| `language` | no | ISO code hint, e.g. `en`. Omit to let Whisper auto-detect |
| `webhook_url` | no | `http(s)` URL notified on terminal states |

Optional header `Idempotency-Key`: the same key returns the original job (`200`) instead of
creating a duplicate.

Status codes: `202` accepted · `400` missing `audio` field or bad `webhook_url` · `413` too large ·
`415` unsupported extension · `429` queue full (with `Retry-After`) · `401` bad API key.

### Webhooks

On `completed` and `failed`, the service POSTs the job JSON (without segments) to `webhook_url`.
When `WEBHOOK_SECRET` is set, the body is signed:

```
x-signature: HMAC-SHA256(secret, rawRequestBody)
```

Best-effort, single attempt, 10 s timeout.

### Output formats

Both are rendered on demand from the same stored segments, so they never drift from the JSON.

```srt
1
00:00:00,000 --> 00:00:03,720
Despite working out five times a week and counting my calories, those pesky sugar cravings

2
00:00:03,720 --> 00:00:07,080
would randomly creep in and one cookie would spiral into a huge binge.
```

```vtt
WEBVTT

00:00:00.000 --> 00:00:03.720
Despite working out five times a week and counting my calories, those pesky sugar cravings
```

SRT uses a comma for milliseconds and requires cue numbers; VTT uses a dot, needs the `WEBVTT`
header and has no numbers — but it is the only format an HTML5 `<track>` element accepts.

---

## How it works

```
POST /v1/transcriptions
        │  multer → storage/audio/<jobId>/original.<ext>   (streamed, never in RAM)
        ▼
   jobs row (queued)  ──►  Queue.tick()
                             │  atomic claim: SELECT … WHERE status='queued'
                             ▼
                        processJob()
                             │  1. ffprobe  → validate, read duration
                             │  2. for each 600 s slice:
                             │       ffmpeg -ss … -t … → 16 kHz mono f32 PCM on stdout
                             │       engine.run(pcm)  → worker thread → Whisper
                             │       keep segments whose midpoint falls in this slice
                             │       INSERT OR REPLACE chunks(job_id, idx, segments)   ← checkpoint
                             ▼
                     completed / failed  ──►  optional webhook
                             │
                             └─ completed: rm -rf storage/audio/<jobId>  ──►  audio_deleted_at
```

**One conversion, every format.** ffmpeg normalises to 16 kHz mono float32 PCM — exactly what
Whisper expects — so nothing downstream knows or cares what the original container was. `ffprobe`
runs first to reject files that aren't decodable media and to read the duration.

**Two layers of chunking.** ffmpeg slices the file into 600 s pieces so memory is bounded and a
checkpoint is cheap. Inside each piece, Transformers.js uses Whisper's own 30 s windows with a 5 s
stride and merges the overlap. Different jobs: one protects the process, the other matches the
model's receptive field.

**Overlap without duplication.** Each slice is decoded with 2 s of padding on both sides, then a
segment is kept only by the slice that owns its midpoint. That prevents words being cut at
boundaries without emitting them twice.

**Inference off the event loop.** `CONCURRENCY` worker threads each load the model once and
receive PCM via a transfer list (zero-copy).

**The upload is temporary.** multer writes it to `storage/audio/<jobId>/original.<ext>`, and the
`audio_path` column records only that basename — the full path is derived from the job id, so the
database keeps working when the project or `STORAGE_DIR` moves. On completion the directory is
removed and `audio_deleted_at` is stamped. If the process dies between those two steps, the boot
sweep removes the leftover. Failed jobs keep their audio so `retry` can resume.

### State machine and recovery

```
queued ──claim──► processing ──► completed
  ▲                   │
  └──requeue/backoff──┤
                      └────────► failed ──POST /:id/retry──► queued
```

| Failure | Handling |
|---|---|
| Corrupt/unsupported media, no audio stream | `PermanentError` → immediate `failed`, `attempts=1` |
| ffmpeg spawn failure, worker crash, timeouts | Retried: `min(2^attempts s, 60 s)` with jitter |
| Worker died mid-job (stale heartbeat > 60 s) | Sweeper requeues it |
| Process restart | Every `processing` job is requeued at boot |
| Retry of a partially done job | Resumes at the first slice with no checkpoint |
| Audio can't be deleted (file locked) | Job still completes; the boot sweep retries it |

`failed` is the dead-letter state: it stays there until `POST /:id/retry` (which resets attempts
but keeps checkpoints) or `DELETE`.

---

## Project layout

```
src/
  server.js              app assembly + boot
  routes.js              route table
  env.js                 dotenv loader (must be imported first)
  config.js              env parsing, PermanentError
  db.js                  SQLite schema + queries (the persistence seam)
  paths.js               audioDir / audioFile / rmAudio
  controllers/           HTTP handlers: health, transcriptions
  middleware/            auth (x-api-key), upload (multer), error
  services/              domain logic, no req/res anywhere
    engine.js            worker-thread pool + mock engine
    queue.js             claim, retry/backoff, stall recovery, audio cleanup, webhooks
    pipeline.js          probe → slice → transcribe → checkpoint
    audio.js             ffprobe + ffmpeg decode-to-pipe
    serialize.js         job → API shape
    format.js            SRT / VTT
    whisper-worker.js    worker entry, loads the model
test/
  smoke.js               end-to-end over HTTP
  fixtures/              real audio (wav, mp3, mp4) + a .txt for the 415 case
postman/                 importable collection + environment
```

Controllers are factory functions that take the queue as an argument, so they can be exercised with
a fake `{ tick(){}, running: new Set() }` and no model.

---

## Testing

```bash
npm test                 # ENGINE defaults to mock
```

Generates audio with ffmpeg, then drives the real HTTP server: concurrent uploads of different
formats, segment ordering across slices, corrupt file → `failed` with `attempts=1`, idempotent
replay, SRT/VTT rendering, extension rejection, and delete.

The corrupt-file case prints the expected ffprobe error to stderr; the command still exits `0`.

Against the real model:

```bash
ENGINE=whisper npm test        # PowerShell: $env:ENGINE='whisper'; npm.cmd test
```

**Postman:** import `postman/transcribe-pipeline.postman_collection.json` and
`postman/transcribe-pipeline.postman_environment.json`, select the *Transcribe Pipeline - Local*
environment, and run the collection. `POST` captures the job id into `{{jobId}}` automatically;
the polling request re-schedules itself until the job finishes.

---

## Performance notes

CPU-only is the expected setup. Measured on a 12-thread Intel machine with `whisper-tiny` once the
model is resident: a 7 s clip completes in a few seconds, an 18 s clip in about 12 s. Startup is
fast (the listener is up immediately) but the first request waits for the model to load.

- `tiny`/`base` are usable on CPU; `small` is roughly real-time; `medium` needs a GPU.
- `CONCURRENCY` above 2 will usually hurt on a 16 GB machine — each worker holds its own model.
- Bump `API_KEY`, lower `MAX_QUEUE`, and keep `CONCURRENCY` ≤ physical cores if you expose this
  beyond localhost.

---

## Known limitations

Deliberately out of scope for this build, listed so nothing is overstated:

- **`language` is not detected.** The field echoes the request value; auto-detect leaves it `null`.
- **No timeout on ffmpeg.** A pathological file can hold a slot indefinitely; the heartbeat keeps
  the job from being reaped as stalled.
- **Worker replies aren't correlated** by message id, so a late result from a crashed call could in
  principle resolve a newer one.
- **`progress` is coarse** — it counts finished 600 s slices, so short files jump `0 → 1`.
- **Single node.** SQLite and local disk; boot-time recovery assumes one process owns the database.
- **No rate limiting** beyond the queue-depth `429`. One API key, no per-user scoping.
- **No DLQ store or alerting** — `failed` is terminal until manually retried.
- **Webhooks are best-effort**: one attempt, and the URL is only scheme-checked (no SSRF guard).
- **Re-transcribing needs a re-upload.** Audio is deleted on completion (unless
  `DELETE_AUDIO_ON_COMPLETE=false`), so there is no endpoint that re-runs a finished job against a
  different model or language hint. Failed jobs are the exception: they keep their audio for
  `retry`.
- **No OpenAPI spec and no SSE**; polling only.
- SRT is emitted with LF line endings.
- Changing `CHUNK_SECONDS` invalidates existing checkpoints for unfinished jobs.

The natural next steps are the ones above, in roughly that order.
