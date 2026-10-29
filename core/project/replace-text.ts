// replace_text: one operation that renames words and phrases in every text field of every table (anonymising a schedule), and in the file header's identity fields.
//   - which fields: the ones that hold names, short names, descriptions, notes and notebooks (HTML memos: only the text between the tags), titles, UDF text, code values, step and expense names,
//     issue text, e-mail addresses, authors. Never an ID or reference (task_id...), a GUID, a date, a number, a flag, or a value P6 itself defines (task_type, status_code, calendar data...).
//   - how a term matches: a term of up to 3 letters (initials: TGS) only as a whole word, so SETTINGS is left alone; a longer one anywhere. A script written without spaces (Chinese, Japanese,
//     Thai...) has no whole words: its terms match anywhere. With case_insensitive the comparison is Unicode case folding (Straße = STRASSE, Σ = ς = σ); the text is compared as NFC.
//   - several terms: the longest wins where they overlap; text a replacement produced is never searched again.

export interface Pair { find: string; replace: string }
export interface Term { pair: number; folded: string; whole: boolean }

const WORD = /[\p{L}\p{N}\p{M}_]/u;
/** Scripts with no spaces between words: a whole-word rule cannot be applied to them. */
const UNSPACED = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Thai}\p{Script=Lao}\p{Script=Khmer}\p{Script=Myanmar}]/u;
const LETTER = /\p{L}/u;
const SHORT = 3;

/** A code point's case-folded form: upper then lower (ß -> ss, ς -> σ), the way a person reads two spellings as the same word. */
const foldChar = (c: string): string => c.toUpperCase().toLowerCase();

export function compile(pairs: unknown, caseInsensitive: boolean): { terms: Term[]; pairs: Pair[] } {
  if (!Array.isArray(pairs) || !pairs.length) throw new Error('"pairs" must be a list of {find, replace}.');
  const out: Pair[] = [], terms: Term[] = [], seen = new Map<string, number>();
  pairs.forEach((p, i) => {
    if (!p || typeof p !== 'object' || typeof (p as Pair).find !== 'string' || !(p as Pair).find.length) throw new Error(`pairs[${i}] needs a "find" text.`);
    const rep = (p as Pair).replace;
    if (typeof rep !== 'string') throw new Error(`pairs[${i}] needs a "replace" text (an empty one removes the term).`);
    const find = (p as Pair).find.normalize('NFC');
    if (!LETTER.test(find)) throw new Error(`pairs[${i}]: "${find}" has no letter in it; numbers, dates and IDs are not replaced.`);
    const key = caseInsensitive ? [...find].map(foldChar).join('') : find;
    if (seen.has(key)) throw new Error(`pairs[${i}] repeats pairs[${seen.get(key)}] ("${find}").`);
    seen.set(key, i);
    out.push({ find, replace: rep.normalize('NFC') });
    terms.push({ pair: i, folded: key, whole: [...find].length <= SHORT && !UNSPACED.test(find) });
  });
  return { terms, pairs: out };
}

interface Hit { start: number; end: number; pair: number }
/** The matches of every term in a text, longest first where they overlap: positions in the (NFC) text. */
function matchesIn(text: string, terms: Term[], ci: boolean): Hit[] {
  // the folded text, with the position in `text` each folded unit comes from
  let folded = '';
  const from: number[] = [], to: number[] = [], startsChar: boolean[] = [], endsChar: boolean[] = [];
  for (let i = 0; i < text.length;) {
    const cp = text.codePointAt(i)!, c = String.fromCodePoint(cp), f = ci ? foldChar(c) : c;
    for (let k = 0; k < f.length; k++) { from.push(i); to.push(i + c.length); startsChar.push(k === 0); endsChar.push(k === f.length - 1); }
    folded += f;
    i += c.length;
  }
  const hits: Hit[] = [];
  for (const t of terms) {
    for (let at = folded.indexOf(t.folded); at >= 0; at = folded.indexOf(t.folded, at + 1)) {
      const last = at + t.folded.length - 1;
      if (!startsChar[at] || !endsChar[last]) continue;
      const start = from[at], end = to[last];
      if (t.whole) {
        const before = start > 0 ? charBefore(text, start) : '';
        const after = end < text.length ? String.fromCodePoint(text.codePointAt(end)!) : '';
        if ((before && WORD.test(before)) || (after && WORD.test(after))) continue;
      }
      hits.push({ start, end, pair: t.pair });
    }
  }
  // the longest first, then the earliest; what overlaps one already taken is dropped
  hits.sort((a, b) => (b.end - b.start) - (a.end - a.start) || a.start - b.start || a.pair - b.pair);
  const taken = new Uint8Array(text.length), kept: Hit[] = [];
  for (const h of hits) {
    let free = true;
    for (let i = h.start; i < h.end; i++) if (taken[i]) { free = false; break; }
    if (!free) continue;
    taken.fill(1, h.start, h.end);
    kept.push(h);
  }
  return kept.sort((a, b) => a.start - b.start);
}

