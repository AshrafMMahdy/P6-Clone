import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { rows, type Db } from '../core/db.ts';
import { parseMspdi, writeMspdi } from '../core/msp/mspdi.ts';
import { applyOps } from '../core/project/ops.ts';
import { scheduleProjects } from '../core/schedule/cpm.ts';
import { baselineOf } from '../core/analysis/common.ts';

test('Microsoft Project Baseline and Baseline1-10 come in as saved baselines, any number; the clone writes its own back', () => {
  const { db } = parseMspdi(readFileSync(join(import.meta.dirname, 'fixtures', 'rich-mspdi.xml'), 'utf8'));
  const proj = rows(db, 'PROJECT').find((p) => !p._baseline_of)!;
  const saved = rows(db, 'PROJECT').filter((p) => p._baseline_of === proj.proj_id);
  assert.ok(saved.length >= 2, saved.map((p) => p.proj_short_name).join(', '));
  assert.ok(baselineOf(db, proj, 'project'), 'Baseline is the project baseline');
  assert.ok(baselineOf(db, proj, 'bl1'), 'Baseline1 is BL1');
  assert.ok(baselineOf(db, proj, saved[0].proj_short_name), 'any saved baseline by name');

  // a project of the clone's with five saved baselines: Baseline, Baseline1-3 and Baseline4 in the file
  const d: Db = { tables: {} };
  assert.ok(applyOps(d, [{ op: 'add_project', id: 'MB', start: '2026-03-02' }, { op: 'add_activity', id: 'A', name: 'A', duration_days: 5 }]).ok);
  const pid = rows(d, 'PROJECT')[0].proj_id;
  scheduleProjects(d, [pid]);
  const ops: unknown[] = [];
  for (const [i, as] of ['project', 'bl1', 'bl2', 'bl3', ''].entries()) ops.push({ op: 'save_baseline', name: `B${i}`, ...(as ? { assign_as: as } : {}) });
  assert.ok(applyOps(d, ops).ok);
  const xml = writeMspdi(d, { projIds: [pid] });
  for (const n of [0, 1, 2, 3, 4]) assert.match(xml, new RegExp(`<Baseline><Number>${n}</Number><Start>2026-03-02T08:00:00</Start>`));
  // and they read back as five saved baselines
  const back = parseMspdi(xml).db;
  assert.equal(rows(back, 'PROJECT').filter((p) => p._baseline_of).length, 5);
});
