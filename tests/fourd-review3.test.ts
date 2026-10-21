// The platform's v0.1.22 review: every 4D import format read back from the clone's own exports, the renderer fenced
// (a program that is not Chromium fails the call, never the server), non-IFC files refused, and the sources kept free
// of the two slips found (innerHTML in the viewer, a control byte in a regular expression).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const ROOT = join(import.meta.dirname, '..');
const FX = join(import.meta.dirname, 'fixtures', '4d');
const call = async (name: string, args: Record<string, unknown>) => {
  const { callTool, toolResult } = await import('../mcp/server.ts');
  const r = await callTool(name, args);
  return { err: r.isError, d: toolResult(r.out, r.isError).structuredContent as any };
};
const ACTS = [['L1W', 'Level 1 walls', 'Level 1', 'IfcWall'], ['L2S', 'Level 2 slab', 'Level 2', 'IfcSlab'], ['L2W', 'Level 2 walls', 'Level 2', 'IfcWall']] as const;
async function linked(id: string, model = join(FX, 'Duplex_A_20110907.ifc'), link = true) {
  const np = (await call('new_project', { id, start: '2026-03-02' })).d;
  const h = np.handle, owner_key = np.owner_key;
  await call('edit', { handle: h, owner_key, operations: ACTS.map(([a, n]) => ({ op: 'add_activity', id: a, name: n, duration_days: 5 })) });
  await call('schedule', { handle: h, owner_key });
  await call('open_model', { handle: h, owner_key, path: model, geometry: false });
  if (link) await call('link_by_rules', { handle: h, owner_key, rules: ACTS.map(([a, , storey, cls]) => ({ type: 'scope', activity: a, storey, class: cls })) });
  return { h, owner_key };
}

test('import_4d reads each format the clone exports: search sets, TimeLiner CSV, IFC4 4D', async () => {
  const { h, owner_key } = await linked('IMP');
  const out = mkdtempSync(join(tmpdir(), 'p6-imp-'));
  const nw = await call('export_4d', { handle: h, target: 'navisworks', path: join(out, 'nw') });
  assert.equal(nw.err, false, JSON.stringify(nw.d).slice(0, 300));
  const sets = nw.d.written.find((f: string) => f.endsWith('-sets.xml')), csv = nw.d.written.find((f: string) => f.endsWith('timeliner.csv'));
  // a fresh project with the same activities and the package's model (its elements carry WHIQ_4D / Task), no links
  const tagged = nw.d.written.find((f: string) => f.endsWith('-4D.ifc'));
  const { h: h2, owner_key: k2 } = await linked('IMP2', tagged, false);
  const s = await call('import_4d', { handle: h2, owner_key: k2, path: sets });
  assert.equal(s.err, false, JSON.stringify(s.d).slice(0, 300));
  assert.equal(s.d.source, 'search_sets', 'the search-set XML is read as search sets, not as a CSV');
  assert.equal(s.d.sets.length, ACTS.length);
  assert.ok(s.d.sets.every((x: { elements: number }) => x.elements > 0), 'each set resolves against the model');
  const t = await call('import_4d', { handle: h2, owner_key: k2, path: csv, link: false });
  assert.equal(t.d.source, 'timeliner_csv');
  assert.equal(t.d.matched_activities, ACTS.length, 'every TimeLiner task matched its activity');
  assert.equal(t.d.activities_with_links, ACTS.length, 'attached sets link through the imported sets');
  // IFC4 4D needs an IFC4 model
  const np = (await call('new_project', { id: 'IMP4', start: '2026-03-02' })).d;
  await call('edit', { handle: np.handle, owner_key: np.owner_key, operations: ['Slab #1', 'Wall #1'].map((n) => ({ op: 'add_activity', id: n.replace(/\W/g, ''), name: n, duration_days: 2 })) });
  await call('schedule', { handle: np.handle, owner_key: np.owner_key });
  await call('open_model', { handle: np.handle, owner_key: np.owner_key, path: join(FX, 'construction-scheduling-task.ifc'), geometry: false });
  const i4 = await call('import_4d', { handle: np.handle, owner_key: np.owner_key, path: join(FX, 'construction-scheduling-task.ifc') });
  assert.equal(i4.d.source, 'ifc4d');
  const ex = await call('export_4d', { handle: np.handle, target: 'ifc4d', path: join(out, 'ifc4d') });
  assert.equal(ex.err, false, JSON.stringify(ex.d).slice(0, 300));
  const text = readFileSync(ex.d.written[0], 'latin1');
  for (const m of text.matchAll(/IFCTASKTIME\(([^;]*)\);/g)) assert.ok(!/,0\)$/.test(m[1]) && !/,0\.?\)$/.test(m[1]), 'IfcTaskTime.Completion is never 0 (IfcPositiveRatioMeasure)');
  const back = await call('import_4d', { handle: np.handle, owner_key: np.owner_key, path: ex.d.written[0], link: false });
  assert.equal(back.d.source, 'ifc4d');
  assert.equal(back.d.matched_activities, 2);
});

