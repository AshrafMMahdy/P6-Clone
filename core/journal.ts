// Undo journal: run a change against a recording view of the database and keep only the values it overwrote.
// Undo then costs as much as the change itself, instead of a copy of the whole database (seconds and hundreds of
// MB per step on a 100 MB programme). Works on plain objects and arrays (the database is nothing else).
type Obj = Record<PropertyKey, unknown>;

/** Reading this key from a recording view gives the real object (for bulk work that records its own change). */
export const RAW = Symbol('raw');
/** The real object behind a recording view (or the value itself). */
export const rawOf = <T>(v: T): T => ((v as { [RAW]?: T } | null)?.[RAW] ?? v);

/** Old value of a key that did not exist before the change. */
export const ABSENT = Symbol('absent');

export interface Journal {
  /** object -> [key, value before the change (ABSENT = the key did not exist), key, value, ...]. A flat list, not a map:
   *  a schedule touches a dozen keys of each of 100k+ rows, and a Map plus an entry object per key costs ~1 KB a row.
   *  ponytail: linear search per write, fine for rows and tables (tens of keys). */
  fields: Map<object, unknown[]>;
  /** array -> its contents before the change */
  arrays: Map<unknown[], unknown[]>;
}

export function record<T extends object>(root: T, fn: (view: T) => void): Journal {
  const j: Journal = { fields: new Map(), arrays: new Map() };
  const proxies = new WeakMap<object, object>(); // target -> proxy
  const targets = new WeakMap<object, object>(); // proxy -> target
  const note = (t: object, k: PropertyKey) => {
    if (Array.isArray(t)) { if (!j.arrays.has(t)) j.arrays.set(t, t.slice()); return; }
    let m = j.fields.get(t);
    if (!m) j.fields.set(t, (m = []));
    for (let i = 0; i < m.length; i += 2) if (m[i] === k) return;
    m.push(k, Object.prototype.hasOwnProperty.call(t, k) ? (t as Obj)[k] : ABSENT);
  };
  // values written must never be views: store the real objects. A new array or object built from views (a filtered
  // row list, a new table) gets its view members replaced; rows themselves hold only text, so they are not walked.
  const real = (x: unknown) => (x !== null && typeof x === 'object' ? targets.get(x) ?? x : x);
  const cleanArray = (a: unknown[]) => { for (let i = 0; i < a.length; i++) { const x = a[i]; if (x !== null && typeof x === 'object') { const t = targets.get(x); if (t) a[i] = t; } } return a; };
  const unwrap = (v: unknown): unknown => {
    if (v === null || typeof v !== 'object') return v;
    const t = targets.get(v);
    if (t) return t;
    if (Array.isArray(v)) return cleanArray(v);
    for (const k in v) { const x = (v as Obj)[k]; if (x !== null && typeof x === 'object') (v as Obj)[k] = Array.isArray(real(x)) ? cleanArray(real(x) as unknown[]) : real(x); }
    return v;
  };
  // one handler for every view (a handler per view costs ~300 bytes on each of the 100k+ rows a schedule reads)
  const handler: ProxyHandler<object> = {
    get(o, k) { if (k === RAW) return o; const v = Reflect.get(o, k); return v !== null && typeof v === 'object' ? wrap(v) : v; },
    set(o, k, v) { note(o, k); return Reflect.set(o, k, unwrap(v)); },
    deleteProperty(o, k) { note(o, k); return Reflect.deleteProperty(o, k); },
    defineProperty(o, k, d) { note(o, k); if ('value' in d) d = { ...d, value: unwrap(d.value) }; return Reflect.defineProperty(o, k, d); },
  };
  const wrap = (t: object): object => {
    let p = proxies.get(t);
    if (p) return p;
    p = new Proxy(t, handler);
    proxies.set(t, p); targets.set(p, t);
    return p;
  };
  try { fn(wrap(root) as T); } catch (e) { rollback(j, false); throw e; } // a failed change leaves nothing half-done
  return j;
}

/** Put back what a journal recorded. Returns the journal that re-applies the change (for redo; empty when redo is false). */
export function rollback(j: Journal, redo = true): Journal {
  const back: Journal = { fields: new Map(), arrays: new Map() };
  for (const [a, before] of j.arrays) {
    if (redo) back.arrays.set(a, a.slice());
    a.length = 0;
    for (const x of before) a.push(x);
  }
  for (const [o, keys] of j.fields) {
    const m: unknown[] = [];
    for (let i = 0; i < keys.length; i += 2) {
      const k = keys[i] as PropertyKey, old = keys[i + 1];
      if (redo) m.push(k, Object.prototype.hasOwnProperty.call(o, k) ? (o as Obj)[k] : ABSENT);
      if (old !== ABSENT) (o as Obj)[k] = old; else delete (o as Obj)[k];
    }
    if (redo) back.fields.set(o, m);
  }
  return back;
}
