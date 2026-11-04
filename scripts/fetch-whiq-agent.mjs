// Fetches the platform's agent (pinned in whiq-agent.lock.json) into vendor/whiq-agent/, read-only, from a local
// clone of the platform repo (WHIQ_REPO, default ../White-Hat-IQ-2 beside this repo). Nothing is written to that
// repo; a commit it does not have yet is reported with the command that fetches it. Then the agent's workspaces are
// cut down to the agent's own (the platform's other apps are not fetched) and an API-only page stands in for the
// platform's front end, which the agent server insists on (the clone's AI panel is the front end here). Last, the
// clone's own small changes in patches/whiq-agent/*.patch are applied to the copy (the platform repo stays untouched);
// a changed patch fetches again.
//   node scripts/fetch-whiq-agent.mjs [--install] [--build] [--engines] [--pqvae]
import { execFileSync, spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const lock = JSON.parse(readFileSync(join(root, 'whiq-agent.lock.json'), 'utf8'));
const repo = resolve(process.env.WHIQ_REPO ?? join(root, '..', 'White-Hat-IQ-2'));
const out = join(root, 'vendor', 'whiq-agent');
const args = new Set(process.argv.slice(2));
const git = (...a) => execFileSync('git', ['-C', repo, ...a], { encoding: 'utf8' }).trim();

if (!existsSync(join(repo, '.git'))) throw new Error(`No platform repo at ${repo}; set WHIQ_REPO to a clone of ${lock.repo}.`);
try { git('cat-file', '-e', `${lock.commit}^{commit}`); } catch {
  throw new Error(`The platform repo at ${repo} does not have ${lock.commit} yet. Run: git -C "${repo}" fetch origin ${lock.branch}`);
}
/** Empty the fetched tree's `tops` (top-level names), keeping every node_modules folder inside them (installed, not fetched). */
function clearExcept(dir, tops) {
  if (!existsSync(dir)) return mkdirSync(dir, { recursive: true });
  const clear = (p) => {
    for (const e of readdirSync(p, { withFileTypes: true })) {
      const q = join(p, e.name);
      if (e.name === 'node_modules') continue;
      if (e.isDirectory() && !e.isSymbolicLink()) clear(q); else rmSync(q, { force: true });
    }
  };
  for (const t of tops) { const p = join(dir, t); if (!existsSync(p)) continue; if (statSync(p).isDirectory()) clear(p); else rmSync(p, { force: true }); }
}
const patchDir = join(root, 'patches', 'whiq-agent');
const patches = existsSync(patchDir) ? readdirSync(patchDir).filter((f) => f.endsWith('.patch')).sort() : [];
const patchHash = createHash('sha256').update(patches.map((f) => f + '\0' + readFileSync(join(patchDir, f), 'utf8')).join('\0')).digest('hex').slice(0, 12);
const version = `${lock.commit} patches:${patchHash}`;
const stamp = join(out, '.whiq-agent-commit');
if (existsSync(stamp) && readFileSync(stamp, 'utf8').trim() === version && !args.has('--force')) {
  console.log(`vendor/whiq-agent is already at ${lock.commit.slice(0, 8)}`);
} else {
  // the platform's files go; what was installed or built beside them stays (node_modules, engines, the PQ-VAE models)
  clearExcept(out, new Set(lock.paths.map((p) => p.split('/')[0])));
  // git archive | tar: the tree exactly as committed, no working copy of the platform involved, and with its own line
  // endings whatever this machine's core.autocrlf (the patches are made against those)
  const tar = spawnSync('git', ['-c', 'core.autocrlf=false', '-C', repo, 'archive', '--format=tar', lock.commit, ...lock.paths], { maxBuffer: 1 << 30 });
  if (tar.status !== 0) throw new Error(`git archive failed: ${tar.stderr}`);
  const x = spawnSync('tar', ['-x', '-f', '-'], { cwd: out, input: tar.stdout, maxBuffer: 1 << 30 }); // (in the folder: GNU tar reads "C:" in a path as a remote host)
  if (x.status !== 0) throw new Error(`tar failed: ${x.stderr}`);
  // the platform's root lists every app as a workspace; only the agent's are here
  const pkgPath = join(out, 'package.json');
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
  pkg.workspaces = lock.workspaces;
  pkg.scripts = {};
  writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n');
  const dist = join(out, '03 Shared Platform Agents', 'app', 'dist');
  mkdirSync(dist, { recursive: true });
  writeFileSync(join(dist, 'index.html'), '<!doctype html><title>White Hat IQ agent</title><p>API only: the P6 Clone AI panel is the front end.</p>\n');
  for (const f of patches) {
    // from this repo's root with the folder named: inside a git work tree, `git apply` reads paths from the tree's top
    const a = spawnSync('git', ['apply', '--whitespace=nowarn', '--directory=vendor/whiq-agent', join(patchDir, f)], { cwd: root, encoding: 'utf8' });
    if (a.status !== 0) throw new Error(`patches/whiq-agent/${f} does not apply to ${lock.commit.slice(0, 8)}: ${a.stderr}`);
  }
  writeFileSync(stamp, version + '\n');
  console.log(`fetched ${lock.commit.slice(0, 8)} (${lock.paths.length} paths) into vendor/whiq-agent, ${patches.length} patch(es) applied`);
}
const run = (cmd, a, cwd, env = {}) => {
  console.log(`> ${cmd} ${a.join(' ')}`);
  const r = spawnSync(cmd, a, { cwd, stdio: 'inherit', shell: process.platform === 'win32', env: { ...process.env, ...env } });
  if (r.status !== 0) throw new Error(`${cmd} failed (${r.status})`);
};
if (args.has('--install')) run('npm', ['install', '--no-audit', '--no-fund'], out);
if (args.has('--build')) run('node', ['scripts/build-servers.mjs'], out, { ONLY: '03 Shared Platform Agents' });
// --engines: the platform's own engines at its pins (downloaded, sha256-checked and smoke-tested by its script), except
// the P6 clone engine, which is this repo's own build (dist-cli: node scripts/build-cli.mjs), the same code as the app
if (args.has('--engines')) {
  const lockFile = JSON.parse(readFileSync(join(out, 'engines.lock'), 'utf8'));
  for (const name of Object.keys(lockFile.engines ?? {})) if (name !== 'p6clone') run('node', ['scripts/engines-fetch.mjs', '--only', name], out);
  const cli = join(root, 'dist-cli');
  if (!existsSync(join(cli, 'p6clone-mcp.cjs'))) throw new Error('No dist-cli/p6clone-mcp.cjs: run node scripts/build-cli.mjs first.');
  const to = join(out, 'engines', 'p6clone');
  rmSync(to, { recursive: true, force: true });
  cpSync(cli, to, { recursive: true });
  console.log(`p6clone engine: this repo's dist-cli copied to ${to}`);
}
// --pqvae: the platform's PQ-VAE models converted once to ONNX for the app's own engine (main/pqvae), into
// vendor/whiq-agent/pqvae-onnx; needs python with torch, sentence-transformers and onnx on this build machine only
if (args.has('--pqvae')) run(process.env.PYTHON_BIN || 'python', ['-P', 'scripts/pqvae-export.py'], root);   // (relative: run() goes through the shell)
