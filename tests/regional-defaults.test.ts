// Fourth ledger item 9 (owner, 2026-11-25: "I'll do your recommendations"): nothing regional is assumed.
//  · add_calendar copies a calendar (as P6's Add: "Select Calendar to Copy From") or takes a week; with neither it is refused, naming the calendars.
//  · The base currency is never assumed: new_project takes it (P6 asks for it when its database is set up), set_currency changes it (P6's
//    Admin > Currencies: the base currency edited in place, amounts not converted), the answers that give costs name it, an XER is not written in a
//    currency the file never named, a Microsoft Project file's own currency is its base currency, and costs are shown in it (no US dollars).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setRoots } from '../mcp/runtime.ts';
import { applyOps } from '../core/project/ops.ts';
import { baseCurrency, currencyRow, formatMoney } from '../core/currency.ts';
import { writeXer } from '../core/xer/write.ts';
import { parseXerFile } from '../core/xer/parseFile.ts';
import { parseP6Xml, writeP6Xml } from '../core/xml/p6xml.ts';
import { writeMpx } from '../core/msp/mpx.ts';
import { parseMspdi, writeMspdi } from '../core/msp/mspdi.ts';
import { rows, type Db } from '../core/db.ts';

process.env.P6CLONE_COMPUTE_WORKERS = '0';
const root = mkdtempSync(join(tmpdir(), 'p6-regional-'));
setRoots(null, root);
const call = async (name: string, args: Record<string, unknown>) => {
  const { callTool, toolResult } = await import('../mcp/server.ts');
  const r = await callTool(name, args);
  return { err: r.isError, d: toolResult(r.out, r.isError).structuredContent as any };
};
const SIX = { mon: [['07:00', '12:00'], ['13:00', '16:00']], tue: [['07:00', '12:00'], ['13:00', '16:00']], wed: [['07:00', '12:00'], ['13:00', '16:00']], thu: [['07:00', '12:00'], ['13:00', '16:00']], sat: [['07:00', '12:00'], ['13:00', '16:00']], sun: [['07:00', '12:00'], ['13:00', '16:00']] };

const MSPDI = (code: string) => `<?xml version="1.0"?><Project xmlns="http://schemas.microsoft.com/project"><Name>T</Name><StartDate>2026-03-02T08:00:00</StartDate><CurrencyCode>${code}</CurrencyCode><CurrencySymbol>€</CurrencySymbol><CurrencyDigits>2</CurrencyDigits><MinutesPerDay>480</MinutesPerDay><MinutesPerWeek>2400</MinutesPerWeek><Calendars><Calendar><UID>1</UID><Name>Standard</Name><IsBaseCalendar>1</IsBaseCalendar></Calendar></Calendars><CalendarUID>1</CalendarUID><Tasks><Task><UID>1</UID><ID>1</ID><Name>A</Name><Duration>PT8H0M0S</Duration><Start>2026-03-02T08:00:00</Start><Finish>2026-03-02T17:00:00</Finish></Task></Tasks></Project>`;

test('add_calendar with neither a calendar to copy nor a week is refused, naming the calendars it could copy', () => {
  const db: Db = { tables: {} };
  const empty = applyOps(db, [{ op: 'add_calendar', name: 'Site' }]);
  assert.equal(empty.ok, false);
  assert.match(empty.error!.message, /needs copy_from .* or work_week .* The file has no calendar yet: give work_week/);
  assert.equal(applyOps(db, [{ op: 'add_project', id: 'P1', start: '2026-03-01' }]).ok, true);
  const r = applyOps(db, [{ op: 'add_calendar', name: 'Site' }]);
  assert.equal(r.ok, false);
  assert.match(r.error!.message, /Calendars to copy: "Standard 5 Day Workweek"/);
  assert.ok(!rows(db, 'CALENDAR').some((c) => c.clndr_name === 'Site'), 'nothing added');
});

