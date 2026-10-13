import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

const MAX_PDF_BYTES = 250 * 1024 * 1024;
const PAGE_NUMBER = /^\s*(?:\d+|[ivxlcdm]+)\s*$/i;
const HEADING_WORDS = /^(?:глава|часть|раздел|chapter|part|prologue|epilogue|пролог|эпилог|введение|заключение)\b/i;

function sha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function median(values) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function cleanText(text) {
  return text
    .replace(/\u0000/g, '')
    .replace(/\s+/g, ' ')
    .replace(/\s+([,.;:!?])/g, '$1')
    .trim();
}

function joinLines(lines) {
  const paragraph = [];
  for (const line of lines) {
    const value = cleanText(line.text);
    if (!value) continue;
    const previous = paragraph.at(-1);
    if (previous && /[\p{L}\p{N}]-$/u.test(previous) && /^[\p{Ll}]/u.test(value)) {
      paragraph[paragraph.length - 1] = previous.slice(0, -1) + value;
    } else {
      paragraph.push(value);
    }
  }
  return paragraph.join(' ');
}

function lineFromItems(items, y) {
  const sorted = [...items].sort((a, b) => a.x - b.x);
  return {
    text: cleanText(sorted.map((item) => item.text).join(' ')),
    x: sorted[0]?.x ?? 0,
    y,
    size: median(sorted.map((item) => item.size)),
  };
}

function columnsFor(lines, pageWidth) {
  if (lines.length < 6) return [lines];
  const centers = lines.map((line) => line.x).sort((a, b) => a - b);
  let largest = { gap: 0, at: 0 };
  for (let i = 1; i < centers.length; i++) {
    const gap = centers[i] - centers[i - 1];
    if (gap > largest.gap) largest = { gap, at: (centers[i] + centers[i - 1]) / 2 };
  }
  if (largest.gap < pageWidth * 0.18) return [lines];
  const left = lines.filter((line) => line.x < largest.at);
  const right = lines.filter((line) => line.x >= largest.at);
  if (left.length < 3 || right.length < 3) return [lines];
  return [left, right];
}

function toPageLines(content, viewport) {
  const items = content.items
    .filter((item) => typeof item.str === 'string' && item.str.trim())
    .map((item) => ({
      text: item.str,
      x: Number(item.transform?.[4] || 0),
      y: Number(item.transform?.[5] || 0),
      size: Math.max(Math.abs(Number(item.transform?.[0] || 0)), Math.abs(Number(item.transform?.[3] || 0))),
    }));
  const tolerance = Math.max(1.5, median(items.map((item) => item.size)) * 0.35);
  const rows = [];
  for (const item of items.sort((a, b) => b.y - a.y || a.x - b.x)) {
    const row = rows.find((candidate) => Math.abs(candidate.y - item.y) <= tolerance);
    if (row) row.items.push(item);
    else rows.push({ y: item.y, items: [item] });
  }
  const lines = rows.flatMap((row) => {
    const sorted = [...row.items].sort((a, b) => a.x - b.x);
    const groups = [];
    let current = [];
    for (const item of sorted) {
      const previous = current.at(-1);
      const gap = previous ? item.x - previous.x : 0;
      if (previous && gap > Math.max(28, Math.max(previous.size, item.size) * 4)) {
        groups.push(current);
        current = [];
      }
      current.push(item);
    }
    if (current.length) groups.push(current);
    return groups.map((group) => lineFromItems(group, row.y));
  }).filter((line) => line.text);
  const columns = columnsFor(lines, viewport.width).map((column) => column.sort((a, b) => b.y - a.y || a.x - b.x));
  return { lines: columns.flat(), columnCount: columns.length, width: viewport.width, height: viewport.height };
}

function repeatedMarginText(pages) {
  const occurrences = new Map();
  for (const page of pages) {
    const seen = new Set();
    for (const line of page.lines) {
      const margin = line.y > page.height * 0.88 || line.y < page.height * 0.12;
      const value = line.text.toLowerCase();
      if (margin && value.length > 2 && !PAGE_NUMBER.test(value) && !seen.has(value)) {
        seen.add(value);
        occurrences.set(value, (occurrences.get(value) || 0) + 1);
      }
    }
  }
  const threshold = Math.max(2, Math.ceil(pages.length * 0.6));
  return new Set([...occurrences].filter(([, count]) => count >= threshold).map(([text]) => text));
}

