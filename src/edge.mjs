import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';

const require = createRequire(import.meta.url);

export const EDGE_ERROR_CODES = Object.freeze({
  DNS_ERROR: 'DNS_ERROR',
  TLS_ERROR: 'TLS_ERROR',
  CONNECTION_TIMEOUT: 'CONNECTION_TIMEOUT',
  WEBSOCKET_REJECTED: 'WEBSOCKET_REJECTED',
  HTTP_403: 'HTTP_403',
  HTTP_429: 'HTTP_429',
  INVALID_SSML: 'INVALID_SSML',
  NO_AUDIO_RECEIVED: 'NO_AUDIO_RECEIVED',
  INVALID_AUDIO: 'INVALID_AUDIO',
  UNKNOWN_ERROR: 'UNKNOWN_ERROR',
});

export function edgeClientInfo() {
  const pkg = require('node-edge-tts/package.json');
  const endpoint = 'wss://api.msedgeservices.com/tts/cognitiveservices/websocket/v1';
  return { library: pkg.name, version: pkg.version, endpoint, endpointHost: new URL(endpoint).host, gecVersion: 'managed-by-node-edge-tts' };
}

export function classifyEdgeError(error, stage = 'WebSocket handshake') {
  const message = String(error?.message || error || '').replace(/[\r\n]+/g, ' ').trim();
  const status = Number(error?.statusCode || error?.status || message.match(/(?:response|status)\s*:?\s*(\d{3})/i)?.[1] || 0) || undefined;
  const rawHeaders = error?.headers || error?.response?.headers;
  const entries = rawHeaders?.entries ? [...rawHeaders.entries()] : Object.entries(rawHeaders || {});
  const headers = Object.fromEntries(entries.filter(([key]) => /^(date|retry-after|server|x-ratelimit-|ratelimit-)/i.test(key)).map(([key, value]) => [String(key).toLowerCase(), String(value)]));
  const retryAfter = error?.retryAfter || headers['retry-after'] || message.match(/retry-after\s*:?\s*([^\s,;]+)/i)?.[1];
  let code = EDGE_ERROR_CODES.UNKNOWN_ERROR;
  let resolvedStage = stage;
  if (status === 403) code = EDGE_ERROR_CODES.HTTP_403;
  else if (status === 429) code = EDGE_ERROR_CODES.HTTP_429;
  else if (/ENOTFOUND|getaddrinfo|dns/i.test(message)) code = EDGE_ERROR_CODES.DNS_ERROR;
  else if (/certificate|TLS|SSL|EPROTO/i.test(message)) code = EDGE_ERROR_CODES.TLS_ERROR;
  else if (/timed out|timeout/i.test(message)) code = EDGE_ERROR_CODES.CONNECTION_TIMEOUT;
  else if (/Unexpected server response|websocket|handshake/i.test(message)) code = EDGE_ERROR_CODES.WEBSOCKET_REJECTED;
  else if (/ssml|xml|invalid.*(voice|rate|prosody)/i.test(message)) { code = EDGE_ERROR_CODES.INVALID_SSML; resolvedStage = 'SSML submission'; }
  else if (/no audio|turn\.end/i.test(message)) { code = EDGE_ERROR_CODES.NO_AUDIO_RECEIVED; resolvedStage = 'Audio receive'; }
  const info = edgeClientInfo();
  return { code, stage: resolvedStage, statusCode: status, httpStatus: status, headers, serverDate: headers.date, retryAfter: retryAfter ? String(retryAfter) : undefined, endpointHost: info.endpointHost, gecVersion: info.gecVersion, clientVersion: info.version, message: message || 'Unknown Edge TTS error', retryable: ![EDGE_ERROR_CODES.HTTP_403, EDGE_ERROR_CODES.HTTP_429, EDGE_ERROR_CODES.INVALID_SSML].includes(code) };
}

export function formatEdgeDiagnostic({ environment, voice, attempt, attempts, error }) {
  return [
    'EDGE TTS ERROR',
    `Stage: ${error.stage}`,
    `Classification: ${error.code}`,
    `HTTP status: ${error.httpStatus || 'n/a'}`,
    `Retry-After: ${error.retryAfter || 'not provided'}`,
    `Environment: ${environment}`,
    `Voice: ${voice}`,
    `Attempt: ${attempt}/${attempts}`,
    `Result: ${error.message}`,
  ].join('\n');
}

