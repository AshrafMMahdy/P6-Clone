// The runtimes that travel beside a bundle. copyReasoner: the schedule reasoner's runtime: models/reasoner.onnx, and ort/ with onnxruntime-web's Node build and
// onnxruntime-common bundled into one ES module beside its WebAssembly (~14 MB), plus their licence notices. Not a
// node_modules folder: the White Hat IQ platform's signed manifest and patch builder skip those. hrmRuntime.ts imports
// ort/onnxruntime-web/dist/ort.node.min.mjs by absolute path; the module finds its .wasm beside itself (import.meta.url).
import { build, buildSync } from 'esbuild';
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
  cpSync(join(root, 'core/bim/meshClosed.mjs'), join(out, 'meshClosed.mjs')); // the closed-mesh rule geomWorker.mjs imports
  // Navisworks files: the reader, bundled into one module (its own process; it starts the tiler beside it)
  buildSync({ entryPoints: [join(root, 'core/bim/nwdWorker.ts')], outfile: join(out, 'nwdWorker.mjs'), bundle: true, format: 'esm', platform: 'node', target: 'node22', logLevel: 'warning', banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" } });
  cpSync(join(root, 'core/bim/geomChunk.mjs'), join(out, 'geomChunk.mjs')); // models past one web-ifc run
  cpSync(join(root, 'core/bim/geomTiles.mjs'), join(out, 'geomTiles.mjs')); // the display tiles of each run
  cpSync(join(root, 'core/bim/rvtWorker.mjs'), join(out, 'rvtWorker.mjs')); // Revit files: rvt-rs (Apache-2.0) in rvt/
  mkdirSync(join(out, 'rvt'), { recursive: true });
  for (const f of ['rvt.js', 'rvt_bg.wasm', 'LICENSE', 'NOTICE', 'README.md', 'p6clone.patch']) cpSync(join(root, 'core/bim/rvt', f), join(out, 'rvt', f));
  writeFileSync(join(out, 'README.txt'), 'web-ifc 0.0.77 (That Open Company, MPL-2.0: web-ifc/LICENSE.md; source at https://github.com/ThatOpen/engine_web-ifc), used unmodified to read IFC geometry for 4D.\nrvt-rs 0.6.1 (Apache-2.0: rvt/LICENSE and rvt/NOTICE; source at https://github.com/DrunkOnJava/rvt-rs, commit b6086d4), its WebAssembly build with the changes in rvt/p6clone.patch (memory only: the same IFC), to read Revit files (rvt/README.md says how it was built).\n');
}
