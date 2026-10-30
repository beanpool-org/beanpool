/**
 * How this community works → Ways back, "Where members' copies go" (vault rethink VR2), at 320px with 1.3× text, light
 * and dark: the row closed on This server, with its honest words, and opened with Nowhere picked, its three choices and
 * the consequence. Then the claim wizard's line, on its step 5 (Founding Invites), for a new community on BeanPool's key
 * vault and for one on Nowhere (the longest words). Into scratch/shots/vault-vr2/manager/ of the checkout it runs in, or
 * `--out <dir>`. Fails on a row past the viewport or the page scrolling sideways.
 *
 *   node apps/manager/e2e/capture-copies-rule-shots.mjs [--out <dir>]
 */
/* global console, document, process, Buffer */
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
// The claim wizard reads the rule from the node's info, as a phone does.
const infoSays = (rule) => ({ '/api/community/info': (json) => ({ ...json, recoveryCopies: rule }) });
// Step 3's first offer needs a photo: a 1×1 PNG, picked as a file.
const PHOTO = { name: 'offer.png', mimeType: 'image/png', buffer: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64') };

const { server, origin } = await startServer();
const browser = await launch();
const problems = [];

/** Saves `selector`'s box as `name` and notes anything in it past the viewport's edges, or the page scrolling sideways. */
async function shoot(page, selector, name) {
    await settle(page);
    const file = path.join(OUT_DIR, name);
    await page.locator(selector).screenshot({ path: file });
    const m = await page.evaluate(({ w, sel }) => {
        const out = [];
        for (const el of document.querySelector(sel).querySelectorAll('*')) {
            const r = el.getBoundingClientRect();
            if (r.width && (r.right > w + 0.5 || r.left < -0.5)) out.push(`"${(el.textContent || '').slice(0, 40)}" spans ${Math.round(r.left)}..${Math.round(r.right)}`);
        }
        return { out, sideways: document.documentElement.scrollWidth > w };
    }, { w: WIDTH, sel: selector });
    for (const o of m.out) problems.push(`${name}: ${o}`);
    if (m.sideways) problems.push(`${name}: the page scrolls sideways`);
    console.log(`Saved ${file}${m.out.length ? ` (${m.out.length} past the edge)` : ''}`);
}

try {
    for (const theme of ['light', 'dark']) {
        for (const open of [false, true]) {
            const { context, page } = await openSettings(browser, origin, {
                width: WIDTH, height: 800, textScale: 1.3, screen: { tab: 'shape' }, colorScheme: theme, overrides: withRule('server'),
            });
            if (theme === 'light') await page.evaluate(() => document.documentElement.classList.remove('dark'));
            await page.waitForSelector('[data-testid="shape-row-recoveryCopies"]', { timeout: 10000 });
            await page.getByTestId('shape-row-recoveryCopies').scrollIntoViewIfNeeded();
            if (open) {
                await page.getByTestId('shape-expand-recoveryCopies').click();
                await page.getByRole('radio', { name: /Nowhere/ }).click();
                await page.waitForSelector('[data-testid="shape-consequence"]', { timeout: 5000 });
            }
            await shoot(page, '[data-testid="shape-row-recoveryCopies"]', `ways-back-row-${open ? 'open-nowhere' : 'closed-this-server'}-${theme}.png`);
            await context.close();
        }
    }

    // The claim wizard's line: Home's "Launch Cold-Start Wizard", then each step's Next to step 5.
    for (const theme of ['light', 'dark']) {
        for (const rule of ['vault', 'none']) {
            const { context, page } = await openSettings(browser, origin, {
                width: WIDTH, height: 800, textScale: 1.3, screen: { tab: 'home' }, colorScheme: theme, overrides: infoSays(rule),
            });
            if (theme === 'light') await page.evaluate(() => document.documentElement.classList.remove('dark'));
            await page.getByRole('button', { name: /Launch Cold-Start Wizard/ }).click();
            await page.getByRole('button', { name: /Next: Owner & 2FA/ }).click();
            await page.getByRole('button', { name: /Next: Create First Enterprise/ }).click();
            await page.getByLabel('Add photo').setInputFiles(PHOTO);
            await page.getByRole('img', { name: 'photo 1' }).waitFor({ timeout: 10000 });
            await page.getByRole('button', { name: /Next: The Commons/ }).click();
            await page.getByRole('button', { name: /Next: Founding Invites/ }).click();
            await page.waitForSelector('[data-testid="recovery-copies-line"]', { timeout: 10000 });
            // Centred: brought only just into view, its top sits under the sticky header and the shot takes the header in.
            await page.getByTestId('recovery-copies-line').evaluate((el) => el.scrollIntoView({ block: 'center' }));
            await shoot(page, '[data-testid="recovery-copies-line"]', `claim-wizard-line-${rule === 'vault' ? 'key-vault' : 'nowhere'}-${theme}.png`);
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
