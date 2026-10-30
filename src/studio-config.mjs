import fs from 'node:fs/promises';
import path from 'node:path';
import { parse as parseToml, stringify as stringifyToml } from 'smol-toml';
import { loadAiFeatureFlags } from './env.mjs';

export const DEFAULT_STANDARD_PROCESSING = Object.freeze({
  enabled: true,
  language_detection_enabled: true,
  auto_translate: false,
  target_language: 'ru',
  translation_provider: 'translategemma_openai',
  translation_model: 'TranslateGemma-4B',
  translation_endpoint: '',
  translation_timeout_seconds: 120,
  pronunciation_enabled: true,
  pronunciation_exceptions: 'data/pronunciation-exceptions.json',
  speech_enabled: true,
  voice: 'ru-RU-DmitryNeural',
  rate: '+0%',
  audio_format: 'mp3',
  speak_sentence_by_sentence: true,
  stable_file_delay_ms: 1500,
  skip_completed: true,
  auto_save: true,
  lock_stale_seconds: 21600,
});

function resolveFrom(root, value, fallback) { return path.resolve(root, value || fallback); }

export async function loadStudioConfig(file) {
  const raw = await fs.readFile(file, 'utf8');
  const config = parseToml(raw);
  const root = path.dirname(file);
  const standard = { ...DEFAULT_STANDARD_PROCESSING, ...(config.standard_processing || {}) };
  const ai = await loadAiFeatureFlags({ root, standard });
  return {
    file,
    raw: config,
    root,
    input: resolveFrom(root, config.paths?.input, 'input'),
    output: resolveFrom(root, config.paths?.output, 'output'),
    data: resolveFrom(root, config.paths?.data, 'data'),
    cache: resolveFrom(root, config.paths?.cache, 'cache'),
    logs: resolveFrom(root, config.paths?.logs, 'logs'),
    standard: {
      ...standard,
      pronunciation_exceptions: resolveFrom(root, standard.pronunciation_exceptions, 'data/pronunciation-exceptions.json'),
    },
    ai,
    language: config.studio?.language || 'ru',
  };
}

async function saveConfig(loaded, next) {
  const temporary = `${loaded.file}.tmp-${process.pid}`;
  await fs.writeFile(temporary, stringifyToml(next), 'utf8');
  await fs.rename(temporary, loaded.file);
  return loadStudioConfig(loaded.file);
}

export async function saveStandardSettings(loaded, patch) {
  return saveConfig(loaded, {
    ...loaded.raw,
    standard_processing: { ...DEFAULT_STANDARD_PROCESSING, ...(loaded.raw.standard_processing || {}), ...patch },
    studio: { ...(loaded.raw.studio || {}), language: loaded.language },
  });
}

export async function saveStudioLanguage(loaded, language) {
  return saveConfig(loaded, { ...loaded.raw, studio: { ...(loaded.raw.studio || {}), language } });
}
