// The contract of the notes, walked mechanically over the answer of every schedule tool on two real samples and a built project: a note exists only where the rule says, in ONE field with ONE name,
// said once, in the one wording of core/notes.ts, with no internal words. (The wording of each family is pinned in notes-a / notes-b; this file pins the shape.)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { callTool, toolResult } from '../mcp/server.ts';
import { sampleCopy, testRoots } from './helpers.ts';

testRoots();
const call = async (name: string, args: Record<string, unknown>) => { const r = await callTool(name, args); return toolResult(r.out, r.isError, name).structuredContent as any; };

/** Keys that are fields of data rows (a finding, an anomaly, a log entry), not notes of the answer. */
const ROW_KEYS = new Set(['message', 'detail', 'reason', 'where', 'what', 'description', 'action']);
const BANNED_FIELDS = new Set(['note', 'warnings', 'method', 'definition', 'logic_definitions', 'tell_the_user', 'es_note', 'es_reason', 'histogram_note', 'best_note', 'stats_note', 'data_date_note', 'data_dates_note', 'status_dates_note', 'partial_note', 'redone_note', 'kept_note', 'refused_note', 'over_limit_note', 'warnings_note', 'volume_note', 'sign_note', 'days_are', 'basis_note', 'resources_order_note', 'periods_note', 'answer_note', 'quality_note', 'calendar_note', 'prefixed_note', 'geometry_note', 'activities_note_all']);
const WORDS = /\bthe source\b|Bellator|\bplatform\b|\btask_id\b|\bproj_id\b|\bwbs_id\b|\brsrc_id\b|\bclndr_id\b|internal id/i;
/** A table or column name of the file in a sentence (the agent knows Activities, Resources and P6's field names, never the table or column the file keeps them in): table names in capitals, a *_id / *_flag / *_cnt / *_date column
 *  (except the arguments a tool takes: data_date, status_date, job_id), and the clone's internal names. */
const TABLE_COLUMN = /\b(?:TASK|TASKPRED|TASKRSRC|PROJWBS|PROJECT|RSRC|RSRCRATE|CALENDAR|ERMHDR|UDFTYPE|PROJCOST|ROLES|RSRCROLE)\b|\b(?!data_date\b|status_date\b|job_id\b)[a-z]+(?:_[a-z]+)*_(?:id|flag|cnt|date)\b/;
/** A raw handle, or an absolute path of a temporary folder (a cut list's note names its result file: that one is the exception). */
const RAW = /\bh_[A-Za-z0-9_-]{8,}|\/tmp\/|\/var\/folders|\\Temp\\|p6-test-|p6-notes|p6-fix3/;
/** The family of a sentence and its subject: two sentences of one family about one subject in one answer say one fact twice. A helper per family of core/notes.ts. */
const FAMILIES: [string, RegExp][] = [
  ['no-data-date', /^(?:.+ not assessed: )?(.+?) (?:has|have) no data date\b/], ['baseline-not-assigned', /[Nn]o baseline is assigned to (.+?)[:;]/], ['dates-not-current', /^The saved dates of (.+?) are not what a recalculation gives/],
  ['root-wbs', /Project (.+?) has no root WBS/], ['material', /^(\d+) resources? (?:is|are) Material/], ['no-limit', /^(\d+) resources? (?:has|have) no Max Units\/Time/], ['loop', /^.+ (?:is|are) (in a loop)\.$/], ['links-left-out', /^(Left out of this schedule)/],
  ['planned-start-used', /^(.+?) has no data date: the planned start .* was used/],
];
export const familyKeys = (sentence: string): string[] => FAMILIES.flatMap(([f, re]) => { const m = re.exec(sentence); return m ? [`${f}:${m[1]}`] : []; });

