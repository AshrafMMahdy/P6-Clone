// What the answers say, third file: the faults an independent check of the notes found on real samples (2026-11-13), each pinned on the sample that showed it, with the figure
// recomputed here from the file's own rows (never with the helper the tool uses).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { callTool, toolResult, toolsList } from '../mcp/server.ts';
import { readXerFile } from '../core/xer/parseFile.ts';
import { sampleCopy, testRoots } from './helpers.ts';

process.env.P6CLONE_COMPUTE_WORKERS = '0';
testRoots();
const call = async (name: string, args: Record<string, unknown>) => { const r = await callTool(name, args); return toolResult(r.out, r.isError, name).structuredContent as any; };
const open = async (sample: string) => { const path = sampleCopy(sample); let o = await call('open_file', { path }); if (o.error) o = await call('open_file', { path, lenient: true }); assert.ok(o.handle, JSON.stringify(o).slice(0, 300)); return o; };
async function built(id: string, ops: unknown[]): Promise<string> {
  const p = await call('new_project', { id, start: '2026-01-05' });
  const e = await call('edit', { handle: p.handle, operations: ops });
  assert.ok(!e.error, JSON.stringify(e).slice(0, 300));
  return p.handle;
}
const act = (id: string, d: number, more: Record<string, unknown> = {}) => ({ op: 'add_activity', id, name: id, duration_days: d, ...more });
const num = (v: unknown) => Number(v || 0);
const csvLines = (file: string) => readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean);

test('a project baseline that is assigned but not in the file (an export without its baselines) is no baseline: earned value reads the file’s own budget, and every tool says which of the two it is', async () => {
  // 130 TRIAL.xer: the project row names baseline 759; no project 759 is in the file
  const db = readXerFile(sampleCopy('130 TRIAL.xer')).db;
  const P = db.tables.PROJECT.rows.filter((p) => !p._baseline_of);
  assert.equal(P.length, 1);
  assert.ok(P[0].sum_base_proj_id && !db.tables.PROJECT.rows.some((p) => p.proj_id === P[0].sum_base_proj_id), 'the file names a baseline it does not hold');
  // the budget, from the rows: the budgeted cost of every assignment and expense of the project's activities
  const mine = new Set(db.tables.TASK.rows.filter((t) => t.proj_id === P[0].proj_id).map((t) => t.task_id));
  const budget = (db.tables.TASKRSRC?.rows ?? []).filter((a) => mine.has(a.task_id)).reduce((s, a) => s + num(a.target_cost), 0) + (db.tables.PROJCOST?.rows ?? []).filter((e) => mine.has(e.task_id)).reduce((s, e) => s + num(e.target_cost), 0);
  assert.ok(budget > 1e6, `the file carries a budget (${budget})`);
  const o = await open('130 TRIAL.xer'), h = o.handle, id = P[0].proj_short_name;
  const ev = await call('earned_value', { handle: h });
  assert.ok(Math.abs(ev.projects[0].totals.bac - budget) < 1, `budget at completion ${ev.projects[0].totals.bac} is the file's ${budget} (it was 0)`);
  assert.equal(ev.projects[0].has_baseline, false);
  assert.ok(!ev.notes.some((n: string) => /carr(?:y|ies) no costs/.test(n)), 'the file carries costs: not said otherwise');
  const gone = `The project baseline of ${id} is not in this file (the file was exported without it): the current budget and dates were used; export the file with its baselines to measure against it.`;
  assert.ok(ev.notes.includes(gone), JSON.stringify(ev.notes));
  const pc = await call('progress_curves', { handle: h });
  assert.ok(pc.notes.includes(gone) && !pc.notes.some((n: string) => /No budgeted cost/.test(n)), JSON.stringify(pc.notes));
  assert.ok(Math.abs(pc.totals.bac - budget) < 1);
  const reason = `the project baseline of ${id} is not in this file (the file was exported without it); export the file with its baselines`;
  for (const [tool, part, arg] of [['dcma_14', 'Missed tasks and Baseline execution index (BEI)', true], ['check_schedule', 'Late activities and Baseline Execution Index (BEI)', false], ['planning_horizon', 'Forecast stability', true]] as const) {
    const a = await call(tool, { handle: h });
    assert.ok(a.notes.includes(`${part} not assessed: ${reason}${arg ? ', or pass baseline to name one that is in it' : ''}.`), `${tool}: ${JSON.stringify(a.notes)}`);
    assert.ok(!a.notes.some((n: string) => /no baseline is assigned/.test(n)), `${tool}: one IS assigned`);
  }
  const bv = await call('baseline_variance', { handle: h });
  assert.equal(bv.error.message, `The project baseline of ${id} is not in this file (the file was exported without it), and no other schedule was given.`);
  // none assigned at all (Detailed Program) keeps its own sentence
  const d = await open('Detailed Program.xer');
  const ev2 = await call('earned_value', { handle: d.handle });
  assert.ok(ev2.notes.some((n: string) => /^No baseline is assigned to C-A-FR-2: the current budget and dates were used; assign one with edit assign_baseline\.$/.test(n)), JSON.stringify(ev2.notes));
});

