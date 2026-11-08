#!/usr/bin/env node
/**
 * Join names N1 shots and checks: every join screen says which community, at 320 px with 1.3x text, light and dark, in English
 * and Spanish, against the stubs in join-names-harness.tsx (no node is contacted). Each shot is at most 900 px tall.
 *
 *   node apps/pwa/e2e/join-names-shots.mjs [<out dir>]     (default: scratch/screenshots/join-names-n1)
 *
 * Fails (exit 1) when, for any screen × theme × language:
 *   - the heading is not the words expected (the global community's, "Join {name}", "Join {name} with an invite");
 *   - the `?ask=` line is missing at ours with ?ask=, or is there without it (the harness opens both);
 *   - anything is wider than the 320 px page, or the heading is cut (its content wider than its box) or clipped by a parent;
 *   - the heading's ink against its background is under 4.5:1 (WCAG AA body text), light or dark.
 */
import { createServer } from 'vite';
import { chromium } from 'playwright';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';

const PWA_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
process.chdir(PWA_DIR);
const OUT = path.resolve(process.argv[2] || path.join(PWA_DIR, '../..', 'scratch', 'screenshots', 'join-names-n1'));
fs.mkdirSync(OUT, { recursive: true });

const server = await createServer({ configFile: path.join(PWA_DIR, 'vite.config.ts'), root: PWA_DIR, server: { port: 0, host: '127.0.0.1' }, logLevel: 'error' });
await server.listen();
const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
const browser = await chromium.launch();
const TEXT_SCALE = 1.3;
const NAME = 'Riverbend Neighbours’ Seed & Tool Library';
let failures = 0;
const fail = (msg) => { console.error(`✗ ${msg}`); failures++; };

// What each screen must say, by language. Spanish is the catalog's own draft (apps/pwa/words/es.json).
const SAYS = {
    en: {
        ours: 'Join the global community',
        named: `Join ${NAME}`,
        invite: `Join ${NAME} with an invite`,
        ask: 'This is the global community, not Byron Shire BeanPool. Join here first, then find Byron Shire BeanPool under Find a community.',
    },
    es: {
        ours: 'Únete a la comunidad global',
        named: `Unirse a ${NAME}`,
        invite: `Unirse a ${NAME} con una invitación`,
        ask: 'Esta es la comunidad global, no Byron Shire BeanPool. Únete aquí primero y luego busca Byron Shire BeanPool en «Buscar una comunidad».',
    },
};

const CASES = [
    { id: 'lobby-ours', query: 'view=lobby&kind=ours', heading: '[data-testid="lobby-join-card"] h2', says: 'ours', card: 'lobby-join-card', noAsk: true },
    { id: 'lobby-ours-ask', query: 'view=lobby&kind=ours&ask=byron.beanpool.org', heading: '[data-testid="lobby-join-card"] h2', says: 'ours', card: 'lobby-join-card', ask: true },
    { id: 'lobby-hall', query: 'view=lobby&kind=hall', heading: '[data-testid="lobby-join-card"] h2', says: 'named', card: 'lobby-join-card', noAsk: true },
    { id: 'lobby-local', query: 'view=lobby&kind=local', heading: '[data-testid="lobby-join-card"] h2', says: 'named', card: 'lobby-join-card', noAsk: true },
    { id: 'join-ours', query: 'view=welcome&kind=ours', heading: '[data-testid="join-screen-lobby"] h3', says: 'ours', card: 'join-screen-lobby' },
    { id: 'join-hall', query: 'view=welcome&kind=hall', heading: '[data-testid="join-screen-lobby"] h3', says: 'named', card: 'join-screen-lobby' },
    { id: 'invite-local', query: 'view=welcome&kind=local', heading: '[data-testid="welcome-invite-heading"]', says: 'invite', card: 'community-card' },
];

/** Contrast of an element's text colour against what is painted behind it (alpha layers composited from the root down). */
const contrastOf = (page, selector) => page.evaluate((sel) => {
    const parse = (c) => { const m = c.match(/rgba?\(([^)]+)\)/); if (!m) return null; const p = m[1].split(/[ ,/]+/).filter(Boolean).map(Number); return { r: p[0], g: p[1], b: p[2], a: p[3] === undefined ? 1 : p[3] }; };
    const over = (top, bottom) => { const a = top.a + bottom.a * (1 - top.a); return a === 0 ? { r: 0, g: 0, b: 0, a: 0 } : { r: (top.r * top.a + bottom.r * bottom.a * (1 - top.a)) / a, g: (top.g * top.a + bottom.g * bottom.a * (1 - top.a)) / a, b: (top.b * top.a + bottom.b * bottom.a * (1 - top.a)) / a, a }; };
    const lum = ({ r, g, b }) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); };
    const el = document.querySelector(sel);
    const chain = [];
    for (let e = el; e; e = e.parentElement) chain.unshift(e);
    let bg = { r: 255, g: 255, b: 255, a: 1 };
    for (const e of chain) { const c = parse(getComputedStyle(e).backgroundColor); if (c && c.a > 0) bg = over(c, bg); }
    const fg = over(parse(getComputedStyle(el).color), bg);
    const [hi, lo] = [lum(fg), lum(bg)].sort((x, y) => y - x);
    return (hi + 0.05) / (lo + 0.05);
}, selector);

