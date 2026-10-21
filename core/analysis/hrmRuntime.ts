// Runs reasoner.onnx in Node (MCP server, CLI, the desktop app's main process) with onnxruntime-web: WebAssembly, so
// no native binary per operating system. Beside a bundle the model is in models/ and the runtime in ort/ (not a
// node_modules folder: the platform's signed manifest and patch builder skip those), loaded by absolute path; in the
// repository both come from models/ and node_modules. P6CLONE_REASONER overrides the model. A missing model or runtime
// is an error that says so, never a silent skip.
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { REASONER_KMAX, type Infer } from './hrm.ts';

const here = () => { try { return typeof __dirname === 'string' ? __dirname : dirname(fileURLToPath(import.meta.url)); } catch { return null; } };
/** Folders to look in: beside the bundle, its parent (dist/ in the desktop app), the repository root. */
const homes = () => { const h = here(); return h ? [h, join(h, '..'), join(h, '..', '..')] : []; };

export function reasonerModelPath(): string | null {
  const env = process.env.P6CLONE_REASONER;
  if (env) return existsSync(env) ? env : null;
  for (const p of homes()) if (existsSync(join(p, 'models', 'reasoner.onnx'))) return join(p, 'models', 'reasoner.onnx');
  return null;
}

/** The runtime's entry: ort/onnxruntime-web beside a bundle, else the package (repository, development). */
export function runtimeEntry(): string {
  for (const p of homes()) { const f = join(p, 'ort', 'onnxruntime-web', 'dist', 'ort.node.min.mjs'); if (existsSync(f)) return pathToFileURL(f).href; }
  return 'onnxruntime-web';
}

export class ReasonerUnavailable extends Error {}

let session: Promise<{ ort: any; s: any }> | null = null;

async function load() {
  const path = reasonerModelPath();
  if (!path) throw new ReasonerUnavailable(process.env.P6CLONE_REASONER ? `P6CLONE_REASONER names ${process.env.P6CLONE_REASONER}, which does not exist.` : 'The schedule reasoner model (models/reasoner.onnx) is not installed beside the program. Copy it there or set P6CLONE_REASONER to its path.');
  let ort: any;
  const entry = runtimeEntry();
  try { ort = await import(entry); } catch (e) { throw new ReasonerUnavailable(`The ONNX runtime (${entry === 'onnxruntime-web' ? 'onnxruntime-web' : 'ort/'}) could not be loaded: ${(e as Error).message}`); }
  ort = ort.default ?? ort;
  ort.env.wasm.numThreads = 1;
  try { return { ort, s: await ort.InferenceSession.create(new Uint8Array(readFileSync(path))) }; } catch (e) { throw new ReasonerUnavailable(`reasoner.onnx failed to load: ${(e as Error).message}`); }
}

const ready = async () => { session ??= load(); try { return await session; } catch (e) { session = null; throw e; } };

/** For server_status: loads the model once (about 0.3 s) and says whether it is ready, from where, or why not. */
export async function reasonerStatus(): Promise<{ loaded: boolean; model: string | null; runtime: string; error?: string }> {
  const model = reasonerModelPath(), runtime = runtimeEntry() === 'onnxruntime-web' ? 'onnxruntime-web (package)' : 'ort/ beside the program';
  try { await ready(); return { loaded: true, model, runtime }; } catch (e) { return { loaded: false, model, runtime, error: (e as Error).message }; }
}

export const nodeInfer: Infer = async ({ n, feats, bias, modeMask }) => {
  const { ort, s } = await ready();
  const o = await s.run({
    feats: new ort.Tensor('float32', feats, [1, n, 9]), bias: new ort.Tensor('float32', bias, [1, n, n]),
    mode_mask: new ort.Tensor('bool', modeMask, [1, n, REASONER_KMAX]), pad: new ort.Tensor('bool', new Uint8Array(n).fill(1), [1, n]),
  });
  return { priority: o.priority.data as Float32Array, modeLogits: o.mode_logits.data as Float32Array };
};
