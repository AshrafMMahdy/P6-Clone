// Saving and putting back a sandbox session's work. The desktop sandbox ends a session on its own when it must make room for another
// (VM_SANDBOX_MAX_SESSIONS) or when it has been idle (VM_SANDBOX_IDLE_S); the platform does not know, and the platform only snapshots a sandbox
// that IT ends. So the service does the same before it ends one, in the same way as the platform (vendor/whiq-agent/shared/chat-engine/server/
// sandbox/e2bClient.ts: SNAPSHOT_FILES_PY, SNAPSHOT_VARS_PY, restoreFilesPy, restoreVarsPy): a tar.gz of the session folder, and a tar.gz with
// a pickle of every picklable global. The two archives are kept on disk (<userData>/whiq/sandbox-snapshots/<sha256 of the id>/), and put back into
// the new session of the same id before its first request runs; the first run says what happened, as the platform's own sandbox note does.
// Kept for 24 hours and at most 2 GB in all (the oldest are dropped, and the id is told so). Nothing here changes the platform's semantics.
import { createHash } from 'node:crypto';
import { closeSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, renameSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import type { SandboxSession } from './pyodideSession.ts';

const STATE_SKIP_VARS = ['DOCS', 'HANDLES', 'load_schedule', 'In', 'Out', 'exit', 'quit', 'get_ipython'];
const STATE_SKIP_DIRS = ['handles', 'files', 'docs', 'site-packages', 'node_modules', '__pycache__', '.cache', '.local', '.ipython', '.npm'];
export const FILES_ARC = '/tmp/__whiq_state.tar.gz';
export const VARS_ARC = '/tmp/__whiq_vars.tar.gz';
const PART = 8 * 1048576;

// The platform's snapshot code (e2bClient.ts), as it is there: it runs in the session's own kernel, every name a local of one function that is deleted after.
export const SNAPSHOT_FILES_PY = `
def __whiq_snap_files():
    import io, os, tarfile, json
    root = os.getcwd() if os.path.isdir(os.getcwd()) else os.path.expanduser('~')
    skip_dirs = set(${JSON.stringify(STATE_SKIP_DIRS)})
    out = '/tmp/__whiq_state.tar.gz'
    kept = []; skipped = []; total = 0
    with tarfile.open(out, 'w:gz') as tar:
        for dp, dns, fns in os.walk(root):
            dns[:] = [d for d in dns if d not in skip_dirs and not d.startswith('.')]
            for fn in fns:
                if fn.startswith('__whiq') or fn.startswith('.'): continue
                p = os.path.join(dp, fn); rel = os.path.relpath(p, root)
                try: tar.add(p, arcname=rel); total += os.path.getsize(p); kept.append(rel)
                except Exception as e: skipped.append({'path': rel, 'reason': type(e).__name__})
        m = json.dumps({'root': root, 'kept': len(kept), 'skipped': skipped[:50], 'bytes': total}).encode()
        ti = tarfile.TarInfo('.whiq-state-manifest.json'); ti.size = len(m); tar.addfile(ti, io.BytesIO(m))
    print('WHIQ_STATE', json.dumps({'files': len(kept), 'bytes': os.path.getsize(out)}))
try: __whiq_snap_files()
finally: del __whiq_snap_files
`;
export const SNAPSHOT_VARS_PY = `
def __whiq_snap_vars(g):
    import io, os, tarfile, json, pickle, types
    out = '/tmp/__whiq_vars.tar.gz'; tmp = '/tmp/__whiq_var.pkl'
    kept = []; skipped = []; defs = []
    with tarfile.open(out, 'w:gz') as tar:
        for k, v in list(g.items()):
            if k.startswith('_') or k in ${JSON.stringify(STATE_SKIP_VARS)} or isinstance(v, types.ModuleType): continue
            if isinstance(v, (types.FunctionType, type)):
                if getattr(v, '__module__', None) == '__main__': defs.append(k)
                continue
            if isinstance(v, types.BuiltinFunctionType): continue
            try:
                with open(tmp, 'wb') as f: pickle.dump(v, f, protocol=pickle.HIGHEST_PROTOCOL)
                tar.add(tmp, arcname=k + '.pkl'); kept.append(k)
            except Exception as e:
                skipped.append({'name': k, 'reason': type(e).__name__})
            finally:
                try: os.remove(tmp)
                except OSError: pass
        m = json.dumps({'vars': sorted(kept), 'skipped': skipped[:50], 'defs': sorted(defs)[:50]}).encode()
        ti = tarfile.TarInfo('.whiq-vars.json'); ti.size = len(m); tar.addfile(ti, io.BytesIO(m))
    print('WHIQ_VARS', json.dumps({'vars': len(kept), 'bytes': os.path.getsize(out)}))
try: __whiq_snap_vars(globals())
finally: del __whiq_snap_vars
`;
// The restore code is the platform's too; the one difference: the archive arrives as raw parts (/tmp/__whiq_*.bin.NNNNN), not as base64 text.
export const RESTORE_FILES_PY = `
def __whiq_restore_files():
    import os, tarfile, json, glob
    root = os.getcwd() if os.path.isdir(os.getcwd()) else os.path.expanduser('~')
    arc = '/tmp/__whiq_state.tar.gz'
    with open(arc, 'wb') as o:
        for pp in sorted(glob.glob('/tmp/__whiq_state.bin.*')):
            with open(pp, 'rb') as f: o.write(f.read())
            os.remove(pp)
    n = 0; lost = []; m = {}
    with tarfile.open(arc, 'r:gz') as tar:
        for mem in tar.getmembers():
            if mem.name == '.whiq-state-manifest.json':
                try: m = json.load(tar.extractfile(mem))
                except Exception: pass
                continue
            try:
                if hasattr(tarfile, 'data_filter'): tar.extract(mem, root, filter='data')
                else: tar.extract(mem, root)
                n += 1
            except Exception: lost.append(mem.name)
    os.remove(arc)
    print('WHIQ_RESTORED', json.dumps({'files': n, 'files_lost': (lost + [s['path'] for s in m.get('skipped', [])])[:30]}))
try: __whiq_restore_files()
finally: del __whiq_restore_files
`;
export const RESTORE_VARS_PY = `
def __whiq_restore_vars(g):
    import os, tarfile, json, glob, pickle
    arc = '/tmp/__whiq_vars.tar.gz'
    with open(arc, 'wb') as o:
        for pp in sorted(glob.glob('/tmp/__whiq_vars.bin.*')):
            with open(pp, 'rb') as f: o.write(f.read())
            os.remove(pp)
    back = []; lost = []; m = {}
    with tarfile.open(arc, 'r:gz') as tar:
        for mem in tar.getmembers():
            if mem.name == '.whiq-vars.json':
                try: m = json.load(tar.extractfile(mem))
                except Exception: pass
                continue
            if not mem.name.endswith('.pkl'): continue
            k = mem.name[:-4]
            try: g[k] = pickle.load(tar.extractfile(mem)); back.append(k)
            except Exception: lost.append(k)
    os.remove(arc)
    print('WHIQ_VARS_BACK', json.dumps({'vars': sorted(back), 'vars_lost': sorted(lost + [s['name'] for s in m.get('skipped', [])])[:30], 'defs': m.get('defs', [])}))
try: __whiq_restore_vars(globals())
finally: del __whiq_restore_vars
`;
const CLEANUP_PY = `
import os as __o
for __p in ('${FILES_ARC}', '${VARS_ARC}'):
    try: __o.remove(__p)
    except OSError: pass
del __o
`;

export interface SnapMeta {
  /** saved: both archives (or the files alone) are on disk. lost: it could not be saved (lost says why). dropped: it was saved and then deleted (lost says why). */
  status: 'saved' | 'lost' | 'dropped';
  at: number;
  /** why the session was ended, as the note words it */
  reason: string;
  lost?: string;
  hasVars?: boolean;
  /** the files were saved but the variables were not: why */
  varsLost?: string;
  files?: number;
  bytes?: number;
  /** a restore was tried and failed: it is kept (until it is old) and not tried again */
  restoreFailed?: string;
}

const list = (a: string[]): string => (a.length > 12 ? `${a.slice(0, 12).join(', ')} and ${a.length - 12} more` : a.join(', '));
const dur = (ms: number): string => (ms >= 7200_000 ? `${Math.round(ms / 3600_000)} h` : ms >= 120_000 ? `${Math.round(ms / 60_000)} min` : `${Math.round(ms / 1000)} s`);
const mbText = (n: number): string => `${Math.max(1, Math.round(n / 1048576))} MB`;

export class SnapshotStore {
  readonly dir: string;
  private readonly maxBytes: number;
  private readonly keepMs: number;
  private readonly log: (l: string) => void;
  constructor(dir: string, o: { maxBytes: number; keepMs: number; log: (l: string) => void }) {
    this.dir = dir; this.maxBytes = o.maxBytes; this.keepMs = o.keepMs; this.log = o.log;
    mkdirSync(dir, { recursive: true });
    for (const n of readdirSync(dir)) if (n.includes('.tmp-')) rmSync(join(dir, n), { recursive: true, force: true });   // a save the app died in
    this.sweep();
  }
  /** the most one snapshot may take (half the store: there is room for another) */
  get fileLimit(): number { return Math.floor(this.maxBytes / 2); }
  private key = (id: string): string => createHash('sha256').update(id).digest('hex');
  private at = (id: string): string => join(this.dir, this.key(id));
  path(id: string, name: string): string { return join(this.at(id), name); }

  meta(id: string): SnapMeta | null {
    try { return JSON.parse(readFileSync(join(this.at(id), 'meta.json'), 'utf8')) as SnapMeta; } catch { return null; }
  }
  remove(id: string): void { rmSync(this.at(id), { recursive: true, force: true }); }
  /** A fresh folder to write a snapshot into; `commit` puts it in place of any earlier one of the id, `abort` throws it away. */
  begin(id: string): { dir: string; commit(meta: SnapMeta): void; abort(): void } {
    const dir = `${this.at(id)}.tmp-${process.pid}-${Date.now().toString(36)}`;
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
    return {
      dir,
      commit: (meta) => { writeFileSync(join(dir, 'meta.json'), JSON.stringify(meta)); rmSync(this.at(id), { recursive: true, force: true }); renameSync(dir, this.at(id)); this.sweep(); },
      abort: () => rmSync(dir, { recursive: true, force: true }),
    };
  }
  /** Only a note is kept: nothing could be saved. */
  putNote(id: string, meta: SnapMeta): void { const b = this.begin(id); b.commit(meta); }
  markRestoreFailed(id: string, why: string): void {
    const m = this.meta(id);
    if (m) writeFileSync(join(this.at(id), 'meta.json'), JSON.stringify({ ...m, restoreFailed: why }));
  }

  /** Old snapshots are dropped after keepMs, the oldest when the store is over its size; the id is told on its next request. */
  sweep(): void {
    const now = Date.now();
    const entries: { name: string; meta: SnapMeta; size: number }[] = [];
    for (const name of readdirSync(this.dir)) {
      const d = join(this.dir, name);
      let meta: SnapMeta;
      try { meta = JSON.parse(readFileSync(join(d, 'meta.json'), 'utf8')) as SnapMeta; } catch { rmSync(d, { recursive: true, force: true }); continue; }
      if (meta.status !== 'saved') { if (now - meta.at > this.keepMs * 7) rmSync(d, { recursive: true, force: true }); continue; }
      let size = 0;
      for (const f of ['files.tar.gz', 'vars.tar.gz']) { try { size += statSync(join(d, f)).size; } catch { /* absent */ } }
      entries.push({ name, meta, size });
    }
    const drop = (e: { name: string; meta: SnapMeta }, why: string): void => {
      const d = join(this.dir, e.name);
      for (const f of ['files.tar.gz', 'vars.tar.gz']) rmSync(join(d, f), { force: true });
      writeFileSync(join(d, 'meta.json'), JSON.stringify({ ...e.meta, status: 'dropped', lost: why }));
      this.log(`snapshot ${e.name.slice(0, 8)}: dropped (${why})`);
    };
    for (const e of entries.slice()) if (now - e.meta.at > this.keepMs) { drop(e, `it was kept for ${dur(this.keepMs)} and then deleted`); entries.splice(entries.indexOf(e), 1); }
    let total = entries.reduce((a, e) => a + e.size, 0);
    entries.sort((a, b) => a.meta.at - b.meta.at);
    while (total > this.maxBytes && entries.length) { const e = entries.shift()!; drop(e, `the store of saved sessions was full (${mbText(this.maxBytes)}) and this was the oldest`); total -= e.size; }
  }
}

/** Why a session is ended, in the words the note uses. */
export interface EndReason { log: string; told: string }

/** Save the session's work before it is ended. Never throws: what it cannot save is written down as a note and the session is ended all the same. */
export async function saveSession(s: SandboxSession, store: SnapshotStore, why: EndReason, o: { timeoutMs: number; log: (l: string) => void }): Promise<void> {
  if (!s.hasState || !s.live) return;   // nothing was ever run or written here, or its Python is already gone (the run that lost it said so)
  const at = Date.now();
  const lostNote = (lost: string): void => { try { store.putNote(s.id, { status: 'lost', at, reason: why.told, lost }); } catch { /* the session ends all the same */ } };
  const builder = (() => { try { return store.begin(s.id); } catch (e) { lostNote(`the app could not write to its snapshot folder: ${(e as Error).message}`); return null; } })();
  if (!builder) return;
  try {
    const f = await s.runInternal(SNAPSHOT_FILES_PY, o.timeoutMs);
    const fm = /WHIQ_STATE (\{.*\})/.exec(f.stdout);
    if (f.error || !fm) { builder.abort(); lostNote(`its files could not be archived (${(f.error ?? f.stderr ?? 'no answer').toString().slice(0, 160)})`); return; }
    const fInfo = JSON.parse(fm[1]) as { files: number; bytes: number };
    if (fInfo.bytes > store.fileLimit) { builder.abort(); lostNote(`its files are ${mbText(fInfo.bytes)} packed, over the ${mbText(store.fileLimit)} a saved session may take`); return; }
    let remaining = store.fileLimit - fInfo.bytes;
    await pull(s, FILES_ARC, join(builder.dir, 'files.tar.gz'), fInfo.bytes);
    // the variables: a failure here costs only them (the files are kept)
    let hasVars = false;
    let varsLost: string | undefined;
    const v = await s.runInternal(SNAPSHOT_VARS_PY, o.timeoutMs);
    const vm = /WHIQ_VARS (\{.*\})/.exec(v.stdout);
    if (v.error || !vm) varsLost = `the archive of the variables failed (${(v.error ?? 'no answer').toString().slice(0, 160)})`;
    else {
      const vInfo = JSON.parse(vm[1]) as { bytes: number };
      if (vInfo.bytes > remaining) varsLost = `the variables are ${mbText(vInfo.bytes)} packed, over the ${mbText(store.fileLimit)} a saved session may take`;
      else { await pull(s, VARS_ARC, join(builder.dir, 'vars.tar.gz'), vInfo.bytes); hasVars = true; remaining -= vInfo.bytes; }
    }
    await s.runInternal(CLEANUP_PY, 30_000).catch(() => undefined);
    builder.commit({ status: 'saved', at, reason: why.told, hasVars, varsLost, files: fInfo.files, bytes: fInfo.bytes });
    o.log(`session ${s.id}: saved before it was ended (${fInfo.files} files, ${mbText(fInfo.bytes)}${hasVars ? ', variables' : ', no variables: ' + varsLost})`);
  } catch (e) {
    builder.abort();
    lostNote(`saving failed (${(e as Error).message.slice(0, 160)})`);
    o.log(`session ${s.id}: could not be saved: ${(e as Error).message}`);
  }
}

/** One archive out of the session, in parts, to a file. */
async function pull(s: SandboxSession, remote: string, local: string, expect: number): Promise<void> {
  const fd = openSync(local, 'w');
  try {
    for (let off = 0; ;) {
      const { size, bytes } = await s.readFile(remote, off, PART);
      if (size !== expect) throw new Error('the archive changed while it was read');
      if (!bytes.length) break;
      writeSync(fd, bytes);
      off += bytes.length;
      if (off >= size) break;
    }
  } finally { closeSync(fd); }
}

/** One archive from disk into the new session, as raw parts (the restore code joins them). */
async function push(s: SandboxSession, local: string, remote: string): Promise<void> {
  const fd = openSync(local, 'r');
  try {
    const buf = Buffer.alloc(PART);
    for (let i = 0; ; i++) {
      const n = readSync(fd, buf, 0, PART, null);
      if (n <= 0 && i > 0) break;
      await s.writeRaw([{ path: `${remote}.${String(i).padStart(5, '0')}`, data: Buffer.from(buf.subarray(0, Math.max(n, 0))) }]);
      if (n < PART) break;
    }
  } finally { closeSync(fd); }
}

/** What the new session of an id is told about the one it replaces; restores the saved work into `s` first. Never throws. Run once, after the Python is up. */
export async function restoreSession(s: SandboxSession, store: SnapshotStore, o: { log: (l: string) => void }): Promise<void> {
  const m = store.meta(s.id);
  if (!m) return;
  const when = new Date(m.at).toISOString().slice(11, 16) + ' UTC';
  const head = `[sandbox] This session was ended earlier (${m.reason}).`;
  if (m.status !== 'saved') {
    store.remove(s.id);
    s.lostNote = `${head} ${m.status === 'dropped' ? `Its saved state was then deleted (${m.lost}).` : `Its state could not be saved (${m.lost}).`} Python variables and files from before are gone; re-create what you need.`;
    return;
  }
  if (m.restoreFailed) { s.lostNote = `${head} Its saved state (${when}) could not be put back earlier (${m.restoreFailed}) and is not tried again. Python variables and files from before are gone; re-create what you need.`; return; }
  const fail = (what: string): void => {
    store.markRestoreFailed(s.id, what.slice(0, 200));
    s.lostNote = `${head} Its saved state (${when}) could not be put back (${what.slice(0, 200)}); it is kept on disk, not overwritten. Python variables and files from before are not here; re-create what you need.`;
    o.log(`session ${s.id}: restore failed: ${what}`);
  };
  try {
    await push(s, store.path(s.id, 'files.tar.gz'), '/tmp/__whiq_state.bin');
    const f = await s.runInternal(RESTORE_FILES_PY, 10 * 60_000, true);
    const fm = /WHIQ_RESTORED (\{.*\})/.exec(f.stdout);
    if (f.error || !fm) return fail(`its files: ${f.error ?? 'no answer'}`);
    const r = JSON.parse(fm[1]) as { files: number; files_lost: string[] };
    let v: { vars: string[]; vars_lost: string[]; defs: string[] } = { vars: [], vars_lost: [], defs: [] };
    if (m.hasVars) {
      await push(s, store.path(s.id, 'vars.tar.gz'), '/tmp/__whiq_vars.bin');
      const ve = await s.runInternal(RESTORE_VARS_PY, 10 * 60_000, true);
      const vm = /WHIQ_VARS_BACK (\{.*\})/.exec(ve.stdout);
      if (ve.error || !vm) return fail(`its variables: ${ve.error ?? 'no answer'}`);
      v = JSON.parse(vm[1]) as typeof v;
    }
    store.remove(s.id);
    const varsNote = v.vars.length ? ` and the variables ${list(v.vars)}` : m.hasVars ? ', no variables' : `, no variables (they could not be saved: ${m.varsLost ?? 'unknown'})`;
    s.lostNote = `${head} It was moved out of memory and put back from its snapshot of ${when}: ${r.files} file(s)${varsNote}. Work done after that snapshot is not in it.`
      + (v.vars_lost.length ? ` Not restored (pickle cannot carry them): ${list(v.vars_lost)} - re-create them.` : '')
      + (v.defs.length ? ` Functions and classes you defined are not carried: ${list(v.defs)} - define them again.` : '')
      + (r.files_lost.length ? ` Files that could not be saved or restored: ${list(r.files_lost)}.` : '')
      + ' Run your imports again.';
    o.log(`session ${s.id}: restored (${r.files} files, ${v.vars.length} variables)`);
  } catch (e) { fail((e as Error).message); }
}
