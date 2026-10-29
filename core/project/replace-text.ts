// replace_text: one operation that renames words and phrases in every text field of every table (anonymising a schedule), and in the file header's identity fields.
//   - which fields: the ones that hold names, short names, descriptions, notes and notebooks (HTML memos: only the text between the tags), titles, UDF text, code values, step and expense names,
//     issue text, e-mail addresses, authors. Never an ID or reference (task_id...), a GUID, a date, a number, a flag, or a value P6 itself defines (task_type, status_code, calendar data...).
//   - how a term matches: as a whole word, whatever its length (Mall is not in Small, Park not in Parking, TGS not in SETTINGS); with anywhere: true, anywhere in a word. A script written without
//     spaces (Chinese, Japanese, Thai...) has no whole words: its terms match anywhere. With case_insensitive the comparison is Unicode case folding (Straße = STRASSE, Σ = ς = σ); the text is
//     compared as NFC. Arabic spellings are one whatever the case rule (alef forms, ة = ه, ى = ي, Persian ک ی, no tatweel or vowel marks); Arabic and Hebrew words carry prefixes (و ب ل ال...,
//     ו ה ב...), which a whole-word term accepts, the prefix kept - and every such match is listed in the answer, since a prefix letter can also belong to another word.
//   - HTML memos: the text between the tags is decoded for matching (&amp; &nbsp; &#1575;...), so an entity is never matched inside, and a term with & or a space finds its entity form.
//   - several terms: the longest wins where they overlap; text a replacement produced is never searched again.

export interface Pair { find: string; replace: string }
/** affix: the prefixes a whole-word term may carry in the script's writing (Arabic and Hebrew attach conjunctions, prepositions and the article to the word). */
export interface Term { pair: number; folded: string; whole: boolean; affix?: RegExp }
/** Called for each replacement: the pair, and for a match made through a prefix (Arabic, Hebrew) the whole word it stood in. */
export type Count = (pair: number, prefixedWord?: string) => void;

const WORD = /[\p{L}\p{N}\p{M}_]/u;
/** Scripts with no spaces between words: a whole-word rule cannot be applied to them. */
const UNSPACED = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Thai}\p{Script=Lao}\p{Script=Khmer}\p{Script=Myanmar}]/u;
const LETTER = /\p{L}/u;
// Arabic: و/ف (and, then), then ب/ك/ل (in, like, to) and/or the article ال, where لل is ل + ال contracted (والأمل, بالأمل, للأمل, فللأمل). Hebrew: ו ה ב ل מ ש כ, up to three (והבית, מבית, כשבית).
const AR_AFFIX = /^[وف]?(?:لل|[بكل]?(?:ال)?)$/u;
const HE_AFFIX = /^[ושהבלמכ]{1,3}$/u;
const scriptAffix = (s: string): RegExp | undefined => (/\p{Script=Arabic}/u.test(s) ? AR_AFFIX : /\p{Script=Hebrew}/u.test(s) ? HE_AFFIX : undefined);

/** A code point's case-folded form: upper then lower (ß -> ss, ς -> σ), the way a person reads two spellings as the same word. */
const caseFold = (c: string): string => c.toUpperCase().toLowerCase();
// Arabic written the ways one name is written: the alef forms are one letter, ة and ه, ى and ي, the Persian/Urdu ک and ی the Arabic ك and ي; the tatweel and the vowel marks (harakat) are not part of the spelling.
const AR_FOLD: Record<string, string> = { 'أ': 'ا', 'إ': 'ا', 'آ': 'ا', 'ٱ': 'ا', 'ى': 'ي', 'ی': 'ي', 'ک': 'ك', 'ة': 'ه', 'ـ': '' };
const HARAKAT = /[ً-ْٰ]/;
const arabicFold = (c: string): string => AR_FOLD[c] ?? (HARAKAT.test(c) ? '' : c === ' ' ? ' ' : c);
/** The form a character is compared in: the Arabic spellings (and the no-break space as a space) are always one - orthography, not case; case folding only with case_insensitive. */
const foldChar = (c: string, ci = false): string => { const a = arabicFold(c); return ci ? caseFold(a) : a; };
const foldAll = (s: string, ci: boolean): string => [...s].map((c) => foldChar(c, ci)).join('');
/** Characters that follow a letter without being one (tatweel, vowel marks): a match takes the ones right after it. */
const IGNORABLE = /[ً-ْٰـ]/;

