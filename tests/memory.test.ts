import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { SAMPLES_DIR } from './helpers.ts';

// Opening a file must stay within a few times its size (the MCP server admits files by ~5x their size against its
// memory budget). Measured in a fresh process with a small young generation, so the fixed ~100 MB V8 keeps for
// short-lived objects does not hide what the parsed data itself costs. scripts/measure-memory.ts has the full picture.
test('parsing an XER takes at most 3x its size in heap, and peaks below 6x', () => {
  const parse = pathToFileURL(join(import.meta.dirname, '..', 'core', 'xer', 'parse.ts')).href;
  const file = join(SAMPLES_DIR, 'DHBL-24FEB13_VER-7.0.xer'); // 12 MB, 106k rows
  const code = `
    import { readFileSync } from 'node:fs';
    const { parseXer } = await import(${JSON.stringify(parse)});
    const heap = () => { gc(); gc(); return process.memoryUsage().heapUsed; };
    const h0 = heap(), r0 = process.memoryUsage().rss;
    let bytes = new Uint8Array(readFileSync(${JSON.stringify(file)}));
    const size = bytes.length, { db } = parseXer(bytes);
    const peak = process.resourceUsage().maxRSS * 1024 - r0;
    bytes = null;
    console.log(JSON.stringify({ heap: (heap() - h0) / size, peak: peak / size, rows: Object.values(db.tables).reduce((n, t) => n + t.rows.length, 0) }));`;
  const out = JSON.parse(execFileSync(process.execPath, ['--expose-gc', '--max-semi-space-size=1', '--input-type=module', '-e', code], { encoding: 'utf8' }));
  assert.ok(out.rows > 100000, `rows ${out.rows}`);
  assert.ok(out.heap <= 3, `heap after parse ${out.heap.toFixed(2)}x the file size`);
  assert.ok(out.peak <= 6, `peak RSS while parsing ${out.peak.toFixed(2)}x the file size`);
});

// One edit of tens of thousands of operations (a plan built from a big schedule: 129 trial.xer is 50,089 operations,
// 21,646 of them assign_code) must stay linear: an operation that gave a table a new array made the undo journal keep
// a copy of it per operation, and searches through the journal's recording view were slow per row. Applied the way
// the MCP server does (a change journal around the edit's own), in a fresh process with a 1 GB heap.
test('a 31,000-operation edit (20,000 assign_code) stays linear in time and memory, undo journal included', () => {
  const url = (p: string) => JSON.stringify(pathToFileURL(join(import.meta.dirname, '..', ...p.split('/'))).href);
  const code = `
    const { applyOps } = await import(${url('core/project/ops.ts')});
    const { record, rollback } = await import(${url('core/journal.ts')});
    const heap = () => { gc(); gc(); return process.memoryUsage().heapUsed; };
    const db = { tables: {} };
    const N = 2000, TYPES = 10;
    const base = [{ op: 'add_project', id: 'BIG', start: '2026-03-02' }, { op: 'add_resource', id: 'R' }, { op: 'add_udf', name: 'Zone' }];
    for (let i = 0; i < N; i++) base.push({ op: 'add_activity', id: 'A' + i, name: 'Activity ' + i, duration_days: 2 });
    for (let k = 0; k < TYPES; k++) base.push({ op: 'add_code_type', name: 'T' + k, values: Array.from({ length: 20 }, (_, v) => ({ code: 'V' + v })) });
    if (!applyOps(db, base).ok) throw new Error('base');
    const ops = [];
    for (let k = 0; k < TYPES; k++) for (let i = 0; i < N; i++) ops.push({ op: 'assign_code', activity: 'A' + i, type: 'T' + k, value: 'V' + ((i + k) % 20) });
    for (let i = 0; i < N; i++) ops.push({ op: 'assign_code', activity: 'A' + i, type: 'T0', value: 'V1' }); // replaces one
    for (let i = 1; i < N; i++) ops.push({ op: 'add_relationship', pred: 'A' + (i - 1), succ: 'A' + i });
    for (let i = 1; i < N; i += 4) ops.push({ op: 'delete_relationship', pred: 'A' + (i - 1), succ: 'A' + i });
    for (let i = 0; i < N; i++) ops.push({ op: 'assign_resource', activity: 'A' + i, resource: 'R' });
    for (let i = 0; i < N; i += 4) ops.push({ op: 'unassign_resource', activity: 'A' + i, resource: 'R' });
    for (let i = 0; i < N; i++) ops.push({ op: 'set_udf', udf: 'Zone', activity: 'A' + i, value: 'Z' + i }, { op: 'set_notebook', activity: 'A' + i, text: 'note ' + i });
    const h0 = heap(), c0 = process.cpuUsage();
    let r;
    const j = record(db, (d) => { r = applyOps(d, ops); });
    const c1 = process.cpuUsage(c0), seconds = (c1.user + c1.system) / 1e6, grew = (heap() - h0) / 1048576;
    const T = (n) => db.tables[n]?.rows.length ?? 0;
    const counts = [T('TASKACTV'), T('TASKPRED'), T('TASKRSRC'), T('UDFVALUE'), T('TASKMEMO')];
    rollback(j);
    console.log(JSON.stringify({ ok: r.ok, applied: r.applied, seconds, grew, counts, undone: [T('TASKACTV'), T('TASKPRED')] }));`;
  const out = JSON.parse(execFileSync(process.execPath, ['--expose-gc', '--max-old-space-size=1024', '--input-type=module', '-e', code], { encoding: 'utf8', timeout: 120_000 }));
  assert.equal(out.ok, true);
  assert.equal(out.applied, 30999);
  assert.deepEqual(out.counts, [20000, 1499, 1500, 2000, 2000]);
  assert.deepEqual(out.undone, [0, 0]);
  assert.ok(out.grew < 150, `the edit and its journal hold ${out.grew.toFixed(0)} MB (before the fix: GBs, the process died)`);
  // CPU time, not wall time: a loaded machine (other tests, other sessions) stretches the wall clock, not the work
  assert.ok(out.seconds < 30, `the edit took ${out.seconds} s of CPU`);
});
