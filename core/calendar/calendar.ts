import { MIN_PER_DAY } from '../dates.ts';
import type { CalendarDef, Shift } from './clndr-data.ts';

const OLE_OFFSET = 25569; // OLE serial of day index 0 (1970-01-01)
const HORIZON_DAYS = 366 * 20;

export class CalendarHorizonError extends Error {}

/** Work-time arithmetic on a P6 calendar. Times are minutes (see core/dates.ts). */
export class WorkCalendar {
  readonly def: CalendarDef;
  private cache = new Map<number, Shift[]>();

  constructor(def: CalendarDef) {
    this.def = def;
  }

  static continuous(): WorkCalendar {
    const all = [{ start: 0, end: MIN_PER_DAY }];
    return new WorkCalendar({ week: [all, all, all, all, all, all, all], exceptions: new Map() });
  }

  /** Shifts on a day index (days since 1970-01-01). */
  shiftsOn(day: number): Shift[] {
    let s = this.cache.get(day);
    if (!s) {
      s = this.def.exceptions.get(day + OLE_OFFSET) ?? this.def.week[(day + 4) % 7];
      this.cache.set(day, s);
    }
    return s;
  }

  isWorkTime(t: number): boolean {
    const day = Math.floor(t / MIN_PER_DAY), m = t - day * MIN_PER_DAY;
    return this.shiftsOn(day).some((x) => m >= x.start && m < x.end);
  }

  /** t if it is inside work time, else the start of the next work period. */
  nextWorkStart(t: number): number {
    let day = Math.floor(t / MIN_PER_DAY);
    let m = t - day * MIN_PER_DAY;
    for (let n = 0; n < HORIZON_DAYS; n++, day++, m = 0) {
      for (const x of this.shiftsOn(day)) {
        if (m < x.end) return day * MIN_PER_DAY + Math.max(m, x.start);
      }
    }
    throw new CalendarHorizonError('no work time within 20 years');
  }

  /** t if it is inside work time (or at a period end), else the end of the previous work period. */
  prevWorkEnd(t: number): number {
    let day = Math.floor(t / MIN_PER_DAY);
    let m = t - day * MIN_PER_DAY;
    if (m === 0) { day--; m = MIN_PER_DAY; }
    for (let n = 0; n < HORIZON_DAYS; n++, day--, m = MIN_PER_DAY) {
      const ss = this.shiftsOn(day);
      for (let i = ss.length - 1; i >= 0; i--) {
        if (m > ss[i].start) return day * MIN_PER_DAY + Math.min(m, ss[i].end);
      }
    }
    throw new CalendarHorizonError('no work time within 20 years');
  }

  /** Add work minutes. Lands at the end of a period rather than the start of the next. */
  addWork(t: number, minutes: number): number {
    if (minutes < 0) return this.subWork(t, -minutes);
    if (minutes === 0) return t;
    let cur = this.nextWorkStart(t);
    let left = minutes;
    for (let n = 0; n < HORIZON_DAYS * 4; n++) {
      const day = Math.floor(cur / MIN_PER_DAY), m = cur - day * MIN_PER_DAY;
      const sh = this.shiftsOn(day).find((x) => m >= x.start && m < x.end)!;
      const avail = sh.end - m;
      if (left <= avail) return cur + left;
      left -= avail;
      cur = this.nextWorkStart(day * MIN_PER_DAY + sh.end);
    }
    throw new CalendarHorizonError('duration exceeds calendar horizon');
  }

  /** Subtract work minutes. Lands at the start of a period rather than the end of the previous. */
  subWork(t: number, minutes: number): number {
    if (minutes < 0) return this.addWork(t, -minutes);
    if (minutes === 0) return t;
    let cur = this.prevWorkEnd(t);
    let left = minutes;
    for (let n = 0; n < HORIZON_DAYS * 4; n++) {
      let day = Math.floor(cur / MIN_PER_DAY), m = cur - day * MIN_PER_DAY;
      if (m === 0) { day--; m = MIN_PER_DAY; }
      const sh = this.shiftsOn(day).find((x) => m > x.start && m <= x.end)!;
      const avail = m - sh.start;
      if (left <= avail) return day * MIN_PER_DAY + m - left;
      left -= avail;
      cur = this.prevWorkEnd(day * MIN_PER_DAY + sh.start);
    }
    throw new CalendarHorizonError('duration exceeds calendar horizon');
  }

  /** Work minutes in [a, b); negative when b < a. */
  workBetween(a: number, b: number): number {
    if (b < a) return -this.workBetween(b, a);
    let total = 0;
    let day = Math.floor(a / MIN_PER_DAY);
    const lastDay = Math.floor(b / MIN_PER_DAY);
    for (; day <= lastDay; day++) {
      const d0 = day * MIN_PER_DAY;
      for (const x of this.shiftsOn(day)) {
        const s = Math.max(d0 + x.start, a), e = Math.min(d0 + x.end, b);
        if (e > s) total += e - s;
      }
    }
    return total;
  }

  /** Work hours on a typical day (max over the week), used for day conversions. */
  hoursPerDay(): number {
    return Math.max(0, ...this.def.week.map((ss) => ss.reduce((a, x) => a + x.end - x.start, 0))) / 60 || 8;
  }
}
