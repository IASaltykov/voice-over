import AdmZip from 'adm-zip';
import { XMLParser } from 'fast-xml-parser';
import { load } from 'cheerio';

const MAX_ENTRIES = 500;
const MAX_BYTES = 100 * 1024 * 1024;
const key = (object, name) => Object.keys(object || {}).find((item) => item.split(':').pop() === name);
const textBlocks = (html) => { const $ = load(html, { xmlMode: true }); $('script,style,nav').remove(); const result = []; $('h1,h2,h3,p,li,blockquote').each((_i, node) => { const text = $(node).text().replace(/\s+/g, ' ').trim(); if (text) result.push({ title: /^h[1-3]$/i.test(node.tagName) ? text : '', text }); }); return result; };
export function parseEpubBuffer(buffer) {
  const zip = new AdmZip(buffer); const entries = zip.getEntries();
  if (entries.length > MAX_ENTRIES) throw new Error('EPUB contains too many entries');
  if (entries.reduce((sum, entry) => sum + Number(entry.header.size || 0), 0) > MAX_BYTES) throw new Error('EPUB uncompressed data exceeds safety limit');
  const container = entries.find((entry) => entry.entryName === 'META-INF/container.xml'); if (!container) throw new Error('Invalid EPUB: META-INF/container.xml is missing');
  const xml = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '' }).parse(container.getData().toString('utf8'));
  const rootfile = xml.container?.rootfiles?.rootfile?.['full-path']; if (!rootfile) throw new Error('Invalid EPUB: package path is missing');
  const opfEntry = entries.find((entry) => entry.entryName === rootfile); if (!opfEntry) throw new Error('Invalid EPUB: package file is missing');
  const opf = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '' }).parse(opfEntry.getData().toString('utf8')).package;
  const manifest = Array.isArray(opf.manifest?.item) ? opf.manifest.item : [opf.manifest?.item].filter(Boolean);
  const byId = new Map(manifest.map((item) => [item.id, item])); const spine = Array.isArray(opf.spine?.itemref) ? opf.spine.itemref : [opf.spine?.itemref].filter(Boolean);
  const base = rootfile.slice(0, rootfile.lastIndexOf('/') + 1); const blocks = [];
  for (const ref of spine) { const item = byId.get(ref.idref); if (!item || !/xhtml|html/i.test(item['media-type'] || '')) continue; const entry = entries.find((value) => value.entryName === `${base}${item.href}`); if (!entry) continue; const values = textBlocks(entry.getData().toString('utf8')); if (!values.length) continue; const title = values.find((value) => value.title)?.title || ''; const text = values.filter((value) => !value.title).map((value) => value.text).join('\n\n').trim(); if (text.length) blocks.push({ index: blocks.length + 1, title, text }); }
  if (!blocks.length) throw new Error('EPUB contains no readable XHTML spine content');
  const metadata = opf.metadata || {}; return { blocks, metadata: { title: metadata['dc:title'] || metadata.title, author: metadata['dc:creator'] || metadata.creator } };
}
