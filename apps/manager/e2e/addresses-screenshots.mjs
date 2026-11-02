#!/usr/bin/env node
/**
 * The Addresses screen of the real built manager: every state at 320 px (130 % text) and desktop, and each control the
 * screen keeps. Dark only: the manager has no light theme (index.html is always class="dark"), so there is nothing else to
 * shoot.
 *
 * Each state's shot is the whole list, however tall, so a row's buttons are never cut off below the fold. At 320 px each
 * run measures: nothing sticks out of the page or of a row, and it fails if anything does.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer, launch, openSettings, settle, horizontalOverflow, boxOverflow } from './harness.mjs';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = process.argv[2] ? path.resolve(process.argv[2]) : path.join(SCRIPT_DIR, 'screenshots/addresses');
fs.mkdirSync(OUT_DIR, { recursive: true });

const NOW = new Date(Date.now() - 27 * 60_000).toISOString();
const reachOf = (answers, step, nextStep, dns = null, minutes = null) => ({ answers, dns, step, minutes, nextStep, checkedAt: NOW, ownAt: answers === 'own' ? NOW : null });
const NO_NAME = { outcome: 'no-such-name', a: [], aaaa: [], cname: [] };
const FINE = reachOf('own', 'fine', 'Answers as this server. Nothing to do.', { outcome: 'answers', a: ['104.21.93.179'], aaaa: [], cname: ['edge.cloudflare.example.org'] });
const MAIN = { address: 'byron.beanpool.org', source: 'public-address', today: 14, busiestDay: 28, reach: FINE };
const LOST = {
    state: 'lost', registrarSays: 'other', releasedOn: null, acceptedUntil: null, leadsHere: false, lostSince: '2026-10-20T10:00:00.000Z', why: 'another-key', checkedAt: NOW,
};

const STATES = [
    { name: 'fine', rows: [MAIN] },
    { name: 'new-name', primary: 'byron.beanpool.org', rows: [MAIN, { address: 'fresh-name.beanpool.org', source: 'registrar', today: 0, busiestDay: 0, reach: reachOf('silence', 'new-name', "Made 12 minutes ago. Some networks remember 'no such name' for up to 30 minutes. Try mobile data, or wait.", NO_NAME, 12) }] },
    { name: 'awaiting-approval', primary: 'byron.beanpool.org', rows: [MAIN, { address: 'waiting-name.beanpool.org', source: 'registrar', today: 0, busiestDay: 0, reach: reachOf('silence', 'awaiting-approval', 'Awaiting approval by the BeanPool project. It moves over by itself once approved.', NO_NAME) }] },
    { name: 'stopped', primary: 'byron.beanpool.org', rows: [MAIN, { address: 'stopped-name.beanpool.org', source: 'registrar', today: 0, busiestDay: 0, reach: reachOf('silence', 'stopped', 'Stopped by the address service. Ask the BeanPool project.', NO_NAME) }] },
    { name: 'certificate', primary: 'byron.beanpool.org', rows: [MAIN, { address: 'beans.example.org', source: 'owner', today: 3, busiestDay: 5, reach: reachOf('tls', 'certificate', 'Answers, but not with a certificate phones trust. Check that port 80 is open and this address points at this server.', { outcome: 'answers', a: ['203.0.113.5'], aaaa: [], cname: [] }) }] },
    { name: 'no-dns-own', primary: 'byron.example.org', rows: [{ address: 'byron.example.org', source: 'public-address', today: 0, busiestDay: 0, reach: reachOf('silence', 'no-dns-own', "No DNS answer for this name. Add or fix its A record where you run your domain's DNS.", NO_NAME) }] },
    { name: 'another-server', primary: 'byron.beanpool.org', rows: [MAIN, { address: 'moved.example.org', source: 'owner', today: 1, busiestDay: 2, reach: reachOf('other', 'another-server', "Another server answers here, with a key that isn't this server's. Check where this address points.", { outcome: 'answers', a: ['203.0.113.8'], aaaa: [], cname: [] }) }] },
    { name: 'former', primary: 'byron.beanpool.org', rows: [MAIN, { address: 'old-byron.beanpool.org', source: 'registrar', former: true, today: 2, busiestDay: 4, reach: reachOf('silence', 'no-longer-ours', "No longer this community's address. Nothing to do.", NO_NAME) }] },
    { name: 'lost', primary: 'byron.beanpool.org', rows: [MAIN, { address: 'taken-name.beanpool.org', source: 'registrar', former: true, lost: true, today: 0, busiestDay: 2, tried: { today: 3, busiestDay: 4 }, standing: LOST, reach: reachOf('other', 'no-longer-ours', "No longer this community's address. Nothing to do.") }] },
];

const VIEWS = [
    { width: 320, height: 780, textScale: 1.3, label: '320px-130-dark' },
    { width: 1280, height: 900, textScale: 1, label: 'desktop-dark' },
];

const reportFor = (state) => (orig) => ({ ...orig, primaryAddress: state.primary ?? state.rows[0].address, named: true, addresses: state.rows, unconfirmed: [], heldBack: [] });
const statusFor = (orig) => ({ ...orig, hostname: 'byron.beanpool.org', name: 'byron', cached: false, nameServiceNote: undefined });
const OPEN = { width: 320, height: 780, textScale: 1.3, screen: { tab: 'appliance', sub: 'network' }, colorScheme: 'dark' };

const problems = [];
const noOverflow = async (page, what) => {
    const sideways = await horizontalOverflow(page);
    if (sideways.overflow > 0) problems.push(`${what}: the page scrolls sideways by ${sideways.overflow}px (${JSON.stringify(sideways.culprits ?? []).slice(0, 200)})`);
    for (const row of await page.locator('[data-testid^="address-row-"]').all()) {
        const out = await boxOverflow(row, 'span, p, a, button');
        const list = out.outside ?? out;
        if (Array.isArray(list) && list.length) problems.push(`${what}: past the row's edge: ${JSON.stringify(list).slice(0, 200)}`);
    }
};

console.log('Building and launching Settings preview server…');
const { server, origin } = await startServer();
const browser = await launch();
let shots = 0;
const shoot = async (locator, name) => {
    await locator.scrollIntoViewIfNeeded().catch(() => {});
    await locator.screenshot({ path: path.join(OUT_DIR, `${name}.png`) });
    shots++;
    console.log(`  ✓ ${name}.png`);
};

try {
    for (const state of STATES) {
        for (const view of VIEWS) {
            const { context, page } = await openSettings(browser, origin, {
                ...view, screen: OPEN.screen, colorScheme: 'dark',
                overrides: { '/api/local/admin/app-addresses': reportFor(state), '/api/local/admin/public-address/status': statusFor },
            });
            await page.waitForSelector('[data-testid="addresses-panel"]', { timeout: 10000 });
            await settle(page);
            if (view.width === 320) await noOverflow(page, `${state.name} at 320 px`);
            await shoot(page.getByTestId('addresses-list'), `addresses-${state.name}-${view.label}`);
            await context.close();
        }
    }

    // Each control the screen keeps, at 320 px / 130 % and on the desktop.
    for (const view of VIEWS) {
        const report = reportFor(STATES[7]);
        const withHeld = (orig) => ({
            ...report(orig), named: false, unboundSignaturesAccepted: true, unboundSignaturesUntil: '2026-12-15', formerApps: { today: 2, busiestDay: 4 }, oldApps: { today: 1, busiestDay: 3 },
            unconfirmed: [{ address: 'community.example.org', today: 2, busiestDay: 4, ownerOrAdmin: true }],
            heldBack: [
                { address: 'other-community.beanpool.org', today: 3, busiestDay: 3, ownerOrAdmin: false, reason: 'another-community' },
                { address: 'riverbend.example', today: 4, busiestDay: 4, ownerOrAdmin: true, reason: 'directory', directory: { name: 'Riverbend Commons' } },
                { address: 'reached.example.net', today: 1, busiestDay: 2, ownerOrAdmin: false, reason: 'not-this-page' },
            ],
        });
        const { context, page } = await openSettings(browser, origin, {
            ...view, screen: OPEN.screen, colorScheme: 'dark',
            overrides: { '/api/local/admin/app-addresses': withHeld, '/api/local/admin/public-address/status': statusFor },
        });
        await page.waitForSelector('[data-testid="addresses-panel"]', { timeout: 10000 });
        await settle(page);
        if (view.width === 320) await noOverflow(page, 'the whole screen at 320 px');

        const panel = page.getByTestId('public-address-panel');
        await shoot(page.getByTestId('extra-name'), `control-spare-name-release-${view.label}`);
        await shoot(panel.getByRole('button', { name: /Restart tunnel/ }).locator('..'), `control-restart-newkey-offline-${view.label}`);
        await shoot(page.getByTestId('address-notices'), `control-notices-reply-link-${view.label}`);
        await shoot(page.getByTestId('own-address-card'), `control-certificates-try-again-${view.label}`);
        await shoot(page.getByTestId('propagation-monitor-terminal'), `control-log-${view.label}`);
        await shoot(page.getByTestId('app-addresses'), `control-confirm-behind-tick-warnings-${view.label}`);

        for (const [button, name] of [[/Restart tunnel/, 'restart-tunnel'], [/New tunnel key/, 'new-tunnel-key'], [/Take offline/, 'take-offline']]) {
            await panel.getByRole('button', { name: button }).click();
            const dialog = page.getByRole('dialog').first();
            await dialog.waitFor({ timeout: 5000 });
            await shoot(dialog, `control-dialog-${name}-${view.label}`);
            await dialog.getByRole('button', { name: 'Cancel' }).click();
        }

        await page.getByTestId('remove-release-btn-old-byron.beanpool.org').click();
        const ask = page.getByTestId('in-page-confirm');
        await ask.waitFor({ timeout: 5000 });
        await shoot(ask, `control-release-question-${view.label}`);
        await ask.getByRole('button', { name: 'Keep it' }).click();

        await page.getByTestId('addresses-add-address-btn').click();
        await shoot(page.getByTestId('add-address-section'), `control-add-beanpool-name-${view.label}`);
        await page.getByRole('button', { name: "this server's number" }).click();
        await shoot(page.getByTestId('add-address-section'), `control-add-number-${view.label}`);
        await page.getByRole('button', { name: 'your own domain' }).click();
        await shoot(page.getByTestId('add-address-section'), `control-add-domain-${view.label}`);
        await context.close();
    }
} finally {
    await browser.close();
    await server.close();
}
if (problems.length) {
    console.error(`\n✗ ${problems.length} overflow problem(s):\n${problems.join('\n')}`);
    process.exit(1);
}
console.log(`\n${shots} screenshots captured; nothing sticks out at 320 px.`);
