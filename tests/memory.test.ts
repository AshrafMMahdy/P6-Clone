import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { SAMPLES_DIR } from './helpers.ts';

// Opening a file must stay within a few times its size (the MCP server admits files by ~5x their size against its
// memory budget). Measured in a fresh process with a small young generation, so the fixed ~100 MB V8 keeps for
// short-lived objects does not hide what the parsed data itself costs. scripts/measure-memory.ts has the full picture.
test('parsing an XER takes at most 3x its size in heap, and peaks below 6x', () => {
  const parse = pathToFileURL(join(import.meta.dirname, '..', 'core', 'xer', 'parse.ts')).href;
  const file = join(SAMPLES_DIR, 'DHBL-24FEB13_VER-7.0.xer'); // 12 MB, 106k rows
  const code = `
    import { readFileSync } from 'node:fs';
    const { parseXer } = await import(${JSON.stringify(parse)});
    const heap = () => { gc(); gc(); return process.memoryUsage().heapUsed; };
    const h0 = heap(), r0 = process.memoryUsage().rss;
    let bytes = new Uint8Array(readFileSync(${JSON.stringify(file)}));
    const size = bytes.length, { db } = parseXer(bytes);
    const peak = process.resourceUsage().maxRSS * 1024 - r0;
    bytes = null;
    console.log(JSON.stringify({ heap: (heap() - h0) / size, peak: peak / size, rows: Object.values(db.tables).reduce((n, t) => n + t.rows.length, 0) }));`;
  const out = JSON.parse(execFileSync(process.execPath, ['--expose-gc', '--max-semi-space-size=1', '--input-type=module', '-e', code], { encoding: 'utf8' }));
  assert.ok(out.rows > 100000, `rows ${out.rows}`);
  assert.ok(out.heap <= 3, `heap after parse ${out.heap.toFixed(2)}x the file size`);
  assert.ok(out.peak <= 6, `peak RSS while parsing ${out.peak.toFixed(2)}x the file size`);
});