interface Walked { notes: string[]; sentences: string[]; cuts: string[]; problems: string[]; errors: string[] }
function walk(tool: string, answer: any): Walked {
  const w: Walked = { notes: [], sentences: [], cuts: [], problems: [], errors: [] };
  const isRefusal = !!answer?.error;
  const visit = (v: unknown, path: string, inRow: boolean, siblings: Record<string, unknown> | null) => {
    if (Array.isArray(v)) { v.forEach((x, i) => visit(x, `${path}[${i}]`, true, null)); return; }
    if (!v || typeof v !== 'object') return;
    const o = v as Record<string, unknown>;
    // a list that has fewer items than its total says so beside it (a page of a paged reader says it with next_offset: run_report, as activity_table and read_table do)
    for (const [k, x] of Object.entries(o)) {
      if (!Array.isArray(x) || k === 'exported') continue;
      const total = o[`${k}_total`] ?? o[`total_${k}`];
      if (typeof total === 'number' && total > x.length && typeof o[`${k}_note`] !== 'string' && typeof o.next_offset !== 'number') w.problems.push(`${path ? `${path}.` : ''}${k}: ${x.length} items of ${total} with no "_note" beside it`);
    }
    for (const [k, x] of Object.entries(o)) {
      const here = path ? `${path}.${k}` : k;
      if (k === 'error' && path === '') { for (const f of ['reason', 'message', 'hint', 'next_step']) if (typeof (x as any)?.[f] === 'string') w.errors.push(String((x as any)[f])); continue; } // the refusal's own fields: judged as sentences too
      if (k === 'log' && (tool === 'schedule' || tool === 'update_progress')) { collectLog(x, here); continue; } // P6's schedule log
      if (k === 'exported') continue;
      if (k === 'notes') {
        if (path !== '') w.problems.push(`${here}: notes only at the top of the answer`);
        else if (!Array.isArray(x) || x.some((n) => typeof n !== 'string')) w.problems.push(`${here}: notes is a list of sentences`);
        else { w.notes.push(...(x as string[])); w.sentences.push(...(x as string[])); }
        continue;
      }
      if (/_note$/.test(k)) {
        const list = k.slice(0, -5);
        const isCut = typeof x === 'string' && /^\d+ of \d+ shown/.test(x) && Array.isArray(o[list]);
        if (!isCut) w.problems.push(`${here}: a "_note" field that is not the "N of M shown" note beside its list`);
        else { w.cuts.push(x as string); w.sentences.push(x as string); }
        continue;
      }
      if (BANNED_FIELDS.has(k)) {
        // the cancelled / partial answer of a run that can be resumed keeps `note` (the platform reads it with `resume`); an echo of an argument (`method`) is a short word
        if (k === 'note' && path === '' && typeof answer.resume === 'string') { w.sentences.push(String(x)); continue; }
        if (k === 'method' && typeof x === 'string') continue;
        if (k === 'warnings' && path.endsWith('diagnostics.counts')) continue;
        if (k === 'warnings' && /(^|\.)(before_repairs\.)?counts$/.test(path)) continue;
        w.problems.push(`${here}: field "${k}" is not a place for notes`);
        continue;
      }
      if (ROW_KEYS.has(k) && typeof x === 'string' && !inRow && path !== '' && !/(^|\.)(summary|error)(\.|$)/.test(path)) { continue; }
      if (ROW_KEYS.has(k) && typeof x === 'string' && inRow) { if (k === 'message' || k === 'detail') w.sentences.push(x); continue; }
      if (ROW_KEYS.has(k) && typeof x === 'string' && path === '' && !isRefusal) { w.problems.push(`${here}: a top-level "${k}" outside a refusal`); continue; }
      if (x && typeof x === 'object') visit(x, here, Array.isArray(x), o);
    }
  };
  const collectLog = (log: any, path: string) => {
    for (const area of ['errors', 'warnings', 'exceptions']) for (const sec of log?.[area] ?? []) for (const a of sec.activities ?? []) if (a.detail) w.sentences.push(a.detail);
  };
  visit(answer, '', false, null);
  for (const s of [...w.notes, ...w.cuts, ...w.errors]) if (WORDS.test(s)) w.problems.push(`banned word in a note: ${s}`);
  for (const s of [...w.notes, ...w.errors]) { const t = TABLE_COLUMN.exec(s); if (t) w.problems.push(`a table or column name (${t[0]}) in: ${s}`); if (RAW.test(s.replace(/\bin \S+\.(?:csv|json)\b/g, 'in <result file>'))) w.problems.push(`a raw handle or temporary path in: ${s}`); } // (a note that names the result file holding a whole list is the list rule)
  for (const s of w.errors) if ((s.match(/\bRefused: /g) ?? []).length > 1) w.problems.push(`a refusal inside a refusal: ${s}`);
  const seen = new Set<string>();
  for (const s of w.sentences) { if (seen.has(s)) w.problems.push(`said twice: ${s}`); seen.add(s); }
  // the same fact said twice in different words: two sentences of one family about one subject
  const byKey = new Map<string, string>();
  for (const s of [...w.notes, ...w.errors]) for (const key of familyKeys(s)) { const before = byKey.get(key); if (before && before !== s) w.problems.push(`one fact twice (${key}): ${before} / ${s}`); byKey.set(key, s); }
  return w;
}

