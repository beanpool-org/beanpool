/* global process, console, document, getComputedStyle, innerWidth, matchMedia, requestAnimationFrame, setTimeout, URL */
/**
 * One set of "?", Invite and Settings at every width (Marty, 9 Nov 2026: the side bar's bottom-left had them beside the
 * profile pill AND a pill at the top right drew them again; "when it reactive resizes to mobile phone size it should go up
 * the top right like the phone app does").
 *
 * App's real header row and side bar (e2e/header-alerts-harness.tsx: MobileHeader and SidebarStatus, as App.tsx draws them)
 * in headless Chromium at 375 and 1280 px, light and dark, plus 767 / 768 / 1024 / 1920, and one window resized 1280 -> 375
 * -> 1280 -> 767 -> 768. Fails (exit 1) at any step on: not exactly one visible "?" (the pill's or the side bar's);
 * the pill drawn at 768 px and up or missing under it; the side bar's Settings not on screen from 768 px; the pill's or the
 * side bar's controls under 44 px; the pill off the screen; sideways scroll. Crops (<= 900 px wide) of the header row and,
 * from 768 px, the side bar's footer.
 *
 * Run from apps/pwa: node e2e/web-controls-once-shots.mjs   (WEB_CONTROLS_SHOTS_DIR=<dir>: where the crops and results.json
 * go; default e2e/screenshots/web-controls-once, gitignored). Nothing here talks to a node: every request off this machine
 * is aborted, and so is every /api request.
 */
import { createServer } from 'vite';
import { chromium } from 'playwright';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';

const PWA_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
process.chdir(PWA_DIR);
const SHOTS_DIR = process.env.WEB_CONTROLS_SHOTS_DIR || path.join(PWA_DIR, 'e2e', 'screenshots', 'web-controls-once');
fs.mkdirSync(SHOTS_DIR, { recursive: true });

const WIDTHS = [375, 767, 768, 1024, 1280, 1920];
const THEMES = ['light', 'dark'];

const server = await createServer({ configFile: path.join(PWA_DIR, 'vite.config.ts'), root: PWA_DIR, server: { port: 0 }, logLevel: 'error' });
await server.listen();
const origin = `http://localhost:${server.httpServer.address().port}`;
const browser = await chromium.launch();

/** In the page: which controls are on screen now, and whether they fit. */
const measure = () => {
    const r = (e) => e.getBoundingClientRect();
    const shown = (e) => !!e && e.getClientRects().length > 0 && getComputedStyle(e).visibility !== 'hidden';
    const problems = [];
    const wide = matchMedia('(min-width: 768px)').matches;
    const pill = document.querySelector('[data-testid="header-pill"]');
    const sideHelp = document.querySelector('[data-testid="sidebar-help"]');
    const sideSettings = document.querySelector('[data-testid="sidebar-settings"]');
    const pillHelp = document.querySelector('[data-testid="header-help"]');
    const visibleHelps = [pillHelp, sideHelp].filter(shown).length;
    const visibleSettings = [document.querySelector('[data-testid="header-settings"]'), sideSettings].filter(shown).length;
    if (visibleHelps !== 1) problems.push(`${visibleHelps} visible "?" (the pill's: ${shown(pillHelp)}, the side bar's: ${shown(sideHelp)})`);
    if (visibleSettings !== 1) problems.push(`${visibleSettings} visible Settings`);
    if (wide) {
        if (pill) problems.push('the pill is drawn beside the side bar');
        if (!shown(sideSettings)) problems.push('the side bar\'s Settings is not on screen');
    } else {
        if (!pill || !shown(pill)) problems.push('no pill under 768 px');
        if (shown(sideSettings)) problems.push('the side bar\'s Settings shows under 768 px');
    }
    const buttons = [...(pill ? pill.querySelectorAll('button') : []), ...(wide ? [...document.querySelectorAll('aside [data-testid^="sidebar-"]')].filter((b) => b.tagName === 'BUTTON' && /help|invite|settings/.test(b.dataset.testid)) : [])];
    for (const b of buttons) {
        const br = r(b);
        if (br.height < 43.5) problems.push(`${b.dataset.testid} ${Math.round(br.height)} px tall`);
        if (wide && br.width < 43.5) problems.push(`${b.dataset.testid} ${Math.round(br.width)} px wide`);
        if (br.right > innerWidth + 0.5) problems.push(`${b.dataset.testid} off the screen`);
    }
    if (document.documentElement.scrollWidth > innerWidth) problems.push(`sideways scroll ${document.documentElement.scrollWidth}`);
    return { wide, pill: !!pill, visibleHelps, visibleSettings, problems };
};
const settle = (page) => page.evaluate(() => new Promise((res) => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(res, 50)))));

const results = [];
let failures = 0;
const note = (key, m) => {
    results.push({ key, ...m });
    if (m.problems.length) { failures++; console.log('FAIL', key, m.problems.join('; ')); }
};
const newPage = async (width, theme) => {
    const ctx = await browser.newContext({ viewport: { width, height: 560 }, colorScheme: theme, reducedMotion: 'reduce' });
    await ctx.route('**/*', (route) => {
        const u = new URL(route.request().url());
        return u.hostname === 'localhost' && !u.pathname.startsWith('/api/') ? route.continue() : route.abort();
    });
    const page = await ctx.newPage();
    await page.goto(`${origin}/e2e/header-alerts-harness.html?chip=plain${theme === 'dark' ? '&dark=1' : ''}`, { waitUntil: 'load' });
    await page.waitForFunction(() => !!window.harness);
    await page.addStyleTag({ content: '*, *::before, *::after { transition: none !important; }' });
    await page.evaluate(() => document.fonts.ready);
    await page.evaluate(() => window.harness.set({ tab: 'home', needs: 0, settings: false }));
    await settle(page);
    return { ctx, page };
};
const crops = async (page, width, key) => {
    const hb = await page.locator('header').boundingBox();
    await page.screenshot({ path: path.join(SHOTS_DIR, `header-${key}.png`), clip: { x: Math.max(0, width - 900), y: 0, width: Math.min(width, 900), height: Math.ceil(hb.y + hb.height + 6) } });
    if (width >= 768) {
        const fb = await page.locator('aside > div').last().boundingBox();
        await page.screenshot({ path: path.join(SHOTS_DIR, `sidebar-${key}.png`), clip: { x: 0, y: Math.max(0, Math.floor(fb.y - 8)), width: Math.ceil(fb.width + 8), height: Math.ceil(fb.height + 16) } });
    }
};

for (const theme of THEMES) {
    for (const width of WIDTHS) {
        const { ctx, page } = await newPage(width, theme);
        const key = `${width}-${theme}`;
        note(key, await page.evaluate(measure));
        await crops(page, width, key);
        await ctx.close();
    }
    // One window, resized across the line and back, as a tester does: the set moves, never two, never none.
    const { ctx, page } = await newPage(1280, theme);
    for (const width of [1280, 375, 1280, 767, 768, 320, 1920]) {
        await page.setViewportSize({ width, height: 560 });
        await settle(page);
        const key = `resize-${theme}-to-${width}`;
        note(key, await page.evaluate(measure));
        await crops(page, width, key);
    }
    await ctx.close();
}
fs.writeFileSync(path.join(SHOTS_DIR, 'results.json'), JSON.stringify(results, null, 1));
await browser.close();
await server.close();
console.log(`${results.length} steps measured, ${failures} with a problem. Crops and results.json in ${SHOTS_DIR}`);
process.exit(failures ? 1 : 0);
