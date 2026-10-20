// Schedule analysis tools of the MCP server (kept apart from server.ts so the two grow without stepping on each other):
// P6 Check Schedule and DCMA 14-point; later lint, float paths, curves, what-ifs, crashing and delay analysis.
import type { Db } from '../core/db.ts';
import { checkSchedule, P6_CHECKS } from '../core/analysis/checkSchedule.ts';
import { dcma14, DCMA_PROFILES } from '../core/analysis/dcma.ts';
import { analysisReportHtml } from '../core/analysis/report.ts';
import { lintSchedule, LINT_CHECKS } from '../core/analysis/lint.ts';
import { nowStamp } from '../core/report/reports.ts';
import { fail, pathArg, type Session } from './runtime.ts';

/** What the server lends these tools. */
export interface AnalysisHelpers {
  projectIds: (db: Db, id: unknown) => string[];
  allIds: (db: Db) => string[];
  dd: (v: unknown) => number | null;
  writeOut: (path: string, data: string | Uint8Array) => void;
}

// read the project; write a file only when path is given
const writesFile = { readOnlyHint: false, destructiveHint: false, openWorldHint: false };
const project = { type: 'string', description: 'Project ID (default: every project in the file)' };
const maxIds = { type: 'number', description: 'activities listed per check (default 100; 0 = all)' };
const reportPath = { type: 'string', description: 'also write the report as HTML to this path' };

export const ANALYSIS_TOOLS = (withHandle: (s: Record<string, unknown>) => Record<string, unknown>) => [
  { name: 'check_schedule', annotations: writesFile, description: `P6's Tools > Check Schedule Report: ${P6_CHECKS.length} checks with P6's own populations and default targets (${P6_CHECKS.map((c) => c.id).join(', ')}). Each check answers metric, threshold {op, value, source}, result pass|fail|not_assessed, numerator/denominator and the activities (or relationships) it found. Thresholds in hours use the hours per day (44 days x 8 h = 352 h). Late activities and BEI need the project baseline. targets overrides a check's target (percent; ratio for bei).`, inputSchema: withHandle({ type: 'object', properties: { project, checks: { type: 'array', items: { type: 'string' } }, targets: { type: 'object' }, threshold_days: { type: 'number', description: 'long lag / large float / large duration limit in days (default 44)' }, max_ids: maxIds, path: reportPath } }) },
  { name: 'dcma_14', annotations: writesFile, description: `DCMA 14-Point Assessment (PAM 200.1): logic, leads, lags, relationship types, hard constraints, high float, negative float, high duration, invalid dates, resources, missed tasks, critical path test, CPLI, BEI. Tasks = incomplete activities that are not WBS summary, LOE or milestones; leads, lags and types count relationships; days are working days of each activity's calendar. Each check answers metric, threshold {op, value, source}, result, numerator/denominator and the activities it found. profile: ${Object.entries(DCMA_PROFILES).map(([k, v]) => `${k} (${v.label})`).join(', ')}; thresholds overrides single checks. baseline: project (default), bl1, bl2, bl3 (missed tasks, BEI, high duration). The critical path test adds cpt_slip_days (600) to the earliest critical task (or cpt_activity) on a scratch copy and passes when the finish moves by exactly that. CPLI: against target_finish, else the project's Must Finish By (contract), else the baseline finish; the other is reported beside it; with neither it is not assessed. limit_days: 44 or "dynamic" (max(20, 10% of the project length)).`, inputSchema: withHandle({ type: 'object', properties: { project, profile: { type: 'string' }, thresholds: { type: 'object' }, baseline: { type: 'string' }, status_date: { type: 'string' }, target_finish: { type: 'string' }, cpt_slip_days: { type: 'number' }, cpt_activity: { type: 'string' }, limit_days: {}, exempt: { type: 'array', items: { type: 'string' } }, max_ids: maxIds, path: reportPath } }) },
  { name: 'lint', annotations: writesFile, description: `Schedule lint: problems P6 schedules without complaint, each with the activities it hits and, where there is one, the fix as edit operations (pass them to edit). Checks: dangling_start (no FS/SS predecessor drives the start), dangling_finish (the finish drives no FS/FF successor), fs_overlap (leads that should be SS + lag, SS lags as long as the predecessor that are really FS, and "ladders" of look-alike activities chained FS that could overlap; ladder fixes carry saves_days, found by scheduling the fix on a scratch copy), empty_wbs, milestone_duration (milestones with a duration, zero-duration tasks), constraints (every type), loe_on_critical, lag_calendar. profile: platform adds White Hat IQ's graded network metrics with score and grade: ${['connectivity', 'start_anchored', 'serialization', 'criticality', 'single_file', 'longest_chain', 'non_fs_share', 'edges_per_activity', 'redundant_links', 'ss_abuse'].join(', ')}. Each check: band pass|warn|fail, severity, activities, fixes. simulate: false skips the days-saved runs.`, inputSchema: withHandle({ type: 'object', properties: { project, profile: { type: 'string', description: 'p6 (default) or platform' }, checks: { type: 'array', items: { type: 'string' } }, simulate: { type: 'boolean' }, max_ids: maxIds, path: reportPath } }) },
];

