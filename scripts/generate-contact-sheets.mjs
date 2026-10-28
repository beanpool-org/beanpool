import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { AVATAR_PRESETS } from '../packages/beanpool-core/dist/index.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');
const avatarsDir = path.join(rootDir, 'apps/pwa/public/avatars');

async function buildContactSheet(bgR, bgG, bgB, outName) {
  const cols = 6;
  const rows = 4;
  const cellSize = 140;
  const imgSize = 120;
  const pad = (cellSize - imgSize) / 2;
  const width = cols * cellSize;
  const height = rows * cellSize;

  // Background
  const base = sharp({
    create: {
      width,
      height,
      channels: 4,
      background: { r: bgR, g: bgG, b: bgB, alpha: 1 }
    }
  });

  const composites = [];

  for (let i = 0; i < AVATAR_PRESETS.length; i++) {
    const preset = AVATAR_PRESETS[i];
    const fileName = `avatar_${preset.id.replace(/-/g, '_')}.webp`;
    const filePath = path.join(avatarsDir, fileName);

    const c = i % cols;
    const r = Math.floor(i / cols);
    const left = Math.round(c * cellSize + pad);
    const top = Math.round(r * cellSize + pad);

    const resized = await sharp(filePath)
      .resize(imgSize, imgSize)
      .toBuffer();

    composites.push({
      input: resized,
      left,
      top
    });
  }

  const outPath = path.join(rootDir, outName);
  await base.composite(composites).png().toFile(outPath);
  console.log(`Generated ${outName}: ${width}x${height}`);
  return outPath;
}

async function main() {
  await buildContactSheet(245, 245, 245, 'contact-sheet-light.png');
  await buildContactSheet(18, 18, 18, 'contact-sheet-dark.png');
}

main().catch(console.error);
