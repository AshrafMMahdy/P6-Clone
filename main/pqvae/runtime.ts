// onnxruntime-web in Node (WebAssembly, no native binary), loaded the way core/analysis/hrmRuntime.ts does it: beside a bundle the runtime is in
// ort/ (not a node_modules folder), in the repository it is the package. One thread by default (PQVAE_THREADS / --threads raises it: 4 threads
// embed text about 3x faster). Models are read from the folder the sidecar was started with.
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
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
