// Rendering the 4D viewer without a screen: the Chromium named by P6CLONE_CHROMIUM (the environment only: a tool
// argument never chooses a program to run), driven over the DevTools protocol on a pipe (--remote-debugging-pipe: no
// WebSocket, so Node 18/20 work too). WebGL runs in software (SwiftShader), slower than a GPU but the same frames.
// Without a Chromium the caller gets the viewer and renders it on a GPU instead (the platform's client render, or the
// desktop app). A WebM (browsers without an H.264 encoder) becomes an MP4 with the ffmpeg named by P6CLONE_FFMPEG.
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

/** A program from the environment, if it names an existing file. */
const fromEnv = (name: string): string | null => { const p = process.env[name]; return p && existsSync(p) ? p : null; };
export const chromiumPath = (): string | null => fromEnv('P6CLONE_CHROMIUM');
export const ffmpegPath = (): string | null => fromEnv('P6CLONE_FFMPEG');

/** The headless browser could not be started or talked to: a clean failure for the tool to report, never a crash. */
export class RenderFailed extends Error {}

export type Progress = (done: number, total: number, note: string) => Promise<void>;
type Evaluate = (expression: string, awaitPromise?: boolean) => Promise<unknown>;

/** Load the viewer page headless and run work against it (evaluate expressions in the page). onProgress may throw (a
 *  cancelled job): the browser is closed and the error passes through. */
export async function inChromium<T>(chromium: string, page: string, work: (evaluate: Evaluate) => Promise<T>, o: { width?: number; height?: number; timeoutMs?: number } = {}): Promise<T> {
  const profile = mkdtempSync(join(tmpdir(), 'p6c4d-chrome-'));
  const args = ['--headless=new', '--remote-debugging-pipe', '--no-first-run', '--no-default-browser-check', `--user-data-dir=${profile}`, '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--allow-file-access-from-files', `--window-size=${o.width ?? 1280},${o.height ?? 760}`, 'about:blank'];
  let died: Error | null = null;
  const waiting = new Map<number, { res: (v: any) => void; rej: (e: Error) => void }>();
  const failAll = (e: Error) => { died ??= e; for (const w of waiting.values()) w.rej(e); waiting.clear(); };
  const child = spawn(chromium, args, { stdio: ['ignore', 'ignore', 'pipe', 'pipe', 'pipe'], windowsHide: true });
  let stderr = '';
  child.on('error', (e) => failAll(new RenderFailed(`The Chromium at P6CLONE_CHROMIUM could not be started: ${e.message}`)));
  child.on('exit', (code) => failAll(new RenderFailed(`The Chromium at P6CLONE_CHROMIUM exited (code ${code}) before the render finished.${stderr ? ` ${stderr.trim().slice(-300)}` : ''}`)));
  child.stderr?.on('data', (d) => { stderr = (stderr + String(d)).slice(-2000); });
  const write = child.stdio[3] as NodeJS.WritableStream, read = child.stdio[4] as NodeJS.ReadableStream;
  // a program that is not Chromium closes the pipes at once: those errors end the render, not the server
  write.on('error', (e: Error) => failAll(new RenderFailed(`The Chromium at P6CLONE_CHROMIUM does not speak the DevTools protocol: ${e.message}`)));
  read.on('error', (e: Error) => failAll(new RenderFailed(`The Chromium at P6CLONE_CHROMIUM does not speak the DevTools protocol: ${e.message}`)));
  let buf = Buffer.alloc(0), id = 0;
  read.on('data', (d: Buffer) => {
    buf = Buffer.concat([buf, d]);
    for (let z = buf.indexOf(0); z >= 0; z = buf.indexOf(0)) {
      let msg: any;
      try { msg = JSON.parse(buf.subarray(0, z).toString('utf8')); } catch { failAll(new RenderFailed('The program at P6CLONE_CHROMIUM sent something that is not the DevTools protocol.')); return; } finally { buf = buf.subarray(z + 1); }
      const w = msg.id != null ? waiting.get(msg.id) : undefined;
      if (w) { waiting.delete(msg.id); if (msg.error) w.rej(new Error(msg.error.message)); else w.res(msg.result); }
    }
  });
  const send = (method: string, params: object = {}, sessionId?: string) => new Promise<any>((res, rej) => {
    if (died) return rej(died);
    const i = ++id; waiting.set(i, { res, rej });
    write.write(JSON.stringify({ id: i, method, params, ...(sessionId ? { sessionId } : {}) }) + '\0');
  });
  const timer = setTimeout(() => failAll(new RenderFailed(`The render took longer than ${Math.round((o.timeoutMs ?? 30 * 60_000) / 60_000)} minutes.`)), o.timeoutMs ?? 30 * 60_000);
  try {
    const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
    await send('Emulation.setDeviceMetricsOverride', { width: o.width ?? 1280, height: o.height ?? 760, deviceScaleFactor: 1, mobile: false }, sessionId);
    await send('Page.enable', {}, sessionId);
    await send('Page.navigate', { url: pathToFileURL(page).href }, sessionId);
    const evaluate: Evaluate = async (expression, awaitPromise = true) => {
      const r = await send('Runtime.evaluate', { expression, awaitPromise, returnByValue: true }, sessionId);
      if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text ?? 'The page failed.');
      return r.result?.value;
    };
    // wait for the model to load (the viewer's ready hook)
    for (const t0 = Date.now(); !(await evaluate('window.P6C4D_API ? window.P6C4D_API.ready() : false', false)); ) {
      if (Date.now() - t0 > 120_000) throw new RenderFailed('The 4D viewer did not load in the headless Chromium within 2 minutes.');
      await new Promise((r2) => setTimeout(r2, 250));
    }
    return await work(evaluate);
  } finally {
    clearTimeout(timer);
    if (!died) try { await Promise.race([send('Browser.close'), new Promise((r) => setTimeout(r, 2000))]); } catch { /* closing */ }
    child.removeAllListeners('exit');
    child.kill();
    await new Promise((r) => setTimeout(r, 300));
    try { rmSync(profile, { recursive: true, force: true }); } catch { /* a locked profile file is left to the temp cleaner */ }
  }
}

