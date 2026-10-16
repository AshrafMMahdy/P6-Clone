// Stress-test file: N copies of a real programme in one XER, each copy a separate project with its own IDs (like a
// campus or compound of identical buildings). Usage: node scripts/make-campus.ts <src.xer> <copies> <out.xer> [version]
import { readFileSync, writeFileSync } from 'node:fs';
import { parseXer } from '../core/xer/parse.ts';
import { importIntoDb, defaultPlan } from '../core/xer/import.ts';
import { writeXer } from '../core/xer/write.ts';
import type { Db } from '../core/db.ts';

const [src, copies = '4', out, version] = process.argv.slice(2);
const bytes = readFileSync(src);
const db: Db = { tables: {} };
const projIds: string[] = [];
for (let k = 1; k <= Number(copies); k++) {
  const s = parseXer(bytes).db;
  for (const p of s.tables.PROJECT.rows) { p.proj_short_name = `${p.proj_short_name}-B${k}`; }
  projIds.push(...importIntoDb(db, s, defaultPlan(s)).projIds);
}
const v = version ?? parseXer(bytes).db.header?.version ?? '19.12';
const xer = writeXer(db, { version: v, projIds });
writeFileSync(out, xer);
const n = (t: string) => db.tables[t]?.rows.length ?? 0;
console.log(`${out}: ${(xer.length / 1048576).toFixed(1)} MB, version ${v}, projects ${n('PROJECT')}, activities ${n('TASK')}, links ${n('TASKPRED')}, assignments ${n('TASKRSRC')}, activity codes ${n('TASKACTV')}, UDF values ${n('UDFVALUE')}`);