export function compile(pairs: unknown, caseInsensitive: boolean, anywhere = false): { terms: Term[]; pairs: Pair[] } {
  if (!Array.isArray(pairs) || !pairs.length) throw new Error('"pairs" must be a list of {find, replace}.');
  const out: Pair[] = [], terms: Term[] = [], seen = new Map<string, number>();
  pairs.forEach((p, i) => {
    if (!p || typeof p !== 'object' || typeof (p as Pair).find !== 'string' || !(p as Pair).find.length) throw new Error(`pairs[${i}] needs a "find" text.`);
    const rep = (p as Pair).replace;
    if (typeof rep !== 'string') throw new Error(`pairs[${i}] needs a "replace" text (an empty one removes the term).`);
    const find = (p as Pair).find.normalize('NFC');
    if (!LETTER.test(find)) throw new Error(`pairs[${i}]: "${find}" has no letter in it; numbers, dates and IDs are not replaced.`);
    const key = foldAll(find, caseInsensitive);
    if (seen.has(key)) throw new Error(`pairs[${i}] repeats pairs[${seen.get(key)}] ("${find}").`);
    seen.set(key, i);
    out.push({ find, replace: rep.normalize('NFC') });
    terms.push({ pair: i, folded: key, whole: !anywhere && !UNSPACED.test(find), affix: scriptAffix(find) });
  });
  // a term given with the article is matched without it too (with whatever prefixes the script allows before it), unless the list names that form itself
  terms.slice().forEach((t) => {
    const p = out[t.pair];
    const cut = /\p{Script=Arabic}/u.test(p.find) && t.folded.startsWith('ال') ? 2 : /\p{Script=Hebrew}/u.test(p.find) && t.folded.startsWith('ה') ? 1 : 0;
    const bare = cut ? t.folded.slice(cut) : '';
    if (!cut || [...bare].length < 2 || seen.has(bare)) return;
    seen.set(bare, t.pair);
    terms.push({ pair: t.pair, folded: bare, whole: t.whole, affix: t.affix });
  });
  return { terms, pairs: out };
}