test('add_calendar copies a calendar: its week, its exceptions and its hours per period; a week given replaces the copied week', () => {
  const db: Db = { tables: {} };
  assert.equal(applyOps(db, [{ op: 'add_project', id: 'P1', start: '2026-03-01' }, { op: 'add_calendar', name: 'Gulf six-day', work_week: SIX, holidays: ['2026-03-20'] }]).ok, true);
  const gulf = rows(db, 'CALENDAR').find((c) => c.clndr_name === 'Gulf six-day')!;
  const r = applyOps(db, [{ op: 'add_calendar', name: 'Copy', copy_from: 'gulf six-day' }]);
  assert.equal(r.ok, true, JSON.stringify(r.error));
  const copy = rows(db, 'CALENDAR').find((c) => c.clndr_name === 'Copy')!;
  assert.equal(copy.clndr_data, gulf.clndr_data, 'the week and the holiday copied as they are');
  for (const f of ['day_hr_cnt', 'week_hr_cnt', 'month_hr_cnt', 'year_hr_cnt']) assert.equal(copy[f], gulf[f], f);
  const said = (r.results as any[])[0];
  assert.equal(said.copied_from, 'Gulf six-day');
  assert.deepEqual(said.work_week.fri, [], 'the answer says the week it holds');
  assert.deepEqual(said.work_week.sat, ['07:00-12:00', '13:00-16:00']);
  assert.equal(said.hours_per_week, 48);
  const r2 = applyOps(db, [{ op: 'add_calendar', name: 'Copy, Mon-Fri', copy_from: 'Gulf six-day', work_week: { mon: [['08:00', '16:00']], tue: [['08:00', '16:00']], wed: [['08:00', '16:00']], thu: [['08:00', '16:00']], fri: [['08:00', '16:00']] } }]);
  assert.equal(r2.ok, true);
  assert.equal((r2.results as any[])[0].hours_per_week, 40);
  assert.match(rows(db, 'CALENDAR').find((c) => c.clndr_name === 'Copy, Mon-Fri')!.clndr_data, /d\|46101/, 'the copied holiday stays (2026-03-20)');
  assert.equal(applyOps(db, [{ op: 'add_calendar', name: 'X', copy_from: 'Nope' }]).error!.message, 'No calendar "Nope".');
});

test('a file\'s first calendar is its default one (P6 always has one)', () => {
  const db: Db = { tables: {} };
  assert.equal(applyOps(db, [{ op: 'add_calendar', name: 'Only', work_week: SIX }]).ok, true);
  assert.equal(rows(db, 'CALENDAR')[0].default_flag, 'Y');
});

test('currencyRow: the code\'s own name, symbol and decimal places, P6\'s settings for a new currency; an unknown code is refused', () => {
  const eur = currencyRow('eur');
  assert.deepEqual([eur.curr_short_name, eur.curr_type, eur.curr_symbol, eur.decimal_digit_cnt, eur.decimal_symbol, eur.digit_group_symbol, eur.pos_curr_fmt_type, eur.neg_curr_fmt_type], ['EUR', 'Euro', '€', '2', '.', ',', '#1.1', '(#1.1)']);
  assert.equal(currencyRow('JPY').decimal_digit_cnt, '0');
  assert.equal(currencyRow('KWD').decimal_digit_cnt, '2', 'a currency of three places is shown with two: the most P6 shows');
  assert.equal(currencyRow({ code: 'SAR', symbol: 'SR', decimal_places: 2 }).curr_symbol, 'SR');
  assert.throws(() => currencyRow('EURO'), /not an ISO 4217 currency code/);
  assert.throws(() => currencyRow('XYZ'), /not an ISO 4217 currency code/);
});

test('formatMoney shows an amount as P6 does in the base currency: symbol, places, separators, the file\'s own formats; none named: the plain number', () => {
  const db: Db = { tables: {} };
  assert.equal(formatMoney(db, 1234.5), '1234.5');
  assert.equal(applyOps(db, [{ op: 'set_currency', code: 'EUR' }]).ok, true);
  assert.equal(formatMoney(db, 1234567.891), '€1,234,567.89');
  assert.equal(formatMoney(db, -1234.5), '(€1,234.50)');
  const c = baseCurrency(db)!;
  Object.assign(c, { curr_symbol: 'kr', decimal_symbol: ',', digit_group_symbol: ' ', pos_curr_fmt_type: '1.1 #', neg_curr_fmt_type: '-1.1 #' });
  assert.equal(formatMoney(db, 28000000), '28 000 000,00 kr');
  assert.equal(formatMoney(db, -5.5), '-5,50 kr');
});