test('TimeLiner with a baseline as Planned: Actual holds only actual dates', async () => {
  const { h, owner_key } = await linked('TLA');
  await call('edit', { handle: h, owner_key, operations: [{ op: 'save_baseline', name: 'Plan' }] });
  const out = mkdtempSync(join(tmpdir(), 'p6-tla-'));
  const nw = await call('export_4d', { handle: h, target: 'navisworks', path: out, planned: 'Plan' });
  assert.equal(nw.err, false, JSON.stringify(nw.d).slice(0, 300));
  const rows = readFileSync(join(out, 'timeliner.csv'), 'utf8').trim().split(/\r?\n/).slice(1).map((r) => r.split(','));
  assert.ok(rows.length > 0 && rows.every((r) => r[2] === '0' && r[3] === '' && r[4] === ''), 'nothing has started, so nothing shows as done');
});

test('open_model refuses a file that is not an IFC, and keeps the links', async () => {
  const { h, owner_key } = await linked('NIF');
  const before = (await call('link_status', { handle: h })).d.links;
  const r = await call('open_model', { handle: h, owner_key, path: join(ROOT, 'tests', 'fixtures', '4d', 'README.md') });
  assert.equal(r.err, true);
  assert.match(JSON.stringify(r.d), /not an IFC file/);
  assert.equal((await call('link_status', { handle: h })).d.links, before);
});

test('render_4d: a P6CLONE_CHROMIUM that is not Chromium fails the call with render_failed; the server lives on', { timeout: 120_000 }, async () => {
  const np = (await call('new_project', { id: 'RF', start: '2026-03-02' })).d;
  const h = np.handle, owner_key = np.owner_key;
  await call('edit', { handle: h, owner_key, operations: [{ op: 'add_activity', id: 'W', name: 'Wall #1', duration_days: 2 }] });
  await call('schedule', { handle: h, owner_key });
  await call('open_model', { handle: h, owner_key, path: join(FX, 'construction-scheduling-task.ifc') });
  await call('link_by_rules', { handle: h, owner_key, rules: [{ type: 'scope', activity: 'W', class: 'IfcWall' }] });
  const saved = process.env.P6CLONE_CHROMIUM;
  // a program that exits at once (node itself, refusing Chromium's flags), as /bin/true did in the review
  process.env.P6CLONE_CHROMIUM = process.execPath;
  try {
    const r = await call('render_4d', { handle: h, path: mkdtempSync(join(tmpdir(), 'p6-rf-')), kind: 'images', step: 30, chromium_path: 'C:/Windows/System32/cmd.exe' });
    assert.equal(r.err, true);
    assert.equal(r.d.error.code, 'render_failed', JSON.stringify(r.d).slice(0, 300));
    assert.equal((await call('server_status', {})).err, false, 'the server still answers');
  } finally { if (saved == null) delete process.env.P6CLONE_CHROMIUM; else process.env.P6CLONE_CHROMIUM = saved; }
});

test('sources: no innerHTML in the viewer, no control bytes in the server code', () => {
  assert.ok(!readFileSync(join(ROOT, 'viewer4d', 'viewer.ts'), 'utf8').includes('innerHTML'), 'labels go in with textContent');
  for (const dir of ['core', 'mcp', 'main', 'viewer4d']) {
    const walk = (d: string): string[] => readdirSync(d).flatMap((f) => { const p = join(d, f); return statSync(p).isDirectory() ? walk(p) : /\.(ts|mjs|tsx)$/.test(f) ? [p] : []; });
    for (const f of walk(join(ROOT, dir))) assert.ok(!/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(readFileSync(f, 'latin1')), `${f} holds a control byte`);
  }
});
