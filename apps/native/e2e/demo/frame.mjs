/* global process, console, document, getComputedStyle -- Node, and the page's side of evaluate() */
/**
 * The caption band for the store pictures (DESIGN-app-screenshots-fable.md §4, lane L2): a raw phone capture under one short
 * line on the brand's ground, with rounded corners and a one-pixel edge, and no bezel. Nothing about the phone is drawn.
 *
 *   Ground     light: the web app's page, the oat `--bg-primary` (core WEB_INK_GROUNDS.light); dark: the website's dark
 *              `--bg-primary`, #030712 (apps/website/style.css), which the Ledger shot sits on.
 *   Caption    Outfit 700 at 56 px on a 1080 px wide picture (scaled by width for a wider one), centred, one line; a line too long
 *              for the width is shrunk until it fits, never wrapped.
 *   Shot       below the caption, 36 px corners (scaled the same way), a 1 px edge in `chip.accent.border`.
 *   Colours    read at run time from packages/beanpool-core/dist/brand-colours.js (so the core must be built); only the dark
 *              ground, which the brand colours do not hold, is written here.
 *   Output     24-bit PNG, no alpha: 1080 x 1920 (Google Play) or 1320 x 2868 (App Store). The same raw picture can be framed
 *              for either; a raw of another shape is fitted by width and the caption band takes what height is left.
 *
 * Deterministic: the same raw picture, caption and scheme give the same bytes (one page, no clock, no animation, the fonts
 * are the website's own files). The page is drawn by the Chromium Playwright already carries, then squeezed by sharp, as
 * scripts/website-og-image.mjs does.
 *
 *   node apps/native/e2e/demo/frame.mjs --in <raw folder> --out <folder> [--store play|appstore]
 *
 * It frames the store set (shots.mjs: six light, the Ledger dark) from `<n>-<id>-<scheme>.png` files in --in into
 * `<out>/<store>/<NN>-<id>.png`.
 *
 * One --in folder holds ONE phone's captures, so one go makes one store's set: `--store` is `play` unless it says otherwise, and
 * the App Store set is framed only from raws of its own size (the iPhone's, `capture.mjs --ios`): Apple rejects pictures that show
 * another platform's interface (App Review Guideline 2.3.10), and an Android capture under an App Store caption band is that.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { SHOTS, rawName, storeName } from './shots.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '../../../..');
const FONTS_CSS = path.join(REPO, 'apps/website/fonts/fonts.css');
const BRAND_COLOURS = path.join(REPO, 'packages/beanpool-core/dist/brand-colours.js');

export const STORE_SIZES = Object.freeze({
    play: Object.freeze({ width: 1080, height: 1920 }),
    appstore: Object.freeze({ width: 1320, height: 2868 }),
});

/** The website's dark `--bg-primary` (apps/website/style.css): the brand colours hold the app's grounds, not the website's. */
export const DARK_GROUND = '#030712';

// The design's numbers are for a 1080 px wide picture; a wider one scales them by width.
const BASE_WIDTH = 1080;
const CAPTION_PX = 56;
const RADIUS_PX = 36;
const SIDE_MARGIN = 0.07; // of the width, each side
const MIN_CAPTION_PX = 36;

/** The grounds and inks of both schemes, read from the built core. */
export async function readBrand(file = BRAND_COLOURS) {
    if (!fs.existsSync(file)) throw new Error(`${path.relative(REPO, file)} is missing: build the core first (pnpm --filter @beanpool/core build)`);
    const brand = await import(pathToFileURL(file).href);
    const light = brand.brandColours('light');
    const dark = brand.brandColours('dark');
    // WEB_INK_GROUNDS.light is [card, page, sunken]: the page is the oat.
    const oat = brand.WEB_INK_GROUNDS.light[1];
    return {
        light: { ground: oat, caption: light.gold.on, edge: light.chip.accent.border },
        dark: { ground: DARK_GROUND, caption: dark.cta.on, edge: dark.chip.accent.border },
    };
}

/** Where everything sits on a `store` picture for a raw picture of `shot` pixels: all whole pixels. */
export function frameLayout(store, shot) {
    const size = STORE_SIZES[store];
    if (!size) throw new Error(`no store size "${store}" (play, appstore)`);
    const scale = size.width / BASE_WIDTH;
    const margin = Math.round(size.width * SIDE_MARGIN);
    const bottom = Math.round(size.width * 0.037);
    const minBand = Math.round(size.height * 0.1);
    let shotW = size.width - 2 * margin;
    let shotH = Math.round((shotW * shot.height) / shot.width);
    // A raw picture taller than the page allows: narrower, so the caption band keeps its height.
    if (size.height - bottom - shotH < minBand) {
        shotH = size.height - bottom - minBand;
        shotW = Math.round((shotH * shot.width) / shot.height);
    }
    const band = size.height - bottom - shotH;
    return {
        size,
        scale,
        shotW,
        shotH,
        shotX: Math.round((size.width - shotW) / 2),
        shotY: band,
        band,
        captionPx: Math.round(CAPTION_PX * scale),
        minCaptionPx: Math.round(MIN_CAPTION_PX * scale),
        radius: Math.round(RADIUS_PX * scale),
        availableCaptionW: size.width - 2 * margin,
    };
}

