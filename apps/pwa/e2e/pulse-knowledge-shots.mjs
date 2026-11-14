/* eslint-disable no-undef */
// (slice KP) Local knowledge's card on the web's Pulse, between two creators' cards, in a real browser:
// node apps/pwa/e2e/pulse-knowledge-shots.mjs [--out <dir>]
//
// The real PulsePage (e2e/pulse-knowledge-harness.tsx, in ?lang=), every /api call answered here, nothing leaves the machine. One
// page (head, topic chip, row with "by {name}", foot) and several the same day (three rows, "and {n} more ›", foot), at 320 px wide
// with text at 1.3x (in English and in the pseudo-locale, ~35 % longer) and at 1280 px, light and dark: the feed asks with=knowledge,
// the card sits between the two creators' cards, no sideways scroll, every target at least 44 px tall and inside its card, no words
// cut. Shots of the card between its neighbours.
import { createServer } from 'vite';
import { chromium } from 'playwright';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';

const PWA_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
process.chdir(PWA_DIR);
const argAt = (flag) => { const i = process.argv.indexOf(flag); return i > 0 ? process.argv[i + 1] : null; };
const OUT_DIR = path.resolve(argAt('--out') ?? path.join(PWA_DIR, 'e2e', 'screenshots', 'pulse-knowledge'));
fs.mkdirSync(OUT_DIR, { recursive: true });
setTimeout(() => { console.error('\nStopped after 300 s, not finished.'); process.exit(2); }, 300_000).unref();

const failures = [];
const check = (ok, what) => { if (ok) console.log(`  ok ${what}`); else { failures.push(what); console.error(`  x ${what}`); } };

const NOW = Date.now();
const H = 3_600_000;
const creator = (id, title, callsign, hoursAgo) => ({
    id, ownerPubkey: id.repeat(64).slice(0, 64), callsign, avatarUrl: 'bundled://leaf', platform: 'youtube', category: 'food',
    url: `https://www.youtube.com/watch?v=${id}`, title, thumbnailUrl: null, publishedAt: new Date(NOW - hoursAgo * H).toISOString(),
    source: 'oauth', isVerified: true,
});
const page = (id, title, topic, by = null) => ({
    id, title, topic, line: 'Bring your own bags; the green bin takes glass, paper and cans, and the yellow one everything else.',
    photo: null, by, gathered: false,
});
const know = (posts, count) => ({
    id: 'know_2026-11-15', source: 'knowledge', platform: 'beanpool', category: 'knowledge', url: null, thumbnailUrl: null,
    ownerPubkey: '', callsign: '', avatarUrl: null, isVerified: false, title: posts[0].title,
    publishedAt: new Date(NOW - 2 * H).toISOString(), knowledge: { count, posts },
});
const CARDS = {
    single: know([page('k1', 'How recycling works at the tip, and what the weighbridge charges on a Saturday morning', 'local-services', 'Riverside Ana')], 1),
    grouped: know([
        page('k1', 'How recycling works at the tip, and what the weighbridge charges on a Saturday morning', 'local-services'),
        page('k2', 'Who to call when the river comes up', 'emergencies'),
        page('k3', 'Bus times to the station on weekends', 'getting-around'),
    ], 8),
};
const feed = (kind) => ({
    items: [
        creator('b1', 'Seed saving at the hall: what to bring and how to dry them', 'GreenThumb', 1),
        CARDS[kind],
        creator('c2', 'Repair café this Sunday', 'Fixit Fred', 3),
    ],
    nextCursor: null,
});

const server = await createServer({ configFile: path.join(PWA_DIR, 'vite.config.ts'), root: PWA_DIR, server: { port: 0 }, logLevel: 'error' });
await server.listen();
const base = `http://localhost:${server.httpServer.address().port}/e2e/pulse-knowledge-harness.html`;
const browser = await chromium.launch();

async function open({ width, dark, textScale, lang, kind }) {
    const context = await browser.newContext({ viewport: { width, height: 1400 }, colorScheme: dark ? 'dark' : 'light', reducedMotion: 'reduce' });
    await context.addInitScript(([mode, language]) => {
        try { localStorage.setItem('beanpool-theme-mode', mode); localStorage.setItem('beanpool-language', language); } catch { /* defaults still draw */ }
    }, [dark ? 'dark' : 'light', lang]);
    const asked = [];
    await context.route('**/api/**', (route) => {
        const url = new URL(route.request().url());
        if (url.pathname === '/api/pulse/feed') {
            asked.push(url.searchParams.get('with'));
            return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(feed(kind)) }).catch(() => {});
        }
        if (url.pathname === '/api/channels/mine') return route.fulfill({ status: 200, contentType: 'application/json', body: '{"channels":[]}' }).catch(() => {});
        if (url.pathname === '/api/member/pulse/nudges') return route.fulfill({ status: 200, contentType: 'application/json', body: '{"nudges":[]}' }).catch(() => {});
        return route.fulfill({ status: 404, contentType: 'application/json', body: '{"error":"Not Found"}' }).catch(() => {});
    });
    await context.route('**/socket.io/**', (route) => route.abort());
    // Nothing leaves the machine: a picture from outside (a creator's face, a thumbnail) is refused.
    await context.route(/^https?:\/\/(?!localhost|127\.0\.0\.1)/, (route) => route.abort());
    const p = await context.newPage();
    p.setDefaultTimeout(30_000);
    p.on('pageerror', (e) => failures.push(`page error: ${e}`));
    await p.goto(`${base}?lang=${lang}`, { waitUntil: 'load' });
    if (textScale !== 1) await p.addStyleTag({ content: `html { font-size: ${textScale * 100}% !important; }` });
    await p.waitForSelector('[data-testid="pulse-knowledge-card"]', { timeout: 60_000 });
    await settle(p);
    return { context, page: p, asked };
}
const settle = (p) => p.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(r, 300)))));

