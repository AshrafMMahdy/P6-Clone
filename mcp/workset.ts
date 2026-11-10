// What a call holds while it runs, beside the project it works on: reserved in the memory budget before the call
// starts, so a call that cannot fit is refused up front, in words, and never runs the server out of heap (audit C1).
// Measured on the hosted budget (a 68 MB XER of 79,982 activities, 226,849 links, Session.bytes 204 MB; heap 2048 MB):
// what the call holds live at its peak beyond the open project (the largest heap left after a full collection, with
// half again as margin), or for a call that ends before a full collection, what its process grew by; per byte of the
// project's own estimate (Session.bytes), plus per activity and iteration where it has those. Garbage between
// collections is not reserved: the budget stays at least 512 MB under the heap limit (effectiveBudget) for it.
import { countArg, fail, type Session } from './runtime.ts';
import { betweenTails } from '../core/schedule/floatPaths.ts';

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
  // the reasoner: the model's runtime and one window of 512 activities (fixed), and beside the project the instance, two scratch copies
  // for the P6 leveler comparison and every activity's dates three ways. Measured through the tool (the whole process, less the 175 to
  // 196 MB it held with the file open): 129 trial (1,299 activities) 250 MB, Zone 2 (3,353) 270 MB, DHBL (5,608) 420 MB, JWM (11,425;
  // counted here as 23 MB) 400 to 420 MB. 1.0 x the project reserved 23 MB for JWM.
  optimize_schedule: { per: 10, fixed: 350 * 1048576, label: 'optimize_schedule', hint: 'pass project to optimise one project' },
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
/** What a Monte Carlo run holds per iteration whatever the activity count (measured, bytes per iteration, heap after a full collection):
 *  the finishes (a Float64Array, 8), their sorted copy (8), the same in working days (8) and the finishSamples array the answer takes
 *  (11.5 measured), 36 rounded up to 40. */
export const MC_BYTES_PER_ITERATION = 40;
/** What export adds per iteration, held beside the above while the answer's rows are made (measured the same way, 200,000 iterations):
 *  the finish_days array 13 B, the iterations table's row object 72 B (iteration, finish, finish_days) and a milestone's samples 25 B in the
 *  engine's array plus 28 B in the row (its finish text): 13 + 72 = 85 rounded up to 100, and 55 more per milestone. */
export const MC_EXPORT_BYTES_PER_ITERATION = 100;
export const MC_EXPORT_BYTES_PER_MILESTONE_ITERATION = 55;
/** What a histogram bucket holds (measured, 200,000 buckets): its object with the two dates' texts 96 B in memory, and 76 B of JSON
 *  text, which the answer holds twice (the text and the structured copy): 96 + 2 x 76 = 248, rounded up to 250. */
export const MC_BYTES_PER_BUCKET = 250;
/** What a listed criticality row holds (measured, 200,000 rows of 12 fields): its object 256 B in memory and 359 B of JSON text, which the answer
 *  holds twice (the text and the structured copy): 256 + 2 x 359 = 974, rounded up to 1,000. With top: 0 every activity is a row. */
export const MC_BYTES_PER_LISTED_ROW = 1000;
/** The most bins the engine's whole-day histogram has (histogram: "days"): a bin of whole days, wide enough for at most 40. */
export const MC_DAY_BINS = 40;
/** What float_paths' between keeps per tail (the best paths from an activity on to the end: an object of the duration, the lowest float,
 *  the next activity and the index there, with its slot in the list): measured 84 B with whole hours and 100 B with fractional hours
 *  (200,000 lists of 100 tails each; a 10,000-activity ladder with max 5,000 held 3.5 GB in the reviewed build, 70 B a tail with the
 *  candidates it sorted before cutting). Reserved for every activity of the project at `max` tails each. */
export const BETWEEN_BYTES_PER_TAIL = 100;

/** float_paths' between.max: a positive whole number (no 0 = all: paths_total says how many paths there are), default 25. between itself
 *  must be an object; the one parser for the tool and its memory reservation. */
export function between(b: unknown): number {
  if (typeof b !== 'object' || b === null || Array.isArray(b)) return fail('bad_input', 'between must be an object {from, to, max?}.', 'e.g. {"from": "A1000", "to": "A9000"}');
  return countArg((b as { max?: unknown }).max, 'between.max', { min: 1, hint: 'a positive whole number of paths (paths_total says how many there are between the two), or leave it out for 25' }) ?? 25;
}

/** The numbers monte_carlo is asked for: iterations (default 1000, at least 10), top (default 25; 0 = all: Infinity) and buckets
 *  (default 20, at least 5). A value that is not a whole number of 0 or more is refused as bad_input, named, before anything runs; the
 *  one parser for the tool and for its memory reservation. */
