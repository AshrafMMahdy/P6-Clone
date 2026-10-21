// Bundle the 4D viewer (viewer4d/viewer.ts with three.js and mediabunny) into one script: dist-viewer/viewer4d.js.
// build.mjs, build-cli.mjs and the tests run it; render_4d and the desktop serve it beside the model.
import { build } from 'esbuild';
import { appendFileSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
export const VIEWER_OUT = join(root, 'dist-viewer', 'viewer4d.js');
export async function buildViewer() {
  await build({ entryPoints: [join(root, 'viewer4d', 'viewer.ts')], outfile: VIEWER_OUT, bundle: true, minify: true, format: 'iife', target: 'chrome110', legalComments: 'eof', logLevel: 'warning' });
  // the licences of what the bundle holds travel inside it (every copy of viewer4d.js carries them)
  const lic = (pkg) => {
    const j = JSON.parse(readFileSync(join(root, 'node_modules', pkg, 'package.json'), 'utf8'));
    const src = typeof j.repository === 'string' ? j.repository : j.repository?.url;
    return `${pkg} ${j.version} (${j.license}${src ? `, source: ${src}` : ''})\n\n${readFileSync(join(root, 'node_modules', pkg, 'LICENSE'), 'utf8')}`;
  };
  const text = ['three', 'mediabunny'].map(lic).join('\n\n').replaceAll('*/', '* /');
  appendFileSync(VIEWER_OUT, `\n/*! The 4D viewer of the P6 clone bundles:\n\n${text}\n*/\n`);
  return VIEWER_OUT;
}
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) { await buildViewer(); console.log(`built ${VIEWER_OUT} (${Math.round(statSync(VIEWER_OUT).size / 1024)} KB)`); }
