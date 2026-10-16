// Build main + preload (esbuild) and renderer (vite) into dist/.
import { build as esbuild } from 'esbuild';
import { build as vite } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const common = { bundle: true, platform: 'node', format: 'cjs', target: 'node22', external: ['electron'], sourcemap: true, logLevel: 'warning' };

await esbuild({ ...common, entryPoints: [join(root, 'main/main.ts')], outfile: join(root, 'dist/main.cjs') });
await esbuild({ ...common, entryPoints: [join(root, 'main/preload.ts')], outfile: join(root, 'dist/preload.cjs') });
await vite({
  root: join(root, 'renderer'),
  base: './',
  plugins: [react()],
  logLevel: 'warn',
  build: { outDir: join(root, 'dist/renderer'), emptyOutDir: true, sourcemap: true, chunkSizeWarningLimit: 4000 },
});
console.log('built dist/');
