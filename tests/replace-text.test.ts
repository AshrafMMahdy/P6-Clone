// replace_text: one operation renames words and phrases in every text field of every table (anonymising a schedule).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { applyOps } from '../core/project/ops.ts';
import { addField, rows, table, type Db, type Row } from '../core/db.ts';
import { parseXer } from '../core/xer/parse.ts';
import { SAMPLES_DIR } from './helpers.ts';

const load = (f = 'CfC.xer') => parseXer(new Uint8Array(readFileSync(join(SAMPLES_DIR, f)))).db;
const addRow = (db: Db, name: string, r: Row) => { const T = table(db, name); for (const f of Object.keys(r)) addField(T, f); T.rows.push(r); return r; };
const run = (db: Db, op: Record<string, unknown>) => { const r = applyOps(db, [{ op: 'replace_text', ...op }]); assert.ok(r.ok, JSON.stringify(r.error)); return r.results[0] as { replaced: number; pairs: { find: string; replaced: number; where: Record<string, number> }[] }; };
const refused = (db: Db, op: Record<string, unknown>, re: RegExp) => { const r = applyOps(db, [{ op: 'replace_text', ...op }]); assert.equal(r.ok, false); assert.match(r.error!.message, re); };
const task = (db: Db) => rows(db, 'TASK')[0];

test('names, short names, descriptions, UDF text, steps, expenses and issues are renamed, counted per pair and per table.field', () => {
  const db = load();
  const t = task(db), pid = t.proj_id;
  t.task_name = 'Pour slab for Acme Tower';
  const w = rows(db, 'PROJWBS').find((x) => x.proj_node_flag !== 'Y')!; w.wbs_name = 'Acme works';
  addRow(db, 'PROJCOST', { cost_item_id: '990001', task_id: t.task_id, proj_id: pid, cost_name: 'Acme crane hire', vendor_name: 'Acme Plant Ltd', cost_descr: 'for the Acme job' });
  addRow(db, 'TASKPROC', { proc_id: '990002', task_id: t.task_id, proj_id: pid, proc_name: 'Inspect with Acme', proc_descr: '' });
  addRow(db, 'PROJISSU', { issue_id: '990003', proj_id: pid, issue_name: 'Acme delay', issue_notes: 'caused by Acme' });
  addRow(db, 'UDFTYPE', { udf_type_id: '990004', table_name: 'TASK', udf_type_label: 'Acme ref', logical_data_type: 'FT_TEXT' });
  addRow(db, 'UDFVALUE', { udf_type_id: '990004', fk_id: t.task_id, proj_id: pid, udf_text: 'Acme-77' });
  const r = run(db, { pairs: [{ find: 'Acme', replace: 'Client' }] });
  assert.equal(r.pairs[0].replaced, r.replaced);
  assert.ok(r.replaced >= 10);
  for (const k of ['TASK.task_name', 'PROJWBS.wbs_name', 'PROJCOST.cost_name', 'PROJCOST.vendor_name', 'PROJCOST.cost_descr', 'TASKPROC.proc_name', 'PROJISSU.issue_name', 'PROJISSU.issue_notes', 'UDFTYPE.udf_type_label', 'UDFVALUE.udf_text'])
    assert.ok(r.pairs[0].where[k] >= 1, `${k}: ${JSON.stringify(r.pairs[0].where)}`);
  assert.equal(t.task_name, 'Pour slab for Client Tower');
  assert.equal(w.wbs_name, 'Client works');
  assert.equal(rows(db, 'UDFVALUE').find((x) => x.udf_type_id === '990004')!.udf_text, 'Client-77');
  // nothing of it is left anywhere in a text field
  for (const [name, T] of Object.entries(db.tables)) for (const x of T.rows) for (const [f, v] of Object.entries(x)) if (/(name|descr|notes?|label|udf_text)$/.test(f) && f !== 'udf_type_name' && f !== 'table_name') assert.ok(!/Acme/.test(String(v)), `${name}.${f}: ${v}`);
});

