#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');

const PWA_AVATARS_DIR = path.join(rootDir, 'apps/pwa/public/avatars');
const NATIVE_AVATARS_DIR = path.join(rootDir, 'apps/native/assets/images/avatars');
const MANAGER_AVATARS_DIR = path.join(rootDir, 'apps/manager/public/avatars');

// Bounding box crops for the 23 circular emblems in the 1024x1024 source JPEGs.
// removeInternalChecker removes faux transparency checkerboard pixels found inside
// the emblem's circular border (sprout, wave, solartree).
const CROPS = {
  avatar_atom: { x: 84, y: 82, w: 856, h: 856 },
  avatar_bean_green: { x: 8, y: 10, w: 1008, h: 1008 },
  avatar_bean_purple: { x: 188, y: 190, w: 648, h: 648 },
  avatar_bolt: { x: 104, y: 108, w: 816, h: 816 },
  avatar_butterfly: { x: 103, y: 105, w: 816, h: 816 },
  avatar_crystal: { x: 120, y: 122, w: 784, h: 784 },
  avatar_cybereye: { x: 108, y: 108, w: 808, h: 808 },
  avatar_fire: { x: 100, y: 100, w: 824, h: 824 },
  avatar_honeybee: { x: 138, y: 138, w: 748, h: 748 },
  avatar_leaf: { x: 126, y: 128, w: 772, h: 772 },
  avatar_moon: { x: 76, y: 84, w: 872, h: 872 },
  avatar_mountain: { x: 144, y: 144, w: 736, h: 736 },
  avatar_mushroom: { x: 192, y: 192, w: 640, h: 640 },
  avatar_planet: { x: 64, y: 76, w: 896, h: 896 },
  avatar_portal: { x: 80, y: 80, w: 864, h: 864 },
  avatar_robot: { x: 98, y: 100, w: 824, h: 824 },
  avatar_rocket: { x: 100, y: 100, w: 824, h: 824 },
  avatar_satellite: { x: 75, y: 75, w: 874, h: 874 },
  avatar_solartree: { x: 108, y: 108, w: 808, h: 808, removeInternalChecker: true },
  avatar_sprout: { x: 96, y: 100, w: 832, h: 832, removeInternalChecker: true },
  avatar_sunflower: { x: 104, y: 106, w: 816, h: 816 },
  avatar_wave: { x: 108, y: 108, w: 808, h: 808, removeInternalChecker: true },
  avatar_wind: { x: 52, y: 52, w: 920, h: 920 },
};

function getSourcePath(name) {
  const pwaPath = path.join(PWA_AVATARS_DIR, name + '.jpg');
  if (fs.existsSync(pwaPath)) return pwaPath;
  const mgrPath = path.join(MANAGER_AVATARS_DIR, name + '.jpg');
  if (fs.existsSync(mgrPath)) return mgrPath;
  throw new Error(`Source JPEG not found for ${name} in PWA or Manager public avatars`);
}

/**
 * Cuts the sun avatar:
 * - Solid face inside radius 182.
 * - Outermost cutoff at radius 470.
 * - Custom ray mask between r=182 and r=470 distinguishing saturated yellow/orange rays
 *   from neutral gray checkerboard background, with edge decontamination to avoid halos.
 */
async function cutSun(sourcePath) {
  const { data, info } = await sharp(sourcePath).raw().toBuffer({ resolveWithObject: true });
  const w = info.width, h = info.height;
  const out = Buffer.alloc(w * h * 4);
  const cx = 512, cy = 512;

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const srcIdx = (y * w + x) * 3;
      const dstIdx = (y * w + x) * 4;
      const r = data[srcIdx];
      const g = data[srcIdx + 1];
      const b = data[srcIdx + 2];
      const dist = Math.sqrt((x - cx) ** 2 + (y - cy) ** 2);

      if (dist <= 182) {
        out[dstIdx] = r;
        out[dstIdx + 1] = g;
        out[dstIdx + 2] = b;
        out[dstIdx + 3] = 255;
        continue;
      }
      if (dist > 470) continue;

      const colorDiff = ((r - b) + (g - b)) / 2;
      if (colorDiff <= 15) {
        continue;
      } else if (colorDiff >= 100) {
        out[dstIdx] = r;
        out[dstIdx + 1] = g;
        out[dstIdx + 2] = b;
        out[dstIdx + 3] = 255;
      } else {
        const alpha = Math.round(((colorDiff - 15) / 85) * 255);
        const a = alpha / 255;
        const bgVal = 235;
        const fgR = Math.min(255, Math.max(0, Math.round((r - bgVal * (1 - a)) / a)));
        const fgG = Math.min(255, Math.max(0, Math.round((g - bgVal * (1 - a)) / a)));
        const fgB = Math.min(255, Math.max(0, Math.round((b - bgVal * (1 - a)) / a)));
        out[dstIdx] = fgR;
        out[dstIdx + 1] = fgG;
        out[dstIdx + 2] = fgB;
        out[dstIdx + 3] = alpha;
      }
    }
  }

  return sharp(out, { raw: { width: w, height: h, channels: 4 } })
    .extract({ left: 52, top: 52, width: 920, height: 920 })
    .resize(512, 512);
}

