/**
 * Canonical form for text that is sent to TTS.  It intentionally normalizes
 * whitespace only: punctuation and words must remain untouched.
 */
export function normalizeSpeechText(value) {
  return String(value || '').replace(/\s+/gu, ' ').trim();
}

export function verifyBlockSegmentation(source, chunks) {
  const expected = normalizeSpeechText(source);
  const actual = normalizeSpeechText((chunks || []).join(' '));
  return {
    ok: expected === actual,
    expectedLength: expected.length,
    actualLength: actual.length,
    detail: expected === actual ? '' : 'Text changed while splitting into TTS fragments',
  };
}

/**
 * The parser output is the project's "normalized source for speech": titles
 * and document markup are metadata, while every block.text is spoken text.
 */
export function verifyDocumentBlocks(blocks) {
  const invalid = (blocks || []).filter((block) => !normalizeSpeechText(block.text));
  return {
    ok: invalid.length === 0,
    blocks: blocks?.length || 0,
    detail: invalid.length ? `Empty spoken blocks: ${invalid.map((block) => block.index).join(', ')}` : '',
  };
}