/** PNG frames at the dates, one page call each, with progress (and cancellation) between frames. */
export async function renderPngs(evaluate: Evaluate, dates: string[], onProgress: Progress): Promise<Buffer[]> {
  const out: Buffer[] = [];
  for (const [i, d] of dates.entries()) {
    await onProgress(i, dates.length, `frame ${i + 1} of ${dates.length}`);
    const url = String(await evaluate(`window.P6C4D_API.png(${JSON.stringify(d)})`));
    out.push(Buffer.from(url.replace(/^data:image\/png;base64,/, ''), 'base64'));
  }
  return out;
}

/** The video encoded in the page; progress is read from the page every half second while it runs. */
export async function renderVideo(evaluate: Evaluate, o: object, onProgress: Progress): Promise<{ mime: string; frames: number; bytes: Buffer }> {
  const run = evaluate(`window.P6C4D_API.encode(${JSON.stringify(o)}).then((r) => { let s = ''; const b = r.bytes; for (let i = 0; i < b.length; i += 32768) s += String.fromCharCode.apply(null, b.subarray(i, i + 32768)); return { mime: r.mime, frames: r.frames, b64: btoa(s) }; })`) as Promise<{ mime: string; frames: number; b64: string }>;
  let finished = false;
  const watch = (async () => {
    while (!finished) {
      await new Promise((r) => setTimeout(r, 500));
      if (finished) return;
      const p = (await evaluate('window.P6C4D_API.progress()', false).catch(() => null)) as { done: number; total: number } | null;
      if (p?.total) await onProgress(p.done, p.total, `frame ${p.done} of ${p.total}`);
    }
  })();
  // a cancelled job (onProgress throws) ends the race; both promises are handled, so nothing is left unhandled
  const stop = new Promise<never>((_, rej) => { watch.catch(rej); });
  try {
    const v = await Promise.race([run, stop]);
    return { mime: v.mime, frames: v.frames, bytes: Buffer.from(v.b64, 'base64') };
  } finally { finished = true; }
}

/** WebM to MP4 (H.264) with ffmpeg; null when no ffmpeg is configured. */
export async function webmToMp4(webm: Buffer, ffmpeg: string | null = ffmpegPath()): Promise<Buffer | null> {
  if (!ffmpeg) return null;
  const dir = mkdtempSync(join(tmpdir(), 'p6c4d-ff-'));
  try {
    const src = join(dir, 'in.webm'), dst = join(dir, 'out.mp4');
    writeFileSync(src, webm);
    const err = await new Promise<string | null>((resolve) => {
      const c = spawn(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', '-i', src, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', dst], { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
      let e = '';
      c.stderr.on('data', (d) => { e = (e + String(d)).slice(-1000); });
      c.on('error', (x) => resolve(`ffmpeg could not be started: ${x.message}`));
      c.on('exit', (code) => resolve(code === 0 ? null : `ffmpeg failed (code ${code}): ${e.trim()}`));
    });
    if (err) throw new RenderFailed(err);
    return readFileSync(dst);
  } finally { rmSync(dir, { recursive: true, force: true }); }
}
