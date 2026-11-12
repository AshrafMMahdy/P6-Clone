// The memory of the redundant-link search does not grow with the square of the schedule: a start milestone linked to every activity and every activity linked to a finish milestone held
// 296 MB of bitsets at 50,000 activities (one bitset of n bits per group); it now holds sets of one block of columns (n x block bits). Kept in a file of its own: the peak resident size of a
// process only grows, so the measurement is the first thing this process does.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Row } from '../core/db.ts';
import * as F from '../core/analysis/forensic.ts';

test('a star of 50,000 activities: the peak resident memory grows by well under what one bitset per group took (370 MB), and the answer is the same', () => {
  const link = (p: number, s: number): Row => ({ pred_task_id: `T${p}`, task_id: `T${s}`, pred_type: 'PR_FS' });
  const n = 50000, rels: Row[] = [];
  for (let i = 1; i <= n; i++) { rels.push(link(0, i)); rels.push(link(i, n + 1)); }
  rels.push(link(0, n + 1)); // start -> finish: also reached through every activity
  const before = process.resourceUsage().maxRSS; // KB
  const found = F.redundantLinks(rels);
  const grew = (process.resourceUsage().maxRSS - before) / 1024;
  assert.equal(found.length, 1);
  assert.equal(found[0], rels.at(-1));
  console.log(`redundantLinks, star of ${n}: peak resident memory grew by ${grew.toFixed(0)} MB`);
  assert.ok(grew < 200, `${grew.toFixed(0)} MB`);
});
