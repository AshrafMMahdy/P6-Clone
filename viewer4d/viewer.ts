// The 4D viewer: one page that plays the build sequence of a model linked to the schedule. It runs on the viewer's own
// GPU (the user's browser on the platform, Electron on the desktop, a headless Chromium for the server route); the MCP
// host has none. Bundled by scripts/build-viewer4d.mjs with three.js and mediabunny into one script (viewer4d.js).
//
// Input, set before the script runs: window.P6C4D = { model, timeline (core/bim/sim4d.ts viewerTimeline), options }.
// model is the display tiles (core/bim/tiles.ts, docs/4d-tiles-contract.md): { tiles: "model-<hash>/manifest.json" }
// (fetched relative to the page, one tile after another, the page's own query string carried along) or { inline:
// { manifest, tiles: [base64 GLB...], guids } } (a self-contained page of a small model); { boxes: ... } draws each
// element as its bounding box, only when the caller asked for that. The full geometry is drawn: nothing stands in for
// a tile, and a browser that cannot hold the model fails with a labelled error naming its size.
// Element states follow core/bim/sim4d.ts (same rules, same colours as the docs). Every element's look is one texel of a
// state texture the shaders read by the element's ordinal, so a frame of millions of elements repaints in milliseconds.
// Hooks: window.WHIQ4D_EXPORT (started, status, ready, max, setStep, frame: the platform's client render) and
// window.P6C4D_API (ready, status, setDate, setSource, highlight, encode: an MP4 made in the page with WebCodecs, png).
// Signals to the parent window (the platform): whiq4d:started at once, whiq4d:progress per tile, whiq4d:ready,
// whiq4d:error.
import * as THREE from 'three';
import { BufferTarget, CanvasSource, getFirstEncodableVideoCodec, Mp4OutputFormat, Output, QUALITY_HIGH, WebMOutputFormat } from 'mediabunny';

type Role = 'built' | 'removed' | 'temporary';
type State = 'not_started' | 'in_progress' | 'complete' | 'removed' | 'temporary';
type Cmp = 'ahead' | 'on_time' | 'late' | 'not_started' | 'complete';
interface Activity { id: string; name: string; task: string; elements: number; pct: number; critical: boolean; spans: Record<string, [string | null, string | null]> }
/** Per element ordinal (its place in the model index): the link group it belongs to (0 = unlinked, else group + 1). */
interface Links { count: number; groups: [string, Role][][]; of: string }
interface Timeline { project: string; name: string; dataDate: string | null; start: string | null; finish: string | null; sources: { name: string; label: string }[]; activities: Activity[]; elements: Links; status: { e: number; status: string; date: string }[] }
interface Options {
  layout?: 'single' | 'side_by_side'; left?: string; right?: string; compare?: boolean; lateMeans?: 'start' | 'finish';
  step?: number; growth?: 'none' | 'bottom_up' | 'top_down' | 'left_right' | 'right_left';
  overlays?: ('date' | 'legend' | 'activity_list' | 'gantt_strip' | 's_curve')[]; view?: 'iso' | 'top' | 'front' | 'side' | 'orbit';
  interactive?: boolean; title?: string; background?: string;
}
interface TileRec { file: string; bytes: number; elements: number; vertices: number; triangles: number; instances: number; bbox: number[] }
interface Manifest { format: string; version: number; elements: number; meshed: number; scale: number; bbox: number[]; bytes: number; vertices: number; triangles: number; instances: number; tiles: TileRec[]; guids: string }
type ModelSrc = { tiles: string } | { inline: { manifest: Manifest; tiles: string[]; guids?: string } } | { boxes: { manifest: Manifest; url?: string; inline?: string } };
interface Status { state: 'loading' | 'ready' | 'failed'; tiles: { loaded: number; total: number }; bytes: { loaded: number; total: number }; elements: number; error?: { code: string; message: string } }
declare global { interface Window { P6C4D: { model: ModelSrc; timeline: Timeline; options?: Options }; WHIQ4D_EXPORT: unknown; P6C4D_API: unknown } }

const cfg = window.P6C4D;
let tl = cfg.timeline;
const opt: Required<Pick<Options, 'layout' | 'left' | 'step' | 'growth' | 'overlays' | 'view'>> & Options = { layout: 'single', left: 'best', step: 7, growth: 'none', overlays: ['date', 'legend', 'activity_list'], view: 'iso', interactive: true, ...cfg.options };
const DAY = 1440;
const toMin = (s: string | null | undefined) => (s ? Date.parse(`${s.slice(0, 10)}T${s.slice(11, 16) || '00:00'}:00Z`) / 60000 : null);
const iso = (m: number) => new Date(m * 60000).toISOString().slice(0, 10);
let t0 = toMin(tl.start) ?? 0, t1 = toMin(tl.finish) ?? t0 + 30 * DAY;
let dataDate = toMin(tl.dataDate);
let actById = new Map(tl.activities.map((a) => [a.task, a]));
const MB = (n: number) => `${Math.round(n / 1048576).toLocaleString('en')} MB`;

