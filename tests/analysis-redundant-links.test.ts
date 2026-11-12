// The redundant-link search (core/analysis/forensic.ts redundantLinks): the same links, in the same order, as the plain walk it replaced, on the fixtures, on graphs with loops, parallel links and
// self-links, and on real files; and the time it takes on a ladder that grows (the walk was quadratic: 2.1 s at 4,000 activities, 9.6 s at 8,000, 44 s at 16,000).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rows, type Row } from '../core/db.ts';
import { readXerFile } from '../core/xer/parseFile.ts';
import { makeScope } from '../core/analysis/common.ts';
import * as F from '../core/analysis/forensic.ts';
import * as B from './benchmark-fixtures.ts';
import { sampleCopy, testRoots } from './helpers.ts';

process.env.P6CLONE_COMPUTE_WORKERS = '0';
testRoots();

/** The search as it was: for every link a -> b of an activity with another successor and a successor with another predecessor, a walk from the other successors of a looks for b (logicAudit.ts:195-232). The oracle. */
function walk(rels: Row[]): Row[] {
  const out = new Map<string, Row[]>(), inDeg = new Map<string, number>();
  for (const r of rels) { (out.get(r.pred_task_id) ?? out.set(r.pred_task_id, []).get(r.pred_task_id)!).push(r); inDeg.set(r.task_id, (inDeg.get(r.task_id) ?? 0) + 1); }
  const found: Row[] = [];
  for (const [from, links] of out) {
    if (links.length < 2) continue;
    for (const r of links) {
      if ((inDeg.get(r.task_id) ?? 0) < 2) continue;
      const seen = new Set<string>(), stack = links.filter((x) => x.task_id !== r.task_id).map((x) => x.task_id);
      let reached = false;
      while (stack.length) {
        const v = stack.pop()!;
        if (v === r.task_id) { reached = true; break; }
        if (seen.has(v)) continue;
        seen.add(v);
        for (const x of out.get(v) ?? []) stack.push(x.task_id);
      }
      if (reached) found.push(r);
    }
  }
  return found;
}
const same = (a: Row[], b: Row[], what: string) => { assert.equal(a.length, b.length, `${what}: count`); a.forEach((r, i) => assert.equal(r, b[i], `${what}: link ${i}`)); };
const link = (p: number, s: number): Row => ({ pred_task_id: `T${p}`, task_id: `T${s}`, pred_type: 'PR_FS' });

test('the same links in the same order as the walk: on every fixture of the benchmark', () => {
  for (const [name, b] of [['cleanChain', B.cleanChain()], ['withFloat', B.withFloat()], ['withLogicIssues', B.withLogicIssues()], ['delayed', B.delayed()], ['overAllocated', B.overAllocated()], ['logicVariety', B.logicVariety()], ['withCycle', B.withCycle()]] as const) {
    const rels = rows(b.db, 'TASKPRED');
    same(F.redundantLinks(rels), walk(rels), name);
  }
  assert.equal(F.redundantLinks(rows(B.logicVariety().db, 'TASKPRED')).length, 2, 'logicVariety: the two redundant links (of any type)');
  assert.deepEqual(F.redundantLinks([]), []);
});

test('the same links on random graphs with loops, parallel links and self-links', () => {
  let seed = 12345;
  const rnd = (n: number) => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % n; };
  let withRedundant = 0, withLoop = 0;
  for (let g = 0; g < 300; g++) {
    const n = 3 + rnd(14), m = rnd(n * 3) + 1, rels: Row[] = [];
    for (let i = 0; i < m; i++) rels.push(link(rnd(n), rnd(n)));
    const a = F.redundantLinks(rels), b = walk(rels);
    same(a, b, `graph ${g}`);
    if (a.length) withRedundant++;
    if (rels.some((r) => r.pred_task_id === r.task_id) || F.redundantLinks(rels.filter((r) => Number(r.pred_task_id.slice(1)) < Number(r.task_id.slice(1)))).length < a.length) withLoop++;
  }
  assert.ok(withRedundant > 50, `${withRedundant} graphs have redundant links`);
  assert.ok(withLoop > 20, `${withLoop} graphs have a loop that changes the answer`);
  // forward-only graphs (no loop): the plain meaning, a -> b with another path of two steps or more
  for (let g = 0; g < 200; g++) {
    const n = 4 + rnd(10), rels: Row[] = [];
    for (let i = 0; i < n * 2; i++) { const p = rnd(n - 1), s = p + 1 + rnd(n - 1 - p); rels.push(link(p, s)); }
    same(F.redundantLinks(rels), walk(rels), `forward graph ${g}`);
  }
});

test('real files: the same links as the walk, and the counts counted independently (129 trial 1,828; Detailed Program 51; Enppi 451; Aurora_Tower_Baseline 27)', () => {
  for (const [name, count] of [['129 trial.xer', 1828], ['Detailed Program.xer', 51], ['Enppi.xer', 451], ['Aurora_Tower_Baseline.xer', 27], ['Tower-A.xer', 0]] as const) {
    const db = readXerFile(sampleCopy(name)).db, s = makeScope(db, { calendarDays: true }), scoped = new Set(s.tasks.map((t) => t.task_id));
    const rels = s.rels.filter((r) => scoped.has(r.task_id) && scoped.has(r.pred_task_id));
    const fast = F.redundantLinks(rels);
    assert.equal(fast.length, count, name);
    same(fast, walk(rels), name);
    const l = F.logicFigures(s);
    assert.equal(l.result === 'assessed' ? l.redundant_links.length : -1, count, `${name} through logicFigures`);
  }
});

test('a ladder of 4,000, 8,000 and 16,000 activities: the redundant links are found in a time that grows with the size, not with its square', () => {
  // activity i is followed by i + 1 and by i + 2: every link i -> i + 2 is also reached through i + 1 (n - 2 redundant links); the walk took 2.1 s, 9.6 s and 44 s here
  const times: number[] = [];
  for (const n of [4000, 8000, 16000]) {
    const rels: Row[] = [];
    for (let i = 0; i < n - 1; i++) { rels.push(link(i, i + 1)); if (i + 2 < n) rels.push(link(i, i + 2)); }
    const t0 = performance.now(), found = F.redundantLinks(rels), secs = (performance.now() - t0) / 1000;
    times.push(secs);
    console.log(`redundantLinks, ladder of ${n}: ${found.length} found in ${secs.toFixed(2)} s`);
    assert.equal(found.length, n - 2);
    assert.ok(found.every((r) => Number(r.task_id.slice(1)) === Number(r.pred_task_id.slice(1)) + 2));
    assert.ok(secs < 20, `${n}: ${secs.toFixed(1)} s`);
  }
  // wide as well as long: 300 activities each followed by the next 40 (every link beyond the first is redundant)
  const wide: Row[] = [];
  for (let i = 0; i < 300; i++) for (let k = 1; k <= 40 && i + k < 300; k++) wide.push(link(i, i + k));
  same(F.redundantLinks(wide), walk(wide), 'wide ladder');
});
