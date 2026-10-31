// Two read problems found by the platform's corpus run on whiq-v0.1.51 (cloneParity, 2026-10-31):
// - a file with %E after each table (and after rows) was read only up to its first %E: "No PROJECT rows";
// - an activity the clone cannot identify (a row made from a damaged line) was listed by read_table, then missing from the
//   repaired copy, with nothing at open time saying so: the platform logged it as a clone fault (clone_row_missing).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { callTool, toolResult } from '../mcp/server.ts';
import { parseXer } from '../core/xer/parse.ts';
import { SAMPLES_DIR, sampleCopy } from './helpers.ts';

const call = async (name: string, args: Record<string, unknown>) => { const r = await callTool(name, args); return { err: r.isError, d: toolResult(r.out, r.isError).structuredContent as any }; };
const xer = (s: string) => new TextEncoder().encode(s.replace(/\n/g, '\r\n'));

test('%E between tables and between rows: everything after it is read, and the stray marker is reported', () => {
  const text = [
    'ERMHDR\t18.8\t2026-09-24\t\tProject\tADMIN\tX\tX\tP6 Professional\t\tEUR',
    '%T\tCURRTYPE', '%F\tcurr_id\tcurr_short_name', '%R\t1\tEUR', '%E',
    '%T\tPROJECT', '%F\tproj_id\tproj_short_name', '%R\t1\tP1', '%E',
    '%T\tPROJWBS', '%F\twbs_id\tproj_id\tparent_wbs_id\twbs_short_name\tproj_node_flag', '%R\t1\t1\t\tP1\tY', '%E', '%R\t2\t1\t1\tW1\tN', '%E', '',
  ].join('\n');
  const r = parseXer(xer(text));
  assert.equal(r.db.tables.PROJECT.rows.length, 1);
  assert.deepEqual(r.db.tables.PROJWBS.rows.map((w) => w.wbs_short_name), ['P1', 'W1'], 'a row after a %E joins its table');
  const f = r.findings.find((x) => x.code === 'DATA_AFTER_END')!;
  assert.match(f.message, /line 5 \(and 2 more\).*read as if the markers were not there/);
  assert.ok(r.meta.hasEnd);
  // a %E at the end only: no finding
  assert.ok(!parseXer(xer(text.replace(/%E\n(?=%[TR])/g, ''))).findings.some((x) => x.code === 'DATA_AFTER_END'));
});

test('PDC1_Baseline_Rev0.xer (%E after every table and row) opens with its project and 248 activities', async () => {
  const r = parseXer(new Uint8Array(readFileSync(join(SAMPLES_DIR, 'PDC1_Baseline_Rev0.xer'))));
  assert.equal(r.db.tables.PROJECT.rows.length, 1);
  assert.equal(r.db.tables.TASK.rows.length, 248);
  assert.equal(r.db.tables.TASKPRED.rows.length, 355);
  const o = await call('open_file', { path: sampleCopy('PDC1_Baseline_Rev0.xer'), lenient: true });
  assert.equal(o.err, false, JSON.stringify(o.d).slice(0, 300));
  assert.equal(o.d.summary.activities, 248);
  assert.equal(o.d.summary.projects[0].id, 'PDC1-BASE');
  await call('close', { handle: o.d.handle, owner_key: o.d.owner_key, discard: true });
});

test('open_file names the activities P6 does not load (damaged lines), with their line: the rows a repaired save removes', async () => {
  const path = sampleCopy('CCA R03 dt 24Oct11SC.xer');
  const o = await call('open_file', { path, lenient: true });
  assert.equal(o.err, false, JSON.stringify(o.d).slice(0, 300));
  const u = o.d.unreadable_rows;
  assert.ok(u && u.total >= 4, JSON.stringify(u).slice(0, 300));
  const r417 = u.rows.find((x: any) => x.row === 417);
  assert.ok(r417, 'TASK row 417 (task_id 160811, its columns shifted) is named');
  assert.equal(r417.task_id, '160811');
  // its line in the file is the line that holds it
  const lines = readFileSync(path, 'latin1').split(/\r?\n/);
  assert.match(lines[r417.line - 1], /^%R\t160811\t/);
  // the same rows a save with repair removes from TASK
  const out = path.replace(/\.xer$/, '-repaired.xer');
  const sv = await call('save', { handle: o.d.handle, owner_key: o.d.owner_key, path: out, repair: true });
  assert.equal(sv.err, false, JSON.stringify(sv.d).slice(0, 300));
  const removed = (sv.d.changes ?? []).filter((c: any) => c.table === 'TASK' && c.field === '*' && /cannot be identified: (a row made|no readable)/.test(c.reason)).map((c: any) => c.row).sort((a: number, b: number) => a - b);
  const named = u.rows.map((x: any) => x.row).sort((a: number, b: number) => a - b);
  assert.deepEqual(named, removed);
  await call('close', { handle: o.d.handle, owner_key: o.d.owner_key, discard: true });
});
