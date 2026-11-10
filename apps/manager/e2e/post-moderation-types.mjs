#!/usr/bin/env node
/**
 * The posts screen (Settings → People → Moderation): its Type Filter, the per-type chips and the "taken down" line with Put back
 * (MCP-MODERATION S4), in the real built Settings, at 320px with 1.3× text and at 100%, in light and in dark, and at desktop width.
 * The node API is answered from fixtures.mjs plus this file's own posts: nothing here talks to a real node.
 *
 * For each way of looking, signed in from the app as an owner:
 *  - the Type Filter offers All, Offers, Needs, Events, Polls and Shown from another community, and each picks the right rows
 *    (a copy of an event is an event and a copy);
 *  - each type's chip is a different colour from the central roles, and every chip, the taken-down line and Put back read at
 *    4.5:1 or better as the browser draws them (computed colours, not class names);
 *  - the posts an assistant took down say who, that they are hidden now and the day they go for good; the one left hidden says why;
 *  - an assistant's hostile name is text: no script or image inside the list, nothing ran;
 *  - the page never scrolls sideways, no line or button runs past its row, every button is 44px or more and holds its words;
 *  - Put back sends the one post; an admin sees it too.
 * Screenshots go to $SHOTS_DIR (default: e2e/screenshots), named post-types-<scheme>-<width>-<step>.png.
 *
 *   node e2e/post-moderation-types.mjs
 */
/* global console, process, window, document, getComputedStyle, URL -- Node, plus page.evaluate callbacks run in the browser */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { agentTakedowns } from './fixtures.mjs';
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

const HOSTILE_NAME = '<img src=x onerror="window.__pwned=1"> <script>window.__pwned=1</script> Spam sweeper on my very long laptop name';
const LONG_WORD = 'Supercalifragilisticexpialidocious'.repeat(3);
const owner = (n) => ({ authorCallsign: `Member ${n}`, authorPublicKey: `pk-${n}`, createdAt: '2026-11-02T04:10:00.000Z' });

/** What the posts screen is shown: one of each type, two copies, and the two posts the fixtures' assistant took down. */
const POSTS = [
    { id: 'post-e2e-offer', type: 'offer', title: 'Split firewood, one trailer load', category: 'tools', price_c: 4500, ...owner(1) },
    { id: 'post-e2e-need', type: 'need', title: 'A hand moving a fridge', category: 'labour', price_c: 0, ...owner(2) },
    { id: 'post-e2e-event', type: 'event', title: 'Seed swap at the hall', category: 'garden', ...owner(3) },
    { id: 'post-e2e-poll', type: 'poll', title: 'Which night suits the market?', category: 'general', ...owner(4) },
    { id: 'post-e2e-copy-event', type: 'event', title: 'Harvest picnic in the next town', category: 'food', shownCopy: true, authorCallsign: '', createdAt: '2026-11-02T04:10:00.000Z' },
    { id: 'post-e2e-copy-offer', type: 'offer', title: LONG_WORD, category: 'food', shownCopy: true, shownFrom: { name: 'Castlemaine' }, authorCallsign: '', createdAt: '2026-11-02T04:10:00.000Z' },
    { id: 'post-fx-td-1', type: 'offer', title: 'Cheap watches, brand new, unbelievably low prices for this weekend only', category: 'goods', hiddenByReportsAt: '2026-11-03T10:00:00.000Z', ...owner(5) },
    { id: 'post-fx-td-2', type: 'event', title: 'Fake meet-up at the hall', category: 'general', hiddenByReportsAt: '2026-11-03T10:00:00.000Z', ...owner(5) },
];

const withTakedowns = (json) => {
    const base = agentTakedowns('looks like spam');
    return {
        ...json,
        takedowns: base.takedowns.map((t) => ({
            ...t,
            grantName: HOSTILE_NAME,
            posts: t.posts.map((p) => (p.id === 'post-fx-td-2' ? { ...p, leftFor: 'deal' } : p)),
        })),
    };
};

