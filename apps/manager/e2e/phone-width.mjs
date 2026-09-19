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
 * Text is set in a bundled Verdana-width font (see HARNESS_FONT in harness.mjs), so a Mac and CI measure the same.
 *
 * Needs Chromium for Playwright once: `pnpm --filter @beanpool/manager exec playwright install --only-shell chromium`.
 */
import { startServer, launch, openSettings, selectSubTab, settle, horizontalOverflow, boxOverflow, SCREENS, screenName, UNKNOWN, HARNESS_FONT } from './harness.mjs';

const WIDTH = 320;
/** One of each kind of modal an owner meets on a phone: `open` is the button (in the page) that opens it. */
const MODALS = [
    { name: 'member-detail', screen: { tab: 'people', sub: 'directory' }, open: /^Inspect$/ },
    { name: 'report-review', screen: { tab: 'people', sub: 'moderation' }, open: /Inspect & Action/ },
    { name: 'create-enterprise', screen: { tab: 'economy', sub: 'enterprises' }, open: /Create Enterprise/ },
    { name: 'keepers', screen: { tab: 'economy', sub: 'enterprises' }, open: /^Keepers$/ },
    { name: 'seed-offer', screen: { tab: 'economy', sub: 'enterprises' }, open: /^Seed Offer$/ },
    { name: 'halt-decision', screen: { tab: 'economy', sub: 'decisions' }, open: /Halt this Decision/ },
    { name: 'add-pulse-channel', screen: { tab: 'bulletin', sub: 'pulse' }, open: /Add Feed Channel/ },
];
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

console.log(`Text font forced to ${HARNESS_FONT} (DejaVu Sans, Verdana width).`);
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
                // Links are thumb targets too: every link on the screen is at least 48px tall (the map's own
                // controls excepted, as in index.css).
                checks++;
                const smallLinks = await page.evaluate(() => [...document.querySelectorAll('main a[href]')]
                    .filter(a => !a.closest('.leaflet-container'))
                    .map(a => ({ r: a.getBoundingClientRect(), text: (a.textContent || '').trim().slice(0, 40) }))
                    .filter(({ r }) => r.width > 0 && r.height < 47.5)
                    .map(({ r, text }) => `"${text}" ${Math.round(r.width)}×${Math.round(r.height)}`));
                if (smallLinks.length) {
                    failures.push(`${screenName(screen)} ${at}: links under 48px: ${smallLinks.join(', ')}`);
                    console.log(`  ✗ ${screenName(screen)} links ${at}`);
                }
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
            // The menu's panel clips and scrolls its own overflow, so the page check above cannot see a row that is
            // too wide for it: measure the panel, and every button in it (the ✕ above all) sits wholly inside.
            checks++;
            const panel = await boxOverflow(page.getByRole('dialog', { name: 'Settings menu' }).locator(':scope > div').nth(1));
            if (panel.scrollWidth > panel.clientWidth || panel.outside.length) {
                failures.push(`menu panel ${at}: panel is ${panel.scrollWidth}px wide inside ${panel.clientWidth}px\n      ${panel.outside.join('\n      ')}`);
                console.log(`  ✗ menu panel ${at} (${panel.scrollWidth} > ${panel.clientWidth}, ${panel.outside.length} buttons outside)`);
            } else {
                console.log(`  ✓ menu panel ${at}`);
            }
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

        // Modals: they fit the width, and with the keyboard up (the viewport shortened, as `interactive-widget=
        // resizes-content` makes the phone do) their last field can still be reached and seen.
        for (const modal of MODALS) {
            const { context, page } = await openSettings(browser, origin, { width: WIDTH, textScale, screen: modal.screen });
            await page.locator('main').getByRole('button', { name: modal.open }).first().click();
            await settle(page);
            record(`modal ${modal.name} ${at}`, await horizontalOverflow(page));
            // A phone-height screen: the modal's last button (usually Save or Close) can be scrolled to and seen.
            checks++;
            await page.setViewportSize({ width: WIDTH, height: 640 });
            const lastButton = page.locator('.fixed.inset-0 button').last();
            await lastButton.scrollIntoViewIfNeeded().catch(() => {});
            const reachable = await lastButton.evaluate((el) => {
                const r = el.getBoundingClientRect();
                const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
                return r.top >= 0 && r.bottom <= window.innerHeight && (hit === el || el.contains(hit));
            });
            if (!reachable) {
                failures.push(`modal ${modal.name} ${at}: its last button cannot be reached on a 320×640 screen`);
                console.log(`  ✗ modal ${modal.name} last button ${at}`);
            } else {
                console.log(`  ✓ modal ${modal.name} last button ${at}`);
            }
            checks++;
            await page.setViewportSize({ width: WIDTH, height: 360 });
            const field = page.locator('.fixed.inset-0 input:not([type=checkbox]):not([type=radio]):not([type=range]), .fixed.inset-0 textarea, .fixed.inset-0 select').last();
            if (await field.count()) {
                await field.focus();
                await page.waitForTimeout(150);
                const seen = await field.evaluate((el) => {
                    const r = el.getBoundingClientRect();
                    return r.top >= 0 && r.bottom <= window.innerHeight;
                });
                if (!seen) {
                    failures.push(`modal ${modal.name} ${at}: with the keyboard up, its last field is off screen`);
                    console.log(`  ✗ modal ${modal.name} keyboard ${at}`);
                } else {
                    console.log(`  ✓ modal ${modal.name} keyboard ${at}`);
                }
            } else {
                console.log(`  - modal ${modal.name}: no text field`);
            }
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
