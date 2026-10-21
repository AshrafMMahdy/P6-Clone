// Bundle the 4D viewer (viewer4d/viewer.ts with three.js and mediabunny) into one script: dist-viewer/viewer4d.js.
// build.mjs, build-cli.mjs and the tests run it; render_4d and the desktop serve it beside the model.
import { build } from 'esbuild';
import { statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
export const VIEWER_OUT = join(root, 'dist-viewer', 'viewer4d.js');
export async function buildViewer() {
  await build({ entryPoints: [join(root, 'viewer4d', 'viewer.ts')], outfile: VIEWER_OUT, bundle: true, minify: true, format: 'iife', target: 'chrome110', legalComments: 'eof', logLevel: 'warning' });
  return VIEWER_OUT;
}
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) { await buildViewer(); console.log(`built ${VIEWER_OUT} (${Math.round(statSync(VIEWER_OUT).size / 1024)} KB)`); }
