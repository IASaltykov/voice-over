import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseToml } from 'smol-toml';
import { discover, parseFileDetails } from './parser.mjs';
import { splitText } from './segmenter.mjs';
import { verifyBlockSegmentation, verifyDocumentBlocks } from './integrity.mjs';
import { isCurrentOutput } from './cache.mjs';
import { FragmentCache, fragmentDescriptor, writeJsonAtomic } from './fragment-cache.mjs';
import { QueuePausedError, TtsQueue, jitterDelay, next429RetryAt, validateQueueConfig } from './tts-queue.mjs';
import { detectPlain, cacheKey } from './chapters.mjs';
import * as audio from './audio.mjs';
import { classifyEdgeError, edgeClientInfo, formatEdgeDiagnostic, runtimeEnvironment, synthesizeEdge } from './edge.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PLAIN_DOCUMENTS = new Set(['.txt', '.md', '.markdown', '.pdf']);

function args(argv) {
  const result = { _: [] };
  const booleans = new Set(['force', 'check', 'dry-run', 'analyze-only', 'review-chapters', 'apply-review']);
  for (let index = 0; index < argv.length; index++) {
    const value = argv[index];
    if (!value.startsWith('--')) result._.push(value);
    else {
      const [key, inline] = value.slice(2).split('=', 2);
      result[key] = booleans.has(key) ? true : (inline ?? argv[++index]);
    }
  }
  return result;
}

function digest(value) { return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex'); }
function documentDestination(output, relative) { return path.join(output, relative.replace(/\.fb2\.zip$/i, '').replace(/\.[^.]+$/, '')); }

async function readConfig(file) {
  const config = parseToml(await fs.readFile(file, 'utf8'));
  const root = path.dirname(file);
  const resolve = (value, fallback) => path.resolve(root, value || fallback);
  return {
    input: resolve(config.paths?.input, 'input'), output: resolve(config.paths?.output, 'output'), cache: resolve(config.paths?.cache, 'cache'), logs: resolve(config.paths?.logs, 'logs'),
    voice: config.tts?.voice || 'ru-RU-DmitryNeural', rate: config.tts?.rate || '-5%', retries: Math.max(1, Number(config.tts?.retries || 4)), pitch: config.tts?.pitch || '+0Hz', volume: config.tts?.volume || '+0%', audioFormat: config.tts?.audio_format || 'audio-24khz-48kbitrate-mono-mp3',
    timeout: Math.max(5, Number(config.tts?.timeout_seconds || 90)), socketTimeoutSeconds: Math.max(5, Number(config.tts?.socket_timeout_seconds || 30)), maxChars: Number(config.segmentation?.max_chars || 700), minChars: Number(config.segmentation?.min_chars || 150),
    quality: String(config.audio?.mp3_quality || '2'), chapterMode: config.chapter_detection?.mode || 'auto', targetMaxWords: Number(config.chapter_detection?.target_max_words || 5000),
    pdf: { maxBytes: Number(config.pdf?.max_bytes || 262144000) },
    edgeQueue: validateQueueConfig(config.edge_queue || {}),
  };
}

async function logLine(file, message) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.appendFile(file, `${new Date().toISOString()} ${message}\n`, 'utf8');
  console.log(message);
}

async function eventLog(settings, event) {
  if (!settings.logs) return;
  const file = path.join(settings.logs, 'events.jsonl');
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.appendFile(file, `${JSON.stringify({ timestamp: new Date().toISOString(), environment: settings.environment, ...event })}\n`, 'utf8');
}

function humanDuration(milliseconds) {
  const seconds = Math.max(0, Math.ceil(milliseconds / 1000));
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

async function waitForCooldown(milliseconds, settings) {
  const delay = Math.max(0, milliseconds);
  if (delay) await (settings.sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms))))(delay);
}

