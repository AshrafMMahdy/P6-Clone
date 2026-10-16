// Import every .mpp in a folder the way the app does (Microsoft Project converts it to XML, opened read-only),
// then validate and schedule it in the clone. Needs Microsoft Project; run it from your own terminal.
// Usage: node scripts/mpp-batch.ts ["sample MPPs"] [report.json]
import { readdirSync, readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { join, basename } from 'node:path';
import { tmpdir } from 'node:os';
import { mppToXml } from '../main/msproject.ts';
import { parseMspdi } from '../core/msp/mspdi.ts';
import { validateXer } from '../core/xer/validate.ts';
import { scheduleProjects } from '../core/schedule/cpm.ts';
import { worst } from '../core/findings.ts';

const dir = process.argv[2] ?? 'sample MPPs';
const reportPath = process.argv[3] ?? join(tmpdir(), 'mpp-report.json');
const work = mkdtempSync(join(tmpdir(), 'mpp-'));
const files = readdirSync(dir).filter((f) => /\.mpp$/i.test(f)).sort();
const report: Record<string, unknown>[] = [];
for (const [i, f] of files.entries()) {
  const row: Record<string, unknown> = { file: f };
  const xml = join(work, `${i}.xml`);
  const t0 = Date.now();
  try {
    await mppToXml(join(dir, f), xml);
    row.convertMs = Date.now() - t0;
    const { db, findings } = parseMspdi(readFileSync(xml, 'utf8'));
    const all = validateXer(db, findings);
    const n = (t: string) => db.tables[t]?.rows.length ?? 0;
    Object.assign(row, { tasks: n('TASK'), links: n('TASKPRED'), calendars: n('CALENDAR'), resources: n('RSRC'), assignments: n('TASKRSRC'), wbs: n('PROJWBS'), verdict: worst(all) ?? 'clean' });
    row.problems = all.filter((x) => x.severity === 'fatal' || x.severity === 'error').map((x) => `${x.code}: ${x.message}`).slice(0, 5);
    if (row.verdict !== 'fatal') {
      const res = scheduleProjects(db, db.tables.PROJECT.rows.map((p) => p.proj_id));
      row.scheduled = res.ok;
      if (!res.ok) row.problems = [...(row.problems as string[]), ...res.findings.filter((x) => x.severity === 'error').map((x) => x.message).slice(0, 3)];
    }
  } catch (e) {
    row.error = (e as Error).message.slice(0, 300);
  }
  report.push(row);
  console.log(`${String(i + 1).padStart(2)}/${files.length} ${basename(f).slice(0, 60).padEnd(60)} ${row.error ? 'ERROR ' + row.error : `${row.tasks} tasks, ${row.links} links, ${row.verdict}${row.scheduled === false ? ', SCHEDULE FAILED' : ''}`}`);
}
writeFileSync(reportPath, JSON.stringify(report, null, 1));
console.log(`report: ${reportPath}`);
