// Build every icon asset from ONE definition of the mark, so the favicon, the
// PWA icon and the in-app component can never drift apart again — which is
// exactly what had happened: a house in the favicon, a lucide Wallet on the
// login screen.
//
// The gradient here MUST match src/components/Logo.tsx. If you re-pigment the
// mark, change both and re-run this script, or the tab icon and the in-app mark
// quietly become two different logos again.
import fs from "node:fs";
import sharp from "sharp";

import { fileURLToPath } from "node:url";
import path from "node:path";

const OUT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "public");

const PLATE = "M22 28 H78 V54 L50 80 L22 54 Z";
const SW = 13;

/** The mark alone, on transparency. `s` scales it inside a 100-unit box. */
function mark(scale = 1, cx = 50, cy = 54) {
  const t = `translate(${cx - 50 * scale} ${cy - 54 * scale}) scale(${scale})`;
  return `
  <defs>
    <linearGradient id="L" x1="18" y1="18" x2="52" y2="86" gradientUnits="userSpaceOnUse">
      <stop offset="0" stop-color="#34d399"/><stop offset="1" stop-color="#06b6d4"/>
    </linearGradient>
    <linearGradient id="R" x1="48" y1="18" x2="86" y2="86" gradientUnits="userSpaceOnUse">
      <stop offset="0" stop-color="#06b6d4"/><stop offset="1" stop-color="#3b82f6"/>
    </linearGradient>
    <mask id="M">
      <path d="${PLATE}" fill="#fff" stroke="#fff" stroke-width="${SW}" stroke-linejoin="round" paint-order="stroke"/>
      <rect x="48.8" y="0" width="2.4" height="62" fill="#000"/>
    </mask>
  </defs>
  <g transform="${t}">
    <g mask="url(#M)">
      <rect x="0" y="0" width="50" height="100" fill="url(#L)"/>
      <rect x="50" y="0" width="50" height="100" fill="url(#R)"/>
    </g>
  </g>`;
}

// ── favicon: the mark alone, filling the frame. A dark tile behind it would
//    only shrink the mark in a 16px browser tab for nothing.
const favicon = `<svg width="512" height="512" viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg">${mark(1.06, 50, 52)}
</svg>`;
fs.writeFileSync(`${OUT}/favicon.svg`, favicon + "\n");

// ── app tile: full-bleed graphite so an OS mask never cuts a white edge, with
//    the mark inside the maskable safe zone (the inner 80%).
const tile = (safe) => `<svg width="1024" height="1024" viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <radialGradient id="glow" cx="50" cy="46" r="42" gradientUnits="userSpaceOnUse">
      <stop offset="0" stop-color="#06b6d4" stop-opacity="0.22"/><stop offset="1" stop-color="#06b6d4" stop-opacity="0"/>
    </radialGradient>
  </defs>
  <rect width="100" height="100" fill="#0a0d12"/>
  <rect width="100" height="100" fill="url(#glow)"/>
  ${mark(safe, 50, 52)}
</svg>`;

const jobs = [
  ["pwa-64x64.png", tile(0.78), 64],
  ["pwa-192x192.png", tile(0.78), 192],
  ["pwa-512x512.png", tile(0.78), 512],
  ["pwa-1024x1024.png", tile(0.78), 1024],
  ["apple-touch-icon-180x180.png", tile(0.78), 180],
  // maskable: the OS crops to a circle, so the mark lives inside the inner 80%
  ["maskable-icon-512x512.png", tile(0.6), 512],
  ["maskable-icon-1024x1024.png", tile(0.6), 1024],
];

for (const [name, svg, size] of jobs) {
  await sharp(Buffer.from(svg)).resize(size, size).png().toFile(`${OUT}/${name}`);
  console.log("wrote", name, size);
}

// favicon.ico — a 48px PNG wrapped in an ICO container (every browser that
// still asks for .ico accepts PNG-in-ICO). Written here rather than by hand so
// the .ico can never drift away from the .svg the way the old house icon did.
const ico48 = await sharp(Buffer.from(favicon)).resize(48, 48).png().toBuffer();
const header = Buffer.alloc(6);
header.writeUInt16LE(0, 0); // reserved
header.writeUInt16LE(1, 2); // type: icon
header.writeUInt16LE(1, 4); // one image
const entry = Buffer.alloc(16);
entry[0] = 48; // width
entry[1] = 48; // height
entry[2] = 0; // palette
entry[3] = 0; // reserved
entry.writeUInt16LE(1, 4); // colour planes
entry.writeUInt16LE(32, 6); // bits per pixel
entry.writeUInt32LE(ico48.length, 8);
entry.writeUInt32LE(6 + 16, 12); // offset
fs.writeFileSync(`${OUT}/favicon.ico`, Buffer.concat([header, entry, ico48]));
console.log("wrote favicon.svg + favicon.ico");
