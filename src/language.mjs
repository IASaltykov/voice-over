const LETTER = /\p{L}/gu;
const CYRILLIC = /\p{Script=Cyrillic}/gu;
const LATIN = /\p{Script=Latin}/gu;
const ENGLISH_MARKERS = new Set(['the', 'and', 'that', 'this', 'with', 'from', 'for', 'are', 'was', 'were', 'have', 'has', 'will', 'into', 'about', 'english', 'article', 'document', 'research']);

export function detectLanguage(text) {
  const source = String(text || '');
  const letters = source.match(LETTER)?.length || 0;
  if (letters < 20) return { code: 'UNKNOWN', confidence: 0, reason: 'not enough alphabetic text' };
  const cyrillic = source.match(CYRILLIC)?.length || 0;
  const latin = source.match(LATIN)?.length || 0;
  if (cyrillic / letters >= 0.65) return { code: 'RU', confidence: cyrillic / letters, reason: 'Cyrillic majority' };
  if (latin / letters >= 0.65) {
    const words = source.toLowerCase().match(/[a-z]+/g) || [];
    const markers = words.filter((word) => ENGLISH_MARKERS.has(word)).length;
    if (markers >= 2 || (words.length >= 8 && markers / words.length >= 0.12)) return { code: 'EN', confidence: Math.min(0.99, latin / letters), reason: 'English markers and Latin majority' };
    return { code: 'UNKNOWN', confidence: latin / letters, reason: 'Latin text is not confidently English' };
  }
  return { code: 'UNKNOWN', confidence: Math.max(cyrillic, latin) / letters, reason: 'mixed or unsupported script' };
}