// ── the load status, and the signals the platform waits for ──────────────────────────────────────────────────────
const manifestOf = (): Manifest | null => ('inline' in cfg.model ? cfg.model.inline.manifest : 'boxes' in cfg.model ? cfg.model.boxes.manifest : null);
const status: Status = { state: 'loading', tiles: { loaded: 0, total: manifestOf()?.tiles.length ?? 0 }, bytes: { loaded: 0, total: manifestOf()?.bytes ?? 0 }, elements: manifestOf()?.elements ?? tl.elements.count };
const tell = (type: string, extra: object = {}) => { try { window.parent?.postMessage({ type, ...extra, status: JSON.parse(JSON.stringify(status)) }, '*'); } catch { /* no parent */ } };
tell('whiq4d:started', { version: 1 });

// ── colours: Navisworks task types; comparison: early blue, on time green, late red, not started grey ────────────
const C = { ghost: 0x5a6372, construct: 0x2c9a4a, demolish: 0xd62728, temporary: 0xe8c547, unlinked: 0x8a93a3, ahead: 0x2a6fdb, on_time: 0x2c9a4a, late: 0xd62728, not_started: 0x7a7f87, complete: 0xb8c0cc, highlight: 0xff8c00 };
/** A look: colour and opacity (0 = not drawn, below 0.5 = drawn see-through). */
type Look = [number, number];
const L: Record<string, Look> = {
  not_started: [C.ghost, 0.06], unlinked: [C.unlinked, 0.18], in_progress: [C.construct, 1], demolishing: [C.demolish, 1], temporary: [C.temporary, 1], complete: [C.complete, 1], removed: [C.complete, 0],
  ahead: [C.ahead, 1], on_time: [C.on_time, 1], late: [C.late, 1], cmp_not_started: [C.not_started, 0.12], highlight: [C.highlight, 1],
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
const b64 = (s: string) => { const bin = atob(s); const u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i); return u; };
let groupOf = new Uint32Array(0);
const statusBy = new Map<number, { status: string; at: number }[]>();
function indexLinks() {
  const u = b64(tl.elements.of || '');
  groupOf = u.length ? new Uint32Array(u.buffer, 0, u.length / 4) : new Uint32Array(tl.elements.count);
  statusBy.clear();
  for (const s of tl.status) { const at = toMin(s.date); if (at != null) (statusBy.get(s.e) ?? statusBy.set(s.e, []).get(s.e)!).push({ status: s.status, at }); }
}
indexLinks();
// growth within a task: the element's place along the chosen direction among the task's elements (0..1)
const growthRank = new Map<string, Float32Array>(); // task -> rank by ordinal (NaN: not the task's)
function rankGrowth() {
  growthRank.clear();
  if (opt.growth === 'none' || !centroids) return;
  const axis = opt.growth === 'left_right' || opt.growth === 'right_left' ? 0 : 1, desc = opt.growth === 'top_down' || opt.growth === 'right_left';
  const byTask = new Map<string, number[]>();
  for (let o = 0; o < groupOf.length; o++) { const g = groupOf[o]; if (!g) continue; for (const [task] of tl.elements.groups[g - 1]) (byTask.get(task) ?? byTask.set(task, []).get(task)!).push(o); }
  for (const [task, list] of byTask) {
    const v = (o: number) => centroids![o * 3 + axis];
    list.sort((a, b) => (desc ? v(b) - v(a) : v(a) - v(b)));
    const r = new Float32Array(groupOf.length).fill(Number.NaN);
    list.forEach((o, i) => { r[o] = list.length > 1 ? i / list.length : 0; });
    growthRank.set(task, r);
  }
}
/** New links or dates (the desktop sends them as the user edits): the same model, a new timeline. */
function setTimeline(next: Timeline) {
  tl = next; t0 = toMin(tl.start) ?? 0; t1 = toMin(tl.finish) ?? t0 + 30 * DAY; dataDate = toMin(tl.dataDate);
  actById = new Map(tl.activities.map((a) => [a.task, a])); indexLinks(); rankGrowth();
  if (slider) slider.max = String(steps());
  render();
}
const RANK: Record<State, number> = { not_started: 0, in_progress: 1, complete: 2, removed: 3, temporary: 1 };
/** An element's state from its links (o: its ordinal, for site status and growth; -1: the group's own state). */
function linkState(links: [string, Role][], source: string, at: number, o: number): State {
  if (o >= 0 && (source === 'actual' || source === 'best')) { let st: string | null = null; for (const x of statusBy.get(o) ?? []) if (x.at <= at) st = x.status; if (st === 'installed') return 'complete'; if (st === 'in_progress') return 'in_progress'; if (st === 'not_installed') return 'not_started'; }
  let built: State = 'not_started';
  for (const [task, role] of links) {
    const sp = spanFor(task, source);
    let s = stateAt(sp, role, at);
    // growth: an in-progress element appears when the task has reached its place along the direction
    if (o >= 0 && s === 'in_progress' && role === 'built' && opt.growth !== 'none' && sp[0] != null && sp[1] != null) { const share = (at - sp[0]) / Math.max(1, sp[1] - sp[0]); const r = growthRank.get(task)?.[o]; if (r != null && !Number.isNaN(r) && share < r) s = 'not_started'; }
    if (role !== 'built' && s !== 'not_started') return s;
    if (RANK[s] > RANK[built]) built = s;
  }
  return built;
}
function lookOf(links: [string, Role][], source: string, at: number, o: number): [Look, State] {
  const s = linkState(links, source, at, o);
  const role = links.find(([task]) => stateAt(spanFor(task, source), 'built', at) !== 'not_started')?.[1];
  return [s === 'not_started' ? L.not_started : s === 'complete' ? L.complete : s === 'temporary' ? L.temporary : s === 'removed' ? L.removed : role === 'removed' ? L.demolishing : L.in_progress, s];
}
function compareLook(links: [string, Role][], against: string, at: number, o: number): [Look, Cmp] {
  const r: Record<string, number> = { not_started: 0, in_progress: 1, temporary: 1, complete: 2, removed: 2 };
  const b = r[linkState(links, against, at, -1)], c = r[linkState(links, 'best', at, o)];
  const k: Cmp = !b && !c ? 'not_started' : b === 2 && c === 2 ? 'complete' : c > b ? 'ahead' : c < b ? (opt.lateMeans === 'finish' && b < 2 ? 'on_time' : 'late') : 'on_time';
  return [k === 'complete' ? L.complete : k === 'not_started' ? L.cmp_not_started : L[k], k];
}

