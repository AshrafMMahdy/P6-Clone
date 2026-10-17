// File > Page Setup, as in P6: paper and margins, what to print (columns, Gantt chart or both, split), which columns,
// relationship lines, legend, timescale, and header/footer bands with variables. Print Preview / Print / PDF from here.
import { useState } from 'react';
import { Dialog, Tabs } from '../components/Layout.tsx';
import { closeDialog, getDb, useStore } from '../store.ts';
import { PAPERS, VARIABLES, type Band, type PageSetup, type Paper } from '../print/layout.ts';
import { printableColumns } from '../print/schedule.ts';
import { pageSetup, printView, savePageSetup } from '../print.ts';

const mini = { minWidth: 0, padding: '0 6px', height: 18, lineHeight: '16px', fontSize: 11 };

export function PageSetupDialog() {
  const layoutCols = useStore((s) => s.ui.columns);
  const [ps, setPs] = useState<PageSetup>(pageSetup);
  const [tab, setTab] = useState('page');
  const set = (patch: Partial<PageSetup>) => setPs({ ...ps, ...patch });
  const all = printableColumns(getDb());
  const title = new Map(all.map((c) => [c.id, c.title]));
  const chosen = ps.columns.length ? ps.columns : layoutCols;
  const setCols = (ids: string[]) => set({ columns: ids });
  const move = (id: string, d: number) => { const a = [...chosen], i = a.indexOf(id), j = i + d; if (j < 0 || j >= a.length) return; [a[i], a[j]] = [a[j], a[i]]; setCols(a); };
  const apply = () => savePageSetup(ps);
  const go = async (mode: 'preview' | 'print' | 'pdf') => { apply(); closeDialog(); await printView(mode); };
  const band = (which: 'header' | 'footer') => {
    const b = ps[which];
    const setB = (patch: Partial<Band>) => set({ [which]: { ...b, ...patch } } as Partial<PageSetup>);
    return <>
      <label style={{ display: 'block', marginBottom: 8 }}><input type="checkbox" checked={b.show} onChange={(e) => setB({ show: e.target.checked })} /> Show {which}</label>
      <div className="form" style={{ gridTemplateColumns: 'auto 1fr' }}>
        {(['left', 'center', 'right'] as const).map((k) => [
          <label key={`${k}l`}>{k[0].toUpperCase() + k.slice(1)}</label>,
          <input key={k} disabled={!b.show} value={b[k]} onChange={(e) => setB({ [k]: e.target.value })} />,
        ])}
      </div>
      <p className="muted" style={{ marginTop: 8 }}>Variables: {VARIABLES.join('  ')}</p>
    </>;
  };
  return (
    <Dialog title="Page Setup" width={620} height={500} buttons={<>
      <button className="btn primary" onClick={() => { apply(); closeDialog(); }}>OK</button>
      <button className="btn" onClick={closeDialog}>Cancel</button>
      <button className="btn" onClick={() => void go('preview')}>Print Preview</button>
      <button className="btn" onClick={() => void go('print')}>Print...</button>
      <button className="btn" onClick={() => void go('pdf')}>Save as PDF...</button>
    </>}>
      <Tabs tabs={[['page', 'Page'], ['content', 'Content'], ['columns', 'Columns'], ['header', 'Header'], ['footer', 'Footer']]} value={tab} onChange={setTab} />
      <div style={{ border: '1px solid #a0a0a0', borderTop: 'none', padding: 10, minHeight: 330 }}>
        {tab === 'page' && <>
          <fieldset><legend>Paper</legend>
            <div className="form" style={{ gridTemplateColumns: 'auto 160px auto' }}>
              <label>Size</label>
              <select value={ps.paper} onChange={(e) => set({ paper: e.target.value as Paper })}>{Object.entries(PAPERS).map(([k, [w, h]]) => <option key={k} value={k}>{k} ({w} x {h} mm)</option>)}</select>
              <span />
            </div>
            <label style={{ marginRight: 16 }}><input type="radio" name="orient" checked={!ps.landscape} onChange={() => set({ landscape: false })} /> Portrait</label>
            <label><input type="radio" name="orient" checked={ps.landscape} onChange={() => set({ landscape: true })} /> Landscape</label>
          </fieldset>
          <fieldset><legend>Margins (mm)</legend>
            <div className="form" style={{ gridTemplateColumns: 'auto 70px auto 70px' }}>
              {(['top', 'bottom', 'left', 'right'] as const).map((k) => [
                <label key={`${k}l`}>{k[0].toUpperCase() + k.slice(1)}</label>,
                <input key={k} type="number" min={0} max={60} value={ps.margins[k]} onChange={(e) => { const v = Number(e.target.value); if (v >= 0 && v <= 60) set({ margins: { ...ps.margins, [k]: v } }); }} />,
              ])}
            </div>
          </fieldset>
          <fieldset><legend>Text</legend>
            <div className="form" style={{ gridTemplateColumns: 'auto 70px auto' }}>
              <label>Size</label><input type="number" min={5} max={14} step={0.5} value={ps.fontPt} onChange={(e) => { const v = Number(e.target.value); if (v >= 5 && v <= 14) set({ fontPt: v }); }} /><span>pt (smaller text fits more rows per page)</span>
            </div>
          </fieldset>
        </>}
        {tab === 'content' && <>
          <fieldset><legend>Print</legend>
            <label style={{ marginRight: 14 }}><input type="radio" name="content" checked={ps.content === 'both'} onChange={() => set({ content: 'both' })} /> Columns and Gantt chart</label>
            <label style={{ marginRight: 14 }}><input type="radio" name="content" checked={ps.content === 'table'} onChange={() => set({ content: 'table' })} /> Columns only</label>
            <label><input type="radio" name="content" checked={ps.content === 'gantt'} onChange={() => set({ content: 'gantt' })} /> Gantt chart only</label>
            <div className="form" style={{ gridTemplateColumns: 'auto 200px auto', marginTop: 8 }}>
              <label>Columns take</label>
              <input type="range" min={10} max={90} value={ps.tableShare} disabled={ps.content !== 'both'} onChange={(e) => set({ tableShare: Number(e.target.value) })} />
              <span>{ps.tableShare}% of the width</span>
            </div>
          </fieldset>
          <fieldset><legend>Gantt chart</legend>
            <label style={{ display: 'block' }}><input type="checkbox" checked={ps.showLinks} onChange={(e) => set({ showLinks: e.target.checked })} /> Relationship lines</label>
            <label style={{ display: 'block' }}><input type="checkbox" checked={ps.showBaseline} onChange={(e) => set({ showBaseline: e.target.checked })} /> Baseline bars</label>
            <label style={{ display: 'block' }}><input type="checkbox" checked={ps.showLegend} onChange={(e) => set({ showLegend: e.target.checked })} /> Legend</label>
            <label style={{ display: 'block' }}><input type="checkbox" checked={ps.showGrid} onChange={(e) => set({ showGrid: e.target.checked })} /> Grid lines</label>
          </fieldset>
          <fieldset><legend>Timescale</legend>
            <label style={{ marginRight: 14 }}><input type="radio" name="range" checked={ps.range === 'project'} onChange={() => set({ range: 'project' })} /> Whole project</label>
            <label><input type="radio" name="range" checked={ps.range === 'custom'} onChange={() => set({ range: 'custom' })} /> From</label>{' '}
            <input type="date" disabled={ps.range !== 'custom'} value={ps.from.slice(0, 10)} onChange={(e) => set({ from: e.target.value })} /> to{' '}
            <input type="date" disabled={ps.range !== 'custom'} value={ps.to.slice(0, 10)} onChange={(e) => set({ to: e.target.value })} />
          </fieldset>
        </>}
        {tab === 'columns' && <>
          <label style={{ display: 'block', marginBottom: 6 }}><input type="checkbox" checked={!ps.columns.length} onChange={(e) => setCols(e.target.checked ? [] : [...layoutCols])} /> Same columns as the layout (View &gt; Columns)</label>
          <div style={{ display: 'flex', gap: 10, opacity: ps.columns.length ? 1 : 0.6 }}>
            <div style={{ flex: 1 }}><b>Printed</b>
              <div className="listbox" style={{ height: 250, overflow: 'auto', border: '1px solid #a0a0a0' }}>
                {chosen.map((id) => <div key={id} style={{ display: 'flex', alignItems: 'center', gap: 4, padding: '1px 4px' }}>
                  <span style={{ flex: 1, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{title.get(id) ?? id}</span>
                  <button className="btn" style={mini} disabled={!ps.columns.length} onClick={() => move(id, -1)}>▲</button>
                  <button className="btn" style={mini} disabled={!ps.columns.length} onClick={() => move(id, 1)}>▼</button>
                  <button className="btn" style={mini} disabled={!ps.columns.length || chosen.length < 2} onClick={() => setCols(chosen.filter((x) => x !== id))}>Hide</button>
                </div>)}
              </div>
            </div>
            <div style={{ flex: 1 }}><b>Available</b>
              <div className="listbox" style={{ height: 250, overflow: 'auto', border: '1px solid #a0a0a0' }}>
                {all.filter((c) => !chosen.includes(c.id)).map((c) => <div key={c.id} style={{ display: 'flex', alignItems: 'center', padding: '1px 4px' }}>
                  <span style={{ flex: 1, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{c.title}</span>
                  <button className="btn" style={mini} disabled={!ps.columns.length} onClick={() => setCols([...chosen, c.id])}>Show</button>
                </div>)}
              </div>
            </div>
          </div>
        </>}
        {tab === 'header' && band('header')}
        {tab === 'footer' && band('footer')}
      </div>
    </Dialog>
  );
}
