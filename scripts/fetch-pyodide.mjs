// The Python of the desktop sandbox (main/sandbox/pyodideService.ts), fetched once and bundled: vendor/pyodide/ holds Pyodide's
// core and ONLY the packages the platform's scripts import (numpy, pandas, scipy, matplotlib, openpyxl, xlsxwriter, python-docx,
// python-pptx, pypdf, lxml, Pillow and what they depend on), so the sandbox works offline and nothing is installed at run time.
// Everything is pinned in pyodide.lock.json by SHA-256: the Pyodide release tarball (GitHub), the pure-Python wheels the release
// does not carry (PyPI), and the licence texts. The release is downloaded into .cache/pyodide/ and unpacked there; vendor/pyodide/
// gets the selected files, a trimmed pyodide-lock.json (so a package that is not bundled is "not found", never a network fetch),
// licenses/ (Pyodide, CPython, Emscripten, and every wheel's own licence files) and manifest.json (file sizes and hashes).
//   node scripts/fetch-pyodide.mjs [--force]          vendor/pyodide/ unchanged when it already matches the lock file
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { inflateRawSync } from 'node:zlib';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');
/** Pyodide's own files in the release (the loader, the runtime, the Python standard library, the package index). */
const CORE = ['pyodide.mjs', 'pyodide.asm.mjs', 'pyodide.asm.wasm', 'python_stdlib.zip', 'package.json'];
/** Licence-like files inside a wheel's dist-info. */
const LICENCE_FILE = /(^|\/)(licen[cs]e|copying|notice|authors)[^/]*$/i;

async function download(url, file, hash, label) {
  if (existsSync(file) && sha256(readFileSync(file)) === hash) return;
  console.log(`downloading ${label}`);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${label}: HTTP ${res.status} from ${url}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (sha256(buf) !== hash) throw new Error(`${label}: its SHA-256 is not the pinned one (a changed or damaged download)`);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, buf);
}

/** The entries of a zip (a wheel): name -> function giving the bytes. Stored and deflated entries only (all a wheel has). */
function readZip(buf) {
  let eocd = buf.length - 22;
  while (eocd >= 0 && buf.readUInt32LE(eocd) !== 0x06054b50) eocd--;
  if (eocd < 0) throw new Error('not a zip file');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const out = new Map();
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('damaged zip directory');
    const method = buf.readUInt16LE(p + 10), csize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28), extraLen = buf.readUInt16LE(p + 30), commentLen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    out.set(name, () => {
      const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
      const raw = buf.subarray(start, start + csize);
      return method === 0 ? raw : inflateRawSync(raw);
    });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

function unpack(tarball, dir) {
  mkdirSync(dir, { recursive: true });
  const tar = process.platform === 'win32' ? join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe') : 'tar';
  const r = spawnSync(tar, ['-xf', tarball, '-C', dir], { stdio: 'inherit' });
  if (r.status !== 0) throw new Error(`could not unpack ${tarball} with ${tar} (bzip2 support is needed)`);
}