async function openAs(browser, origin, { role, width, textScale, colorScheme }) {
    const opened = await openSettings(browser, origin, {
        width, textScale, colorScheme, signedIn: false, handoffRole: role, screen: { tab: 'people' }, hash: `#handoff=${'ab'.repeat(16)}`,
        overrides: {
            '/api/local/admin/data': (json) => ({ ...json, posts: POSTS }),
            '/api/local/admin/agent/takedowns': withTakedowns,
        },
    });
    await opened.page.waitForSelector('main', { timeout: 20000 });
    await settle(opened.page);
    await selectSubTab(opened.page, 'moderation');
    await settle(opened.page);
    return opened;
}

/** The posts card: the one holding the Type Filter. */
const cardOf = (page) => page.locator('#admin-post-type-filter').locator('xpath=ancestor::div[contains(@class,"rounded-2xl")][1]');

/** WCAG contrast of each element's words on its own background, as the browser computed them. */
async function contrastOf(card, selector) {
    return card.evaluate((el, sel) => {
        const parse = (c) => (c.match(/[\d.]+/g) || []).map(Number);
        const lum = ([r, g, b]) => {
            const f = (v) => { const s = v / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; };
            return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
        };
        return [...el.querySelectorAll(sel)].map((n) => {
            const cs = getComputedStyle(n);
            const fg = parse(cs.color);
            const bg = parse(cs.backgroundColor);
            const [hi, lo] = [lum(fg), lum(bg)].sort((a, b) => b - a);
            return { text: (n.textContent || '').trim().slice(0, 28), bg: cs.backgroundColor, alpha: bg.length > 3 ? bg[3] : 1, ratio: (hi + 0.05) / (lo + 0.05) };
        });
    }, selector);
}

/** `touch`: a phone, where a button must be a thumb tall (44px). On a desktop only words that spill are judged. */
async function badBoxes(card, touch) {
    return card.evaluate((el, touchTargets) => {
        const box = el.getBoundingClientRect();
        const out = [];
        for (const b of el.querySelectorAll('button, select')) {
            const r = b.getBoundingClientRect();
            if (r.height === 0) continue;
            if (touchTargets && r.height < 43.5) out.push(`${b.tagName.toLowerCase()} "${(b.textContent || '').trim().slice(0, 24)}" is ${Math.round(r.height)}px tall`);
            if (b.scrollWidth - b.clientWidth > 1 && b.tagName === 'BUTTON') out.push(`button "${(b.textContent || '').trim().slice(0, 24)}" spills its words`);
        }
        for (const t of el.querySelectorAll('[data-testid="post-taken-down"], [data-testid="post-type-chip"], [data-testid="post-copy-chip"], h4')) {
            const r = t.getBoundingClientRect();
            if (r.width > 0 && r.right > box.right + 0.5) out.push(`${t.getAttribute('data-testid') || t.tagName} runs ${Math.round(r.right - box.right)}px past the card`);
        }
        return out;
    }, touch);
}

