#!/usr/bin/env node
/**
 * "Taken down by assistants" and the tick "May take down posts for me" (MCP-MODERATION S1), in the real built Settings, dark, at
 * 320px with 1.3× text and at desktop width. The node API is answered from fixtures.mjs: nothing here talks to a real node.
 *
 * For each width, signed in from the app as an owner: the card is drawn; the assistant's hostile words are text (no script or image
 * inside, nothing ran); the page never scrolls sideways; every button is 48px or more and holds its words; Put back sends the one
 * post; an admin sees no whole-call button. The tick is on the token form, off until ticked.
 * Screenshots go to $SHOTS_DIR (default: e2e/screenshots), named takedowns-<width>-<step>.png.
 *
 *   node e2e/assistant-takedowns.mjs
 */
/* global console, process, window, URL -- Node, plus page.evaluate callbacks run in the browser */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { HOSTILE_REASON } from './fixtures.mjs';
import { startServer, launch, openSettings, selectSubTab, settle, horizontalOverflow, CSP_VIOLATIONS } from './harness.mjs';

const SHOTS = process.env.SHOTS_DIR || path.join(path.dirname(fileURLToPath(import.meta.url)), 'screenshots');
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

async function badButtons(card) {
    return card.evaluate((el) => [...el.querySelectorAll('button')]
        .map((b) => ({ h: b.getBoundingClientRect().height, spill: b.scrollWidth - b.clientWidth, text: (b.textContent || '').trim().slice(0, 30) }))
        .filter(({ h, spill }) => h > 0 && (h < 47.5 || spill > 1)));
}

async function openAs(browser, origin, { role, width, textScale, tab, sub }) {
    const opened = await openSettings(browser, origin, {
        width, textScale, colorScheme: 'dark', signedIn: false, handoffRole: role, screen: { tab }, hash: `#handoff=${'ef'.repeat(16)}`,
        overrides: {
            '/api/local/admin/agent/grants': (json) => ({ ...json, canConnect: role === 'owner', role, seesAll: role === 'owner' }),
            '/api/local/admin/agent/takedowns': (json) => ({ ...json, canActOnMany: role === 'owner' }),
        },
    });
    await opened.page.waitForSelector('main', { timeout: 20000 });
    await settle(opened.page);
    await selectSubTab(opened.page, sub);
    await settle(opened.page);
    return opened;
}

console.log(`Shots: ${SHOTS}`);
const { server, origin } = await startServer();
const browser = await launch();
try {
    for (const [width, textScale] of [[320, 1.3], [1280, 1]]) {
        const at = `dark ${width}px ×${textScale}`;
        console.log(`\n${at}`);
        const { context, page, errors } = await openAs(browser, origin, { role: 'owner', width, textScale, tab: 'people', sub: 'moderation' });
        const sent = [];
        page.on('request', (req) => {
            if (req.method() === 'POST' && req.url().includes('/agent/takedowns/')) sent.push({ path: new URL(req.url()).pathname, body: req.postData() });
        });
        const card = page.getByTestId('agent-takedowns-card');
        await card.waitFor({ timeout: 15000 });
        await card.scrollIntoViewIfNeeded();
        check(await page.getByTestId('agent-takedown').count() === 2, `${at}: both calls are listed`);
        check((await page.getByTestId('agent-takedown-why').first().textContent()) === HOSTILE_REASON, `${at}: the assistant's hostile words are shown as text, word for word`);
        await page.getByRole('button', { name: 'Show its posts' }).first().click();
        await settle(page);
        check(await page.getByTestId('agent-takedown-post').count() === 3, `${at}: a call opens to its posts`);
        check(await page.getByText(/Left hidden: a deal in escrow/).isVisible(), `${at}: a post held by a deal says so`);
        const inside = await card.evaluate((el) => el.querySelectorAll('script, img').length);
        check(inside === 0 && await page.evaluate(() => window.__pwned === undefined), `${at}: no script or image inside the card; nothing ran`, String(inside));
        let o = await horizontalOverflow(page);
        check(o.scrollWidth <= o.viewport, `${at}: no sideways scroll`, o.culprits?.join('; '));
        const bad = await badButtons(card);
        check(bad.length === 0, `${at}: every button is 48px or more and holds its words`, JSON.stringify(bad));
        await card.screenshot({ path: path.join(SHOTS, `takedowns-${width}-card.png`) });
        await page.getByTestId('agent-takedown-put-back').first().click();
        await page.getByText(/^Put back: 1 post/).waitFor({ timeout: 10000 });
        check(sent.some((s) => s.path.endsWith('/agent/takedowns/put-back') && JSON.parse(s.body || '{}').postId === 'post-fx-td-1'), `${at}: Put back sends the one post`, JSON.stringify(sent));
        check(errors.length === 0, `${at}: no page errors`, errors.join(' | '));
        await context.close();

        const asAdmin = await openAs(browser, origin, { role: 'admin', width, textScale, tab: 'people', sub: 'moderation' });
        await asAdmin.page.getByTestId('agent-takedowns-card').waitFor({ timeout: 15000 });
        check(await asAdmin.page.getByTestId('agent-takedown-put-back-call').count() === 0, `${at}: an admin sees no whole-call button`);
        await asAdmin.context.close();

        const tick = await openAs(browser, origin, { role: 'owner', width, textScale, tab: 'appliance', sub: 'access' });
        const box = tick.page.getByTestId('agent-can-moderate');
        await box.waitFor({ timeout: 15000 });
        await box.scrollIntoViewIfNeeded();
        check(!(await box.isChecked()), `${at}: the tick is off until ticked`);
        o = await horizontalOverflow(tick.page);
        check(o.scrollWidth <= o.viewport, `${at}: no sideways scroll on the form`, o.culprits?.join('; '));
        const form = box.locator('xpath=ancestor::label');
        await form.screenshot({ path: path.join(SHOTS, `takedowns-${width}-tick.png`) });
        await tick.page.screenshot({ path: path.join(SHOTS, `takedowns-${width}-tick-page.png`) });
        await tick.context.close();
    }
} finally {
    await browser.close();
    await server.close();
}
check(CSP_VIOLATIONS.length === 0, 'no content-security-policy violations', JSON.stringify(CSP_VIOLATIONS.slice(0, 3)));
console.log(`\n${checks - failures.length}/${checks} checks passed`);
if (failures.length) {
    console.error(failures.map((f) => `  ✗ ${f}`).join('\n'));
    process.exit(1);
}
process.exit(0);
