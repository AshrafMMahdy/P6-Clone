// P6 project risk register, stored in P6's own XER tables:
//   RISKTYPE  (risk categories, hierarchical)
//   PROJRISK  (one row per project risk)
//   TASKRISK  (risk <-> activity links)
// They are plain tables of the Db, so the XER writer exports them like any other table
// (RISKTYPE in P6's table order, PROJRISK/TASKRISK alphabetically after the known tables).
//
// Qualitative scale (5 x 5 probability / impact matrix):
//   level  code  probability (midpoint used by Monte Carlo)   schedule impact          score
//   1      VL    Very Low   < 10 %   (5 %)                    <= 1 week   (<= 40 h)    1
//   2      L     Low        10-30 %  (20 %)                   <= 2 weeks  (<= 80 h)    2
//   3      M     Medium     30-50 %  (40 %)                   <= 1 month  (<= 160 h)   3
//   4      H     High       50-70 %  (60 %)                   <= 3 months (<= 480 h)   4
//   5      VH    Very High  > 70 %   (85 %)                   > 3 months               5
// Risk score = probability level x impact level (1..25); impact level = the worse of schedule and cost impact.
// Bands: Low 1-4 (green), Medium 5-11 (amber), High 12-25 (red).
import { addField, rows, table, type Db, type Row } from '../db.ts';
import { formatP6Date } from '../dates.ts';

export type Level = 'VL' | 'L' | 'M' | 'H' | 'VH';
export type RiskPhase = 'pre' | 'post';
export type RiskStatus = 'RS_Proposed' | 'RS_Open' | 'RS_Rejected' | 'RS_Managed' | 'RS_Impacted';
export type ResponseType = 'Avoid' | 'Transfer' | 'Reduce' | 'Accept' | 'Enhance' | 'Exploit';
export type Band = 'low' | 'medium' | 'high';

export const LEVELS: Level[] = ['VL', 'L', 'M', 'H', 'VH'];
export const LEVEL_LABEL: Record<Level, string> = { VL: 'Very Low', L: 'Low', M: 'Medium', H: 'High', VH: 'Very High' };
/** Probability used by the Monte Carlo when no explicit percentage is given (midpoint of the band). */
export const PROB_PCT: Record<Level, number> = { VL: 5, L: 20, M: 40, H: 60, VH: 85 };
export const PROB_RANGE: Record<Level, string> = { VL: '< 10%', L: '10% - 30%', M: '30% - 50%', H: '50% - 70%', VH: '> 70%' };
/** Upper limit (hours) of each schedule impact level; VH is anything above H. */
export const SCHED_IMPACT_MAX_HR: Record<Level, number> = { VL: 40, L: 80, M: 160, H: 480, VH: Infinity };
export const SCHED_IMPACT_RANGE: Record<Level, string> = { VL: '<= 1 week', L: '1 - 2 weeks', M: '2 weeks - 1 month', H: '1 - 3 months', VH: '> 3 months' };

export const RISK_STATUS: Record<RiskStatus, string> = { RS_Proposed: 'Proposed', RS_Open: 'Open', RS_Rejected: 'Rejected', RS_Managed: 'Managed', RS_Impacted: 'Impacted' };
export const RESPONSE_TYPES: ResponseType[] = ['Avoid', 'Transfer', 'Reduce', 'Accept', 'Enhance', 'Exploit'];
export const BAND_COLOR: Record<Band, string> = { low: '#7ccf7c', medium: '#ffd966', high: '#ff6b6b' };
export const BAND_LABEL: Record<Band, string> = { low: 'Low', medium: 'Medium', high: 'High' };

export const RISKTYPE_FIELDS = ['risk_type_id', 'parent_risk_type_id', 'risk_type', 'risk_seq_num'];
export const PROJRISK_FIELDS = [
  'proj_risk_id', 'proj_id', 'risk_type_id', 'risk_code', 'risk_name', 'risk_descr', 'status_code', 'obs_id', 'rsrc_id',
  'pre_prob', 'pre_prob_pct', 'pre_sched_impact', 'pre_sched_impact_hr_cnt', 'pre_cost_impact', 'pre_cost_impact_amt',
  'post_prob', 'post_prob_pct', 'post_sched_impact', 'post_sched_impact_hr_cnt', 'post_cost_impact', 'post_cost_impact_amt',
  'cause', 'effect', 'response_type', 'response_descr', 'identified_date',
];
export const TASKRISK_FIELDS = ['task_risk_id', 'proj_risk_id', 'task_id', 'proj_id'];

const DEFAULT_TYPES = ['Technical', 'Design', 'Procurement', 'Construction', 'Commercial', 'External', 'Weather', 'Organizational', 'Health & Safety'];

const isLevel = (s: string | undefined): s is Level => !!s && (LEVELS as string[]).includes(s);
const num = (s: string | undefined) => { const n = Number(s); return s !== '' && s != null && Number.isFinite(n) ? n : null; };

