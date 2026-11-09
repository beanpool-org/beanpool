/* global process, console */
/**
 * The website's phone pictures (DESIGN-app-screenshots-fable.md §5, lane L2): the five shots beanpool.org shows (Home, Market,
 * Listing, Deal chat, Ledger), light and dark, at 360 and 720 px wide, WebP: 5 x 2 x 2 = 20 files, under 1 MB all together,
 * named exactly as the website's markup asks for them (`phone-<name>-<scheme>-<width>.webp`, shots.mjs).
 *
 * Quality starts at 80 (the design's) and steps down by 2 only while the twenty files together are over the 1 MB budget (the
 * Market's photographs and the app's doodle background do not compress well): the same quality for every file, the highest that
 * fits, and the one used is printed.
 *
 * They are written to --out and NOT into apps/website: the website lane copies them in. The pictures are the raw captures,
 * untouched but for the size: no caption, no frame (the page draws its own figure and caption).
 *
 *   node apps/native/e2e/demo/web-sizes.mjs --in <raw folder> --out <folder>
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SHOTS, SCHEMES, WEB_WIDTHS, rawName, webName } from './shots.mjs';

export const WEBP_QUALITY = 80;
export const MIN_QUALITY = 60;
export const WEB_BUDGET_BYTES = 1_000_000;

/** One raw PNG as WebP at `width` px wide (the height follows the raw's shape; a 1080 x 1920 raw gives 360 x 640 and 720 x 1280). */
export async function webp(png, width, quality = WEBP_QUALITY, effort = 6) {
    const sharp = (await import('sharp')).default;
    return sharp(png).resize({ width, kernel: 'lanczos3' }).webp({ quality, effort }).toBuffer();
}

/** Make the twenty files in memory at the highest quality (80 down to MIN_QUALITY) that keeps them under the budget. */
export async function makeWebSizes(inDir, budget = WEB_BUDGET_BYTES, effort = 6) {
    const raws = [];
    for (const shot of SHOTS.filter((s) => s.web)) {
        for (const scheme of SCHEMES) {
            const png = fs.readFileSync(path.join(inDir, rawName(shot, scheme)));
            for (const width of WEB_WIDTHS) raws.push({ name: webName(shot, scheme, width), png, width });
        }
    }
    for (let quality = WEBP_QUALITY; ; quality -= 2) {
        const files = [];
        for (const r of raws) files.push({ name: r.name, buf: await webp(r.png, r.width, quality, effort) });
        const total = files.reduce((n, f) => n + f.buf.length, 0);
        if (total < budget || quality <= MIN_QUALITY) return { files, total, quality, withinBudget: total < budget };
    }
}

async function main() {
    const arg = (name) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : undefined; };
    const inDir = arg('--in');
    const outDir = arg('--out');
    if (!inDir || !outDir) throw new Error('usage: node web-sizes.mjs --in <raw folder> --out <folder>');
    const sharp = (await import('sharp')).default;
    const { files, total, quality, withinBudget } = await makeWebSizes(inDir);
    fs.mkdirSync(outDir, { recursive: true });
    for (const f of files) {
        fs.writeFileSync(path.join(outDir, f.name), f.buf);
        const meta = await sharp(f.buf).metadata();
        console.log(`${f.name}  ${meta.width}x${meta.height}  ${Math.round(f.buf.length / 1024)} KB`);
    }
    console.log(`${files.length} files, ${total} bytes (${(total / 1_000_000).toFixed(2)} MB) in all, WebP quality ${quality} (budget ${WEB_BUDGET_BYTES} bytes)`);
    if (files.length !== 20) throw new Error(`expected 20 files, made ${files.length}`);
    if (!withinBudget) throw new Error(`the twenty files still weigh ${total} bytes at quality ${quality}: over the 1 MB budget`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
    main().catch((e) => { console.error('❌', e.message); process.exit(1); });
}
