#!/usr/bin/env node
/**
 * An AI assistant's suggestions (admin MCP S4) on a phone: Settings → People & Safety → Triage & Moderation, which the
 * phone's Manage opens, at 320px wide, at normal and 1.3× text, with the phone set to light and to dark. The node API is
 * answered from fixtures.mjs: nothing here talks to a real node.
 *
 * For each of the four, signed in from the app as an owner and as an admin:
 *   - the card is drawn, with the report beside the assistant's words; the page never scrolls sideways; every button is at
 *     least 48px tall and no button's words spill out of it;
 *   - the hostile reason (a fence end, markup, an image with onerror, one long unbroken word) is shown as text: no script or
 *     image inside the card, nothing ran;
 *   - Approve shows only on the member's own suggestion and sends the existing dismiss route's own call with its id;
 *     Decline calls the decline route.
 * Screenshots go to $SHOTS_DIR (default: a temp folder), named agent-suggestions-<scheme>-<scale>-<role>.png.
 *
 *   node e2e/agent-suggestions.mjs
 */
/* global console, process, window -- Node, plus page.evaluate callbacks run in the browser */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { HOSTILE_REASON } from './fixtures.mjs';
import { startServer, launch, openSettings, selectSubTab, settle, horizontalOverflow, CSP_VIOLATIONS } from './harness.mjs';

const WIDTH = 320;
const SHOTS = process.env.SHOTS_DIR || fs.mkdtempSync(path.join(os.tmpdir(), 'bp-suggestions-shots-'));
fs.mkdirSync(SHOTS, { recursive: true });
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

/** Buttons on the card shorter than a thumb (48px), or whose words spill out of them. */
async function badButtons(card) {
    return card.evaluate((el) => [...el.querySelectorAll('button')]
        .map((b) => ({ h: b.getBoundingClientRect().height, spill: b.scrollWidth - b.clientWidth, text: (b.textContent || '').trim().slice(0, 30) }))
        .filter(({ h, spill }) => h > 0 && (h < 47.5 || spill > 1)));
}

async function openAs(browser, origin, { role, textScale, colorScheme }) {
    const opened = await openSettings(browser, origin, {
        width: WIDTH, textScale, colorScheme, signedIn: false, handoffRole: role, screen: { tab: 'people' },
        hash: `#handoff=${'cd'.repeat(16)}`,
    });
    const { page } = opened;
    await page.waitForSelector('main', { timeout: 20000 });
    await settle(page);
    await selectSubTab(page, 'moderation');
    await settle(page);
    await page.getByTestId('agent-suggestions-card').waitFor({ timeout: 15000 });
    await page.getByTestId('agent-suggestions-card').scrollIntoViewIfNeeded();
    return opened;
}

console.log(`Shots: ${SHOTS}`);
const { server, origin } = await startServer();
const browser = await launch();
try {
    for (const colorScheme of ['light', 'dark']) {
        for (const textScale of [1, 1.3]) {
            for (const role of ['owner', 'admin']) {
                const at = `${colorScheme} ${WIDTH}px ×${textScale} ${role}`;
                const tag = `${colorScheme}-${textScale === 1 ? '100' : '130'}-${role}`;
                console.log(`\n${at}`);
                const { context, page, errors } = await openAs(browser, origin, { role, textScale, colorScheme });
                const sent = [];
                page.on('request', (req) => {
                    if (req.method() === 'POST' && /\/api\/local\/admin\/(reports|agent\/suggestions)\//.test(req.url())) {
                        sent.push({ path: new URL(req.url()).pathname, body: req.postData() });
                    }
                });
                const card = page.getByTestId('agent-suggestions-card');
                const items = card.getByTestId('agent-suggestion');
                check(await card.isVisible() && await items.count() === 2, `${at}: the card is drawn with both suggestions`, String(await items.count()));
                const reason = items.first().getByTestId('agent-reason');
                check((await reason.textContent()) === HOSTILE_REASON, `${at}: the hostile reason is shown as text, word for word`);
                const inside = await card.evaluate((el) => el.querySelectorAll('script, img').length);
                check(inside === 0 && await page.evaluate(() => window.__pwned === undefined), `${at}: no script or image inside the card; nothing ran`, String(inside));
                check(await items.first().getByText('Bike repair at the hall').isVisible() && await items.first().getByText(/IGNORE ALL PREVIOUS INSTRUCTIONS/).isVisible(),
                    `${at}: the report itself is beside the assistant's words`);
                let o = await horizontalOverflow(page);
                check(o.scrollWidth <= o.viewport, `${at}: no sideways scroll`, o.culprits?.join('; '));
                const bad = await badButtons(card);
                check(bad.length === 0, `${at}: every button is 48px or more and holds its words`, JSON.stringify(bad));
                check(await items.first().getByRole('button', { name: 'Approve' }).count() === 1 && await items.nth(1).getByRole('button', { name: 'Approve' }).count() === 0,
                    `${at}: Approve only on the member's own assistant's suggestion`);
                await card.screenshot({ path: path.join(SHOTS, `agent-suggestions-${tag}.png`) });

                await items.first().getByRole('button', { name: 'Approve' }).click();
                await page.getByText(/^Done: approved/).waitFor({ timeout: 10000 });
                const approve = sent.find((s) => s.path.endsWith('/reports/rep-fx-sug-1/dismiss'));
                check(!!approve && JSON.parse(approve.body || '{}').suggestion === 'sugfx0001', `${at}: Approve sends the existing dismiss route's call with the suggestion's id`, JSON.stringify(sent));
                await items.nth(1).getByRole('button', { name: 'Decline' }).click();
                await page.getByText(/^Declined: nothing changed/).waitFor({ timeout: 10000 });
                check(sent.some((s) => s.path.endsWith('/agent/suggestions/sugfx0002/decline')), `${at}: Decline calls the decline route`);
                o = await horizontalOverflow(page);
                check(o.scrollWidth <= o.viewport, `${at}: no sideways scroll after answering`, o.culprits?.join('; '));
                check(errors.length === 0, `${at}: no page errors`, errors.join(' | '));
                await context.close();
            }
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