// ── scene ───────────────────────────────────────────────────────────────────────────────────────────────────────
const canvas = document.getElementById('c4d') as HTMLCanvasElement;
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: true });
renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
renderer.setScissorTest(true);
const gl = renderer.getContext() as WebGL2RenderingContext;
const scene = new THREE.Scene();
const bg = new THREE.Color(opt.background ?? '#eef1f5');
scene.add(new THREE.HemisphereLight(0xffffff, 0x445566, 1.2));
const sun = new THREE.DirectionalLight(0xffffff, 1.1); sun.position.set(1, 2, 1.5); scene.add(sun);
const camera = new THREE.PerspectiveCamera(50, 1, 0.1, 10000);
const root = new THREE.Group(); scene.add(root);

// the state texture: one RGBA texel per element ordinal (sized once the manifest says how many elements there are)
const TW = 4096;
let N = 1, stateData = new Uint8Array(TW * 4), stateTex = new THREE.DataTexture(stateData, TW, 1, THREE.RGBAFormat, THREE.UnsignedByteType);
const uniforms = { p6State: { value: stateTex }, p6W: { value: TW } };
function sizeState(n: number) {
  N = Math.max(1, n); const TH = Math.max(1, Math.ceil(N / TW));
  stateData = new Uint8Array(TW * TH * 4);
  stateTex.dispose();
  stateTex = new THREE.DataTexture(stateData, TW, TH, THREE.RGBAFormat, THREE.UnsignedByteType);
  stateTex.magFilter = THREE.NearestFilter; stateTex.minFilter = THREE.NearestFilter; stateTex.generateMipmaps = false; stateTex.needsUpdate = true;
  uniforms.p6State.value = stateTex;
}
const material = (ghost: boolean) => {
  const m = new THREE.MeshLambertMaterial({ flatShading: true, transparent: ghost, depthWrite: !ghost });
  if (ghost) m.defines = { P6_GHOST: '' };
  m.onBeforeCompile = (sh) => {
    sh.uniforms.p6State = uniforms.p6State; sh.uniforms.p6W = uniforms.p6W;
    sh.vertexShader = 'attribute uint p6Ordinal;\nuniform sampler2D p6State;\nuniform int p6W;\nflat varying vec4 p6Look;\n' + sh.vertexShader.replace('#include <begin_vertex>', '#include <begin_vertex>\n  p6Look = texelFetch(p6State, ivec2(int(p6Ordinal % uint(p6W)), int(p6Ordinal / uint(p6W))), 0);');
    sh.fragmentShader = 'flat varying vec4 p6Look;\n' + sh.fragmentShader.replace('#include <color_fragment>', `#include <color_fragment>
  diffuseColor = vec4(p6Look.rgb, p6Look.a);
#ifdef P6_GHOST
  if (p6Look.a >= 0.5 || p6Look.a < 0.01) discard;
#else
  if (p6Look.a < 0.5) discard;
  diffuseColor.a = 1.0;
#endif`);
  };
  m.customProgramCacheKey = () => (ghost ? 'p6-ghost' : 'p6-solid');
  return m;
};
const SOLID = material(false), GHOST = material(true);
const HIDDEN = new THREE.MeshBasicMaterial({ visible: false });
/** What can be picked: a batch (per-vertex ordinals) or instances (per-instance ordinals). */
const pickables: { mesh: THREE.Mesh; ordinals: Uint32Array; perVertex: boolean }[] = [];
let centroids: Float32Array | null = null; // per ordinal, metres, for growth
/** Every mesh with the elements it draws: a mesh none of whose elements is opaque (or see-through) skips that pass. */
const draws: { solid: THREE.Mesh; ghost: THREE.Mesh; elements: Uint32Array }[] = [];
const uniqueOrdinals = (ranges: Uint32Array) => { const out = new Uint32Array(ranges.length / 3); for (let k = 0; k < out.length; k++) out[k] = ranges[k * 3]; return out; };
/** After a paint: draw a mesh's solid pass only if one of its elements is opaque, its see-through pass only if one is. */
function cull() {
  for (const d of draws) {
    let solid = false, ghost = false;
    for (let k = 0; k < d.elements.length && !(solid && ghost); k++) { const a = stateData[d.elements[k] * 4 + 3]; if (a >= 128) solid = true; else if (a > 2) ghost = true; }
    // the solid mesh carries the see-through one as its child: hiding it would hide both, so its material goes instead
    d.solid.material = solid ? SOLID : HIDDEN;
    d.ghost.visible = ghost;
  }
}
let centroidN: Uint32Array | null = null;
let guids: string[] | null = null, guidIndex: Map<string, number> | null = null;

