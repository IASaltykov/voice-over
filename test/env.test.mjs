import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { loadAiFeatureFlags, parseDotEnv } from '../src/env.mjs';
import { StandardTaskStore, prepareBlocksForSpeech, processStandardDocument } from '../src/standard-processing.mjs';

test('AI flags use environment, then .env, then config.toml values', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'voice-over-env-')); t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(path.join(root, '.env'), 'AI_LANGUAGE_DETECTION_ENABLED=false\nAI_TRANSLATION_ENABLED=true\nAI_PRONUNCIATION_ENABLED=false\n');
  const flags = await loadAiFeatureFlags({ root, standard: { language_detection_enabled: true, auto_translate: false, pronunciation_enabled: true }, env: { AI_TRANSLATION_ENABLED: 'false' } });
  assert.deepEqual(flags.languageDetection, { enabled: false, source: '.env' });
  assert.deepEqual(flags.translation, { enabled: false, source: 'environment' });
  assert.deepEqual(flags.pronunciation, { enabled: false, source: '.env' });
});

test('AI flag values and dotenv syntax are validated', async () => {
  assert.deepEqual(parseDotEnv('# comment\nA=true\nB="false"\n'), { A: 'true', B: 'false' });
  await assert.rejects(() => loadAiFeatureFlags({ root: process.cwd(), envFile: '.missing-env-for-test', env: { AI_TRANSLATION_ENABLED: 'yes' } }), /AI_TRANSLATION_ENABLED must be exactly true or false/);
  assert.throws(() => parseDotEnv('not valid'), /Invalid .env line 1/);
});

function settings(root, ai) {
  return {
    file: path.join(root, 'config.toml'), input: path.join(root, 'input'), output: path.join(root, 'output'), data: path.join(root, 'data'), cache: path.join(root, 'cache'),
    standard: { stable_file_delay_ms: 0, language_detection_enabled: true, target_language: 'ru', auto_translate: true, translation_provider: 'translategemma_openai', translation_model: 'TranslateGemma-4B', translation_endpoint: 'http://127.0.0.1:1/not-called', pronunciation_enabled: true, pronunciation_exceptions: path.join(root, 'data', 'exceptions.json'), speech_enabled: true, voice: 'ru-RU-DmitryNeural', rate: '+0%', audio_format: 'mp3', lock_stale_seconds: 60 }, ai,
  };
}

test('disabled language detection requires a saved language selection', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'voice-over-language-off-')); t.after(() => fs.rm(root, { recursive: true, force: true }));
  const value = settings(root, { languageDetection: { enabled: false }, translation: { enabled: false }, pronunciation: { enabled: true } });
  await fs.mkdir(value.input); await fs.writeFile(path.join(value.input, 'russian.txt'), '# Article\nЭто достаточно длинный русский текст для проверки выбора языка перед обработкой.');
  const store = new StandardTaskStore(value); const [entry] = await store.pending();
  assert.equal(entry.language, 'UNKNOWN');
  await assert.rejects(() => processStandardDocument(store, entry), /Choose a source language/);
  const task = await store.read(entry.id);
  assert.equal(task.status, 'NEEDS_LANGUAGE_SELECTION');
});

test('disabled translation never calls endpoint and uses safe or explicit decisions', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'voice-over-translation-off-')); t.after(() => fs.rm(root, { recursive: true, force: true }));
  const value = settings(root, { languageDetection: { enabled: true }, translation: { enabled: false }, pronunciation: { enabled: true } });
  await fs.mkdir(value.input); await fs.writeFile(path.join(value.input, 'english.txt'), '# Article\nThis is sufficiently long English prose for reliable language detection and disabled translation testing.');
  const store = new StandardTaskStore(value); const [entry] = await store.pending();
  const safe = await processStandardDocument(store, entry);
  assert.equal(safe.status, 'WAITING_TRANSLATOR');
  const interactive = await processStandardDocument(store, entry, { interactive: true });
  assert.equal(interactive.status, 'NEEDS_TRANSLATION_DECISION');
});

test('disabled pronunciation preserves the source text and records the disabled stage', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'voice-over-pronunciation-off-')); t.after(() => fs.rm(root, { recursive: true, force: true }));
  const value = settings(root, { languageDetection: { enabled: true }, translation: { enabled: true }, pronunciation: { enabled: false } });
  const result = await prepareBlocksForSpeech({ id: 'task' }, [{ index: 1, title: 'Section', text: 'Договор и каталог.' }], value);
  assert.equal(result.prepared[0].text, 'Договор и каталог.');
  const metadata = JSON.parse(await fs.readFile(path.join(value.data, 'documents', 'task', 'pronunciation.json'), 'utf8'));
  assert.equal(metadata.enabled, false);
  assert.equal(metadata.convention, 'disabled');
});
