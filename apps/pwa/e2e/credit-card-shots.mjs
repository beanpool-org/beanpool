/**
 * The Ledger's credit card (slice R1, DESIGN-credit-bar-amend-fable.md §11) in a real Chromium layout: the harness
 * (e2e/credit-card-harness.tsx) draws nine members' cards with the app's own code. At 320 px with 1.3x text and at 1280 px,
 * in Light, Classic and Dark, in English, the pseudo-locale (every sentence about 40 % longer) and Tamil, it photographs
 * each page and CHECKS what jsdom can't:
 *   1. nothing runs off sideways: no card's content is wider than the card, and the page does not scroll sideways;
 *   2. the label on the dot stays inside its card;
 *   3. the card (one button) is a 44 px target or more.
 * It prints a table (markdown) and exits non-zero on any failed check. Nothing here touches a BeanPool node.
 *
 *   node e2e/credit-card-shots.mjs [shots-dir]
 *
 * Run from apps/pwa: Tailwind reads its config from the working directory. Needs @beanpool/core built.
 */
/* global process, console, document, localStorage, window */
import { createServer } from 'vite';
import { chromium } from 'playwright';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';

const PWA_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
process.chdir(PWA_DIR);
const OUT_DIR = process.argv[2] ? path.resolve(process.argv[2]) : path.join(PWA_DIR, 'e2e', 'shots');
const LOOKS = ['light', 'dark', 'night'];
const SIZES = [{ name: '320', w: 320, h: 900, scale: 1.3 }, { name: '1280', w: 1280, h: 900, scale: 1 }];
const LANGS = ['en', 'xx', 'ta'];

const server = await createServer({ configFile: path.join(PWA_DIR, 'vite.config.ts'), root: PWA_DIR, server: { port: 0 }, logLevel: 'error' });
await server.listen();
const base = `http://localhost:${server.httpServer.address().port}`;
fs.mkdirSync(OUT_DIR, { recursive: true });
const browser = await chromium.launch();
const failures = [];
const rows = [];

try {
    for (const look of LOOKS) {
        for (const size of SIZES) {
            for (const lang of LANGS) {
                if (lang === 'ta' && size.name !== '320') continue;
                const context = await browser.newContext({ viewport: { width: size.w, height: size.h } });
                await context.route('**/*', (route) => {
                    const url = route.request().url();
                    if (url.includes('/api/') || url.startsWith('ws')) return route.abort();
                    return route.continue();
                });
                await context.addInitScript((l) => { try { localStorage.setItem('beanpool-theme-mode', l); } catch { /* none */ } }, look);
                const page = await context.newPage();
                await page.goto(`${base}/e2e/credit-card-harness.html?lang=${lang}`);
                await page.waitForSelector('[data-ready="1"]', { timeout: 30000 });
                await page.evaluate((scale) => { document.documentElement.style.fontSize = `${scale * 100}%`; }, size.scale);
                await page.waitForTimeout(150);
                const result = await page.evaluate(() => {
                    const out = { wide: [], label: [], small: [], pageScroll: document.documentElement.scrollWidth > window.innerWidth + 1 };
                    for (const card of Array.from(document.querySelectorAll('[data-fixture]'))) {
                        const id = card.getAttribute('data-fixture');
                        const box = card.getBoundingClientRect();
                        for (const el of Array.from(card.querySelectorAll('*'))) {
                            const r = el.getBoundingClientRect();
                            if (r.width === 0) continue;
                            if (r.right > box.right + 0.5 || r.left < box.left - 0.5) { out.wide.push(`${id}: ${el.getAttribute('data-testid') ?? el.tagName.toLowerCase()} ${Math.round(r.left - box.left)}..${Math.round(r.right - box.left)} of ${Math.round(box.width)}`); break; }
                        }
                        const label = card.querySelector('[data-testid="credit-label"]').getBoundingClientRect();
                        const button = card.querySelector('[data-testid="credit-card"]').getBoundingClientRect();
                        if (label.left < button.left - 0.5 || label.right > button.right + 0.5) out.label.push(id);
                        if (button.height < 44) out.small.push(id);
                    }
                    out.height = Math.round(document.querySelector('[data-fixture="owing-vouched"]').getBoundingClientRect().height);
                    return out;
                });
                const file = path.join(OUT_DIR, `credit-card-${look}-${size.name}-${lang}.png`);
                await page.screenshot({ path: file, fullPage: true });
                const name = `${look} ${size.name}${size.scale !== 1 ? ` ×${size.scale}` : ''} ${lang}`;
                if (result.pageScroll) failures.push(`${name}: the page scrolls sideways`);
                for (const w of result.wide) failures.push(`${name}: runs off its card: ${w}`);
                for (const l of result.label) failures.push(`${name}: the label leaves its card: ${l}`);
                for (const s of result.small) failures.push(`${name}: the card is under 44 px: ${s}`);
                rows.push(`| ${name} | ${result.height} px | ${result.wide.length + result.label.length + result.small.length + (result.pageScroll ? 1 : 0) === 0 ? 'ok' : 'FAIL'} | ${path.basename(file)} |`);
                await context.close();
            }
        }
    }
} finally {
    await browser.close();
    await server.close();
}

console.log('| look, width, language | Marty\'s card height | checks | shot |\n|---|---|---|---|');
for (const r of rows) console.log(r);
if (failures.length) {
    console.error(`\n${failures.length} failed check(s):`);
    for (const f of failures) console.error(`  ✗ ${f}`);
    process.exit(1);
}
console.log('\nall checks pass');
