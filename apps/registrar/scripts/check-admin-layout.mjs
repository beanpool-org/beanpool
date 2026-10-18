// /admin in a real browser: the page served as the Worker serves it, its API answered with a list shaped like the live
// one (2026-10-17: 51 names, 45 of them released; and a bot's burst of held names, S3), at 320, 768, 1000, 1001 and
// 1280 px. Exit 1 if anything in the Pending, New names or Names card reaches past its card's edge, or the page scrolls
// sideways — with the Released section shut and open. Run by hand (CI's test job has no browser):
//   pnpm --filter @beanpool/manager exec playwright install --only-shell chromium   # once
//   node apps/registrar/scripts/check-admin-layout.mjs [<dir for screenshots>]
// Playwright comes from the workspace (apps/manager's); the registrar itself depends on nothing.
import { createRequire } from 'node:module';
import { mkdirSync } from 'node:fs';
import { ADMIN_HTML } from '../src/admin-html.js';

const require = createRequire(new URL('../../../package.json', import.meta.url));
const { chromium } = require('playwright');
const shots = process.argv[2];
if (shots) mkdirSync(shots, { recursive: true });

const now = Math.floor(Date.now() / 1000);
const DAY = 86400;
const key = (i) => i.toString(16).padStart(4, '0').repeat(16);
const rows = [
    { name: 'mullum', status: 'live', mode: 'tunnel', community_name: 'Mullumbimby Community Garden Cooperative', contact: 'someone-with-a-long-address@example.org' },
    { name: 'castlemaine', status: 'live', mode: 'direct', community_name: 'Castlemaine' },
    { name: 'a-name-of-the-longest-kind-32ch', status: 'live', mode: 'tunnel', community_name: 'Thirty-two characters' },
    { name: 'newplace', status: 'pending', mode: 'tunnel', community_name: 'A new community with a long name', contact: 'contact@example.org' },
    ...[['number1', 'admin'], ['testyeah', 'impostor'], ['tst21', 'unverified'], ['yarravalley', 'admin'], ['test', 'admin']]
        .map(([name, why]) => ({ name, status: 'paused', pause_reason: why, paused_at: now - 20 * DAY, mode: 'tunnel', community_name: name })),
    { name: 'aitest1017', status: 'blocked', pause_reason: 'admin', paused_at: now - DAY, mode: 'tunnel', community_name: 'AI test' },
    ...Array.from({ length: 45 }, (_, i) => ({
        name: ['cairns', 'wow', 'tst', 'etest', 'test'][i % 5] + i, status: 'released', pause_reason: ['owner', 'admin', 'admin-held', 'withdrawn'][i % 4],
        released_at: now - (100 - i) * DAY, mode: i % 3 ? 'tunnel' : 'direct', community_name: i % 5 ? `Test ${i}` : null, contact: i % 7 ? null : 'x@example.org',
    })),
    { name: 'heldone', status: 'released', pause_reason: 'owner', released_at: now - 2 * DAY, mode: 'tunnel', community_name: 'Held' },
].map((r, i) => {
    // As /pending sends them (index.js holdsName, isOwnRow): a release holds unless freed at once or past its 30 days,
    // and its old key can take it back unless freed at once (or released by the admin from every key).
    const holds = r.status !== 'released' || (!['admin', 'withdrawn'].includes(r.pause_reason) && now - r.released_at < 30 * DAY);
    const released = r.status === 'released';
    const takesBack = released && !['admin', 'withdrawn', 'admin-held-all'].includes(r.pause_reason);
    return { node_pubkey: key(i + 1), requested_at: now - (120 - i) * DAY, ...r, holds, ...(released ? { takes_back: takesBack } : {}), ...(holds && released ? { held_until: r.released_at + 30 * DAY } : {}) };
});

