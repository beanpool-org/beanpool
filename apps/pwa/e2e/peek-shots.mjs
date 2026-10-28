/**
 * A post shared outside its community, in the web app (front doors S6): what a stranger reads after the node's share
 * page's "See it in your browser" (`/app?post=<id>&peek=<ticket>`, pages/PeekPage.tsx), in headless Chromium at 320x568
 * px with 1.3x text (a phone's browser: touch, Android) and at 1280 px (a computer's), light and dark:
 *   1. the post, under "A member of {community} shared this with you", its photo, words and price, the line about names
 *      and faces, and the doors: Open in the BeanPool app and Get the app (phone only), the community's card (Ask to
 *      join, Already a member, Look around the global community), I have an invite
 *   2. a link that opens nothing now: "This link has stopped working", and the same doors
 * Builds the web app as it ships, serves it under the app document's Content-Security-Policy, answers /api as a local
 * community answers a ticket holder (the post through guestPost: no author key, name, face; its area only), and fails on
 * any sideways scroll, any policy violation, any request signed with a key (a stranger has none), any read but the ones
 * a ticket holder makes, and any author, face or badge on the page.
 *
 * Nothing here talks to a node: /api is answered below, and every other host is refused.
 *
 * Run: node apps/pwa/e2e/peek-shots.mjs [out-dir]
 * Needs Chromium for Playwright once: pnpm --filter @beanpool/pwa exec playwright install --only-shell chromium
 */
/* global Buffer, URL, console, process, document, window, localStorage, location -- Node, and the page's side of evaluate() */
import { build, preview, transformWithEsbuild } from 'vite';
import { chromium } from 'playwright';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const PWA_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const POLICY_SOURCE = path.resolve(PWA_DIR, '../server/src/app-document-csp.ts');
process.chdir(PWA_DIR);

const SHOTS_DIR = process.argv[2] || path.join(os.tmpdir(), 'bp-peek-shots');
const PHOTO = fs.readFileSync(path.join(PWA_DIR, 'public/assets/header-bg.png'));
const VIEWS = [
    { name: '320', viewport: { width: 320, height: 568 }, textScale: 1.3, phone: true },
    { name: '1280', viewport: { width: 1280, height: 800 }, textScale: 1, phone: false },
];
const ANDROID_UA = 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Mobile Safari/537.36';
const TICKET = 'AbCdEfGhIjKlMnOpQrSt_-';
const POST_ID = '3f0c8a8e-1b2c-4d5e-8f90-123456789abc';
const STOPPED_ID = '9a9a9a9a-1b2c-4d5e-8f90-123456789abc';
// What a ticket holder reads: the post (by its ticket), its photo, the community's public card and info.
const READS = new Set(['/api/community/info', '/api/community/card', '/api/community/health', `/api/marketplace/posts/${POST_ID}`, `/api/marketplace/posts/${STOPPED_ID}`]);
const mayRead = (p) => READS.has(p) || /^\/api\/marketplace\/posts\/[^/]+\/photos\/[^/]+$/.test(p);

const GUEST_POST = {
    id: POST_ID, type: 'offer', category: 'tools', title: 'Long ladder to lend for the weekend', status: 'active', active: true,
    description: 'A 6 m extension ladder, light enough for one person. Good for gutters and fruit trees.', credits: 15, priceType: 'fixed',
    photos: [`/api/marketplace/posts/${POST_ID}/photos/0?v=1&k=key`], createdAt: new Date(Date.now() - 86_400_000).toISOString(),
    audienceScope: 'public', lat: -37.1, lng: 144.2, repeatable: false,
    authorPublicKey: 'hidden', authorCallsign: '', authorAvatarUrl: null, authorEnergyCycled: 0, authorFoundingNeeded: false,
};
const CARD = {
    name: 'Castlemaine BeanPool', host: 'castlemaine.beanpool.org', members: 42, area: { name: 'Castlemaine and around', radiusKm: 15 },
    joining: 'requests', askUrl: 'https://global.beanpool.org/?ask=castlemaine.beanpool.org', globalUrl: 'https://global.beanpool.org',
};

