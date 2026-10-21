// Tactplan exchange. Tactplan (Vico Office's successor) has no project file: each grid goes in and out as a CSV or a
// clipboard table. Layouts from its 2.5.1 import dialogs and a real Grid export:
//   Locations: Id, Name, Level, Location level (the tree in row order; level 0 is the root "Project")
//   Grid: Id, Name, Code, Start date, Finish date, Color, ASAP, Paced, Milestone, Location precision, then a column per
//         location under a header of one row per level (the level legend "Floor (2)" down the precision column, each
//         location's path down its column); one row per subtask; durations in days; empty = not in the task, * = in
//         another subtask of the same task
//   Quantities: Id, Name, Consumption, Unit, Location precision, then a quantity column per location (same header)
// Links have no import or export in Tactplan: the export lists them for re-entry. Ids are left blank (Tactplan makes
// new ones); locations are known by their path of names.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { locationDurations } from './edit.ts';
import { locationsAt, pathOf, type LobLocation, type LobModel, type LobTask } from './model.ts';
import { TRADE_COLOURS } from './svg.ts';

export type DateFormat = 'dd/MM/yyyy' | 'MM/d/yyyy' | 'd/MM/yyyy' | 'yyyy/MM/dd';
const fmtDate = (iso: string, f: DateFormat) => { const [y, m, d] = iso.slice(0, 10).split('-'); const dd = String(Number(d)), mm = String(Number(m)); return f === 'dd/MM/yyyy' ? `${d}/${m}/${y}` : f === 'MM/d/yyyy' ? `${m}/${dd}/${y}` : f === 'd/MM/yyyy' ? `${dd}/${m}/${y}` : `${y}/${m}/${d}`; };

