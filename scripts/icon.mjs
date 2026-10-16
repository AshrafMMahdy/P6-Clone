// App icon drawn in code (no image tools needed): a Gantt chart on a blue tile. Writes PNG and ICO bytes.
import { deflateSync, crc32 } from 'node:zlib';

export function iconPng(size = 256) {
  const px = Buffer.alloc(size * size * 4);
  const s = size / 256;
  const set = (x, y, [r, g, b, a = 255]) => { const i = (y * size + x) * 4; px[i] = r; px[i + 1] = g; px[i + 2] = b; px[i + 3] = a; };
  const rect = (x0, y0, x1, y1, c) => { for (let y = Math.round(y0 * s); y < Math.round(y1 * s); y++) for (let x = Math.round(x0 * s); x < Math.round(x1 * s); x++) set(x, y, c); };
  const R = 40 * s; // rounded corners
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const dx = Math.max(R - x, x - (size - 1 - R), 0), dy = Math.max(R - y, y - (size - 1 - R), 0);
    if (dx * dx + dy * dy <= R * R) set(x, y, [31, 78, 140]);
  }
  rect(36, 52, 220, 60, [255, 255, 255, 90]); // timescale line
  rect(36, 76, 132, 104, [122, 201, 67]); // activity bars
  rect(96, 122, 196, 150, [242, 196, 48]);
  rect(150, 168, 220, 196, [230, 74, 60]);
  rect(128, 104, 134, 122, [255, 255, 255]); // relationship lines
  rect(190, 150, 196, 168, [255, 255, 255]);
  rect(36, 208, 220, 214, [255, 255, 255, 90]);
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) px.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type), data]); const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td)); return Buffer.concat([len, td, crc]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

/** ICO holding one 256x256 PNG image (supported by Windows Vista and later). */
export function iconIco() {
  const png = iconPng(256);
  const head = Buffer.alloc(22);
  head.writeUInt16LE(0, 0); head.writeUInt16LE(1, 2); head.writeUInt16LE(1, 4); // reserved, type icon, 1 image
  head[6] = 0; head[7] = 0; head[8] = 0; head[9] = 0; // 256x256, no palette
  head.writeUInt16LE(1, 10); head.writeUInt16LE(32, 12); head.writeUInt32LE(png.length, 14); head.writeUInt32LE(22, 18);
  return Buffer.concat([head, png]);
}
