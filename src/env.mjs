import fs from 'node:fs/promises';
import path from 'node:path';

const AI_FLAGS = Object.freeze({
  languageDetection: 'AI_LANGUAGE_DETECTION_ENABLED',
  translation: 'AI_TRANSLATION_ENABLED',
  pronunciation: 'AI_PRONUNCIATION_ENABLED',
});

function parseBoolean(name, value) {
  const normalized = String(value).trim();
  if (normalized === 'true') return true;
  if (normalized === 'false') return false;
  throw new Error(`${name} must be exactly true or false.`);
}

export function parseDotEnv(source) {
  const values = {};
  for (const [index, raw] of String(source || '').split(/\r?\n/).entries()) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!match) throw new Error(`Invalid .env line ${index + 1}.`);
    let value = match[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    values[match[1]] = value;
  }
  return values;
}

export async function loadDotEnv(file) {
  try { return parseDotEnv(await fs.readFile(file, 'utf8')); }
  catch (error) { if (error?.code === 'ENOENT') return {}; throw error; }
}

function readFlag(name, systemEnv, dotEnv, fallback) {
  const system = systemEnv[name];
  if (system != null && String(system).trim() !== '') return { enabled: parseBoolean(name, system), source: 'environment' };
  const fromFile = dotEnv[name];
  if (fromFile != null && String(fromFile).trim() !== '') return { enabled: parseBoolean(name, fromFile), source: '.env' };
  return { enabled: Boolean(fallback), source: 'config.toml' };
}

export async function loadAiFeatureFlags({ root, standard = {}, env = process.env, envFile = '.env' } = {}) {
  if (!root) throw new Error('Environment root is required.');
  const dotEnv = await loadDotEnv(path.resolve(root, envFile));
  return {
    languageDetection: readFlag(AI_FLAGS.languageDetection, env, dotEnv, standard.language_detection_enabled ?? true),
    translation: readFlag(AI_FLAGS.translation, env, dotEnv, standard.auto_translate),
    pronunciation: readFlag(AI_FLAGS.pronunciation, env, dotEnv, standard.pronunciation_enabled),
  };
}

export { AI_FLAGS };
