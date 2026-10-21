// Vico Schedule Planner .dpp reader against the user's own sample (read in place, never copied into the repo); the
// expected values are what Schedule Planner v6.8 shows for that file. Skipped when the sample is not on this machine.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { readVicoDpp } from '../core/lob/vico.ts';

const SAMPLE = process.env.P6CLONE_VICO_SAMPLE || 'D:\\Backup\\Documents\\ConREM\\2. Semester 3 & 4 Berlin\\1. Semester 3\\Case Studies 2\\Term Project 2 Vico\\1. Outputs\\2. After Optimization\\0. Case Studies II -- Vico Term Project II -- After Optimization 16 January 2024.dpp';
const skip = existsSync(SAMPLE) ? false : 'Vico sample .dpp not present on this machine';
const load = () => readVicoDpp(readFileSync(SAMPLE));

// code, name, start, end, crew, crew size, Gantt duration (days)
const TASKS: [string, string, string, string, string, number, number][] = [
  ['PW', 'Plaster Works', '2025-07-10', '2026-04-29', 'Plastering Crew', 14, 314],
  ['WP', 'Water Proofing', '2025-07-25', '2026-06-03', 'Waterproofing Crew', 8, 336.3],
  ['PAW', 'Painting Works', '2025-12-22', '2026-08-27', 'Painting Crew', 14, 272.1],
  ['FAW', 'Façade Works (Plaster and Paint)', '2026-07-27', '2026-10-06', 'Facade Crew', 4, 51],
  ['DWI', 'Doors and Windows Installation', '2025-10-31', '2026-07-20', 'Doors Crew', 4, 272],
  ['CTW', 'Ceramic Tile Works', '2025-10-09', '2026-07-07', 'Ceramic Crew', 14, 275],
  ['PFF', 'Plumbing (Water Supply First Fix)', '2025-05-12', '2026-03-13', 'MEP Crew', 16, 333.8],
  ['CS', 'Concrete Skeleton', '2025-04-14', '2026-02-13', 'Concrete Crew', 25, 324],
  ['HSSF', 'Heating System Second Fix', '2026-04-28', '2026-09-30', 'MEP Crew', 4, 154],
  ['EW', 'Electrical Wiring', '2025-09-25', '2026-06-12', 'MEP Crew', 6, 267],
  ['EISF', 'Electrical Items (Second Fix)', '2026-02-25', '2026-09-08', 'MEP Crew', 3, 217],
  ['DFF', 'Plumbing (Drainage Supply First Fix)', '2025-06-13', '2026-04-08', 'MEP Crew', 4, 317],
  ['PSF', 'Plumbing Second Fix', '2026-03-30', '2026-09-17', 'MEP Crew', 6, 178],
  ['ELE', 'Elevators', '2025-11-25', '2026-08-10', 'MEP Crew', 2, 274.6],
];
// task code -> total quantity, unit, consumption (h/unit)
const QTY: Record<string, [number, string, number]> = {
  CS: [7050, 'M3', 9.191], PFF: [11200, 'M', 3.814], DFF: [6160, 'M', 1.647], PW: [71000, 'M2', 0.495], WP: [26018, 'M2', 0.827],
  EW: [11200, 'M', 1.144], CTW: [6850, 'M2', 4.496], DWI: [966, 'NO', 9.01], ELE: [16, 'NO', 274.587], PAW: [71000, 'M2', 0.429],
  EISF: [1812, 'NO', 2.874], PSF: [204, 'NO', 41.882], HSSF: [140, 'NO', 35.2], FAW: [1170, 'M2', 1.395],
};
const near = (a: number, b: number, tol: number, what: string) => assert.ok(Math.abs(a - b) <= tol, `${what}: ${a} vs ${b}`);

test('vico: not a .dpp file throws a clear error', () => {
  assert.throws(() => readVicoDpp(new TextEncoder().encode('ERMHDR\t19.12\tProject')), /Not a Vico \.dpp file/);
  assert.throws(() => readVicoDpp(new Uint8Array(0)), /Not a Vico \.dpp file/);
  const fake = new Uint8Array(64); fake.set([0x44, 0x53, 0x53, 0x1a]); fake.set(new TextEncoder().encode('GraphisoftControl Project'), 8);
  assert.throws(() => readVicoDpp(fake), /zlib/);
});

