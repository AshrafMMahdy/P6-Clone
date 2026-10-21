// Each open project remembers the text encoding its file was read in, and `save` without an encoding writes in it
// (BOM as read); a new project, or an explicit encoding, chooses as before.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { callTool, toolResult } from '../mcp/server.ts';
import { evict, sessions } from '../mcp/runtime.ts';
import { applyOps } from '../core/project/ops.ts';
import { writeXer } from '../core/xer/write.ts';
import { detectEncoding, textDecoder, type TextEncodingName } from '../core/encoding.ts';
import { SAMPLES_DIR } from './helpers.ts';
import type { Db } from '../core/db.ts';

const call = async (name: string, args: Record<string, unknown>) => { const r = await callTool(name, args); return toolResult(r.out, r.isError).structuredContent as any; };
const dir = mkdtempSync(join(tmpdir(), 'p6enc-'));
const RENAMED = 'أعمال الحفر (مراجعة)';

/** An Arabic project as the clone writes it, in the given encoding. */
function arabicFile(enc: TextEncodingName): string {
  const db: Db = { tables: {} };
  assert.equal(applyOps(db, [{ op: 'add_project', id: 'AR', name: 'برج القاهرة', start: '2026-03-02' }, { op: 'add_wbs', code: 'S', name: 'الهيكل' },
    { op: 'add_activity', id: 'A1', name: 'أعمال الحفر', wbs: 'S', duration_days: 5 }, { op: 'add_activity', id: 'A2', name: 'صب الخرسانة', wbs: 'S', duration_days: 3 },
    { op: 'add_relationship', pred: 'A1', succ: 'A2' }]).ok, true);
  const path = join(dir, `ar-${enc}.xer`);
  writeFileSync(path, writeXer(db, { version: '19.12', encoding: enc }));
  return path;
}
const decode = (b: Uint8Array, enc: TextEncodingName) => textDecoder(enc === 'utf-8-bom' ? 'utf-8' : enc, { ignoreBOM: true }).decode(enc === 'utf-8-bom' ? b.subarray(3) : b);
/** Open, rename one activity, save with no encoding: the bytes before and after. */
async function roundTrip(src: string, id?: string, path = join(dir, `out-${Math.random().toString(36).slice(2)}.xer`)) {
  const o = await call('open_file', { path: src });
  const act = id ?? (await call('find_activities', { handle: o.handle, limit: 1 })).activities[0].id;
  assert.equal((await call('edit', { handle: o.handle, operations: [{ op: 'update_activity', id: act, name: RENAMED }] })).ok, true);
  const sv = await call('save', { handle: o.handle, owner_key: o.owner_key, path });
  return { a: new Uint8Array(readFileSync(src)), b: new Uint8Array(readFileSync(path)), sv, act };
}
/** The lines that differ (header export date aside), as text in the file's encoding. */
function changed(a: Uint8Array, b: Uint8Array, enc: TextEncodingName) {
  const la = decode(a, enc).split('\r\n'), lb = decode(b, enc).split('\r\n');
  assert.equal(la.length, lb.length);
  const hdr = (l: string) => l.split('\t').filter((_, i) => i !== 2).join('\t'); // ERMHDR: the export date is the day of the save
  return la.map((l, i) => [l, lb[i]]).filter(([x, y], i) => (i === 0 ? hdr(x) !== hdr(y) : x !== y));
}

for (const enc of ['utf-8', 'utf-8-bom', 'windows-1256'] as TextEncodingName[]) {
  test(`an Arabic XER in ${enc}: open, edit, save with no encoding gives the same bytes but for the edited field`, async () => {
    const { a, b, sv } = await roundTrip(arabicFile(enc), 'A1');
    assert.equal(detectEncoding(b).encoding, enc);
    assert.equal(b[0] === 0xef, enc === 'utf-8-bom', 'BOM as read');
    const diff = changed(a, b, enc);
    assert.equal(diff.length, 1, JSON.stringify(diff));
    const [x, y] = diff[0].map((l) => l.split('\t'));
    // the edit stamps the row's update date (to the minute): a minute passing between the file's making and the save is no difference
    const stamp = (v: string) => /^\d{4}-\d\d-\d\d \d\d:\d\d$/.test(v);
    assert.deepEqual(x.map((v, i) => (v === y[i] || (stamp(v) && stamp(y[i])) ? null : [v, y[i]])).filter(Boolean), [['أعمال الحفر', RENAMED]]);
    assert.equal(sv.notes, undefined);
  });
}

test('a real windows-1256 export from P6 (building a.xer): the same bytes but for the edited field', async () => {
  const { a, b } = await roundTrip(join(SAMPLES_DIR, 'building a.xer'));
  assert.equal(detectEncoding(b).encoding, 'windows-1256');
  const diff = changed(a, b, 'windows-1256');
  assert.equal(diff.length, 1);
  assert.ok(diff[0][1].includes(RENAMED));
});

test('each handle keeps its own encoding: two open at once save in their own; a new project and an explicit encoding choose as before', async () => {
  const u = await call('open_file', { path: arabicFile('utf-8') }), c = await call('open_file', { path: arabicFile('windows-1256') });
  const save = async (o: any, extra: Record<string, unknown> = {}) => { const p = join(dir, `h-${Math.random().toString(36).slice(2)}.xer`); await call('save', { handle: o.handle, owner_key: o.owner_key, path: p, ...extra }); return new Uint8Array(readFileSync(p)); };
  for (const o of [u, c, u]) await call('edit', { handle: o.handle, operations: [{ op: 'update_activity', id: 'A2', name: 'صب الخرسانة 2' }] });
  assert.deepEqual([detectEncoding(await save(u)).encoding, detectEncoding(await save(c)).encoding], ['utf-8', 'windows-1256']);
  // an explicit encoding wins
  assert.equal(detectEncoding(await save(u, { encoding: 'windows-1256' })).encoding, 'windows-1256');
  assert.equal(detectEncoding(await save(u)).encoding, 'utf-8', 'and the handle still keeps its own');
  evict(sessions.get(u.handle)!, 'memory'); // moved out of memory and back: still its own
  assert.equal(detectEncoding(await save(u)).encoding, 'utf-8');
  // a new project: the code page P6 would use (Arabic: windows-1256), as before
  const n = await call('new_project', { id: 'NW', start: '2026-03-02' });
  await call('edit', { handle: n.handle, operations: [{ op: 'add_activity', id: 'N1', name: 'أعمال الحفر والردم', duration_days: 1 }] });
  assert.equal(detectEncoding(await save(n)).encoding, 'windows-1256');
  // text the code page it was read in cannot hold: written as P6 would (UTF-8 here), with a note
  await call('edit', { handle: c.handle, operations: [{ op: 'update_activity', id: 'A1', name: '混凝土 أعمال' }] });
  const p = join(dir, 'cjk.xer');
  const sv = await call('save', { handle: c.handle, owner_key: c.owner_key, path: p });
  assert.equal(detectEncoding(new Uint8Array(readFileSync(p))).encoding, 'utf-8');
  assert.match(sv.notes.join(' '), /Read as Arabic \(Windows-1256\), but the text no longer fits it: written as Unicode \(UTF-8\)/);
});
