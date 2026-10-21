// The runtimes that travel beside a bundle. copyReasoner: the schedule reasoner's runtime: models/reasoner.onnx, and ort/ with onnxruntime-web's Node build and
// onnxruntime-common bundled into one ES module beside its WebAssembly (~14 MB), plus their licence notices. Not a
// node_modules folder: the White Hat IQ platform's signed manifest and patch builder skip those. hrmRuntime.ts imports
// ort/onnxruntime-web/dist/ort.node.min.mjs by absolute path; the module finds its .wasm beside itself (import.meta.url).
import { build } from 'esbuild';
import { cpSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
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

/** The IFC engine (4D) beside a bundle: ifc/ with web-ifc's Node build, its WebAssembly and licence (MPL-2.0), and the
 *  geometry worker that runs it in its own process. Not a node_modules folder (the platform's manifest skips those). */
export function copyIfc(root, dest) {
  const web = join(root, 'node_modules/web-ifc'), out = join(dest, 'ifc');
  rmSync(out, { recursive: true, force: true });
  mkdirSync(join(out, 'web-ifc'), { recursive: true });
  for (const f of ['package.json', 'web-ifc-api-node.js', 'web-ifc-node.wasm', 'LICENSE.md']) cpSync(join(web, f), join(out, 'web-ifc', f));
  cpSync(join(root, 'core/bim/geomWorker.mjs'), join(out, 'geomWorker.mjs'));
  cpSync(join(root, 'core/bim/geomChunk.mjs'), join(out, 'geomChunk.mjs')); // models past one web-ifc run
  writeFileSync(join(out, 'README.txt'), 'web-ifc 0.0.77 (That Open Company, MPL-2.0: web-ifc/LICENSE.md; source at https://github.com/ThatOpen/engine_web-ifc), used unmodified to read IFC geometry for 4D.\n');
}
