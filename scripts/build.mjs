// Build main + preload (esbuild) and renderer (vite) into dist/.
import { build as esbuild } from 'esbuild';
import { build as vite } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { writeFileSync } from 'node:fs';
import { iconPng } from './icon.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const common = { bundle: true, platform: 'node', format: 'cjs', target: 'node22', external: ['electron', 'onnxruntime-web'], sourcemap: true, logLevel: 'warning' };

await esbuild({ ...common, entryPoints: [join(root, 'main/main.ts')], outfile: join(root, 'dist/main.cjs') });
await esbuild({ ...common, entryPoints: [join(root, 'main/preload.ts')], outfile: join(root, 'dist/preload.cjs') });
await vite({
  root: join(root, 'renderer'),
  base: './',
  plugins: [react()],
  logLevel: 'warn',
  build: { minify: false /* local app; the minifier reorders module init and breaks it */, outDir: join(root, 'dist/renderer'), emptyOutDir: true, sourcemap: true, chunkSizeWarningLimit: 4000 },
});
writeFileSync(join(root, 'dist/icon.png'), iconPng());
console.log('built dist/');
