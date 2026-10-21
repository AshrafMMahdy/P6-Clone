// Rendering the 4D viewer without a screen: a Chromium the caller names (MCP chromium_path or P6CLONE_CHROMIUM), driven
// over the DevTools protocol on a pipe (--remote-debugging-pipe: no WebSocket, so Node 18/20 work too). WebGL runs in
// software (SwiftShader), slower than a GPU but the same frames. Without a Chromium the caller gets the viewer and
// renders it on a GPU instead (the platform's client render, or the desktop app).
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

/** A Chromium to use: the given path, P6CLONE_CHROMIUM, else none (no guessing at installed browsers). */
export function chromiumPath(given?: string): string | null {
  const p = given || process.env.P6CLONE_CHROMIUM;
  return p && existsSync(p) ? p : null;
}

/** Load the viewer page headless and run an expression in it (awaited); the value comes back as JSON. */
export async function inChromium<T>(chromium: string, page: string, expression: string, o: { width?: number; height?: number; timeoutMs?: number } = {}): Promise<T> {
  const profile = mkdtempSync(join(tmpdir(), 'p6c4d-chrome-'));
  const args = ['--headless=new', '--remote-debugging-pipe', '--no-first-run', '--no-default-browser-check', `--user-data-dir=${profile}`, '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--allow-file-access-from-files', `--window-size=${o.width ?? 1280},${o.height ?? 760}`, 'about:blank'];
  const child = spawn(chromium, args, { stdio: ['ignore', 'ignore', 'pipe', 'pipe', 'pipe'], windowsHide: true });
  const write = child.stdio[3] as NodeJS.WritableStream, read = child.stdio[4] as NodeJS.ReadableStream;
  let buf = Buffer.alloc(0), id = 0;
  const waiting = new Map<number, { res: (v: any) => void; rej: (e: Error) => void }>();
  read.on('data', (d: Buffer) => {
    buf = Buffer.concat([buf, d]);
    for (let z = buf.indexOf(0); z >= 0; z = buf.indexOf(0)) {
      const msg = JSON.parse(buf.subarray(0, z).toString('utf8')); buf = buf.subarray(z + 1);
      const w = msg.id != null ? waiting.get(msg.id) : undefined;
      if (w) { waiting.delete(msg.id); if (msg.error) w.rej(new Error(msg.error.message)); else w.res(msg.result); }
    }
  });
  const send = (method: string, params: object = {}, sessionId?: string) => new Promise<any>((res, rej) => { const i = ++id; waiting.set(i, { res, rej }); write.write(JSON.stringify({ id: i, method, params, ...(sessionId ? { sessionId } : {}) }) + '\0'); });
  const timer = setTimeout(() => child.kill(), o.timeoutMs ?? 10 * 60_000);
  try {
    const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
    await send('Emulation.setDeviceMetricsOverride', { width: o.width ?? 1280, height: o.height ?? 760, deviceScaleFactor: 1, mobile: false }, sessionId);
    await send('Page.enable', {}, sessionId);
    await send('Page.navigate', { url: pathToFileURL(page).href }, sessionId);
    // wait for the model to load (the viewer's ready hook)
    for (const t0 = Date.now(); ; ) {
      const r = await send('Runtime.evaluate', { expression: 'window.P6C4D_API ? window.P6C4D_API.ready() : false', returnByValue: true }, sessionId);
      if (r.result?.value === true) break;
      if (Date.now() - t0 > 120_000) throw new Error('The 4D viewer did not load in the headless Chromium within 2 minutes.');
      await new Promise((r2) => setTimeout(r2, 250));
    }
    const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, sessionId);
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text ?? 'The page failed.');
    return r.result?.value as T;
  } finally {
    clearTimeout(timer);
    try { await Promise.race([send('Browser.close'), new Promise((r) => setTimeout(r, 2000))]); } catch { /* closing */ }
    child.kill();
    await new Promise((r) => setTimeout(r, 300));
    try { rmSync(profile, { recursive: true, force: true }); } catch { /* a locked profile file is left to the temp cleaner */ }
  }
}

/** The expression that encodes the video in the page and hands the bytes back as base64. */
export const ENCODE = (o: object) => `window.P6C4D_API.encode(${JSON.stringify(o)}).then((r) => { let s = ''; const b = r.bytes; for (let i = 0; i < b.length; i += 32768) s += String.fromCharCode.apply(null, b.subarray(i, i + 32768)); return { mime: r.mime, frames: r.frames, b64: btoa(s) }; })`;
export const PNGS = (dates: string[]) => `(${JSON.stringify(dates)}).map((d) => window.P6C4D_API.png(d).replace(/^data:image\\/png;base64,/, ''))`;
