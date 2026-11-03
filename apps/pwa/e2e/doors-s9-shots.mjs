#!/usr/bin/env node
/* global process, console, document, getComputedStyle */
/**
 * Front doors S9 at 320 px with text at 130%, light and dark: Settings → Use the phone app → Put your account on your
 * phone, in each state (the code; the code on a phone's browser, with Open the BeanPool app; the digits; wrong digits;
 * the phone has it but has not saved it; done, with Remove from this browser, once the phone saved it; the phone did
 * not save it; no word from it; burned; a browser without the 12 words). The relay is stubbed in the harness
 * (doors-s9-shots-harness.tsx) and every request off the page is aborted.
 *
 * Fails on: the page scrolling sideways, text past the 320 edge, a button under 44 px, text under 4.5:1 contrast.
 *
 *   node apps/pwa/e2e/doors-s9-shots.mjs [--shots <dir>]
 */
import { createServer } from 'vite';
import { chromium } from 'playwright';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';

const PWA_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
process.chdir(PWA_DIR);
const shotsAt = process.argv.indexOf('--shots');
const SHOTS = shotsAt > 0 ? path.resolve(process.argv[shotsAt + 1]) : null;
const WIDTH = 320;

const server = await createServer({ configFile: path.join(PWA_DIR, 'vite.config.ts'), root: PWA_DIR, server: { port: 0 }, logLevel: 'error' });
await server.listen();
const origin = `http://localhost:${server.httpServer.address().port}`;
const browser = await chromium.launch();
const problems = [];

const STATES = [
    ['code', 'Put your account on your phone, the code', async (page) => page.getByRole('img', { name: /QR code/ }).waitFor()],
    ['phone', 'the code on a phone\'s browser', async (page) => page.getByRole('link', { name: 'Open the BeanPool app' }).waitFor()],
    ['digits', 'the digits', async (page) => page.getByLabel('Type the four digits your phone shows').waitFor()],
    ['wrong', 'wrong digits', async (page) => {
        await page.getByLabel('Type the four digits your phone shows').fill('1111');
        await page.getByRole('button', { name: 'Confirm' }).click();
        await page.getByText('Those are not the digits on the phone.', { exact: false }).waitFor();
    }],
    ['received', 'the phone has it, not saved yet: no Remove', async (page) => page.getByText('Your phone has received your account.', { exact: false }).waitFor()],
    ['done', 'the phone saved it: Remove from this browser offered', async (page) => page.getByRole('button', { name: 'Remove from this browser' }).waitFor()],
    ['notsaved', 'the phone did not save it', async (page) => page.getByText("Your phone didn't save your account", { exact: false }).waitFor()],
    ['unheard', 'no word from the phone', async (page) => page.getByText("Your phone hasn't said it saved your account", { exact: false }).waitFor()],
    ['burned', 'three wrong tries', async (page) => page.getByText('typed wrong three times', { exact: false }).waitFor()],
    ['nowords', 'a browser without the 12 words', async (page) => page.getByText("doesn't hold your 12 recovery words", { exact: false }).waitFor()],
];

