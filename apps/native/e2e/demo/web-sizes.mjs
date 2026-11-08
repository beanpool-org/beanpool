/**
 * The website's phone pictures (DESIGN-app-screenshots-fable.md §5, lane L2): the five shots beanpool.org shows (Home, Market,
 * Listing, Deal chat, Ledger), light and dark, at 360 and 720 px wide, WebP at quality 80: 5 x 2 x 2 = 20 files, under 1 MB all
 * together, named exactly as the website's markup asks for them (`phone-<name>-<scheme>-<width>.webp`, shots.mjs).
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
export const WEB_BUDGET_BYTES = 1_000_000;

/** One raw PNG as WebP at `width` px wide (the height follows the raw's shape; a 1080 x 1920 raw gives 360 x 640 and 720 x 1280). */
export async function webp(png, width) {
    const sharp = (await import('sharp')).default;
    return sharp(png).resize({ width, kernel: 'lanczos3' }).webp({ quality: WEBP_QUALITY, effort: 6 }).toBuffer();
}

/** Write the twenty files; answers [{ file, width, height, bytes }]. */
export async function makeWebSizes(inDir, outDir) {
    const sharp = (await import('sharp')).default;
    fs.mkdirSync(outDir, { recursive: true });
    const made = [];
    for (const shot of SHOTS.filter((s) => s.web)) {
        for (const scheme of SCHEMES) {
            const png = fs.readFileSync(path.join(inDir, rawName(shot, scheme)));
            for (const width of WEB_WIDTHS) {
                const buf = await webp(png, width);
                const file = path.join(outDir, webName(shot, scheme, width));
                fs.writeFileSync(file, buf);
                const meta = await sharp(buf).metadata();
                made.push({ file, width: meta.width, height: meta.height, bytes: buf.length });
            }
        }
    }
    return made;
}

async function main() {
    const arg = (name) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : undefined; };
    const inDir = arg('--in');
    const outDir = arg('--out');
    if (!inDir || !outDir) throw new Error('usage: node web-sizes.mjs --in <raw folder> --out <folder>');
    const made = await makeWebSizes(inDir, outDir);
    for (const m of made) console.log(`${path.basename(m.file)}  ${m.width}x${m.height}  ${Math.round(m.bytes / 1024)} KB`);
    const total = made.reduce((n, m) => n + m.bytes, 0);
    console.log(`${made.length} files, ${Math.round(total / 1024)} KB in all (budget ${Math.round(WEB_BUDGET_BYTES / 1024)} KB)`);
    if (made.length !== 20) throw new Error(`expected 20 files, made ${made.length}`);
    if (total >= WEB_BUDGET_BYTES) throw new Error(`the twenty files weigh ${total} bytes: over the 1 MB budget`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
    main().catch((e) => { console.error('❌', e.message); process.exit(1); });
}
