/**
 * The base currency of a file, as P6 keeps it (Admin > Currencies; Oracle, "The Base Currency"): every cost of every project is stored in it,
 * and costs are shown in it — its symbol, decimal places, separators and the positive and negative formats of its CURRTYPE row. A file names
 * its base currency; when it names none, nothing is assumed: the answers say so and an XER is not written until one is set (set_currency).
 */
import type { Db, Row } from './db.ts';
import { ermhdrCurrency } from './db.ts';

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

/** The file's base currency: as its CURRTYPE table holds it, else as its ERMHDR line names it (an XER with no CURRTYPE table: the code's own
 *  name and symbol when it is an ISO code, else the ID as P6 shows a currency it has no symbol for); null when the file names none. */
export function baseCurrency(db: Db): Row | null {
  const stored = storedBase(db);
  if (stored || db.tables.CURRTYPE?.rows.length) return stored;
  const named = ermhdrCurrency(db.header?.raw);
  if (!named) return null;
  try { return currencyRow(named); }
  catch { return { curr_id: '1', curr_short_name: named, curr_type: named, curr_symbol: named, decimal_digit_cnt: '2', decimal_symbol: '.', digit_group_symbol: ',', group_digit_cnt: '3', pos_curr_fmt_type: '1.1 #', neg_curr_fmt_type: '-1.1 #', base_exch_rate: '1' }; }
}

/** The base currency as an answer names it: its ID (P6's Currency ID, e.g. EUR), or null when the file names none. */
export const currencyId = (db: Db): string | null => baseCurrency(db)?.curr_short_name || null;

/** An amount as P6 shows it in the base currency (its symbol and formats); with no base currency, the plain number. */
export function formatMoney(db: Db, n: number): string {
  const c = baseCurrency(db);
  const v = Number.isFinite(n) ? n : 0;
  if (!c) return String(v);
  const places = Math.max(0, Number.parseInt(c.decimal_digit_cnt, 10) || 0);
  const group = Math.max(0, Number.parseInt(c.group_digit_cnt || '3', 10) || 0);
  const [int, frac] = Math.abs(v).toFixed(places).split('.');
  const grouped = group > 0 ? int.replace(new RegExp(`\\B(?=(\\d{${group}})+(?!\\d))`, 'g'), c.digit_group_symbol ?? '') : int;
  const amount = frac ? `${grouped}${c.decimal_symbol || '.'}${frac}` : grouped;
  // (a row read without formats — a P6 XML file names none — takes P6's own formats for a new currency)
  const fmt = v < 0 ? (c.neg_curr_fmt_type || '(#1.1)') : (c.pos_curr_fmt_type || '#1.1');
  return fmt.replace('1.1', '\u0000').replace('#', c.curr_symbol ?? '').replace('\u0000', amount);
}

/** What a caller gives for a currency: an ISO 4217 code ("EUR"), or the code with any of P6's other settings of it. */
export type CurrencySpec = string | { code: string; name?: string; symbol?: string; decimal_places?: number; decimal_symbol?: string; group_symbol?: string };

/**
 * A base currency row from what a caller gave: the code (ISO 4217, upper case; refused when unknown), its English name and symbol as the
 * code defines them (Intl), its usual decimal places — each unless given — and P6's own settings for a new currency for the rest (decimal
 * symbol ".", digit grouping "," every 3 digits, positive "#1.1", negative "(#1.1)": the Currencies dialog's defaults). Throws, in words.
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
  const places = o.decimal_places ?? nf.resolvedOptions().maximumFractionDigits ?? 0;   // (Intl names every ISO currency's places; the type allows none)
  if (!Number.isInteger(places) || places < 0) throw new Error('decimal_places is a whole number, 0 or more.');
  try { new Intl.NumberFormat('en', { minimumFractionDigits: places, maximumFractionDigits: places }); } catch (e) { throw new Error(`decimal_places: ${(e as Error).message}`); }
  return {
    curr_id: id, decimal_digit_cnt: String(places), curr_symbol: symbol, decimal_symbol: o.decimal_symbol ?? '.', digit_group_symbol: o.group_symbol ?? ',',
    pos_curr_fmt_type: '#1.1', neg_curr_fmt_type: '(#1.1)', curr_type: name, curr_short_name: code, group_digit_cnt: '3', base_exch_rate: '1',
  };
}

/** Makes `spec` the file's base currency: the base row's ID, name, symbol and formats are replaced (P6: the base currency is edited in
 *  place; its ID, name and symbol can be changed), amounts are not converted. A file with none gets it as its one currency. Answers the
 *  ID it had (null: none). */
export function setBaseCurrency(db: Db, spec: CurrencySpec): { was: string | null; now: Row } {
  const t = (db.tables.CURRTYPE ??= { name: 'CURRTYPE', fields: [...CURRTYPE_FIELDS], rows: [] });
  for (const f of CURRTYPE_FIELDS) if (!t.fields.includes(f)) t.fields.push(f);
  const base = storedBase(db);
  const was0 = base ? null : ermhdrCurrency(db.header?.raw) || null;   // (a header-only currency: the row is written now, the header follows)
  if (!base && t.rows.length) throw new Error(`The file has ${t.rows.length} currencies and does not say which is the base one; set_currency cannot tell which to change.`);
  const row = currencyRow(spec, base?.curr_id ?? '1');
  if (base) {
    const was = base.curr_short_name || null;
    const keep = { ...base };
    Object.assign(base, row, { base_exch_rate: keep.base_exch_rate || '1' });
    if (keep._xml_IsBaseCurrency) base._xml_IsBaseCurrency = keep._xml_IsBaseCurrency;
    // the header names the base currency too: it follows
    if (db.header?.raw && ermhdrCurrency(db.header.raw) === was) db.header.raw[db.header.raw.length - 1] = row.curr_short_name;
    return { was, now: base };
  }
  t.rows.push(row);
  if (was0 && db.header?.raw) db.header.raw[db.header.raw.length - 1] = row.curr_short_name;
  return { was: was0, now: row };
}
