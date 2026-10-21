// The 4D viewer: one page that plays the build sequence of a model linked to the schedule. It runs on the viewer's own
// GPU (the user's browser on the platform, Electron on the desktop); the MCP host has none. Bundled by
// scripts/build-viewer4d.mjs with three.js and mediabunny into one script (viewer4d.js).
//
// Input, set before the script runs: window.P6C4D = { model: url | base64 GLB, timeline (core/bim/sim4d.ts
// viewerTimeline), options }. Element states follow core/bim/sim4d.ts (same rules, same colours as the docs).
// Hooks: window.WHIQ4D_EXPORT (ready, max, setStep, frame: the platform's client render drives these unchanged) and
// window.P6C4D_API (setDate, setSource, highlight, encode: an MP4 made in the page with WebCodecs).
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { BufferTarget, CanvasSource, getFirstEncodableVideoCodec, Mp4OutputFormat, Output, QUALITY_HIGH, WebMOutputFormat } from 'mediabunny';

type Role = 'built' | 'removed' | 'temporary';
type State = 'not_started' | 'in_progress' | 'complete' | 'removed' | 'temporary';
type Cmp = 'ahead' | 'on_time' | 'late' | 'not_started' | 'complete';
interface Activity { id: string; name: string; task: string; elements: number; pct: number; critical: boolean; spans: Record<string, [string | null, string | null]> }
interface Timeline { project: string; name: string; dataDate: string | null; start: string | null; finish: string | null; sources: { name: string; label: string }[]; activities: Activity[]; elements: Record<string, { links: [string, Role][]; x?: number; y?: number; z?: number }>; status: { guid: string; status: string; date: string }[] }
interface Options {
  layout?: 'single' | 'side_by_side'; left?: string; right?: string; compare?: boolean; lateMeans?: 'start' | 'finish';
  step?: number; growth?: 'none' | 'bottom_up' | 'top_down' | 'left_right' | 'right_left';
  overlays?: ('date' | 'legend' | 'activity_list' | 'gantt_strip' | 's_curve')[]; view?: 'iso' | 'top' | 'front' | 'side' | 'orbit';
  interactive?: boolean; title?: string; background?: string;
}
declare global { interface Window { P6C4D: { model: string; timeline: Timeline; options?: Options }; WHIQ4D_EXPORT: unknown; P6C4D_API: unknown } }

const cfg = window.P6C4D;
let tl = cfg.timeline;
const opt: Required<Pick<Options, 'layout' | 'left' | 'step' | 'growth' | 'overlays' | 'view'>> & Options = { layout: 'single', left: 'best', step: 7, growth: 'none', overlays: ['date', 'legend', 'activity_list'], view: 'iso', interactive: true, ...cfg.options };
const DAY = 1440;
const toMin = (s: string | null | undefined) => (s ? Date.parse(`${s.slice(0, 10)}T${s.slice(11, 16) || '00:00'}:00Z`) / 60000 : null);
const iso = (m: number) => new Date(m * 60000).toISOString().slice(0, 10);
let t0 = toMin(tl.start) ?? 0, t1 = toMin(tl.finish) ?? t0 + 30 * DAY;
let dataDate = toMin(tl.dataDate);
let actById = new Map(tl.activities.map((a) => [a.task, a]));

// ── colours: Navisworks task types; comparison: early blue, on time green, late red, not started grey ────────────
const C = { ghost: 0x5a6372, construct: 0x2c9a4a, demolish: 0xd62728, temporary: 0xe8c547, unlinked: 0x8a93a3, ahead: 0x2a6fdb, on_time: 0x2c9a4a, late: 0xd62728, not_started: 0x7a7f87, complete: 0xb8c0cc, highlight: 0xff8c00 };
const mat = (color: number, opacity = 1) => new THREE.MeshLambertMaterial({ color, transparent: opacity < 1, opacity, depthWrite: opacity >= 1 });
const M = {
  not_started: mat(C.ghost, 0.06), unlinked: mat(C.unlinked, 0.18), in_progress: mat(C.construct), demolishing: mat(C.demolish), temporary: mat(C.temporary),
  ahead: mat(C.ahead), on_time: mat(C.on_time), late: mat(C.late), cmp_not_started: mat(C.not_started, 0.12), highlight: mat(C.highlight),
};