async function loadPolicy() {
    const source = fs.readFileSync(POLICY_SOURCE, 'utf8');
    const { code } = await transformWithEsbuild(source, POLICY_SOURCE, { loader: 'ts', format: 'esm' });
    return import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`);
}

class Failure extends Error {}

async function main() {
    const policy = await loadPolicy();
    const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bp-peek-'));
    fs.mkdirSync(SHOTS_DIR, { recursive: true });
    let server;
    let browser;
    const failures = [];
    try {
        await build({ root: PWA_DIR, logLevel: 'error', build: { outDir, emptyOutDir: true } });
        server = await preview({
            configFile: false, root: PWA_DIR, build: { outDir }, logLevel: 'warn',
            preview: { port: 0, open: false, headers: { 'Content-Security-Policy': policy.APP_DOCUMENT_CSP, 'Referrer-Policy': policy.APP_DOCUMENT_REFERRER_POLICY } },
        });
        const origin = server.resolvedUrls.local[0].replace(/\/$/, '');
        browser = await chromium.launch();
        for (const view of VIEWS) for (const theme of ['light', 'dark']) {
            const run = `${view.name} ${theme}`;
            const seen = { violations: [], signed: [], refused: [] };
            const context = await browser.newContext({
                viewport: view.viewport, reducedMotion: 'reduce', colorScheme: theme,
                ...(view.phone ? { isMobile: true, hasTouch: true, userAgent: ANDROID_UA } : {}),
            });
            await context.exposeBinding('__reportCspViolation', (_s, v) => { seen.violations.push(v); });
            await context.addInitScript(([scale, dark]) => {
                document.addEventListener('securitypolicyviolation', (e) => {
                    window.__reportCspViolation({ directive: e.effectiveDirective, blocked: e.blockedURI, page: location.href });
                });
                localStorage.setItem('beanpool-theme-default-light-v1', 'done');
                localStorage.setItem('beanpool-theme-mode', dark ? 'dark' : 'light');
                document.addEventListener('DOMContentLoaded', () => {
                    const s = document.createElement('style');
                    s.textContent = `html { font-size: ${scale * 100}% !important; }`;
                    document.head.appendChild(s);
                });
            }, [view.textScale, theme === 'dark']);
            await context.route((url) => url.origin !== origin, (route) => route.abort());
            await context.route(`${origin}/api/**`, (route) => {
                const req = route.request();
                const url = new URL(req.url());
                const p = url.pathname;
                if (req.headers()['x-public-key']) seen.signed.push(p);
                if (!mayRead(p)) seen.refused.push(p);
                const reply = (status, body) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
                if (p === '/api/community/info') {
                    return reply(200, { memberCount: 42, postCount: 30, transactionCount: 0, commonsBalance: 0, profile: 'local', features: { beans: true, shareOutside: true } });
                }
                if (p === '/api/community/card') return reply(200, CARD);
                if (p === '/api/community/health') return reply(200, { status: 'ok', version: '1.2.31' });
                if (p === `/api/marketplace/posts/${POST_ID}` && url.searchParams.get('peek') === TICKET) return reply(200, { post: GUEST_POST });
                if (/^\/api\/marketplace\/posts\/[^/]+$/.test(p)) {
                    return reply(403, { error: "This community's listings are for its members. Join with an invite from a member, or look around the global community at global.beanpool.org.", code: 'members_only' });
                }
                if (/^\/api\/marketplace\/posts\/[^/]+\/photos\/[^/]+$/.test(p)) return route.fulfill({ status: 200, contentType: 'image/png', body: PHOTO });
                return reply(404, { error: 'Not Found' });
            });
            const page = await context.newPage();

            async function shot(name, { fullPage = false } = {}) {
                await page.waitForTimeout(300);
                const { scrollWidth, innerWidth } = await page.evaluate(() => ({
                    scrollWidth: Math.max(document.documentElement.scrollWidth, document.body.scrollWidth), innerWidth: window.innerWidth,
                }));
                if (scrollWidth > innerWidth) throw new Failure(`${name}: the page scrolls sideways (${scrollWidth}px in ${innerWidth}px)`);
                const text = await page.evaluate(() => document.body.innerText);
                const person = text.match(/\bhidden\b|Anonymous|Posted by|Elder|Steward|Resident|Newcomer|No ratings/);
                if (person) throw new Failure(`${name}: the page shows "${person[0]}"`);
                const avatars = await page.evaluate(() => Array.from(document.images).map((i) => i.getAttribute('src')).filter((s) => s && s.includes('/api/avatar/')));
                if (avatars.length) throw new Failure(`${name}: a face on the page: ${avatars.join(', ')}`);
                const file = path.join(SHOTS_DIR, `${name}-${view.name}-${theme}.png`);
                await page.screenshot({ path: file, fullPage });
                console.log(`  ${path.basename(file)}`);
            }

            try {
                // 1. the post
                await page.goto(`${origin}/app?post=${POST_ID}&peek=${TICKET}`);
                await page.getByTestId('peek-page').waitFor({ timeout: 15_000 });
                await page.getByText('A member of Castlemaine BeanPool shared this with you').waitFor();
                await page.getByTestId('community-card').waitFor();
                const kept = await page.evaluate(() => location.search);
                if (kept.includes('peek=')) throw new Failure(`the ticket stays in the address bar (${kept})`);
                await shot('peek-top');
                await page.getByTestId('peek-names-note').scrollIntoViewIfNeeded();
                await shot('peek-doors');
                const phoneDoors = await page.getByTestId('peek-open-app').count();
                if (view.phone !== (phoneDoors === 1)) throw new Failure(`Open in the BeanPool app: ${phoneDoors} on ${view.phone ? 'a phone' : 'a computer'}`);
                // 2. a link that opens nothing
                await page.goto(`${origin}/app?post=${STOPPED_ID}&peek=${TICKET}`);
                await page.getByTestId('peek-stopped').waitFor({ timeout: 15_000 });
                await shot('peek-stopped');
                if (seen.violations.length) throw new Failure(`policy violations: ${JSON.stringify(seen.violations.slice(0, 3))}`);
                if (seen.signed.length) throw new Failure(`signed requests from a stranger: ${seen.signed.join(', ')}`);
                if (seen.refused.length) throw new Failure(`reads a ticket holder doesn't make: ${[...new Set(seen.refused)].join(', ')}`);
                console.log(`✓ ${run}`);
            } catch (e) {
                failures.push(`${run}: ${e instanceof Failure ? e.message : e?.stack || e}`);
                console.log(`✗ ${run}`);
            }
            await context.close();
        }
    } finally {
        await browser?.close();
        await new Promise((r) => (server?.httpServer ? server.httpServer.close(r) : r()));
        fs.rmSync(outDir, { recursive: true, force: true });
    }
    console.log(`\nShots in ${SHOTS_DIR}`);
    if (failures.length) {
        console.log(failures.map((f) => `  ✗ ${f}`).join('\n'));
        process.exit(1);
    }
    process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
