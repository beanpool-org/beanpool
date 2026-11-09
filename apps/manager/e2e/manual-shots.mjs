#!/usr/bin/env node
/**
 * Takes pictures of each Settings screen the operator manual describes at phone width (390px).
 * Saves compressed WebP images (<80 KB each) into packages/beanpool-guide/operators/images/.
 *
 * What each picture shows:
 *   - A healthy server on an ordinary day (manual-fixtures.mjs layers it over the stress fixtures phone-width.mjs uses):
 *     audited, backed up off the server, no alerts, a community of eight with believable sums.
 *   - Under a public-looking address (riverbend.beanpool.org), never 127.0.0.1 and a random port. Nothing leaves this machine.
 *   - Scrolled to the subject its manual section talks about (SUBJECTS below), not to wherever the screen opens.
 *   - Only pictures a manual page uses: the script stops with an error if it wrote one no page references, or a page
 *     references one it did not write.
 *
 * Usage:
 *   node e2e/manual-shots.mjs [out-dir]
 *   pnpm --filter @beanpool/guide screenshots
 */
/* global console, process, Buffer, Image, document, window, getComputedStyle -- Node, plus page.evaluate callbacks run in the browser */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
    startServer,
    launch,
    openSettings,
    selectSubTab,
    settle,
    SCREENS,
    screenName,
} from './harness.mjs';
import { MANUAL_ORIGIN, manualBody, withManual, BACKUPS_NEED_ATTENTION } from './manual-fixtures.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '../../..');
const OPERATORS_DIR = path.resolve(REPO_ROOT, 'packages/beanpool-guide/operators');
const outDir = process.argv[2] || path.resolve(OPERATORS_DIR, 'images');

fs.mkdirSync(outDir, { recursive: true });

const WIDTH = 390;
const MAX_H = 800;
/** Space left between the phone's top bar and the top of the subject a picture scrolls to. */
const GAP = 12;
/** The member (by callsign) whose card is pictured: active, no role, so the actions the manual lists for a member are on it. */
const MEMBER_FOR_CARD = 'josephine_wren';

/**
 * The screens with a picture in the manual. Core settings is left out: no manual page shows it (the script checks this
 * against the pages, below, so a page that starts to use one, or a screen that gains one, is noticed).
 */
const MANUAL_SCREENS = SCREENS.filter((s) => s.tab !== 'shape');

/**
 * Where each screen's picture starts: the element the manual's text beside it is about. A screen not listed opens on
 * its subject already, and is taken from the top. `card` takes the box the element sits in, so its border shows too.
 * `endsAtSubject` stops the picture at the bottom of that box, where what follows it is not what the text is about.
 */
const SUBJECTS = {
    // The roster is the last block of a long card (the treasuries come first), so it is the heading that is scrolled to.
    'people-directory': { find: (page) => page.locator('main h4', { hasText: 'Node Member Roster' }) },
    'people-invites': { find: (page) => page.locator('main h3', { hasText: 'Invite Generator' }), card: true },
    'people-moderation': { find: (page) => page.locator('main h3', { hasText: 'Community Report Triage' }), card: true },
    'people-roles': { find: (page) => page.locator('main h4', { hasText: 'Current roles' }), card: true, endsAtSubject: true },
    'appliance-diagnostics': { find: (page) => page.getByText(/^CPU Load$/i).first(), card: true },
    // The gateway's switches, then its rate limit: from the Web app switch down.
    'appliance-gateway': { find: (page) => page.locator('main h4', { hasText: /^Web App$/i }) },
    'appliance-network': { find: (page) => page.locator('main h3', { hasText: 'Public Address & DNS Tunnel' }), card: true },
};

async function saveWebP(page, pngBuffer, outFile, quality = 0.82) {
    const b64 = pngBuffer.toString('base64');
    const webpDataUrl = await page.evaluate(async ({ b64, quality }) => {
        return new Promise((resolve) => {
            const img = new Image();
            img.onload = () => {
                const canvas = document.createElement('canvas');
                canvas.width = img.naturalWidth;
                canvas.height = img.naturalHeight;
                const ctx = canvas.getContext('2d');
                ctx.drawImage(img, 0, 0);
                resolve(canvas.toDataURL('image/webp', quality));
            };
            img.src = 'data:image/png;base64,' + b64;
        });
    }, { b64, quality });
    const buf = Buffer.from(webpDataUrl.split(',')[1], 'base64');
    fs.writeFileSync(outFile, buf);
    const kb = (buf.length / 1024).toFixed(1);
    console.log(`  ✓ ${path.basename(outFile)} (${kb} KB)`);
    if (buf.length > 80 * 1024) {
        console.warn(`    ⚠️ Warning: ${path.basename(outFile)} is ${kb} KB (exceeds ~80 KB)`);
    }
}

