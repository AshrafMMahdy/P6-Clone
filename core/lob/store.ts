// The LOB model inside the XER, read by both programs. Real P6 sees two ordinary things: a project UDF "Schedule Method"
// = "LOB (P6 clone)" and a project notebook topic "LOB model (P6 clone)". The notebook holds the model as base64 JSON
// with its SHA-256 (base64 survives P6 rewriting memos as HTML), split into numbered topics above 32 KB. A damaged or
// missing model is rebuilt from the activities' Location / Trade codes and LOB UDFs, saying what could not be.
import { rows, type Db } from '../db.ts';
import { applyOps } from '../project/ops.ts';
import { activityId, LOB_CODES, LOB_UDF } from './expand.ts';
import { locationDurations } from './edit.ts';
import { fromBase64, sha256Hex, toBase64 } from './codec.ts';
import type { LobLocation, LobModel, LobTask } from './model.ts';

export const LOB_FLAG = { udf: 'Schedule Method', value: 'LOB (P6 clone)' } as const;
export const LOB_TOPIC = 'LOB model (P6 clone)';
const PART = 32 * 1024;
const sha = sha256Hex;

/** The operations that write the model (flag and notebook parts; stale parts removed). One undoable change with the rest. */
export function saveLobOps(db: Db, projId: string, m: LobModel): unknown[] {
  const P = rows(db, 'PROJECT').find((p) => p.proj_id === projId)!.proj_short_name;
  const ops: unknown[] = [];
  if (!rows(db, 'UDFTYPE').some((u) => u.table_name === 'PROJECT' && u.udf_type_label === LOB_FLAG.udf)) ops.push({ op: 'add_udf', name: LOB_FLAG.udf, subject: 'project', data_type: 'text' });
  ops.push({ op: 'set_udf', udf: LOB_FLAG.udf, value: LOB_FLAG.value, project: P });
  const json = JSON.stringify(m), b64 = toBase64(json), hash = sha(json);
  const parts: string[] = [];
  for (let i = 0; i < b64.length; i += PART) parts.push(b64.slice(i, i + PART));
  const n = Math.max(1, parts.length);
  const topic = (k: number) => (n === 1 ? LOB_TOPIC : `${LOB_TOPIC} ${k}/${n}`);
  parts.forEach((p, k) => ops.push({ op: 'set_notebook', project: P, topic: topic(k + 1), text: `P6CLONE-LOB v1 ${k + 1}/${n} ${hash} ${p}` }));
  // topics of an earlier, longer (or shorter) save
  for (const t of lobTopics(db, projId)) if (![...Array(n).keys()].some((k) => topic(k + 1) === t)) ops.push({ op: 'set_notebook', project: P, topic: t, text: '' });
  return ops;
}
export function saveLobModel(db: Db, projId: string, m: LobModel, o: { hoursPerDay: number }): void {
  const r = applyOps(db, saveLobOps(db, projId, m), { hoursPerDay: o.hoursPerDay });
  if (!r.ok) throw new Error(r.error!.message);
}