const escapeText = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** The page for one picture. `shotUrl` is a data: or file: URL of the raw capture. */
export function frameHtml({ caption, scheme, shotUrl, layout, brand }) {
    const c = brand[scheme];
    if (!c) throw new Error(`no scheme "${scheme}" (light, dark)`);
    const L = layout;
    return `<!DOCTYPE html>
<html><head><meta charset="UTF-8"><link rel="stylesheet" href="${pathToFileURL(FONTS_CSS).href}"><style>
html, body { margin: 0; width: ${L.size.width}px; height: ${L.size.height}px; overflow: hidden; background: ${c.ground}; }
.band { position: absolute; left: 0; top: 0; width: ${L.size.width}px; height: ${L.band}px; display: flex; align-items: center; justify-content: center; }
.caption { margin: 0; padding: 0; white-space: nowrap; text-align: center; color: ${c.caption};
    font: 700 ${L.captionPx}px/1.15 'Outfit', sans-serif; letter-spacing: -0.005em; }
.shot { position: absolute; left: ${L.shotX}px; top: ${L.shotY}px; width: ${L.shotW}px; height: ${L.shotH}px; box-sizing: border-box;
    border-radius: ${L.radius}px; border: 1px solid ${c.edge}; overflow: hidden; background: ${c.ground}; }
.shot img { display: block; width: 100%; height: 100%; }
</style></head><body>
<div class="band"><p class="caption" id="caption">${escapeText(caption)}</p></div>
<div class="shot"><img src="${shotUrl}" alt=""></div>
</body></html>`;
}

export const pngSize = (buf) => ({ width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) });

/** The store a go is for: `play` when `--store` is not given. One folder of raws serves one store, so there is no "both". */
export function storeFor(which = 'play') {
    if (which === 'both') throw new Error('--store both is gone: one --in folder holds one phone\'s pictures (Android for play, the iPhone\'s for appstore), so frame each store from its own folder');
    if (!STORE_SIZES[which]) throw new Error(`no store "${which}" (play, appstore)`);
    return which;
}

/** The App Store set is framed only from raws of its own size (the iPhone captures); a Play set from any shape (fitted by width). */
export function checkRaw(store, size, name) {
    if (store !== 'appstore') return;
    const want = STORE_SIZES.appstore;
    if (size.width !== want.width || size.height !== want.height) {
        throw new Error(`${name} is ${size.width}x${size.height}, not ${want.width}x${want.height}: the App Store set is framed from the iPhone captures (capture.mjs --ios), never from Android ones (App Review Guideline 2.3.10)`);
    }
}

/**
 * Frame raw pictures. `jobs`: [{ shot: Buffer (PNG), caption, scheme, store }]. Answers one Buffer each (24-bit PNG, no alpha),
 * and `fitted` (the caption's final size in px) so a shrunk caption is seen rather than silent.
 */
export async function frameShots(jobs, { brand } = {}) {
    const [{ chromium }, sharp] = await Promise.all([import('playwright'), import('sharp').then((m) => m.default)]);
    const colours = brand ?? (await readBrand());
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'store-frame-'));
    const browser = await chromium.launch();
    try {
        const out = [];
        for (const job of jobs) {
            const layout = frameLayout(job.store, pngSize(job.shot));
            const html = frameHtml({ caption: job.caption, scheme: job.scheme, shotUrl: `data:image/png;base64,${job.shot.toString('base64')}`, layout, brand: colours });
            const file = path.join(dir, 'frame.html');
            fs.writeFileSync(file, html, 'utf8');
            const page = await browser.newPage({ viewport: layout.size, deviceScaleFactor: 1 });
            try {
                await page.goto(pathToFileURL(file).href);
                await page.evaluate(() => document.fonts.ready);
                // One line, however long: shrink in whole pixels until it fits the width.
                const fitted = await page.evaluate(({ avail, min }) => {
                    const el = document.getElementById('caption');
                    let px = parseFloat(getComputedStyle(el).fontSize);
                    while (el.scrollWidth > avail && px > min) { px -= 1; el.style.fontSize = `${px}px`; }
                    return px;
                }, { avail: layout.availableCaptionW, min: layout.minCaptionPx });
                const raw = await page.screenshot({ type: 'png' });
                const png = await sharp(raw).flatten({ background: colours[job.scheme].ground }).removeAlpha().toColourspace('srgb')
                    .png({ compressionLevel: 9, palette: false }).toBuffer();
                out.push({ png, fitted, captionPx: layout.captionPx, layout });
            } finally {
                await page.close();
            }
        }
        return out;
    } finally {
        await browser.close();
        fs.rmSync(dir, { recursive: true, force: true });
    }
}

async function main() {
    const arg = (name) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : undefined; };
    const inDir = arg('--in');
    const outDir = arg('--out');
    if (!inDir || !outDir) throw new Error('usage: node frame.mjs --in <raw folder> --out <folder> [--store play|appstore]  (play unless it says otherwise)');
    const store = storeFor(arg('--store'));
    // Every raw is read and checked before any is framed, so a wrong folder leaves nothing half written.
    const jobs = SHOTS.map((s) => {
        const name = rawName(s, s.store);
        const shot = fs.readFileSync(path.join(inDir, name));
        checkRaw(store, pngSize(shot), name);
        return { shot, caption: s.caption, scheme: s.store, store, id: s };
    });
    const done = await frameShots(jobs);
    fs.mkdirSync(path.join(outDir, store), { recursive: true });
    done.forEach((d, i) => {
        const file = path.join(outDir, store, storeName(jobs[i].id));
        fs.writeFileSync(file, d.png);
        const note = d.fitted < d.captionPx ? ` (caption shrunk ${d.captionPx} -> ${d.fitted} px to stay on one line)` : '';
        console.log(`${store}/${path.basename(file)}  ${d.layout.size.width}x${d.layout.size.height}  ${Math.round(d.png.length / 1024)} KB${note}`);
    });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
    main().catch((e) => { console.error('❌', e.message); process.exit(1); });
}
