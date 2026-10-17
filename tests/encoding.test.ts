import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { decodeText, chooseEncoding, encodeText } from '../core/encoding.ts';
import { parseXer } from '../core/xer/parse.ts';
import { writeXer } from '../core/xer/write.ts';
import { applyOps } from '../core/project/ops.ts';
import { emptyDb, rows } from '../core/db.ts';
import { SAMPLES_DIR } from './helpers.ts';

const bytes = (f: string) => new Uint8Array(readFileSync(join(SAMPLES_DIR, f)));

test('XER code pages are recognised: Arabic P6 exports read as Arabic, Western files unchanged, mangled UTF-8 not mistaken', () => {
  for (const f of ['129 trial.xer', '130 TRIAL.xer', '31 buidings.xer', 'building a.xer', 'building a-2.xer', 'Detailed Program.xer']) assert.equal(decodeText(bytes(f)).encoding, 'windows-1256', f);
  for (const f of ['cairo festival city.xer', 'damac-hyde park.xer', 'Copy of JWM - Baseline Programme Rev 05A.xer', 'CCA R03 dt 24Oct11SC.xer']) assert.equal(decodeText(bytes(f)).encoding, 'windows-1252', f);
  const db = parseXer(bytes('Detailed Program.xer')).db;
  assert.ok(rows(db, 'PROJWBS').some((w) => w.wbs_name === 'أعمال الطرق'));
  assert.equal(db.header?.encoding, 'windows-1256');
  assert.equal(parseXer(bytes('Detailed Program.xer')).findings.find((x) => x.code === 'ENCODING_CODEPAGE')?.severity, 'info');
  // forcing a code page by hand
  assert.equal(decodeText(bytes('Detailed Program.xer'), 'windows-1252').encoding, 'windows-1252');
});

test('export writes the code page P6 would use, so Arabic (and other scripts) survive instead of turning into "?"', () => {
  const db = parseXer(bytes('Detailed Program.xer')).db;
  const pid = db.tables.PROJECT.rows[0].proj_id;
  const out = writeXer(db, { version: '19.12', projIds: [pid] });
  assert.equal(decodeText(out).encoding, 'windows-1256');
  const back = parseXer(out).db;
  assert.deepEqual(rows(back, 'TASK').map((t) => t.task_name).slice(0, 50), rows(db, 'TASK').map((t) => t.task_name).slice(0, 50));
  // a schedule written in Arabic through the edit operations (the agent's way)
  const a = emptyDb();
  assert.equal(applyOps(a, [{ op: 'add_project', id: 'AR1', name: 'برج سكني', start: '2027-01-03' }, { op: 'add_wbs', code: 'S', name: 'الهيكل الخرساني' }, { op: 'add_activity', id: 'A1000', name: 'صب الأساسات', wbs: 'S', duration_days: 5 }]).ok, true);
  const x = parseXer(writeXer(a, { version: '19.12' })).db;
  assert.equal(rows(x, 'TASK')[0].task_name, 'صب الأساسات');
  assert.ok(rows(x, 'PROJWBS').some((w) => w.wbs_name === 'الهيكل الخرساني'));
  // other scripts; and text no single code page holds goes out as UTF-8
  for (const s of ['Приёмка работ', 'שלום', 'Ελλάδα', '建筑施工', '日本の建設', 'Žluťoučký kůň', 'Café 25€']) { const e = chooseEncoding(s); assert.equal(new TextDecoder(e).decode(encodeText(s, e)), s, s); }
  assert.equal(chooseEncoding('Arabic عربي and Russian русский'), 'utf-8');
});
