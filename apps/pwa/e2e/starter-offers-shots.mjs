/* eslint-disable no-undef */
// (cold start O2) "What could you offer?" on the web, in a real browser: node apps/pwa/e2e/starter-offers-shots.mjs [--out <dir>]
//
// The real HomePage (e2e/starter-offers-harness.tsx), every /api call answered here, nothing leaves the machine. First steps'
// "Post your first Offer" opens the dialog; it is checked at 320 px wide with text at 1.3x and at 1280 px, light and dark:
// the three rows (what the member starred, or labour, tools and the garden), the prices from the community's guide, the
// last row, no sideways scroll, every control at least 44 px, text contrast, Escape and Cancel, focus back on the step.
// A row opens the composer with its draft (the harness records what App's composer would be given); "Something else" asks for
// the blank one. A guide that cannot be read leaves the prices off; where Beans are off there is no price column at all.
import { createServer } from 'vite';
import { chromium } from 'playwright';
import { DEFAULT_PRICING_CATALOG } from '@beanpool/core';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';

const PWA_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
process.chdir(PWA_DIR);
const argAt = (flag) => { const i = process.argv.indexOf(flag); return i > 0 ? process.argv[i + 1] : null; };
const OUT_DIR = path.resolve(argAt('--out') ?? path.join(PWA_DIR, 'e2e', 'screenshots', 'starter-offers'));
fs.mkdirSync(OUT_DIR, { recursive: true });
setTimeout(() => { console.error('\nStopped after 240 s, not finished.'); process.exit(2); }, 240_000).unref();

const failures = [];
const check = (ok, what) => { if (ok) console.log(`  ok ${what}`); else { failures.push(what); console.error(`  x ${what}`); } };

const NOW = Date.now();
const answer = ({ interests, beans }) => ({
    generatedAt: new Date(NOW).toISOString(), profile: beans ? 'local' : 'global',
    features: { beans, escrow: beans, enterprises: beans, invites: beans, decisions: beans, guestListingsOnly: false },
    me: { joinedAt: new Date(NOW - 3 * 86_400_000).toISOString(), isKeeper: false, probation: null, interests, area: null, firstOffer: false, standing: 'member', tour: { v: 1, state: 'skipped', at: '2026-10-01T00:00:00.000Z' } },
    layout: { v: 2, cards: [{ id: 'steps', type: 'steps' }, { id: 'market', type: 'market' }], dismissed: {}, updatedAt: null },
    cards: {
        steps: { joinedAt: new Date(NOW - 3 * 86_400_000).toISOString(), firstOffer: false, firstPost: false, photo: false, interests: interests.length > 0, invited: false, area: false, knocked: null },
        market: { items: [{ id: 'p0', type: 'offer', title: 'Pottery lessons', category: 'arts', credits: 10, photoUrl: null }], total14d: 1, more: false },
        community: { name: 'Mullumbimby', members: 81, tradesThisMonth: 23 },
    },
});

const server = await createServer({ configFile: path.join(PWA_DIR, 'vite.config.ts'), root: PWA_DIR, server: { port: 0 }, logLevel: 'error' });
await server.listen();
const base = `http://localhost:${server.httpServer.address().port}/e2e/starter-offers-harness.html`;
const browser = await chromium.launch();

async function open({ width, dark, textScale, interests = [], beans = true, guide = true }) {
    const context = await browser.newContext({ viewport: { width, height: 900 }, colorScheme: dark ? 'dark' : 'light', reducedMotion: 'reduce' });
    await context.addInitScript(([mode]) => {
        try { localStorage.setItem('beanpool-theme-mode', mode); localStorage.setItem('beanpool-theme-default-light-v1', 'done'); } catch { /* the default theme is still a theme */ }
    }, [dark ? 'dark' : 'light']);
    await context.route('**/api/**', (route) => {
        const url = new URL(route.request().url());
        if (url.pathname === '/api/pricing-guide') {
            return guide
                ? route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ items: DEFAULT_PRICING_CATALOG }) }).catch(() => {})
                : route.fulfill({ status: 500, contentType: 'application/json', body: '{"error":"no guide"}' }).catch(() => {});
        }
        if (url.pathname !== '/api/home') return route.fulfill({ status: 404, contentType: 'application/json', body: '{"error":"Not Found"}' });
        return route.fulfill({ status: 200, contentType: 'application/json', headers: { ETag: 'W/"starter-1"' }, body: JSON.stringify(answer({ interests, beans })) }).catch(() => {});
    });
    await context.route('**/socket.io/**', (route) => route.abort());
    const page = await context.newPage();
    page.setDefaultTimeout(30_000);
    page.on('pageerror', (e) => failures.push(`page error: ${e}`));
    await page.goto(base, { waitUntil: 'load' });
    if (textScale !== 1) await page.addStyleTag({ content: `html { font-size: ${textScale * 100}% !important; }` });
    await page.waitForSelector('[data-testid="home-card-steps"]', { timeout: 60_000 });
    await settle(page);
    return { context, page };
}
const settle = (page) => page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(r, 200)))));
const openDialog = async (page) => {
    await page.getByRole('button', { name: 'To do: Post your first Offer' }).click();
    await page.getByTestId('home-starter-dialog').waitFor();
    // The guide is asked for as the dialog opens: its figures come in a moment later.
    await settle(page);
};
const rowTexts = (page) => page.evaluate(() => Array.from(document.querySelectorAll('[data-testid^="home-starter-"][aria-label]')).map((b) => b.getAttribute('aria-label')));

