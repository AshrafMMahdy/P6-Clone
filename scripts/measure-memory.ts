// Memory use of opening an XER, per stage: heap after the parse (the file's bytes released), and peak RSS after the
// parse, after validation and after the stored-dates check (the import checks), each file in its own process so peaks
// do not mix. Peak RSS includes the file's bytes and Node itself ("start" = RSS before reading the file).
//   node scripts/measure-memory.ts [file.xer ...]      (defaults: the four reference files, missing ones skipped)
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOTS = [join(import.meta.dirname, '..'), join(import.meta.dirname, '..', '..', '..', '..')]; // repo, or main checkout from a worktree
const DEFAULTS = ['downloaded XERs/synthetic/campus-4x-plant.xer', 'downloaded XERs/MurleKrishnan_xer_analyzer/AMC9-213.xer', 'Sample XERs/CCA R03 dt 24Oct11SC.xer', 'downloaded XERs/mannixcom_xer/plant.xer'];
const MB = (n: number) => (n / 1048576).toFixed(0).padStart(5);

if (process.argv[2] === '--one') {
  const gc = (globalThis as { gc?: () => void }).gc!;
  const peak = () => process.resourceUsage().maxRSS * 1024;
  const heap = () => { gc(); gc(); return process.memoryUsage().heapUsed; };
  const { parseXer } = await import('../core/xer/parse.ts');
  const { importChecks } = await import('../renderer/io.ts');
  const { checkStoredDates } = await import('../core/schedule/stored-dates.ts');
  const out: Record<string, number> = { base: heap(), start: process.memoryUsage().rss };
  let bytes: Uint8Array | null = new Uint8Array(readFileSync(process.argv[3]));
  out.size = bytes.length;
  let t = Date.now();
  const r = parseXer(bytes);
  out.parseMs = Date.now() - t;
  out.rows = Object.values(r.db.tables).reduce((n, x) => n + x.rows.length, 0);
  out.parsePeak = peak();
  bytes = null;
  out.heap = heap() - out.base;
  t = Date.now();
  const f = importChecks(r.db, r.findings, 'xer', false);
  out.validatePeak = peak();
  f.push(...checkStoredDates(r.db));
  out.checkMs = Date.now() - t;
  out.datesPeak = peak();
  out.heapAfter = heap() - out.base;
  console.log(JSON.stringify(out));
} else {
  const files = process.argv.slice(2).length ? process.argv.slice(2) : DEFAULTS.map((f) => ROOTS.map((r) => join(r, f)).find(existsSync)).filter((f): f is string => !!f);
  console.log('x = times the file size. Peaks include the file bytes and Node itself (start).');
  console.log('file                            MB     rows parse s start MB   heap MB (x)   peak parse MB (x)  validate MB (x)     dates MB (x)  checks s');
  for (const file of files) {
    const o = JSON.parse(execFileSync(process.execPath, ['--expose-gc', '--max-old-space-size=8192', import.meta.filename, '--one', file], { encoding: 'utf8', maxBuffer: 1 << 24 }).trim().split('\n').pop()!);
    const x = (n: number) => `${MB(n)} (${(n / o.size).toFixed(1).padStart(4)})`;
    const name = file.split(/[\\/]/).pop()!.slice(0, 28).padEnd(28);
    console.log(`${name} ${MB(o.size)} ${String(o.rows).padStart(8)} ${(o.parseMs / 1000).toFixed(1).padStart(7)} ${MB(o.start)}     ${x(o.heap)}        ${x(o.parsePeak)}     ${x(o.validatePeak)}     ${x(o.datesPeak)}  ${(o.checkMs / 1000).toFixed(1).padStart(7)}`);
  }
}
