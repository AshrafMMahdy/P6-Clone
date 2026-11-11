// The value types of Microsoft Project XML (MSPDI), and which element is which type. The one place where a value of the format is
// turned into the clone's model value and back: the readers and writers (mspdi.ts, shared.ts, baselines.ts, custom-fields.ts) take every
// conversion from here and do no unit arithmetic of their own.
//
// The types, as Microsoft Project stores them (calibrated on MPXJ's MSPDI reader and writer, which are calibrated on Microsoft Project's own files):
//   currency   hundredths of the currency unit: 1234.50 is 123450. Always: <CurrencyDigits> is only how many decimals Microsoft Project shows.
//              (Rates are not currency: a rate is in the unit of its format.)
//   duration   an ISO time string, PT40H0M0S; the clone's model holds hours.
//   tenths     tenths of a minute (slack; the clone's model holds hours).
//   lag        tenths of a minute, with <LagFormat> naming the display unit, except a percentage lag (formats 19, 20), which is the plain percentage.
//   rate       a plain amount PER HOUR, whatever <StandardRateFormat> says (that only names the unit Microsoft Project shows it in: a resource at 400 a day
//              is <StandardRate>50</StandardRate><StandardRateFormat>3</StandardRateFormat> for an 8 hour day; MPXJ reads and writes it so). A material's
//              rate is per unit of the material.
//   days       whole days of the project's MinutesPerDay (CriticalSlackLimit).
//   number     a plain decimal: units (1 is 100 %), percentages.
//   int, flag (0 / 1), text, date (yyyy-mm-ddThh:mm:ss).
import { formatP6Date, parseP6Date } from '../dates.ts';
import { p6num } from '../schedule/cpm.ts';

export type ValueType = 'text' | 'int' | 'number' | 'flag' | 'date' | 'duration' | 'tenths' | 'days' | 'currency' | 'rate' | 'lag';
export type Entity = 'Project' | 'Task' | 'Resource' | 'Assignment' | 'PredecessorLink' | 'Baseline' | 'TimephasedData' | 'ExtendedAttribute';

/** What a conversion needs to know of the file / project: the length of its day (and week). `plainCurrency`: the file is one the clone wrote
 *  before it wrote currency as Microsoft Project does (FORMAT_REVISION below): its currency elements hold plain units. */
export interface Ctx { minutesPerDay: number; minutesPerWeek?: number; plainCurrency?: boolean }
export const defaultCtx = (): Ctx => ({ minutesPerDay: 480 });

// ---------- the table: which element is which type (every element the clone reads or writes)

