// set_notebook with a project alone: the project's notebook as P6 keeps it (WBSMEMO on the root WBS node, under a
// topic available for projects / WBS), on new and opened projects, through save and reopen, one MEMOTYPE table.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { applyOps } from '../core/project/ops.ts';
import { parseXer } from '../core/xer/parse.ts';
import { writeXer } from '../core/xer/write.ts';
import { parseP6Xml, writeP6Xml } from '../core/xml/p6xml.ts';
import { callTool, toolResult } from '../mcp/server.ts';
import { rows, type Db } from '../core/db.ts';
import { SAMPLES_DIR } from './helpers.ts';

const DRAFT = 'DRAFT — not reviewed';
const ok = (db: Db, ops: unknown[]) => { const r = applyOps(db, ops); assert.ok(r.ok, JSON.stringify(r.error)); return r.results; };
const xerText = (db: Db) => new TextDecoder().decode(writeXer(db, { version: '19.12', encoding: 'utf-8' }));
const reopen = (db: Db) => parseXer(new TextEncoder().encode(xerText(db))).db;
/** The project's notebook: topic -> text, from the WBSMEMO rows on its root WBS node. */
function notebook(db: Db, code: string) {
  const p = rows(db, 'PROJECT').find((x) => x.proj_short_name === code)!;
  const root = rows(db, 'PROJWBS').find((w) => w.proj_id === p.proj_id && w.proj_node_flag === 'Y')!;
  const mt = new Map(rows(db, 'MEMOTYPE').map((m) => [m.memo_type_id, m]));
  return Object.fromEntries(rows(db, 'WBSMEMO').filter((m) => m.wbs_id === root.wbs_id).map((m) => [mt.get(m.memo_type_id)!.memo_type, m.wbs_memo.replace(/<[^>]+>/g, '')]));
}
const tableCount = (xer: string, t: string) => xer.split('\r\n').filter((l) => l === `%T\t${t}`).length;

test('a new project: set_notebook with project writes the project notebook (WBSMEMO on the root WBS, topic for projects / WBS); kept through XER and P6 XML', () => {
  const db: Db = { tables: {} };
  ok(db, [{ op: 'add_project', id: 'NP', start: '2026-03-02' }, { op: 'add_activity', id: 'A1', name: 'One', duration_days: 1 }]);
  assert.deepEqual(ok(db, [{ op: 'set_notebook', project: 'NP', topic: 'Review Status', text: DRAFT }]), [{ notebook: 'NP / Review Status', project: 'NP' }]);
  const mt = rows(db, 'MEMOTYPE').find((m) => m.memo_type === 'Review Status')!;
  assert.deepEqual([mt.proj_flag, mt.wbs_flag, mt.task_flag, mt.eps_flag], ['Y', 'Y', 'N', 'N']);
  const root = rows(db, 'PROJWBS').find((w) => w.proj_node_flag === 'Y')!;
  assert.deepEqual(rows(db, 'WBSMEMO').map((m) => [m.wbs_id, m.proj_id, m.memo_type_id]), [[root.wbs_id, root.proj_id, mt.memo_type_id]]);
  // set again: replaced, not added; the project alone (one in the file) needs no "project"
  ok(db, [{ op: 'set_notebook', topic: 'review status', text: `${DRAFT} (2)` }]);
  assert.equal(rows(db, 'WBSMEMO').length, 1);
  assert.equal(rows(db, 'MEMOTYPE').length, 1);
  assert.deepEqual(notebook(db, 'NP'), { 'Review Status': `${DRAFT} (2)` });
  // XER: one MEMOTYPE and one WBSMEMO table, and back as it was
  const x = xerText(db);
  assert.deepEqual([tableCount(x, 'MEMOTYPE'), tableCount(x, 'WBSMEMO')], [1, 1]);
  assert.deepEqual(notebook(reopen(db), 'NP'), { 'Review Status': `${DRAFT} (2)` });
  assert.deepEqual(notebook(reopen(reopen(db)), 'NP'), { 'Review Status': `${DRAFT} (2)` });
  // P6 XML: a ProjectNote on the project's WBS, the topic available for projects and WBS
  const xml = writeP6Xml(db, { version: '19.12' });
  assert.match(xml, /<ProjectNote>.*<WBSObjectId>[^<]+<\/WBSObjectId>.*<\/ProjectNote>/s);
  assert.match(xml, /<NotebookTopic>.*<AvailableForProject>true<\/AvailableForProject><AvailableForWBS>true<\/AvailableForWBS>.*<\/NotebookTopic>/s);
  const back = parseP6Xml(xml).db;
  assert.deepEqual(notebook(back, 'NP'), { 'Review Status': `${DRAFT} (2)` });
  assert.equal(rows(back, 'MEMOTYPE')[0].proj_flag, 'Y');
  // "" removes it
  ok(db, [{ op: 'set_notebook', project: 'NP', topic: 'Review Status', text: '' }]);
  assert.deepEqual(notebook(db, 'NP'), {});
});

