import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { splitText, splitSentences } from './segmenter.mjs';
import { normalizeForSpeech } from './speech-normalizer.mjs';
import { verifyBlockSegmentation } from './integrity.mjs';
import { isCurrentOutput } from './cache.mjs';
import { fragmentDescriptor, writeJsonAtomic } from './fragment-cache.mjs';
import { QueuePausedError, jitterDelay, next429RetryAt } from './tts-queue.mjs';
import { saveManifest } from './manifest.mjs';
import { logLine, eventLog, humanDuration, waitForCooldown } from './runtime.mjs';
import * as audio from './audio.mjs';
import { classifyEdgeError, formatEdgeDiagnostic, synthesizeEdge } from './edge.mjs';

function digest(value) { return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex'); }

export async function validatePart(file) {
  const probed = await audio.probe(file);
  if (!probed.valid) return { valid: false, code: probed.code || 'INVALID_AUDIO', detail: `MP3 validation (ffprobe): ${probed.detail}` };
  const decoded = await audio.decodeCheck(file);
  return decoded.valid ? { valid: true, duration: probed.duration } : { valid: false, code: decoded.code || 'INVALID_AUDIO', detail: `MP3 decoding (ffmpeg): ${decoded.detail}` };
}

export function outputFilename(block, manifest) {
  const original = String(block.title || '').trim();
  const match = original.match(/^(?:(?:\u0413\u043b\u0430\u0432\u0430|chapter)\s+)?(\d{1,4})(?:[.\s:\u2014-]+)(.*)$/iu);
  const explicit = Number(block.chapterNumber);
  const number = Number.isSafeInteger(explicit) && explicit > 0 ? explicit : Number(match?.[1] || block.index);
  const prefix = String(number).padStart(Math.max(2, String(manifest.totalBlocks).length), '0');
  const title = String(match ? match[2] : original).replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/[. ]+$/g, '').trim().slice(0, 140);
  return `${prefix}${title ? ` ${title}` : ''}.mp3`;
}

