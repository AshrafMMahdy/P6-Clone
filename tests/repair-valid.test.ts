// save {repair: true}: a lenient open that P6 would still reject is written as a repaired copy P6 imports, field by
// field and never by guessing, every change listed; the original file is never overwritten.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { callTool, toolResult } from '../mcp/server.ts';
import { applyOps } from '../core/project/ops.ts';
import { writeXer } from '../core/xer/write.ts';
import { parseXer } from '../core/xer/parse.ts';
import { rows, type Db } from '../core/db.ts';
import { SAMPLES_DIR } from './helpers.ts';

const call = async (name: string, a: Record<string, unknown>) => toolResult((await callTool(name, a)).out, false).structuredContent as any;
const dir = mkdtempSync(join(tmpdir(), 'p6repair-'));

/** A small project with one of each damage. */
function damaged(): string {
  const db: Db = { tables: {} };
  assert.equal(applyOps(db, [{ op: 'add_project', id: 'DMG', start: '2026-03-02' }, { op: 'add_wbs', code: 'W', name: 'Works' },
    ...['IMPOSS', 'SPAN', 'NONE', 'FUTURE', 'BADFIN', 'ANCIENT', 'ORDER', 'NOSTART', 'SHIFT', 'CODES', 'TWIN'].map((id) => ({ op: 'add_activity', id, name: `Activity ${id}`, wbs: 'W', duration_days: 5 })),
    { op: 'add_relationship', pred: 'IMPOSS', succ: 'SHIFT' }, { op: 'add_relationship', pred: 'SHIFT', succ: 'CODES' }, { op: 'add_relationship', pred: 'IMPOSS', succ: 'CODES' },
    { op: 'set_project', data_date: '2026-03-16' }]).ok, true);
  const t = (c: string) => rows(db, 'TASK').find((x) => x.task_code === c)!;
  // an impossible duration (49,445 days), the remaining duration readable (not started: the same)
  t('IMPOSS').target_drtn_hr_cnt = '395563.6';
  // both durations impossible: the planned start-finish span (10 working days) gives it
  Object.assign(t('SPAN'), { target_drtn_hr_cnt: '999999', remain_drtn_hr_cnt: '-5', target_start_date: '2026-03-02 08:00', target_end_date: '2026-03-13 17:00' });
  // nothing gives it: P6's default (5 days), not a 0
  Object.assign(t('NONE'), { target_drtn_hr_cnt: 'abc', remain_drtn_hr_cnt: 'x1', target_start_date: '', target_end_date: '' });
  // an actual start in 2212, after the data date: P6 imports it, so it is kept and reported as an invalid date
  Object.assign(t('FUTURE'), { act_start_date: '2212-01-05 13:00', status_code: 'TK_Active' });
  // before 1753, outside what a P6 database stores: P6 refuses it, so it is cleared (not started)
  Object.assign(t('ANCIENT'), { act_start_date: '1700-05-01 08:00', status_code: 'TK_Active' });
  // a finish before its start: P6 refuses the actual dates; the finish goes, the start stays (in progress)
  Object.assign(t('ORDER'), { act_start_date: '2026-03-10 08:00', act_end_date: '2026-03-05 17:00', status_code: 'TK_Complete', remain_drtn_hr_cnt: '0' });
  // a finish without a start: P6 imports it, kept and reported
  Object.assign(t('NOSTART'), { act_end_date: '2026-03-05 17:00', status_code: 'TK_Complete', remain_drtn_hr_cnt: '0' });
  // started, with an unreadable actual finish: the finish is cleared, it stays in progress
  Object.assign(t('BADFIN'), { act_start_date: '2026-03-03 08:00', act_end_date: '2026-03-1! 17:00', status_code: 'TK_Complete', remain_drtn_hr_cnt: '0' });
  // a row made from a damaged line: its name is a number and a field cannot be read
  Object.assign(t('SHIFT'), { task_name: '362.016667', early_start_date: '20±2-05-12 1<:36' });
  // codes and flags P6 has no such value for
  Object.assign(t('CODES'), { task_type: 'TT_Tssk', driving_path_flag: '86', complete_pct_type: 'CP_U~its' });
  // a repeated task_id (P6 rejects the file), the copy damaged: FUTURE keeps its id (and links), TWIN gets a fresh one
  Object.assign(t('TWIN'), { task_id: t('FUTURE').task_id, late_start_date: '20q2-1\u0011-27 13:00' });
  const path = join(dir, 'damaged.xer');
  writeFileSync(path, writeXer(db, { version: '19.12' }));
  return path;
}

