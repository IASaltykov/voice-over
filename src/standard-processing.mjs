import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { discover, parseFileDetails } from './parser.mjs';
import { detectLanguage } from './language.mjs';
import { loadPronunciationExceptions, preparePronunciation } from './pronunciation.mjs';
import { translateToRussian, TranslatorUnavailableError } from './translator.mjs';
import { writeJsonAtomic } from './fragment-cache.mjs';
import { probe, decodeCheck } from './audio.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const STATES = new Set(['NEW', 'TRANSLATING', 'TRANSLATED', 'PREPARING_PRONUNCIATION', 'SPEAKING', 'PAUSED', 'WAITING_TRANSLATOR', 'NEEDS_LANGUAGE_SELECTION', 'NEEDS_TRANSLATION_DECISION', 'FAILED', 'COMPLETED']);
const now = () => new Date().toISOString();
const sha = (value) => crypto.createHash('sha256').update(value).digest('hex');

function aiEnabled(settings, feature, fallback) { return settings.ai?.[feature]?.enabled ?? fallback; }

export class LanguageSelectionRequiredError extends Error {
  constructor() { super('Document language could not be determined. Choose a source language before processing.'); this.name = 'LanguageSelectionRequiredError'; }
}

export async function sha256File(file) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    createReadStream(file).on('error', reject).on('data', (chunk) => hash.update(chunk)).on('end', () => resolve(hash.digest('hex')));
  });
}

async function isStable(file, delayMs) {
  const first = await fs.stat(file);
  if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
  const second = await fs.stat(file);
  return first.size === second.size && first.mtimeMs === second.mtimeMs;
}

async function child(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const process = spawn(command, args, { ...options, windowsHide: true, stdio: 'inherit' });
    process.once('error', reject); process.once('close', (code) => resolve(code));
  });
}