function pageToMarkdown(page, repeated) {
  const usable = page.lines.filter((line) => !PAGE_NUMBER.test(line.text) && !repeated.has(line.text.toLowerCase()));
  if (!usable.length) return [];
  const bodySize = median(usable.map((line) => line.size).filter(Boolean)) || 10;
  const gapBase = median(usable.slice(1).map((line, index) => Math.abs(usable[index].y - line.y)).filter(Boolean)) || bodySize * 1.25;
  const result = [];
  let paragraph = [];
  const flush = () => {
    const text = joinLines(paragraph);
    if (text) result.push(text);
    paragraph = [];
  };
  for (let index = 0; index < usable.length; index++) {
    const line = usable[index];
    const previous = usable[index - 1];
    const heading = (line.size >= bodySize * 1.22 && line.text.length <= 160) || (HEADING_WORDS.test(line.text) && line.text.length <= 180);
    const largeGap = previous && Math.abs(previous.y - line.y) > gapBase * 1.55;
    if (heading) {
      flush();
      result.push(`# ${line.text}`);
      continue;
    }
    if (largeGap) flush();
    paragraph.push(line);
  }
  flush();
  return result;
}

function markdownToBlocks(markdown) {
  const blocks = [];
  let title = '';
  let text = [];
  const flush = () => {
    const value = text.join('\n\n').trim();
    if (value) blocks.push({ index: blocks.length + 1, title, text: value });
    text = [];
  };
  for (const line of markdown.split(/\r?\n/)) {
    const match = line.match(/^#\s+(.+)$/);
    if (match) {
      flush();
      title = match[1].trim().slice(0, 100);
    } else if (line.trim()) text.push(line.trim());
  }
  flush();
  return blocks;
}

export class PdfTextLayerError extends Error {
  constructor(message) {
    super(message);
    this.name = 'PdfTextLayerError';
  }
}

export async function extractPdf(file, { cacheRoot, maxBytes = MAX_PDF_BYTES } = {}) {
  const stat = await fs.stat(file);
  if (stat.size > maxBytes) throw new Error(`PDF exceeds configured size limit (${maxBytes} bytes): ${file}`);
  const data = await fs.readFile(file);
  const id = sha256(data);
  const directory = cacheRoot ? path.join(cacheRoot, 'pdf') : null;
  const markdownFile = directory ? path.join(directory, `${id}.md`) : null;
  const metadataFile = directory ? path.join(directory, `${id}.json`) : null;
  if (markdownFile) {
    try {
      const [markdown, metadata] = await Promise.all([fs.readFile(markdownFile, 'utf8'), fs.readFile(metadataFile, 'utf8').then(JSON.parse)]);
      return { id, markdown, blocks: markdownToBlocks(markdown), metadata: { ...metadata, cached: true } };
    } catch {}
  }

  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const task = pdfjs.getDocument({ data: new Uint8Array(data), disableWorker: true, stopAtErrors: false, useSystemFonts: true });
  let document;
  try {
    document = await task.promise;
    const pages = [];
    let extractedChars = 0;
    let columnsDetected = 0;
    for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber++) {
      const page = await document.getPage(pageNumber);
      const viewport = page.getViewport({ scale: 1 });
      const content = await page.getTextContent({ includeMarkedContent: false, disableNormalization: false });
      const pageData = toPageLines(content, viewport);
      extractedChars += pageData.lines.reduce((total, line) => total + line.text.length, 0);
      if (pageData.columnCount > 1) columnsDetected++;
      pages.push(pageData);
      page.cleanup();
    }
    if (!extractedChars) throw new PdfTextLayerError('PDF does not contain extractable text. OCR is required for scanned pages.');
    const repeated = repeatedMarginText(pages);
    const markdown = `${pages.flatMap((page) => pageToMarkdown(page, repeated)).join('\n\n').replace(/\n{3,}/g, '\n\n').trim()}\n`;
    if (!markdown.trim()) throw new PdfTextLayerError('PDF text layer is empty after normalization. OCR is required.');
    const metadata = { id, pages: pages.length, extractedChars, columnsDetected, repeatedMarginsRemoved: repeated.size, cached: false, format: 'Normalized Markdown V2' };
    if (directory) {
      await fs.mkdir(directory, { recursive: true });
      await Promise.all([fs.writeFile(markdownFile, markdown, 'utf8'), fs.writeFile(metadataFile, JSON.stringify(metadata, null, 2), 'utf8')]);
    }
    return { id, markdown, blocks: markdownToBlocks(markdown), metadata };
  } finally {
    document?.cleanup?.();
    await task.destroy?.();
  }
}

export const pdfInternals = { markdownToBlocks, pageToMarkdown, toPageLines, joinLines };