test('a 3-letter initial is a whole word (TGS in "TGS-01" and "TGS Tower", not in SETTINGS or TGSX); a longer phrase matches anywhere', () => {
  const db = load();
  const t = task(db);
  t.task_name = 'TGS Tower'; t.task_code = 'TGS-01';
  const w = rows(db, 'PROJWBS').find((x) => x.proj_node_flag !== 'Y')!; w.wbs_name = 'Edit SETTINGS of TGSX (TGS)';
  const q = rows(db, 'TASK')[1]; q.task_name = 'MyConstruction Co site, Construction Co';
  const r = run(db, { pairs: [{ find: 'TGS', replace: 'ABC' }, { find: 'Construction Co', replace: 'Builder' }] });
  assert.equal(t.task_name, 'ABC Tower');
  assert.equal(t.task_code, 'ABC-01');
  assert.equal(w.wbs_name, 'Edit SETTINGS of TGSX (ABC)');
  assert.equal(q.task_name, 'MyBuilder site, Builder');
  assert.equal(r.pairs[1].replaced >= 2, true);
});

test('overlapping terms: the longest wins; what a replacement wrote is not searched again', () => {
  const db = load();
  const t = task(db);
  t.task_name = 'Acme Construction Co and Acme';
  run(db, { pairs: [{ find: 'Acme', replace: 'X' }, { find: 'Acme Construction Co', replace: 'Y' }] });
  assert.equal(t.task_name, 'Y and X');
  t.task_name = 'one two';
  run(db, { pairs: [{ find: 'one', replace: 'two' }, { find: 'two', replace: 'three' }] });
  assert.equal(t.task_name, 'two three', 'one -> two is final, not two -> three again');
});

test('case: exact by default, Unicode case folding with case_insensitive (Straße = STRASSE, Greek sigma, Cyrillic)', () => {
  const db = load();
  const t = task(db);
  t.task_name = 'acme and ACME and Acme';
  run(db, { pairs: [{ find: 'Acme', replace: 'X' }] });
  assert.equal(t.task_name, 'acme and ACME and X');
  t.task_name = 'acme and ACME and Acme';
  run(db, { pairs: [{ find: 'Acme', replace: 'X' }], case_insensitive: true });
  assert.equal(t.task_name, 'X and X and X');
  t.task_name = 'Neue STRASSE und Straße, ΟΔΟΣ οδος, ПРОЕКТ проект';
  const r = run(db, { pairs: [{ find: 'straße', replace: 'Weg' }, { find: 'οδοσ', replace: 'Road' }, { find: 'проект', replace: 'Plan' }], case_insensitive: true });
  assert.equal(t.task_name, 'Neue Weg und Weg, Road Road, Plan Plan'); // (ΟΔΟΣ, upper case with the final sigma ς of οδος, folds to οδοσ)
  assert.deepEqual(r.pairs.map((p) => p.replaced), [2, 2, 2]);
  // a composed and a decomposed spelling of the same letter are the same
  t.task_name = 'Müller Bau';
  run(db, { pairs: [{ find: 'Müller', replace: 'Smith' }] });
  assert.equal(t.task_name, 'Smith Bau');
});

test('Arabic and Chinese: phrases, short Arabic terms as whole words, Chinese terms anywhere', () => {
  const db = load();
  const t = task(db);
  t.task_name = 'مشروع شركة الأمل للمقاولات';
  const w = rows(db, 'PROJWBS').find((x) => x.proj_node_flag !== 'Y')!;
  w.wbs_name = 'أمل برج الأمل'; // a 3-letter Arabic term: "أمل" as a word, and with its article (the prefix ال stays)
  const q = rows(db, 'TASK')[1]; q.task_name = '中建三局项目部 and 中建';
  const r = run(db, { pairs: [{ find: 'شركة الأمل للمقاولات', replace: 'شركة س' }, { find: 'أمل', replace: 'س' }, { find: '中建', replace: '甲方' }] });
  assert.equal(t.task_name, 'مشروع شركة س');
  assert.equal(w.wbs_name, 'س برج الس');
  assert.equal(q.task_name, '甲方三局项目部 and 甲方');
  assert.deepEqual(r.pairs.map((p) => p.replaced), [1, 2, 2]);
});

