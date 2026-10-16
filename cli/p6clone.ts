#!/usr/bin/env node
// P6 Clone CLI — same core as the desktop app.
import { readFileSync, writeFileSync } from 'node:fs';
import { parseXer } from '../core/xer/parse.ts';
import { validateXer } from '../core/xer/validate.ts';
import { checkStoredDates } from '../core/schedule/stored-dates.ts';
import { writeXer } from '../core/xer/write.ts';
import { diffDbs } from '../core/diff.ts';
import { worst, type Finding } from '../core/findings.ts';
import type { Db } from '../core/db.ts';

const USAGE = `p6clone <command> [options]

  validate <file.xer> [--json]                       P6-style import diagnostics. Exit 0 ok/warnings, 1 errors, 2 fatal
  schedule <file.xer> [--data-date YYYY-MM-DD] [--out out.xer] [--version 19.12] [--json]
  progress <file.xer> --data-date YYYY-MM-DD --out out.xer [--version v]
  level    <file.xer> --out out.xer [--version v]
  export   <file.xer> --version <v> --out <path> [--format xer|xml]
  diff     <a.xer> <b.xer> [--json]
`;

const args = process.argv.slice(2);
const cmd = args[0];
const opt = (name: string) => { const i = args.indexOf(`--${name}`); return i > 0 ? args[i + 1] : undefined; };
const flag = (name: string) => args.includes(`--${name}`);
const VALUED = new Set(['--data-date', '--out', '--version', '--format']);
const positional: string[] = [];
for (let i = 1; i < args.length; i++) {
  if (VALUED.has(args[i])) i++;
  else if (!args[i].startsWith('--')) positional.push(args[i]);
}

function load(path: string): { db: Db; findings: Finding[] } {
  const r = parseXer(new Uint8Array(readFileSync(path)));
  return { db: r.db, findings: r.findings };
}

function printFindings(f: Finding[]): void {
  for (const x of f) {
    const where = [x.table, x.row != null ? `row ${x.row}` : '', x.field].filter(Boolean).join(' ');
    console.log(`${x.severity.toUpperCase().padEnd(7)} ${x.code.padEnd(20)} ${where ? `[${where}] ` : ''}${x.message}`);
    console.log(`        P6: ${x.p6}`);
  }
}

function exitCode(f: Finding[]): number {
  const w = worst(f);
  return w === 'fatal' ? 2 : w === 'error' ? 1 : 0;
}

async function main(): Promise<number> {
  switch (cmd) {
    case 'validate': {
      const { db, findings } = load(positional[0]);
      const pre = validateXer(db, findings);
      const all = worst(pre) === 'fatal' ? pre : [...pre, ...checkStoredDates(db)];
      if (flag('json')) console.log(JSON.stringify({ file: positional[0], version: db.header?.version, verdict: worst(all) ?? 'clean', findings: all }, null, 2));
      else {
        printFindings(all);
        const w = worst(all);
        console.log(`\n${all.length} finding(s). Verdict: ${w === 'fatal' ? 'P6 would REJECT this file' : w === 'error' ? 'P6 import would FAIL or drop data' : 'P6 would import this file'}.`);
      }
      return exitCode(all);
    }
    case 'export': {
      const { db } = load(positional[0]);
      const version = opt('version') ?? '19.12';
      const out = opt('out');
      if (!out) throw new Error('--out required');
      if ((opt('format') ?? 'xer') === 'xml') {
        const { writeP6Xml } = await import('../core/xml/p6xml.ts');
        writeFileSync(out, writeP6Xml(db, {}));
      } else writeFileSync(out, writeXer(db, { version }));
      console.log(`Wrote ${out}`);
      return 0;
    }
    case 'schedule': case 'progress': case 'level': {
      const { db, findings } = load(positional[0]);
      const pre = validateXer(db, findings);
      if (worst(pre) === 'fatal') { printFindings(pre.filter((f) => f.severity === 'fatal')); return 2; }
      const { runScheduleCommand } = await import('./commands.ts');
      return runScheduleCommand(cmd, db, { dataDate: opt('data-date'), out: opt('out'), version: opt('version'), json: flag('json') });
    }
    case 'diff': {
      const d = diffDbs(load(positional[0]).db, load(positional[1]).db);
      if (flag('json')) console.log(JSON.stringify(d, null, 2));
      else for (const e of d) console.log(e.kind === 'changed' ? `~ ${e.table}[${e.key}].${e.field}: ${e.a} -> ${e.b}` : `${e.kind === 'added' ? '+' : '-'} ${e.table}[${e.key}]`);
      if (!flag('json')) console.log(`${d.length} difference(s)`);
      return d.length ? 1 : 0;
    }
    default:
      console.log(USAGE);
      return cmd ? 64 : 0;
  }
}

main().then((c) => process.exit(c), (e) => { console.error(String(e?.message ?? e)); process.exit(70); });
