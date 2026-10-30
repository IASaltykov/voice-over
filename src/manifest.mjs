import fs from 'node:fs/promises';
import { writeJsonAtomic } from './fragment-cache.mjs';

export async function saveManifest(file, manifest) {
  // Keep one known-good snapshot. The fragment cache remains authoritative for
  // unfinished blocks even if both manifest files are later unreadable.
  try { JSON.parse(await fs.readFile(file, 'utf8')); await fs.copyFile(file, `${file}.last-good.json`); } catch {}
  await writeJsonAtomic(file, manifest);
}

export async function readManifest(file) {
  try { return JSON.parse(await fs.readFile(file, 'utf8')); } catch (error) {
    try { return JSON.parse(await fs.readFile(`${file}.last-good.json`, 'utf8')); } catch {}
    if (error?.code !== 'ENOENT') {
      const preserved = `${file}.corrupt-${Date.now()}.json`;
      await fs.rename(file, preserved).catch(() => {});
    }
    return {};
  }
}