export function monteCarloCounts(a: Record<string, any>): { iterations: number; top: number; buckets: number; days: boolean } {
  const iterations = countArg(a.iterations, 'iterations', { min: 10 }) ?? 1000;
  const top = countArg(a.top, 'top') ?? 25;
  if (a.histogram != null && a.histogram !== 'days') fail('bad_input', `histogram must be "days" (got ${JSON.stringify(a.histogram)}).`, 'Leave histogram out for `buckets` equal bins, or pass "days" for whole-day bins.');
  const days = a.histogram === 'days';
  if (days && a.buckets != null) fail('bad_input', 'histogram "days" and buckets cannot be given together.', 'Pass histogram: "days" for whole-day bins, or buckets for that many equal bins, not both.');
  // whole-day bins (the engine's: a bin of 1 day or more so that there are at most 40): counted like buckets in the reservation
  const buckets = days ? MC_DAY_BINS : countArg(a.buckets, 'buckets', { min: 5 }) ?? 20;
  return { iterations, top: top === 0 ? Infinity : top, buckets, days };
}

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
/** The milestones still to finish in those projects (each has samples of its own in a Monte Carlo export) */
const milestones = (s: Session) => {
  const bl = new Set((s.db.tables.PROJECT?.rows ?? []).filter((p) => p._baseline_of).map((p) => p.proj_id));
  let n = 0;
  for (const t of s.db.tables.TASK?.rows ?? []) if ((t.task_type === 'TT_Mile' || t.task_type === 'TT_FinMile') && !t.act_end_date && !bl.has(t.proj_id)) n++;
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
    const { iterations: it, buckets, top, days } = monteCarloCounts(a); // as monte_carlo runs it; a bad count is refused here, before anything runs
    const perIt = n * MC_BYTES_PER_SAMPLE + MC_BYTES_PER_ITERATION + (a.export != null ? MC_EXPORT_BYTES_PER_ITERATION + milestones(s) * MC_EXPORT_BYTES_PER_MILESTONE_ITERATION : 0);
    const base = w.per * s.bytes;
    const listed = Math.min(top, n) * MC_BYTES_PER_LISTED_ROW; // the criticality rows the answer lists (top 0: every activity)
    bytes += it * perIt + buckets * MC_BYTES_PER_BUCKET + listed;
    what = `Monte Carlo of ${n.toLocaleString('en-US')} activities × ${it.toLocaleString('en-US')} iterations${a.export != null ? ' with its export' : ''}${days ? ` and its whole-day histogram (${MC_DAY_BINS} bins at most)` : a.buckets != null ? ` and ${buckets.toLocaleString('en-US')} histogram buckets` : ''}${a.top != null ? ` and ${Math.min(top, n).toLocaleString('en-US')} listed activity rows` : ''}`;
    // what would fit in what is free now: iterations with the buckets as asked, buckets with the iterations as asked (the minimums are 10 and 5)
    const room = Math.max(0, free() - base);
    const fitIt = Math.floor((room - buckets * MC_BYTES_PER_BUCKET - listed) / perIt), fitBk = Math.floor((room - it * perIt - listed) / MC_BYTES_PER_BUCKET);
    const ways = [
      ...(fitIt >= 10 ? [`at most ${fitIt.toLocaleString('en-US')} iterations (iterations)`] : []),
      ...(!days && fitBk >= 5 ? [`at most ${fitBk.toLocaleString('en-US')} histogram buckets (buckets)`] : []),
    ];
    hint = ways.length ? `run ${ways.join(' or ')}, which fit in the ${mbs(room)} free now` : 'run it on fewer activities (a narrower project)';
  }
  if (tool === 'float_paths' && a.between != null) {
    // the longest `max` paths between two activities: every activity between them keeps its best min(max, paths from it to "to") tails
    // (BETWEEN_BYTES_PER_TAIL each), so the reservation is that sum, worked out on the logic of the projects the call itself uses (the
    // file's own, never its baselines, which copy every Activity ID). Where it cannot be worked out before the call, it is bounded and
    // the words say so. A bad max is refused here as in the tool.
    const max = between(a.between);
    const own = (s.db.tables.PROJECT?.rows ?? []).filter((p) => !p._baseline_of);
    const named = a.project != null && a.project !== '' ? own.filter((p) => String(p.proj_short_name).toLowerCase() === String(a.project).toLowerCase()) : own;
    const bt = betweenTails(s.db, named.map((p) => p.proj_id), a.between);
    const room = Math.max(0, free() - w.per * s.bytes);
    const tails = bt ? bt.tails : (m: number) => n * m;
    const bound = !bt ? `the ends were not found as one activity each: reserved for the project's ${n.toLocaleString('en-US')} activities` : !bt.exact ? `the logic between them has a loop, which the call itself reports: reserved for the ${bt.activities.toLocaleString('en-US')} activities between them at ${max.toLocaleString('en-US')} paths each` : `${bt.activities.toLocaleString('en-US')} activities between them`;
    bytes += tails(max) * BETWEEN_BYTES_PER_TAIL;
    what = `float_paths between two activities (${bound}) × the ${max.toLocaleString('en-US')} longest paths`;
    // the most paths (between.max) whose tails fit in what is free now: the tails grow with max, so the largest max that fits is searched
    let fit = 0;
    if (bytes > free()) for (let lo = 1, hi = max - 1; lo <= hi;) { const mid = Math.floor((lo + hi) / 2); if (tails(mid) * BETWEEN_BYTES_PER_TAIL <= room) { fit = mid; lo = mid + 1; } else hi = mid - 1; }
    hint = fit >= 1 ? `ask for at most ${fit.toLocaleString('en-US')} paths (between.max), which fit in the ${mbs(Math.max(0, free()))} free now; paths_total says how many there are` : 'pass project to one project, or close other projects first';
  }
  return { bytes: Math.round(bytes), what, hint };
}
