#!/usr/bin/env node
//
// Bakes Dark's doodle tiles and its header banner from Classic dark's art (DESIGN-themes-fable.md §3.4 and §6; slice T5;
// Marty, 12 Nov 2026: "Dark has no green"). Repeatable: run it again and the same files come out.
//
//   node scripts/bake-dark-doodle.mjs            write the files in place (build @beanpool/core first: it reads core's dist)
//   node scripts/bake-dark-doodle.mjs --out DIR  write them under DIR instead (a rehearsal; nothing in the repo changes)
//
// WHAT IT MAKES (the same sizes and densities as Classic's tiles; each file no bigger than the file it stands in for)
//   apps/native/assets/images/pattern-night.webp       890 x 890   (the phone, 1x)
//   apps/native/assets/images/pattern-night@2x.webp   1780 x 1780  (the phone, 2x)
//   apps/pwa/public/pattern-night.webp                 the same bytes as the phone's 1x
//   apps/pwa/public/pattern-night-2x.webp              the same bytes as the phone's 2x
//   apps/pwa/public/assets/vines-banner-night.jpg      640 x 640, the web's header and bottom bar
// Classic's and Light's files are INPUTS here and are never written.
//
// HOW (the rule of §3.3: a look changes the hue of a colour, never how light it is)
//   Tiles. Every pixel of Classic dark's tile keeps its linear luminance. It is placed on the line between Dark's ground
//   and Dark's doodle line (the library's brandGrounds('night').doodle, `ground` and `line`), at the same distance along
//   it as the pixel was between Classic dark's ground and line. Dark's two colours are each as light as Classic's, so the
//   doodle stands off its ground exactly as far as Classic's does (the "lift": the median line is 1.50:1 on its ground in
//   Classic dark). Pixels within noise of the ground (under SNAP_CONTRAST) are set to the ground itself: Classic's lossy
//   tile has a few levels of noise on its flat ground, and a flat ground is what lets the tile's ground be the library's
//   exactly, and keeps the file small.
//   Ground. The tile is lossy (WebP, as Classic's: a lossless tile is 1.5 to 2.3 times as big), and 8-bit 4:2:0 colour cannot
//   show every grey: no input at all decodes to exactly the library's #17191c (checked: all 729 colours within 4 levels of it,
//   as a flat patch, at quality 75), and the nearest a decode gets is one level off in one channel. So the script encodes,
//   decodes, reads the most common colour (the ground) and corrects the colour it put in by the difference, until the
//   decoded ground is within GROUND_TOLERANCE (one level per channel, a contrast of under 1.01:1) of the library's, and
//   refuses to finish otherwise. The test (scripts/dark-doodle.test.mjs) reads the committed files the same way.
//   Size. The encoder's quality is the highest, in steps of five, whose file is no bigger than Classic dark's.
//
//   Banner. The same art, in charcoal. Its vines are a glowing neon green; here each pixel's brightness keeps its place
//   between the gaps (Dark's banner ground) and the brightest glow (VINE_PEAK), and the colour is Dark's charcoal blue-grey
//   at that place. The header and the bottom bar draw it under a black wash (50 % in the header, 30 % in the bar), so the
//   file's gaps are twice the library's web.banner and the header shows web.banner itself, the colour the browser's own bar
//   runs on from. The lines are quieter than Classic's glow, so the light words over them read at least as well.
//
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import sharp from 'sharp';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CORE = path.join(ROOT, 'packages/beanpool-core/dist/brand-colours.js');
if (!fs.existsSync(CORE)) throw new Error(`${CORE} is missing: build @beanpool/core first (pnpm --filter @beanpool/core build)`);
const { brandGrounds } = await import(pathToFileURL(CORE).href);

/** How far (levels per channel) a lossy tile's decoded ground may sit from the library's: the closest 8-bit 4:2:0 gets to #17191c. */
export const GROUND_TOLERANCE = 1;
/** Pixels this close to the ground (contrast ratio) are the ground: Classic's encoder noise, not doodle. */
export const SNAP_CONTRAST = 1.05;
/** The black wash the header draws over the banner (App's AppHeader and LobbyHeader: `dark:bg-black/50`). */
export const HEADER_WASH = 0.5;
/** The brightest vine as the header shows it, under the wash: Dark's grey step 700 (the library's web.ramp['700'], `night`). */
export const VINE_PEAK = '#575c69';
/** The most a banner file may weigh: Classic's banner (apps/pwa/public/assets/neon-vines-banner.png) is 45,838 bytes. */
export const BANNER_MAX_BYTES = 45838;