test('vico: project header and location breakdown (2 parts x 9 floors)', { skip }, () => {
  const p = load();
  assert.equal(p.name, 'Case Studies II -- Vico Term Project II');
  assert.equal(p.start, '2025-01-31');
  assert.equal(p.end, '2027-01-01');
  assert.equal(p.info?.["Company's name"], 'Metropolia and HTW Berlin');
  assert.equal(p.info?.["Creator's name"], 'Group');
  assert.deepEqual(p.levels.slice(1), ['Parts', 'Floors']);
  const parts = p.locations.filter((l) => l.level === 1);
  assert.deepEqual(parts.map((l) => l.name), ['1', '2']);
  for (const part of parts) {
    const floors = p.locations.filter((l) => l.parent === part.code);
    assert.deepEqual(floors.map((f) => f.name), ['1', '2', '3', '4', '5', '6', '7', '8', '9']);
    assert.ok(floors.every((f) => f.level === 2));
  }
  assert.equal(p.locations.length, 1 + 2 + 18);
  assert.equal(new Set(p.locations.map((l) => l.code)).size, p.locations.length, 'location codes are unique');
});

test('vico: the 14 tasks with dates, crews and durations', { skip }, () => {
  const p = load();
  assert.deepEqual(p.tasks.map((t) => t.code), TASKS.map((t) => t[0]));
  for (const [code, name, start, end, crew, size, days] of TASKS) {
    const t = p.tasks.find((x) => x.code === code)!;
    assert.equal(t.name.toLowerCase(), name.toLowerCase(), code);
    assert.equal(t.start, start, `${code} start`);
    assert.equal(t.end, end, `${code} end`);
    assert.deepEqual(t.crew, { name: crew, size }, `${code} crew`);
    near(t.durationDays!, days, 0.051, `${code} duration`); // Gantt shows one decimal
    assert.deepEqual(t.locations, ['1', '2'], `${code} runs part by part`);
  }
});

test('vico: quantities, units and consumption; man-hours and BoQ cost match the project report', { skip }, () => {
  const p = load();
  let manHours = 0, cost = 0;
  for (const t of p.tasks) {
    assert.equal(t.items.length, 1, t.code);
    const it = t.items[0];
    const total = it.quantities.reduce((s, q) => s + q.quantity, 0);
    const [qty, unit, cons] = QTY[t.code];
    near(total, qty, 1e-6, `${t.code} quantity`);
    assert.equal(it.unit, unit, `${t.code} unit`);
    near(it.consumption, cons, 0.0005, `${t.code} consumption`);
    assert.equal(it.quantities.length, 18, `${t.code}: a quantity on every floor`);
    assert.ok(it.quantities.every((q) => /^[12]\/[1-9]$/.test(q.location)), `${t.code} quantity locations are floors`);
    manHours += total * it.consumption;
    cost += total * (it.unitPrice ?? 0);
  }
  near(manHours, 281857.4, 0.05, 'man-hours');
  near(cost, 11061220, 0.01, 'BoQ cost');
  const cs = p.tasks.find((t) => t.code === 'CS')!.items[0];
  near(cs.quantities.reduce((s, q) => s + q.quantity, 0) * cs.unitPrice!, 528750, 0.01, 'Concrete skeleton target cost');
});

test('vico: calendar and what is not decoded', { skip }, () => {
  const p = load();
  const cal = (p.calendars as { week: { day: string; start: string; hours: number }[]; holidays: { name: string; rule: string; month: number; day: number; weekday?: number }[] }[])[0];
  assert.deepEqual(cal.week.map((d) => d.hours), [8, 8, 8, 8, 8, 0, 0]);
  assert.equal(cal.week[0].start, '07:00');
  assert.equal(cal.holidays.length, 13);
  const memorial = cal.holidays.find((h) => h.name === 'Memorial Day')!;
  assert.deepEqual([memorial.rule, memorial.month, memorial.day, memorial.weekday], ['weekdayOnOrAfter', 5, 25, 0]);
  assert.deepEqual(p.links, []);
  assert.ok(p.notes.some((n) => /dependency/.test(n)), 'the missing logic is stated in notes');
});

test('L-6: a .dpp whose body unpacks past the cap is refused before it is held in memory', async () => {
  const { deflateSync } = await import('node:zlib');
  const head = Buffer.concat([Buffer.from([0x44, 0x53, 0x53, 0x1a, 0, 0, 0, 0]), Buffer.from('GraphisoftControl Project\x1a\x00', 'latin1'), Buffer.alloc(4)]);
  const bomb = new Uint8Array(Buffer.concat([head, deflateSync(Buffer.alloc(8 * 1048576))]));
  assert.throws(() => readVicoDpp(bomb, { maxBytes: 1048576 }), /unpacks past 1 MB/);
});
