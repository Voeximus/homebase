// Generates public/notification-badge.png — a monochrome white house silhouette
// on a transparent background. Android renders the notification status-bar
// "badge" as a flat silhouette (a full-color icon shows as a white square), so
// this gives it the Homebase house instead. Run: node scripts/gen-badge.mjs
import sharp from "sharp";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, "..", "public", "notification-badge.png");

// a clean house outline with a door cutout, centered in a 96×96 canvas
const svg = `<svg width="96" height="96" viewBox="0 0 96 96" xmlns="http://www.w3.org/2000/svg">
  <path d="M48 14 L85 48 L74 48 L74 82 L57 82 L57 58 L39 58 L39 82 L22 82 L22 48 L11 48 Z"
        fill="#ffffff"/>
</svg>`;

await sharp(Buffer.from(svg)).png().toFile(out);
console.log("wrote", out);