const orbit = { target: new THREE.Vector3(), theta: 0.8, phi: 1.05, r: 30 };
const VIEWS: Record<string, [number, number]> = { iso: [0.8, 1.05], top: [0.8, 0.12], front: [Math.PI / 2, Math.PI / 2], side: [0, Math.PI / 2], orbit: [0.8, 1.05] };
function applyOrbit() { const t = orbit.target; camera.position.set(t.x + orbit.r * Math.sin(orbit.phi) * Math.cos(orbit.theta), t.y + orbit.r * Math.cos(orbit.phi), t.z + orbit.r * Math.sin(orbit.phi) * Math.sin(orbit.theta)); camera.lookAt(t); camera.near = Math.max(0.01, orbit.r / 2000); camera.far = Math.max(1000, orbit.r * 20); camera.updateProjectionMatrix(); }
function fit(bbox: number[]) {
  const lo = new THREE.Vector3(bbox[0], bbox[1], bbox[2]), hi = new THREE.Vector3(bbox[3], bbox[4], bbox[5]);
  orbit.target.copy(lo.clone().add(hi).multiplyScalar(0.5));
  orbit.r = (hi.clone().sub(lo).length() || 30) * 1.25;
  [orbit.theta, orbit.phi] = VIEWS[opt.view] ?? VIEWS.iso;
  applyOrbit();
}