export async function fetchPyodide({ out = join(root, 'vendor', 'pyodide'), force = false } = {}) {
  const lockText = readFileSync(join(root, 'pyodide.lock.json'), 'utf8');
  const lockHash = sha256(Buffer.from(lockText));
  const lock = JSON.parse(lockText);
  const manifestFile = join(out, 'manifest.json');
  if (!force && existsSync(manifestFile)) {
    const m = JSON.parse(readFileSync(manifestFile, 'utf8'));
    if (m.lock === lockHash && m.files.every((f) => existsSync(join(out, f.path)) && statSync(join(out, f.path)).size === f.size)) {
      console.log(`vendor/pyodide is up to date (Pyodide ${lock.pyodide.version})`);
      return m;
    }
  }
  const cache = join(root, '.cache', 'pyodide');
  const tarball = join(cache, `pyodide-${lock.pyodide.version}.tar.bz2`);
  await download(lock.pyodide.url, tarball, lock.pyodide.sha256, `Pyodide ${lock.pyodide.version} (${Math.round(lock.pyodide.size / 1048576)} MB)`);
  const dist = join(cache, `dist-${lock.pyodide.version}`);
  const stamp = join(dist, '.unpacked');
  if (!existsSync(stamp)) { rmSync(dist, { recursive: true, force: true }); unpack(tarball, dist); writeFileSync(stamp, lock.pyodide.sha256); }
  const src = join(dist, 'pyodide');
  const full = JSON.parse(readFileSync(join(src, 'pyodide-lock.json'), 'utf8'));

  // the packages the distribution carries, with everything they depend on
  const chosen = new Map(), todo = [...lock.packages];
  while (todo.length) {
    const n = todo.pop();
    if (chosen.has(n)) continue;
    const p = full.packages[n];
    if (!p) throw new Error(`package ${n} is not in the Pyodide ${lock.pyodide.version} distribution`);
    chosen.set(n, p);
    todo.push(...(p.depends ?? []));
  }
  // the wheels it does not carry
  const wheels = new Map();
  for (const w of lock.wheels) {
    const file = join(cache, 'wheels', w.file);
    await download(w.url, file, w.sha256, `${w.name} ${w.version}`);
    wheels.set(w.name, { w, file });
    for (const d of w.depends) if (!chosen.has(d) && !lock.wheels.some((x) => x.name === d)) {
      const p = full.packages[d];
      if (!p) throw new Error(`${w.name} needs ${d}, which neither the distribution nor pyodide.lock.json carries`);
      const more = [d];
      while (more.length) { const m = more.pop(); if (chosen.has(m)) continue; chosen.set(m, full.packages[m]); more.push(...(full.packages[m].depends ?? [])); }
    }
  }

  rmSync(out, { recursive: true, force: true });
  mkdirSync(join(out, 'licenses'), { recursive: true });
  for (const f of CORE) cpSync(join(src, f), join(out, f));
  const trimmed = { info: full.info, packages: {} };
  for (const [n, p] of [...chosen].sort(([a], [b]) => a.localeCompare(b))) {
    const f = join(src, p.file_name);
    if (sha256(readFileSync(f)) !== p.sha256) throw new Error(`${p.file_name}: does not match the hash in Pyodide's own lock`);
    cpSync(f, join(out, p.file_name));
    trimmed.packages[n] = p;
  }
  for (const [n, { w, file }] of [...wheels].sort(([a], [b]) => a.localeCompare(b))) {
    cpSync(file, join(out, w.file));
    trimmed.packages[n] = { depends: w.depends, file_name: w.file, imports: w.imports, install_dir: 'site', name: w.name, package_type: 'package', sha256: w.sha256, tool: {}, unvendored_tests: false, version: w.version };
  }
  writeFileSync(join(out, 'pyodide-lock.json'), JSON.stringify(trimmed, null, 1) + '\n');

  // licences: the three runtimes, and what each wheel carries in its own dist-info
  const notes = ['Licences of what vendor/pyodide/ bundles (written by scripts/fetch-pyodide.mjs).', ''];
  for (const l of lock.licenses) {
    await download(l.url, join(cache, 'licenses', l.file), l.sha256, l.what);
    cpSync(join(cache, 'licenses', l.file), join(out, 'licenses', l.file));
    notes.push(`${l.file}: ${l.what}`);
  }
  notes.push('');
  for (const [n, p] of Object.entries(trimmed.packages)) {
    const wheel = wheels.get(n)?.file ?? join(src, p.file_name);
    const zip = readZip(readFileSync(wheel));
    const dir = join(out, 'licenses', `${n}-${p.version}`);
    let got = 0;
    for (const [name, bytes] of zip) {
      if (name.endsWith('/') || !LICENCE_FILE.test(name) || !/\.dist-info\//.test(name)) continue;
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, name.split('/').slice(1).join('__')), bytes());
      got++;
    }
    notes.push(`licenses/${n}-${p.version}/: ${got ? `${got} licence file(s) from the wheel` : 'the wheel carries no licence file (its licence is named by its project page)'}`);
  }
  writeFileSync(join(out, 'licenses', 'README.txt'), notes.join('\n') + '\n');

  const files = [];
  const walk = (d) => { for (const e of readdirSync(d, { withFileTypes: true })) { const f = join(d, e.name); if (e.isDirectory()) walk(f); else if (e.name !== 'manifest.json') { const b = readFileSync(f); files.push({ path: f.slice(out.length + 1).replaceAll('\\', '/'), size: b.length, sha256: sha256(b) }); } } };
  walk(out);
  const manifest = {
    pyodide: lock.pyodide.version, python: lock.pyodide.python, lock: lockHash,
    /** what a session loads when it starts, in this order */
    load: [...lock.packages, ...lock.wheels.map((w) => w.name)],
    packages: Object.fromEntries(Object.entries(trimmed.packages).map(([n, p]) => [n, p.version])),
    files,
  };
  writeFileSync(manifestFile, JSON.stringify(manifest, null, 1) + '\n');
  const total = files.reduce((a, f) => a + f.size, 0);
  console.log(`vendor/pyodide: Pyodide ${lock.pyodide.version}, ${files.length} files, ${(total / 1048576).toFixed(1)} MB, ${Object.keys(trimmed.packages).length} packages`);
  return manifest;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await fetchPyodide({ force: process.argv.includes('--force') });
