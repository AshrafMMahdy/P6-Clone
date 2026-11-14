import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { parseXer } from '../core/xer/parse.ts';
import { validateXer } from '../core/xer/validate.ts';
import { samples, realSamples, xer } from './helpers.ts';

const CAL = '(0||CalendarData()((0||DaysOfWeek()((0||1()())(0||2()((0||0(s|08:00|f|16:00)())))(0||3()())(0||4()())(0||5()())(0||6()())(0||7()())))(0||Exceptions()())))';

/** Minimal valid project; patch tables by replacing lines. */
function base(over: Record<string, string[]> = {}): string {
  const t: Record<string, string[]> = {
    PROJECT: ['proj_id\tproj_short_name\tplan_start_date\tlast_recalc_date\tclndr_id', '1\tP1\t2024-01-01 08:00\t2024-01-01 08:00\t1'],
    CALENDAR: ['clndr_id\tdefault_flag\tclndr_name\tclndr_type\tclndr_data', `1\tY\tStd\tCA_Base\t${CAL}`],
    PROJWBS: ['wbs_id\tproj_id\tparent_wbs_id\tproj_node_flag\twbs_short_name', '10\t1\t\tY\tP1', '11\t1\t10\tN\tW1'],
    TASK: ['task_id\tproj_id\twbs_id\tclndr_id\ttask_code\ttask_type\tstatus_code\ttarget_drtn_hr_cnt\tact_start_date\tact_end_date', '100\t1\t11\t1\tA1\tTT_Task\tTK_NotStart\t8\t\t', '101\t1\t11\t1\tA2\tTT_Task\tTK_NotStart\t8\t\t'],
    TASKPRED: ['task_pred_id\ttask_id\tpred_task_id\tproj_id\tpred_proj_id\tpred_type\tlag_hr_cnt', '1\t101\t100\t1\t1\tPR_FS\t0'],
    ...over,
  };
  const lines = ['ERMHDR\t7.0\t2024-01-01\tProject\tadmin\tadmin\tdb\tProject Management\tUSD'];
  for (const [name, [fields, ...rows]] of Object.entries(t)) {
    lines.push(`%T\t${name}`, `%F\t${fields}`, ...rows.map((r) => `%R\t${r}`));
  }
  lines.push('%E', '');
  return lines.join('\n');
}

function codes(text: string): string[] {
  const r = parseXer(xer(text));
  return validateXer(r.db, r.findings).filter((f) => f.severity !== 'info').map((f) => f.code);
}

test('valid minimal project has no warnings or errors', () => {
  assert.deepEqual(codes(base()), []);
});

