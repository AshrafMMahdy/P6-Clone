// End-to-end: what the AI panel shows of everything the embedded platform agent does, with a scripted stand-in model
// (fake-model.ts). One turn makes the agent load tools, set a plan and tick it, dispatch a researcher sub-agent (slow, so
// it is seen working), save a memory and answer; a message sent while it works is steered in and shown delivered; the
// reply it suggests is a chip that sends. Then events the model cannot make (a sign-in request, the autopilot, a hand-off,
// a message rewritten or taken back, one step reported three times) are sent into the panel as the agent's stream sends them.
//   node tests/e2e/whiq-panel-events.ts   (needs vendor/whiq-agent installed and built)
import { _electron as electron } from 'playwright';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fakeModel, type Req } from './fake-model.ts';
const ok = (c: boolean, m: string) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) process.exitCode = 1; };

const offered = (r: Req, n: string) => (r.tools ?? []).some((t) => t.function.name === n);
const toolResults = (r: Req) => r.messages.filter((m) => m.role === 'tool').length;
const users = (r: Req) => r.messages.filter((m) => m.role === 'user').map((m) => JSON.stringify(m.content ?? '')).join(' ');
const fake = await fakeModel((r) => {
  // the call that drafts the suggested replies
  if (r.messages.some((m) => String(m.content ?? '').includes("write the USER's next message"))) return { text: JSON.stringify({ suggestions: ['chip reply one', 'chip reply two', 'chip reply three'], best: 1 }) };
  if (!offered(r, 'load_tools')) return { text: 'ok' };
  const n = toolResults(r);
  // the researcher: one step, then hands back (each takes a while, so the panel can show it working)
  if (offered(r, 'hand_back')) return n === 0 ? { call: 'list_outputs', args: {}, delayMs: 1800 } : { call: 'hand_back', args: { summary: 'The contract has no surprises.' }, delayMs: 1800 };
  // the turn: the latest of the user's messages that start one (the platform's own context text may hold any word)
  const u = users(r);
  const asked = r.messages.filter((m) => m.role === 'user' && ['events question', 'chip reply two'].includes(String(m.content))).pop()?.content;
  // the chip's turn: the plan is cleared (a text-only turn with a plan still on is nudged as a false stop), then the answer
  if (asked === 'chip reply two') return r.messages[r.messages.length - 1].role === 'tool' ? { text: 'Chip received.' } : { call: 'run_plan', args: { action: 'clear' } };
  if (n === 0) return { call: 'load_tools', args: { names: ['run_plan', 'dispatch_agents', 'save_memory'] } };
  if (n === 1) return { call: 'run_plan', args: { action: 'set', steps: ['Read the schedule', 'Research the contract', 'Write the answer'] } };
  if (n === 2) return { call: 'dispatch_agents', args: { agents: [{ name: 'contract-scan', task: 'Scan the contract for surprises.', mode: 'research' }] } };
  if (n === 3) return { call: 'run_plan', args: { action: 'check', step_indexes: [1, 2, 3] } };
  if (n === 4) return { call: 'save_memory', args: { text: 'The owner wants a weekly look-ahead on this project.', about: 'general' } };
  return { text: u.includes('pineapple') ? 'Done: noted the pineapple.' : 'Done: no steer arrived.' };
});

const root = join(import.meta.dirname, '..', '..');
const profile = mkdtempSync(join(tmpdir(), 'p6whiqe-'));
const app = await electron.launch({ args: [root, '--user-data', profile, '--import', join(root, 'Sample XERs/cairo festival city.xer')], cwd: root });
const win = await app.firstWindow(); const errors: string[] = []; win.on('pageerror', (e) => errors.push(e.message));
await win.waitForSelector('button:has-text("View Diagnostics...")'); await win.click('button:has-text("Next >")'); await win.click('button:has-text("Finish")'); await win.waitForSelector('.grid-row');
for (let i = 0; i < 4 && (await win.locator('.dialog').count()); i++) { await win.keyboard.press('Escape'); await win.waitForTimeout(150); }
await win.evaluate((u) => (window as any).p6.aiSetConfig({ enabled: true, provider: 'openai', baseUrl: u, model: 'fake-1', actions: true }, 'not-a-key'), fake.url);
await win.waitForSelector('.ai-panel', { timeout: 15000 }).catch(async () => { await win.click('.ai-strip'); await win.waitForSelector('.ai-panel'); });
await win.waitForSelector('.ai-head b:has-text("Scheduler Agent")', { timeout: 15000 });
const body = () => win.locator('.ai-panel .ai-body').innerText();
/** how many step/note lines read exactly like `re` (the glyph in front of a step is not part of its words) */
const lines = (re: RegExp) => win.locator('.ai-panel .ai-msg.tool').evaluateAll((els, src) => els.filter((e) => new RegExp(src).test((e.textContent ?? '').replace(/^[^\w$]\s?/, ''))).length, re.source);