test('Arabic: a short term is found with its proclitics (و ف / ب ك ل / ال / لل) and the prefix stays; a term given with ال is matched without it too', () => {
  const db = load();
  const t = task(db);
  // أمل bare, with the article, and with و / ب / ل / لل / ف+لل: all the written forms of one word; not inside تأمل (another word) or أملاك (a longer one)
  t.task_name = 'أمل الأمل والأمل بالأمل للأمل فللأمل وبأمل تأمل أملاك';
  const r = run(db, { pairs: [{ find: 'أمل', replace: 'س' }] });
  assert.equal(t.task_name, 'س الس والس بالس للس فللس وبس تأمل أملاك');
  assert.equal(r.pairs[0].replaced, 7);
  // with diacritics on the prefix, and the term at the end of the text
  t.task_name = 'وَالأمل';
  run(db, { pairs: [{ find: 'أمل', replace: 'س' }] });
  assert.equal(t.task_name, 'وَالس');
  // given with the article, the bare word and the other prefixed forms are found too
  t.task_name = 'الأمل أمل والأمل بأمل للأمل';
  const r2 = run(db, { pairs: [{ find: 'الأمل', replace: 'ص' }] });
  assert.equal(t.task_name, 'ص ص وص بص للص');
  assert.equal(r2.pairs[0].replaced, 5);
  // a Latin initial is still a whole word with nothing attached
  t.task_name = 'والTGS TGS';
  run(db, { pairs: [{ find: 'TGS', replace: 'ABC' }] });
  assert.equal(t.task_name, 'والTGS ABC');
});

test('Hebrew: a short term is found with its prefixes (ו ה ב ל מ ש כ) and the prefix stays; a term given with ה is matched without it too', () => {
  const db = load();
  const t = task(db);
  t.task_name = 'בית הבית ובבית מבית לבית והבית כשבית ביתנו ביתן';
  const r = run(db, { pairs: [{ find: 'בית', replace: 'X' }] });
  assert.equal(t.task_name, 'X הX ובX מX לX והX כשX ביתנו ביתן');
  assert.equal(r.pairs[0].replaced, 7);
  t.task_name = 'הבית בית ובבית';
  const r2 = run(db, { pairs: [{ find: 'הבית', replace: 'Y' }] });
  assert.equal(t.task_name, 'Y Y ובY');
  assert.equal(r2.pairs[0].replaced, 3);
});

test('notebooks: only the text between the tags; entities and attributes are left alone', () => {
  const db = load();
  const t = task(db);
  addRow(db, 'TASKMEMO', { memo_id: '990010', task_id: t.task_id, memo_type_id: '1', proj_id: t.proj_id, task_memo: '<HTML><BODY><A href="http://tgs.example/TGS">TGS</A> met Smith &amp; Co, <FONT color=TGS>TGS Ltd</FONT></BODY></HTML>' });
  const r = run(db, { pairs: [{ find: 'TGS', replace: 'ABC' }, { find: 'Smith & Co', replace: 'Jones & Sons' }] });
  const m = rows(db, 'TASKMEMO').find((x) => x.memo_id === '990010')!.task_memo;
  assert.equal(m, '<HTML><BODY><A href="http://tgs.example/TGS">ABC</A> met Jones &amp; Sons, <FONT color=TGS>ABC Ltd</FONT></BODY></HTML>');
  assert.equal(r.pairs[0].where['TASKMEMO.task_memo'], 2);
  assert.equal(r.pairs[1].where['TASKMEMO.task_memo'], 1);
  // a replacement with & or < goes in escaped
  run(db, { pairs: [{ find: 'Jones', replace: 'A<B&C' }] });
  assert.match(rows(db, 'TASKMEMO').find((x) => x.memo_id === '990010')!.task_memo, /A&lt;B&amp;C &amp; Sons/);
});

test('IDs, GUIDs, dates, numbers, flags and P6\'s own codes are never touched', () => {
  const db = load();
  const t = task(db);
  Object.assign(t, { guid: 'TaskGUID-Task', task_type: 'TT_Task', status_code: 'TK_NotStart', duration_type: 'DT_FixedDrtn', target_start_date: '2026-01-05 08:00', target_drtn_hr_cnt: '80', suspend_date: '' });
  const before = JSON.stringify({ ...t, task_name: '', task_code: '' });
  const udf = addRow(db, 'UDFTYPE', { udf_type_id: '990020', table_name: 'TASK', udf_type_label: 'Task field', logical_data_type: 'FT_TEXT', udf_type_name: 'user_text1' });
  const r = run(db, { pairs: [{ find: 'Task', replace: 'Job' }, { find: 'TK', replace: 'XX' }, { find: 'FT', replace: 'GG' }], case_insensitive: true });
  assert.equal(JSON.stringify({ ...t, task_name: '', task_code: '' }), before);
  assert.equal(udf.table_name, 'TASK'); assert.equal(udf.logical_data_type, 'FT_TEXT'); assert.equal(udf.udf_type_name, 'user_text1');
  assert.equal(udf.udf_type_label, 'Job field');
  assert.ok(Object.keys(r.pairs[0].where).every((k) => !/guid|_id$|_type$|status_code|_date|_cnt/.test(k)), JSON.stringify(r.pairs[0].where));
  // a term with no letter is refused
  refused(db, { pairs: [{ find: '2026', replace: 'x' }] }, /no letter/);
});

