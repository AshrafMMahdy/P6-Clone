// Finding a TrueType font for Unicode text in CLI / MCP printouts (Node only; the desktop app uses Chromium's fonts).
// Order: a font given explicitly (--font, MCP settings.font_path, P6CLONE_FONT), a fonts/ folder shipped next to the
// tool, then common system fonts. The first font that has every character on the pages wins.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { parseTtf, type TtfFont } from './unicode-font.ts';

const SYSTEM = [
  '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf', '/usr/share/fonts/dejavu/DejaVuSans.ttf', '/usr/share/fonts/TTF/DejaVuSans.ttf',
  '/usr/share/fonts/truetype/noto/NotoSansArabic-Regular.ttf', '/usr/share/fonts/truetype/noto/NotoSans-Regular.ttf',
  '/usr/share/fonts/truetype/freefont/FreeSans.ttf', '/usr/share/fonts/truetype/freefont/FreeSerif.ttf',
  'C:/Windows/Fonts/arial.ttf', 'C:/Windows/Fonts/tahoma.ttf', 'C:/Windows/Fonts/segoeui.ttf',
  '/Library/Fonts/Arial Unicode.ttf', '/System/Library/Fonts/Supplemental/Arial Unicode.ttf', '/System/Library/Fonts/Supplemental/Arial.ttf',
];
const shipped = () => {
  // dist-cli/fonts beside the bundles; the repository's fonts/ when run from cli/ or mcp/; the current folder
  const here = dirname(process.argv[1] ?? '.');
  const dirs = [join(here, 'fonts'), join(here, '..', 'fonts'), join(process.cwd(), 'fonts')];
  return dirs.flatMap((d) => { try { return readdirSync(d).filter((f) => /\.ttf$/i.test(f)).map((f) => join(d, f)); } catch { return []; } });
};

/** A font covering the characters (or the best available), or null when there is none. Skips unreadable files. */
export function findUnicodeFont(chars: Set<number>, explicit?: string): TtfFont | null {
  const list = [explicit, process.env.P6CLONE_FONT, ...shipped(), ...SYSTEM].filter((p): p is string => !!p && existsSync(p));
  let best: TtfFont | null = null, bestCover = -1;
  for (const p of list) {
    let f: TtfFont;
    try { f = parseTtf(new Uint8Array(readFileSync(p))); } catch { continue; }
    let cover = 0; for (const c of chars) if (f.cmap.has(c)) cover++;
    if (cover === chars.size) return f;
    if (cover > bestCover) { best = f; bestCover = cover; }
  }
  return best;
}
