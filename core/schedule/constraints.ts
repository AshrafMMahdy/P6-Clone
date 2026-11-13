// Whether a scheduled date meets a constraint, judged in WORKING time on the activity's calendar: a constraint given as a bare date is stored at 00:00, and
// 17:00 of the working day before (or the end of the last work period before it) is the same working moment. The one test for the scheduler's own log
// (CONSTRAINT_VIOLATED) and for the schedule log of every tool (Activities with unsatisfied constraints).
import type { WorkCalendar } from '../calendar/calendar.ts';

/** `a` is later than `b` in work time on `cal` (there is work time between them). */
export const laterInWork = (cal: WorkCalendar, a: number, b: number): boolean => cal.workBetween(b, a) > 0;
/** `a` and `b` are the same working moment on `cal` (no work time between them). */
export const sameInWork = (cal: WorkCalendar, a: number, b: number): boolean => cal.workBetween(Math.min(a, b), Math.max(a, b)) === 0;

/** A constraint type that is not met by the scheduled start `es` / finish `ef` (null: not scheduled), for the constraint date `c`. */
export function constraintNotMet(cal: WorkCalendar, ty: string, c: number, es: number | null, ef: number | null): boolean {
  switch (ty) {
    case 'CS_MSO': case 'CS_MANDSTART': return es != null && !sameInWork(cal, es, c);
    case 'CS_MSOB': return es != null && laterInWork(cal, es, c);
    case 'CS_MSOA': return es != null && laterInWork(cal, c, es);
    case 'CS_MEO': case 'CS_MANDFIN': return ef != null && !sameInWork(cal, ef, c);
    case 'CS_MEOB': return ef != null && laterInWork(cal, ef, c);
    case 'CS_MEOA': return ef != null && laterInWork(cal, c, ef);
    default: return false;
  }
}
