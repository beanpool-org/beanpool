/**
 * The People tabs (Friends | Community | Invites) at 320 px with 1.3× text, in every one of the 25 languages, light and
 * dark, with each of the three tabs selected in turn. The real PeoplePage and the real compiled stylesheet, opened by
 * e2e/words-w2-harness.html (`?screen=people&lang=<tag>`).
 *
 * It FAILS when, in any language, scheme or selected tab:
 *   - a word is split across two lines ("Druz/ya", "Einladung/en"): each word's text is one line. Words are the
 *     whitespace-separated pieces of the tab's name; in Chinese, Japanese and Korean, which have no spaces, Intl.Segmenter's
 *     words (a break between two words is a break at a word boundary);
 *   - a word reaches past its own tab, or a tab past the row, or the row past the 320 px screen, or the page scrolls
 *     sideways;
 *   - a tab is not drawn (no width), so one of the three cannot be tapped.
 * The same rule the phone holds (apps/native/app/(tabs)/people.tsx: a pill starts from its own words and shares what is
 * left; the type shrinks, a word is never split). A tab's name may wrap at a space (the emoji above the word); that is
 * listed, not failed.
 *
 * Builds the harness with Vite into a temp folder; every /api request is answered from fixtures.mjs, every other host
 * is refused. Nothing here talks to a node.
 *
 * Run: node e2e/people-tabs-check.mjs [shots-dir]   (in apps/pwa; @beanpool/core, engine and signin built)
 *   PEOPLE_TABS_LANGS=en,de,ml   these languages (default: all 25 of @beanpool/core's LANGS; `xx` is the pseudo-locale)
 *   PEOPLE_TABS_SCHEMES=light    these colour schemes (default light,dark)
 *   PEOPLE_TABS_SHOTS=en,de,ml   write a picture (≤ 900 px wide) of the tabs in these languages (default none)
 *   PEOPLE_TABS_WIDTH=1024       a wider screen, to see the same tabs on a tablet or desktop (default 320; the sweep above is at 320)
 * Needs Chromium for Playwright once: pnpm --filter @beanpool/pwa exec playwright install --only-shell chromium
 */
/* global URL, console, process, document, window, localStorage, getComputedStyle, NodeFilter -- Node, and the page's side of evaluate() */
import { build, preview } from 'vite';
import react from '@vitejs/plugin-react';
import { chromium } from 'playwright';
import { LANGS } from '@beanpool/core';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { mockResponse } from './fixtures.mjs';

const PWA_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
process.chdir(PWA_DIR);
const SHOTS_DIR = process.argv[2] || path.join(process.env.TMPDIR || os.tmpdir(), 'bp-people-tabs');
const list = (env, fallback) => (process.env[env] ? process.env[env].split(',').map((x) => x.trim()).filter(Boolean) : fallback);
const LANGUAGES = list('PEOPLE_TABS_LANGS', [...LANGS]);
const SCHEMES = list('PEOPLE_TABS_SCHEMES', ['light', 'dark']);
const SHOT_LANGS = list('PEOPLE_TABS_SHOTS', []);
const WIDTH = Number(process.env.PEOPLE_TABS_WIDTH) || 320;
const VIEWS = ['friends', 'community', 'invites'];
/** Languages written without spaces between words: a break inside a run of these is a break between words. */
const NO_SPACES = new Set(['zh-Hans', 'zh-Hant', 'ja', 'ko']);

/** Android's font size scales text, not layout: the root to 130 %, and the cards' pixel sizes with it (harness.mjs). */
const TEXT_SCALE_CSS = (scale) => `
html { font-size: ${scale * 100}% !important; }
${[8, 9, 10, 11, 12, 13, 14, 15, 16].map((px) => `.text-\\[${px}px\\] { font-size: ${px * scale}px !important; }`).join('\n')}
`;