function withTimeout(promise, seconds, label) {
  let timer;
  const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} timed out after ${seconds} seconds`)), seconds * 1000); });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function retryAfterUntil(progress) {
  if (progress?.next_retry_at) { const next = Date.parse(progress.next_retry_at); if (Number.isFinite(next)) return next; }
  if (progress?.status !== 'paused' || !progress.retry_after) return null;
  const seconds = Number(progress.retry_after);
  if (Number.isFinite(seconds) && seconds >= 0) return Date.parse(progress.updated_at || '') + seconds * 1000;
  const date = Date.parse(progress.retry_after);
  return Number.isFinite(date) ? date : null;
}

async function loadChapterReview(document, destination, settings) {
  const source = document.normalizedText ?? await fs.readFile(document.file, 'utf8');
  const key = cacheKey(source, { mode: settings.chapterMode, targetMaxWords: settings.targetMaxWords });
  const file = path.join(destination, '.chapters.json');
  try {
    const cached = JSON.parse(await fs.readFile(file, 'utf8'));
    if (cached.cacheKey === key) return cached;
  } catch {}
  const result = detectPlain(source, settings.chapterMode, settings.targetMaxWords);
  const review = { cacheKey: key, method: result.method, blocks: result.blocks };
  await fs.mkdir(destination, { recursive: true });
  await fs.writeFile(file, JSON.stringify(review, null, 2), 'utf8');
  return review;
}

async function validatePart(file) {
  const probed = await audio.probe(file);
  if (!probed.valid) return { valid: false, code: probed.code || 'INVALID_AUDIO', detail: `MP3 validation (ffprobe): ${probed.detail}` };
  const decoded = await audio.decodeCheck(file);
  return decoded.valid ? { valid: true, duration: probed.duration } : { valid: false, code: decoded.code || 'INVALID_AUDIO', detail: `MP3 decoding (ffmpeg): ${decoded.detail}` };
}

async function saveManifest(file, manifest) {
  // Keep one known-good snapshot. The fragment cache remains authoritative for
  // unfinished blocks even if both manifest files are later unreadable.
  try { JSON.parse(await fs.readFile(file, 'utf8')); await fs.copyFile(file, `${file}.last-good.json`); } catch {}
  await writeJsonAtomic(file, manifest);
}

async function readManifest(file) {
  try { return JSON.parse(await fs.readFile(file, 'utf8')); } catch (error) {
    try { return JSON.parse(await fs.readFile(`${file}.last-good.json`, 'utf8')); } catch {}
    if (error?.code !== 'ENOENT') {
      const preserved = `${file}.corrupt-${Date.now()}.json`;
      await fs.rename(file, preserved).catch(() => {});
    }
    return {};
  }
}

async function speakBlock(block, destination, settings, manifest, manifestFile, log, queue, fragments) {
  const width = Math.max(2, String(manifest.totalBlocks).length);
  const title = block.title.replace(/[<>:"/\\|?*]/g, '_').trim();
  const filename = `${String(block.index).padStart(width, '0')}${title ? ` ${title}` : ''}.mp3`;
  const target = path.join(destination, filename);
  const textHash = digest(block.text);
  const configHash = digest({ voice: settings.voice, rate: settings.rate, maxChars: settings.maxChars, engine: 'edge', client: 'node-edge-tts', version: 3 });
  const previous = manifest.blocks[String(block.index)];
  if (!settings.force && await isCurrentOutput({ target, previous, textHash, configHash, filename, probe: audio.probe })) return { status: 'skipped', filename };
  if (settings.edgeCircuit?.open) return { status: 'paused', filename, detail: settings.edgeCircuit.reason };

  const chunks = splitText(block.text, settings.maxChars, settings.minChars);
  const integrity = verifyBlockSegmentation(block.text, chunks);
  if (!integrity.ok) throw new Error(`Text integrity check failed for block ${block.index}: ${integrity.detail}`);
  await logLine(log, `${manifest.source} block=${block.index}: chars=${block.text.length}, fragments=${chunks.length}, lengths=${JSON.stringify(chunks.map((part) => part.length))}`);
  manifest.progress ||= {};
  const priorProgress = manifest.progress[String(block.index)] || {};
  const progress = manifest.progress[String(block.index)] = { ...priorProgress, document: manifest.source, block: block.index, total_fragments: chunks.length, completed_fragments: 0, completed_fragment_hashes: [], status: 'RUNNING', updated_at: new Date().toISOString() };
  await saveManifest(manifestFile, manifest);
  const parts = [];
  for (let index = 0; index < chunks.length; index++) {
      const descriptor = fragmentDescriptor(chunks[index], settings);
      const cached = !settings.force && await fragments.get(descriptor);
      if (cached) {
        parts.push(cached.file);
        progress.completed_fragments = index + 1;
        progress.completed_fragment_hashes[index] = descriptor.key;
        progress.status = 'running'; progress.updated_at = new Date().toISOString();
        await saveManifest(manifestFile, manifest);
        await logLine(log, `TTS cache hit: ${manifest.source} block=${block.index} fragment=${index + 1}/${chunks.length}`);
        continue;
      }
      const work = await fs.mkdtemp(path.join(settings.cache, 'tts-tmp-'));
      const part = path.join(work, 'fragment.mp3');
      let lastError = '';
      let success = false;
      let attempt = 0;
      const maxAttempts = Math.min(settings.retries, settings.edgeQueue.transientMaxAttempts || settings.retries);
      try { while (!success) {
        attempt++;
        try {
          await logLine(log, `TTS request: ${manifest.source} block=${block.index} fragment=${index + 1}/${chunks.length} attempt=${attempt}/${settings.retries}`);
          await queue.run(() => withTimeout((settings.synthesize || synthesizeEdge)(chunks[index], part, settings), settings.timeout, 'Edge TTS request'));
        } catch (error) {
          if (error instanceof QueuePausedError) {
            progress.status = 'paused'; progress.reason = error.reason; progress.updated_at = new Date().toISOString();
            await saveManifest(manifestFile, manifest);
            return { status: 'paused', filename, detail: error.reason, completed: index, total: chunks.length };
          }
          const diagnosis = classifyEdgeError(error);
          lastError = `${diagnosis.code}: ${diagnosis.message}`;
          await fs.rm(part, { force: true });
          await logLine(log, formatEdgeDiagnostic({ environment: settings.environment, voice: settings.voice, attempt, attempts: settings.retries, error: diagnosis }));
          await logLine(log, `TTS failure: ${manifest.source} block=${block.index} fragment=${index + 1} attempt=${attempt}: ${lastError}`);
          if (diagnosis.httpStatus === 403 && attempt <= settings.edgeQueue.http403MaxRetries) {
            await logLine(log, `HTTP 403 diagnostic retry: ${manifest.source} block=${block.index} fragment=${index + 1} retry=${attempt}/${settings.edgeQueue.http403MaxRetries}`);
            continue;
          }
          const stopForRateLimit = diagnosis.httpStatus === 429 && settings.edgeQueue.stopOnHttp429;
          const stopForForbidden = diagnosis.httpStatus === 403 && settings.edgeQueue.stopOnHttp403;
          if (stopForRateLimit) {
            const events = (progress.consecutive_429 || 0) + 1;
            const next = next429RetryAt({ retryAfter: diagnosis.retryAfter, event: events, config: settings.edgeQueue });
            const waitMs = Math.max(0, next - Date.now());
            const pacing = queue.recordRateLimit();
            await writeJsonAtomic(path.join(settings.cache, 'edge-pacing.json'), pacing);
            queue.pause(`HTTP 429 until ${new Date(next).toISOString()}`);
            progress.status = 'COOLDOWN'; progress.reason = 'HTTP_429'; progress.retry_after = diagnosis.retryAfter;
            progress.next_retry_at = new Date(next).toISOString(); progress.consecutive_429 = events;
            progress.fragment = index + 1; progress.completed_fragments = index; progress.updated_at = new Date().toISOString();
            await saveManifest(manifestFile, manifest);
            await eventLog(settings, { type: 'EDGE_TTS_COOLDOWN', document: manifest.source, block: block.index, fragment: index + 1, fragment_total: chunks.length, voice: settings.voice, rate: settings.rate, error_code: diagnosis.code, retry_after: diagnosis.retryAfter || null, consecutive_429: events, cooldown_ms: waitMs, next_retry_at: progress.next_retry_at, completed_fragments: index, recommended_interval_ms: pacing.intervalMs });
            console.log(['========================================', 'EDGE TTS COOLDOWN', '========================================', `Document: ${manifest.source}`, `Block: ${block.index}/${manifest.totalBlocks}`, `Next fragment: ${index + 1}/${chunks.length}`, 'Reason: HTTP 429', `Retry-After: ${diagnosis.retryAfter || 'not provided'}`, `Consecutive 429: ${events}`, `Waiting: ${humanDuration(waitMs)}`, `Next attempt: ${new Date(next).toLocaleTimeString()}`, 'Progress saved: YES', `Automatic resume: ${settings.edgeQueue.autoResume429 ? 'ENABLED' : 'DISABLED'}`, '========================================'].join('\n'));
            if (!settings.edgeQueue.autoResume429) return { status: 'paused', filename, detail: lastError, completed: index, total: chunks.length, diagnosis };
            await logLine(log, `Waiting before automatic retry: ${manifest.source} block=${block.index} fragment=${index + 1}/${chunks.length} wait=${humanDuration(waitMs)}`);
            await waitForCooldown(waitMs, settings);
            queue.halfOpen();
            progress.status = 'RECOVERING'; progress.updated_at = new Date().toISOString();
            await saveManifest(manifestFile, manifest);
            await logLine(log, `EDGE TTS RECOVERED: resuming ${manifest.source} block=${block.index} fragment=${index + 1}/${chunks.length}`);
            continue;
          }
          if (stopForForbidden) {
            settings.edgeCircuit.open = true;
            settings.edgeCircuit.reason = `HTTP ${diagnosis.httpStatus} at ${diagnosis.stage}`;
            queue.pause(settings.edgeCircuit.reason);
            progress.status = 'PAUSED_REQUIRES_ATTENTION'; progress.reason = 'HANDSHAKE_PROTOCOL_ERROR'; progress.completed_fragments = index; progress.updated_at = new Date().toISOString();
            await saveManifest(manifestFile, manifest);
            return { status: 'paused', filename, detail: lastError, completed: index, total: chunks.length, diagnosis };
          }
          if (attempt < maxAttempts && diagnosis.retryable) await waitForCooldown(jitterDelay(settings.edgeQueue.retryJitter, settings.edgeQueue.transientBaseBackoffMs, settings.edgeQueue.transientMaxBackoffMs, attempt - 1), settings);
          if (!diagnosis.retryable) break;
          continue;
        }
        const validation = await (settings.validatePart || validatePart)(part);
        if (validation.valid) { success = true; progress.consecutive_429 = 0; await writeJsonAtomic(path.join(settings.cache, 'edge-pacing.json'), queue.recordSuccess()); break; }
        lastError = validation.detail;
        await fs.rm(part, { force: true });
        await logLine(log, `MP3 validation failure (no TTS retry): classification=${validation.code || 'INVALID_AUDIO'} ${manifest.source} block=${block.index} fragment=${index + 1}: ${lastError}`);
        break;
      }
      if (!success) {
        progress.status = 'failed'; progress.reason = lastError; progress.completed_fragments = index; progress.updated_at = new Date().toISOString();
        await saveManifest(manifestFile, manifest);
        return { status: 'failed', filename, detail: `fragment ${index + 1}: ${lastError}` };
      }
      const saved = await fragments.save(descriptor, part);
      parts.push(saved.file);
      progress.completed_fragments = index + 1; progress.status = 'running'; progress.updated_at = new Date().toISOString();
      progress.completed_fragment_hashes[index] = descriptor.key;
      await saveManifest(manifestFile, manifest);
      await logLine(log, `TTS fragment completed: ${manifest.source} block=${block.index} fragment=${index + 1}/${chunks.length} cache=${descriptor.key}`);
      } finally { await fs.rm(work, { recursive: true, force: true }); }
    }
    const merged = await (settings.mergeMp3 || audio.mergeMp3)(parts, target, settings.quality);
    if (!merged.ok) return { status: 'failed', filename, detail: `merge/MP3 validation: ${merged.detail}` };
    manifest.blocks[String(block.index)] = { filename, textHash, configHash, engine: 'edge', chunks: chunks.length, duration: merged.duration };
    manifest.progress[String(block.index)] = { ...progress, completed_fragments: chunks.length, status: 'completed', updated_at: new Date().toISOString() };
    await saveManifest(manifestFile, manifest);
    return { status: 'created', filename, duration: merged.duration };
}

async function main() {
  const cli = args(process.argv.slice(2));
  const settings = await readConfig(path.resolve(cli.config || path.join(ROOT, 'config.toml')));
  settings.force = Boolean(cli.force);
  settings.voice = cli.voice || settings.voice;
  settings.rate = cli.rate || settings.rate;
  settings.maxChars = Number(cli['max-chars'] || settings.maxChars);
  settings.chapterMode = cli['chapter-mode'] || settings.chapterMode;
  if (cli.input) settings.input = path.resolve(cli.input);
  if (cli.output) settings.output = path.resolve(cli.output);
  settings.environment = await runtimeEnvironment();
  settings.edgeCircuit = { open: false, reason: '' };
  await fs.mkdir(settings.cache, { recursive: true });
  let savedPacing = null;
  try { savedPacing = JSON.parse(await fs.readFile(path.join(settings.cache, 'edge-pacing.json'), 'utf8')); } catch {}
  const queue = new TtsQueue(settings.edgeQueue, { pacingState: savedPacing });
  const fragments = new FragmentCache(settings.cache, { validateAudio: validatePart });
  const log = path.join(settings.logs, 'generation.log');
  const edge = edgeClientInfo();
  await logLine(log, `Node Edge-only TTS start: node=${process.version} environment=${settings.environment} voice=${settings.voice} rate=${settings.rate} edge_client=${edge.library}@${edge.version}`);
  const inspectionOnly = cli['analyze-only'] || cli['review-chapters'] || cli['dry-run'];
  if (cli.check || !inspectionOnly) await audio.requireTools();
  if (cli.check) { await logLine(log, 'Dependency check passed'); return 0; }
  if (!(await fs.stat(settings.input).catch(() => null))) throw new Error(`Input not found: ${settings.input}`);
  const files = cli.only ? [path.resolve(settings.input, cli.only)] : await discover(settings.input);
  if (!files.length) throw new Error('No supported input documents found');
  const totals = { documents: 0, blocks: 0, created: 0, skipped: 0, errors: 0 };
  let pause = null;
  for (const file of files) {
    if (!(await fs.stat(file).catch(() => null))) throw new Error(`Document not found: ${file}`);
    const relative = path.relative(settings.input, file);
    const destination = documentDestination(settings.output, relative);
    await fs.mkdir(destination, { recursive: true });
    try {
      const parsed = await parseFileDetails(file, { pdf: { cacheRoot: settings.cache, maxBytes: settings.pdf.maxBytes } });
      const document = { file, relative, normalizedText: parsed.normalizedText };
      let blocks = parsed.blocks;
      if (!blocks.length && PLAIN_DOCUMENTS.has(path.extname(file).toLowerCase())) blocks = (await loadChapterReview(document, destination, settings)).blocks;
      if (inspectionOnly) {
        await fs.writeFile(path.join(destination, 'chapters_review.json'), JSON.stringify({ source: relative, blocks, mode: settings.chapterMode, pdf: parsed.pdf }, null, 2), 'utf8');
        totals.documents++;
        totals.blocks += blocks.length;
        for (const block of blocks) await logLine(log, `ANALYZE ${relative} block=${block.index} chars=${block.text.length} words=${block.text.split(/\s+/).filter(Boolean).length}`);
        continue;
      }
      if (cli['apply-review']) {
        const review = JSON.parse(await fs.readFile(path.join(destination, 'chapters_review.json'), 'utf8'));
        if (review.blocks.length !== blocks.length || review.blocks.some((item, index) => item.text !== blocks[index].text)) throw new Error(`Review does not match current source: ${relative}`);
        blocks = review.blocks;
      }
      const documentIntegrity = verifyDocumentBlocks(blocks);
      if (!documentIntegrity.ok) throw new Error(`Document text integrity check failed: ${documentIntegrity.detail}`);
      totals.documents++;
      totals.blocks += blocks.length;
      const manifestFile = path.join(destination, '.manifest.json');
      let manifest = await readManifest(manifestFile);
      manifest.source = relative;
      manifest.totalBlocks = blocks.length;
      manifest.blocks ||= {};
      manifest.progress ||= {};
      const pendingCooldowns = Object.values(manifest.progress).filter((item) => item.status === 'COOLDOWN');
      const deferred = pendingCooldowns
        .filter((item) => item.retry_after || !settings.edgeQueue.immediateResumeWithoutRetryAfter)
        .map(retryAfterUntil).find((until) => until && until > Date.now());
      if (deferred) {
        const detail = `Saved Retry-After is still active until ${new Date(deferred).toISOString()}`;
        const waitMs = deferred - Date.now();
        queue.pause(detail);
        await logLine(log, `Waiting before automatic retry: ${detail} (${humanDuration(waitMs)})`);
        await waitForCooldown(waitMs, settings);
        queue.halfOpen();
        for (const item of Object.values(manifest.progress)) if (item.status === 'COOLDOWN') { item.status = 'RECOVERING'; item.updated_at = new Date().toISOString(); }
        await saveManifest(manifestFile, manifest);
      } else if (pendingCooldowns.length) {
        // A persisted local cooldown without a server Retry-After is not a
        // permanent lock. A restarted worker gets one ordinary half-open
        // request for the same unfinished fragment; a new 429 starts a fresh
        // conservative cooldown.
        queue.halfOpen();
        for (const item of pendingCooldowns) { item.status = 'RECOVERING'; item.updated_at = new Date().toISOString(); }
        await saveManifest(manifestFile, manifest);
        await logLine(log, `Restart resume: no server Retry-After; retrying the first unfinished fragment for ${relative}`);
      }
      for (const block of blocks) {
        if (cli['only-block'] && Number(cli['only-block']) !== block.index) continue;
        const result = await speakBlock(block, destination, settings, manifest, manifestFile, log, queue, fragments);
        if (result.status === 'created') totals.created++;
        else if (result.status === 'skipped') totals.skipped++;
        else if (result.status === 'paused') {
          totals.errors++;
          pause = { relative, block: block.index, detail: result.detail, completed: result.completed || 0, total: result.total || 0, remaining: blocks.filter((item) => item.index > block.index).length, diagnosis: result.diagnosis };
          await logLine(log, `EDGE TTS PAUSED: ${relative} block=${block.index}: ${result.detail}`);
          break;
        } else { totals.errors++; await logLine(log, `FAILED ${relative} block=${block.index}: ${result.detail}`); }
      }
      await saveManifest(manifestFile, manifest);
    } catch (error) {
      totals.documents++;
      totals.errors++;
      await logLine(log, `DOCUMENT FAILED ${relative}: ${error.constructor.name}: ${error.message}`);
    }
    if (pause) break;
  }
  if (pause) {
    console.log(["========================================", "EDGE TTS PAUSED", "========================================", `Document: ${pause.relative}`, `Block: ${pause.block || 'n/a'}`, `Completed fragments: ${pause.completed}/${pause.total || 'n/a'}`, `Remaining blocks in document: ${pause.remaining}`, `Reason: ${pause.detail}`, 'Progress saved: YES', 'Restart later to resume.', "========================================"].join('\n'));
  }
  console.log(JSON.stringify(totals, null, 2));
  return totals.errors ? 1 : 0;
}

export const mainInternals = { speakBlock, readManifest, retryAfterUntil, waitForCooldown, humanDuration };

const invokedAsScript = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedAsScript) main().then((code) => { process.exitCode = code; }).catch((error) => { console.error(error.stack || error.message); process.exitCode = 1; });
