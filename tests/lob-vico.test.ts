// The user's own Vico project rebuilt in the clone: 2 parts × 9 floors, 14 trades with their quantities, consumption
// and crews, each line from its own start, on Vico's calendar. Durations to 0.1 day and dates to the day, against the
// Schedule Planner screenshots of 2024-01-17. Skipped where the .dpp is not present (it stays out of the repo).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { rows, type Db } from '../core/db.ts';
import { applyOps } from '../core/project/ops.ts';
import { readVicoDpp } from '../core/lob/vico.ts';
import { lobFromVico, vicoCalendarOp } from '../core/lob/fromVico.ts';
import { expandLob } from '../core/lob/expand.ts';
import { scheduleLob } from '../core/lob/pace.ts';
import { segmentDuration } from '../core/lob/edit.ts';

const SAMPLE = process.env.P6CLONE_VICO_SAMPLE || 'D:\\Backup\\Documents\\ConREM\\2. Semester 3 & 4 Berlin\\1. Semester 3\\Case Studies 2\\Term Project 2 Vico\\1. Outputs\\2. After Optimization\\0. Case Studies II -- Vico Term Project II -- After Optimization 16 January 2024.dpp';
// Schedule Planner's Gantt (duration days, start, end) for each task
const VICO: Record<string, [number, string, string]> = {
  CS: [324, '2025-04-14', '2026-02-13'], PFF: [333.8, '2025-05-12', '2026-03-13'], DFF: [317, '2025-06-13', '2026-04-08'], PW: [314, '2025-07-10', '2026-04-29'],
  WP: [336.3, '2025-07-25', '2026-06-03'], EW: [267, '2025-09-25', '2026-06-12'], CTW: [275, '2025-10-09', '2026-07-07'], DWI: [272, '2025-10-31', '2026-07-20'],
  ELE: [274.6, '2025-11-25', '2026-08-10'], PAW: [272.1, '2025-12-22', '2026-08-27'], EISF: [217, '2026-02-25', '2026-09-08'], PSF: [178, '2026-03-30', '2026-09-17'],
  HSSF: [154, '2026-04-28', '2026-09-30'], FAW: [51, '2026-07-27', '2026-10-06'],
};

test('the Vico project in the clone: the same durations and dates as Schedule Planner', { skip: !existsSync(SAMPLE) && 'the Vico sample is not here' }, () => {
  const v = readVicoDpp(new Uint8Array(readFileSync(SAMPLE)));
  const { model: m, calendar, hoursPerDay } = lobFromVico(v, 'VICO');
  assert.deepEqual(m.levels, ['Parts', 'Floors']);
  assert.equal(m.locations.filter((l) => l.level === 2).length, 18);
  const db: Db = { tables: {} };
  const ops: unknown[] = [vicoCalendarOp(calendar!, 'Vico default', [2024, 2028]), { op: 'add_project', id: 'VICO', start: '2025-01-31', calendar: 'Vico default' }];
  assert.equal(applyOps(db, ops, { hoursPerDay }).ok, true);
  const pid = rows(db, 'PROJECT')[0].proj_id;
  for (const t of m.tasks) t.calendar = 'Vico default';
  const ex = expandLob(db, pid, m, { hoursPerDay });
  assert.equal(ex.ok, true, ex.error ?? '');
  const r = scheduleLob(db, [pid], new Map([[pid, m]]), { hoursPerDay });
  assert.equal(r.ok, true, r.error ?? '');
  const acts = rows(db, 'TASK');
  for (const t of m.tasks) {
    const [days, start, end] = VICO[t.code];
    const total = t.segments.reduce((n, _, k) => n + segmentDuration(m, t, k), 0);
    assert.ok(Math.abs(total - days) <= 0.1, `${t.code}: ${total.toFixed(2)} days, Vico ${days}`);
    const mine = acts.filter((a) => a.task_code.startsWith(`${t.code}-`));
    const first = mine.map((a) => a.early_start_date).sort()[0].slice(0, 10), last = mine.map((a) => a.early_end_date).sort().at(-1)!.slice(0, 10);
    assert.equal(first, start, `${t.code} start`);
    assert.equal(last, end, `${t.code} finish`);
  }
});
