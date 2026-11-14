// What the answers say, third file: the faults an independent check of the notes found on real samples (2026-11-13), each pinned on the sample that showed it, with the figure
// recomputed here from the file's own rows (never with the helper the tool uses).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { callTool, toolResult, toolsList } from '../mcp/server.ts';
import { readXerFile } from '../core/xer/parseFile.ts';
import { sampleCopy, testRoots } from './helpers.ts';
import { config } from '../mcp/runtime.ts';

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
    assert.ok(!a.notes.some((n: string) => /no project baseline is assigned/.test(n)), `${tool}: one IS assigned`);
  }
  const bv = await call('baseline_variance', { handle: h });
  assert.equal(bv.error.message, `The project baseline of ${id} is not in this file (the file was exported without it), and no other schedule was given.`);
  // none assigned at all (Detailed Program) keeps its own sentence
  const d = await open('Detailed Program.xer');
  const ev2 = await call('earned_value', { handle: d.handle });
  assert.ok(ev2.notes.some((n: string) => /^No project baseline is assigned to C-A-FR-2: the current budget and dates were used; assign one with edit assign_baseline\.$/.test(n)), JSON.stringify(ev2.notes));
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
  const bad = p.notes.filter((n: string) => /not a value P6 has/.test(n));
  // (owner 2026-11-14: the sentence says the value is not one of P6's and what the repair does; that P6 refuses such a file is established by no source, so it is
  // not said. One sentence per column, with how many values of that column are such: what the repair puts is the column's)
  assert.deepEqual(bad, [
    'Not repaired: PROJECT.def_duration_type is "Fixed Duration & Units", which is not a value P6 has for it (P6\'s: DT_FixedDUR2, DT_FixedDrtn, DT_FixedQty, DT_FixedRate); save with repair: true empties it.',
    'Not repaired: PROJECT.def_qty_type is "Fixed Qty", which is not a value P6 has for it (P6\'s: QT_Hour, QT_Day, QT_Week, QT_Month, QT_Year); save with repair: true empties it.',
    'Not repaired: PROJWBS.status_code is "Active", which is not a value P6 has for it (P6\'s: WS_Planned, WS_Open, WS_Closed, WS_Whatif, WS_Requested) (13 such values in this column); save with repair: true puts WS_Open, P6\'s default.',
    'Not repaired: NB_0001 TASK.complete_pct_type is "CP_Start", which is not a value P6 has for it (P6\'s: CP_Drtn, CP_Phys, CP_Units) (248 such values in this column); save with repair: true puts CP_Drtn (Duration), P6\'s default.',
  ]);
  assert.ok(!p.notes.concat(p.diagnostics.findings.map((f: any) => f.message)).some((n: string) => /not a value P6 has|not a number|cannot be read as a date|where P6 has Y or N/.test(n) && /P6 refuses/.test(n)));
  // counted from the file: every such value is one finding; the sentences' counts add up to the errors but the one about the end marker
  assert.equal(1 + 1 + 13 + 248, p.diagnostics.counts.error - 1, 'the invalid codes: every error but the one about the end marker');
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

test('every analysis that judges from the saved dates says when they are not what a recalculation gives, once, in the sentence that does not order a recalculation; not on a file whose dates are current, and not after schedule', async () => {
  const TOOLS = ['critical_path', 'float_paths', 'dcma_14', 'check_schedule', 'decm', 'schedule_health', 'lint', 'schedule_index', 'planning_horizon', 'earned_value', 'progress_curves', 'resource_histogram', 'review'];
  // verify_fidelity_schedule.xer: 6 open activities whose saved early dates are not the ones its own logic gives (a file written by a tool, never calculated in P6)
  const o = await open('verify_fidelity_schedule.xer'), h = o.handle;
  const said = 'The saved dates of verify_fidelity are not what a recalculation gives (6 of 6 open activities differ): these figures are of the saved dates; run schedule to recalculate them.';
  for (const tool of TOOLS) {
    const a = await call(tool, { handle: h });
    assert.equal((a.notes ?? []).filter((n: string) => n === said).length, 1, `${tool}: ${JSON.stringify(a.notes)}`);
    assert.equal(JSON.stringify(a).split('are not what a recalculation gives').length - 1, 1, `${tool}: once in the answer`);
  }
  // an edit that leaves the dates not current says the fact and how to recalculate (it has no figures of its own)
  const e = await call('edit', { handle: h, operations: [{ op: 'update_activity', id: '1', duration_days: 9 }] });
  assert.ok(e.notes.some((n: string) => /^The saved dates of verify_fidelity are not what a recalculation gives \(\d of 6 open activities differ\); run schedule to recalculate them\.$/.test(n)), JSON.stringify(e.notes));
  // calculated: no tool says it
  await call('schedule', { handle: h });
  for (const tool of TOOLS) assert.ok(!JSON.stringify((await call(tool, { handle: h })).notes ?? []).includes('recalculation'), tool);
  // a real P6 export whose saved dates are its own (Detailed Program): none says it as opened
  const d = await open('Detailed Program.xer');
  for (const tool of TOOLS) assert.ok(!JSON.stringify((await call(tool, { handle: d.handle })).notes ?? []).includes('recalculation'), `Detailed Program ${tool}`);
});

