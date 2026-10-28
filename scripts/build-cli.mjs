// Bundle the CLI and the MCP server into single files with no dependencies (the reasoner's runtime travels beside them), runnable on Node 18+ (no TypeScript
// support needed): dist-cli/p6clone.cjs and dist-cli/p6clone-mcp.cjs. Copy them anywhere (e.g. an agent sandbox), with
// the fonts/ folder beside them so PDFs can print Arabic and other non-Latin text.
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { cpSync } from 'node:fs';
import { copyIfc, copyReasoner } from './ort-files.mjs';
import { copyMpxj } from './mpxj-files.mjs';
import { buildViewer } from './build-viewer4d.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const common = { bundle: true, platform: 'node', format: 'cjs', target: 'node18', logLevel: 'warning', external: ['onnxruntime-web'] }; // the entry files carry their own #! line
await build({ ...common, entryPoints: [join(root, 'cli/p6clone.ts')], outfile: join(root, 'dist-cli/p6clone.cjs') });
await build({ ...common, entryPoints: [join(root, 'mcp/server.ts')], outfile: join(root, 'dist-cli/p6clone-mcp.cjs') });
// the Unicode font for PDFs (Arabic, Hebrew, Cyrillic, Greek) travels with the bundles: copy the fonts folder too
cpSync(join(root, 'fonts'), join(root, 'dist-cli/fonts'), { recursive: true });
// the schedule reasoner (optimize_schedule): the model and its WebAssembly runtime
await copyReasoner(root, join(root, 'dist-cli'));
copyIfc(root, join(root, 'dist-cli')); // 4D: the IFC engine
await copyMpxj(root, join(root, 'dist-cli')); // .mpp: MPXJ (and the Java runtimes P6CLONE_JRE_TARGETS names)
cpSync(await buildViewer(), join(root, 'dist-cli', 'viewer4d.js')); // 4D: the viewer render_4d writes beside the model
console.log('built dist-cli/p6clone.cjs, dist-cli/p6clone-mcp.cjs, dist-cli/fonts/, dist-cli/models/ dist-cli/ort/ (the reasoner runtime and its licences) dist-cli/ifc/ (the IFC engine) and dist-cli/mpxj/ (the .mpp reader)');
