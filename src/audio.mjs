import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

function tool(name) { return process.env[name.toUpperCase()] || name; }
export function run(command, args, options = {}) { return new Promise((resolve, reject) => { const child = spawn(command, args, { ...options, windowsHide: true }); let stdout = '', stderr = ''; child.stdout?.on('data', (x) => { stdout += x; }); child.stderr?.on('data', (x) => { stderr += x; }); child.on('error', reject); child.on('close', (code) => resolve({ code, stdout, stderr })); }); }

export async function requireTools() {
  for (const name of ['ffmpeg', 'ffprobe']) {
    try {
      const result = await run(tool(name), ['-version']);
      if (result.code !== 0) throw new Error(result.stderr.trim() || `exit code ${result.code}`);
    } catch (error) {
      throw new Error(`Required dependency '${name}' is unavailable. Install FFmpeg (including ffprobe) or run via Docker. Detail: ${error.message}`);
    }
  }
}

export async function probe(file) {
  try {
    const result = await run(tool('ffprobe'), ['-v', 'error', '-show_entries', 'format=format_name,duration', '-of', 'json', file]);
    if (result.code !== 0) return { valid: false, code: 'INVALID_AUDIO', detail: result.stderr.trim() || 'ffprobe failed' };
    const format = JSON.parse(result.stdout).format || {}; const duration = Number(format.duration || 0);
    return { valid: format.format_name?.includes('mp3') && duration > 0, code: format.format_name?.includes('mp3') && duration > 0 ? undefined : 'INVALID_AUDIO', duration, detail: format.format_name || '' };
  } catch (error) { return { valid: false, code: 'INVALID_AUDIO', detail: String(error) }; }
}

export async function decodeCheck(file) { const result = await run(tool('ffmpeg'), ['-v', 'error', '-i', file, '-f', 'null', '-']); return { valid: result.code === 0, code: result.code === 0 ? undefined : 'INVALID_AUDIO', detail: result.stderr.trim() }; }

export async function mergeMp3(parts, destination, quality = '2') {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'edge-tts-')); const list = path.join(directory, 'concat.txt'); const building = `${destination}.building.mp3`;
  try {
    await fs.writeFile(list, parts.map((file) => `file '${path.resolve(file).replaceAll("'", "'\\''")}'`).join('\n'), 'utf8');
    const result = await run(tool('ffmpeg'), ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'concat', '-safe', '0', '-i', list, '-vn', '-c:a', 'libmp3lame', '-q:a', quality, building]);
    if (result.code !== 0) return { ok: false, detail: result.stderr.trim() };
    const checked = await probe(building); if (!checked.valid) return { ok: false, detail: checked.detail };
    await fs.mkdir(path.dirname(destination), { recursive: true }); await fs.rename(building, destination); return { ok: true, duration: checked.duration };
  } finally { await fs.rm(directory, { recursive: true, force: true }); await fs.rm(building, { force: true }); }
}