/** What cannot be seen from a label: the sideways scroll, anything past the window, a control under 44 px, text under 4.5:1. */
const measure = (page) => page.evaluate(() => {
    const out = [];
    const W = innerWidth;
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
    const box = document.querySelector('[data-testid="home-starter-dialog"]');
    if (!box) return ['no dialog'];
    const b = box.getBoundingClientRect();
    if (b.left < -0.5 || b.right > W + 0.5) out.push(`the dialog runs past the window (${Math.round(b.left)}–${Math.round(b.right)})`);
    if (box.scrollWidth > box.clientWidth + 1) out.push(`the dialog scrolls sideways (${box.scrollWidth} > ${box.clientWidth})`);
    for (const el of box.querySelectorAll('button')) {
        const r = el.getBoundingClientRect();
        if (r.height < 43.5) out.push(`the control "${el.textContent.trim().slice(0, 30)}" is ${Math.round(r.height)} px tall`);
    }
    for (const el of box.querySelectorAll('*')) {
        if (![...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim())) continue;
        const r = el.getBoundingClientRect();
        if (r.width === 0 || r.height === 0) continue;
        const what = el.textContent.trim().slice(0, 40);
        if (r.right > b.right + 0.5 || r.left < b.left - 0.5) out.push(`"${what}" runs past the dialog (${Math.round(r.left)}–${Math.round(r.right)})`);
        const cs = getComputedStyle(el);
        const fg = rgb(cs.color);
        if (!fg) continue;
        const bg = backdrop(el);
        const [a, c] = [lum(over(fg, bg)), lum(bg)].sort((x, y) => y - x);
        const ratio = (a + 0.05) / (c + 0.05);
        if (ratio < 4.5) out.push(`"${what}" has contrast ${ratio.toFixed(2)}:1 (${cs.color} on rgb(${Math.round(bg.r)},${Math.round(bg.g)},${Math.round(bg.b)}))`);
    }
    return out;
});

const WITH_FIGURES = [
    'An hour of help, 25 Beans an hour. Opens a new Offer with this filled in.',
    'Lend a tool, Free. Opens a new Offer with this filled in.',
    'Extra from the garden, 6 Beans. Opens a new Offer with this filled in.',
    'Something else. Opens a blank new Offer.',
];

