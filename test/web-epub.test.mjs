import assert from 'node:assert/strict';
import test from 'node:test';
import AdmZip from 'adm-zip';
import { extractArticle, validatePublicUrl } from '../src/web.mjs';
import { parseEpubBuffer } from '../src/epub.mjs';

test('article extraction excludes navigation and retains headings and paragraphs', () => {
  const html = Buffer.from('<html lang="ru"><head><title>Статья</title><meta name="author" content="Автор"></head><body><nav>Меню меню меню</nav><article><h1>Заголовок</h1><p>Первый содержательный абзац статьи, достаточно длинный для проверки корректного выделения основного текста без навигационных элементов и рекламных блоков.</p><h2>Раздел</h2><p>Второй содержательный абзац статьи, также достаточно длинный для проверки извлечения и сохранения структуры публикации в результирующем документе.</p></article><footer>Подвал</footer></body></html>');
  const result = extractArticle(html, { contentType: 'text/html' });
  assert.equal(result.title, 'Заголовок'); assert.equal(result.author, 'Автор'); assert.match(result.text, /Первый/); assert.doesNotMatch(result.text, /Меню/);
});

test('URL validation blocks local network schemes and hosts', () => {
  assert.throws(() => validatePublicUrl('file:///secret'), /Only HTTP/);
  assert.throws(() => validatePublicUrl('http://127.0.0.1/'), /Local/);
  assert.equal(validatePublicUrl('https://example.org/a').hostname, 'example.org');
});

test('EPUB spine is read in order', () => {
  const zip = new AdmZip(); zip.addFile('META-INF/container.xml', Buffer.from('<container><rootfiles><rootfile full-path="OEBPS/book.opf"/></rootfiles></container>'));
  zip.addFile('OEBPS/book.opf', Buffer.from('<package><metadata><dc:title>Book</dc:title></metadata><manifest><item id="a" href="a.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="a"/></spine></package>'));
  zip.addFile('OEBPS/a.xhtml', Buffer.from('<html><body><h1>Глава</h1><p>Текст главы.</p></body></html>'));
  const result = parseEpubBuffer(zip.toBuffer()); assert.equal(result.blocks[0].title, 'Глава'); assert.equal(result.blocks[0].text, 'Текст главы.');
});