// ── states (the rules of core/bim/sim4d.ts) ─────────────────────────────────────────────────────────────────────
const spanFor = (task: string, source: string): [number | null, number | null] => { const s = actById.get(task)?.spans[source]; return [toMin(s?.[0]), toMin(s?.[1])]; };
function stateAt([s, f]: [number | null, number | null], role: Role, at: number): State {
  if (s == null || at < s) return 'not_started';
  const done = f != null && at >= f;
  if (role === 'removed') return done ? 'removed' : 'in_progress';
  if (role === 'temporary') return done ? 'removed' : 'temporary';
  return done ? 'complete' : 'in_progress';
}
// growth within a task: the element's place along the chosen direction among the task's elements (0..1)
const growthRank = new Map<string, number>();
function rankGrowth() {
  growthRank.clear();
  if (opt.growth === 'none') return;
  const byTask = new Map<string, { guid: string; v: number }[]>();
  for (const [guid, e] of Object.entries(tl.elements)) for (const [task] of e.links) { const v = opt.growth === 'left_right' || opt.growth === 'right_left' ? e.x ?? 0 : e.z ?? 0; (byTask.get(task) ?? byTask.set(task, []).get(task)!).push({ guid, v }); }
  for (const [task, l] of byTask) { l.sort((a, b) => (opt.growth === 'top_down' || opt.growth === 'right_left' ? b.v - a.v : a.v - b.v)); l.forEach((x, i) => growthRank.set(`${task}|${x.guid}`, l.length > 1 ? i / l.length : 0)); }
}
rankGrowth();
const statusBy = new Map<string, { status: string; at: number }[]>();
function indexStatus() { statusBy.clear(); for (const s of tl.status) { const at = toMin(s.date); if (at != null) (statusBy.get(s.guid) ?? statusBy.set(s.guid, []).get(s.guid)!).push({ status: s.status, at }); } }
indexStatus();
/** New links or dates (the desktop sends them as the user edits): the same model, a new timeline. */
function setTimeline(next: Timeline) {
  tl = next; t0 = toMin(tl.start) ?? 0; t1 = toMin(tl.finish) ?? t0 + 30 * DAY; dataDate = toMin(tl.dataDate);
  actById = new Map(tl.activities.map((a) => [a.task, a])); rankGrowth(); indexStatus();
  if (slider) slider.max = String(steps());
  render();
}
function elementState(guid: string, source: string, at: number): State | 'unlinked' {
  const e = tl.elements[guid];
  if (!e) return 'unlinked';
  if (source === 'actual' || source === 'best') { let st: string | null = null; for (const x of statusBy.get(guid) ?? []) if (x.at <= at) st = x.status; if (st === 'installed') return 'complete'; if (st === 'in_progress') return 'in_progress'; if (st === 'not_installed') return 'not_started'; }
  const rank: Record<State, number> = { not_started: 0, in_progress: 1, complete: 2, removed: 3, temporary: 1 };
  let built: State = 'not_started';
  for (const [task, role] of e.links) {
    const sp = spanFor(task, source);
    let s = stateAt(sp, role, at);
    // growth: an in-progress element appears when the task has reached its place along the direction
    if (s === 'in_progress' && role === 'built' && opt.growth !== 'none' && sp[0] != null && sp[1] != null) { const share = (at - sp[0]) / Math.max(1, sp[1] - sp[0]); if (share < (growthRank.get(`${task}|${guid}`) ?? 0)) s = 'not_started'; }
    if (role !== 'built' && s !== 'not_started') return s;
    if (rank[s] > rank[built]) built = s;
  }
  return built;
}
function compareState(guid: string, against: string, at: number): Cmp | 'unlinked' {
  if (!tl.elements[guid]) return 'unlinked';
  const r: Record<string, number> = { not_started: 0, in_progress: 1, temporary: 1, complete: 2, removed: 2 };
  const b = r[elementState(guid, against, at)], c = r[elementState(guid, 'best', at)];
  if (!b && !c) return 'not_started';
  if (b === 2 && c === 2) return 'complete';
  if (c > b) return 'ahead';
  if (c < b) return opt.lateMeans === 'finish' && b < 2 ? 'on_time' : 'late';
  return 'on_time';
}

