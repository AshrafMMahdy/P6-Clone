// The P6 XML writer against P6's own schema and against the XER it came from.
// 1. Every element and field the writer writes is one P6's XML schema (p6apibo.xsd, read from the copy MPXJ embeds: tests/fixtures/p6apibo-names.json) has.
// 2. Every field an XER can hold (the observed layouts of every P6 version, and every sample) is carried, or listed in P6XML_NOT_CARRIED with the reason.
// 3. XER -> P6 XML -> read back equals the XER, field for field, on every sample, for every field that is carried.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseXer } from '../core/xer/parse.ts';
import { P6XML_ENUMS, P6XML_NOT_CARRIED, P6XML_PARTLY_CARRIED, P6XML_ROOT_MAP, P6XML_ROOT_NOT_CARRIED, P6XML_SPECIAL_TABLES, P6XML_TABLES, parseP6Xml, parseXml, writeP6Xml, type XNode } from '../core/xml/p6xml.ts';
import { parseClndrData, parseClndrDataLeniently } from '../core/calendar/clndr-data.ts';
import { KEYS, type Db, type Row } from '../core/db.ts';
import { SAMPLES_DIR } from './helpers.ts';

const NAMES = JSON.parse(readFileSync(join(import.meta.dirname, 'fixtures', 'p6apibo-names.json'), 'utf8')) as Record<string, string[]>;
const OBSERVED = JSON.parse(readFileSync(join(import.meta.dirname, '..', 'core', 'xer', 'schema-observed.json'), 'utf8')) as { versions: Record<string, Record<string, { fields: string[] }[]>> };
const samples = readdirSync(SAMPLES_DIR).filter((f) => /\.xer$/i.test(f)).sort();
const load = (f: string): Db | null => { try { return parseXer(new Uint8Array(readFileSync(join(SAMPLES_DIR, f)))).db; } catch { return null; } };
/** Samples with a key used twice are damaged files (bit flips in transit): a key cannot tell their rows apart. */
const hasDuplicateKeys = (db: Db) => Object.entries(db.tables).some(([t, T]) => KEYS[t] && T.rows.some((r) => r[KEYS[t]]) && new Set(T.rows.map((r) => r[KEYS[t]])).size !== T.rows.length);

test('everything the P6 XML writer writes is an element or field of P6\'s XML schema', () => {
  const unknown = new Map<string, number>();
  const walk = (n: XNode, type: string, path: string) => {
    const names = new Set(NAMES[type] ?? []);
    for (const c of n.children) {
      if (!names.has(c.name)) { unknown.set(`${path}/${c.name}`, (unknown.get(`${path}/${c.name}`) ?? 0) + 1); continue; }
      const nested = c.name === 'Code' ? 'CodeAssignment' : c.name === 'UDF' ? 'UDFAssignment' : NAMES[c.name] ? c.name : null;
      if (c.children.length && nested && NAMES[nested]) walk(c, nested, `${path}/${c.name}`);
    }
  };
  let checked = 0;
  for (const f of samples.slice(0, 40)) {
    const db = load(f);
    if (!db) continue;
    const root = parseXml(writeP6Xml(db, {} as never)).children[0];
    for (const e of root.children) { if (!NAMES[e.name]) { unknown.set(`(top)${e.name}`, 1); continue; } walk(e, e.name, e.name); }
    checked++;
  }
  assert.ok(checked >= 20);
  assert.deepEqual([...unknown], [], 'elements the P6 schema does not have');
  // and the maps themselves (also the ones no sample uses)
  for (const [table, { element, map }] of Object.entries(P6XML_TABLES)) {
    const names = new Set(NAMES[element]);
    assert.ok(names.size, `${table}: P6 has an element ${element}`);
    for (const [tag, field, conv] of map) if (conv !== 'legacy') assert.ok(names.has(tag), `${table}.${field}: ${element}/${tag} is in P6's schema`);
  }
  for (const [tag, field] of P6XML_ROOT_MAP) assert.ok(NAMES.Project.includes(tag), `PROJWBS.${field}: Project/${tag} is in P6's schema`);
});

