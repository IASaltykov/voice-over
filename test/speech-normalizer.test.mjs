import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeForSpeech } from '../src/speech-normalizer.mjs';
import { splitText } from '../src/segmenter.mjs';
import { verifyBlockSegmentation } from '../src/integrity.mjs';

test('speech normalizer handles only unambiguous Russian editorial forms', () => {
  assert.equal(normalizeForSpeech('В 1812 г. началась война.'), 'В тысяча восемьсот двенадцатом году началась война.');
  assert.equal(normalizeForSpeech('В XVIII веке. т. д.'), 'В восемнадцатом веке. и так далее');
  assert.equal(normalizeForSpeech('А. С. Пушкин'), 'А. С. Пушкин');
  assert.equal(normalizeForSpeech('пере-\nнос слова'), 'перенос слова');
});

test('segmentation preserves normalized text and never splits a word', () => {
  const source = 'Первый абзац заканчивается здесь.\n\nВторой абзац содержит достаточно слов для разбиения на несколько безопасных частей.';
  const chunks = splitText(source, 45, 10);
  assert.ok(chunks.every((chunk) => chunk.length <= 45));
  assert.ok(verifyBlockSegmentation(source, chunks).ok);
});
