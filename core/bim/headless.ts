// Rendering the 4D viewer without a screen: the Chromium named by P6CLONE_CHROMIUM (the environment only: a tool
// argument never chooses a program to run), driven over the DevTools protocol on a pipe (--remote-debugging-pipe: no
// WebSocket, so Node 18/20 work too). WebGL runs in software (SwiftShader), slower than a GPU but the same frames.
// Without a Chromium the caller gets the viewer and renders it on a GPU instead (the platform's client render, or the
// desktop app). A WebM (browsers without an H.264 encoder) becomes an MP4 with the ffmpeg named by P6CLONE_FFMPEG.
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createReadStream, existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { treeCpuMs, watchLiveness } from './liveness.ts';

/** A program from the environment, if it names an existing file. */
const fromEnv = (name: string): string | null => { const p = process.env[name]; return p && existsSync(p) ? p : null; };
export const chromiumPath = (): string | null => fromEnv('P6CLONE_CHROMIUM');
export const ffmpegPath = (): string | null => fromEnv('P6CLONE_FFMPEG');

/** The headless browser could not be started or talked to, or could not hold the model: a clean failure for the tool
 *  to report, never a crash. code: what stopped it (the page's own code, e.g. webgl_context_lost, when it said). */
export class RenderFailed extends Error { code?: string; constructor(message: string, code?: string) { super(message); if (code) this.code = code; } }

/** The failures that are the graphics card's or WebGL's (the software renderer may draw what they could not):
 *  webgl_context_lost (the driver reset), gpu_out_of_memory (the card's own memory), gpu_process_crashed (Chromium's
 *  graphics process died) and webgl_unavailable (no WebGL context). Everything else (the machine's memory, the disk,
 *  a stuck browser, a missing tile) would fail in software too, or worse, and is reported, not retried. */
export const GPU_FAILURES = new Set(['webgl_context_lost', 'gpu_out_of_memory', 'gpu_process_crashed', 'webgl_unavailable']);
export const isGpuFailure = (e: unknown): e is RenderFailed => e instanceof RenderFailed && !!e.code && GPU_FAILURES.has(e.code);

/** What the render reports to its watch (inChromium): a unit of progress arrived (done counts frames or tiles), and how
 *  long one unit is expected to take before any has been measured. */
export interface Alive { beat(done: number): void; expect(unitMs: number): void }

const TYPES: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json', '.glb': 'model/gltf-binary', '.txt': 'text/plain; charset=utf-8', '.bin': 'application/octet-stream' };
/** The page's folder over HTTP on the loopback, under a random path (the page fetches its tiles relative to itself,
 *  as it does from the platform's files route; a file:// page cannot fetch). Only files inside the folder are served. */
function serveFolder(dir: string): Promise<{ server: Server; base: string }> {
  const token = randomBytes(12).toString('hex'), root = resolve(dir);
  const server = createServer((req, res) => {
    const u = new URL(req.url ?? '/', 'http://x');
    const parts = u.pathname.split('/').filter(Boolean);
    if (parts.shift() !== token) { res.writeHead(404).end(); return; }
    const file = resolve(root, ...parts.map(decodeURIComponent));
    if (!file.startsWith(root + sep) || !existsSync(file) || !statSync(file).isFile()) { res.writeHead(404).end(); return; }
    res.writeHead(200, { 'content-type': TYPES[file.slice(file.lastIndexOf('.'))] ?? 'application/octet-stream', 'content-length': statSync(file).size, 'cache-control': 'no-store' });
    createReadStream(file).pipe(res);
  });
  return new Promise((ok, fail) => { server.once('error', fail); server.listen(0, '127.0.0.1', () => { const a = server.address(); ok({ server, base: `http://127.0.0.1:${typeof a === 'object' && a ? a.port : 0}/${token}/` }); }); });
}

export type Progress = (done: number, total: number, note: string) => Promise<void>;
type Evaluate = (expression: string, awaitPromise?: boolean) => Promise<unknown>;

