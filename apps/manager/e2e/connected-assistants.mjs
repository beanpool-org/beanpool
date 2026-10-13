#!/usr/bin/env node
/**
 * Connected assistants (admin MCP S3) on a phone: Settings → Appliance & Data → Access & Security, at 320px wide, at normal
 * and 1.3× text, with the phone set to light and to dark. The node API is answered from fixtures.mjs: nothing here talks
 * to a real node.
 *
 * For each of the four: the card is drawn and the page never scrolls sideways (the long names, the address, the token, the
 * fenced report text in "What it sees", the alerts card's line); every button on the card is at least 48px tall; and,
 * signed in with an owner's key from the app:
 *   - Connect: the token appears ONCE in the page (its secret half nowhere else: not in an attribute, a field, the command
 *     line, web storage or the page's title), and of every answer the page received, only the connect call's carried it;
 *   - Done: it is gone from the page;
 *   - an admin sees the card and their own, and is told only an owner turns assistants off.
 * Screenshots of each go to $SHOTS_DIR (default: a temp folder), named connected-assistants-<scheme>-<scale>-<step>.png.
 *
 *   node e2e/connected-assistants.mjs
 *
 * Needs Chromium for Playwright once: `pnpm --filter @beanpool/manager exec playwright install --only-shell chromium`.
 */
/* global console, process, document, window, localStorage, sessionStorage -- Node, plus page.evaluate callbacks run in the browser */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { FAKE_AGENT_TOKEN } from './fixtures.mjs';
import { startServer, launch, openSettings, selectSubTab, settle, horizontalOverflow, CSP_VIOLATIONS } from './harness.mjs';

const WIDTH = 320;
const SHOTS = process.env.SHOTS_DIR || fs.mkdtempSync(path.join(os.tmpdir(), 'bp-assistants-shots-'));
fs.mkdirSync(SHOTS, { recursive: true });
const SECRET = FAKE_AGENT_TOKEN.split('_')[2];
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

/** Every place the page could hold the secret: its markup (text and attributes), field values, title, web storage. */
async function secretCount(page) {
    return page.evaluate((secret) => {
        const count = (s) => (s ? s.split(secret).length - 1 : 0);
        const html = count(document.documentElement.outerHTML);
        const fields = [...document.querySelectorAll('input, textarea, select')].reduce((n, el) => n + count(el.value), 0);
        let storage = 0;
        try { storage = count(JSON.stringify({ ...localStorage })) + count(JSON.stringify({ ...sessionStorage })); } catch { /* none */ }
        return { html, fields, storage, title: count(document.title) };
    }, SECRET);
}

async function shot(page, name) {
    const card = page.getByTestId('connected-assistants-card');
    await card.screenshot({ path: path.join(SHOTS, `connected-assistants-${name}.png`) }).catch(() => page.screenshot({ path: path.join(SHOTS, `connected-assistants-${name}.png`), fullPage: true }));
}

/** Buttons on the card shorter than a thumb (48px). */
async function smallButtons(page) {
    return page.getByTestId('connected-assistants-card').evaluate((card) => [...card.querySelectorAll('button')]
        .map((b) => ({ h: b.getBoundingClientRect().height, text: (b.textContent || '').trim().slice(0, 30) }))
        .filter(({ h }) => h > 0 && h < 47.5));
}

async function openAs(browser, origin, { role, textScale, colorScheme }) {
    const opened = await openSettings(browser, origin, {
        width: WIDTH, textScale, colorScheme, signedIn: false, handoffRole: role, screen: { tab: 'appliance' },
        hash: `#handoff=${'ab'.repeat(16)}`,
        overrides: { '/api/local/admin/agent/grants': (json) => ({ ...json, canConnect: true, role, seesAll: role === 'owner' }) },
    });
    const { page } = opened;
    await page.waitForSelector('main', { timeout: 20000 });
    await settle(page);
    await selectSubTab(page, 'access');
    await settle(page);
    await page.getByTestId('connected-assistants-card').scrollIntoViewIfNeeded();
    return opened;
}

