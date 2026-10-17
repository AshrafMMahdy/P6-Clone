import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseXer } from '../core/xer/parse.ts';
import { writeP6Xml, parseP6Xml } from '../core/xml/p6xml.ts';
import { importIntoDb, defaultPlan } from '../core/xer/import.ts';
import { saveBaseline, assignBaseline } from '../core/progress/baseline.ts';
import { emptyDb, rows, table, addField } from '../core/db.ts';
import { SAMPLES_DIR } from './helpers.ts';

const put = (db: ReturnType<typeof emptyDb>, t: string, r: Record<string, string>) => { const T = table(db, t); for (const f of Object.keys(r)) addField(T, f); T.rows.push(r); };

test('P6 XML carries project and resource codes, activity steps and baselines, with the requested version', () => {
  const db = parseXer(new Uint8Array(readFileSync(join(SAMPLES_DIR, 'cairo festival city.xer')))).db;
  const p = rows(db, 'PROJECT')[0], t = rows(db, 'TASK')[0], r = rows(db, 'RSRC')[0];
  put(db, 'PCATTYPE', { proj_catg_type_id: '900', proj_catg_type: 'Region', seq_num: '1', proj_catg_short_len: '10' });
  put(db, 'PCATVAL', { proj_catg_id: '901', proj_catg_type_id: '900', proj_catg_short_name: 'EG', proj_catg_name: 'Egypt', parent_proj_catg_id: '', seq_num: '1' });
  put(db, 'PROJPCAT', { proj_id: p.proj_id, proj_catg_type_id: '900', proj_catg_id: '901' });
  put(db, 'RCATTYPE', { rsrc_catg_type_id: '800', rsrc_catg_type: 'Trade', seq_num: '1', rsrc_catg_short_len: '10' });
  put(db, 'RCATVAL', { rsrc_catg_id: '801', rsrc_catg_type_id: '800', rsrc_catg_short_name: 'CRP', rsrc_catg_name: 'Carpentry', parent_rsrc_catg_id: '', seq_num: '1' });
  put(db, 'RSRCRCAT', { rsrc_id: r.rsrc_id, rsrc_catg_type_id: '800', rsrc_catg_id: '801' });
  put(db, 'TASKPROC', { proc_id: '700', task_id: t.task_id, proj_id: p.proj_id, seq_num: '10', proc_name: 'Set out', complete_flag: 'N', proc_wt: '2', complete_pct: '25', proc_descr: '' });
  assignBaseline(db, p.proj_id, saveBaseline(db, p.proj_id, 'BL1'));
  const xml = writeP6Xml(db, { projIds: [p.proj_id], version: '23.12' });
  assert.match(xml, /xmlns="http:\/\/xmlns\.oracle\.com\/Primavera\/P6\/V23\.12\/API\/BusinessObjects"/);
  for (const tag of ['<ProjectCodeType>', '<ProjectCode>', '<ResourceCodeType>', '<ResourceCode>', '<ActivityStep>', '<BaselineProject>', '<OriginalProjectObjectId>']) assert.ok(xml.includes(tag), tag);
  const back = parseP6Xml(xml).db;
  assert.equal(rows(back, 'PROJPCAT')[0]?.proj_catg_id, '901');
  assert.equal(rows(back, 'PCATVAL')[0]?.proj_catg_name, 'Egypt');
  assert.equal(rows(back, 'RSRCRCAT').find((x) => x.rsrc_id === r.rsrc_id)?.rsrc_catg_id, '801');
  const step = rows(back, 'TASKPROC')[0];
  assert.deepEqual([step?.proc_name, step?.complete_pct, step?.proc_wt, step?.task_id], ['Set out', '25', '2', t.task_id]);
  const bl = rows(back, 'PROJECT').find((x) => x._baseline_of);
  assert.equal(bl?._baseline_of, p.proj_id);
  assert.equal(rows(back, 'TASK').filter((x) => x.proj_id === bl!.proj_id).length, rows(db, 'TASK').filter((x) => x.proj_id === p.proj_id).length, 'baseline activities');
  // imported into a database: the baseline stays attached to its (renumbered) project
  const target = emptyDb();
  const res = importIntoDb(target, back, defaultPlan(back));
  const proj = rows(target, 'PROJECT').find((x) => !x._baseline_of)!;
  const blIn = rows(target, 'PROJECT').find((x) => x._baseline_of)!;
  assert.equal(blIn._baseline_of, proj.proj_id);
  assert.equal(proj.sum_base_proj_id, blIn.proj_id);
  assert.deepEqual(res.projIds, [proj.proj_id], 'only the project is opened, not its baseline');
  // versions before P6 XML existed get the 8.1 schema
  assert.match(writeP6Xml(db, { projIds: [p.proj_id], version: '6.2' }), /P6\/V8\.1\/API/);
});