// ── the model: tiles, one after another, each uploaded to the GPU before the next is fetched ────────────────────────
class LoadFailed extends Error { code: string; constructor(code: string, message: string) { super(message); this.code = code; } }
const describe = (m: Manifest) => `${MB(m.bytes)} of geometry in ${m.tiles.length} tile${m.tiles.length === 1 ? '' : 's'} (${m.elements.toLocaleString('en')} elements, ${Math.round(m.triangles).toLocaleString('en')} triangles)`;
let lost = false;
canvas.addEventListener('webglcontextlost', (e) => { e.preventDefault(); lost = true; if (status.state !== 'failed') failWith(new LoadFailed('webgl_context_lost', `The browser lost its WebGL context${manifest ? ` holding the 4D model, ${describe(manifest)}` : ''}, after ${status.tiles.loaded} of ${status.tiles.total} tiles (${MB(status.bytes.loaded)}): it could not hold the model on this GPU.`)); }, false);
let manifest: Manifest | null = manifestOf();
const relUrl = (rel: string) => { const u = new URL(rel, location.href); u.search = location.search; return u.href; };
async function fetchBytes(url: string): Promise<ArrayBuffer> {
  const r = await fetch(url);
  if (!r.ok) throw new LoadFailed('tile_missing', `${url.split('?')[0].split('/').slice(-2).join('/')} could not be fetched (HTTP ${r.status}).`);
  return r.arrayBuffer();
}
function parseGlb(buf: ArrayBuffer): { json: any; bin: ArrayBuffer; binAt: number } {
  const dv = new DataView(buf);
  if (dv.getUint32(0, true) !== 0x46546c67) throw new LoadFailed('bad_tile', 'A tile is not a GLB file.');
  const jl = dv.getUint32(12, true);
  const json = JSON.parse(new TextDecoder().decode(new Uint8Array(buf, 20, jl)));
  return { json, bin: buf, binAt: 20 + jl + 8 };
}
const SIZES: Record<string, number> = { SCALAR: 1, VEC3: 3, VEC4: 4 };
function addTile(buf: ArrayBuffer) {
  const { json, bin, binAt } = parseGlb(buf);
  const view = (i: number) => json.bufferViews[i];
  const acc = (i: number) => { const a = json.accessors[i], v = view(a.bufferView), n = a.count * SIZES[a.type]; return a.componentType === 5125 ? new Uint32Array(bin, binAt + v.byteOffset, n) : new Float32Array(bin, binAt + v.byteOffset, n); };
  const u32 = (i: number) => { const v = view(i); return new Uint32Array(bin, binAt + v.byteOffset, v.byteLength / 4); };
  const group = new THREE.Group();
  const keep = opt.interactive !== false;
  for (const node of json.nodes) {
    const p6 = node.extras?.p6c;
    const prim = json.meshes[node.mesh].primitives[0];
    const pos = acc(prim.attributes.POSITION) as Float32Array, idx = acc(prim.indices) as Uint32Array;
    const [ox, oy, oz] = node.translation ?? [0, 0, 0];
    const g = new THREE.BufferGeometry();
    const pa = new THREE.BufferAttribute(pos, 3), ia = new THREE.BufferAttribute(idx, 1);
    g.setAttribute('position', pa); g.setIndex(ia);
    g.computeBoundingSphere(); g.computeBoundingBox();
    let mesh: THREE.Mesh, ordinals: Uint32Array;
    if (p6?.kind === 'instances') {
      ordinals = u32(p6.ordinals).slice(); // a copy: a view would keep the whole tile alive
      const ext = node.extensions.EXT_mesh_gpu_instancing.attributes;
      const T = acc(ext.TRANSLATION) as Float32Array, Q = acc(ext.ROTATION) as Float32Array, S = acc(ext.SCALE) as Float32Array;
      const im = new THREE.InstancedMesh(g, SOLID, ordinals.length);
      const mtx = new THREE.Matrix4(), q = new THREE.Quaternion(), t = new THREE.Vector3(), s = new THREE.Vector3(), c = new THREE.Vector3();
      const lc = g.boundingBox!.getCenter(new THREE.Vector3());
      for (let k = 0; k < ordinals.length; k++) {
        t.set(T[k * 3], T[k * 3 + 1], T[k * 3 + 2]); q.set(Q[k * 4], Q[k * 4 + 1], Q[k * 4 + 2], Q[k * 4 + 3]); s.set(S[k * 3], S[k * 3 + 1], S[k * 3 + 2]);
        mtx.compose(t, q, s); im.setMatrixAt(k, mtx);
        c.copy(lc).applyMatrix4(mtx); addCentroid(ordinals[k], c.x + ox, c.y + oy, c.z + oz, 1);
      }
      g.setAttribute('p6Ordinal', new THREE.InstancedBufferAttribute(ordinals, 1));
      im.computeBoundingSphere();
      const ghost = new THREE.InstancedMesh(g, GHOST, ordinals.length); ghost.instanceMatrix = im.instanceMatrix; ghost.boundingSphere = im.boundingSphere; ghost.renderOrder = 1; ghost.raycast = () => {};
      im.add(ghost); mesh = im;
      if (!keep) for (const a of [pa, ia]) a.onUpload(function (this: { array: unknown }) { this.array = null as never; });
    } else {
      const ranges = u32(p6.ranges);
      ordinals = new Uint32Array(pos.length / 3);
      for (let k = 0; k < ranges.length; k += 3) {
        const o = ranges[k], v0 = ranges[k + 1], vn = ranges[k + 2];
        ordinals.fill(o, v0, v0 + vn);
        let sx = 0, sy = 0, sz = 0; for (let v = v0; v < v0 + vn; v++) { sx += pos[v * 3]; sy += pos[v * 3 + 1]; sz += pos[v * 3 + 2]; }
        addCentroid(o, sx + ox * vn, sy + oy * vn, sz + oz * vn, vn);
      }
      const oa = new THREE.BufferAttribute(ordinals, 1);
      g.setAttribute('p6Ordinal', oa);
      mesh = new THREE.Mesh(g, SOLID);
      const ghost = new THREE.Mesh(g, GHOST); ghost.renderOrder = 1; ghost.raycast = () => {};
      mesh.add(ghost);
      draws.push({ solid: mesh, ghost, elements: uniqueOrdinals(ranges) });
      // a page that only renders lets the arrays go once they are on the GPU (the GPU copy is all it draws from)
      if (!keep) for (const a of [pa, ia, oa]) a.onUpload(function (this: { array: unknown }) { this.array = null as never; });
    }
    if (p6?.kind === 'instances') draws.push({ solid: mesh, ghost: mesh.children[0] as THREE.Mesh, elements: Uint32Array.from(new Set(ordinals)) });
    mesh.position.set(ox, oy, oz);
    group.add(mesh);
    if (keep) pickables.push({ mesh, ordinals, perVertex: p6?.kind !== 'instances' });
  }
  root.add(group);
  return group;
}
function addCentroid(o: number, sx: number, sy: number, sz: number, n: number) {
  if (!centroids || o >= centroidN!.length) return;
  const k = o * 3, m = centroidN![o];
  // a running mean over the element's vertices (several meshes, several tiles)
  centroids[k] = (centroids[k] * m + sx) / (m + n); centroids[k + 1] = (centroids[k + 1] * m + sy) / (m + n); centroids[k + 2] = (centroids[k + 2] * m + sz) / (m + n);
  centroidN![o] = m + n;
}
/** Put a tile's buffers on the GPU now (a scene of only that tile, drawn into one pixel), so a GPU that cannot hold
 *  the model says so while it loads, not mid-video. */
