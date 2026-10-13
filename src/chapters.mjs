import crypto from 'node:crypto';
import { normalizeMarkdown } from './parser.mjs';

const heading = /^(?:Глава|Chapter)\s+\d+(?:\s*[.:—-].*)?$|^(?:Часть|Part)\s+(?:[IVXLC]+|\d+)(?:\s*[.:—-].*)?$|^(?:Пролог|Эпилог|Введение|Заключение)$/i;
export function paragraphs(text) {
  const values = []; let current = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim() || (current.length && (/^\s*#\s+\S/.test(line) || heading.test(line.trim())))) {
      if (current.length) { values.push(current.join('\n').trim()); current = []; }
      if (!line.trim()) continue;
    }
    current.push(line);
  }
  if (current.length) values.push(current.join('\n').trim());
  return values.filter(Boolean).map((text, i) => ({ id: `P${String(i + 1).padStart(6, '0')}`, index: i + 1, text }));
}

export function detectPlain(text, mode = 'auto', targetMaxWords = 5000) {
  const source = normalizeMarkdown(text);
  const ps = paragraphs(source);
  if (!ps.length) return { blocks: [], method: 'rules' };
  const starts = new Map([[1, { title: '', confidence: 1 }]]);
  const titleOf = (value) => value.split(/\r?\n/)[0].trim();
  for (const paragraph of ps) if (heading.test(titleOf(paragraph.text))) starts.set(paragraph.index, { title: titleOf(paragraph.text).slice(0, 100), confidence: 1 });
  const generatedSections = mode === 'auto' && starts.size === 1;
  if (generatedSections && targetMaxWords > 0) {
    let count = 0;
    for (const paragraph of ps.slice(0, -1)) { count += paragraph.text.split(/\s+/).length; if (count >= targetMaxWords) { starts.set(paragraph.index + 1, { title: '', confidence: 0.7 }); count = 0; } }
  }
  const ordered = [...starts.entries()].sort((a, b) => a[0] - b[0]);
  const blocks = ordered.map(([start, meta], i) => ({ index: i + 1, title: meta.title || (generatedSections ? `Раздел ${i + 1}` : ''), text: ps.slice(start - 1, ordered[i + 1]?.[0] - 1 || ps.length).map((p) => p.text).join('\n\n').trim() })).filter((block) => block.text);
  return { blocks, method: 'rules' };
}

export function cacheKey(text, settings) { return crypto.createHash('sha256').update(JSON.stringify({ text, settings, version: 1 })).digest('hex'); }
