// P6 CALENDAR.clndr_data: nested "(0||Name(k|v|k|v)(children...))" structure.
// DaysOfWeek children 1..7 = Sunday..Saturday; Exceptions keyed by OLE serial day (d|41519).

export interface Shift { start: number; end: number } // minutes from midnight, end may be 1440
export interface CalendarDef {
  /** index 0 = Sunday .. 6 = Saturday */
  week: Shift[][];
  /** OLE serial day -> shifts (empty = non-work day) */
  exceptions: Map<number, Shift[]>;
}

interface Node { name: string; attrs: string[]; children: Node[] }

export class ClndrDataError extends Error {}

function parseNodes(s: string): Node[] {
  let i = 0;
  const ws = () => { while (i < s.length && /[\s\x7f]/.test(s[i])) i++; };
  const node = (): Node => {
    ws();
    if (s[i] !== '(') throw new ClndrDataError(`expected "(" at ${i}`);
    i++;
    const bar = s.indexOf('||', i);
    if (bar < 0) throw new ClndrDataError(`expected "||" after ${i}`);
    i = bar + 2;
    const open = s.indexOf('(', i);
    if (open < 0) throw new ClndrDataError(`expected attribute list at ${i}`);
    const name = s.slice(i, open).trim();
    const close = s.indexOf(')', open);
    if (close < 0) throw new ClndrDataError(`unclosed attribute list at ${open}`);
    const attrText = s.slice(open + 1, close);
    i = close + 1;
    ws();
    if (s[i] !== '(') throw new ClndrDataError(`expected child list at ${i}`);
    i++;
    const children: Node[] = [];
    ws();
    while (s[i] === '(') { children.push(node()); ws(); }
    if (s[i] !== ')') throw new ClndrDataError(`expected ")" closing children at ${i}`);
    i++;
    ws();
    if (s[i] !== ')') throw new ClndrDataError(`expected ")" closing node at ${i}`);
    i++;
    return { name, attrs: attrText ? attrText.split('|').map((x) => x.trim()) : [], children };
  };
  const out: Node[] = [];
  ws();
  while (i < s.length) { out.push(node()); ws(); }
  return out;
}

function attr(n: Node, key: string): string | undefined {
  for (let j = 0; j + 1 < n.attrs.length; j += 2) if (n.attrs[j] === key) return n.attrs[j + 1];
  return undefined;
}

function hhmm(s: string | undefined, isEnd: boolean): number {
  const m = /^(\d{1,2}):(\d{2})$/.exec(s ?? '');
  if (!m) throw new ClndrDataError(`bad time "${s}"`);
  const v = +m[1] * 60 + +m[2];
  return isEnd && v === 0 ? 1440 : v;
}

function shifts(n: Node): Shift[] {
  return n.children.map((c) => ({ start: hhmm(attr(c, 's'), false), end: hhmm(attr(c, 'f'), true) }))
    .filter((x) => x.end > x.start)
    .sort((a, b) => a.start - b.start);
}

export function parseClndrData(s: string): CalendarDef {
  const roots = parseNodes(s);
  // Some P6 builds write an unnamed root: (0||()(...))
  const root = roots.find((r) => r.name === 'CalendarData') ?? roots.find((r) => r.children.some((c) => c.name === 'DaysOfWeek'));
  if (!root) throw new ClndrDataError('missing CalendarData node');
  const week: Shift[][] = [[], [], [], [], [], [], []];
  const dow = root.children.find((c) => c.name === 'DaysOfWeek');
  if (!dow) throw new ClndrDataError('missing DaysOfWeek node');
  for (const d of dow.children) {
    const k = Number(d.name);
    if (!(k >= 1 && k <= 7)) throw new ClndrDataError(`bad weekday "${d.name}"`);
    week[k - 1] = shifts(d);
  }
  const exceptions = new Map<number, Shift[]>();
  for (const e of root.children.find((c) => c.name === 'Exceptions')?.children ?? []) {
    const d = Number(attr(e, 'd'));
    if (!Number.isFinite(d)) throw new ClndrDataError(`bad exception day "${attr(e, 'd')}"`);
    exceptions.set(d, shifts(e));
  }
  return { week, exceptions };
}

