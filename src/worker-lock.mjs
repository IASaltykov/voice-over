import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';

// An exclusive file guards the entire cache, including shared pacing state.
// A crash leaves the lock in place; an operator must verify ownership before removal.
export async function acquireWorkerLock(cache) {
  await fs.mkdir(cache, { recursive: true });
  const file = path.join(cache, 'edge-worker.lock');
  const owner = { pid: process.pid, host: os.hostname(), started: new Date().toISOString(), token: randomUUID() };
  let handle;
  try { handle = await fs.open(file, 'wx'); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const detail = await fs.readFile(file, 'utf8').catch(() => '(unreadable)');
    throw new Error(`Another worker may be using this cache: ${file}. Owner: ${detail}. If it crashed, verify that it is no longer running before removing the lock.`);
  }
  try { await handle.writeFile(JSON.stringify(owner)); await handle.sync(); }
  catch (error) { await handle.close(); await fs.rm(file, { force: true }); throw error; }
  await handle.close();
  return async () => {
    const current = JSON.parse(await fs.readFile(file, 'utf8'));
    if (current.token !== owner.token) throw new Error(`Worker lock ownership changed: ${file}`);
    await fs.unlink(file);
  };
}