// ── In the page ─────────────────────────────────────────────────────────────────────────────────────────────────
/** Each tab: its box, its lines, the words split across lines and the words past its box. */
function measure({ lang, noSpaces }) {
    const W = window.innerWidth;
    const row = document.querySelector('[role="tablist"]');
    const rowBox = row.getBoundingClientRect();
    const segmenter = noSpaces ? new Intl.Segmenter(lang, { granularity: 'word' }) : null;
    const tabs = [...row.querySelectorAll('[role="tab"]')].map((tab) => {
        const box = tab.getBoundingClientRect();
        const lineHeight = parseFloat(getComputedStyle(tab).lineHeight) || 16;
        const centres = [];
        const split = [];
        const past = [];
        const walker = document.createTreeWalker(tab, NodeFilter.SHOW_TEXT);
        for (let node = walker.nextNode(); node; node = walker.nextNode()) {
            const text = node.textContent;
            const tokens = [];
            if (segmenter) {
                for (const s of segmenter.segment(text)) if (s.isWordLike) tokens.push({ word: s.segment, start: s.index });
            } else {
                for (const m of text.matchAll(/\S+/g)) tokens.push({ word: m[0], start: m.index });
            }
            for (const { word, start } of tokens) {
                const range = document.createRange();
                range.setStart(node, start);
                range.setEnd(node, start + word.length);
                const rects = [...range.getClientRects()].filter((r) => r.width > 0 && r.height > 0);
                if (!rects.length) continue;
                // One line = rectangles whose vertical centres are within half a line of each other (an emoji's rectangle
                // is taller than a letter's, so tops differ on one line, centres do not).
                const lines = [];
                for (const r of rects) {
                    const c = (r.top + r.bottom) / 2;
                    if (!lines.some((l) => Math.abs(l - c) < lineHeight / 2)) lines.push(c);
                    if (!centres.some((l) => Math.abs(l - c) < lineHeight / 2)) centres.push(c);
                }
                if (lines.length > 1) split.push(`${word} (${lines.length} lines)`);
                const left = Math.min(...rects.map((r) => r.left));
                const right = Math.max(...rects.map((r) => r.right));
                if (left < box.left - 0.5 || right > box.right + 0.5) past.push(`${word} ${left.toFixed(1)}–${right.toFixed(1)} in ${box.left.toFixed(1)}–${box.right.toFixed(1)}`);
            }
        }
        return {
            text: tab.textContent.replace(/\s+/g, ' ').trim(),
            selected: tab.getAttribute('aria-selected') === 'true',
            left: box.left, right: box.right, width: box.width, height: box.height,
            fontSize: parseFloat(getComputedStyle(tab).fontSize),
            lines: centres.length, split, past,
        };
    });
    return {
        width: W, scrollWidth: Math.max(document.documentElement.scrollWidth, document.body.scrollWidth),
        row: { left: rowBox.left, right: rowBox.right, bottom: rowBox.bottom, scrollWidth: row.scrollWidth, clientWidth: row.clientWidth },
        tabs,
    };
}