/**
 * Cuts a circular emblem:
 * - Extracts bounding box of emblem.
 * - Resizes to 512x512.
 * - Clips to circular mask of radius 254 (1px inside border ring).
 * - Optionally removes faux checkerboard pixels inside the circle.
 */
async function cutCircle(name, crop, sourcePath) {
  const circleSvg = Buffer.from(
    '<svg width="512" height="512"><circle cx="256" cy="256" r="254" fill="white"/></svg>'
  );

  if (crop.removeInternalChecker) {
    const { data } = await sharp(sourcePath)
      .extract({ left: crop.x, top: crop.y, width: crop.w, height: crop.h })
      .resize(512, 512)
      .raw()
      .toBuffer({ resolveWithObject: true });

    const out = Buffer.alloc(512 * 512 * 4);
    const cx = 256, cy = 256, r = 254;

    for (let y = 0; y < 512; y++) {
      for (let x = 0; x < 512; x++) {
        const idx = (y * 512 + x) * 3;
        const outIdx = (y * 512 + x) * 4;
        const red = data[idx], green = data[idx + 1], blue = data[idx + 2];
        const dist = Math.sqrt((x - cx) ** 2 + (y - cy) ** 2);
        if (dist > r) continue;

        const maxDiff = Math.max(Math.abs(red - green), Math.abs(green - blue), Math.abs(red - blue));
        const avg = (red + green + blue) / 3;
        if (maxDiff <= 8 && avg >= 200) {
          continue; // transparent checkerboard inside circle
        }
        out[outIdx] = red;
        out[outIdx + 1] = green;
        out[outIdx + 2] = blue;
        out[outIdx + 3] = 255;
      }
    }

    return sharp(out, { raw: { width: 512, height: 512, channels: 4 } });
  }

  return sharp(sourcePath)
    .extract({ left: crop.x, top: crop.y, width: crop.w, height: crop.h })
    .resize(512, 512)
    .composite([{ input: circleSvg, blend: 'dest-in' }]);
}

async function encodeWebpUnderTarget(sharpInstance, isSun = false) {
  let q = isSun ? 45 : 90;
  const targetBytes = 38 * 1024; // strictly under 40 KB limit
  let buf;

  while (q >= 25) {
    const options = isSun
      ? { quality: q, alphaQuality: 50, effort: 6 }
      : { quality: q, effort: 6 };
    buf = await sharpInstance.clone().webp(options).toBuffer();
    if (buf.length <= targetBytes || q <= 30) break;
    q -= 5;
  }

  return { buf, q, size: buf.length };
}

export async function cutAllAvatars() {
  fs.mkdirSync(PWA_AVATARS_DIR, { recursive: true });
  fs.mkdirSync(NATIVE_AVATARS_DIR, { recursive: true });

  const summary = [];

  // Process 23 circular emblems
  for (const [name, crop] of Object.entries(CROPS)) {
    const sourcePath = getSourcePath(name);
    const sharpInstance = await cutCircle(name, crop, sourcePath);
    const { buf, q, size } = await encodeWebpUnderTarget(sharpInstance, false);

    const outWebpName = `${name}.webp`;
    fs.writeFileSync(path.join(PWA_AVATARS_DIR, outWebpName), buf);
    fs.writeFileSync(path.join(NATIVE_AVATARS_DIR, outWebpName), buf);

    summary.push({ name: outWebpName, q, size, kb: (size / 1024).toFixed(1) });
  }

  // Process Sun
  const sunSourcePath = getSourcePath('avatar_sun');
  const sunSharpInstance = await cutSun(sunSourcePath);
  const { buf: sunBuf, q: sunQ, size: sunSize } = await encodeWebpUnderTarget(sunSharpInstance, true);

  const sunWebpName = 'avatar_sun.webp';
  fs.writeFileSync(path.join(PWA_AVATARS_DIR, sunWebpName), sunBuf);
  fs.writeFileSync(path.join(NATIVE_AVATARS_DIR, sunWebpName), sunBuf);

  summary.push({ name: sunWebpName, q: sunQ, size: sunSize, kb: (sunSize / 1024).toFixed(1) });
  summary.sort((a, b) => a.name.localeCompare(b.name));

  console.log('Successfully cut 24 preset avatars to 512px transparent WebP:');
  for (const s of summary) {
    console.log(`  ${s.name.padEnd(25)} quality=${s.q}  ${s.kb} KB (${s.size} bytes)`);
  }

  return summary;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  cutAllAvatars().catch((err) => {
    console.error('Failed to cut avatars:', err);
    process.exit(1);
  });
}
