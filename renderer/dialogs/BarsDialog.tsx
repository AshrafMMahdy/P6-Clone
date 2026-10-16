// View > Bars / Bar Chart Options: colours, thickness, labels and what the bar chart shows (saved with the layout).
import { useState } from 'react';
import { Dialog, Tabs } from '../components/Layout.tsx';
import { DEFAULT_BARS, type BarStyles } from '../components/Gantt.tsx';
import { closeDialog, getUi, setUi } from '../store.ts';

const COLORS: [keyof BarStyles, string][] = [
  ['actual', 'Actual Work'], ['remaining', 'Remaining Work'], ['critical', 'Critical Remaining Work'], ['milestone', 'Milestone'],
  ['baseline', 'Project Baseline'], ['summary', 'WBS Summary'], ['link', 'Relationship Line'], ['criticalLink', 'Critical Relationship Line'], ['dataDate', 'Data Date Line'],
];

export function BarsDialog(props: { tab?: string }) {
  const [tab, setTab] = useState(props.tab ?? 'bars');
  const [s, setS] = useState<BarStyles>({ ...DEFAULT_BARS, ...getUi().bars });
  const [rel, setRel] = useState(getUi().relLines);
  const set = <K extends keyof BarStyles>(k: K, v: BarStyles[K]) => setS({ ...s, [k]: v });
  const apply = () => setUi({ bars: s, relLines: rel });
  const check = (k: keyof BarStyles, label: string) => <label style={{ display: 'block', margin: '5px 0' }}><input type="checkbox" checked={s[k] as boolean} onChange={(e) => set(k, e.target.checked as never)} /> {label}</label>;
  return (
    <Dialog title="Bars" width={560} height={470} buttons={<>
      <button className="btn primary" onClick={() => { apply(); closeDialog(); }}>OK</button>
      <button className="btn" onClick={closeDialog}>Cancel</button>
      <button className="btn" onClick={apply}>Apply</button>
      <button className="btn" onClick={() => { setS({ ...DEFAULT_BARS }); setRel(true); }}>Default</button>
    </>}>
      <Tabs tabs={[['bars', 'Bars'], ['options', 'Bar Chart Options']]} value={tab} onChange={setTab} />
      {tab === 'bars' && <div style={{ padding: 8 }}>
        <table className="tbl"><thead><tr><th>Bar</th><th>Colour</th><th>Preview</th></tr></thead><tbody>
          {COLORS.map(([k, label]) => <tr key={k}>
            <td>{label}</td>
            <td><input type="color" value={s[k] as string} onChange={(e) => set(k, e.target.value as never)} /></td>
            <td><div style={{ width: 70, height: k === 'link' || k === 'criticalLink' || k === 'dataDate' ? 2 : s.height === 'thin' ? 4 : s.height === 'thick' ? 11 : 7, background: s[k] as string }} /></td>
          </tr>)}
        </tbody></table>
        <div style={{ marginTop: 10, display: 'flex', gap: 16, alignItems: 'center' }}>
          <label>Bar thickness <select value={s.height} onChange={(e) => set('height', e.target.value as BarStyles['height'])}><option value="thin">Thin</option><option value="normal">Normal</option><option value="thick">Thick</option></select></label>
          <label>Bar label <select value={s.label} onChange={(e) => set('label', e.target.value as BarStyles['label'])}><option value="none">None</option><option value="name">Activity Name</option><option value="id">Activity ID</option><option value="id-name">Activity ID - Name</option></select></label>
        </div>
      </div>}
      {tab === 'options' && <div style={{ padding: 8 }}>
        <label style={{ display: 'block', margin: '5px 0' }}><input type="checkbox" checked={rel} onChange={(e) => setRel(e.target.checked)} /> Show relationship lines</label>
        {check('showBaseline', 'Show project baseline bars')}
        {check('showSummary', 'Show WBS summary bars')}
        {check('showDataDate', 'Show data date line')}
        {check('shadeNonWork', 'Shade non-work days (when zoomed in)')}
        {check('gridLines', 'Show horizontal grid lines')}
        <p className="muted">Zoom with Ctrl + mouse wheel over the bar chart, Ctrl + plus / minus, or View &gt; Zoom.</p>
      </div>}
    </Dialog>
  );
}