test('every field an XER can hold is carried by the P6 XML writer or listed with the reason it is not', () => {
  const fields = new Map<string, Set<string>>();
  const add = (t: string, f: string) => (fields.get(t) ?? fields.set(t, new Set()).get(t)!).add(f);
  for (const v of Object.values(OBSERVED.versions)) for (const [t, l] of Object.entries(v)) for (const x of l) x.fields.forEach((f) => add(t, f));
  for (const f of samples) { const db = load(f); if (db) for (const [t, T] of Object.entries(db.tables)) if (!t.startsWith('_')) T.fields.filter((x) => !x.startsWith('_')).forEach((x) => add(t, x)); }
  const left: string[] = [];
  for (const [t, fs] of fields) {
    if (P6XML_NOT_CARRIED[t]) continue; // a whole table
    const carried = new Set(P6XML_TABLES[t]?.map.filter((m) => m[2] !== 'legacy').map((m) => m[1]) ?? []);
    for (const f of fs) {
      if (carried.has(f) || P6XML_NOT_CARRIED[`${t}.${f}`]) continue;
      if (P6XML_SPECIAL_TABLES.includes(t) && !P6XML_TABLES[t]) continue; // checked by the round trip below
      if (t === 'RSRCCURVDATA' && /^pct_usage_\d+$/.test(f)) continue; // <Values><Value0..Value100/>
      if (t === 'TASKACTV' || t === 'UDFVALUE' || t === 'TASKPROC' && f === 'complete_pct') continue; // nested <Code>, <UDF>; step percentages
      left.push(`${t}.${f}`);
    }
  }
  assert.deepEqual(left, [], 'fields neither carried nor listed in P6XML_NOT_CARRIED');
  // no stale entry: what is listed as not carried is not carried
  for (const k of Object.keys(P6XML_NOT_CARRIED)) {
    const [t, f] = k.split('.');
    if (f) assert.ok(!P6XML_TABLES[t]?.map.some((m) => m[1] === f && m[2] !== 'legacy'), `${k} is carried after all`);
    else assert.ok(!P6XML_TABLES[t], `${k} is carried after all`);
  }
  // partly carried: carried (some codes), and the root node's list names fields the WBS element has
  for (const k of Object.keys(P6XML_PARTLY_CARRIED)) {
    const [t, f] = k.split('.');
    assert.ok(P6XML_TABLES[t]?.map.some((m) => m[1] === f) || P6XML_ROOT_MAP.some((m) => m[1] === f), `${k} is not carried at all`);
  }
  for (const f of Object.keys(P6XML_ROOT_NOT_CARRIED)) assert.ok(P6XML_TABLES.PROJWBS.map.some((m) => m[1] === f) || P6XML_NOT_CARRIED[`PROJWBS.${f}`], `root ${f} is a WBS field`);
});

