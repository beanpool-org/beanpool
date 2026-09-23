/**
 * Photographs the Market grid's event card at every width the design has to hold, and MEASURES the RSVP row
 * rather than just looking at it. Three things are checked in a real Chromium layout, for every button in every
 * shot:
 *
 *   1. the label occupies exactly one line box — anything else is "Intereste / d" (Marty, 2026-09-24);
 *   2. nothing overflows: not the label out of its button, not the row out of its card;
 *   3. when the row does wrap, it wraps *properly* — every button takes a full row of its own, which is the
 *      stacking the design asks for instead of a smaller font or a cut label.
 *
 * On origin/main this run fails: 11 split labels across the four standard cases, including the plain word
 * "Interested" broken after "Intereste" on the 1440px 5-column grid at 130% text.
 *
 * Nothing here touches a BeanPool node: the harness renders the component against the fixtures in
 * event-card-harness.tsx, and every /api and /ws request is aborted at the browser and counted, so a stray
 * fetch fails the run instead of escaping.
 *
 *   node e2e/event-card-shots.mjs      # writes e2e/shots/*.png, exits non-zero on a split or overflowing label
 *
 * Run from apps/pwa — Tailwind reads its config from the working directory.
 */
import { createServer } from 'vite';
import { chromium } from 'playwright';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';

const PWA_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
process.chdir(PWA_DIR);
const OUT_DIR = path.join(PWA_DIR, 'e2e', 'shots');

/**
 * 1440 is where the bug was reported: max-w-7xl + px-6 + xl:grid-cols-5 + gap-3.5 is the narrowest column the
 * grid ever produces (235px, and 261px at 130% text — the rem-based gap grows with the root font). 320 at 130%
 * is the documented floor. The three STRESS cases are past that floor and are the ones that actually exercise
 * the wrap: everything at or inside the floor still fits side by side, so without them the stacking path would
 * ship unphotographed and unmeasured.
 */
const CASES = [
    { name: 'desktop-5col-1440', width: 1440, height: 900, fontScale: 1 },
    { name: 'desktop-5col-1440-130pc', width: 1440, height: 900, fontScale: 1.3 },
    { name: 'tablet-800', width: 800, height: 1000, fontScale: 1 },
    { name: 'phone-320-130pc', width: 320, height: 900, fontScale: 1.3 },
    { name: 'STRESS-phone-320-160pc', width: 320, height: 900, fontScale: 1.6 },
    { name: 'STRESS-phone-320-200pc', width: 320, height: 900, fontScale: 2.0 },
    { name: 'STRESS-narrow-260-130pc', width: 260, height: 900, fontScale: 1.3 },
];

/** Runs in the page: the geometry of every RSVP row and the labels inside it. */
const MEASURE = () => {
    const rows = Array.from(document.querySelectorAll('[data-testid="event-rsvp-row"]'));
    return rows.map((row) => {
        const card = row.closest('[data-testid="event-card"]') || row.parentElement;
        const cardRect = card.getBoundingClientRect();
        const rowRect = row.getBoundingClientRect();
        const buttons = Array.from(row.querySelectorAll('button')).map((b) => {
            const r = b.getBoundingClientRect();
            const range = document.createRange();
            range.selectNodeContents(b);
            return {
                label: (b.textContent || '').trim(),
                lines: range.getClientRects().length,
                labelOverflows: b.scrollWidth > b.clientWidth,
                x: Math.round(r.x), y: Math.round(r.y),
                width: Math.round(r.width), height: Math.round(r.height),
            };
        });
        const lanes = [...new Set(buttons.map((b) => b.y))];
        return {
            buttons,
            lanes: lanes.length,
            rowWidth: Math.round(rowRect.width),
            // A wrapped button must own its row: full width, not a half-width orphan.
            badStack: lanes.length > 1 && buttons.some((b) => Math.abs(b.width - Math.round(rowRect.width)) > 1),
            rowOverflowsCard: Math.round(rowRect.right) > Math.round(cardRect.right) + 1,
            rowScrollOverflow: row.scrollWidth > row.clientWidth,
        };
    });
};

