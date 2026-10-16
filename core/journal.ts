// Undo journal: run a change against a recording view of the database and keep only the values it overwrote.
// Undo then costs as much as the change itself, instead of a copy of the whole database (seconds and hundreds of
// MB per step on a 100 MB programme). Works on plain objects and arrays (the database is nothing else).
type Obj = Record<PropertyKey, unknown>;

export interface Journal {
  /** object -> key -> value before the change (absent = the key did not exist) */
  fields: Map<object, Map<PropertyKey, { had: boolean; old: unknown }>>;
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
    if (!m) j.fields.set(t, (m = new Map()));
    if (!m.has(k)) m.set(k, { had: Object.prototype.hasOwnProperty.call(t, k), old: (t as Obj)[k] });
  };
  // values written must never be views: store the real objects (arrays/objects built from views are cleaned too)
  const unwrap = (v: unknown, depth = 0): unknown => {
    if (v === null || typeof v !== 'object') return v;
    const t = targets.get(v);
    if (t) return t;
    if (depth > 2) return v;
    if (Array.isArray(v)) { for (let i = 0; i < v.length; i++) { const x = v[i]; if (x !== null && typeof x === 'object') v[i] = unwrap(x, depth + 1); } return v; }
    for (const k of Object.keys(v)) { const x = (v as Obj)[k]; if (x !== null && typeof x === 'object') (v as Obj)[k] = unwrap(x, depth + 1); }
    return v;
  };
  const wrap = (t: object): object => {
    let p = proxies.get(t);
    if (p) return p;
    p = new Proxy(t, {
      get(o, k) { const v = Reflect.get(o, k); return v !== null && typeof v === 'object' ? wrap(v) : v; },
      set(o, k, v) { note(o, k); return Reflect.set(o, k, unwrap(v)); },
      deleteProperty(o, k) { note(o, k); return Reflect.deleteProperty(o, k); },
      defineProperty(o, k, d) { note(o, k); if ('value' in d) d = { ...d, value: unwrap(d.value) }; return Reflect.defineProperty(o, k, d); },
    });
    proxies.set(t, p); targets.set(p, t);
    return p;
  };
  try { fn(wrap(root) as T); } catch (e) { rollback(j); throw e; } // a failed change leaves nothing half-done
  return j;
}

/** Put back what a journal recorded. Returns the journal that re-applies the change (for redo). */
export function rollback(j: Journal): Journal {
  const back: Journal = { fields: new Map(), arrays: new Map() };
  for (const [a, before] of j.arrays) {
    back.arrays.set(a, a.slice());
    a.length = 0;
    for (const x of before) a.push(x);
  }
  for (const [o, keys] of j.fields) {
    const m = new Map<PropertyKey, { had: boolean; old: unknown }>();
    for (const [k, { had, old }] of keys) {
      m.set(k, { had: Object.prototype.hasOwnProperty.call(o, k), old: (o as Obj)[k] });
      if (had) (o as Obj)[k] = old; else delete (o as Obj)[k];
    }
    back.fields.set(o, m);
  }
  return back;
}
