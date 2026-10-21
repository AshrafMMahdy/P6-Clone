import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const FX = join(import.meta.dirname, 'fixtures', '4d');
const call = async (name: string, args: Record<string, unknown>) => {
  const { callTool, toolResult } = await import('../mcp/server.ts');
  const r = await callTool(name, args);
  return { err: r.isError, d: toolResult(r.out, r.isError).structuredContent as any };
};

test('4D M1: model, rules, links, status, quantities, keys, packages, sidecar (Duplex, IFC2X3)', async () => {
  const out = mkdtempSync(join(tmpdir(), 'p6-4d-'));
  const np = (await call('new_project', { id: 'DUP', start: '2026-03-02' })).d;
  const h = np.handle, owner_key = np.owner_key;
  const ops: unknown[] = [];
  for (const [id, name, d] of [['L1W', 'Level 1 walls', 10], ['L2W', 'Level 2 walls', 8], ['ROOF', 'Roof', 5], ['WIN', 'Windows', 4]] as const) ops.push({ op: 'add_activity', id, name, duration_days: d });
  ops.push({ op: 'add_relationship', pred: 'L1W', succ: 'L2W' }, { op: 'add_relationship', pred: 'L2W', succ: 'ROOF' }, { op: 'add_relationship', pred: 'ROOF', succ: 'WIN' });
  assert.equal((await call('edit', { handle: h, owner_key, operations: ops })).err, false);
  await call('schedule', { handle: h, owner_key });

  const om = await call('open_model', { handle: h, owner_key, path: join(FX, 'Duplex_A_20110907.ifc') });
  assert.equal(om.err, false, JSON.stringify(om.d));
  assert.equal(om.d.schema, 'IFC2X3');
  assert.ok(om.d.elements > 200 && om.d.storeys.includes('Level 1'));
  assert.equal(om.d.geometry, 'ok');

  const walls1 = await call('list_elements', { handle: h, class: 'IfcWall', storey: 'Level 1', limit: 5 });
  assert.ok(walls1.d.total > 0);

  const rules = [
    { type: 'scope', activity: 'L1W', storey: 'Level 1', class: 'IfcWall' },
    { type: 'scope', activity: 'L2W', storey: 'Level 2', class: 'IfcWall' },
    { type: 'property', property: 'storey', equals: 'name' }, // the storey named "Roof" goes to the activity named "Roof"
    { type: 'scope', activity: 'WIN', class: 'IfcWindow' },
  ];
  const dry = await call('link_by_rules', { handle: h, rules, dry_run: true });
  assert.equal(dry.err, false, JSON.stringify(dry.d));
  assert.equal(dry.d.rules[0].matched_elements, walls1.d.total);
  assert.ok(dry.d.rules[2].matched_elements > 0, 'storey "Roof" matches the activity named Roof');
  assert.equal((await call('link_status', { handle: h })).d.links, 0, 'a dry run changes nothing');
  const applied = await call('link_by_rules', { handle: h, owner_key, rules });
  assert.equal(applied.d.applied.added, dry.d.proposed_links);

  // by hand: unknown ids are reported, many-to-many is allowed, remove works
  const door = (await call('list_elements', { handle: h, class: 'IfcDoor', limit: 1 })).d.elements[0].guid;
  const lk = await call('link_elements', { handle: h, owner_key, links: [{ activity: 'WIN', guids: [door, 'nope'] }, { activity: 'L1W', guids: [door], role: 'temporary' }, { activity: 'XX', guids: [door] }] });
  assert.equal(lk.d.added, 2);
  assert.deepEqual(lk.d.unknown_activities, ['XX']);
  assert.deepEqual(lk.d.unknown_guids, ['nope']);
  assert.equal((await call('link_elements', { handle: h, owner_key, mode: 'remove', links: [{ activity: 'L1W', guids: [door] }] })).d.removed, 1);
  assert.equal((await call('undo', { handle: h, owner_key })).err, false, 'link changes are undoable');
  const st = await call('link_status', { handle: h });
  assert.ok(st.d.elements_on_several_activities.some((x: any) => x.guid === door));
  assert.ok(st.d.unlinked_elements > 0 && st.d.unlinked_by_class.IfcSpace > 0);

  const q = await call('quantities', { handle: h, group_by: 'activity' });
  const l1 = q.d.groups.find((g: any) => g.group === 'L1W');
  assert.ok(l1.count === walls1.d.total + 1 && l1.volume_m3 > 0, JSON.stringify(l1));

  assert.equal((await call('set_4d_keys', { handle: h, owner_key })).d.set, 4);

  const nav = await call('export_4d', { handle: h, target: 'navisworks', path: join(out, 'nav') });
  assert.equal(nav.err, false, JSON.stringify(nav.d));
  const tagged = readFileSync(nav.d.written.find((p: string) => p.endsWith('-4D.ifc')), 'latin1');
  assert.equal((tagged.match(/'WHIQ_4D'/g) ?? []).length, 4);
  const sets = readFileSync(nav.d.written.find((p: string) => p.endsWith('-sets.xml')), 'utf8');
  assert.equal((sets.match(/<selectionset /g) ?? []).length, 4);
  assert.match(readFileSync(join(out, 'nav', 'timeliner.csv'), 'utf8'), /^UniqueId,Name,ActualEnabled/);
  const syn = await call('export_4d', { handle: h, target: 'synchro', path: join(out, 'syn') });
  assert.ok(syn.d.written.some((p: string) => p.endsWith('DUP.xml')));
  assert.match(readFileSync(syn.d.written.find((p: string) => p.endsWith('DUP.xml')), 'utf8'), /4D Key/);
  assert.equal((await call('export_4d', { handle: h, target: 'ifc4d', path: join(out, 'x') })).d.error.code, 'bad_input', 'IFC4 4D needs an IFC4 model');

  // the links travel beside the saved file and come back with it
  const xer = join(out, 'dup.xer');
  const sv = await call('save', { handle: h, owner_key, path: xer });
  assert.ok(existsSync(`${xer}.4d.json`), JSON.stringify(sv.d));
  const linked = (await call('list_elements', { handle: h, linked: true, limit: 1 })).d.total;
  const re = (await call('open_file', { path: xer })).d.handle;
  assert.equal((await call('list_elements', { handle: re, linked: true, limit: 1 })).d.total, linked);
});

