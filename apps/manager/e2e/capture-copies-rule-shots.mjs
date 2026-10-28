/**
 * How this community works → Ways back, "Where members' copies go" (vault rethink VR2), at 320px with 1.3× text, light
 * and dark: the row closed on This server, with its honest words, and opened with Nowhere picked, its three choices and
 * the consequence. Into scratch/shots/vault-vr2/manager/ of the checkout it runs in, or `--out <dir>`. Fails on a row past
 * the viewport or the page scrolling sideways.
 *
 *   node apps/manager/e2e/capture-copies-rule-shots.mjs [--out <dir>]
 */
/* global console, document, process */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer, launch, openSettings, settle } from './harness.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const outAt = process.argv.indexOf('--out');
const OUT_DIR = outAt > 0 ? path.resolve(process.argv[outAt + 1]) : path.resolve(__dirname, '../../../scratch/shots/vault-vr2/manager');
fs.mkdirSync(OUT_DIR, { recursive: true });

const WIDTH = 320;
const withRule = (rule) => ({
    '/api/local/admin/community-shape': (json) => ({
        ...json,
        settings: { ...json.settings, recoveryCopies: { value: rule, configured: rule, source: rule === 'vault' ? 'default' : 'owner', lock: null } },
    }),
});

const { server, origin } = await startServer();
const browser = await launch();
const problems = [];
try {
    for (const theme of ['light', 'dark']) {
        for (const open of [false, true]) {
            const { context, page } = await openSettings(browser, origin, {
                width: WIDTH, height: 800, textScale: 1.3, screen: { tab: 'shape' }, colorScheme: theme, overrides: withRule('server'),
            });
            if (theme === 'light') await page.evaluate(() => document.documentElement.classList.remove('dark'));
            await page.waitForSelector('[data-testid="shape-row-recoveryCopies"]', { timeout: 10000 });
            const row = page.getByTestId('shape-row-recoveryCopies');
            await row.scrollIntoViewIfNeeded();
            if (open) {
                await page.getByTestId('shape-expand-recoveryCopies').click();
                await page.getByRole('radio', { name: /Nowhere/ }).click();
                await page.waitForSelector('[data-testid="shape-consequence"]', { timeout: 5000 });
            }
            await settle(page);
            const file = path.join(OUT_DIR, `ways-back-row-${open ? 'open-nowhere' : 'closed-this-server'}-${theme}.png`);
            await row.screenshot({ path: file });
            const m = await page.evaluate((w) => {
                const out = [];
                const box = document.querySelector('[data-testid="shape-row-recoveryCopies"]');
                for (const el of box.querySelectorAll('*')) {
                    const r = el.getBoundingClientRect();
                    if (r.width && (r.right > w + 0.5 || r.left < -0.5)) out.push(`"${(el.textContent || '').slice(0, 40)}" spans ${Math.round(r.left)}..${Math.round(r.right)}`);
                }
                return { out, sideways: document.documentElement.scrollWidth > w };
            }, WIDTH);
            for (const o of m.out) problems.push(`${path.basename(file)}: ${o}`);
            if (m.sideways) problems.push(`${path.basename(file)}: the page scrolls sideways`);
            console.log(`Saved ${file}${m.out.length ? ` (${m.out.length} past the edge)` : ''}`);
            await context.close();
        }
    }
} finally {
    await browser.close();
    server.close();
}
if (problems.length) {
    console.error(problems.join('\n'));
    process.exit(1);
}
