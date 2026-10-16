export type Severity = 'fatal' | 'error' | 'warning' | 'info';

export interface Finding {
  severity: Severity;
  code: string;
  message: string;
  /** What real P6 does in this situation. */
  p6: string;
  table?: string;
  /** 1-based row index within the table. */
  row?: number;
  key?: string;
  field?: string;
}

const RANK: Record<Severity, number> = { fatal: 0, error: 1, warning: 2, info: 3 };

export function sortFindings(f: Finding[]): Finding[] {
  return [...f].sort((a, b) => RANK[a.severity] - RANK[b.severity]);
}

export function worst(f: Finding[]): Severity | null {
  let w: Severity | null = null;
  for (const x of f) if (w === null || RANK[x.severity] < RANK[w]) w = x.severity;
  return w;
}
