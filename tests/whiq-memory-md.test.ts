// The platform agent's Memory as Markdown files (WHIQ_MEMORY_DIR; vendor patches 05 and 06): the store itself (bundled fresh for
// every test, so each test starts a store of its own) and, through WhiqHost, a local chat that carries a project of the app's own.
// Runs only where the agent is fetched (node scripts/fetch-whiq-agent.mjs --install --build).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, rmSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import { WhiqHost } from '../main/whiq-host.ts';
import { fakeModel, type Req } from './e2e/fake-model.ts';

const vendor = join(import.meta.dirname, '..', 'vendor', 'whiq-agent');
const server = join(vendor, 'shared', 'chat-engine', 'server');
const fetched = existsSync(join(server, 'memoryMarkdown.ts')) && existsSync(join(vendor, 'node_modules'));
// the store is bundled with esbuild's command line, whose native binary is installed for this platform only (a Windows
// install under WSL's Linux has the Windows one)
const esbuildHere = existsSync(join(import.meta.dirname, '..', 'node_modules', '@esbuild', `${process.platform}-${process.arch}`));
const skip = !fetched ? 'platform agent not fetched with the Markdown memory patch' : !esbuildHere ? `esbuild is not installed for ${process.platform}-${process.arch}` : false;
const fwd = (p: string) => p.replace(/\\/g, '/');

