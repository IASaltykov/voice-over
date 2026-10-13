import assert from 'node:assert/strict';
import test from 'node:test';
import { classifyEdgeError, edgeClientInfo } from '../src/edge.mjs';

test('Edge handshake HTTP 403 is classified as non-retryable', () => {
  const result = classifyEdgeError(new Error('Unexpected server response: 403'));
  assert.equal(result.code, 'HTTP_403');
  assert.equal(result.stage, 'WebSocket handshake');
  assert.equal(result.httpStatus, 403);
  assert.equal(result.retryable, false);
});

test('network and audio failures remain distinguishable', () => {
  assert.equal(classifyEdgeError(new Error('getaddrinfo ENOTFOUND api.msedgeservices.com')).code, 'DNS_ERROR');
  assert.equal(classifyEdgeError(new Error('No audio was received')).code, 'NO_AUDIO_RECEIVED');
  assert.equal(classifyEdgeError(new Error('WebSocket timeout')).code, 'CONNECTION_TIMEOUT');
});

test('Edge client metadata identifies the maintained Node client', () => {
  const info = edgeClientInfo();
  assert.equal(info.library, 'node-edge-tts');
  assert.match(info.version, /^1\.2\./);
});
