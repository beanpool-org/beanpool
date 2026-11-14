/* eslint-disable no-undef */
// (slice K7) "Learn something local" on the web's Home and the community card's "{n} things worth knowing", in a real browser:
// node apps/pwa/e2e/learn-home-shots.mjs [--out <dir>]
//
// The real HomePage (e2e/learn-home-harness.tsx, in ?lang=), every /api call answered here, nothing leaves the machine. A Home arranged
// before Learn (the card arrives after the member's own cards, with Keep on Home), at 320 px wide with text at 1.3x and at
// 1280 px, light and dark, in English and in Tamil (a long language): no sideways scroll, every row, See all, Keep on Home
// and the figure at least 44 px tall and inside its card, no words cut. Shots of the two cards.
import { createServer } from 'vite';
import { chromium } from 'playwright';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';

const PWA_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
process.chdir(PWA_DIR);
const argAt = (flag) => { const i = process.argv.indexOf(flag); return i > 0 ? process.argv[i + 1] : null; };
const OUT_DIR = path.resolve(argAt('--out') ?? path.join(PWA_DIR, 'e2e', 'screenshots', 'learn-home'));
fs.mkdirSync(OUT_DIR, { recursive: true });
setTimeout(() => { console.error('\nStopped after 300 s, not finished.'); process.exit(2); }, 300_000).unref();

const failures = [];
const check = (ok, what) => { if (ok) console.log(`  ok ${what}`); else { failures.push(what); console.error(`  x ${what}`); } };

const NOW = Date.now();
const H = 3_600_000;
const row = (id, title, topic, isNew) => ({
    id, title, line: 'Bring your own bags; the green bin takes glass, paper and cans, and the yellow one everything else.', topic, photo: null,
    checkedAt: new Date(NOW - 20 * 24 * H).toISOString(), helped: 4, pinned: false, outdated: false, ...(isNew ? { isNew: true } : {}),
});
const answer = () => ({
    generatedAt: new Date(NOW).toISOString(), profile: 'local',
    features: { beans: true, escrow: true, enterprises: true, invites: true, decisions: true, guestListingsOnly: false, knowledge: true },
    me: { joinedAt: new Date(NOW - 30 * 24 * H).toISOString(), isKeeper: false, probation: null, interests: ['arts'], area: null, firstOffer: true, standing: 'member', tour: { v: 1, state: 'skipped', at: '2026-10-01T00:00:00.000Z' } },
    // Arranged before Learn something local: the card arrives after these.
    layout: { v: 2, cards: ['market', 'events'].map((t) => ({ id: t, type: t })), dismissed: {}, updatedAt: '2026-11-01T00:00:00.000Z' },
    cards: {
        events: { items: [{ id: 'e0', title: 'Seed swap', startsAt: new Date(NOW + 86_400_000).toISOString(), endsAt: null, place: 'Town Hall', rsvp: null }], radiusKm: null },
        market: { items: [{ id: 'p0', type: 'offer', title: 'Pottery lessons', category: 'arts', price_c: 1000, photoUrl: null }], total14d: 1, more: false },
        learn: { rows: [
            row('k1', 'How recycling works at the tip, and what the weighbridge charges on a Saturday morning', 'local-services', true),
            row('k2', 'Bins day', 'local-services'),
            row('k3', 'Who to call when the river comes up', 'emergencies'),
        ] },
        community: { name: 'Riverside', members: 81, tradesThisMonth: 23, knowledge: 6 },
    },
});

const server = await createServer({ configFile: path.join(PWA_DIR, 'vite.config.ts'), root: PWA_DIR, server: { port: 0 }, logLevel: 'error' });
await server.listen();
const base = `http://localhost:${server.httpServer.address().port}/e2e/learn-home-harness.html`;
const browser = await chromium.launch();

