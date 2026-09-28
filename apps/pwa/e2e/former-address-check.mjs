/**
 * MEASURES "This community has moved to …" (lost-name L4) in a real Chromium layout at the documented floor, 320px with
 * 1.3x text (and a 260px stress case), light and dark: the banner at a former address, with the longest name the
 * registrar gives (32 letters, nowhere to break); nothing may reach past the viewport, the page may not scroll sideways,
 * the whole new address shows, "Open it there" is a plain link to https://<address>/ at least 44px tall, and loading
 * the page goes nowhere by itself. Then the same page at the community's current address: no banner. Photographs each
 * case to e2e/shots/.
 *
 * Nothing here touches a BeanPool node: /api/community/info is answered by the page route with a fixture naming this
 * page's own host (localhost) as a former address, and any other /api or /ws request is aborted and counted.
 *
 *   node e2e/former-address-check.mjs     # exits non-zero on any problem
 *
 * Run from apps/pwa: Tailwind reads its config from the working directory.
 * Needs Chromium for Playwright once: pnpm --filter @beanpool/pwa exec playwright install --only-shell chromium
 */
/* global process, console, document, getComputedStyle */
import { createServer } from 'vite';
import { chromium } from 'playwright';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';

const PWA_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
process.chdir(PWA_DIR);
const OUT_DIR = path.join(PWA_DIR, 'e2e', 'shots');

/** The longest name the registrar gives: one label of 32 characters (apps/registrar NAME_RE), with no hyphen to break at. */
const NEW_HOST = 'thecommunityofmullumbimbygardens.beanpool.org';
const INFO = {
    moved: { memberCount: 3, postCount: 0, transactionCount: 0, commonsBalance: 0, addresses: [NEW_HOST], primaryAddress: NEW_HOST, formerAddresses: ['localhost'] },
    // Opened at the current address: this page's host is the primary one.
    current: { memberCount: 3, postCount: 0, transactionCount: 0, commonsBalance: 0, addresses: ['localhost'], primaryAddress: 'localhost', formerAddresses: ['oldname.beanpool.org'] },
};

const CASES = [
    { name: 'phone-320-130pc', width: 320, height: 900, fontScale: 1.3 },
    { name: 'STRESS-narrow-260-130pc', width: 260, height: 1000, fontScale: 1.3 },
];

/** Runs in the page: what reaches past the viewport, and the banners, their address and their links. */
const MEASURE = () => {
    const vw = document.documentElement.clientWidth;
    const out = [];
    for (const el of document.querySelectorAll('#root *')) {
        const r = el.getBoundingClientRect();
        if (r.width === 0 && r.height === 0) continue;
        if (r.right > vw + 0.5 || r.left < -0.5) out.push(`${el.tagName.toLowerCase()}${el.dataset.testid ? `[${el.dataset.testid}]` : ''} "${(el.textContent || '').slice(0, 40)}" spans ${Math.round(r.left)}..${Math.round(r.right)} of ${vw}`);
        if (el.scrollWidth > el.clientWidth + 1 && getComputedStyle(el).overflowX !== 'visible') out.push(`${el.tagName.toLowerCase()} scrolls sideways (${el.scrollWidth} > ${el.clientWidth})`);
    }
    const banners = [...document.querySelectorAll('[data-testid="former-address-banner"]')];
    return {
        overflow: out,
        pageScrollsSideways: document.documentElement.scrollWidth > vw,
        banners: banners.map((b) => {
            const a = b.querySelector('a');
            const strong = b.querySelector('strong');
            const ar = a?.getBoundingClientRect();
            const sr = strong?.getBoundingClientRect();
            return {
                text: b.textContent,
                address: strong?.textContent ?? null,
                addressInside: !!sr && sr.left >= -0.5 && sr.right <= vw + 0.5,
                href: a?.getAttribute('href') ?? null,
                rel: a?.getAttribute('rel') ?? null,
                linkHeight: ar ? Math.round(ar.height) : 0,
                // The banner sits over the header, which on the map floats at the top of the column.
                zIndex: getComputedStyle(b).zIndex,
            };
        }),
    };
};

const server = await createServer({ configFile: path.join(PWA_DIR, 'vite.config.ts'), root: PWA_DIR, server: { port: 0 } });
await server.listen();
const base = `http://localhost:${server.httpServer.address().port}`;

