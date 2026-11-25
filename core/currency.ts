/**
 * The base currency of a file, as P6 keeps it (Admin > Currencies; Oracle, "The Base Currency"): every cost of every project is stored in it,
 * and costs are shown in it — its symbol, decimal places, separators and the positive and negative formats of its CURRTYPE row. A file names
 * its base currency; when it names none, nothing is assumed: the answers say so and an XER is not written until one is set (set_currency).
 */
import type { Db, Row } from './db.ts';
import { ermhdrCurrency } from './db.ts';
import { removeWhere } from './journal.ts';

export const CURRTYPE_FIELDS = ['curr_id', 'decimal_digit_cnt', 'curr_symbol', 'decimal_symbol', 'digit_group_symbol', 'pos_curr_fmt_type', 'neg_curr_fmt_type', 'curr_type', 'curr_short_name', 'group_digit_cnt', 'base_exch_rate'];

/** The file's base currency as its CURRTYPE table holds it: the row its ERMHDR line names, else the one P6 XML marks as the base, else the one at
 *  exchange rate 1, else the only one; null when the table has none (or several and nothing says which is the base). */
function storedBase(db: Db): Row | null {
  const rows = db.tables.CURRTYPE?.rows ?? [];
  if (!rows.length) return null;
  const named = ermhdrCurrency(db.header?.raw);
  return (named && rows.find((r) => r.curr_short_name === named))
    || rows.find((r) => r._xml_IsBaseCurrency === 'true')
    || (rows.length === 1 ? rows[0] : rows.filter((r) => Number(r.base_exch_rate) === 1).length === 1 ? rows.find((r) => Number(r.base_exch_rate) === 1)! : null);
}

/** A header's currency as a row, per code (an XER with no CURRTYPE table is read once per cell of a screen: not built again each time). */
const fromHeader = new Map<string, Row>();

/** The file's base currency: as its CURRTYPE table holds it, else as its ERMHDR line names it (an XER with no CURRTYPE table): an ISO code's own
 *  name, symbol and places, else the ID alone (nothing is known of it but its name); null when the file names none. */
export function baseCurrency(db: Db): Row | null {
  const stored = storedBase(db);
  if (stored || db.tables.CURRTYPE?.rows.length) return stored;
  const named = ermhdrCurrency(db.header?.raw);
  if (!named) return null;
  let r = fromHeader.get(named);
  if (!r) {
    try { r = currencyRow(named); } catch { r = { curr_short_name: named, curr_type: named }; }
    fromHeader.set(named, r);
  }
  return r;
}

/** The base currency as an answer names it: its ID (P6's Currency ID, e.g. EUR), or null when the file names none. */
export const currencyId = (db: Db): string | null => baseCurrency(db)?.curr_short_name || null;

/** A number as the clone shows one with no currency format to follow: to the hundredth, as its screens and reports showed amounts before. */
const plain = (v: number): string => String(Math.round(v * 100) / 100);

/** An amount as P6 shows it in the base currency: its symbol, decimal places, separators and positive / negative formats. A currency known by
 *  its ID alone (no symbol or formats in the file): the number and the ID. No base currency: the number. */
export function formatMoney(db: Db, n: number): string {
  const c = baseCurrency(db);
  const v = Number.isFinite(n) ? n : 0;
  if (!c) return plain(v);
  if (c.curr_symbol == null || !c.pos_curr_fmt_type || !c.neg_curr_fmt_type || !c.decimal_symbol || c.decimal_digit_cnt == null) return `${plain(v)} ${c.curr_short_name}`;
  const places = Math.max(0, Number.parseInt(c.decimal_digit_cnt, 10) || 0);
  // (P6 XML carries no grouping count: P6 groups by three — every CURRTYPE row of the sample P6 exports holds 3)
  const group = Math.max(0, Number.parseInt(c.group_digit_cnt ?? '3', 10) || 0);
  const [int, frac] = Math.abs(v).toFixed(places).split('.');
  const grouped = group > 0 && c.digit_group_symbol ? int.replace(new RegExp(`\\B(?=(\\d{${group}})+(?!\\d))`, 'g'), c.digit_group_symbol) : int;
  const amount = frac ? `${grouped}${c.decimal_symbol}${frac}` : grouped;
  return (v < 0 ? c.neg_curr_fmt_type : c.pos_curr_fmt_type).replace('1.1', '\u0000').replace('#', c.curr_symbol).replace('\u0000', amount);
}