// ── the store, bundled once (the app's server bundles it the same way), imported fresh per test ─────────────────────
type Item = Record<string, any>;
interface Store {
  initMemoryStore(): Promise<void>; syncMemoryFiles(): void; setMemoryProjectName(id: string, name?: string): void;
  addMemory(o: Record<string, unknown>): Item | null; updateMemory(id: string, p: Record<string, unknown>, by?: string): Item | null;
  supersedeMemory(id: string, n: Record<string, unknown>, by?: string): { old: Item; next: Item } | null;
  retireMemory(id: string, reason?: string, by?: string): Item | null; restoreMemory(id: string, by?: string): Item | null; forgetMemory(id: string, by?: string): boolean;
  getMemory(id: string): Item | undefined; listMemory(org?: string, user?: string, module?: string, more?: Record<string, unknown>): Item[];
  recallMemory(org: string | undefined, q: string, n?: number, user?: string, module?: string, more?: Record<string, unknown>): Item[];
  projectIntro(org: string | undefined, project: string | undefined): Item | undefined; initPaths(root: string): void;
}
let bundle: Promise<string> | null = null;
const bundled = () => bundle ??= (async () => {
  const dir = mkdtempSync(join(tmpdir(), 'whiq-mem-bundle-'));
  writeFileSync(join(dir, 'entry.ts'), `export * from '${fwd(join(server, 'memoryStore.ts'))}';\nexport { initPaths } from '${fwd(join(server, 'paths.ts'))}';\n`);
  const out = join(dir, 'store.mjs');
  // esbuild's command line (not its in-process service, which keeps the test process alive)
  execFileSync(process.execPath, [join(import.meta.dirname, '..', 'node_modules', 'esbuild', 'bin', 'esbuild'), join(dir, 'entry.ts'), '--bundle', '--platform=node', '--format=esm', `--outfile=${out}`, '--log-level=error', "--banner:js=import {createRequire as __cr} from 'node:module';const require=__cr(import.meta.url);"], { stdio: 'inherit' });
  return out;
})();
let n = 0;
/** A store of its own over `mem` (the Markdown folder; `rt` is the runtime folder memory.json lives in). */
async function open(mem: string, rt: string): Promise<Store> {
  process.env.WHIQ_MEMORY_DIR = mem; process.env.COWORK_RUNTIME_DIR = rt;
  const s = await import(`${pathToFileURL(await bundled()).href}?n=${++n}`) as Store;
  s.initPaths(rt);
  await s.initMemoryStore();
  return s;
}
const fresh = () => { const d = mkdtempSync(join(tmpdir(), 'whiq-mem-')); return { mem: join(d, 'Memory'), rt: join(d, 'runtime') }; };
const files = (dir: string) => (existsSync(dir) ? (readdirSync(dir, { recursive: true }) as string[]) : []).filter((f) => f.endsWith('.md')).map((f) => f.replace(/\\/g, '/')).sort();
/** what the store logs while `fn` runs */
async function logged<T>(fn: () => T | Promise<T>): Promise<{ out: T; log: string }> {
  const w = process.stderr.write.bind(process.stderr); let log = '';
  (process.stderr as any).write = (c: any, ...a: any[]) => { log += String(c); return typeof a[a.length - 1] === 'function' ? w(c, ...a) : true; };
  try { return { out: await fn(), log }; } finally { (process.stderr as any).write = w; }
}
const all = { includeInactive: true, allProjects: true };
const norm = (list: Item[]) => JSON.parse(JSON.stringify([...list].sort((a, b) => a.id.localeCompare(b.id))));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test('save, update, supersede, forget, restore and recall round-trip through the files, losslessly', { skip }, async () => {
  const { mem, rt } = fresh();
  const s = await open(mem, rt);
  s.setMemoryProjectName('p-tower', 'Tower A');
  const a = s.addMemory({ text: 'The client signs off drawings on Thursdays.', kind: 'fact', tags: ['Client', 'programme'], orgId: 'o1', authorId: 'u1', module: 'scheduler', sourceChatId: 'chat-1', expiresAt: '2027-01-01T00:00:00.000Z' })!;
  const b = s.addMemory({ text: 'Weekly look-ahead goes out on Mondays.\nSecond line: "quoted", with a colon.', kind: 'preference', orgId: 'o1', authorId: 'u1', module: 'scheduler' })!;
  const c = s.addMemory({ text: 'Use the 2026 calendar for the tower.', kind: 'decision', orgId: 'o1', authorId: 'u1', module: 'scheduler', projectId: 'p-tower' })!;
  const d = s.addMemory({ text: 'Old figure: payment terms are 30 days.', kind: 'fact', orgId: 'o1', authorId: 'u1', module: 'scheduler' })!;
  const e = s.addMemory({ text: 'Walk the site every Friday.', orgId: 'o1', authorId: 'u1', module: 'scheduler', tags: [] })!;   // no kind
  s.updateMemory(a.id, { text: 'The client signs off drawings on Fridays.', tags: ['client'] }, 'agent (scheduler)');
  const sup = s.supersedeMemory(d.id, { text: 'Payment terms are 45 days.' }, 'agent (scheduler)')!;
  s.retireMemory(b.id, 'no longer sent: "reason" with, commas', 'user');
  s.forgetMemory(e.id, 'user'); s.restoreMemory(e.id, 'user');
  s.syncMemoryFiles();
  const before = norm(s.listMemory('o1', 'u1', 'scheduler', all));
  assert.equal(before.length, 6);
  // a second store over the same folder (a restart) holds exactly the same entries
  const s2 = await open(mem, rt);
  assert.deepEqual(norm(s2.listMemory('o1', 'u1', 'scheduler', all)), before);
  assert.deepEqual(s2.getMemory(a.id)!.history!.map((h: Item) => h.action), ['written', 'edited']);
  assert.equal(s2.getMemory(a.id)!.history![1].text, 'The client signs off drawings on Thursdays.', 'the earlier words stay in the history');
  assert.equal(s2.getMemory(sup.next.id)!.history![0].by, 'agent (scheduler)');
  assert.equal(s2.getMemory(e.id)!.kind, undefined);
  // recall, as the tools do it: current entries only, this project plus the general ones
  assert.deepEqual(s2.recallMemory('o1', 'drawings', 8, 'u1', 'scheduler').map((m) => m.id), [a.id]);
  assert.deepEqual(s2.recallMemory('o1', 'calendar tower', 8, 'u1', 'scheduler', { projectId: 'p-tower' }).map((m) => m.id), [c.id]);
  assert.deepEqual(s2.recallMemory('o1', 'calendar tower', 8, 'u1', 'scheduler').map((m) => m.id), [], 'a project entry is not read from outside its project');
  assert.deepEqual(s2.recallMemory('o1', 'look-ahead', 8, 'u1', 'scheduler').map((m) => m.id), [], 'a retired entry is left out');
  assert.deepEqual(s2.recallMemory('o1', 'look-ahead', 8, 'u1', 'scheduler', { includeInactive: true }).map((m) => m.id), [b.id]);
});