test('dcma_14: a CPLI with no remaining critical path length says why from the activities, and never calls a project complete that has open work; CPLI is of its own project’s finish', async () => {
  const cpliOf = (d: any) => d.checks.find((c: any) => c.id === 'cpli');
  const reason = (d: any): string => String((d.notes as string[]).find((n) => /CPLI/.test(n) && /not assessed/.test(n)));
  const left = (proj: string, finish: string, status: string, open: string) => `Critical path length index (CPLI) not assessed: the latest finish of ${proj} (${finish}) is not after the status date (${status}) in working time of the project’s default calendar, so there is no remaining critical path to measure; ${open} not complete.`;
  const whose = (proj: string, n: number) => ` CPLI is of ${proj}, the first of ${n} projects in scope; pass project to measure another.`;
  const made = async (id: string, more: Record<string, unknown>, ops: unknown[]) => { const p = await call('new_project', { id, start: '2026-01-05', ...more }); const e = await call('edit', { handle: p.handle, operations: ops }); assert.ok(!e.error, JSON.stringify(e).slice(0, 300)); return p.handle as string; };

  // verify_fidelity_schedule.xer as opened: open activities whose saved dates were never calculated. From the file's own rows: how many activities
  // have no actual finish, the latest saved finish, the data date; the saved finish lies before the data date
  const db = readXerFile(sampleCopy('verify_fidelity_schedule.xer')).db;
  const rows = db.tables.TASK.rows.filter((t) => t.task_type !== 'TT_WBS');
  const openRows = rows.filter((t) => !t.act_end_date).length, lastFinish = rows.map((t) => String(t.act_end_date || t.reend_date || t.early_end_date || t.target_end_date || '')).sort().at(-1)!;
  const dataDate = String(db.tables.PROJECT.rows[0].last_recalc_date);
  assert.ok(openRows > 1 && lastFinish < dataDate, `${openRows} open, ${lastFinish} before ${dataDate}`);
  const o = await open('verify_fidelity_schedule.xer'), h = o.handle;
  const d = await call('dcma_14', { handle: h });
  assert.equal(cpliOf(d).result, 'not_assessed');
  assert.equal(reason(d), left('verify_fidelity', lastFinish, dataDate, `${openRows} activities are`));
  assert.ok(!/is complete/.test(JSON.stringify(d)), 'nothing calls this project complete');
  // the same file calculated: there is a length, so CPLI is measured
  await call('schedule', { handle: h });
  const d2 = await call('dcma_14', { handle: h });
  assert.ok(cpliOf(d2).denominator > 0 && cpliOf(d2).result !== 'not_assessed', JSON.stringify(cpliOf(d2)));
  assert.ok(!(d2.notes as string[]).some((n) => /CPLI/.test(n) && /not assessed/.test(n)));

  // every activity has an actual finish: the project IS complete, and only then is that said
  const done = await made('DONE', { must_finish_by: '2026-01-30' }, [act('A', 2, { actual_start: '2026-01-05 08:00', actual_finish: '2026-01-06 17:00' }), act('B', 3, { actual_start: '2026-01-07 08:00', actual_finish: '2026-01-09 17:00' }), { op: 'set_project', data_date: '2026-01-12' }]);
  await call('schedule', { handle: done });
  assert.equal(reason(await call('dcma_14', { handle: done })), 'Critical path length index (CPLI) not assessed: every activity of DONE is complete, so there is no remaining critical path to measure.');

  // ONE activity open, and a status date the caller passes (it replaces the data date): the date printed is the one passed, the count is singular,
  // and the latest finish (the open activity's, read from the activity table) lies before it
  const one = await made('ONE', { must_finish_by: '2026-03-31' }, [act('A', 5, { actual_start: '2026-01-05 08:00', actual_finish: '2026-01-09 17:00' }), act('B', 5), { op: 'add_relationship', pred: 'A', succ: 'B' }]);
  await call('schedule', { handle: one });
  const tb = await call('activity_table', { handle: one });
  const bFinish = String(tb.rows.find((r: unknown[]) => r[0] === 'B')[tb.columns.indexOf('finish')]);
  assert.match(bFinish, /^2026-01-\d\d 17:00$/, 'B, the open activity, finishes in January');
  assert.equal(reason(await call('dcma_14', { handle: one, status_date: '2026-03-02' })), left('ONE', bFinish, '2026-03-02 00:00', '1 activity is'));

  // a project with nothing but its WBS has no activities: it is neither complete nor waiting for a calculation
  const empty = await made('EMPTY', { must_finish_by: '2026-01-30' }, []);
  await call('schedule', { handle: empty });
  assert.equal(reason(await call('dcma_14', { handle: empty })), 'Critical path length index (CPLI) not assessed: EMPTY has no activities.');

  // two projects in one file. CPLI is of the first, from ITS finish and ITS activities (P2 finishes weeks later; the old code read P2's finish as P1's
  // forecast: 0.475, fail). 5 working days are left (5 January to 9 January), the Must Finish By date is 30 January
  const two = await made('P1', { must_finish_by: '2026-01-30' }, [act('A', 5), { op: 'add_project', id: 'P2', start: '2026-01-05' }, { op: 'add_activity', project: 'P2', id: 'X', name: 'X', duration_days: 40 }, { op: 'add_activity', project: 'P2', id: 'Y', name: 'Y', duration_days: 3 }]);
  await call('schedule', { handle: two });
  const d4 = await call('dcma_14', { handle: two });
  assert.match(cpliOf(d4).detail.forecast_finish, /^2026-01-09/, JSON.stringify(cpliOf(d4)));
  assert.equal(cpliOf(d4).denominator, 5);
  assert.equal(cpliOf(d4).result, 'pass');
  assert.ok((d4.notes as string[]).some((n) => n.endsWith(whose('P1', 2).trim())), JSON.stringify(d4.notes));
  // the first project complete while the second has open work: P1 is complete (P2's two open activities are not counted as P1's), and the answer says whose CPLI it is
  const e5 = await call('edit', { handle: two, operations: [{ op: 'update_activity', id: 'A', project: 'P1', actual_start: '2026-01-05 08:00', actual_finish: '2026-01-09 17:00' }, { op: 'set_project', project: 'P1', data_date: '2026-01-12' }, { op: 'set_project', project: 'P2', data_date: '2026-01-12' }] });
  assert.ok(!e5.error, JSON.stringify(e5).slice(0, 300));
  await call('schedule', { handle: two });
  assert.equal(reason(await call('dcma_14', { handle: two })), `Critical path length index (CPLI) not assessed: every activity of P1 is complete, so there is no remaining critical path to measure.${whose('P1', 2)}`);
});

