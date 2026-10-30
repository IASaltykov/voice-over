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

test('last list item ends with a pause before following paragraph', () => {
  assert.match(normalizeForSpeech('\u2022 First\n\u2022 Second\n\nNext'), /Second\.\n\nNext/);
  assert.match(normalizeForSpeech('\u0438 \u0442. \u0434. Next'), /\u0434\u0430\u043b\u0435\u0435\. Next/);
});

test('numbered lists and year before a new sentence keep pauses', () => {
  assert.match(normalizeForSpeech('1. First\n2. Second\n\nNext'), /Second\.\n\nNext/);
  assert.match(normalizeForSpeech('1812 \u0433. Next'), /\u0433\u043e\u0434\u0443\. Next/);
});
