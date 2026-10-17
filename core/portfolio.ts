// Project portfolios. P6 keeps portfolios in its database (not in XER files); the clone stores them in the
// internal table _PORTFOLIO (never exported). A portfolio is either a fixed list of projects or a filter rule.
import { addField, rows, table, type Db, type Row } from './db.ts';
import { parseP6Date } from './dates.ts';
import { activityCosts, cpi, spi, sumLines, type CostLine } from './cost/rollup.ts';

export const PORTFOLIO_FIELDS = ['portfolio_id', 'name', 'descr', 'json'];

/** Dynamic portfolio filter. Every given criterion must match. */
export interface PortfolioRule {
  /** project status = project WBS node status_code (WS_Planned, WS_Open, WS_Closed, WS_Whatif, WS_Requested) */
  status?: string;
  /** EPS node; projects in its child EPS nodes are included */
  epsId?: string;
  /** case-insensitive match on project ID or name */
  nameContains?: string;
}

export interface Portfolio { id: string; name: string; descr: string; projIds: string[]; rule?: PortfolioRule }

export const PROJECT_STATUS: Record<string, string> = { WS_Planned: 'Planned', WS_Open: 'Active', WS_Closed: 'Inactive', WS_Whatif: 'What-If', WS_Requested: 'Requested' };

const num = (s: string | undefined) => Number(s || 0) || 0;

function parse(r: Row): Portfolio {
  let def: { projIds?: unknown; rule?: unknown } = {};
  try { def = JSON.parse(r.json || '{}') ?? {}; } catch { def = {}; }
  const projIds = Array.isArray(def.projIds) ? def.projIds.map(String) : [];
  const rule = def.rule && typeof def.rule === 'object' ? (def.rule as PortfolioRule) : undefined;
  return { id: r.portfolio_id, name: r.name, descr: r.descr ?? '', projIds, rule };
}

function store(r: Row, p: { projIds: string[]; rule?: PortfolioRule }): void {
  r.json = JSON.stringify(p.rule ? { rule: p.rule } : { projIds: p.projIds });
}

export function listPortfolios(db: Db): Portfolio[] {
  return rows(db, '_PORTFOLIO').map(parse).sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
}

export function getPortfolio(db: Db, id: string): Portfolio | undefined {
  const r = rows(db, '_PORTFOLIO').find((x) => x.portfolio_id === id);
  return r ? parse(r) : undefined;
}

export interface PortfolioDef { descr?: string; projIds?: string[]; rule?: PortfolioRule }

export function createPortfolio(db: Db, name: string, def: PortfolioDef = {}): Portfolio {
  const n = name.trim();
  if (!n) throw new Error('Portfolio name cannot be blank.');
  if (rows(db, '_PORTFOLIO').some((r) => r.name.toLowerCase() === n.toLowerCase())) throw new Error(`A portfolio named ${n} already exists.`);
  const T = table(db, '_PORTFOLIO');
  for (const f of PORTFOLIO_FIELDS) addField(T, f);
  const id = String(Math.max(0, ...T.rows.map((r) => Number(r.portfolio_id) || 0)) + 1);
  const r: Row = { portfolio_id: id, name: n, descr: def.descr ?? '', json: '' };
  store(r, { projIds: def.projIds ?? [], rule: def.rule });
  T.rows.push(r);
  return parse(r);
}

/** Change name, description, project list or rule. Passing `rule: undefined` with projIds switches to a fixed list. */
export function updatePortfolio(db: Db, id: string, patch: { name?: string; descr?: string; projIds?: string[]; rule?: PortfolioRule | null }): Portfolio {
  const r = rows(db, '_PORTFOLIO').find((x) => x.portfolio_id === id);
  if (!r) throw new Error('Portfolio not found.');
  if (patch.name != null) {
    const n = patch.name.trim();
    if (!n) throw new Error('Portfolio name cannot be blank.');
    if (rows(db, '_PORTFOLIO').some((x) => x !== r && x.name.toLowerCase() === n.toLowerCase())) throw new Error(`A portfolio named ${n} already exists.`);
    r.name = n;
  }
  if (patch.descr != null) r.descr = patch.descr;
  const cur = parse(r);
  const rule = patch.rule === null ? undefined : patch.rule ?? (patch.projIds ? undefined : cur.rule);
  store(r, { projIds: patch.projIds ?? cur.projIds, rule });
  return parse(r);
}

