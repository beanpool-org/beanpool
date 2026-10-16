#!/usr/bin/env node
/**
 * The in-page question (components/common/InPageConfirm.tsx, owner-delete S4b item 6) is the top thing on the screen,
 * and can be answered, wherever it is asked from: from inside a modal as well as from the page. At 1280px and at 320px
 * with 1.3× text. The node API is answered from fixtures.mjs: nothing here talks to a real node.
 *
 * A unit test cannot see this: jsdom has no paint and no hit-testing. On 01bd6e4c the question was a sibling of the
 * Manage Keepers modal at the same z-index, earlier in the page, so the modal painted over it: Revoke showed nothing,
 * and Escape answered "no" (PR #2029's deciding review, B1).
 *
 * Economy → Enterprises → Keepers → Revoke (the one question asked from inside a modal), at each size:
 *   - the question opens, and the point at the centre of each of its buttons is that button (elementFromPoint), not the
 *     modal under it; Playwright's own click check agrees; the question is wholly on screen;
 *   - Escape answers "no" and closes only the question: the keepers modal stays open and nothing is sent;
 *   - asked again, its Revoke sends the revoke call, the question closes, and the keepers modal stays open.
 * And every question asked from the page (assistant Disconnect, off-box Remove, Pulse channel Remove, Remove from the
 * Pulse, Prune Stale Posts, proposal Dismiss) is on top and on screen the same way.
 *
 *   node e2e/in-page-confirm.mjs
 *
 * Needs Chromium for Playwright once: `pnpm --filter @beanpool/manager exec playwright install --only-shell chromium`.
 */
/* global console, process, document, window, URL -- Node, plus page.evaluate callbacks run in the browser */
import { startServer, launch, openSettings, openModal, settle, ALL_MODALS, CSP_VIOLATIONS } from './harness.mjs';

const SIZES = [{ width: 1280, textScale: 1 }, { width: 320, textScale: 1.3 }];
/** Questions asked from the page, not from a modal: the button that asks, on its screen in the fixtures. */
const PAGE_QUESTIONS = [
    // Its accessible name is "Disconnect <the assistant's name>" (aria-label).
    { name: 'assistant Disconnect', screen: { tab: 'appliance', sub: 'access' }, button: /^Disconnect / },
    { name: 'off-box Remove', screen: { tab: 'appliance', sub: 'backups' }, button: /^Remove$/ },
    { name: 'Pulse channel Remove', screen: { tab: 'bulletin', sub: 'pulse' }, button: /^Remove$/ },
    { name: 'Remove from the Pulse', screen: { tab: 'people', sub: 'moderation' }, button: /^Remove from the Pulse$/ },
    { name: 'Prune Stale Posts', screen: { tab: 'people', sub: 'moderation' }, button: /^Prune Stale Posts$/ },
    { name: 'proposal Dismiss', screen: { tab: 'economy', sub: 'decisions' }, button: /^Dismiss$/ },
];
const QUESTION = '[role="alertdialog"][data-testid="in-page-confirm"]';
const failures = [];
let checks = 0;

function check(ok, label, detail = '') {
    checks++;
    if (ok) console.log(`  ✓ ${label}`);
    else {
        failures.push(`${label}${detail ? `: ${detail}` : ''}`);
        console.log(`  ✗ ${label}${detail ? ` (${detail})` : ''}`);
    }
}

/**
 * For each of the open question's buttons: is the element at its centre that button (or inside it)? If not, what is.
 * And is the whole question inside the viewport.
 */
async function onTop(page) {
    return page.evaluate((sel) => {
        const dlg = document.querySelector(sel);
        if (!dlg) return { open: false };
        const buttons = [...dlg.querySelectorAll('button')].map((b) => {
            const r = b.getBoundingClientRect();
            const top = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
            const hit = !!top && (top === b || b.contains(top));
            const what = top ? `${top.tagName.toLowerCase()} "${(top.textContent || '').trim().slice(0, 40)}" in ${top.closest('[data-bp-modal]')?.className.slice(0, 60) ?? 'the page'}` : 'nothing';
            return { label: (b.textContent || '').trim(), hit, what };
        });
        const d = dlg.getBoundingClientRect();
        return {
            open: true,
            buttons,
            onScreen: d.top >= 0 && d.left >= 0 && d.bottom <= window.innerHeight + 0.5 && d.right <= window.innerWidth + 0.5,
            box: [Math.round(d.left), Math.round(d.top), Math.round(d.right), Math.round(d.bottom)],
        };
    }, QUESTION);
}

/** Playwright's own check that a click on the question's confirm button would land on it (no "intercepts pointer events"). */
async function trialClick(page, name) {
    try {
        await page.locator(QUESTION).getByRole('button', typeof name === 'string' ? { name, exact: true } : { name }).click({ trial: true, timeout: 3000 });
        return '';
    } catch (e) {
        return String(e.message).split('\n').find((l) => /intercepts|not visible|outside/.test(l)) || 'not clickable';
    }
}

