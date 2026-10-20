// AI assistant conversations, kept per project as append-only JSON Lines files in the app's data folder
// (not in the project database: never exported, never part of undo). Clear context deletes the file.
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';

const file = (dir: string, key: string) => join(dir, `${createHash('sha256').update(key).digest('hex').slice(0, 24)}.jsonl`);

/** Every entry of a conversation, oldest first. A line cut off by a crash is skipped. */
export function loadChat(dir: string, key: string): unknown[] {
  const f = file(dir, key);
  if (!existsSync(f)) return [];
  const out: unknown[] = [];
  for (const l of readFileSync(f, 'utf8').split('\n')) { if (!l) continue; try { out.push(JSON.parse(l)); } catch { /* partial line */ } }
  return out;
}

export function appendChat(dir: string, key: string, entries: unknown[]): void {
  if (!entries.length) return;
  mkdirSync(dir, { recursive: true });
  appendFileSync(file(dir, key), entries.map((e) => JSON.stringify(e) + '\n').join(''));
}

export function clearChat(dir: string, key: string): void { rmSync(file(dir, key), { force: true }); }

/** Carry a conversation over to another project (e.g. the one the assistant just created), after what is there. */
export function moveChat(dir: string, from: string, to: string): void {
  const a = file(dir, from), b = file(dir, to);
  if (a === b || !existsSync(a)) return;
  if (!existsSync(b)) renameSync(a, b);
  else { appendFileSync(b, readFileSync(a, 'utf8')); rmSync(a, { force: true }); }
}
