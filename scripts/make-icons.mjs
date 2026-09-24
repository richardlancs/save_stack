// Draws the extension icons (a rounded blue square with a white magnifying glass) and writes them as PNGs, with no image library:
// a tiny anti-aliased rasteriser plus a PNG encoder on node:zlib.   node scripts/make-icons.mjs
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const OUT = path.resolve('public/icon');
const SIZES = [16, 32, 48, 128];
const BLUE = [31, 94, 224];
const WHITE = [255, 255, 255];

/** Coverage (0..1) of the icon's shapes at a point in unit space, returned as { bg, fg } coverage. */
function sample(x, y) {
  // rounded square background
  const r = 0.22;
  const dx = Math.max(Math.abs(x - 0.5) - (0.5 - r), 0);
  const dy = Math.max(Math.abs(y - 0.5) - (0.5 - r), 0);
  const bg = Math.hypot(dx, dy) <= r ? 1 : 0;
  // magnifying glass: ring + handle
  const cx = 0.44, cy = 0.44, R = 0.235, ring = 0.075;
  const d = Math.hypot(x - cx, y - cy);
  const inRing = d <= R + ring / 2 && d >= R - ring / 2 ? 1 : 0;
  // handle: a thick segment from the ring's lower-right toward the corner
  const ax = cx + R * 0.72, ay = cy + R * 0.72, bx = 0.79, by = 0.79, w = 0.085;
  const abx = bx - ax, aby = by - ay;
  const t = Math.max(0, Math.min(1, ((x - ax) * abx + (y - ay) * aby) / (abx * abx + aby * aby)));
  const inHandle = Math.hypot(x - (ax + t * abx), y - (ay + t * aby)) <= w / 2 ? 1 : 0;
  // three small "chips" inside the lens, echoing the search chips
  const chip = (px, py, pw) => (Math.abs(x - px) <= pw / 2 && Math.abs(y - py) <= 0.022 ? 1 : 0);
  const inChips = d < R - ring / 2 - 0.015 ? Math.max(chip(cx, cy - 0.07, 0.26), chip(cx, cy, 0.19), chip(cx, cy + 0.07, 0.23)) : 0;
  return { bg, fg: Math.max(inRing, inHandle, inChips) };
}

function render(size) {
  const px = Buffer.alloc(size * size * 4);
  const N = 4; // supersampling, 4 x 4 per pixel
  for (let j = 0; j < size; j++) {
    for (let i = 0; i < size; i++) {
      let bg = 0, fg = 0;
      for (let sy = 0; sy < N; sy++) for (let sx = 0; sx < N; sx++) {
        const s = sample((i + (sx + 0.5) / N) / size, (j + (sy + 0.5) / N) / size);
        bg += s.bg; fg += s.bg ? s.fg : 0;
      }
      const a = bg / (N * N);
      const f = bg > 0 ? fg / bg : 0;
      const o = (j * size + i) * 4;
      px[o] = Math.round(BLUE[0] * (1 - f) + WHITE[0] * f);
      px[o + 1] = Math.round(BLUE[1] * (1 - f) + WHITE[1] * f);
      px[o + 2] = Math.round(BLUE[2] * (1 - f) + WHITE[2] * f);
      px[o + 3] = Math.round(a * 255);
    }
  }
  return px;
}

function crc32(buf) {
  let c, crc = 0xffffffff;
  for (let n = 0; n < buf.length; n++) {
    c = (crc ^ buf[n]) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}
function png(size, rgba) {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) { raw[y * (size * 4 + 1)] = 0; rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4); }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4); ihdr[8] = 8; ihdr[9] = 6; // 8-bit RGBA
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}

fs.mkdirSync(OUT, { recursive: true });
for (const size of SIZES) {
  const file = path.join(OUT, `${size}.png`);
  fs.writeFileSync(file, png(size, render(size)));
  console.log(`wrote ${path.relative('.', file)} (${fs.statSync(file).size} bytes)`);
}
