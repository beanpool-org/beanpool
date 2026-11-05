/* global process, console, document, window, requestAnimationFrame, setTimeout, URL */
import { createServer } from 'vite';
import { chromium } from 'playwright';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';

const PWA_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
process.chdir(PWA_DIR);
const SHOTS_DIR = path.join(PWA_DIR, 'e2e', 'screenshots', 'web-invite-button');
fs.mkdirSync(SHOTS_DIR, { recursive: true });

const server = await createServer({
    configFile: path.join(PWA_DIR, 'vite.config.ts'),
    root: PWA_DIR,
    server: { port: 0 },
    logLevel: 'error',
});
await server.listen();
const origin = `http://localhost:${server.httpServer.address().port}`;
const browser = await chromium.launch();

const cases = [
    { width: 320, text: 130, theme: 'light', tab: 'home', chip: 'plain' },
    { width: 320, text: 130, theme: 'dark', tab: 'home', chip: 'plain' },
    { width: 1280, text: 100, theme: 'light', tab: 'home', chip: 'plain' },
    { width: 1280, text: 100, theme: 'dark', tab: 'home', chip: 'plain' },
    { width: 1280, text: 100, theme: 'light', tab: 'home', chip: 'ago' },
    { width: 1280, text: 100, theme: 'dark', tab: 'home', chip: 'ago' },
    { width: 1280, text: 130, theme: 'light', tab: 'home', chip: 'ago' },
    { width: 1280, text: 130, theme: 'dark', tab: 'home', chip: 'ago' },
    { width: 1024, text: 100, theme: 'light', tab: 'home', chip: 'ago' },
    { width: 1024, text: 100, theme: 'dark', tab: 'home', chip: 'ago' },
];

const results = [];
let failures = 0;

for (const c of cases) {
    const ctx = await browser.newContext({
        viewport: { width: c.width, height: 600 },
        colorScheme: c.theme,
        reducedMotion: 'reduce',
    });
    await ctx.route('**/*', (route) => {
        const u = new URL(route.request().url());
        return u.hostname === 'localhost' && !u.pathname.startsWith('/api/') ? route.continue() : route.abort();
    });
    const page = await ctx.newPage();
    await page.goto(`${origin}/e2e/header-alerts-harness.html?chip=${c.chip || 'plain'}${c.theme === 'dark' ? '&dark=1' : ''}`, { waitUntil: 'load' });
    await page.waitForFunction(() => !!window.harness);
    await page.addStyleTag({
        content: `*, *::before, *::after { transition: none !important; }${c.text !== 100 ? ` html { font-size: ${c.text}% !important; }` : ''}`,
    });
    await page.evaluate(() => document.fonts.ready);
    await page.evaluate((s) => window.harness.set(s), { tab: c.tab, needs: 0, settings: false });
    await page.evaluate(() => new Promise((res) => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(res, 50)))));

    const measureData = await page.evaluate(() => {
        const r = (el) => el ? el.getBoundingClientRect() : null;
        const header = document.querySelector('header');
        const pill = document.querySelector('[data-testid="header-pill"]');
        const inviteBtn = document.querySelector('[data-testid="header-invite"]');
        const sidebarInviteBtn = document.querySelector('[data-testid="sidebar-invite"]');
        const sidebarHelpBtn = document.querySelector('[data-testid="sidebar-help"]');
        const sidebarSettingsBtn = document.querySelector('[data-testid="sidebar-settings"]');
        const title = document.querySelector('[data-testid="header-title"]');
        const aside = document.querySelector('aside');
        const chipEl = aside ? aside.querySelector('[data-testid="sync-chip"]') : null;
        const chipWords = chipEl ? chipEl.querySelector('[data-chip-words]') : null;

        const chipClipped = chipEl ? (chipEl.scrollWidth > chipEl.clientWidth + 0.5 || (chipWords && (chipWords.scrollWidth > chipWords.clientWidth + 0.5 || r(chipWords).right > r(chipEl).right + 0.5))) : false;

        return {
            scrollWidth: document.documentElement.scrollWidth,
            innerWidth: window.innerWidth,
            header: r(header),
            pill: r(pill),
            inviteBtn: r(inviteBtn),
            sidebarInviteBtn: r(sidebarInviteBtn),
            sidebarHelpBtn: r(sidebarHelpBtn),
            sidebarSettingsBtn: r(sidebarSettingsBtn),
            title: r(title),
            aside: r(aside),
            chip: chipEl ? {
                width: r(chipEl).width,
                scrollWidth: chipEl.scrollWidth,
                clientWidth: chipEl.clientWidth,
                clipped: chipClipped,
            } : null,
        };
    });

    if (c.width > 768) {
        if (measureData.chip && measureData.chip.clipped) {
            failures++;
            console.error(`FAIL: chip clipped at ${c.width}px (${c.theme}, text: ${c.text}%, chip: ${c.chip}): scrollWidth ${measureData.chip.scrollWidth} > clientWidth ${measureData.chip.clientWidth}`);
        }
        if (measureData.sidebarInviteBtn) {
            if (measureData.sidebarInviteBtn.width < 43.5 || measureData.sidebarInviteBtn.height < 43.5) {
                failures++;
                console.error(`FAIL: sidebar invite button shrinks below 44px: ${measureData.sidebarInviteBtn.width}x${measureData.sidebarInviteBtn.height}`);
            }
        }
    }

    const shotName = `header-${c.width}px-${c.text}pct-${c.theme}-${c.chip}.png`;
    const shotPath = path.join(SHOTS_DIR, shotName);

    if (c.width <= 768) {
        // Screenshot of the mobile header
        const hb = await page.locator('header').boundingBox();
        await page.screenshot({
            path: shotPath,
            clip: { x: 0, y: 0, width: c.width, height: Math.ceil(hb.height + 10) },
        });
    } else {
        // Screenshot of the desktop top row
        await page.screenshot({
            path: shotPath,
            clip: { x: 0, y: 0, width: c.width, height: 200 },
        });
        // Also capture the sidebar controls area at bottom of sidebar
        const sidebarFooter = await page.locator('aside > div').last().boundingBox();
        if (sidebarFooter) {
            const sideShotPath = path.join(SHOTS_DIR, `sidebar-${c.width}px-${c.theme}-${c.chip}-${c.text}pct.png`);
            await page.screenshot({
                path: sideShotPath,
                clip: {
                    x: 0,
                    y: Math.max(0, Math.floor(sidebarFooter.y - 8)),
                    width: Math.ceil(sidebarFooter.width + 8),
                    height: Math.ceil(sidebarFooter.height + 16),
                },
            });
        }
    }

    results.push({ ...c, shotPath, measureData });
    await ctx.close();
}

await browser.close();
await server.close();

console.log(JSON.stringify(results, null, 2));
if (failures > 0) {
    console.error(`${failures} checks failed!`);
    process.exit(1);
}