const of = (type: ValueType, ...names: string[]): Record<string, ValueType> => Object.fromEntries(names.map((n) => [n, type]));
export const ELEMENT_TYPES: Record<Entity, Record<string, ValueType>> = {
  Project: {
    ...of('text', 'Name', 'Title', 'Author', 'CalendarUID', 'DefaultStartTime', 'DefaultFinishTime'),
    ...of('int', 'SaveVersion', 'MinutesPerDay', 'MinutesPerWeek', 'DaysPerMonth', 'DefaultTaskType', 'DurationFormat', 'WorkFormat', 'WeekStartDay', 'NewTaskStartDate'),
    ...of('flag', 'ScheduleFromStart', 'HonorConstraints', 'MultipleCriticalPaths', 'NewTasksEffortDriven', 'NewTasksEstimated', 'SplitsInProgressTasks', 'MoveRemainingStartsForward'),
    ...of('date', 'CreationDate', 'LastSaved', 'StartDate', 'FinishDate', 'StatusDate'),
    ...of('days', 'CriticalSlackLimit'),
  },
  Task: {
    ...of('text', 'UID', 'Name', 'WBS', 'OutlineNumber', 'CalendarUID'),
    ...of('int', 'ID', 'Type', 'OutlineLevel', 'Priority', 'ConstraintType', 'DurationFormat'),
    ...of('flag', 'IsNull', 'Milestone', 'Summary', 'Critical', 'EffortDriven', 'Estimated', 'IgnoreResourceCalendar'),
    ...of('number', 'PercentComplete'),
    ...of('date', 'Start', 'Finish', 'EarlyStart', 'EarlyFinish', 'LateStart', 'LateFinish', 'ActualStart', 'ActualFinish', 'ConstraintDate', 'Deadline'),
    ...of('duration', 'Duration', 'RemainingDuration', 'ActualDuration'),
    ...of('tenths', 'TotalSlack', 'FreeSlack'),
  },
  Resource: {
    ...of('text', 'UID', 'Name', 'Code', 'Initials', 'CalendarUID'),
    ...of('int', 'ID', 'Type', 'StandardRateFormat', 'OvertimeRateFormat'),
    ...of('flag', 'IsNull'),
    ...of('number', 'MaxUnits'),
    ...of('rate', 'StandardRate', 'OvertimeRate'),
  },
  Assignment: {
    ...of('text', 'UID', 'TaskUID', 'ResourceUID'),
    ...of('number', 'Units'),
    ...of('duration', 'Work', 'ActualWork', 'RemainingWork'),
    ...of('currency', 'Cost', 'ActualCost', 'RemainingCost'),
    ...of('date', 'Start', 'Finish', 'ActualStart', 'ActualFinish'),
  },
  PredecessorLink: { ...of('text', 'PredecessorUID', 'CrossProjectName'), ...of('int', 'Type', 'LagFormat'), ...of('flag', 'CrossProject'), ...of('lag', 'LinkLag') },
  Baseline: { ...of('int', 'Number', 'DurationFormat'), ...of('flag', 'EstimatedDuration'), ...of('date', 'Start', 'Finish'), ...of('duration', 'Duration') },
  // the clone neither reads nor writes timephased values (they stay in the file as written: KEPT_AS_WRITTEN)
  TimephasedData: {},
  // a custom field's value is of the kind of its slot (custom-fields.ts); the definition's elements are text
  ExtendedAttribute: { ...of('text', 'FieldID', 'FieldName', 'Alias', 'Value:Text'), ...of('number', 'Value:Number'), ...of('currency', 'Value:Cost'), ...of('date', 'Value:Start', 'Value:Finish', 'Value:Date') },
};

/** Currency elements (and timephased values) of the format that the clone neither reads nor writes: they stay in a file as written, so nothing
 *  converts them. (A file's own values are in its own representation: Microsoft Project's, or the clone's earlier one, which re-saving rewrites.) */
export const KEPT_AS_WRITTEN: Record<string, string[]> = {
  Project: ['DefaultStandardRate', 'DefaultOvertimeRate (rates)'],
  Task: ['FixedCost', 'Cost', 'OvertimeCost', 'ActualCost', 'ActualOvertimeCost', 'RemainingCost', 'RemainingOvertimeCost', 'CV', 'BCWS', 'BCWP', 'ACWP'],
  Resource: ['Cost', 'OvertimeCost', 'CostPerUse', 'ActualCost', 'ActualOvertimeCost', 'RemainingCost', 'RemainingOvertimeCost', 'CostVariance', 'SV', 'CV', 'ACWP', 'BCWS', 'BCWP', 'Rates/Rate (CostPerUse; rates)'],
  Assignment: ['OvertimeCost', 'ActualOvertimeCost', 'RemainingOvertimeCost', 'CostVariance', 'CV', 'VAC', 'ACWP', 'BCWS', 'BCWP', 'BudgetCost'],
  Baseline: ['Cost', 'Work and the like (all values of a baseline other than Number, Start, Finish, Duration)'],
  TimephasedData: ['Value (all of it)'],
};

const spec = (entity: Entity, name: string): ValueType => {
  const t = ELEMENT_TYPES[entity][name];
  if (!t) throw new Error(`MSPDI element ${entity}/${name} has no value type in core/msp/values.ts`);
  return t;
};
/** The type of an element (an element not in the table is a mistake in the code, not a text). */
export const typeOf = (entity: Entity, name: string): ValueType => spec(entity, name);

// ---------- the codecs

