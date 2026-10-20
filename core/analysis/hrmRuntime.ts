// Runs reasoner.onnx in Node (MCP server, CLI, the desktop app's main process) with onnxruntime-web: WebAssembly, so
// no native binary per operating system. The model is looked for in models/ beside the code or the bundle
// (P6CLONE_REASONER overrides). A missing model or runtime is an error that says so, never a silent skip.
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { REASONER_KMAX, type Infer } from './hrm.ts';

const here = () => { try { return typeof __dirname === 'string' ? __dirname : dirname(fileURLToPath(import.meta.url)); } catch { return process.cwd(); } };

export function reasonerModelPath(): string | null {
  const env = process.env.P6CLONE_REASONER;
  if (env) return existsSync(env) ? env : null;
  const h = here();
  for (const p of [join(h, 'models'), join(h, '..', 'models'), join(h, '..', '..', 'models'), join(process.cwd(), 'models')]) if (existsSync(join(p, 'reasoner.onnx'))) return join(p, 'reasoner.onnx');
  return null;
}

let session: Promise<{ ort: any; s: any }> | null = null;

export class ReasonerUnavailable extends Error {}

async function load() {
  const path = reasonerModelPath();
  if (!path) throw new ReasonerUnavailable('The schedule reasoner model (models/reasoner.onnx) is not installed beside the program. Copy it there or set P6CLONE_REASONER to its path.');
  let ort: any;
  try { ort = await import('onnxruntime-web'); } catch (e) { throw new ReasonerUnavailable(`The ONNX runtime (onnxruntime-web) could not be loaded: ${(e as Error).message}`); }
  ort = ort.default ?? ort;
  ort.env.wasm.numThreads = 1;
  try { return { ort, s: await ort.InferenceSession.create(new Uint8Array(readFileSync(path))) }; } catch (e) { throw new ReasonerUnavailable(`reasoner.onnx failed to load: ${(e as Error).message}`); }
}

export const nodeInfer: Infer = async ({ n, feats, bias, modeMask }) => {
  session ??= load();
  let got;
  try { got = await session; } catch (e) { session = null; throw e; }
  const { ort, s } = got;
  const o = await s.run({
    feats: new ort.Tensor('float32', feats, [1, n, 9]), bias: new ort.Tensor('float32', bias, [1, n, n]),
    mode_mask: new ort.Tensor('bool', modeMask, [1, n, REASONER_KMAX]), pad: new ort.Tensor('bool', new Uint8Array(n).fill(1), [1, n]),
  });
  return { priority: o.priority.data as Float32Array, modeLogits: o.mode_logits.data as Float32Array };
};
