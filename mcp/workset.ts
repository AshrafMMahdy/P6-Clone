// What a call holds while it runs, beside the project it works on: reserved in the memory budget before the call
// starts, so a call that cannot fit is refused up front, in words, and never runs the server out of heap (audit C1).
// Measured on the hosted budget (a 68 MB XER of 79,982 activities, 226,849 links, Session.bytes 204 MB; heap 2048 MB):
// what the call holds live at its peak beyond the open project (the largest heap left after a full collection, with
// half again as margin), or for a call that ends before a full collection, what its process grew by; per byte of the
// project's own estimate (Session.bytes), plus per activity and iteration where it has those. Garbage between
// collections is not reserved: the budget stays at least 512 MB under the heap limit (effectiveBudget) for it.
import type { Session } from './runtime.ts';

export interface WorkNeed { bytes: number; what: string; hint: string }
interface Work { per: number; fixed?: number; label: string; hint: string }

const MB = 1048576;
/** The tools whose working set is larger than a few MB on a big schedule. per: bytes per byte of Session.bytes. */
export const WORK: Record<string, Work> = {
  schedule: { per: 1.0, label: 'Scheduling', hint: 'close other projects first' },
  lint: { per: 1.0, label: 'Lint', hint: 'pass checks to run fewer checks, or simulate: false' },
  dcma_14: { per: 1.0, label: 'The DCMA 14-point check', hint: 'close other projects first' },
  check_schedule: { per: 0.5, label: 'check_schedule', hint: 'close other projects first' },
  review: { per: 1.0, label: 'review', hint: 'close other projects first' },
  float_paths: { per: 0.5, label: 'float_paths', hint: 'close other projects first' },
  crash_schedule: { per: 1.8, label: 'crash_schedule', hint: 'lower max_steps' },
  level_resources: { per: 1.2, label: 'Resource levelling', hint: 'pass resources to level fewer' },
  evaluate_batch: { per: 1.8, label: 'evaluate_batch', hint: 'pass fewer scenarios' },
  optimize_schedule: { per: 1.0, label: 'optimize_schedule', hint: 'pass project to optimise one project' },
  tia: { per: 1.8, label: 'The time impact analysis', hint: 'close other projects first' },
  windows_analysis: { per: 1.2, label: 'windows_analysis', hint: 'pass fewer updates' },
  export_excel: { per: 2.0, label: 'export_excel', hint: 'pass project to export one project' },
  export_pdf: { per: 1.0, label: 'export_pdf', hint: 'print a filtered layout (fewer rows), or export to .html' },
  run_report: { per: 1.0, label: 'run_report', hint: 'filter the report to fewer rows' },
  monte_carlo: { per: 0.9, label: 'Monte Carlo', hint: 'run fewer iterations' },
};
/** save: by format (P6 XML and MSPDI are written as they are made). */
const SAVE: Record<string, Work> = {
  xer: { per: 1.0, label: 'Saving as XER', hint: 'save one project at a time (project)' },
  p6xml: { per: 0.5, label: 'Saving as P6 XML', hint: 'save one project at a time (project)' },
  mspdi: { per: 1.4, label: 'Saving as Microsoft Project XML', hint: 'save as XER or P6 XML' },
  mpx: { per: 1.0, label: 'Saving as MPX', hint: 'save as XER or P6 XML' },
};
/** Monte Carlo's samples per activity per iteration: its early finish (4 bytes) and, when it varies, its duration (8). */
export const MC_BYTES_PER_SAMPLE = 12;

/** What reading a file peaks at, per byte of the file (the text, the element being read, the rows, the import checks;
 *  measured on the hosted budget: an XER 5.4-6.7x (most of it the import checks' scheduling pass), read a chunk at a time; a 215 MB P6 XML 5.8x and a 137 MB MSPDI
 *  10.4-12.5x, each read element by element (8x and 16x as whole trees); an MSPDI keeps every element's own text for the
 *  save that merges back into it). The part above the project's own estimate is reserved while the file is read. */
export const READ_PEAK: Record<string, number> = { xer: 6, xml: 6.5, mspdi: 12.5, mpp: 12.5, mpx: 6 };
export const readPeak = (format: string, bytes: number) => Math.round((READ_PEAK[format] ?? 5.5) * bytes + 8 * MB);

/** The activities the work runs on: the file's projects, not the baselines stored in it */
const activities = (s: Session) => {
  const bl = new Set((s.db.tables.PROJECT?.rows ?? []).filter((p) => p._baseline_of).map((p) => p.proj_id));
  let n = 0;
  for (const t of s.db.tables.TASK?.rows ?? []) if (!bl.has(t.proj_id)) n++;
  return n;
};
const mbs = (b: number) => `${Math.round(b / MB)} MB`;

/** The memory a call on this project needs besides the project itself; null for a call that needs little. */
export function workNeed(tool: string, a: Record<string, any>, s: Session, free: () => number): WorkNeed | null {
  const n = activities(s);
  if (tool === 'save') {
    const path = String(a.path ?? s.path ?? '');
    const fmt = String(a.format ?? (/\.mpx$/i.test(path) ? 'mpx' : /\.xml$/i.test(path) ? 'p6xml' : 'xer')).toLowerCase();
    const w = SAVE[fmt === 'xml' ? 'p6xml' : fmt];
    return w ? { bytes: Math.round(w.per * s.bytes + (w.fixed ?? 0)), what: `${w.label} (${n.toLocaleString('en-US')} activities)`, hint: w.hint } : null;
  }
  const w = WORK[tool];
  if (!w) return null;
  let bytes = w.per * s.bytes + (w.fixed ?? 0), what = `${w.label} on this project (${n.toLocaleString('en-US')} activities)`, hint = w.hint;
  if (tool === 'monte_carlo') {
    const it = Math.min(20000, Math.max(10, Math.floor(Number(a.iterations) || 1000))); // as monte_carlo runs it
    bytes += n * it * MC_BYTES_PER_SAMPLE;
    // how many iterations would fit in what is free now
    const fit = Math.floor((free() - w.per * s.bytes) / Math.max(1, n * MC_BYTES_PER_SAMPLE));
    what = `Monte Carlo of ${n.toLocaleString('en-US')} activities × ${it.toLocaleString('en-US')} iterations`;
    hint = fit >= 50 ? `run at most ${fit.toLocaleString('en-US')} iterations (iterations), which fit in the ${mbs(Math.max(0, free()))} free now` : 'run it on fewer activities (a narrower project)';
  }
  return { bytes: Math.round(bytes), what, hint };
}