// ---- the turn
await win.fill('.ai-panel textarea', 'events question');
await win.keyboard.press('Enter');
await win.waitForSelector('.ai-panel .ai-pin:has-text("contract-scan")', { timeout: 90000 });
const kidLive = await win.locator('.ai-panel .ai-pins').innerText();
ok(/contract-scan · researcher · step \d+\/\d+ · running/.test(kidLive), `a live line for the researcher while it works: ${kidLive.replace(/\s+/g, ' ').slice(0, 120)}`);
ok(await win.locator('.ai-panel .ai-send.stop').count() === 1 && await win.locator('.ai-panel .ai-send:not(.stop)').count() === 1, 'Send is there next to Stop while the agent works');
// steer: a message while it works
await win.fill('.ai-panel textarea', 'please also say pineapple');
await win.click('.ai-panel .ai-send:not(.stop)');
await win.waitForSelector('.ai-panel .ai-msg.user:has-text("pineapple") .ai-steer', { timeout: 5000 });
ok(/sent/.test(await win.locator('.ai-panel .ai-msg.user:has-text("pineapple") .ai-steer').innerText()), 'the steered message shows as sent');
await win.waitForSelector('.ai-panel .ai-msg:has-text("Done: noted the pineapple.")', { timeout: 120000 }).catch(() => {});
ok(/Done: noted the pineapple\./.test(await body()), 'the agent read the steered message and answered with it');
ok(/delivered/.test(await win.locator('.ai-panel .ai-msg.user:has-text("pineapple") .ai-steer').innerText()), 'the steered message shows as delivered');
await win.waitForSelector('.ai-panel .ai-send.stop', { state: 'detached', timeout: 30000 }).catch(() => {});
ok(await win.locator('.ai-panel .ai-send.stop').count() === 0, 'the panel is not left busy');

// each step once, in its final state
ok(await lines(/^load tools$/) === 1, 'the tool-loading step shows once (not once per status change)');
ok(await lines(/^Sub-agents: /) === 1, 'the dispatch step shows once');
ok(await lines(/^save memory$/) === 1, 'the memory step shows once');
ok(await win.locator('.ai-panel .ai-msg.tool .st', { hasText: '⋯' }).count() === 0, 'no step is left running');
ok(await win.locator('.ai-panel .ai-msg.tool .st', { hasText: '✓' }).count() >= 3, 'finished steps are ticked');
// plan
const plan = await win.locator('.ai-panel .ai-pin:has-text("Plan")').innerText();
ok(/Plan 3\/3/.test(plan) && /Read the schedule/.test(plan) && /Research the contract/.test(plan) && /Write the answer/.test(plan), `the plan is a checklist, ticked in place: ${plan.replace(/\s+/g, ' ')}`);
ok(await win.locator('.ai-panel .ai-pin:has-text("Plan")').count() === 1, 'one plan block');
// sub-agent finished: collapsed
const kids = await win.locator('.ai-panel .ai-pin:has-text("Sub-agents")').innerText();
ok(/1 finished/.test(kids) && !/contract-scan/.test(kids), `a finished sub-agent collapses: ${kids.replace(/\s+/g, ' ')}`);
await win.click('.ai-panel .ai-pin:has-text("Sub-agents") a');
ok(/contract-scan · researcher · step \d+\/\d+ · handed back/.test(await win.locator('.ai-panel .ai-pin:has-text("Sub-agents")').innerText()), 'and opens to its last state');
// memory, cost
ok(/Saved to memory: The owner wants a weekly look-ahead/.test(await body()), 'a "Saved to memory" note');
ok(/\d+ tokens/.test(await win.locator('.ai-panel .ai-input').innerText()), 'the running cost shows');
// suggested replies: chips that send
await win.waitForSelector('.ai-panel .ai-chip', { timeout: 30000 });
ok(await win.locator('.ai-panel .ai-chip').count() === 3 && await win.locator('.ai-panel .ai-chip.best').innerText() === 'chip reply two', 'three suggested replies, the best marked');
await win.click('.ai-panel .ai-chip.best');
await win.waitForSelector('.ai-panel .ai-msg:has-text("Chip received.")', { timeout: 60000 }).catch(() => {});
ok(await win.locator('.ai-panel .ai-msg.user:has-text("chip reply two")').count() === 1 && /Chip received\./.test(await body()), `a chip sends its reply and the agent answers it: ${(await body()).slice(-300).replace(/\s+/g, ' ')}`);

ok(await win.locator('.ai-panel .ai-pin:has-text("Plan")').count() === 0, 'a plan the agent cleared leaves the panel');