test('a user defined field and a calendar are answered in the words the operations take, not the file’s codes', async () => {
  const p = await call('new_project', { id: 'UD', start: '2026-01-05' });
  const e = await call('edit', { handle: p.handle, operations: [{ op: 'add_udf', name: 'Zone' }, { op: 'add_udf', name: 'Handover', subject: 'wbs', data_type: 'finish_date' }, { op: 'add_udf', name: 'Weight', subject: 'resource', data_type: 'number' }] });
  assert.deepEqual(e.results, [{ udf: 'Zone', subject: 'activity', data_type: 'text' }, { udf: 'Handover', subject: 'wbs', data_type: 'finish_date' }, { udf: 'Weight', subject: 'resource', data_type: 'number' }]);
  const d = await call('list_dictionaries', { handle: p.handle });
  assert.deepEqual(d.udfs, [{ name: 'Zone', subject: 'activity', data_type: 'text' }, { name: 'Handover', subject: 'wbs', data_type: 'finish_date' }, { name: 'Weight', subject: 'resource', data_type: 'number' }]);
  // each of them can be sent straight back
  const back = await call('edit', { handle: p.handle, operations: d.udfs.map((u: any) => ({ op: 'delete_udf', udf: u.name, subject: u.subject })) });
  assert.ok(!back.error, JSON.stringify(back.error));
  assert.ok(d.calendars.length > 0 && d.calendars.every((c: any) => ['Global', 'Project', 'Resource'].includes(c.type)), JSON.stringify(d.calendars));
  // real files that hold custom fields (18 and 8 of them): each subject and type is a word add_udf knows or P6's "indicator", the count is the file's own
  const WORDS = new Set(['text', 'number', 'integer', 'cost', 'start_date', 'finish_date', 'indicator']), SUBJECTS = new Set(['activity', 'wbs', 'project', 'resource', 'assignment', 'expense']);
  for (const sample of ['EBCF-4 070127 Forecast Original.xer', 'DHBL-24FEB13_VER-7.0.xer']) {
    const inFile = readXerFile(sampleCopy(sample)).db.tables.UDFTYPE.rows.length;
    const real = await call('list_dictionaries', { handle: (await open(sample)).handle });
    assert.ok(inFile > 0 && real.udfs.length === inFile, `${sample}: ${real.udfs.length} of ${inFile}`);
    for (const u of real.udfs) assert.ok(WORDS.has(u.data_type) && SUBJECTS.has(u.subject), `${sample}: ${JSON.stringify(u)}`);
    assert.ok(real.calendars.length > 0);
    for (const c of real.calendars) assert.ok(['Global', 'Project', 'Resource'].includes(c.type), JSON.stringify(c));
  }
  // files written by other tools with codes P6 does not have ("FT_DATE", "CA_Global"): said in small words, never as the code
  const odd = await call('list_dictionaries', { handle: (await open('PDC1_Baseline_Rev0.xer')).handle });
  assert.ok(odd.udfs.length > 0 && odd.udfs.every((u: any) => !/^FT_|[A-Z]{3}/.test(u.data_type) && !/[A-Z]{3}/.test(u.subject)), JSON.stringify(odd.udfs));
  const oddCal = await call('list_dictionaries', { handle: (await open('Polaris_DC1_Baseline_CPM.xer')).handle });
  assert.ok(oddCal.calendars.length > 0 && oddCal.calendars.every((c: any) => !/^CA_/.test(c.type)), JSON.stringify(oddCal.calendars));
});

