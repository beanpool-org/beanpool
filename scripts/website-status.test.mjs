// beanpool.org/status (apps/website/status.html): the public status line of our own servers, slice A8 of the mothership
// design (scratch/global-node/DESIGN-global-mothership-fable.md §3.2 U4, accepted by Marty 18 Oct 2026). The registrar
// writes status.json (apps/registrar/src/status.js) and the page draws it from the visitor's browser. This fails when:
//   - the page loads a script from anywhere, or reads its status from anywhere but /api/registrar/status.json on its
//     own site;
//   - drawn in headless Chromium at 320 px, light and dark, from a status.json as the registrar writes it: a server's
//     state, its share or its last incident is not in words; a state's colour is not its token in that theme
//     (--success-ink answering, --danger-ink down, --accent-ink missed or late); or anything is wider than the screen;
//   - a status over 15 minutes old is not said to be late; a 404, a failed read, or a status in a form the page does not
//     know is not said in words, or leaves rows on the page;
//   - a name or a reason in the status reaches the page as markup.
// Every colour on the page is also held to the site's tokens by scripts/website-colours.test.mjs, and its words to
// 4.5:1 by scripts/website-contrast.mjs (which draws it from a stubbed status too). No network.
//
//   node --test scripts/website-status.test.mjs     (needs: pnpm --filter @beanpool/pwa exec playwright install --only-shell chromium)
//
// WEBSITE_ROOT points it at another copy of apps/website (an archive of origin/main, for a fail-first run);
// STATUS_SHOTS=<dir> keeps a screenshot of the page in each theme.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SITE = path.resolve(process.env.WEBSITE_ROOT ?? path.join(ROOT, 'apps/website'));
const PAGE = path.join(SITE, 'status.html');
const require = createRequire(path.join(ROOT, 'apps/pwa/package.json'));
const { chromium } = require('playwright');
const SHOTS = process.env.STATUS_SHOTS;

const TYPES = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.webp': 'image/webp', '.png': 'image/png', '.woff2': 'font/woff2' };
function serve(root) {
    return new Promise((resolve) => {
        const server = http.createServer((req, res) => {
            const p = path.join(root, decodeURIComponent(new URL(req.url, 'http://x').pathname));
            if (!p.startsWith(root) || !fs.existsSync(p) || fs.statSync(p).isDirectory()) { res.writeHead(404); res.end(); return; }
            res.writeHead(200, { 'content-type': TYPES[path.extname(p)] ?? 'application/octet-stream' });
            fs.createReadStream(p).pipe(res);
        });
        server.listen(0, '127.0.0.1', () => resolve(server));
    });
}

// status.json as the registrar writes it (apps/registrar/test/status-2026-10-18.test.js): global answering with an
// incident that ended, test down now, the registrar with its checks missed for an hour once.
const NOW = Math.floor(Date.UTC(2026, 9, 18, 12, 0, 0) / 1000);
const status = (over = {}) => ({
    v: 1, at: NOW - 120, every_s: 300, window_days: 90,
    servers: [
        { name: 'global', up: true, checked_at: NOW - 120, looks: 5749, answered: 5742, percent: 99.87, since: '2026-09-20',
            incident: { began_at: NOW - 3 * 86400, ended_at: NOW - 3 * 86400 + 35 * 60, why: 'timed-out' } },
        { name: 'test', up: false, checked_at: NOW - 120, looks: 5749, answered: 5740, percent: 99.84, since: '2026-09-20',
            incident: { began_at: NOW - 720, ended_at: null, why: 'http-502' } },
        { name: 'registrar', up: true, checked_at: NOW - 120, looks: 5761, answered: 5749, percent: 99.79, since: '2026-09-20',
            incident: { began_at: NOW - 5 * 86400, ended_at: NOW - 5 * 86400 + 3600, why: 'checks-missed' } },
    ],
    ...over,
});

