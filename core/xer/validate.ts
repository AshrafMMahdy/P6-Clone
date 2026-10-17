import { KEYS, refTarget, type Db, type Row } from '../db.ts';
import { parseP6Date } from '../dates.ts';
import { sortFindings, type Finding, type Severity } from '../findings.ts';
import { parseClndrData, hoursPerWeek } from '../calendar/clndr-data.ts';
import { ENUMS, fieldType, fieldsFor, knownFields, knownTables } from './schema.ts';

const KNOWN_VERSION = /^(3\.5|4\.[01]|5\.0(\.\d+)?|6\.[0-2](\.\d+)?|7\.0(\.\d+)?|8\.[1-4](\.\d+)?|1[5-9]\.\d+|2[0-6]\.\d+)$/;
const PER_KIND_CAP = 5;

/** Severity when a reference does not resolve. Unlisted = warning. */
const REF_SEVERITY: Record<string, Severity> = {
  'TASK.proj_id': 'error', 'TASK.wbs_id': 'error', 'PROJWBS.proj_id': 'error',
  'TASKPRED.task_id': 'error', 'TASKPRED.pred_task_id': 'warning', 'TASKPRED.pred_proj_id': 'info', 'TASKPRED.proj_id': 'error',
  'TASKRSRC.task_id': 'error', 'TASKRSRC.rsrc_id': 'error', 'TASKRSRC.proj_id': 'error',
  'TASKACTV.task_id': 'error', 'TASKACTV.actv_code_id': 'error', 'ACTVCODE.actv_code_type_id': 'error',
  'UDFVALUE.udf_type_id': 'error', 'PROJCOST.task_id': 'error', 'TASKMEMO.task_id': 'error',
};
const REF_P6: Record<Severity, string> = {
  fatal: 'P6 rejects the file.',
  error: 'P6 import fails or the row is rejected.',
  warning: 'P6 imports and substitutes a default (e.g. project default calendar, root OBS).',
  info: 'P6 keeps it as an external relationship if that project exists in the database, otherwise drops it.',
};

function levenshtein(a: string, b: string): number {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) {
    d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  }
  return d[a.length][b.length];
}

function suggest(name: string, candidates: Iterable<string>): string | undefined {
  let best: string | undefined;
  let bd = 4;
  for (const c of candidates) {
    const d = levenshtein(name, c);
    if (d < bd) { bd = d; best = c; }
  }
  return best;
}

class Collector {
  out: Finding[] = [];
  private counts = new Map<string, number>();
  add(f: Finding): void {
    const k = `${f.code}|${f.table ?? ''}|${f.field ?? ''}`;
    const n = (this.counts.get(k) ?? 0) + 1;
    this.counts.set(k, n);
    if (n <= PER_KIND_CAP) this.out.push(f);
  }
  finish(): Finding[] {
    for (const [k, n] of this.counts) {
      if (n <= PER_KIND_CAP) continue;
      const first = this.out.find((f) => `${f.code}|${f.table ?? ''}|${f.field ?? ''}` === k)!;
      this.out.push({ ...first, row: undefined, key: undefined, message: `…and ${n - PER_KIND_CAP} more ${first.code} in ${first.table ?? 'file'}${first.field ? '.' + first.field : ''} (${n} total).` });
    }
    return this.out;
  }
}

