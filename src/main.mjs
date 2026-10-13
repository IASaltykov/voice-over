import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseToml } from 'smol-toml';
import { discover, parseFileDetails } from './parser.mjs';
import { splitText } from './segmenter.mjs';
import { verifyBlockSegmentation, verifyDocumentBlocks } from './integrity.mjs';
import { isCurrentOutput } from './cache.mjs';
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
    voice: config.tts?.voice || 'ru-RU-DmitryNeural', rate: config.tts?.rate || '-5%', retries: Math.max(1, Number(config.tts?.retries || 4)),
    timeout: Math.max(5, Number(config.tts?.timeout_seconds || 90)), socketTimeoutSeconds: Math.max(5, Number(config.tts?.socket_timeout_seconds || 30)), maxChars: Number(config.segmentation?.max_chars || 700), minChars: Number(config.segmentation?.min_chars || 150),
    quality: String(config.audio?.mp3_quality || '2'), chapterMode: config.chapter_detection?.mode || 'auto', targetMaxWords: Number(config.chapter_detection?.target_max_words || 5000),
    pdf: { maxBytes: Number(config.pdf?.max_bytes || 262144000) },
  };
}

async function logLine(file, message) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.appendFile(file, `${new Date().toISOString()} ${message}\n`, 'utf8');
  console.log(message);
}

function withTimeout(promise, seconds, label) {
  let timer;
  const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} timed out after ${seconds} seconds`)), seconds * 1000); });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
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
  return decoded.valid ? { valid: true } : { valid: false, code: decoded.code || 'INVALID_AUDIO', detail: `MP3 decoding (ffmpeg): ${decoded.detail}` };
}

async function speakBlock(block, destination, settings, manifest, log) {
  const width = Math.max(2, String(manifest.totalBlocks).length);
  const title = block.title.replace(/[<>:"/\\|?*]/g, '_').trim();
  const filename = `${String(block.index).padStart(width, '0')}${title ? ` ${title}` : ''}.mp3`;
  const target = path.join(destination, filename);
  const textHash = digest(block.text);
  const configHash = digest({ voice: settings.voice, rate: settings.rate, maxChars: settings.maxChars, engine: 'edge', client: 'node-edge-tts', version: 3 });
  const previous = manifest.blocks[String(block.index)];
  if (!settings.force && await isCurrentOutput({ target, previous, textHash, configHash, filename, probe: audio.probe })) return { status: 'skipped', filename };
  if (settings.edgeCircuit?.open) return { status: 'blocked', filename, detail: `Edge TTS circuit is open: ${settings.edgeCircuit.reason}` };

  const chunks = splitText(block.text, settings.maxChars, settings.minChars);
  const integrity = verifyBlockSegmentation(block.text, chunks);
  if (!integrity.ok) throw new Error(`Text integrity check failed for block ${block.index}: ${integrity.detail}`);
  await logLine(log, `${manifest.source} block=${block.index}: chars=${block.text.length}, fragments=${chunks.length}, lengths=${JSON.stringify(chunks.map((part) => part.length))}`);
  const work = await fs.mkdtemp(path.join(settings.cache, `block-${block.index}-`));
  const parts = [];
  try {
    for (let index = 0; index < chunks.length; index++) {
      const part = path.join(work, `part-${index + 1}.mp3`);
      let lastError = '';
      let success = false;
      for (let attempt = 1; attempt <= settings.retries; attempt++) {
        try {
          await logLine(log, `TTS request: ${manifest.source} block=${block.index} fragment=${index + 1}/${chunks.length} attempt=${attempt}/${settings.retries}`);
          await withTimeout(synthesizeEdge(chunks[index], part, settings), settings.timeout, 'Edge TTS request');
        } catch (error) {
          const diagnosis = classifyEdgeError(error);
          lastError = `${diagnosis.code}: ${diagnosis.message}`;
          await fs.rm(part, { force: true });
          await logLine(log, formatEdgeDiagnostic({ environment: settings.environment, voice: settings.voice, attempt, attempts: settings.retries, error: diagnosis }));
          await logLine(log, `TTS failure: ${manifest.source} block=${block.index} fragment=${index + 1} attempt=${attempt}: ${lastError}`);
          if (diagnosis.httpStatus === 403 || diagnosis.httpStatus === 429) {
            settings.edgeCircuit.open = true;
            settings.edgeCircuit.reason = `HTTP ${diagnosis.httpStatus} at WebSocket handshake`;
            return { status: 'blocked', filename, detail: lastError };
          }
          if (attempt < settings.retries && diagnosis.retryable) await new Promise((resolve) => setTimeout(resolve, Math.min(2 ** (attempt - 1), 20) * 1000));
          if (!diagnosis.retryable) break;
          continue;
        }
        const validation = await validatePart(part);
        if (validation.valid) { success = true; break; }
        lastError = validation.detail;
        await fs.rm(part, { force: true });
        await logLine(log, `MP3 validation failure (no TTS retry): classification=${validation.code || 'INVALID_AUDIO'} ${manifest.source} block=${block.index} fragment=${index + 1}: ${lastError}`);
        break;
      }
      if (!success) return { status: 'failed', filename, detail: `fragment ${index + 1}: ${lastError}` };
      parts.push(part);
    }
    const merged = await audio.mergeMp3(parts, target, settings.quality);
    if (!merged.ok) return { status: 'failed', filename, detail: `merge/MP3 validation: ${merged.detail}` };
    manifest.blocks[String(block.index)] = { filename, textHash, configHash, engine: 'edge', chunks: chunks.length, duration: merged.duration };
    return { status: 'created', filename, duration: merged.duration };
  } finally {
    await fs.rm(work, { recursive: true, force: true });
  }
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
      let manifest = {};
      try { manifest = JSON.parse(await fs.readFile(manifestFile, 'utf8')); } catch {}
      manifest.source = relative;
      manifest.totalBlocks = blocks.length;
      manifest.blocks ||= {};
      for (const block of blocks) {
        if (cli['only-block'] && Number(cli['only-block']) !== block.index) continue;
        const result = await speakBlock(block, destination, settings, manifest, log);
        if (result.status === 'created') totals.created++;
        else if (result.status === 'skipped') totals.skipped++;
        else { totals.errors++; await logLine(log, `${result.status === 'blocked' ? 'BLOCKED' : 'FAILED'} ${relative} block=${block.index}: ${result.detail}`); }
      }
      await fs.writeFile(manifestFile, JSON.stringify(manifest, null, 2), 'utf8');
    } catch (error) {
      totals.documents++;
      totals.errors++;
      await logLine(log, `DOCUMENT FAILED ${relative}: ${error.constructor.name}: ${error.message}`);
    }
  }
  console.log(JSON.stringify(totals, null, 2));
  return totals.errors ? 1 : 0;
}

main().then((code) => { process.exitCode = code; }).catch((error) => { console.error(error.stack || error.message); process.exitCode = 1; });
