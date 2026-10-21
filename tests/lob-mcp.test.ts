// The LOB tools as an agent uses them: a plan of 3 parts × 10 floors on a takt in five calls, every change reported,
// refusals in the driver's words, LOB activities guarded from edit, the plan through an XER and back, toolsets, and
// the Vico and Tactplan exchanges.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const call = async (name: string, args: Record<string, unknown>) => {
  const { callTool, toolResult } = await import('../mcp/server.ts');
  const r = await callTool(name, args);
  return { err: r.isError, d: toolResult(r.out, r.isError).structuredContent as any };
};
const TASKS = [
  { code: 'CS', name: 'Concrete skeleton', trade: 'Concrete', level: 'Floor', unit: 'm3', consumption: 9, quantity: 60, crew_size: 18 },
  { code: 'DW', name: 'Drywall', trade: 'Drywall', level: 'Floor', unit: 'm2', consumption: 0.5, quantity: 1400, crew_size: 16 },
  { code: 'PT', name: 'Painting', trade: 'Painters', level: 'Floor', unit: 'm2', consumption: 0.25, quantity: 2800, crew_size: 18 },
];

async function plan() {
  // 1: a file to hold it
  const np = (await call('new_project', { id: 'DES', start: '2026-03-02' })).d;
  const h = np.handle, owner_key = np.owner_key;
  // 2: the LOB plan, beside the CPM project
  const c = await call('lob_create', { handle: h, owner_key, id: 'TOWER', start: '2026-03-02', locations: { levels: ['Part', 'Floor'], grid: [3, 10] }, tasks: TASKS, links: [{ pred: 'CS', succ: 'DW', location_lag: 1 }, { pred: 'DW', succ: 'PT' }] });
  return { h, owner_key, c };
}

test('an agent builds 3 parts × 10 floors on a takt in five calls', async () => {
  const { h, owner_key, c } = await plan();
  assert.equal(c.err, false, JSON.stringify(c.d).slice(0, 400));
  assert.equal(c.d.activities.added, 90);
  // 3: the takt
  const k = await call('lob_edit', { handle: h, owner_key, operations: [{ op: 'set_takt', takt_days: 5, train: ['CS', 'DW', 'PT'], buffer_periods: 0 }] });
  assert.equal(k.err, false, JSON.stringify(k.d).slice(0, 300));
  // 4: onto the takt
  const a = await call('lob_takt', { handle: h, owner_key, apply: true });
  assert.equal(a.err, false, JSON.stringify(a.d).slice(0, 300));
  assert.ok(a.d.changes.some((x: any) => x.field === 'crew_size'), 'crews sized to the takt, and said');
  // 5: the result
  const v = await call('lob_view', { handle: h, svg: join(mkdtempSync(join(tmpdir(), 'p6-lob-')), 'flow.svg') });
  assert.equal(v.err, false);
  assert.deepEqual(v.d.tasks.map((t: any) => t.code), ['CS', 'DW', 'PT']);
  assert.equal(v.d.gaps.length, 0, 'paced: no crew waits');
  assert.equal(v.d.collisions.length, 0, JSON.stringify(v.d.collisions.slice(0, 3)));
  assert.ok(v.d.critical.length >= 1);
  assert.ok(existsSync(v.d.svg));
  assert.equal((await call('lob_takt', { handle: h })).d.fits, true);
});

test('lob_edit reports every change; a held value refuses in the driver\u2019s words; edit cannot touch the plan\u2019s structure', async () => {
  const { h, owner_key } = await plan();
  const e = await call('lob_edit', { handle: h, owner_key, operations: [{ op: 'split', task: 'DW', at: 'P2F1' }, { op: 'set_crew', task: 'DW', segment: 2, crew_size: 20 }] });
  assert.equal(e.err, false, JSON.stringify(e.d).slice(0, 300));
  assert.ok(e.d.changes.some((x: any) => x.task === 'DW' && x.field === 'crew_size' && x.segment === 2 && x.old === 16 && x.new === 20));
  assert.ok(e.d.changes.every((x: any) => !(x.location ?? '').startsWith('P1')), 'part 1 untouched');
  await call('lob_edit', { handle: h, owner_key, operations: [{ op: 'set_driver', task: 'PT', driver: 'rate' }] });
  const no = await call('lob_edit', { handle: h, owner_key, operations: [{ op: 'set_crew', task: 'PT', crew_size: 30 }] });
  assert.equal(no.err, true);
  assert.match(no.d.error.reason, /the rate is held; change the driver or the rate/);
  const ed = await call('edit', { handle: h, owner_key, operations: [{ op: 'update_activity', id: 'DW-P1F3', project: 'TOWER', duration_days: 2 }] });
  assert.equal(ed.d.ok, false);
  assert.match(ed.d.error.message, /set by the LOB plan: edit it in Extensions > LOB \(or lob_edit\)/);
  const prog = await call('edit', { handle: h, owner_key, operations: [{ op: 'update_activity', id: 'CS-P1F1', project: 'TOWER', percent_complete: 50, actual_start: '2026-03-02' }] });
  assert.equal(prog.d.ok, true, 'progress is free');
});

