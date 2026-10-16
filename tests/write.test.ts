import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseXer } from '../core/xer/parse.ts';
import { writeXer } from '../core/xer/write.ts';
import { realSamples, samples, xer } from './helpers.ts';

function sameHeader(raw: string[]) {
  return { version: raw[1], exportDate: raw[2], user: raw[4], userName: raw[5], dbName: raw[6], currency: raw[8] };
}
function enc(meta: { encoding: string }) {
  return meta.encoding === 'windows-1252' ? 'windows-1252' as const : 'utf-8' as const;
}

test('real P6 samples round-trip byte-identical', () => {
  const failures: string[] = [];
  for (const s of realSamples()) {
    const { db, meta } = parseXer(s.bytes);
    const out = writeXer(db, { ...sameHeader(db.header!.raw), encoding: enc(meta) });
    if (Buffer.compare(Buffer.from(out), Buffer.from(s.bytes)) !== 0) {
      const a = Buffer.from(s.bytes).toString('latin1').split('\r\n');
      const b = Buffer.from(out).toString('latin1').split('\r\n');
      const i = a.findIndex((l, j) => l !== b[j]);
      failures.push(`${s.name} @line ${i + 1}\n  orig: ${a[i]?.slice(0, 160)}\n  ours: ${b[i]?.slice(0, 160)}`);
    }
  }
  assert.deepEqual(failures, []);
});

test('every sample re-parses after export to modern version without loss of rows', () => {
  for (const s of samples()) {
    const a = parseXer(s.bytes).db;
    const b = parseXer(writeXer(a, { version: '19.12' })).db;
    for (const [name, t] of Object.entries(a.tables)) assert.equal(b.tables[name]?.rows.length ?? 0, t.rows.length, `${s.name} ${name}`);
  }
});

test('project filter keeps referenced dictionaries only', () => {
  const src = xer([
    'ERMHDR\t7.0\t2014-01-01\tProject\tadmin\tadmin\tdb\tProject Management\tUSD',
    '%T\tCURRTYPE', '%F\tcurr_id\tcurr_short_name', '%R\t1\tUSD',
    '%T\tPROJECT', '%F\tproj_id\tproj_short_name\tclndr_id', '%R\t1\tA\t10', '%R\t2\tB\t11',
    '%T\tCALENDAR', '%F\tclndr_id\tclndr_name\tproj_id', '%R\t10\tCalA\t', '%R\t11\tCalB\t', '%R\t12\tUnused\t',
    '%T\tPROJWBS', '%F\twbs_id\tproj_id\tparent_wbs_id', '%R\t100\t1\t', '%R\t200\t2\t',
    '%T\tTASK', '%F\ttask_id\tproj_id\twbs_id\tclndr_id', '%R\t1000\t1\t100\t10', '%R\t2000\t2\t200\t11',
    '%T\tTASKPRED', '%F\ttask_pred_id\ttask_id\tpred_task_id\tproj_id\tpred_proj_id', '%R\t1\t1000\t2000\t1\t2',
    '%E', ''].join('\n'));
  const db = parseXer(src).db;
  const out = parseXer(writeXer(db, { version: '7.0', projIds: ['1'] })).db;
  assert.deepEqual(out.tables.PROJECT.rows.map((r) => r.proj_id), ['1']);
  assert.deepEqual(out.tables.CALENDAR.rows.map((r) => r.clndr_id), ['10']);
  assert.equal(out.tables.TASK.rows.length, 1);
  assert.equal(out.tables.TASKPRED.rows.length, 1, 'inter-project relationship kept');
  assert.equal(out.tables.CURRTYPE.rows.length, 1);
});