const num = (s: string | undefined): number | null => {
  if (s == null || s.trim() === '') return null;
  const n = Number(s.trim());
  return Number.isFinite(n) ? n : null;
};
export { num };
const isFlag = (s: string) => s === '1' || s.toLowerCase() === 'true';

/** ISO-8601 duration (PT40H0M0S, P1DT2H, -PT8H) -> hours. Days count as working days of minutesPerDay. */
export function isoDurationHours(s: string, minutesPerDay = 480): number | null {
  const m = /^(-)?P(?:(\d+(?:\.\d+)?)Y)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)W)?(?:(\d+(?:\.\d+)?)D)?(?:T(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?)?$/.exec(s.trim());
  if (!m) return null;
  const n = (i: number) => Number(m[i] ?? 0);
  const dayH = minutesPerDay / 60;
  const h = n(2) * 52 * 5 * dayH + n(3) * 20 * dayH + n(4) * 5 * dayH + n(5) * dayH + n(6) + n(7) / 60 + n(8) / 3600;
  return m[1] ? -h : h;
}
export function hoursToIso(h: number): string {
  const neg = h < 0;
  const secs = Math.round(Math.abs(h) * 3600);
  return `${neg ? '-' : ''}PT${Math.floor(secs / 3600)}H${Math.floor((secs % 3600) / 60)}M${secs % 60}S`;
}

/** Accepts 'yyyy-mm-ddThh:mm[:ss[.fff]][Z]' or P6 format; returns P6 'yyyy-mm-dd hh:mm' or ''. */
export function toP6Date(s: string | undefined): string {
  if (!s) return '';
  const t = parseP6Date(s.trim().replace(/(\.\d+)?(Z|[+-]\d{2}:\d{2})?$/, '').slice(0, 19));
  return t == null ? '' : formatP6Date(t);
}
/** A P6 date as the format writes it ('' for none or one that is not a date). */
export const xmlDate = (s: string) => { const t = parseP6Date(s); return t == null ? '' : formatP6Date(t).replace(' ', 'T') + ':00'; };

/** Currency: hundredths of the unit. `plain`: a file the clone wrote before revision 2, whose currency elements hold plain units. */
export const currencyFromText = (s: string, plain = false): number | null => { const n = num(s); return n == null ? null : plain ? n : n / 100; };
/** The decimals of the hundredths MPXJ's MSPDI writer prints: an assignment's Cost / ActualCost / RemainingCost with 4, a custom field's Cost value with 2. */
export interface CurrencyForm { decimals: number; negativeZero: boolean }
/** (a negative amount that rounds to nothing is written "-0" in a custom field and "0" in an assignment, as MPXJ prints them) */
export const ASSIGNMENT_COST: CurrencyForm = { decimals: 4, negativeZero: false }, CUSTOM_FIELD_COST: CurrencyForm = { decimals: 2, negativeZero: true };
/** Currency as text, as MPXJ's MSPDI writer prints it (calibrated on its output for the same values: it multiplies the amount by 100 and prints it with at most 4
 *  decimals for an assignment's cost and 2 for a custom field's, none when whole, no exponent, "0" for zero (MPXJ leaves a zero out; the clone writes the 0)): 12.345 is 1234.5, 0.004 is 0.4, 1e9 is 100000000000, -5.5 is -550, 1.2345678 is 123.45678 -> 123.4568. The
 *  rounding is DecimalFormat's: half-even, on the shortest decimal form of the number, with an exact tie of the binary value (j/32) going to the even digit. */
