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
 * Then every modal and wizard (ALL_MODALS in harness.mjs) at 320 and 360px, at both text sizes: its overlay covers the
 * whole screen, top bar included; every button, link, field and line of text in it lies inside its card, no text runs
 * under its ✕ (the cards clip, so the page check above cannot see a button pushed off the edge),
 * and a tap on the centre of its ✕ closes it. At 320px, normal text, the backdrop, Escape and the phone's Back button
 * each close it too, and Back does not leave Settings.
 *
 * Text is set in a bundled Verdana-width font (see HARNESS_FONT in harness.mjs), so a Mac and CI measure the same.
 *
 * Needs Chromium for Playwright once: `pnpm --filter @beanpool/manager exec playwright install --only-shell chromium`.
 */
import { startServer, launch, openSettings, selectSubTab, settle, horizontalOverflow, boxOverflow, SCREENS, screenName, UNKNOWN, HARNESS_FONT, ALL_MODALS, openModal, topModal, closeControl } from './harness.mjs';

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
                } else {
                    console.log(`  ✓ ${screenName(screen)} links ${at}`);
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

    // Every modal and wizard: nothing in it sits outside its card, and its ✕ can be tapped.
    const CONTROLS = 'button, a[href], input:not([type=hidden]), select, textarea';
    const MODAL_WIDTHS = (process.env.MODAL_WIDTHS || '320,360').split(',').map(Number);
    const only = process.env.MODALS ? new Set(process.env.MODALS.split(',')) : null;
    for (const width of MODAL_WIDTHS) {
        for (const textScale of TEXT_SCALES) {
            const at = `@${width}${textScale !== 1 ? ` ×${textScale}` : ''}`;
            console.log(`\nmodals ${at}`);
            for (const modal of ALL_MODALS.filter(m => !only || only.has(m.name))) {
                const { context, page, errors } = await openSettings(browser, origin, { width, textScale, screen: modal.screen, overrides: modal.overrides });
                const fail = (what) => {
                    failures.push(`modal ${modal.name} ${at}: ${what}`);
                    console.log(`  ✗ ${modal.name} ${at}: ${what.split('\n')[0]}`);
                };
                try {
                    const before = await page.locator('.fixed.inset-0').count();
                    const opened = await openModal(page, modal);
                    checks++;
                    if (opened <= before) { fail('did not open'); continue; }
                    const { overlay, card } = topModal(page);
                    // The dimmed overlay covers the whole screen, top bar included.
                    checks++;
                    const cover = await overlay.evaluate((o) => {
                        const r = o.getBoundingClientRect();
                        return { top: Math.round(r.top), bottom: Math.round(r.bottom), h: window.innerHeight };
                    });
                    if (cover.top > 0 || cover.bottom < cover.h) fail(`the overlay covers ${cover.top}–${cover.bottom} of a ${cover.h}px screen, leaving the top bar live`);
                    else console.log(`  ✓ ${modal.name} ${at}: the overlay covers the screen`);
                    checks++;
                    const box = await boxOverflow(card, CONTROLS, { skipScrollers: true });
                    if (box.outside.length) fail(`${box.outside.length} controls outside the card\n      ${box.outside.join('\n      ')}`);
                    else console.log(`  ✓ ${modal.name} ${at}: every control inside the card`);
                    // Nor does any text run past the card's edge (a name that cannot wrap is cut off there). Text in a
                    // box that clips or scrolls it (an ellipsis, a scrolling table) is that box's business.
                    checks++;
                    const cutText = await card.evaluate((c) => {
                        const b = c.getBoundingClientRect();
                        const out = [];
                        const walker = document.createTreeWalker(c, NodeFilter.SHOW_TEXT);
                        for (let t = walker.nextNode(); t; t = walker.nextNode()) {
                            if (!t.textContent.trim()) continue;
                            let clipped = false;
                            for (let p = t.parentElement; p && p !== c; p = p.parentElement) {
                                if (getComputedStyle(p).overflowX !== 'visible') { clipped = true; break; }
                            }
                            if (clipped) continue;
                            const range = document.createRange();
                            range.selectNodeContents(t);
                            for (const r of range.getClientRects()) {
                                if (r.width && (r.left < b.left - 0.5 || r.right > b.right + 0.5)) {
                                    out.push(`"${t.textContent.trim().slice(0, 30)}" ${Math.round(r.left)}–${Math.round(r.right)} outside ${Math.round(b.left)}–${Math.round(b.right)}`);
                                    break;
                                }
                            }
                        }
                        return out.slice(0, 6);
                    });
                    if (cutText.length) fail(`${cutText.length} texts run past the card\n      ${cutText.join('\n      ')}`);
                    else console.log(`  ✓ ${modal.name} ${at}: no text runs past the card`);

                    checks++;
                    const x = await closeControl(card);
                    if (!x) { fail('no ✕ (or Cancel) to close it'); continue; }
                    const tap = await x.evaluate((el) => {
                        const probe = () => {
                            const r = el.getBoundingClientRect();
                            const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
                            const hit = document.elementFromPoint(cx, cy);
                            return { cx, cy, hit: hit === el || el.contains(hit), label: (el.getAttribute('aria-label') || el.textContent || '').trim().slice(0, 20), r: `${Math.round(r.left)}–${Math.round(r.right)}` };
                        };
                        const first = probe();
                        if (first.hit) return first;
                        // Below the fold (of the page or of a card that scrolls): scroll up or down to it, as a thumb
                        // would, but never sideways. A card that clips can still be scrolled sideways by a script
                        // (scrollIntoView does it), which a thumb cannot do, so every sideways scroll is put back.
                        const lefts = [];
                        for (let p = el.parentElement; p; p = p.parentElement) lefts.push([p, p.scrollLeft]);
                        el.scrollIntoView({ block: 'center', inline: 'nearest' });
                        for (const [p, left] of lefts) p.scrollLeft = left;
                        return probe();
                    });
                    if (!tap.hit) { fail(`a tap on the centre of "${tap.label}" (${tap.r}) misses it`); continue; }
                    // No text runs under or over it (a title that cannot wrap still lets the tap through, unreadably).
                    checks++;
                    const overlaps = await x.evaluate((el) => {
                        const card = el.closest('.fixed.inset-0 > div');
                        const b = el.getBoundingClientRect();
                        const hits = [];
                        const walker = document.createTreeWalker(card, NodeFilter.SHOW_TEXT);
                        for (let t = walker.nextNode(); t; t = walker.nextNode()) {
                            if (!t.textContent.trim() || el.contains(t)) continue;
                            const range = document.createRange();
                            range.selectNodeContents(t);
                            for (const r of range.getClientRects()) {
                                if (r.width && r.left < b.right - 1 && r.right > b.left + 1 && r.top < b.bottom - 1 && r.bottom > b.top + 1) {
                                    hits.push(`"${t.textContent.trim().slice(0, 30)}"`);
                                    break;
                                }
                            }
                        }
                        return hits.slice(0, 4);
                    });
                    if (overlaps.length) fail(`text overlaps "${tap.label}": ${overlaps.join(', ')}`);
                    else console.log(`  ✓ ${modal.name} ${at}: no text overlaps "${tap.label}"`);
                    await page.mouse.click(tap.cx, tap.cy);
                    await settle(page);
                    if (await page.locator('.fixed.inset-0').count() !== opened - 1) fail(`a tap on "${tap.label}" did not close it`);
                    else console.log(`  ✓ ${modal.name} ${at}: "${tap.label}" closes it`);

                    // Backdrop, Escape and Back: once per modal, at the narrowest size, each on a fresh page.
                    if (width === MODAL_WIDTHS[0] && textScale === 1) {
                        for (const how of ['backdrop', 'Escape', 'Back']) {
                            checks++;
                            const fresh = await openSettings(browser, origin, { width, textScale, screen: modal.screen, overrides: modal.overrides });
                            try {
                                const p = fresh.page;
                                const where = await p.locator('header').first().innerText().catch(() => '');
                                const n = await openModal(p, modal);
                                if (how === 'backdrop') {
                                    // The overlay's left margin, halfway down: outside the card, on the dimmed backdrop.
                                    const pt = await topModal(p).overlay.evaluate((o) => {
                                        const y = window.innerHeight / 2;
                                        return { y, onBackdrop: document.elementFromPoint(3, y) === o };
                                    });
                                    if (!pt.onBackdrop) { fail('the backdrop beside the card cannot be tapped'); continue; }
                                    await p.mouse.click(3, pt.y);
                                }
                                else if (how === 'Escape') await p.keyboard.press('Escape');
                                else await p.goBack({ timeout: 3000 }).catch(() => {});
                                await settle(p);
                                // Back must close the modal and stay on the same screen, not go to the one before.
                                const stillSettings = p.url().includes('/settings') && await p.locator('main').count() > 0
                                    && await p.locator('header').first().innerText().catch(() => '') === where;
                                const closed = stillSettings && await p.locator('.fixed.inset-0').count() === n - 1;
                                if (!closed) fail(`${how} does not close it${stillSettings ? '' : ' (Back left the screen)'}`);
                                else console.log(`  ✓ ${modal.name} ${at}: ${how} closes it`);
                            } finally {
                                await fresh.context.close().catch(() => {});
                            }
                        }
                    }
                } catch (e) {
                    fail(`error: ${String(e.message || e).split('\n')[0]}`);
                } finally {
                    if (errors.length) failures.push(`modal ${modal.name} ${at}: page errors: ${errors.join(' | ')}`);
                    await context.close().catch(() => {});
                }
            }
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
console.log(`\n✓ ${checks} checks: no page-level horizontal scroll at ${WIDTH}px, every modal fits its card and closes, and the hand-off lands on its section.`);