test('an opened XER: an existing topic of that name is reused (made available for projects), a new one added once; one MEMOTYPE table after save and reopen', () => {
  const src = readFileSync(join(SAMPLES_DIR, 'CfC.xer'));
  const db = parseXer(new Uint8Array(src)).db; // MEMOTYPE "WBS Description" (projects / WBS) and two WBS notes
  const code = rows(db, 'PROJECT')[0].proj_short_name;
  const before = rows(db, 'MEMOTYPE').length, notes = rows(db, 'WBSMEMO').length;
  ok(db, [{ op: 'set_notebook', project: code, topic: 'wbs description', text: DRAFT }, { op: 'set_notebook', project: code, topic: 'Review Status', text: 'second' }]);
  assert.equal(rows(db, 'MEMOTYPE').length, before + 1);
  assert.equal(rows(db, 'WBSMEMO').length, notes + 2);
  // an activity notebook under the project topic: the same topic, now available for activities too
  const act = rows(db, 'TASK')[0].task_code;
  ok(db, [{ op: 'set_notebook', activity: act, project: code, topic: 'Review Status', text: 'on an activity' }]);
  assert.equal(rows(db, 'MEMOTYPE').length, before + 1);
  assert.equal(rows(db, 'MEMOTYPE').find((m) => m.memo_type === 'Review Status')!.task_flag, 'Y');
  const x = xerText(db);
  assert.equal(tableCount(x, 'MEMOTYPE'), 1);
  const back = reopen(db);
  assert.deepEqual(notebook(back, code), { 'WBS Description': DRAFT, 'Review Status': 'second' });
  assert.equal(rows(back, 'WBSMEMO').length, notes + 2, 'the WBS notes of the file stay');
});

test('a file with two MEMOTYPE tables (an earlier platform bug) opens as one, reuses its topics and saves one table', () => {
  const head = '%T\tMEMOTYPE\r\n%F\tmemo_type_id\tseq_num\teps_flag\tproj_flag\twbs_flag\ttask_flag\tmemo_type\r\n';
  const text = new TextDecoder('windows-1252').decode(readFileSync(join(SAMPLES_DIR, 'CfC.xer')))
    .replace('%T\tOBS\r\n', `${head}%R\t90\t1\tN\tY\tY\tN\tReview Status\r\n%T\tOBS\r\n`);
  assert.equal(tableCount(text, 'MEMOTYPE'), 2);
  const { db, findings } = parseXer(new TextEncoder().encode(text));
  assert.ok(findings.some((f) => f.code === 'DUP_TABLE' && f.table === 'MEMOTYPE'));
  const code = rows(db, 'PROJECT')[0].proj_short_name;
  ok(db, [{ op: 'set_notebook', project: code, topic: 'Review Status', text: DRAFT }]);
  assert.equal(rows(db, 'MEMOTYPE').filter((m) => m.memo_type === 'Review Status').length, 1);
  assert.equal(rows(db, 'WBSMEMO').find((m) => m.memo_type_id === '90')!.wbs_memo.includes('DRAFT'), true);
  assert.equal(tableCount(xerText(db), 'MEMOTYPE'), 1);
});

