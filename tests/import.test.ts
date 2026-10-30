import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseXer } from '../core/xer/parse.ts';
import { importIntoDb, defaultPlan, deleteProject } from '../core/xer/import.ts';
import { emptyDb, KEYS, refTarget, type Db } from '../core/db.ts';
import { samples } from './helpers.ts';

const load = (name: string) => parseXer(samples().find((s) => s.name === name)!.bytes).db;

/** Every reference in db resolves (ignoring EPS parents and refs to tables never imported). */
function danglingRefs(db: Db): string[] {
  const out: string[] = [];
  for (const t of Object.values(db.tables)) for (const f of t.fields) {
    const target = refTarget(f, t.name);
    if (!target || !db.tables[target]) continue;
    const keys = new Set(db.tables[target].rows.map((r) => r[KEYS[target]]));
    for (const r of t.rows) if (r[f] && !keys.has(r[f]) && !(f === 'parent_wbs_id' && r.proj_node_flag === 'Y')) out.push(`${t.name}.${f}=${r[f]}`);
  }
  return out;
}

test('importing the same file twice creates two projects with consistent references', () => {
  const db = emptyDb();
  const src = load('cairo festival city.xer');
  const a = importIntoDb(db, src, defaultPlan(src));
  const b = importIntoDb(db, load('cairo festival city.xer'), defaultPlan(src));
  assert.equal(db.tables.PROJECT.rows.length, 2);
  assert.notEqual(a.projIds[0], b.projIds[0]);
  const tasks = db.tables.TASK.rows;
  assert.equal(tasks.length, 2 * src.tables.TASK.rows.length);
  assert.equal(new Set(tasks.map((t) => t.task_id)).size, tasks.length, 'no key collisions');
  assert.deepEqual(danglingRefs(db).filter((x) => !x.startsWith('TASKPRED.pred_proj')), []);
  assert.equal(db.tables.CALENDAR.rows.filter((c) => !c.proj_id).length, src.tables.CALENDAR.rows.filter((c) => !c.proj_id).length, 'global calendars matched by name, not duplicated');
});

test('replace keeps project id and swaps content', () => {
  const db = emptyDb();
  const src = load('cairo festival city.xer');
  const { projIds: [pid] } = importIntoDb(db, src, defaultPlan(src));
  const other = load('cleopatra elmohandesen.xer');
  importIntoDb(db, other, { projects: [{ srcProjId: other.tables.PROJECT.rows[0].proj_id, action: 'replace', targetProjId: pid }] });
  assert.deepEqual(db.tables.PROJECT.rows.map((p) => p.proj_id), [pid]);
  assert.equal(db.tables.TASK.rows.length, other.tables.TASK.rows.length);
  assert.ok(db.tables.TASK.rows.every((t) => t.proj_id === pid));
});

test('update keeps ids of matching activities', () => {
  const db = emptyDb();
  const src = load('cairo festival city.xer');
  const { projIds: [pid] } = importIntoDb(db, src, defaultPlan(src));
  const before = new Map(db.tables.TASK.rows.map((t) => [t.task_code, t.task_id]));
  const again = load('cairo festival city.xer');
  importIntoDb(db, again, { projects: [{ srcProjId: again.tables.PROJECT.rows[0].proj_id, action: 'update', targetProjId: pid }] });
  for (const t of db.tables.TASK.rows) assert.equal(t.task_id, before.get(t.task_code));
});

test('deleteProject removes its rows', () => {
  const db = emptyDb();
  const src = load('cairo festival city.xer');
  const { projIds: [pid] } = importIntoDb(db, src, defaultPlan(src));
  deleteProject(db, pid);
  assert.equal(db.tables.TASK.rows.length, 0);
  assert.equal(db.tables.TASKPRED.rows.length, 0);
  assert.equal(db.tables.PROJECT.rows.length, 0);
});

test('all samples import without throwing', () => {
  const db = emptyDb();
  for (const s of samples()) {
    const src = parseXer(s.bytes).db;
    importIntoDb(db, src, defaultPlan(src));
  }
  assert.ok(db.tables.PROJECT.rows.length > 40);
});