export const TILES = [
    { from: 'apps/native/assets/images/pattern-dark.webp', size: 890, to: ['apps/native/assets/images/pattern-night.webp', 'apps/pwa/public/pattern-night.webp'] },
    { from: 'apps/native/assets/images/pattern-dark@2x.webp', size: 1780, to: ['apps/native/assets/images/pattern-night@2x.webp', 'apps/pwa/public/pattern-night-2x.webp'] },
];
export const BANNER = { from: 'apps/pwa/public/assets/neon-vines-banner.png', to: 'apps/pwa/public/assets/vines-banner-night.jpg' };

// ——— colour arithmetic (sRGB bytes <-> linear light) ———
export const hexToRgb = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
export const rgbToHex = (rgb) => '#' + rgb.map((v) => v.toString(16).padStart(2, '0')).join('');
const LIN = new Float64Array(256).map((_, i) => { const c = i / 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; });
const toByte = (lin) => {
    const c = lin <= 0.0031308 ? lin * 12.92 : 1.055 * lin ** (1 / 2.4) - 0.055;
    return Math.max(0, Math.min(255, Math.round(c * 255)));
};
export const luminance = (r, g, b) => 0.2126 * LIN[r] + 0.7152 * LIN[g] + 0.0722 * LIN[b];
export const contrast = (a, b) => (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);

async function decode(file) {
    const { data, info } = await sharp(file).removeAlpha().raw().toBuffer({ resolveWithObject: true });
    return { data, width: info.width, height: info.height };
}

