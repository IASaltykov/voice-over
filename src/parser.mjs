import fs from 'node:fs/promises';
import path from 'node:path';
import AdmZip from 'adm-zip';
import { XMLParser } from 'fast-xml-parser';
import { extractPdf } from './pdf.mjs';
import { extractArticle } from './web.mjs';
import { parseEpubBuffer } from './epub.mjs';

const SUPPORTED = new Set(['.txt', '.md', '.markdown', '.fb2', '.pdf', '.html', '.htm', '.xhtml', '.epub']);
const DIVIDER = /^\s*#(?:\s+(.*?))?\s*$/;
const MAX_ZIP_ENTRIES = 100;
const MAX_ZIP_UNCOMPRESSED_BYTES = 50 * 1024 * 1024;
const MAX_ZIP_COMPRESSION_RATIO = 100;

export function normalizeMarkdown(text) {
  return text.replace(/^\s{0,3}#{2,6}\s+/gm, '').replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/\[([^\]]+)\]\([^)]*\)/g, '$1').replace(/[*_~`]/g, '');
}

export function parseDelimited(text, markdown = false) {
  const blocks = [];
  let current = null;
  let title = '';
  let fence = false;
  for (const line of text.split(/\r?\n/)) {
    if (/^\s*```/.test(line)) fence = !fence;
    const match = !markdown || !fence ? line.match(DIVIDER) : null;
    if (match) {
      if (current !== null) blocks.push({ title, text: current.join('\n').trim() });
      title = (match[1] || '').trim(); current = [];
    } else if (current !== null) current.push(line);
  }
  if (current !== null) blocks.push({ title, text: (markdown ? normalizeMarkdown(current.join('\n')) : current.join('\n')).trim() });
  return blocks.map((b, i) => ({ index: i + 1, title: b.title.slice(0, 100), text: b.text }));
}

function textOf(value) {
  if (value == null) return '';
  if (typeof value === 'string' || typeof value === 'number') return String(value).trim();
  if (Array.isArray(value)) return value.map(textOf).filter(Boolean).join(' ');
  if (typeof value === 'object') return Object.entries(value).filter(([k]) => k !== 'section').map(([, v]) => textOf(v)).filter(Boolean).join(' ');
  return '';
}

function localKey(object, name) {
  return Object.keys(object || {}).find((key) => key.split(':').pop() === name);
}

function collectSections(body) {
  const key = localKey(body, 'section');
  const sections = body?.[key] || [];
  return Array.isArray(sections) ? sections : [sections];
}

function sectionContent(section) {
  const ignored = new Set(['title', 'section', 'annotation']);
  return Object.entries(section || {}).filter(([key]) => !ignored.has(key.split(':').pop())).map(([, value]) => textOf(value)).filter(Boolean).join('\n\n').trim();
}

function sectionTitle(section, fallback) {
  const title = section?.title;
  const value = textOf(title);
  return value || `Chapter ${fallback}`;
}

function fb2Blocks(data) {
  const parsed = new XMLParser({ ignoreAttributes: true, trimValues: false, parseTagValue: false }).parse(data);
  const book = parsed[localKey(parsed, 'FictionBook')] || parsed;
  const bodyKey = localKey(book, 'body');
  const bodies = book?.[bodyKey];
  const body = Array.isArray(bodies) ? bodies[0] : bodies;
  const result = [];
  const walk = (section, prefix = '') => {
    const children = collectSections(section);
    const content = sectionContent(section);
    if (content || children.length === 0) result.push({ title: sectionTitle(section, result.length + 1), text: content });
    for (const child of children) walk(child, prefix);
  };
  for (const section of collectSections(body || {})) walk(section);
  return result.filter((block) => block.text).map((block, i) => ({ index: i + 1, ...block }));
}

export function parseBuffer(buffer, extension, sourceName = '') {
  const ext = extension.toLowerCase();
  if (ext === '.fb2') return fb2Blocks(buffer.toString('utf8'));
  if (ext === '.epub') return parseEpubBuffer(buffer).blocks;
  if (['.html', '.htm', '.xhtml'].includes(ext)) return [{ index: 1, ...extractArticle(buffer, { sourceUrl: sourceName }) }];
  const text = buffer.toString('utf8').replace(/^\uFEFF/, '');
  return parseDelimited(text, ['.md', '.markdown'].includes(ext));
}

export async function parseFileDetails(file, options = {}) {
  const lower = file.toLowerCase();
  if (lower.endsWith('.fb2.zip')) {
    const zip = new AdmZip(file);
    const entries = zip.getEntries();
    if (entries.length > MAX_ZIP_ENTRIES) throw new Error(`FB2.ZIP contains too many entries (limit: ${MAX_ZIP_ENTRIES})`);
    const fb2Entries = entries.filter((entry) => !entry.isDirectory && entry.entryName.toLowerCase().endsWith('.fb2'));
    const totalSize = fb2Entries.reduce((total, entry) => total + Number(entry.header.size || 0), 0);
    if (totalSize > MAX_ZIP_UNCOMPRESSED_BYTES) throw new Error(`FB2.ZIP uncompressed FB2 data exceeds limit (${MAX_ZIP_UNCOMPRESSED_BYTES} bytes)`);
    for (const entry of fb2Entries) {
      const size = Number(entry.header.size || 0);
      const compressed = Number(entry.header.compressedSize || 0);
      if (size > 0 && (!compressed || size / compressed > MAX_ZIP_COMPRESSION_RATIO)) throw new Error(`FB2.ZIP entry has an unsafe compression ratio: ${entry.entryName}`);
    }
    return { blocks: fb2Entries.flatMap((entry) => fb2Blocks(entry.getData().toString('utf8'))) };
  }
  if (path.extname(file).toLowerCase() === '.pdf') {
    const pdf = await extractPdf(file, options.pdf || {});
    const hasHeadings = /^#\s+/m.test(pdf.markdown);
    return { blocks: hasHeadings ? pdf.blocks : [], normalizedText: pdf.markdown, pdf: pdf.metadata };
  }
  if (path.extname(file).toLowerCase() === '.epub') {
    const epub = parseEpubBuffer(await fs.readFile(file));
    return { blocks: epub.blocks, metadata: epub.metadata };
  }
  return { blocks: parseBuffer(await fs.readFile(file), path.extname(file), file) };
}

export async function parseFile(file, options = {}) {
  return (await parseFileDetails(file, options)).blocks;
}

export async function discover(root) {
  const result = [];
  async function walk(directory) {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      if (['output', 'cache', 'logs', 'models', '.git', 'node_modules'].includes(entry.name)) continue;
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.name.toLowerCase().endsWith('.fb2.zip') || SUPPORTED.has(path.extname(entry.name).toLowerCase())) result.push(full);
    }
  }
  await walk(root);
  return result.sort((a, b) => a.localeCompare(b, 'ru', { numeric: true }));
}