test('save and close say they need the owner key only where this server requires it, and each statement is what the server does', async () => {
  const text = (name: string) => toolsList().find((t) => t.name === name)!.description;
  const was = config.requireOwnerKey;
  try {
    config.requireOwnerKey = false;   // a stdio server (the platform's): no key needed, a wrong one refused
    for (const t of ['save', 'close']) assert.ok(!text(t).includes('(needs owner_key)') && text(t).includes('owner_key is not required by this server'), text(t).slice(0, 160));
    const p = await call('new_project', { id: 'OK1', start: '2026-01-05' });
    assert.equal((await call('close', { handle: p.handle, owner_key: 'not-the-key', discard: true })).error.code, 'invalid_owner_key');
    assert.equal((await call('close', { handle: p.handle, discard: true })).closed, p.handle);
    config.requireOwnerKey = true;    // an HTTP server: the key is needed, and the description says so
    for (const t of ['save', 'close']) assert.ok(text(t).includes('(needs owner_key)'), text(t).slice(0, 160));
    const q = await call('new_project', { id: 'OK2', start: '2026-01-05' });
    assert.equal((await call('close', { handle: q.handle, discard: true })).error.code, 'owner_key_required');
    assert.equal((await call('close', { handle: q.handle, owner_key: q.owner_key, discard: true })).closed, q.handle);
  } finally { config.requireOwnerKey = was; }
});

