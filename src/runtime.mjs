import fs from 'node:fs/promises';
import path from 'node:path';

export async function logLine(file, message) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.appendFile(file, `${new Date().toISOString()} ${message}\n`, 'utf8');
  console.log(message);
}

export async function eventLog(settings, event) {
  if (!settings.logs) return;
  const file = path.join(settings.logs, 'events.jsonl');
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.appendFile(file, `${JSON.stringify({ timestamp: new Date().toISOString(), environment: settings.environment, ...event })}\n`, 'utf8');
}

export function humanDuration(milliseconds) {
  const seconds = Math.max(0, Math.ceil(milliseconds / 1000));
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

export async function waitForCooldown(milliseconds, settings) {
  const delay = Math.max(0, milliseconds);
  if (delay) await (settings.sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms))))(delay);
}