// ── scene ───────────────────────────────────────────────────────────────────────────────────────────────────────
const canvas = document.getElementById('c4d') as HTMLCanvasElement;
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: true });
renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
renderer.setScissorTest(true);
const scene = new THREE.Scene();
const bg = new THREE.Color(opt.background ?? '#eef1f5');
scene.add(new THREE.HemisphereLight(0xffffff, 0x445566, 1.2));
const sun = new THREE.DirectionalLight(0xffffff, 1.1); sun.position.set(1, 2, 1.5); scene.add(sun);
const camera = new THREE.PerspectiveCamera(50, 1, 0.1, 10000);
const meshes: { mesh: THREE.Mesh; guid: string; own: THREE.Material | THREE.Material[] }[] = [];
const byGuid = new Map<string, THREE.Mesh[]>();
const orbit = { target: new THREE.Vector3(), theta: 0.8, phi: 1.05, r: 30 };
const VIEWS: Record<string, [number, number]> = { iso: [0.8, 1.05], top: [0.8, 0.12], front: [Math.PI / 2, Math.PI / 2], side: [0, Math.PI / 2], orbit: [0.8, 1.05] };
function applyOrbit() { const t = orbit.target; camera.position.set(t.x + orbit.r * Math.sin(orbit.phi) * Math.cos(orbit.theta), t.y + orbit.r * Math.cos(orbit.phi), t.z + orbit.r * Math.sin(orbit.phi) * Math.sin(orbit.theta)); camera.lookAt(t); }
let loaded = false;
async function loadModel() {
  let data: ArrayBuffer;
  if (cfg.model.startsWith('data:') || !/[./]/.test(cfg.model.slice(0, 40))) { const b64 = cfg.model.replace(/^data:[^,]*,/, ''); const bin = atob(b64); const u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i); data = u.buffer; }
  else data = await (await fetch(cfg.model)).arrayBuffer();
  const gltf = await new GLTFLoader().parseAsync(data, '');
  gltf.scene.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh) return;
    m.geometry.computeVertexNormals();
    const guid = (m.userData?.guid || m.parent?.userData?.guid || m.parent?.name || m.name) as string;
    meshes.push({ mesh: m, guid, own: mat(0xb8c0cc) });
    (byGuid.get(guid) ?? byGuid.set(guid, []).get(guid)!).push(m);
  });
  scene.add(gltf.scene);
  const box = new THREE.Box3().setFromObject(gltf.scene);
  orbit.target.copy(box.getCenter(new THREE.Vector3()));
  orbit.r = (box.getSize(new THREE.Vector3()).length() || 30) * 1.25;
  [orbit.theta, orbit.phi] = VIEWS[opt.view] ?? VIEWS.iso;
  applyOrbit();
  loaded = true;
}

// ── state colouring per pane ────────────────────────────────────────────────────────────────────────────────────
let current = dataDate ?? t0;
const highlighted = new Set<string>();
const counts = (source: string) => { const c: Record<string, number> = {}; for (const { guid } of meshes) { const s = opt.compare && source !== opt.left ? compareState(guid, opt.left!, current) : elementState(guid, source, current); c[s] = (c[s] ?? 0) + 1; } return c; };
function paint(source: string, asCompare: boolean) {
  for (const { mesh, guid, own } of meshes) {
    if (highlighted.has(guid)) { mesh.visible = true; mesh.material = M.highlight; continue; }
    if (asCompare) {
      const s = compareState(guid, opt.left!, current);
      mesh.visible = true;
      mesh.material = s === 'unlinked' ? M.unlinked : s === 'complete' ? own : s === 'not_started' ? M.cmp_not_started : M[s];
      continue;
    }
    const s = elementState(guid, source, current);
    const role = tl.elements[guid]?.links.find(([task]) => stateAt(spanFor(task, source), 'built', current) !== 'not_started')?.[1];
    mesh.visible = s !== 'removed';
    mesh.material = s === 'unlinked' ? M.unlinked : s === 'not_started' ? M.not_started : s === 'complete' ? own : s === 'temporary' ? M.temporary : role === 'removed' ? M.demolishing : M.in_progress;
  }
}
function panes(): { x: number; w: number; source: string; compare: boolean; label: string }[] {
  const W = canvas.width;
  const lbl = (s: string) => tl.sources.find((x) => x.name === s)?.label ?? s;
  if (opt.layout === 'side_by_side') { const right = opt.right ?? 'best'; return [{ x: 0, w: W / 2, source: opt.left, compare: false, label: lbl(opt.left) }, { x: W / 2, w: W / 2, source: right, compare: !!opt.compare, label: opt.compare ? `${lbl(right)} against ${lbl(opt.left)}` : lbl(right) }]; }
  return [{ x: 0, w: W, source: opt.left, compare: !!opt.compare, label: opt.compare ? `best against ${lbl(opt.left)}` : lbl(opt.left) }];
}
function render() {
  if (!loaded) return;
  if (slider && opt.interactive) slider.value = String(Math.round((current - t0) / (opt.step * DAY)));
  const H = canvas.height;
  for (const p of panes()) {
    paint(p.source, p.compare);
    renderer.setViewport(p.x, 0, p.w, H); renderer.setScissor(p.x, 0, p.w, H);
    camera.aspect = p.w / H; camera.updateProjectionMatrix();
    scene.background = bg;
    renderer.render(scene, camera);
  }
  ui();
}