export async function synthesizeEdge(text, file, { voice, rate, pitch = 'default', volume = 'default', audioFormat = 'audio-24khz-48kbitrate-mono-mp3', timeoutSeconds, timeout, socketTimeoutSeconds = 30 }) {
  const { WebSocket } = require('ws');
  const { TRUSTED_CLIENT_TOKEN, CHROMIUM_FULL_VERSION, generateSecMsGecToken } = require('node-edge-tts/dist/drm.js');
  const overallSeconds = Number(timeoutSeconds ?? timeout ?? 90);
  const limitMs = Math.max(1000, (Number(socketTimeoutSeconds) || 30) * 1000);
  const parts = [];
  await new Promise((resolve, reject) => {
    const ws = new WebSocket(`${edgeClientInfo().endpoint}?Ocp-Apim-Subscription-Key=${TRUSTED_CLIENT_TOKEN}&Sec-MS-GEC=${generateSecMsGecToken()}&Sec-MS-GEC-Version=1-${CHROMIUM_FULL_VERSION}`, {
      handshakeTimeout: limitMs,
      origin: 'chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold',
      headers: { 'User-Agent': `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${CHROMIUM_FULL_VERSION.split('.')[0]}.0.0.0 Safari/537.36 Edg/${CHROMIUM_FULL_VERSION.split('.')[0]}.0.0.0` },
    });
    let settled = false;
    let idleTimer;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(idleTimer); clearTimeout(overallTimer);
      ws.terminate();
      if (error) reject(error); else resolve();
    };
    const resetIdle = () => { clearTimeout(idleTimer); idleTimer = setTimeout(() => finish(new Error('Edge TTS socket inactivity timeout')), limitMs); };
    const overallTimer = setTimeout(() => finish(new Error('Edge TTS overall timeout')), Math.max(1000, overallSeconds * 1000));
    const escape = (value) => String(value).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]));
    ws.on('error', finish);
    ws.on('close', () => finish(new Error('No audio completion: WebSocket closed before turn.end')));
    ws.on('unexpected-response', (_, response) => {
      const error = new Error(`Unexpected server response: ${response.statusCode}`);
      error.statusCode = response.statusCode; error.headers = response.headers;
      response.resume(); finish(error);
    });
    ws.on('open', () => {
      resetIdle();
      ws.send('Content-Type:application/json; charset=utf-8\r\nPath:speech.config\r\n\r\n' + JSON.stringify({ context: { synthesis: { audio: { metadataoptions: { sentenceBoundaryEnabled: 'false', wordBoundaryEnabled: 'false' }, outputFormat: audioFormat } } } }));
      ws.send(`X-RequestId:${randomUUID().replaceAll('-', '')}\r\nContent-Type:application/ssml+xml\r\nPath:ssml\r\n\r\n<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="${escape(voice.split('-').slice(0, 2).join('-'))}"><voice name="${escape(voice)}"><prosody rate="${escape(rate)}" pitch="${escape(pitch)}" volume="${escape(volume)}">${escape(text)}</prosody></voice></speak>`);
    });
    ws.on('message', (data, binary) => {
      if (settled) return;
      resetIdle();
      if (binary && data.length >= 2) {
        const headerLength = data.readUInt16BE(0);
        if (data.subarray(2, 2 + headerLength).toString().includes('Path:audio')) parts.push(data.subarray(2 + headerLength));
      } else if (!binary && data.toString().includes('Path:turn.end')) finish();
    });
  });
  if (!parts.length) throw new Error('No audio was received');
  await fs.writeFile(file, Buffer.concat(parts));
  const stat = await fs.stat(file);
  if (stat.size === 0) throw new Error('No audio was received: output file is empty');
}

export async function runtimeEnvironment() {
  try {
    await fs.access('/.dockerenv');
    return 'Docker';
  } catch {
    return process.platform === 'win32' ? 'Windows' : process.platform;
  }
}
