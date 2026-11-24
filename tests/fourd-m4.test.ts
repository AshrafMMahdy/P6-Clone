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

test('4D M4: links survive a re-export that changes every GlobalId; a deleted element loses its links', async () => {
  const np = (await call('new_project', { id: 'RL', start: '2026-03-02' })).d;
  const h = np.handle, owner_key = np.owner_key;
  await call('edit', { handle: h, owner_key, operations: [{ op: 'add_activity', id: 'W1', name: 'Level 1 walls', duration_days: 5 }, { op: 'add_activity', id: 'W2', name: 'Level 2 walls', duration_days: 5 }] });
  await call('open_model', { handle: h, owner_key, path: join(FX, 'Duplex_A_20110907.ifc') });
  await call('link_by_rules', { handle: h, owner_key, rules: [{ type: 'scope', activity: 'W1', storey: 'Level 1', class: 'IfcWall' }, { type: 'scope', activity: 'W2', storey: 'Level 2', class: 'IfcWall' }] });
  const before = (await call('link_status', { handle: h })).d.links;
  // the revision: every rooted GlobalId regenerated (an exporter's churn), and one linked wall deleted
  const victim = (await call('list_elements', { handle: h, linked: 'W1', limit: 1 })).d.elements[0];
  let text = readFileSync(join(FX, 'Duplex_A_20110907.ifc'), 'latin1');
  const ALPHA = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz_$';
  let n = 0;
  text = text.replace(/^(#\d+\s*=\s*IFC[A-Z0-9]+\(\s*')([0-9A-Za-z_$]{22})'/gm, (_m, a: string, g: string) => { if (g === victim.guid) return `${a}${g}'`; n++; return `${a}${(n.toString(36) + '0'.repeat(22)).slice(0, 22).replace(/[^0-9A-Za-z]/g, ALPHA[n % 64])}'`; });
  { const NL = String.fromCharCode(10), at = text.indexOf(`'${victim.guid}'`), ls = text.lastIndexOf(NL, at), le = text.indexOf(NL, at); text = text.slice(0, ls) + text.slice(le); }
  const out = mkdtempSync(join(tmpdir(), 'p6-rl-'));
  const rev = join(out, 'Duplex_A_rev2.ifc');
  writeFileSync(rev, text, 'latin1');
  const dry = await call('relink_model', { handle: h, path: rev, dry_run: true });
  assert.equal(dry.err, false, JSON.stringify(dry.d).slice(0, 500));
  assert.equal(dry.d.kept, 0, 'every GlobalId changed');
  assert.equal(dry.d.lost, 1);
  assert.equal(dry.d.lost_elements[0].guid, victim.guid);
  assert.equal(dry.d.matched, before - 1);
  const done = await call('relink_model', { handle: h, owner_key, path: rev });
  assert.equal(done.err, false);
  const st = (await call('link_status', { handle: h })).d;
  assert.equal(st.links, before - 1);
  assert.equal(st.links_to_missing_elements.length, 0, 'every remaining link points into the new model');
});

const SCHEP = join(import.meta.dirname, '..', 'sample 4D');
const schepSp = join(SCHEP, 'synchro', 'schependomlaan', 'Synchro project Schependomlaan.sp'), schepIfc = join(SCHEP, 'ifc-models', 'schependomlaan', 'IFC Schependomlaan.ifc');
test('4D: a SYNCHRO project (.sp) comes in as activities and their element links to the design model', { skip: !existsSync(schepSp) || !existsSync(schepIfc) ? 'Schependomlaan samples not present' : false, timeout: 600_000 }, async () => {
  const np = (await call('new_project', { id: 'SCH', start: '2015-02-02' })).d;
  const h = np.handle, owner_key = np.owner_key;
  assert.equal((await call('open_model', { handle: h, owner_key, path: schepIfc, geometry: false })).err, false);
  const dry = await call('import_4d', { handle: h, owner_key, path: schepSp, link: false, create_activities: true });
  assert.equal(dry.err, false, JSON.stringify(dry.d).slice(0, 400));
  assert.equal(dry.d.source, 'synchro');
  assert.ok(dry.d.would_create.length > 100, `${dry.d.would_create.length} activities to create`);
  const r = await call('import_4d', { handle: h, owner_key, path: schepSp, create_activities: true });
  assert.equal(r.err, false, JSON.stringify(r.d).slice(0, 400));
  assert.ok(r.d.created_activities.some((a: { id: string }) => a.id === 'ST00020'), 'SYNCHRO task IDs kept as Activity IDs');
  assert.ok(r.d.added > 3000, `${r.d.added} links`);
  const st = (await call('link_status', { handle: h })).d;
  assert.equal(st.links_to_missing_elements.length, 0);
});

const paths3d = join(SCHEP, 'synchro', 'bentley-kb-training', 'Challenge Models', 'Challenge Model_3D Paths.sp');
test('4D: a SYNCHRO project (.sp) opened as the model itself: its 3D objects are the elements, and its own tasks link to them', { skip: !existsSync(paths3d) && 'SYNCHRO training samples not present', timeout: 600_000 }, async () => {
  const np = (await call('new_project', { id: 'SPM', start: '2018-07-02' })).d;
  const h = np.handle, owner_key = np.owner_key;
  const om = await call('open_model', { handle: h, owner_key, path: paths3d });
  assert.equal(om.err, false, JSON.stringify(om.d).slice(0, 400));
  assert.equal(om.d.source.format, 'SYNCHRO');
  assert.deepEqual([om.d.elements, om.d.source.resources, om.d.source.scene_only], [3011, 2975, 36]);
  assert.equal(om.d.geometry, 'ok');
  const r = await call('import_4d', { handle: h, owner_key, path: paths3d, create_activities: true });
  assert.equal(r.err, false, JSON.stringify(r.d).slice(0, 400));
  assert.deepEqual(r.d.created_activities.map((a: { id: string }) => a.id).sort(), ['ST00160', 'ST00180']);
  assert.equal(r.d.added, 4, 'the file\u2019s four assignments, each to its own object');
  assert.ok(!r.d.notes.some((n: string) => /\(#id\)/.test(n)), 'the design-model note does not apply to the file opened as its own model');
  assert.ok(r.d.notes.some((n: string) => /Load 3 along "Crane 2 - Podium Lift"/.test(n)), 'the 3D path is named');
  const st = (await call('link_status', { handle: h })).d;
  assert.deepEqual([st.links, st.links_to_missing_elements.length], [4, 0]);
  const lifted = (await call('list_elements', { handle: h, linked: 'ST00160' })).d.elements as { name: string; guid: string }[];
  assert.deepEqual(lifted.map((e) => e.name).sort(), ['Load 3', 'Tower Crane 2']);
  assert.ok((await call('element_info', { handle: h, guids: [lifted.find((e) => e.name === 'Load 3')!.guid] })).d.elements[0].geom, 'the load SYNCHRO made is drawn');
  assert.equal(om.d.source.without_geometry, 0);
  // the IFC declares a face set closed only when it is: as many open ones as the clone's own meshing finds
  const { spToIfc: conv } = await import('../core/bim/synchroModel.ts');
  assert.equal((readFileSync((await conv(paths3d)).ifc, 'latin1').match(/IFCTRIANGULATEDFACESET\(#\d+,\$,\.F\./g) ?? []).length, om.d.meshed_without_volume);
  // the model's index as it is found again after a restart names the conversion's IFC, not the .sp: the file's own
  // objects are what decide the route
  const { spToIfc } = await import('../core/bim/synchroModel.ts');
  const np2 = (await call('new_project', { id: 'SPR', start: '2018-07-02' })).d;
  assert.equal((await call('open_model', { handle: np2.handle, owner_key: np2.owner_key, path: (await spToIfc(paths3d)).ifc, geometry: false })).err, false);
  const again = await call('import_4d', { handle: np2.handle, owner_key: np2.owner_key, path: paths3d, create_activities: true });
  assert.equal(again.d.added, 4, JSON.stringify(again.d).slice(0, 300));
});

test('4D M7 (optional): the SYNCHRO cloud connector stays dormant without Bentley credentials', async () => {
  const saved = [process.env.BENTLEY_CLIENT_ID, process.env.BENTLEY_CLIENT_SECRET];
  delete process.env.BENTLEY_CLIENT_ID; delete process.env.BENTLEY_CLIENT_SECRET;
  try {
    const np = (await call('new_project', { id: 'SC', start: '2026-03-02' })).d;
    const r = await call('synchro_cloud', { handle: np.handle, owner_key: np.owner_key, action: 'push_tasks', schedule_id: 'x' });
    assert.equal(r.err, false);
    assert.equal(r.d.configured, false);
    assert.equal(r.d.optional, true);
  } finally { if (saved[0] != null) process.env.BENTLEY_CLIENT_ID = saved[0]; if (saved[1] != null) process.env.BENTLEY_CLIENT_SECRET = saved[1]; }
});