let browser, server, base;
before(async () => {
    browser = await chromium.launch();
    server = await serve(SITE);
    base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => { await browser?.close(); server?.close(); });

/** The page at 320 px in `theme`, its clock at NOW, its status.json answered by `answer` (a Response's parts). */
async function open(theme, answer) {
    const ctx = await browser.newContext({ viewport: { width: 320, height: 900 }, colorScheme: theme, reducedMotion: 'reduce', timezoneId: 'UTC', locale: 'en-GB' });
    const page = await ctx.newPage();
    await page.clock.setFixedTime(new Date(NOW * 1000));
    const asked = [];
    await page.route('**/*', (r) => {
        const u = new URL(r.request().url());
        if (u.hostname !== '127.0.0.1') { asked.push(u.href); return r.abort(); }
        if (u.pathname === '/api/registrar/status.json') {
            asked.push(u.pathname);
            return r.fulfill({ status: answer.status ?? 200, contentType: 'application/json', body: typeof answer.body === 'string' ? answer.body : JSON.stringify(answer.body) });
        }
        return r.continue();
    });
    await page.goto(`${base}/status.html`, { waitUntil: 'load' });
    await page.evaluate(() => document.fonts.ready);
    await page.waitForFunction(() => document.getElementById('status-note').textContent !== 'Reading the status…');
    return { ctx, page, asked };
}

/** Each row's state, name, words; the note and its tone; what is wider than the screen; each state's colours vs its token. */
const look = (page) => page.evaluate(() => {
    const probe = (v) => { const p = document.createElement('span'); p.style.color = `var(${v})`; document.body.appendChild(p); const c = getComputedStyle(p).color; p.remove(); return c; };
    const tokens = { up: probe('--success-ink'), down: probe('--danger-ink'), missed: probe('--accent-ink') };
    const list = document.getElementById('status-list');
    const rows = list.hidden ? [] : [...list.querySelectorAll('.status-row')].map((li) => ({
        name: li.dataset.name, state: li.dataset.state,
        text: [...li.querySelectorAll('.status-name, .status-state, .status-host, .status-share, .status-incident')].map((e) => e.textContent).join(' ').replace(/\s+/g, ' ').trim(),
        word: getComputedStyle(li.querySelector('.status-state')).color, dot: getComputedStyle(li.querySelector('.status-dot')).backgroundColor,
    }));
    const note = document.getElementById('status-note');
    const wide = [...document.querySelectorAll('body *')].filter((e) => e.getClientRects().length && e.getBoundingClientRect().right > innerWidth + 0.5)
        .map((e) => `${e.tagName.toLowerCase()}.${e.className}`);
    return {
        rows, tokens, wide, scroll: document.documentElement.scrollWidth, width: innerWidth,
        note: note.textContent, tone: note.dataset.tone ?? null, markup: list.querySelectorAll('img, b, script').length,
    };
});

test('the page loads only its own files and reads its status only from the registrar on its own site', () => {
    const html = fs.readFileSync(PAGE, 'utf8').replace(/<!--[\s\S]*?-->/g, '');
    assert.deepEqual([...html.matchAll(/<script\b[^>]*\bsrc=/g)], [], 'no script from a file or another site');
    for (const m of html.matchAll(/\b(?:href|src)="([^"]+)"/g)) {
        if (m[1].startsWith('https://beanpool.org/')) continue;
        assert.doesNotMatch(m[1], /^(?:https?:)?\/\//, `${m[1]}: the site's own files only`);
    }
    assert.deepEqual([...html.matchAll(/fetch\(([^,)]+)/g)].map((m) => m[1]), ['URL_']);
    assert.match(html, /var URL_ = '\/api\/registrar\/status\.json';/);
    assert.doesNotMatch(html, /innerHTML|outerHTML|insertAdjacentHTML|document\.write/, 'what the status says is set as text');
});

for (const theme of ['light', 'dark']) {
    test(`${theme}, 320 px: each server in words and its state's token colour, nothing wider than the screen`, async () => {
        const { ctx, page, asked } = await open(theme, { body: status() });
        try {
            assert.deepEqual(asked, ['/api/registrar/status.json'], 'one read of the status, nothing else off the site');
            const v = await look(page);
            if (SHOTS) { fs.mkdirSync(SHOTS, { recursive: true }); await page.screenshot({ path: path.join(SHOTS, `status-${theme}-320.png`), fullPage: true }); }
            assert.deepEqual(v.rows.map((r) => [r.name, r.state]), [['global', 'up'], ['test', 'down'], ['registrar', 'up']]);
            const [g, t, reg] = v.rows;
            assert.match(g.text, /^The global community Answering global\.beanpool\.org 99\.87% of checks answered since 20 Sept?\. Last incident: 15 Oct,? (?:at )?12:00 for 35 minutes: it did not answer in time\.$/);
            assert.match(t.text, /^The test community Down test\.beanpool\.org 99\.84% of checks answered since 20 Sept?\. Down since 18 Oct,? (?:at )?11:48: it answered with an error \(HTTP 502\)\.$/);
            assert.match(reg.text, /^Community addresses Answering beanpool\.org: gives communities .* new ones and beanpool\.org\/i\/ links wait\. 99\.79% of its 5-minute checks ran since 20 Sept?\. Last incident: 13 Oct,? (?:at )?12:00 for 1 hour: the checks did not run\.$/);
            assert.match(v.note, /^Checked 18 Oct,? (?:at )?11:58 UTC\.$/);
            assert.equal(v.tone, null);
            assert.equal(g.word, v.tokens.up, 'answering: --success-ink');
            assert.equal(g.dot, v.tokens.up);
            assert.equal(t.word, v.tokens.down, 'down: --danger-ink');
            assert.equal(t.dot, v.tokens.down);
            assert.notEqual(v.tokens.up, v.tokens.down);
            assert.deepEqual(v.wide, [], 'nothing reaches past the screen');
            assert.equal(v.scroll, v.width, 'no sideways scroll');
        } finally { await ctx.close(); }
    });

    test(`${theme}, 320 px: a status over 15 minutes old says the checks are late; a server that missed its last check says so`, async () => {
        const doc = status({ at: NOW - 2 * 3600 });
        doc.servers[0] = { ...doc.servers[0], up: false, incident: null };
        const { ctx, page } = await open(theme, { body: doc });
        try {
            const v = await look(page);
            assert.equal(v.tone, 'late');
            assert.match(v.note, /^These are from 18 Oct,? (?:at )?10:00 UTC: the checks have not run since\. What a server says now may differ\.$/);
            const [g, , reg] = v.rows;
            assert.deepEqual([g.state, reg.state], ['missed', 'missed']);
            assert.match(g.text, /Missed its last check/);
            assert.match(g.text, /No incident since 20 Sept?\./);
            assert.match(reg.text, /^Community addresses Its checks are late /);
            assert.equal(g.word, v.tokens.missed, 'missed: --accent-ink');
            assert.equal(reg.dot, v.tokens.missed);
            assert.deepEqual(v.wide, []);
        } finally { await ctx.close(); }
    });
}

test('a 404, a failed read and a status in a form the page does not know are each said in words, with no rows', async () => {
    for (const [answer, words] of [
        [{ status: 404, body: { error: 'no status is published here' } }, /^No status is published here yet\.$/],
        [{ status: 500, body: { error: 'internal' } }, /^The status could not be read just now: the registrar that keeps it may be down\. Local communities are not affected\./],
        [{ body: 'not json' }, /^The status could not be read: it is not in a form this page knows\.$/],
        [{ body: status({ v: 2 }) }, /^The status could not be read: it is not in a form this page knows\.$/],
        [{ body: status({ servers: [] }) }, /not in a form this page knows/],
    ]) {
        const { ctx, page } = await open('dark', answer);
        try {
            const v = await look(page);
            assert.match(v.note, words, JSON.stringify(answer).slice(0, 80));
            assert.deepEqual(v.rows, []);
        } finally { await ctx.close(); }
    }
});

test('what the status says reaches the page as text: a name that is markup is dropped, an unknown reason is plain words', async () => {
    const doc = status();
    doc.servers = [
        { ...doc.servers[0], name: '<img src=x onerror=alert(1)>' },
        { ...doc.servers[1], name: 'somewhere-new', incident: { began_at: NOW - 600, ended_at: null, why: '<b>bold</b>' } },
        doc.servers[2],
    ];
    const { ctx, page } = await open('light', { body: doc });
    try {
        const v = await look(page);
        assert.deepEqual(v.rows.map((r) => r.name), ['somewhere-new', 'registrar'], 'a name that is not one of ours in form is dropped');
        assert.match(v.rows[0].text, /^somewhere-new Down 99\.84% .* Down since 18 Oct,? (?:at )?11:50: it did not answer\.$/, 'an unknown server by its name, an unknown reason as plain words');
        assert.equal(v.markup, 0, 'no markup from the status');
    } finally { await ctx.close(); }
});