/** Each tap target on the card: its height, whether it stays inside the card, and whether any of its words are cut. */
const targets = (p) => p.evaluate(() => {
    const card = document.querySelector('[data-testid="pulse-knowledge-card"]');
    const box = card.getBoundingClientRect();
    return Array.from(card.querySelectorAll('button')).map((el) => {
        const r = el.getBoundingClientRect();
        const words = Array.from(el.querySelectorAll('span')).filter((x) => x.children.length === 0 && x.textContent.trim() && !x.className.includes('truncate') && !x.className.includes('line-clamp'));
        const cut = words.some((x) => x.scrollWidth > x.clientWidth + 1) || el.scrollWidth > el.clientWidth + 1;
        return { id: el.getAttribute('data-testid'), h: Math.round(r.height), inside: r.left >= box.left - 0.5 && r.right <= box.right + 0.5, cut };
    });
});

/** The cards in the order drawn: k for the knowledge card, c for a creator's. */
const order = (p) => p.evaluate(() => Array.from(document.querySelectorAll('article')).map((a) => (a.getAttribute('data-testid') === 'pulse-knowledge-card' ? 'k' : 'c')).join(''));

try {
    for (const [width, textScale, size, langs] of [[320, 1.3, '320', ['en', 'xx']], [1280, 1, 'desktop', ['en']]]) {
        for (const lang of langs) {
            for (const kind of ['single', 'grouped']) {
                for (const dark of [false, true]) {
                    const label = `${size}-${lang}-${kind}-${dark ? 'dark' : 'light'}`;
                    const { context, page: p, asked } = await open({ width, dark, textScale, lang, kind });
                    check(asked.length > 0 && asked.every((w) => w === 'knowledge'), `${label}: the feed asks with=knowledge (${asked.join(', ')})`);
                    check((await order(p)) === 'ckc', `${label}: the card sits between the two creators' cards (${await order(p)})`);
                    check(!(await p.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth)), `${label}: the Pulse does not scroll sideways`);
                    const t = await targets(p);
                    const want = kind === 'single' ? 2 : 5;
                    check(t.length === want, `${label}: ${want} targets (${t.map((x) => x.id).join(', ')})`);
                    check(t.every((x) => x.h >= 44), `${label}: every target is at least 44 px tall (least ${Math.min(...t.map((x) => x.h))} px)`);
                    check(t.every((x) => x.inside && !x.cut), `${label}: every target stays inside the card, no words cut (${t.filter((x) => !x.inside || x.cut).map((x) => `${x.id}${x.inside ? '' : ' outside'}${x.cut ? ' cut' : ''}`).join(', ') || 'all'})`);
                    // "Open Learn ›", with its space: a flex button once dropped it and drew "Open Learn›".
                    const gap = await p.evaluate(() => {
                        const b = document.querySelector('[data-testid="pulse-knowledge-open-learn"]');
                        const words = document.createRange(); words.selectNodeContents(b.firstChild);
                        const glyph = b.querySelector('span').firstChild;
                        const mark = document.createRange(); mark.setStart(glyph, glyph.length - 1); mark.setEnd(glyph, glyph.length);
                        return Math.round((mark.getBoundingClientRect().left - words.getBoundingClientRect().right) * 10) / 10;
                    });
                    check(gap >= 2, `${label}: a space before the › on Open Learn (${gap} px)`);
                    // The card with the end of the creator's card above it and the start of the one below.
                    const clip = await p.evaluate(() => {
                        const a = Array.from(document.querySelectorAll('article'));
                        const r = a.map((x) => x.getBoundingClientRect());
                        const top = Math.max(0, r[0].bottom - 90 + window.scrollY);
                        const bottom = Math.min(r[2].top + 90, r[2].bottom) + window.scrollY;
                        return { x: 0, y: Math.round(top), width: document.documentElement.clientWidth, height: Math.round(bottom - top) };
                    });
                    if (width >= 768) {
                        // Wide: the three sit side by side in the grid; the shot is the row.
                        const g = await p.evaluate(() => { const r = document.querySelector('article').parentElement.getBoundingClientRect(); return { x: Math.round(r.left), y: Math.round(r.top + window.scrollY), width: Math.round(r.width), height: Math.round(r.height) }; });
                        await p.screenshot({ path: path.join(OUT_DIR, `pulse-${label}.png`), clip: g, fullPage: true });
                    } else {
                        await p.screenshot({ path: path.join(OUT_DIR, `pulse-${label}.png`), clip, fullPage: true });
                    }
                    await context.close();
                }
            }
        }
    }
} finally {
    await browser.close();
    await server.close();
}
if (failures.length) { console.error(`\n${failures.length} problem(s)`); process.exit(1); }
console.log(`\nShots in ${OUT_DIR}`);
