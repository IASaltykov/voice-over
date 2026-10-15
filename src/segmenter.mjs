export function splitText(text, limit = 700, minChars = 150) {
  if (limit < 20) throw new Error('max-chars must be at least 20');
  const normalized = text.replace(/\r\n/g, '\n').replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
  if (!normalized) return [];
  const sentences = normalized.split(/\n{2,}/).flatMap((paragraph) => paragraph.replace(/\n/g, ' ').match(/.*?(?:[.!?…]+(?=\s|$)|$)/g)?.map((value) => value.trim()).filter(Boolean) || [paragraph.trim()]);
  const chunks = [];
  let current = '';
  for (const sentence of sentences) {
    if (sentence.length <= limit && (!current || current.length + sentence.length + 1 <= limit)) {
      current = `${current} ${sentence}`.trim(); continue;
    }
    if (current) chunks.push(current);
    current = '';
    if (sentence.length <= limit) { current = sentence; continue; }
    let piece = '';
    for (const word of sentence.split(' ')) {
      if (piece && piece.length + word.length + 1 > limit) { chunks.push(piece); piece = ''; }
      piece = `${piece} ${word}`.trim();
    }
    current = piece;
  }
  if (current) chunks.push(current);
  return chunks;
}
