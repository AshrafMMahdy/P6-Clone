// Extensions > 4D: open an IFC model, see it in the viewer, pick an element and link it to the selected activity,
// the 4D bottom pane, a Navisworks package, and a video rendered on this computer's GPU.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { _electron as electron } from 'playwright';
import { existsSync, mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const ROOT = join(import.meta.dirname, '..', '..');
const IFC = join(ROOT, 'tests', 'fixtures', '4d', 'Duplex_A_20110907.ifc');

test('4D: model, viewer, pick and link, bottom pane, package, video', { timeout: 300_000 }, async () => {
  const userData = mkdtempSync(join(tmpdir(), 'p6clone-e2e-4d-'));
  const out = mkdtempSync(join(tmpdir(), 'p6clone-e2e-4d-out-'));
  // P6CLONE_E2E_EXE: run the packaged app (release/P6 Clone/P6 Clone.exe) instead of the built one
  const exe = process.env.P6CLONE_E2E_EXE, data = ['--user-data', userData, '--import', join(ROOT, 'Sample XERs', 'el ezz warehouse.xer')];
  const app = await electron.launch(exe ? { executablePath: exe, args: data } : { args: [ROOT, ...data], cwd: ROOT });
  const errors: string[] = [];
  try {
    const win = await app.firstWindow();
    win.on('pageerror', (e) => errors.push(e.message));
    const menu = (id: string) => app.evaluate(({ BrowserWindow }, id) => BrowserWindow.getAllWindows()[0].webContents.send('menu', id), id);
    // the file dialogs answer by themselves
    await app.evaluate(({ dialog }, o) => {
      dialog.showOpenDialog = (async (_w: unknown, opts: { properties?: string[] }) => ({ canceled: false, filePaths: [opts.properties?.includes('openDirectory') ? o.out : o.ifc] })) as never;
      dialog.showSaveDialog = (async (_w: unknown, opts: { defaultPath?: string }) => ({ canceled: false, filePath: `${o.out}/${opts.defaultPath}` })) as never;
    }, { ifc: IFC, out });
    await win.waitForSelector('button:has-text("View Diagnostics...")', { timeout: 30_000 });
    await win.click('button:has-text("Next >")');
    await win.click('button:has-text("Finish")');
    await win.waitForSelector('.grid-row:not(.group)', { timeout: 30_000 });
    if (await win.locator('.dialog:has-text("Import Log")').count()) await win.click('.dialog button:has-text("Close")');
    await win.locator('.grid-row:not(.group)').first().click();

    await menu('tools.extensions');
    await win.locator('.dirbtn', { has: win.locator('b', { hasText: /^4D$/ }) }).click();
    await win.click('button:has-text("Open model (IFC, Revit)")');
    await win.waitForSelector('text=/\\d+ elements ·/', { timeout: 120_000 });
    const frame = win.frameLocator('iframe');
    await frame.locator('canvas').first().waitFor({ timeout: 60_000 });
    await win.waitForTimeout(1500);

    // pick the element in the middle of the view, link it to the selected activity
    const box = (await win.locator('iframe').boundingBox())!;
    for (const [fx, fy] of [[0.5, 0.5], [0.45, 0.55], [0.55, 0.45], [0.5, 0.6]]) {
      await win.mouse.click(box.x + box.width * fx, box.y + box.height * fy);
      await win.waitForTimeout(300);
      if (!(await win.locator('legend:has-text("Picked (0)")').count())) break;
    }
    assert.equal(await win.locator('legend:has-text("Picked (0)")').count(), 0, 'an element was picked');
    await win.click('button:has-text("Link to ")');
    await win.waitForSelector('text=/1 links added to/');
    await win.waitForSelector('text=/ · 1 links · /');

    // the 4D bottom pane under the Activities window
    await menu('view.bottom.fourd');
    await win.waitForSelector('text=/: 1 elements, shown at its finish/', { timeout: 30_000 });

    // a Navisworks package
    await menu('tools.extensions');
    await win.click('button:has-text("Export...")').catch(() => win.click('button:has-text("Export…")'));
    await win.waitForSelector('text=/Wrote \\d+ files/', { timeout: 60_000 });
    for (const f of ['timeliner.csv', 'README.txt']) assert.ok(existsSync(join(out, f)), f);
    assert.ok(readdirSync(out).some((f) => f.endsWith('-4D.ifc')) && readdirSync(out).some((f) => f.endsWith('-4D-sets.xml')));

    // a video, encoded in the page on this computer
    await win.click('button:has-text("Video")');
    await win.waitForSelector('text=/Saved .*frames|Video failed/', { timeout: 180_000 });
    const video = readdirSync(out).find((f) => /-4D\.(mp4|webm)$/.test(f));
    assert.ok(video, `video written: ${await win.locator('.toast').allInnerTexts().catch(() => [])}`);
    assert.ok(statSync(join(out, video!)).size > 1000);
    assert.deepEqual(errors, []);
  } finally {
    await app.close();
    // Windows may hold the profile a moment after the app exits
    for (const d of [userData, out]) try { rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 }); } catch { /* left to the temp cleaner */ }
  }
});
