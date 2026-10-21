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
        const start = v.start ?? x.model.tasks.flatMap((t) => t.segments.map((g) => g.start ?? '')).filter(Boolean).sort()[0] ?? new Date().toISOString().slice(0, 10);
        const y = Number(start.slice(0, 4));
        return { name: v.name || basename(p), model: x.model, start, hoursPerDay: x.hoursPerDay, ...(x.calendar ? { calendarOp: vicoCalendarOp(x.calendar, `${(v.name || 'Vico').slice(0, 30)} (Vico)`, [y - 1, y + 5]) } : {}), notes: x.notes };
      }
      const t = readTactplan(dirname(p));
      return { name: basename(dirname(p)), model: t.model, start: t.start ?? new Date().toISOString().slice(0, 10), hoursPerDay: 8, notes: t.notes };
    } catch (e) { return { error: (e as Error).message }; }
  });
}