/** The rows a result file holds for a list: a CSV's records, or the length of the array of that size somewhere in a JSON. */
function rowsOf(file: string, total: number): number | null {
  if (!existsSync(file)) return null;
  const text = readFileSync(file, 'utf8');
  if (file.endsWith('.csv')) { let n = 0, q = false; for (let i = 0; i < text.length; i++) { const c = text[i]; if (c === '"') q = !q; else if (c === '\n' && !q) n++; } return Math.max(0, n - (text.endsWith('\n') ? 0 : -1) - 1); }
  const find = (v: unknown): boolean => (Array.isArray(v) ? v.length === total || v.some(find) : v && typeof v === 'object' ? Object.values(v).some(find) : false);
  try { return find(JSON.parse(text)) ? total : -1; } catch { return -1; }
}

function check(tool: string, answer: any, label: string, tools: Set<string>) {
  const w = walk(tool, answer);
  assert.deepEqual(w.problems, [], `${label} ${tool}: ${JSON.stringify(answer?.notes ?? '').slice(0, 300)}`);
  for (const s of w.cuts) {
    const m = /^(\d+) of (\d+) shown(?:; all \d+ in (.+))?\.$/.exec(s);
    assert.ok(m, `${label} ${tool}: a list cut is said as "<n> of <N> shown; all <N> in <file>.": ${s}`);
    if (m![3]) {
      const n = rowsOf(m![3], Number(m![2]));
      assert.ok(n != null, `${label} ${tool}: the file named in "${s}" exists`);
      if (m![3].endsWith('.csv')) assert.ok(n! >= Number(m![2]), `${label} ${tool}: ${m![3]} holds ${n} rows, "${s}" says ${m![2]}`);
      else assert.ok(n! >= 0, `${label} ${tool}: ${m![3]} holds a list of ${m![2]}`);
    }
  }
  tools.add(tool);
}

const OPS = (c: (tool: string, args: Record<string, unknown>) => Promise<any>, h: string, h2: string) => [
  ['validate', { handle: h }], ['schedule', { handle: h }], ['dcma_14', { handle: h }], ['check_schedule', { handle: h }], ['decm', { handle: h }], ['lint', { handle: h }],
  ['progress_curves', { handle: h }], ['earned_value', { handle: h }], ['monte_carlo', { handle: h, seed: 7, iterations: 20 }], ['schedule_index', { handle: h }], ['planning_horizon', { handle: h }],
  ['baseline_variance', { handle: h }], ['resource_histogram', { handle: h }], ['level_resources', { handle: h, dry_run: true }], ['critical_path', { handle: h }], ['float_paths', { handle: h }],
  ['schedule_health', { handle: h }], ['review', { handle: h }], ['project_summary', { handle: h }], ['compare', { handle: h, other_handle: h2 }], ['windows_analysis', { handle: h, updates: [{ handle: h2 }] }],
  ['change_tracking', { handle: h, updates: [{ handle: h2 }] }], ['crash_schedule', { handle: h, target_days: 2 }], ['evaluate_batch', { handle: h, scenarios: [{ name: 'same', overrides: [] }] }],
] as [string, Record<string, unknown>][];