test('XER -> P6 XML -> read back equals the XER, field for field, on every sample', { timeout: 300_000 }, () => {
  const SIG: Record<string, string[]> = { RSRCROLE: ['rsrc_id', 'role_id'], TASKFIN: ['fin_dates_id', 'task_id'], RSRCRATE: ['rsrc_id', 'start_date', 'shift_period_id'], ROLERATE: ['role_id', 'start_date'], TASKNOTE: ['task_id', 'proj_id'], WBSBUDG: ['wbs_budg_id'] };
  const compared: Record<string, number> = {};
  const off = new Map<string, string>(); // table.field -> the first row that did not come back as it went
  let files = 0;
  for (const f of samples) {
    const a = load(f);
    if (!a || !a.tables.PROJECT?.rows.length || hasDuplicateKeys(a)) continue;
    const b = parseP6Xml(writeP6Xml(a, {} as never)).db;
    files++;
    for (const [t, { map }] of Object.entries(P6XML_TABLES)) {
      const A: Row[] = a.tables[t]?.rows ?? [];
      if (!A.length) continue;
      const B: Row[] = b.tables[t]?.rows ?? [];
      const own = t === 'PROJWBS' ? (r: Row) => r.proj_node_flag !== 'Y' : () => true; // the root WBS node is the Project element
      const keyed = KEYS[t] && A.some((r) => r[KEYS[t]]);
      const sig = SIG[t] ?? (keyed ? [KEYS[t]] : t === 'TASKPRED' ? ['task_id', 'pred_task_id', 'pred_type'] : null);
      const fields = map.filter((m) => m[2] !== 'legacy' && !(sig ?? []).includes(m[1])).map((m) => m[1]);
      const dates = new Set(map.filter((m) => m[2] === 'date').map((m) => m[1]));
      const strict = new Map(map.filter((m) => m[2]?.startsWith('strict:')).map((m) => [m[1], P6XML_ENUMS[m[2]!.slice(7)]]));
      // (a date without a time is midnight; a coded value whose P6 text is not verified is not written, so it is not there to read back)
      const same = (x: string, v: string | undefined) => (strict.has(x) ? (v && v in strict.get(x)! ? v : '') : dates.has(x) && /^\d{4}-\d\d-\d\d$/.test(v ?? '') ? `${v} 00:00` : v ?? '');
      if (!sig) { assert.ok(B.length >= A.filter(own).length, `${f} ${t}: rows`); continue; }
      const key = (r: Row) => sig.map((s) => r[s] ?? '').join('|');
      const idx = new Map(B.map((r) => [key(r), r]));
      for (const r of A.filter(own)) {
        const u = idx.get(key(r));
        assert.ok(u, `${f} ${t} ${key(r)}: the row is written and read back`);
        for (const x of fields) {
          if (!(x in r) && !(x in u!)) continue;
          if (t === 'PROJECT' && x === 'clndr_id' && !r[x]) continue;
          if ((u![x] ?? '') !== same(x, r[x]) && !(t === 'TASKPRED' && x === 'pred_proj_id' && !r[x] && u![x] === r.proj_id)) { const k = `${t}.${x}`; if (!off.has(k)) off.set(k, `${f}: ${JSON.stringify(r[x] ?? '')} -> ${JSON.stringify(u![x] ?? '')}`); }
          if (r[x]) compared[`${t}.${x}`] = (compared[`${t}.${x}`] ?? 0) + 1;
        }
      }
    }
    // the root WBS node, written as the Project element: the fields it carries come back
    for (const r of (a.tables.PROJWBS?.rows ?? []).filter((w) => w.proj_node_flag === 'Y')) {
      const u = b.tables.PROJWBS?.rows.find((w) => w.proj_node_flag === 'Y' && w.proj_id === r.proj_id);
      assert.ok(u, `${f} root WBS of project ${r.proj_id}`);
      for (const [, x, conv] of P6XML_ROOT_MAP) {
        const want = conv?.startsWith('strict:') ? (r[x] && r[x] in P6XML_ENUMS[conv.slice(7)] ? r[x] : '') : conv === 'date' && /^\d{4}-\d\d-\d\d$/.test(r[x] ?? '') ? `${r[x]} 00:00` : r[x] ?? '';
        if (x === 'status_code' && !r[x]) continue; // (a root without a status is Active)
        if ((u![x] ?? '') !== want) { const k = `PROJWBS(root).${x}`; if (!off.has(k)) off.set(k, `${f}: ${JSON.stringify(r[x] ?? '')} -> ${JSON.stringify(u![x] ?? '')}`); }
        if (r[x]) compared[`PROJWBS(root).${x}`] = (compared[`PROJWBS(root).${x}`] ?? 0) + 1;
      }
    }
    // calendars: the same week and exceptions (their clndr_data text is written again), and the same other fields
    for (const c of a.tables.CALENDAR?.rows ?? []) {
      const u = b.tables.CALENDAR?.rows.find((x) => x.clndr_id === c.clndr_id);
      assert.ok(u, `${f} calendar ${c.clndr_id}`);
      for (const x of ['default_flag', 'clndr_name', 'proj_id', 'base_clndr_id', 'clndr_type', 'day_hr_cnt', 'week_hr_cnt', 'month_hr_cnt', 'year_hr_cnt', 'rsrc_private', 'last_chng_date']) { if (c[x] === undefined) continue; const want = x === 'clndr_type' && c[x] === 'CA_Global' ? 'CA_Base' : c[x] ?? ''; if ((u![x] ?? '') !== want && !off.has(`CALENDAR.${x}`)) off.set(`CALENDAR.${x}`, `${f}: ${JSON.stringify(c[x])} -> ${JSON.stringify(u![x])}`); }
      if (c.clndr_data) {
        let was; try { was = parseClndrData(c.clndr_data); } catch { was = parseClndrDataLeniently(c.clndr_data); }
        if (was) { const now = parseClndrData(u!.clndr_data); assert.deepEqual(now.week, was.week, `${f} ${c.clndr_name}: work week`); assert.deepEqual([...now.exceptions].sort(), [...was.exceptions].sort(), `${f} ${c.clndr_name}: exceptions`); }
      }
    }
    // a resource curve's 21 points
    for (const c of a.tables.RSRCCURVDATA?.rows ?? []) { const u = b.tables.RSRCCURVDATA.rows.find((x) => x.curv_id === c.curv_id)!; for (let i = 0; i <= 20; i++) assert.equal(u[`pct_usage_${i}`] ?? '', c[`pct_usage_${i}`] ?? '', `${f} curve ${c.curv_name} point ${i}`); }
  }
  assert.deepEqual([...off], [], 'fields that came back different');
  assert.ok(files >= 55, `${files} samples`);
  for (const k of ['ROLERATE.cost_per_qty', 'RSRC.max_qty_per_hr', 'RSRC.unit_id', 'UMEASURE.unit_name', 'COSTTYPE.cost_type', 'RSRCROLE.skill_level', 'TASK.act_work_qty', 'TASK.create_user', 'TASKRSRC.guid', 'TASKRSRC.cost_per_qty_source_type', 'PROJCOST.cost_load_type', 'RSRCRATE.cost_per_qty2', 'TASKFIN.bcwp', 'PROJISSU.issue_name', 'PROJTHRS.window_start', 'ACTVCODE.color', 'TASKNOTE.task_notes', 'WBSBUDG.spend_cost', 'PROJWBS.ev_user_pct', 'PROJECT.def_qty_type', 'PROJECT.sum_assign_level', 'PROJECT.chng_eff_cmp_pct_flag', 'PROJWBS(root).ev_user_pct', 'PROJWBS(root).orig_cost', 'PROJWBS(root).obs_id']) assert.ok(compared[k] > 0, `${k}: some sample has a value and it came back`);
});

