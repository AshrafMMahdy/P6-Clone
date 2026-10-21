// The 4D viewer as files: index.html + viewer4d.js + model.glb + timeline.json in a folder (a separate model file, not
// base64 in the page), or one self-contained HTML (embed) for sharing and for the platform's client render. The same
// page renders videos: in the user's browser or Electron (on their GPU), or in a headless Chromium when one is given.
import { existsSync, mkdirSync, readFileSync, writeFileSync, copyFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = () => { try { return typeof __dirname === 'string' ? __dirname : dirname(fileURLToPath(import.meta.url)); } catch { return process.cwd(); } };

/** The viewer script: beside a bundle (viewer4d.js), or dist-viewer/ in the repository (scripts/build-viewer4d.mjs). */
export function viewerScriptPath(): string | null {
  const h = here();
  for (const p of [join(h, 'viewer4d.js'), join(h, '..', 'viewer4d.js'), join(h, '..', '..', 'dist-viewer', 'viewer4d.js'), join(process.cwd(), 'dist-viewer', 'viewer4d.js')]) if (existsSync(p)) return p;
  return null;
}

export interface ViewerOptions { layout?: 'single' | 'side_by_side'; left?: string; right?: string; compare?: boolean; lateMeans?: 'start' | 'finish'; step?: number; growth?: string; overlays?: string[]; view?: string; interactive?: boolean; title?: string }

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');
const STYLE = `html,body{margin:0;height:100%;font:12px Segoe UI,Tahoma,sans-serif;background:#eef1f5;color:#1f2a3a}#bar{display:flex;gap:8px;align-items:center;padding:6px 8px;background:#dfe5ee;border-bottom:1px solid #c4cfe0}#bar input[type=range]{flex:1}#stage{position:absolute;top:36px;left:0;right:0;bottom:0}#stage canvas{position:absolute;inset:0;width:100%;height:100%}#o4d{pointer-events:none}#counts4d{color:#4a5568;white-space:nowrap}button,select{font:inherit}`;

/** The page. model: "model.glb" (a file beside it) or base64; script: the viewer script inline, or its file name. */
export function viewerHtml(o: { title: string; model: string; timeline: unknown; options: ViewerOptions; script: { inline?: string; src?: string } }): string {
  const bar = o.options.interactive === false ? '' : `<div id="bar"><button id="p4d" title="Play">▶</button><input id="d4d" type="range" min="0" value="0"><select id="s4d" title="Dates to use"></select><button id="v4d-iso">Iso</button><button id="v4d-top">Top</button><button id="v4d-front">Front</button><button id="v4d-side">Side</button><span id="counts4d"></span></div>`;
  const cfg = JSON.stringify({ model: o.model, timeline: o.timeline, options: o.options }).replace(/</g, '\\u003c');
  const script = o.script.inline != null ? `<script>${o.script.inline.replace(/<\/script/gi, '<\\/script')}</script>` : `<script src="${esc(o.script.src ?? 'viewer4d.js')}"></script>`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="generator" content="WHIQ_4D viewer (P6 clone)"><title>${esc(o.title)}</title><style>${STYLE}${o.options.interactive === false ? '#stage{top:0}' : ''}</style></head><body>${bar}<div id="stage"><canvas id="c4d"></canvas><canvas id="o4d"></canvas></div><script>window.P6C4D=${cfg};</script>${script}</body></html>`;
}

/** Write the viewer: a folder (index.html, viewer4d.js, model.glb, timeline.json) or one file with embed. */
export function writeViewer(o: { dir: string; glb: string; timeline: unknown; options: ViewerOptions; title: string; embed?: boolean; file?: string }): string[] {
  const script = viewerScriptPath();
  if (!script) throw new Error('The 4D viewer (viewer4d.js) is missing beside the program; build it with node scripts/build-viewer4d.mjs.');
  mkdirSync(o.dir, { recursive: true });
  if (o.embed) {
    const p = join(o.dir, o.file ?? 'viewer.html');
    writeFileSync(p, viewerHtml({ title: o.title, model: readFileSync(o.glb).toString('base64'), timeline: o.timeline, options: o.options, script: { inline: readFileSync(script, 'utf8') } }));
    return [p];
  }
  const out = [join(o.dir, 'index.html'), join(o.dir, 'viewer4d.js'), join(o.dir, 'model.glb'), join(o.dir, 'timeline.json')];
  writeFileSync(out[0], viewerHtml({ title: o.title, model: 'model.glb', timeline: o.timeline, options: o.options, script: { src: 'viewer4d.js' } }));
  copyFileSync(script, out[1]);
  copyFileSync(o.glb, out[2]);
  writeFileSync(out[3], JSON.stringify(o.timeline));
  return out;
}