function nextNum(db: Db, tbl: string, key: string): string {
  let max = 0;
  for (const r of rows(db, tbl)) { const n = Number(r[key]); if (n > max) max = n; }
  return String(max + 1);
}

/** Create the three risk tables with their full field lists (idempotent). */
export function ensureRiskTables(db: Db): void {
  for (const [t, fs] of [['RISKTYPE', RISKTYPE_FIELDS], ['PROJRISK', PROJRISK_FIELDS], ['TASKRISK', TASKRISK_FIELDS]] as const) {
    const tb = table(db, t);
    for (const f of fs) addField(tb, f);
  }
}

/** Risk categories; seeds a default set when the dictionary is empty. */
export function ensureRiskTypes(db: Db): Row[] {
  ensureRiskTables(db);
  const t = table(db, 'RISKTYPE');
  if (!t.rows.length) DEFAULT_TYPES.forEach((name, i) => t.rows.push({ risk_type_id: String(i + 1), parent_risk_type_id: '', risk_type: name, risk_seq_num: String((i + 1) * 10) }));
  return t.rows;
}

export function addRiskType(db: Db, name: string, parentId = ''): Row {
  ensureRiskTables(db);
  const t = table(db, 'RISKTYPE');
  const r: Row = { risk_type_id: nextNum(db, 'RISKTYPE', 'risk_type_id'), parent_risk_type_id: parentId, risk_type: name, risk_seq_num: String((t.rows.length + 1) * 10) };
  t.rows.push(r);
  return r;
}

export function nextRiskCode(db: Db, projId: string): string {
  let max = 0;
  for (const r of rows(db, 'PROJRISK')) {
    if (r.proj_id !== projId) continue;
    const m = /(\d+)\s*$/.exec(r.risk_code ?? '');
    if (m) max = Math.max(max, Number(m[1]));
  }
  return `RSK-${String(max + 1).padStart(4, '0')}`;
}

/** Add a risk to a project. `init` overrides any default field. */
export function addRisk(db: Db, projId: string, init: Partial<Row> = {}): Row {
  ensureRiskTypes(db);
  const r: Row = Object.fromEntries(PROJRISK_FIELDS.map((f) => [f, '']));
  Object.assign(r, {
    proj_risk_id: nextNum(db, 'PROJRISK', 'proj_risk_id'), proj_id: projId, risk_code: nextRiskCode(db, projId), risk_name: 'New Risk',
    status_code: 'RS_Proposed', pre_prob: 'M', pre_sched_impact: 'M', pre_cost_impact: 'VL', response_type: 'Reduce',
    identified_date: formatP6Date(Math.floor(Date.now() / 60000 / 1440) * 1440),
  }, init);
  table(db, 'PROJRISK').rows.push(r);
  return r;
}

export function getRisk(db: Db, riskId: string): Row | undefined {
  return rows(db, 'PROJRISK').find((r) => r.proj_risk_id === riskId);
}

/** Change fields of a risk; unknown fields are added to the table. Returns false when the risk is missing. */
export function updateRisk(db: Db, riskId: string, patch: Partial<Row>): boolean {
  const t = table(db, 'PROJRISK');
  const r = t.rows.find((x) => x.proj_risk_id === riskId);
  if (!r) return false;
  for (const [k, v] of Object.entries(patch)) { if (v == null) continue; addField(t, k); r[k] = v; }
  return true;
}

/** Delete risks and their activity links. */
export function deleteRisks(db: Db, riskIds: string[]): void {
  const ids = new Set(riskIds);
  if (db.tables.PROJRISK) db.tables.PROJRISK.rows = db.tables.PROJRISK.rows.filter((r) => !ids.has(r.proj_risk_id));
  if (db.tables.TASKRISK) db.tables.TASKRISK.rows = db.tables.TASKRISK.rows.filter((r) => !ids.has(r.proj_risk_id));
}
export const deleteRisk = (db: Db, riskId: string) => deleteRisks(db, [riskId]);

/** Link an activity to a risk. Returns an error message or the TASKRISK row. */
export function linkActivity(db: Db, riskId: string, taskId: string): Row | string {
  const risk = getRisk(db, riskId);
  if (!risk) return 'Risk not found.';
  const task = rows(db, 'TASK').find((t) => t.task_id === taskId);
  if (!task) return 'Activity not found.';
  const existing = rows(db, 'TASKRISK').find((l) => l.proj_risk_id === riskId && l.task_id === taskId);
  if (existing) return existing;
  ensureRiskTables(db);
  const l: Row = { task_risk_id: nextNum(db, 'TASKRISK', 'task_risk_id'), proj_risk_id: riskId, task_id: taskId, proj_id: task.proj_id };
  table(db, 'TASKRISK').rows.push(l);
  return l;
}

