import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scheduleProjects } from '../core/schedule/cpm.ts';
import type { Db, Row } from '../core/db.ts';

const CAL = '(0||CalendarData()((0||DaysOfWeek()((0||1()())(0||2()((0||0(s|08:00|f|16:00)())))(0||3()((0||0(s|08:00|f|16:00)())))(0||4()((0||0(s|08:00|f|16:00)())))(0||5()((0||0(s|08:00|f|16:00)())))(0||6()((0||0(s|08:00|f|16:00)())))(0||7()())))(0||Exceptions()())))';

type T = { code: string; d?: number; [k: string]: string | number | undefined };
/** Project starting Mon 2024-01-08 (data date). Durations in days (8 h). Links as [pred, succ, type, lagDays]. */
function build(tasks: T[], links: [string, string, string?, number?][] = [], proj: Partial<Row> = {}): Db {
  const id = (c: string) => String(tasks.findIndex((t) => t.code === c) + 100);
  const tbl = (name: string, rs: Row[]) => ({ name, fields: [...new Set(rs.flatMap((r) => Object.keys(r)))], rows: rs });
  return {
    tables: {
      PROJECT: tbl('PROJECT', [{ proj_id: '1', proj_short_name: 'P', clndr_id: '1', plan_start_date: '2024-01-08 00:00', last_recalc_date: '2024-01-08 00:00', plan_end_date: '', ...proj }]),
      CALENDAR: tbl('CALENDAR', [{ clndr_id: '1', default_flag: 'Y', clndr_name: 'Std', clndr_data: CAL }]),
      PROJWBS: tbl('PROJWBS', [{ wbs_id: '10', proj_id: '1', parent_wbs_id: '', proj_node_flag: 'Y' }]),
      TASK: tbl('TASK', tasks.map(({ code, d = 1, ...rest }) => ({
        task_id: id(code), proj_id: '1', wbs_id: '10', clndr_id: '1', task_code: code, task_type: 'TT_Task', status_code: 'TK_NotStart',
        target_drtn_hr_cnt: String(d * 8), remain_drtn_hr_cnt: String(d * 8), act_start_date: '', act_end_date: '', cstr_type: '', cstr_date: '', ...rest,
      } as Row))),
      TASKPRED: tbl('TASKPRED', links.map(([p, s, ty = 'PR_FS', lag = 0], i) => ({ task_pred_id: String(i + 1), task_id: id(s), pred_task_id: id(p), proj_id: '1', pred_proj_id: '1', pred_type: ty, lag_hr_cnt: String(lag * 8) }))),
    },
  };
}
const run = (db: Db, o = {}) => { const r = scheduleProjects(db, ['1'], o); return { r, t: (c: string) => db.tables.TASK.rows.find((x) => x.task_code === c)! }; };

test('FS chain with float', () => {
  const { r, t } = run(build([{ code: 'A', d: 2 }, { code: 'B', d: 3 }, { code: 'C', d: 1 }, { code: 'D', d: 1 }], [['A', 'B'], ['A', 'C'], ['B', 'D'], ['C', 'D']]));
  assert.ok(r.ok);
  assert.equal(t('A').early_start_date, '2024-01-08 08:00');
  assert.equal(t('A').early_end_date, '2024-01-09 16:00');
  assert.equal(t('B').early_start_date, '2024-01-10 08:00');
  assert.equal(t('D').early_end_date, '2024-01-15 16:00'); // skips weekend
  assert.equal(t('C').total_float_hr_cnt, '16');
  assert.equal(t('C').free_float_hr_cnt, '16');
  assert.equal(t('B').total_float_hr_cnt, '0');
  assert.equal(t('B').driving_path_flag, 'Y');
  assert.equal(t('C').driving_path_flag, 'N');
  assert.equal(t('A').target_start_date, '2024-01-08 08:00', 'planned dates follow early dates for not-started');
  assert.equal(r.stats.finish != null, true);
});

test('SS, FF, SF and lags (incl. negative)', () => {
  const { t } = run(build([{ code: 'A', d: 5 }, { code: 'SS', d: 2 }, { code: 'FF', d: 2 }, { code: 'SF', d: 1 }, { code: 'NEG', d: 1 }],
    [['A', 'SS', 'PR_SS', 2], ['A', 'FF', 'PR_FF', 1], ['A', 'SF', 'PR_SF', 3], ['A', 'NEG', 'PR_FS', -2]]));
  assert.equal(t('SS').early_start_date, '2024-01-10 08:00');
  assert.equal(t('FF').early_end_date, '2024-01-15 16:00');
  assert.equal(t('SF').early_end_date, '2024-01-10 16:00');
  assert.equal(t('NEG').early_start_date, '2024-01-11 08:00');
});

test('milestones placement', () => {
  const { t } = run(build([{ code: 'A', d: 1 }, { code: 'SM', task_type: 'TT_Mile', d: 0 }, { code: 'FM', task_type: 'TT_FinMile', d: 0 }], [['A', 'SM'], ['A', 'FM']]));
  assert.equal(t('SM').early_start_date, '2024-01-09 08:00');
  assert.equal(t('FM').early_end_date, '2024-01-08 16:00');
});

