#!/usr/bin/env node
/**
 * Node Settings on a phone: fails if any screen scrolls the PAGE sideways at 320px wide, at normal and at 1.3x text.
 *
 * Every section and sub-tab, the phone menu, the manual (contents and a page), the sign-in card, and the key sign-in
 * hand-off from the app (which must land on the section it names). The node API is answered from fixtures.mjs:
 * nothing here talks to a real node. Things may scroll sideways INSIDE themselves (a table, the sub-tab strip, a
 * log line); the page itself may not.
 *
 *   pnpm --filter @beanpool/manager test:phone-width
 *
 * Needs Chromium for Playwright once: `pnpm --filter @beanpool/manager exec playwright install --only-shell chromium`.
 */
import { startServer, launch, openSettings, selectSubTab, settle, horizontalOverflow, SCREENS, screenName, UNKNOWN } from './harness.mjs';

const WIDTH = 320;
const TEXT_SCALES = [1, 1.3];
const failures = [];
let checks = 0;

function record(label, result) {
    checks++;
    if (result.scrollWidth > result.viewport) {
        failures.push(`${label}: page is ${result.scrollWidth}px wide in a ${result.viewport}px viewport\n      ${result.culprits.join('\n      ')}`);
        console.log(`  ✗ ${label} (${result.scrollWidth} > ${result.viewport})`);
    } else {
        console.log(`  ✓ ${label}`);
    }
}

const { server, origin } = await startServer();
const browser = await launch();
try {
    for (const textScale of TEXT_SCALES) {
        console.log(`\n${WIDTH}px, text ×${textScale}`);
        const at = `@${WIDTH}${textScale !== 1 ? ` ×${textScale}` : ''}`;

        // Every screen. One page per section; its sub-tabs are chosen in turn, as an owner would.
        const tabs = [...new Set(SCREENS.map(s => s.tab))];
        for (const tab of tabs) {
            const { context, page, errors } = await openSettings(browser, origin, { width: WIDTH, textScale, screen: { tab } });
            for (const screen of SCREENS.filter(s => s.tab === tab)) {
                if (screen.sub) {
                    await selectSubTab(page, screen.sub);
                    await settle(page);
                }
                record(`${screenName(screen)} ${at}`, await horizontalOverflow(page));
            }
            if (errors.length) failures.push(`${tab} ${at}: page errors: ${errors.join(' | ')}`);
            await context.close();
        }

        // The phone menu, the manual, and the sign-in card.
        {
            const { context, page } = await openSettings(browser, origin, { width: WIDTH, textScale, screen: { tab: 'people' } });
            await page.getByRole('button', { name: 'Menu' }).click();
            await page.getByRole('dialog', { name: 'Settings menu' }).waitFor();
            record(`menu ${at}`, await horizontalOverflow(page));
            await page.getByRole('button', { name: /Manual: running your community/ }).click();
            await page.getByRole('dialog', { name: 'Operator manual' }).waitFor();
            record(`manual contents ${at}`, await horizontalOverflow(page));
            await page.getByRole('dialog', { name: 'Operator manual' }).getByRole('button').nth(1).click();
            await settle(page);
            record(`manual page ${at}`, await horizontalOverflow(page));
            await context.close();
        }
        {
            const { context, page } = await openSettings(browser, origin, { width: WIDTH, textScale, signedIn: false });
            record(`sign-in ${at}`, await horizontalOverflow(page));
            await context.close();
        }
    }

    // The key sign-in hand-off (#933) lands on the section it names, visible in the top bar and the sub-tab strip.
    console.log(`\nhand-off at ${WIDTH}px`);
    for (const [section, label, sub] of [['disputes', 'Escrow Disputes', 'disputes'], ['moderation', 'Triage & Moderation', 'moderation'], ['decisions', 'Proposals', 'decisions']]) {
        checks++;
        const { context, page } = await openSettings(browser, origin, {
            width: WIDTH, textScale: 1.3, signedIn: false, hash: `#handoff=${'ab'.repeat(16)}&section=${section}`,
        });
        await page.waitForSelector('main', { timeout: 20000 });
        await settle(page);
        const topBar = await page.locator('header').first().innerText();
        const active = page.locator(`main [data-subtab="${sub}"][aria-current="page"]`);
        const visible = await active.count() === 1 && await active.evaluate((el) => {
            const strip = el.parentElement.getBoundingClientRect();
            const r = el.getBoundingClientRect();
            return r.left >= strip.left - 1 && r.right <= strip.right + 1;
        });
        if (!topBar.includes(label) || !visible) {
            failures.push(`hand-off section=${section}: top bar "${topBar.replace(/\n/g, ' / ')}", tab visible in strip: ${visible}`);
            console.log(`  ✗ section=${section}`);
        } else {
            console.log(`  ✓ section=${section} → ${label}`);
        }
        record(`hand-off ${section} @${WIDTH} ×1.3`, await horizontalOverflow(page));
        await context.close();
    }
} finally {
    await browser.close();
    await server.close();
}

if (UNKNOWN.size) console.log(`\n(note) API paths with no fixture, answered {}: ${[...UNKNOWN].join(', ')}`);
if (failures.length) {
    console.error(`\n✗ ${failures.length} of ${checks} checks failed:\n  - ${failures.join('\n  - ')}`);
    process.exit(1);
}
console.log(`\n✓ ${checks} checks: no page-level horizontal scroll at ${WIDTH}px, and the hand-off lands on its section.`);