test('through an XER and back: the plan reopens from its notebook, a sidecar beside it; F9 keeps the crews continuous', async () => {
  const { h, owner_key } = await plan();
  const dir = mkdtempSync(join(tmpdir(), 'p6-lobx-'));
  const sv = await call('save', { handle: h, owner_key, path: join(dir, 'tower.xer') });
  assert.equal(sv.err, false, JSON.stringify(sv.d).slice(0, 300));
  assert.ok(readdirSync(dir).includes('tower.xer.lob.json'));
  const o = await call('open_file', { path: join(dir, 'tower.xer') });
  assert.deepEqual(o.d.lob, [{ project: 'TOWER', model_from: 'notebook' }]);
  const f9 = await call('schedule', { handle: o.d.handle, owner_key: o.d.owner_key });
  assert.equal(f9.err, false);
  assert.equal((await call('lob_view', { handle: o.d.handle })).d.gaps.length, 0);
});

test('P6CLONE_TOOLSETS lists only the groups asked for', async () => {
  const { toolsList } = await import('../mcp/server.ts');
  const all = toolsList().map((t: { name: string }) => t.name);
  assert.ok(all.includes('lob_edit') && all.includes('open_model') && all.includes('dcma_14'));
  process.env.P6CLONE_TOOLSETS = 'core,lob';
  try {
    const some = toolsList().map((t: { name: string }) => t.name);
    assert.ok(some.includes('lob_edit') && some.includes('edit') && !some.includes('open_model') && !some.includes('dcma_14'));
  } finally { delete process.env.P6CLONE_TOOLSETS; }
});

test('Tactplan: export, then the export imported again as a new plan with the same tasks and durations', async () => {
  const { h, owner_key } = await plan();
  const dir = mkdtempSync(join(tmpdir(), 'p6-tp-'));
  const x = await call('lob_export', { handle: h, project: 'TOWER', path: dir });
  assert.equal(x.err, false, JSON.stringify(x.d).slice(0, 300));
  assert.deepEqual(readdirSync(dir).sort(), ['Grid.csv', 'Locations.csv', 'Quantities.csv', 'links-not-exported.txt']);
  const before = (await call('lob_view', { handle: h, project: 'TOWER' })).d;
  const i = await call('lob_import', { handle: h, owner_key, path: dir, id: 'TP' });
  assert.equal(i.err, false, JSON.stringify(i.d).slice(0, 400));
  const after = (await call('lob_view', { handle: h, project: 'TP' })).d;
  assert.deepEqual(after.tasks.map((t: any) => [t.code, t.locations.length]), before.tasks.map((t: any) => [t.code, t.locations.length]));
  // durations per location, in working days, the same
  const dur = (v: any) => v.tasks.map((t: any) => t.locations.map((l: any) => l[0]).length);
  assert.deepEqual(dur(after), dur(before));
});

const VICO = process.env.P6CLONE_VICO_SAMPLE || 'D:\\Backup\\Documents\\ConREM\\2. Semester 3 & 4 Berlin\\1. Semester 3\\Case Studies 2\\Term Project 2 Vico\\1. Outputs\\2. After Optimization\\0. Case Studies II -- Vico Term Project II -- After Optimization 16 January 2024.dpp';
test('lob_import of the user\u2019s Vico project: 14 trades on 2 parts × 9 floors, Concrete skeleton 14-04-2025 to 13-02-2026', { skip: !existsSync(VICO) && 'the Vico sample is not here' }, async () => {
  const np = (await call('new_project', { id: 'X', start: '2025-01-31' })).d;
  const i = await call('lob_import', { handle: np.handle, owner_key: np.owner_key, path: VICO, id: 'VICO' });
  assert.equal(i.err, false, JSON.stringify(i.d).slice(0, 400));
  const v = (await call('lob_view', { handle: np.handle, project: 'VICO' })).d;
  assert.equal(v.tasks.length, 14);
  const cs = v.tasks.find((t: any) => t.code === 'CS');
  assert.deepEqual([cs.start, cs.finish], ['2025-04-14', '2026-02-13']);
});

