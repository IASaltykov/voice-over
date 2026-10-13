import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import { EdgeTTS } from 'node-edge-tts';

const require = createRequire(import.meta.url);

export const EDGE_ERROR_CODES = Object.freeze({
  DNS_ERROR: 'DNS_ERROR',
  TLS_ERROR: 'TLS_ERROR',
  CONNECTION_TIMEOUT: 'CONNECTION_TIMEOUT',
  WEBSOCKET_REJECTED: 'WEBSOCKET_REJECTED',
  HTTP_403: 'HTTP_403',
  INVALID_SSML: 'INVALID_SSML',
  NO_AUDIO_RECEIVED: 'NO_AUDIO_RECEIVED',
  INVALID_AUDIO: 'INVALID_AUDIO',
  UNKNOWN_ERROR: 'UNKNOWN_ERROR',
});

export function edgeClientInfo() {
  const pkg = require('node-edge-tts/package.json');
  return { library: pkg.name, version: pkg.version, endpoint: 'wss://api.msedgeservices.com/tts/cognitiveservices/websocket/v1' };
}

export function classifyEdgeError(error, stage = 'WebSocket handshake') {
  const message = String(error?.message || error || '').replace(/[\r\n]+/g, ' ').trim();
  const status = Number(message.match(/(?:response|status)\s*:?\s*(\d{3})/i)?.[1] || 0) || undefined;
  let code = EDGE_ERROR_CODES.UNKNOWN_ERROR;
  let resolvedStage = stage;
  if (status === 403) code = EDGE_ERROR_CODES.HTTP_403;
  else if (/ENOTFOUND|getaddrinfo|dns/i.test(message)) code = EDGE_ERROR_CODES.DNS_ERROR;
  else if (/certificate|TLS|SSL|EPROTO/i.test(message)) code = EDGE_ERROR_CODES.TLS_ERROR;
  else if (/timed out|timeout/i.test(message)) code = EDGE_ERROR_CODES.CONNECTION_TIMEOUT;
  else if (/Unexpected server response|websocket|handshake/i.test(message)) code = EDGE_ERROR_CODES.WEBSOCKET_REJECTED;
  else if (/ssml|xml|invalid.*(voice|rate|prosody)/i.test(message)) { code = EDGE_ERROR_CODES.INVALID_SSML; resolvedStage = 'SSML submission'; }
  else if (/no audio|turn\.end/i.test(message)) { code = EDGE_ERROR_CODES.NO_AUDIO_RECEIVED; resolvedStage = 'Audio receive'; }
  return { code, stage: resolvedStage, httpStatus: status, message: message || 'Unknown Edge TTS error', retryable: ![EDGE_ERROR_CODES.HTTP_403, EDGE_ERROR_CODES.INVALID_SSML].includes(code) };
}

export function formatEdgeDiagnostic({ environment, voice, attempt, attempts, error }) {
  return [
    'EDGE TTS ERROR',
    `Stage: ${error.stage}`,
    `Classification: ${error.code}`,
    `HTTP status: ${error.httpStatus || 'n/a'}`,
    `Environment: ${environment}`,
    `Voice: ${voice}`,
    `Attempt: ${attempt}/${attempts}`,
    `Result: ${error.message}`,
  ].join('\n');
}

export async function synthesizeEdge(text, file, { voice, rate, timeoutSeconds, timeout, socketTimeoutSeconds = 30 }) {
  const overallSeconds = Number(timeoutSeconds ?? timeout ?? 90);
  const limitMs = Math.max(1000, Math.min(overallSeconds, Number(socketTimeoutSeconds) || 30) * 1000);
  const client = new EdgeTTS({ voice, lang: voice.split('-').slice(0, 2).join('-'), rate, timeout: limitMs });
  const parts = [];
  const iterator = client.streamAudio(text)[Symbol.asyncIterator]();
  let timer;
  const timeoutPromise = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Edge TTS socket timeout')), limitMs); });
  try {
    while (true) {
      const next = await Promise.race([iterator.next(), timeoutPromise]);
      if (next.done) break;
      if (Buffer.isBuffer(next.value) && next.value.length) parts.push(next.value);
    }
  } finally {
    clearTimeout(timer);
    void iterator.return?.().catch(() => {});
  }
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
