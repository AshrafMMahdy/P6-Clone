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
  ['REL_DUP', { TASKPRED: ['task_pred_id\ttask_id\tpred_task_id\tproj_id\tpred_proj_id\tpred_type\tlag_hr_cnt', '1\t101\t100\t1\t1\tPR_FS\t0', '2\t101\t100\t1\t1\tPR_FS\t8'] }],
  ['ACT_DATES_ORDER', { TASK: ['task_id\tproj_id\twbs_id\tclndr_id\ttask_code\ttask_type\tstatus_code\ttarget_drtn_hr_cnt\tact_start_date\tact_end_date', '100\t1\t11\t1\tA1\tTT_Task\tTK_Complete\t8\t2023-12-05 08:00\t2023-12-01 16:00'] }],
  ['STATUS_MISMATCH', { TASK: ['task_id\tproj_id\twbs_id\tclndr_id\ttask_code\ttask_type\tstatus_code\ttarget_drtn_hr_cnt\tact_start_date\tact_end_date', '100\t1\t11\t1\tA1\tTT_Task\tTK_Complete\t8\t\t'] }],
  ['ACTUAL_AFTER_DD', { TASK: ['task_id\tproj_id\twbs_id\tclndr_id\ttask_code\ttask_type\tstatus_code\ttarget_drtn_hr_cnt\tact_start_date\tact_end_date', '100\t1\t11\t1\tA1\tTT_Task\tTK_Active\t8\t2024-03-01 08:00\t'] }],
  ['MILESTONE_DURATION', { TASK: ['task_id\tproj_id\twbs_id\tclndr_id\ttask_code\ttask_type\tstatus_code\ttarget_drtn_hr_cnt\tact_start_date\tact_end_date', '100\t1\t11\t1\tA1\tTT_Mile\tTK_NotStart\t8\t\t'] }],
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
