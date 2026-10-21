// 4D exchange: what goes to Navisworks, SYNCHRO and IFC4 4D tools, and what comes back. Pure text in and out; the MCP
// server and the desktop app write the files. Formats per sample 4D/*/NOTES.md (nw-exchange 12.0 schema and real files,
// TimeLiner CSV exports, the IFC4 specification's scheduling example, Bonsai and SYNCHRO 4D IFCs). Runs in Node and in
// the desktop's renderer alike (the global crypto).
const randomUUID = () => globalThis.crypto.randomUUID();
import { rows, type Db, type Row } from '../db.ts';
import { parseP6Date } from '../dates.ts';
import { baselineOf } from '../analysis/common.ts';
import { activityValue, linkMaps, type Role } from './link4d.ts';
import type { IfcIndex } from './parse.ts';
import { parseArgs, decodeStepString } from './stepIndex.ts';

export const PSET_4D = 'WHIQ_4D';

export interface Item4d { taskId: string; key: string; id: string; name: string; type: 'Construct' | 'Demolish' | 'Temporary'; plannedStart: string; plannedFinish: string; actualStart: string; actualFinish: string; expressIds: number[]; guids: string[] }

const day = (s?: string) => (s ? s.slice(0, 10) : '');

/** The activities with elements, with their dates: planned = the current schedule, or a baseline's dates when
 *  planned names one (TimeLiner's usual Planned vs Actual: baseline as planned, the current dates as actual). */
export function items4d(db: Db, projId: string, ix: IfcIndex | null, o: { planned?: string; key?: string } = {}): Item4d[] {
  const proj = rows(db, 'PROJECT').find((p) => p.proj_id === projId)!;
  const bl = o.planned && o.planned !== 'current' ? baselineOf(db, proj, o.planned) : null;
  if (o.planned && o.planned !== 'current' && !bl) throw new Error(`No baseline "${o.planned}".`);
  const { byTask } = linkMaps(db, projId);
  const byGuid = ix ? new Map(ix.elements.map((e) => [e.guid, e.expressId])) : new Map<string, number>();
  const out: Item4d[] = [];
  for (const t of rows(db, 'TASK').filter((x) => x.proj_id === projId && x.task_type !== 'TT_WBS')) {
    const ls = byTask.get(t.task_id);
    if (!ls?.length) continue;
    const role: Role = ls.some((l) => l.role === 'built') ? 'built' : ls[0].role;
    const b = bl?.tasks.get(t.task_code);
    const start = b ? b.act_start_date || b.early_start_date || b.target_start_date : t.act_start_date || t.early_start_date || t.target_start_date;
    const finish = b ? b.act_end_date || b.early_end_date || b.target_end_date : t.act_end_date || t.early_end_date || t.target_end_date;
    out.push({
      taskId: t.task_id, key: (o.key ? activityValue(db, t, o.key) : undefined) ?? t.task_code, id: t.task_code, name: t.task_name,
      type: role === 'removed' ? 'Demolish' : role === 'temporary' ? 'Temporary' : 'Construct',
      plannedStart: start ?? '', plannedFinish: finish ?? '', actualStart: bl ? t.act_start_date || t.early_start_date || '' : t.act_start_date || '', actualFinish: bl ? t.act_end_date || t.early_end_date || '' : t.act_end_date || '',
      guids: ls.map((l) => l.guid), expressIds: ls.map((l) => byGuid.get(l.guid)).filter((x): x is number => x != null),
    });
  }
  return out;
}