/** The character (code point) that ends at `end`. */
function charBefore(text: string, end: number): string {
  const lo = text.charCodeAt(end - 1);
  if (lo >= 0xdc00 && lo <= 0xdfff && end >= 2) { const hi = text.charCodeAt(end - 2); if (hi >= 0xd800 && hi <= 0xdbff) return text.slice(end - 2, end); }
  return text[end - 1];
}

/** Replace in a plain text. Returns the text unchanged (the very string) when nothing matched. */
export function replacePlain(value: string, terms: Term[], pairs: Pair[], ci: boolean, count: (pair: number) => void): string {
  if (!LETTER.test(value)) return value;
  const text = value.normalize('NFC');
  const hits = matchesIn(text, terms, ci);
  if (!hits.length) return value;
  let out = '', at = 0;
  for (const h of hits) { out += text.slice(at, h.start) + pairs[h.pair].replace; at = h.end; count(h.pair); }
  return out + text.slice(at);
}

const TAG = /(<\/?[A-Za-z!][^<>]*>)/;
const HAS_TAG = /<\/?[A-Za-z][^<>]*>/;
const escapeHtml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
/** Replace in an HTML memo: the text between the tags only (markup, attributes and styles are not touched); a term with &, < or > is also found as its entity form. */
export function replaceHtml(value: string, terms: Term[], pairs: Pair[], ci: boolean, count: (pair: number) => void): string {
  const extra: Term[] = [], escPairs = pairs.map((p) => ({ find: p.find, replace: escapeHtml(p.replace) }));
  for (const t of terms) {
    const f = pairs[t.pair].find;
    if (/[&<>]/.test(f)) extra.push({ pair: t.pair, folded: ci ? [...escapeHtml(f)].map(foldChar).join('') : escapeHtml(f), whole: t.whole });
  }
  // (the text between tags is HTML: a replacement with & < > goes in escaped, and a term with them is also looked for as the entity form)
  const all = [...terms, ...extra];
  let changed = false;
  const res = value.split(TAG).map((seg, i) => {
    if (i % 2 === 1) return seg; // a tag
    const r = replacePlain(seg, all, escPairs, ci, count); // one pass: the plain and the entity form of the terms together, longest first
    if (r !== seg) changed = true;
    return r;
  });
  return changed ? res.join('') : value;
}

export const isHtml = (v: string): boolean => HAS_TAG.test(v);

/** The fields that hold text to rename, by name (see the header). */
const NAME_FIELD = /(?:name|descr|descript\w*|notes?|memo|comments?|title|label|url|path)$/i;
const EXACT = new Set(['task_code', 'udf_text', 'actv_code_type', 'proj_catg_type', 'rsrc_catg_type', 'memo_type', 'po_number', 'email_addr', 'employee_code', 'baseline_names_to_export', 'curr_type',
  'create_user', 'update_user']);
/** Fields that end like a name but are P6's own: the table a UDF is on, a threshold's column, a UDF's system name. */
const NOT_TEXT = new Set(['table_name', 'thresh_field_name', 'udf_type_name', 'name_sep_char']);
export function isTextField(table: string, field: string): boolean {
  if (field.startsWith('_')) return field === '_name' || field.startsWith('_xml_');
  if (NOT_TEXT.has(field)) return false;
  if (table === 'COSTTYPE' && field === 'cost_type') return true; // the expense category's name (PROJCOST.cost_type is a P6 code)
  return EXACT.has(field) || NAME_FIELD.test(field);
}
