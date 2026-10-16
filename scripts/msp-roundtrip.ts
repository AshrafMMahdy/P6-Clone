// Round trip through the installed Microsoft Project: our MSPDI XML -> .mpp -> XML -> our import. node scripts/msp-roundtrip.ts
import { readFileSync, writeFileSync, rmSync } from 'node:fs';
import { parseXer } from '../core/xer/parse.ts';
import { writeMspdi, parseMspdi } from '../core/msp/mspdi.ts';
import { xmlToMpp, mppToXml } from '../main/msproject.ts';
const S = process.argv[2] ?? (await import('node:os')).tmpdir(); // out.xml, out.mpp, back.xml are left here
const db = parseXer(readFileSync('sample XERs/cairo festival city.xer')).db;
const xml = writeMspdi(db);
writeFileSync(S + '/out.xml', xml);
const nTasks = db.tables.TASK.rows.length;
for (const f of ['/out.mpp', '/back.xml']) rmSync(S + f, { force: true });
let t = Date.now();
await xmlToMpp(S + '/out.xml', S + '/out.mpp'); console.log('xml→mpp ok', Date.now() - t, 'ms', readFileSync(S + '/out.mpp').length, 'bytes');
t = Date.now();
await mppToXml(S + '/out.mpp', S + '/back.xml'); console.log('mpp→xml ok', Date.now() - t, 'ms');
const back = parseMspdi(readFileSync(S + '/back.xml', 'utf8'));
console.log('tasks in', nTasks, 'back', back.db.tables.TASK?.rows.length, 'rels in', db.tables.TASKPRED?.rows.length, 'back', back.db.tables.TASKPRED?.rows.length, 'findings', back.findings.filter((f) => f.severity !== 'info').length);