test('a report that reads the project baseline says when a project has none in the file: its baseline columns are empty, Late Activities fall to negative float', async () => {
  // Tower-A: a baseline saved in the file, none assigned
  const o = await open('Tower-A.xer'), h = o.handle;
  const v = await call('run_report', { handle: h, report: 'variance' });
  const at = (r: any, col: string) => r.columns.indexOf(col);
  assert.ok(v.rows.length > 0 && v.rows.every((r: any) => r.cells[at(v, 'BL Start')] === '' && r.cells[at(v, 'BL Finish')] === '' && r.cells[at(v, 'Finish Var (d)')] === ''), 'the baseline columns are empty');
  // (a report prints saved dates: when they are not what a calculation gives, its answer says so first, owner 2026-11-14)
  const stale = 'The saved dates of TOWER-A are not what a recalculation gives (3 of 3 open activities differ): these figures are of the saved dates; run schedule to recalculate them.';
  assert.deepEqual(v.notes, [stale, 'BL Start, BL Finish and Finish Var (d) are empty: no project baseline is assigned to TOWER-A; TOWER-A-BL1 is saved in the file: assign it with edit assign_baseline.']);
  const late = await call('run_report', { handle: h, report: 'std-late' });
  assert.deepEqual(late.notes, [stale, 'BL Project Finish and Variance - BL Project Finish Date are empty and the activities listed are those with negative total float: no project baseline is assigned to TOWER-A; TOWER-A-BL1 is saved in the file: assign it with edit assign_baseline.']);
  // a report with no baseline column says nothing of it
  assert.deepEqual((await call('run_report', { handle: h, report: 'schedule' })).notes, [stale]);
  // (and with the dates calculated, nothing at all)
  await call('schedule', { handle: h });
  assert.equal((await call('run_report', { handle: h, report: 'schedule' })).notes, undefined);
  // the baseline assigned: the columns are filled and nothing is said
  const e = await call('edit', { handle: h, operations: [{ op: 'assign_baseline', baseline: 'TOWER-A-BL1' }] });
  assert.ok(!e.error, JSON.stringify(e.error));
  // (what is still said: the two activities the baseline does not hold, whose baseline cells are the empty ones: read from the rows)
  const v2 = await call('run_report', { handle: h, report: 'variance', max_rows: 1000 });
  assert.deepEqual(v2.notes, ['BL Start, BL Finish and Finish Var (d) are empty for 2 activities of TOWER-A that are not in its baseline TOWER-A-BL1: A1030, M1000.']);
  assert.deepEqual(v2.rows.filter((r: any) => r.cells[at(v2, 'BL Finish')] === '').map((r: any) => r.cells[at(v2, 'Activity ID')]).sort(), ['A1030', 'M1000']);
  assert.ok(v2.rows.some((r: any) => r.cells[at(v2, 'BL Finish')] !== ''), 'baseline dates are shown');
  // (Late Activities lists neither of the two, so it says nothing)
  assert.equal((await call('run_report', { handle: h, report: 'std-late' })).notes, undefined);
  // 130 TRIAL: the project names a baseline the file does not hold
  const t = await open('130 TRIAL.xer');
  const v3 = await call('run_report', { handle: t.handle, report: 'variance', max_rows: 5 });
  assert.equal(v3.notes.length, 1);
  assert.match(v3.notes[0], /^BL Start, BL Finish and Finish Var \(d\) are empty: the project baseline of .+ is not in this file \(the file was exported without it\); export the file with its baselines\.$/);
});