test('an edit confirms a baseline and a schedule option in P6’s words: one line for a saved baseline, the baseline by its name, the critical float in days', async () => {
  const h = await built('EDC', [act('A', 5), act('B', 5), { op: 'add_relationship', pred: 'A', succ: 'B' }]);
  const sb = await call('edit', { handle: h, operations: [{ op: 'save_baseline', name: 'BL-ONE' }] });
  assert.deepEqual(sb.changes, [{ id: 'BL-ONE', field: 'baseline', old: null, new: 'added' }]);
  const ab = await call('edit', { handle: h, operations: [{ op: 'assign_baseline', baseline: 'BL-ONE' }] });
  assert.deepEqual(ab.changes, [{ id: 'EDC', field: 'Project Baseline', old: null, new: 'BL-ONE' }]);
  const a2 = await call('edit', { handle: h, operations: [{ op: 'assign_baseline', baseline: 'BL-ONE', as: 'bl2' }] });
  assert.deepEqual(a2.changes, [{ id: 'EDC', field: 'Secondary Baseline', old: null, new: 'BL-ONE' }]);
  const so = await call('edit', { handle: h, operations: [{ op: 'set_schedule_options', critical_float_days: 2 }] });
  assert.deepEqual(so.changes, [{ id: 'EDC', field: 'Critical activities: Total Float at or below (days)', old: 0, new: 2 }]);
  for (const a of [sb, ab, a2, so]) assert.doesNotMatch(JSON.stringify(a.changes), /object Object|Sum base|drtn|"Rows"/);
});

test('review grades a check it could not assess "not_assessed" (not "pass") and says why in notes; review and schedule_health say the data date the schedule put in', async () => {
  const o = await open('small_villa_g_1_schedule.xer'), h = o.handle;
  const db = readXerFile(sampleCopy('small_villa_g_1_schedule.xer')).db;
  const proj = db.tables.PROJECT.rows[0];
  assert.equal(proj.last_recalc_date ?? '', '', 'the sample has no data date');
  assert.equal((db.tables.TASKRSRC?.rows ?? []).length, 0, 'and no resource assignment');
  const r = await call('review', { handle: h });
  const by = Object.fromEntries(r.checks.map((c: any) => [c.id, c]));
  assert.equal(by.invalid_dates.grade, 'not_assessed'); assert.equal(by.invalid_dates.of, 0);
  assert.equal(by.resources.grade, 'not_assessed');
  assert.ok(['pass', 'warn', 'fail'].includes(r.grade), 'the review’s own grade is of the checks that were assessed');
  assert.ok(r.notes.includes(`Invalid dates not assessed: ${proj.proj_short_name} has no data date; set one with schedule data_date.`), JSON.stringify(r.notes));
  assert.ok(r.notes.includes('Activities without resources not assessed: no resource is assigned to an activity.'), JSON.stringify(r.notes));
  assert.ok(!('detail' in by.invalid_dates) && !('detail' in by.resources), 'said once, in notes');
  // the calculation uses the planned start and says so, and that a calendar with no work week in the file got the default one
  const s = await call('schedule', { handle: h });
  const used = s.notes.find((n: string) => n.startsWith(`${proj.proj_short_name} has no data date: the planned start `));
  assert.ok(used, JSON.stringify(s.notes));
  const cal = db.tables.CALENDAR.rows.find((c) => !c.clndr_data);
  assert.ok(cal, 'the sample has a calendar with no work week');
  assert.ok(s.notes.includes(`Calendar ${cal!.clndr_name} has no work week in the file: the default 5-day week (no holidays) is used.`), JSON.stringify(s.notes));
  assert.equal(JSON.stringify(s).split('has no work week in the file').length - 1, 1, 'once in the answer');
  // afterwards the tools that judge against the data date say which date that is
  const r2 = await call('review', { handle: h }), sh = await call('schedule_health', { handle: h });
  assert.ok(r2.notes.includes(used) && sh.notes.includes(used), JSON.stringify([r2.notes, sh.notes]));
  assert.notEqual(r2.checks.find((c: any) => c.id === 'invalid_dates').grade, 'not_assessed');
});

