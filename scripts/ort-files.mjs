// The schedule reasoner's runtime for bundles: models/reasoner.onnx and the parts of onnxruntime-web that run it in
// Node (the WebAssembly build, ~14 MB), copied beside a bundle that keeps onnxruntime-web external.
import { cpSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

export function copyReasoner(root, dest) {
  cpSync(join(root, 'models'), join(dest, 'models'), { recursive: true });
  const nm = join(dest, 'node_modules');
  const web = join(root, 'node_modules/onnxruntime-web'), common = join(root, 'node_modules/onnxruntime-common');
  mkdirSync(join(nm, 'onnxruntime-web/dist'), { recursive: true });
  cpSync(join(web, 'package.json'), join(nm, 'onnxruntime-web/package.json'));
  for (const f of ['ort.node.min.js', 'ort.node.min.mjs', 'ort-wasm-simd-threaded.mjs', 'ort-wasm-simd-threaded.wasm']) cpSync(join(web, 'dist', f), join(nm, 'onnxruntime-web/dist', f));
  cpSync(common, join(nm, 'onnxruntime-common'), { recursive: true, filter: (p) => !p.endsWith('.map') && !/[\/]lib[\/]/.test(p.slice(common.length)) });
}
