// Reading another tool's 4D file into the import format (Node only: the MCP server and the desktop main process).
import { parseIfc4d, parseSearchSets, parseTimelinerCsv, sheetToCsv, type Imported4d } from './exchange4d.ts';
import type { SynchroFile } from './synchro.ts';
import { readXlsx } from '../excel/xlsx.ts';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { inWorker } from './jobWorker.ts';
import { read4dWorkerPath } from './runtime.ts';

/** readImport4d in a process of its own (read4dWorker.ts), watched like the other workers: a reader that is stuck ends only itself and
 *  this call, with the reason. Without the worker (an Electron app without the bundle) it runs here. */
export async function readImport4dWatched(path: string): Promise<Imported4d> {
  const worker = read4dWorkerPath();
  if (!worker) return readImport4d(path, new Uint8Array(readFileSync(path)));
  return inWorker({ script: worker, job: { path }, what: 'The 4D file reader', tried: 'one pass of the reader over the file in a process of its own', next: 'export the schedule from the source tool in another format (a TimeLiner CSV, a Navisworks search-set XML, an IFC 4D) or in smaller parts, and import that' },
    (dir) => JSON.parse(readFileSync(join(dir, 'result.json'), 'utf8')) as Imported4d);
}

/** Read a 4D file of another tool, by its content: Navisworks .nwf/.nwd (TimeLiner), SYNCHRO .sp, IFC 4D, a search-set
 *  XML, a TimeLiner grid in .xlsx, else a TimeLiner CSV. */
export async function readImport4d(path: string, bytes: Uint8Array): Promise<Imported4d> {
  const head = Buffer.from(bytes.subarray(0, 2000)).toString('latin1');
  if (head.startsWith('#LcUStream')) return navisworksToImport(path);
  if (/\.sp$/i.test(path)) { const { readSynchro } = await import('./synchro.ts'); return synchroToImport(readSynchro(bytes)); }
  if (/^ISO-10303-21/m.test(head.slice(0, 200))) return parseIfc4d(Buffer.from(bytes).toString('latin1'));
  if (/<exchange\b/.test(head) || /<exchange\b/.test(xmlText(bytes.subarray(0, 4000)))) return parseSearchSets(xmlText(bytes));
  if (/\.xlsx$/i.test(path)) return parseTimelinerCsv(sheetToCsv((await readXlsx(bytes))[0]?.rows ?? []));
  // anything else must be a TimeLiner CSV: a file without its Name column (or not text at all) is refused, not read as
  // an empty schedule
  const csv = parseTimelinerCsv(Buffer.from(bytes).toString('utf8'));
  if (!csv.tasks.length && (bytes.subarray(0, 4000).includes(0) || csv.notes.some((n) => /No "Name" column/.test(n)))) throw new Error('not a 4D file this reads (IFC 4D, search-set XML, TimeLiner CSV or .xlsx, Navisworks .nwf/.nwd, SYNCHRO .sp)');
  return csv;
}

/** A Navisworks TimeLiner as the import format: the tasks (planned dates as the schedule, actual dates kept), each
 *  attached to its selection set, or to a set made for it ("TimeLiner: <task>") when it has an explicit selection or
 *  several sets; the sets as the GlobalIds of the elements they select. */
export async function navisworksToImport(path: string): Promise<Imported4d> {
  const { readNavisworksTimeliner } = await import('./nwd.ts');
  const n = readNavisworksTimeliner(path);
  const sets = new Map(n.sets.map((s) => [s.name, s.guids] as const)), made: NonNullable<Imported4d['sets']> = [];
  // a summary task (an imported schedule's root, a parent) is its children's span: not an activity of its own, unless
  // it carries a selection
  const summaries = n.tasks.filter((t) => t.children > 0 && !t.items.length && !t.sets.length).map((t) => t.name);
  const tasks = n.tasks.flatMap((t, i) => (t.children > 0 && !t.items.length && !t.sets.length ? [] : [[t, i] as const])).map(([t, i]) => {
    let attached: string | undefined = t.sets[0];
    if (t.items.length || t.sets.length > 1) {
      let name = `TimeLiner: ${t.name}`;
      for (let k = 2; sets.has(name) || made.some((m) => m.name === name); k++) name = `TimeLiner: ${t.name} (${k})`;
      made.push({ name, conditions: [], guids: [...new Set([...(n.taskGuids[i] ?? []), ...t.sets.flatMap((s) => sets.get(s) ?? [])])] });
      attached = name;
    }
    return { name: t.name, id: t.name, start: t.plannedStart ?? undefined, finish: t.plannedFinish ?? undefined, actualStart: t.actualStart ?? undefined, actualFinish: t.actualFinish ?? undefined, type: t.type, attached };
  });
  const resolved = n.sets.filter((s): s is { name: string; guids: string[] } => s.guids !== null).map((s) => ({ name: s.name, conditions: [], guids: s.guids }));
  return { source: /\.nwf$/i.test(path) ? 'nwf' : 'nwd', tasks, links: [], sets: [...resolved, ...made], notes: [...n.notes, ...(summaries.length ? [`Summary tasks left out (their children are the activities): ${summaries.slice(0, 10).join(', ')}.`] : [])] };
}

/** XML text by its byte-order mark, else the encoding its declaration names, else UTF-8 (what Navisworks and the
 *  clone write; reading it as latin1 garbled "—" and Arabic set names, so set_name links did not match). */
export function xmlText(bytes: Uint8Array): string {
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) return new TextDecoder('utf-8').decode(bytes.subarray(3));
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder('utf-16le').decode(bytes.subarray(2));
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder('utf-16be').decode(bytes.subarray(2));
  const decl = /^\s*<\?xml[^>]*\bencoding\s*=\s*["']([A-Za-z0-9._-]+)["']/.exec(Buffer.from(bytes.subarray(0, 200)).toString('latin1'));
  try { return new TextDecoder(decl?.[1] ?? 'utf-8').decode(bytes); } catch { return new TextDecoder('utf-8').decode(bytes); }
}

/** A SYNCHRO project as the import format: its work tasks (summaries left out) and the 3D objects assigned to them,
 *  matched to the design model by the "(#id)" SYNCHRO puts in their names. */
export function synchroToImport(sp: SynchroFile): Imported4d {
  const work = sp.tasks.filter((t) => !t.isSummary), byUuid = new Map(work.map((t) => [t.uuid, t])), res = new Map(sp.resources.map((r) => [r.uuid, r.name]));
  const links = new Map<string, { task: string; expressIds: number[] }>();
  let unnamed = 0;
  for (const a of sp.assignments) {
    const t = byUuid.get(a.task), m = /\(#(\d+)\)/.exec(res.get(a.resource) ?? '');
    if (!t) continue;
    if (!m) { unnamed++; continue; }
    (links.get(t.uuid) ?? links.set(t.uuid, { task: t.id || t.name, expressIds: [] }).get(t.uuid)!).expressIds.push(Number(m[1]));
  }
  const notes = [...sp.notes, ...(unnamed ? [`${unnamed} assigned resources carry no "(#id)" of a design model element and were not linked.`] : [])];
  return { source: 'synchro', tasks: work.map((t) => ({ name: t.name, id: t.id || t.name, start: t.start ?? undefined, finish: t.finish ?? undefined, actualStart: t.actualStart ?? undefined, actualFinish: t.actualFinish ?? undefined })), links: [...links.values()], notes };
}