/** Validate a parsed XER the way P6 import would, with diagnostics. Returns parse findings plus rule findings, worst first. */
export function validateXer(db: Db, parseFindings: Finding[] = []): Finding[] {
  const c = new Collector();
  parseFindings.forEach((f) => c.add(f));
  const T = db.tables;
  const version = db.header?.version ?? '';
  const raw = db.header?.raw ?? [];

  // Header
  if (db.header) {
    if (!KNOWN_VERSION.test(version)) c.add({ severity: 'warning', code: 'VERSION_UNKNOWN', message: `ERMHDR version "${version}" is not a P6 release number.`, p6: 'P6 maps fields by name; an unrecognised version may be refused by older P6 builds.' });
    if (raw[3] !== 'Project') c.add({ severity: 'warning', code: 'HEADER_FORMAT', message: `ERMHDR 4th value is "${raw[3] ?? ''}", P6 writes "Project".`, p6: 'P6 expects ERMHDR, version, date, "Project", user, user name, database, "Project Management", currency.' });
    if (!/^\d{4}-\d{2}-\d{2}$/.test(raw[2] ?? '')) c.add({ severity: 'warning', code: 'HEADER_DATE', message: `ERMHDR export date "${raw[2] ?? ''}" is not yyyy-mm-dd.`, p6: 'P6 writes the export date without a time.' });
  }

  // Tables, fields, values
  const known = knownTables();
  const ref = fieldsFor(KNOWN_VERSION.test(version) ? version : '19.12', 'TASK') ? (KNOWN_VERSION.test(version) ? version : '19.12') : '7.0';
  for (const t of Object.values(T)) {
    if (!known.has(t.name)) {
      c.add({ severity: 'warning', code: 'TABLE_UNKNOWN', table: t.name, message: `Unknown table ${t.name}.`, p6: 'P6 ignores tables it does not recognise.' });
      continue;
    }
    const kf = knownFields(t.name);
    const key = KEYS[t.name];
    if (key && kf.has(key) && !t.fields.includes(key)) {
      const s = suggest(key, t.fields);
      c.add({ severity: 'fatal', code: 'MISSING_KEY_FIELD', table: t.name, field: key, message: `${t.name} has no ${key} column${s ? ` (found "${s}" — misspelled?)` : ''}.`, p6: 'P6 cannot import the table without its key.' });
    }
    for (const f of t.fields) {
      if (kf.size && !kf.has(f)) {
        const s = suggest(f, kf);
        c.add({ severity: 'warning', code: 'FIELD_UNKNOWN', table: t.name, field: f, message: `${t.name}.${f} is not a P6 field${s ? `; did you mean ${s}?` : ''}.`, p6: 'P6 ignores unknown columns, so this data is lost on import.' });
      }
    }
    const expected = fieldsFor(ref, t.name) ?? [];
    const missing = expected.filter((f) => !t.fields.includes(f));
    if (missing.length) c.add({ severity: 'info', code: 'MISSING_FIELD', table: t.name, message: `${t.name} lacks ${missing.length} of ${expected.length} P6 ${ref} fields: ${missing.slice(0, 12).join(', ')}${missing.length > 12 ? ', …' : ''}.`, p6: 'P6 fills missing columns with defaults.' });

    const seen = new Set<string>();
    t.rows.forEach((r, i) => {
      const row = i + 1;
      if (key && t.fields.includes(key)) {
        const k = r[key];
        if (!k) c.add({ severity: 'error', code: 'EMPTY_KEY', table: t.name, row, field: key, message: `${t.name} row ${row} has empty ${key}.`, p6: 'P6 rejects the row.' });
        else if (seen.has(k)) c.add({ severity: 'fatal', code: 'DUP_KEY', table: t.name, row, key: k, field: key, message: `Duplicate ${t.name}.${key} = ${k}.`, p6: 'P6 import fails with a unique constraint error.' });
        seen.add(k);
      }
      for (const f of t.fields) {
        const v = r[f];
        if (v === '' || v == null || !kf.has(f)) continue;
        const en = ENUMS[`${t.name}.${f}`];
        if (en) {
          if (t.name === 'TASKPRED' && f === 'pred_type' && /^PR_(FS|SS|FF|SF)\d$/.test(v)) {
            c.add({ severity: 'warning', code: 'LEGACY_REL_TYPE', table: t.name, row, field: f, message: `TASKPRED.pred_type = "${v}" is a legacy numbered code (seen in P6 5.0 exports).`, p6: 'Old P6 builds accept it as the base type; current P6 expects PR_FS/PR_SS/PR_FF/PR_SF.' });
            continue;
          }
          if (!en.includes(v)) c.add({ severity: 'error', code: 'BAD_ENUM', table: t.name, row, field: f, key: key ? r[key] : undefined, message: `${t.name}.${f} = "${v}" is not a P6 code (expected ${en.filter(Boolean).join(', ')}).`, p6: 'P6 import fails on an invalid code value.' });
          continue;
        }
        const ty = fieldType(f);
        if (ty === 'date') {
          if (parseP6Date(v) == null) c.add({ severity: 'error', code: 'BAD_DATE', table: t.name, row, field: f, key: key ? r[key] : undefined, message: `${t.name}.${f} = "${v}" is not a date.`, p6: 'P6 import fails on unparseable dates.' });
          else if (!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(v)) c.add({ severity: 'warning', code: 'DATE_FORMAT', table: t.name, row, field: f, message: `${t.name}.${f} = "${v}" is not in P6's yyyy-mm-dd hh:mm format.`, p6: 'P6 writes yyyy-mm-dd hh:mm; other forms may be misread.' });
        } else if (ty === 'number' && !/^-?\d+(\.\d+)?([eE][-+]?\d+)?$/.test(v)) {
          c.add({ severity: 'error', code: 'BAD_NUMBER', table: t.name, row, field: f, key: key ? r[key] : undefined, message: `${t.name}.${f} = "${v}" is not a number.`, p6: 'P6 import fails on non-numeric values.' });
        } else if (ty === 'flag' && v !== 'Y' && v !== 'N') {
          c.add({ severity: 'error', code: 'BAD_FLAG', table: t.name, row, field: f, key: key ? r[key] : undefined, message: `${t.name}.${f} = "${v}" must be Y or N.`, p6: 'P6 import fails on invalid flags.' });
        }
      }
    });

    // References
    for (const f of t.fields) {
      const target = refTarget(f, t.name);
      if (!target || !known.has(target)) continue;
      const tk = KEYS[target];
      const keys = new Set((T[target]?.rows ?? []).map((x) => x[tk]));
      const sev: Severity = REF_SEVERITY[`${t.name}.${f}`] ?? (f === 'clndr_id' ? 'warning' : T[target] ? 'warning' : 'info');
      t.rows.forEach((r, i) => {
        const v = r[f];
        if (!v || keys.has(v)) return;
        if (t.name === 'PROJWBS' && f === 'parent_wbs_id' && r.proj_node_flag === 'Y') return; // EPS parent, not exported
        if (t.name === 'CALENDAR' && f === 'proj_id') return;
        c.add({ severity: sev, code: 'DANGLING_REF', table: t.name, row: i + 1, field: f, key: key ? r[key] : undefined, message: `${t.name}.${f} = ${v} not found in ${target}${T[target] ? '' : ' (table missing)'}.`, p6: REF_P6[sev] });
      });
    }
  }

  // Project structure
  const projects = T.PROJECT?.rows ?? [];
  if (!projects.length) c.add({ severity: 'fatal', code: 'NO_PROJECT', message: 'No PROJECT rows.', p6: 'P6 finds no project to import.' });
  if (!T.TASK?.rows.length) c.add({ severity: 'warning', code: 'NO_TASK', message: 'No TASK rows.', p6: 'P6 imports an empty project.' });
  const wbs = T.PROJWBS?.rows ?? [];
  for (const p of projects) {
    const nodes = wbs.filter((w) => w.proj_id === p.proj_id && w.proj_node_flag === 'Y');
    if (!nodes.length) c.add({ severity: 'fatal', code: 'NO_PROJ_NODE', table: 'PROJWBS', key: p.proj_id, message: `Project ${p.proj_short_name || p.proj_id} has no PROJWBS row with proj_node_flag = Y.`, p6: 'P6 import fails: every project needs its root WBS node.' });
    if (nodes.length > 1) c.add({ severity: 'error', code: 'MULTI_PROJ_NODE', table: 'PROJWBS', key: p.proj_id, message: `Project ${p.proj_short_name || p.proj_id} has ${nodes.length} root WBS nodes.`, p6: 'P6 import fails.' });
    if (!p.plan_start_date) c.add({ severity: 'error', code: 'NO_PLAN_START', table: 'PROJECT', key: p.proj_id, field: 'plan_start_date', message: `Project ${p.proj_short_name || p.proj_id} has no planned start.`, p6: 'P6 requires a project planned start.' });
    if (!p.last_recalc_date) c.add({ severity: 'warning', code: 'NO_DATA_DATE', table: 'PROJECT', key: p.proj_id, field: 'last_recalc_date', message: `Project ${p.proj_short_name || p.proj_id} has no data date (last_recalc_date).`, p6: 'P6 uses the planned start as data date.' });
  }

  // WBS tree
  const wbsById = new Map(wbs.map((w) => [w.wbs_id, w]));
  for (const w of wbs) {
    const visited = new Set<string>();
    let cur: Row | undefined = w;
    while (cur && cur.proj_node_flag !== 'Y') {
      if (visited.has(cur.wbs_id)) { c.add({ severity: 'fatal', code: 'WBS_CYCLE', table: 'PROJWBS', key: w.wbs_id, message: `WBS ${w.wbs_short_name || w.wbs_id} is in a parent cycle.`, p6: 'P6 import fails.' }); break; }
      visited.add(cur.wbs_id);
      const parent = wbsById.get(cur.parent_wbs_id);
      if (!parent) { c.add({ severity: 'warning', code: 'WBS_ORPHAN', table: 'PROJWBS', key: w.wbs_id, message: `WBS ${w.wbs_short_name || w.wbs_id} does not lead to its project root node.`, p6: 'P6 places it directly under the project.' }); break; }
      if (parent.proj_id !== w.proj_id) { c.add({ severity: 'error', code: 'WBS_CROSS_PROJECT', table: 'PROJWBS', key: w.wbs_id, message: `WBS ${w.wbs_short_name || w.wbs_id} has a parent in another project.`, p6: 'P6 import fails.' }); break; }
      cur = parent;
    }
  }

  // Calendars
  if (T.CALENDAR?.rows.length && !T.CALENDAR.fields.includes('clndr_data')) {
    c.add({ severity: 'warning', code: 'CAL_NO_DATA', table: 'CALENDAR', message: 'CALENDAR has no clndr_data column, so no calendar defines work hours or holidays.', p6: 'P6 creates the calendars with its default work week and no holidays.' });
  }
  for (const [i, r] of (T.CALENDAR?.rows ?? []).entries()) {
    if (!T.CALENDAR.fields.includes('clndr_data')) break;
    if (!r.clndr_data) { c.add({ severity: 'warning', code: 'CAL_EMPTY', table: 'CALENDAR', row: i + 1, key: r.clndr_id, message: `Calendar ${r.clndr_name} has no clndr_data.`, p6: 'P6 creates it with the default work week.' }); continue; }
    try {
      const cal = parseClndrData(r.clndr_data);
      const wh = hoursPerWeek(cal);
      if (wh === 0) c.add({ severity: 'warning', code: 'CAL_NO_WORK', table: 'CALENDAR', row: i + 1, key: r.clndr_id, message: `Calendar ${r.clndr_name} has no work hours in its week.`, p6: 'P6 imports it; activities on it cannot be scheduled.' });
      if (r.week_hr_cnt && Math.abs(Number(r.week_hr_cnt) - wh) > 0.01) c.add({ severity: 'info', code: 'CAL_HOURS_MISMATCH', table: 'CALENDAR', row: i + 1, key: r.clndr_id, message: `Calendar ${r.clndr_name}: week_hr_cnt ${r.week_hr_cnt} but work week has ${wh} h.`, p6: 'P6 uses week_hr_cnt only for display/unit conversion.' });
    } catch (e) {
      c.add({ severity: 'error', code: 'CAL_PARSE', table: 'CALENDAR', row: i + 1, key: r.clndr_id, field: 'clndr_data', message: `Calendar ${r.clndr_name}: clndr_data does not parse (${(e as Error).message}).`, p6: 'P6 import fails or the calendar is unusable.' });
    }
  }

  // Activities
  const projById = new Map(projects.map((p) => [p.proj_id, p]));
  const codes = new Map<string, string>();
  for (const [i, r] of (T.TASK?.rows ?? []).entries()) {
    const row = i + 1;
    const id = r.task_code || r.task_id;
    const ck = `${r.proj_id}|${r.task_code}`;
    if (r.task_code) {
      if (codes.has(ck)) c.add({ severity: 'error', code: 'DUP_TASK_CODE', table: 'TASK', row, key: r.task_id, field: 'task_code', message: `Activity ID ${r.task_code} is used twice in project ${r.proj_id}.`, p6: 'P6 requires unique Activity IDs within a project.' });
      codes.set(ck, r.task_id);
    } else if (T.TASK.fields.includes('task_code')) c.add({ severity: 'error', code: 'EMPTY_TASK_CODE', table: 'TASK', row, key: r.task_id, message: `Activity ${r.task_id} has no Activity ID.`, p6: 'P6 rejects activities without an ID.' });
    if (!r.clndr_id && T.TASK.fields.includes('clndr_id')) c.add({ severity: 'warning', code: 'NO_CALENDAR', table: 'TASK', row, key: id, message: `Activity ${id} has no calendar.`, p6: 'P6 assigns the project default calendar.' });
    const isMile = r.task_type === 'TT_Mile' || r.task_type === 'TT_FinMile';
    if (isMile && Number(r.target_drtn_hr_cnt || 0) > 0) c.add({ severity: 'warning', code: 'MILESTONE_DURATION', table: 'TASK', row, key: id, message: `Milestone ${id} has duration ${r.target_drtn_hr_cnt} h.`, p6: 'P6 sets milestone durations to zero.' });
    for (const f of ['target_drtn_hr_cnt', 'remain_drtn_hr_cnt']) if (Number(r[f]) < 0) c.add({ severity: 'error', code: 'NEG_DURATION', table: 'TASK', row, field: f, key: id, message: `Activity ${id} has negative ${f}.`, p6: 'P6 rejects negative durations.' });
    const as = parseP6Date(r.act_start_date), ae = parseP6Date(r.act_end_date);
    if (as != null && ae != null && ae < as) c.add({ severity: 'error', code: 'ACT_DATES_ORDER', table: 'TASK', row, key: id, message: `Activity ${id}: actual finish before actual start.`, p6: 'P6 rejects the actual dates.' });
    if (r.status_code === 'TK_Complete' && (as == null || ae == null)) c.add({ severity: 'warning', code: 'STATUS_MISMATCH', table: 'TASK', row, key: id, message: `Activity ${id} is Completed without both actual dates.`, p6: 'P6 fills missing actuals from early dates.' });
    if (r.status_code === 'TK_Active' && (as == null || ae != null)) c.add({ severity: 'warning', code: 'STATUS_MISMATCH', table: 'TASK', row, key: id, message: `Activity ${id} is In Progress but ${as == null ? 'has no actual start' : 'has an actual finish'}.`, p6: 'P6 derives status from actual dates.' });
    if (r.status_code === 'TK_NotStart' && (as != null || ae != null)) c.add({ severity: 'warning', code: 'STATUS_MISMATCH', table: 'TASK', row, key: id, message: `Activity ${id} is Not Started but has actual dates.`, p6: 'P6 derives status from actual dates.' });
    const dd = parseP6Date(projById.get(r.proj_id)?.last_recalc_date);
    if (dd != null && ((as != null && as > dd) || (ae != null && ae > dd))) c.add({ severity: 'warning', code: 'ACTUAL_AFTER_DD', table: 'TASK', row, key: id, message: `Activity ${id} has actual dates after the data date.`, p6: 'P6 imports them; the schedule log reports actuals in the future.' });
  }

  // Relationships
  const preds = T.TASKPRED?.rows ?? [];
  const pairs = new Set<string>();
  const succOf = new Map<string, string[]>();
  for (const [i, r] of preds.entries()) {
    const row = i + 1;
    if (r.task_id && r.task_id === r.pred_task_id) c.add({ severity: 'error', code: 'REL_SELF', table: 'TASKPRED', row, key: r.task_pred_id, message: `Activity ${r.task_id} is linked to itself.`, p6: 'P6 rejects the relationship.' });
    // P6 allows several relationships between one pair (e.g. SS + FF), but not two of the same type.
    const pk = `${r.pred_task_id}>${r.task_id}>${r.pred_type}`;
    if (pairs.has(pk)) c.add({ severity: 'warning', code: 'REL_DUP', table: 'TASKPRED', row, key: r.task_pred_id, message: `Two ${r.pred_type} relationships between ${r.pred_task_id} and ${r.task_id}.`, p6: 'P6 normally prevents this when editing, but imports it (seen in real P6 exports); both links are scheduled.' });
    pairs.add(pk);
    let a = succOf.get(r.pred_task_id);
    if (!a) succOf.set(r.pred_task_id, (a = []));
    a.push(r.task_id);
  }
  for (const loop of findLoops(succOf)) {
    c.add({ severity: 'warning', code: 'REL_LOOP', table: 'TASKPRED', message: `Relationship loop: ${loop.slice(0, 10).join(' → ')}${loop.length > 10 ? ' → …' : ''}.`, p6: 'P6 imports the file, but scheduling stops with a loop error.' });
  }

  return sortFindings(c.finish());
}

