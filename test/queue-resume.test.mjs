import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { FragmentCache, fragmentDescriptor } from '../src/fragment-cache.mjs';
import { TtsQueue, jitterDelay, next429RetryAt, parseRetryAfter, validateQueueConfig } from '../src/tts-queue.mjs';
import { mainInternals } from '../src/main.mjs';

const settings = { voice: 'ru-RU-DmitryNeural', rate: '-5%' };
const validateAudio = async (file) => {
  const bytes = await fs.readFile(file).catch(() => Buffer.alloc(0));
  return { valid: bytes.toString().startsWith('valid-mp3-'), duration: 1.25, detail: 'fake validator' };
};

test('queue remains sequential and respects local pacing', async () => {
  let clock = 0;
  const waits = [];
  const queue = new TtsQueue({ min_interval_ms: 10, normal_jitter_max_ms: 0, max_requests_per_minute: 2 }, { now: () => clock, sleep: async (ms) => { waits.push(ms); clock += ms; } });
  const started = [];
  await Promise.all([1, 2, 3].map((id) => queue.run(async () => { started.push({ id, at: clock }); })));
  assert.deepEqual(started.map((item) => item.id), [1, 2, 3]);
  assert.ok(waits.includes(10));
  assert.ok(waits.some((wait) => wait >= 59_000));
});

test('adaptive pacing speeds up after successes and slows down after a rate limit', () => {
  const queue = new TtsQueue({ min_interval_ms: 4000, adaptive_min_interval_ms: 3000, adaptive_max_interval_ms: 9000, adaptive_successes_before_speedup: 2, adaptive_step_down_ms: 250, adaptive_rate_limit_multiplier: 1.5 });
  queue.recordSuccess();
  assert.equal(queue.pacingSnapshot().intervalMs, 4000);
  queue.recordSuccess();
  assert.equal(queue.pacingSnapshot().intervalMs, 3750);
  queue.recordRateLimit();
  assert.equal(queue.pacingSnapshot().intervalMs, 5625);
  const restored = new TtsQueue({ min_interval_ms: 4000, adaptive_min_interval_ms: 3000, adaptive_max_interval_ms: 9000 }, { pacingState: queue.pacingSnapshot() });
  assert.equal(restored.pacingSnapshot().intervalMs, 5625);
});

test('configuration rejects an uncontrolled queue', () => {
  assert.throws(() => validateQueueConfig({ min_interval_ms: 0 }), /invalid/);
  assert.throws(() => validateQueueConfig({ concurrency: 2 }), /exactly 1/);
  assert.throws(() => validateQueueConfig({ max_requests_per_minute: 0 }), /invalid/);
  assert.throws(() => validateQueueConfig({ min_interval_ms: '5000' }), /invalid/);
  assert.throws(() => validateQueueConfig({ stop_on_http_429: 'yes' }), /true or false/);
  assert.equal(validateQueueConfig({}).immediateResumeWithoutRetryAfter, false);
  assert.throws(() => validateQueueConfig({ immediate_resume_without_retry_after: 'yes' }), /true or false/);
});

test('fragment key is deterministic and independent of temporary paths', () => {
  const first = fragmentDescriptor('Одинаковый фрагмент.', settings);
  const second = fragmentDescriptor('Одинаковый фрагмент.', settings);
  assert.equal(first.key, second.key);
  assert.equal(first.textSha256, second.textSha256);
  assert.notEqual(first.key, fragmentDescriptor('Одинаковый фрагмент.', { ...settings, rate: '+5%' }).key);
});

test('jitter strategies and Retry-After never schedule earlier than allowed', () => {
  assert.equal(jitterDelay('none', 100, 1000, 2, 100, () => 0.5), 400);
  assert.equal(jitterDelay('full', 100, 1000, 2, 100, () => 0.5), 200);
  assert.equal(jitterDelay('equal', 100, 1000, 2, 100, () => 0.5), 300);
  assert.equal(jitterDelay('decorrelated', 100, 1000, 0, 200, () => 0.5), 350);
  const now = Date.UTC(2026, 0, 1);
  assert.equal(parseRetryAfter('60', now), now + 60_000);
  assert.equal(parseRetryAfter('Thu, 01 Jan 2026 00:02:00 GMT', now), now + 120_000);
  const config = validateQueueConfig({ http_429_jitter_ratio: 0.15 });
  assert.ok(next429RetryAt({ retryAfter: '60', config, now, random: () => 0 }) >= now + 60_000);
  assert.ok(next429RetryAt({ config, event: 2, now, random: () => 0 }) >= now + 120_000);
});

test('HTTP 429 style interruption preserves five fragments and resume uses them', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'voice-over-resume-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const source = path.join(root, 'source.mp3');
  const cache = new FragmentCache(root, { validateAudio });
  const fragments = Array.from({ length: 6 }, (_, index) => `fragment ${index + 1}`);
  const firstQueue = new TtsQueue({ min_interval_ms: 1, normal_jitter_max_ms: 0, max_requests_per_minute: 60 });
  let firstRequests = 0;
  for (let index = 0; index < fragments.length; index++) {
    const descriptor = fragmentDescriptor(fragments[index], settings);
    if (index === 5) {
      await assert.rejects(() => firstQueue.run(async () => { firstRequests++; throw new Error('Unexpected server response: 429'); }), /429/);
      firstQueue.pause('HTTP 429');
      break;
    }
    await firstQueue.run(async () => { firstRequests++; await fs.writeFile(source, `valid-mp3-${index}`); });
    await cache.save(descriptor, source);
  }
  assert.equal(firstRequests, 6);
  assert.equal((await Promise.all(fragments.slice(0, 5).map((text) => cache.get(fragmentDescriptor(text, settings))))).filter(Boolean).length, 5);
  assert.equal(await cache.get(fragmentDescriptor(fragments[5], settings)), null);

  let resumedRequests = 0;
  for (let index = 0; index < fragments.length; index++) {
    const descriptor = fragmentDescriptor(fragments[index], settings);
    if (await cache.get(descriptor)) continue;
    resumedRequests++;
    await fs.writeFile(source, `valid-mp3-resume-${index}`);
    await cache.save(descriptor, source);
  }
  assert.equal(resumedRequests, 1);
  assert.equal((await Promise.all(fragments.map((text) => cache.get(fragmentDescriptor(text, settings))))).filter(Boolean).length, 6);
});

