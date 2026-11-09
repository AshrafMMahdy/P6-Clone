// One running copy per data folder (main/main.ts): a second start on the same --user-data ends at once and the first
// copy hears of it; a start on another --user-data runs beside it. In the background: no window takes the front.
//   node tests/e2e/single-instance.ts [packaged exe]   (after node scripts/build.mjs; with an exe: after npm run package)
import { _electron as electron } from 'playwright';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
const ok = (c: boolean, m: string) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) process.exitCode = 1; };
const root = join(import.meta.dirname, '..', '..'), exe = process.argv[2];
const bin = exe ?? (createRequire(import.meta.url)('electron') as unknown as string), lead = exe ? [] : [root];
const launch = async (ud: string) => {
  const app = await electron.launch({ ...(exe ? { executablePath: exe } : {}), args: [...lead, '--user-data', ud], cwd: root });
  await app.evaluate(({ app, dialog }) => { dialog.showErrorBox = () => {}; const g = globalThis as any; g.__second = 0; app.on('second-instance', () => g.__second++); });
  await app.firstWindow();
  return app;
};
const state = (app: Awaited<ReturnType<typeof launch>>) => app.evaluate(({ BrowserWindow }) => { const w = BrowserWindow.getAllWindows(); return { second: (globalThis as any).__second as number, windows: w.length, minimized: w[0]?.isMinimized(), focused: w[0]?.isFocused() }; });
/** A plain second start (no Playwright): how it ended, and after how long. */
const start = (ud: string) => new Promise<{ code: number | null; ms: number; timedOut: boolean }>((res) => {
  const env: NodeJS.ProcessEnv = { ...process.env, P6CLONE_BACKGROUND: '1' }; delete env.ELECTRON_RUN_AS_NODE;
  const t0 = Date.now(), p = spawn(bin, [...lead, '--user-data', ud], { cwd: root, env, stdio: 'ignore' });
  const timer = setTimeout(() => { p.kill(); res({ code: null, ms: Date.now() - t0, timedOut: true }); }, 30_000);
  p.on('exit', (code) => { clearTimeout(timer); res({ code, ms: Date.now() - t0, timedOut: false }); });
});

const udA = mkdtempSync(join(tmpdir(), 'p6one-a-')), udB = mkdtempSync(join(tmpdir(), 'p6one-b-'));
const a = await launch(udA);
const second = await start(udA);
ok(!second.timedOut && second.code === 0, `a second start on the same data folder ends by itself (exit ${second.code}, ${second.ms} ms)`);
await new Promise((r) => setTimeout(r, 500));
const sa = await state(a);
ok(sa.second === 1, `the first copy heard of the second start (${sa.second})`);
ok(sa.windows === 1, `the first copy still has its one window (${sa.windows})`);
ok(sa.minimized === true && sa.focused === false, `in the background the first window stays minimized and unfocused (minimized ${sa.minimized}, focused ${sa.focused})`);
const b = await launch(udB);
const sb = await state(b);
ok(sb.windows === 1 && (await state(a)).windows === 1, 'a start on another data folder runs beside the first');
ok((await state(a)).second === 1 && sb.second === 0, 'and neither copy is told of it');
await b.close(); await a.close();
// the lock goes with the copy that held it: the next start on that folder is a first start again
const again = await launch(udA);
ok((await state(again)).windows === 1, 'after the first copy closed, a start on its data folder opens the app');
await again.close();