export function writeTactplan(m: LobModel, o: { decimal: 'dot' | 'comma'; date: string }): { name: string; text: string }[] {
  const sep = o.decimal === 'comma' ? ';' : ',', date = (['dd/MM/yyyy', 'MM/d/yyyy', 'd/MM/yyyy', 'yyyy/MM/dd'].includes(o.date) ? o.date : 'dd/MM/yyyy') as DateFormat;
  const num = (x: number) => { const s = String(Math.round(x * 1000) / 1000); return o.decimal === 'comma' ? s.replace('.', ',') : s; };
  const cell = (v: string) => (/["\n;,]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
  const line = (cells: string[]) => cells.map(cell).join(sep);
  const name = new Map(m.locations.map((l) => [l.code, l.name]));
  // Locations: the root "Project" (level 0), then the tree
  const locRows = [line(['Id', 'Name', 'Level', 'Location level']), line(['', 'Project', '0', 'Project'])];
  const walk = (parent: string | null) => { for (const l of m.locations.filter((x) => x.parent === parent)) { locRows.push(line(['', l.name, String(l.level), m.levels[l.level - 1] ?? `Level ${l.level}`])); walk(l.code); } };
  walk(null);
  // the location columns: every location a task runs at, in tree order
  const used = new Set(m.tasks.flatMap((t) => t.order));
  const cols = m.levels.flatMap((_, k) => locationsAt(m, k + 1)).filter((l) => used.has(l.code)).sort((a, b) => order(a) - order(b));
  function order(l: LobLocation) { return m.locations.findIndex((x) => x.code === l.code) + l.level * 1e-3; }
  const header = (fixed: string[]) => {
    const levelRows = [['Project (0)', 'Project'], ...m.levels.map((lv, k) => [`${lv} (${k + 1})`, ''])].map(([legend], r) => {
      const left = fixed.map((_, i) => (i === fixed.length - 1 ? legend : ''));
      return line([...left, ...cols.map((c) => (r === 0 ? 'Project' : (pathOf(m, c.code)[r - 1] ? name.get(pathOf(m, c.code)[r - 1])! : '')))]);
    });
    return [...levelRows, line([...fixed, ...cols.map(() => '')])];
  };
  const trades = [...new Set(m.tasks.map((t) => t.trade))];
  const grid = header(['Id', 'Name', 'Code', 'Start date', 'Finish date', 'Color', 'ASAP', 'Paced', 'Milestone', 'Location precision']);
  for (const t of m.tasks) {
    const d = locationDurations(m, t);
    t.segments.forEach((s, k) => {
      const mine = new Set(t.order.slice(t.order.indexOf(s.from), t.order.indexOf(s.to) + 1));
      const colour = `${TRADE_COLOURS[trades.indexOf(t.trade) % TRADE_COLOURS.length]}ff`;
      grid.push(line(['', t.name, t.code, s.start ? fmtDate(s.start, date) : '', '', colour, s.timing === 'paced' ? 'FALSE' : 'TRUE', s.timing === 'asap' ? 'FALSE' : 'TRUE', 'FALSE', String(t.precision), ...cols.map((c) => (mine.has(c.code) ? (d.has(c.code) ? num(d.get(c.code)!) : '0') : t.order.includes(c.code) ? '*' : ''))]));
      void k;
    });
  }
  const qty = header(['Id', 'Name', 'Consumption', 'Unit', 'Location precision']);
  for (const t of m.tasks) for (const it of t.items) qty.push(line(['', `${t.code} ${it.name}`, num(it.consumption), it.unit, String(t.precision), ...cols.map((c) => { const q = it.quantities.find((x) => x.location === c.code); return q ? num(q.quantity) : ''; })]));
  const links = m.links.map((l) => `${l.pred}${l.predLocation ? ` @ ${name.get(l.predLocation) ?? l.predLocation}` : ''} -> ${l.succ}${l.succLocation ? ` @ ${name.get(l.succLocation) ?? l.succLocation}` : ''}: ${l.type}${l.lagDays ? ` lag ${l.lagDays} d` : ''}${l.locationLag ? `, location delay ${l.locationLag}` : ''}${l.bufferDays ? `, buffer ${l.bufferDays} d` : ''}${l.project ? ` (project ${l.project})` : ''}`);
  return [
    { name: 'Locations.csv', text: locRows.join('\r\n') + '\r\n' },
    { name: 'Grid.csv', text: grid.join('\r\n') + '\r\n' },
    { name: 'Quantities.csv', text: qty.join('\r\n') + '\r\n' },
    { name: 'links-not-exported.txt', text: `Tactplan has no import for dependencies: enter these in Tactplan (Dependencies tab).\r\n${links.join('\r\n')}\r\n` },
  ];
}

// ── reading ──────────────────────────────────────────────────────────────────────────────────────────────────────
function parseTable(text: string): string[][] {
  const first = text.split(/\r?\n/)[0] ?? '';
  const sep = (first.match(/\t/g)?.length ?? 0) > 0 ? '\t' : (first.match(/;/g)?.length ?? 0) > (first.match(/,/g)?.length ?? 0) ? ';' : ',';
  const out: string[][] = [];
  let row: string[] = [], cur = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '"') { if (text[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += c; continue; }
    if (c === '"') q = true;
    else if (c === sep) { row.push(cur); cur = ''; }
    else if (c === '\n') { row.push(cur.replace(/\r$/, '')); out.push(row); row = []; cur = ''; }
    else cur += c;
  }
  if (cur || row.length) { row.push(cur.replace(/\r$/, '')); out.push(row); }
  return out.filter((r) => r.some((x) => x.trim() !== ''));
}
const numOf = (s: string) => { const t = s.trim().replace(/\s/g, ''); if (!t) return NaN; return Number(/,\d{1,3}$/.test(t) && !/\.\d/.test(t) ? t.replace(/\./g, '').replace(',', '.') : t.replace(/,(?=\d{3}\b)/g, '')); };
const isoOf = (s: string): string | null => {
  const t = s.trim(); if (!t) return null;
  let m = /^(\d{4})[/-](\d{1,2})[/-](\d{1,2})/.exec(t); if (m) return `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
  m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})/.exec(t);
  if (m) { const a = Number(m[1]), b = Number(m[2]); const [d, mo] = a > 12 ? [a, b] : b > 12 ? [b, a] : [a, b]; return `${m[3]}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`; }
  return null;
};
const truthy = (s: string) => /^(true|1|yes)$/i.test(s.trim());

/** A Tactplan export (a folder of its CSVs, or one Grid file) as an LOB model. Locations are coded by their path of
 *  names; durations come in as hours of a one-person crew (Tactplan's quantities are not linked to tasks in its export). */
export function readTactplan(path: string): { model: LobModel; start: string | null; notes: string[] } {
  const files = existsSync(path) && statSync(path).isDirectory() ? readdirSync(path).map((f) => join(path, f)) : [path];
  const find = (re: RegExp) => files.find((f) => re.test(f.replace(/^.*[\\/]/, '')));
  const gridFile = find(/grid/i) ?? find(/\.(csv|tsv|txt)$/i);
  if (!gridFile) throw new Error('No Tactplan Grid export (Grid.csv) found.');
  const notes: string[] = ['Tactplan exports no dependencies: add the links between trades with lob_edit add_link.'];
  const grid = parseTable(readFileSync(gridFile, 'utf8'));
  const hi = grid.findIndex((r) => r.some((c) => /^location precision$/i.test(c.trim())));
  if (hi < 0) throw new Error(`${gridFile}: no "Location precision" column; not a Tactplan Grid export.`);
  const head = grid[hi].map((c) => c.trim().toLowerCase());
  const col = (n: string) => head.findIndex((c) => c === n || c === n.replace(' date', ''));
  const precisionCol = head.indexOf('location precision');
  const levelRows = grid.slice(0, hi);
  // the level legend down the precision column: "Floor (2)"
  const levels: string[] = [];
  for (const r of levelRows) { const x = /^(.*)\s*\((\d+)\)\s*$/.exec(r[precisionCol] ?? ''); if (x && Number(x[2]) > 0) levels[Number(x[2]) - 1] = x[1].trim(); }
  // each location column: its path of names (the "Project" row left out)
  const locCols: { col: number; path: string[] }[] = [];
  for (let c = precisionCol + 1; c < grid[hi].length; c++) {
    const path: string[] = []; let last = '';
    for (const r of levelRows) { const v = (r[c] ?? '').trim(); if (v && v !== 'Project') last = v; if (v && v !== 'Project') path.push(v); }
    void last;
    if (path.length) locCols.push({ col: c, path });
  }
  // merged header cells repeat nothing: a blank means the same as the column to the left on that row
  for (let k = 1; k < locCols.length; k++) for (let lv = 0; lv < locCols[k].path.length - 1; lv++) if (!locCols[k].path[lv]) locCols[k].path[lv] = locCols[k - 1].path[lv];
  const codeOf = (path: string[]) => path.join('/');
  const locations: LobLocation[] = [];
  const seen = new Set<string>();
  for (const lc of locCols) lc.path.forEach((_, k) => { const code = codeOf(lc.path.slice(0, k + 1)); if (!seen.has(code)) { seen.add(code); locations.push({ code, name: lc.path[k], level: k + 1, parent: k ? codeOf(lc.path.slice(0, k)) : null }); } });
  // a Locations export, when there, adds the locations no task runs at
  const locFile = find(/location/i);
  if (locFile) {
    const L = parseTable(readFileSync(locFile, 'utf8'));
    const h = L[0].map((c) => c.trim().toLowerCase()), ni = h.indexOf('name'), li = h.indexOf('level'), lli = h.indexOf('location level');
    const stack: string[] = [];
    for (const r of L.slice(1)) {
      const lv = Number(r[li]); if (!(lv > 0)) continue;
      stack.length = lv - 1; stack.push(r[ni].trim());
      const code = codeOf(stack);
      if (lli >= 0 && r[lli]?.trim()) levels[lv - 1] = r[lli].trim();
      if (!seen.has(code)) { seen.add(code); locations.push({ code, name: r[ni].trim(), level: lv, parent: lv > 1 ? codeOf(stack.slice(0, -1)) : null }); }
    }
  }
  for (let k = 0; k < Math.max(...locations.map((l) => l.level), 1); k++) levels[k] ??= `Level ${k + 1}`;
  // tasks: rows with the same code (else name) are one task's subtasks
  const tasks = new Map<string, LobTask>();
  let start: string | null = null;
  const hpd = 8;
  for (const r of grid.slice(hi + 1)) {
    const nm = (r[col('name')] ?? '').trim(); if (!nm) continue;
    const code = ((r[col('code')] ?? '').trim() || nm).replace(/[^A-Za-z0-9-]+/g, '').slice(0, 20) || 'T';
    const precision = Number(r[precisionCol]) || 1;
    const asap = col('asap') >= 0 ? truthy(r[col('asap')] ?? '') : true, paced = col('paced') >= 0 ? truthy(r[col('paced')] ?? '') : false;
    const st = isoOf(r[col('start date')] ?? '');
    if (st && (!start || st < start)) start = st;
    const t = tasks.get(code) ?? tasks.set(code, { code, name: nm, trade: nm, precision, order: [], items: [{ name: nm, unit: 'h', consumption: 1, quantities: [] }], segments: [], hoursPerDay: hpd }).get(code)!;
    const mine: string[] = [];
    for (const lc of locCols) {
      const v = (r[lc.col] ?? '').trim(); if (!v || v === '*') continue;
      const days = numOf(v); if (!Number.isFinite(days)) continue;
      const loc = codeOf(lc.path.slice(0, precision));
      if (t.order.includes(loc)) continue;
      t.order.push(loc); mine.push(loc);
      t.items[0].quantities.push({ location: loc, quantity: days * hpd });
    }
    if (mine.length) t.segments.push({ from: mine[0], to: mine.at(-1)!, crews: 1, crewSize: 1, productivity: 1, driver: 'crew', timing: paced ? (asap ? 'asap_paced' : 'paced') : 'asap', ...(st ? { start: st } : {}) });
  }
  if (find(/quantit/i)) notes.push('Quantities.csv was read for nothing: Tactplan’s export does not say which task each quantity belongs to; the durations are kept as they are.');
  return { model: { version: 1, project: 'TACTPLAN', levels, locations, tasks: [...tasks.values()].filter((t) => t.segments.length), links: [] }, start, notes };
}