test('corrupt cache and changed voice or rate are not reused', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'voice-over-fragment-cache-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const source = path.join(root, 'source.mp3');
  await fs.writeFile(source, 'valid-mp3-original');
  const cache = new FragmentCache(root, { validateAudio });
  const descriptor = fragmentDescriptor('same text', settings);
  const saved = await cache.save(descriptor, source);
  assert.ok(await cache.get(descriptor));
  await fs.writeFile(saved.file, 'damaged');
  assert.equal(await cache.get(descriptor), null);
  assert.equal(await cache.get(fragmentDescriptor('same text', { ...settings, voice: 'ru-RU-SvetlanaNeural' })), null);
  assert.equal(await cache.get(fragmentDescriptor('same text', { ...settings, rate: '+5%' })), null);
});

test('verified cache resumes with size and SHA-256 checks without re-running FFmpeg', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'voice-over-fast-cache-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const source = path.join(root, 'source.mp3');
  await fs.writeFile(source, 'valid-mp3-fast-cache');
  let validations = 0;
  const cache = new FragmentCache(root, { validateAudio: async (file) => { validations++; return validateAudio(file); } });
  const descriptor = fragmentDescriptor('fast cache', settings);
  await cache.save(descriptor, source);
  assert.equal(validations, 1); // validation before the atomic cache commit
  await cache.get(descriptor);
  assert.equal(validations, 1);
  const saved = cache.paths(descriptor);
  await fs.appendFile(saved.audio, 'changed');
  assert.equal(await cache.get(descriptor), null);
});

test('mocked HTTP 429 persists cooldown then automatically retries only the unfinished fragment', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'voice-over-main-pause-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const destination = path.join(root, 'output');
  const manifestFile = path.join(destination, '.manifest.json');
  const log = path.join(root, 'generation.log');
  const fragmentCache = new FragmentCache(root, { validateAudio });
  const queue = new TtsQueue({ min_interval_ms: 1, normal_jitter_max_ms: 0, max_requests_per_minute: 60 });
  const manifest = { source: 'mock.txt', totalBlocks: 1, blocks: {} };
  let requests = 0;
  const cooldownWaits = [];
  const settingsForBlock = {
    ...settings, cache: root, maxChars: 20, minChars: 1, retries: 1, timeout: 5, quality: '2', force: false,
    edgeQueue: validateQueueConfig({ min_interval_ms: 1, normal_jitter_max_ms: 0, max_requests_per_minute: 60, http_429_cooldown_seconds: [1], http_429_jitter_ratio: 0 }), edgeCircuit: { open: false, reason: '' }, environment: 'test',
    sleep: async (ms) => { cooldownWaits.push(ms); },
    mergeMp3: async () => ({ ok: true, duration: 6 }),
    validatePart: validateAudio,
    synthesize: async (_text, file) => {
      requests++;
      if (requests === 6) throw new Error('Unexpected server response: 429');
      await fs.writeFile(file, `valid-mp3-${requests}`);
    },
  };
  const text = Array.from({ length: 6 }, (_, index) => `Sentence ${index + 1} abc.`).join(' ');
  const result = await mainInternals.speakBlock({ index: 1, title: '', text }, destination, settingsForBlock, manifest, manifestFile, log, queue, fragmentCache);
  assert.equal(result.status, 'created');
  assert.equal(requests, 7);
  assert.equal(cooldownWaits.length, 1);
  assert.ok(cooldownWaits[0] >= 1_000);
  assert.equal(queue.paused, false);
  const savedManifest = JSON.parse(await fs.readFile(manifestFile, 'utf8'));
  assert.equal(savedManifest.progress['1'].status, 'completed');
  assert.equal(savedManifest.progress['1'].completed_fragments, 6);
  const chunks = text.match(/[^.]+\./g).map((value) => value.trim());
  assert.equal((await Promise.all(chunks.map((value) => fragmentCache.get(fragmentDescriptor(value, settings))))).filter(Boolean).length, 6);
});

test('429 cooldown progression uses 15, 30, 60, then 120 minutes and honors Retry-After', () => {
  const config = validateQueueConfig({ http_429_jitter_ratio: 0, http_429_cooldown_seconds: [900, 1800, 3600, 7200] });
  const now = Date.UTC(2026, 0, 1);
  assert.equal(next429RetryAt({ event: 1, config, now, random: () => 0 }), now + 900_000);
  assert.equal(next429RetryAt({ event: 2, config, now, random: () => 0 }), now + 1_800_000);
  assert.equal(next429RetryAt({ event: 3, config, now, random: () => 0 }), now + 3_600_000);
  assert.equal(next429RetryAt({ event: 4, config, now, random: () => 0 }), now + 7_200_000);
  assert.equal(next429RetryAt({ event: 5, config, now, random: () => 0 }), now + 7_200_000);
  assert.equal(next429RetryAt({ retryAfter: '120', event: 1, config, now, random: () => 0 }), now + 120_000);
});