export const ANALYSIS_NAMES = new Set(['check_schedule', 'dcma_14', 'lint']);

/** Run an analysis tool; undefined when the name is not one of them. */
export async function runAnalysis(name: string, a: Record<string, any>, s: Session, h: AnalysisHelpers): Promise<unknown> {
  if (!ANALYSIS_NAMES.has(name)) return undefined;
  const projIds = a.project != null && a.project !== '' ? h.projectIds(s.db, a.project) : h.allIds(s.db);
  const maxIds = a.max_ids != null ? Math.max(0, Math.floor(Number(a.max_ids))) : undefined;
  const withReport = <T extends { report: string; checks: unknown[]; summary: Record<string, number> }>(r: T) => {
    if (!a.path) return r;
    const path = pathArg(a.path, 'path', 'write');
    h.writeOut(path, analysisReportHtml(r as never, nowStamp()));
    return { ...r, saved: path };
  };
  switch (name) {
    case 'check_schedule': {
      const unknown = (a.checks ?? []).filter((c: string) => !P6_CHECKS.some((x) => x.id === c));
      if (unknown.length) fail('bad_input', `Unknown check(s): ${unknown.join(', ')}.`, `Checks: ${P6_CHECKS.map((c) => c.id).join(', ')}.`);
      return withReport(checkSchedule(s.db, { projIds, hoursPerDay: s.hpd, checks: a.checks, targets: a.targets, thresholdHours: a.threshold_days != null ? Number(a.threshold_days) * s.hpd : undefined, maxIds }));
    }
    case 'dcma_14': {
      if (a.profile != null && !DCMA_PROFILES[a.profile]) fail('bad_input', `Unknown profile "${a.profile}".`, `Profiles: ${Object.keys(DCMA_PROFILES).join(', ')}.`);
      if (a.baseline != null && !['project', 'bl1', 'bl2', 'bl3'].includes(a.baseline)) fail('bad_input', `Unknown baseline "${a.baseline}".`, 'Use project, bl1, bl2 or bl3.');
      const limit = a.limit_days === 'dynamic' ? 'dynamic' : a.limit_days != null ? Number(a.limit_days) : undefined;
      return withReport(dcma14(s.db, { projIds, hoursPerDay: s.hpd, profile: a.profile, thresholds: a.thresholds, baseline: a.baseline, statusDate: h.dd(a.status_date), targetFinish: h.dd(a.target_finish), cptSlipDays: a.cpt_slip_days != null ? Number(a.cpt_slip_days) : undefined, cptActivity: a.cpt_activity, limitDays: limit, exempt: a.exempt, maxIds }));
    }
    case 'lint': {
      if (a.profile != null && a.profile !== 'p6' && a.profile !== 'platform') fail('bad_input', `Unknown profile "${a.profile}".`, 'Use p6 or platform.');
      const unknown = (a.checks ?? []).filter((c: string) => !(LINT_CHECKS as readonly string[]).includes(c));
      if (unknown.length) fail('bad_input', `Unknown check(s): ${unknown.join(', ')}.`, `Checks: ${LINT_CHECKS.join(', ')}.`);
      return withReport(lintSchedule(s.db, { projIds, hoursPerDay: s.hpd, profile: a.profile, checks: a.checks, simulate: a.simulate !== false, maxIds }) as never);
    }
  }
  return undefined;
}