/** Load the viewer page headless and run work against it (evaluate expressions in the page). onProgress may throw (a
 *  cancelled job): the browser is closed and the error passes through.
 *  There is no time limit (owner rule 2026-10-27). The render is alive while tiles load and frames arrive (work reports
 *  them through `alive`) or the browser's processes keep using the processor; it is stuck (code render_stuck) after two
 *  windows in a row with neither. A window is 4 times the slowest tile or frame measured (frameMs, the estimate, before
 *  the first one), and never under floorMs: 2 minutes, because a browser start, a garbage collection or a driver stall
 *  on one huge frame can be quiet that long without being stuck. (The processor time is read from outside: /proc on Linux; PowerShell, then wmic,
 *  then tasklist on Windows; ps on macOS; where none works only tiles and frames count.) */
export async function inChromium<T>(chromium: string, page: string, work: (evaluate: Evaluate, alive: Alive) => Promise<T>, o: { width?: number; height?: number; floorMs?: number; frameMs?: number; onLoad?: (loaded: number, total: number) => Promise<void> | void; what?: string; gpu?: boolean } = {}): Promise<T> {
  const profile = mkdtempSync(join(tmpdir(), 'p6c4d-chrome-'));
  const http = await serveFolder(dirname(page));
  // the renderer's heap may grow with the model (a tile at a time); the GPU process (SwiftShader) holds the geometry
  // gpu (a render_4d whose probe found a graphics card): ANGLE's default backend; else SwiftShader, the processor draws
  // (any machine; slow on a big model). A Chromium told to use a graphics card it does not have may hang, not fail
  const gl = o.gpu ? ['--use-angle=default', '--enable-gpu'] : ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'];
  const args = ['--headless=new', '--remote-debugging-pipe', '--no-first-run', '--no-default-browser-check', `--user-data-dir=${profile}`, ...gl, '--ignore-gpu-blocklist', '--js-flags=--max-old-space-size=8192', `--window-size=${o.width ?? 1280},${o.height ?? 760}`, ...(process.getuid?.() === 0 ? ['--no-sandbox'] : []), 'about:blank'];
  // (Chromium refuses to start as root with its sandbox: a server run as root, a container, gets it without)
  let died: Error | null = null;
  const waiting = new Map<number, { res: (v: any) => void; rej: (e: Error) => void }>();
  const failAll = (e: Error) => { died ??= e; for (const w of waiting.values()) w.rej(e); waiting.clear(); };
  const child = spawn(chromium, args, { stdio: ['ignore', 'ignore', 'pipe', 'pipe', 'pipe'], windowsHide: true });
  let stderr = '', gpuCrashed = false;
  child.on('error', (e) => failAll(new RenderFailed(`The Chromium at P6CLONE_CHROMIUM could not be started: ${e.message}`)));
  child.on('exit', (code) => failAll(new RenderFailed(`The Chromium at P6CLONE_CHROMIUM exited (code ${code}) before the render finished.${stderr ? ` ${stderr.trim().slice(-300)}` : ''}`, /No space left on device|ENOSPC/i.test(stderr) ? 'disk_full' : o.gpu && gpuCrashed ? 'gpu_process_crashed' : undefined)));
  // Chromium logs "GPU process exited unexpectedly" / "GPU process isn't usable" when its graphics process dies
  child.stderr?.on('data', (d) => { stderr = (stderr + String(d)).slice(-2000); if (/GPU process (exited unexpectedly|crashed|launch failed|isn't usable)/i.test(stderr)) gpuCrashed = true; });
  const write = child.stdio[3] as NodeJS.WritableStream, read = child.stdio[4] as NodeJS.ReadableStream;
  // a program that is not Chromium closes the pipes at once: those errors end the render, not the server
  write.on('error', (e: Error) => failAll(new RenderFailed(`The Chromium at P6CLONE_CHROMIUM does not speak the DevTools protocol: ${e.message}`)));
  read.on('error', (e: Error) => failAll(new RenderFailed(`The Chromium at P6CLONE_CHROMIUM does not speak the DevTools protocol: ${e.message}`)));
  let buf = Buffer.alloc(0), id = 0, pageSession = '', loaded = ' while loading the viewer';
  read.on('data', (d: Buffer) => {
    buf = Buffer.concat([buf, d]);
    for (let z = buf.indexOf(0); z >= 0; z = buf.indexOf(0)) {
      let msg: any;
      try { msg = JSON.parse(buf.subarray(0, z).toString('utf8')); } catch { failAll(new RenderFailed('The program at P6CLONE_CHROMIUM sent something that is not the DevTools protocol.')); return; } finally { buf = buf.subarray(z + 1); }
      const w = msg.id != null ? waiting.get(msg.id) : undefined;
      if (w) { waiting.delete(msg.id); if (msg.error) w.rej(new Error(msg.error.message)); else w.res(msg.result); }
      // the page's process gone (killed for memory, most often): its calls never answer, so the render ends here
      else if (msg.method === 'Inspector.targetCrashed' || msg.method === 'Target.targetCrashed' || (msg.method === 'Target.detachedFromTarget' && msg.params?.sessionId && msg.params.sessionId === pageSession)) {
        failAll(o.gpu && gpuCrashed
          ? new RenderFailed(`The headless Chromium's graphics process crashed${loaded}${o.what ? ` (${o.what})` : ''}.`, 'gpu_process_crashed')
          : new RenderFailed(`The headless Chromium's page crashed${loaded}${o.what ? ` (${o.what})` : ''}: most often the machine ran out of memory for the browser beside the server.`, 'browser_out_of_memory'));
      }
    }
  });
  const send = (method: string, params: object = {}, sessionId?: string) => new Promise<any>((res, rej) => {
    if (died) return rej(died);
    const i = ++id; waiting.set(i, { res, rej });
    write.write(JSON.stringify({ id: i, method, params, ...(sessionId ? { sessionId } : {}) }) + '\0');
  });
  // liveness, not a time limit (see above)
  let beats = 0, lastDone = -1, lastAt = Date.now(), slowest = 0, expected = o.frameMs ?? 0;
  const alive: Alive = {
    beat(done) { if (done === lastDone) return; const now = Date.now(); if (lastDone >= 0 && done > lastDone) slowest = Math.max(slowest, (now - lastAt) / (done - lastDone)); lastDone = done; lastAt = now; beats++; },
    expect(unitMs) { expected = unitMs; slowest = 0; lastDone = -1; lastAt = Date.now(); },
  };
  const floorMs = o.floorMs ?? 120_000;
  const stopWatch = watchLiveness({ floorMs, windowMs: () => 4 * Math.max(slowest, expected), progress: () => beats, cpu: () => (child.pid ? treeCpuMs(child.pid) : null),
    onStuck: (ms) => failAll(new RenderFailed(`The render stopped making progress${loaded}${o.what ? ` (${o.what})` : ''}: no tile or frame, and no processor time in the browser, for ${Math.round(ms / 60_000 * 10) / 10} minutes (two windows sized from the ${slowest ? 'measured' : 'estimated'} time of one ${loaded.includes('drawing') ? 'frame' : 'tile'}).`, 'render_stuck')) });
  try {
    const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
    pageSession = sessionId;
    await send('Target.setDiscoverTargets', { discover: true });
    await send('Inspector.enable', {}, sessionId);
    await send('Emulation.setDeviceMetricsOverride', { width: o.width ?? 1280, height: o.height ?? 760, deviceScaleFactor: 1, mobile: false }, sessionId);
    await send('Page.enable', {}, sessionId);
    await send('Page.navigate', { url: `${http.base}${encodeURIComponent(basename(page))}` }, sessionId);
    const evaluate: Evaluate = async (expression, awaitPromise = true) => {
      const r = await send('Runtime.evaluate', { expression, awaitPromise, returnByValue: true }, sessionId);
      // what the page threw is the render's failure (the viewer labels its own: "[code] message")
      if (r.exceptionDetails) { const d = String(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text ?? 'The page failed.').split('\n    at ')[0].replace(/^Error: /, ''); const m = /^\[([a-z_]+)\] ([\s\S]*)$/.exec(d); throw new RenderFailed(m ? m[2] : `The 4D viewer failed in the headless Chromium: ${d}`, m?.[1]); }
      return r.result?.value;
    };
    // wait for every tile to be on the GPU (the viewer's status): as long as tiles keep arriving (or the browser works), it
    // waits; a page that could not hold the model says why, and that is the render's error
    let seen = -1, noApi = 0, webglChecked = false;
    for (;;) {
      const st = (await evaluate('window.P6C4D_API ? window.P6C4D_API.status() : null', false)) as { state: string; tiles: { loaded: number; total: number }; error?: { code: string; message: string } } | null;
      if (st?.state === 'ready') break;
      if (st?.state === 'failed') throw new RenderFailed(st.error?.message ?? 'The 4D viewer could not load the model.', st.error?.code);
      const n = st ? st.tiles.loaded : -1;
      if (st && n !== seen) { seen = n; alive.beat(n); loaded = ` after loading ${st.tiles.loaded} of ${st.tiles.total} tiles`; await o.onLoad?.(st.tiles.loaded, st.tiles.total); }
      // a page that never started: no WebGL context at all is the graphics side's failure, and says so
      if (!st && ++noApi === 20 && !webglChecked) {
        webglChecked = true;
        if (!(await evaluate(`(() => { try { return !!(document.createElement('canvas').getContext('webgl2') || document.createElement('canvas').getContext('webgl')); } catch { return false; } })()`, false))) throw new RenderFailed(`WebGL is not available in the headless Chromium (${o.gpu ? 'on the graphics card' : 'in software'}), so the 4D viewer could not start.`, 'webgl_unavailable');
      }
      await new Promise((r2) => setTimeout(r2, 250));
    }
    loaded = ' while drawing frames, with every tile loaded';
    alive.expect(o.frameMs ?? 0);
    return await work(evaluate, alive);
  } finally {
    stopWatch();
    if (!died) try { await Promise.race([send('Browser.close'), new Promise((r) => setTimeout(r, 2000))]); } catch { /* closing */ }
    child.removeAllListeners('exit');
    child.kill();
    await new Promise((r) => setTimeout(r, 300));
    http.server.close();
    try { rmSync(profile, { recursive: true, force: true }); } catch { /* a locked profile file is left to the temp cleaner */ }
  }
}

/** P6CLONE_RENDER_GPU: auto (the default: the graphics card when Chrome finds one, else the processor draws), on, off
 *  (always the processor: SwiftShader). */
export const renderGpu = (): 'auto' | 'on' | 'off' => { const v = process.env.P6CLONE_RENDER_GPU; return v === 'on' || v === 'off' ? v : 'auto'; };
/** The renderer that draws: the graphics card, or software (SwiftShader, Mesa's llvmpipe, Windows' WARP: the processor). */
export interface Renderer { kind: 'gpu' | 'software'; name: string }
const SOFTWARE = /SwiftShader|llvmpipe|softpipe|Basic Render|WARP|Software/i;
/** The page expression naming WebGL's renderer. */
export const RENDERER_JS = `(() => { try { const g = document.createElement('canvas').getContext('webgl2') || document.createElement('canvas').getContext('webgl'); if (!g) return ''; const d = g.getExtension('WEBGL_debug_renderer_info'); return String(d ? g.getParameter(d.UNMASKED_RENDERER_WEBGL) : g.getParameter(g.RENDERER)); } catch { return ''; } })()`;
export const rendererOf = (name: string, gpu: boolean): Renderer => ({ kind: gpu && name && !SOFTWARE.test(name) ? 'gpu' : 'software', name: name || 'none' });
const probes = new Map<string, Promise<{ renderer: Renderer; keep: boolean }>>();
// what the graphics card has failed at in this process (by Chromium): the driver-level failures stop it for good, the
// card running out of memory only for models as big as the one that did it
const gpuDown = new Map<string, string>(), gpuTooBig = new Map<string, number>();
const DRIVER_LEVEL = new Set(['webgl_context_lost', 'gpu_process_crashed', 'webgl_unavailable']);
/** A render on the graphics card failed with a GPU failure: remember it, so the next renders do not repeat the attempt.
 *  Only a GPU failure is remembered (isGpuFailure): the machine's memory, the disk or a stuck browser say nothing about
 *  the card. modelBytes: the size of the model that ran the card out of memory. */
export function noteGpuFailure(chromium: string, e: RenderFailed, modelBytes: number): void {
  if (!isGpuFailure(e)) return;
  if (DRIVER_LEVEL.has(e.code!)) gpuDown.set(chromium, e.code!);
  else gpuTooBig.set(chromium, Math.min(gpuTooBig.get(chromium) ?? Infinity, modelBytes));
}
/** Forget what the probes and failures said (a test; a changed P6CLONE_RENDER_GPU needs nothing: it is in the key). */
export function resetRendererMemory(): void { probes.clear(); gpuDown.clear(); gpuTooBig.clear(); }
/** What renders on this machine (asked once per Chromium and setting): Chromium started as a render starts it, on an
 *  empty page, naming its WebGL renderer. A card that failed before (noteGpuFailure) is reported as software, for any
 *  model the failure applies to (modelBytes: the model about to be drawn). A probe that failed for a reason other than
 *  the graphics side (the browser would not start, nothing answered) says nothing about the card and is not remembered. */
export async function probeRenderer(chromium: string, modelBytes = 0): Promise<Renderer> {
  const gpu = renderGpu() !== 'off', key = `${chromium}|${gpu}`;
  let p = probes.get(key);
  if (!p) {
    p = (async () => {
      if (!gpu) return { renderer: { kind: 'software' as const, name: 'SwiftShader (P6CLONE_RENDER_GPU=off)' }, keep: true };
      // a Linux machine with no graphics device (a server, a container): software, without asking Chromium
      if (process.platform === 'linux' && !existsSync('/dev/dri') && renderGpu() === 'auto') return { renderer: { kind: 'software' as const, name: 'SwiftShader (no graphics device: /dev/dri)' }, keep: true };
      const dir = mkdtempSync(join(tmpdir(), 'p6c4d-probe-')), page = join(dir, 'probe.html');
      writeFileSync(page, '<!doctype html><script>window.P6C4D_API = { status: () => ({ state: "ready", tiles: { loaded: 0, total: 0 } }) };</script>');
      try { return { renderer: rendererOf(String(await inChromium(chromium, page, (ev) => ev(RENDERER_JS), { gpu, floorMs: 10_000, width: 64, height: 64 })), gpu), keep: true }; }
      catch (e) { return { renderer: { kind: 'software' as const, name: `unknown (the probe failed: ${(e as Error).message.slice(0, 120)})` }, keep: isGpuFailure(e) }; }
      finally { rmSync(dir, { recursive: true, force: true }); }
    })();
    probes.set(key, p);
  }
  const r = await p;
  if (!r.keep && probes.get(key) === p) probes.delete(key);
  const down = gpuDown.get(chromium), small = gpuTooBig.get(chromium);
  if (r.renderer.kind === 'gpu' && gpu && down) return { kind: 'software', name: `SwiftShader (the graphics card failed earlier in this server's run: ${down})` };
  if (r.renderer.kind === 'gpu' && gpu && small != null && modelBytes >= small) return { kind: 'software', name: 'SwiftShader (the graphics card ran out of memory earlier on a model this size)' };
  return r.renderer;
}

/** PNG frames at the dates, one page call each, with progress (and cancellation) between frames. */
export async function renderPngs(evaluate: Evaluate, dates: string[], onProgress: Progress, alive?: Alive): Promise<Buffer[]> {
  const out: Buffer[] = [];
  for (const [i, d] of dates.entries()) {
    alive?.beat(i);
    await onProgress(i, dates.length, `frame ${i + 1} of ${dates.length}`);
    const url = String(await evaluate(`window.P6C4D_API.png(${JSON.stringify(d)})`));
    out.push(Buffer.from(url.replace(/^data:image\/png;base64,/, ''), 'base64'));
  }
  return out;
}

/** The video encoded in the page; progress is read from the page every half second while it runs. */
export async function renderVideo(evaluate: Evaluate, o: object, onProgress: Progress, alive?: Alive): Promise<{ mime: string; frames: number; bytes: Buffer }> {
  const run = evaluate(`window.P6C4D_API.encode(${JSON.stringify(o)}).then((r) => { let s = ''; const b = r.bytes; for (let i = 0; i < b.length; i += 32768) s += String.fromCharCode.apply(null, b.subarray(i, i + 32768)); return { mime: r.mime, frames: r.frames, b64: btoa(s) }; })`) as Promise<{ mime: string; frames: number; b64: string }>;
  let finished = false;
  const watch = (async () => {
    while (!finished) {
      await new Promise((r) => setTimeout(r, 500));
      if (finished) return;
      const p = (await evaluate('window.P6C4D_API.progress()', false).catch(() => null)) as { done: number; total: number } | null;
      if (p?.total) { alive?.beat(p.done); await onProgress(p.done, p.total, `frame ${p.done} of ${p.total}`); }
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
