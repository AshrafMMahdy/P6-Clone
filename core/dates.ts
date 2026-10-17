// Times are minutes since 1970-01-01 00:00, treating P6 wall-clock as UTC (no TZ, no DST).
export const MIN_PER_DAY = 1440;
const OLE_EPOCH_OFFSET_DAYS = 25569; // OLE serial of 1970-01-01

export function parseP6Date(s: string | undefined): number | null {
  if (!s) return null;
  const m = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?$/.exec(s.trim());
  if (!m) return null;
  const ms = Date.UTC(+m[1], +m[2] - 1, +m[3], m[4] ? +m[4] : 0, m[5] ? +m[5] : 0);
  if (Number.isNaN(ms)) return null;
  const d = new Date(ms);
  if (d.getUTCMonth() !== +m[2] - 1 || d.getUTCDate() !== +m[3]) return null; // 2024-02-31 etc
  return ms / 60000;
}

const p2 = (n: number) => String(n).padStart(2, '0');

/** Memoised: a schedule writes the same dates many times, and a built string is a tree of its pieces (~5x its size),
 *  so each date is built once, kept as one flat string and shared. */
export function memo<K>(build: (k: K) => string, max = 100000): (k: K) => string {
  const m = new Map<K, string>();
  return (k) => {
    let s = m.get(k);
    if (s === undefined) {
      if (m.size >= max) m.clear();
      m.set(k, (s = JSON.parse(JSON.stringify(build(k))) as string)); // a flat copy
    }
    return s;
  };
}

const formatMinute = memo((t: number) => {
  const d = new Date(t * 60000);
  return `${d.getUTCFullYear()}-${p2(d.getUTCMonth() + 1)}-${p2(d.getUTCDate())} ${p2(d.getUTCHours())}:${p2(d.getUTCMinutes())}`;
});

export function formatP6Date(t: number | null | undefined): string {
  if (t == null || !Number.isFinite(t)) return '';
  return formatMinute(Math.round(t));
}

/** Day part only, yyyy-mm-dd. */
export function formatDay(t: number | null | undefined): string {
  return formatP6Date(t).slice(0, 10);
}

export function serialToMinutes(serial: number): number {
  return (serial - OLE_EPOCH_OFFSET_DAYS) * MIN_PER_DAY;
}

export function minutesToSerial(t: number): number {
  return Math.floor(t / MIN_PER_DAY) + OLE_EPOCH_OFFSET_DAYS;
}

export function dayStart(t: number): number {
  return Math.floor(t / MIN_PER_DAY) * MIN_PER_DAY;
}

/** 0 = Sunday .. 6 = Saturday */
export function weekday(t: number): number {
  return (Math.floor(t / MIN_PER_DAY) + 4) % 7; // 1970-01-01 was Thursday
}