// "New names, last 24 h" (GET /sources) as a bot's burst draws it: one source with many names, a long network name, the
// held ones in the Awaiting card too (their source and why), a block, and the settings table open.
const hash = (c) => c.repeat(64);
const sources = {
    schema: true, source_key_set: true, since: now - DAY,
    hold: { on: true, until: now + 20 * 3600 },
    capacity: { names: 131, capacity: 200, alert_at: 120, hold_at: 160 },
    groups: [
        { source: hash('a'), asn: 14061, as_org: 'DigitalOcean, LLC — a hosting network with a long name', country: 'US', names: 17, held: 14, pending: 14, live: 3, verified: 0, keys: 17, first: now - 7200, last: now - 60,
            rows: Array.from({ length: 17 }, (_, i) => ({ name: `bot-made-name-number-${i}`, status: i < 3 ? 'live' : 'pending', held_reason: i < 3 ? null : 'source', probation: i < 3 })) },
        { source: hash('b'), asn: 7545, as_org: 'TPG Telecom', country: 'AU', names: 1, held: 0, pending: 0, live: 1, verified: 1, keys: 1, first: now - 3600, last: now - 3600,
            rows: [{ name: 'a-name-of-the-longest-kind-32ch', status: 'live', held_reason: null, probation: false }] },
        { source: null, asn: null, as_org: null, country: null, names: 2, held: 2, pending: 2, live: 0, verified: 0, keys: 2, first: now - 600, last: now - 300,
            rows: [{ name: 'nosource1', status: 'pending', held_reason: 'budget' }, { name: 'nosource2', status: 'pending', held_reason: 'budget' }] },
    ],
    networks: [{ asn: 14061, as_org: 'DigitalOcean, LLC — a hosting network with a long name', country: 'US', names: 17, sources: 1 }],
    blocked: [{ kind: 'source', value: hash('c'), until: now + 6 * DAY, at: now - DAY, by: 'admin@example.org', label: 'AS14061 DigitalOcean, LLC, US' }, { kind: 'asn', value: '64500', until: now + DAY, at: now, by: null, label: null }],
    settings: ['source_per_hour', 'source_per_day', 'asn_per_day', 'new_names_per_hour', 'new_names_per_day', 'claim_limit_per_key', 'probation_sweeps', 'probation_s', 'attest_fail_limit', 'swap_fail_limit', 'capacity', 'capacity_alert_at', 'capacity_hold_at']
        .map((key, i) => ({ key, value: 3 + i, default: 3, min: 1, max: 100000, words: 'New names from one source (one connecting address) in an hour; past it they are held for your approval', set: i % 2 ? { value: '9', at: now, by: 'admin@example.org' } : null })),
};
for (let i = 3; i < 17; i++) rows.push({ name: `bot-made-name-number-${i}`, status: 'pending', mode: 'tunnel', node_pubkey: key(500 + i), requested_at: now - 600, holds: true, awaiting_approval: true, held_reason: 'source',
    source: { id: hash('a'), asn: 14061, as_org: 'DigitalOcean, LLC — a hosting network with a long name', country: 'US' } });

// How far anything drawn in each card reaches past the card's inner edge (px), and how far the page scrolls sideways.
const measure = () => {
    const out = { page: document.documentElement.scrollWidth - window.innerWidth };
    for (const id of ['pendingTableContainer', 'sourcesContainer', 'activeTableContainer']) {
        const c = document.getElementById(id);
        const card = c.closest('.admin-card');
        const cs = getComputedStyle(card);
        const edge = card.getBoundingClientRect().right - parseFloat(cs.borderRightWidth) - parseFloat(cs.paddingRight) + 0.5;
        let worst = 0;
        for (const el of c.querySelectorAll('*')) {
            const r = el.getBoundingClientRect();
            if (r.width || r.height) worst = Math.max(worst, r.right - edge);
        }
        out[id] = Math.round(worst * 10) / 10;
    }
    return out;
};

const browser = await chromium.launch();
const bad = [];
try {
    for (const width of [320, 768, 1000, 1001, 1280]) {
        const page = await browser.newPage({ viewport: { width, height: 900 } });
        await page.route('**/*', (route) => {
            const p = new URL(route.request().url()).pathname;
            if (p === '/admin') return route.fulfill({ contentType: 'text/html', body: ADMIN_HTML });
            // Signed in by Cloudflare Access, as the live page is (README "Admin sign-in").
            if (p === '/api/local/admin/registrar/whoami') return route.fulfill({ json: { email: 'admin@example.org', via: 'cloudflare-access' } });
            if (p === '/api/local/admin/registrar/pending') return route.fulfill({ json: { allocations: rows } });
            if (p === '/api/local/admin/registrar/events') return route.fulfill({ json: { events: [{ at: now, name: 'mullum', event: 'claimed', detail: 'claimed by key 0001000100010001 (tunnel, tier auto)' }] } });
            if (p === '/api/local/admin/registrar/alerts') return route.fulfill({ json: { channel: { set: false }, cap: {}, settings: {} } });
            if (p === '/api/local/admin/registrar/servers') return route.fulfill({ json: { targets: [] } });
            if (p === '/api/local/admin/registrar/sources') return route.fulfill({ json: sources });
            return route.fulfill({ status: 404, body: '' });
        });
        await page.goto('https://beanpool.org/admin');
        await page.waitForSelector('#activeTableContainer details.released');
        await page.waitForSelector('#sourcesContainer details.released');
        await page.click('#sourcesContainer details.released > summary');   // the settings table, open
        const shut = await page.evaluate(measure);
        if (shots) {
            await page.screenshot({ path: `${shots}/admin-${width}.png` });
            await (await page.$('#sourcesContainer')).screenshot({ path: `${shots}/admin-${width}-sources.png` });
        }
        await page.click('#activeTableContainer details.released > summary');
        const open = await page.evaluate(measure);
        if (shots) {
            await (await page.$('#activeTableContainer details.released')).scrollIntoViewIfNeeded();
            await page.screenshot({ path: `${shots}/admin-${width}-released.png` });
        }
        console.log(`${width}px  Released shut: ${JSON.stringify(shut)}  open: ${JSON.stringify(open)}`);
        for (const [state, m] of [['shut', shut], ['open', open]]) {
            for (const [what, px] of Object.entries(m)) if (px > 0) bad.push(`${width}px, Released ${state}: ${what} ${px}px past the edge`);
        }
        await page.close();
    }
} finally {
    await browser.close();
}
if (bad.length) { console.error(`FAIL\n${bad.join('\n')}`); process.exit(1); }
console.log('OK: nothing past its card, no sideways scroll, at every width');