test('new_project needs the base currency; it is the file\'s, named in the answer; set_currency changes it (amounts not converted); answers with costs name it', async () => {
  const none = await call('new_project', { id: 'NOCUR', start: '2026-03-02' });
  assert.equal(none.err, true);
  assert.match(none.d.error.message, /new_project needs currency/);
  const np = (await call('new_project', { id: 'RIY', start: '2026-03-02', currency: 'SAR' })).d;
  assert.equal(np.currency, 'SAR');
  const h = { handle: np.handle, owner_key: np.owner_key };
  const e = await call('edit', { ...h, operations: [
    { op: 'add_resource', id: 'MASON', type: 'labor', price_per_unit: 50 }, { op: 'add_activity', id: 'A1', name: 'Blockwork', duration_days: 5 },
    { op: 'assign_resource', activity: 'A1', resource: 'MASON', units_per_day: 8 }] });
  assert.equal(e.err, false, JSON.stringify(e.d).slice(0, 300));
  await call('schedule', h);
  const ev = (await call('earned_value', h)).d;
  assert.equal(ev.currency, 'SAR', 'the earned value answer names the currency its figures are in');
  const crit = (await call('critical_path', h)).d;
  assert.equal(crit.currency, undefined, 'an answer with no costs names none');
  const set = await call('edit', { ...h, operations: [{ op: 'set_currency', code: 'AED' }] });
  const said = set.d.results[0];
  assert.equal(said.currency, 'AED'); assert.equal(said.was, 'SAR');
  assert.match(said.note, /Amounts are not converted/);
  assert.equal((await call('earned_value', h)).d.currency, 'AED');
  const mismatch = await call('edit', { ...h, operations: [{ op: 'add_project', id: 'P2', start: '2026-03-02', currency: 'EUR' }] });
  assert.equal(mismatch.err, true);
  assert.match(JSON.stringify(mismatch.d), /base currency is AED/);
  const out = join(root, 'riy.xer');
  const saved = await call('save', { ...h, path: out });
  assert.equal(saved.err, false, JSON.stringify(saved.d).slice(0, 300));
  const xer = readFileSync(out, 'latin1');
  assert.match(xer.split('\n')[0], /\tAED\r?$/, 'the XER header names the currency');
  assert.match(xer.split('%T\tCURRTYPE')[1]?.split('%T')[0] ?? '', /%R[^\n]*\tAED\t/, 'the CURRTYPE row holds the currency');
});

test('a file that names no currency: the answers say so, and it is not written as an XER until one is set', async () => {
  const db: Db = { tables: {} };
  assert.equal(applyOps(db, [{ op: 'add_project', id: 'P', start: '2026-03-02' }]).ok, true);
  assert.equal(baseCurrency(db), null);
  assert.throws(() => writeXer(db, { version: '24.12' }), /names no base currency/);
  // the agent's save says it in words: a Microsoft Project file whose currency is no ISO code is opened with none
  const path = join(root, 'NoCurrency.xml');
  writeFileSync(path, MSPDI('Euros'));
  const op = (await call('open_file', { path })).d;
  assert.equal(op.currency, null); assert.ok((op.notes ?? []).some((n: string) => /names no base currency/.test(n)), JSON.stringify(op.notes));
  const refused = await call('save', { handle: op.handle, owner_key: op.owner_key, path: join(root, 'NoCurrency.xer') });
  assert.equal(refused.err, true);
  assert.equal(refused.d.error.code, 'no_currency'); assert.match(refused.d.error.next_step, /set_currency/);
  await call('edit', { handle: op.handle, owner_key: op.owner_key, operations: [{ op: 'set_currency', code: 'EUR' }] });
  assert.equal((await call('save', { handle: op.handle, owner_key: op.owner_key, path: join(root, 'NoCurrency.xer') })).err, false);
  assert.equal(applyOps(db, [{ op: 'set_currency', code: 'GBP' }]).ok, true);
  assert.match(Buffer.from(writeXer(db, { version: '24.12' })).toString('latin1').split('\n')[0], /\tGBP\r?$/);
});

test('an XER whose header names the currency and has no currency table: that is its currency (the Aurora sample)', async () => {
  const path = join(root, 'Aurora_Tower_Baseline.xer');
  copyFileSync(join(process.cwd(), 'Sample XERs', 'Aurora_Tower_Baseline.xer'), path);   // (read where the server may read)
  const op = (await call('open_file', { path, lenient: true })).d;   // (the sample opens leniently: P6 would refuse two of its rows)
  assert.equal(op.currency, 'USD', JSON.stringify(op).slice(0, 200));
  const db: Db = { tables: {}, header: { version: '12.0', exportDate: '', raw: ['ERMHDR', '12.0', '2026-06-22', 'Project', 'u', 'u', 'db', 'Project Management', 'SAR'] } };
  assert.equal(baseCurrency(db)!.curr_short_name, 'SAR');
  assert.equal(formatMoney(db, 10), 'SAR10.00');
  db.header!.raw[8] = 'Dinars';
  assert.equal(formatMoney(db, 10), '10 Dinars', 'an ID that is no ISO code: the plain amount and the ID after it');
  assert.equal(applyOps(db, [{ op: 'set_currency', code: 'KWD' }]).ok, true);
  assert.equal(db.header!.raw[8], 'KWD', 'the header follows');
  assert.equal(rows(db, 'CURRTYPE').length, 1);
});