try {
    for (const [width, textScale, size] of [[320, 1.3, '320'], [1280, 1, 'desktop']]) {
        for (const dark of [false, true]) {
            const theme = dark ? 'dark' : 'light';
            const label = `${size}-${theme}`;
            const { context, page } = await open({ width, dark, textScale });
            await page.getByTestId('home-card-steps').scrollIntoViewIfNeeded();
            await page.screenshot({ path: path.join(OUT_DIR, `home-steps-${label}.png`) });
            await openDialog(page);
            check(JSON.stringify(await rowTexts(page)) === JSON.stringify(WITH_FIGURES), `${label}: the three starter rows, with the guide's figures, and Something else`);
            check((await page.getByTestId('home-starter-note').textContent()) === 'Pick one. Every word is yours to change before it posts.', `${label}: the note`);
            const found = await measure(page);
            check(found.length === 0, `${label}: nothing past the window or cut, every control 44 px, contrast 4.5:1${found.length ? ` (${found.join('; ')})` : ''}`);
            check(await page.evaluate(() => document.activeElement?.tagName === 'H2'), `${label}: focus moved into the dialog, on its heading`);
            await page.screenshot({ path: path.join(OUT_DIR, `dialog-${label}.png`) });
            // Escape closes it and focus goes back to the step that opened it.
            await page.keyboard.press('Escape');
            await page.getByTestId('home-starter-dialog').waitFor({ state: 'detached' });
            check(await page.evaluate(() => (document.activeElement?.getAttribute('aria-label') ?? '') === 'To do: Post your first Offer'), `${label}: Escape closes it, focus back on Post your first Offer`);
            check((await page.evaluate(() => window.__composer.length + window.__navigated.length)) === 0, `${label}: closing opened nothing`);
            // Cancel too.
            await openDialog(page);
            await page.getByTestId('home-starter-dialog-done').click();
            await page.getByTestId('home-starter-dialog').waitFor({ state: 'detached' });
            check((await page.evaluate(() => window.__composer.length + window.__navigated.length)) === 0, `${label}: Cancel opened nothing`);
            await context.close();
        }
    }

    // A row opens the composer with its draft; Something else asks for the blank one.
    {
        const { context, page } = await open({ width: 1280, dark: false, textScale: 1 });
        await openDialog(page);
        await page.getByTestId('home-starter-labour.1').click();
        await page.getByTestId('home-starter-dialog').waitFor({ state: 'detached' });
        const given = await page.evaluate(() => window.__composer);
        check(given.length === 1 && given[0].type === 'offer' && given[0].title === 'An hour of help' && given[0].category === 'labour'
            && given[0].credits === 25 && given[0].priceType === 'hourly' && given[0].description.startsWith('An extra pair of hands')
            && !given[0].photos, 'a row opens the composer with that Offer: title, words, category, 25 Beans an hour, no photo');
        await openDialog(page);
        await page.getByTestId('home-starter-other').click();
        check(JSON.stringify(await page.evaluate(() => window.__navigated)) === '["map-post"]', 'Something else asks for the blank composer');
        await context.close();
    }

    // What the member starred leads the rows.
    {
        const { context, page } = await open({ width: 320, dark: false, textScale: 1.3, interests: ['animals', 'transport'] });
        await openDialog(page);
        const rows = await rowTexts(page);
        check(rows.slice(0, 3).map((r) => r.split(',')[0].split('.')[0]).join('|') === 'Dog walking|A lift into town|Pet sitting', `starred Animals and Transport: ${rows.slice(0, 3).map((r) => r.split(',')[0].split('.')[0]).join(', ')}`);
        const found = await measure(page);
        check(found.length === 0, `320 starred: nothing past the window or cut${found.length ? ` (${found.join('; ')})` : ''}`);
        await page.screenshot({ path: path.join(OUT_DIR, 'dialog-320-light-starred.png') });
        await context.close();
    }

    // The guide cannot be read: no figures, and the paid drafts open with the price empty.
    {
        const { context, page } = await open({ width: 320, dark: false, textScale: 1.3, guide: false });
        await openDialog(page);
        check(JSON.stringify(await rowTexts(page)) === JSON.stringify([
            'An hour of help. Opens a new Offer with this filled in.',
            'Lend a tool, Free. Opens a new Offer with this filled in.',
            'Extra from the garden. Opens a new Offer with this filled in.',
            'Something else. Opens a blank new Offer.',
        ]), 'no guide: no figures on the paid rows');
        await page.getByTestId('home-starter-garden.1').click();
        const given = await page.evaluate(() => window.__composer);
        check(given.length === 1 && given[0].credits === null && given[0].priceType === 'fixed', 'no guide: the garden Offer opens with the price empty');
        await context.close();
    }

    // Beans off (the global community): no price column, every draft free.
    {
        const { context, page } = await open({ width: 320, dark: false, textScale: 1.3, beans: false });
        await page.getByRole('button', { name: /^To do: Post something free or for swap/ }).click();
        await page.getByTestId('home-starter-dialog').waitFor();
        await settle(page);
        check(JSON.stringify(await rowTexts(page)) === JSON.stringify([
            'An hour of help. Opens a new Offer with this filled in.',
            'Lend a tool. Opens a new Offer with this filled in.',
            'Extra from the garden. Opens a new Offer with this filled in.',
            'Something else. Opens a blank new Offer.',
        ]), 'Beans off: no prices');
        await page.getByTestId('home-starter-labour.1').click();
        const given = await page.evaluate(() => window.__composer);
        check(given.length === 1 && given[0].credits === 0 && given[0].priceType === 'fixed', 'Beans off: every draft opens free');
        await page.screenshot({ path: path.join(OUT_DIR, 'after-pick-320-global.png') });
        await context.close();
    }
} finally {
    await browser.close();
    await server.close();
}
if (failures.length) { console.error(`\n${failures.length} problem(s)`); process.exit(1); }
console.log(`\nShots in ${OUT_DIR}`);
