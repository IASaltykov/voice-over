import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

function sha256(value) { return crypto.createHash('sha256').update(value).digest('hex'); }
function uniqueTemp(file) { return `${file}.tmp-${process.pid}-${crypto.randomUUID()}`; }

export function fragmentDescriptor(text, settings) {
  const normalizedText = String(text).replace(/\s+/gu, ' ').trim();
  const input = { version: 2, text: normalizedText, engine: 'edge', voice: settings.voice, rate: settings.rate, pitch: settings.pitch || '+0Hz', volume: settings.volume || '+0%', audioFormat: settings.audioFormat || 'audio-24khz-48kbitrate-mono-mp3', client: 'node-edge-tts' };
  return { key: sha256(JSON.stringify(input)), textSha256: sha256(normalizedText), settings: { engine: input.engine, voice: input.voice, rate: input.rate, pitch: input.pitch, volume: input.volume, audioFormat: input.audioFormat, client: input.client } };
}

export async function writeJsonAtomic(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temporary = uniqueTemp(file);
  await fs.writeFile(temporary, JSON.stringify(value, null, 2), 'utf8');
  await fs.rename(temporary, file);
}

export class FragmentCache {
  constructor(root, { validateAudio, now = () => new Date().toISOString() }) {
    this.root = root;
    this.validateAudio = validateAudio;
    this.now = now;
  }

  paths(descriptor) {
    const directory = path.join(this.root, 'tts', descriptor.key);
    return { directory, audio: path.join(directory, 'fragment.mp3'), metadata: path.join(directory, 'metadata.json') };
  }

  async get(descriptor) {
    const files = this.paths(descriptor);
    try {
      const metadata = JSON.parse(await fs.readFile(files.metadata, 'utf8'));
      if (metadata.status !== 'completed' || metadata.text_sha256 !== descriptor.textSha256 || JSON.stringify(metadata.settings) !== JSON.stringify(descriptor.settings)) return null;
      const content = await fs.readFile(files.audio);
      if (!content.length || metadata.audio_sha256 !== sha256(content)) return null;
      const checked = await this.validateAudio(files.audio);
      if (!checked.valid) return null;
      return { file: files.audio, metadata, duration: checked.duration };
    } catch { return null; }
  }

  async save(descriptor, sourceFile) {
    const files = this.paths(descriptor);
    const existing = await this.get(descriptor);
    if (existing) return existing;
    await fs.mkdir(files.directory, { recursive: true });
    const content = await fs.readFile(sourceFile);
    const temporary = uniqueTemp(files.audio);
    await fs.writeFile(temporary, content);
    const checked = await this.validateAudio(temporary);
    if (!checked.valid) { await fs.rm(temporary, { force: true }); throw new Error(`Refusing to cache invalid MP3: ${checked.detail || 'validation failed'}`); }
    // Preserve evidence of a broken cache entry instead of deleting it.  A
    // valid entry was already returned above and is never overwritten here.
    if (await fs.stat(files.audio).catch(() => null)) {
      await fs.rename(files.audio, `${files.audio}.corrupt-${Date.now()}`).catch(() => {});
      await fs.rename(files.metadata, `${files.metadata}.corrupt-${Date.now()}`).catch(() => {});
    }
    try { await fs.rename(temporary, files.audio); } catch (error) {
      await fs.rm(temporary, { force: true });
      if (!(await this.get(descriptor))) throw error;
    }
    const finalContent = await fs.readFile(files.audio);
    const metadata = { status: 'completed', text_sha256: descriptor.textSha256, settings: descriptor.settings, audio_sha256: sha256(finalContent), duration_seconds: checked.duration, created_at: this.now() };
    await writeJsonAtomic(files.metadata, metadata);
    return { file: files.audio, metadata, duration: checked.duration };
  }
}
