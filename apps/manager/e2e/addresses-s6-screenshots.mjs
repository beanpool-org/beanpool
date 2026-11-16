#!/usr/bin/env node
/**
 * Settings → Addresses, several addresses S6 (design scratch/fable-design/DESIGN-several-addresses-fable.md §2.1, §7, §8), in
 * the real built manager at 320 px with 130 % text and on the desktop, dark (the manager has no light theme): an own-domain
 * main with a BeanPool name kept as the way back, a number the server refuses as main, a long hand-set name; the line saying
 * what members' phones follow; Make main's question and its answer; Add an address's question. At 320 px each step measures:
 * nothing sticks out of the page, a row or the question, and the run fails if anything does.
 *
 *   node e2e/addresses-s6-screenshots.mjs [out-dir]     (from apps/manager)
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer, launch, openSettings, settle, horizontalOverflow, boxOverflow } from './harness.mjs';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = process.argv[2] ? path.resolve(process.argv[2]) : path.join(SCRIPT_DIR, 'screenshots/addresses-s6');
fs.mkdirSync(OUT_DIR, { recursive: true });

const NOW = new Date(Date.now() - 12 * 60_000).toISOString();
const FINE = { answers: 'own', dns: { outcome: 'answers', a: ['203.0.113.5'], aaaa: [], cname: [] }, step: 'fine', minutes: null, nextStep: 'Answers as this server. Nothing to do.', checkedAt: NOW, ownAt: NOW };
const MAIN = 'coop.example.org';
const NAME = 'riverside.beanpool.org';
const NUMBER = '203.0.113.5';
const LONG = 'thelongestneighbourhoodnameanyonecouldpick.example.org';
const ROWS = [
    { address: MAIN, source: 'owner', today: 14, busiestDay: 28, reach: FINE },
    { address: NAME, source: 'registrar', today: 3, busiestDay: 5, reach: FINE },
    { address: NUMBER, source: 'owner', today: 1, busiestDay: 2, reach: FINE, mainRefusal: `${NUMBER} is a number, and this community has a name. A number stops working when the server changes, so a name stays the main address.` },
    { address: LONG, source: 'env', today: 0, busiestDay: 1, reach: FINE },
];
const report = (orig) => ({
    ...orig, primaryAddress: MAIN, named: true, addresses: ROWS, unconfirmed: [], heldBack: [],
    list: { main: MAIN, addresses: ROWS.map((r) => r.address).sort() },
});
const statusFor = (orig) => ({ ...orig, hostname: NAME, name: 'riverside', cached: false, nameServiceNote: undefined });
const SCREEN = { tab: 'appliance', sub: 'network' };
const VIEWS = [
    { width: 320, height: 780, textScale: 1.3, label: '320px-130-dark' },
    { width: 1280, height: 900, textScale: 1, label: 'desktop-dark' },
];

const problems = [];
const noOverflow = async (page, what, within = '[data-testid^="address-row-"]') => {
    const sideways = await horizontalOverflow(page);
    if (sideways.scrollWidth > sideways.viewport) problems.push(`${what}: the page scrolls sideways by ${sideways.scrollWidth - sideways.viewport}px (${JSON.stringify(sideways.culprits).slice(0, 200)})`);
    for (const box of await page.locator(within).all()) {
        const { outside } = await boxOverflow(box, 'span, p, a, button');
        if (outside.length) problems.push(`${what}: past the edge: ${JSON.stringify(outside).slice(0, 200)}`);
    }
};
const expectShown = async (page, testId, what) => {
    if (!(await page.getByTestId(testId).isVisible().catch(() => false))) problems.push(`${what}: ${testId} is not shown`);
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
    for (const view of VIEWS) {
        const { context, page } = await openSettings(browser, origin, {
            ...view, screen: SCREEN, colorScheme: 'dark',
            overrides: { '/api/local/admin/app-addresses': report, '/api/local/admin/app-addresses/main': report, '/api/local/admin/public-address/status': statusFor },
        });
        await page.waitForSelector('[data-testid="addresses-panel"]', { timeout: 10000 });
        await settle(page);
        await page.addStyleTag({ content: 'header { position: static !important; }' });
        if (view.width === 320) await noOverflow(page, `the list at ${view.label}`);
        await expectShown(page, 'addresses-follow-line', view.label);
        await expectShown(page, 'addresses-way-back', view.label);
        for (const a of [NAME, LONG]) await expectShown(page, `make-main-btn-${a}`, `${view.label}: Make main on ${a}`);
        if (await page.getByTestId(`make-main-btn-${NUMBER}`).count()) problems.push(`${view.label}: Make main is offered on the number the server refuses`);
        await shoot(page.locator('[data-testid="addresses-panel"] > div').first(), `s6-header-follow-line-${view.label}`);
        await shoot(page.getByTestId('addresses-list'), `s6-list-way-back-${view.label}`);

        // Make main: the question, then the answer.
        await page.getByTestId(`make-main-btn-${LONG}`).click();
        const ask = page.getByTestId('in-page-confirm');
        await ask.waitFor({ timeout: 5000 });
        if (view.width === 320) await noOverflow(page, `Make main's question at ${view.label}`, '[data-testid="in-page-confirm"]');
        await shoot(ask, `s6-make-main-question-${view.label}`);
        await ask.getByRole('button', { name: 'Make main' }).click();
        const said = page.getByTestId('addresses-action-message');
        await said.waitFor({ timeout: 5000 });
        if (!/is now the main address\./.test(await said.innerText())) problems.push(`${view.label}: Make main answered "${await said.innerText()}"`);
        if (view.width === 320) await noOverflow(page, `Make main's answer at ${view.label}`, '[data-testid="addresses-action-message"]');
        await shoot(said, `s6-make-main-done-${view.label}`);

        // Add an address: the question before anything is sent.
        await page.getByTestId('addresses-add-address-btn').click();
        await page.getByRole('button', { name: 'your own domain' }).click();
        await page.getByPlaceholder('e.g. beans.example.org').fill('beans.example.net');
        await page.getByRole('button', { name: 'Use this domain' }).click();
        const add = page.getByTestId('in-page-confirm');
        await add.waitFor({ timeout: 5000 });
        if (view.width === 320) await noOverflow(page, `Add's question at ${view.label}`, '[data-testid="in-page-confirm"]');
        await shoot(add, `s6-add-question-${view.label}`);
        await add.getByRole('button', { name: 'Cancel' }).click();
        await context.close();
    }
} finally {
    await browser.close();
    await server.close();
}

console.log(`\n${shots} shots in ${OUT_DIR}`);
if (problems.length) {
    console.error(`\n${problems.length} problem(s):\n  ${problems.join('\n  ')}`);
    process.exit(1);
}
console.log('No problems at 320 px or on the desktop.');
