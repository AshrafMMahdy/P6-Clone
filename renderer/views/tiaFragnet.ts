// The fragnet the Time impact analysis screen sends to the engine, built as the screen's rows are typed. Every operation names the
// project the screen is on (the first open one), so with two projects open the operations go to it and the engine never asks "say
// which with project". Kept apart from the panel (a .ts file) so a test can run it.
export interface FragAct { id: string; name: string; days: string }
export interface FragRel { pred: string; succ: string; type: string; lag: string }

// A box that does not hold a number is refused, naming the row (item 26: never read as 0).
const days = (v: string, what: string): number => {
  const n = v.trim() === '' ? NaN : Number(v);
  if (!Number.isFinite(n)) throw new Error(`${what} must be a number of days (got ${v.trim() === '' ? 'nothing' : JSON.stringify(v)}).`);
  return n;
};
export const tiaFragnetOps = (acts: FragAct[], rels: FragRel[], project: string) => [
  ...acts.filter((a) => a.id.trim()).map((a) => ({ op: 'add_activity', id: a.id.trim(), name: a.name || a.id, duration_days: days(a.days, `The days of ${a.id.trim()}`), project })),
  ...rels.filter((r) => r.pred.trim() && r.succ.trim()).map((r) => ({ op: 'add_relationship', pred: r.pred.trim(), succ: r.succ.trim(), type: r.type, lag_days: days(r.lag, `The lag of ${r.pred.trim()} → ${r.succ.trim()}`), project })),
];
