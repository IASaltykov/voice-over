import AdmZip from 'adm-zip';

const MAX_DOCX_TEXT_BYTES = 50 * 1024 * 1024;
function decodeXml(value) { return value.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&'); }
function paragraphText(xml) {
  return [...xml.matchAll(/<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>/g)].map((item) => decodeXml(item[1])).join('').trim();
}

export function parseDocxBuffer(buffer) {
  const zip = new AdmZip(buffer);
  const entry = zip.getEntry('word/document.xml');
  if (!entry) throw new Error('DOCX does not contain word/document.xml');
  if (Number(entry.header.size || 0) > MAX_DOCX_TEXT_BYTES) throw new Error('DOCX document.xml exceeds the safe extraction limit');
  const xml = entry.getData().toString('utf8');
  const text = [...xml.matchAll(/<w:p(?:\s[^>]*)?>([\s\S]*?)<\/w:p>/g)].map((item) => paragraphText(item[1])).filter(Boolean).join('\n\n');
  if (!text) throw new Error('DOCX contains no readable text');
  return { blocks: [{ index: 1, title: '', text }], metadata: { format: 'docx' } };
}
