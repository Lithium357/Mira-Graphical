// SPDX-License-Identifier: GPL-3.0-only
// Code-native Mira mark, matching the workbench's green M. PNG-in-ICO for Windows.
import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
const size = 256,
  polygon = [
    [58, 60],
    [94, 60],
    [128, 126],
    [162, 60],
    [198, 60],
    [198, 198],
    [166, 198],
    [166, 123],
    [140, 174],
    [116, 174],
    [90, 123],
    [90, 198],
    [58, 198],
  ];
const inside = (x, y) => {
  let yes = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const [a, b] = polygon[i],
      [c, d] = polygon[j];
    if (b > y !== d > y && x < ((c - a) * (y - b)) / (d - b) + a) yes = !yes;
  }
  return yes;
};
const raw = Buffer.alloc(size * (size * 4 + 1));
for (let y = 0; y < size; y++)
  for (let x = 0; x < size; x++) {
    const offset = y * (size * 4 + 1) + 1 + x * 4;
    const dx = Math.max(40 - x, 0, x - 215),
      dy = Math.max(40 - y, 0, y - 215);
    const color = inside(x + 0.5, y + 0.5) ? [11, 18, 32] : [86, 222, 189];
    raw.set([...color, dx * dx + dy * dy <= 40 * 40 ? 255 : 0], offset);
  }
function crc(bytes) {
  let value = 0xffffffff;
  for (const byte of bytes) {
    value ^= byte;
    for (let i = 0; i < 8; i++) value = (value >>> 1) ^ (value & 1 ? 0xedb88320 : 0);
  }
  return (value ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const kind = Buffer.from(type),
    length = Buffer.alloc(4),
    checksum = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  checksum.writeUInt32BE(crc(Buffer.concat([kind, data])));
  return Buffer.concat([length, kind, data, checksum]);
}
const header = Buffer.alloc(13);
header.writeUInt32BE(size, 0);
header.writeUInt32BE(size, 4);
header[8] = 8;
header[9] = 6;
const png = Buffer.concat([
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
  chunk('IHDR', header),
  chunk('IDAT', deflateSync(raw)),
  chunk('IEND', Buffer.alloc(0)),
]);
const ico = Buffer.alloc(22);
ico.writeUInt16LE(1, 2);
ico.writeUInt16LE(1, 4);
ico.writeUInt16LE(1, 10);
ico.writeUInt16LE(32, 12);
ico.writeUInt32LE(png.length, 14);
ico.writeUInt32LE(22, 18);
mkdirSync('build', { recursive: true });
writeFileSync('build/mira.ico', Buffer.concat([ico, png]));