const cases: [string, Record<string, string[]>][] = [
  ['MISSING_KEY_FIELD', { TASKPRED: ['taskpred_id\ttask_id\tpred_task_id\tproj_id\tpred_proj_id\tpred_type\tlag_hr_cnt', '1\t101\t100\t1\t1\tPR_FS\t0'] }],
  ['FIELD_UNKNOWN', { TASKPRED: ['task_pred_id\ttask_id\tpred_task_id\tproj_id\tpred_proj_id\tpred_type\tlag_hours', '1\t101\t100\t1\t1\tPR_FS\t0'] }],
  ['BAD_ENUM', { TASKPRED: ['task_pred_id\ttask_id\tpred_task_id\tproj_id\tpred_proj_id\tpred_type\tlag_hr_cnt', '1\t101\t100\t1\t1\tFS\t0'] }],
  ['BAD_NUMBER', { TASKPRED: ['task_pred_id\ttask_id\tpred_task_id\tproj_id\tpred_proj_id\tpred_type\tlag_hr_cnt', '1\t101\t100\t1\t1\tPR_FS\t2d'] }],
  ['BAD_DATE', { PROJECT: ['proj_id\tproj_short_name\tplan_start_date\tlast_recalc_date\tclndr_id', '1\tP1\t01/02/2024\t2024-01-01 08:00\t1'] }],
  ['DATE_FORMAT', { PROJECT: ['proj_id\tproj_short_name\tplan_start_date\tlast_recalc_date\tclndr_id', '1\tP1\t2024-01-01\t2024-01-01 08:00\t1'] }],
  ['DUP_KEY', { TASK: ['task_id\tproj_id\twbs_id\tclndr_id\ttask_code\ttask_type\tstatus_code\ttarget_drtn_hr_cnt\tact_start_date\tact_end_date', '100\t1\t11\t1\tA1\tTT_Task\tTK_NotStart\t8\t\t', '100\t1\t11\t1\tA2\tTT_Task\tTK_NotStart\t8\t\t'] }],
  ['DUP_TASK_CODE', { TASK: ['task_id\tproj_id\twbs_id\tclndr_id\ttask_code\ttask_type\tstatus_code\ttarget_drtn_hr_cnt\tact_start_date\tact_end_date', '100\t1\t11\t1\tA1\tTT_Task\tTK_NotStart\t8\t\t', '101\t1\t11\t1\tA1\tTT_Task\tTK_NotStart\t8\t\t'] }],
  ['DANGLING_REF', { TASKPRED: ['task_pred_id\ttask_id\tpred_task_id\tproj_id\tpred_proj_id\tpred_type\tlag_hr_cnt', '1\t999\t100\t1\t1\tPR_FS\t0'] }],
  ['NO_PROJ_NODE', { PROJWBS: ['wbs_id\tproj_id\tparent_wbs_id\tproj_node_flag\twbs_short_name', '11\t1\t\tN\tW1'] }],
  ['WBS_CYCLE', { PROJWBS: ['wbs_id\tproj_id\tparent_wbs_id\tproj_node_flag\twbs_short_name', '10\t1\t\tY\tP1', '11\t1\t12\tN\tW1', '12\t1\t11\tN\tW2'] }],
  ['CAL_PARSE', { CALENDAR: ['clndr_id\tdefault_flag\tclndr_name\tclndr_type\tclndr_data', '1\tY\tStd\tCA_Base\t(0||CalendarData()((0||DaysOfWeek('] }],
  ['CAL_NO_WORK', { CALENDAR: ['clndr_id\tdefault_flag\tclndr_name\tclndr_type\tclndr_data', '1\tY\tStd\tCA_Base\t(0||CalendarData()((0||DaysOfWeek()())(0||Exceptions()())))'] }],
  ['REL_SELF', { TASKPRED: ['task_pred_id\ttask_id\tpred_task_id\tproj_id\tpred_proj_id\tpred_type\tlag_hr_cnt', '1\t100\t100\t1\t1\tPR_FS\t0'] }],
  ['REL_LOOP', { TASKPRED: ['task_pred_id\ttask_id\tpred_task_id\tproj_id\tpred_proj_id\tpred_type\tlag_hr_cnt', '1\t101\t100\t1\t1\tPR_FS\t0', '2\t100\t101\t1\t1\tPR_FS\t0'] }],
  ['ACT_DATES_ORDER', { TASK: ['task_id\tproj_id\twbs_id\tclndr_id\ttask_code\ttask_type\tstatus_code\ttarget_drtn_hr_cnt\tact_start_date\tact_end_date', '100\t1\t11\t1\tA1\tTT_Task\tTK_Complete\t8\t2023-12-05 08:00\t2023-12-01 16:00'] }],
  ['STATUS_MISMATCH', { TASK: ['task_id\tproj_id\twbs_id\tclndr_id\ttask_code\ttask_type\tstatus_code\ttarget_drtn_hr_cnt\tact_start_date\tact_end_date', '100\t1\t11\t1\tA1\tTT_Task\tTK_Complete\t8\t\t'] }],
  ['ACTUAL_AFTER_DD', { TASK: ['task_id\tproj_id\twbs_id\tclndr_id\ttask_code\ttask_type\tstatus_code\ttarget_drtn_hr_cnt\tact_start_date\tact_end_date', '100\t1\t11\t1\tA1\tTT_Task\tTK_Active\t8\t2024-03-01 08:00\t'] }],
  ['MILESTONE_DURATION', { TASK: ['task_id\tproj_id\twbs_id\tclndr_id\ttask_code\ttask_type\tstatus_code\ttarget_drtn_hr_cnt\tact_start_date\tact_end_date', '100\t1\t11\t1\tA1\tTT_Mile\tTK_NotStart\t8\t\t'] }],
  ['FIELD_TOO_LONG', { TASK: ['task_id\tproj_id\twbs_id\tclndr_id\ttask_code\ttask_name\ttask_type\tstatus_code\ttarget_drtn_hr_cnt', `100\t1\t11\t1\tA1\t${'x'.repeat(121)}\tTT_Task\tTK_NotStart\t8`] }],
  ['NO_PLAN_START', { PROJECT: ['proj_id\tproj_short_name\tplan_start_date\tlast_recalc_date\tclndr_id', '1\tP1\t\t2024-01-01 08:00\t1'] }],
];