test('a Microsoft Project file\'s own currency is the converted file\'s base currency; a code that is not ISO is said, not assumed', () => {
  const doc = MSPDI;
  const r = parseMspdi(doc('EUR'));
  const c = baseCurrency(r.db)!;
  assert.deepEqual([c.curr_short_name, c.curr_symbol, c.decimal_digit_cnt], ['EUR', '€', '2']);
  const odd = parseMspdi(doc('Euros'));
  assert.equal(baseCurrency(odd.db), null);
  assert.ok(odd.findings.some((f) => f.code === 'MSP_CURRENCY' && /Euros/.test(f.message)), JSON.stringify(odd.findings.map((f) => f.code)));
});

test('a copied project calendar carries the holidays it observes from its base calendar (its own exceptions win); a base loop ends', () => {
  const db: Db = { tables: {} };
  assert.equal(applyOps(db, [{ op: 'add_project', id: 'P1', start: '2026-03-01', currency: 'EUR' }, { op: 'add_calendar', name: 'Global', work_week: SIX, holidays: ['2026-03-20', '2026-03-23'] },
    { op: 'add_calendar', name: 'Project cal', work_week: SIX, work_exceptions: { '2026-03-23': [['07:00', '11:00']] } }]).ok, true);
  const g = rows(db, 'CALENDAR').find((c) => c.clndr_name === 'Global')!, pc = rows(db, 'CALENDAR').find((c) => c.clndr_name === 'Project cal')!;
  Object.assign(pc, { base_clndr_id: g.clndr_id, clndr_type: 'CA_Project' });
  assert.doesNotMatch(pc.clndr_data, /d\|46101/, 'the project calendar holds no holiday of its own');
  const r = applyOps(db, [{ op: 'add_calendar', name: 'Copy', copy_from: 'Project cal' }]);
  assert.equal(r.ok, true, JSON.stringify(r.error));
  const copy = rows(db, 'CALENDAR').find((c) => c.clndr_name === 'Copy')!;
  assert.equal(copy.base_clndr_id, '');
  assert.match(copy.clndr_data, /d\|46101\)\(\)/, 'the base calendar\'s holiday (2026-03-20) comes with the copy');
  assert.match(copy.clndr_data, /d\|46104\)\(\s*\(0\|\|0\(s\|07:00\|f\|11:00\)/, 'the copied calendar\'s own exception wins over the base\'s holiday (2026-03-23)');
  Object.assign(g, { base_clndr_id: pc.clndr_id });   // (a file whose two calendars name each other as base)
  assert.equal(applyOps(db, [{ op: 'add_calendar', name: 'Loop copy', copy_from: 'Project cal' }]).ok, true);
});

test('add_project with a currency on a file of several currencies that does not say which is the base: refused in words', () => {
  const db: Db = { tables: { CURRTYPE: { name: 'CURRTYPE', fields: [], rows: [{ ...currencyRow('EUR', '1'), base_exch_rate: '0.9' }, { ...currencyRow('GBP', '2'), base_exch_rate: '0.8' }] } } };
  const r = applyOps(db, [{ op: 'add_project', id: 'P', start: '2026-03-02', currency: 'EUR' }]);
  assert.equal(r.ok, false);
  assert.match(r.error!.message, /has 2 currencies and does not say which is its base one, so it cannot be given EUR: leave currency out/);
  assert.equal(applyOps(db, [{ op: 'add_project', id: 'P', start: '2026-03-02' }]).ok, true, 'without a currency it is made');
});

test('a P6 file of many currencies (cairo festival city): the base is the row its header names; another currency\'s code is not given to it', () => {
  const { db } = parseXerFile(join(process.cwd(), 'Sample XERs', 'cairo festival city.xer'));
  const n = rows(db, 'CURRTYPE').length;
  assert.ok(n > 5);
  assert.equal(baseCurrency(db)!.curr_id, '1');
  const dup = applyOps(db, [{ op: 'set_currency', code: 'ARS' }]);
  assert.equal(dup.ok, false);
  assert.match(dup.error!.message, /already has a currency ARS \(Argentine Peso, exchange rate 3\.077\), and P6 keeps one row per Currency ID/);
  const r = applyOps(db, [{ op: 'set_currency', code: 'EGP' }]);
  assert.equal(r.ok, true, JSON.stringify(r.error));
  assert.deepEqual((r.results as any[])[0].was, 'USD');
  const base = rows(db, 'CURRTYPE').find((c) => c.curr_id === '1')!;
  assert.deepEqual([base.curr_short_name, base.base_exch_rate, db.header!.raw.at(-1)], ['EGP', '1', 'EGP'], 'edited in place at its rate; the header follows');
  assert.equal(rows(db, 'CURRTYPE').length, n, 'no row added');
  assert.equal(rows(db, 'CURRTYPE').find((c) => c.curr_short_name === 'ARS')!.base_exch_rate, '3.077', 'the other currencies untouched');
});

