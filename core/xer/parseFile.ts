// An XER read from its file a chunk at a time (Node only: the desktop's renderer reads bytes with parseXer).
import { closeSync, openSync, readSync, statSync } from 'node:fs';
import { parseXerSource, type ParseResult } from './parse.ts';
import { markBaselines } from '../progress/baseline.ts';
import { compactHeap } from '../bim/element.ts';
import type { TextEncodingName } from '../encoding.ts';

/** Parse the XER file at path, a chunk at a time: the file is never held whole (a 195 MB XER is 195 MB less to hold
 *  while its rows are built). The same result as parseXer on its bytes. */
export function parseXerFile(path: string, opts: { encoding?: TextEncodingName | 'auto' } = {}): ParseResult {
  const fd = openSync(path, 'r');
  try {
    const size = statSync(path).size;
    // a full collection every 64 MB read: the lines' garbage (decoded text, split fields) is let go as it goes, so
    // the peak stays near the rows kept instead of growing to what the heap allows (a 195 MB XER: see README)
    let read = 0;
    return parseXerSource({ size, read: (pos, len) => {
      const b = Buffer.allocUnsafe(Math.min(len, size - pos)); const n = readSync(fd, b, 0, b.length, pos);
      if (size > 64 * 1048576 && (read += n) >= 64 * 1048576) { read = 0; compactHeap(); }
      return b.subarray(0, n);
    } }, opts);
  } finally { closeSync(fd); }
}

/** readRaw for an XER file (its baselines marked), with what the reader saw of its encoding. */
export function readXerFile(path: string, encoding?: TextEncodingName | 'auto'): ParseResult {
  const r = parseXerFile(path, { encoding });
  markBaselines(r.db);
  return r;
}