// ── overlays: drawn on a 2D canvas over the model (the same canvas makes the video frames) ─────────────────────────
const over = document.getElementById('o4d') as HTMLCanvasElement;
const frameCanvas = document.createElement('canvas');
function activeRows() {
  const w0 = current - opt.step * DAY;
  const src = opt.layout === 'side_by_side' ? opt.right ?? 'best' : opt.left;
  return tl.activities.map((a) => { const [s, f] = spanFor(a.task, src); return { a, s, f }; }).filter((x) => x.s != null && x.f != null && x.f >= w0 && x.s <= current)
    .map((x) => ({ ...x, share: Math.min(1, Math.max(0, (current - x.s!) / Math.max(1, x.f! - x.s!))) })).sort((x, y) => x.s! - y.s!);
}
function drawOverlays(g: CanvasRenderingContext2D, W: number, H: number, clear = true) {
  if (clear) g.clearRect(0, 0, W, H);
  const k = Math.max(1, W / 1280), pad = 12 * k;
  g.textBaseline = 'top';
  const box = (x: number, y: number, w: number, h: number) => { g.fillStyle = 'rgba(255,255,255,0.88)'; g.strokeStyle = '#c4cfe0'; g.lineWidth = 1; g.fillRect(x, y, w, h); g.strokeRect(x, y, w, h); };
  const ps = panes();
  for (const p of ps) { g.font = `600 ${13 * k}px Segoe UI, sans-serif`; g.fillStyle = '#1f2a3a'; if (ps.length > 1) g.fillText(p.label, p.x + pad, pad); }
  if (ps.length > 1) { g.strokeStyle = '#8a97ab'; g.beginPath(); g.moveTo(W / 2, 0); g.lineTo(W / 2, H); g.stroke(); }
  if (opt.overlays.includes('date')) {
    const t = `${iso(current)}${dataDate != null && Math.abs(current - dataDate) < DAY ? '  (data date)' : ''}`;
    g.font = `600 ${18 * k}px Segoe UI, sans-serif`; const w = g.measureText(t).width + 2 * pad;
    box(W - w - pad, pad, w, 30 * k); g.fillStyle = '#1f2a3a'; g.fillText(t, W - w, pad + 6 * k);
    if (opt.title) { g.font = `${12 * k}px Segoe UI, sans-serif`; g.fillStyle = '#4a5568'; g.fillText(opt.title, W - w, pad + 34 * k); }
  }
  if (opt.overlays.includes('legend')) {
    const items: [string, number][] = opt.compare ? [['ahead', C.ahead], ['on time', C.on_time], ['late', C.late], ['not started', C.not_started], ['complete', C.complete]] : [['under construction', C.construct], ['complete', C.complete], ['being removed', C.demolish], ['temporary', C.temporary], ['not started', C.ghost]];
    g.font = `${12 * k}px Segoe UI, sans-serif`;
    const w = Math.max(...items.map(([t]) => g.measureText(t).width)) + 34 * k, y0 = ps.length > 1 ? 34 * k : pad;
    box(pad, y0, w, (items.length * 18 + 10) * k);
    items.forEach(([t, c], i) => { g.fillStyle = `#${c.toString(16).padStart(6, '0')}`; g.fillRect(pad + 8 * k, y0 + (8 + i * 18) * k, 12 * k, 12 * k); g.fillStyle = '#1f2a3a'; g.fillText(t, pad + 26 * k, y0 + (6 + i * 18) * k); });
  }
  let bottom = H - pad;
  if (opt.overlays.includes('gantt_strip') || opt.overlays.includes('s_curve')) {
    const h = 70 * k, y = bottom - h, x = pad, w = W - 2 * pad;
    box(x, y, w, h);
    const X = (m: number) => x + 6 * k + ((m - t0) / Math.max(1, t1 - t0)) * (w - 12 * k);
    if (opt.overlays.includes('gantt_strip')) {
      const acts = tl.activities, src = opt.layout === 'side_by_side' ? opt.right ?? 'best' : opt.left, rowH = Math.max(1, (h - 12 * k) / Math.max(1, acts.length));
      acts.forEach((a, i) => { const [s, f] = spanFor(a.task, src); if (s == null || f == null) return; g.fillStyle = f <= current ? '#8a97ab' : '#2c9a4a'; g.fillRect(X(s), y + 6 * k + i * rowH, Math.max(1, X(f) - X(s)), Math.max(1, rowH - 1)); if (a.critical) { g.strokeStyle = '#1f2a3a'; g.lineWidth = Math.max(1, k); g.strokeRect(X(s), y + 6 * k + i * rowH, Math.max(1, X(f) - X(s)), Math.max(1, rowH - 1)); } });
    }
    if (opt.overlays.includes('s_curve')) {
      const total = tl.activities.reduce((n, a) => n + a.elements, 0) || 1;
      const curve = (src: string, color: string) => { g.strokeStyle = color; g.lineWidth = 2 * k; g.beginPath(); for (let i = 0; i <= 60; i++) { const m = t0 + ((t1 - t0) * i) / 60; let v = 0; for (const a of tl.activities) { const [s, f] = spanFor(a.task, src); if (s == null || f == null) continue; v += a.elements * Math.min(1, Math.max(0, (m - s) / Math.max(1, f - s))); } const px = X(m), py = y + h - 6 * k - (v / total) * (h - 12 * k); if (i) g.lineTo(px, py); else g.moveTo(px, py); } g.stroke(); };
      curve(opt.left, '#8a97ab'); if (opt.layout === 'side_by_side' || opt.compare) curve(opt.right ?? 'best', '#2a6fdb');
    }
    g.strokeStyle = '#1f2a3a'; g.lineWidth = 1.5 * k; g.beginPath(); g.moveTo(X(current), y); g.lineTo(X(current), y + h); g.stroke();
    bottom = y - 6 * k;
  }
  if (opt.overlays.includes('activity_list')) {
    const rows = activeRows().slice(0, 10);
    g.font = `${12 * k}px Segoe UI, sans-serif`;
    const w = Math.min(W * 0.5, 560 * k), h = (rows.length + 1) * 18 * k + 12 * k, y = bottom - h;
    box(pad, y, w, h);
    g.fillStyle = '#1f2a3a'; g.font = `600 ${12 * k}px Segoe UI, sans-serif`;
    g.fillText(rows.length ? `Under way in the ${opt.step >= 28 ? 'month' : opt.step >= 7 ? 'week' : 'day'} to ${iso(current)}` : 'No activity under way', pad + 8 * k, y + 6 * k);
    g.font = `${12 * k}px Segoe UI, sans-serif`;
    rows.forEach((r, i) => { const yy = y + (24 + i * 18) * k; g.fillStyle = '#2c9a4a'; g.fillRect(pad + 8 * k, yy + 3 * k, 10 * k, 10 * k); if (r.a.critical) { g.strokeStyle = '#1f2a3a'; g.lineWidth = Math.max(1, 1.5 * k); g.strokeRect(pad + 8 * k, yy + 3 * k, 10 * k, 10 * k); } g.fillStyle = '#1f2a3a'; let n = `${r.a.id}  ${r.a.name}`; while (g.measureText(n).width > w - 120 * k && n.length > 4) n = n.slice(0, -2) + '…'; g.fillText(n, pad + 24 * k, yy); g.fillStyle = '#4a5568'; g.fillText(`${Math.round(r.share * 100)}%  ${r.a.elements} el.`, pad + w - 90 * k, yy); });
  }
}
function ui() { const g = over.getContext('2d'); if (g) drawOverlays(g, over.width, over.height); const c = document.getElementById('counts4d'); if (c) { const k = counts(opt.layout === 'side_by_side' ? opt.right ?? 'best' : opt.left); c.textContent = Object.entries(k).map(([s, n]) => `${s.replace('_', ' ')} ${n}`).join(' · '); } }