interface Hit { start: number; end: number; pair: number; word?: string }
/** The matches of every term in a text, longest first where they overlap: positions in the text. */
function matchesIn(text: string, terms: Term[], ci: boolean): Hit[] {
  // the folded text, with the position in `text` each folded unit comes from
  let folded = '';
  const from: number[] = [], to: number[] = [], startsChar: boolean[] = [], endsChar: boolean[] = [];
  for (let i = 0; i < text.length;) {
    const cp = text.codePointAt(i)!, c = String.fromCodePoint(cp), f = foldChar(c, ci);
    for (let k = 0; k < f.length; k++) { from.push(i); to.push(i + c.length); startsChar.push(k === 0); endsChar.push(k === f.length - 1); }
    folded += f;
    i += c.length;
  }
  const hits: Hit[] = [];
  for (const t of terms) {
    for (let at = folded.indexOf(t.folded); at >= 0; at = folded.indexOf(t.folded, at + 1)) {
      const last = at + t.folded.length - 1;
      if (!startsChar[at] || !endsChar[last]) continue;
      const start = from[at];
      let end = to[last];
      while (end < text.length && IGNORABLE.test(text[end])) end++; // (the vowel marks and tatweel right after the term belong to it)
      let word: string | undefined;
      if (t.whole) {
        const after = end < text.length ? String.fromCodePoint(text.codePointAt(end)!) : '';
        if (after && WORD.test(after)) continue;
        // what stands before the term in its word must be nothing, or a prefix the script attaches to words
        let ws = start;
        while (ws > 0) { const ch = charBefore(text, ws); if (!WORD.test(ch)) break; ws -= ch.length; }
        const prefix = text.slice(ws, start);
        if (prefix) {
          if (!(t.affix && t.affix.test(foldAll(prefix, false).replace(/\p{M}/gu, '')))) continue;
          word = text.slice(ws, end);
        }
      }
      hits.push({ start, end, pair: t.pair, ...(word ? { word } : {}) });
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
export function replacePlain(value: string, terms: Term[], pairs: Pair[], ci: boolean, count: Count): string {
  if (!LETTER.test(value)) return value;
  const text = value.normalize('NFC');
  const hits = matchesIn(text, terms, ci);
  if (!hits.length) return value;
  let out = '', at = 0;
  for (const h of hits) { out += text.slice(at, h.start) + pairs[h.pair].replace; at = h.end; count(h.pair, h.word); }
  return out + text.slice(at);
}

const TAG = /(<\/?[A-Za-z!][^<>]*>)/;
const HAS_TAG = /<\/?[A-Za-z][^<>]*>/;
const ENTITY_SRC = '&(#x[0-9a-f]+|#\\d+|[a-z][a-z0-9]*);';
const NAMED: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
const escapeHtml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
/** A piece of HTML text decoded, each decoded unit knowing the span of the source it came from; the entities a memo editor writes are decoded, any other entity is one opaque mark nothing matches inside. */
function decode(seg: string): { text: string; from: number[]; to: number[] } {
  let text = '';
  const from: number[] = [], to: number[] = [];
  let at = 0;
  const lit = (a: number, b: number) => { for (let k = a; k < b; k++) { from.push(k); to.push(k + 1); } text += seg.slice(a, b); };
  for (const m of seg.matchAll(new RegExp(ENTITY_SRC, 'gi'))) {
    lit(at, m.index!);
    const e = m[1], num = e[0] === '#' ? (e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : Number(e.slice(1))) : -1;
    let ch = '￼';
    if (num >= 0 && num <= 0x10ffff && !(num >= 0xd800 && num <= 0xdfff)) ch = String.fromCodePoint(num);
    else if (num < 0 && NAMED[e.toLowerCase()] != null) ch = NAMED[e.toLowerCase()];
    for (let k = 0; k < ch.length; k++) { from.push(m.index!); to.push(m.index! + m[0].length); }
    text += ch;
    at = m.index! + m[0].length;
  }
  lit(at, seg.length);
  return { text, from, to };
}
/** Replace in an HTML memo: the text between the tags only (markup, attributes and styles are not touched), compared in its decoded form; a replacement with & < > is written escaped. */
export function replaceHtml(value: string, terms: Term[], pairs: Pair[], ci: boolean, count: Count): string {
  let changed = false;
  const res = value.split(TAG).map((seg, i) => {
    if (i % 2 === 1 || !LETTER.test(seg)) return seg; // a tag
    const d = decode(seg);
    const hits = matchesIn(d.text, terms, ci);
    if (!hits.length) return seg;
    changed = true;
    let out = '', at = 0;
    for (const h of hits) { out += seg.slice(at, d.from[h.start]) + escapeHtml(pairs[h.pair].replace); at = d.to[h.end - 1]; count(h.pair, h.word); }
    return out + seg.slice(at);
  });
  return changed ? res.join('') : value;
}

/** A value with markup or an entity is HTML (a notebook): matched on its decoded text, a replacement written escaped. */
export const isHtml = (v: string): boolean => HAS_TAG.test(v) || new RegExp(ENTITY_SRC, 'i').test(v);

/** The fields that hold text to rename, by name (see the header). */
const NAME_FIELD = /(?:name|descr|descript\w*|notes?|memo|comments?|title|label|url|path)$/i;
const EXACT = new Set(['task_code', 'udf_text', 'actv_code_type', 'proj_catg_type', 'rsrc_catg_type', 'memo_type', 'po_number', 'email_addr', 'employee_code', 'baseline_names_to_export', 'curr_type',
  'create_user', 'update_user']);
/** Fields that end like a name but are P6's own: the table a UDF is on, a threshold's column, a UDF's system name. */
const NOT_TEXT = new Set(['table_name', 'thresh_field_name', 'udf_type_name', 'name_sep_char']);
export function isTextField(table: string, field: string): boolean {
  // what a P6 XML file held that the clone has no column for is kept as _xml_<Tag> (a repeated tag as <Tag>#2): text only where the tag is a name, description, note or the like
  // (Status, Type, Priority... are P6's own words)
  if (field.startsWith('_xml_')) return NAME_FIELD.test(field.slice(5).replace(/#\d+$/, ''));
  if (field.startsWith('_')) return field === '_name';
  if (NOT_TEXT.has(field)) return false;
  if (table === 'COSTTYPE' && field === 'cost_type') return true; // the expense category's name (PROJCOST.cost_type is a P6 code)
  return EXACT.has(field) || NAME_FIELD.test(field);
}
