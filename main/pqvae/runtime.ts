// onnxruntime-web in Node (WebAssembly, no native binary), loaded the way core/analysis/hrmRuntime.ts does it: beside a bundle the runtime is in
// ort/ (not a node_modules folder), in the repository it is the package. One thread by default (PQVAE_THREADS / --threads raises it: 4 threads
// embed text about 2.5x faster, also on Electron's Node; start.ts passes min(4, cores - 1)). Models are read from the folder the sidecar was started with.
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const here = (): string | null => { try { return typeof __dirname === 'string' ? __dirname : dirname(fileURLToPath(import.meta.url)); } catch { return null; } };

/** The runtime's entry: ort/onnxruntime-web beside a bundle (or its parent, or the repository root), else the package. */
export function runtimeEntry(): string {
  const h = here();
  for (const p of h ? [h, join(h, '..'), join(h, '..', '..')] : []) { const f = join(p, 'ort', 'onnxruntime-web', 'dist', 'ort.node.min.mjs'); if (existsSync(f)) return pathToFileURL(f).href; }
  return 'onnxruntime-web';
}

export interface Tensor { dims: readonly number[]; data: Float32Array | BigInt64Array | Int32Array }
export interface Session { run(feeds: Record<string, Tensor>): Promise<Record<string, Tensor>> }
export interface Ort { Tensor: new (type: string, data: ArrayLike<number | bigint>, dims: number[]) => Tensor; InferenceSession: { create(model: Uint8Array, options?: object): Promise<Session> }; env: { wasm: { numThreads: number } } }

let ortP: Promise<Ort> | null = null;
export function ort(): Promise<Ort> {
  ortP ??= import(runtimeEntry()).then((m) => { const o = (m.default ?? m) as Ort; o.env.wasm.numThreads = Math.max(1, Number(process.env.PQVAE_THREADS) || 1); return o; }, (e: Error) => { ortP = null; throw new Error(`The ONNX runtime (${runtimeEntry()}) could not be loaded: ${e.message}`); });
  return ortP;
}

export async function loadSession(file: string): Promise<Session> {
  if (!existsSync(file)) throw new Error(`model file missing: ${file} (run scripts/pqvae-export.py)`);
  const o = await ort();
  const b = readFileSync(file);
  return o.InferenceSession.create(new Uint8Array(b.buffer, b.byteOffset, b.byteLength), { executionProviders: ['wasm'], graphOptimizationLevel: 'all' });   // a view: the file is not copied again in JS memory
}

// ── the GPU: onnxruntime-node with DirectML (Windows, any DirectX 12 GPU), for the text encoder only ──────────────────────────────────
// Beside a bundle it is ort-node/ (dist/index.cjs, the native binding in bin/napi-v6/win32/x64 and DirectML.dll; not a node_modules folder),
// in the repository it is the package. PQVAE_GPU=off forces wasm; =on fails loudly when the GPU cannot be used.
export type TextProvider = 'dml' | 'wasm';
export const gpuMode = (): 'off' | 'on' | 'auto' => { const v = String(process.env.PQVAE_GPU ?? '').toLowerCase(); return v === 'off' || v === 'on' ? v : 'auto'; };

/** The native runtime's entry: ort-node/dist/index.cjs beside a bundle (or its parent, or the repository root), else the package. */
export function nativeEntry(): string {
  const h = here();
  for (const p of h ? [h, join(h, '..'), join(h, '..', '..')] : []) { const f = join(p, 'ort-node', 'dist', 'index.cjs'); if (existsSync(f)) return f; }
  return 'onnxruntime-node';
}

let nativeM: { m: Ort | null; why: string } | null = null;
/** onnxruntime-node, or why it cannot be used here (not Windows x64, not installed, the binding or DirectML.dll does not load). Loaded once. */
export function native(): { m: Ort | null; why: string } {
  if (nativeM) return nativeM;
  if (process.platform !== 'win32' || process.arch !== 'x64') return (nativeM = { m: null, why: `DirectML needs Windows x64 (this is ${process.platform} ${process.arch})` });
  try {
    const m = createRequire(pathToFileURL(join(here() ?? process.cwd(), 'x.cjs')).href)(nativeEntry());
    return (nativeM = { m: (m.default ?? m) as Ort, why: '' });
  } catch (e) { return (nativeM = { m: null, why: `onnxruntime-node could not be loaded: ${(e as Error).message}` }); }
}

/** A DirectML session over the model file; fed with the wasm runtime's tensors, rebuilt as the native runtime's. */
export async function loadGpuSession(file: string): Promise<Session> {
  const n = native();
  if (!n.m) throw new Error(n.why);
  if (!existsSync(file)) throw new Error(`model file missing: ${file} (run scripts/pqvae-export.py)`);
  const o = n.m;
  const s = await o.InferenceSession.create(file as unknown as Uint8Array, { executionProviders: ['dml'], graphOptimizationLevel: 'all', enableMemPattern: false, executionMode: 'sequential', logSeverityLevel: 3 });
  return { run: (feeds) => s.run(Object.fromEntries(Object.entries(feeds).map(([k, t]) => [k, new o.Tensor((t as unknown as { type: string }).type, t.data, [...t.dims])])) as Record<string, Tensor>) };
}
