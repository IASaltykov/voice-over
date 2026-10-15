import crypto from 'node:crypto';
import dns from 'node:dns/promises';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import iconv from 'iconv-lite';
import { load } from 'cheerio';

const MAX_BYTES = 25 * 1024 * 1024;
const REDIRECTS = 5;
const BLOCKED_HOSTS = new Set(['localhost', 'localhost.localdomain']);
const isPrivateV4 = (ip) => /^(127\.|10\.|0\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[0-1])\.|100\.(6[4-9]|[789]\d|1[01]\d|12[0-7])\.)/.test(ip);
function unsafeAddress(address) {
  const family = net.isIP(address);
  if (family === 4) return isPrivateV4(address);
  if (family === 6) return address === '::1' || /^f[cd]/i.test(address) || /^fe[89ab]/i.test(address) || /^::ffff:(?:127|10|192\.168)/i.test(address);
  return true;
}
export function validatePublicUrl(value) {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Only HTTP and HTTPS URLs are supported');
  if (BLOCKED_HOSTS.has(url.hostname.toLowerCase()) || net.isIP(url.hostname) && unsafeAddress(url.hostname)) throw new Error('Local and private network addresses are not allowed');
  return url;
}
async function safeLookup(hostname) {
  const rows = await dns.lookup(hostname, { all: true, verbatim: true });
  if (!rows.length || rows.some((row) => unsafeAddress(row.address))) throw new Error('URL resolves to a local or private address');
  return rows;
}
function requestOnce(url, addresses, maxBytes, timeoutMs) {
  const client = url.protocol === 'https:' ? https : http;
  return new Promise((resolve, reject) => {
    const request = client.request(url, { method: 'GET', headers: { 'user-agent': 'Voice-Over/1.0 (+local document reader)', accept: 'text/html,application/xhtml+xml,text/plain,application/pdf,application/epub+zip,application/xml;q=0.9,*/*;q=0.1' }, timeout: timeoutMs, lookup: (_host, options, callback) => options?.all ? callback(null, addresses) : callback(null, addresses[0].address, addresses[0].family) }, (response) => {
      const chunks = []; let size = 0;
      response.on('data', (chunk) => { size += chunk.length; if (size > maxBytes) { request.destroy(new Error(`Download exceeds ${maxBytes} bytes`)); return; } chunks.push(chunk); });
      response.on('end', () => resolve({ status: response.statusCode || 0, headers: response.headers, body: Buffer.concat(chunks) }));
    });
    request.on('timeout', () => request.destroy(new Error('URL request timed out')));
    request.on('error', reject); request.end();
  });
}
export async function fetchPublicUrl(value, { maxBytes = MAX_BYTES, timeoutMs = 20_000 } = {}) {
  let url = validatePublicUrl(value);
  for (let redirect = 0; redirect <= REDIRECTS; redirect++) {
    const response = await requestOnce(url, await safeLookup(url.hostname), maxBytes, timeoutMs);
    if ([301, 302, 303, 307, 308].includes(response.status)) { if (!response.headers.location) throw new Error('Redirect without Location header'); url = validatePublicUrl(new URL(response.headers.location, url).href); continue; }
    if (response.status < 200 || response.status >= 300) throw new Error(`URL returned HTTP ${response.status}`);
    return { ...response, url: url.href };
  }
  throw new Error(`Too many redirects (limit: ${REDIRECTS})`);
}
function decode(buffer, contentType = '') {
  const declared = contentType.match(/charset=([^;\s]+)/i)?.[1]?.replace(/["']/g, '').toLowerCase();
  const html = buffer.subarray(0, 4096).toString('latin1').match(/<meta[^>]+charset=["']?([^\s"'>]+)/i)?.[1]?.toLowerCase();
  const encoding = html || declared || 'utf-8';
  return iconv.encodingExists(encoding) ? iconv.decode(buffer, encoding) : buffer.toString('utf8');
}
export function extractArticle(buffer, { contentType = '', sourceUrl = '' } = {}) {
  const html = decode(buffer, contentType); const $ = load(html, { xmlMode: /xhtml|xml/i.test(contentType) });
  $('script,style,noscript,svg,canvas,iframe,form,nav,footer,aside,.advertisement,.ads,.comments,.comment,.cookie,.share,.social,.navbar,#wm-ipp').remove();
  const root = $('article').first().length ? $('article').first() : $('main').first().length ? $('main').first() : $('[role="main"]').first().length ? $('[role="main"]').first() : $('body');
  const title = $('meta[property="og:title"]').attr('content') || $('h1').first().text().trim() || $('title').text().trim();
  const author = $('meta[name="author"]').attr('content') || $('[rel="author"]').first().text().trim() || $('.author,.byline').first().text().trim() || undefined;
  const parts = [];
  root.find('h1,h2,h3,p,li,blockquote').each((_index, node) => { const text = $(node).text().replace(/\s+/g, ' ').trim(); if (text.length >= 20) parts.push(/^h[1-3]$/i.test(node.tagName) ? `# ${text}` : text); });
  const text = [...new Set(parts)].join('\n\n').trim();
  if (text.length < 200 || parts.length < 2) throw new Error('Article extraction produced too little meaningful text; review the cached extraction');
  return { title: title.slice(0, 200), author: author?.slice(0, 200), text, paragraphs: parts.length, sourceUrl, language: $('html').attr('lang') || undefined, fetchedChars: html.length };
}
export const webInternals = { unsafeAddress, decode };