test('files go in the right folders, with the exact front matter', { skip }, async () => {
  const { mem, rt } = fresh();
  const s = await open(mem, rt);
  s.setMemoryProjectName('p-1', 'Tower A: East/West');
  const fact = s.addMemory({ text: 'The client signs off drawings on Thursdays.', kind: 'fact', tags: ['client', 'programme'], orgId: 'o1', authorId: 'u1', module: 'scheduler' })!;
  s.addMemory({ text: 'Likes tables.', kind: 'preference', authorId: 'u1' });
  s.addMemory({ text: 'Jo Smith is the planner.', kind: 'party', authorId: 'u1' });
  s.addMemory({ text: 'Fixed price, signed in May.', kind: 'decision', authorId: 'u1' });
  s.addMemory({ text: 'Something else entirely.', kind: 'other', authorId: 'u1' });
  const proj = s.addMemory({ text: 'The tower uses the 2026 calendar.', kind: 'fact', authorId: 'u1', projectId: 'p-1', sourceChatId: 'chat-9' })!;
  const intro = s.addMemory({ text: 'Tower A is a 30-storey office building for Acme in Cairo. Key dates follow.', kind: 'intro', projectId: 'p-1' })!;
  const old = s.addMemory({ text: 'Retire this one.', kind: 'fact', authorId: 'u1' })!;
  const sup = s.supersedeMemory(intro.id, { text: 'Tower A is a 32-storey office building for Acme in Cairo. Key dates follow.' })!;
  s.retireMemory(old.id, 'wrong', 'user');
  s.syncMemoryFiles();
  assert.deepEqual(files(mem), [
    'General/Facts/The client signs off drawings on Thursdays.md',
    'General/Other/Something else entirely.md',
    'General/Decisions/Fixed price, signed in May.md',
    'General/People and parties/Jo Smith is the planner.md',
    'General/Preferences/Likes tables.md',
    'General/_Retired/Facts/Retire this one.md',
    'Tower A East West/Facts/The tower uses the 2026 calendar.md',
    'Tower A East West/Project introduction/Tower A is a 32-storey office building for Acme in Cairo.md',
    'Tower A East West/_Superseded/Project introduction/Tower A is a 30-storey office building for Acme in Cairo.md',
  ].sort());
  const at = fact.createdAt;
  assert.equal(readFileSync(join(mem, 'General', 'Facts', 'The client signs off drawings on Thursdays.md'), 'utf8'),
    `---\nid: ${fact.id}\nkind: fact\ntags: [client, programme]\nauthor: u1\nmodule: scheduler\norg: o1\ncreated: ${at}\nhistory:\n  - at: ${at}\n    by: agent\n    action: written\n---\n\nThe client signs off drawings on Thursdays.\n`);
  assert.equal(readFileSync(join(mem, 'Tower A East West', 'Facts', 'The tower uses the 2026 calendar.md'), 'utf8'),
    `---\nid: ${proj.id}\nkind: fact\nauthor: u1\nproject: p-1\nprojectName: "Tower A: East/West"\nsourceChat: chat-9\ncreated: ${proj.createdAt}\nhistory:\n  - at: ${proj.createdAt}\n    by: agent\n    action: written\n---\n\nThe tower uses the 2026 calendar.\n`);
  const retired = readFileSync(join(mem, 'General', '_Retired', 'Facts', 'Retire this one.md'), 'utf8');
  assert.match(retired, /\nretiredAt: \S+\nretiredReason: wrong\n/);
  assert.match(retired, /    action: retired\n    note: wrong\n---/);
  const superseded = readFileSync(join(mem, 'Tower A East West', '_Superseded', 'Project introduction', 'Tower A is a 30-storey office building for Acme in Cairo.md'), 'utf8');
  assert.match(superseded, new RegExp(`\\nsupersededAt: \\S+\\nsupersededBy: ${sup.next.id}\\n`));
  assert.equal(s.projectIntro(undefined, 'p-1')!.id, sup.next.id);
});

test('a name is kept across saves, and the project folder takes its name when the name arrives', { skip }, async () => {
  const { mem, rt } = fresh();
  const s = await open(mem, rt);
  const m = s.addMemory({ text: 'Project fact before the name is known.', kind: 'fact', projectId: 'p-late' })!;
  s.syncMemoryFiles();
  assert.deepEqual(files(mem), ['p-late/Facts/Project fact before the name is known.md']);
  s.setMemoryProjectName('p-late', 'Harbour Bridge');
  s.updateMemory(m.id, { text: 'Project fact, reworded after the name arrived.' });
  s.addMemory({ text: 'Second project fact.', kind: 'decision', projectId: 'p-late' });
  s.syncMemoryFiles();
  assert.deepEqual(files(mem), ['Harbour Bridge/Decisions/Second project fact.md', 'Harbour Bridge/Facts/Project fact before the name is known.md']);
  assert.ok(!existsSync(join(mem, 'p-late')), 'the emptied id folder is gone');
  const path = files(mem)[1];
  for (let i = 0; i < 4; i++) { s.updateMemory(m.id, { text: `Reworded ${i} times, the file keeps its name.` }); s.syncMemoryFiles(); }
  assert.equal(files(mem)[1], path, 'saving never renames');
  // a restart: the folder name is read back from the files; a hand-renamed folder is respected
  const s2 = await open(mem, rt);
  s2.setMemoryProjectName('p-late', 'Harbour Bridge');
  s2.addMemory({ text: 'Third project fact, after a restart.', kind: 'fact', projectId: 'p-late' });
  s2.syncMemoryFiles();
  assert.equal(files(mem).filter((f) => f.startsWith('Harbour Bridge/')).length, 3);
});