/** Strongly connected components with more than one node (Tarjan, iterative). */
export function findLoops(succ: Map<string, string[]>): string[][] {
  let index = 0;
  const idx = new Map<string, number>(), low = new Map<string, number>(), on = new Set<string>();
  const stack: string[] = [];
  const out: string[][] = [];
  for (const start of succ.keys()) {
    if (idx.has(start)) continue;
    const work: [string, number][] = [[start, 0]];
    while (work.length) {
      const top = work[work.length - 1];
      const [v, i] = top;
      if (i === 0) { idx.set(v, index); low.set(v, index); index++; stack.push(v); on.add(v); }
      const ns = succ.get(v) ?? [];
      if (i < ns.length) {
        top[1]++;
        const w = ns[i];
        if (!idx.has(w)) work.push([w, 0]);
        else if (on.has(w)) low.set(v, Math.min(low.get(v)!, idx.get(w)!));
        continue;
      }
      work.pop();
      if (work.length) { const p = work[work.length - 1][0]; low.set(p, Math.min(low.get(p)!, low.get(v)!)); }
      if (low.get(v) === idx.get(v)) {
        const comp: string[] = [];
        let w: string;
        do { w = stack.pop()!; on.delete(w); comp.push(w); } while (w !== v);
        if (comp.length > 1) out.push(comp.reverse());
      }
    }
  }
  return out;
}
