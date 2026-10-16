export type TextEncodingName = 'utf-8-bom' | 'utf-8' | 'windows-1252';

export function decodeText(b: Uint8Array): { text: string; encoding: TextEncodingName } {
  if (b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf) {
    return { text: new TextDecoder('utf-8').decode(b.subarray(3)), encoding: 'utf-8-bom' };
  }
  let high = false;
  for (const x of b) if (x >= 0x80) { high = true; break; }
  if (high) {
    try {
      return { text: new TextDecoder('utf-8', { fatal: true }).decode(b), encoding: 'utf-8' };
    } catch { /* not UTF-8, fall through */ }
  }
  return { text: new TextDecoder('windows-1252').decode(b), encoding: high ? 'windows-1252' : 'utf-8' };
}

let reverse: Map<number, number> | undefined;

export function encodeCp1252(s: string): Uint8Array {
  if (!reverse) {
    reverse = new Map();
    const dec = new TextDecoder('windows-1252');
    for (let i = 0x80; i < 0x100; i++) reverse.set(dec.decode(new Uint8Array([i])).codePointAt(0)!, i);
  }
  const out = new Uint8Array(s.length);
  let n = 0;
  for (const ch of s) {
    const c = ch.codePointAt(0)!;
    out[n++] = c < 0x80 ? c : reverse.get(c) ?? 0x3f;
  }
  return out.subarray(0, n);
}
