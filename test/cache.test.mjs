import test from 'node:test';
import assert from 'node:assert/strict';
import { isCurrentOutput } from '../src/cache.mjs';

const current = { filename: '01.mp3', textHash: 'text-a', configHash: 'config-a' };
const request = (overrides = {}) => ({ target: '01.mp3', previous: current, textHash: 'text-a', configHash: 'config-a', filename: '01.mp3', probe: async () => ({ valid: true }), ...overrides });

test('cache reuses only a valid MP3 with matching text and settings', async () => {
  assert.equal(await isCurrentOutput(request()), true);
  assert.equal(await isCurrentOutput(request({ textHash: 'text-b' })), false);
  assert.equal(await isCurrentOutput(request({ configHash: 'config-b' })), false);
  assert.equal(await isCurrentOutput(request({ probe: async () => ({ valid: false }) })), false);
  assert.equal(await isCurrentOutput(request({ previous: { ...current, filename: 'old.mp3' } })), false);
});