// ── STEP writing helpers ───────────────────────────────────────────────────────────────────────────────────────────
const ALPHA = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz_$';
/** A fresh 22-character IFC GlobalId. */
export function ifcGuid(): string {
  let n = BigInt('0x' + randomUUID().replace(/-/g, ''));
  const out: string[] = [];
  for (let i = 0; i < 21; i++) { out.unshift(ALPHA[Number(n & 63n)]); n >>= 6n; }
  out.unshift(ALPHA[Number(n & 3n)]);
  return out.join('');
}
/** STEP string body: apostrophes and backslashes doubled, non-ASCII as \X2\HHHH\X0\. */
export function stepString(s: string): string {
  let out = '', run = '';
  const flush = () => { if (run) { out += `\\X2\\${run}\\X0\\`; run = ''; } };
  for (const ch of s) { const cp = ch.codePointAt(0) ?? 0; if (cp > 126) { run += cp.toString(16).toUpperCase().padStart(4, '0'); continue; } flush(); out += ch === "'" ? "''" : ch === '\\' ? '\\\\' : ch; }
  flush();
  return out;
}
interface Tail { head: string; tail: string; nextId: () => number; owner: string; project: string | null; nl: string; schema: string }
function stepTail(ifcText: string): Tail {
  const end = ifcText.lastIndexOf('ENDSEC;');
  if (end < 0 || !/END-ISO-10303-21;/.test(ifcText.slice(end))) throw new Error('Not an IFC (STEP) file: no DATA section tail.');
  let max = 0;
  for (const m of ifcText.matchAll(/^#(\d+)\s*=/gm)) { const id = Number(m[1]); if (id > max) max = id; }
  const oh = /^#(\d+)\s*=\s*IFCOWNERHISTORY\(/m.exec(ifcText), pj = /^#(\d+)\s*=\s*IFCPROJECT\(/m.exec(ifcText);
  const schema = /FILE_SCHEMA\s*\(\s*\(\s*'([^']+)'/i.exec(ifcText)?.[1] ?? 'IFC?';
  return { head: ifcText.slice(0, end), tail: ifcText.slice(end), nextId: () => ++max, owner: oh ? `#${oh[1]}` : '$', project: pj ? `#${pj[1]}` : null, nl: ifcText.includes('\r\n') ? '\r\n' : '\n', schema };
}

/** The IFC with a WHIQ_4D property set on every linked element: Task (the 4D key), TaskName, PlannedStart,
 *  PlannedFinish. Appended only: geometry, GlobalIds and hierarchy stay byte-identical. One rule then attaches every
 *  element in Navisworks (Auto-Attach by property) or SYNCHRO (Auto-Matching on the field). */
export function tagIfc(ifcText: string, items: Item4d[]) {
  const t = stepTail(ifcText);
  const lines: string[] = [];
  let elements = 0, tasks = 0;
  for (const it of items) {
    const els = [...new Set(it.expressIds)];
    if (!els.length) continue;
    const props = ([['Task', it.key], ['TaskName', it.name], ['PlannedStart', day(it.plannedStart)], ['PlannedFinish', day(it.plannedFinish)]] as const)
      .map(([k, v]) => { const id = t.nextId(); lines.push(`#${id}=IFCPROPERTYSINGLEVALUE('${k}',$,IFCLABEL('${stepString(String(v ?? ''))}'),$);`); return `#${id}`; });
    const ps = t.nextId();
    lines.push(`#${ps}=IFCPROPERTYSET('${ifcGuid()}',${t.owner},'${PSET_4D}',$,(${props.join(',')}));`);
    const rel = t.nextId();
    lines.push(`#${rel}=IFCRELDEFINESBYPROPERTIES('${ifcGuid()}',${t.owner},$,$,(${els.map((e) => `#${e}`).join(',')}),#${ps});`);
    tasks++; elements += els.length;
  }
  return { text: t.head + lines.join(t.nl) + (lines.length ? t.nl : '') + t.tail, tasks, elements };
}

const xml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
/** Navisworks search sets (nw-exchange 12.0): one set per activity, named like the task, one condition on the 4D key
 *  property (category WHIQ_4D, property Task), matched by display name. */
export function searchSetsXml(items: Item4d[], folder = '4D'): string {
  const sets = items.map((it) => `      <selectionset name="${xml(it.name)}" guid="${randomUUID()}">
        <findspec mode="all" disjoint="0">
          <conditions>
            <condition test="equals" flags="10">
              <category><name internal="${PSET_4D}">${PSET_4D}</name></category>
              <property><name internal="Task">Task</name></property>
              <value><data type="wstring">${xml(it.key)}</data></value>
            </condition>
          </conditions>
          <locator>/</locator>
        </findspec>
      </selectionset>`).join('\n');
  return `<?xml version="1.0" encoding="UTF-8" ?>\n\n<exchange xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:noNamespaceSchemaLocation="http://download.autodesk.com/us/navisworks/schemas/nw-exchange-12.0.xsd" units="m" filename="" filepath="">
  <selectionsets>
    <viewfolder name="${xml(folder)}" guid="${randomUUID()}">
${sets}
    </viewfolder>
  </selectionsets>
</exchange>
`;
}

const usDate = (s: string) => { const d = parseP6Date(s); if (d == null) return ''; const x = new Date(d * 60000); return `${x.getUTCMonth() + 1}/${x.getUTCDate()}/${x.getUTCFullYear()}`; };
const csvCell = (v: unknown) => { const s = String(v ?? ''); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
/** TimeLiner CSV (the 21 columns of a TimeLiner export): UniqueId = P6 task_id (stable through updates), Display ID =
 *  Activity ID, User 1 = 4D key. Add it as a CSV data source; map User 1 to the key for Auto-Attach. */
export function timelinerCsv(items: Item4d[]): string {
  const head = ['UniqueId', 'Name', 'ActualEnabled', 'Actual Start', 'Actual End', 'PlannedEnabled', 'Planned Start', 'Planned End', 'Task Type', 'MaterialCost', 'LaborCost', 'EquipmentCost', 'Display ID', 'Animation', 'Animation Behavior', 'Provided Progress %', 'User 1', 'User 2', 'User 3', 'User 4', 'User 5'];
  const body = items.map((it) => [it.taskId, it.name, it.actualStart ? 1 : 0, usDate(it.actualStart), usDate(it.actualFinish), 1, usDate(it.plannedStart), usDate(it.plannedFinish), it.type, '', '', '', it.id, '', 'Scale', '', it.key, it.id, '', '', ''].map(csvCell).join(','));
  return [head.join(','), ...body].join('\r\n') + '\r\n';
}

export function linksCsv(db: Db, projId: string, ix: IfcIndex | null): string {
  const el = ix ? new Map(ix.elements.map((e) => [e.guid, e])) : new Map();
  const tasks = new Map(rows(db, 'TASK').filter((t) => t.proj_id === projId).map((t) => [t.task_id, t]));
  const head = ['Activity ID', 'Activity Name', 'Role', 'GlobalId', 'IFC Class', 'Element Name', 'Storey'];
  const body: string[] = [];
  for (const [taskId, ls] of linkMaps(db, projId).byTask) for (const l of ls) { const t = tasks.get(taskId), e = el.get(l.guid); body.push([t?.task_code, t?.task_name, l.role, l.guid, e?.ifcClass, e?.name, e?.storey].map(csvCell).join(',')); }
  return [head.join(','), ...body].join('\r\n') + '\r\n';
}

export const README: Record<string, string> = {
  navisworks: `Navisworks 4D package (P6 clone)

Files: the model with a WHIQ_4D property set on every linked element (Task = the activity's 4D key), search sets (one per
activity), and the TimeLiner task list (timeliner.csv).

1. Append the IFC to the Navisworks file.
2. Sets window > Import > the search-set XML: one set per activity, each finds the elements whose WHIQ_4D / Task equals
   the activity's key.
3. TimeLiner > Data Sources > Add > CSV Import > timeliner.csv. Map Name, Display ID, Planned Start/End, Actual
   Start/End, Task Type and User 1. Rebuild Task Hierarchy.
4. TimeLiner > Tasks > Auto-Attach Using Rules > "Attach Selection Sets to Tasks by Task Name" (sets are named like the
   tasks). Or "Attach Items to Tasks by Category/Property" with category WHIQ_4D, property Task = column User 1.
5. Simulate (Settings > View: Planned vs Actual when the CSV carries a baseline as Planned).
`,
  synchro: `SYNCHRO 4D package (P6 clone)

Files: the schedule as P6 XML (every activity carries the "4D Key" user-defined field) and the model with a WHIQ_4D
property set on every linked element (Task = the same key).

1. File > Import > Primavera P6 > the XML (or the XER).
2. Import the IFC as a 3D resource.
3. Auto-Matching: match tasks to 3D objects on Task user field "4D Key" = object property WHIQ_4D.Task.
`,
  ifc4d: `IFC4 4D (P6 clone)

The model with the schedule inside, the way Bonsai (BlenderBIM) and other IFC4 tools read it: an IfcWorkSchedule
(PLANNED) with one IfcTask per linked activity (IfcTaskTime with planned, early, late and actual dates and the critical
flag), IfcRelSequence for the logic, and IfcRelAssignsToProduct from each task to the elements it builds. Each saved
baseline is a BASELINE work schedule whose tasks point to the planned ones (IfcRelDefinesByObject).
`,
};

/** IFC4 4D: the schedule written into the model (Bonsai style). The model must be IFC4 (IfcTaskTime and
 *  IfcWorkSchedule as used here do not exist in IFC2X3). */
export function ifc4dText(db: Db, projId: string, ifcText: string, items: Item4d[], baselines: string[] = []): { text: string; tasks: number; links: number } {
  const t = stepTail(ifcText);
  if (!/^IFC4/i.test(t.schema)) throw new Error(`The model is ${t.schema}: IFC4 4D needs an IFC4 model. Use the navisworks or synchro package, or convert the model to IFC4.`);
  const L: string[] = [];
  const add = (body: string) => { const id = t.nextId(); L.push(`#${id}=${body};`); return `#${id}`; };
  const s = (v?: string) => (v ? `'${stepString(v)}'` : '$');
  const iso = (d?: string) => (d ? `'${d.slice(0, 10)}T${d.slice(11, 16) || '00:00'}:00'` : '$');
  const dur = (h: number) => `'PT${Math.round(h * 100) / 100}H'`;
  const tasks = new Map(rows(db, 'TASK').filter((x) => x.proj_id === projId).map((x) => [x.task_id, x]));
  const now = new Date().toISOString().slice(0, 19);
  const schedule = (name: string, type: 'PLANNED' | 'BASELINE', list: { it: Item4d; row?: Row }[]) => {
    const starts = list.map((x) => x.it.plannedStart).filter(Boolean).sort();
    const ws = add(`IFCWORKSCHEDULE('${ifcGuid()}',${t.owner},${s(name)},$,$,$,'${now}',$,$,$,$,${iso(starts[0])},$,.${type}.)`);
    if (t.project) add(`IFCRELDECLARES('${ifcGuid()}',${t.owner},$,$,${t.project},(${ws}))`);
    const ids = new Map<string, string>();
    for (const { it, row } of list) {
      const r = row ?? tasks.get(it.taskId)!;
      const tt = add(`IFCTASKTIME($,$,$,.WORKTIME.,${dur(Number(r.target_drtn_hr_cnt || 0))},${iso(it.plannedStart)},${iso(it.plannedFinish)},${iso(r.early_start_date)},${iso(r.early_end_date)},${iso(r.late_start_date)},${iso(r.late_end_date)},${r.free_float_hr_cnt ? dur(Number(r.free_float_hr_cnt)) : '$'},${r.total_float_hr_cnt ? dur(Number(r.total_float_hr_cnt)) : '$'},${Number(r.total_float_hr_cnt || 0) <= 0 && !r.act_end_date ? '.T.' : '.F.'},$,$,${iso(r.act_start_date)},${iso(r.act_end_date)},${r.remain_drtn_hr_cnt ? dur(Number(r.remain_drtn_hr_cnt)) : '$'},${r.phys_complete_pct ? Number(r.phys_complete_pct) / 100 : '$'})`);
      const pre = it.type === 'Demolish' ? 'DEMOLITION' : it.type === 'Temporary' ? 'NOTDEFINED' : 'CONSTRUCTION';
      ids.set(it.taskId, add(`IFCTASK('${ifcGuid()}',${t.owner},${s(it.name)},$,$,${s(it.id)},$,$,$,${r.task_type === 'TT_Mile' || r.task_type === 'TT_FinMile' ? '.T.' : '.F.'},$,${tt},.${pre}.)`));
    }
    if (ids.size) add(`IFCRELASSIGNSTOCONTROL('${ifcGuid()}',${t.owner},$,$,(${[...ids.values()].join(',')}),$,${ws})`);
    return ids;
  };
  const planned = schedule(rows(db, 'PROJECT').find((p) => p.proj_id === projId)?.proj_short_name ?? 'Schedule', 'PLANNED', items.map((it) => ({ it })));
  // logic between the exported tasks
  const SEQ: Record<string, string> = { PR_FS: 'FINISH_START', PR_SS: 'START_START', PR_FF: 'FINISH_FINISH', PR_SF: 'START_FINISH' };
  for (const r of rows(db, 'TASKPRED')) {
    const a = planned.get(r.pred_task_id), b = planned.get(r.task_id);
    if (!a || !b) continue;
    const lagH = Number(r.lag_hr_cnt || 0);
    const lag = lagH ? add(`IFCLAGTIME($,$,$,IFCDURATION(${dur(lagH)}),.WORKTIME.)`) : '$';
    add(`IFCRELSEQUENCE('${ifcGuid()}',${t.owner},$,$,${a},${b},${lag},.${SEQ[r.pred_type] ?? 'FINISH_START'}.,$)`);
  }
  // elements the tasks build (Bonsai: one assignment per element, the task as output)
  let n = 0;
  for (const it of items) for (const e of new Set(it.expressIds)) { add(`IFCRELASSIGNSTOPRODUCT('${ifcGuid()}',${t.owner},$,$,(${planned.get(it.taskId)}),$,#${e})`); n++; }
  // baselines: a BASELINE schedule each, its tasks tied to the planned ones
  const proj = rows(db, 'PROJECT').find((p) => p.proj_id === projId)!;
  for (const name of baselines) {
    const bl = baselineOf(db, proj, name);
    if (!bl) throw new Error(`No baseline "${name}".`);
    const list = items.flatMap((it) => { const row = bl.tasks.get(it.id); return row ? [{ it: { ...it, plannedStart: row.act_start_date || row.early_start_date || row.target_start_date || '', plannedFinish: row.act_end_date || row.early_end_date || row.target_end_date || '' }, row }] : []; });
    const ids = schedule(bl.name, 'BASELINE', list);
    for (const [taskId, id] of ids) add(`IFCRELDEFINESBYOBJECT('${ifcGuid()}',${t.owner},$,$,(${id}),${planned.get(taskId)})`);
  }
  return { text: t.head + L.join(t.nl) + t.nl + t.tail, tasks: planned.size, links: n };
}

// ── imports ────────────────────────────────────────────────────────────────────────────────────────────────────────
export interface Imported4d { source: string; tasks: { name: string; id: string; start?: string; finish?: string; actualStart?: string; actualFinish?: string; type?: string; attached?: string }[]; links: { task: string; guids?: string[]; expressIds?: number[]; names?: string[] }[]; sets?: { name: string; conditions: { category: string; property: string; value: string; or: boolean }[] }[]; notes: string[] }

/** IFC 4D in both styles: Bonsai/IFC4 (IfcRelAssignsToProduct: the task outputs the element) and SYNCHRO/IFC2X3
 *  (IfcRelAssignsToProcess: elements assigned to the task). SYNCHRO renames elements "<name>_(#<id in the source
 *  IFC>)" and regenerates GlobalIds, so those links come back as express ids of the design model. */
export function parseIfc4d(ifcText: string): Imported4d {
  const ent = new Map<number, { type: string; args: string }>();
  for (const m of ifcText.matchAll(/^#(\d+)\s*=\s*([A-Z0-9_]+)\s*\(([\s\S]*?)\);\s*$/gm)) ent.set(Number(m[1]), { type: m[2].toUpperCase(), args: m[3] });
  const ref = (v: unknown) => (v && typeof v === 'object' && 'ref' in (v as object) ? (v as { ref: number }).ref : undefined);
  const str = (v: unknown) => (typeof v === 'string' ? v : '');
  const tasks = new Map<number, Imported4d['tasks'][number]>();
  const timeOf = new Map<number, number>();
  for (const [id, e] of ent) {
    if (e.type !== 'IFCTASK') continue;
    const a = parseArgs(e.args);
    // IFC4: ..., Identification(5), LongDescription, Status, WorkMethod, IsMilestone, Priority, TaskTime(11); IFC2X3: ..., TaskId(5)
    tasks.set(id, { name: str(a[2]), id: str(a[5]) || str(a[2]) });
    const tt = ref(a[11]); if (tt) timeOf.set(id, tt);
  }
  const dateOf = (v: unknown): string | undefined => {
    if (typeof v === 'string') return v.replace('T', ' ').slice(0, 16);
    const r = ref(v); const e = r != null ? ent.get(r) : undefined;
    if (e?.type === 'IFCDATEANDTIME') { const a = parseArgs(e.args); const d = ent.get(ref(a[0]) ?? -1), t = ent.get(ref(a[1]) ?? -1); if (!d) return undefined; const [dd, mm, yy] = parseArgs(d.args) as number[]; const tm = t ? (parseArgs(t.args) as number[]) : [0, 0]; return `${yy}-${String(mm).padStart(2, '0')}-${String(dd).padStart(2, '0')} ${String(tm[0] ?? 0).padStart(2, '0')}:${String(tm[1] ?? 0).padStart(2, '0')}`; }
    return undefined;
  };
  for (const [taskId, tt] of timeOf) { const e = ent.get(tt); if (e?.type !== 'IFCTASKTIME') continue; const a = parseArgs(e.args); const t = tasks.get(taskId)!; t.start = dateOf(a[5]); t.finish = dateOf(a[6]); t.actualStart = dateOf(a[16]); t.actualFinish = dateOf(a[17]); }
  // IFC2X3 SYNCHRO: IfcRelAssignsTasks(..., RelatedObjects(4)=(task), ..., RelatingControl(6)=work schedule, TimeForTask(7)=IfcScheduleTimeControl)
  for (const e of ent.values()) {
    if (e.type !== 'IFCRELASSIGNSTASKS') continue;
    const a = parseArgs(e.args); const tc = ent.get(ref(a[7]) ?? -1);
    if (!tc) continue;
    const c = parseArgs(tc.args);
    for (const r of (Array.isArray(a[4]) ? a[4] : [])) { const t = tasks.get(ref(r) ?? -1); if (t) { t.start = dateOf(c[8]) ?? t.start; t.finish = dateOf(c[12]) ?? t.finish; t.actualStart = dateOf(c[5]); t.actualFinish = dateOf(c[9]); } }
  }
  const productGuid = (id: number) => { const e = ent.get(id); if (!e) return null; const a = parseArgs(e.args); return { guid: str(a[0]), name: str(a[2]) }; };
  const links: Imported4d['links'] = [];
  const notes: string[] = [];
  let renamed = 0;
  const linkOf = new Map<number, Imported4d['links'][number]>();
  const linkFor = (task: number) => { let l = linkOf.get(task); if (!l) { l = { task: tasks.get(task)!.id, guids: [], expressIds: [], names: [] }; linkOf.set(task, l); links.push(l); } return l; };
  const addProduct = (task: number, product: number) => {
    const p = productGuid(product); if (!p || !tasks.has(task)) return;
    const m = /_\(#(\d+)\)$/.exec(p.name);
    const l = linkFor(task);
    if (m) { l.expressIds!.push(Number(m[1])); renamed++; } else l.guids!.push(p.guid);
  };
  for (const e of ent.values()) {
    if (e.type === 'IFCRELASSIGNSTOPRODUCT') { const a = parseArgs(e.args); const prod = ref(a[6]); for (const r of (Array.isArray(a[4]) ? a[4] : [])) { const t = ref(r); if (t != null && prod != null) addProduct(t, prod); } }
    if (e.type === 'IFCRELASSIGNSTOPROCESS') { const a = parseArgs(e.args); const task = ref(a[6]); if (task == null || !tasks.has(task)) continue; for (const r of (Array.isArray(a[4]) ? a[4] : [])) { const p = ref(r); if (p != null && !tasks.has(p)) addProduct(task, p); } }
  }
  if (renamed) notes.push(`${renamed} elements were renamed by SYNCHRO ("name_(#id)"): they are matched to the design model by that id, which holds only for the exact source IFC SYNCHRO was given.`);
  return { source: 'ifc4d', tasks: [...tasks.values()], links, notes };
}

/** Navisworks search-set XML: each set's conditions (category, property, value; bit 64 of flags starts an OR group). */
export function parseSearchSets(text: string): Imported4d {
  const sets: NonNullable<Imported4d['sets']> = [];
  for (const m of text.matchAll(/<selectionset\b[^>]*\bname="([^"]*)"[^>]*>([\s\S]*?)<\/selectionset>/g)) {
    const conditions = [...m[2].matchAll(/<condition\b([^>]*)>([\s\S]*?)<\/condition>/g)].map((c) => {
      const flags = Number(/flags="(\d+)"/.exec(c[1])?.[1] ?? 0);
      const name = (tag: string) => { const x = new RegExp(`<${tag}>\\s*<name[^>]*>([\\s\\S]*?)<\\/name>`).exec(c[2]); return x ? unxml(x[1]) : ''; };
      const value = /<data[^>]*>([\s\S]*?)<\/data>/.exec(c[2]);
      return { category: name('category'), property: name('property'), value: value ? unxml(value[1]) : '', or: (flags & 64) !== 0 };
    });
    sets.push({ name: unxml(m[1]), conditions });
  }
  return { source: 'search_sets', tasks: [], links: [], sets, notes: sets.length ? [] : ['No <selectionset> found.'] };
}
const unxml = (s: string) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');

/** TimeLiner CSV (or the task grid copied to Excel and saved as CSV): Name, Planned/Actual Start/End, Task Type,
 *  Display ID, and an "Attached" column (Sets-><name>) where present. */
export function parseTimelinerCsv(text: string): Imported4d {
  const lines = text.replace(/^﻿/, '').split(/\r?\n/).filter((l) => l.trim());
  const cells = (l: string) => { const out: string[] = []; let cur = '', q = false; for (let i = 0; i < l.length; i++) { const c = l[i]; if (q) { if (c === '"' && l[i + 1] === '"') { cur += '"'; i++; } else if (c === '"') q = false; else cur += c; } else if (c === '"') q = true; else if (c === ',' || c === '\t') { out.push(cur); cur = ''; } else cur += c; } out.push(cur); return out; };
  const head = cells(lines[0] ?? '').map((h) => h.trim().toLowerCase());
  const col = (...names: string[]) => head.findIndex((h) => names.includes(h));
  const iName = col('name'), iId = col('display id', 'uniqueid', 'id'), iPs = col('planned start'), iPf = col('planned end', 'planned finish'), iAs = col('actual start'), iAf = col('actual end', 'actual finish'), iType = col('task type'), iAtt = col('attached');
  if (iName < 0) return { source: 'timeliner_csv', tasks: [], links: [], notes: ['No "Name" column: not a TimeLiner task list.'] };
  const date = (s?: string) => { if (!s?.trim()) return undefined; const iso = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2}))?/.exec(s.trim()); if (iso) return `${iso[1]}-${iso[2]}-${iso[3]} ${iso[4] ?? '08'}:${iso[5] ?? '00'}`; const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:\s+(\d{1,2}):(\d{2}))?/.exec(s.trim()); if (m) return `${m[3]}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')} ${(m[4] ?? '08').padStart(2, '0')}:${m[5] ?? '00'}`; const d = Date.parse(s); return Number.isNaN(d) ? undefined : new Date(d).toISOString().slice(0, 16).replace('T', ' '); };
  const tasks = lines.slice(1).map(cells).filter((c) => c[iName]?.trim()).map((c) => ({ name: c[iName].trim(), id: (iId >= 0 ? c[iId]?.trim() : '') || c[iName].trim(), start: date(c[iPs]), finish: date(c[iPf]), actualStart: date(c[iAs]), actualFinish: date(c[iAf]), type: iType >= 0 ? c[iType]?.trim() : undefined, attached: iAtt >= 0 ? c[iAtt]?.replace(/^Sets->/i, '').trim() || undefined : undefined }));
  return { source: 'timeliner_csv', tasks, links: [], notes: [] };
}

/** Elements matching a search set's conditions against the model (Navisworks semantics: AND within a group, a
 *  condition with the OR bit starts a new group). Category names a property set, or "Item"/"IFC" for attributes. */
export function resolveSet(ix: IfcIndex, set: NonNullable<Imported4d['sets']>[number]): string[] {
  const groups: (typeof set.conditions)[] = [];
  for (const c of set.conditions) { if (c.or || !groups.length) groups.push([]); groups[groups.length - 1].push(c); }
  const val = (e: IfcIndex['elements'][number], cat: string, prop: string) => {
    const p = prop.toLowerCase();
    if (/^(item|ifc|element)$/i.test(cat) || !cat) { const attr: Record<string, string | undefined> = { name: e.name, type: e.typeName, objecttype: e.typeName, globalid: e.guid, guid: e.guid, ifcguid: e.guid, layer: e.storey, material: e.material, class: e.ifcClass }; if (p in attr) return attr[p]; }
    const v = e.props[`${cat}.${prop}`] ?? Object.entries(e.props).find(([k]) => k.toLowerCase() === `${cat}.${prop}`.toLowerCase())?.[1];
    return v == null ? undefined : String(v);
  };
  return ix.elements.filter((e) => groups.some((g) => g.every((c) => (val(e, c.category, c.property) ?? '').toLowerCase() === c.value.toLowerCase()))).map((e) => e.guid);
}

export { decodeStepString };

/** The TimeLiner task grid copied to Excel (first sheet), as the same CSV: dates written as YYYY-MM-DD HH:mm. */
export function sheetToCsv(rows: unknown[][]): string {
  const cell = (v: unknown) => { const s = v instanceof Date ? v.toISOString().slice(0, 16).replace('T', ' ') : String(v ?? ''); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  return rows.map((r) => r.map(cell).join(',')).join('\n');
}