export function deletePortfolio(db: Db, id: string): void {
  const T = db.tables._PORTFOLIO;
  if (!T || !T.rows.some((r) => r.portfolio_id === id)) throw new Error('Portfolio not found.');
  T.rows = T.rows.filter((r) => r.portfolio_id !== id);
}

/** Projects of the database (baseline copies excluded). */
export function realProjects(db: Db): Row[] {
  return rows(db, 'PROJECT').filter((p) => !p._baseline_of);
}

const projNode = (db: Db, projId: string) => rows(db, 'PROJWBS').find((w) => w.proj_id === projId && w.proj_node_flag === 'Y');
export const projectStatus = (db: Db, projId: string) => projNode(db, projId)?.status_code || '';
export const projectTitle = (db: Db, p: Row) => projNode(db, p.proj_id)?.wbs_name || p._name || p.proj_short_name;

/** EPS node of a project (as the Projects window places it: _eps_id, else the first EPS node). */
const projectEps = (db: Db, p: Row) => p._eps_id || rows(db, 'EPS')[0]?.eps_id || '';

function epsAndChildren(db: Db, epsId: string): Set<string> {
  const out = new Set([epsId]);
  const eps = rows(db, 'EPS');
  for (let grew = true; grew;) {
    grew = false;
    for (const e of eps) if (e.parent_eps_id && out.has(e.parent_eps_id) && !out.has(e.eps_id)) { out.add(e.eps_id); grew = true; }
  }
  return out;
}

/** Projects matched by a rule. */
export function projectsMatching(db: Db, rule: PortfolioRule): string[] {
  const eps = rule.epsId ? epsAndChildren(db, rule.epsId) : null;
  const q = rule.nameContains?.trim().toLowerCase();
  return realProjects(db).filter((p) => {
    if (rule.status && projectStatus(db, p.proj_id) !== rule.status) return false;
    if (eps && !eps.has(projectEps(db, p))) return false;
    if (q && !`${p.proj_short_name}\u0000${projectTitle(db, p)}`.toLowerCase().includes(q)) return false;
    return true;
  }).map((p) => p.proj_id);
}

/** Project ids of a portfolio that exist in the database. */
export function projectsIn(db: Db, portfolioId: string): string[] {
  const p = getPortfolio(db, portfolioId);
  if (!p) return [];
  if (p.rule) return projectsMatching(db, p.rule);
  const exist = new Set(realProjects(db).map((x) => x.proj_id));
  return [...new Set(p.projIds)].filter((id) => exist.has(id));
}

// ---------------------------------------------------------------- dashboard

export interface ProjectSummary {
  projId: string; code: string; name: string; status: string;
  activities: number; notStarted: number; inProgress: number; completed: number;
  start: number | null; finish: number | null; dataDate: number | null;
  /** smallest total float of incomplete activities, hours (null when unscheduled) */
  minTotalFloatHr: number | null;
  critical: number;
  budgetedCost: number; actualCost: number; remainingCost: number; atCompletionCost: number;
  bcws: number; bcwp: number; acwp: number; spi: number; cpi: number;
}

export interface PortfolioSummary { projects: ProjectSummary[]; totals: ProjectSummary }

const minN = (a: number | null, b: number | null) => (a == null ? b : b == null ? a : Math.min(a, b));
const maxN = (a: number | null, b: number | null) => (a == null ? b : b == null ? a : Math.max(a, b));

function isCritical(t: Row, p: Row | undefined): boolean {
  if (t.act_end_date || t.total_float_hr_cnt === '' || t.total_float_hr_cnt == null) return false;
  if (p?.critical_path_type === 'CT_DrivPath') return t.driving_path_flag === 'Y';
  return Number(t.total_float_hr_cnt) <= Number(p?.critical_drtn_hr_cnt || 0);
}

