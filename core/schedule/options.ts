// P6's Schedule Options (Tools > Schedule > Options) by name: set_schedule_options writes them to the project
// (SCHEDOPTIONS, and PROJECT for the critical rule); the MCP schedule tool takes the same names for one run.
import { addField, nextId, table, type Db, type Row } from '../db.ts';
import { p6num, type FloatType, type LagCalendar, type LogicMode, type SchedOptions } from './cpm.ts';

const LOGIC: Record<string, LogicMode> = { retained: 'retained', retained_logic: 'retained', override: 'override', progress_override: 'override', actual: 'actual', actual_dates: 'actual' };
const LAG: Record<string, LagCalendar> = { predecessor: 'predecessor', successor: 'successor', '24h': '24h', '24_hour': '24h', project: 'project', project_default: 'project' };
const FLOAT: Record<string, FloatType> = { start: 'start', start_float: 'start', finish: 'finish', finish_float: 'finish', smallest: 'smallest', most_critical: 'smallest' };
const CRIT: Record<string, SchedOptions['criticalBy']> = { total_float: 'float', float: 'float', longest_path: 'longestPath' };
const BOOLS = { open_ended_critical: 'openEndedCritical', use_expected_finish: 'useExpectedFinish', ignore_external: 'ignoreExternal', ss_lag_from_actual_start: 'ssLagFromActualStart' } as const;
export const SCHEDULE_OPTION_NAMES = ['logic', 'lag_calendar', 'float_type', 'critical', 'critical_float_hours', 'critical_float_days', 'float_paths', 'float_path_method', 'float_paths_count', 'float_path_end', ...Object.keys(BOOLS)];

export const SCHEDULE_OPTIONS_GUIDE = `logic (retained, override, actual), lag_calendar (predecessor, successor, 24h, project), float_type (start, finish, smallest), critical (total_float, longest_path), critical_float_hours or critical_float_days (critical when total float <= this), open_ended_critical, use_expected_finish, ignore_external (relationships to other projects), ss_lag_from_actual_start (true/false), float_paths (true/false: Advanced > Calculate multiple float paths; F9 then fills Float Path and Float Path Order) with float_path_method (free_float, the default, or total_float), float_paths_count (default 10) and float_path_end (Activity ID the paths end with; default the open end with the latest finish)`;

/** The options given (snake_case names), as the scheduler's; an unknown name or value is refused. */
export function parseScheduleOptions(o: Record<string, unknown>, fail: (m: string) => never, hpd = 8): Partial<SchedOptions> {
  const out: Partial<SchedOptions> = {};
  const one = <T>(k: string, map: Record<string, T>): T | undefined => {
    if (o[k] == null) return undefined;
    return map[String(o[k]).toLowerCase()] ?? fail(`${k} must be one of ${[...new Set(Object.keys(map))].join(', ')}.`);
  };
  for (const k of Object.keys(o)) if (!SCHEDULE_OPTION_NAMES.includes(k) && k !== 'op' && k !== 'project') fail(`Unknown schedule option "${k}". Options: ${SCHEDULE_OPTION_NAMES.join(', ')}.`);
  const logic = one('logic', LOGIC), lag = one('lag_calendar', LAG), fl = one('float_type', FLOAT), crit = one('critical', CRIT);
  if (logic) out.logic = logic;
  if (lag) out.lagCalendar = lag;
  if (fl) out.floatType = fl;
  if (crit) out.criticalBy = crit;
  const num = (k: string) => { const v = Number(o[k]); return Number.isFinite(v) ? v : fail(`${k} must be a number.`); };
  if (o.critical_float_hours != null) out.criticalFloatHrs = num('critical_float_hours');
  else if (o.critical_float_days != null) out.criticalFloatHrs = num('critical_float_days') * hpd;
  for (const [k, f] of Object.entries(BOOLS)) if (o[k] != null) { if (typeof o[k] !== 'boolean') fail(`${k} must be true or false.`); out[f] = o[k] as boolean; }
  // Advanced: multiple float paths
  if (o.float_paths != null || o.float_path_method != null || o.float_paths_count != null || o.float_path_end != null) {
    if (o.float_paths != null && typeof o.float_paths !== 'boolean') fail('float_paths must be true or false.');
    const m = o.float_path_method == null ? 'free_float' : String(o.float_path_method).toLowerCase();
    if (m !== 'free_float' && m !== 'total_float') fail('float_path_method must be free_float or total_float.');
    out.floatPaths = { enabled: o.float_paths !== false, method: m as 'free_float' | 'total_float', count: o.float_paths_count != null ? Math.max(1, Math.floor(num('float_paths_count'))) : 10, ...(o.float_path_end ? { endActivity: String(o.float_path_end) } : {}) };
  }
  return out;
}