test('a text edit made by hand is picked up, and the earlier words go to the history', { skip }, async () => {
  const { mem, rt } = fresh();
  const s = await open(mem, rt);
  const m = s.addMemory({ text: 'The planner is Jo Smith.', kind: 'party', authorId: 'u1' })!;
  const o = s.addMemory({ text: 'Untouched memory.', kind: 'fact', authorId: 'u1' })!;
  s.syncMemoryFiles();
  const file = join(mem, 'General', 'People and parties', 'The planner is Jo Smith.md');
  writeFileSync(file, readFileSync(file, 'utf8').replace('The planner is Jo Smith.', 'The planner is Jo Smith-Jones, since March.').replace('tags: []\n', ''));
  const { log } = await logged(() => s.syncMemoryFiles());
  const got = s.getMemory(m.id)!;
  assert.equal(got.text, 'The planner is Jo Smith-Jones, since March.');
  assert.equal(got.history!.at(-1)!.action, 'edited');
  assert.equal(got.history!.at(-1)!.text, 'The planner is Jo Smith.');
  assert.ok(got.updatedAt);
  assert.equal(log, '');
  assert.deepEqual(s.recallMemory(undefined, 'Smith-Jones', 3, 'u1').map((x) => x.id), [m.id]);
  // the app's own next save keeps the hand edit and its history line
  s.syncMemoryFiles(); await sleep(300); s.syncMemoryFiles();
  assert.match(readFileSync(file, 'utf8'), /note: "edited in the file"/);
  assert.equal(s.getMemory(o.id)!.text, 'Untouched memory.');
  // a hand edit of the front matter: tags in the usual YAML shapes, an expiry
  writeFileSync(file, readFileSync(file, 'utf8').replace('kind: party\n', "kind: party\ntags:\n  - Client\n  - 'site visit'\nexpiresAt: 2099-01-01\n"));
  s.syncMemoryFiles();
  assert.deepEqual(s.getMemory(m.id)!.tags, ['Client', 'site visit']);
  assert.equal(s.getMemory(m.id)!.expiresAt, '2099-01-01');
  // and the watcher alone (no call into the store) brings a later edit in, shortly after
  writeFileSync(file, readFileSync(file, 'utf8').replace('since March.', 'since April, confirmed by the client.'));
  let seen = '';
  for (let i = 0; i < 30 && !/April/.test(seen); i++) { await sleep(200); seen = s.getMemory(m.id)!.text; }
  assert.match(seen, /since April/);
});

test('a file deleted by hand is a memory forgotten, and the rest are not touched', { skip }, async () => {
  const { mem, rt } = fresh();
  const s = await open(mem, rt);
  const a = s.addMemory({ text: 'First memory to keep.', kind: 'fact' })!;
  const b = s.addMemory({ text: 'Second memory to delete.', kind: 'fact' })!;
  s.syncMemoryFiles();
  unlinkSync(join(mem, 'General', 'Facts', 'Second memory to delete.md'));
  s.syncMemoryFiles();
  assert.equal(s.getMemory(b.id), undefined);
  assert.ok(s.getMemory(a.id));
  assert.deepEqual(s.recallMemory(undefined, 'delete', 5), []);
  assert.deepEqual(files(mem), ['General/Facts/First memory to keep.md']);
  assert.equal((await open(mem, rt)).getMemory(b.id), undefined, 'and it stays gone after a restart');
});