/** The composite frame (model + overlays) for the platform's client render and the video. */
function composite(): HTMLCanvasElement {
  const W = canvas.width, H = canvas.height;
  frameCanvas.width = W; frameCanvas.height = H;
  const g = frameCanvas.getContext('2d')!;
  // the model's pixels read from WebGL (drawImage of a WebGL canvas comes out blank under software rendering)
  const gl = renderer.getContext(), px = new Uint8Array(W * H * 4);
  gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, px);
  const img = g.createImageData(W, H), row = W * 4;
  for (let y = 0; y < H; y++) img.data.set(px.subarray((H - 1 - y) * row, (H - y) * row), y * row);
  g.putImageData(img, 0, 0);
  drawOverlays(g, W, H, false);
  return frameCanvas;
}

function resize(w?: number, h?: number) {
  const W = Math.round(w ?? canvas.clientWidth ?? 1280), H = Math.round(h ?? canvas.clientHeight ?? 720);
  renderer.setPixelRatio(w != null ? 1 : Math.min(2, window.devicePixelRatio || 1));
  renderer.setSize(W, H, false);
  over.width = canvas.width; over.height = canvas.height;
  render();
}

// ── interaction (skipped when the page only renders) ─────────────────────────────────────────────────────────────
const slider = document.getElementById('d4d') as HTMLInputElement | null;
const steps = () => Math.max(1, Math.ceil((t1 - t0) / (opt.step * DAY)));
function setStepIndex(i: number) { current = Math.min(t1, t0 + i * opt.step * DAY); if (slider) slider.value = String(i); render(); }
if (opt.interactive) {
  let drag = false, lx = 0, ly = 0, moved = false;
  canvas.addEventListener('pointerdown', (e) => { drag = true; moved = false; lx = e.clientX; ly = e.clientY; });
  window.addEventListener('pointerup', (e) => {
    if (drag && !moved) pick(e);
    drag = false;
  });
  window.addEventListener('pointermove', (e) => { if (!drag) return; if (Math.abs(e.clientX - lx) + Math.abs(e.clientY - ly) > 2) moved = true; orbit.theta += (e.clientX - lx) * 0.006; orbit.phi = Math.min(3, Math.max(0.12, orbit.phi - (e.clientY - ly) * 0.006)); lx = e.clientX; ly = e.clientY; applyOrbit(); render(); });
  canvas.addEventListener('wheel', (e) => { e.preventDefault(); orbit.r = Math.max(1, orbit.r * (e.deltaY > 0 ? 1.1 : 0.9)); applyOrbit(); render(); }, { passive: false });
  window.addEventListener('resize', () => resize());
  if (slider) { slider.max = String(steps()); slider.addEventListener('input', () => setStepIndex(Number(slider.value))); }
  for (const v of Object.keys(VIEWS)) document.getElementById(`v4d-${v}`)?.addEventListener('click', () => { [orbit.theta, orbit.phi] = VIEWS[v]; applyOrbit(); render(); });
  const play = document.getElementById('p4d');
  let timer: ReturnType<typeof setInterval> | null = null;
  play?.addEventListener('click', () => { if (timer) { clearInterval(timer); timer = null; play.textContent = '▶'; return; } play.textContent = '⏸'; let i = Math.round((current - t0) / (opt.step * DAY)); if (i >= steps()) i = 0; timer = setInterval(() => { if (i > steps()) { clearInterval(timer!); timer = null; play.textContent = '▶'; return; } setStepIndex(i++); }, 400); });
  const srcSel = document.getElementById('s4d') as HTMLSelectElement | null;
  if (srcSel) { srcSel.replaceChildren(...tl.sources.map((s) => { const o = document.createElement('option'); o.value = s.name; o.textContent = s.label; return o; })); srcSel.value = opt.left; srcSel.addEventListener('change', () => { opt.left = srcSel.value; render(); }); }
}
const ray = new THREE.Raycaster();
function pick(e: PointerEvent) {
  const r = canvas.getBoundingClientRect(), x = e.clientX - r.left, y = e.clientY - r.top;
  const ps = panes(), cssW = r.width / ps.length, i = Math.min(ps.length - 1, Math.floor(x / cssW));
  ray.setFromCamera(new THREE.Vector2(((x - i * cssW) / cssW) * 2 - 1, -(y / r.height) * 2 + 1), camera);
  const hit = ray.intersectObjects(meshes.filter((m) => m.mesh.visible).map((m) => m.mesh), false)[0];
  const guid = hit ? meshes.find((m) => m.mesh === hit.object)?.guid : undefined;
  window.parent?.postMessage({ type: 'p6c4d:pick', guid: guid ?? null, add: e.ctrlKey || e.shiftKey }, '*');
}
window.addEventListener('message', (e) => {
  const m = e.data as { type?: string; date?: string; guids?: string[]; source?: string; options?: Options; timeline?: Timeline };
  if (m?.type === 'p6c4d:date' && m.date) api.setDate(m.date);
  if (m?.type === 'p6c4d:highlight') api.highlight(m.guids ?? []);
  if (m?.type === 'p6c4d:source' && m.source) api.setSource(m.source);
  if (m?.type === 'p6c4d:options' && m.options) { Object.assign(opt, m.options); rankGrowth(); render(); }
  if (m?.type === 'p6c4d:timeline' && (m as { timeline?: Timeline }).timeline) setTimeline((m as { timeline: Timeline }).timeline);
});