console.log(`Shots: ${SHOTS}`);
const { server, origin } = await startServer();
const browser = await launch();
try {
    const LOOKS = [
        { colorScheme: 'light', width: 320, textScale: 1.3 },
        { colorScheme: 'dark', width: 320, textScale: 1.3 },
        { colorScheme: 'light', width: 320, textScale: 1 },
        { colorScheme: 'dark', width: 320, textScale: 1 },
        { colorScheme: 'dark', width: 1280, textScale: 1 },
    ];
    const seen = {};
    for (const { colorScheme, width, textScale } of LOOKS) {
        const at = `${colorScheme} ${width}px ×${textScale}`;
        const tag = `post-types-${colorScheme}-${width}${textScale === 1 ? '' : '-130'}`;
        console.log(`\n${at}`);
        const { context, page, errors } = await openAs(browser, origin, { role: 'owner', width, textScale, colorScheme });
        const sent = [];
        page.on('request', (req) => {
            if (req.method() === 'POST' && req.url().includes('/agent/takedowns/')) sent.push({ path: new URL(req.url()).pathname, body: req.postData() });
        });
        const card = cardOf(page);
        await card.waitFor({ timeout: 15000 });
        await page.getByTestId('post-taken-down').first().waitFor({ timeout: 15000 });
        await card.scrollIntoViewIfNeeded();

        // The Type Filter.
        const options = await page.locator('#admin-post-type-filter option').allTextContents();
        check(JSON.stringify(options) === JSON.stringify(['All Types', 'Offers', 'Needs', 'Events', 'Polls', 'Shown from another community']),
            `${at}: the Type Filter offers All, Offers, Needs, Events, Polls and Shown from another community`, JSON.stringify(options));
        const count = async () => (await page.locator('#post-count-label').textContent()).trim();
        const titles = async () => (await page.locator('#admin-posts-list h4').allTextContents()).map((s) => s.trim());
        check(await count() === `${POSTS.length} of ${POSTS.length} posts`, `${at}: every type is listed under All Types`, await count());
        await page.selectOption('#admin-post-type-filter', 'event');
        const events = await titles();
        check(events.length === 3 && events.includes('Seed swap at the hall') && events.includes('Harvest picnic in the next town') && events.includes('Fake meet-up at the hall'),
            `${at}: Events picks the events, a copy of one included`, JSON.stringify(events));
        await page.selectOption('#admin-post-type-filter', 'poll');
        check(JSON.stringify(await titles()) === JSON.stringify(['Which night suits the market?']), `${at}: Polls picks the poll`, JSON.stringify(await titles()));
        await page.selectOption('#admin-post-type-filter', 'copy');
        const copies = await titles();
        check(copies.length === 2 && copies.includes('Harvest picnic in the next town') && copies.includes(LONG_WORD), `${at}: Shown from another community picks the two copies, whatever they copy`, JSON.stringify(copies));
        check(await page.getByTestId('post-copy-chip').count() === 2, `${at}: each copy says so on its row`);
        await page.selectOption('#admin-post-type-filter', 'need');
        check(JSON.stringify(await titles()) === JSON.stringify(['A hand moving a fridge']), `${at}: Needs still picks the Need`);
        await page.selectOption('#admin-post-type-filter', 'all');

        // Chips: one colour per type, and readable as drawn.
        const chipBg = async (title) => page.locator('#admin-posts-list h4', { hasText: title }).locator('xpath=preceding-sibling::span[@data-testid="post-type-chip"]').evaluate((n) => getComputedStyle(n).backgroundColor);
        const colours = {
            offer: await chipBg('Split firewood'), need: await chipBg('A hand moving'), event: await chipBg('Seed swap'), poll: await chipBg('Which night'),
        };
        check(new Set(Object.values(colours)).size === 4, `${at}: Offer, Need, event and poll chips are four different colours`, JSON.stringify(colours));
        seen[at] = colours;
        const chips = await contrastOf(card, '[data-testid="post-type-chip"], [data-testid="post-copy-chip"]');
        const lowChips = chips.filter((c) => c.ratio < 4.5 || c.alpha < 1);
        check(chips.length >= 8 && lowChips.length === 0, `${at}: every chip is words on an opaque tint at 4.5:1 or better (${chips.length} chips, lowest ${Math.min(...chips.map((c) => c.ratio)).toFixed(2)})`, JSON.stringify(lowChips));
        const lines = await contrastOf(card, '[data-testid="post-taken-down"], [data-testid="post-put-back"]');
        const lowLines = lines.filter((c) => c.ratio < 4.5);
        check(lines.length === 4 && lowLines.length === 0, `${at}: the taken-down lines and Put back read at 4.5:1 or better (lowest ${Math.min(...lines.map((c) => c.ratio)).toFixed(2)})`, JSON.stringify(lowLines));

        // The taken-down line.
        const downLines = await page.getByTestId('post-taken-down').allTextContents();
        check(downLines.length === 2, `${at}: the two posts the assistant took down say so`, String(downLines.length));
        check(downLines.some((t) => /^Taken down by .*Spam sweeper on my very long laptop name: hidden now, and removed for good on .+ unless put back\.$/.test(t)),
            `${at}: a hidden post says who, that it is hidden now and the day it goes for good`, JSON.stringify(downLines));
        check(downLines.some((t) => /left hidden, because a deal is in escrow\. It is not removed for good until a person decides\.$/.test(t)), `${at}: the post left hidden says why`);
        const inside = await card.evaluate((el) => el.querySelectorAll('script, img').length);
        check(inside === 0 && await page.evaluate(() => window.__pwned === undefined), `${at}: the assistant's hostile name is text: no script or image inside; nothing ran`, String(inside));
        check(await page.getByTestId('post-put-back').count() === 2, `${at}: Put back is on those two rows and no others`);

        const o = await horizontalOverflow(page);
        check(o.scrollWidth <= o.viewport, `${at}: no sideways scroll`, o.culprits?.join('; '));
        const bad = await badBoxes(card, width < 600);
        check(bad.length === 0, `${at}: no line or chip runs past its card, ${width < 600 ? 'every button is 44px or more and ' : ''}every button holds its words`, bad.join('; '));
        // The list scrolls inside its card: each picture is of rows scrolled into view.
        const rowOf = (testId) => page.getByTestId(testId).first().locator('xpath=ancestor::div[contains(@class,"flex-col")][1]');
        await page.getByTestId('post-taken-down').first().scrollIntoViewIfNeeded();
        await rowOf('post-taken-down').screenshot({ path: path.join(SHOTS, `${tag}-taken-down.png`) });
        await page.getByTestId('post-taken-down').nth(1).locator('xpath=ancestor::div[contains(@class,"flex-col")][1]').screenshot({ path: path.join(SHOTS, `${tag}-left-hidden.png`) });
        await page.selectOption('#admin-post-type-filter', 'copy');
        await page.getByTestId('post-copy-chip').first().scrollIntoViewIfNeeded();
        await card.screenshot({ path: path.join(SHOTS, `${tag}-copies.png`) });
        await page.selectOption('#admin-post-type-filter', 'event');
        await card.screenshot({ path: path.join(SHOTS, `${tag}-events.png`) });
        await page.selectOption('#admin-post-type-filter', 'all');

        // The manager sets class="dark" on the page, so a light phone draws the dark set. The light set is the library's own, and it
        // is what any screen would draw if that class went: read it here, from the same chips and lines, so it is judged where it is used.
        if (colorScheme === 'light') {
            await page.evaluate(() => document.documentElement.classList.remove('dark'));
            const lightChips = await contrastOf(card, '[data-testid="post-type-chip"], [data-testid="post-copy-chip"]');
            const lightLines = await contrastOf(card, '[data-testid="post-taken-down"], [data-testid="post-put-back"]');
            const lightAll = [...lightChips, ...lightLines];
            const lowLight = lightAll.filter((c) => c.ratio < 4.5 || c.alpha < 1);
            const differs = JSON.stringify(lightChips.map((c) => c.bg)) !== JSON.stringify(chips.map((c) => c.bg));
            check(differs && lowLight.length === 0, `${at}: with the light set (class "dark" removed) the chips and lines are other colours and still read at 4.5:1 or better (lowest ${Math.min(...lightAll.map((c) => c.ratio)).toFixed(2)})`, JSON.stringify(lowLight));
            await page.evaluate(() => document.documentElement.classList.add('dark'));
        }

        await page.getByTestId('post-put-back').first().click();
        // The banner draws a tick before the words.
        await page.getByRole('status').filter({ hasText: /Put back: its author is told, and everyone sees it again\./ }).waitFor({ timeout: 10000 });
        check(sent.length === 1 && sent[0].path.endsWith('/agent/takedowns/put-back') && JSON.parse(sent[0].body || '{}').postId === 'post-fx-td-1',
            `${at}: Put back sends the one post to the takedowns route`, JSON.stringify(sent));
        check(errors.length === 0, `${at}: no page errors`, errors.join(' | '));
        await context.close();
    }
    console.log('\nChip colours as drawn (the manager sets class="dark" on the page, so a light phone gets the same set):');
    for (const [at, colours] of Object.entries(seen)) console.log(`  ${at}: ${JSON.stringify(colours)}`);

    const asAdmin = await openAs(browser, origin, { role: 'admin', width: 320, textScale: 1.3, colorScheme: 'light' });
    await asAdmin.page.getByTestId('post-taken-down').first().waitFor({ timeout: 15000 });
    check(await asAdmin.page.getByTestId('post-put-back').count() === 2, 'light 320px ×1.3 admin: an admin sees the taken-down lines and Put back');
    await asAdmin.context.close();
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