const t = (m: number) => `${String(Math.floor((m % 1440) / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
const shiftNodes = (ss: Shift[]) => ss.map((x, i) => `(0||${i}(s|${t(x.start)}|f|${t(x.end)})())`).join('');

export function serializeClndrData(c: CalendarDef): string {
  const days = c.week.map((ss, i) => `(0||${i + 1}()(${shiftNodes(ss)}))`).join('');
  const ex = [...c.exceptions.entries()].sort((a, b) => a[0] - b[0])
    .map(([d, ss], i) => `(0||${i}(d|${d})(${shiftNodes(ss)}))`).join('');
  return `(0||CalendarData()((0||DaysOfWeek()(${days}))(0||VIEW(ShowTotal|Y)())(0||Exceptions()(${ex}))))`;
}

/** Standard 5-day 08:00-12:00, 13:00-17:00 calendar (P6 default). */
export function standardCalendar(): CalendarDef {
  const day = [{ start: 480, end: 720 }, { start: 780, end: 1020 }];
  return { week: [[], day, day, day, day, day, []], exceptions: new Map() };
}

/** The work week P6 gives a calendar without calendar data: its hours per day on its days a week (week_hr_cnt /
 *  day_hr_cnt, Monday on), from 08:00 with an hour's lunch at noon; without usable hours, the standard week
 *  (Mon-Fri 08:00-12:00, 13:00-17:00, as an 8 h / 40 h calendar comes out too). */
export function defaultCalendarDef(dayHrs?: string | number, weekHrs?: string | number): CalendarDef {
  const d = Number(dayHrs), w = Number(weekHrs);
  if (!(d > 0 && d <= 24) || !(w > 0)) return standardCalendar();
  const days = Math.min(7, Math.max(1, Math.round(w / d)));
  const min = Math.round(d * 60);
  const day: Shift[] = min <= 240 ? [{ start: 480, end: 480 + min }] : min <= 960 ? [{ start: 480, end: 720 }, { start: 780, end: 780 + min - 240 }] : [{ start: 0, end: min }];
  const week: Shift[][] = [[], [], [], [], [], [], []];
  for (let i = 0; i < days; i++) week[(i + 1) % 7] = day.map((s) => ({ ...s })); // Mon, Tue, ... Sat, Sun
  return { week, exceptions: new Map() };
}
/** A CALENDAR row's definition: its calendar data, or (none) the week P6 gives it (defaultCalendarDef). */
export function calendarDefOfRow(r: { clndr_data?: string; day_hr_cnt?: string; week_hr_cnt?: string }): CalendarDef {
  return r.clndr_data && r.clndr_data.trim() ? parseClndrData(r.clndr_data) : defaultCalendarDef(r.day_hr_cnt, r.week_hr_cnt);
}

/** The definition F9 schedules a calendar row with: calendarDefOfRow, or the standard week when its data cannot be
 *  read (the scheduler warns of that). Edits start from it, so what they leave alone schedules as before. */
export function scheduledCalendarDef(r: { clndr_data?: string; day_hr_cnt?: string; week_hr_cnt?: string }): CalendarDef {
  try { return calendarDefOfRow(r); } catch { return standardCalendar(); }
}

export function hoursPerWeek(c: CalendarDef): number {
  return c.week.flat().reduce((a, x) => a + x.end - x.start, 0) / 60;
}

/** P6 project/resource calendars inherit holidays and exceptions from their base calendar; own exceptions win. */
export function inheritExceptions(own: CalendarDef, base: CalendarDef): CalendarDef {
  return { week: own.week, exceptions: new Map([...base.exceptions, ...own.exceptions]) };
}
