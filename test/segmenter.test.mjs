import test from 'node:test';
import assert from 'node:assert/strict';
import { splitText } from '../src/segmenter.mjs';

test('long text is split without losing words', () => {
  const text = 'Первое предложение. ' + Array.from({ length: 30 }, () => 'слово').join(' ');
  const chunks = splitText(text, 40);
  assert.ok(chunks.length > 1);
  assert.deepEqual(chunks.join(' ').split(/\s+/), text.split(/\s+/));
});