function upload(group: THREE.Object3D) {
  const s = new THREE.Scene(); const parent = group.parent; s.add(group);
  renderer.setViewport(0, 0, 1, 1); renderer.setScissor(0, 0, 1, 1);
  renderer.render(s, camera);
  parent?.add(group);
  const err = gl.getError();
  if (err === gl.OUT_OF_MEMORY) throw new LoadFailed('gpu_out_of_memory', 'out of GPU memory');
  if (lost || gl.isContextLost()) throw new LoadFailed('webgl_context_lost', 'the WebGL context was lost');
}
/** Boxes, only when the caller asked: each element's bounding box (per ordinal: min x, y, z, max x, y, z, metres). */
function addBoxes(boxes: Float32Array) {
  const n = boxes.length / 6;
  const g = new THREE.BoxGeometry(1, 1, 1);
  const list: number[] = [];
  for (let o = 0; o < n; o++) if (!Number.isNaN(boxes[o * 6])) list.push(o);
  const ordinals = Uint32Array.from(list);
  const im = new THREE.InstancedMesh(g, SOLID, ordinals.length), mtx = new THREE.Matrix4();
  ordinals.forEach((o, k) => { const b = boxes.subarray(o * 6, o * 6 + 6); mtx.makeScale(Math.max(1e-3, b[3] - b[0]), Math.max(1e-3, b[4] - b[1]), Math.max(1e-3, b[5] - b[2])).setPosition((b[0] + b[3]) / 2, (b[1] + b[4]) / 2, (b[2] + b[5]) / 2); im.setMatrixAt(k, mtx); addCentroid(o, (b[0] + b[3]) / 2, (b[1] + b[4]) / 2, (b[2] + b[5]) / 2, 1); });
  g.setAttribute('p6Ordinal', new THREE.InstancedBufferAttribute(ordinals, 1));
  im.computeBoundingSphere();
  const ghost = new THREE.InstancedMesh(g, GHOST, ordinals.length); ghost.instanceMatrix = im.instanceMatrix; ghost.boundingSphere = im.boundingSphere; ghost.renderOrder = 1; ghost.raycast = () => {};
  im.add(ghost); scene.add(im);
  pickables.push({ mesh: im, ordinals, perVertex: false });
}