test('a loop in the logic (owner 2026-11-13): every analysis that reads the saved dates says it and still answers; lint and review fail on it; an edit that moves dates says it', async () => {
  // Detailed Program.xer with ONE relationship added that closes a loop: the reverse of its first relationship
  const path = sampleCopy('Detailed Program.xer');
  const lines = readFileSync(path, 'latin1').split(/\r?\n/);
  const at = lines.findIndex((l) => l.startsWith('%T\tTASKPRED')), fields = lines[at + 1].split('\t'), first = lines[at + 2].split('\t');
  const col = (n: string) => fields.indexOf(n);
  const rev = [...first]; rev[col('task_pred_id')] = '99999999'; rev[col('task_id')] = first[col('pred_task_id')]; rev[col('pred_task_id')] = first[col('task_id')];
  lines.splice(at + 3, 0, rev.join('\t'));
  writeFileSync(path, lines.join('\r\n'), 'latin1');
  // the two activities of the loop, from the file's own rows
  const db = readXerFile(path).db;
  const codeOf = (id: string) => String(db.tables.TASK.rows.find((t) => t.task_id === id)!.task_code);
  const pair = [codeOf(first[col('pred_task_id')]), codeOf(first[col('task_id')])].sort();
  const proj = String(db.tables.PROJECT.rows[0].proj_short_name);
  const o = await call('open_file', { path }), h = o.handle;
  assert.ok(h, JSON.stringify(o).slice(0, 300));
  const named = (s: string) => pair.every((c) => s.includes(c));
  const sentenceOf = (figures: boolean) => `${proj} has a loop in its logic (${[codeOf(first[col('pred_task_id')]), codeOf(first[col('task_id')])].join(', ')}): schedule stops on it${figures ? ', so these figures are of the saved dates' : ''}; change or delete one relationship of the loop.`;
  const sentence = (figures: boolean) => ({ test: (n: string) => n === sentenceOf(figures) || n === sentenceOf(figures).replace(/\(([^ ,]+), ([^)]+)\)/, '($2, $1)') });
  for (const tool of ['critical_path', 'float_paths', 'dcma_14', 'check_schedule', 'decm', 'schedule_health', 'lint', 'schedule_index', 'planning_horizon', 'baseline_variance', 'earned_value', 'progress_curves', 'resource_histogram', 'project_summary']) {
    const a = await call(tool, { handle: h, ...(tool === 'lint' ? { simulate: false } : {}) });
    if (tool === 'baseline_variance') { assert.equal(a.error?.code, 'bad_input', 'no baseline in this file: its own refusal stands'); continue; }
    assert.ok(!a.error, `${tool} still answers: ${JSON.stringify(a.error)}`);
    const said = ((a.notes ?? []) as string[]).filter((n) => /loop/.test(n) && !/not assessed/.test(n));
    assert.equal(said.length, 1, `${tool}: the loop is said once: ${JSON.stringify(a.notes)}`);
    assert.ok(sentence(true).test(said[0]) && named(said[0]), `${tool}: ${said[0]}`);
    assert.ok(!JSON.stringify(a.notes).includes('are not what a recalculation gives'), `${tool}: nothing is said of a recalculation that cannot be made`);
  }
  // lint: a check that fails, with the two activities; review: a check graded fail, its sentence in notes
  const lint = await call('lint', { handle: h, simulate: false });
  const lc = lint.checks.find((c: any) => c.id === 'loops');
  assert.deepEqual([lc.result, lc.band, lc.activities.map((x: any) => x.id).sort()], ['fail', 'fail', pair]);
  const rv = await call('review', { handle: h });
  const rc = rv.checks.find((c: any) => c.id === 'loops');
  assert.deepEqual([rc.grade, rc.count], ['fail', 2]);
  assert.ok((rv.notes as string[]).some((n) => sentence(false).test(n) && named(n)), JSON.stringify(rv.notes));
  // schedule refuses, as before; an edit that moves dates says the dates cannot be recalculated
  assert.match((await call('schedule', { handle: h })).error.message, / are in a loop\.$/);
  const e = await call('edit', { handle: h, operations: [{ op: 'update_activity', id: pair[0], duration_days: 77 }] });
  assert.ok(!e.error && (e.notes as string[]).some((n) => sentence(false).test(n)), JSON.stringify(e.notes ?? e.error));
  // the loop removed: none of them says it, and lint and review pass the check
  const fix = await call('edit', { handle: h, operations: [{ op: 'delete_relationship', pred: codeOf(rev[col('pred_task_id')]), succ: codeOf(rev[col('task_id')]) }] });
  assert.ok(!fix.error, JSON.stringify(fix.error));
  for (const tool of ['critical_path', 'dcma_14', 'project_summary']) assert.ok(!/loop/.test(JSON.stringify((await call(tool, { handle: h })).notes ?? [])), tool);
  assert.equal((await call('lint', { handle: h, simulate: false })).checks.find((c: any) => c.id === 'loops').result, 'pass');
  assert.equal((await call('review', { handle: h })).checks.find((c: any) => c.id === 'loops').grade, 'pass');
  // a file with no loop (as shipped): the check passes with nothing listed
  const clean = await open('130 TRIAL.xer');
  const cl = (await call('lint', { handle: clean.handle, simulate: false })).checks.find((c: any) => c.id === 'loops');
  assert.deepEqual([cl.result, cl.total_activities], ['pass', 0]);
});

test('a report over several projects says whose baseline columns are empty; a PDF report says it too', async () => {
  // TOWER-A with its saved baseline assigned, and a second project with none
  const o = await open('Tower-A.xer'), h = o.handle;
  const e = await call('edit', { handle: h, operations: [{ op: 'assign_baseline', baseline: 'TOWER-A-BL1' }, { op: 'add_project', id: 'NOBL', start: '2026-03-02' }, { op: 'add_activity', project: 'NOBL', id: 'N1', name: 'N1', duration_days: 3 }] });
  assert.ok(!e.error, JSON.stringify(e.error));
  assert.equal((await call('schedule', { handle: h })).ok, true); // (the dates current: this test is about the baseline sentences)
  const v = await call('run_report', { handle: h, report: 'variance' });
  assert.deepEqual(v.notes, ['For the activities of NOBL, BL Start, BL Finish and Finish Var (d) are empty: no project baseline is assigned to NOBL; assign one with edit assign_baseline.', 'BL Start, BL Finish and Finish Var (d) are empty for 2 activities of TOWER-A that are not in its baseline TOWER-A-BL1: A1030, M1000.']);
  const blFinish = v.columns.indexOf('BL Finish'), id = v.columns.indexOf('Activity ID');
  assert.ok(v.rows.some((r: any) => r.cells[id] !== 'N1' && r.cells[blFinish] !== ''), 'TOWER-A’s rows show their baseline');
  assert.equal(v.rows.find((r: any) => r.cells[id] === 'N1').cells[blFinish], '');
  const late = await call('run_report', { handle: h, report: 'std-late' });
  assert.match(late.notes[0], /^For the activities of NOBL, BL Project Finish and Variance - BL Project Finish Date are empty and those listed are the ones with negative total float: no project baseline is assigned to NOBL; /);
  // one project asked for: no qualifier is needed, and the project that has its baseline says nothing
  assert.deepEqual((await call('run_report', { handle: h, report: 'variance', project: 'TOWER-A' })).notes, ['BL Start, BL Finish and Finish Var (d) are empty for 2 activities of TOWER-A that are not in its baseline TOWER-A-BL1: A1030, M1000.']);
  assert.deepEqual((await call('run_report', { handle: h, report: 'variance', project: 'NOBL' })).notes, ['BL Start, BL Finish and Finish Var (d) are empty: no project baseline is assigned to NOBL; assign one with edit assign_baseline.']);
  // written to a file: the same sentence, PDF included
  for (const ext of ['pdf', 'csv', 'xlsx', 'html']) {
    const w = await call('run_report', { handle: h, report: 'variance', path: `variance-out.${ext}` });
    assert.ok(!w.error, `${ext}: ${JSON.stringify(w.error)}`);
    assert.deepEqual(w.notes, v.notes, ext);
  }
});

