import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseXer } from '../core/xer/parse.ts';
import { writeXer } from '../core/xer/write.ts';
import { SAMPLES_DIR } from './helpers.ts';

const load = (f: string) => parseXer(new Uint8Array(readFileSync(join(SAMPLES_DIR, f)))).db;
const rsrcUdfs = (d: ReturnType<typeof load>) => { const ty = new Set((d.tables.UDFTYPE?.rows ?? []).filter((u) => u.table_name === 'RSRC').map((u) => u.udf_type_id)); return (d.tables.UDFVALUE?.rows ?? []).filter((v) => ty.has(v.udf_type_id)).length; };

test('project XER export keeps POBS, resource UDF values and every known P6 field of the source', () => {
  for (const f of ['DHBL-24FEB13_VER-7.0.xer', 'cairo alex-road.xer']) {
    const db = load(f);
    const pid = db.tables.PROJECT.rows.filter((p) => !p._baseline_of)[0].proj_id;
    const back = parseXer(writeXer(db, { version: '19.12', projIds: [pid] })).db;
    assert.equal(back.tables.POBS?.rows.length ?? 0, db.tables.POBS?.rows.length ?? 0, `${f} POBS`);
    assert.equal(rsrcUdfs(back), rsrcUdfs(db), `${f} resource UDF values`);
    for (const t of ['TASK', 'PROJECT', 'TASKRSRC', 'RSRC']) {
      const lost = (db.tables[t]?.fields ?? []).filter((x) => !x.startsWith('_') && !(back.tables[t]?.fields ?? []).includes(x));
      assert.deepEqual(lost, [], `${f} ${t} fields`);
    }
  }
});

test('a resource\'s shift (SHIFT, SHIFTPER) goes with it into a project export', () => {
  const db = load('cairo festival city.xer');
  const pid = db.tables.PROJECT.rows[0].proj_id;
  const asg = db.tables.TASKRSRC.rows.find((a) => a.proj_id === pid)!;
  db.tables.SHIFT = { name: 'SHIFT', fields: ['shift_id', 'shift_name'], rows: [{ shift_id: '7', shift_name: 'Day shift' }] };
  db.tables.SHIFTPER = { name: 'SHIFTPER', fields: ['shift_period_id', 'shift_id', 'shift_start_hr_num'], rows: [{ shift_period_id: '1', shift_id: '7', shift_start_hr_num: '7' }] };
  const r = db.tables.RSRC.rows.find((x) => x.rsrc_id === asg.rsrc_id)!;
  if (!db.tables.RSRC.fields.includes('shift_id')) db.tables.RSRC.fields.push('shift_id');
  r.shift_id = '7';
  const back = parseXer(writeXer(db, { version: '19.12', projIds: [pid] })).db;
  assert.equal(back.tables.SHIFT?.rows[0]?.shift_name, 'Day shift');
  assert.equal(back.tables.SHIFTPER?.rows.length, 1);
});
