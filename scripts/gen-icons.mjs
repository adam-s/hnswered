#!/usr/bin/env node
/**
 * Generate solid HN-orange PNG icons (16/32/48/128) with a white "Y" mark.
 * Writes directly into ../icons/.
 * Pure Node — uses zlib for DEFLATE and a hand-rolled PNG encoder.
 */
import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT = resolve(__dirname, '..', 'icons');
mkdirSync(OUT, { recursive: true });

const ORANGE = [0xff, 0x66, 0x00];
const WHITE = [0xff, 0xff, 0xff];
// Background is white so the orange toolbar-badge pill contrasts cleanly.
const BG = WHITE;
const FG = ORANGE;

function crc32(buf) {
  let c;
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) crc = table[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crcBuf = Buffer.alloc(4);
  const crc = crc32(Buffer.concat([typeBuf, data]));
  crcBuf.writeUInt32BE(crc, 0);
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}

function encodePng(width, height, pixels) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  const stride = width * 3;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0;
    pixels.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  const idat = deflateSync(raw);
  return Buffer.concat([
    sig,
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function drawY(size) {
  const pixels = Buffer.alloc(size * size * 3);
  for (let i = 0; i < size * size; i++) {
    pixels[i * 3] = BG[0];
    pixels[i * 3 + 1] = BG[1];
    pixels[i * 3 + 2] = BG[2];
  }
  const setPx = (x, y) => {
    if (x < 0 || y < 0 || x >= size || y >= size) return;
    const o = (y * size + x) * 3;
    pixels[o] = FG[0];
    pixels[o + 1] = FG[1];
    pixels[o + 2] = FG[2];
  };
  const thick = Math.max(1, Math.round(size / 10));
  const midX = size / 2;
  const topY = Math.round(size * 0.22);
  const forkY = Math.round(size * 0.55);
  const bottomY = Math.round(size * 0.82);
  const branchX = Math.round(size * 0.25);
  const len = Math.abs(forkY - topY);
  for (let i = 0; i <= len; i++) {
    const t = i / len;
    const xL = Math.round(midX - (midX - (midX - branchX)) * t);
    const xR = Math.round(midX + (midX - branchX) * t - (midX - (size - branchX - 1)) * 0);
    for (let d = -thick; d <= thick; d++) {
      setPx(xL + d, topY + i);
      setPx(size - 1 - xL + d, topY + i);
    }
    // suppress unused
    void xR;
  }
  for (let y = forkY; y <= bottomY; y++) {
    for (let d = -thick; d <= thick; d++) setPx(Math.round(midX) + d, y);
  }
  return pixels;
}

for (const size of [16, 32, 48, 128]) {
  const png = encodePng(size, size, drawY(size));
  const file = resolve(OUT, `icon-${size}.png`);
  writeFileSync(file, png);
  console.log(`wrote ${file} (${png.length} bytes)`);
}