test('a memory folder that vanishes as a whole is not read as every memory deleted, and is written again', { skip }, async () => {
  const { mem, rt } = fresh();
  const s = await open(mem, rt);
  const a = s.addMemory({ text: 'First memory to keep.', kind: 'fact' })!;
  s.syncMemoryFiles();
  // a folder that vanishes as a whole (an unplugged drive) is not "everything deleted"
  rmSync(mem, { recursive: true, force: true });
  s.syncMemoryFiles();
  assert.ok(s.getMemory(a.id), 'kept in memory');
  s.updateMemory(a.id, { tags: ['again'] }); s.syncMemoryFiles(); await sleep(300); s.syncMemoryFiles();
  assert.deepEqual(files(mem), ['General/Facts/First memory to keep.md'], 'a removed folder is written again from memory');
});

test('a file that cannot be read as a memory is left exactly as it is, and logged once', { skip }, async () => {
  const { mem, rt } = fresh();
  const s = await open(mem, rt);
  s.addMemory({ text: 'A good memory.', kind: 'fact' });
  s.syncMemoryFiles();
  const bad: Record<string, string> = {
    'General/Facts/unclosed.md': '---\nid: mem-x1\nkind: fact\n\nThis front matter never closes.\n',
    'General/Facts/badline.md': '---\nid: mem-x2\nthis is not yaml at all\n---\n\nSome text for a memory.\n',
    'General/Other/badkind.md': '---\nid: mem-x3\nkind: banana\n---\n\nSome text for a memory.\n',
    'General/Other/empty.md': '',
    'General/Other/badhistory.md': '---\nid: mem-x4\nhistory:\n  - at: 2026-01-01\n    by: me\n    action: exploded\n---\n\nSome text for a memory.\n',
  };
  for (const [f, text] of Object.entries(bad)) { mkdirSync(join(mem, f, '..'), { recursive: true }); writeFileSync(join(mem, f), text); }
  const { log } = await logged(() => { s.syncMemoryFiles(); s.addMemory({ text: 'Another memory, saved later.', kind: 'fact' }); s.syncMemoryFiles(); s.syncMemoryFiles(); });
  for (const [f, text] of Object.entries(bad)) {
    assert.equal(readFileSync(join(mem, f), 'utf8'), text, `${f} untouched`);
    assert.equal(log.split('\n').filter((l) => l.startsWith('[memoryStore]')).join('\n').split(`${f.split('/').pop()} is not a memory file`).length - 1, 1, `${f} logged once`);
  }
  assert.match(log, /never closes|not closed/);
  assert.match(log, /banana/);
  assert.match(log, /exploded/);
  assert.equal(s.listMemory(undefined, undefined, undefined, all).length, 2, 'only the good ones are memories');
  // mended by hand, it comes in
  writeFileSync(join(mem, 'General/Other/badkind.md'), '---\nid: mem-x3\nkind: decision\n---\n\nMended: some text for a memory.\n');
  s.syncMemoryFiles();
  assert.equal(s.getMemory('mem-x3')!.kind, 'decision');
  // a restart does not lose or rewrite the bad ones either
  await open(mem, rt);
  assert.equal(readFileSync(join(mem, 'General/Facts/unclosed.md'), 'utf8'), bad['General/Facts/unclosed.md']);
});

test('a file added by hand, with or without front matter and without an id, becomes a memory and gets one', { skip }, async () => {
  const { mem, rt } = fresh();
  const s = await open(mem, rt);
  s.setMemoryProjectName('p-1', 'Tower A');
  s.addMemory({ text: 'Existing memory in the project.', kind: 'fact', projectId: 'p-1' });
  s.syncMemoryFiles();
  mkdirSync(join(mem, 'General', 'Decisions'), { recursive: true });
  writeFileSync(join(mem, 'General', 'Decisions', 'Plain note.md'), 'Just a note written in an editor, no front matter.\n');
  writeFileSync(join(mem, 'General', 'No id yet.md'), '---\nkind: preference\ntags: [style, reporting]\n---\n\nShort reports please.\n');
  writeFileSync(join(mem, 'Tower A', 'Facts', 'Project note.md'), 'A note dropped into the project folder.');
  s.syncMemoryFiles(); await sleep(300); s.syncMemoryFiles();
  const list = s.listMemory(undefined, undefined, undefined, all);
  assert.equal(list.length, 4);
  const plain = list.find((m) => m.text.startsWith('Just a note'))!;
  assert.match(plain.id, /^mem-/); assert.equal(plain.kind, 'decision', 'the kind from its folder');
  assert.equal(plain.history![0].note, 'added as a file');
  const noId = list.find((m) => m.text === 'Short reports please.')!;
  assert.equal(noId.kind, 'preference'); assert.deepEqual(noId.tags, ['style', 'reporting']);
  assert.equal(list.find((m) => m.text.startsWith('A note dropped'))!.projectId, 'p-1', 'a note in a project folder belongs to the project');
  // the id is written into the file, in place (the file keeps its name and folder)
  assert.match(readFileSync(join(mem, 'General', 'Decisions', 'Plain note.md'), 'utf8'), new RegExp(`^---\\nid: ${plain.id}\\n`));
  assert.match(readFileSync(join(mem, 'General', 'No id yet.md'), 'utf8'), new RegExp(`\\nid: ${noId.id}\\n`));
  assert.equal(files(mem).length, 4, files(mem).join(' | '));
  // a copied file is a new memory, not the same id twice
  writeFileSync(join(mem, 'General', 'Copy of plain.md'), readFileSync(join(mem, 'General', 'Decisions', 'Plain note.md'), 'utf8'));
  s.syncMemoryFiles(); await sleep(300); s.syncMemoryFiles();
  const copy = s.listMemory(undefined, undefined, undefined, all);
  assert.equal(copy.length, 5);
  assert.equal(new Set(copy.map((m) => m.id)).size, 5);
});

