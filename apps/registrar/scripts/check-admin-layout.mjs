// /admin in a real browser: the page served as the Worker serves it, its API answered with a list shaped like the live
// one (2026-10-17: 51 names, 45 of them released), at 320, 768, 1000, 1001 and 1280 px. Exit 1 if anything in the
// Pending or Names card reaches past its card's edge, or the page scrolls sideways — with the Released section shut
// and open. Run by hand (CI's test job has no browser):
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

// How far anything drawn in each card reaches past the card's inner edge (px), and how far the page scrolls sideways.
const measure = () => {
    const out = { page: document.documentElement.scrollWidth - window.innerWidth };
    for (const id of ['pendingTableContainer', 'activeTableContainer']) {
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
        await page.addInitScript(() => sessionStorage.setItem('bp_registrar_admin_secret', 'layout-check'));
        await page.route('**/*', (route) => {
            const p = new URL(route.request().url()).pathname;
            if (p === '/admin') return route.fulfill({ contentType: 'text/html', body: ADMIN_HTML });
            if (p === '/api/local/admin/registrar/pending') return route.fulfill({ json: { allocations: rows } });
            if (p === '/api/local/admin/registrar/events') return route.fulfill({ json: { events: [{ at: now, name: 'mullum', event: 'claimed', detail: 'claimed by key 0001000100010001 (tunnel, tier auto)' }] } });
            if (p === '/api/local/admin/registrar/alerts') return route.fulfill({ json: { channel: { set: false }, cap: {}, settings: {} } });
            if (p === '/api/local/admin/registrar/servers') return route.fulfill({ json: { targets: [] } });
            return route.fulfill({ status: 404, body: '' });
        });
        await page.goto('https://beanpool.org/admin');
        await page.waitForSelector('#activeTableContainer details.released');
        const shut = await page.evaluate(measure);
        if (shots) await page.screenshot({ path: `${shots}/admin-${width}.png` });
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