async function run(c, theme, lang) {
    const ctx = await browser.newContext({ viewport: { width: 320, height: 900 }, colorScheme: theme, deviceScaleFactor: 1 });
    const page = await ctx.newPage();
    await page.goto(`${origin}/e2e/join-names-harness.html?${c.query}&lang=${lang}${theme === 'dark' ? '&dark=1' : ''}`, { waitUntil: 'networkidle' });
    await page.addStyleTag({ content: `html { font-size: ${TEXT_SCALE * 100}% !important; } *, *::before, *::after { transition: none !important; animation: none !important; }` });
    await page.evaluate(() => document.fonts.ready);
    const want = SAYS[lang][c.says];
    const selector = c.heading;
    const label = `${c.id} ${theme} ${lang}`;
    const heading = page.locator(selector).first();
    try {
        await heading.waitFor({ timeout: 8000 });
        // The name arrives from the card a moment after the page: wait for the words, not a fixed time.
        await page.waitForFunction(([sel, text]) => (document.querySelector(sel)?.textContent || '').trim() === text, [selector, want], { timeout: 5000 }).catch(() => {});
    } catch { fail(`${label}: no heading at ${selector}`); await ctx.close(); return; }
    const got = ((await heading.textContent()) || '').trim();
    if (got !== want) fail(`${label}: heading says "${got}", expected "${want}"`);
    if (/Join BeanPool|Unirme a BeanPool/.test(await page.locator('body').innerText())) fail(`${label}: the old "Join BeanPool" heading is still on the page`);

    const askLine = page.getByTestId('lobby-asked-elsewhere');
    if (c.ask) {
        await askLine.waitFor({ timeout: 5000 }).catch(() => {});
        await page.waitForFunction((text) => (document.querySelector('[data-testid="lobby-asked-elsewhere"]')?.textContent || '').trim() === text, SAYS[lang].ask, { timeout: 5000 }).catch(() => {});
        const line = ((await askLine.textContent().catch(() => '')) || '').trim();
        if (line !== SAYS[lang].ask) fail(`${label}: the ?ask= line says "${line}", expected "${SAYS[lang].ask}"`);
        const first = await page.evaluate((id) => document.querySelector(`[data-testid="${id}"]`)?.firstElementChild?.getAttribute('data-testid'), c.card);
        if (first !== 'lobby-asked-elsewhere') fail(`${label}: the ?ask= line is not the first thing in the Join card`);
    } else if (c.noAsk && (await askLine.count())) {
        fail(`${label}: the ?ask= line is there without ?ask=`);
    }

    const box = await heading.evaluate((el) => {
        const r = el.getBoundingClientRect();
        let clipped = false;
        for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
            const o = getComputedStyle(p).overflow;
            if (o !== 'visible') { const pr = p.getBoundingClientRect(); if (r.left < pr.left - 1 || r.right > pr.right + 1) clipped = true; }
        }
        return { left: r.left, right: r.right, cut: el.scrollWidth > el.clientWidth + 1, clipped, lines: Math.round(r.height / parseFloat(getComputedStyle(el).lineHeight || '0') || 0) };
    });
    if (box.right > 320.5 || box.left < -0.5) fail(`${label}: the heading runs outside the 320 px page (${Math.round(box.left)}–${Math.round(box.right)})`);
    if (box.cut) fail(`${label}: the heading is cut (its words are wider than its box)`);
    if (box.clipped) fail(`${label}: a parent clips the heading`);
    const wide = await page.evaluate(() => document.documentElement.scrollWidth);
    if (wide > 320) fail(`${label}: the page is ${wide} px wide at 320`);
    const ratio = await contrastOf(page, selector);
    if (ratio < 4.5) fail(`${label}: the heading's ink is ${ratio.toFixed(2)}:1 against its background (needs 4.5:1)`);

    const target = page.getByTestId(c.card).first();
    const tb = await target.boundingBox();
    // The shot holds the card and the heading both (the invite form's heading sits under the community's card).
    const hb = await heading.boundingBox();
    const top = Math.min(tb.y, hb.y);
    const bottom = Math.max(tb.y + tb.height, hb.y + hb.height);
    const clip = { x: 0, y: Math.max(0, top - 8), width: 320, height: Math.min(900, bottom - top + 16) };
    const out = path.join(OUT, `join-names-${c.id}-${lang}-320-x1.3-${theme}.png`);
    await page.screenshot({ path: out, clip, fullPage: true });
    console.log(`✓ ${label}: "${got}"${box.lines > 1 ? ` (${box.lines} lines)` : ''}, ${ratio.toFixed(1)}:1 → ${path.basename(out)} (${clip.width}×${Math.round(clip.height)})`);
    await ctx.close();
}

for (const theme of ['light', 'dark']) {
    for (const lang of ['en', 'es']) {
        for (const c of CASES) await run(c, theme, lang);
    }
}

await browser.close();
await server.close();
if (failures) { console.error(`join-names-shots: ${failures} problem(s)`); process.exit(1); }
console.log(`join-names-shots: ok — ${CASES.length} screens × light and dark × English and Spanish at 320 px, 1.3× text`);
