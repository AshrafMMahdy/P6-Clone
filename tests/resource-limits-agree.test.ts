// One predicate for "this resource has no limit" (core/resource/usage.ts resourceLimits): resource_histogram, schedule_index and level_resources agree on which resources they do not judge, and say so in the one sentence.
// Built project: one limited resource, one with Max Units/Time 0, one with it blank, one Material; and a copy of Detailed Program.xer.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { callTool, toolResult } from '../mcp/server.ts';
import { sampleCopy, testRoots } from './helpers.ts';

testRoots();
const call = async (name: string, args: Record<string, unknown>) => { const r = await callTool(name, args); return toolResult(r.out, r.isError, name).structuredContent as any; };
const MAT = /^(\d+) resources? (?:is|are) Material: over-allocation is not assessed for a Material resource: (.+)\.$/;
const NO_LIMIT = /^(\d+) resources? (?:has|have) no Max Units\/Time, so (?:its|their) over-allocation is not assessed: (.+)\.$/;
const idsOf = (notes: string[] | undefined, re: RegExp): string[] => {
  const n = (notes ?? []).filter((x) => re.test(x)); assert.ok(n.length <= 1, `said once: ${JSON.stringify(notes)}`); if (!n.length) return [];
  const m = re.exec(n[0])!, cut = /^(.*) and (\d+) more \((\d+) in total\)$/.exec(m[2]);   // more than 25: the first 25, how many more, the total
  const ids = (cut ? cut[1] : m[2]).split(', '); assert.equal(cut ? Number(cut[3]) : ids.length, Number(m[1]));
  return [...ids, ...(cut ? [`+${cut[2]}`] : [])].sort();
};
/** The Resource IDs a tool's notes say are Material / have no limit ([] when it says nothing). */
const notJudged = (notes: string[] | undefined): { material: string[]; noLimit: string[] } => ({ material: idsOf(notes, MAT), noLimit: idsOf(notes, NO_LIMIT) });
const count = (notes: string[] | undefined, re: RegExp): number => Number(re.exec((notes ?? []).find((x) => re.test(x)) ?? '')?.[1] ?? 0);

test('a limited, a 0, a blank and a Material resource: the three tools judge the limited one only and name the same other ones', async () => {
  const p = await call('new_project', { id: 'RL', start: '2026-01-05' });
  const act = (id: string, rs: string) => [{ op: 'add_activity', id, name: id, duration_days: 5 }, { op: 'assign_resource', activity: id, resource: rs }];
  const e = await call('edit', { handle: p.handle, operations: [
    { op: 'add_resource', id: 'LIM', max_units_per_day: 8 }, { op: 'add_resource', id: 'ZERO', max_units_per_day: 8 }, { op: 'add_resource', id: 'BLANK', max_units_per_day: 8 }, { op: 'add_resource', id: 'MAT', type: 'material', price_per_unit: 2 },
    // two activities at once on each resource: 16 units a day against a limit of 8 where there is one
    ...['LIM', 'ZERO', 'BLANK', 'MAT'].flatMap((r) => [...act(`${r}1`, r), ...act(`${r}2`, r)]),
  ] });
  assert.ok(e.ok !== false && !e.error, JSON.stringify(e));
  const id = async (code: string) => (await call('read_table', { handle: p.handle, table: 'RSRC', columns: ['rsrc_id', 'rsrc_short_name'] })).rows.find((r: any) => r[1] === code)[0];
  const [zero, blank] = [await id('ZERO'), await id('BLANK')];
  const set = await call('edit', { handle: p.handle, operations: [
    { op: 'set_fields', table: 'RSRCRATE', where: { rsrc_id: zero }, fields: { max_qty_per_hr: '0' } },
    { op: 'set_fields', table: 'RSRCRATE', where: { rsrc_id: blank }, fields: { max_qty_per_hr: '' } },
  ] });
  assert.ok(set.ok !== false && !set.error, JSON.stringify(set));
  await call('schedule', { handle: p.handle });

  const hist = await call('resource_histogram', { handle: p.handle });
  const idx = await call('schedule_index', { handle: p.handle });
  const lev = await call('level_resources', { handle: p.handle, dry_run: true });
  // the limited one is judged: over-allocated in the histogram; the other three are not judged, none of them over-allocated
  const over = (hist.resources as any[]).filter((r) => r.over_allocated_periods > 0).map((r) => r.id ?? r.resource);
  assert.deepEqual(over, ['LIM'], JSON.stringify((hist.resources as any[]).map((r) => [r.id ?? r.resource, r.over_allocated_periods])));
  assert.deepEqual(notJudged(hist.notes), { material: ['MAT'], noLimit: ['BLANK', 'ZERO'] }, 'a Material is said as Material, never as having no limit');
  assert.deepEqual(notJudged(idx.notes), notJudged(hist.notes), 'schedule_index says the same two sentences');
  assert.equal(idx.resource_summary.over_allocated, 1);
  // level_resources levels the limited one and leaves the others as they are (it names the same ones)
  assert.ok(lev.delayed > 0, JSON.stringify(lev).slice(0, 400));
  assert.deepEqual(notJudged(lev.notes), notJudged(hist.notes), 'level_resources says the same two sentences');
});