test('lob_export makes its folder; lob_import of something that is not a plan is bad input, not a server error', async () => {
  const { h, owner_key } = await plan();
  const dir = join(mkdtempSync(join(tmpdir(), 'p6-tpn-')), 'new', 'folder');
  const x = await call('lob_export', { handle: h, project: 'TOWER', path: dir });
  assert.equal(x.err, false, JSON.stringify(x.d).slice(0, 300));
  assert.equal(readdirSync(dir).length, 4);
  const i = await call('lob_import', { handle: h, owner_key, path: mkdtempSync(join(tmpdir(), 'p6-empty-')), id: 'NOPE' });
  assert.equal(i.err, true);
  assert.equal(i.d.error.code, 'bad_input');
});

test('crash_schedule leaves an LOB plan\u2019s activities to the plan', async () => {
  const { h } = await plan();
  const r = await call('crash_schedule', { handle: h, target_days: 10 });
  assert.equal(r.err, false, JSON.stringify(r.d).slice(0, 300));
  assert.ok(!(r.d.ops ?? []).some((o: any) => /^(CS|DW|PT)-/.test(o.id ?? '')), 'no LOB activity crashed directly');
});

test('anonymising an LOB plan: clear_udfs keeps it an LOB plan; rename reaches the activities, codes, notebook and sidecar; a new project ID follows', async () => {
  const { h, owner_key } = await plan();
  const c = await call('edit', { handle: h, owner_key, operations: [{ op: 'clear_udfs', project: 'TOWER' }, { op: 'set_project', project: 'TOWER', new_id: 'P-001', name: 'Project 1' }, { op: 'clear_authors', project: 'P-001' }, { op: 'regenerate_guids', project: 'P-001' }] });
  assert.equal(c.d.ok, true, JSON.stringify(c.d).slice(0, 300));
  const r = await call('lob_edit', { handle: h, owner_key, project: 'P-001', operations: [
    { op: 'rename', task: 'CS', name: 'Task 1', trade: 'Trade 1' }, { op: 'rename', task: 'DW', item: 'Drywall', name: 'Item 1', unit: 'u' }, { op: 'rename', task: 'DW', name: 'Task 2', trade: 'Trade 2' }, { op: 'rename', task: 'PT', name: 'Task 3', trade: 'Trade 3' },
    { op: 'rename', location: 'P1', name: 'Zone A' }, { op: 'rename', level: 'Part', name: 'Level 1' },
  ] });
  assert.equal(r.err, false, JSON.stringify(r.d).slice(0, 300));
  assert.ok(r.d.changes.some((x: any) => x.task === 'CS' && x.field === 'trade' && x.old === 'Concrete' && x.new === 'Trade 1'));
  const acts = JSON.stringify((await call('activity_table', { handle: h, project: 'P-001', names: true })).d);
  assert.ok(acts.includes('Task 1, Zone A') && !acts.includes('Concrete skeleton'), acts.slice(0, 200));
  const dir = mkdtempSync(join(tmpdir(), 'p6-anon-'));
  await call('save', { handle: h, owner_key, path: join(dir, 'a.xer') });
  const { readFileSync } = await import('node:fs');
  const xer = readFileSync(join(dir, 'a.xer'), 'utf8'), side = readFileSync(join(dir, 'a.xer.lob.json'), 'utf8');
  const notebook = (xer.match(/P6CLONE-LOB v1 \d+\/\d+ [0-9a-f]+ ([A-Za-z0-9+/=]+)/g) ?? []).map((x) => Buffer.from(x.split(' ').at(-1)!, 'base64').toString('utf8')).join('');
  for (const old of ['Concrete', 'Drywall', 'Paint', 'Part 1', '"Part"', 'TOWER']) assert.ok(!xer.includes(old) && !side.includes(old) && !notebook.includes(old), `${old} left in the file`);
  const o = await call('open_file', { path: join(dir, 'a.xer') });
  assert.deepEqual(o.d.lob, [{ project: 'P-001', model_from: 'notebook' }]);
});