for (const [code, over] of cases) {
  test(`rule ${code}`, () => assert.ok(codes(base(over)).includes(code), codes(base(over)).join(',')));
}

test('misspelled key gets a suggestion', () => {
  const r = parseXer(xer(base(cases[0][1])));
  const f = validateXer(r.db, r.findings).find((x) => x.code === 'MISSING_KEY_FIELD')!;
  assert.match(f.message, /taskpred_id/);
});

test('DATA_AFTER_END when %E precedes tables', () => {
  const text = base().replace('%T\tCALENDAR', '%E\n%T\tCALENDAR');
  assert.ok(codes(text).includes('DATA_AFTER_END'));
});

test('real P6 samples: no fatal or error findings', () => {
  for (const s of realSamples()) {
    const r = parseXer(s.bytes);
    const bad = validateXer(r.db, r.findings).filter((f) => f.severity === 'fatal' || f.severity === 'error');
    assert.deepEqual(bad.map((f) => f.message), [], s.name);
  }
});

test('diagnostics snapshot over all samples', () => {
  const snap: Record<string, Record<string, number>> = {};
  for (const s of samples()) {
    const r = parseXer(s.bytes);
    const counts: Record<string, number> = {};
    for (const f of validateXer(r.db, r.findings)) counts[`${f.severity}:${f.code}`] = (counts[`${f.severity}:${f.code}`] ?? 0) + 1;
    snap[s.name] = Object.fromEntries(Object.entries(counts).sort());
  }
  const dir = join(import.meta.dirname, '__snapshots__');
  const file = join(dir, 'diagnostics.json');
  if (!existsSync(file) || process.env.UPDATE_SNAPSHOTS) {
    mkdirSync(dir, { recursive: true });
    writeFileSync(file, JSON.stringify(snap, null, 1) + '\n');
  }
  assert.deepEqual(snap, JSON.parse(readFileSync(file, 'utf8')));
});

test('SCHEDOPTIONS FT_Min (P6 code for smallest of start and finish float) is valid and scheduled as smallest float', async () => {
  const { optionsFor } = await import('../core/schedule/cpm.ts');
  const r = parseXer(xer(base({ SCHEDOPTIONS: ['schedoptions_id\tproj_id\tsched_float_type', '1\t1\tFT_Min'] })));
  assert.deepEqual(validateXer(r.db, r.findings).filter((f) => f.code === 'BAD_ENUM'), []);
  assert.equal(optionsFor(r.db, r.db.tables.PROJECT.rows[0]).floatType, 'smallest');
});