/** The most common colour of an RGB buffer: a tile's ground. */
export function mostCommonColour(data) {
    const counts = new Map();
    for (let i = 0; i < data.length; i += 3) {
        const key = (data[i] << 16) | (data[i + 1] << 8) | data[i + 2];
        counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    let best = 0, bestN = -1;
    for (const [key, n] of counts) if (n > bestN) { best = key; bestN = n; }
    return [best >> 16, (best >> 8) & 255, best & 255];
}

/** The doodle's line as a member sees it, as the library measures it: the median, by lightness, of the pixels that stand 1.3:1 or more off the ground. */
export function lineLift(data, groundRgb) {
    const gl = luminance(...groundRgb);
    const lit = [];
    for (let i = 0; i < data.length; i += 3) {
        const l = luminance(data[i], data[i + 1], data[i + 2]);
        if (contrast(l, gl) >= 1.3) lit.push(l);
    }
    lit.sort((a, b) => a - b);
    const median = lit[lit.length >> 1];
    return { pixels: lit.length, median, ratio: contrast(median, gl) };
}

/** Classic dark's tile, re-drawn on Dark's ground and line. `groundIn` is the colour put in for the ground (the calibration moves it). */
function recolourTile(classic, groundIn) {
    const g = brandGrounds('dark').doodle, n = brandGrounds('night').doodle;
    const cg = hexToRgb(g.ground), cl = hexToRgb(g.line), ng = hexToRgb(n.ground), nl = hexToRgb(n.line);
    const yg = luminance(...cg), yl = luminance(...cl);
    const snapBelow = ((yg + 0.05) * SNAP_CONTRAST - 0.05 - yg) / (yl - yg); // s of a pixel SNAP_CONTRAST lighter than the ground
    const out = Buffer.alloc(classic.data.length);
    for (let i = 0; i < classic.data.length; i += 3) {
        const y = luminance(classic.data[i], classic.data[i + 1], classic.data[i + 2]);
        const s = (y - yg) / (yl - yg);
        if (s < snapBelow) { out[i] = groundIn[0]; out[i + 1] = groundIn[1]; out[i + 2] = groundIn[2]; continue; }
        for (let c = 0; c < 3; c++) out[i + c] = toByte(LIN[ng[c]] + s * (LIN[nl[c]] - LIN[ng[c]]));
    }
    return out;
}

/** The highest quality (steps of five) whose file fits `maxBytes`, with the ground calibrated to within GROUND_TOLERANCE of `target`. */
async function encodeTile(classic, target, maxBytes) {
    for (let quality = 95; quality >= 40; quality -= 5) {
        let groundIn = [...target];
        for (let round = 0; round < 8; round++) {
            const raw = recolourTile(classic, groundIn);
            const file = await sharp(raw, { raw: { width: classic.width, height: classic.height, channels: 3 } })
                .webp({ quality, effort: 6, smartSubsample: false }).toBuffer();
            const decoded = await sharp(file).removeAlpha().raw().toBuffer();
            const got = mostCommonColour(decoded);
            const miss = target.map((v, c) => v - got[c]);
            if (miss.every((d) => Math.abs(d) <= GROUND_TOLERANCE)) {
                if (file.length <= maxBytes) return { file, quality, decoded };
                break; // too big at this quality: a lower one
            }
            groundIn = groundIn.map((v, c) => Math.max(0, Math.min(255, v + miss[c])));
        }
    }
    throw new Error(`no encoding of a ${classic.width}px tile reached a ground within ${GROUND_TOLERANCE} level of ${rgbToHex(target)} inside ${maxBytes} bytes`);
}

/** Dark's banner: Classic's vines in charcoal (see the header of this file). */
async function bakeBanner() {
    const src = await decode(path.join(ROOT, BANNER.from));
    const web = brandGrounds('night').web;
    const gaps = hexToRgb(web.banner).map((v) => v / HEADER_WASH);       // the file's gaps: twice what the header shows
    const peak = hexToRgb(VINE_PEAK).map((v) => v / HEADER_WASH);        // and its brightest line
    if (![...gaps, ...peak].every(Number.isInteger)) throw new Error('web.banner and VINE_PEAK must halve cleanly under the wash');
    // Brightness of every pixel (the sRGB bytes' own luma, so the glow keeps the gradation the eye sees).
    const luma = new Float64Array(src.width * src.height);
    for (let p = 0; p < luma.length; p++) luma[p] = 0.2126 * src.data[p * 3] + 0.7152 * src.data[p * 3 + 1] + 0.0722 * src.data[p * 3 + 2];
    // The strip of vines is the middle band (about rows 250 to 390); its gaps are the floor, its glow the ceiling.
    const band = [];
    for (let y = Math.round(src.height * 0.42); y < Math.round(src.height * 0.58); y++) for (let x = Math.round(src.width * 0.1); x < Math.round(src.width * 0.9); x++) band.push(luma[y * src.width + x]);
    band.sort((a, b) => a - b);
    const floor = band[Math.floor(band.length * 0.1)], ceil = band[Math.floor(band.length * 0.995)];
    const out = Buffer.alloc(src.data.length);
    for (let p = 0; p < luma.length; p++) {
        const t = Math.max(0, Math.min(1, (luma[p] - floor) / (ceil - floor)));
        for (let c = 0; c < 3; c++) out[p * 3 + c] = Math.round(gaps[c] + t * (peak[c] - gaps[c]));
    }
    for (let quality = 90; quality >= 40; quality -= 5) {
        const file = await sharp(out, { raw: { width: src.width, height: src.height, channels: 3 } })
            .jpeg({ quality, mozjpeg: true, chromaSubsampling: '4:2:0' }).toBuffer();
        if (file.length <= BANNER_MAX_BYTES) return { file, quality, floor, ceil };
    }
    throw new Error('no JPEG quality fits the banner within the size of Classic\'s');
}

async function main() {
    const outIdx = process.argv.indexOf('--out');
    const outDir = outIdx > 0 ? path.resolve(process.argv[outIdx + 1]) : null;
    const dest = (rel) => path.join(outDir ?? ROOT, rel);
    const write = (rel, buf) => { fs.mkdirSync(path.dirname(dest(rel)), { recursive: true }); fs.writeFileSync(dest(rel), buf); };

    const target = hexToRgb(brandGrounds('night').doodle.ground);
    for (const t of TILES) {
        const classic = await decode(path.join(ROOT, t.from));
        if (classic.width !== t.size || classic.height !== t.size) throw new Error(`${t.from} is ${classic.width}x${classic.height}, expected ${t.size}`);
        const limit = fs.statSync(path.join(ROOT, t.from)).size;
        const { file, quality, decoded } = await encodeTile(classic, target, limit);
        for (const rel of t.to) write(rel, file);
        const before = lineLift(classic.data, hexToRgb(brandGrounds('dark').doodle.ground));
        const after = lineLift(decoded, target);
        console.log(`${t.to[0]}: ${file.length} bytes (Classic's ${limit}), quality ${quality}, ground ${rgbToHex(mostCommonColour(decoded))}, ` +
            `line lift ${after.ratio.toFixed(3)}:1 (Classic dark ${before.ratio.toFixed(3)}:1), line pixels ${after.pixels} (Classic ${before.pixels})`);
    }
    const banner = await bakeBanner();
    write(BANNER.to, banner.file);
    console.log(`${BANNER.to}: ${banner.file.length} bytes (Classic's ${BANNER_MAX_BYTES}), quality ${banner.quality}, brightness ${banner.floor.toFixed(1)} to ${banner.ceil.toFixed(1)} mapped onto charcoal`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