/** The lookups, the what-if and the transfer / import dry runs: every other tool of the server that answers about a schedule (see the list of what is not walked, at the end of this file). */
const MORE = async (c: (tool: string, args: Record<string, unknown>) => Promise<any>, h: string, h2: string, dir: string) => {
  const first = (await c('find_activities', { handle: h, limit: 1 })).activities?.[0]?.id as string;
  return [
    ['find_activities', { handle: h, limit: 3 }], ['get_activity', { handle: h, activity_id: first }], ['trace_logic', { handle: h, activity_id: first }], ['activity_table', { handle: h, limit: 3 }],
    ['list_wbs', { handle: h }], ['list_dictionaries', { handle: h }], ['resource_summary', { handle: h }], ['list_projects', { handle: h }], ['list_tables', { handle: h }], ['read_table', { handle: h, table: 'TASK', limit: 3 }],
    ['run_report', { handle: h, report: 'Schedule Report' }], ['export_excel', { handle: h, path: `${dir}/rules.xlsx` }], ['evaluate', { handle: h, overrides: [{ op: 'update_activity', id: first, duration_days: 3 }] }],
    ['transfer_progress', { handle: h, other_handle: h2, dry_run: true }], ['import_file', { handle: h, other_handle: h2, action: 'update', dry_run: true }],
    ['compute_schedule', { start: '2026-03-02', activities: [{ id: 'A', duration_days: 2 }, { id: 'B', duration_days: 3 }], relationships: [{ pred: 'A', succ: 'B' }] }],
  ] as [string, Record<string, unknown>][];
};
/** Not walked, and why: tia (needs a fragnet built for the case), optimize_schedule (runs the embedded reasoner model for minutes; its notes are walked in tests/analysis-hrm.test.ts), export_pdf (renders pages; its notes are those of export_excel's family), undo / redo /
 *  close / list_open / server_status / job_status / cancel_job (they answer about the session, not about a schedule), the 4D and model tools (open_model ... compare_4d: they answer about a building model; their notes are walked in tests/fourd-*.test.ts) and lob_* (walked in tests/lob-mcp.test.ts). */

const seenTools = new Set<string>();
for (const sample of ['130 TRIAL.xer', 'Tower-A.xer', 'Enppi.xer', 'Detailed Program.xer', 'Aurora_Tower_Baseline.xer']) {
  test(`the contract of the notes holds for every tool's answer on ${sample}`, { timeout: 600000 }, async () => {
    const o = await call('open_file', { path: sampleCopy(sample), lenient: true });
    const o2 = await call('open_file', { path: sampleCopy(sample), lenient: true });
    check('open_file', o, sample, seenTools);
    for (const [tool, args] of OPS(call, o.handle, o2.handle)) check(tool, await call(tool, args), sample, seenTools);
    for (const [tool, args] of await MORE(call, o.handle, o2.handle, dirname(sampleCopy(sample)))) check(tool, await call(tool, args), sample, seenTools);
  });
}

