// Reading another tool's 4D file into the import format (Node only: the MCP server and the desktop main process).
import { parseIfc4d, parseSearchSets, parseTimelinerCsv, sheetToCsv, type Imported4d } from './exchange4d.ts';
import { readNwfTimeliner } from './nwf.ts';
import type { SynchroFile } from './synchro.ts';
import { readXlsx } from '../excel/xlsx.ts';

/** Read a 4D file of another tool, by its content: Navisworks .nwf/.nwd (TimeLiner), SYNCHRO .sp, IFC 4D, a search-set
 *  XML, a TimeLiner grid in .xlsx, else a TimeLiner CSV. */
export async function readImport4d(path: string, bytes: Uint8Array): Promise<Imported4d> {
  const head = Buffer.from(bytes.subarray(0, 2000)).toString('latin1');
  if (head.startsWith('#LcUStream')) { const n = readNwfTimeliner(bytes); return { source: 'nwf', tasks: n.tasks.map((t) => ({ name: t.name, id: t.name, start: t.plannedStart ?? undefined, finish: t.plannedFinish ?? undefined, actualStart: t.actualStart ?? undefined, actualFinish: t.actualFinish ?? undefined, type: t.type, attached: t.attached[0] })), links: [], notes: n.notes }; }
  if (/\.sp$/i.test(path)) { const { readSynchro } = await import('./synchro.ts'); return synchroToImport(readSynchro(bytes)); }
  if (/^ISO-10303-21/m.test(head.slice(0, 200))) return parseIfc4d(Buffer.from(bytes).toString('latin1'));
  if (/<exchange\b/.test(head) || /<exchange\b/.test(xmlText(bytes.subarray(0, 4000)))) return parseSearchSets(xmlText(bytes));
  if (/\.xlsx$/i.test(path)) return parseTimelinerCsv(sheetToCsv((await readXlsx(bytes))[0]?.rows ?? []));
  return parseTimelinerCsv(Buffer.from(bytes).toString('utf8'));
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
