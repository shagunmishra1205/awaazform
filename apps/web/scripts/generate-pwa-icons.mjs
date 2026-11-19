// Rasterize the existing vector mark. No image-generation service or external assets.
import { createRequire } from 'node:module';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
// sharp is Next's own image dependency; resolve through Next for pnpm's strict layout.
const sharp = createRequire(require.resolve('next/package.json'))('sharp');
const root = fileURLToPath(new URL('../', import.meta.url));
const original = await readFile(`${root}app/icon.svg`, 'utf8');
await mkdir(`${root}public/icons`, { recursive: true });
for (const size of [192, 512]) {
  await sharp(Buffer.from(original)).resize(size, size).png().toFile(`${root}public/icons/icon-${size}.png`);
  // Full-bleed background, all waveform strokes inside the central 80% safe circle.
  const maskable = original.replace('rx="8"', '').replace('<g fill=', '<g transform="translate(4 4) scale(.75)" fill=');
  await sharp(Buffer.from(maskable)).resize(size, size).png().toFile(`${root}public/icons/maskable-${size}.png`);
}
await sharp(Buffer.from(original.replace('rx="8"', ''))).resize(180, 180).png().toFile(`${root}public/icons/apple-touch-icon.png`);
await writeFile(`${root}public/icons/logo.svg`, original);
console.log('Generated AwaazForm launcher, maskable and Apple icons.');
