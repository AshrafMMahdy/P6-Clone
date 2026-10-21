// The schedule reasoner's runtime for bundles: models/reasoner.onnx, and ort/ with onnxruntime-web's Node build and
// onnxruntime-common bundled into one ES module beside its WebAssembly (~14 MB), plus their licence notices. Not a
// node_modules folder: the White Hat IQ platform's signed manifest and patch builder skip those. hrmRuntime.ts imports
// ort/onnxruntime-web/dist/ort.node.min.mjs by absolute path; the module finds its .wasm beside itself (import.meta.url).
import { build } from 'esbuild';
import { cpSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

export async function copyReasoner(root, dest) {
  cpSync(join(root, 'models'), join(dest, 'models'), { recursive: true });
  const web = join(root, 'node_modules/onnxruntime-web'), out = join(dest, 'ort', 'onnxruntime-web', 'dist');
  rmSync(join(dest, 'ort'), { recursive: true, force: true });
  rmSync(join(dest, 'node_modules'), { recursive: true, force: true }); // the layout before ort/
  mkdirSync(out, { recursive: true });
  await build({ entryPoints: [join(web, 'dist/ort.node.min.mjs')], outfile: join(out, 'ort.node.min.mjs'), bundle: true, format: 'esm', platform: 'node', target: 'node18', logLevel: 'warning' });
  for (const f of ['ort-wasm-simd-threaded.mjs', 'ort-wasm-simd-threaded.wasm']) cpSync(join(web, 'dist', f), join(out, f));
  cpSync(join(root, 'licenses'), join(dest, 'ort'), { recursive: true });
}