let loaded = false;
let failure: LoadFailed | null = null;
let resolveLoad!: () => void, rejectLoad!: (e: Error) => void;
const loading = new Promise<void>((res, rej) => { resolveLoad = res; rejectLoad = rej; });
loading.catch(() => { /* reported by status() and the hooks */ });
function failWith(e: LoadFailed) {
  failure = e; status.state = 'failed'; status.error = { code: e.code, message: e.message };
  const el = document.getElementById('counts4d'); if (el) el.textContent = e.message;
  tell('whiq4d:error', { code: e.code, message: e.message });
  rejectLoad(e);
}
async function loadModel() {
  const src = cfg.model;
  if ('tiles' in src) manifest = JSON.parse(new TextDecoder().decode(await fetchBytes(relUrl(src.tiles)))) as Manifest;
  const m = manifest!;
  status.tiles.total = m.tiles.length; status.bytes.total = m.bytes; status.elements = m.elements;
  sizeState(m.elements);
  centroids = new Float32Array(m.elements * 3); centroidN = new Uint32Array(m.elements);
  root.scale.setScalar(m.scale || 1);
  fit(m.bbox);
  tell('whiq4d:progress');
  if ('boxes' in src) {
    const bytes = src.boxes.inline ? b64(src.boxes.inline).buffer : await fetchBytes(relUrl(src.boxes.url!));
    addBoxes(new Float32Array(bytes));
  } else {
    for (const [k, t] of m.tiles.entries()) {
      let group: THREE.Object3D;
      try {
        const buf = 'inline' in src ? b64(src.inline.tiles[k]).buffer : await fetchBytes(relUrl(`${(src as { tiles: string }).tiles.replace(/[^/]*$/, '')}${t.file}`));
        group = addTile(buf);
        upload(group);
      } catch (e) {
        if (e instanceof LoadFailed && (e.code === 'tile_missing' || e.code === 'bad_tile')) throw e;
        const what = e instanceof LoadFailed ? e.message : e instanceof RangeError ? `out of memory (${e.message})` : (e as Error).message;
        throw new LoadFailed(e instanceof LoadFailed ? e.code : 'browser_out_of_memory', `The browser could not hold the 4D model, ${describe(m)}: ${what} at tile ${k + 1} of ${m.tiles.length}, with ${MB(status.bytes.loaded)} loaded. Render it where there is more GPU memory, or ask for boxes (each element drawn as its bounding box).`);
      }
      status.tiles.loaded = k + 1; status.bytes.loaded += t.bytes;
      tell('whiq4d:progress');
    }
  }
  if (opt.interactive !== false) await loadGuids();
  rankGrowth();
  loaded = true;
  resize(); // sized and drawn before anyone is told it is ready (a frame asked for at once is the full size)
  status.state = 'ready';
  tell('whiq4d:ready');
  resolveLoad();
}
/** GlobalIds by ordinal (picking and highlighting): inline, or elements.txt beside the manifest. */
async function loadGuids() {
  const src = cfg.model;
  try {
    const text = 'inline' in src ? src.inline.guids ?? '' : 'tiles' in src ? new TextDecoder().decode(await fetchBytes(relUrl(`${src.tiles.replace(/[^/]*$/, '')}${manifest!.guids || 'elements.txt'}`))) : '';
    guids = text.split('\n'); guidIndex = null;
  } catch { guids = null; }
}
const ordinalOfGuid = (g: string) => { if (!guids) return -1; if (!guidIndex) { guidIndex = new Map(); guids.forEach((x, i) => guidIndex!.set(x, i)); } return guidIndex.get(g) ?? -1; };

