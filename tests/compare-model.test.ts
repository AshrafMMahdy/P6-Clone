// compare {model}: the model attached to the project against another revision of it (it was the platform's own ifc_diff tool).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const FX = join(import.meta.dirname, 'fixtures', '4d');
const call = async (name: string, args: Record<string, unknown>) => {
  const { callTool, toolResult } = await import('../mcp/server.ts');
  const r = await callTool(name, args);
  return { err: r.isError, d: toolResult(r.out, r.isError).structuredContent as any };
};

test('compare {model}: what changed between the attached model and a revision — removed, renamed, the rest unchanged; filters, pages, files', async () => {
  const np = (await call('new_project', { id: 'CM', start: '2026-03-02' })).d;
  const h = np.handle, owner_key = np.owner_key;
  const none = await call('compare', { handle: h, model: join(FX, 'Duplex_A_20110907.ifc'), export: join(tmpdir(), 'p6-cm-none') });
  assert.equal(none.err, true);
  assert.equal(none.d.error.code, 'no_model', 'a project with no model attached says so');
  await call('open_model', { handle: h, owner_key, path: join(FX, 'Duplex_A_20110907.ifc') });
  const walls = (await call('list_elements', { handle: h, class: 'IfcWall', limit: 3 })).d.elements;
  const [gone, renamed] = walls;
  // the revision: one wall deleted, one wall renamed, nothing else touched
  let text = readFileSync(join(FX, 'Duplex_A_20110907.ifc'), 'latin1');
  const NL = String.fromCharCode(10);
  { const at = text.indexOf(`'${gone.guid}'`), ls = text.lastIndexOf(NL, at), le = text.indexOf(NL, at); text = text.slice(0, ls) + text.slice(le); }
  { const at = text.indexOf(`'${renamed.guid}'`), le = text.indexOf(NL, at); const line = text.slice(at, le); const quoted = [...line.matchAll(/'([^']*)'/g)]; const nameTok = quoted[1]; assert.ok(nameTok, 'the wall line has a name'); text = text.slice(0, at) + line.replace(`'${nameTok[1]}'`, `'RENAMED WALL REV 2'`) + text.slice(le); }
  const out = mkdtempSync(join(tmpdir(), 'p6-cm-'));
  const rev = join(out, 'Duplex_A_rev2.ifc');
  writeFileSync(rev, text, 'latin1');

  const same = await call('compare', { handle: h, model: join(FX, 'Duplex_A_20110907.ifc'), export: join(out, 'same') });
  assert.equal(same.err, false, JSON.stringify(same.d).slice(0, 400));
  assert.deepEqual([same.d.summary.added, same.d.summary.removed, same.d.summary.modified, same.d.summary.reidentified, same.d.changed], [0, 0, 0, 0, 0], 'a model against itself: nothing changed');

  const c = await call('compare', { handle: h, model: rev, export: join(out, 'files') });
  assert.equal(c.err, false, JSON.stringify(c.d).slice(0, 400));
  assert.equal(c.d.mode, 'model');
  assert.match(c.d.compared, /Duplex_A_20110907\.ifc \(the model attached to the project\) \(earlier\) . Duplex_A_rev2\.ifc \(the file\) \(later\)/);
  assert.equal(c.d.summary.removed, 1);
  assert.equal(c.d.summary.added, 0);
  assert.equal(c.d.summary.modified, 1);
  assert.equal(c.d.models.b.elements, c.d.models.a.elements - 1);
  const rm = c.d.changes.find((x: any) => x.kind === 'removed');
  assert.equal(rm.guid, gone.guid);
  assert.equal(rm.class, gone.class);
  const md = c.d.changes.find((x: any) => x.kind === 'modified');
  assert.equal(md.guid, renamed.guid);
  assert.ok(md.what.includes('name'), JSON.stringify(md));
  assert.deepEqual(md.detail.name, [renamed.name, 'RENAMED WALL REV 2']);
  assert.equal(c.d.by_class[gone.class].delta, -1);
  // the files: every change, as a table and whole
  assert.ok(c.d.exported?.files?.length >= 2, JSON.stringify(c.d.exported).slice(0, 300));
  const files = (r: any) => (r.d.exported.files as { path: string; rows?: number }[]);
  assert.deepEqual(files(c).map((f) => f.path.split(/[\\/]/).pop()).sort(), ['compare_model-changes.csv', 'compare_model.json'], 'its own two files: no table of a schedule comparison');
  const csvPath = files(c).find((f) => /compare_model-changes\.csv$/.test(f.path))!.path;
  assert.ok(existsSync(csvPath));
  assert.ok(readFileSync(csvPath, 'utf8').includes(`removed,${gone.guid},`), 'the removed wall is a row of the table');
  // who exported each revision (the file's own header), and only the classes that moved
  const header = /FILE_NAME\s*\([^;]*?'([^']*)'\s*,\s*'[^']*'\s*\)\s*;/s.exec(text.slice(0, 4000));
  assert.ok(c.d.models.a.exported_by && c.d.models.b.exported_by, JSON.stringify(c.d.models));
  if (header) assert.equal(c.d.models.a.exported_by, header[1], 'the application the IFC header names');
  assert.deepEqual(Object.keys(c.d.by_class), [gone.class], 'by_class lists the classes whose count moved');

  // filters list a part; the totals stay the whole model's
  const onlyRemoved = await call('compare', { handle: h, model: rev, kind: 'removed', export: join(out, 'filtered') });
  assert.equal(onlyRemoved.d.changes.length, 1);
  assert.equal(onlyRemoved.d.listed, 1);
  assert.equal(onlyRemoved.d.changed, 2);
  assert.equal(onlyRemoved.d.summary.modified, 1);
  // the files hold EVERY change whatever the filter and the page, and the JSON holds them as the answer does (not as cells)
  assert.equal(files(onlyRemoved).find((f) => /changes\.csv$/.test(f.path))!.rows, 2, 'a filtered call writes the whole list');
  const whole = JSON.parse(readFileSync(files(onlyRemoved).find((f) => /compare_model\.json$/.test(f.path))!.path, 'utf8'));
  assert.equal(whole.changes.length, 2);
  const wm = whole.changes.find((x: any) => x.kind === 'modified');
  assert.deepEqual(wm.what, md.what);
  assert.deepEqual(wm.detail.name, [renamed.name, 'RENAMED WALL REV 2']);
  assert.ok(Object.keys(whole.by_class).length > Object.keys(c.d.by_class).length, 'and every class, moved or not');
  const noDoors = await call('compare', { handle: h, model: rev, class: 'IfcDoor', export: join(out, 'doors') });
  assert.equal(noDoors.d.changes.length, 0);
  // a page
  const page = await call('compare', { handle: h, model: rev, max_changes: 1, export: join(out, 'page') });
  assert.equal(files(page).find((f) => /changes\.csv$/.test(f.path))!.rows, 2, 'a page of the answer, the whole list in the file');
  assert.equal(page.d.changes.length, 1);
  assert.equal(page.d.changes_total, 2);
  assert.equal(page.d.next_offset, 1);
  // what is refused, in words, before any model is read
  const refused = async (args: Record<string, unknown>, code: string, words: RegExp) => { const r = await call('compare', { handle: h, export: join(out, 'refused'), ...args }); assert.equal(r.err, true, JSON.stringify(args)); assert.equal(r.d.error.code, code, JSON.stringify(r.d.error)); assert.match(String(r.d.error.message), words); };
  await refused({ model: rev, mode: 'computed' }, 'bad_input', /model compares the 3D model/);
  await refused({ model: rev, kind: 'moved' }, 'bad_input', /kind must be one of added, removed, modified, reidentified/);
  await refused({ model: rev, tolerance_m: 0 }, 'bad_input', /tolerance_m must be a length in metres above 0/);
  await refused({ model: rev, max_changes: -1 }, 'bad_input', /max_changes/);
  await refused({ model: join(out, 'nowhere.ifc') }, 'model_unreadable', /No file at .*nowhere\.ifc/);
  assert.ok(!existsSync(join(out, 'refused', 'compare_model.json')), 'a refused call writes nothing');
  // the attached model is not touched by a comparison
  assert.equal((await call('list_elements', { handle: h, class: 'IfcWall', limit: 3 })).d.elements[0].guid, gone.guid);

  // what filters a model comparison, sent with a comparison of schedules: said as not used
  const other = (await call('new_project', { id: 'CM2', start: '2026-03-02' })).d;
  const sched = await call('compare', { handle: h, other_handle: other.handle, kind: 'removed', export: join(out, 'sched') });
  assert.equal(sched.err, false, JSON.stringify(sched.d).slice(0, 300));
  assert.ok((sched.d.notes ?? []).some((x: string) => /kind belongs to a comparison of models \(model\): not used/.test(x)), JSON.stringify(sched.d.notes));

  // two model files and no schedule: open_model with no handle makes a project of its own to compare in
  const own = await call('open_model', { path: join(FX, 'Duplex_A_20110907.ifc') });
  assert.equal(own.err, false, JSON.stringify(own.d).slice(0, 300));
  assert.ok(own.d.handle && own.d.handle !== h);
  const two = await call('compare', { handle: own.d.handle, model: rev, export: join(out, 'two') });
  assert.deepEqual([two.d.summary.removed, two.d.summary.modified], [1, 1]);
});