/** Every picture written this run, to check against the manual's pages at the end. */
const written = new Set();

/** A picture must never show where it was taken: no 127.0.0.1 and no localhost in the page's text or its fields. */
async function assertNoLocalAddress(page, name) {
    const seen = await page.evaluate(() => {
        const texts = [document.body.innerText, ...[...document.querySelectorAll('input, textarea')].map((el) => el.value)];
        return texts.join('\n').match(/127\.0\.0\.1|localhost/i);
    });
    if (seen) throw new Error(`${name}: the page shows a local address (${seen[0]}); a manual picture must show the public one`);
}

/** Save the viewport (or its first `height` pixels) as `name`.webp. */
async function shoot(page, name, { height = MAX_H } = {}) {
    await assertNoLocalAddress(page, name);
    const pngBuffer = await page.screenshot({ animations: 'disabled', clip: { x: 0, y: 0, width: WIDTH, height } });
    await saveWebP(page, pngBuffer, path.join(outDir, `${name}.webp`));
    written.add(`${name}.webp`);
}

/** The top of the screen: as tall as the page, up to MAX_H. */
async function captureTop(page, name) {
    await page.evaluate(() => window.scrollTo(0, 0));
    const scrollHeight = await page.evaluate(() => document.documentElement.scrollHeight);
    await shoot(page, name, { height: Math.min(scrollHeight, MAX_H) });
}

/** Bottom edge of whatever is stuck to the top of the page (the phone's top bar): a subject scrolls to just under it. */
function stickyBottom(page) {
    return page.evaluate(() => {
        let bottom = 0;
        for (const el of document.querySelectorAll('body *')) {
            const style = getComputedStyle(el);
            if (style.position !== 'fixed' && style.position !== 'sticky') continue;
            const r = el.getBoundingClientRect();
            if (r.top <= 1 && r.width >= window.innerWidth * 0.9 && r.height < 160) bottom = Math.max(bottom, r.bottom);
        }
        return bottom;
    });
}

/** Scroll so `subject` (or the box it sits in) starts just under the top bar. Returns the element scrolled to. */
async function scrollToSubject(page, subject, { card = false } = {}) {
    let target = subject.first();
    await target.waitFor({ state: 'attached', timeout: 10000 });
    if (card) {
        const box = target.locator('xpath=ancestor::*[contains(@class, "rounded-2xl") or contains(@class, "rounded-3xl")][1]');
        if (await box.count()) target = box;
    }
    const top = await target.evaluate((el) => el.getBoundingClientRect().top + window.scrollY);
    const bar = await stickyBottom(page);
    await page.evaluate((y) => window.scrollTo(0, y), Math.max(0, Math.round(top - bar - GAP)));
    await page.waitForTimeout(250);
    return target;
}

/** Press Run Ledger Audit on Home and wait for its answer: Home says "Ledger not audited yet" until an owner has. */
async function auditTheLedger(page) {
    await page.getByRole('button', { name: /Run Ledger Audit/i }).first().click();
    await page.getByText('✓ Ledger balanced').first().waitFor({ state: 'visible', timeout: 10000 });
    await settle(page);
}

/** Every `images/<name>.webp` the manual's pages use. */
function imagesTheManualUses() {
    const used = new Set();
    const walk = (dir) => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            if (entry.isDirectory()) { if (entry.name !== 'images') walk(path.join(dir, entry.name)); continue; }
            if (!entry.name.endsWith('.md')) continue;
            for (const m of fs.readFileSync(path.join(dir, entry.name), 'utf8').matchAll(/\(images\/([a-z0-9-]+\.webp)\)/g)) used.add(m[1]);
        }
    };
    walk(OPERATORS_DIR);
    return used;
}

console.log(`Taking manual screenshots (width: ${WIDTH}px) -> ${outDir}`);

const { server, origin } = await startServer();
const browser = await launch();

/** Settings opened as the manual's pictures need it: signed in under the public address, on a healthy server. */
const openForManual = (screen, extra = {}) => openSettings(browser, origin, {
    width: WIDTH,
    height: MAX_H,
    screen,
    publicOrigin: MANUAL_ORIGIN,
    overrides: withManual(),
    rewriteBody: manualBody,
    ...extra,
});

