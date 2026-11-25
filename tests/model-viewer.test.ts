// render_4d's viewer of a model with nothing linked (owner, 2026-11-25, item 32): the model as it is, the page under the name asked — what the
// platform's preview pane shows of an uploaded model (IFC, Revit, Navisworks, SYNCHRO), read by the clone. The page never carries the model
// (owner 2026-11-25): its folder is beside it, fetched when the page is served, handed to it by its window when it has no address (the
// platform's preview pane shows it in a sandboxed frame).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';

process.env.P6CLONE_MODEL_CACHE = mkdtempSync(join(tmpdir(), 'p6-mv-cache-'));
const { callTool, toolResult } = await import('../mcp/server.ts');
const { ifcWriter } = await import('../core/bim/nwd/toIfc.ts');
const call = async (name: string, args: Record<string, unknown>) => { const r = await callTool(name, args); return { err: r.isError, d: toolResult(r.out, r.isError).structuredContent as any }; };
const CHROME = [process.env.P6CLONE_CHROMIUM, '/opt/pw-browsers/chromium', 'C:/Program Files/Google/Chrome/Application/chrome.exe', '/usr/bin/chromium'].find((p) => p && existsSync(p));

test('a model with nothing linked: the viewer draws it as it is, the page under the name asked with its model folder; images still need links', { skip: !CHROME && 'no Chromium here', timeout: 600_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'p6-mv-')), ifc = join(dir, 'two.ifc');
  const w = ifcWriter(ifc, { name: 'Two boxes', file: 'two.ifc' });
  const box = (x: number) => ({ positions: [x, 0, 0, x + 1, 0, 0, x + 1, 1, 0, x, 1, 0, x, 0, 1, x + 1, 0, 1, x + 1, 1, 1, x, 1, 1], triangles: [0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4, 1, 2, 6, 1, 6, 5, 2, 3, 7, 2, 7, 6, 3, 0, 4, 3, 4, 7] });
  for (const [k, x] of [0, 3].entries()) w.add({ guid: null, key: `b${k}`, name: `Box ${k}`, category: null, family: null, type: null, level: 'L1', levelElevationM: null, layer: null, material: null, psets: {}, quantities: {}, revitId: null }, k, 0, box(x));
  w.finish();
  const om = await call('open_model', { path: ifc });
  assert.equal(om.err, false, JSON.stringify(om.d).slice(0, 300));
  const page = join(dir, 'preview', 'model.html');
  const v = await call('render_4d', { handle: om.d.handle, kind: 'viewer', path: page });
  assert.equal(v.err, false, JSON.stringify(v.d).slice(0, 300));
  assert.equal(v.d.written[0], page, 'the page, under the name asked');
  assert.ok(v.d.written.slice(1).every((f: string) => /^model-[0-9a-f]{16}$/.test(basename(dirname(f))) && dirname(dirname(f)) === dirname(page)), 'its model folder beside it');
  assert.doesNotMatch(readFileSync(page, 'utf8'), /<script src=|"inline"/, 'the script inside the page, the model not');
  assert.match(String(v.d.note), /No activity has linked elements: the page shows the model as it is, with nothing scheduled\. For the 4D, link elements first/, 'the answer says nothing is linked, and how to link');
  const { inChromium } = await import('../core/bim/headless.ts');
  const r = await inChromium(CHROME!, page, (ev) => ev(`(async () => ({ ok: window.WHIQ4D_EXPORT.ready(), status: window.WHIQ4D_EXPORT.status() }))()`)) as any;
  assert.equal(r.ok, true, JSON.stringify(r.status));
  assert.notEqual(r.status.state, 'failed', JSON.stringify(r.status));
  // the same page with no address (a sandboxed frame given its text, as the platform's preview pane shows it): it asks its window for
  // each file of its model folder, and draws what it is handed
  writeFileSync(join(dirname(page), 'host.html'), `<!doctype html><html><body><iframe id="f" sandbox="allow-scripts" style="width:640px;height:400px"></iframe><script>
let st = { state: 'loading', tiles: { loaded: 0, total: 0 } };
window.P6C4D_API = { status: () => st };   // what the test's browser waits on: the framed page's own status, as it signals it
window.result = new Promise(async (done) => {
  const f = document.getElementById('f'), asked = [];
  addEventListener('message', async (e) => {
    const d = e.data;
    if (e.source !== f.contentWindow || !d) return;
    if (d.status) st = d.status;
    if (d.source === 'whiq-4d' && d.type === 'file') { asked.push(d.path); const b = await (await fetch(d.path)).arrayBuffer(); f.contentWindow.postMessage({ source: 'whiq-4d-file', id: d.id, bytes: b }, '*', [b]); }
    if (d.type === 'whiq4d:ready') done({ ok: true, asked });
    if (d.type === 'whiq4d:error') done({ ok: false, error: d, asked });
  });
  f.srcdoc = await (await fetch('model.html')).text();
});
</script></body></html>`);
  const framed = await inChromium(CHROME!, join(dirname(page), 'host.html'), (ev) => ev('window.result')) as any;
  assert.equal(framed.ok, true, JSON.stringify(framed).slice(0, 400));
  assert.ok(framed.asked.length >= 3 && framed.asked.every((p: string) => /^model-[0-9a-f]{16}\/(manifest\.json|elements\.txt|tile-\d{5}\.glb)$/.test(p)), JSON.stringify(framed.asked));
  // a picture of the schedule still needs links
  assert.equal((await call('render_4d', { handle: om.d.handle, kind: 'images', path: join(dir, 'img') })).d.error.code, 'no_links');
});