test('a baseline project is written with the fields P6\'s schema has for a BaselineProject, and an activity note without a topic is not a notebook note', () => {
  const f = samples.find((x) => { const d = load(x); return d?.tables.PROJECT?.rows.length && d.tables.PROJWBS?.rows.length && !hasDuplicateKeys(d); });
  assert.ok(f);
  const db = load(f!)!;
  const p = db.tables.PROJECT.rows[0];
  // a baseline of the first project: a copy of its row, marked as the reader marks one
  db.tables.PROJECT.rows.push({ ...p, proj_id: '99999', proj_short_name: `${p.proj_short_name}_BL`, _baseline_of: p.proj_id, def_qty_type: 'QT_Hour', sum_assign_level: 'SL_Taskrsrc', sum_base_proj_id: '1', use_project_baseline_flag: 'Y' });
  db.tables.TASKNOTE ??= { name: 'TASKNOTE', fields: ['task_id', 'proj_id', 'task_notes'], rows: [] };
  db.tables.TASKNOTE.rows.push({ task_id: db.tables.TASK.rows[0].task_id, proj_id: db.tables.TASK.rows[0].proj_id, task_notes: '<HTML><BODY>a note</BODY></HTML>' });
  const root = parseXml(writeP6Xml(db, {} as never)).children[0];
  const bl = root.children.filter((e) => e.name === 'BaselineProject');
  assert.ok(bl.length >= 1, 'a BaselineProject is written');
  for (const e of bl) for (const c of e.children) assert.ok(NAMES.BaselineProject.includes(c.name), `BaselineProject/${c.name} is in P6's schema`);
  // an assignment's three curves, a color and a spending plan (the samples hardly have them)
  const ra = db.tables.TASKRSRC?.rows[0];
  if (ra) Object.assign(ra, { target_crv: '159:112', remain_crv: '131.505:792;27.895:8;0:160', actual_crv: '8:80' });
  const cv = db.tables.ACTVCODE?.rows[0];
  if (cv) cv.color = '0000FF';
  const xml = writeP6Xml(db, {} as never);
  if (cv) assert.ok(xml.includes('<Color>#0000FF</Color>'), 'a code value\'s color is #RRGGBB');
  if (ra) assert.ok(xml.includes('<PlannedCurve>159:112</PlannedCurve>') && xml.includes('<RemainingCurve>') && xml.includes('<ActualCurve>8:80</ActualCurve>'));
  const back = parseP6Xml(xml).db;
  if (ra) assert.deepEqual(['target_crv', 'remain_crv', 'actual_crv'].map((x) => back.tables.TASKRSRC.rows.find((r) => r.taskrsrc_id === ra.taskrsrc_id)?.[x]), ['159:112', '131.505:792;27.895:8;0:160', '8:80']);
  if (cv) assert.equal(back.tables.ACTVCODE.rows.find((r) => r.actv_code_id === cv.actv_code_id)?.color, '0000FF');
  const n = back.tables.TASKNOTE?.rows.find((r) => r.task_notes.includes('a note'));
  assert.ok(n, 'the note comes back as a TASKNOTE row');
  assert.ok(!back.tables.TASKMEMO?.rows.some((r) => r.task_memo?.includes('a note')), 'and not as a notebook note');
});