export function currencyToText(v: number, { decimals, negativeZero }: CurrencyForm = ASSIGNMENT_COST): string {
  const x = v * 100;
  if (!Number.isFinite(x) || x === 0) return '0';
  const neg = x < 0;
  let [int, dec = ''] = plainDecimal(Math.abs(x)).split('.');
  if (dec.length > decimals) {
    const keep = dec.slice(0, decimals), rest = dec.slice(decimals);
    let up: boolean;
    if (rest[0] !== '5' || /[1-9]/.test(rest.slice(1))) up = rest[0] > '5' || (rest[0] === '5');
    else {
      // the shortest form ends exactly in a 5: the binary value decides (above the tie: up, below: down, exactly on it: the even digit)
      const exact = Math.abs(x).toFixed(80), tie = `${int}.${keep}5`.padEnd(exact.length, '0');
      up = exact > tie || (exact === tie && Number(keep.at(-1) ?? int.at(-1)) % 2 === 1);
    }
    let n = BigInt(int + keep) + (up ? 1n : 0n);
    const t = n.toString().padStart(decimals + 1, '0');
    int = t.slice(0, t.length - decimals); dec = t.slice(t.length - decimals);
  }
  const body = `${int}${dec.replace(/0+$/, '') ? '.' + dec.replace(/0+$/, '') : ''}`;
  return `${neg && (negativeZero || /[1-9]/.test(body)) ? '-' : ''}${body}`;
}
/** A finite non-negative number as plain decimal digits (its shortest form, without an exponent). */
function plainDecimal(x: number): string {
  const m = /^(\d)(?:\.(\d+))?e([+-]\d+)$/.exec(x.toExponential());
  const digits = m![1] + (m![2] ?? ''), e = Number(m![3]);
  if (e >= digits.length - 1) return digits + '0'.repeat(e - digits.length + 1);
  if (e >= 0) return `${digits.slice(0, e + 1)}.${digits.slice(e + 1)}`;
  return `0.${'0'.repeat(-e - 1)}${digits}`;
}

/** The kinds of lag format: percentage (19, 20: the plain percentage of the predecessor's duration) and elapsed (4, 6, 8, 10, 12, with the
 *  elapsed percentage 20; 32 is added for an estimated one). */
const baseLagFormat = (fmt: number) => (fmt > 32 ? fmt - 32 : fmt);
export const lagIsPercent = (fmt: number) => [19, 20].includes(baseLagFormat(fmt));
export const lagIsElapsed = (fmt: number) => [4, 6, 8, 10, 12].includes(baseLagFormat(fmt));
/** The lag format the clone writes a lag in (days, Microsoft Project's default); the value is in tenths of a minute whatever the format. */
export const LAG_FORMAT = 7;
/** A link's lag: hours (not for a percentage lag) or the percentage of the predecessor's duration. */
export function readLag(text: string, format: number): { hours: number; percent?: number } {
  const v = num(text) ?? 0;
  return lagIsPercent(format) ? { hours: 0, percent: v } : { hours: v / 600 };
}
/** A lag in the format it is kept in: a percentage lag stays a percentage of the predecessor's duration (`predHrs`). */
export function writeLag(hours: number, format = LAG_FORMAT, predHrs = 0): string {
  return String(lagIsPercent(format) ? Math.round(predHrs > 0 ? (hours / predHrs) * 100 : 0) : Math.round(hours * 600));
}

/** An assignment's Units. A work resource's are the fraction of its time (1 is 100 %). A material's are its quantity (500 % is 5 units of the material), which the
 *  clone holds as the assignment's quantity (the file's Work, in hours, is that quantity too): so a material's units are never read as a fraction, and are written
 *  as the quantity. (Calibrated on Microsoft Project's own .mpp through MPXJ: Units 5 and Work PT5H0M0S for 5 units of a material.) */
export const readUnits = (text: string, material: boolean, quantity: number | null): number | null => (material && quantity != null ? null : num(text));
export const unitsToWrite = (material: boolean, perHour: number | null, quantity: number | null): number | null => (material ? quantity ?? perHour : perHour);

/** A percentage lag as hours: that percentage of the predecessor's duration. */
export const percentLagHours = (percent: number, predHrs: number): number => (percent / 100) * predHrs;
/** A project's MinutesPerDay / MinutesPerWeek (minutes) and the hours the model holds for them. */
export const minutesOfHours = (h: number): number => Math.round(h * 60);
export const hoursOfMinutes = (m: number): number => m / 60;

