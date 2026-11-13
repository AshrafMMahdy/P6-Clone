// Fix round 3 (items 3-14): each condition is built and the answer's sentence asserted: true, present, once.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { callTool, toolResult } from '../mcp/server.ts';
import { setRoots } from '../mcp/runtime.ts';
import { SAMPLES_DIR } from './helpers.ts';
import { writeFileSync } from 'node:fs';
import { applyOps } from '../core/project/ops.ts';
import { writeXer } from '../core/xer/write.ts';
import { rows, type Db } from '../core/db.ts';

const W = mkdtempSync(join(tmpdir(), 'p6-fix3-'));
setRoots(join(import.meta.dirname, '..'), W);
const call = async (name: string, args: Record<string, unknown>) => { const r = await callTool(name, args); return toolResult(r.out, r.isError, name).structuredContent as any; };
async function built(start: string, ops: unknown[], id = 'P'): Promise<string> {
  const p = await call('new_project', { id, start });
  const e = await call('edit', { handle: p.handle, operations: ops });
  assert.ok(e.ok !== false && !e.error, JSON.stringify(e));
  return p.handle;
}
const act = (id: string, d: number, more: Record<string, unknown> = {}) => ({ op: 'add_activity', id, name: id, duration_days: d, ...more });
const rel = (pred: string, succ: string, extra: Record<string, unknown> = {}) => ({ op: 'add_relationship', pred, succ, ...extra });
const sampleHandle = async (name: string) => (await call('open_file', { path: join(SAMPLES_DIR, name), lenient: true })).handle as string;
void sampleHandle;

test('3: a constraint given as a bare date, met at 17:00 of the working day before, is not reported as unmet (schedule and compute_schedule)', async () => {
  // A5 must finish 2026-01-09 (stored 00:00): scheduled to finish Thursday 2026-01-08 17:00, the same working moment
  const h = await built('2026-01-05', [act('A5', 4, { constraint: { type: 'mandatory_finish', date: '2026-01-09' } })]);
  const s = await call('schedule', { handle: h });
  const unmet = s.log.exceptions.find((x: any) => x.code === 'CONSTRAINT_UNMET');
  assert.equal(unmet, undefined, JSON.stringify(unmet));
  assert.ok(!JSON.stringify(s).includes('is not met'), JSON.stringify(s.log).slice(0, 600));
  // and a constraint that really is not met still is
  const h2 = await built('2026-01-05', [act('A1', 10), act('A5', 2, { constraint: { type: 'finish_on_or_before', date: '2026-01-09' } }), rel('A1', 'A5')]);
  const s2 = await call('schedule', { handle: h2 });
  assert.match(JSON.stringify(s2.log.exceptions.find((x: any) => x.code === 'CONSTRAINT_UNMET')), /Finish On or Before 2026-01-09 00:00 is not met/);
  // compute_schedule (the description, no handle)
  const c = await call('compute_schedule', { start: '2026-01-05', activities: [{ id: 'A5', name: 'A5', duration_days: 4, constraint: { type: 'mandatory_finish', date: '2026-01-09' } }] });
  assert.ok(!JSON.stringify(c).includes('is not met'), JSON.stringify(c).slice(0, 600));
});

test('4: compute_schedule with a loop says the links left out once, with no unmet sentence for them and no "saved logic" (it saves nothing)', async () => {
  const c = await call('compute_schedule', { start: '2026-01-05', activities: [
    { id: 'A', duration_days: 2 }, { id: 'B', duration_days: 2, predecessors: [{ id: 'A' }] }, { id: 'C', duration_days: 2, predecessors: [{ id: 'B' }] }, { id: 'D', duration_days: 2, predecessors: [{ id: 'C' }] },
  ], relationships: [{ pred: 'D', succ: 'A' }] });
  assert.equal(c.ok, true, JSON.stringify(c).slice(0, 400));
  const notes: string[] = c.notes;
  const left = notes.filter((n) => /Left out of this schedule/.test(n));
  assert.equal(left.length, 1, JSON.stringify(notes));
  assert.doesNotMatch(left[0], /saved logic/);
  const names = c.broken_links.map((x: any) => `${x.pred} ${x.type} ${x.succ}`);
  assert.ok(names.length >= 1);
  for (const n of names) assert.ok(!notes.some((x) => x.startsWith(`${n} is not met`)), `${n}: ${JSON.stringify(notes)}`);
  // a project: schedule keeps the sentence (its dates are saved, the logic is not)
  const db: Db = { tables: {} };
  assert.equal(applyOps(db, [{ op: 'add_project', id: 'L', start: '2026-01-05' }, act('A', 2), act('B', 2), act('C', 2), rel('A', 'B'), rel('B', 'C')]).ok, true);
  const T = rows(db, 'TASK'), id = (c: string) => T.find((t) => t.task_code === c)!.task_id;
  db.tables.TASKPRED.rows.push({ ...db.tables.TASKPRED.rows[0], task_pred_id: '99', pred_task_id: id('C'), task_id: id('A') });
  const path = join(W, 'loop.xer');
  writeFileSync(path, writeXer(db, { version: '19.12' }));
  const o = await call('open_file', { path, lenient: true }); const h = o.handle; assert.ok(h, JSON.stringify(o).slice(0, 300));
  const s = await call('schedule', { handle: h, break_loops: true });
  const text = JSON.stringify(s);
  assert.match(text, /Left out of this schedule to break loops: .*the saved logic is unchanged\./);
  assert.ok(!/ is not met by /.test(JSON.stringify(s.log.exceptions.find((x: any) => x.code === 'RELATIONSHIP_UNMET') ?? {})), text.slice(0, 600));
});
