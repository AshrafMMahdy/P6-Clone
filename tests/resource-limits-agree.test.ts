// One predicate for "this resource has no limit" (core/resource/usage.ts resourceLimits): resource_histogram, schedule_index and level_resources agree on which resources they do not judge, and say so in the one sentence.
// Built project: one limited resource, one with Max Units/Time 0, one with it blank, one Material; and a copy of Detailed Program.xer.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { callTool, toolResult } from '../mcp/server.ts';
import { sampleCopy, testRoots } from './helpers.ts';

testRoots();
const call = async (name: string, args: Record<string, unknown>) => { const r = await callTool(name, args); return toolResult(r.out, r.isError, name).structuredContent as any; };
const NO_LIMIT = /^(\d+) resources? (?:has|have) no Max Units\/Time, so (?:its|their) over-allocation is not assessed: (.+)\.$/;
/** The Resource IDs a tool's notes say it does not judge ([] when it says nothing). */
const notJudged = (notes: string[] | undefined): string[] => {
  const n = (notes ?? []).filter((x) => NO_LIMIT.test(x)); assert.ok(n.length <= 1, `said once: ${JSON.stringify(notes)}`); if (!n.length) return [];
  const m = NO_LIMIT.exec(n[0])!, cut = /^(.*) and (\d+) more \((\d+) in total\)$/.exec(m[2]);   // more than 25: the first 25, how many more, the total
  const ids = (cut ? cut[1] : m[2]).split(', '); assert.equal(cut ? Number(cut[3]) : ids.length, Number(m[1]));
  return [...ids, ...(cut ? [`+${cut[2]}`] : [])].sort();
};

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
  assert.deepEqual(notJudged(hist.notes), ['BLANK', 'MAT', 'ZERO'], 'a Material never has a limit');
  assert.deepEqual(notJudged(idx.notes), notJudged(hist.notes), 'schedule_index names the same resources');
  assert.equal(idx.resource_summary.over_allocated, 1);
  // level_resources levels the limited one and leaves the others as they are (it names the same ones)
  assert.ok(lev.delayed > 0, JSON.stringify(lev).slice(0, 400));
  assert.deepEqual(notJudged(lev.notes), ['BLANK', 'ZERO'], 'level_resources names the same ones, except the Material it never levels');
});

test('Detailed Program.xer: the three tools agree on the resources with no limit', async () => {
  const o = await call('open_file', { path: sampleCopy('Detailed Program.xer'), lenient: true });
  const hist = await call('resource_histogram', { handle: o.handle });
  const idx = await call('schedule_index', { handle: o.handle });
  const lev = await call('level_resources', { handle: o.handle, dry_run: true });
  const a = notJudged(hist.notes);
  assert.ok(a.length > 0, 'the sample has resources with no limit');
  assert.deepEqual(notJudged(idx.notes), a, 'schedule_index names the same resources, in the same order');
  // the whole list, from the histogram's result file: exactly the resources that have no limit are the ones the note counts
  const whole = JSON.parse(readFileSync(hist.exported.files.find((f: any) => f.path.endsWith('resource_histogram.json')).path, 'utf8'));
  const unlimited = whole.resources.filter((r: any) => !r.limit_set).map((r: any) => String(r.resource)).sort();
  assert.equal(unlimited.length, Number(NO_LIMIT.exec(hist.notes.find((n: string) => NO_LIMIT.test(n)))![1]));
  assert.deepEqual(a.filter((x) => !x.startsWith('+')), unlimited.slice(0, a.filter((x) => !x.startsWith('+')).length), 'the first ones, by Resource ID');
  assert.equal(whole.resources.filter((r: any) => !r.limit_set && r.over_allocated_periods > 0).length, 0, 'none of them has an over-allocated period');
  // level_resources names only resources the histogram also names (it never levels a Material or a resource marked not to be leveled)
  const lv = notJudged(lev.notes).filter((x) => !x.startsWith('+'));
  assert.ok(lv.every((x) => unlimited.includes(x)), `${lv.join(', ')}`);
});