// ── hooks ─────────────────────────────────────────────────────────────────────────────────────────────────────────
// how far a long encode has got (the headless renderer reads it to report progress)
const progress = { done: 0, total: 0 };
const api = {
  ready: () => loaded,
  progress: () => ({ ...progress }),
  setDate: (d: string) => { const m = toMin(d); if (m != null) { current = m; render(); } },
  setSource: (s: string) => { opt.left = s; render(); },
  highlight: (guids: string[]) => { highlighted.clear(); for (const g of guids) highlighted.add(g); render(); },
  /** An MP4 (H.264 when the browser can encode it, else WebM/VP9) of the sweep from..to, a frame per step, made here. */
  encode: async (o: { from?: string; to?: string; step?: number; fps?: number; width?: number; height?: number; codec?: 'avc' | 'vp9' } = {}): Promise<{ bytes: Uint8Array; mime: string; frames: number }> => {
    const w = (o.width ?? 1280) & ~1, h = (o.height ?? 720) & ~1, fps = o.fps ?? 4, step = (o.step ?? opt.step) * DAY;
    resize(w, h);
    const codec = await getFirstEncodableVideoCodec(o.codec === 'vp9' ? ['vp9'] : ['avc', 'vp9'], { width: w, height: h });
    if (!codec) throw new Error('This browser cannot encode H.264 or VP9 video (WebCodecs).');
    const output = new Output({ format: codec === 'avc' ? new Mp4OutputFormat() : new WebMOutputFormat(), target: new BufferTarget() });
    const frame = document.createElement('canvas'); frame.width = w; frame.height = h;
    const src = new CanvasSource(frame, { codec, bitrate: QUALITY_HIGH });
    output.addVideoTrack(src, { frameRate: fps });
    await output.start();
    const a = toMin(o.from ?? null) ?? t0, b = toMin(o.to ?? null) ?? t1;
    let n = 0;
    progress.done = 0; progress.total = Math.floor((b - a) / step + 1e-6) + 1;
    for (let m = a; m <= b + 1e-6; m += step) { current = Math.min(m, b); render(); frame.getContext('2d')!.drawImage(composite(), 0, 0); await src.add(n / fps, 1 / fps); n++; progress.done = n; }
    await output.finalize();
    return { bytes: new Uint8Array((output.target as BufferTarget).buffer!), mime: codec === 'avc' ? 'video/mp4' : 'video/webm', frames: n };
  },
  /** One frame as PNG (data URL) at a date. */
  png: (d?: string) => { if (d) api.setDate(d); render(); return composite().toDataURL('image/png'); },
};
window.P6C4D_API = api;
// the White Hat IQ platform's client render (shared/chat-engine/clientRender4d.ts) drives these, unchanged
window.WHIQ4D_EXPORT = {
  ready: () => loaded,
  max: () => Math.max(1, Math.round((t1 - t0) / DAY)),
  setStep: (days: number) => { opt.step = Math.max(1, Number(days) || 7); },
  frame: (v: number) => { current = Math.min(t1, t0 + Number(v) * DAY); render(); return composite().toDataURL('image/png'); },
};

loadModel().then(() => resize(), (e) => { const el = document.getElementById('counts4d'); if (el) el.textContent = `The model could not be loaded: ${(e as Error).message}`; });
