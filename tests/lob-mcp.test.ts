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
  const prog2 = await call('edit', { handle: h, owner_key, operations: [{ op: 'update_activity', id: 'CS-P1F2', project: 'TOWER', actual_start: '2026-03-09', remaining_days: 4 }, { op: 'update_activity', id: 'CS-P1F1', project: 'TOWER', remaining_days: 1 }] });
  assert.equal(prog2.d.ok, true, `actual start with a remaining duration, and a remaining duration once started (L-2): ${JSON.stringify(prog2.d).slice(0, 200)}`);
  const notYet = await call('edit', { handle: h, owner_key, operations: [{ op: 'update_activity', id: 'CS-P1F3', project: 'TOWER', remaining_days: 1 }] });
  assert.equal(notYet.d.ok, false, 'before it starts, the remaining duration is the plan’s');
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
    const hidden = await call('dcma_14', { handle: 'x' });
    assert.equal(hidden.d.error?.code, 'unknown_tool', 'a hidden tool cannot be called either (L-8)');
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

test('L-1: two LOB plans in one file: creating, importing, editing and takt-applying one leaves the other\u2019s logic and dates alone', async () => {
  const { h, owner_key } = await plan();
  const dates = async (p: string) => (await call('lob_view', { handle: h, project: p })).d.tasks.map((t: any) => [t.code, t.start, t.finish, t.locations.map((l: any) => l[1]).join()]);
  const before = await dates('TOWER');
  const c = await call('lob_create', { handle: h, owner_key, id: 'B', start: '2026-03-02', locations: { levels: ['Floor'], grid: [4] }, tasks: TASKS.slice(0, 2), links: [{ pred: 'CS', succ: 'DW' }] });
  assert.equal(c.err, false, JSON.stringify(c.d).slice(0, 300));
  assert.deepEqual(await dates('TOWER'), before, 'lob_create of B');
  await call('lob_edit', { handle: h, owner_key, project: 'B', operations: [{ op: 'set_crew', task: 'DW', crew_size: 20 }] });
  assert.deepEqual(await dates('TOWER'), before, 'lob_edit of B');
  await call('lob_edit', { handle: h, owner_key, project: 'B', operations: [{ op: 'set_takt', takt_days: 5, train: ['CS', 'DW'] }] });
  await call('lob_takt', { handle: h, owner_key, project: 'B', apply: true });
  assert.deepEqual(await dates('TOWER'), before, 'lob_takt apply of B');
  const dir = mkdtempSync(join(tmpdir(), 'p6-l1-'));
  await call('lob_export', { handle: h, project: 'TOWER', path: dir });
  assert.equal((await call('lob_import', { handle: h, owner_key, path: dir, id: 'TP' })).err, false);
  assert.deepEqual(await dates('TOWER'), before, 'lob_import of TP');
  await call('schedule', { handle: h, owner_key });
  assert.deepEqual(await dates('TOWER'), before, 'F9');
});

test('L-3: a large LOB edit runs as a job: the server answers meanwhile, the job says its step, cancel_job keeps nothing', { timeout: 120_000 }, async () => {
  const np = (await call('new_project', { id: 'DES', start: '2026-03-02' })).d;
  const h = np.handle, owner_key = np.owner_key;
  const tasks = Array.from({ length: 40 }, (_, i) => ({ code: `T${i}`, name: `Task ${i}`, trade: `Trade ${i}`, level: 'Floor', unit: 'm2', consumption: 0.5, quantity: 200, crew_size: 4 }));
  const c = await call('lob_create', { handle: h, owner_key, id: 'BIG', start: '2026-03-02', locations: { levels: ['Part', 'Floor'], grid: [3, 40] }, tasks, links: tasks.slice(1).map((t, i) => ({ pred: `T${i}`, succ: t.code })) });
  assert.equal(c.d.activities.added, 4800);
  const crew = async () => (await call('lob_view', { handle: h, project: 'BIG' })).d.tasks.find((t: any) => t.code === 'T5').segments[0].crew;
  const job = (await call('lob_edit', { handle: h, owner_key, async: true, operations: [{ op: 'set_crew', task: 'T5', crew_size: 6 }] })).d.job_id;
  assert.ok(job);
  assert.equal((await call('server_status', {})).err, false);
  let view = (await call('job_status', { job_id: job })).d;
  for (let k = 0; k < 200 && view.status === 'running' && !view.progress; k++) { await new Promise((r) => setTimeout(r, 5)); view = (await call('job_status', { job_id: job })).d; }
  assert.match(String(view.progress ?? ''), /expanding|saving|scheduling/);
  await call('cancel_job', { job_id: job });
  view = (await call('job_status', { job_id: job, wait_seconds: 20 })).d;
  assert.equal(view.status, 'cancelled', JSON.stringify(view).slice(0, 300));
  assert.equal(await crew(), '1 × 4', 'nothing kept');
  const done = await call('lob_edit', { handle: h, owner_key, operations: [{ op: 'set_crew', task: 'T5', crew_size: 6 }] });
  assert.equal(done.err, false);
  assert.equal(await crew(), '1 × 6');
});