// ---- events the model cannot make: sent into the panel as the agent's stream sends them
const chatId = await win.evaluate(() => Object.values(JSON.parse(localStorage.getItem('p6clone.whiq.chats') ?? '{}'))[0] as string);
const emit = (e: Record<string, unknown>) => app.evaluate(({ BrowserWindow }, [id, ev]) => { BrowserWindow.getAllWindows()[0].webContents.send('whiq:event', id, ev); }, [chatId, e] as const);
const tool = (status: string) => emit({ type: 'tool_call', messageId: 'a1', record: { id: 'tc-x', toolName: 'compute_slack', args: {}, status } });
await tool('pending'); await tool('running'); await tool('ok');
await emit({ type: 'tool_result', messageId: 'a1', toolCallId: 'tc-x', result: { ok: true } });
await win.waitForTimeout(300);
ok(await lines(/^compute slack$/) === 1 && await win.locator('.ai-panel .ai-msg.tool', { hasText: 'compute slack' }).locator('.st', { hasText: '✓' }).count() === 1, 'one step reported three times (and its result) is one line, done');
await tool('error');
await win.waitForTimeout(200);
ok(await win.locator('.ai-panel .ai-msg.tool.err', { hasText: 'compute slack' }).count() === 1, 'a failed step shows as failed, in place');
await emit({ type: 'message', message: { id: 'm-x', role: 'assistant', content: 'Draft wording.' } });
await emit({ type: 'message_replaced', messageId: 'm-x', content: 'Final wording.' });
await win.waitForTimeout(200);
ok(/Final wording\./.test(await body()) && !/Draft wording/.test(await body()), 'a rewritten message is replaced in place');
await emit({ type: 'message_hidden', messageId: 'm-x' });
await win.waitForTimeout(200);
ok(!/Final wording/.test(await body()), 'a message the agent took back is removed');
await emit({ type: 'handoff', handoff: { id: 'ho-1', task: 'Draft the claim letter', status: 'pending' } });
await win.waitForSelector('.ai-panel .ai-msg:has-text("Draft the claim letter") button:has-text("Do it here")');
await emit({ type: 'handoff', handoff: { id: 'ho-1', task: 'Draft the claim letter', status: 'declined' } });
await win.waitForTimeout(200);
ok(await win.locator('.ai-panel .ai-msg:has-text("Draft the claim letter")').count() === 1 && /not now/.test(await body()), 'a hand-off shows with its choices, then its outcome, in place');
await emit({ type: 'browser_attention', attention: { mode: 'pulse', reason: 'Sign in to the portal', at: '' } });
await win.waitForSelector('.ai-panel .ai-pin:has-text("Sign in to the portal")');
await emit({ type: 'browser_attention', attention: null });
await win.waitForTimeout(200);
ok(await win.locator('.ai-panel .ai-pin:has-text("Sign in to the portal")').count() === 0, 'a request for the user at the browser shows, then clears');
const run = (status: string) => ({ type: 'autopilot', run: { status, repliesUsed: 2, maxReplies: 10, log: [{ detail: 'the goal was met' }] } });
await emit(run('watching'));
await win.waitForSelector('.ai-panel .ai-pin:has-text("Autopilot watching · 2/10")');
await emit(run('done'));
await win.waitForTimeout(200);
ok(await win.locator('.ai-panel .ai-pin:has-text("Autopilot")').count() === 0 && /Autopilot done: the goal was met/.test(await body()), 'the autopilot shows while it watches and leaves a note when it ends');

// what needs the user: the chat as the agent keeps it names it; pinned until the user writes
const asked = new Date(Date.now() - 1000).toISOString();
await app.evaluate(({ ipcMain }, at) => {
  ipcMain.removeHandler('whiq:chat');
  // the chat as the agent keeps it: a question it went on without, until a message of the user's comes after it
  ipcMain.handle('whiq:chat', async () => ({ ok: true, data: { messages: (globalThis as any).answered ? [{ id: 'u2', role: 'user', content: 'answer', timestamp: new Date().toISOString() }] : [], needsYou: [{ question: 'Which baseline should the forecast use?', at }] } }));
}, asked);
await emit({ type: 'done', messageId: 'a2' });
await win.waitForSelector('.ai-panel .ai-pin.warn:has-text("Needs you"):has-text("Which baseline should the forecast use?")', { timeout: 5000 }).catch(() => {});
ok(await win.locator('.ai-panel .ai-pin.warn:has-text("Which baseline")').count() === 1, 'what needs the user is pinned at the top');
await app.evaluate(() => { (globalThis as any).answered = true; });
await win.fill('.ai-panel textarea', 'Use the baseline from last month.');
await win.keyboard.press('Enter');
await win.waitForTimeout(300);
await emit({ type: 'done', messageId: 'a3' });
await win.waitForTimeout(500);
ok(await win.locator('.ai-panel .ai-pin.warn:has-text("Which baseline")').count() === 0, 'and goes when the user answers');
ok(!errors.length, 'no page errors ' + errors.join(' | '));
await app.close();
fake.close();
rmSync(profile, { recursive: true, force: true });