test('save repair: one of each damage, repaired field by field, every change listed; the copy opens and schedules; the original is untouched', async () => {
  const src = damaged(), before = readFileSync(src);
  const o = await call('open_file', { path: src, lenient: true });
  assert.equal(o.still_rejected, true, JSON.stringify(o.diagnostics?.not_repaired));
  assert.equal((await call('save', { handle: o.handle, repair: true })).error.code, 'bad_input', 'a repaired copy needs a new path');
  assert.equal((await call('save', { handle: o.handle, repair: true, path: src })).error.code, 'bad_input', 'never over the original');
  const out = join(dir, 'damaged-repaired.xer');
  const r = await call('save', { handle: o.handle, repair: true, path: out });
  assert.deepEqual([r.saved, r.repaired, r.check.still_rejected, r.check.counts.fatal ?? 0, r.check.counts.error ?? 0], [out, true, false, 0, 0], JSON.stringify(r.check));
  const ch = (key: string, field: string) => r.changes.find((c: any) => c.key === key && c.field === field);
  const code = (c: string) => r.changes.find((x: any) => x.field === '*' && x.old.startsWith(c));
  const db0 = (await import('../core/xer/parse.ts')).parseXer(new Uint8Array(before)).db;
  const id = (c: string) => db0.tables.TASK.rows.find((t) => t.task_code === c)!.task_id; // as the file had it
  assert.deepEqual([ch(id('IMPOSS'), 'target_drtn_hr_cnt').old, ch(id('IMPOSS'), 'target_drtn_hr_cnt').new], ['395563.6', '40']);
  assert.match(ch(id('IMPOSS'), 'target_drtn_hr_cnt').reason, /impossible: its remaining duration/);
  assert.equal(ch(id('SPAN'), 'target_drtn_hr_cnt').new, '80');
  assert.match(ch(id('SPAN'), 'target_drtn_hr_cnt').reason, /planned start-finish span/);
  assert.deepEqual([ch(id('NONE'), 'target_drtn_hr_cnt').new, ch(id('NONE'), 'remain_drtn_hr_cnt').new], ['40', '40']);
  assert.match(ch(id('NONE'), 'target_drtn_hr_cnt').reason, /P6's default for a new activity/);
  // actuals P6 imports are the customer's facts: kept, reported as invalid dates; only what P6 refuses is cleared
  const rowOf = (c: string) => db0.tables.TASK.rows.findIndex((t) => t.task_code === c) + 1;
  assert.equal(r.changes.some((c: any) => c.table === 'TASK' && (c.row === rowOf('FUTURE') || c.row === rowOf('NOSTART'))), false, 'FUTURE and NOSTART are not changed');
  assert.deepEqual(r.invalid_dates.map((x: any) => [x.key, x.field, x.code]).sort(), [[id('FUTURE'), 'act_start_date', 'ACTUAL_AFTER_DD'], [id('NOSTART'), 'act_end_date', 'FINISH_WITHOUT_START']].sort());
  assert.deepEqual([ch(id('ANCIENT'), 'act_start_date').new, ch(id('ANCIENT'), 'status_code').new], ['', 'TK_NotStart']);
  assert.match(ch(id('ANCIENT'), 'act_start_date').reason, /before 1753, outside what a P6 database stores \(P6 refuses it\)/);
  assert.deepEqual([ch(id('ORDER'), 'act_end_date').new, ch(id('ORDER'), 'status_code').new, ch(id('ORDER'), 'act_start_date')], ['', 'TK_Active', undefined]);
  assert.equal(r.cleared_actuals_rule.length, 3);
  assert.deepEqual([ch(id('BADFIN'), 'act_end_date').new, ch(id('BADFIN'), 'status_code').new], ['', 'TK_Active']);
  assert.match(code('SHIFT').reason, /damaged line: its name is the number "362.016667"/);
  assert.equal(r.changes.filter((c: any) => c.table === 'TASKPRED' && c.field === '*').length, 2, 'its two relationships go with it');
  assert.deepEqual([ch(id('CODES'), 'task_type').new, ch(id('CODES'), 'driving_path_flag').new, ch(id('CODES'), 'complete_pct_type').new], ['TT_Task', 'N', 'CP_Drtn']);
  const fresh = r.changes.find((c: any) => c.field === 'task_id');
  assert.deepEqual([fresh.key, fresh.row], [id('FUTURE'), db0.tables.TASK.rows.findIndex((x) => x.task_code === 'TWIN') + 1]);
  assert.match(fresh.reason, /this activity, TWIN, gets a fresh id \(links to \d+ stay with FUTURE\)/);
  for (const c of r.changes) assert.ok(c.table && c.row > 0 && c.field && typeof c.old === 'string' && typeof c.new === 'string' && c.reason, JSON.stringify(c));
  assert.deepEqual(readFileSync(src), before, 'the original file is untouched');
  // the copy opens without lenient and schedules
  const back = await call('open_file', { path: out });
  assert.ok(back.handle, JSON.stringify(back).slice(0, 300));
  assert.equal((await call('schedule', { handle: back.handle })).ok, true);
  for (const h of [o.handle, back.handle]) await call('close', { handle: h, discard: true });
});

test('save repair on CCA R03 (a corrupted 16,000-activity file): the repaired copy validates, opens again and schedules', { timeout: 600_000 }, async () => {
  const src = join(dir, 'cca.xer');
  copyFileSync(join(SAMPLES_DIR, 'CCA R03 dt 24Oct11SC.xer'), src);
  const o = await call('open_file', { path: src, lenient: true });
  assert.equal(o.still_rejected, true);
  const out = join(dir, 'cca-repaired.xer');
  const r = await call('save', { handle: o.handle, repair: true, path: out });
  assert.deepEqual([r.check.still_rejected, r.check.counts.fatal ?? 0, r.check.counts.error ?? 0], [false, 0, 0], JSON.stringify(r.check).slice(0, 2000));
  // the 49,445-day duration: from its remaining duration (not started)
  assert.ok(r.changes.some((c: any) => c.field === 'target_drtn_hr_cnt' && c.old === '395563.6' && c.new === '336'));
  // the actual starts after the 2011-09-30 data date: P6 imports them, so they stay as recorded, reported as invalid dates
  for (const k of ['164390', '164391', '164449', '164450']) {
    assert.equal(r.changes.some((c: any) => c.key === k), false, k);
    assert.ok(r.invalid_dates.some((x: any) => x.key === k && x.code === 'ACTUAL_AFTER_DD' && x.field === 'act_start_date'), k);
  }
  assert.equal(r.changes.filter((c: any) => c.table === 'TASK' && c.field === '*').length, 10);
  const back = await call('open_file', { path: out });
  assert.ok(back.handle, JSON.stringify(back).slice(0, 300));
  assert.equal((await call('schedule', { handle: back.handle })).ok, true);
  for (const h of [o.handle, back.handle]) await call('close', { handle: h, discard: true });
});

test('save repair on every Tower-A variant: the baseline with no root WBS node gets one (coded as the project), orphan WBS under it; the copy opens strictly and validates clean', { timeout: 120_000 }, async () => {
  const { readdirSync } = await import('node:fs');
  const variants = readdirSync(SAMPLES_DIR).filter((f) => /^tower[-_]a/i.test(f) && f.toLowerCase().endsWith('.xer'));
  assert.ok(variants.length >= 4, variants.join(', '));
  for (const f of variants) {
    assert.equal((await call('open_file', { path: join(SAMPLES_DIR, f) })).error?.code, 'p6_would_reject', `${f} as shipped`);
    const o = await call('open_file', { path: join(SAMPLES_DIR, f), lenient: true });
    const out = join(dir, `${f.replace(/\.xer$/i, '')}-repaired.xer`);
    const r = await call('save', { handle: o.handle, repair: true, path: out });
    assert.deepEqual([r.check.still_rejected, r.check.counts.fatal ?? 0, r.check.counts.error ?? 0], [false, 0, 0], `${f}: ${JSON.stringify(r.check).slice(0, 400)}`);
    const roots = r.changes.filter((c: any) => c.table === 'PROJWBS' && c.field === '*' && c.old === '(no row)');
    assert.equal(roots.length, 1, `${f}: one root WBS node added`);
    assert.match(roots[0].reason, /no root WBS node .*added, coded as the project/);
    const back = await call('open_file', { path: out });
    assert.ok(back.handle, `${f}: ${JSON.stringify(back).slice(0, 300)}`);
    const v = await call('validate', { handle: back.handle });
    assert.deepEqual([v.counts?.fatal ?? 0, v.counts?.error ?? 0], [0, 0], `${f}: ${JSON.stringify(v).slice(0, 400)}`);
    // the baseline's root: proj_node_flag Y, coded as its project, and every WBS of it in one tree under it
    const db = parseXer(new Uint8Array(readFileSync(out))).db;
    for (const p of db.tables.PROJECT.rows) {
      const W = db.tables.PROJWBS.rows.filter((w) => w.proj_id === p.proj_id), root = W.filter((w) => w.proj_node_flag === 'Y');
      assert.equal(root.length, 1, `${f} ${p.proj_short_name}`);
      const ids = new Set(W.map((w) => w.wbs_id));
      assert.deepEqual(W.filter((w) => w.proj_node_flag !== 'Y' && !ids.has(w.parent_wbs_id)), [], `${f} ${p.proj_short_name}: no orphan WBS`);
    }
    const added = db.tables.PROJWBS.rows.find((w) => w.wbs_id === roots[0].key)!;
    assert.equal(added.wbs_short_name, db.tables.PROJECT.rows.find((p) => p.proj_id === added.proj_id)!.proj_short_name);
    for (const h of [o.handle, back.handle]) await call('close', { handle: h, discard: true });
  }
});

test('repair: a project without its root WBS node gets one, and WBS elements whose parent is missing go under it', async () => {
  const { repairToValid } = await import('../core/xer/repair-valid.ts');
  const db: Db = { tables: {} };
  assert.equal(applyOps(db, [{ op: 'add_project', id: 'NOROOT', start: '2026-03-02' }, { op: 'add_wbs', code: 'A' }, { op: 'add_wbs', code: 'B', parent: 'A' }, { op: 'add_activity', id: 'X1', name: 'x', wbs: 'A.B' }]).ok, true);
  const W = db.tables.PROJWBS.rows, rootId = W.find((w) => w.proj_node_flag === 'Y')!.wbs_id;
  db.tables.PROJWBS.rows = W.filter((w) => w.proj_node_flag !== 'Y');
  const { changes } = repairToValid(db);
  const root = db.tables.PROJWBS.rows.find((w) => w.proj_node_flag === 'Y')!;
  assert.deepEqual([root.wbs_short_name, root.parent_wbs_id, root.wbs_id !== rootId], ['NOROOT', '', true]);
  assert.equal(db.tables.PROJWBS.rows.find((w) => w.wbs_short_name === 'A')!.parent_wbs_id, root.wbs_id, 'the orphan goes under the root');
  assert.equal(db.tables.PROJWBS.rows.find((w) => w.wbs_short_name === 'B')!.parent_wbs_id, db.tables.PROJWBS.rows.find((w) => w.wbs_short_name === 'A')!.wbs_id, 'its child stays where it was');
  assert.deepEqual(changes.map((c) => [c.table, c.field]), [['PROJWBS', '*'], ['PROJWBS', 'parent_wbs_id']]);
  assert.equal(db.tables.TASK.rows.length, 1, 'the activity stays');
});
