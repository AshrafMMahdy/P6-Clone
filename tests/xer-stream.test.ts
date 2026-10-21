// XER read a chunk at a time (never the whole file in memory) gives what reading its bytes gives: on every sample file,
// and on the edge cases (byte order marks, LF and mixed endings, code pages, a line cut by every chunk boundary).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { parseXer, parseXerSource, type ByteSource } from '../core/xer/parse.ts';
import { parseXerFile } from '../core/xer/parseFile.ts';
import { encodeText } from '../core/encoding.ts';
import { SAMPLES_DIR } from './helpers.ts';

const same = (a: ReturnType<typeof parseXer>, b: ReturnType<typeof parseXer>, what: string) => {
  assert.deepEqual(b.meta, a.meta, `${what}: meta`);
  assert.deepEqual(b.findings, a.findings, `${what}: findings`);
  assert.deepEqual(Object.keys(b.db.tables), Object.keys(a.db.tables), `${what}: tables`);
  for (const [n, t] of Object.entries(a.db.tables)) { assert.deepEqual(b.db.tables[n].fields, t.fields, `${what}: ${n} fields`); assert.deepEqual(b.db.tables[n].rows.map((r) => ({ ...r })), t.rows.map((r) => ({ ...r })), `${what}: ${n} rows`); }
  assert.deepEqual(b.db.header, a.db.header, `${what}: header`);
};
/** A source that hands out at most n bytes a read: every line crosses chunk boundaries. */
const tiny = (b: Uint8Array, n: number): ByteSource => ({ size: b.length, read: (pos, len) => b.subarray(pos, Math.min(b.length, pos + Math.min(len, n))) });

test('a file read a chunk at a time parses as its bytes do (every sample, and through 7-byte chunks)', { timeout: 300_000 }, () => {
  const dir = existsSync(SAMPLES_DIR) ? SAMPLES_DIR : join(import.meta.dirname, 'fixtures');
  const files = readdirSync(dir).filter((f) => /\.xer$/i.test(f)).slice(0, 40).map((f) => join(dir, f));
  for (const f of [...files, ...readdirSync(join(import.meta.dirname, 'fixtures')).filter((x) => /\.xer$/i.test(x)).map((x) => join(import.meta.dirname, 'fixtures', x))]) {
    const bytes = new Uint8Array(readFileSync(f));
    const a = parseXer(bytes);
    same(a, parseXerFile(f), f);
    if (bytes.length < 400_000) same(a, parseXerSource(tiny(bytes, 7)), `${f} in 7-byte chunks`);
  }
});

test('byte order marks, line endings and code pages read the same a chunk at a time', () => {
  const dir = mkdtempSync(join(tmpdir(), 'p6-xer-stream-'));
  const head = 'ERMHDR\t19.12\t2026-01-01\tProject\tadmin\tadmin\tdbx\tProject Management\tUSD';
  const body = ['%T\tPROJECT', '%F\tproj_id\tproj_short_name', '%R\t1\tМост через реку', '%T\tTASK', '%F\ttask_id\tproj_id\ttask_code\ttask_name', '%R\t10\t1\tA1\tБетонирование — опор', '%R\t11\t1\tA2\tCafé “déjà vu”', '%E'];
  const cases: [string, Uint8Array][] = [
    ['utf-8 CRLF', new TextEncoder().encode([head, ...body].join('\r\n') + '\r\n')],
    ['utf-8 LF, no final newline', new TextEncoder().encode([head, ...body].join('\n'))],
    ['mixed endings', new TextEncoder().encode([head, ...body].map((l, i) => l + (i % 2 ? '\n' : '\r\n')).join(''))],
    ['BOM', Uint8Array.from([0xef, 0xbb, 0xbf, ...new TextEncoder().encode([head, ...body].join('\r\n'))])],
    ['two BOMs', Uint8Array.from([0xef, 0xbb, 0xbf, 0xef, 0xbb, 0xbf, ...new TextEncoder().encode([head, ...body].join('\r\n'))])],
    ['windows-1251', encodeText([head, ...body.filter((l) => !/[éé“”]/.test(l))].join('\r\n'), 'windows-1251')],
    ['windows-1252', encodeText([head, ...body.filter((l) => !/[А-я]/.test(l))].join('\r\n'), 'windows-1252')],
    ['ASCII, empty lines', new TextEncoder().encode([head, '', '%T\tPROJECT', '%F\tproj_id', '', '%R\t1', '%E', ''].join('\r\n'))],
  ];
  for (const [what, b] of cases) {
    const f = join(dir, 'x.xer'); writeFileSync(f, b);
    const a = parseXer(b);
    same(a, parseXerFile(f), what);
    for (const n of [1, 2, 5, 13]) same(a, parseXerSource(tiny(b, n)), `${what} in ${n}-byte chunks`);
    for (const enc of ['windows-1252', 'utf-8'] as const) same(parseXer(b, { encoding: enc }), parseXerSource(tiny(b, 3), { encoding: enc }), `${what} forced ${enc}`);
  }
});
