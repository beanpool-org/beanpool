/**
 * Builds the link-preview image apps/website/og-image.png (1200 x 630): the bean, "BeanPool" and the home page's own tagline
 * (the words after the dash in apps/website/index.html's <title>) on the site's light-theme colours.
 *
 * The page is drawn by headless Chromium with the website's own self-hosted Outfit and Inter (apps/website/fonts), then squeezed
 * to a palette PNG with sharp. Both come from the repo's dependencies; Chromium is the one playwright already uses.
 *
 *   node scripts/website-og-image.mjs
 *
 * Colours are the light-theme tokens in apps/website/style.css (--bg-primary, --text-heading, --text-secondary, --logo-gradient-*).
 * Never touches bean.png: it is only read.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WEBSITE_DIR = path.join(REPO_ROOT, 'apps', 'website');
export const OG_IMAGE_FILE = path.join(WEBSITE_DIR, 'og-image.png');
export const OG_IMAGE_SIZE = Object.freeze({ width: 1200, height: 630 });

const escapeText = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** The home page's tagline: its <title> after the dash. */
export function readTagline(indexHtml = fs.readFileSync(path.join(WEBSITE_DIR, 'index.html'), 'utf8')) {
    const title = indexHtml.match(/<title>([^<]*)<\/title>/i)?.[1] ?? '';
    const tagline = title.split('—').slice(1).join('—').trim();
    if (!tagline) throw new Error('apps/website/index.html <title> has no tagline after the dash');
    return tagline;
}

/** A light-theme token from style.css's `@media (prefers-color-scheme: light)` block. */
function lightToken(css, name) {
    const light = css.slice(css.indexOf('prefers-color-scheme: light'));
    const m = light.match(new RegExp(`${name}:\\s*(#[0-9a-fA-F]{3,8})`));
    if (!m) throw new Error(`light-theme token ${name} not found in apps/website/style.css`);
    return m[1];
}

export function ogImageHtml() {
    const css = fs.readFileSync(path.join(WEBSITE_DIR, 'style.css'), 'utf8');
    const tokens = Object.fromEntries(
        ['--bg-primary', '--text-heading', '--text-secondary', '--logo-gradient-start', '--logo-gradient-end'].map((n) => [n, lightToken(css, n)])
    );
    const tagline = readTagline();
    // "Exchange for Communities, Not Commercial Banks": the home page's headline picks "Communities" out in the gradient
    const taglineHtml = escapeText(tagline).replace('Communities', '<span class="g">Communities</span>');
    const fontsCss = pathToFileURL(path.join(WEBSITE_DIR, 'fonts', 'fonts.css')).href;
    const beanUrl = pathToFileURL(path.join(WEBSITE_DIR, 'bean.png')).href;
    return `<!DOCTYPE html>
<html><head><meta charset="UTF-8"><link rel="stylesheet" href="${fontsCss}"><style>
html, body { margin: 0; width: ${OG_IMAGE_SIZE.width}px; height: ${OG_IMAGE_SIZE.height}px; background: ${tokens['--bg-primary']}; }
body { display: flex; align-items: center; padding: 0 80px; box-sizing: border-box; font-family: 'Inter', sans-serif; }
img { width: 330px; height: 330px; flex: none; margin-right: 70px; }
h1 { margin: 0 0 22px; font: 800 150px/1 'Outfit', sans-serif; color: ${tokens['--text-heading']}; }
p { margin: 0; font: 600 54px/1.2 'Outfit', sans-serif; color: ${tokens['--text-secondary']}; }
.g { background: linear-gradient(135deg, ${tokens['--logo-gradient-start']}, ${tokens['--logo-gradient-end']}); -webkit-background-clip: text; background-clip: text; color: transparent; }
</style></head><body><img src="${beanUrl}" alt=""><div><h1>BeanPool</h1><p>${taglineHtml}</p></div></body></html>`;
}

export async function buildOgImage(outFile = OG_IMAGE_FILE) {
    const { chromium } = await import('playwright');
    const sharp = (await import('sharp')).default;
    const tmp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'og-image-')), 'og.html');
    fs.writeFileSync(tmp, ogImageHtml(), 'utf8');
    const browser = await chromium.launch();
    try {
        const page = await browser.newPage({ viewport: OG_IMAGE_SIZE, deviceScaleFactor: 1 });
        await page.goto(pathToFileURL(tmp).href);
        await page.evaluate(() => document.fonts.ready);
        const shot = await page.screenshot({ type: 'png' });
        const png = await sharp(shot).png({ palette: true, colours: 128, effort: 10, dither: 0.5 }).toBuffer();
        fs.writeFileSync(outFile, png);
        return png.length;
    } finally {
        await browser.close();
        fs.rmSync(path.dirname(tmp), { recursive: true, force: true });
    }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
    const bytes = await buildOgImage();
    console.log(`✓ Wrote apps/website/og-image.png (${Math.round(bytes / 1024)} KB).`);
}