console.log(`Shots: ${SHOTS}`);
const { server, origin } = await startServer();
const browser = await launch();
try {
    for (const colorScheme of ['light', 'dark']) {
        for (const textScale of [1, 1.3]) {
            const at = `${colorScheme} ${WIDTH}px ×${textScale}`;
            const tag = `${colorScheme}-${textScale === 1 ? '100' : '130'}`;
            console.log(`\n${at}`);

            // ── An owner, signed in with their key from the app ──
            const { context, page, errors } = await openAs(browser, origin, { role: 'owner', textScale, colorScheme });
            const answers = [];
            page.on('response', async (res) => {
                if (!/\/api\//.test(res.url())) return;
                const text = await res.text().catch(() => '');
                answers.push({ url: `${res.request().method()} ${new URL(res.url()).pathname}`, holds: text.includes(SECRET) });
            });
            const card = page.getByTestId('connected-assistants-card');
            check(await card.isVisible(), `${at}: the card is drawn`);
            check(await page.getByRole('switch').isVisible(), `${at}: the owner has the switch`);
            let o = await horizontalOverflow(page);
            check(o.scrollWidth <= o.viewport, `${at}: no sideways scroll with the list`, o.culprits?.join('; '));
            const small = await smallButtons(page);
            check(small.length === 0, `${at}: every button on the card is 48px or more`, JSON.stringify(small));
            await shot(page, `${tag}-list`);
            const before = await secretCount(page);
            check(before.html + before.fields + before.storage === 0, `${at}: no token in the page before connecting`, JSON.stringify(before));

            await card.getByLabel('Assistant’s name').fill('Claude on my laptop');
            await card.getByRole('button', { name: 'Connect', exact: true }).click();
            await page.getByTestId('agent-token-value').waitFor();
            await settle(page);
            const shown = await secretCount(page);
            check(shown.html === 1 && shown.fields === 0 && shown.storage === 0 && shown.title === 0,
                `${at}: the token appears once in the page, in no field, no web storage`, JSON.stringify(shown));
            check(!(await page.getByTestId('agent-command').innerText()).includes(SECRET), `${at}: the command line on screen holds a placeholder`);
            const carriers = answers.filter((a) => a.holds).map((a) => a.url);
            check(carriers.length === 1 && carriers[0] === 'POST /api/local/admin/agent/grants',
                `${at}: of ${answers.length} answers, only the connect call's carried it`, carriers.join(', '));
            o = await horizontalOverflow(page);
            check(o.scrollWidth <= o.viewport, `${at}: no sideways scroll with the token shown`, o.culprits?.join('; '));
            await page.getByTestId('agent-token-shown').scrollIntoViewIfNeeded();
            await shot(page, `${tag}-token`);
            await card.getByRole('button', { name: 'Done' }).click();
            await settle(page);
            const after = await secretCount(page);
            check(after.html + after.fields + after.storage === 0, `${at}: Done takes it out of the page`, JSON.stringify(after));

            // "What it sees": a tool's answer, with fenced member text (one long unbroken word in it).
            await card.getByRole('button', { name: 'What Claude Desktop on the community hall laptop sees' }).click();
            const tools = page.getByTestId('agent-preview-tool');
            await tools.first().waitFor();
            check(await tools.count() === 3, `${at}: "What it sees" lists the assistant's tools`, String(await tools.count()));
            const reports = tools.nth(1);
            await reports.getByRole('checkbox').check();
            await reports.getByRole('button', { name: 'Show its answer' }).click();
            await reports.getByTestId('agent-preview-answer').waitFor();
            await settle(page);
            check(/MEMBER-TEXT 7f3a9c01/.test(await reports.getByTestId('agent-preview-answer').innerText()), `${at}: the answer shows the fenced text as the assistant gets it`);
            o = await horizontalOverflow(page);
            check(o.scrollWidth <= o.viewport, `${at}: no sideways scroll with a tool's answer open`, o.culprits?.join('; '));
            await reports.scrollIntoViewIfNeeded();
            await shot(page, `${tag}-preview`);

            // The alerts card's line (Backups).
            await selectSubTab(page, 'backups');
            await settle(page);
            const line = page.getByTestId('alerts-assistants');
            check(await line.isVisible() && /AI assistants today: 1234 calls · 3 connected\./.test(await line.innerText()), `${at}: the alerts card says today's assistant calls`);
            o = await horizontalOverflow(page);
            check(o.scrollWidth <= o.viewport, `${at}: no sideways scroll on Backups with the line`, o.culprits?.join('; '));
            await line.scrollIntoViewIfNeeded();
            await page.getByTestId('server-alerts').screenshot({ path: path.join(SHOTS, `connected-assistants-${tag}-alerts.png`) });
            check(errors.length === 0, `${at}: no page errors`, errors.join(' | '));
            await context.close();

            // ── An admin ──
            const admin = await openAs(browser, origin, { role: 'admin', textScale, colorScheme });
            const aCard = admin.page.getByTestId('connected-assistants-card');
            check(await aCard.isVisible() && await admin.page.getByText('Only an owner turns this on or off.').isVisible()
                && await admin.page.getByRole('switch').count() === 0, `${at}: an admin sees the card, without the switch`);
            o = await horizontalOverflow(admin.page);
            check(o.scrollWidth <= o.viewport, `${at}: no sideways scroll for the admin`, o.culprits?.join('; '));
            await shot(admin.page, `${tag}-admin`);
            await admin.context.close();
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
