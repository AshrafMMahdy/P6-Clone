// Bundle the CLI and the MCP server into single files with no dependencies, runnable on Node 18+ (no TypeScript
// support needed): dist-cli/p6clone.cjs and dist-cli/p6clone-mcp.cjs. Copy them anywhere (e.g. an agent sandbox), with
// the fonts/ folder beside them so PDFs can print Arabic and other non-Latin text.
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { cpSync } from 'node:fs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const common = { bundle: true, platform: 'node', format: 'cjs', target: 'node18', logLevel: 'warning' }; // the entry files carry their own #! line
await build({ ...common, entryPoints: [join(root, 'cli/p6clone.ts')], outfile: join(root, 'dist-cli/p6clone.cjs') });
await build({ ...common, entryPoints: [join(root, 'mcp/server.ts')], outfile: join(root, 'dist-cli/p6clone-mcp.cjs') });
// the Unicode font for PDFs (Arabic, Hebrew, Cyrillic, Greek) travels with the bundles: copy the fonts folder too
cpSync(join(root, 'fonts'), join(root, 'dist-cli/fonts'), { recursive: true });
console.log('built dist-cli/p6clone.cjs, dist-cli/p6clone-mcp.cjs and dist-cli/fonts/');
