/**
 * A short week on the web (DESIGN-getting-paid-fable §3.2, slice L2), in a real Chromium layout: the real standing card and its
 * three sheets (e2e/short-week-harness.tsx), at 320 px wide with the text at 130 %, in Light, Classic and Dark. For each case it
 * opens what the member taps (the link, Answer, Another amount), photographs the whole page, and CHECKS what jsdom can't:
 *   1. nothing runs off sideways (the page is no wider than 320 px), and no button's words are cut;
 *   2. every button is a 44 px target or more, the quiet link 48 px;
 *   3. a refused ask keeps its sheet open with the node's words.
 * It prints a table (markdown) and exits non-zero on any failed check. Nothing here touches a BeanPool node.
 *
 *   node e2e/short-week-shots.mjs [shots-dir]
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
const VIEWPORT = { w: 320, h: 568 };
// The stored looks: Light ('light'), Classic ('dark', the olive dark) and Dark ('night').
const THEMES = [['light', 'light'], ['classic', 'dark'], ['dark', 'night']];
// [case, what to tap before the photo]
const CASES = [
    ['take-up', []],
    ['payer-card', []],
    ['payer-ask-sheet', ['standing-lower-link']],
    ['payer-ask-refused', ['standing-lower-link', 'standing-sheet-go']],
    ['payer-ask-open', []],
    ['payee-answer-sheet', ['standing-ask-answer']],
    ['payee-lower-sheet', ['standing-lower-link', 'standing-choice-other']],
    ['payee-grace-lower', []],
    ['payer-grace-ask-sheet', ['standing-lower-link']],
    ['payer-agreed', []],
    ['payee-zero-week', []],
];

const server = await createServer({ configFile: path.join(PWA_DIR, 'vite.config.ts'), root: PWA_DIR, server: { port: 0 }, logLevel: 'error' });
await server.listen();
const base = `http://localhost:${server.httpServer.address().port}`;
fs.mkdirSync(OUT_DIR, { recursive: true });
const browser = await chromium.launch();
const failures = [];
const check = (ok, what) => { if (!ok) { failures.push(what); console.error(`  ✗ ${what}`); } };
const rows = [];

try {
    for (const [themeName, stored] of THEMES) {
        const context = await browser.newContext({ viewport: { width: VIEWPORT.w, height: VIEWPORT.h }, colorScheme: themeName === 'light' ? 'light' : 'dark' });
        await context.route('**/*', (route) => {
            const url = route.request().url();
            if (url.includes('/api/') || url.startsWith('ws')) return route.abort();
            return route.continue();
        });
        const page = await context.newPage();
        await page.addInitScript(([th]) => { try { localStorage.setItem('beanpool-theme-mode', th); } catch { /* private mode */ } }, [stored]);
        for (const [name, taps] of CASES) {
            await page.goto(`${base}/e2e/short-week-harness.html?case=${name}`, { waitUntil: 'load' });
            await page.waitForSelector(name === 'take-up' ? '[data-testid="standing-take-up"]' : '[data-testid="standing-panel-tx-1"]', { timeout: 30_000 });
            await page.evaluate(() => { document.documentElement.style.fontSize = '130%'; });
            for (const id of taps) await page.click(`[data-testid="${id}"]`);
            if (name === 'payee-lower-sheet') await page.fill('[data-testid="standing-other-amount"]', '250');
            await page.waitForTimeout(150);
            const m = await page.evaluate(() => {
                const buttons = Array.from(document.querySelectorAll('button')).map(b => {
                    const r = b.getBoundingClientRect();
                    return { text: b.textContent, h: r.height, cut: b.scrollWidth > b.clientWidth + 1 || b.scrollHeight > b.clientHeight + 1, link: b.dataset.testid === 'standing-lower-link' };
                });
                return { width: document.documentElement.scrollWidth, buttons, refusal: document.querySelector('[data-testid="standing-sheet-refusal"]')?.textContent ?? null,
                    sheet: !!document.querySelector('[data-testid^="standing-sheet-"]'), dark: document.documentElement.classList.contains('dark') };
            });
            check(m.width <= VIEWPORT.w, `${themeName} ${name}: page is ${m.width} px wide`);
            for (const b of m.buttons) {
                check(b.h >= (b.link ? 48 : 44) - 0.5, `${themeName} ${name}: "${b.text}" is ${b.h.toFixed(1)} px tall`);
                check(!b.cut, `${themeName} ${name}: "${b.text}" is cut`);
            }
            if (name === 'payer-ask-refused') check(m.sheet && m.refusal === "You've asked about this week three times, which is the most.", `${themeName} ${name}: the refusal stays on the sheet`);
            check(m.dark === (themeName !== 'light'), `${themeName} ${name}: the look is ${m.dark ? 'dark' : 'light'}`);
            const file = `web-${name}-${themeName}.png`;
            await page.screenshot({ path: path.join(OUT_DIR, file), fullPage: true });
            rows.push(`| ${name} | ${themeName} | ${m.width} | ${m.buttons.length} | ${file} |`);
        }
        await context.close();
    }
} finally {
    await browser.close();
    await server.close();
}
console.log('| case | look | page px | buttons | shot |\n|---|---|---|---|---|');
console.log(rows.join('\n'));
console.log(failures.length ? `\n${failures.length} failed` : '\nall checks pass');
process.exit(failures.length ? 1 : 0);
