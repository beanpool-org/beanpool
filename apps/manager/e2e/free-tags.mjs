#!/usr/bin/env node
/**
 * "Tags members typed" (tags F3), in the real built Settings → Moderation, dark, at 320px with 1.3× text and at desktop width.
 * The node API is answered from fixtures (the list below): nothing here talks to a real node.
 *
 * For each width, signed in as an owner: the card is drawn with each tag's counts, what members are offered and the rule; the
 * page never scrolls sideways; every button is 44px or more and holds its words; Hide sends the rule for that tag; Merge finds
 * a library tag. Screenshots go to $SHOTS_DIR (default: e2e/screenshots), named free-tags-<width>-<step>.png.
 *
 *   node e2e/free-tags.mjs
 */
/* global console, process, URL */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer, launch, openSettings, selectSubTab, settle, horizontalOverflow } from './harness.mjs';

const SHOTS = process.env.SHOTS_DIR || path.join(path.dirname(fileURLToPath(import.meta.url)), 'screenshots');
fs.mkdirSync(SHOTS, { recursive: true });
const failures = [];
const check = (ok, label, detail = '') => {
    console.log(`  ${ok ? '✓' : '✗'} ${label}${!ok && detail ? ` (${detail})` : ''}`);
    if (!ok) failures.push(label);
};

const TAGS = {
    offerAuthors: 2, offerDays: 7,
    tags: [
        { tag: 'vintage', listings: 14, authors: 6, firstSeen: '2026-10-20T10:00:00.000Z', offered: true, rule: null, mergeInto: null },
        { tag: 'limones', listings: 3, authors: 2, firstSeen: '2026-11-02T10:00:00.000Z', offered: true, rule: 'merge', mergeInto: 'food.fruit.lemon' },
        { tag: 'handed down from my grandmother', listings: 1, authors: 1, firstSeen: '2026-11-13T10:00:00.000Z', offered: false, rule: null, mergeInto: null },
        { tag: 'retro', listings: 0, authors: 0, firstSeen: null, offered: false, rule: 'hide', mergeInto: null },
    ],
};

console.log(`Shots: ${SHOTS}`);
const { server, origin } = await startServer();
const browser = await launch();
try {
    for (const [width, textScale] of [[320, 1.3], [1280, 1]]) {
        const at = `dark ${width}px ×${textScale}`;
        console.log(`\n${at}`);
        const { context, page } = await openSettings(browser, origin, {
            width, textScale, colorScheme: 'dark', signedIn: false, handoffRole: 'owner', screen: { tab: 'people' }, hash: `#handoff=${'ef'.repeat(16)}`,
            overrides: { '/api/local/admin/free-tags': () => TAGS },
        });
        await page.waitForSelector('main', { timeout: 20000 });
        await settle(page);
        await selectSubTab(page, 'moderation');
        await settle(page);
        const sent = [];
        page.on('request', (req) => { if (req.method() === 'POST' && req.url().includes('/free-tags/')) sent.push(new URL(req.url()).pathname); });
        const card = page.getByTestId('free-tags-panel');
        await card.waitFor({ timeout: 15000 });
        await card.scrollIntoViewIfNeeded();
        check(await page.getByTestId('free-tag-row').count() === 4, `${at}: every tag is listed`);
        check(await card.getByText('Merged into Lemon').isVisible(), `${at}: a merge names its library tag`);
        const o = await horizontalOverflow(page);
        check(o.scrollWidth <= o.viewport, `${at}: no sideways scroll`, o.culprits?.join('; '));
        const bad = await card.evaluate((el) => [...el.querySelectorAll('button')]
            .map((b) => ({ h: b.getBoundingClientRect().height, spill: b.scrollWidth - b.clientWidth, text: (b.textContent || '').trim().slice(0, 30) }))
            .filter(({ h, spill }) => h > 0 && (h < 43.5 || spill > 1)));
        check(bad.length === 0, `${at}: every button is 44px or more and holds its words`, JSON.stringify(bad));
        await card.screenshot({ path: path.join(SHOTS, `free-tags-${width}-card.png`) });
        await page.getByTestId('free-tag-row').nth(2).getByRole('button', { name: 'Merge into a library tag' }).click();
        await page.getByLabel('Find a library tag').fill('lemon');
        await card.getByRole('button', { name: 'Lemon', exact: true }).waitFor({ timeout: 5000 });
        await card.screenshot({ path: path.join(SHOTS, `free-tags-${width}-merge.png`) });
        await page.getByTestId('free-tag-row').first().getByRole('button', { name: 'Hide' }).click();
        await card.getByText('#vintage is no longer offered to members.').waitFor({ timeout: 5000 });
        check(sent.some((p) => p.endsWith('/api/local/admin/free-tags/vintage/hide')), `${at}: Hide sends the rule for that tag`, JSON.stringify(sent));
        await context.close();
    }
} finally {
    await browser.close();
    await server.close();
}
if (failures.length) { console.error(`\n${failures.length} failed`); process.exit(1); }
console.log('\nall passed');
