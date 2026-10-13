import dns from 'node:dns/promises';
import fs from 'node:fs/promises';
import https from 'node:https';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { probe, decodeCheck } from '../src/audio.mjs';
import { classifyEdgeError, edgeClientInfo, runtimeEnvironment, synthesizeEdge } from '../src/edge.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HOST = 'api.msedgeservices.com';
const TEST_TEXT = 'Привет! Это проверка работы синтеза речи.';

function httpsProbe() {
  return new Promise((resolve) => {
    const request = https.request({ hostname: HOST, path: '/', method: 'HEAD', timeout: 10_000 }, (response) => {
      response.resume();
      resolve({ ok: true, status: response.statusCode, tls: response.socket?.getProtocol?.() || 'unknown' });
    });
    request.on('timeout', () => request.destroy(new Error('HTTPS timeout')));
    request.on('error', (error) => resolve({ ok: false, error: String(error.message || error) }));
    request.end();
  });
}

async function main() {
  const result = {
    timestamp: new Date().toISOString(), environment: await runtimeEnvironment(), node: process.version, edge: edgeClientInfo(),
    dns: null, https: null, websocket: null, mp3: null, status: 'ERROR',
  };
  try {
    result.dns = { ok: true, addresses: (await dns.lookup(HOST, { all: true })).map((entry) => entry.address) };
  } catch (error) {
    result.dns = { ok: false, error: String(error.message || error) };
  }
  result.https = await httpsProbe();

  const directory = path.join(ROOT, 'cache', 'diagnostics');
  const audioFile = path.join(directory, 'edge-connection.mp3');
  await fs.mkdir(directory, { recursive: true });
  await fs.rm(audioFile, { force: true });
  try {
    const started = Date.now();
    await synthesizeEdge(TEST_TEXT, audioFile, { voice: 'ru-RU-DmitryNeural', rate: '-5%', timeoutSeconds: 20 });
    result.websocket = { ok: true, handshake: '101 Switching Protocols', elapsedMs: Date.now() - started };
    const metadata = await probe(audioFile);
    const decoded = metadata.valid ? await decodeCheck(audioFile) : { valid: false, detail: metadata.detail };
    result.mp3 = { exists: true, bytes: (await fs.stat(audioFile)).size, duration: metadata.duration || 0, ffprobe: metadata.valid, ffmpeg: decoded.valid };
    result.status = metadata.valid && decoded.valid ? 'WORKING' : 'ERROR';
  } catch (error) {
    const diagnosis = classifyEdgeError(error);
    result.websocket = { ok: false, stage: diagnosis.stage, classification: diagnosis.code, httpStatus: diagnosis.httpStatus || null, error: diagnosis.message };
    result.mp3 = { exists: false };
    result.status = diagnosis.code === 'HTTP_403' ? 'BLOCKED' : 'ERROR';
  }
  await fs.mkdir(path.join(ROOT, 'logs'), { recursive: true });
  await fs.writeFile(path.join(ROOT, 'logs', 'edge-connection-latest.json'), JSON.stringify(result, null, 2), 'utf8');
  console.log(JSON.stringify(result, null, 2));
  process.exitCode = result.status === 'WORKING' ? 0 : 2;
}

main().catch((error) => { console.error(error.stack || error.message); process.exitCode = 1; });