test('renumbered resources, OBS and shifts keep their references (primary resource, pobs_id, shift_id)', () => {
  const db = emptyDb();
  const src = load('cairo festival city.xer');
  importIntoDb(db, src, defaultPlan(src)); // takes the low ids, so the second file's rows are renumbered
  const text = (name: string, fields: string[], rs: string[][]) => ({ name, fields, rows: rs.map((r) => Object.fromEntries(fields.map((f, i) => [f, r[i]]))) });
  const two = load('cairo festival city.xer');
  two.tables.SHIFT = text('SHIFT', ['shift_id', 'shift_name'], [['900', 'Night']]);
  two.tables.POBS = text('POBS', ['pobs_id', 'pobs_name'], [['800', 'Site team']]);
  const r0 = two.tables.RSRC.rows[0];
  Object.assign(r0, { shift_id: '900', pobs_id: '800', rsrc_name: 'Renamed so it is not matched' , rsrc_short_name: 'NEW-RSRC' });
  const t0 = two.tables.TASK.rows[0];
  t0.rsrc_id = r0.rsrc_id;
  if (!two.tables.TASK.fields.includes('rsrc_id')) two.tables.TASK.fields.push('rsrc_id');
  for (const f of ['shift_id', 'pobs_id']) if (!two.tables.RSRC.fields.includes(f)) two.tables.RSRC.fields.push(f);
  const res = importIntoDb(db, two, defaultPlan(two));
  const newR = db.tables.RSRC.rows.find((r) => r.rsrc_short_name === 'NEW-RSRC')!;
  const newT = db.tables.TASK.rows.find((t) => t.task_id === res.map.TASK[t0.task_id])!;
  assert.equal(newT.rsrc_id, newR.rsrc_id);
  assert.equal(newR.shift_id, db.tables.SHIFT.rows.find((r) => r.shift_name === 'Night')!.shift_id);
  assert.equal(newR.pobs_id, db.tables.POBS.rows.find((r) => r.pobs_name === 'Site team')!.pobs_id);
});

// P6's Import into an existing project: Update Existing Project, Replace Existing Project, Add Into Existing Project
const fresh = () => load('cairo festival city.xer');
/** The file as a subcontractor sends it next week: one activity renamed and longer, one gone, one new. */
function nextWeek(): { src: Db; renamed: string; gone: string } {
  const src = fresh(), T = src.tables.TASK.rows;
  const [a, b] = T.filter((t) => t.task_type === 'TT_Task');
  a.task_name = 'Renamed by the sub'; a.target_drtn_hr_cnt = String(Number(a.target_drtn_hr_cnt) + 80);
  src.tables.TASK.rows = T.filter((t) => t !== b);
  src.tables.TASKPRED.rows = src.tables.TASKPRED.rows.filter((r) => r.task_id !== b.task_id && r.pred_task_id !== b.task_id);
  for (const n of ['TASKRSRC', 'TASKACTV']) if (src.tables[n]) src.tables[n].rows = src.tables[n].rows.filter((r) => r.task_id !== b.task_id);
  src.tables.TASK.rows.push({ ...a, task_id: '99999901', task_code: 'NEW-1', task_name: 'Added by the sub' });
  return { src, renamed: a.task_code, gone: b.task_code };
}
const tasksOf = (db: Db, pid: string) => db.tables.TASK.rows.filter((t) => t.proj_id === pid);
const plan1 = (src: Db, action: 'update' | 'replace' | 'add_into', targetProjId: string, extra: object = {}) => ({ projects: [{ srcProjId: src.tables.PROJECT.rows[0].proj_id, action, targetProjId }], ...extra });

