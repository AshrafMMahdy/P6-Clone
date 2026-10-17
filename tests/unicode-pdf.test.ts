import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { shapeArabic, visualOrder } from '../renderer/print/unicode-font.ts';
import { findUnicodeFont } from '../renderer/print/system-font.ts';
import { pagesToPdf } from '../renderer/print/output.ts';
import { printPages } from '../renderer/print/schedule.ts';
import { reportText } from '../renderer/reports/output.ts';
import { parseXer } from '../core/xer/parse.ts';
import { SAMPLES_DIR } from './helpers.ts';

test('Arabic letters take their joined forms (initial, medial, final, lam-alef) and right-to-left text is drawn in visual order', () => {
  const cps = (s: string) => [...s].map((c) => c.codePointAt(0)!.toString(16));
  assert.deepEqual(cps(shapeArabic('صب')), ['febb', 'fe90']); // initial sad, final beh
  assert.deepEqual(cps(shapeArabic('لا')), ['fefb']); // lam-alef ligature
  assert.deepEqual(cps(shapeArabic('بيت')), ['fe91', 'fef4', 'fe96']); // initial, medial, final
  assert.deepEqual(cps(shapeArabic('دار')), ['fea9', 'fe8d', 'fead']); // dal and alef do not join forward: all isolated
  assert.equal(visualOrder('صب الأساسات - Zone 2 (B1)'), 'Zone 2 (B1) - تاساسألا بص');
  assert.equal(visualOrder('المرحلة 3'), '3 ةلحرملا');
  assert.equal(visualOrder('Phase عربي text'), 'Phase يبرع text');
  assert.equal(visualOrder('No RTL here (ok)'), 'No RTL here (ok)');
});

test('CLI/MCP PDFs of an Arabic schedule embed a Unicode font (when the computer has one) instead of printing "?"', async (t) => {
  const font = findUnicodeFont(new Set([0x0627, 0x0644, 0xfefb]));
  if (!font) { t.skip('no Unicode TrueType font on this computer'); return; }
  const db = parseXer(new Uint8Array(readFileSync(join(SAMPLES_DIR, 'Detailed Program.xer')))).db;
  const r = printPages(db, { projIds: [db.tables.PROJECT.rows[0].proj_id], setup: { paper: 'A3' } });
  const pdf = Buffer.from(await pagesToPdf(r.pages, r.title, { font: (cs) => findUnicodeFont(cs) }));
  const s = pdf.toString('latin1');
  assert.ok(s.includes('/FontFile2') && s.includes('/Identity-H') && s.includes('/ToUnicode'));
  assert.ok(/\/Title <FEFF[0-9A-F]+>/i.test(s), 'title in UTF-16');
  // without a font the old behaviour stays (Helvetica only, "?" for Arabic) and nothing breaks
  const plain = Buffer.from(await pagesToPdf(r.pages, r.title)).toString('latin1');
  assert.ok(!plain.includes('/FontFile2'));
});

test('report CSV starts with a byte-order mark so Excel reads Arabic correctly', () => {
  assert.equal(reportText({ title: 't', columns: ['اسم'], rows: [{ cells: ['أعمال'] }] }).charCodeAt(0), 0xfeff);
});