test('memory.json is imported once when the folder is empty, then set aside as .imported', { skip }, async () => {
  const { mem, rt } = fresh();
  mkdirSync(rt, { recursive: true });
  const items = [
    { id: 'mem-old1', text: 'An old fact from the JSON store.', kind: 'fact', createdAt: '2026-03-01T10:00:00.000Z', authorId: 'u1', module: 'scheduler', orgId: 'o1', tags: ['client'], history: [{ at: '2026-03-01T10:00:00.000Z', by: 'agent', action: 'written' }] },
    { id: 'mem-old2', text: 'A retired decision from the JSON store.', kind: 'decision', createdAt: '2026-03-02T10:00:00.000Z', retiredAt: '2026-04-01T00:00:00.000Z', retiredReason: 'forgotten', history: [] },
    { id: 'mem-old3', text: 'A project entry from the JSON store.', kind: 'intro', createdAt: '2026-03-03T10:00:00.000Z', projectId: 'p-9', sourceChatId: 'chat-3', updatedAt: '2026-03-04T10:00:00.000Z' },
    { id: 'mem-old4', text: 'A legacy entry with no kind at all.', createdAt: '2026-03-05T10:00:00.000Z' },
  ];
  writeFileSync(join(rt, 'memory.json'), JSON.stringify({ version: 1, items }, null, 2));
  const { out: s, log } = await logged(() => open(mem, rt));
  assert.match(log, /4 memories moved from memory.json/);
  assert.ok(!existsSync(join(rt, 'memory.json')) && existsSync(join(rt, 'memory.json.imported')));
  assert.deepEqual(norm(s.listMemory(undefined, undefined, undefined, all)), norm(items as Item[]));
  assert.deepEqual(files(mem).map((f) => f.split('/').slice(0, -1).join('/')).sort(), ['General/Facts', 'General/Other', 'General/_Retired/Decisions', 'p-9/Project introduction']);
  const again = await open(mem, rt);
  assert.deepEqual(norm(again.listMemory(undefined, undefined, undefined, all)), norm(items as Item[]), 'a restart reads the files, not the JSON');
  // not imported again over a folder that has memories: a memory.json that turns up later is left alone
  writeFileSync(join(rt, 'memory.json'), JSON.stringify({ version: 1, items: [{ id: 'mem-late', text: 'A late JSON entry.', createdAt: '2026-05-01T00:00:00.000Z' }] }));
  const third = await open(mem, rt);
  assert.equal(third.getMemory('mem-late'), undefined);
  assert.ok(existsSync(join(rt, 'memory.json')));
  // and with the variable unset the store is the JSON store it always was
  delete process.env.WHIQ_MEMORY_DIR;
  const plain = await import(`${pathToFileURL(await bundled()).href}?n=${++n}`) as Store;
  plain.initPaths(rt); await plain.initMemoryStore();
  assert.equal(plain.getMemory('mem-late')!.text, 'A late JSON entry.');
  assert.equal(plain.getMemory('mem-old1'), undefined);
});