test('an export to P6 XML says what it leaves out: fields, rows and the reason, through the library and the save answer', { timeout: 60_000 }, async () => {
  const { p6xmlLosses, p6xmlLossNotes } = await import('../core/xml/p6xml.ts');
  const db = load(samples.find((f) => /^CfC\.xer$/i.test(f)) ?? samples[0])!;
  const T = db.tables;
  // the counts are the rows holding a value, per field and per reason, worked out here from the data
  const want = new Map<string, number>();
  for (const [k, reason] of Object.entries(P6XML_NOT_CARRIED)) {
    if (reason.startsWith('derived') || reason.startsWith('structure') || reason.startsWith('carried on the root')) continue;
    const [t, f] = k.split('.');
    const n = f ? (T[t]?.rows ?? []).filter((r) => r[f]).length : (T[t]?.rows.length ?? 0);
    if (n) want.set(`${t}.${f ?? '(whole table)'}|${reason}`, n);
  }
  assert.ok(want.size > 5, 'the sample holds values P6 XML has no place for');
  const got = new Map(p6xmlLosses(db).filter((l) => !/^coded value|^root node|^BaselineProject/.test(l.reason) && !l.reason.startsWith('carried on the root')).map((l) => [`${l.table}.${l.field}|${l.reason}`, l.rows]));
  assert.deepEqual([...got].sort(), [...want].sort());
  // an empty value is not a loss; a code without a verified text is one; a verified code is not
  T.PROJECT.rows[0].risk_level = ''; T.PROJECT.rows[0].def_qty_type = 'QT_Day';
  const l1 = p6xmlLosses(db);
  assert.ok(!l1.some((l) => l.table === 'PROJECT' && l.field === 'risk_level' && l.rows > T.PROJECT.rows.filter((r) => r.risk_level).length));
  assert.equal(l1.find((l) => l.table === 'PROJECT' && l.field === 'def_qty_type')?.rows, T.PROJECT.rows.filter((r) => r.def_qty_type && r.def_qty_type !== 'QT_Hour').length);
  const notes = p6xmlLossNotes(l1);
  assert.ok(notes.length >= 2 && notes.every((n) => /^Not in the P6 XML \(.+\): .+ (value|row)\(s\)/.test(n) && n.includes('Save as XER')), notes.join('\n'));
  assert.ok(notes.some((n) => n.includes('no element in P6 XML')));
  // a project with none of it loses nothing
  const empty = parseXer(new Uint8Array(readFileSync(join(SAMPLES_DIR, samples[0])))).db;
  for (const [k] of Object.entries(P6XML_NOT_CARRIED)) { const [t, f] = k.split('.'); if (!f) empty.tables[t] && (empty.tables[t].rows = []); else for (const r of empty.tables[t]?.rows ?? []) r[f] = ''; }
  for (const r of empty.tables.PROJECT?.rows ?? []) { r.def_qty_type = ''; r.sum_assign_level = ''; }
  for (const r of empty.tables.PROJWBS?.rows ?? []) { r.ev_compute_type = ''; for (const f of ['est_wt', 'seq_num', 'guid', 'sum_data_flag']) if (r.proj_node_flag === 'Y') r[f] = ''; if (r.proj_node_flag === 'Y' && r.wbs_short_name !== undefined) { const p = empty.tables.PROJECT.rows.find((x) => x.proj_id === r.proj_id); r.wbs_short_name = p?.proj_short_name ?? ''; } }
  assert.deepEqual(p6xmlLosses(empty).map((l) => `${l.table}.${l.field}`), []);
  // the MCP save answer: structured, and plainly in notes; an XER save has none of it
  const { callTool, toolResult } = await import('../mcp/server.ts');
  const call = async (name: string, args: Record<string, unknown>) => { const r = await callTool(name, args); return { err: r.isError, d: toolResult(r.out, r.isError).structuredContent as any }; };
  const dir = mkdtempSync(join(tmpdir(), 'p6-xmlloss-'));
  const np = (await call('new_project', { id: 'LOSS', start: '2026-03-02' })).d;
  const H = { handle: np.handle, owner_key: np.owner_key };
  const { sessions } = await import('../mcp/runtime.ts');
  const s = sessions.get(np.handle)!;
  assert.equal((await call('edit', { ...H, operations: [{ op: 'add_activity', id: 'A1', name: 'a' }] })).err, false);
  const pr = s.db.tables.PROJECT.rows[0];
  pr.risk_level = '3'; pr.hist_interval = 'HI_Month';
  s.db.tables.POBS = { name: 'POBS', fields: ['pobs_id', 'pobs_name'], rows: [{ pobs_id: '1', pobs_name: 'x' }, { pobs_id: '2', pobs_name: 'y' }] };
  const x = await call('save', { ...H, path: join(dir, 'a.xml') });
  assert.equal(x.err, false, JSON.stringify(x.d));
  const risk = x.d.not_in_p6_xml.find((l: any) => l.table === 'PROJECT' && l.field === 'risk_level');
  assert.deepEqual([risk.rows, risk.reason], [1, 'P6 XML field exists, its texts are not verified']);
  assert.equal(x.d.not_in_p6_xml.find((l: any) => l.table === 'POBS')?.rows, 2);
  const said = x.d.notes.join('\n');
  for (const t of ['PROJECT.risk_level 1 value(s)', 'PROJECT.hist_interval 1 value(s)', 'POBS.(whole table) 2 row(s)', 'no element in P6 XML', 'texts are not verified']) assert.ok(said.includes(t), `${t}: ${said}`);
  const r = await call('save', { ...H, path: join(dir, 'a.xer') });
  assert.equal(r.err, false);
  assert.equal(r.d.not_in_p6_xml, undefined, 'an XER keeps every field');
  await call('close', { ...H, discard: true });
});