test('loops, the harder cases: two loops are one sentence; a loop in one project leaves the other judged and unburdened; a loop across two projects is said of both', async () => {
  // a file built here and saved, then relationships that close loops are written into the file itself (edit refuses to make one)
  const p = await call('new_project', { id: 'LP', start: '2026-01-05' });
  const e = await call('edit', { handle: p.handle, operations: [
    act('A', 3), act('B', 3), act('C', 3), act('D', 3), { op: 'add_relationship', pred: 'A', succ: 'B' }, { op: 'add_relationship', pred: 'C', succ: 'D' },
    { op: 'add_project', id: 'LQ', start: '2026-01-05' }, { op: 'add_activity', project: 'LQ', id: 'X', name: 'X', duration_days: 4 }, { op: 'add_activity', project: 'LQ', id: 'Y', name: 'Y', duration_days: 4 }, { op: 'add_relationship', pred: 'X', succ: 'Y', project: 'LQ' }] });
  assert.ok(!e.error, JSON.stringify(e.error));
  await call('schedule', { handle: p.handle });
  await call('edit', { handle: p.handle, operations: [{ op: 'update_activity', id: 'X', project: 'LQ', duration_days: 9 }] });   // LQ's saved dates are now not current
  const saved = await call('save', { handle: p.handle, owner_key: p.owner_key, path: 'loops-base.xer' });
  assert.ok(!saved.error, JSON.stringify(saved.error));
  const base = readFileSync(saved.saved ?? saved.path, 'latin1');
  const withLinks = (name: string, links: [string, string][]): string => {
    const lines = base.split(/\r?\n/), db = readXerFile(saved.saved ?? saved.path).db;
    const at = lines.findIndex((l) => l.startsWith('%T\tTASKPRED')), fields = lines[at + 1].split('\t'), first = lines[at + 2].split('\t');
    const col = (n: string) => fields.indexOf(n), task = (code: string) => db.tables.TASK.rows.find((t) => t.task_code === code)!;
    links.forEach(([pred, succ], i) => { const r = [...first]; r[col('task_pred_id')] = String(900000 + i); r[col('pred_task_id')] = task(pred).task_id; r[col('task_id')] = task(succ).task_id; r[col('proj_id')] = task(succ).proj_id; r[col('pred_proj_id')] = task(pred).proj_id; lines.splice(at + 3, 0, r.join('\t')); });
    const out = join(dirname(saved.saved ?? saved.path), name);
    writeFileSync(out, lines.join('\r\n'), 'latin1');
    return out;
  };
  const loopsSaid = (a: any) => ((a.notes ?? []) as string[]).filter((n) => /loop/.test(n) && !/not assessed/.test(n));
  const openIt = async (path: string) => { const o = await call('open_file', { path }); assert.ok(o.handle, JSON.stringify(o).slice(0, 300)); return o.handle as string; };

  // two loops in LP (B back to A, D back to C), none in LQ
  let h = await openIt(withLinks('two-loops.xer', [['B', 'A'], ['D', 'C']]));
  let a = await call('critical_path', { handle: h, project: 'LP' });
  assert.equal(loopsSaid(a).length, 1, JSON.stringify(a.notes));
  assert.match(loopsSaid(a)[0], /^LP has 2 loops in its logic \((?:[AB], [AB]; [CD], [CD]|[CD], [CD]; [AB], [AB])\): schedule stops on them, so these figures are of the saved dates; change or delete one relationship of each loop\.$/);
  for (const tool of ['dcma_14', 'decm', 'schedule_index', 'planning_horizon']) assert.equal(loopsSaid(await call(tool, { handle: h, project: 'LP' })).length, 1, tool);
  // LQ has no loop: its saved dates are still judged (they are not current), and its lint check passes. The dates sentence sends the agent to schedule, which
  // calculates every project of the file and stops on LP's loops: so those are said with it, once, and not as a matter of LQ's figures
  a = await call('critical_path', { handle: h, project: 'LQ' });
  assert.equal(loopsSaid(a).length, 1, JSON.stringify(a.notes));
  assert.match(loopsSaid(a)[0], /^LP has 2 loops in its logic \([^)]+\): schedule stops on them; change or delete one relationship of each loop\.$/);
  assert.ok((a.notes as string[]).some((n) => /^The saved dates of LQ are not what a recalculation gives \(\d of 2 open activities differ\)/.test(n)), JSON.stringify(a.notes));
  assert.equal((await call('lint', { handle: h, project: 'LQ', simulate: false })).checks.find((c: any) => c.id === 'loops').result, 'pass');
  const lp = (await call('lint', { handle: h, project: 'LP', simulate: false })).checks.find((c: any) => c.id === 'loops');
  assert.deepEqual([lp.result, lp.activities.map((x: any) => x.id).sort()], ['fail', ['A', 'B', 'C', 'D']]);
  const rv = await call('review', { handle: h, project: 'LQ' });
  assert.equal(rv.checks.find((c: any) => c.id === 'loops').grade, 'pass');
  assert.equal(rv.checks.find((c: any) => c.id === 'saved_dates').grade, 'warn');

  // a loop that runs through both projects (B of LP to X of LQ, Y of LQ back to A of LP): ONE sentence that names both projects, each activity with its Project ID,
  // whether one project is asked for or the whole file (the call an agent makes first)
  h = await openIt(withLinks('cross-loop.xer', [['B', 'X'], ['Y', 'A']]));
  for (const tool of ['critical_path', 'dcma_14', 'check_schedule', 'schedule_health', 'project_summary', 'schedule_index', 'lint']) {
    a = await call(tool, { handle: h, ...(tool === 'lint' ? { simulate: false } : {}) });
    assert.equal(loopsSaid(a).length, 1, `${tool}, the whole file: ${JSON.stringify(a.notes)}`);
  }
  const rvAll = await call('review', { handle: h });
  assert.equal((rvAll.notes as string[]).join(' ').split(' have a loop in their logic').length - 1, 1, JSON.stringify(rvAll.notes));
  assert.equal(rvAll.checks.find((c: any) => c.id === 'saved_dates').grade, 'not_assessed', 'no project could be recalculated: the saved dates are not judged');
  for (const [proj, own] of [['LP', ['A', 'B']], ['LQ', ['X', 'Y']]] as const) {
    a = await call('critical_path', { handle: h, project: proj });
    assert.equal(loopsSaid(a).length, 1, `${proj}: ${JSON.stringify(a.notes)}`);
    assert.ok(loopsSaid(a)[0].startsWith('LP and LQ have a loop in their logic ('), loopsSaid(a)[0]);
    for (const n of ['A in LP', 'B in LP', 'X in LQ', 'Y in LQ']) assert.ok(loopsSaid(a)[0].includes(n), `${proj}: ${n} in ${loopsSaid(a)[0]}`);
    const lc = (await call('lint', { handle: h, project: proj, simulate: false })).checks.find((c: any) => c.id === 'loops');
    assert.deepEqual([lc.result, lc.activities.map((x: any) => x.id).sort()], ['fail', [...own]], `${proj}: its own activities of the loop`);
  }
  // a report shows the saved float and finish: it says the loop too (and nothing of whether the saved dates are current: that is the analyses' to say)
  const rep = await call('run_report', { handle: h, report: 'critical' });
  assert.deepEqual([loopsSaid(rep).length, (rep.notes as string[]).filter((n) => /recalculation/.test(n)).length], [1, 0], JSON.stringify(rep.notes));
  // after schedule with break_loops the dates are of a calculation that left a relationship out: the loop is still in the logic, and the sentence still true
  h = await openIt(withLinks('one-loop.xer', [['B', 'A']]));
  const broken = await call('schedule', { handle: h, break_loops: true, log: false });
  assert.ok(!broken.error, JSON.stringify(broken.error));
  a = await call('critical_path', { handle: h, project: 'LP' });
  assert.equal(loopsSaid(a)[0], 'LP has a loop in its logic (A, B): schedule stops on it, so these figures are of the saved dates; change or delete one relationship of the loop.');
});