/** The rate format the clone writes a rate in (per hour). */
export const RATE_PER_HOUR = 2;
/** A rate per hour (a material's: per unit of the material): the text's number as it is. <StandardRateFormat> is how Microsoft Project displays the
 *  rate, not what the number is in (calibrated on MPXJ: StandardRate 360 with format 3 and a 6 hour day reads as 2160 a day). */
export const readRate = (text: string): number | null => num(text);

type Value = string | number | boolean | null;
const READ: Record<Exclude<ValueType, 'rate' | 'lag'>, (s: string, c: Ctx, entity: Entity) => Value> = {
  text: (s) => s.trim(),
  int: (s) => num(s),
  number: (s) => num(s),
  flag: (s) => (s.trim() === '' ? null : isFlag(s.trim())),
  date: (s) => toP6Date(s),
  duration: (s, c) => (s.trim() ? isoDurationHours(s, c.minutesPerDay) : null),
  tenths: (s) => { const n = num(s); return n == null ? null : n / 600; },
  days: (s, c) => { const n = num(s); return n == null ? null : n * (c.minutesPerDay / 60); },
  // a custom field's cost is in hundredths in every revision of the clone's files; its element currency was plain in revision 1
  currency: (s, c, entity) => currencyFromText(s, !!c.plainCurrency && entity !== 'ExtendedAttribute'),
};
const WRITE: Record<Exclude<ValueType, 'rate' | 'lag'>, (v: never, c: Ctx, entity: Entity) => string> = {
  text: (v: string) => String(v),
  int: (v: number) => String(v),
  number: (v: number | string) => (typeof v === 'string' ? v : p6num(v)), // (a stored custom-field number is written as it is stored)
  flag: (v: boolean | number) => (v ? '1' : '0'),
  date: (v: string) => xmlDate(v),
  duration: (v: number) => hoursToIso(v),
  tenths: (v: number) => String(Math.round(v * 600)),
  days: (v: number, c: Ctx) => String(Math.round(v / (c.minutesPerDay / 60)) || 0),
  currency: (v: number, _c, entity) => currencyToText(v, entity === 'ExtendedAttribute' ? CUSTOM_FIELD_COST : ASSIGNMENT_COST),
};

/** The model value of an element's text (null: none; a date '' for none). A rate or a lag has its own reader (readRate, readLag): they need the
 *  element's format too. */
export function readValue(entity: Entity, name: string, text: string | undefined, c: Ctx): Value {
  const t = spec(entity, name);
  if (t === 'rate' || t === 'lag') throw new Error(`${entity}/${name} is a ${t}: read it with ${t === 'rate' ? 'readRate' : 'readLag'}`);
  return READ[t](text ?? '', c, entity);
}
export const readNumber = (entity: Entity, name: string, text: string | undefined, c: Ctx): number | null => readValue(entity, name, text, c) as number | null;
export const readText = (entity: Entity, name: string, text: string | undefined): string => readValue(entity, name, text, defaultCtx()) as string;
export const readDate = (entity: Entity, name: string, text: string | undefined): string => readValue(entity, name, text, defaultCtx()) as string;
export const readFlag = (entity: Entity, name: string, text: string | undefined): boolean | null => readValue(entity, name, text, defaultCtx()) as boolean | null;

/** The text of a model value for an element ('' for none: the element is left out). */
export function writeValue(entity: Entity, name: string, v: Value | undefined, c: Ctx): string {
  const t = spec(entity, name);
  if (v == null || v === '') return '';
  if (t === 'rate') return p6num(v as number);
  if (t === 'lag') return writeLag(v as number);
  return (WRITE[t] as (v: Value, c: Ctx, entity: Entity) => string)(v, c, entity);
}

// ---------- the revision of the clone's own files

/** How the clone writes the values of a file, stamped in the file (mspdi.ts, the "P6 Schedule Rules" definition's alias): 2, currency as Microsoft
 *  Project stores it (hundredths). A file the clone wrote that has no stamp is revision 1: its currency elements hold plain units. */
export const FORMAT_REVISION = 2;
export const revisionText = (): string => `format ${FORMAT_REVISION}`;