try {
    // 1. Sign-in screen
    {
        const { context, page } = await openForManual({ tab: 'home' }, { signedIn: false });
        await captureTop(page, 'sign-in');
        await context.close();
    }

    // 2. Cold-start wizard
    {
        const { context, page } = await openForManual({ tab: 'home' });
        const wizardBtn = page.getByRole('button', { name: /Launch Cold-Start Wizard/i });
        if (!(await wizardBtn.isVisible())) throw new Error('Home has no Launch Cold-Start Wizard button: cold-start.webp cannot be taken');
        await wizardBtn.click();
        await settle(page);
        await captureTop(page, 'cold-start');
        await context.close();
    }

    // 3. Home on an ordinary day (audited), then the owner's off-server backup warning, which the manual describes on its own
    {
        const { context, page } = await openForManual({ tab: 'home' });
        await auditTheLedger(page);
        await captureTop(page, 'home');
        await context.close();
    }
    {
        const { context, page } = await openForManual({ tab: 'home' }, { overrides: withManual(BACKUPS_NEED_ATTENTION) });
        await auditTheLedger(page);
        const banner = page.locator('[data-testid="offbox-health-banner"]');
        await banner.waitFor({ state: 'visible', timeout: 10000 });
        // Home's header and the warning: down to the warning's bottom edge.
        const bottom = await banner.evaluate((el) => el.getBoundingClientRect().bottom + window.scrollY);
        await page.evaluate(() => window.scrollTo(0, 0));
        await shoot(page, 'home-backups-attention', { height: Math.min(MAX_H, Math.ceil(bottom) + 24) });
        await context.close();
    }

    // 4. Tab screens (the sections' sub-screens), each scrolled to its subject
    const tabs = [...new Set(MANUAL_SCREENS.filter((s) => s.tab !== 'home').map((s) => s.tab))];
    for (const tab of tabs) {
        const { context, page } = await openForManual({ tab });
        for (const screen of MANUAL_SCREENS.filter((s) => s.tab === tab)) {
            if (screen.sub) {
                await selectSubTab(page, screen.sub);
                await settle(page);
            }
            const name = screenName(screen);
            const subject = SUBJECTS[name];
            if (subject) {
                const target = await scrollToSubject(page, subject.find(page), { card: subject.card });
                if (subject.endsAtSubject) {
                    const bottom = await target.evaluate((el) => el.getBoundingClientRect().bottom);
                    await shoot(page, name, { height: Math.min(MAX_H, Math.ceil(bottom) + 12) });
                } else {
                    await shoot(page, name);
                }
            } else {
                await captureTop(page, name);
            }
        }
        await context.close();
    }

    // 5. Member detail card (described in people/members-and-invites.md): an ordinary member's, whole, because the actions
    // the page lists (Suspend, Freeze, Re-Key, Bring back, Grant Operator) are at its foot.
    {
        const { context, page } = await openForManual({ tab: 'people', sub: 'directory' });
        const row = page.locator('main').getByText(MEMBER_FOR_CARD).first()
            .locator('xpath=ancestor::*[.//button[normalize-space()="Inspect"]][1]');
        await row.getByRole('button', { name: /^Inspect$/ }).evaluate((el) => el.click());
        await settle(page);
        const card = page.locator('.fixed.inset-0').last().locator(':scope > div').first();
        const cardHeight = await card.evaluate((el) => el.getBoundingClientRect().height);
        await page.setViewportSize({ width: WIDTH, height: Math.max(780, Math.ceil(cardHeight) + 64) });
        await page.waitForTimeout(200);
        await assertNoLocalAddress(page, 'modal-member-detail');
        const pngBuffer = await page.screenshot({ animations: 'disabled' });
        await saveWebP(page, pngBuffer, path.join(outDir, 'modal-member-detail.webp'));
        written.add('modal-member-detail.webp');
        await context.close();
    }

    // The set of pictures must be the set the manual uses.
    const used = imagesTheManualUses();
    const unused = [...written].filter((f) => !used.has(f));
    const missing = [...used].filter((f) => !written.has(f));
    if (unused.length || missing.length) {
        throw new Error(
            `The pictures and the manual's pages do not match.`
            + (unused.length ? ` Written but no page uses them: ${unused.join(', ')}.` : '')
            + (missing.length ? ` A page uses them but they were not written: ${missing.join(', ')}.` : ''),
        );
    }
    console.log(`\nAll ${written.size} manual screenshots saved successfully.`);
} finally {
    await browser.close();
    await server.close();
}
