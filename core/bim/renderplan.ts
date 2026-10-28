// What a 4D image/video render will take and the quality it is drawn at: pure arithmetic, so the decision (and what
// the user is told about it) can be checked without a browser. render_4d (mcp/fourd.ts) plans with it, and plans again
// when the graphics card could not finish and the processor draws instead.

export const RENDER_SOFTWARE_TRIANGLES_PER_S = 2.1e6, RENDER_GPU_TRIANGLES_PER_S = 400e6;
/** Past this many minutes for the full model, quality auto renders a draft (P6CLONE_RENDER_DRAFT_MINUTES overrides it;
 *  quality: "standard" or "high" overrides it per call). owner decision 2026-10-27: 5 minutes (it was 10). */
export const AUTO_DRAFT_MINUTES = 5;
export const draftLimitMinutes = () => Number(process.env.P6CLONE_RENDER_DRAFT_MINUTES) || AUTO_DRAFT_MINUTES;

/** Minutes a render takes, from the triangles drawn per frame and the frames, plus loading the tiles (measured on a
 *  509 MB federation, 320 million triangles, 24 frames at 1280x720: 60 min with the processor drawing, about 2 million
 *  triangles a second; 34 s on this machine's graphics card, about 400 million, the tiles at about 200 MB/s). */
export function renderMinutes(kind: 'gpu' | 'software', triangles: number, frames: number, tileBytes: number, pixels = 1280 * 720): number {
  const perFrame = kind === 'gpu' ? 0.15 + triangles / RENDER_GPU_TRIANGLES_PER_S : 0.5 * (pixels / (1280 * 720)) + triangles / RENDER_SOFTWARE_TRIANGLES_PER_S;
  return (frames * perFrame + tileBytes / (200 * 1048576)) / 60;
}

export type Quality = 'draft' | 'standard' | 'high';
const SIZE: Record<Quality, [number, number]> = { draft: [854, 480], standard: [1280, 720], high: [1920, 1080] };

export interface PlanInput {
  /** Who draws: 'gpu' (this server's graphics card, or the user's own: the client render), 'software' (this server's processor) */
  kind: 'gpu' | 'software';
  /** the server has no Chromium: the page goes to the client, which draws it on the user's graphics card */
  client?: boolean;
  /** the name of this server's graphics card, when it draws */
  gpuName?: string;
  /** the graphics card could not finish and the processor draws instead: why, and what was first estimated (minutes) */
  fellBack?: { reason: string; firstMinutes: number };
  asked: 'auto' | Quality;
  /** boxes: true asked for (each element drawn as its bounding box) */
  boxes?: boolean;
  triangles: number; tileBytes: number; elements: number; frames: number;
  /** side_by_side draws the model twice a frame */
  sides?: 1 | 2;
  /** custom size (width/height asked for) */
  width?: number; height?: number;
  limitMinutes?: number;
}
export interface Plan {
  quality: Quality; boxes: boolean; width: number; height: number;
  /** what this render is expected to take, in the quality chosen */
  minutes: number;
  /** the full model (not boxes) at standard, or high when asked, size */
  fullMinutes: number; draftMinutes: number;
  where: string; note?: string;
}

const about = (min: number) => (min < 1 ? 'under a minute' : `about ${Math.round(min)} minute${Math.round(min) === 1 ? '' : 's'}`);
export const aboutMinutes = about;

export function planRender(i: PlanInput): Plan {
  const limit = i.limitMinutes ?? draftLimitMinutes(), s = i.sides ?? 1;
  const size = (q: Quality): [number, number] => [Math.min(3840, i.width || SIZE[q][0]), Math.min(2160, i.height || SIZE[q][1])];
  // the estimate of drawing in quality q, the model's own triangles or as boxes (12 triangles each, nothing to load)
  const minutes = (q: Quality, boxed: boolean) => { const [w, h] = size(q); return renderMinutes(i.kind, (boxed ? i.elements * 12 : i.triangles) * s, i.frames, boxed ? 0 : i.tileBytes, w * h); };
  const fullQ: Quality = i.asked === 'high' ? 'high' : 'standard';
  const fullMinutes = minutes(fullQ, false), draftMinutes = minutes('draft', true);
  const quality: Quality = i.asked !== 'auto' ? i.asked : i.boxes === true || fullMinutes <= limit ? 'standard' : 'draft';
  const boxes = i.boxes === true || quality === 'draft'; // a stand-in when asked for, or for a draft
  const [width, height] = size(quality);
  const mins = minutes(quality, boxes);
  const where = i.fellBack ? 'drawn by the processor (the graphics card could not finish the render)'
    : i.client ? 'on the user’s own graphics card (the client render: this server draws nothing, so this is an estimate for a typical graphics card)'
    : i.kind === 'gpu' ? `on this server's graphics card (${i.gpuName ?? 'found by the browser'})`
    : 'drawn by the processor (this server has no graphics card the browser can use)';
  const limitText = `${Number(limit.toPrecision(2))} minutes`;
  let note = quality === 'draft'
    ? `${i.asked === 'auto' ? `Draft quality was chosen because the full model would take ${about(fullMinutes)} to render ${where} (quality auto draws a draft past ${limitText}; owner decision 2026-10-27)` : 'Draft quality, as asked'}: ${width}x${height}, each element drawn as a simple box, so it renders in ${about(draftMinutes)}. Tell the user it is a quick preview by choice, not how their model really looks, so they do not take it for the model's quality; quality: "standard" gives the full detail (${about(fullMinutes)} ${i.fellBack ? 'with the processor' : 'here'}).`
    : mins > limit ? `${boxes ? 'Boxes, as asked' : 'Full detail, as asked'}: expect ${about(mins)} ${where}${boxes ? '' : `; quality: "draft" gives a quick preview in ${about(draftMinutes)}`}. Tell the user it will take a while, and why.` : undefined;
  if (i.fellBack) note = `The graphics card could not finish this render (${i.fellBack.reason}), so the processor drew it, which takes longer: ${about(mins)} instead of the ${about(i.fellBack.firstMinutes)} first estimated. Tell the user why it took longer.${note ? ` ${note}` : ''}`;
  return { quality, boxes, width, height, minutes: mins, fullMinutes, draftMinutes, where, ...(note ? { note } : {}) };
}