test('titles that Windows cannot take become safe, unique file names that stay put', { skip }, async () => {
  const { mem, rt } = fresh();
  const s = await open(mem, rt);
  const texts = [
    'CON', 'aux.txt is a device name', 'COM1 port notes', 'NUL: nothing here', 'a<b>c:d|e?f*g"h/i\\j file',
    'Ends with a dot...', 'Ends with spaces and dots . . .   ', '...Starts with dots', `${'Very long title words '.repeat(30)}end`,
    'Ünïcödé ñame — and 日本語 and emoji 🚀🚀🚀 in the title', 'Same first words, different ending one', 'Same first words, different ending one',
    'LPT9', '   leading spaces', '# Heading as the title', '**Bold start** with *markup*', 'COM¹ superscript device',
  ];
  const added = texts.map((t, i) => s.addMemory({ text: t + (i === 11 ? ' (but not the same text)' : ''), kind: 'fact' })!).filter(Boolean);
  s.syncMemoryFiles();
  const names = files(mem).map((f) => f.split('/').pop()!);
  assert.equal(names.length, added.length);
  assert.equal(new Set(names.map((x) => x.toLowerCase())).size, names.length, 'unique within the folder, case-insensitively');
  for (const name of names) {
    const stem = name.slice(0, -3);
    assert.doesNotMatch(name, /[\\/:*?"<>|\u0000-\u001f]/, `${name}: no forbidden characters`);
    assert.doesNotMatch(stem, /[. ]$/, `${name}: no trailing dot or space`);
    assert.doesNotMatch(stem, /^\./, `${name}: not hidden`);
    assert.doesNotMatch(stem.split('.')[0].trim(), /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])$/i, `${name}: not a device`);
    assert.ok(stem.length > 0 && name.length <= 70, `${name}: a sensible length`);
  }
  assert.ok(names.some((x) => /^Same first words, different ending one \(2\)\.md$/.test(x)) || names.filter((x) => x.startsWith('Same first words')).length === 2);
  // every one is readable back and stays where it is through edits and a restart
  const before = files(mem);
  for (const m of added) s.updateMemory(m.id, { text: `${m.text} - reworded` });
  s.syncMemoryFiles();
  assert.deepEqual(files(mem), before, 'edits do not rename');
  const s2 = await open(mem, rt);
  assert.equal(s2.listMemory(undefined, undefined, undefined, all).length, added.length);
  s2.updateMemory(added[0].id, { text: 'CON - reworded again' }); s2.syncMemoryFiles();
  assert.deepEqual(files(mem), before, 'nor after a restart');
});

// ── the agent server: a local chat that carries a project of the app's own ─────────────────────────────────────────
const installed = existsSync(join(vendor, '03 Shared Platform Agents', 'app', 'server.dist.mjs'));
const rebuilt = installed && /localProjectId/.test(readFileSync(join(vendor, '03 Shared Platform Agents', 'app', 'server.dist.mjs'), 'utf8'))
  // installed for THIS platform (the agent's packages carry native parts, as in whiq-host.test.ts)
  && existsSync(join(vendor, 'node_modules', '@napi-rs')) && readdirSync(join(vendor, 'node_modules', '@napi-rs')).some((d) => d.startsWith(`canvas-${process.platform}-${process.arch}`));