function costFields(l: CostLine) {
  return { budgetedCost: l.bac, actualCost: l.actual, remainingCost: l.remaining, atCompletionCost: l.eac, bcws: l.pv, bcwp: l.ev, acwp: l.ac, spi: spi(l), cpi: cpi(l) };
}

/** Portfolio dashboard: per project and total activity counts, dates, float, critical count, costs and earned value. */
export function portfolioSummary(db: Db, projectIds: string[]): PortfolioSummary {
  const projects = new Map(rows(db, 'PROJECT').map((p) => [p.proj_id, p]));
  const ids = projectIds.filter((id) => projects.has(id));
  const costs = activityCosts(db, ids);
  const tasksBy = new Map<string, Row[]>(ids.map((id) => [id, []]));
  for (const t of rows(db, 'TASK')) if (t.task_type !== 'TT_WBS') tasksBy.get(t.proj_id)?.push(t);
  const out: ProjectSummary[] = [];
  const allLines: CostLine[] = [];
  for (const id of ids) {
    const p = projects.get(id)!;
    const ts = tasksBy.get(id) ?? [];
    let start: number | null = null, finish: number | null = null, flt: number | null = null;
    let ns = 0, ip = 0, cp = 0, crit = 0;
    const lines: CostLine[] = [];
    for (const t of ts) {
      if (t.act_end_date) cp++; else if (t.act_start_date) ip++; else ns++;
      start = minN(start, parseP6Date(t.act_start_date || t.early_start_date || t.restart_date || t.target_start_date));
      finish = maxN(finish, parseP6Date(t.act_end_date || t.early_end_date || t.reend_date || t.target_end_date));
      if (!t.act_end_date && t.total_float_hr_cnt !== '' && t.total_float_hr_cnt != null) flt = minN(flt, num(t.total_float_hr_cnt));
      if (isCritical(t, p)) crit++;
      const l = costs.get(t.task_id);
      if (l) lines.push(l);
    }
    // project-level expenses without an activity are not in activityCosts
    const loose = rows(db, 'PROJCOST').filter((c) => c.proj_id === id && !c.task_id);
    if (loose.length) {
      const bac = loose.reduce((v, c) => v + num(c.target_cost), 0), act = loose.reduce((v, c) => v + num(c.act_cost), 0), rem = loose.reduce((v, c) => v + num(c.remain_cost), 0);
      lines.push({ bac, budget: bac, actual: act, remaining: rem, eac: act + rem, pv: 0, ev: 0, ac: act });
    }
    start ??= parseP6Date(p.plan_start_date);
    finish ??= parseP6Date(p.scd_end_date) ?? parseP6Date(p.plan_end_date);
    const sum = sumLines(lines);
    allLines.push(sum);
    out.push({
      projId: id, code: p.proj_short_name, name: projectTitle(db, p), status: PROJECT_STATUS[projectStatus(db, id)] ?? projectStatus(db, id),
      activities: ts.length, notStarted: ns, inProgress: ip, completed: cp,
      start, finish, dataDate: parseP6Date(p.last_recalc_date), minTotalFloatHr: flt, critical: crit, ...costFields(sum),
    });
  }
  const total = sumLines(allLines);
  const totals: ProjectSummary = {
    projId: '', code: 'Total', name: `${out.length} project${out.length === 1 ? '' : 's'}`, status: '',
    activities: 0, notStarted: 0, inProgress: 0, completed: 0, start: null, finish: null, dataDate: null, minTotalFloatHr: null, critical: 0, ...costFields(total),
  };
  for (const s of out) {
    totals.activities += s.activities; totals.notStarted += s.notStarted; totals.inProgress += s.inProgress; totals.completed += s.completed; totals.critical += s.critical;
    totals.start = minN(totals.start, s.start); totals.finish = maxN(totals.finish, s.finish);
    totals.dataDate = maxN(totals.dataDate, s.dataDate); totals.minTotalFloatHr = minN(totals.minTotalFloatHr, s.minTotalFloatHr);
  }
  return { projects: out, totals };
}