test('update existing project: matched activities updated, new ones added, the rest kept; nothing duplicated week after week', () => {
  const db = emptyDb();
  const { projIds: [pid] } = importIntoDb(db, fresh(), defaultPlan(fresh()));
  const before = tasksOf(db, pid).length, ids = new Map(tasksOf(db, pid).map((t) => [t.task_code, t.task_id]));
  const tables = ['TASKPRED', 'TASKRSRC', 'TASKACTV', 'CALENDAR', 'ACTVTYPE', 'ACTVCODE', 'PROJWBS', 'UDFVALUE', 'RSRC', 'UDFTYPE'];
  let after1: Record<string, number> = {};
  for (let week = 0; week < 3; week++) {
    const { src, renamed, gone } = nextWeek();
    const res = importIntoDb(db, src, plan1(src, 'update', pid));
    assert.deepEqual(res.projIds, [pid]);
    assert.equal(tasksOf(db, pid).length, before + 1, 'one new activity; the one the file lacks is kept');
    const r = tasksOf(db, pid).find((t) => t.task_code === renamed)!;
    assert.equal(r.task_name, 'Renamed by the sub');
    assert.equal(r.task_id, ids.get(renamed), 'an updated activity keeps its identity');
    assert.ok(tasksOf(db, pid).some((t) => t.task_code === gone));
    assert.equal(tasksOf(db, pid).filter((t) => t.task_code === 'NEW-1').length, 1);
    const now = Object.fromEntries(tables.map((n) => [n, db.tables[n]?.rows.length ?? 0]));
    if (week === 0) after1 = now; else assert.deepEqual(now, after1, 'the same file again changes no counts: everything matched');
  }
  assert.equal(db.tables.PROJECT.rows.length, 1);
  assert.deepEqual(danglingRefs(db).filter((x) => !x.startsWith('TASKPRED.pred_proj')), []);
});

test('update: keep existing leaves matched activities alone; remove_missing takes out what the file lacks, with its rows', () => {
  const db = emptyDb();
  const { projIds: [pid] } = importIntoDb(db, fresh(), defaultPlan(fresh()));
  let w = nextWeek();
  importIntoDb(db, w.src, plan1(w.src, 'update', pid, { data: { TASK: 'keep' } }));
  assert.notEqual(tasksOf(db, pid).find((t) => t.task_code === w.renamed)!.task_name, 'Renamed by the sub');
  assert.ok(tasksOf(db, pid).some((t) => t.task_code === 'NEW-1'), 'keep existing still inserts what is new');
  w = nextWeek();
  const goneId = tasksOf(db, pid).find((t) => t.task_code === w.gone)!.task_id;
  const res = importIntoDb(db, w.src, plan1(w.src, 'update', pid, { data: { TASK: 'remove_missing', TASKPRED: 'remove_missing' } }));
  assert.ok(!tasksOf(db, pid).some((t) => t.task_code === w.gone));
  assert.ok(!db.tables.TASKPRED.rows.some((r) => r.task_id === goneId || r.pred_task_id === goneId));
  assert.ok(!(db.tables.TASKRSRC?.rows ?? []).some((r) => r.task_id === goneId));
  assert.equal(res.counts.TASK.removed, 1);
  assert.equal(tasksOf(db, pid).length, w.src.tables.TASK.rows.length);
  assert.deepEqual(danglingRefs(db).filter((x) => !x.startsWith('TASKPRED.pred_proj')), []);
});