test('MCP: set_notebook with project on a new and an opened project, saved and opened again (project_summary shows it); refused on a Microsoft Project file', async () => {
  const call = async (name: string, args: Record<string, unknown>) => { const r = await callTool(name, args); return toolResult(r.out, r.isError).structuredContent as any; };
  const dir = mkdtempSync(join(tmpdir(), 'p6nb-'));
  const n = await call('new_project', { id: 'NB', start: '2026-03-02' });
  assert.equal((await call('edit', { handle: n.handle, operations: [{ op: 'set_notebook', project: 'NB', topic: 'Review Status', text: DRAFT }] })).ok, true);
  const p1 = join(dir, 'nb.xer');
  await call('save', { handle: n.handle, owner_key: n.owner_key, path: p1 });
  const o = await call('open_file', { path: p1 });
  assert.deepEqual(o.summary.projects[0].notebook, [{ topic: 'Review Status', text: DRAFT }]);
  // an opened project: set again (replaced) and another topic, saved as P6 XML and opened again
  assert.equal((await call('edit', { handle: o.handle, operations: [{ op: 'set_notebook', project: 'NB', topic: 'Review Status', text: 'reviewed' }, { op: 'set_notebook', project: 'NB', topic: 'Scope', text: 'A & B < C' }] })).ok, true);
  const p2 = join(dir, 'nb.xml');
  await call('save', { handle: o.handle, owner_key: o.owner_key, path: p2 });
  const x = await call('open_file', { path: p2 });
  assert.deepEqual(x.summary.projects[0].notebook, [{ topic: 'Review Status', text: 'reviewed' }, { topic: 'Scope', text: 'A & B < C' }]);
  // Microsoft Project XML: refused, with a structured error, and nothing changed
  const m = await call('open_file', { path: join(import.meta.dirname, 'fixtures', 'rich-mspdi.xml') });
  const r = await call('edit', { handle: m.handle, operations: [{ op: 'update_activity', id: 'uid:140', name: 'Strip out (rev)' }, { op: 'set_notebook', text: DRAFT }] });
  assert.equal(r.ok, false);
  assert.deepEqual([r.error.code, r.error.index, r.error.format], ['unsupported_for_format', 1, 'mspdi']);
  assert.match(r.error.message, /cannot be kept in a Microsoft Project XML file/);
  assert.equal((await call('list_open', {})).open.find((h: any) => h.handle === m.handle).unsaved_changes, false);
});

