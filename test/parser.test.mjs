import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import AdmZip from 'adm-zip';
import { parseDelimited, parseFile } from '../src/parser.mjs';
import { detectPlain } from '../src/chapters.mjs';

test('TXT delimiters preserve inline hash characters', () => {
  const blocks = parseDelimited('#\nТекст # внутри.\n#\nВторой блок.');
  assert.equal(blocks.length, 2);
  assert.equal(blocks[0].text, 'Текст # внутри.');
});

test('plain chapter headings are detected without an LLM', () => {
  const result = detectPlain('Глава 1\nПервый текст.\nГлава 2. Продолжение\nВторой текст.', 'auto');
  assert.deepEqual(result.blocks.map((block) => block.title), ['Глава 1', 'Глава 2. Продолжение']);
});

test('plain text without headings receives neutral automatic section titles', () => {
  const result = detectPlain('Первый абзац.\n\nВторой абзац.', 'auto', 100);
  assert.equal(result.blocks[0].title, 'Раздел 1');
});

test('Markdown and FB2 are parsed into named blocks', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'voice-over-parser-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const markdown = path.join(directory, 'book.md');
  const fb2 = path.join(directory, 'book.fb2');
  await fs.writeFile(markdown, '# First\nMarkdown text.\n\n# Second\nMore text.', 'utf8');
  await fs.writeFile(fb2, '<?xml version="1.0"?><FictionBook><body><section><title><p>Chapter One</p></title><p>FB2 text.</p></section></body></FictionBook>', 'utf8');
  assert.deepEqual((await parseFile(markdown)).map((block) => block.title), ['First', 'Second']);
  assert.equal((await parseFile(fb2))[0].text, 'FB2 text.');
});

test('FB2.ZIP is parsed without extracting user files', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'voice-over-zip-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'book.fb2.zip');
  const zip = new AdmZip();
  zip.addFile('inside.fb2', Buffer.from('<FictionBook><body><section><title><p>Zip Chapter</p></title><p>Text in zip.</p></section></body></FictionBook>'));
  zip.writeZip(file);
  const blocks = await parseFile(file);
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].title, 'Zip Chapter');
});

test('FB2.ZIP rejects unsafe compression ratio before decompression', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'voice-over-zip-limit-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'unsafe.fb2.zip');
  const zip = new AdmZip();
  zip.addFile('inside.fb2', Buffer.from('x'.repeat(1024 * 1024)));
  zip.writeZip(file);
  await assert.rejects(() => parseFile(file), /unsafe compression ratio/);
});
