// File > Export to Excel, as P6's spreadsheet export: the subject areas to write and, per subject area, its columns
// (P6's Modify Template: activity, resource and assignment codes and UDFs included; the columns P6 requires are always
// written and cannot be removed). Templates are saved by name on this computer and reused.
import { useMemo, useState } from 'react';
import { Dialog, Tabs } from '../components/Layout.tsx';
import { closeDialog, getDb, getUi } from '../store.ts';
import { SHEETS, SHEET_TITLES, templateColumns, type ExportTemplate, type SheetName } from '../../core/excel/p6sheets.ts';
import { excelTemplates, exportExcel, saveExcelTemplates } from '../excel.ts';

const mini = { minWidth: 0, padding: '0 6px', height: 20, fontSize: 11 };

export function ExcelExportDialog() {
  const ui = getUi();
  const [saved, setSaved] = useState(excelTemplates);
  const [name, setName] = useState('');
  const [tpl, setTpl] = useState<ExportTemplate>({});
  const { columns, available } = useMemo(() => templateColumns(getDb(), ui.openProjects, tpl, ui.prefs.hoursPerDay, !!ui.prefs.calendarDays), [tpl, ui.openProjects, ui.prefs.hoursPerDay, ui.prefs.calendarDays]);
  const [tab, setTab] = useState<SheetName>('TASK');
  const [pickAvail, setPickAvail] = useState<string[]>([]);
  const [pickSel, setPickSel] = useState<string[]>([]);
  const on = (s: SheetName) => !!columns[s];
  const sheetsOn = SHEETS.filter(on);
  const chosen = (columns[tab] ?? []).map((c) => c.field);
  const setCols = (fields: string[]) => setTpl({ ...tpl, columns: { ...tpl.columns, [tab]: fields } });
  const toggleSheet = (s: SheetName) => { const next = on(s) ? sheetsOn.filter((x) => x !== s) : SHEETS.filter((x) => x === s || on(x)); setTpl({ ...tpl, sheets: next }); };
  const required = new Set(available[tab].filter((c) => c.required).map((c) => c.field));
  const move = (d: number) => {
    const a = [...chosen];
    const idx = pickSel.map((f) => a.indexOf(f)).filter((i) => i >= 0).sort((x, y) => d * (y - x));
    for (const i of idx) { const j = i + d; if (j < 0 || j >= a.length || pickSel.includes(a[j])) continue; [a[i], a[j]] = [a[j], a[i]]; }
    setCols(a);
  };
  const label = (c: { title: string; calc?: boolean; required?: boolean; field: string }) => `${c.calc ? '(*)' : ''}${c.title}${c.required ? ' (required)' : ''}  [${c.field}]`;
  const load = (n: string) => { setName(n); setTpl(saved[n] ?? {}); };
  const save = () => { if (!name.trim()) return; const all = { ...saved, [name.trim()]: tpl }; saveExcelTemplates(all); setSaved(all); };
  const remove = () => { const all = { ...saved }; delete all[name]; saveExcelTemplates(all); setSaved(all); setName(''); };
  const list = (items: { field: string; title: string; calc?: boolean; required?: boolean }[], sel: string[], setSel: (v: string[]) => void) => (
    <select multiple size={16} style={{ width: '100%' }} value={sel} onChange={(e) => setSel([...e.target.selectedOptions].map((o) => o.value))}>
      {items.map((c) => <option key={c.field} value={c.field}>{label(c)}</option>)}
    </select>
  );
  return (
    <Dialog title="Export to Excel" width={760} height={560} buttons={<>
      <button className="btn primary" disabled={!sheetsOn.length} onClick={() => { closeDialog(); void exportExcel(tpl); }}>Export...</button>
      <button className="btn" onClick={closeDialog}>Cancel</button>
    </>}>
      <div className="form" style={{ gridTemplateColumns: 'auto 200px auto auto auto', marginBottom: 8 }}>
        <label>Template</label>
        <input list="xl-templates" value={name} onChange={(e) => (saved[e.target.value] ? load(e.target.value) : setName(e.target.value))} placeholder="(unsaved)" />
        <datalist id="xl-templates">{Object.keys(saved).map((n) => <option key={n} value={n} />)}</datalist>
        <button className="btn" style={mini} disabled={!name.trim()} onClick={save}>Save</button>
        <button className="btn" style={mini} disabled={!saved[name]} onClick={remove}>Delete</button>
      </div>
      <fieldset><legend>Subject areas</legend>
        {SHEETS.map((s) => <label key={s} style={{ marginRight: 14 }}><input type="checkbox" checked={on(s)} onChange={() => toggleSheet(s)} /> {SHEET_TITLES[s]}</label>)}
      </fieldset>
      <Tabs tabs={SHEETS.filter(on).map((s) => [s, SHEET_TITLES[s]] as [string, string])} value={tab} onChange={(t) => { setTab(t as SheetName); setPickAvail([]); setPickSel([]); }} />
      {on(tab) && <div style={{ display: 'grid', gridTemplateColumns: '1fr auto 1fr auto', gap: 6, border: '1px solid #a0a0a0', borderTop: 'none', padding: 8 }}>
        <div><div className="muted">Available columns</div>{list(available[tab].filter((c) => !chosen.includes(c.field)), pickAvail, setPickAvail)}</div>
        <div style={{ display: 'flex', flexDirection: 'column', justifyContent: 'center', gap: 4 }}>
          <button className="btn" style={mini} onClick={() => { setCols([...chosen, ...pickAvail]); setPickAvail([]); }}>&gt;</button>
          <button className="btn" style={mini} onClick={() => { setCols(chosen.filter((f) => !pickSel.includes(f) || required.has(f))); setPickSel([]); }}>&lt;</button>
          <button className="btn" style={mini} onClick={() => setCols(available[tab].map((c) => c.field))}>All</button>
        </div>
        <div><div className="muted">Columns written</div>{list(columns[tab] ?? [], pickSel, setPickSel)}</div>
        <div style={{ display: 'flex', flexDirection: 'column', justifyContent: 'center', gap: 4 }}>
          <button className="btn" style={mini} onClick={() => move(-1)}>Up</button>
          <button className="btn" style={mini} onClick={() => move(1)}>Down</button>
        </div>
      </div>}
      <p className="muted" style={{ marginTop: 6 }}>(*) marks a calculated column: written for reference, never imported. Required columns cannot be removed. Edit the workbook in Excel and bring it back with File &gt; Import from Excel.</p>
    </Dialog>
  );
}