test('the edit guide names set_notebook\'s project form (the platform detects support from it); the save guide its encoding default', async () => {
  const { toolsList } = await import('../mcp/server.ts');
  const tool = (n: string) => (toolsList() as { name: string; description: string; inputSchema: any }[]).find((t) => t.name === n)!;
  const line = tool('edit').description.split('\n').find((l) => l.startsWith('set_notebook:'));
  assert.equal(line, 'set_notebook: [activity] | project, topic, text (text "" removes the topic; answer removed: true/false; the topic itself stays). activity (+[project]): its activity notebook; project alone: the project\'s notebook (P6\'s WBSMEMO on the project\'s root WBS node). topic default "Notes", created when missing, else reused');
  assert.ok(line!.startsWith('set_notebook: [activity] | project, topic, text '));
  assert.match(tool('save').description, /encoding defaults to the file's own/);
});

test('text "" removes that topic\'s memo when there is one (removed: true), else does nothing (removed: false); the topic stays, also when the customer\'s own', () => {
  const db = parseXer(new Uint8Array(readFileSync(join(SAMPLES_DIR, 'CfC.xer')))).db;
  const code = rows(db, 'PROJECT')[0].proj_short_name, act = rows(db, 'TASK')[0].task_code;
  const types = () => rows(db, 'MEMOTYPE').map((m) => m.memo_type).sort();
  const before = types(), wbsNotes = rows(db, 'WBSMEMO').length;
  // nothing to remove: no memo of the customer's topic on the project, none of an unknown topic
  assert.deepEqual(ok(db, [{ op: 'set_notebook', project: code, topic: 'WBS Description', text: '' }, { op: 'set_notebook', project: code, topic: 'Nope', text: '' }, { op: 'set_notebook', activity: act, project: code, topic: 'WBS Description', text: '' }]),
    [{ cleared: 'WBS Description', project: code, removed: false }, { cleared: 'Nope', project: code, removed: false }, { cleared: 'WBS Description', removed: false }]);
  assert.deepEqual(types(), before, 'no topic added by a removal');
  // set, then remove: removed, the topic (the customer's) stays, the WBS notes of the file too
  ok(db, [{ op: 'set_notebook', project: code, topic: 'WBS Description', text: DRAFT }, { op: 'set_notebook', activity: act, project: code, topic: 'WBS Description', text: 'a' }]);
  assert.deepEqual(ok(db, [{ op: 'set_notebook', project: code, topic: 'WBS Description', text: '' }, { op: 'set_notebook', activity: act, project: code, topic: 'WBS Description', text: '' }]),
    [{ cleared: 'WBS Description', project: code, removed: true }, { cleared: 'WBS Description', removed: true }]);
  assert.deepEqual(types(), before);
  assert.equal(rows(db, 'WBSMEMO').length, wbsNotes);
  assert.deepEqual(notebook(db, code), {});
  // a topic the clone added stays too once its last memo goes
  ok(db, [{ op: 'set_notebook', project: code, topic: 'Review Status', text: DRAFT }]);
  assert.deepEqual(ok(db, [{ op: 'set_notebook', project: code, topic: 'Review Status', text: '' }]), [{ cleared: 'Review Status', project: code, removed: true }]);
  assert.ok(types().includes('Review Status'));
});

test('WBS notebooks, topic "*" and clear_notebooks (the anonymise op): every notebook of the project and its baselines goes, whatever its topic; Tower-A\'s EPS notebook too', () => {
  const db: Db = { tables: {} };
  ok(db, [{ op: 'add_project', id: 'NP', start: '2026-03-02' }, { op: 'add_wbs', code: 'S1', name: 'Structure' }, { op: 'add_activity', id: 'A1', name: 'One', wbs: 'S1', duration_days: 1 }]);
  assert.deepEqual(ok(db, [{ op: 'set_notebook', wbs: 'S1', topic: 'Scope', text: 'Client: Acme' }]), [{ notebook: 'NP / S1 / Scope', wbs: 'S1', project: 'NP' }]);
  const s1 = rows(db, 'PROJWBS').find((w) => w.wbs_short_name === 'S1')!;
  assert.deepEqual(rows(db, 'WBSMEMO').map((m) => m.wbs_id), [s1.wbs_id], 'on the WBS element, not the root');
  ok(db, [{ op: 'set_notebook', wbs: 'S1', topic: 'Risks', text: 'Acme risk' }, { op: 'set_notebook', topic: 'Notes', text: 'EPS: Acme / Region' }, { op: 'set_notebook', activity: 'A1', topic: 'Notes', text: 'Acme activity' }]);
  // topic "*": every topic of that WBS element; the project's notebook and the activity's stay
  assert.deepEqual(ok(db, [{ op: 'set_notebook', wbs: 'S1', topic: '*', text: '' }]), [{ cleared: 'every topic', wbs: 'S1', project: 'NP', removed: 2 }]);
  assert.equal(rows(db, 'WBSMEMO').length, 1);
  assert.equal(applyOps(db, [{ op: 'set_notebook', wbs: 'S1', topic: '*', text: 'x' }]).ok, false, '"*" only removes');
  // a baseline with notebooks of its own; a memo whose topic the file no longer lists (as P6 exports leave them)
  ok(db, [{ op: 'save_baseline', name: 'NP-BL' }]);
  rows(db, 'WBSMEMO').push({ wbs_memo_id: '99', proj_id: rows(db, 'PROJECT')[0].proj_id, memo_type_id: '77', wbs_id: s1.wbs_id, wbs_memo: 'orphan Acme' });
  assert.ok(rows(db, 'WBSMEMO').length >= 3 && rows(db, 'TASKMEMO').length === 2);
  assert.deepEqual(ok(db, [{ op: 'clear_notebooks', project: 'NP' }]), [{ activity_notebooks: 2, wbs_and_project_notebooks: rows(db, 'WBSMEMO').length, projects: 2 }].map((x) => ({ ...x, wbs_and_project_notebooks: 3 })));
  assert.deepEqual([rows(db, 'WBSMEMO').length, rows(db, 'TASKMEMO').length], [0, 0]);
  assert.ok(!xerText(db).includes('Acme'), 'nothing of the notebooks left in the XER');
  // Tower-A: its project notebook (topic 3, which its MEMOTYPE does not list) names the EPS
  const tower = parseXer(readFileSync(join(SAMPLES_DIR, 'tower_a_schedule.xer'))).db;
  assert.ok(xerText(tower).includes('EPS: Group / Middle East / Buildings'));
  ok(tower, [{ op: 'clear_notebooks' }]);
  assert.ok(!xerText(tower).includes('Middle East'));
});

test('update_baseline renames a baseline; in_baseline renames its activities, WBS and codes (renames only, a baseline only)', () => {
  const db: Db = { tables: {} };
  ok(db, [{ op: 'add_project', id: 'ACME', start: '2026-03-02' }, { op: 'add_wbs', code: 'S1', name: 'Acme structure' }, { op: 'add_activity', id: 'A1', name: 'Acme pour', wbs: 'S1', duration_days: 1 }, { op: 'save_baseline', name: 'ACME-BL1', assign_as: 'project' }]);
  assert.deepEqual(ok(db, [{ op: 'update_baseline', baseline: 'ACME-BL1', new_name: 'P1 - B1', name: 'Baseline 1' }]), [{ baseline: 'P1 - B1', was: 'ACME-BL1' }]);
  const b = rows(db, 'PROJECT').find((p) => p._baseline_of)!;
  const broot = rows(db, 'PROJWBS').find((w) => w.proj_id === b.proj_id && w.proj_node_flag === 'Y')!;
  assert.deepEqual([b.proj_short_name, broot.wbs_short_name, broot.wbs_name], ['P1 - B1', 'P1 - B1', 'Baseline 1']);
  ok(db, [{ op: 'set_project', new_id: 'P1', name: 'Project 1' }, { op: 'update_activity', id: 'A1', new_id: 'X1', name: 'Activity 1' }, { op: 'update_wbs', code: 'S1', new_code: 'W1', name: 'Area 1' },
    { op: 'update_activity', in_baseline: true, project: 'P1 - B1', id: 'A1', new_id: 'X1', name: 'Activity 1' }, { op: 'update_wbs', in_baseline: true, project: 'P1 - B1', code: 'S1', new_code: 'W1', name: 'Area 1' }]);
  const bt = rows(db, 'TASK').find((t) => t.proj_id === b.proj_id)!;
  assert.deepEqual([bt.task_code, bt.task_name], ['X1', 'Activity 1'], 'the baseline activity keeps matching the live one');
  assert.ok(!xerText(db).includes('Acme') && !xerText(db).includes('ACME'));
  // in_baseline: renames only, on a baseline, for the ops that rename
  const bad = (op: object) => { const r = applyOps(db, [op]); assert.equal(r.ok, false); return r.error!.message; };
  assert.match(bad({ op: 'update_activity', in_baseline: true, project: 'P1 - B1', id: 'X1', duration_days: 5 }), /renames only/);
  assert.match(bad({ op: 'update_activity', in_baseline: true, project: 'P1', id: 'X1', name: 'x' }), /No baseline "P1"/);
  assert.match(bad({ op: 'add_activity', in_baseline: true, project: 'P1 - B1', name: 'x' }), /in_baseline works with/);
  assert.match(bad({ op: 'update_baseline', baseline: 'P1 - B1', new_name: 'P1' }), /already exists/);
  // a global code type is not the baseline's: in_baseline does not rename it for every project
  ok(db, [{ op: 'add_code_type', name: 'Zone' }, { op: 'add_code_value', type: 'Zone', code: 'N', name: 'North' }]);
  assert.match(bad({ op: 'update_code_type', in_baseline: true, project: 'P1 - B1', name: 'Zone', new_name: 'Area' }), /No code type "Zone" of the baseline/);
  assert.match(bad({ op: 'update_code_value', in_baseline: true, project: 'P1 - B1', type: 'Zone', code: 'N', name: 'x' }), /No code type "Zone" of the baseline/);
  assert.ok(rows(db, 'ACTVTYPE').some((t) => t.actv_code_type === 'Zone'));
});