async function main() {
    const outDir = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'bp-people-tabs-build-'));
    fs.mkdirSync(SHOTS_DIR, { recursive: true });
    let server;
    let browser;
    const failures = [];
    const notes = [];
    let runs = 0;
    try {
        await build({
            configFile: false, root: PWA_DIR, plugins: [react()], define: { __APP_VERSION__: JSON.stringify('harness') }, logLevel: 'warn',
            build: { outDir, emptyOutDir: true, rollupOptions: { input: path.join(PWA_DIR, 'e2e', 'words-w2-harness.html') } },
        });
        server = await preview({ configFile: false, root: PWA_DIR, preview: { port: 0, open: false }, build: { outDir }, logLevel: 'warn' });
        const origin = server.resolvedUrls.local[0].replace(/\/$/, '');
        browser = await chromium.launch();
        for (const scheme of SCHEMES) {
            for (const lang of LANGUAGES) {
                const context = await browser.newContext({ viewport: { width: WIDTH, height: 568 }, deviceScaleFactor: 2, reducedMotion: 'reduce', colorScheme: scheme });
                await context.addInitScript((mode) => {
                    localStorage.setItem('beanpool-theme-default-light-v1', 'done');
                    localStorage.setItem('beanpool-theme-mode', mode);
                }, scheme);
                await context.route((url) => url.origin !== origin, (route) => route.abort());
                await context.route(`${origin}/api/**`, (route) => {
                    const url = new URL(route.request().url());
                    const body = url.pathname.startsWith('/api/friends/') ? [] : mockResponse(url.pathname, url.search);
                    if (body === undefined) return route.fulfill({ status: 404, contentType: 'application/json', body: JSON.stringify({ error: 'Not Found' }) });
                    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
                });
                await context.route(`${origin}/ws**`, (route) => route.abort());
                const page = await context.newPage();
                const errors = [];
                page.on('pageerror', (e) => errors.push(e.message));
                try {
                    await page.goto(`${origin}/e2e/words-w2-harness.html?screen=people&lang=${lang}`, { waitUntil: 'load' });
                    await page.addStyleTag({ content: TEXT_SCALE_CSS(1.3) });
                    await page.waitForSelector('html[data-harness-ready="true"]', { timeout: 20_000 });
                    await page.waitForSelector('[role="tablist"] [role="tab"]', { timeout: 20_000 });
                    await page.waitForLoadState('networkidle').catch(() => {});
                    await page.waitForTimeout(500);
                    for (const view of VIEWS) {
                        const run = `${lang} ${scheme} ${view}`;
                        await page.locator(`#people-tab-${view}`).click({ timeout: 10_000 });
                        await page.waitForTimeout(300);
                        const m = await page.evaluate(measure, { lang, noSpaces: NO_SPACES.has(lang) });
                        runs += 1;
                        if (errors.length) failures.push(`${run}: page error: ${errors[0]}`);
                        if (m.tabs.length !== 3) failures.push(`${run}: ${m.tabs.length} tabs drawn, not 3`);
                        if (!m.tabs.some((t) => t.selected && t.text)) failures.push(`${run}: no tab selected`);
                        if (m.scrollWidth > m.width) failures.push(`${run}: the page scrolls sideways (${m.scrollWidth}px in ${m.width}px)`);
                        if (m.row.left < -0.5 || m.row.right > m.width + 0.5) failures.push(`${run}: the tab row spans ${m.row.left.toFixed(1)}–${m.row.right.toFixed(1)} px of ${m.width}`);
                        for (const t of m.tabs) {
                            const where = `${run}, tab "${t.text}"`;
                            if (t.width < 24 || t.height < 24) failures.push(`${where}: not drawn (${t.width.toFixed(1)}×${t.height.toFixed(1)} px)`);
                            if (t.left < -0.5 || t.right > m.width + 0.5) failures.push(`${where}: past the screen (${t.left.toFixed(1)}–${t.right.toFixed(1)} px of ${m.width})`);
                            for (const w of t.split) failures.push(`${where}: a word is split across lines: ${w}`);
                            for (const w of t.past) failures.push(`${where}: a word reaches past its tab: ${w}`);
                            if (t.lines > 1 && !t.split.length) notes.push(`${where}: ${t.lines} lines at ${t.fontSize.toFixed(1)} px, ${t.width.toFixed(1)} px wide`);
                        }
                        if (SHOT_LANGS.includes(lang)) {
                            await page.screenshot({ path: path.join(SHOTS_DIR, `people-tabs-${lang}-${scheme}-${view}.png`), clip: { x: 0, y: 0, width: WIDTH, height: Math.ceil(m.row.bottom) + 16 } });
                        }
                    }
                    console.log(`${lang} ${scheme}: tabs ${(await page.evaluate(measure, { lang, noSpaces: NO_SPACES.has(lang) })).tabs.map((t) => `${t.width.toFixed(0)}px/${t.lines}l`).join(' ')}`);
                } catch (e) {
                    failures.push(`${lang} ${scheme}: ${e.message}`);
                    await page.screenshot({ path: path.join(SHOTS_DIR, `people-tabs-${lang}-${scheme}-error.png`) }).catch(() => {});
                }
                await context.close();
            }
        }
    } finally {
        await browser?.close();
        await new Promise((r) => (server ? server.httpServer.close(r) : r()));
        fs.rmSync(outDir, { recursive: true, force: true });
    }
    for (const n of notes) console.log(`note ${n}`);
    console.log(`screenshots: ${SHOTS_DIR}`);
    if (failures.length) {
        for (const f of failures) console.log(`FAIL ${f}`);
        console.log(`people-tabs-check: ${failures.length} failure(s) in ${runs} runs`);
        process.exit(1);
    }
    console.log(`people-tabs-check: ok — ${runs} runs (${LANGUAGES.length} languages × ${SCHEMES.join(' + ')} × 3 selected tabs) at ${WIDTH} px, 1.3× text: no word split, nothing past a tab, the row or the screen`);
}

main().catch((e) => { console.error(e); process.exit(1); });
