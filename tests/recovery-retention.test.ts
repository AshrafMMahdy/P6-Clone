// Recovery folder upkeep (whiq-v0.1.17): Windows process start times (a reused pid told apart), and retention:
// a closed project's file whose saved file holds every change goes after P6CLONE_RECOVERY_KEEP_DAYS (7); anything
// with unsaved work, or whose saved file is missing, stays for ever; adopted folders go once emptied; server_status
// reports the folder's size and what is kept.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// this process's recovery folders in a temp folder of its own (read when used)
const TMP = mkdtempSync(join(tmpdir(), 'p6keep-'));
process.env.TMPDIR = TMP; process.env.TMP = TMP; process.env.TEMP = TMP;
const { callTool, toolResult } = await import('../mcp/server.ts');
const rt = await import('../mcp/runtime.ts');
const { applyOps } = await import('../core/project/ops.ts');
const { dbLines } = await import('../core/db-file.ts');
const call = async (name: string, a: Record<string, unknown> = {}) => toolResult((await callTool(name, a)).out, false).structuredContent as any;
const DAY = 86400000;
const closed = () => { const d = join(rt.recoveryDir(), 'closed'); return existsSync(d) ? readdirSync(d).filter((n) => n.endsWith('.p6db.jsonl')) : []; };

/** A new project with an edit, checkpointed (as the server does 2 s after a change); saved to `save` if given. */
async function project(id: string, save?: string) {
  const h = (await call('new_project', { id, start: '2026-03-02' })).handle;
  await call('edit', { handle: h, operations: [{ op: 'add_activity', id: 'A1', name: 'one', duration_days: 1 }] });
  rt.checkpoint(rt.sessions.get(h)!);
  if (save) assert.equal((await call('save', { handle: h, path: save })).saved, save);
  return h;
}

test('Windows start times: CIM, else wmic, else unknown; start times compare only when read the same way', () => {
  const cim = (cmd: string) => { if (cmd === 'powershell.exe') return '2026-10-20T08:00:00.1234567Z\r\n'; throw new Error('no'); };
  const wmic = (cmd: string) => { if (cmd === 'wmic') return '\r\n\r\nCreationDate=20261020080000.123456+000\r\n\r\n'; throw new Error('timeout'); };
  const none = () => { throw new Error('ETIMEDOUT'); };
  assert.equal(rt.windowsStart(42, cim), 'cim:2026-10-20T08:00:00.1234567Z');
  assert.equal(rt.windowsStart(42, wmic), 'wmic:20261020080000.123456+000');
  assert.equal(rt.windowsStart(42, none), null);
  assert.equal(rt.windowsStart(42, () => ''), null, 'no such process: nothing printed');
  // a reused pid: another start time read the same way
  assert.equal(rt.startsDiffer('cim:2026-10-20T08:00:00Z', 'cim:2026-10-21T09:00:00Z'), true);
  assert.equal(rt.startsDiffer('wmic:20261020080000.1+000', 'wmic:20261020080000.1+000'), false);
  // read two ways, or not at all: no conclusion (the owner counts as alive: its folder is left alone)
  assert.equal(rt.startsDiffer('cim:2026-10-20T08:00:00Z', 'wmic:20261021090000.1+000'), false);
  assert.equal(rt.startsDiffer('cim:2026-10-20T08:00:00Z', null), false);
  assert.equal(rt.startsDiffer(null, '12345'), false);
  assert.equal(rt.startsDiffer('12345', '67890'), true, 'Linux /proc start ticks');
});

