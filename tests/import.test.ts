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
