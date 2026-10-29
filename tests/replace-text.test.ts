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

test('a term is a whole word whatever its length (TGS not in SETTINGS, Mall not in Small, Park not in Parking); anywhere: true matches inside words', () => {
  const db = load();
  const t = task(db);
  t.task_name = 'TGS Tower'; t.task_code = 'TGS-01';
  const w = rows(db, 'PROJWBS').find((x) => x.proj_node_flag !== 'Y')!; w.wbs_name = 'Edit SETTINGS of TGSX (TGS)';
  const q = rows(db, 'TASK')[1]; q.task_name = 'MyConstruction Co site, Construction Co';
  const r = run(db, { pairs: [{ find: 'TGS', replace: 'ABC' }, { find: 'Construction Co', replace: 'Builder' }] });
  assert.equal(t.task_name, 'ABC Tower');
  assert.equal(t.task_code, 'ABC-01');
  assert.equal(w.wbs_name, 'Edit SETTINGS of TGSX (ABC)');
  assert.equal(q.task_name, 'MyConstruction Co site, Builder', 'a phrase is a whole word too: not inside MyConstruction');
  assert.equal(r.pairs[1].replaced, 1);
  q.task_name = 'MyConstruction Co site, Construction Co';
  const r2 = run(db, { pairs: [{ find: 'Construction Co', replace: 'Builder' }], anywhere: true });
  assert.equal(q.task_name, 'MyBuilder site, Builder');
  assert.equal(r2.pairs[0].replaced, 2);
  // Mall / Small, Park / Parking / Park Lane
  q.task_name = 'Small Mall, Parking, Park Lane, Mall-2';
  run(db, { pairs: [{ find: 'Mall', replace: 'M' }, { find: 'Park', replace: 'P' }] });
  assert.equal(q.task_name, 'Small M, Parking, P Lane, M-2');
  q.task_name = 'Small Mall, Parking';
  run(db, { pairs: [{ find: 'Mall', replace: 'M' }, { find: 'Park', replace: 'P' }], anywhere: true, case_insensitive: true });
  assert.equal(q.task_name, 'SM M, Ping');
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

test('Arabic spellings: alef forms, ة/ه, ى/ي, Persian ک ی, tatweel and vowel marks are one for matching; the other letters of the text stay as the file has them', () => {
  const db = load();
  const t = task(db);
  // أحمد written with and without the hamza, with the tatweel and with vowel marks; مكتبة with ta marbuta or ha
  t.task_name = 'أحمد احمد إحمد أحـمد أَحْمَد، مكتبة مكتبه';
  const r = run(db, { pairs: [{ find: 'أحمد', replace: 'س' }, { find: 'مكتبة', replace: 'ص' }] });
  assert.equal(t.task_name, 'س س س س س، ص ص');
  assert.deepEqual(r.pairs.map((p) => p.replaced), [5, 2]);
  // the term spelled the other way finds them as well
  t.task_name = 'احمد أحمد مكتبة';
  run(db, { pairs: [{ find: 'احمد', replace: 'س' }, { find: 'مكتبه', replace: 'ص' }] });
  assert.equal(t.task_name, 'س س ص');
  // ى and ي, آ ٱ إ, Persian ی ک
  t.task_name = 'مصطفى مصطفي، آمنة امنة، کتاب كتاب كتابی';
  run(db, { pairs: [{ find: 'مصطفي', replace: 'م' }, { find: 'أمنه', replace: 'ن' }, { find: 'كتاب', replace: 'ك' }] });
  assert.equal(t.task_name, 'م م، ن ن، ك ك كتابی', 'كتابی is another word');
  // a short term (3 letters) keeps its whole-word rule and its prefixes with the variants; the text around keeps its own letters
  t.task_name = 'للأمل والامل بإمل وأملاك أُمَل';
  const r3 = run(db, { pairs: [{ find: 'أمل', replace: 'س' }] });
  assert.equal(t.task_name, 'للس والس بس وأملاك س', JSON.stringify(t.task_name));
  assert.equal(r3.pairs[0].replaced, 4);
  // other letters are not folded together (د and ذ stay two letters)
  t.task_name = 'احمد احمذ';
  run(db, { pairs: [{ find: 'احمد', replace: 'س' }] });
  assert.equal(t.task_name, 'س احمذ');
  // and it works inside a notebook between the tags, with the case rules of other scripts untouched
  addRow(db, 'WBSMEMO', { wbs_memo_id: '990030', proj_id: t.proj_id, wbs_id: rows(db, 'PROJWBS')[0].wbs_id, memo_type_id: '1', wbs_memo: '<HTML><BODY>مكتبه الأمل</BODY></HTML>' });
  run(db, { pairs: [{ find: 'مكتبة', replace: 'ص' }] });
  assert.equal(rows(db, 'WBSMEMO').find((x) => x.wbs_memo_id === '990030')!.wbs_memo, '<HTML><BODY>ص الأمل</BODY></HTML>');
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

test('HTML entities are never matched inside; the decoded text between the tags is what matches', () => {
  const db = load();
  const t = task(db);
  const memo = (id: string, html: string) => addRow(db, 'TASKMEMO', { memo_id: id, task_id: t.task_id, memo_type_id: '1', proj_id: t.proj_id, task_memo: html });
  const get = (id: string) => rows(db, 'TASKMEMO').find((x) => x.memo_id === id)!.task_memo;
  memo('990040', '<P>a &gt; b &lt; c &amp; d&nbsp;e &#1575;&#x6A9; f</P>');
  const r = run(db, { pairs: [{ find: 'gt', replace: 'X' }, { find: 'amp', replace: 'X' }, { find: 'nbsp', replace: 'X' }, { find: 'lt', replace: 'X' }, { find: 'x6A9', replace: 'X' }], anywhere: true });
  assert.equal(r.replaced, 0, JSON.stringify(r.pairs));
  assert.equal(get('990040'), '<P>a &gt; b &lt; c &amp; d&nbsp;e &#1575;&#x6A9; f</P>');
  // a term with & or a space is found through its entities; the other letters around are left as the file wrote them
  memo('990041', '<P>Smith&nbsp;&amp;&nbsp;Co &eacute;tude Smith &amp; Co</P>');
  const r2 = run(db, { pairs: [{ find: 'Smith & Co', replace: 'Jones <&> Sons' }] });
  assert.equal(get('990041'), '<P>Jones &lt;&amp;&gt; Sons &eacute;tude Jones &lt;&amp;&gt; Sons</P>');
  assert.equal(r2.pairs[0].where['TASKMEMO.task_memo'], 2);
  // an Arabic letter written as an entity matches as the letter
  memo('990042', '<P>&#1571;&#1581;&#1605;&#1583; and أحمد</P>');
  run(db, { pairs: [{ find: 'احمد', replace: 'س' }] });
  assert.equal(get('990042'), '<P>س and س</P>');
  // text with an entity but no tag is a memo too
  t.task_name = 'R &amp; D plan';
  run(db, { pairs: [{ find: 'amp', replace: 'X' }, { find: 'plan', replace: 'scheme' }] });
  assert.equal(t.task_name, 'R &amp; D scheme');
});

test('kept XML leaves: only names, descriptions and notes are text; Status, Type and the like are P6\'s own words', () => {
  const db = load();
  const p = rows(db, 'PROJECT')[0];
  for (const [f, v] of [['_xml_Name', 'Acme plan'], ['_xml_Description', 'for Acme'], ['_xml_Notes#2', 'Acme note'], ['_xml_Status', 'Acme Active'], ['_xml_Type', 'Acme'], ['_xml_Priority', 'Acme High'], ['_xml_Detail', '<a>Acme</a>']] as const) { addField(db.tables.PROJECT, f); p[f] = v; }
  run(db, { pairs: [{ find: 'Acme', replace: 'Client' }] });
  assert.deepEqual(['_xml_Name', '_xml_Description', '_xml_Notes#2'].map((f) => p[f]), ['Client plan', 'for Client', 'Client note']);
  assert.deepEqual(['_xml_Status', '_xml_Type', '_xml_Priority', '_xml_Detail'].map((f) => p[f]), ['Acme Active', 'Acme', 'Acme High', '<a>Acme</a>']);
});

test('matches made through an Arabic or Hebrew prefix are listed with the word and field', () => {
  const db = load();
  const t = task(db), q = rows(db, 'TASK')[1];
  t.task_name = 'שרון רון והרון';
  q.task_name = 'والأمل أمل بالأمل';
  const r = applyOps(db, [{ op: 'replace_text', pairs: [{ find: 'רון', replace: 'X' }, { find: 'أمل', replace: 'س' }] }]).results[0] as any;
  assert.equal(t.task_name, 'שX X והX', 'שרון is taken for ש + רון: over-replacing is the safer side');
  const words = r.prefixed_matches.map((m: any) => `${m.find}|${m.word}|${m.field}`).sort();
  assert.deepEqual(words, ['רון|והרון|TASK.task_name', 'רון|שרון|TASK.task_name', 'أمل|بالأمل|TASK.task_name', 'أمل|والأمل|TASK.task_name'].sort());
  assert.equal(r.prefixed_total, 4);
  assert.match(r.prefixed_note, /prefix/);
  // none made through a prefix: no list
  t.task_name = 'Acme';
  assert.equal((applyOps(db, [{ op: 'replace_text', pairs: [{ find: 'Acme', replace: 'X' }] }]).results[0] as any).prefixed_matches, undefined);
});
