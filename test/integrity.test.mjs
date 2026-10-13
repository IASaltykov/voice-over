import test from 'node:test';
import assert from 'node:assert/strict';
import { verifyBlockSegmentation, verifyDocumentBlocks } from '../src/integrity.mjs';
import { splitText } from '../src/segmenter.mjs';

test('Russian text survives segmentation byte-for-word', () => {
  const text = 'Глава начинается здесь. Затем идёт второе предложение… И последнее предложение!';
  const chunks = splitText(text, 34);
  assert.ok(chunks.length >= 2);
  assert.equal(verifyBlockSegmentation(text, chunks).ok, true);
});

test('integrity guard detects lost punctuation or text', () => {
  const result = verifyBlockSegmentation('Первый текст. Второй текст.', ['Первый текст.', 'Второй']);
  assert.equal(result.ok, false);
  assert.match(result.detail, /Text changed/);
});

test('document guard rejects empty spoken blocks', () => {
  assert.equal(verifyDocumentBlocks([{ index: 1, text: 'Есть текст' }, { index: 2, text: '   ' }]).ok, false);
  assert.equal(verifyDocumentBlocks([{ index: 1, text: 'Есть текст' }]).ok, true);
});