test('the header\'s user, user name and database are renamed, in the old layout and in P6 18+', () => {
  const db = load();
  db.header = { version: '8.4', exportDate: '2026-01-02', raw: ['ERMHDR', '8.4', '2026-01-02', 'Project', 'tgs.admin', 'TGS Planner', 'TGS_DB', 'Project Management', 'EUR'] };
  const r = run(db, { pairs: [{ find: 'TGS', replace: 'ABC' }] });
  assert.deepEqual(db.header.raw, ['ERMHDR', '8.4', '2026-01-02', 'Project', 'tgs.admin', 'ABC Planner', 'TGS_DB', 'Project Management', 'EUR'], 'a short term is a whole word: TGS_DB is one word with its underscore, tgs.admin is lower case');
  assert.equal(r.pairs[0].where['ERMHDR.export_user_name'], 1);
  run(db, { pairs: [{ find: 'tgs', replace: 'abc' }, { find: 'TGS_DB', replace: 'DB1' }], case_insensitive: true });
  assert.deepEqual(db.header.raw.slice(4, 7), ['abc.admin', 'ABC Planner', 'DB1']);
  db.header = { version: '18.8', exportDate: '2026-09-24', raw: ['ERMHDR', '18.8', '2026-09-24', '', 'Project', 'ADMIN', 'PDC1_BASELINE', 'NordBuild GmbH', 'P6 Professional', '', 'EUR'] };
  const r2 = run(db, { pairs: [{ find: 'NordBuild', replace: 'Builder' }, { find: 'PDC1_BASELINE', replace: 'Planner' }] });
  assert.deepEqual(db.header.raw, ['ERMHDR', '18.8', '2026-09-24', '', 'Project', 'ADMIN', 'Planner', 'Builder GmbH', 'P6 Professional', '', 'EUR']);
  assert.ok(r2.pairs[0].where['ERMHDR.field_7'] === 1 || Object.keys(r2.pairs[0].where).some((k) => k.startsWith('ERMHDR.')));
});

test('an ID that would become the same as another is refused and nothing is changed; the whole call is one change', async () => {
  const db = load();
  const [a, b] = rows(db, 'TASK').filter((x) => x.proj_id === rows(db, 'TASK')[0].proj_id);
  a.task_code = 'TGS-1'; b.task_code = 'ABC-1';
  a.task_name = 'TGS first';
  refused(db, { pairs: [{ find: 'TGS', replace: 'ABC' }] }, /would make an ID the same/);
  assert.equal(a.task_code, 'TGS-1'); assert.equal(a.task_name, 'TGS first');
  // through the server: one undo takes the whole rename back
  const { callTool, toolResult } = await import('../mcp/server.ts');
  const call = async (name: string, args: Record<string, unknown>) => { const x = await callTool(name, args); return { err: x.isError, d: toolResult(x.out, x.isError).structuredContent as any }; };
  const np = (await call('new_project', { id: 'RT', start: '2026-03-02' })).d;
  const H = { handle: np.handle, owner_key: np.owner_key };
  assert.equal((await call('edit', { ...H, operations: [{ op: 'add_activity', id: 'A1', name: 'Acme one' }, { op: 'add_activity', id: 'A2', name: 'Acme two' }] })).err, false);
  const e = await call('edit', { ...H, operations: [{ op: 'replace_text', pairs: [{ find: 'Acme', replace: 'Client' }] }] });
  assert.equal(e.err, false, JSON.stringify(e.d));
  const names = async () => (await call('read_table', { ...H, table: 'TASK', columns: ['task_name'] })).d.rows.map((r: string[]) => r[0]).sort();
  assert.deepEqual(await names(), ['Client one', 'Client two']);
  assert.equal((await call('undo', { ...H })).err, false);
  assert.deepEqual(await names(), ['Acme one', 'Acme two'], 'one undo');
  await call('close', { ...H, discard: true });
});