function lobTopics(db: Db, projId: string): string[] {
  const root = rows(db, 'PROJWBS').find((w) => w.proj_id === projId && w.proj_node_flag === 'Y');
  const ids = new Set(rows(db, 'WBSMEMO').filter((m) => m.wbs_id === root?.wbs_id).map((m) => m.memo_type_id));
  return rows(db, 'MEMOTYPE').filter((t) => ids.has(t.memo_type_id) && t.memo_type.startsWith(LOB_TOPIC)).map((t) => t.memo_type);
}
/** Plain text of a memo, whatever HTML P6 wrapped it in. */
const plain = (html: string) => html.replace(/<[^>]*>/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&');

export const isLobProject = (db: Db, projId: string) => {
  const u = rows(db, 'UDFTYPE').find((x) => x.table_name === 'PROJECT' && x.udf_type_label === LOB_FLAG.udf);
  return !!u && rows(db, 'UDFVALUE').some((v) => v.udf_type_id === u.udf_type_id && v.fk_id === projId && v.udf_text === LOB_FLAG.value);
};

/** The model of an LOB project from its notebook; null with the reason when it is missing or damaged. */
export function readLobNotebook(db: Db, projId: string): { model: LobModel | null; problem?: string } {
  const root = rows(db, 'PROJWBS').find((w) => w.proj_id === projId && w.proj_node_flag === 'Y');
  const topics = new Map(rows(db, 'MEMOTYPE').map((t) => [t.memo_type_id, t.memo_type]));
  const texts = rows(db, 'WBSMEMO').filter((m) => m.wbs_id === root?.wbs_id && (topics.get(m.memo_type_id) ?? '').startsWith(LOB_TOPIC)).map((m) => plain(m.wbs_memo ?? ''));
  if (!texts.length) return { model: null, problem: `no "${LOB_TOPIC}" notebook` };
  const parts: { k: number; n: number; hash: string; data: string }[] = [];
  for (const t of texts) { const x = /P6CLONE-LOB v1 (\d+)\/(\d+) ([0-9a-f]{64}) ([A-Za-z0-9+/=\s]*)/.exec(t); if (x) parts.push({ k: Number(x[1]), n: Number(x[2]), hash: x[3], data: x[4].replace(/\s+/g, '') }); }
  if (!parts.length) return { model: null, problem: 'the notebook holds no LOB model (it was edited)' };
  const n = parts[0].n, hash = parts[0].hash;
  const ordered = [...Array(n).keys()].map((k) => parts.find((p) => p.k === k + 1 && p.hash === hash));
  if (ordered.some((p) => !p)) return { model: null, problem: `the notebook has ${parts.length} of its ${n} parts` };
  const json = fromBase64(ordered.map((p) => p!.data).join(''));
  if (sha(json) !== hash) return { model: null, problem: 'the notebook was altered (its checksum does not match)' };
  try { return { model: JSON.parse(json) as LobModel }; } catch { return { model: null, problem: 'the notebook does not hold valid JSON' }; }
}

/** What the activities themselves say about the model: locations from the Location codes, tasks from the LOB UDFs.
 *  Logic between trades, segments, factors and takt cannot be recovered this way, and the answer says so. */
export function rebuildFromActivities(db: Db, projId: string): { model: LobModel; lost: string[] } {
  const P = rows(db, 'PROJECT').find((p) => p.proj_id === projId)!.proj_short_name;
  const udf = (label: string) => rows(db, 'UDFTYPE').find((u) => u.table_name === 'TASK' && u.udf_type_label === label)?.udf_type_id;
  const val = new Map<string, Map<string, { text?: string; num?: number }>>();
  for (const [k, label] of Object.entries(LOB_UDF)) { const id = udf(label); const m = new Map<string, { text?: string; num?: number }>(); for (const v of rows(db, 'UDFVALUE')) if (v.udf_type_id === id) m.set(v.fk_id, { text: v.udf_text, num: v.udf_number ? Number(v.udf_number) : undefined }); val.set(k, m); }
  const ctype = (name: string) => rows(db, 'ACTVTYPE').find((t) => t.actv_code_type === name)?.actv_code_type_id;
  const lt = ctype(LOB_CODES.location), tt = ctype(LOB_CODES.trade);
  const codes = new Map(rows(db, 'ACTVCODE').map((c) => [c.actv_code_id, c]));
  const assigned = (taskId: string, type?: string) => rows(db, 'TASKACTV').filter((a) => a.task_id === taskId && a.actv_code_type_id === type).map((a) => codes.get(a.actv_code_id)).find(Boolean);
  // the location tree: every Location value, its level its depth
  const all = rows(db, 'ACTVCODE').filter((c) => c.actv_code_type_id === lt);
  const byId = new Map(all.map((c) => [c.actv_code_id, c]));
  const depth = (c: (typeof all)[number]): number => { let d = 1; for (let p = byId.get(c.parent_actv_code_id); p; p = byId.get(p.parent_actv_code_id)) d++; return d; };
  const locations: LobLocation[] = all.map((c) => ({ code: c.short_name, name: c.actv_code_name || c.short_name, level: depth(c), parent: byId.get(c.parent_actv_code_id)?.short_name ?? null }));
  const levels = [...Array(Math.max(1, ...locations.map((l) => l.level))).keys()].map((k) => `Level ${k + 1}`);
  const tasks = new Map<string, LobTask>();
  const acts = rows(db, 'TASK').filter((t) => t.proj_id === projId && val.get('task')!.get(t.task_id)?.text).sort((a, b) => (a.early_start_date || a.target_start_date || '').localeCompare(b.early_start_date || b.target_start_date || ''));
  for (const a of acts) {
    const code = val.get('task')!.get(a.task_id)!.text!, loc = assigned(a.task_id, lt)?.short_name;
    if (!loc) continue;
    const level = locations.find((l) => l.code === loc)?.level ?? 1;
    const t = tasks.get(code) ?? tasks.set(code, { code, name: a.task_name.split(',')[0], trade: assigned(a.task_id, tt)?.short_name ?? code, precision: level, order: [], items: [{ name: a.task_name.split(',')[0], unit: '', consumption: val.get('consumption')!.get(a.task_id)?.num ?? 1, quantities: [] }], segments: [] }).get(code)!;
    t.order.push(loc);
    t.items[0].quantities.push({ location: loc, quantity: val.get('quantity')!.get(a.task_id)?.num ?? 0 });
    const crew = /(\d+)\s*×\s*(\d+)/.exec(val.get('crew')!.get(a.task_id)?.text ?? '');
    if (!t.segments.length) t.segments.push({ from: loc, to: loc, crews: crew ? Number(crew[1]) : 1, crewSize: crew ? Number(crew[2]) : 1, productivity: 1, driver: 'crew', timing: 'asap_paced' });
    t.segments[0].to = loc;
  }
  return { model: { version: 1, project: P, levels, locations, tasks: [...tasks.values()], links: [] }, lost: ['links between trades', 'segments (each task is one segment)', 'production factors', 'takt settings', 'location level names'] };
}

/** Where the activities no longer match the model (someone edited the XER in real P6): every difference, listed. */
export function reconcile(db: Db, projId: string, m: LobModel, o: { hoursPerDay: number }): string[] {
  const out: string[] = [];
  const udf = rows(db, 'UDFTYPE').find((u) => u.table_name === 'TASK' && u.udf_type_label === LOB_UDF.task)?.udf_type_id;
  const owned = new Map(rows(db, 'UDFVALUE').filter((v) => v.udf_type_id === udf && v.udf_text).map((v) => [v.fk_id, v.udf_text]));
  const acts = new Map(rows(db, 'TASK').filter((t) => t.proj_id === projId).map((t) => [t.task_code, t]));
  const want = new Map<string, number>();
  for (const t of m.tasks) for (const [c, d] of locationDurations(m, t)) want.set(activityId(t.code, c), d);
  for (const [code, d] of want) {
    const a = acts.get(code);
    if (!a) { out.push(`${code} is in the LOB plan but not in the file (deleted outside the clone).`); continue; }
    const have = Number(a.target_drtn_hr_cnt || 0) / o.hoursPerDay;
    if (Math.abs(have - d) > 0.01) out.push(`${code} lasts ${Math.round(have * 100) / 100} days in the file, ${Math.round(d * 100) / 100} in the LOB plan.`);
  }
  for (const [code, a] of acts) if (owned.has(a.task_id) && !want.has(code)) out.push(`${code} carries the LOB task ${owned.get(a.task_id)} but is not in the LOB plan (added outside the clone).`);
  return out;
}

/** The model of every LOB project in the file: from its notebook, else rebuilt, with what happened. */
export function loadLobModels(db: Db, sidecar?: Record<string, LobModel>): Map<string, { model: LobModel; from: 'notebook' | 'sidecar' | 'activities'; problems: string[] }> {
  const out = new Map<string, { model: LobModel; from: 'notebook' | 'sidecar' | 'activities'; problems: string[] }>();
  for (const p of rows(db, 'PROJECT')) {
    if (p._baseline_of || !isLobProject(db, p.proj_id)) continue;
    const nb = readLobNotebook(db, p.proj_id);
    if (nb.model) { out.set(p.proj_id, { model: nb.model, from: 'notebook', problems: [] }); continue; }
    const side = sidecar?.[p.proj_short_name];
    if (side) { out.set(p.proj_id, { model: side, from: 'sidecar', problems: [`${nb.problem}; the model was taken from the .lob.json beside the file`] }); continue; }
    const rb = rebuildFromActivities(db, p.proj_id);
    out.set(p.proj_id, { model: rb.model, from: 'activities', problems: [`${nb.problem}; the model was rebuilt from the activities, without ${rb.lost.join(', ')}`] });
  }
  return out;
}