test('a lenient open: what is not repaired is counted, an invalid code names the valid ones, a cut list of findings names the file that holds them all, a repeated row is said once', async () => {
  const p = await open('PDC1_Baseline_Rev0.xer');
  const bad = p.notes.find((n: string) => /not a valid code/.test(n));
  assert.match(bad, /^Not repaired: PROJECT\.def_duration_type is "Fixed Duration & Units", not a valid code \(valid: DT_FixedDUR2, DT_FixedDrtn, DT_FixedQty, DT_FixedRate\): P6 refuses the file \((\d+) of this kind\)\.$/);
  // counted from the file: every value of a coded column that is not one of P6's codes is one such finding; the note's count is the findings of that kind the answer counts
  assert.equal(Number(/\((\d+) of this kind\)/.exec(bad)![1]), p.diagnostics.counts.error - 1, 'the invalid codes: every error but the one about the end marker');
  const m = /^25 of (\d+) shown; all \1 in (.+\.csv)\.$/.exec(p.diagnostics.findings_note);
  assert.ok(m, p.diagnostics.findings_note);
  assert.equal(p.diagnostics.findings.length, 25); assert.equal(p.diagnostics.findings_total, Number(m![1]));
  assert.ok(existsSync(m![2]) && csvLines(m![2]).length - 1 >= Number(m![1]), 'the file holds every finding');
  // CCA: three activity rows repeat an id with other contents: said by the finding (with what save with repair does), not also by the open's own repair and by the summary
  const c = await open('CCA R03 dt 24Oct11SC.xer');
  const twice = c.notes.filter((n: string) => /appears twice in the file|repeat an id/.test(n));
  assert.equal(twice.length, 1, JSON.stringify(twice));
  assert.match(twice[0], /^Not repaired: Activity .+ appears twice in the file \(rows \d+ and \d+\) with different contents: P6 refuses the file; save with repair: true gives this one a new key when its Activity ID tells the two apart \(3 of this kind\)\.$/);
});

test('over-allocation is judged by one rule: a resource has over-allocated periods exactly when its severity is not "none"; resource_histogram and schedule_index count the same resources', async () => {
  const o = await open('130 TRIAL.xer'), h = o.handle;
  await call('schedule', { handle: h });
  const hist = await call('resource_histogram', { handle: h, export: 'hist' });
  const all = JSON.parse(readFileSync(hist.exported.files.find((f: any) => f.path.endsWith('.json')).path, 'utf8')).resources as any[];
  assert.ok(all.length > 25);
  for (const r of all) assert.equal(r.over_allocated_periods > 0, r.severity !== 'none', `${r.resource}: ${r.over_allocated_periods} periods, severity ${r.severity}`);
  const over = all.filter((r) => r.over_allocated_periods > 0).map((r) => r.resource).sort();
  assert.ok(over.length > 0);
  const si = await call('schedule_index', { handle: h, export: 'si' });
  const res = JSON.parse(readFileSync(si.exported.files.find((f: any) => f.path.endsWith('.json')).path, 'utf8'));
  const flat = JSON.stringify(res);
  const rowsOf = (v: any): any[] => (Array.isArray(v) && v.length && v[0] && typeof v[0] === 'object' && 'over_allocated' in v[0] && 'resource' in v[0] ? v : v && typeof v === 'object' ? Object.values(v).flatMap(rowsOf) : []);
  const siOver = [...new Set(rowsOf(res).filter((r) => r.over_allocated).map((r) => r.resource))].sort();
  assert.deepEqual(siOver, over, flat.slice(0, 200));
});

