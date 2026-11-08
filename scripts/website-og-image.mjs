/**
 * Builds the link-preview image apps/website/og-image.jpg (1200 x 630) in the website's dark look (Marty, 8 Nov 2026: "use our
 * fonts, dark mode, our background doodle and the BeanPool text"): the doodle tile on its dark ground, the bean and the
 * orange-gradient "BeanPool" from the header, the hero's badge, and the home page's headline with "Communities" in the
 * hero's rainbow. The headline is the home page's own <title> after the dash; the badge is index.html's own .hero-badge text.
 *
 * The page is drawn by headless Chromium with the website's own self-hosted Outfit and Inter (apps/website/fonts), then squeezed
 * to a JPEG with sharp (a palette PNG bands the rainbow and greys the bean). Both come from the repo's dependencies; Chromium is the one playwright already uses.
 *
 *   node scripts/website-og-image.mjs
 *
 * Colours are the dark-theme (default :root) tokens in apps/website/style.css. Never touches bean.png: it is only read.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WEBSITE_DIR = path.join(REPO_ROOT, 'apps', 'website');
export const OG_IMAGE_FILE = path.join(WEBSITE_DIR, 'og-image.jpg');
export const OG_IMAGE_SIZE = Object.freeze({ width: 1200, height: 630 });

const escapeText = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** The home page's tagline: its <title> after the dash. */
export function readTagline(indexHtml = fs.readFileSync(path.join(WEBSITE_DIR, 'index.html'), 'utf8')) {
    const title = indexHtml.match(/<title>([^<]*)<\/title>/i)?.[1] ?? '';
    const tagline = title.split('—').slice(1).join('—').trim();
    if (!tagline) throw new Error('apps/website/index.html <title> has no tagline after the dash');
    return tagline;
}

/** The hero badge's words ("Free on phone and web"), from index.html. */
export function readBadge(indexHtml = fs.readFileSync(path.join(WEBSITE_DIR, 'index.html'), 'utf8')) {
    const badge = indexHtml.match(/class="hero-badge"[^>]*>([^<]*)</)?.[1]?.trim();
    if (!badge) throw new Error('apps/website/index.html has no .hero-badge');
    return badge;
}

/** A dark-theme token: the first definition in style.css, the default :root block before the light-theme media query. */
function darkToken(css, name) {
    const dark = css.slice(0, css.indexOf('prefers-color-scheme: light'));
    const m = dark.match(new RegExp(`${name}:\\s*(#[0-9a-fA-F]{3,8})`));
    if (!m) throw new Error(`dark-theme token ${name} not found in apps/website/style.css`);
    return m[1];
}

export function ogImageHtml() {
    const css = fs.readFileSync(path.join(WEBSITE_DIR, 'style.css'), 'utf8');
    const names = ['--pattern-bg', '--text-heading', '--accent-ink', '--logo-gradient-start', '--logo-gradient-end',
        '--rainbow-1', '--rainbow-2', '--rainbow-3', '--rainbow-4', '--rainbow-5', '--rainbow-6'];
    const t = Object.fromEntries(names.map((n) => [n, darkToken(css, n)]));
    // "Exchange for Communities, Not Commercial Banks": broken after the comma and "Communities" in the rainbow, as the hero shows it
    const headline = escapeText(readTagline())
        .replace('Communities', '<span class="rainbow">Communities</span>')
        .replace(/,\s*/, ',<br>');
    const url = (f) => pathToFileURL(path.join(WEBSITE_DIR, f)).href;
    return `<!DOCTYPE html>
<html><head><meta charset="UTF-8"><link rel="stylesheet" href="${url('fonts/fonts.css')}"><style>
html, body { margin: 0; width: ${OG_IMAGE_SIZE.width}px; height: ${OG_IMAGE_SIZE.height}px; overflow: hidden; }
body {
    background-color: ${t['--pattern-bg']};
    background-image: radial-gradient(ellipse 62% 58% at 50% 56%, rgba(3, 7, 18, 0.78) 0%, rgba(3, 7, 18, 0.35) 70%, rgba(3, 7, 18, 0.15) 100%),
        url('${url('assets/pattern-dark-2x.webp')}');
    background-size: auto, 890px 890px;
    font-family: 'Inter', sans-serif; color: ${t['--text-heading']}; box-sizing: border-box; position: relative;
}
.brand { position: absolute; top: 44px; left: 56px; display: flex; align-items: center; gap: 16px;
    font: 800 52px/1 'Outfit', sans-serif; }
.brand img { width: 84px; height: 84px; }
.brand span, .rainbow { -webkit-background-clip: text; background-clip: text; -webkit-text-fill-color: transparent; }
.brand span { background-image: linear-gradient(135deg, ${t['--logo-gradient-start']}, ${t['--logo-gradient-end']}); }
.main { position: absolute; left: 0; right: 0; top: 168px; text-align: center; }
.badge { display: inline-block; padding: 9px 26px; border-radius: 999px; background: rgba(245, 158, 11, 0.10);
    border: 2px solid rgba(245, 158, 11, 0.32); color: ${t['--accent-ink']}; font: 600 24px/1.2 'Inter', sans-serif;
    letter-spacing: 0.06em; text-transform: uppercase; margin-bottom: 26px; }
h1 { margin: 0; font: 900 86px/1.06 'Outfit', sans-serif; letter-spacing: -0.03em; }
.site { position: absolute; left: 0; right: 0; bottom: 40px; text-align: center; font: 600 26px/1 'Inter', sans-serif; color: #b4bfcc; letter-spacing: 0.02em; }
.rainbow { background-image: linear-gradient(135deg, ${t['--rainbow-1']}, ${t['--rainbow-2']}, ${t['--rainbow-3']}, ${t['--rainbow-4']}, ${t['--rainbow-5']}, ${t['--rainbow-6']}); }
</style></head><body>
<div class="brand"><img src="${url('bean.png')}" alt=""><span>BeanPool</span></div>
<div class="main"><div class="badge">${escapeText(readBadge())}</div><h1>${headline}</h1></div>
<div class="site">beanpool.org</div>
</body></html>`;
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
        const jpg = await sharp(shot).jpeg({ quality: 82, mozjpeg: true, chromaSubsampling: '4:4:4' }).toBuffer();
        fs.writeFileSync(outFile, jpg);
        return jpg.length;
    } finally {
        await browser.close();
        fs.rmSync(path.dirname(tmp), { recursive: true, force: true });
    }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
    const bytes = await buildOgImage();
    console.log(`✓ Wrote apps/website/og-image.jpg (${Math.round(bytes / 1024)} KB).`);
}
