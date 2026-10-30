import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import AdmZip from 'adm-zip';
import { detectLanguage } from '../src/language.mjs';
import { preparePronunciation } from '../src/pronunciation.mjs';
import { TranslatorUnavailableError, translateToRussian } from '../src/translator.mjs';
import { parseFile } from '../src/parser.mjs';
import { StandardTaskStore, processStandardDocument } from '../src/standard-processing.mjs';

test('language detection distinguishes Russian, English, and insufficient text', () => {
  assert.equal(detectLanguage('Это достаточно длинный русский текст для уверенного определения языка документа.').code, 'RU');
  assert.equal(detectLanguage('This is sufficiently long English prose for reliable language detection in a document.').code, 'EN');
  assert.equal(detectLanguage('Ceci est un texte français assez long pour ne pas être identifié comme anglais.').code, 'UNKNOWN');
  assert.equal(detectLanguage('42').code, 'UNKNOWN');
});

test('pronunciation preparation is conservative and honors user exceptions', () => {
  const result = preparePronunciation('Договор и каталог.', new Map([['договор', 'до́говор']]));
  assert.equal(result.text, 'До́говор и катало́г.');
  assert.equal(result.changes.length, 2);
});

test('TranslateGemma adapter waits for an explicitly configured endpoint', async () => {
  await assert.rejects(() => translateToRussian('Hello', { translation_provider: 'translategemma_openai', translation_endpoint: '' }), TranslatorUnavailableError);
});

test('DOCX is parsed as readable text without extracting files', async (t) => {
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'voice-over-docx-')); t.after(() => fs.rm(folder, { recursive: true, force: true }));
  const file = path.join(folder, 'document.docx'); const zip = new AdmZip();
  zip.addFile('word/document.xml', Buffer.from('<w:document xmlns:w="x"><w:body><w:p><w:r><w:t>First paragraph.</w:t></w:r></w:p><w:p><w:r><w:t>Second paragraph.</w:t></w:r></w:p></w:body></w:document>'));
  zip.writeZip(file);
  assert.equal((await parseFile(file))[0].text, 'First paragraph.\n\nSecond paragraph.');
});

test('standard task scan identifies a new stable document without creating an audio task', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'voice-over-standard-')); t.after(() => fs.rm(root, { recursive: true, force: true }));
  const input = path.join(root, 'input'); await fs.mkdir(input); await fs.writeFile(path.join(input, 'article.txt'), '# Article\nThis is sufficiently long English prose for reliable language detection in a new document.');
  const settings = { input, output: path.join(root, 'output'), data: path.join(root, 'data'), cache: path.join(root, 'cache'), standard: { stable_file_delay_ms: 0, target_language: 'ru', translation_provider: 'translategemma_openai', translation_model: 'TranslateGemma-4B', pronunciation_enabled: true, voice: 'ru-RU-DmitryNeural', rate: '+0%', audio_format: 'mp3', lock_stale_seconds: 60 } };
  const entries = await new StandardTaskStore(settings).pending();
  assert.equal(entries.length, 1); assert.equal(entries[0].language, 'EN'); assert.equal(entries[0].status, 'NEW');
  assert.equal((await fs.readdir(path.join(root, 'data', 'tasks')).catch(() => [])).length, 0);
});

test('English standard task persists original and waits for server-side TranslateGemma without TTS', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'voice-over-standard-translation-')); t.after(() => fs.rm(root, { recursive: true, force: true }));
  const input = path.join(root, 'input'); await fs.mkdir(input); await fs.writeFile(path.join(input, 'english.txt'), '# Article\nThis is sufficiently long English prose for reliable language detection in a document which must be translated before speech.');
  const settings = { file: path.join(root, 'config.toml'), input, output: path.join(root, 'output'), data: path.join(root, 'data'), cache: path.join(root, 'cache'), standard: { stable_file_delay_ms: 0, target_language: 'ru', auto_translate: true, translation_provider: 'translategemma_openai', translation_model: 'TranslateGemma-4B', translation_endpoint: '', pronunciation_enabled: true, pronunciation_exceptions: path.join(root, 'data', 'exceptions.json'), speech_enabled: true, voice: 'ru-RU-DmitryNeural', rate: '+0%', audio_format: 'mp3', lock_stale_seconds: 60 } };
  const store = new StandardTaskStore(settings); const [entry] = await store.pending();
  await assert.rejects(() => processStandardDocument(store, entry), TranslatorUnavailableError);
  const task = await store.read(entry.id);
  assert.equal(task.status, 'WAITING_TRANSLATOR');
  assert.ok(await fs.stat(task.original_copy));
  assert.equal((await fs.readdir(path.join(root, 'output')).catch(() => [])).length, 0);
});
