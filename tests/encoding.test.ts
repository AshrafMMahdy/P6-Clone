import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { decodeText, chooseEncoding, encodeText, textDecoder } from '../core/encoding.ts';
import { parseXer } from '../core/xer/parse.ts';
import { writeXer } from '../core/xer/write.ts';
import { applyOps } from '../core/project/ops.ts';
import { emptyDb, rows } from '../core/db.ts';
import { SAMPLES_DIR } from './helpers.ts';

const bytes = (f: string) => new Uint8Array(readFileSync(join(SAMPLES_DIR, f)));

test('XER code pages are recognised: Arabic P6 exports read as Arabic, Western files unchanged, mangled UTF-8 not mistaken', () => {
  for (const f of ['129 trial.xer', '130 TRIAL.xer', '31 buidings.xer', 'building a.xer', 'building a-2.xer', 'Detailed Program.xer']) assert.equal(decodeText(bytes(f)).encoding, 'windows-1256', f);
  for (const f of ['cairo festival city.xer', 'Copy of JWM - Baseline Programme Rev 05A.xer', 'CCA R03 dt 24Oct11SC.xer']) assert.equal(decodeText(bytes(f)).encoding, 'windows-1252', f);
  // damac's unit of measure is Arabic (متر مكعب, cubic metre) in Windows-1256; its other non-ASCII bytes are £ € ¥, the
  // same bytes in both code pages: read as Arabic, every character is right (as Western, the unit was ãÊÑ ãßÚÈ)
  const damac = decodeText(bytes('damac-hyde park.xer'));
  assert.equal(damac.encoding, 'windows-1256');
  assert.ok(damac.text.includes('متر مكعب') && damac.text.includes('£') && damac.text.includes('€'));
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
  for (const s of ['Приёмка работ', 'שלום', 'Ελλάδα', '建筑施工', '日本の建設', 'Žluťoučký kůň', 'Café 25€']) { const e = chooseEncoding(s); assert.equal(textDecoder(e).decode(encodeText(s, e)), s, s); }
  assert.equal(chooseEncoding('Arabic عربي and Russian русский'), 'utf-8');
});

// short files told apart by how their non-ASCII bytes sit (one at a time in words, or in runs) and what they spell
{
  const { detectCodepage } = await import('../core/encoding.ts');
  /** text in a single-byte code page (each character's byte, from the code page's own table) */
  const encode = (text: string, enc: string) => {
    const map = new Map<string, number>();
    for (let x = 0x80; x <= 0xff; x++) { const c = new TextDecoder(enc).decode(Uint8Array.of(x)); if (!map.has(c)) map.set(c, x); }
    return Uint8Array.from([...text].map((c) => (c.charCodeAt(0) < 0x80 ? c.charCodeAt(0) : map.get(c) ?? 0x3f)));
  };
  const xerOf = (rows: string[]) => `ERMHDR\t19.12\t2026-01-01\tProject\tadmin\n%T\tTASK\n%F\ttask_id\ttask_name\n${rows.map((r, i) => `%R\t${i + 1}\t${r}`).join('\n')}\n%E\n`;
  const cases: [string, string, string[]][] = [
    ['a small Arabic schedule (cp1256), once read as Greek or Chinese', 'windows-1256', ['صب خرسانة', 'دهان', 'أعمال الحفر']],
    ['a Western file whose only accents are ä and ö (cp1252), once read as Arabic or Chinese', 'windows-1252', ['Väliseinät ja Mäkelän työmaa', 'Köysi']],
    ['German (cp1252)', 'windows-1252', ['Wände im Erdgeschoß', 'Übergabe']],
    ['Greek (cp1253)', 'windows-1253', ['Σκυροδέτηση πλάκας', 'Τοιχοποιία']],
    ['Russian (cp1251)', 'windows-1251', ['Бетонирование плиты', 'Кладка стен']],
    ['Hebrew (cp1255)', 'windows-1255', ['יציקת תקרה', 'בניית קירות']],
    ['Polish (cp1250)', 'windows-1250', ['Ściany działowe', 'Łączniki stalowe']],
    ['Turkish (cp1254)', 'windows-1254', ['Döşeme betonu ışık', 'Ağaç işleri']],
  ];
  for (const [what, enc, rows] of cases) test(`code page from a short file: ${what}`, () => { assert.equal(detectCodepage(encode(xerOf(rows), enc)), enc); });
  test('code page from a short file: Chinese (GBK) and Japanese (Shift_JIS) still read as such', () => {
    const gbk = (b: number[]) => Uint8Array.from([...new TextEncoder().encode('ERMHDR\t19.12\n%T\tTASK\n%R\t1\t'), ...b, 0x0a]);
    assert.equal(detectCodepage(gbk([0xb9, 0xa4, 0xb3, 0xcc, 0xbd, 0xf8, 0xb6, 0xc8, 0x20, 0xd6, 0xd0, 0xb9, 0xfa])), 'gbk'); // 工程进度 中国
    assert.equal(detectCodepage(gbk([0x93, 0xfa, 0x96, 0x7b, 0x8d, 0x48, 0x8e, 0x96])), 'shift_jis'); // 日本工事
  });
}