fs.mkdirSync(OUT_DIR, { recursive: true });
const browser = await chromium.launch();
const failures = [];
let blocked = 0;

try {
    for (const which of ['moved', 'current']) {
        for (const theme of ['light', 'dark']) {
            for (const c of CASES) {
                const context = await browser.newContext({ viewport: { width: c.width, height: c.height }, colorScheme: theme });
                await context.route('**/*', (route) => {
                    const url = route.request().url();
                    if (url.includes('/api/community/info')) return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(INFO[which]) });
                    if (url.includes('/api/') || url.startsWith('ws')) { blocked++; return route.abort(); }
                    return route.continue();
                });
                const page = await context.newPage();
                const pageErrors = [];
                page.on('pageerror', (e) => pageErrors.push(e.message));
                const harness = `${base}/e2e/former-address-harness.html`;
                await page.goto(harness, { waitUntil: 'networkidle' });
                await page.evaluate(([t, scale]) => {
                    document.documentElement.classList.toggle('dark', t === 'dark');
                    document.documentElement.classList.toggle('dark-theme', t === 'dark');
                    document.documentElement.style.fontSize = `${scale * 100}%`;
                }, [theme, c.fontScale]);
                if (which === 'moved') await page.waitForSelector('[data-testid="former-address-banner"]');
                else await page.waitForTimeout(500);
                await page.evaluate(() => document.fonts.ready);

                const shot = `former-address-${which}-${c.name}-${theme}.png`;
                await page.screenshot({ path: path.join(OUT_DIR, shot), fullPage: true });
                const m = await page.evaluate(MEASURE);
                if (page.url() !== harness) failures.push(`${shot}: the page went to ${page.url()} by itself`);
                if (which === 'moved') {
                    if (m.banners.length !== 2) failures.push(`${shot}: ${m.banners.length} banners, expected 2`);
                    for (const [i, b] of m.banners.entries()) {
                        const who = i === 0 ? 'member' : 'visitor';
                        if (b.address !== NEW_HOST) failures.push(`${shot} (${who}): the address reads ${JSON.stringify(b.address)}`);
                        if (!b.addressInside) failures.push(`${shot} (${who}): the address reaches past the viewport`);
                        if (b.href !== `https://${NEW_HOST}/`) failures.push(`${shot} (${who}): the link goes to ${b.href}`);
                        if (!String(b.rel).includes('noreferrer')) failures.push(`${shot} (${who}): the link sends a referrer (rel=${b.rel})`);
                        if (b.linkHeight < 44) failures.push(`${shot} (${who}): "Open it there" is ${b.linkHeight}px tall, under 44`);
                        if (!(Number(b.zIndex) > 100)) failures.push(`${shot} (${who}): z-index ${b.zIndex}, not above the header's 100`);
                    }
                    if (m.banners[0] && !/sign in there again/.test(m.banners[0].text)) failures.push(`${shot}: the member's banner doesn't say they sign in there again`);
                    if (m.banners[1] && /sign in/.test(m.banners[1].text)) failures.push(`${shot}: the visitor's banner talks about signing in`);
                } else if (m.banners.length !== 0) {
                    failures.push(`${shot}: ${m.banners.length} banners at the current address, expected none`);
                }
                if (m.pageScrollsSideways) failures.push(`${shot}: the page scrolls sideways`);
                for (const o of m.overflow) failures.push(`${shot}: ${o}`);
                if (pageErrors.length) failures.push(`${shot}: page errors ${JSON.stringify(pageErrors)}`);
                console.log(`${shot}: ${m.banners.length} banners${m.banners.map((b) => `, link ${b.linkHeight}px`).join('')}, ${m.overflow.length} overflowing, sideways ${m.pageScrollsSideways}`);
                await context.close();
            }
        }
    }
} finally {
    await browser.close();
    await server.close();
}

if (blocked) console.log(`(${blocked} other /api or /ws requests aborted at the browser)`);
if (failures.length) {
    console.error(`\n✗ ${failures.length} problem(s):\n  ${failures.join('\n  ')}`);
    process.exit(1);
}
console.log('\n✓ at a former address: the whole new address, a plain 44px link, nothing past the viewport; at the current one: nothing');
