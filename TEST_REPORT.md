# E2E audit report — 2026-10-13

## Smart Queue / Resume addendum — 2026-10-13

The Edge TTS flow now has a single local queue (`concurrency=1`, 5,000 ms
minimum interval, 8 requests/minute by default), durable per-fragment cache,
and atomic manifest progress. A real Docker smoke run synthesized one safe
example fragment, stored it under `cache/tts/<sha256>/`, and produced a valid
MP3: FFprobe reported MP3 / 5.160 seconds and FFmpeg decoded it without error.
Its immediate repeat used the final cache (`created: 0`, `skipped: 1`).

The current regression suite has 25 passing tests locally and in Docker. Mock
tests cover: HTTP 429 on fragment 6 after five saved fragments, no later
requests after pause, automatic resume using those five cached fragments,
corrupt-cache rejection, changed voice/rate rejection, queue pacing and local
rate limit, and atomic paused manifest state. No large user book was
synthesized for this addendum.

## Scope and safety

The audit was run without deleting or overwriting user source documents, existing audio files, models, or backups.  The full FB2 book was analysed only; it was **not** synthesized, because a full-book synthesis is an external-service load and requires explicit confirmation.

## Result summary

| Area | Result | Evidence |
|---|---|---|
| Node.js project | PASS | Node `v24.14.0` on host; Node `v22.23.3` in Docker |
| Python application runtime | PASS | Docker check printed `PYTHON_ABSENT` |
| Unit/regression tests | PASS | 18/18 passed locally and in Docker |
| TXT / Markdown / FB2 / FB2.ZIP | PASS | Parser tests passed |
| PDF text layer / cache / damaged-PDF / no-text layer | PASS | PDF tests passed |
| Real PDF analysis | PASS | `g.pdf`: 64 pages, 22 blocks, 222,418 extracted characters (cached metadata) |
| Edge TTS connectivity | PASS at test time | DNS, TLS 1.3, WebSocket `101`, synthesis passed |
| Real multi-fragment synthesis | PASS | PDF block 2: 1,064 chars → 3 fragments → valid MP3 |
| Final MP3 validation | PASS | FFprobe: MP3, 85.008 seconds; FFmpeg decode exit code 0 |
| Cache reuse | PASS | second identical run: `created: 0`, `skipped: 1` |
| Docker / Compose / BAT | PASS | image builds; `start-docker.bat --only g.pdf --analyze-only` completed |
| Local Windows FFmpeg | BLOCKED | `ffmpeg` is not on host PATH; Docker path is working |

## Changes made during this audit

- Added `src/integrity.mjs`. The generator now verifies that whitespace-normalized block text exactly equals the concatenated TTS fragment text before any request is sent.
- Added `src/cache.mjs`. A file is reused only when FFprobe marks it valid and its filename, text hash, and generation-settings hash all match the manifest. Missing, invalid, changed-text, changed-voice/rate, or renamed output is regenerated.
- Added explicit FB2.ZIP safeguards: at most 100 archive entries, at most 50 MiB of uncompressed FB2 data, and maximum compression ratio 100. Unsafe archives are rejected before decompression.
- Improved the FFmpeg/FFprobe preflight message. On a host without FFmpeg the program stops before Edge TTS requests and directs the user to Docker or installation.
- Added regression coverage for Russian segmentation integrity, cache invalidation decisions, Edge error categories, and unsafe ZIP compression.
- Included the `test/` directory in Docker so `npm test` is runnable inside the built image.

## Commands run

```powershell
npm test
docker compose build voice-over
docker compose run --rm --entrypoint npm voice-over test
docker compose run --rm voice-over --only g.pdf --only-block 2 --max-chars 500
docker compose run --rm --entrypoint sh voice-over -c "ffprobe ... && ffmpeg ..."
docker compose run --rm voice-over --only g.pdf --only-block 2 --max-chars 500
docker compose run --rm --entrypoint npm voice-over run edge:check
cmd /c "(echo.)| call start-docker.bat --only g.pdf --analyze-only"
```

The live Edge diagnostic recorded: `node-edge-tts@1.2.11`, endpoint `wss://api.msedgeservices.com/tts/cognitiveservices/websocket/v1`, HTTPS TLS 1.3, WebSocket handshake `101 Switching Protocols`, and a diagnostic MP3 of 29,088 bytes / 4.848 seconds that FFprobe and FFmpeg both accepted.

The real output checked was:

```text
output/g/02 Майкл Дж. Д. Вермеер, Эмили Лэтроп, Элвин Мун.mp3
```

It contains 3 sequentially synthesized fragments (459, 440, and 161 characters), is 779,061 bytes, has a measured duration of 85.008 seconds, and decoded with FFmpeg without errors.

## Fault handling verified

- HTTP 403 is classified as a non-retryable WebSocket handshake refusal; the circuit is opened and later blocks are not sent in a failure loop.
- DNS, timeout, `No audio was received`, and invalid-audio conditions have distinct classifications.
- MP3 validation failure is not retried as a TTS request.
- Invalid/missing output and text/configuration mismatch cause cache rejection. These decisions are regression-tested using injected probes.

## Remaining limits and unexecuted items

- FFmpeg/FFprobe are not installed on the Windows host. Use `start-docker.bat`, or install FFmpeg and put both binaries on PATH for direct `npm start`.
- A full synthesis of the real FB2 book was deliberately not run. Its structure was analysed successfully: 11 blocks, including large chapters. Run it only after confirming the expected Edge TTS load.
- No speech-to-text semantic comparison was performed; audio correctness is confirmed technically (nonempty MP3, duration, FFprobe, and FFmpeg decode), not by automated linguistic transcription.
- PDF layouts covered by tests include text layer, multiple pages, repeated margins, page numbers, Cyrillic coordinates, two-column ordering, damaged input, and no-text-layer detection. Highly irregular or image-only PDFs still require OCR, which is intentionally not bundled.
- Peak RAM/CPU was not measured with a profiler. The parser processes PDF pages one at a time and caches normalized Markdown; this is an implementation property, not a benchmark claim.

## How to reproduce

```powershell
# Full regression set
npm test

# Recommended Windows run (Docker has FFmpeg and FFprobe)
start-docker.bat

# Dependency and real Edge TTS diagnostic in Docker
docker compose run --rm --entrypoint npm voice-over run edge:check
```
