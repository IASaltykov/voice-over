import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fetchPublicUrl } from './web.mjs';

const extensionFor = (url, type = '') => /pdf/i.test(type) || /\.pdf(?:$|[?#])/i.test(url) ? '.pdf' : /epub/i.test(type) || /\.epub(?:$|[?#])/i.test(url) ? '.epub' : /fb2/i.test(type) || /\.fb2(?:$|[?#])/i.test(url) ? '.fb2' : /plain/i.test(type) || /\.txt(?:$|[?#])/i.test(url) ? '.txt' : '.html';
export async function materializeUrls(input, cache, directUrls = []) {
  const listFile = path.join(input, 'urls.txt'); let lines = [...directUrls];
  try { lines.push(...(await fs.readFile(listFile, 'utf8')).split(/\r?\n/)); } catch {}
  const urls = [...new Set(lines.map((line) => line.trim()).filter((line) => line && !line.startsWith('#')))];
  const root = path.join(cache, 'sources'); await fs.mkdir(root, { recursive: true }); const result = [];
  for (const sourceUrl of urls) {
    const id = crypto.createHash('sha256').update(sourceUrl).digest('hex'); const metadataFile = path.join(root, `${id}.json`);
    const response = await fetchPublicUrl(sourceUrl); const ext = extensionFor(response.url, response.headers['content-type']); const file = path.join(root, `${id}${ext}`);
    await fs.writeFile(file, response.body); await fs.writeFile(metadataFile, JSON.stringify({ sourceUrl, finalUrl: response.url, contentType: response.headers['content-type'], downloadedAt: new Date().toISOString(), bytes: response.body.length }, null, 2));
    result.push({ file, relative: path.join('articles', id), sourceUrl, metadataFile });
  }
  return result;
}