function checkOnTop(at, top, confirmLabel, trial) {
    check(top.open, `${at}: the question opens`);
    if (!top.open) return;
    const missed = top.buttons.filter((b) => !b.hit);
    check(top.buttons.length >= 2 && missed.length === 0, `${at}: the point at each of its buttons is that button, not what is under it`,
        missed.map((b) => `${b.label} → ${b.what}`).join('; '));
    check(trial === '', `${at}: a click on ${confirmLabel} lands on it`, trial);
    check(top.onScreen, `${at}: the question is wholly on screen`, JSON.stringify(top.box));
}

const keepers = ALL_MODALS.find((m) => m.name === 'keepers');
const { server, origin } = await startServer();
const browser = await launch();
try {
    for (const { width, textScale } of SIZES) {
        const size = `${width}px${textScale !== 1 ? ` ×${textScale}` : ''}`;

        console.log(`\nKeepers → Revoke, ${size}`);
        {
            const { context, page, errors } = await openSettings(browser, origin, { width, textScale, screen: keepers.screen });
            const revokes = [];
            page.on('request', (req) => {
                if (req.method() === 'DELETE' && /\/api\/local\/admin\/treasury\/[^/]+\/operators\/[^/]+$/.test(new URL(req.url()).pathname)) revokes.push(req.url());
            });
            await openModal(page, keepers);
            const keeperModal = page.locator('[data-bp-modal]').filter({ has: page.getByRole('button', { name: /^Revoke$/ }) }).first();
            check(await keeperModal.isVisible(), `${size}: the keepers modal is open, with a Revoke button`);
            const at = `${size} keepers Revoke`;

            await keeperModal.getByRole('button', { name: /^Revoke$/ }).first().click();
            await page.locator(QUESTION).waitFor({ timeout: 5000 }).catch(() => {});
            await settle(page);
            checkOnTop(at, await onTop(page), 'Revoke', await trialClick(page, /^Revoke$/));

            await page.keyboard.press('Escape');
            await settle(page);
            check(await page.locator(QUESTION).count() === 0 && await keeperModal.isVisible() && revokes.length === 0,
                `${at}: Escape answers "no": the question closes, the keepers modal stays, nothing is sent`, `${revokes.length} sent`);

            await keeperModal.getByRole('button', { name: /^Revoke$/ }).first().click();
            await page.locator(QUESTION).waitFor({ timeout: 5000 }).catch(() => {});
            if (await page.locator(QUESTION).count()) {
                await page.locator(QUESTION).getByRole('button', { name: /^Revoke$/ }).click({ timeout: 5000 }).catch(() => {});
            }
            await settle(page);
            check(revokes.length === 1 && await page.locator(QUESTION).count() === 0 && await keeperModal.isVisible(),
                `${at}: its Revoke sends the revoke call; the question closes and the keepers modal stays`, `${revokes.length} sent`);
            check(errors.length === 0, `${at}: no page errors`, errors.join(' | '));
            await context.close();
        }

        for (const q of PAGE_QUESTIONS) {
            const at = `${size} ${q.name}`;
            console.log(`\n${at}`);
            const { context, page, errors } = await openSettings(browser, origin, { width, textScale, screen: q.screen });
            const button = page.locator('main').getByRole('button', { name: q.button }).first();
            await button.waitFor({ state: 'visible', timeout: 10000 }).catch(() => {});
            check(await button.count() === 1, `${at}: the button that asks is on its screen`);
            if (await button.count()) {
                await button.scrollIntoViewIfNeeded();
                await button.click();
                await page.locator(QUESTION).waitFor({ timeout: 5000 }).catch(() => {});
                await settle(page);
                const confirmLabel = (await page.locator(QUESTION).getByRole('button').first().textContent().catch(() => ''))?.trim() || '';
                checkOnTop(at, await onTop(page), confirmLabel || 'its confirm button', confirmLabel ? await trialClick(page, confirmLabel) : 'no button');
                await page.keyboard.press('Escape');
                await settle(page);
                check(await page.locator(QUESTION).count() === 0, `${at}: Escape closes it`);
            }
            check(errors.length === 0, `${at}: no page errors`, errors.join(' | '));
            await context.close();
        }
    }
} finally {
    await browser.close();
    await server.close();
}

check(CSP_VIOLATIONS.length === 0, 'no page broke the node\'s content policy', JSON.stringify(CSP_VIOLATIONS.slice(0, 3)));
console.log(`\n${checks - failures.length}/${checks} checks passed`);
if (failures.length) {
    console.log(`\n${failures.length} failed:\n  ${failures.join('\n  ')}`);
    process.exit(1);
}
