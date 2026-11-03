/**
 * People → Triage & Moderation, the card "Message requests cleared by reports" (#2710, engine/request-limits.ts), light and
 * dark at a wide desktop width and at 320px with 1.3× text: two members limited (a long callsign, to test wrapping), their
 * reasons, the date and Undo. Into scratch/shots/requests-r1-words/manager/ of the checkout it runs in, or `--out <dir>`.
 * Fails on anything past the viewport's edge or the page scrolling sideways.
 *
 *   node apps/manager/e2e/capture-request-limits-shots.mjs [--out <dir>]
 */
/* global console, document, process */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer, launch, openSettings, settle } from './harness.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const outAt = process.argv.indexOf('--out');
const OUT_DIR = outAt > 0 ? path.resolve(process.argv[outAt + 1]) : path.resolve(__dirname, '../../../scratch/shots/requests-r1-words/manager');
fs.mkdirSync(OUT_DIR, { recursive: true });

const LIMITS = {
    '/api/local/admin/members/request-limits': () => ({
        limits: [
            { id: 'l1', publicKey: 'a'.repeat(64), callsign: 'Marketing Bot With A Very Long Callsign', how: 'same_wording', madeAt: '2026-11-01T09:00:00.000Z', until: '2026-11-08T09:00:00.000Z' },
            { id: 'l2', publicKey: 'b'.repeat(64), callsign: null, how: 'words_newcomer', madeAt: '2026-11-02T09:00:00.000Z', until: '2026-11-09T09:00:00.000Z' },
        ],
    }),
};

const VIEWS = [
    { name: '320', width: 320, textScale: 1.3 },
    { name: 'desktop', width: 1100, textScale: 1 },
];

const { server, origin } = await startServer();
const browser = await launch();
const problems = [];

try {
    for (const theme of ['light', 'dark']) {
        for (const view of VIEWS) {
            const { context, page } = await openSettings(browser, origin, {
                width: view.width, height: 800, textScale: view.textScale, screen: { tab: 'people', sub: 'moderation' }, colorScheme: theme, overrides: LIMITS,
            });
            if (theme === 'light') await page.evaluate(() => document.documentElement.classList.remove('dark'));
            await page.waitForSelector('[data-testid="request-limits"]', { timeout: 10000 });
            await page.getByTestId('request-limits').scrollIntoViewIfNeeded();
            await settle(page);
            const name = `message-requests-cleared-${view.name}-${theme}.png`;
            await page.getByTestId('request-limits').screenshot({ path: path.join(OUT_DIR, name) });
            const m = await page.evaluate((w) => {
                const out = [];
                for (const el of document.querySelector('[data-testid="request-limits"]').querySelectorAll('*')) {
                    const r = el.getBoundingClientRect();
                    if (r.width && (r.right > w + 0.5 || r.left < -0.5)) out.push(`"${(el.textContent || '').slice(0, 40)}" spans ${Math.round(r.left)}..${Math.round(r.right)}`);
                }
                return { out, sideways: document.documentElement.scrollWidth > w };
            }, view.width);
            for (const o of m.out) problems.push(`${name}: ${o}`);
            if (m.sideways) problems.push(`${name}: the page scrolls sideways`);
            console.log(`Saved ${path.join(OUT_DIR, name)}`);
            await context.close();
        }
    }

    // The switch that turns this on: its row says posts AND message requests (CommunityShapeSection autoHide).
    for (const theme of ['light', 'dark']) {
        const { context, page } = await openSettings(browser, origin, {
            width: 320, height: 800, textScale: 1.3, screen: { tab: 'shape' }, colorScheme: theme,
        });
        if (theme === 'light') await page.evaluate(() => document.documentElement.classList.remove('dark'));
        await page.waitForSelector('[data-testid="shape-row-autoHide"]', { timeout: 10000 });
        await page.getByTestId('shape-row-autoHide').scrollIntoViewIfNeeded();
        await settle(page);
        const name = `switch-row-320-${theme}.png`;
        await page.getByTestId('shape-row-autoHide').screenshot({ path: path.join(OUT_DIR, name) });
        console.log(`Saved ${path.join(OUT_DIR, name)}`);
        await context.close();
    }
} finally {
    await browser.close();
    await server.close();
}
if (problems.length) {
    console.error(problems.join('\n'));
    process.exit(1);
}