test('constraints', () => {
  const { t, r } = run(build([
    { code: 'SNET', cstr_type: 'CS_MSOA', cstr_date: '2024-01-10 00:00' },
    { code: 'FNET', cstr_type: 'CS_MEOA', cstr_date: '2024-01-12 16:00', d: 2 },
    { code: 'MAND', cstr_type: 'CS_MANDSTART', cstr_date: '2024-01-09 08:00' },
    { code: 'P', d: 3 },
    { code: 'FNLT', cstr_type: 'CS_MEOB', cstr_date: '2024-01-09 16:00' },
  ], [['P', 'MAND'], ['P', 'FNLT']]));
  assert.equal(t('SNET').early_start_date, '2024-01-10 08:00');
  assert.equal(t('FNET').early_end_date, '2024-01-12 16:00');
  assert.equal(t('MAND').early_start_date, '2024-01-09 08:00', 'mandatory start ignores logic');
  assert.ok(Number(t('FNLT').total_float_hr_cnt) < 0, 'finish-on-or-before violated gives negative float');
  assert.ok(r.findings.some((f) => f.code === 'CONSTRAINT_VIOLATED'));
});

test('must finish by gives negative float', () => {
  const { t } = run(build([{ code: 'A', d: 10 }], [], { plan_end_date: '2024-01-12 16:00' }));
  assert.equal(t('A').total_float_hr_cnt, '-40');
});

test('progress: retained logic vs progress override', () => {
  const tasks: T[] = [
    { code: 'P', d: 4, act_start_date: '2024-01-08 08:00', status_code: 'TK_Active', remain_drtn_hr_cnt: '16' },
    { code: 'S', d: 4, act_start_date: '2024-01-09 08:00', status_code: 'TK_Active', remain_drtn_hr_cnt: '16' },
  ];
  const dd = { last_recalc_date: '2024-01-10 00:00' };
  const ret = run(build(tasks, [['P', 'S']], dd));
  assert.equal(ret.t('P').early_start_date, '2024-01-10 08:00', 'remaining starts at data date');
  assert.equal(ret.t('P').early_end_date, '2024-01-11 16:00');
  assert.equal(ret.t('S').early_start_date, '2024-01-12 08:00', 'retained logic waits for predecessor');
  assert.ok(ret.r.findings.some((f) => f.code === 'OUT_OF_SEQUENCE'));
  const ovr = run(build(tasks, [['P', 'S']], dd), { logic: 'override' });
  assert.equal(ovr.t('S').early_start_date, '2024-01-10 08:00', 'progress override ignores logic');
});

test('completed activities: early dates at data date, no float, lag counts from actual finish', () => {
  const { t } = run(build([
    { code: 'C', act_start_date: '2024-01-02 08:00', act_end_date: '2024-01-05 16:00', status_code: 'TK_Complete' },
    { code: 'N', d: 1 },
  ], [['C', 'N', 'PR_FS', 5]], { last_recalc_date: '2024-01-08 00:00', plan_start_date: '2024-01-01 00:00' }));
  assert.equal(t('C').early_start_date, '2024-01-08 00:00');
  assert.equal(t('C').total_float_hr_cnt, '');
  assert.equal(t('C').restart_date, '');
  assert.equal(t('N').early_start_date, '2024-01-15 08:00'); // Fri 16:00 + 5d lag
});

test('loop aborts without touching data', () => {
  const db = build([{ code: 'A' }, { code: 'B' }], [['A', 'B'], ['B', 'A']]);
  const before = JSON.stringify(db);
  const { r } = run(db);
  assert.equal(r.ok, false);
  assert.ok(r.findings.some((f) => f.code === 'SCHED_LOOP' && /A/.test(f.message)));
  assert.equal(JSON.stringify(db), before);
});

test('level of effort spans its links', () => {
  const { t } = run(build([{ code: 'A', d: 2 }, { code: 'B', d: 3 }, { code: 'LOE', task_type: 'TT_LOE', d: 1 }], [['A', 'B'], ['A', 'LOE', 'PR_SS'], ['LOE', 'B', 'PR_FF']]));
  assert.equal(t('LOE').early_start_date, t('A').early_start_date);
  assert.equal(t('LOE').early_end_date, t('B').early_end_date);
  assert.equal(t('LOE').remain_drtn_hr_cnt, '40');
});

test('planned start later than data date floors not-started work', () => {
  const { t } = run(build([{ code: 'A' }], [], { last_recalc_date: '2024-01-01 00:00', plan_start_date: '2024-01-10 00:00' }));
  assert.equal(t('A').early_start_date, '2024-01-10 08:00');
});

test('external predecessor uses external early start', () => {
  const db = build([{ code: 'A', external_early_start_date: '2024-01-15 08:00' }]);
  db.tables.TASKPRED.rows.push({ task_pred_id: '9', task_id: '100', pred_task_id: '999', proj_id: '1', pred_proj_id: '2', pred_type: 'PR_FS', lag_hr_cnt: '0' });
  const { t } = run(db);
  assert.equal(t('A').early_start_date, '2024-01-15 08:00');
  const db2 = build([{ code: 'A', external_early_start_date: '2024-01-15 08:00' }]);
  db2.tables.TASKPRED.rows.push({ task_pred_id: '9', task_id: '100', pred_task_id: '999', proj_id: '1', pred_proj_id: '2', pred_type: 'PR_FS', lag_hr_cnt: '0' });
  assert.equal(run(db2, { ignoreExternal: true }).t('A').early_start_date, '2024-01-08 08:00');
});
