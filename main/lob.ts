// LOB in the desktop app's main process: plans from other tools are read here (a Vico .dpp needs zlib, a Tactplan
// export is a folder of files); the renderer turns the model into a project.
import { BrowserWindow, dialog, ipcMain } from 'electron';
import { readFileSync } from 'node:fs';
import { basename, dirname } from 'node:path';
import { readVicoDpp } from '../core/lob/vico.ts';
import { lobFromVico, vicoCalendarOp } from '../core/lob/fromVico.ts';
import { readTactplan } from '../core/lob/tactplan.ts';
import type { LobModel } from '../core/lob/model.ts';

export interface LobImport { name: string; model: LobModel; start: string; hoursPerDay: number; calendarOp?: Record<string, unknown>; notes: string[] }

export function registerLob(getWin: () => BrowserWindow | null): void {
  ipcMain.handle('lob:import', async (): Promise<LobImport | { error: string } | null> => {
    const r = await dialog.showOpenDialog(getWin()!, { title: 'Import an LOB plan (Vico .dpp, or a Tactplan Grid.csv)', filters: [{ name: 'Vico or Tactplan', extensions: ['dpp', 'csv', 'txt', 'tsv'] }], properties: ['openFile'] });
    if (r.canceled || !r.filePaths[0]) return null;
    const p = r.filePaths[0];
    try {
      if (/\.dpp$/i.test(p)) {
        const v = readVicoDpp(new Uint8Array(readFileSync(p)));
        const x = lobFromVico(v, '');
        // the start the plan gives, else its first segment's, else today: each said in the import's notes (item 26, desktop C34)
        const first = x.model.tasks.flatMap((t) => t.segments.map((g) => g.start ?? '')).filter(Boolean).sort()[0];
        const start = v.start ?? first ?? new Date().toISOString().slice(0, 10);
        const said = v.start ? [] : [first ? `The plan has no start date of its own: it starts at its first segment's start, ${start}.` : `The plan has no start date and no dated segment: it starts today, ${start}.`];
        const y = Number(start.slice(0, 4));
        // AGREED LIMIT (owner, 2026-11-28): the year before the start to 5 years after — the years a Vico calendar's holidays are written for, said in the notes — why: item 26 rule 4, "Defaults - agreed" — arbitrary by agreement (a plan running later has no holidays after them).
        const years: [number, number] = [y - 1, y + 5];
        if (x.calendar) said.push(`The Vico calendar's holidays are written for ${years[0]} to ${years[1]}: a plan running past ${years[1]} has no holidays after it.`);
        return { name: v.name || basename(p), model: x.model, start, hoursPerDay: x.hoursPerDay, ...(x.calendar ? { calendarOp: vicoCalendarOp(x.calendar, `${(v.name || 'Vico').slice(0, 30)} (Vico)`, years) } : {}), notes: [...x.notes, ...said] };
      }
      const t = readTactplan(dirname(p));
      // a Tactplan grid gives no hours a day (8, P6's default) and may give no start (today): both said in the import's notes (item 26, desktop C34, C35)
      const start = t.start ?? new Date().toISOString().slice(0, 10);
      return { name: basename(dirname(p)), model: t.model, start, hoursPerDay: 8, notes: [...t.notes, 'A Tactplan grid gives no hours a day: 8 hours a day are used (P6\'s default).', ...(t.start ? [] : [`The grid has no start date: the plan starts today, ${start}.`])] };
    } catch (e) { return { error: (e as Error).message }; }
  });
}