function safeName(value) { return String(value || 'document').replace(/[<>:"/\\|?*]/g, '_').slice(0, 120) || 'document'; }
function taskDirectory(settings) { return path.join(settings.data, 'tasks'); }
function taskFile(settings, id) { return path.join(taskDirectory(settings), `${id}.json`); }
function documentDirectory(settings, id) { return path.join(settings.data, 'documents', id); }
function outputDirectory(settings, id) { return path.join(settings.output, 'standard', id); }

async function readJson(file, fallback = null) { try { return JSON.parse(await fs.readFile(file, 'utf8')); } catch { return fallback; } }

async function allMp3(root) {
  const result = [];
  async function walk(folder) {
    for (const item of await fs.readdir(folder, { withFileTypes: true }).catch(() => [])) {
      const full = path.join(folder, item.name);
      if (item.isDirectory()) await walk(full); else if (/\.mp3$/i.test(item.name)) result.push(full);
    }
  }
  await walk(root); return result.sort();
}

async function audioFilesValid(files) {
  if (!files?.length) return false;
  for (const file of files) { const checked = await probe(file); if (!checked.valid || !(await decodeCheck(file)).valid) return false; }
  return true;
}

export class StandardTaskStore {
  constructor(settings) { this.settings = settings; }

  async read(id) { return readJson(taskFile(this.settings, id)); }
  async save(task) { task.updated_at = now(); await writeJsonAtomic(taskFile(this.settings, task.id), task); return task; }

  async list() {
    const files = await fs.readdir(taskDirectory(this.settings)).catch(() => []);
    const tasks = await Promise.all(files.filter((file) => file.endsWith('.json')).map((file) => readJson(path.join(taskDirectory(this.settings), file))));
    return tasks.filter(Boolean).sort((a, b) => String(b.updated_at || '').localeCompare(String(a.updated_at || '')));
  }

  async completed(task) {
    if (task?.status !== 'COMPLETED' || task.settings_hash !== this.settingsHash()) return false;
    return audioFilesValid(task.audio_files || []);
  }

  settingsHash() {
    const s = this.settings.standard;
    return sha(JSON.stringify({ target: s.target_language, provider: s.translation_provider, model: s.translation_model, languageDetection: aiEnabled(this.settings, 'languageDetection', s.language_detection_enabled ?? true), translation: aiEnabled(this.settings, 'translation', s.auto_translate), pronunciation: aiEnabled(this.settings, 'pronunciation', s.pronunciation_enabled), sentenceBySentence: s.speak_sentence_by_sentence, voice: s.voice, rate: s.rate, format: s.audio_format }));
  }

  async inspect(file) {
    const stable = await isStable(file, Math.max(0, Number(this.settings.standard.stable_file_delay_ms || 0)));
    const stat = await fs.stat(file);
    const id = await sha256File(file);
    const existing = await this.read(id);
    if (!stable) return { id, file, name: path.basename(file), status: 'COPYING', language: '…', task: existing };
    const parsed = await parseFileDetails(file, { pdf: { cacheRoot: this.settings.cache } });
    const text = parsed.blocks.map((block) => block.text).join('\n\n');
    const language = existing?.language || (aiEnabled(this.settings, 'languageDetection', this.settings.standard.language_detection_enabled ?? true) ? detectLanguage(text).code : 'UNKNOWN');
    const completed = await this.completed(existing);
    const status = completed ? 'COMPLETED' : (existing?.status || 'NEW');
    return { id, file, name: path.basename(file), size: stat.size, modified_at: stat.mtime.toISOString(), language, status, parsed, task: existing, text_chars: text.length };
  }

  async pending() {
    const files = (await discover(this.settings.input)).filter((file) => path.basename(file).toLowerCase() !== 'urls.txt');
    const entries = [];
    for (const file of files) {
      try { const entry = await this.inspect(file); if (entry.status !== 'COMPLETED') entries.push(entry); }
      catch (error) { entries.push({ id: null, file, name: path.basename(file), language: '?', status: 'FAILED', error: error.message }); }
    }
    return entries;
  }

  async acquire(id) {
    const dir = documentDirectory(this.settings, id); await fs.mkdir(dir, { recursive: true });
    const lock = path.join(dir, '.processing.lock');
    const staleMs = Math.max(60, Number(this.settings.standard.lock_stale_seconds || 21600)) * 1000;
    const old = await fs.stat(lock).catch(() => null);
    if (old && Date.now() - old.mtimeMs > staleMs) await fs.rm(lock, { force: true });
    let handle;
    try { handle = await fs.open(lock, 'wx'); await handle.writeFile(JSON.stringify({ pid: process.pid, started_at: now() }), 'utf8'); await handle.close(); }
    catch { throw new Error('This document is already being processed by another Article Studio worker.'); }
    const heartbeat = setInterval(() => fs.utimes(lock, new Date(), new Date()).catch(() => {}), 30_000);
    return async () => { clearInterval(heartbeat); await fs.rm(lock, { force: true }); };
  }

  async ensureTask(entry, languageOverride) {
    const task = (await this.read(entry.id)) || {
      id: entry.id, created_at: now(), source: { sha256: entry.id, file_name: entry.name, original_path: path.relative(this.settings.input, entry.file), size: entry.size, modified_at: entry.modified_at },
      status: 'NEW', blocks: [], audio_files: [], settings_hash: this.settingsHash(),
    };
    task.language = languageOverride || task.language || entry.language;
    if (!STATES.has(task.status)) task.status = 'NEW';
    await fs.mkdir(documentDirectory(this.settings, entry.id), { recursive: true });
    const sourceCopy = path.join(documentDirectory(this.settings, entry.id), 'original', safeName(entry.name));
    await fs.mkdir(path.dirname(sourceCopy), { recursive: true });
    if (!(await fs.stat(sourceCopy).catch(() => null))) await fs.copyFile(entry.file, sourceCopy);
    task.original_copy = sourceCopy;
    return this.save(task);
  }
}

async function translatedBlocks(task, blocks, settings) {
  const directory = path.join(documentDirectory(settings, task.id), 'translation'); await fs.mkdir(directory, { recursive: true });
  const result = [];
  for (const block of blocks) {
    const file = path.join(directory, `${String(block.index).padStart(4, '0')}.json`);
    const sourceHash = sha(block.text);
    const cached = await readJson(file);
    if (cached?.source_sha256 === sourceHash && typeof cached.text === 'string') { result.push({ ...block, text: cached.text }); continue; }
    const text = await translateToRussian(block.text, settings.standard);
    await writeJsonAtomic(file, { source_sha256: sourceHash, text, model: settings.standard.translation_model, created_at: now() });
    result.push({ ...block, text });
  }
  return result;
}

export async function prepareBlocksForSpeech(task, blocks, settings) {
  const pronunciationEnabled = aiEnabled(settings, 'pronunciation', settings.standard.pronunciation_enabled);
  const exceptions = pronunciationEnabled ? await loadPronunciationExceptions(settings.standard.pronunciation_exceptions) : new Map();
  const prepared = blocks.map((block) => {
    const result = pronunciationEnabled ? preparePronunciation(block.text, exceptions) : { text: block.text, changes: [], convention: 'disabled' };
    return { ...block, text: result.text, pronunciation_changes: result.changes };
  });
  const content = prepared.map((block) => `# ${block.title || `Section ${block.index}`}\n${block.text}`).join('\n\n');
  const directory = documentDirectory(settings, task.id);
  await fs.mkdir(directory, { recursive: true });
  const file = path.join(directory, 'prepared.txt');
  await fs.writeFile(file, content, 'utf8');
  await writeJsonAtomic(path.join(directory, 'pronunciation.json'), { enabled: pronunciationEnabled, convention: pronunciationEnabled ? 'unicode_combining_acute' : 'disabled', blocks: prepared.map(({ index, pronunciation_changes }) => ({ index, changes: pronunciation_changes })) });
  return { file, prepared };
}

async function hasPausedManifest(root) {
  const items = await fs.readdir(root, { recursive: true }).catch(() => []);
  for (const item of items) {
    if (!String(item).endsWith('.manifest.json')) continue;
    const manifest = await readJson(path.join(root, item));
    if (Object.values(manifest?.progress || {}).some((progress) => ['COOLDOWN', 'RECOVERING', 'paused', 'PAUSED_REQUIRES_ATTENTION'].includes(progress.status))) return true;
  }
  return false;
}

export async function processStandardDocument(store, entry, { language, translationDecision, interactive = false } = {}) {
  const settings = store.settings;
  const release = await store.acquire(entry.id);
  let task;
  try {
    task = await store.ensureTask(entry, language);
    const parsed = entry.parsed || await parseFileDetails(entry.file, { pdf: { cacheRoot: settings.cache } });
    const blocks = parsed.blocks;
    if (!blocks.length) throw new Error('The document contains no readable text blocks.');
    task.blocks = blocks.map(({ index, title, text }) => ({ index, title, source_sha256: sha(text), source_chars: text.length }));
    const detected = language || task.language || (aiEnabled(settings, 'languageDetection', settings.standard.language_detection_enabled ?? true) ? detectLanguage(blocks.map((block) => block.text).join('\n')).code : 'UNKNOWN');
    task.language = detected;
    if (detected === 'UNKNOWN') { task.status = 'NEEDS_LANGUAGE_SELECTION'; await store.save(task); throw new LanguageSelectionRequiredError(); }
    let spokenBlocks = blocks;
    const translationEnabled = aiEnabled(settings, 'translation', settings.standard.auto_translate);
    if (detected !== 'RU' && translationEnabled) {
      task.status = 'TRANSLATING'; await store.save(task);
      try { spokenBlocks = await translatedBlocks(task, blocks, settings); }
      catch (error) {
        task.status = error instanceof TranslatorUnavailableError ? 'WAITING_TRANSLATOR' : 'FAILED'; task.error = error.message; await store.save(task); throw error;
      }
      task.translation_file = path.join(documentDirectory(settings, task.id), 'translation'); task.status = 'TRANSLATED'; await store.save(task);
    } else if (detected !== 'RU') {
      if (translationDecision !== 'speak_original' && task.translation_decision !== 'speak_original') {
        task.status = interactive ? 'NEEDS_TRANSLATION_DECISION' : 'WAITING_TRANSLATOR';
        await store.save(task);
        return task;
      }
      task.translation_decision = 'speak_original';
      task.translation_file = null;
      await store.save(task);
    }
    task.status = 'PREPARING_PRONUNCIATION'; await store.save(task);
    const prepared = await prepareBlocksForSpeech(task, spokenBlocks, settings);
    task.prepared_text = prepared.file;
    if (!settings.standard.speech_enabled) { task.status = 'TRANSLATED'; await store.save(task); return task; }
    task.status = 'SPEAKING'; await store.save(task);
    const output = outputDirectory(settings, task.id); await fs.mkdir(output, { recursive: true });
    const speechArgs = [path.join(ROOT, 'src', 'main.mjs'), '--config', settings.file, '--input', documentDirectory(settings, task.id), '--output', output, '--only', 'prepared.txt', '--voice', settings.standard.voice, '--rate', settings.standard.rate, '--pre-normalized'];
    if (settings.standard.speak_sentence_by_sentence) speechArgs.push('--sentence-by-sentence');
    const code = await child(process.execPath, speechArgs);
    const mp3 = await allMp3(output);
    if (code !== 0 || !(await audioFilesValid(mp3))) { task.status = (await hasPausedManifest(output)) ? 'PAUSED' : 'FAILED'; task.error = `Speech generation exited with code ${code}`; task.audio_files = mp3; await store.save(task); return task; }
    task.status = 'COMPLETED'; task.error = null; task.audio_files = mp3; task.output = output; task.completed_at = now(); task.settings_hash = store.settingsHash(); await store.save(task);
    return task;
  } finally { await release(); }
}