export function unlinkActivity(db: Db, riskId: string, taskId: string): void {
  if (db.tables.TASKRISK) db.tables.TASKRISK.rows = db.tables.TASKRISK.rows.filter((l) => !(l.proj_risk_id === riskId && l.task_id === taskId));
}

/** Activity ids linked to a risk (only activities that still exist). */
export function linkedTasks(db: Db, riskId: string): string[] {
  const ids = new Set(rows(db, 'TASK').map((t) => t.task_id));
  return rows(db, 'TASKRISK').filter((l) => l.proj_risk_id === riskId && ids.has(l.task_id)).map((l) => l.task_id);
}

/** Remove links to activities that no longer exist. Returns the number removed. */
export function pruneRiskLinks(db: Db): number {
  const t = db.tables.TASKRISK;
  if (!t) return 0;
  const ids = new Set(rows(db, 'TASK').map((x) => x.task_id));
  const risks = new Set(rows(db, 'PROJRISK').map((x) => x.proj_risk_id));
  const before = t.rows.length;
  t.rows = t.rows.filter((l) => ids.has(l.task_id) && risks.has(l.proj_risk_id));
  return before - t.rows.length;
}

export function risksOf(db: Db, projIds: string[]): Row[] {
  const s = new Set(projIds);
  return rows(db, 'PROJRISK').filter((r) => s.has(r.proj_id));
}

// ---------------------------------------------------------------- scoring

/** 1..5 for a level code, 0 when blank/unknown. */
export function levelScore(code: string | undefined): number {
  return isLevel(code) ? LEVELS.indexOf(code) + 1 : 0;
}

/** Schedule impact level from hours of delay. */
export function schedLevelFromHours(hours: number): Level {
  for (const l of LEVELS) if (hours <= SCHED_IMPACT_MAX_HR[l]) return l;
  return 'VH';
}

export function scoreBand(score: number): Band {
  return score >= 12 ? 'high' : score >= 5 ? 'medium' : 'low';
}

/** Post-response value of a field, falling back to the pre-response value when blank. */
function phaseVal(r: Row, phase: RiskPhase, field: string): string {
  if (phase === 'post') { const v = r[`post_${field}`]; if (v !== '' && v != null) return v; }
  return r[`pre_${field}`] ?? '';
}

export interface RiskScore { prob: number; sched: number; cost: number; impact: number; score: number; band: Band }

export function riskScore(r: Row, phase: RiskPhase = 'pre'): RiskScore {
  const prob = levelScore(phaseVal(r, phase, 'prob'));
  let sched = levelScore(phaseVal(r, phase, 'sched_impact'));
  if (!sched) { const h = num(phaseVal(r, phase, 'sched_impact_hr_cnt')); if (h != null && h > 0) sched = levelScore(schedLevelFromHours(h)); }
  const cost = levelScore(phaseVal(r, phase, 'cost_impact'));
  const impact = Math.max(sched, cost);
  const score = prob * impact;
  return { prob, sched, cost, impact, score, band: scoreBand(score) };
}

/** Probability (0..1) of the risk occurring: explicit percentage, else the midpoint of its level. */
export function riskProbability(r: Row, phase: RiskPhase = 'pre'): number {
  const pct = num(phaseVal(r, phase, 'prob_pct'));
  if (pct != null) return Math.max(0, Math.min(100, pct)) / 100;
  const l = phaseVal(r, phase, 'prob');
  return isLevel(l) ? PROB_PCT[l] / 100 : 0;
}

/** Schedule impact in hours applied to each linked activity when the risk occurs. */
export function riskScheduleHours(r: Row, phase: RiskPhase = 'pre'): number {
  const h = num(phaseVal(r, phase, 'sched_impact_hr_cnt'));
  return h != null && h > 0 ? h : 0;
}

export interface HeatCell { prob: number; impact: number; score: number; band: Band; risks: string[] }

/** 5 x 5 matrix, `cells[prob - 1][impact - 1]`. Risks without a probability or impact rating are in `unrated`. */
export function heatMap(db: Db, projIds: string[], phase: RiskPhase = 'pre', opts: { includeRejected?: boolean } = {}): { cells: HeatCell[][]; unrated: string[] } {
  const cells: HeatCell[][] = [];
  for (let p = 1; p <= 5; p++) {
    const line: HeatCell[] = [];
    for (let i = 1; i <= 5; i++) line.push({ prob: p, impact: i, score: p * i, band: scoreBand(p * i), risks: [] });
    cells.push(line);
  }
  const unrated: string[] = [];
  for (const r of risksOf(db, projIds)) {
    if (!opts.includeRejected && r.status_code === 'RS_Rejected') continue;
    const s = riskScore(r, phase);
    if (!s.prob || !s.impact) { unrated.push(r.proj_risk_id); continue; }
    cells[s.prob - 1][s.impact - 1].risks.push(r.proj_risk_id);
  }
  return { cells, unrated };
}
