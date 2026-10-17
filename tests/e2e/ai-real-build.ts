// The assistant building a schedule from an empty app against the REAL provider saved in the app's settings
// (costs a long conversation's worth of requests):  node tests/e2e/ai-real-build.ts ["request"] [--past <xer>]
// --past imports a past project first, so the assistant can learn from it (or copy it) instead of starting cold.
// Uses a throwaway profile with only the saved AI settings (key stays encrypted), then reviews what was built.
import { _electron as electron } from 'playwright';
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { linesToDb } from '../../core/db-file.ts';
import { parseXer } from '../../core/xer/parse.ts';
import { reviewSchedule, reviewText } from '../../core/query/review.ts';
import { rows } from '../../core/db.ts';

const ok = (c: boolean, m: string) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) process.exitCode = 1; };
const argv = process.argv.slice(2);
const pastAt = argv.indexOf('--past');
const past = pastAt >= 0 ? argv.splice(pastAt, 2)[1] : undefined;
const request = argv[0] ?? 'Create a schedule for a five-story reinforced-concrete office building.';
const real = join(process.env.APPDATA!, 'p6-clone');
const profile = mkdtempSync(join(tmpdir(), 'p6realbuild-'));
for (const f of ['Local State', 'ai-assistant.json']) copyFileSync(join(real, f), join(profile, f));
const root = join(import.meta.dirname, '..', '..');
const app = await electron.launch({ args: [root, '--user-data', profile, ...(past ? ['--import', past] : [])], cwd: root });
const win = await app.firstWindow(); const errors: string[] = []; win.on('pageerror', (e) => errors.push(e.message));
if (past) {
  await win.waitForSelector('button:has-text("View Diagnostics...")'); await win.click('button:has-text("Next >")'); await win.click('button:has-text("Finish")'); await win.waitForSelector('.grid-row');
  for (let i = 0; i < 4 && (await win.locator('.dialog').count()); i++) { await win.keyboard.press('Escape'); await win.waitForTimeout(150); }
}
await win.waitForSelector('.ai-strip'); await win.waitForTimeout(400); if (!(await win.locator('.ai-panel').count())) await win.click('.ai-strip');
await win.fill('.ai-panel textarea', request); await win.keyboard.press('Enter');
const t0 = Date.now();
let seen = 0;
while (Date.now() - t0 < 30 * 60000 && !(await win.locator('.ai-msg.ai').count()) && !(await win.locator('.ai-msg.error').count())) {
  const tools = (await win.locator('.ai-msg.tool').allInnerTexts()).filter((t) => t !== 'Thinking...');
  for (; seen < tools.length; seen++) console.log(`  [${((Date.now() - t0) / 1000).toFixed(0)} s] ${tools[seen]}`);
  await win.waitForTimeout(1000);
}
const err = await win.locator('.ai-msg.error').allInnerTexts();
const reply = (await win.locator('.ai-msg.ai').allInnerTexts()).at(-1) ?? '';
console.log(`\n### ${request}  (${((Date.now() - t0) / 60000).toFixed(1)} min)\n${err.length ? 'ERROR: ' + err.join(' | ') : reply}\n`);
const shown = await win.locator('.grid-row').count();
await win.waitForTimeout(3000); // let the database save
await app.close();

const file = join(profile, 'p6clone-db.json');
ok(existsSync(file), 'the database was saved');
const { db } = linesToDb(readFileSync(file, 'utf8').split('\n').filter(Boolean));
const all = rows(db, 'PROJECT').filter((p) => !p._baseline_of);
const pastIds = new Set(past ? rows(parseXer(new Uint8Array(readFileSync(past))).db, 'PROJECT').map((p) => p.proj_short_name) : []);
const projs = all.filter((p) => !pastIds.has(p.proj_short_name));
const newIds = new Set(projs.map((p) => p.proj_id));
const tasks = rows(db, 'TASK').filter((t) => newIds.has(t.proj_id));
if (past) {
  const orig = parseXer(new Uint8Array(readFileSync(past))).db;
  const kept = all.filter((p) => pastIds.has(p.proj_short_name));
  const now = rows(db, 'TASK').filter((t) => kept.some((p) => p.proj_id === t.proj_id));
  console.log(`past project: ${kept.map((p) => p.proj_short_name).join(', ')}, ${now.length} activities (file: ${rows(orig, 'TASK').length})`);
  ok(kept.length === pastIds.size && now.length === rows(orig, 'TASK').length && now.every((t) => rows(orig, 'TASK').some((o) => o.task_code === t.task_code && o.task_name === t.task_name && o.target_drtn_hr_cnt === t.target_drtn_hr_cnt)), 'the past project was not changed');
}
const finish = tasks.map((t) => t.early_end_date).filter(Boolean).sort().at(-1);
console.log(`projects: ${projs.map((p) => p.proj_short_name).join(', ')}; activities: ${tasks.length}; WBS: ${rows(db, 'PROJWBS').length}; relationships: ${rows(db, 'TASKPRED').length}; finish: ${finish}; rows on screen: ${shown}`);
const review = reviewSchedule(db, { projIds: [...newIds] });
console.log(reviewText(review));
ok(!err.length, 'finished without an error');
ok(projs.length === 1 && tasks.length >= 60, `built a project with 60+ activities (${tasks.length})`);
ok(tasks.every((t) => t.early_start_date), 'every activity was scheduled');
ok(review.grade !== 'fail', `schedule review is not a fail (${review.grade})`);
ok(errors.length === 0, `no page errors${errors.length ? ': ' + errors.join(' | ') : ''}`);
rmSync(profile, { recursive: true, force: true });