test('a value that is not one P6 has: the sentence says so and what the repair puts, never that P6 refuses it; the repair does what it says (owner 2026-11-14)', async () => {
  const { repairToValid } = await import('../core/xer/repair-valid.ts');
  const r = parseXer(xer(base({
    PROJECT: ['proj_id\tproj_short_name\tplan_start_date\tlast_recalc_date\tclndr_id\tdef_duration_type\tstep_complete_flag', '1\tP1\t01/02/2024\t2024-01-01 08:00\t1\tFixed Duration & Units\tyes'],
    TASK: ['task_id\tproj_id\twbs_id\tclndr_id\ttask_code\ttask_type\tstatus_code\ttarget_drtn_hr_cnt\tact_start_date\tact_end_date\tcomplete_pct_type\tduration_type\tcstr_type\tcstr_date\ttarget_work_qty',
      '100\t1\t11\t1\tA1\tTT_Task\tStarted\t8\t2024-01-01 08:00\t\tCP_Duration\tFixed\tSNET\t2024-01-03 08:00\t2d', '101\t1\t11\t1\tA2\tTT_Task\tTK_NotStart\t8\t\t\tCP_Drtn\tDT_FixedDUR2\t\t\t0'],
    TASKPRED: ['task_pred_id\ttask_id\tpred_task_id\tproj_id\tpred_proj_id\tpred_type\tlag_hr_cnt', '1\t101\t100\t1\t1\tFS\t0'],
  })));
  const said = validateXer(r.db, r.findings).filter((f) => /^BAD_/.test(f.code)).map((f) => f.message).sort();
  assert.deepEqual(said, [
    'A1 TASK.complete_pct_type is "CP_Duration", which is not a value P6 has for it (P6\'s: CP_Drtn, CP_Phys, CP_Units); save with repair: true puts CP_Drtn (Duration), P6\'s default.',
    'A1 TASK.cstr_type is "SNET", which is not a value P6 has for it (P6\'s: CS_MSO, CS_MSOB, CS_MSOA, CS_MEO, CS_MEOB, CS_MEOA, CS_ALAP, CS_MANDSTART, CS_MANDFIN); save with repair: true clears the constraint.',
    'A1 TASK.duration_type is "Fixed", which is not a value P6 has for it (P6\'s: DT_FixedDUR2, DT_FixedDrtn, DT_FixedQty, DT_FixedRate); save with repair: true puts DT_FixedDUR2 (Fixed Duration & Units), P6\'s default.',
    'A1 TASK.status_code is "Started", which is not a value P6 has for it (P6\'s: TK_NotStart, TK_Active, TK_Complete); save with repair: true puts the status the actual dates give.',
    'A1 TASK.target_work_qty is "2d", which is not a number; save with repair: true replaces it (its changes list what it puts).',
    'PROJECT.def_duration_type is "Fixed Duration & Units", which is not a value P6 has for it (P6\'s: DT_FixedDUR2, DT_FixedDrtn, DT_FixedQty, DT_FixedRate); save with repair: true empties it.',
    'PROJECT.plan_start_date is "01/02/2024", which cannot be read as a date; save with repair: true empties it.',
    'PROJECT.step_complete_flag is "yes", where P6 has Y or N; save with repair: true puts N.',
    'TASKPRED.pred_type is "FS", which is not a value P6 has for it (P6\'s: PR_FS, PR_SS, PR_FF, PR_SF); save with repair: true puts PR_FS (Finish to Start), P6\'s default.',
  ]);
  // the repair, read from the rows it leaves (not from its own list of changes)
  repairToValid(r.db);
  const a1 = r.db.tables.TASK.rows[0], p = r.db.tables.PROJECT.rows[0];
  assert.deepEqual([a1.complete_pct_type, a1.cstr_type, a1.cstr_date, a1.duration_type, a1.status_code, a1.target_work_qty, p.def_duration_type, p.plan_start_date, p.step_complete_flag, r.db.tables.TASKPRED.rows[0].pred_type],
    ['CP_Drtn', '', '', 'DT_FixedDUR2', 'TK_Active', '0', '', '', 'N', 'PR_FS']);
  assert.deepEqual(validateXer(r.db).filter((f) => /^BAD_/.test(f.code)), []);
});