/** Write options onto a project: SCHEDOPTIONS (made when the project has none) and PROJECT's critical rule. */
export function writeScheduleOptions(db: Db, p: Row, s: Partial<SchedOptions>): string[] {
  const S = table(db, 'SCHEDOPTIONS');
  let so = S.rows.find((r) => r.proj_id === p.proj_id);
  if (!so) {
    for (const f of ['schedoptions_id', 'proj_id']) addField(S, f);
    so = { schedoptions_id: String(nextId(db, 'SCHEDOPTIONS')), proj_id: p.proj_id };
    S.rows.push(so);
    so = S.rows[S.rows.length - 1];
  }
  const set = (f: string, v: string) => { addField(S, f); so![f] = v; };
  const yn = (b: boolean) => (b ? 'Y' : 'N');
  const done: string[] = [];
  if (s.logic) { set('sched_retained_logic', yn(s.logic === 'retained')); set('sched_progress_override', yn(s.logic === 'override')); done.push(`logic ${s.logic}`); }
  if (s.lagCalendar) { set('sched_calendar_on_relationship_lag', ({ predecessor: 'rcal_Predecessor', successor: 'rcal_Successor', '24h': 'rcal_24Hour', project: 'rcal_ProjDefault' } as const)[s.lagCalendar]); done.push(`lag_calendar ${s.lagCalendar}`); }
  if (s.floatType) { set('sched_float_type', ({ start: 'FT_SS', finish: 'FT_FF', smallest: 'FT_Min' } as const)[s.floatType]); done.push(`float_type ${s.floatType}`); }
  if (s.openEndedCritical != null) { set('sched_open_critical_flag', yn(s.openEndedCritical)); done.push(`open_ended_critical ${s.openEndedCritical}`); }
  if (s.useExpectedFinish != null) { set('sched_use_expect_end_flag', yn(s.useExpectedFinish)); done.push(`use_expected_finish ${s.useExpectedFinish}`); }
  if (s.ignoreExternal != null) { set('sched_outer_depend_type', s.ignoreExternal ? 'SD_None' : 'SD_Both'); done.push(`ignore_external ${s.ignoreExternal}`); }
  if (s.ssLagFromActualStart != null) { set('sched_lag_early_start_flag', yn(!s.ssLagFromActualStart)); done.push(`ss_lag_from_actual_start ${s.ssLagFromActualStart}`); }
  if (s.floatPaths) {
    set('enable_multiple_longest_path_calc', yn(s.floatPaths.enabled)); set('use_total_float_multiple_longest_paths', yn(s.floatPaths.method === 'total_float')); set('max_multiple_longest_path', String(s.floatPaths.count));
    const end = s.floatPaths.endActivity ? (db.tables.TASK?.rows ?? []).find((t) => t.proj_id === p.proj_id && t.task_code === s.floatPaths!.endActivity) : undefined;
    set('key_activity_for_multiple_longest_paths', end?.task_id ?? '');
    done.push(`float_paths ${s.floatPaths.enabled ? `${s.floatPaths.method}, ${s.floatPaths.count} paths${end ? `, ending with ${end.task_code}` : ''}` : 'off'}`);
  }
  const P = table(db, 'PROJECT');
  if (s.criticalBy) { addField(P, 'critical_path_type'); p.critical_path_type = s.criticalBy === 'longestPath' ? 'CT_DrivPath' : 'CT_TotFloat'; done.push(`critical ${s.criticalBy === 'longestPath' ? 'longest_path' : 'total_float'}`); }
  if (s.criticalFloatHrs != null) { addField(P, 'critical_drtn_hr_cnt'); p.critical_drtn_hr_cnt = p6num(s.criticalFloatHrs); done.push(`critical_float_hours ${s.criticalFloatHrs}`); }
  return done;
}