try {
    for (const theme of ['light', 'dark']) {
        for (const [state, label, ready] of STATES) {
            const phone = state === 'phone';
            const ctx = await browser.newContext({ viewport: { width: WIDTH, height: 900 }, colorScheme: theme, deviceScaleFactor: 2, hasTouch: phone, isMobile: phone });
            await ctx.route('**/*', (route) => (route.request().url().startsWith(origin) ? route.continue() : route.abort()));
            const page = await ctx.newPage();
            const errors = [];
            page.on('pageerror', (e) => errors.push(String(e)));
            await page.goto(`${origin}/e2e/doors-s9-shots-harness.html?state=${state}${theme === 'dark' ? '&dark=1' : ''}`, { waitUntil: 'networkidle' });
            await page.addStyleTag({ content: 'html { font-size: 130% !important; } *, *::before, *::after { transition: none !important; }' });
            await page.getByTestId('settings-use-phone-app').click();
            await page.getByTestId('bring-to-phone-open').click();
            await ready(page);
            await page.waitForTimeout(200);
            const found = await page.evaluate((W) => {
                const out = [];
                const rgb = (s) => { const m = /rgba?\(([^)]+)\)/.exec(s); if (!m) return null; const p = m[1].split(',').map(parseFloat); return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 }; };
                const lum = ({ r, g, b }) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); };
                const over = (t, u) => ({ r: t.r * t.a + u.r * (1 - t.a), g: t.g * t.a + u.g * (1 - t.a), b: t.b * t.a + u.b * (1 - t.a), a: 1 });
                const backdrop = (el) => {
                    const layers = [];
                    for (let e = el; e; e = e.parentElement) { const c = rgb(getComputedStyle(e).backgroundColor); if (c && c.a > 0) { layers.push(c); if (c.a >= 0.999) break; } }
                    let base = { r: 255, g: 255, b: 255, a: 1 };
                    for (const l of layers.reverse()) base = over(l, base);
                    return base;
                };
                if (document.scrollingElement.scrollWidth > W) out.push(`the page scrolls sideways (${document.scrollingElement.scrollWidth}px)`);
                const panel = document.querySelector('[data-testid="bring-to-phone"]');
                if (!panel) { out.push('no panel'); return out; }
                for (const el of panel.querySelectorAll('*')) {
                    if (![...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim())) continue;
                    const r = el.getBoundingClientRect();
                    if (r.width === 0) continue;
                    const what = el.textContent.trim().slice(0, 48);
                    if (r.right > W + 0.5) out.push(`"${what}" runs past the edge`);
                    const cs = getComputedStyle(el);
                    const fg = rgb(cs.color);
                    if (!fg) continue;
                    const bg = backdrop(el);
                    const [a, b] = [lum(over(fg, bg)), lum(bg)].sort((x, y) => y - x);
                    const ratio = (a + 0.05) / (b + 0.05);
                    const size = parseFloat(cs.fontSize);
                    if (ratio < (size >= 24 || (size >= 18.66 && Number(cs.fontWeight) >= 700) ? 3 : 4.5)) out.push(`"${what}" has contrast ${ratio.toFixed(2)}:1`);
                }
                for (const el of panel.querySelectorAll('button, input')) {
                    const r = el.getBoundingClientRect();
                    if (r.width > 0 && r.height < 43.5) out.push(`"${el.textContent.trim().slice(0, 30) || el.id}" is ${Math.round(r.height)}px tall`);
                }
                // The QR code whole inside its white box and the page: one cut at the edge may not scan.
                for (const svg of panel.querySelectorAll('svg')) {
                    const r = svg.getBoundingClientRect();
                    const box = svg.parentElement.getBoundingClientRect();
                    if (r.right > box.right + 0.5 || r.left < box.left - 0.5 || r.right > W + 0.5) out.push(`the QR code runs past its box (${Math.round(r.left)}–${Math.round(r.right)} in ${Math.round(box.left)}–${Math.round(box.right)})`);
                    if (r.width < 150) out.push(`the QR code is only ${Math.round(r.width)}px wide`);
                }
                return out;
            }, WIDTH);
            for (const e of errors) found.push(`page error: ${e}`);
            for (const p of found) problems.push(`${theme} · ${label}: ${p}`);
            console.log(`${found.length ? '✗' : '✓'} ${theme} · ${label}${found.length ? `: ${found.join('; ')}` : ''}`);
            if (SHOTS) {
                fs.mkdirSync(SHOTS, { recursive: true });
                await page.locator('[data-testid="bring-to-phone"]').screenshot({ path: path.join(SHOTS, `s9-${state}-320-x1.3-${theme}.png`) });
            }
            await ctx.close();
        }
    }
} finally {
    await browser.close();
    await server.close();
}
console.log(problems.length ? `\n✗ ${problems.length} problem(s)` : '\n✓ every state holds at 320 px with text at 130%, light and dark');
process.exit(problems.length ? 1 : 0);