test('a closed project saved with every change goes after 7 days, not before; unsaved, missing or older saved files stay for ever', async () => {
  const out = join(TMP, 'out');
  mkdirSync(out, { recursive: true });
  const saved = await project('SAVED', join(out, 'saved.xer'));
  const unsaved = await project('UNSAVED');
  const lost = await project('LOST', join(out, 'lost.xer'));
  for (const h of [saved, unsaved, lost]) await call('close', { handle: h, discard: true });
  rmSync(join(out, 'lost.xer')); // its saved file is gone
  assert.equal(closed().length, 3);
  const now = Date.now();
  assert.deepEqual(rt.sweepRecovery(now + 6 * DAY), [], 'nothing before 7 days');
  const gone = rt.sweepRecovery(now + 8 * DAY);
  assert.equal(gone.length, 1);
  assert.match(gone[0], new RegExp(`${saved}\\.p6db\\.jsonl$`));
  // never: ten years on, unsaved work and a project whose saved file is missing are still there
  assert.deepEqual(rt.sweepRecovery(now + 3650 * DAY), []);
  assert.equal(closed().length, 2);
  const st = (await call('server_status')).recovery;
  const why = Object.fromEntries(st.kept_unsaved.filter((k: any) => k.handle === unsaved || k.handle === lost).map((k: any) => [k.handle, k.why]));
  assert.deepEqual(why, { [unsaved]: 'unsaved changes', [lost]: 'its saved file is missing' });
  assert.ok(st.bytes > 0 && st.bytes_all_servers >= st.bytes && st.keep_days === 7, JSON.stringify(st));
  // a saved file older than the last change (edited after the save, closed with discard: unsaved) stays too
  const later = await project('LATER', join(out, 'later.xer'));
  await call('edit', { handle: later, operations: [{ op: 'update_activity', id: 'A1', name: 'after the save' }] });
  rt.checkpoint(rt.sessions.get(later)!);
  await call('close', { handle: later, discard: true });
  assert.deepEqual(rt.sweepRecovery(Date.now() + 3650 * DAY), []);
});

test('P6CLONE_RECOVERY_KEEP_DAYS sets the wait', async () => {
  const out = join(TMP, 'out2');
  mkdirSync(out, { recursive: true });
  const h = await project('KEEP1', join(out, 'k.xer'));
  await call('close', { handle: h });
  process.env.P6CLONE_RECOVERY_KEEP_DAYS = '1';
  try { assert.equal(rt.sweepRecovery(Date.now() + 1.5 * DAY).length, 1); } finally { delete process.env.P6CLONE_RECOVERY_KEEP_DAYS; }
});

test('an adopted folder goes once every project in it was taken out; one still holding a project stays', async () => {
  const pid = await new Promise<number>((res) => { const c = spawn(process.execPath, ['-e', '0']); c.on('exit', () => res(c.pid!)); });
  const base = join(TMP, '.p6clone-recovery');
  const leftover = (name: string, handles: string[]) => {
    const dir = join(base, name);
    mkdirSync(dir, { recursive: true });
    const ev: Record<string, unknown> = {};
    for (const h of handles) {
      const db = { tables: {} } as any;
      applyOps(db, [{ op: 'add_project', id: h.toUpperCase(), start: '2026-03-02' }, { op: 'add_activity', id: 'L1', name: 'left', duration_days: 1 }]);
      const file = join(dir, `${h}.p6db.jsonl`);
      writeFileSync(file, [...dbLines(db, null)].join('\n') + '\n');
      ev[h] = { file, ownerKey: 'k', path: null, format: 'xer', hpd: 8, at: Date.now(), reason: 'memory', dirty: true };
    }
    writeFileSync(join(dir, 'owner.json'), JSON.stringify({ pid, token: 't', started: null }));
    writeFileSync(join(dir, 'index.json'), JSON.stringify({ evicted: ev, checkpoints: {} }));
  };
  leftover(`${pid}-aaaaaaaaaaaa`, ['h_one']);
  leftover(`${pid}-bbbbbbbbbbbb`, ['h_two', 'h_three']);
  const took = rt.adoptRecovery();
  assert.deepEqual(took.sort(), ['h_one', 'h_three', 'h_two']);
  const adopted = () => readdirSync(join(base, 'adopted')).filter((n) => !n.endsWith('.json'));
  assert.equal(adopted().length, 2);
  // h_one and h_two come back (their files move into this server's folder); h_three is never asked for
  for (const h of ['h_one', 'h_two']) assert.equal((await call('get_activity', { handle: h, activity_id: 'L1' })).name, 'left');
  rt.sweepRecovery();
  assert.deepEqual(adopted().map((n) => n.slice(0, `${pid}-b`.length)), [`${pid}-b`], 'the emptied folder went; the one holding h_three stays');
  assert.ok(existsSync(join(rt.recoveryDir(), 'h_one.p6db.jsonl')), 'restored projects live on in this server\'s folder');
  // the unsaved restored ones, closed with discard, stay for ever (and are listed)
  await call('close', { handle: 'h_one', discard: true });
  assert.deepEqual(rt.sweepRecovery(Date.now() + 3650 * DAY), []);
  assert.ok((await call('server_status')).recovery.kept_unsaved.some((k: any) => k.handle === 'h_one' && k.why === 'unsaved changes'));
  assert.ok((await call('server_status')).recovery.kept_unsaved.some((k: any) => k.handle === 'h_three'), 'the moved-out one not asked for is listed too');
});