/** The expectation from the tables: of the resources assigned in the file, the Material ones, and the others whose price rows / own Max Units/Time give no value above 0. */
async function expected(handle: string) {
  const t = async (table: string, columns: string[]) => (await call('read_table', { handle, table, columns, limit: 100000 })).rows as string[][];
  const rsrc = (await t('RSRC', ['rsrc_id', 'rsrc_short_name', 'rsrc_type'])).map((r) => [...r, '']), rate = await t('RSRCRATE', ['rsrc_id', 'max_qty_per_hr']), asg = new Set((await t('TASKRSRC', ['rsrc_id'])).map((r) => r[0]));
  const material: string[] = [], noLimit: string[] = [];
  for (const [id, name, type, own] of rsrc) {
    if (!asg.has(id)) continue;
    if (type === 'RT_Mat') { material.push(name); continue; }
    const rr = rate.filter((r) => r[0] === id && r[1] !== '').map((r) => Number(r[1]));
    const vals = rr.length ? rr : [Number(own)];
    if (!vals.some((v) => v > 0)) noLimit.push(name);
  }
  return { material: material.sort(), noLimit: noLimit.sort() };
}

for (const [file, mat, none] of [['Detailed Program.xer', 123, 0], ['130 TRIAL.xer', null, null], ['129 trial.xer', null, null], ['Tower-A.xer', null, null]] as [string, number | null, number | null][]) {
  test(`${file}: Material and no-limit resources are said truthfully and separately, the same in the three tools, counts from the tables`, async () => {
    const o = await call('open_file', { path: sampleCopy(file), lenient: true });
    const want = await expected(o.handle);
    if (mat != null) { assert.equal(want.material.length, mat); assert.equal(want.noLimit.length, none); }
    const hist = await call('resource_histogram', { handle: o.handle });
    const idx = await call('schedule_index', { handle: o.handle });
    // (a leveling goes on from calculated dates: on a file whose saved dates are not what the calculation gives it is refused, so the file is scheduled first)
    assert.equal((await call('schedule', { handle: o.handle, log: false })).ok, true);
    const lev = await call('level_resources', { handle: o.handle, dry_run: true });
    for (const [name, notes] of [['resource_histogram', hist.notes], ['schedule_index', idx.notes], ['level_resources', lev.notes]] as [string, string[]][]) {
      assert.equal(count(notes, MAT), want.material.length, `${name}: Material count`);
      assert.equal(count(notes, NO_LIMIT), want.noLimit.length, `${name}: no-limit count`);
      const got = notJudged(notes), cutOf = (l: string[]) => l.filter((x) => !x.startsWith('+'));
      assert.deepEqual(cutOf(got.material), want.material.slice(0, cutOf(got.material).length), `${name}: Material ids`);
      assert.deepEqual(cutOf(got.noLimit), want.noLimit.slice(0, cutOf(got.noLimit).length), `${name}: no-limit ids`);
      assert.ok(!(notes ?? []).some((x) => /no Max Units\/Time/.test(x) && MAT.test(x)));
    }
    assert.ok(want.material.length + want.noLimit.length > 0);
  });
}

test('a Material resource added without a limit is told no default limit that will never be used', async () => {
  const p = await call('new_project', { id: 'RM', start: '2026-01-05' });
  const e = await call('edit', { handle: p.handle, operations: [{ op: 'add_resource', id: 'MAT', type: 'material', price_per_unit: 2 }] });
  assert.ok(!(e.notes ?? []).some((x: string) => /default/.test(x)), JSON.stringify(e.notes));
});