export async function speakBlock(block, destination, settings, manifest, manifestFile, log, queue, fragments) {
  let filename = outputFilename(block, manifest);
  const chapterTitle = block.title ? `${block.title}.` : '';
  const spokenText = settings.preNormalized ? block.text : normalizeForSpeech(`${chapterTitle} ${block.text}`.trim());
  const textHash = digest({ original: block.text, spoken: spokenText });
  const configHash = digest({ voice: settings.voice, rate: settings.rate, pitch: settings.pitch, volume: settings.volume, audioFormat: settings.audioFormat, maxChars: settings.maxChars, sentenceBySentence: settings.sentenceBySentence, engine: 'edge', client: 'node-edge-tts', normalizer: settings.preNormalized ? 0 : 1, version: 4 });
  const previous = manifest.blocks[String(block.index)];
  // Never replace an existing file whose source/configuration cannot be proved.
  if (await fs.stat(path.join(destination, filename)).catch(() => null)) {
    if (previous?.filename !== filename || previous?.textHash !== textHash || previous?.configHash !== configHash) {
      filename = filename.replace(/\.mp3$/i, ` [${textHash.slice(0, 10)}-${configHash.slice(0, 8)}].mp3`);
      if (await fs.stat(path.join(destination, filename)).catch(() => null) && (previous?.filename !== filename || previous?.textHash !== textHash || previous?.configHash !== configHash)) throw new Error(`Existing output has no matching provenance: ${filename}`);
    }
  }
  const target = path.join(destination, filename);
  if (!settings.force && await isCurrentOutput({ target, previous, textHash, configHash, filename, probe: audio.probe })) return { status: 'skipped', filename };
  if (settings.edgeCircuit?.open) return { status: 'paused', filename, detail: settings.edgeCircuit.reason };

  const chunks = settings.sentenceBySentence ? splitSentences(spokenText, settings.maxChars, settings.minChars) : splitText(spokenText, settings.maxChars, settings.minChars);
  const integrity = verifyBlockSegmentation(spokenText, chunks);
  if (!integrity.ok) throw new Error(`Text integrity check failed for block ${block.index}: ${integrity.detail}`);
  await logLine(log, `${manifest.source} block=${block.index}: chars=${block.text.length}, fragments=${chunks.length}, lengths=${JSON.stringify(chunks.map((part) => part.length))}`);
  manifest.progress ||= {};
  const priorProgress = manifest.progress[String(block.index)] || {};
  const progress = manifest.progress[String(block.index)] = { ...priorProgress, document: manifest.source, block: block.index, total_fragments: chunks.length, completed_fragments: 0, completed_fragment_hashes: [], status: 'RUNNING', updated_at: new Date().toISOString() };
  await saveManifest(manifestFile, manifest);
  const parts = [];
  for (let index = 0; index < chunks.length; index++) {
      const descriptor = fragmentDescriptor(chunks[index], settings);
      const cached = !settings.force && await fragments.get(descriptor);
      if (cached) {
        parts.push(cached.file);
        progress.completed_fragments = index + 1;
        progress.completed_fragment_hashes[index] = descriptor.key;
        progress.status = 'running'; progress.updated_at = new Date().toISOString();
        await saveManifest(manifestFile, manifest);
        await logLine(log, `TTS cache hit: ${manifest.source} block=${block.index} fragment=${index + 1}/${chunks.length}`);
        continue;
      }
      const work = await fs.mkdtemp(path.join(settings.cache, 'tts-tmp-'));
      const part = path.join(work, 'fragment.mp3');
      let lastError = '';
      let success = false;
      let attempt = 0;
      const maxAttempts = Math.min(settings.retries, settings.edgeQueue.transientMaxAttempts || settings.retries);
      try { while (!success) {
        attempt++;
        try {
          await logLine(log, `TTS request: ${manifest.source} block=${block.index} fragment=${index + 1}/${chunks.length} attempt=${attempt}/${maxAttempts}`);
          await queue.run(() => (settings.synthesize || synthesizeEdge)(chunks[index], part, settings));
        } catch (error) {
          if (error instanceof QueuePausedError) {
            progress.status = 'paused'; progress.reason = error.reason; progress.updated_at = new Date().toISOString();
            await saveManifest(manifestFile, manifest);
            return { status: 'paused', filename, detail: error.reason, completed: index, total: chunks.length };
          }
          const diagnosis = classifyEdgeError(error);
          lastError = `${diagnosis.code}: ${diagnosis.message}`;
          await fs.rm(part, { force: true });
          await logLine(log, formatEdgeDiagnostic({ environment: settings.environment, voice: settings.voice, attempt, attempts: maxAttempts, error: diagnosis }));
          await logLine(log, `TTS failure: ${manifest.source} block=${block.index} fragment=${index + 1} attempt=${attempt}: ${lastError}`);
          if (diagnosis.httpStatus === 403 && attempt <= settings.edgeQueue.http403MaxRetries) {
            await logLine(log, `HTTP 403 diagnostic retry: ${manifest.source} block=${block.index} fragment=${index + 1} retry=${attempt}/${settings.edgeQueue.http403MaxRetries}`);
            continue;
          }
          const stopForRateLimit = diagnosis.httpStatus === 429 && settings.edgeQueue.stopOnHttp429;
          const stopForForbidden = diagnosis.httpStatus === 403 && settings.edgeQueue.stopOnHttp403;
          if (stopForRateLimit) {
            const events = (progress.consecutive_429 || 0) + 1;
            const next = next429RetryAt({ retryAfter: diagnosis.retryAfter, event: events, config: settings.edgeQueue });
            const waitMs = Math.max(0, next - Date.now());
            const pacing = queue.recordRateLimit();
            await writeJsonAtomic(path.join(settings.cache, 'edge-pacing.json'), { ...pacing, nextRetryAt: new Date(next).toISOString() });
            queue.pause(`HTTP 429 until ${new Date(next).toISOString()}`);
            progress.status = 'COOLDOWN'; progress.reason = 'HTTP_429'; progress.retry_after = diagnosis.retryAfter;
            progress.next_retry_at = new Date(next).toISOString(); progress.consecutive_429 = events;
            progress.fragment = index + 1; progress.completed_fragments = index; progress.updated_at = new Date().toISOString();
            await saveManifest(manifestFile, manifest);
            await eventLog(settings, { type: 'EDGE_TTS_COOLDOWN', document: manifest.source, block: block.index, fragment: index + 1, fragment_total: chunks.length, voice: settings.voice, rate: settings.rate, error_code: diagnosis.code, retry_after: diagnosis.retryAfter || null, consecutive_429: events, cooldown_ms: waitMs, next_retry_at: progress.next_retry_at, completed_fragments: index, recommended_interval_ms: pacing.intervalMs });
            console.log(['========================================', 'EDGE TTS COOLDOWN', '========================================', `Document: ${manifest.source}`, `Block: ${block.index}/${manifest.totalBlocks}`, `Next fragment: ${index + 1}/${chunks.length}`, 'Reason: HTTP 429', `Retry-After: ${diagnosis.retryAfter || 'not provided'}`, `Consecutive 429: ${events}`, `Waiting: ${humanDuration(waitMs)}`, `Next attempt: ${new Date(next).toLocaleTimeString()}`, 'Progress saved: YES', `Automatic resume: ${settings.edgeQueue.autoResume429 ? 'ENABLED' : 'DISABLED'}`, '========================================'].join('\n'));
            if (!settings.edgeQueue.autoResume429) return { status: 'paused', filename, detail: lastError, completed: index, total: chunks.length, diagnosis };
            await logLine(log, `Waiting before automatic retry: ${manifest.source} block=${block.index} fragment=${index + 1}/${chunks.length} wait=${humanDuration(waitMs)}`);
            await waitForCooldown(waitMs, settings);
            queue.halfOpen();
            progress.status = 'RECOVERING'; progress.updated_at = new Date().toISOString();
            await saveManifest(manifestFile, manifest);
            await logLine(log, `EDGE TTS RECOVERED: resuming ${manifest.source} block=${block.index} fragment=${index + 1}/${chunks.length}`);
            continue;
          }
          if (stopForForbidden) {
            settings.edgeCircuit.open = true;
            settings.edgeCircuit.reason = `HTTP ${diagnosis.httpStatus} at ${diagnosis.stage}`;
            queue.pause(settings.edgeCircuit.reason);
            progress.status = 'PAUSED_REQUIRES_ATTENTION'; progress.reason = 'HANDSHAKE_PROTOCOL_ERROR'; progress.completed_fragments = index; progress.updated_at = new Date().toISOString();
            await saveManifest(manifestFile, manifest);
            return { status: 'paused', filename, detail: lastError, completed: index, total: chunks.length, diagnosis };
          }
          if (diagnosis.retryable && attempt >= maxAttempts) break;
          if (diagnosis.retryable) await waitForCooldown(jitterDelay(settings.edgeQueue.retryJitter, settings.edgeQueue.transientBaseBackoffMs, settings.edgeQueue.transientMaxBackoffMs, attempt - 1), settings);
          if (!diagnosis.retryable) break;
          continue;
        }
        const validation = await (settings.validatePart || validatePart)(part);
        if (validation.valid) { success = true; progress.consecutive_429 = 0; await writeJsonAtomic(path.join(settings.cache, 'edge-pacing.json'), queue.recordSuccess()); break; }
        lastError = validation.detail;
        await fs.rm(part, { force: true });
        await logLine(log, `MP3 validation failure (no TTS retry): classification=${validation.code || 'INVALID_AUDIO'} ${manifest.source} block=${block.index} fragment=${index + 1}: ${lastError}`);
        break;
      }
      if (!success) {
        progress.status = 'failed'; progress.reason = lastError; progress.completed_fragments = index; progress.updated_at = new Date().toISOString();
        await saveManifest(manifestFile, manifest);
        return { status: 'failed', filename, detail: `fragment ${index + 1}: ${lastError}` };
      }
      const saved = await fragments.save(descriptor, part);
      parts.push(saved.file);
      progress.completed_fragments = index + 1; progress.status = 'running'; progress.updated_at = new Date().toISOString();
      progress.completed_fragment_hashes[index] = descriptor.key;
      await saveManifest(manifestFile, manifest);
      await logLine(log, `TTS fragment completed: ${manifest.source} block=${block.index} fragment=${index + 1}/${chunks.length} cache=${descriptor.key}`);
      } finally { await fs.rm(work, { recursive: true, force: true }); }
    }
    const merged = await (settings.mergeMp3 || audio.mergeMp3)(parts, target, settings.quality);
    if (!merged.ok) return { status: 'failed', filename, detail: `merge/MP3 validation: ${merged.detail}` };
    manifest.blocks[String(block.index)] = { filename, textHash, configHash, engine: 'edge', chunks: chunks.length, duration: merged.duration };
    manifest.progress[String(block.index)] = { ...progress, completed_fragments: chunks.length, status: 'completed', updated_at: new Date().toISOString() };
    await saveManifest(manifestFile, manifest);
    return { status: 'created', filename, duration: merged.duration };
}
