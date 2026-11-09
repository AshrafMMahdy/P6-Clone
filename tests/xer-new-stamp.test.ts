// A project with no P6 version of its own (new, or read from a non-P6 file) is saved as XER 7.0 (owner 2026-11-09): every P6
// in use imports it (P6 refuses a newer stamp, silently), and the file opened again calculates as it did before the save.
import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { callTool, toolResult } from '../mcp/server.ts';
import { setRoots } from '../mcp/runtime.ts';
import { sampleCopy } from './helpers.ts';

setRoots(null, tmpdir());
const call = async (name: string, args: Record<string, unknown>) => { const r = await callTool(name, args); return toolResult(r.out, r.isError).structuredContent as any; };
afterEach(async () => { for (const h of (await call('list_open', {})).open) await call('close', { handle: h.handle, discard: true }); });
const dir = mkdtempSync(join(tmpdir(), 'p6stamp-'));
const head = (p: string) => readFileSync(p, 'latin1').split(/\r?\n/)[0].split('\t');

test('a new project is saved as XER 7.0 and, opened again, finishes on the same date', async () => {
  const np = await call('new_project', { id: 'NEW', start: '2026-03-02' });
  const ops: unknown[] = [];
  for (let i = 0; i < 6; i++) ops.push({ op: 'add_activity', id: `A${i}`, name: `A${i}`, duration_days: 2 + i }, ...(i ? [{ op: 'add_relationship', pred: `A${i - 1}`, succ: `A${i}`, type: i % 2 ? 'FS' : 'FF', lag_days: i % 3 }] : []));
  assert.equal((await call('edit', { handle: np.handle, owner_key: np.owner_key, operations: ops })).ok, true);
  const before = await call('schedule', { handle: np.handle });
  const path = join(dir, 'new.xer');
  const saved = await call('save', { handle: np.handle, owner_key: np.owner_key, path });
  assert.deepEqual(head(path).slice(0, 2), ['ERMHDR', '7.0']);
  // the answer names the version written, and says what the 7.0 stamp means for the user
  assert.equal(saved.format, 'XER 7.0');
  assert.ok(saved.notes?.some((n: string) => /written as XER 7\.0/.test(n) && /Tell the user: P6 8 and later/.test(n)), JSON.stringify(saved.notes));
  // the CLI writes a project without a version the same way
  const { writeOut } = await import('../cli/commands.ts');
  const { getSession } = await import('../mcp/runtime.ts');
  const cli = join(dir, 'cli.xer');
  writeOut(cli, getSession(np.handle).db);
  assert.equal(head(cli)[1], '7.0');
  const re = await call('open_file', { path });
  const after = await call('schedule', { handle: re.handle });
  assert.equal(after.finish, before.finish);
});

test('a file read in keeps its own version; an explicit version wins', async () => {
  const src = sampleCopy('Baseline Zone 2 Rev.01.xer');
  const s = await call('open_file', { path: src });
  assert.ok(s.handle, JSON.stringify(s).slice(0, 300));
  const own = join(dir, 'own.xer'), v19 = join(dir, 'v19.xer');
  const ver = head(src)[1];
  const sv = await call('save', { handle: s.handle, owner_key: s.owner_key, path: own }); assert.ok(!sv.error, JSON.stringify(sv).slice(0, 300));
  assert.equal(sv.format, 'XER 6.2'); assert.ok(!(sv.notes ?? []).some((n: string) => /written as XER 7/.test(n)));
  const s19 = await call('save', { handle: s.handle, owner_key: s.owner_key, path: v19, version: '19.12' });
  assert.equal(s19.format, 'XER 19.12');
  assert.equal(ver, '6.2'); assert.equal(head(own)[1], ver);
  assert.equal(head(v19)[1], '19.12');
});