test('the base currency survives every format the clone writes: P6 XML (separators and formats), Microsoft Project XML (its code), MPX (record 10)', () => {
  const db: Db = { tables: {} };
  assert.equal(applyOps(db, [{ op: 'add_project', id: 'P', start: '2026-03-02', currency: 'SAR' }, { op: 'set_currency', code: 'EUR', decimal_symbol: ',', group_symbol: '.' }]).ok, true);
  const back = baseCurrency(parseP6Xml(writeP6Xml(db, {})).db)!;
  assert.deepEqual([back.curr_short_name, back.curr_symbol, back.decimal_symbol, back.digit_group_symbol, back.pos_curr_fmt_type, back.neg_curr_fmt_type, back.decimal_digit_cnt],
    ['EUR', '€', ',', '.', '#1.1', '(#1.1)', '2']);
  const x = writeMspdi(db);
  assert.match(x, /<CurrencyCode>EUR<\/CurrencyCode>/);
  assert.equal(baseCurrency(parseMspdi(x).db)!.curr_short_name, 'EUR', 'opened again: the same currency');
  assert.match(writeMpx(db), /^10,€,0,2,\.,","\r?$/m, 'MPX record 10: the symbol before the amount, two places, thousands ".", decimal "," (quoted: the delimiter)');
  const none: Db = { tables: {} };
  assert.equal(applyOps(none, [{ op: 'add_project', id: 'P', start: '2026-03-02' }]).ok, true);
  assert.doesNotMatch(writeMpx(none), /^10,/m, 'a file that names none writes no currency record');
  assert.doesNotMatch(writeMspdi(none), /<CurrencyCode>/);
});

test('set_currency is undone and redone like any change; compute_schedule says the calendar it ran on; get_activity names the currency', async () => {
  const np = (await call('new_project', { id: 'UNDO', start: '2026-03-02', currency: 'SAR' })).d;
  const h = { handle: np.handle, owner_key: np.owner_key };
  assert.equal((await call('edit', { ...h, operations: [{ op: 'add_activity', id: 'A1', name: 'Dig', duration_days: 2 }] })).err, false);
  assert.equal((await call('edit', { ...h, operations: [{ op: 'set_currency', code: 'AED' }] })).err, false);
  assert.equal((await call('undo', h)).err, false);
  assert.equal((await call('get_activity', { ...h, activity_id: 'A1' })).d.currency, 'SAR', 'undone');
  assert.equal((await call('redo', h)).err, false);
  assert.equal((await call('get_activity', { ...h, activity_id: 'A1' })).d.currency, 'AED', 'redone');
  // a file that had no currency table: set_currency, undone, leaves it with none
  const path = join(root, 'UndoCur.xml');
  writeFileSync(path, MSPDI('Euros'));
  const op = (await call('open_file', { path })).d;
  const o = { handle: op.handle, owner_key: op.owner_key };
  await call('edit', { ...o, operations: [{ op: 'set_currency', code: 'EUR' }] });
  await call('undo', o);
  const repaired = await call('save', { ...o, path: join(root, 'UndoCur-repaired.xer'), repair: true });
  assert.equal(repaired.d.error?.code, 'no_currency', 'undone: no currency again, and a repaired copy is refused before any repair is made');
  assert.equal((await call('redo', o)).err, false, 'the refused save made no change: set_currency is still there to redo');
  assert.equal((await call('save', { ...o, path: join(root, 'UndoCur.xer') })).err, false, 'redone: written');
  const c = (await call('compute_schedule', { start: '2026-03-02', activities: [{ id: 'A', duration_days: 3 }] })).d;
  assert.ok(c.notes.some((n: string) => /^No calendar was named: computed on the default calendar "Standard 5 Day Workweek" \(Mon 8 h, Tue 8 h, Wed 8 h, Thu 8 h, Fri 8 h\)/.test(n)), JSON.stringify(c.notes));
});
