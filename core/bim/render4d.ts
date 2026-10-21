// The 4D viewer as files: a page and, beside it, the model's display tiles in a folder of their own (model-<hash>/:
// manifest.json, tile-NNNNN.glb, elements.txt; core/bim/tiles.ts), fetched by the page relative to itself; or one
// self-contained page (embed) when the model is small enough to inline. The same page renders videos: in the user's
// browser or Electron (on their GPU), or in a headless Chromium. The layout and what the page fetches and signals are
// docs/4d-tiles-contract.md (the White Hat IQ platform serves it by that).
import { existsSync, mkdirSync, readFileSync, writeFileSync, copyFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { embedMaxBytes, inlineTiles, placeTiles, readManifest, type TilesManifest } from './tiles.ts';
import { GEOM_STRIDE, geomStore } from './element.ts';
import type { IfcIndex } from './parse.ts';

const here = () => { try { return typeof __dirname === 'string' ? __dirname : dirname(fileURLToPath(import.meta.url)); } catch { return null; } };

/** The viewer script: beside a bundle (viewer4d.js), or dist-viewer/ in the repository (scripts/build-viewer4d.mjs). */
export function viewerScriptPath(): string | null {
  const h = here();
  if (!h) return null;
  for (const p of [join(h, 'viewer4d.js'), join(h, '..', 'viewer4d.js'), join(h, '..', '..', 'dist-viewer', 'viewer4d.js')]) if (existsSync(p)) return p;
  return null;
}

export interface ViewerOptions { layout?: 'single' | 'side_by_side'; left?: string; right?: string; compare?: boolean; lateMeans?: 'start' | 'finish'; step?: number; growth?: string; overlays?: string[]; view?: string; interactive?: boolean; title?: string }

/** Where the page finds the model: the tile folder beside it, the tiles inline, or (asked for only) boxes. */
export type ModelSrc = { tiles: string } | { inline: { manifest: TilesManifest; tiles: string[]; guids?: string } } | { boxes: { manifest: TilesManifest; url?: string; inline?: string } };

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');
const STYLE = `html,body{margin:0;height:100%;font:12px Segoe UI,Tahoma,sans-serif;background:#eef1f5;color:#1f2a3a}#bar{display:flex;gap:8px;align-items:center;padding:6px 8px;background:#dfe5ee;border-bottom:1px solid #c4cfe0}#bar input[type=range]{flex:1}#stage{position:absolute;top:36px;left:0;right:0;bottom:0}#stage canvas{position:absolute;inset:0;width:100%;height:100%}#o4d{pointer-events:none}#counts4d{color:#4a5568;white-space:nowrap}button,select{font:inherit}`;

/** The page. script: the viewer script inline, or its file name beside the page. */
export function viewerHtml(o: { title: string; model: ModelSrc; timeline: unknown; options: ViewerOptions; script: { inline?: string; src?: string } }): string {
  const bar = o.options.interactive === false ? '' : `<div id="bar"><button id="p4d" title="Play">▶</button><input id="d4d" type="range" min="0" value="0"><select id="s4d" title="Dates to use"></select><button id="v4d-iso">Iso</button><button id="v4d-top">Top</button><button id="v4d-front">Front</button><button id="v4d-side">Side</button><span id="counts4d"></span></div>`;
  const cfg = JSON.stringify({ model: o.model, timeline: o.timeline, options: o.options }).replace(/</g, '\\u003c');
  const script = o.script.inline != null ? `<script>${o.script.inline.replace(/<\/script/gi, '<\\/script')}</script>` : `<script src="${esc(o.script.src ?? 'viewer4d.js')}"></script>`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="generator" content="WHIQ_4D viewer (P6 clone)"><title>${esc(o.title)}</title><style>${STYLE}${o.options.interactive === false ? '#stage{top:0}' : ''}</style></head><body>${bar}<div id="stage"><canvas id="c4d"></canvas><canvas id="o4d"></canvas></div><script>window.P6C4D=${cfg};</script>${script}</body></html>`;
}

/** The name of a model's tile folder beside a page. */
export const modelFolder = (hash: string) => `model-${hash.slice(0, 16)}`;

/** Each element's bounding box (metres; NaN without geometry), per ordinal, for the boxes a caller asked for. */
export function boxesOf(ix: IfcIndex): Float32Array {
  const out = new Float32Array(ix.elements.length * 6).fill(Number.NaN);
  const st = geomStore(ix);
  if (st?.rows) { const r = st.rows, [ox, oy, oz] = st.origin; for (let o = 0; o < ix.elements.length; o++) { const k = o * GEOM_STRIDE; if (Number.isNaN(r[k])) continue; out.set([r[k] + ox, r[k + 1] + oy, r[k + 2] + oz, r[k + 3] + ox, r[k + 4] + oy, r[k + 5] + oz], o * 6); } }
  else ix.elements.forEach((e, o) => { if (e.geom) out.set(e.geom.bbox, o * 6); });
  return out;
}

export interface WriteViewer {
  dir: string; title: string; timeline: unknown; options: ViewerOptions;
  /** the model: its tile folder (from the cache), content hash and index */
  model: { tiles: string; hash: string; index: IfcIndex };
  /** one self-contained file (the tiles inline): refused for a model past P6CLONE_EMBED_MAX_MB (64) */
  embed?: boolean;
  /** the viewer script inside the page, the tiles still beside it (a page served alone: the platform's client render) */
  inlineScript?: boolean;
  /** each element as its bounding box (only when the caller asked: never a silent stand-in) */
  boxes?: boolean;
  file?: string;
}

/** Write the viewer; answers every file written (the page first). */
export function writeViewer(o: WriteViewer): string[] {
  const script = viewerScriptPath();
  if (!script) throw new Error('The 4D viewer (viewer4d.js) is missing beside the program; build it with node scripts/build-viewer4d.mjs.');
  const manifest = readManifest(o.model.tiles);
  if (!manifest) throw new Error('The model has no display tiles.');
  mkdirSync(o.dir, { recursive: true });
  // a folder viewer is index.html (its script beside it); a page that stands alone takes the name asked for
  const page = join(o.dir, o.embed || o.inlineScript ? o.file ?? 'viewer.html' : 'index.html');
  if (o.embed) {
    let model: ModelSrc;
    if (o.boxes) model = { boxes: { manifest, inline: Buffer.from(boxesOf(o.model.index).buffer).toString('base64') } };
    else {
      if (manifest.bytes > embedMaxBytes()) throw new EmbedTooBig(manifest);
      const t = inlineTiles(o.model.tiles);
      model = { inline: { manifest: t.manifest, tiles: t.tiles, guids: readFileSync(join(o.model.tiles, 'elements.txt'), 'utf8') } };
    }
    writeFileSync(page, viewerHtml({ title: o.title, model, timeline: o.timeline, options: o.options, script: { inline: readFileSync(script, 'utf8') } }));
    return [page];
  }
  const folder = modelFolder(o.model.hash);
  const files = placeTiles(o.model.tiles, o.dir, folder);
  let model: ModelSrc = { tiles: `${folder}/manifest.json` };
  if (o.boxes) { const f = join(o.dir, folder, 'boxes.bin'); writeFileSync(f, boxesOf(o.model.index)); files.push(f); model = { boxes: { manifest, url: `${folder}/boxes.bin` } }; }
  const out = [page];
  if (o.inlineScript) writeFileSync(page, viewerHtml({ title: o.title, model, timeline: o.timeline, options: o.options, script: { inline: readFileSync(script, 'utf8') } }));
  else {
    writeFileSync(page, viewerHtml({ title: o.title, model, timeline: o.timeline, options: o.options, script: { src: 'viewer4d.js' } }));
    copyFileSync(script, join(o.dir, 'viewer4d.js'));
    out.push(join(o.dir, 'viewer4d.js'));
  }
  return [...out, ...files];
}

/** A self-contained page was asked for a model too big to inline. */
export class EmbedTooBig extends Error {
  constructor(m: TilesManifest) { super(`The model's display geometry is ${Math.round(m.bytes / 1048576)} MB in ${m.tiles.length} tiles, past the ${Math.round(embedMaxBytes() / 1048576)} MB a self-contained page carries (P6CLONE_EMBED_MAX_MB).`); }
}