async function open({ width, dark, textScale, lang }) {
    const context = await browser.newContext({ viewport: { width, height: 1400 }, colorScheme: dark ? 'dark' : 'light', reducedMotion: 'reduce' });
    await context.addInitScript(([mode, language]) => {
        try { localStorage.setItem('beanpool-theme-mode', mode); localStorage.setItem('beanpool-language', language); } catch { /* defaults still draw */ }
    }, [dark ? 'dark' : 'light', lang]);
    await context.route('**/api/**', (route) => {
        const url = new URL(route.request().url());
        if (url.pathname !== '/api/home') return route.fulfill({ status: 404, contentType: 'application/json', body: '{"error":"Not Found"}' });
        return route.fulfill({ status: 200, contentType: 'application/json', headers: { ETag: 'W/"learn-1"' }, body: JSON.stringify(answer()) }).catch(() => {});
    });
    await context.route('**/socket.io/**', (route) => route.abort());
    const page = await context.newPage();
    page.setDefaultTimeout(30_000);
    page.on('pageerror', (e) => failures.push(`page error: ${e}`));
    await page.goto(`${base}?lang=${lang}`, { waitUntil: "load" });
    if (textScale !== 1) await page.addStyleTag({ content: `html { font-size: ${textScale * 100}% !important; }` });
    await page.waitForSelector('[data-testid="home-card-learn"]', { timeout: 60_000 });
    await settle(page);
    return { context, page };
}
const settle = (page) => page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(r, 300)))));

/** Each target's height, whether it stays inside its card, and whether any of its words are cut. */
const targets = (page, card, sel) => page.evaluate(([cardSel, s]) => {
    const box = document.querySelector(cardSel).getBoundingClientRect();
    return Array.from(document.querySelectorAll(`${cardSel} ${s}`)).map((el) => {
        const r = el.getBoundingClientRect();
        const words = Array.from(el.querySelectorAll('span')).filter((x) => x.children.length === 0 && x.textContent.trim() && !x.className.includes('truncate') && !x.className.includes('line-clamp'));
        return { id: el.getAttribute('data-testid'), h: Math.round(r.height), inside: r.left >= box.left - 0.5 && r.right <= box.right + 0.5, cut: words.some((x) => x.scrollWidth > x.clientWidth + 1) };
    });
}, [card, sel]);

try {
    for (const [width, textScale, size, langs] of [[320, 1.3, '320', ['en', 'ta']], [1280, 1, 'desktop', ['en']]]) {
        for (const lang of langs) {
            for (const dark of [false, true]) {
                const label = `${size}-${lang}-${dark ? 'dark' : 'light'}`;
                const { context, page } = await open({ width, dark, textScale, lang });
                check(!(await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth)), `${label}: Home does not scroll sideways`);
                const order = await page.evaluate(() => Array.from(document.querySelectorAll('[data-testid^="home-card-"]')).map((e) => e.getAttribute('data-testid').replace('home-card-', '')).filter((id) => id !== 'menu'));
                check(order.join(',') === 'market,events,learn,community', `${label}: it arrives after the member's own cards (${order.join(', ')})`);
                const learn = await targets(page, '[data-testid="home-card-learn"]', '[data-testid^="home-learn-"]:not([data-testid="home-learn-rows"])');
                check(learn.length === 5, `${label}: three rows, See all and Keep on Home (${learn.map((t) => t.id).join(', ')})`);
                check(learn.every((t) => t.h >= 44), `${label}: every target is at least 44 px tall (least ${Math.min(...learn.map((t) => t.h))} px)`);
                check(learn.every((t) => t.inside && !t.cut), `${label}: every target stays inside the card, no words cut (${learn.filter((t) => !t.inside || t.cut).map((t) => `${t.id}${t.inside ? '' : ' outside'}${t.cut ? ' cut' : ''}`).join(', ') || 'all'})`);
                const figure = await targets(page, '[data-testid="home-card-community"]', '[data-testid="home-community-learn"]');
                check(figure.length === 1 && figure[0].h >= 44 && figure[0].inside && !figure[0].cut, `${label}: the figure is one target of at least 44 px, inside, whole (${figure[0]?.h} px)`);
                await page.getByTestId('home-card-learn').screenshot({ path: path.join(OUT_DIR, `learn-${label}.png`) });
                await page.getByTestId('home-card-community').screenshot({ path: path.join(OUT_DIR, `community-${label}.png`) });
                await context.close();
            }
        }
    }
} finally {
    await browser.close();
    await server.close();
}
if (failures.length) { console.error(`\n${failures.length} problem(s)`); process.exit(1); }
console.log(`\nShots in ${OUT_DIR}`);
