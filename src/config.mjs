import path from 'node:path';
import fs from 'node:fs/promises';
import { parse as parseToml } from 'smol-toml';
import { validateQueueConfig } from './tts-queue.mjs';

export async function readConfig(file) {
  const config = parseToml(await fs.readFile(file, 'utf8'));
  const root = path.dirname(file);
  const resolve = (value, fallback) => path.resolve(root, value || fallback);
  return {
    input: resolve(config.paths?.input, 'input'), output: resolve(config.paths?.output, 'output'), cache: resolve(config.paths?.cache, 'cache'), logs: resolve(config.paths?.logs, 'logs'),
    voice: config.tts?.voice || 'ru-RU-DmitryNeural', rate: config.tts?.rate || '-5%', retries: Math.max(1, Number(config.tts?.retries || 4)), pitch: config.tts?.pitch || '+0Hz', volume: config.tts?.volume || '+0%', audioFormat: config.tts?.audio_format || 'audio-24khz-48kbitrate-mono-mp3',
    timeout: Math.max(5, Number(config.tts?.timeout_seconds || 90)), socketTimeoutSeconds: Math.max(5, Number(config.tts?.socket_timeout_seconds || 30)), maxChars: Number(config.segmentation?.max_chars || 700), minChars: Number(config.segmentation?.min_chars || 150),
    quality: String(config.audio?.mp3_quality || '2'), chapterMode: config.chapter_detection?.mode || 'auto', targetMaxWords: Number(config.chapter_detection?.target_max_words || 5000),
    pdf: { maxBytes: Number(config.pdf?.max_bytes || 262144000) },
    edgeQueue: validateQueueConfig(config.edge_queue || {}),
  };
}
