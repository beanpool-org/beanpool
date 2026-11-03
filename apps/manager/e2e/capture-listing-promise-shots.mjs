/**
 * Settings → Node Identity → "The listing promise" (Mothership A3), light and dark, at 320 px with 1.3× text and at a wide
 * desktop width: a new listing (one owner, no ticks) and a community that keeps it (three owners, both ticks, a closing day).
 * Into scratch/shots/listing-promise-a3/manager/ of the checkout it runs in, or `--out <dir>`. Fails on anything past the
 * viewport's edge or the page scrolling sideways. No node is contacted: the harness answers every /api/ call itself.
 *
 *   node apps/manager/e2e/capture-listing-promise-shots.mjs [--out <dir>]
 */
/* global console, document, process */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer, launch, openSettings, settle } from './harness.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const outAt = process.argv.indexOf('--out');
const OUT_DIR = outAt > 0 ? path.resolve(process.argv[outAt + 1]) : path.resolve(__dirname, '../../../scratch/shots/listing-promise-a3/manager');
fs.mkdirSync(OUT_DIR, { recursive: true });

const day = (n) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);
const STATES = [
    { name: 'new-listing', override: undefined },
    {
        name: 'kept',
        override: () => ({ promise: { kept: true, owners: 3, backupsLocked: true, backupsRunning: true, reports: true, notice: true, closingOn: day(45), acceptingKnocks: true, why: [] } }),
    },
    {
        name: 'no-recovery-code',
        override: () => ({ promise: { kept: false, owners: 1, backupsLocked: false, backupsRunning: false, reports: false, notice: false, closingOn: null, acceptingKnocks: true, why: [] } }),
    },
];
const VIEWS = [
    { name: '320', width: 320, textScale: 1.3 },
    { name: 'desktop', width: 1100, textScale: 1 },
];

const { server, origin } = await startServer();
const browser = await launch();
const problems = [];

try {
    for (const theme of ['light', 'dark']) {
        for (const state of STATES) {
            for (const view of VIEWS) {
                const { context, page } = await openSettings(browser, origin, {
                    width: view.width, height: 800, textScale: view.textScale, screen: { tab: 'appliance', sub: 'identity' }, colorScheme: theme,
                    overrides: state.override ? { '/api/local/admin/directory/promise': state.override } : {},
                });
                if (theme === 'light') await page.evaluate(() => document.documentElement.classList.remove('dark'));
                await page.waitForSelector('[data-testid="listing-promise-headline"]', { timeout: 10000 });
                // The sticky header would float over the top of an element crop: shots only.
                await page.addStyleTag({ content: '.sticky, .fixed { position: static !important; }' });
                await page.getByTestId('listing-promise').scrollIntoViewIfNeeded();
                await settle(page);
                const name = `listing-promise-${state.name}-${view.name}-${theme}.png`;
                await page.getByTestId('listing-promise').screenshot({ path: path.join(OUT_DIR, name) });
                const m = await page.evaluate((w) => {
                    const out = [];
                    for (const el of document.querySelector('[data-testid="listing-promise"]').querySelectorAll('*')) {
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
    }
} finally {
    await browser.close();
    await server.close();
}
if (problems.length) {
    console.error(problems.join('\n'));
    process.exit(1);
}