/** What a caller gives for a currency: an ISO 4217 code ("EUR"), or the code with any of P6's other settings of it. */
export type CurrencySpec = string | { code: string; name?: string; symbol?: string; decimal_places?: number; decimal_symbol?: string; group_symbol?: string };

/**
 * A base currency row from what a caller gave: the code (ISO 4217, upper case; refused when unknown), its English name and symbol as the code
 * defines them (Intl) unless given, its decimal places (the code's usual ones, at most P6's 2), and the rest as the currencies P6 ships hold
 * them unless given (decimal symbol ".", digit grouping "," by three, positive "#1.1", negative "(#1.1)": every currency row of the sample P6
 * exports). P6's Currencies dialog allows a period or a comma as the decimal symbol, a comma, period or dash for grouping, and 0, 1 or 2
 * decimal places (Oracle, "Appearance tab - Currencies dialog box"): a value outside those is refused. Throws, in words.
 */
export function currencyRow(spec: CurrencySpec, id = '1'): Row {
  const o = typeof spec === 'string' ? { code: spec } : spec;
  if (!o || typeof o !== 'object' || typeof o.code !== 'string') throw new Error('currency is an ISO 4217 code such as "EUR", or {code, [name], [symbol], [decimal_places], [decimal_symbol], [group_symbol]}.');
  const code = o.code.trim().toUpperCase();
  const known = (Intl as unknown as { supportedValuesOf?: (k: string) => string[] }).supportedValuesOf?.('currency') ?? [];
  if (!/^[A-Z]{3}$/.test(code) || (known.length && !known.includes(code))) throw new Error(`"${o.code}" is not an ISO 4217 currency code (EUR, GBP, SAR, AED, USD …).`);
  const nf = new Intl.NumberFormat('en', { style: 'currency', currency: code });
  const symbol = o.symbol ?? nf.formatToParts(1).find((p) => p.type === 'currency')?.value ?? code;
  const name = o.name ?? new Intl.DisplayNames(['en'], { type: 'currency' }).of(code) ?? code;
  const usual = nf.resolvedOptions().maximumFractionDigits ?? 0;   // (Intl names every ISO currency's places; the type allows none)
  const places = o.decimal_places ?? Math.min(usual, 2);   // (a currency of 3, as the Kuwaiti dinar: P6 shows 2 at most)
  if (![0, 1, 2].includes(places)) throw new Error('decimal_places is 0, 1 or 2: the places P6 shows a currency with.');
  if (o.decimal_symbol != null && !['.', ','].includes(o.decimal_symbol)) throw new Error('decimal_symbol is "." or ",": the two P6 allows.');
  if (o.group_symbol != null && ![',', '.', '-'].includes(o.group_symbol)) throw new Error('group_symbol is ",", "." or "-": the three P6 allows.');
  if ((o.decimal_symbol ?? '.') === (o.group_symbol ?? ',')) throw new Error('decimal_symbol and group_symbol must differ.');
  return {
    curr_id: id, decimal_digit_cnt: String(places), curr_symbol: symbol, decimal_symbol: o.decimal_symbol ?? '.', digit_group_symbol: o.group_symbol ?? ',',
    pos_curr_fmt_type: '#1.1', neg_curr_fmt_type: '(#1.1)', curr_type: name, curr_short_name: code, group_digit_cnt: '3', base_exch_rate: '1',
  };
}

/** What setBaseCurrency did: the base currency's ID before (null: none), its row now, and the row of the same currency the file listed
 *  besides the base one, merged into it (null: none). */
export interface BaseCurrencyChange { was: string | null; now: Row; merged: { id: string; name: string; rate: string; resources: number } | null }

/** The currency settings a caller can give, as the CURRTYPE fields they set. */
const GIVEN: Array<[keyof Exclude<CurrencySpec, string>, string]> = [['name', 'curr_type'], ['symbol', 'curr_symbol'], ['decimal_places', 'decimal_digit_cnt'], ['decimal_symbol', 'decimal_symbol'], ['group_symbol', 'digit_group_symbol']];

