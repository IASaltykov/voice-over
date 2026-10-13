import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { extractPdf, PdfTextLayerError, pdfInternals } from '../src/pdf.mjs';

function escapePdf(value) { return value.replace(/([\\()])/g, '\\$1'); }

function makePdf(pages) {
  const objects = [];
  const firstPage = 4;
  const pageRefs = pages.map((_, index) => `${firstPage + index * 2} 0 R`).join(' ');
  objects[1] = '<< /Type /Catalog /Pages 2 0 R >>';
  objects[2] = `<< /Type /Pages /Kids [${pageRefs}] /Count ${pages.length} >>`;
  objects[3] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>';
  pages.forEach((lines, index) => {
    const page = firstPage + index * 2;
    const content = page + 1;
    const commands = lines.map(({ text, x = 72, y = 720, size = 11 }) => `BT /F1 ${size} Tf ${x} ${y} Td (${escapePdf(text)}) Tj ET`).join('\n');
    objects[page] = `<< /Type /Page /Parent 2 0 R /Resources << /Font << /F1 3 0 R >> >> /MediaBox [0 0 612 792] /Contents ${content} 0 R >>`;
    objects[content] = `<< /Length ${Buffer.byteLength(commands)} >>\nstream\n${commands}\nendstream`;
  });
  let output = '%PDF-1.4\n';
  const offsets = [0];
  for (let number = 1; number < objects.length; number++) {
    offsets[number] = Buffer.byteLength(output);
    output += `${number} 0 obj\n${objects[number]}\nendobj\n`;
  }
  const xref = Buffer.byteLength(output);
  output += `xref\n0 ${objects.length}\n0000000000 65535 f \n`;
  for (let number = 1; number < objects.length; number++) output += `${String(offsets[number]).padStart(10, '0')} 00000 n \n`;
  output += `trailer\n<< /Size ${objects.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(output, 'utf8');
}

async function temporaryPdf(name, bytes) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'voice-over-pdf-'));
  const file = path.join(directory, name);
  await fs.writeFile(file, bytes);
  return { directory, file };
}

test('PDF text layer becomes normalized Markdown, removes repeated footer and uses cache', async (t) => {
  const fixture = await temporaryPdf('book.pdf', makePdf([
    [{ text: 'Chapter 1', size: 18 }, { text: 'First paragraph.', y: 680 }, { text: 'Demo Header', y: 770 }, { text: '1', y: 20 }],
    [{ text: 'Chapter 2', size: 18 }, { text: 'Second paragraph.', y: 680 }, { text: 'Demo Header', y: 770 }, { text: '2', y: 20 }],
  ]));
  t.after(() => fs.rm(fixture.directory, { recursive: true, force: true }));
  const cache = path.join(fixture.directory, 'cache');
  const first = await extractPdf(fixture.file, { cacheRoot: cache });
  assert.equal(first.blocks.length, 2);
  assert.match(first.markdown, /# Chapter 1/);
  assert.doesNotMatch(first.markdown, /Demo Header/);
  assert.doesNotMatch(first.markdown, /^1$/m);
  const second = await extractPdf(fixture.file, { cacheRoot: cache });
  assert.equal(second.metadata.cached, true);
});

test('PDF without a text layer reports that OCR is required', async (t) => {
  const fixture = await temporaryPdf('scan.pdf', makePdf([[]]));
  t.after(() => fs.rm(fixture.directory, { recursive: true, force: true }));
  await assert.rejects(() => extractPdf(fixture.file), PdfTextLayerError);
});

test('damaged PDF is rejected', async (t) => {
  const fixture = await temporaryPdf('broken.pdf', Buffer.from('not a PDF'));
  t.after(() => fs.rm(fixture.directory, { recursive: true, force: true }));
  await assert.rejects(() => extractPdf(fixture.file));
});

test('coordinate ordering keeps two columns separate and preserves Cyrillic text', () => {
  const content = { items: [
    { str: 'Левый один', transform: [10, 0, 0, 10, 50, 700] },
    { str: 'Левый два', transform: [10, 0, 0, 10, 50, 680] },
    { str: 'Левый три', transform: [10, 0, 0, 10, 50, 660] },
    { str: 'Правый один', transform: [10, 0, 0, 10, 360, 700] },
    { str: 'Правый два', transform: [10, 0, 0, 10, 360, 680] },
    { str: 'Правый три', transform: [10, 0, 0, 10, 360, 660] },
  ] };
  const page = pdfInternals.toPageLines(content, { width: 612, height: 792 });
  assert.equal(page.columnCount, 2);
  assert.deepEqual(page.lines.map((line) => line.text), ['Левый один', 'Левый два', 'Левый три', 'Правый один', 'Правый два', 'Правый три']);
});