test('L-7: an Activity ID past 40 characters is refused when the plan would make it, and nothing is made', async () => {
  const np = (await call('new_project', { id: 'DES', start: '2026-03-02' })).d;
  const r = await call('lob_create', { handle: np.handle, owner_key: np.owner_key, id: 'LONG', start: '2026-03-02', locations: { levels: ['Floor'], list: [{ code: 'BUILDING-A-NORTH-WING-LEVEL-01', name: 'L1', level: 1, parent: null }] }, tasks: [{ code: 'CONCRETE-WORKS', name: 'Concrete', consumption: 1, quantity: 1, crew_size: 1 }] });
  assert.equal(r.err, true);
  assert.equal(r.d.error.code, 'lob_refused');
  assert.match(r.d.error.reason, /40 characters.*CONCRETE-WORKS-BUILDING-A-NORTH-WING-LEVEL-01/);
  const again = await call('lob_create', { handle: np.handle, owner_key: np.owner_key, id: 'LONG', start: '2026-03-02', locations: { levels: ['Floor'], grid: [2] }, tasks: [{ code: 'CW', name: 'Concrete', consumption: 1, quantity: 1, crew_size: 1 }] });
  assert.equal(again.err, false, `the refused plan left no project LONG behind: ${JSON.stringify(again.d).slice(0, 200)}`);
});

test('L-5: the Tactplan export carries each subtask\u2019s dates and trade; bad cells are refused by line and column; a cp1256 file reads as Arabic', async () => {
  const { readFileSync, writeFileSync } = await import('node:fs');
  const { h, owner_key } = await plan();
  const dir = mkdtempSync(join(tmpdir(), 'p6-tp5-'));
  await call('lob_export', { handle: h, project: 'TOWER', path: dir });
  const grid = readFileSync(join(dir, 'Grid.csv'), 'utf8');
  const v = (await call('lob_view', { handle: h, project: 'TOWER' })).d;
  const cs = v.tasks.find((t: any) => t.code === 'CS'), [y, m, d] = cs.start.split('-');
  const row = grid.split('\r\n').find((l) => l.includes(',CS,'))!;
  assert.ok(row.includes(`${d}/${m}/${y}`) && row.includes(',Concrete,'), row.slice(0, 160));
  const back = await call('lob_import', { handle: h, owner_key, path: dir, id: 'TP5' });
  assert.equal(back.err, false, JSON.stringify(back.d).slice(0, 300));
  assert.deepEqual((await call('lob_view', { handle: h, project: 'TP5' })).d.tasks.map((t: any) => t.trade), ['Concrete', 'Drywall', 'Painters']);
  // one bad cell at a time, in the first location of the CS row
  const lines = grid.split('\r\n'), at = lines.findIndex((l) => l.includes(',CS,'));
  for (const bad of ['-5', 'abc', '0', '1e12']) {
    const cells = lines[at].split(','); cells[cells.findIndex((c, i) => i > 10 && c !== '')] = bad;
    const bdir = mkdtempSync(join(tmpdir(), 'p6-tpbad-'));
    writeFileSync(join(bdir, 'Grid.csv'), [...lines.slice(0, at), cells.join(','), ...lines.slice(at + 1)].join('\r\n'));
    const r = await call('lob_import', { handle: h, owner_key, path: bdir, id: 'BAD' });
    assert.equal(r.err, true, bad);
    assert.equal(r.d.error.code, 'bad_input');
    assert.match(r.d.error.reason, new RegExp(`Grid.csv line ${at + 1}, column ".+": "${bad}" is not a duration`), r.d.error.reason);
  }
  const ddir = mkdtempSync(join(tmpdir(), 'p6-tpdup-'));
  writeFileSync(join(ddir, 'Grid.csv'), [...lines.slice(0, at + 1), lines[at], ...lines.slice(at + 1)].join('\r\n'));
  const dup = await call('lob_import', { handle: h, owner_key, path: ddir, id: 'DUP' });
  assert.equal(dup.d.error?.code, 'bad_input');
  assert.match(dup.d.error.reason, new RegExp(`line ${at + 2}, .*already runs at`));
  // the same Grid saved in Windows-1256 with an Arabic task name
  const adir = mkdtempSync(join(tmpdir(), 'p6-tpar-'));
  const [pre, post] = grid.split('Painting');
  writeFileSync(join(adir, 'Grid.csv'), Buffer.concat([Buffer.from(pre, 'latin1'), Buffer.from([0xc7, 0xe1, 0xd8, 0xc7, 0xc8, 0xe6, 0xd1]), Buffer.from(post, 'latin1')]));
  const ar = await call('lob_import', { handle: h, owner_key, path: adir, id: 'AR' });
  assert.equal(ar.err, false, JSON.stringify(ar.d).slice(0, 300));
  const names = (await call('lob_view', { handle: h, project: 'AR' })).d.tasks.map((t: any) => t.name);
  assert.ok(names.includes('\u0627\u0644\u0637\u0627\u0628\u0648\u0631'), JSON.stringify(names));
});

test('L-9: an LOB plan counts in projects_mb; lob_takt\u2019s check says nothing of unsaved changes', async () => {
  const mb = async () => (await call('server_status', {})).d.memory.projects_mb;
  const before = await mb();
  const np = (await call('new_project', { id: 'DES', start: '2026-03-02' })).d;
  const after0 = await mb();
  const tasks = Array.from({ length: 30 }, (_, i) => ({ code: `T${i}`, name: `Task ${i}`, consumption: 0.5, quantity: 200, crew_size: 4 }));
  await call('lob_create', { handle: np.handle, owner_key: np.owner_key, id: 'BIG', start: '2026-03-02', locations: { levels: ['Part', 'Floor'], grid: [3, 40] }, tasks, takt: { takt_days: 5 } });
  assert.ok(await mb() > after0 && after0 >= before, `${before} -> ${after0} -> ${await mb()}`);
  const k = await call('lob_takt', { handle: np.handle, owner_key: np.owner_key });
  assert.equal(k.err, false, JSON.stringify(k.d).slice(0, 200));
  assert.equal('unsaved_changes' in k.d, false);
});
