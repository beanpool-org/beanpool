/**
 * Your deals → Bills on the web (DESIGN-getting-paid-fable §4.2, §4.3, slice B2), in a real Chromium layout: the real panel and
 * the payer's sheet (e2e/bills-harness.tsx), at 320 px wide with the text at 130 %, in Light, Classic and Dark. For each case it
 * taps what the member taps, photographs the whole page, and CHECKS what jsdom can't:
 *   1. nothing runs off sideways (the page is no wider than 320 px), no button's words are cut, no amount is cut;
 *   2. every button is a 44 px target or more;
 *   3. a lost answer keeps the sheet open and says the bill may have been paid.
 * It prints a table (markdown) and exits non-zero on any failed check. Nothing here touches a BeanPool node.
 *
 *   node e2e/bills-shots.mjs [shots-dir]
 *
 * Run from apps/pwa: Tailwind reads its config from the working directory. Needs @beanpool/core built.
 */
/* global process, console, document, localStorage */
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
    ['to-pay-list', []],
    ['sheet-known', []],
    ['sheet-confirm', ['bill-pay']],
    ['sheet-stranger', []],
    ['sheet-lost', ['bill-pay', 'bill-confirm-pay']],
    ['sent-list', ['bills-side-sent']],
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
        const page = await context.newPage();
        page.on('pageerror', (e) => failures.push(`${themeName}: page error ${e}`));
        await page.addInitScript(([th]) => { try { localStorage.setItem('beanpool-theme-mode', th); } catch { /* private mode */ } }, [stored]);
        for (const [name, taps] of CASES) {
            await page.goto(`${base}/e2e/bills-harness.html?case=${name}`, { waitUntil: 'load' });
            await page.waitForSelector(name.startsWith('sheet') ? '[data-testid^="bill-sheet-"]' : '[data-testid="bills-panel"]', { timeout: 30_000 });
            await page.evaluate(() => { document.documentElement.style.fontSize = '130%'; });
            await page.waitForTimeout(150);
            for (const id of taps) { await page.click(`[data-testid="${id}"]`); await page.waitForTimeout(150); }
            const m = await page.evaluate(() => {
                const cut = (el) => el.scrollWidth > el.clientWidth + 1;
                const buttons = Array.from(document.querySelectorAll('button')).map(b => {
                    const r = b.getBoundingClientRect();
                    return { text: b.textContent, h: r.height, right: r.right, cut: cut(b) || b.scrollHeight > b.clientHeight + 1 };
                });
                const amount = document.querySelector('[data-testid="bill-amount"]');
                return {
                    width: document.documentElement.scrollWidth, buttons, amountCut: amount ? cut(amount) : false,
                    refusal: document.querySelector('[data-testid="bill-refusal"]')?.textContent ?? null,
                    sheet: !!document.querySelector('[data-testid^="bill-sheet-"]'), dark: document.documentElement.classList.contains('dark'),
                };
            });
            check(m.width <= VIEWPORT.w, `${themeName} ${name}: page is ${m.width} px wide`);
            check(!m.amountCut, `${themeName} ${name}: the amount is cut`);
            for (const b of m.buttons) {
                check(b.h >= 44 - 0.5, `${themeName} ${name}: "${b.text}" is ${b.h.toFixed(1)} px tall`);
                check(!b.cut, `${themeName} ${name}: "${b.text}" is cut`);
                check(b.right <= VIEWPORT.w + 0.5, `${themeName} ${name}: "${b.text}" runs past 320 px`);
            }
            if (name === 'sheet-lost') check(m.sheet && /may have been paid/.test(m.refusal ?? ''), `${themeName} ${name}: the lost answer stays on the sheet`);
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