test('replace and update keep relationships from other projects; replace reports the ones whose activity is gone', () => {
  const db = emptyDb();
  const { projIds: [pid] } = importIntoDb(db, fresh(), defaultPlan(fresh()));
  const { projIds: [qid], findings } = importIntoDb(db, fresh(), defaultPlan(fresh()));
  assert.ok(findings.some((f) => f.code === 'IMPORT_ID_RENAMED'), 'a second project of the same ID gets -1');
  assert.equal(new Set(db.tables.PROJECT.rows.map((p) => p.proj_short_name)).size, 2);
  const w = nextWeek();
  const q = tasksOf(db, qid)[0], keep = tasksOf(db, pid).find((t) => t.task_code === w.renamed)!, lose = tasksOf(db, pid).find((t) => t.task_code === w.gone)!;
  const link = (pred: string, succ: string, id: string) => ({ task_pred_id: id, task_id: succ, pred_task_id: pred, proj_id: qid, pred_proj_id: pid, pred_type: 'PR_FS', lag_hr_cnt: '0' });
  db.tables.TASKPRED.rows.push(link(keep.task_id, q.task_id, '88888801'), link(lose.task_id, q.task_id, '88888802'));
  importIntoDb(db, w.src, plan1(w.src, 'update', pid));
  assert.equal(db.tables.TASKPRED.rows.filter((r) => r.task_pred_id.startsWith('8888880')).length, 2);
  const r = importIntoDb(db, w.src, plan1(w.src, 'replace', pid));
  assert.ok(db.tables.TASKPRED.rows.some((x) => x.task_pred_id === '88888801' && x.pred_task_id === keep.task_id), 'kept: same Activity ID, same identity');
  assert.ok(!db.tables.TASKPRED.rows.some((x) => x.task_pred_id === '88888802'));
  assert.ok(r.findings.some((f) => f.code === 'IMPORT_LINK_DROPPED' && f.message.includes(w.gone)));
  assert.equal(db.tables.PROJECT.rows.find((p) => p.proj_id === pid)!.proj_short_name, fresh().tables.PROJECT.rows[0].proj_short_name);
  assert.equal(tasksOf(db, pid).length, w.src.tables.TASK.rows.length);
});

test('add into existing project: the file becomes a WBS node; Activity IDs already used get -1', () => {
  const db = emptyDb();
  const { projIds: [pid] } = importIntoDb(db, fresh(), defaultPlan(fresh()));
  const n = tasksOf(db, pid).length, root = db.tables.PROJWBS.rows.find((w) => w.proj_id === pid && w.proj_node_flag === 'Y')!;
  const src = fresh();
  const res = importIntoDb(db, src, plan1(src, 'add_into', pid));
  assert.deepEqual(res.projIds, [pid]);
  assert.equal(db.tables.PROJECT.rows.length, 1);
  assert.equal(tasksOf(db, pid).length, 2 * n);
  assert.equal(new Set(tasksOf(db, pid).map((t) => t.task_code)).size, 2 * n, 'Activity IDs unique in the project');
  assert.equal(db.tables.PROJWBS.rows.filter((w) => w.proj_id === pid && w.proj_node_flag === 'Y').length, 1);
  assert.ok(db.tables.PROJWBS.rows.some((w) => w.proj_id === pid && w.parent_wbs_id === root.wbs_id && w.wbs_short_name === src.tables.PROJWBS.rows.find((x) => x.proj_node_flag === 'Y')!.wbs_short_name));
  assert.deepEqual(danglingRefs(db).filter((x) => !x.startsWith('TASKPRED.pred_proj')), []);
});

test('do not import: resources the project lacks are left out with their assignments; a baseline cannot be the target', () => {
  const db = emptyDb();
  const { projIds: [pid] } = importIntoDb(db, fresh(), defaultPlan(fresh()));
  const src = fresh();
  const r0 = src.tables.RSRC.rows.find((r) => src.tables.TASKRSRC.rows.some((a) => a.rsrc_id === r.rsrc_id))!;
  r0.rsrc_short_name = 'NOT-HERE';
  const rsrc = db.tables.RSRC.rows.length;
  const res = importIntoDb(db, src, { projects: [{ srcProjId: src.tables.PROJECT.rows[0].proj_id, action: 'new' }], dict: { RSRC: 'skip' } });
  assert.equal(db.tables.RSRC.rows.length, rsrc);
  assert.ok(!db.tables.TASKRSRC.rows.some((a) => a.proj_id === res.projIds[0] && !db.tables.RSRC.rows.some((r) => r.rsrc_id === a.rsrc_id)));
  assert.ok(res.counts.TASKRSRC.skipped > 0);
  db.tables.PROJECT.rows.push({ ...db.tables.PROJECT.rows[0], proj_id: '777', proj_short_name: 'BL', _baseline_of: pid });
  assert.throws(() => importIntoDb(db, fresh(), plan1(fresh(), 'update', '777')), /baseline/);
});