test('4D M1: IFC4 4D round trip (buildingSMART scheduling example): import task links, export them back', async () => {
  const out = mkdtempSync(join(tmpdir(), 'p6-4d-'));
  const np = (await call('new_project', { id: 'BSI', start: '2026-03-02' })).d;
  const h = np.handle, owner_key = np.owner_key;
  const ops: unknown[] = [];
  for (const n of ['Slab #1', 'Wall #1', 'Wall #2', 'Wall #3', 'Wall #4']) ops.push({ op: 'add_activity', id: n.replace(/\W/g, ''), name: n, duration_days: 2 });
  ops.push({ op: 'add_relationship', pred: 'Slab1', succ: 'Wall1' });
  await call('edit', { handle: h, owner_key, operations: ops });
  await call('schedule', { handle: h, owner_key });
  const src = join(FX, 'construction-scheduling-task.ifc');
  assert.equal((await call('open_model', { handle: h, owner_key, path: src, geometry: false })).err, false);
  const dry = await call('import_4d', { handle: h, path: src, link: false });
  assert.equal(dry.d.proposed_links, 5, JSON.stringify(dry.d));
  const imp = await call('import_4d', { handle: h, owner_key, path: src });
  assert.equal(imp.d.added, 5);
  const ex = await call('export_4d', { handle: h, target: 'ifc4d', path: out });
  assert.equal(ex.err, false, JSON.stringify(ex.d));
  assert.equal(ex.d.tasks, 5);
  // the exported model carries the schedule: importing it again gives the same links
  const np2 = (await call('new_project', { id: 'BSI2', start: '2026-03-02' })).d;
  await call('edit', { handle: np2.handle, owner_key: np2.owner_key, operations: ops });
  const file = ex.d.written.find((p: string) => p.endsWith('.ifc'));
  await call('open_model', { handle: np2.handle, owner_key: np2.owner_key, path: file, geometry: false });
  const back = await call('import_4d', { handle: np2.handle, owner_key: np2.owner_key, path: file });
  assert.equal(back.d.added, 5, JSON.stringify(back.d));
  assert.match(readFileSync(file, 'latin1'), /IFCWORKSCHEDULE\([^)]*\.PLANNED\.\)/);
});

const VILLA = join(import.meta.dirname, '..', 'sample 4D', 'navisworks-real-2016-villa');
test('4D M1: TimeLiner from a real 2016 Navisworks file (.nwf) and its Excel grid, as activities', { skip: !existsSync(join(VILLA, 'Ashraf_Navisworks.nwf')) && 'the villa files are kept out of the repository' }, async () => {
  const np = (await call('new_project', { id: 'VILLA', start: '2016-02-01' })).d;
  const dry = await call('import_4d', { handle: np.handle, path: join(VILLA, 'Ashraf_Navisworks.nwf'), link: false, create_activities: true });
  assert.equal(dry.err, false, JSON.stringify(dry.d));
  assert.equal(dry.d.tasks, 12);
  assert.equal(dry.d.would_create.length, 12);
  const imp = await call('import_4d', { handle: np.handle, owner_key: np.owner_key, path: join(VILLA, 'Ashraf_Navisworks.nwf'), create_activities: true });
  assert.equal(imp.d.created_activities.length, 12);
  // the Excel grid (a later edit) now matches the created activities by name
  const xl = await call('import_4d', { handle: np.handle, path: join(VILLA, 'NWs schedule.xlsx'), link: false });
  assert.equal(xl.d.tasks, 12);
  assert.ok(xl.d.unmatched_tasks.length <= 1, JSON.stringify(xl.d.unmatched_tasks)); // "Bottom Roof slab" was renamed after the NWF
});
