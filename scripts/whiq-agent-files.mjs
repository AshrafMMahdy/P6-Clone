// The embedded platform agent beside a packaged app (resources/whiq-agent): its fetched tree (vendor/whiq-agent, see
// fetch-whiq-agent.mjs) without the 700 MB of node_modules it was built with, and in their place only the packages its
// server bundles and the router load at run time (the bundles keep npm packages external), with their dependencies.
// The engines (Word, Excel, PowerPoint, PDF, DWG crafts and this app's own p6clone) and the platform's sandbox service
// travel as they are. Dev-only parts (the web front end's sources, vite) stay behind.
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const SKIP_TOP = new Set(['node_modules', '.git']);
/** npm packages a bundle imports: static and dynamic `import`, `require`; Node's own modules are not packages. */
function specifiers(file) {
  const src = readFileSync(file, 'utf8'), out = new Set();
  for (const m of src.matchAll(/(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*)["']([^"'./][^"']*)["']/g)) {
    const s = m[1];
    if (s.startsWith('node:') || !/^(@[a-z0-9][\w.-]*\/)?[a-z0-9][\w.-]*(\/.*)?$/i.test(s)) continue;
    out.add(s.startsWith('@') ? s.split('/').slice(0, 2).join('/') : s.split('/')[0]);
  }
  return out;
}
const BUILTIN = new Set(['fs', 'path', 'url', 'os', 'crypto', 'http', 'https', 'stream', 'zlib', 'util', 'events', 'child_process', 'buffer', 'net', 'tls', 'dns', 'readline', 'module', 'assert', 'worker_threads', 'v8', 'vm', 'querystring', 'string_decoder', 'timers', 'perf_hooks', 'async_hooks', 'process', 'fs/promises', 'stream/promises']);
const DEV_ONLY = new Set(['vite']);   // the front end's dev server: the dist branch never imports it

/** The package folder `name` resolves to from `fromDir` (node's lookup: nested node_modules first, then up). */
function resolvePkg(name, fromDir, top) {
  for (let d = fromDir; ; d = dirname(d)) {
    const p = join(d, 'node_modules', name);
    if (existsSync(join(p, 'package.json'))) return p;
    if (d === top || dirname(d) === d) return null;
  }
}

/** Every package folder needed, from the roots' specifiers, with their dependencies (optional ones when installed). */
export function agentPackages(vendor) {
  const roots = [join(vendor, '03 Shared Platform Agents', 'app', 'server.dist.mjs'), ...readdirSync(join(vendor, '06 LLM Router')).filter((f) => f.endsWith('.mjs') && !f.includes('selfcheck')).map((f) => join(vendor, '06 LLM Router', f))];
  const seen = new Set(), missing = new Set(), queue = [];
  for (const r of roots) for (const s of specifiers(r)) if (!BUILTIN.has(s) && !DEV_ONLY.has(s)) queue.push([s, dirname(r)]);
  while (queue.length) {
    const [name, from] = queue.pop();
    const dir = resolvePkg(name, from, vendor);
    if (!dir) { missing.add(name); continue; }
    if (seen.has(dir)) continue;
    seen.add(dir);
    const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
    for (const d of Object.keys({ ...pkg.dependencies, ...pkg.optionalDependencies, ...pkg.peerDependencies })) queue.push([d, dir]);
  }
  // a peer or optional dependency that is not installed is not needed; a root that is not installed is
  return { dirs: [...seen], missing: [...missing] };
}

const size = (p) => { const s = statSync(p); return s.isDirectory() ? readdirSync(p).reduce((n, f) => n + size(join(p, f)), 0) : s.size; };

/** Copy the agent into `dest` (resources/whiq-agent); returns the package count and the sizes. */
export function copyWhiqAgent(vendor, dest) {
  if (!existsSync(join(vendor, '03 Shared Platform Agents', 'app', 'server.dist.mjs'))) throw new Error('vendor/whiq-agent is not built: node scripts/fetch-whiq-agent.mjs --install --build --engines');
  rmSync(dest, { recursive: true, force: true });
  mkdirSync(dest, { recursive: true });
  // the tree, no node_modules anywhere (the app's own and the workspaces' are replaced below)
  for (const f of readdirSync(vendor)) {
    if (SKIP_TOP.has(f)) continue;
    cpSync(join(vendor, f), join(dest, f), { recursive: true, dereference: true, filter: (p) => !p.split(sep).includes('node_modules') });
  }
  const { dirs } = agentPackages(vendor);
  // (source maps and type declarations are not run)
  for (const d of dirs) cpSync(d, join(dest, relative(vendor, d)), { recursive: true, dereference: true, filter: (p) => !/\.(map|d\.ts|d\.mts|d\.cts)$/.test(p) });
  return { packages: dirs.length, mb: Math.round(size(dest) / 1e6) };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const vendor = join(dirname(fileURLToPath(import.meta.url)), '..', 'vendor', 'whiq-agent');
  const { dirs, missing } = agentPackages(vendor);
  console.log(`${dirs.length} packages, ${Math.round(dirs.reduce((n, d) => n + size(d), 0) / 1e6)} MB; not installed: ${missing.join(', ') || 'none'}`);
}