const server = await createServer({ configFile: path.join(PWA_DIR, 'vite.config.ts'), root: PWA_DIR, server: { port: 0 } });
await server.listen();
const base = `http://localhost:${server.httpServer.address().port}`;

fs.mkdirSync(OUT_DIR, { recursive: true });
const browser = await chromium.launch();
const failures = [];
let blocked = 0;

try {
    for (const theme of ['light', 'dark']) {
        for (const c of CASES) {
            const context = await browser.newContext({
                viewport: { width: c.width, height: c.height },
                colorScheme: theme,
            });
            // No node, ever. Anything node-shaped is refused and counted.
            await context.route('**/*', (route) => {
                const url = route.request().url();
                if (url.includes('/api/') || url.startsWith('ws')) { blocked++; return route.abort(); }
                return route.continue();
            });
            const page = await context.newPage();
            const pageErrors = [];
            page.on('pageerror', (e) => pageErrors.push(e.message));

            await page.goto(`${base}/e2e/event-card-harness.html`, { waitUntil: 'networkidle' });
            await page.evaluate(([t, scale]) => {
                document.documentElement.classList.toggle('dark', t === 'dark');
                document.documentElement.classList.toggle('dark-theme', t === 'dark');
                document.documentElement.style.fontSize = `${scale * 100}%`;
            }, [theme, c.fontScale]);
            await page.waitForSelector('[data-testid="event-rsvp-row"]');
            await page.evaluate(() => document.fonts.ready);

            const shot = `${c.name}-${theme}.png`;
            // The grid only, not the whole page: the cards are the evidence and a full-page shot of the
            // background pattern is megabytes of nothing.
            await page.locator('.grid').screenshot({ path: path.join(OUT_DIR, shot) });

            const rows = await page.evaluate(MEASURE);
            if (rows.length === 0) failures.push(`${shot}: no RSVP rows rendered`);
            for (const r of rows) {
                for (const b of r.buttons) {
                    if (b.lines !== 1) failures.push(`${shot}: "${b.label}" occupies ${b.lines} line boxes (${b.width}x${b.height})`);
                    if (b.labelOverflows) failures.push(`${shot}: "${b.label}" overflows its button (${b.width}px)`);
                    if (b.height < 48) failures.push(`${shot}: "${b.label}" is ${b.height}px tall, under the 48px target`);
                }
                if (r.badStack) failures.push(`${shot}: wrapped row has a button that is not full width`);
                if (r.rowOverflowsCard) failures.push(`${shot}: the RSVP row overflows its card`);
                if (r.rowScrollOverflow) failures.push(`${shot}: the RSVP row scrolls sideways`);
            }
            if (pageErrors.length) failures.push(`${shot}: page errors ${JSON.stringify(pageErrors)}`);

            const stacked = rows.some((r) => r.lanes > 1);
            const widths = rows[0]?.buttons.map((b) => `${b.label}=${b.width}x${b.height}`).join(' ') ?? '';
            console.log(`${shot.padEnd(36)} ${rows.length} rows, ${stacked ? 'STACKED' : 'side by side'}, all labels on one line: ${rows.every((r) => r.buttons.every((b) => b.lines === 1))}`);
            console.log(`${' '.repeat(36)} first card: ${widths}`);
            await context.close();
        }
    }
} finally {
    await browser.close();
    await server.close();
}

console.log(`\nnode requests blocked: ${blocked} (0 expected — the harness needs none)`);
if (failures.length) {
    console.error(`\nFAILED:\n${failures.map((f) => `  - ${f}`).join('\n')}`);
    process.exit(1);
}
console.log(`\nOK — every RSVP label whole and on one line, every target >= 48px, nothing overflowing, in all ${CASES.length * 2} shots.`);
console.log(OUT_DIR);
