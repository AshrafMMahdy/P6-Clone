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
  const none = await call('compare', { handle: h, model: join(FX, 'Duplex_A_20110907.ifc') });
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

  const same = await call('compare', { handle: h, model: join(FX, 'Duplex_A_20110907.ifc') });
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
  const csv = c.d.exported.files.find((f: any) => /compare-changes\.csv$/.test(f.path ?? f.file ?? ''));
  assert.ok(csv, 'the changes table is written');
  const csvPath = csv.path ?? csv.file;
  assert.ok(existsSync(csvPath));
  assert.ok(readFileSync(csvPath, 'utf8').includes(`removed,${gone.guid},`), 'the removed wall is a row of the table');

  // filters list a part; the totals stay the whole model's
  const onlyRemoved = await call('compare', { handle: h, model: rev, kind: 'removed' });
  assert.equal(onlyRemoved.d.changes.length, 1);
  assert.equal(onlyRemoved.d.listed, 1);
  assert.equal(onlyRemoved.d.changed, 2);
  assert.equal(onlyRemoved.d.summary.modified, 1);
  const noDoors = await call('compare', { handle: h, model: rev, class: 'IfcDoor' });
  assert.equal(noDoors.d.changes.length, 0);
  // a page
  const page = await call('compare', { handle: h, model: rev, max_changes: 1 });
  assert.equal(page.d.changes.length, 1);
  assert.equal(page.d.changes_total, 2);
  assert.equal(page.d.next_offset, 1);
  // what is refused, in words
  const mixed = await call('compare', { handle: h, model: rev, mode: 'computed' });
  assert.equal(mixed.err, true);
  assert.match(mixed.d.error.message, /model compares the 3D model/);
  const badKind = await call('compare', { handle: h, model: rev, kind: 'moved' });
  assert.equal(badKind.err, true);
  const badTol = await call('compare', { handle: h, model: rev, tolerance_m: 0 });
  assert.equal(badTol.err, true);
  const noFile = await call('compare', { handle: h, model: join(out, 'nowhere.ifc') });
  assert.equal(noFile.err, true);
});
