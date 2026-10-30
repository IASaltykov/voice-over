import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readConfig } from './config.mjs';
import { readManifest, saveManifest } from './manifest.mjs';
import { discover, parseFileDetails } from './parser.mjs';
import { verifyDocumentBlocks } from './integrity.mjs';
import { FragmentCache } from './fragment-cache.mjs';
import { TtsQueue } from './tts-queue.mjs';
import { detectPlain, cacheKey } from './chapters.mjs';
import { materializeUrls } from './sources.mjs';
import * as audio from './audio.mjs';
import { acquireWorkerLock } from './worker-lock.mjs';
import { edgeClientInfo, runtimeEnvironment } from './edge.mjs';
import { speakBlock, validatePart } from './speech-block.mjs';
import { logLine, humanDuration, waitForCooldown } from './runtime.mjs';
export { outputFilename } from './speech-block.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PLAIN_DOCUMENTS = new Set(['.txt', '.md', '.markdown', '.pdf']);

function args(argv) {
  const result = { _: [] };
  const booleans = new Set(['force', 'check', 'dry-run', 'analyze-only', 'review-chapters', 'apply-review', 'url-only', 'pre-normalized', 'sentence-by-sentence']);
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

function documentDestination(output, relative) { return path.join(output, relative.replace(/\.fb2\.zip$/i, '').replace(/\.[^.]+$/, '')); }

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

async function runMain() {
  const cli = args(process.argv.slice(2));
  const settings = await readConfig(path.resolve(cli.config || path.join(ROOT, 'config.toml')));
  settings.force = Boolean(cli.force);
  settings.preNormalized = Boolean(cli['pre-normalized']);
  settings.sentenceBySentence = Boolean(cli['sentence-by-sentence']);
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
  settings.savedCooldown = savedPacing?.nextRetryAt;
  const fragments = new FragmentCache(settings.cache, { validateAudio: validatePart });
  const log = path.join(settings.logs, 'generation.log');
  const edge = edgeClientInfo();
  await logLine(log, `Node Edge-only TTS start: node=${process.version} environment=${settings.environment} voice=${settings.voice} rate=${settings.rate} edge_client=${edge.library}@${edge.version}`);
  const inspectionOnly = cli['analyze-only'] || cli['review-chapters'] || cli['dry-run'];
  if (!inspectionOnly && !cli.check) {
    const release = await acquireWorkerLock(settings.cache);
    try {
      const until = Date.parse(settings.savedCooldown || '');
      if (Number.isFinite(until) && until > Date.now()) {
        await logLine(log, `Shared Edge cooldown until ${new Date(until).toISOString()}`);
        await waitForCooldown(until - Date.now(), settings);
      }
      return await processDocuments(cli, settings, queue, fragments, log, inspectionOnly);
    } finally { await release(); }
  }
  return processDocuments(cli, settings, queue, fragments, log, inspectionOnly);
}

async function processDocuments(cli, settings, queue, fragments, log, inspectionOnly) {
  if (cli.check || !inspectionOnly) await audio.requireTools();
  if (cli.check) { await logLine(log, 'Dependency check passed'); return 0; }
  if (!(await fs.stat(settings.input).catch(() => null))) throw new Error(`Input not found: ${settings.input}`);
  const localFiles = cli['url-only'] ? [] : (cli.only ? [path.resolve(settings.input, cli.only)] : await discover(settings.input));
  const directUrls = cli.url ? (Array.isArray(cli.url) ? cli.url : [cli.url]) : [];
  const urlSources = await materializeUrls(settings.input, settings.cache, directUrls);
  const files = [...localFiles.map((file) => ({ file, relative: path.relative(settings.input, file) })), ...urlSources];
  if (!files.length) throw new Error('No supported input documents found');
  const totals = { documents: 0, blocks: 0, created: 0, skipped: 0, errors: 0 };
  let pause = null;
  for (const source of files) {
    const file = source.file;
    if (!(await fs.stat(file).catch(() => null))) throw new Error(`Document not found: ${file}`);
    const relative = source.relative;
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
if (invokedAsScript) runMain().then((code) => { process.exitCode = code; }).catch((error) => { console.error(error.stack || error.message); process.exitCode = 1; });