test('a local chat with localProjectId scopes memory and the project introduction, and keeps its own working folder', { skip: !rebuilt && 'platform agent not built with the local-projects patch', timeout: 240_000 }, async () => {
  const offered = (r: Req, name: string) => (r.tools ?? []).some((t) => t.function.name === name);
  const done = (r: Req) => r.messages.filter((m) => m.role === 'tool').length;
  const fake = await fakeModel((r) => {
    if (!offered(r, 'load_tools')) return { text: 'ok' };
    const k = done(r);
    if (k === 0) return { call: 'load_tools', args: { names: ['save_memory', 'project_intro', 'recall_memory'] } };
    if (k === 1) return { call: 'save_memory', args: { text: 'The tower uses the 2026 working calendar.', kind: 'fact', about: 'this_project' } };
    if (k === 2) return { call: 'save_memory', args: { text: 'Always send the weekly look-ahead on Mondays.', kind: 'preference', about: 'general' } };
    if (k === 3) return { call: 'project_intro', args: { action: 'write', text: 'Tower A is a thirty-storey office building in Cairo for Acme. Our role is planning and progress control. The contract is a fixed price lump sum.' } };
    if (k === 4) return { call: 'recall_memory', args: { query: 'calendar' } };
    return { text: 'Done.' };
  });
  const data = mkdtempSync(join(tmpdir(), 'whiq-host-'));
  const mem = join(data, 'Memory');
  const was = process.env.WHIQ_MEMORY_DIR;
  process.env.WHIQ_MEMORY_DIR = mem;
  const host = new WhiqHost({ vendor, data, logs: join(data, 'logs') }, () => ({
    providers: [{ name: 'main', type: 'openai-compat', baseUrl: fake.url, key: 'sk-test-not-a-real-key' }],
    tiers: [{ name: 'Strong', provider: 'main', model: 'fake-1' }],
  }));
  try {
    // a Database project is still refused (there is no Database), a local one is not
    await assert.rejects(host.api('POST', '/api/chats', { title: 't', module: 'scheduler', projectId: 'p-db' }), /database|unreachable/i);
    const chat = await host.api('POST', '/api/chats', { title: 'tower', module: 'scheduler', trustMode: 'act-auto', localProjectId: 'p-tower', localProjectName: 'Tower A' }) as Record<string, any>;
    assert.equal(chat.localProjectId, 'p-tower'); assert.equal(chat.localProjectName, 'Tower A');
    assert.equal(chat.projectId, undefined, 'it is not a Database project');
    const wd = mkdtempSync(join(tmpdir(), 'whiq-wd-'));
    await host.api('POST', '/api/working-dir/set', { chatId: chat.id, path: wd });
    const events: Array<{ type: string }> = [];
    const stop = await host.stream(chat.id, (e) => events.push(e));
    await host.api('POST', '/api/agent/send', { chatId: chat.id, content: 'Remember what you learned about this project.' });
    for (let i = 0; i < 240 && !events.some((e) => e.type === 'done'); i++) await sleep(500);
    stop();
    assert.ok(events.some((e) => e.type === 'done'), `no done event: ${events.map((e) => e.type).join(', ')}`);
    const after = await host.api('GET', `/api/chats/${chat.id}`) as Record<string, any>;
    assert.equal(after.workingDir, wd, 'a local project chat keeps its own working folder (no bucket mirror)');
    assert.equal(after.projectId, undefined);
    for (let i = 0; i < 40 && files(mem).length < 3; i++) await sleep(250);   // the server saves a moment after the turn
    const found = files(mem); const why = `files: ${found.join(',')}; model calls: ${fake.requests.map((r) => (r.tools ?? []).length + ':' + String(r.messages.at(-1)?.content ?? '').slice(0, 60)).join(' / ')}; events: ${events.map((e: any) => JSON.stringify(e).slice(0, 300)).join(',')}`;
    assert.ok(found.some((f) => /^Tower A\/Facts\/The tower uses the 2026 working calendar\.md$/.test(f)), why);
    assert.ok(found.some((f) => /^General\/Preferences\/Always send the weekly look-ahead on Mondays\.md$/.test(f)), why);
    assert.ok(found.some((f) => /^Tower A\/Project introduction\/Tower A is a thirty-storey office building in Cairo for.md$/.test(f)), why);
    const fm = readFileSync(join(mem, 'Tower A', 'Facts', 'The tower uses the 2026 working calendar.md'), 'utf8');
    assert.match(fm, /\nproject: p-tower\nprojectName: "Tower A"\n/);
    assert.match(fm, new RegExp(`sourceChat: ${chat.id}\\n`));
    // the introduction is in the prompt of the next turn, the recall found only this project's entry
    const sawIntro = fake.requests.some((r) => JSON.stringify(r.messages).includes('This project — its introduction'));
    assert.ok(sawIntro || done(fake.requests.at(-1)!) > 0);
    const recalled = JSON.stringify(fake.requests.at(-1)!.messages.filter((m) => m.role === 'tool').at(-1));
    assert.match(recalled, /working calendar/);
    assert.match(recalled, /this project/);
    // moving the chat out of its project, and into another
    const out = await host.api('PATCH', `/api/chats/${chat.id}`, { localProjectId: '' }) as Record<string, any>;
    assert.equal(out.localProjectId, undefined); assert.equal(out.localProjectName, undefined);
    const into = await host.api('PATCH', `/api/chats/${chat.id}`, { localProjectId: 'p-bridge', localProjectName: 'Harbour Bridge' }) as Record<string, any>;
    assert.equal(into.localProjectId, 'p-bridge');
  } finally {
    if (was === undefined) delete process.env.WHIQ_MEMORY_DIR; else process.env.WHIQ_MEMORY_DIR = was;
    host.stop();
    fake.close();
    await sleep(1000);   // the servers end
  }
});

