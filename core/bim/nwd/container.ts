// Navisworks files (.nwd published, .nwc cache, .nwf with its caches inside): the container. Clean-room: worked out from
// the bytes of the sample files only (sample 4D/BINARY-NOTES.md), never from Autodesk or other readers' code.
//
//   "#LcUStream-V1.1 binary double release C lichunk-008\n"   header line
//   sections, each one or more zlib streams (some with a 4-byte lead)
//   "#LcUStream-V1.1 binary double release utf8 navisworks:NNN lizlib\n", 7 zero bytes, the table of contents (zlib):
//       i32 -1, u32 count, then per section: u32 length + UTF-8 name (padded to 4), u32 version, (align 8)
//       u64 file offset, u64 length, u32, u32
//   the header line again
import { inflateSync } from 'node:zlib';

export interface NwSection { name: string; version: number; offset: number; length: number }
export interface NwContainer { revision: number; sections: NwSection[]; bytes: Uint8Array }

const td = new TextDecoder();
const HEAD = '#LcUStream-V1.1 binary double release';

export const isNavisworksBytes = (b: Uint8Array) => b.length > 52 && td.decode(b.subarray(0, HEAD.length)) === HEAD;

/** Every zlib stream in b, inflated and joined (a stream's own length is found by inflating it). maxBytes caps what
 *  the whole section may unpack to. */
export function inflateAll(b: Uint8Array, maxBytes: number): Uint8Array {
  const out: Buffer[] = [];
  let total = 0;
  for (let i = 0; i + 2 <= b.length;) {
    if (b[i] !== 0x78 || ((b[i] << 8) | b[i + 1]) % 31 !== 0) { i++; continue; }
    let one: Buffer, used: number;
    try {
      ({ buffer: one, engine: { bytesWritten: used } } = inflateSync(b.subarray(i), { maxOutputLength: Math.max(1, maxBytes - total), info: true }) as unknown as { buffer: Buffer; engine: { bytesWritten: number } });
    } catch (e) {
      if ((e as { code?: string }).code === 'ERR_BUFFER_TOO_LARGE') throw new Error(`a Navisworks section unpacks past ${Math.round(maxBytes / 1048576)} MB`);
      i++; continue;
    }
    out.push(one); total += one.length;
    i += used;
  }
  return out.length === 1 ? out[0] : Buffer.concat(out);
}

/** The table of contents. Throws on anything that is not a lichunk-008 Navisworks file. */
export function readContainer(bytes: Uint8Array): NwContainer {
  if (!isNavisworksBytes(bytes)) throw new Error('not a Navisworks file (no "#LcUStream" header)');
  const text = td.decode(bytes.subarray(0, 64));
  if (!/lichunk-008/.test(text)) throw new Error(`a Navisworks file in an older layout (${text.split('\n')[0].split(' ').pop()}) that this reader does not read yet; save it again from a current Navisworks`);
  // the table's header is the last "utf8 navisworks:" line
  const tail = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const at = tail.lastIndexOf('utf8 navisworks:');
  if (at < 0) throw new Error('Navisworks file without its table of contents (cut short?)');
  const start = tail.lastIndexOf('#LcUStream', at), nl = tail.indexOf(0x0a, at);
  const revision = Number(/navisworks:(\d+)/.exec(td.decode(tail.subarray(start, nl)))![1]);
  const toc = inflateAll(tail.subarray(nl + 1), 64 * 1048576);
  const v = new DataView(toc.buffer, toc.byteOffset, toc.byteLength);
  const n = v.getUint32(4, true);
  const sections: NwSection[] = [];
  let k = 8;
  for (let s = 0; s < n; s++) {
    const len = v.getUint32(k, true); k += 4;
    const name = td.decode(toc.subarray(k, k + len)); k += (len + 3) & ~3;
    const version = v.getUint32(k, true); k += 4;
    k = (k + 7) & ~7;
    const offset = Number(v.getBigUint64(k, true)), length = Number(v.getBigUint64(k + 8, true)); k += 24;
    if (offset + length > bytes.length) throw new Error(`Navisworks section ${name} runs past the end of the file (cut short?)`);
    sections.push({ name, version, offset, length });
  }
  return { revision, sections, bytes };
}

/** A section's content, inflated (null when the file has none of that name). The name is matched on its end
 *  ("LcOpNwdLogicalHierarchy" finds "cache\\LcOpNwdLogicalHierarchy" and "model.nwd\\LcOpNwdLogicalHierarchy"). */
export function section(c: NwContainer, name: string, maxBytes: number): Uint8Array | null {
  const s = c.sections.find((x) => x.name === name || x.name.endsWith(`\\${name}`));
  return s ? inflateAll(c.bytes.subarray(s.offset, s.offset + s.length), maxBytes) : null;
}