test('the contract of the notes holds for the answers on a built project, and each tool says a condition once, in the one wording', async () => {
  const p = await call('new_project', { id: 'B', start: '2026-03-02' });
  const e = await call('edit', { handle: p.handle, operations: [
    { op: 'add_resource', id: 'LIM', max_units_per_day: 8 }, { op: 'add_resource', id: 'FREE' },
    { op: 'add_activity', id: 'A', name: 'A', duration_days: 5 }, { op: 'add_activity', id: 'B', name: 'B', duration_days: 4 }, { op: 'add_activity', id: 'C', name: 'C', duration_days: 3 },
    { op: 'add_relationship', pred: 'A', succ: 'B' }, { op: 'add_relationship', pred: 'B', succ: 'C' },
    { op: 'assign_resource', activity: 'A', resource: 'LIM' }, { op: 'assign_resource', activity: 'B', resource: 'FREE' },
  ] });
  check('edit', e, 'built', seenTools);
  await call('edit', { handle: p.handle, operations: [{ op: 'set_fields', table: 'RSRCRATE', where: { rsrc_id: '2' }, fields: { max_qty_per_hr: '0' } }] });
  const q = await call('open_file', { path: sampleCopy('Tower-A.xer'), lenient: true });
  for (const [tool, args] of OPS(call, p.handle, q.handle)) check(tool, await call(tool, args), 'built', seenTools);
  for (const [tool, args] of await MORE(call, p.handle, q.handle, dirname(sampleCopy('Tower-A.xer')))) check(tool, await call(tool, args), 'built', seenTools);
  check('save', await call('save', { handle: p.handle, owner_key: p.owner_key, path: sampleCopy('Tower-A.xer').replace(/Tower-A\.xer$/, 'built-out.xer') }), 'built', seenTools);
  const u = await call('update_progress', { handle: p.handle, data_date: '2026-03-04' });
  check('update_progress', u, 'built', seenTools);
  for (const t of ['find_activities', 'get_activity', 'trace_logic', 'evaluate', 'transfer_progress', 'import_file', 'compute_schedule', 'schedule', 'dcma_14', 'decm', 'check_schedule', 'schedule_index', 'planning_horizon', 'resource_histogram', 'level_resources', 'baseline_variance']) assert.ok(seenTools.has(t), `${t} was walked`);
});

/** The edge cases of the data date, the loop, the stale dates and the baseline: built, and every tool's answer walked. */
test('the contract of the notes holds on the built edge cases: no data date, no planned start, an assumed data date, a loop, a stale schedule, an unassigned baseline', async () => {
  const mk = async (id: string, ops: unknown[] = []) => {
    const p = await call('new_project', { id, start: '2026-03-02' });
    const e = await call('edit', { handle: p.handle, operations: [{ op: 'add_activity', id: 'A', name: 'A', duration_days: 5 }, { op: 'add_activity', id: 'B', name: 'B', duration_days: 4 }, { op: 'add_relationship', pred: 'A', succ: 'B' }, ...ops] });
    assert.ok(!e.error, JSON.stringify(e));
    return p.handle as string;
  };
  const other = await call('open_file', { path: sampleCopy('Tower-A.xer'), lenient: true });
  const cases: [string, string][] = [];
  cases.push(['no data date, no planned start', await mk('N1', [{ op: 'set_fields', table: 'PROJECT', all: true, fields: { plan_start_date: '', last_recalc_date: '' } }])]);
  cases.push(['no data date, a planned start', await mk('N2', [{ op: 'set_fields', table: 'PROJECT', all: true, fields: { last_recalc_date: '' } }])]);
  const assumed = await mk('N3', [{ op: 'set_fields', table: 'PROJECT', all: true, fields: { last_recalc_date: '' } }]);
  await call('schedule', { handle: assumed });
  cases.push(['an assumed data date', assumed]);
  const stale = await mk('N4');
  await call('schedule', { handle: stale }); await call('edit', { handle: stale, operations: [{ op: 'update_activity', id: 'A', duration_days: 9 }] });
  cases.push(['a stale schedule', stale]);
  for (const [label, h] of cases) {
    for (const [tool, args] of OPS(call, h, other.handle)) if (!['compare', 'windows_analysis', 'change_tracking'].includes(tool)) check(tool, await call(tool, args), label, new Set());
    for (const tool of ['windows_analysis', 'change_tracking']) check(tool, await call(tool, { handle: h, updates: [{ handle: other.handle }] }), label, new Set());
    check('edit', await call('edit', { handle: h, operations: [{ op: 'update_activity', id: 'A', name: 'A renamed' }] }), label, new Set());
  }
});
