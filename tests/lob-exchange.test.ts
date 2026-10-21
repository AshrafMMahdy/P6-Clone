// Tactplan files: the layout of its import dialogs (Locations, a Grid with a level header and a column per location,
// Quantities), decimal comma or dot, and back into a model with the same locations and durations.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { readTactplan, writeTactplan } from '../core/lob/tactplan.ts';
import { locationDurations } from '../core/lob/edit.ts';
import { applyLobOps, buildLocations } from '../core/lob/input.ts';
import type { LobModel } from '../core/lob/model.ts';

function model(): LobModel {
  const m: LobModel = { version: 1, project: 'T', levels: ['Building', 'Floor'], locations: buildLocations({ levels: ['Building', 'Floor'], grid: [2, 3] }), tasks: [], links: [] };
  return applyLobOps(m, [
    { op: 'add_task', code: 'FR', name: 'Frames', consumption: 0.5, quantity: 300, crew_size: 4, unit: 'm' },
    { op: 'add_task', code: 'BD', name: 'Boards, both sides', consumption: 0.2, quantities: { B1F1: 900, B1F2: 900, B1F3: 450, B2F1: 900, B2F2: 900, B2F3: 0 }, crew_size: 6, unit: 'm2', timing: 'asap' },
    { op: 'split', task: 'FR', at: 'B2F1' }, { op: 'set_start', task: 'FR', segment: 2, date: '2026-05-04' },
    { op: 'add_link', pred: 'FR', succ: 'BD', location_lag: 1 },
  ]).model;
}
const byName = (m: LobModel) => { const name = new Map(m.locations.map((l) => [l.code, l.name])); const path = (c: string) => { const out: string[] = []; for (let x: string | null = c; x; x = m.locations.find((l) => l.code === x)!.parent) out.unshift(name.get(x)!); return out.join('/'); }; return Object.fromEntries(m.tasks.map((t) => [t.code, [...locationDurations(m, t)].map(([c, d]) => [path(c), Math.round(d * 1000) / 1000])])); };

for (const decimal of ['dot', 'comma'] as const) test(`Tactplan round trip (${decimal} decimals): the same locations, tasks, durations, subtasks and starts`, () => {
  const m = model();
  const files = writeTactplan(m, { decimal, date: 'dd/MM/yyyy' });
  const grid = files.find((f) => f.name === 'Grid.csv')!.text.split('\r\n');
  const sep = decimal === 'comma' ? ';' : ',';
  assert.equal(grid[0].split(sep)[10], 'Project (0)', 'the level legend down the precision column');
  assert.deepEqual(grid[3].split(sep).slice(0, 11), ['Id', 'Name', 'Code', 'Start date', 'Finish date', 'Color', 'ASAP', 'Paced', 'Milestone', 'Trade', 'Location precision']);
  assert.match(files.find((f) => f.name === 'links-not-exported.txt')!.text, /FR -> BD: FS, location delay 1/);
  const dir = mkdtempSync(join(tmpdir(), 'p6-tpx-'));
  for (const f of files) writeFileSync(join(dir, f.name), f.text);
  const back = readTactplan(dir);
  assert.deepEqual(back.model.levels, ['Building', 'Floor']);
  assert.deepEqual(byName(back.model), byName(m));
  assert.deepEqual(back.model.tasks.find((t) => t.code === 'FR')!.segments.map((s) => [s.start ?? null, s.timing]), [[null, 'asap_paced'], ['2026-05-04', 'asap_paced']]);
  assert.equal(back.model.tasks.find((t) => t.code === 'BD')!.segments[0].timing, 'asap');
  assert.match(back.notes[0], /no dependencies/);
});