test('projects with different data dates: review, earned_value and monte_carlo say it in the one sentence the other tools use', async () => {
  const o = await open('Enppi.xer'), h = o.handle;
  const said = 'Master Rev.F-N-4 and 4229 update 2-6-12 have different data dates (2011-11-30, 2012-06-02): each project’s own date was used; pass project to work on one.';
  for (const tool of ['review', 'earned_value', 'dcma_14', 'schedule_health']) { const a = await call(tool, { handle: h }); assert.ok(a.notes.includes(said), `${tool}: ${JSON.stringify(a.notes)}`); }
  const mc = await call('monte_carlo', { handle: h, iterations: 10, seed: 3, sampler: { type: 'ratio_normal', mean: 1.1, std: 0.2, min_ratio: 0.5, max_ratio: 3 } });
  assert.ok(mc.notes.includes(said), JSON.stringify(mc.notes));
  const one = await call('review', { handle: h, project: 'Master Rev.F-N-4' });
  assert.ok(!(one.notes ?? []).some((n: string) => /different data dates/.test(n)));
});

test('one wording for "no resource is assigned": the reason of a part not assessed and the sentence of a tool with nothing to do (the loop sentence is in notes-a, test 3)', async () => {
  const n = await built('NR', [act('A', 5), act('B', 5), { op: 'add_relationship', pred: 'A', succ: 'B' }]);
  await call('schedule', { handle: n });
  assert.deepEqual((await call('resource_histogram', { handle: n })).notes, ['No resource is assigned to an activity: nothing to chart.']);
  assert.deepEqual((await call('level_resources', { handle: n, dry_run: true })).notes, ['No resource is assigned to an activity: nothing to level.']);
  for (const [tool, part] of [['schedule_index', 'Resource risk'], ['planning_horizon', 'Resources'], ['review', 'Activities without resources']] as const) {
    const a = await call(tool, { handle: n });
    assert.ok((a.notes ?? []).some((x: string) => x.startsWith(`${part} not assessed: no resource is assigned to an activity`) || new RegExp(`${part}.* not assessed: no resource is assigned to an activity`).test(x)), `${tool}: ${JSON.stringify(a.notes)}`);
  }
});

test('level_resources lists every moved activity (it writes files only when given export, as its description says); resource_summary names the type in P6\u2019s words', async () => {
  const o = await open('130 TRIAL.xer'), h = o.handle;
  await call('schedule', { handle: h });
  const l = await call('level_resources', { handle: h, dry_run: true });
  assert.ok(l.delayed > 25, `the sample delays more than 25 activities (${l.delayed})`);
  assert.equal(l.moved.length, l.delayed); assert.ok(!('exported' in l) && !('moved_total' in l));
  const d = (toolsList() as { name: string; description: string }[]).find((x) => x.name === 'level_resources')!.description;
  assert.match(d, /without export no file is written/); assert.doesNotMatch(d, /written to files every time|at most 25 rows/);
  const rs = await call('resource_summary', { handle: h });
  const db = readXerFile(sampleCopy('130 TRIAL.xer')).db;
  const kinds = { RT_Labor: 'labor', RT_Equip: 'nonlabor', RT_Mat: 'material' } as Record<string, string>;
  for (const r of rs.resources) assert.equal(r.type, kinds[db.tables.RSRC.rows.find((x) => x.rsrc_short_name === r.resource)!.rsrc_type], r.resource);
  assert.equal(rs.resources.length, Math.min(80, rs.total));
});

test('save as P6 XML: the note says the kinds and names a file that lists every field left out', async () => {
  const path = sampleCopy('Tower-A.xer');
  const o = await call('open_file', { path, lenient: true });
  const s = await call('save', { handle: o.handle, owner_key: o.owner_key, path: path.replace(/\.xer$/i, '.out.xml'), format: 'p6xml' });
  const note = (s.notes as string[]).find((n) => n.startsWith('Not written to P6 XML: '))!;
  const m = /; save as XER to keep them; each field is listed in (.+\.csv)\.$/.exec(note);
  assert.ok(m, note);
  const lines = csvLines(m![1]);
  assert.equal(lines[0], 'what,table,field,values,why');
  // the kinds of the sentence add up to the values of the file
  const inNote = [...note.matchAll(/\((\d+)\)/g)].reduce((a, x) => a + Number(x[1]), 0);
  const inFile = lines.slice(1).reduce((a, l) => a + Number(/^"[^"]*","[^"]*","[^"]*","(\d+)"/.exec(l)![1]), 0);
  assert.equal(inFile, inNote);
  assert.ok(!('not_in_p6_xml' in s));
});