/**
 * Makes `spec` the file's base currency (P6: Admin > Currencies, the base currency edited in place: its ID, name and symbol can be changed;
 * amounts are not converted). The file's currency list is P6's database list as the export wrote it, one row per Currency ID: when it
 * already lists that currency besides the base one, that row becomes the base currency — the base row takes its ID and its own settings
 * (name, symbol, places, separators, formats; what the caller gives wins), the other row goes, and a resource that named it names the
 * base (as a P6 user deletes that currency, then edits the base). The rest of the list keeps its exchange rates. A file with none gets
 * the currency as its one currency. Only this file changes.
 */
export function setBaseCurrency(db: Db, spec: CurrencySpec): BaseCurrencyChange {
  const t = (db.tables.CURRTYPE ??= { name: 'CURRTYPE', fields: [...CURRTYPE_FIELDS], rows: [] });
  for (const f of CURRTYPE_FIELDS) if (!t.fields.includes(f)) t.fields.push(f);
  const base = storedBase(db);
  const was0 = base ? null : ermhdrCurrency(db.header?.raw) || null;   // (a header-only currency: the row is written now, the header follows)
  if (!base && t.rows.length) throw new Error(`The file has ${t.rows.length} currencies and does not say which is the base one; set_currency cannot tell which to change.`);
  const row = currencyRow(spec, base?.curr_id ?? '1');
  const other = base ? t.rows.find((r) => r.curr_id !== base.curr_id && r.curr_short_name === row.curr_short_name) : undefined;
  let merged: BaseCurrencyChange['merged'] = null;
  if (base && other) {
    // the file's own row of that currency: its settings, unless the caller gave them
    const given: Partial<Exclude<CurrencySpec, string>> = typeof spec === 'string' ? {} : spec;
    for (const f of ['curr_type', 'curr_symbol', 'decimal_digit_cnt', 'decimal_symbol', 'digit_group_symbol', 'pos_curr_fmt_type', 'neg_curr_fmt_type', 'group_digit_cnt']) {
      const by = GIVEN.find(([, field]) => field === f)?.[0];
      if ((by == null || given[by] == null) && other[f] != null && other[f] !== '') row[f] = other[f];
    }
    const id = other.curr_id;
    let resources = 0;
    for (const r of db.tables.RSRC?.rows ?? []) if (r.curr_id === id) { r.curr_id = base.curr_id; resources++; }
    merged = { id: other.curr_short_name, name: other.curr_type || '', rate: other.base_exch_rate || '', resources };
    removeWhere(t.rows, (r) => r.curr_id === id);
  }
  if (base) {
    const was = base.curr_short_name || null;
    const keep = { ...base };
    Object.assign(base, row, { base_exch_rate: keep.base_exch_rate || '1' });
    if (keep._xml_IsBaseCurrency) base._xml_IsBaseCurrency = keep._xml_IsBaseCurrency;
    // the header names the base currency too: it follows
    if (db.header?.raw && ermhdrCurrency(db.header.raw) === was) db.header.raw[db.header.raw.length - 1] = row.curr_short_name;
    return { was, now: base, merged };
  }
  t.rows.push(row);
  if (was0 && db.header?.raw) db.header.raw[db.header.raw.length - 1] = row.curr_short_name;
  return { was: was0, now: row, merged };
}

/** The answers that carry the file's base currency: those that give costs (in the variant that gives them), and the open and new file's. One
 *  rule for both ways a tool is called (the MCP server; the desktop app's embedded agent, renderer/ai/liveBridge.ts). */
export function namesCurrency(name: string, a: Record<string, unknown>): boolean {
  switch (name) {
    case 'open_file': case 'new_project': case 'earned_value': case 'resource_summary': case 'get_activity': case 'evaluate_batch': case 'crash_schedule': case 'run_report': return true;
    case 'progress_curves': return (a.units ?? 'cost') === 'cost';
    case 'resource_histogram': return a.cost === true;
    case 'optimize_schedule': return a.objective === 'min_crash_cost';
    case 'activity_table': return a.of === 'assignments';
    default: return false;
  }
}

/** An answer with the file's base currency named (`currency`: its ID); a file that names none: null, and said in the answer's notes. */
export function withCurrency(db: Db, out: Record<string, unknown>): Record<string, unknown> {
  const c = currencyId(db), own = Array.isArray(out.notes) ? (out.notes as string[]) : [];
  return { ...out, currency: c, ...(c ? {} : { notes: [...own, 'The file names no base currency: its costs are plain numbers. Set it with edit set_currency (an ISO 4217 code such as "EUR").'] }) };
}
