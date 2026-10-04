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

// ── The mark, 2026-10-04 ─────────────────────────────────────────────────────
//
// It was a teal→blue shield split down the middle. He picked this one off three
// options: a white house on systemBlue, doorway knocked out.
//
// TWO BLUES, NOT THREE. The gradient runs #0A84FF → #0040DD, Apple's own
// systemBlue falling into a deeper one. The old mark had a green end, and a
// green-to-blue sweep is the thing that reads as "a generic app icon".
//
// THE DOORWAY IS A KNOCK-OUT, not a drawn rectangle, so it is always exactly the
// blue behind it and cannot drift from the gradient.
//
// WHY IT SURVIVES AT 40px, which is what actually decides an icon: the whole mark
// is two solid shapes with no stroke anywhere. The outline version of this house
// was the better drawing at 152px and a grey smudge at 40.
const HOUSE = "M12 46 L50 14 L88 46 L88 88 L12 88 Z";
const DOOR = { x: 40, y: 62, w: 20, h: 26, r: 2 };
const BLUE = `<linearGradient id="B" x1="10" y1="6" x2="92" y2="96" gradientUnits="userSpaceOnUse">
      <stop offset="0" stop-color="#0A84FF"/><stop offset="1" stop-color="#0040DD"/>
    </linearGradient>`;

/** The mark alone, on transparency — a blue house with the doorway cut out of it.
 *  This is the favicon form: no tile, because a tile only shrinks the mark in a
 *  16px browser tab. */
function mark(scale = 1, cx = 50, cy = 50) {
  const t = `translate(${cx - 50 * scale} ${cy - 50 * scale}) scale(${scale})`;
  return `
  <defs>
    ${BLUE}
    <mask id="M">
      <path d="${HOUSE}" fill="#fff"/>
      <rect x="${DOOR.x}" y="${DOOR.y}" width="${DOOR.w}" height="${DOOR.h}" rx="${DOOR.r}" fill="#000"/>
    </mask>
  </defs>
  <g transform="${t}">
    <rect x="0" y="0" width="100" height="100" fill="url(#B)" mask="url(#M)"/>
  </g>`;
}

/** The mark INVERTED — a white house on a filled blue tile. This is the app-tile
 *  form: at icon sizes a solid field of colour reads from further away than a
 *  coloured shape on a dark ground, which is what the old graphite tile was. */
function plate(scale = 1) {
  const inset = (100 - 100 * scale) / 2;
  return `
  <defs>${BLUE}</defs>
  <rect width="100" height="100" fill="url(#B)"/>
  <g transform="translate(${inset} ${inset}) scale(${scale})">
    <path d="${HOUSE}" fill="#fff"/>
    <rect x="${DOOR.x}" y="${DOOR.y}" width="${DOOR.w}" height="${DOOR.h}" rx="${DOOR.r}" fill="#0A84FF"/>
  </g>`;
}

// ── favicon: the mark alone, filling the frame. A dark tile behind it would
//    only shrink the mark in a 16px browser tab for nothing.
const favicon = `<svg width="512" height="512" viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg">${mark(1.0, 50, 50)}
</svg>`;
fs.writeFileSync(`${OUT}/favicon.svg`, favicon + "\n");

// ── app tile: full-bleed BLUE so an OS mask never cuts a white edge, with the
//    mark inside the maskable safe zone. The tile was graphite with a cyan glow
//    behind the mark; a glow is invisible at 40px and only softened the edge, so
//    the colour is the tile itself now.
const tile = (safe) => `<svg width="1024" height="1024" viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg">
  ${plate(safe)}
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