// ── state painting per pane: every element's look into the state texture ────────────────────────────────────────
let current = dataDate ?? t0;
const highlighted = new Set<number>();
let lastCounts: Record<string, number> = {};
function paint(source: string, asCompare: boolean) {
  const groups = tl.elements.groups;
  // a group's look, once (elements with site status, growth or a highlight get their own)
  const gl8 = groups.map((links) => (asCompare ? compareLook(links, opt.left!, current, -1) : lookOf(links, source, current, -1)));
  const special = (o: number, g: number) => highlighted.has(o) || (g > 0 && (statusBy.has(o) || (opt.growth !== 'none' && growthRank.size > 0)));
  const counts: Record<string, number> = {};
  const put = (o: number, [c, a]: Look) => { const k = o * 4; stateData[k] = (c >> 16) & 255; stateData[k + 1] = (c >> 8) & 255; stateData[k + 2] = c & 255; stateData[k + 3] = Math.round(a * 255); };
  const n = Math.min(N, groupOf.length || N);
  for (let o = 0; o < n; o++) {
    const g = groupOf[o] ?? 0;
    let look: Look, s: string;
    if (!g) { look = L.unlinked; s = 'unlinked'; }
    else if (special(o, g)) { const links = groups[g - 1]; [look, s] = asCompare ? compareLook(links, opt.left!, current, o) : lookOf(links, source, current, o); }
    else [look, s] = gl8[g - 1];
    counts[s] = (counts[s] ?? 0) + 1;
    put(o, highlighted.has(o) ? L.highlight : look);
  }
  stateTex.needsUpdate = true;
  cull();
  return counts;
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
    lastCounts = paint(p.source, p.compare);
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
function ui() { const g = over.getContext('2d'); if (g) drawOverlays(g, over.width, over.height); const c = document.getElementById('counts4d'); if (c) c.textContent = Object.entries(lastCounts).map(([s, n]) => `${s.replace('_', ' ')} ${n.toLocaleString('en')}`).join(' · '); }

/** The composite frame (model + overlays) for the platform's client render and the video. */
function composite(): HTMLCanvasElement {
  const W = canvas.width, H = canvas.height;
  frameCanvas.width = W; frameCanvas.height = H;
  const g = frameCanvas.getContext('2d')!;
  // the model's pixels read from WebGL (drawImage of a WebGL canvas comes out blank under software rendering)
  const px = new Uint8Array(W * H * 4);
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
  // the first thing hit that is drawn (an element's texel with some opacity)
  let guid: string | undefined;
  for (const hit of ray.intersectObjects(pickables.map((p) => p.mesh), false)) {
    const p = pickables.find((x) => x.mesh === hit.object);
    if (!p) continue;
    const o = p.perVertex ? p.ordinals[hit.face?.a ?? 0] : p.ordinals[hit.instanceId ?? 0];
    if (stateData[o * 4 + 3] < 20) continue;
    guid = guids?.[o]; break;
  }
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
/** The hooks answer only once every tile is on the GPU; a model the browser could not hold throws its labelled error. */
const failedNow = () => { if (failure) throw new Error(`[${failure.code}] ${failure.message}`); };
const whenLoaded = async () => { failedNow(); await loading.catch(() => failedNow()); };
const api = {
  ready: () => { failedNow(); return loaded; },
  status: () => JSON.parse(JSON.stringify(status)) as Status,
  progress: () => ({ ...progress }),
  setDate: (d: string) => { const m = toMin(d); if (m != null) { current = m; render(); } },
  setSource: (s: string) => { opt.left = s; render(); },
  highlight: (list: string[]) => { highlighted.clear(); for (const g of list) { const o = ordinalOfGuid(g); if (o >= 0) highlighted.add(o); } render(); },
  /** An MP4 (H.264 when the browser can encode it, else WebM/VP9) of the sweep from..to, a frame per step, made here. */
  encode: async (o: { from?: string; to?: string; step?: number; fps?: number; width?: number; height?: number; codec?: 'avc' | 'vp9' } = {}): Promise<{ bytes: Uint8Array; mime: string; frames: number }> => {
    await whenLoaded();
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
    for (let m = a; m <= b + 1e-6; m += step) { failedNow(); current = Math.min(m, b); render(); frame.getContext('2d')!.drawImage(composite(), 0, 0); await src.add(n / fps, 1 / fps); n++; progress.done = n; }
    await output.finalize();
    return { bytes: new Uint8Array((output.target as BufferTarget).buffer!), mime: codec === 'avc' ? 'video/mp4' : 'video/webm', frames: n };
  },
  /** One frame as PNG (data URL) at a date. */
  png: (d?: string) => { failedNow(); if (!loaded) throw new Error('The 4D model has not finished loading (P6C4D_API.ready() is still false).'); if (d) api.setDate(d); render(); return composite().toDataURL('image/png'); },
};
window.P6C4D_API = api;
// the White Hat IQ platform's client render (shared/chat-engine/clientRender4d.ts) drives these: ready() is true once
// every tile is on the GPU and THROWS the labelled error when the browser could not hold the model (so a render fails
// at once, in words, instead of timing out); started and status() let it see the page alive while the tiles load
window.WHIQ4D_EXPORT = {
  started: true,
  status: api.status,
  ready: api.ready,
  max: () => Math.max(1, Math.round((t1 - t0) / DAY)),
  setStep: (days: number) => { opt.step = Math.max(1, Number(days) || 7); },
  frame: (v: number) => { failedNow(); if (!loaded) throw new Error('The 4D model has not finished loading (WHIQ4D_EXPORT.ready() is still false).'); current = Math.min(t1, t0 + Number(v) * DAY); render(); return composite().toDataURL('image/png'); },
};

loadModel().then(() => undefined, (e) => failWith(e instanceof LoadFailed ? e : new LoadFailed('load_failed', `The 4D model could not be loaded: ${(e as Error).message}`)));
