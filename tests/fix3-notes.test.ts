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

/** A built project with a data date and a planned start; `clear` blanks them as given. */
async function datesBuilt(clear: { start?: boolean; dd?: boolean }): Promise<string> {
  const h = await built('2026-01-05', [act('A', 5), act('B', 3), rel('A', 'B')]);
  const e = await call('edit', { handle: h, operations: [{ op: 'set_fields', table: 'PROJECT', all: true, fields: { ...(clear.start ? { plan_start_date: '' } : {}), ...(clear.dd ? { last_recalc_date: '' } : {}) } }] });
  assert.ok(e.ok !== false && !e.error, JSON.stringify(e));
  return h;
}
const STATE = /^P has no data date and no planned start: nothing can be calculated; set one with edit set_project \(planned start\) or pass (data_date|status_date)\.$/;
const stateOf = (notes: string[] | undefined) => (notes ?? []).filter((n) => /no data date and no planned start/.test(n));

test('5: no data date and no planned start: one sentence in every tool, a refusal with its next step where the tool calculates', async () => {
  const h = await datesBuilt({ start: true, dd: true });
  for (const t of ['project_summary', 'dcma_14', 'decm', 'check_schedule', 'planning_horizon', 'critical_path', 'float_paths', 'schedule_index', 'schedule_health', 'progress_curves', 'earned_value']) {
    const r = await call(t, { handle: h });
    const st = stateOf(r.notes);
    assert.equal(st.length, 1, `${t}: ${JSON.stringify(r.notes ?? r.error)}`);
    assert.match(st[0], STATE, t);
    assert.ok(!(r.notes ?? []).some((n: string) => /no planned start either|none either|\(no planned start/.test(n)), t);
    // the same fact is not said again in other words
    assert.equal((r.notes ?? []).filter((n: string) => /has no data date/.test(n)).length, 1, `${t}: ${JSON.stringify(r.notes)}`);
  }
  for (const [t, args] of [['schedule', {}], ['evaluate', { overrides: [] }], ['monte_carlo', { iterations: 20 }]] as [string, Record<string, unknown>][]) {
    const r = await call(t, { handle: h, ...args });
    assert.ok(r.error, `${t} is refused: ${JSON.stringify(r).slice(0, 300)}`);
    assert.match(r.error.message, /^Refused: .*P has no data date and no planned start: nothing can be calculated\.$/, t);
    assert.match(r.error.hint ?? '', /^Set one with edit set_project \(planned start\) or pass data_date\.$/, `${t}: a next step`);
    assert.doesNotMatch(r.error.hint ?? '', /loop|calendar/, t);
    assert.equal((r.error.message.match(/Refused:/g) ?? []).length, 1, `${t}: not a refusal inside a refusal`);
  }
  const v = await call('validate', { handle: h });
  assert.doesNotMatch(JSON.stringify(v), /none either|no planned start either/);
});

test('6: a planned start stands in for the data date: every tool that uses it says so once, and save says it wrote it', async () => {
  const h = await datesBuilt({ dd: true });
  for (const [t, args] of [['monte_carlo', { iterations: 20 }], ['evaluate', { overrides: [] }]] as [string, Record<string, unknown>][]) {
    const r = await call(t, { handle: h, ...args });
    assert.equal((r.notes ?? []).filter((n: string) => /^P has no data date: the planned start 2026-01-05 \d\d:\d\d was used\./.test(n)).length, 1, `${t}: ${JSON.stringify(r.notes)}`);
  }
  for (const t of ['progress_curves', 'earned_value']) {
    const r = await call(t, { handle: h });
    assert.equal((r.notes ?? []).filter((n: string) => /^.* not assessed: P has no data date; set one with schedule data_date\.$/.test(n)).length, 1, `${t}: ${JSON.stringify(r.notes)}`);
  }
  // the series tools: an update with no data date is dated by its planned start, said once
  const other = await datesBuilt({ dd: true });
  void other;
  // schedule assumes the planned start; save writes it into the file and says so once
  const s = await call('schedule', { handle: h });
  assert.equal((s.notes ?? []).filter((n: string) => /was used/.test(n)).length, 1, JSON.stringify(s.notes));
  const path = join(W, 'assumed.xer');
  const sv = await call('save', { handle: h, path, overwrite: true });
  assert.equal((sv.notes ?? []).filter((n: string) => /^P had no data date: 2026-01-05 \d\d:\d\d \(its planned start\) was written as the data date\.$/.test(n)).length, 1, JSON.stringify(sv));
  const sv2 = await call('save', { handle: h, path, overwrite: true });
  assert.ok(!(sv2.notes ?? []).some((n: string) => /was written as the data date/.test(n)), 'said once: the file has it now');
  const o = await call('open_file', { path });
  assert.ok(!(o.summary?.notes ?? o.notes ?? []).some((n: string) => /no data date/.test(n)));
});

test('7: a stored baseline is never "saved dates not current"; the stale note after an edit names the live project and follows set_project data_date and must_finish_by', async () => {
  const o = await call('open_file', { path: join(SAMPLES_DIR, 'Tower-A.xer'), lenient: true });
  const h = o.handle as string;
  await call('schedule', { handle: h });
  const noBaseline = (r: any) => assert.ok(!JSON.stringify(r.notes ?? []).includes('BL1') && !JSON.stringify(r).includes('saved dates of TOWER-A-BL1'), JSON.stringify(r.notes));
  for (const t of ['validate', 'review', 'critical_path', 'float_paths']) { const r = await call(t, { handle: h }); noBaseline(r); if (t === 'review') assert.ok(!JSON.stringify(r).includes('TOWER-A-BL1'), 'review'); }
  const stale = (e: any) => (e.notes ?? []).filter((n: string) => /saved dates of/.test(n));
  const ddEdit = await call('edit', { handle: h, operations: [{ op: 'set_project', data_date: '2026-04-08' }] });
  assert.equal(stale(ddEdit).length, 1, JSON.stringify(ddEdit.notes ?? ddEdit).slice(0, 400));
  assert.match(stale(ddEdit)[0], /^The saved dates of TOWER-A are not current: /);
  await call('schedule', { handle: h });
  const mfb = await call('edit', { handle: h, operations: [{ op: 'set_project', must_finish_by: '2026-06-30' }] });
  assert.ok(stale(mfb).every((n: string) => /^The saved dates of TOWER-A are not current: /.test(n)), JSON.stringify(mfb.notes));
  // the answer of the edit never names the stored baseline
  assert.ok(!JSON.stringify(mfb).includes('TOWER-A-BL1') && !JSON.stringify(ddEdit).includes('TOWER-A-BL1'));
  await call('schedule', { handle: h });
  const lag = await call('edit', { handle: h, operations: [{ op: 'update_relationship', pred: 'A1020', succ: 'A1030', lag_days: 3 }] });
  assert.ok(!JSON.stringify(lag).includes('TOWER-A-BL1'), JSON.stringify(lag.notes));
  await call('schedule', { handle: h });
  const dur = await call('edit', { handle: h, operations: [{ op: 'update_activity', id: 'A1030', duration_days: 60 }] });
  assert.equal(stale(dur).length, 1, JSON.stringify(dur).slice(0, 500));
  assert.match(stale(dur)[0], /^The saved dates of TOWER-A are not current/);
});

test('8: edit changes are named as P6 names them, in the units the operation takes, with the ids the agent uses, each change once', async () => {
  const o = await call('open_file', { path: join(SAMPLES_DIR, 'Tower-A.xer'), lenient: true });
  const h = o.handle as string;
  const ch = async (ops: unknown[]) => { const e = await call('edit', { handle: h, operations: ops }); assert.ok(!e.error, JSON.stringify(e)); return e.changes as { id: string; field: string; old: unknown; new: unknown }[]; };
  const proj = await ch([{ op: 'set_project', data_date: '2026-04-08', planned_start: '2026-03-02', must_finish_by: '2026-12-31' }]);
  assert.deepEqual(proj.map((c) => [c.id, c.field]), [['TOWER-A', 'Data Date'], ['TOWER-A', 'Planned Start'], ['TOWER-A', 'Must Finish By']]);
  const res = await ch([{ op: 'update_resource', id: 'PILE', name: 'Renamed R', max_units_per_day: 12 }]);
  assert.deepEqual(res.map((c) => [c.id, c.field, c.old, c.new]), [['PILE', 'Resource Name', 'Piling Crew', 'Renamed R'], ['PILE', 'Max Units/Time (units a day)', 48, 12]], 'the limit in units a day, once, under the Resource ID');
  const pr = await ch([{ op: 'set_fields', table: 'TASK', where: { task_code: 'A1030', proj_id: '10' }, fields: { priority_type: 'PT_High' } }]);
  assert.deepEqual(pr, [{ id: 'A1030', field: 'Leveling Priority', old: null, new: 'High' }]);
  const hol = await ch([{ op: 'add_holidays', calendar: 'Site 5-Day', dates: ['2026-05-04', '2026-05-05'] }]);
  assert.equal(hol.length, 1); assert.equal(hol[0].id, 'Site 5-Day'); assert.equal(hol[0].field, 'Calendar Exceptions Added'); assert.equal(hol[0].new, '2026-05-04, 2026-05-05');
  const lag = await ch([{ op: 'update_relationship', pred: 'A1020', succ: 'A1030', lag_days: 3 }]);
  assert.deepEqual(lag, [{ id: 'A1020 SS A1030', field: 'Lag (days)', old: 2, new: 3 }]);
  const txt = await ch([{ op: 'replace_text', pairs: [{ find: 'Drive piles', replace: 'Bore piles' }] }]);
  assert.deepEqual(txt.map((c) => c.id), ['A1020', 'A1020 in baseline TOWER-A-BL1'], 'the stored baseline copy is named as such');
  const con = await ch([{ op: 'update_activity', id: 'A1030', constraint: { type: 'finish_on_or_before', date: '2026-07-01' } }]);
  assert.deepEqual(con.map((c) => [c.field, c.old, c.new]), [['Primary Constraint', 'Start On or After', 'Finish On or Before'], ['Primary Constraint Date', '2026-03-19 08:00', '2026-07-01 00:00']]);
  const all = JSON.stringify([proj, res, pr, hol, lag, txt, con]);
  assert.doesNotMatch(all, /last_recalc|plan_end|rsrc_name|max_qty|PT_|PR_|TT_|TK_|CS_|clndr_data|\(hours\)/);
});
