/**
 * Ask to join from a browser (DESIGN-shared-listing-door-fable.md §2.1, §2.3, slice A1), in headless Chromium at 320x568
 * px with 1.3x text (a phone's browser: touch, Android) and at 1280 px (a computer's), light and dark:
 *   1. the shared post's doors (computer: Ask to join {name} · I have an invite · Already a member · 🌍 … first; phone:
 *      Open in the BeanPool app · or ask here in your browser · …)
 *   2. the form (Ask to join {name}, the line under it, Your name, A few words), filled
 *   3. Send: the waiting page ("You asked to join {name} on {date}. Your request arrived."), then a reload: still waiting
 *   3b. Tell me when they answer (web push W1): the card, with no service worker registered; tapped where the browser
 *       refuses (headless Chromium does): the blocked words, Get the app above them on a phone, still no worker; then
 *       with permission and the subscription kept: ✓ We'll tell you here when {name} answers.
 *   4. a yes: "🎉 {name} said yes." and Join {name}
 *   5. the bare card's `/app?door=ask`: the form open
 * The built web app is served as https://castlemaine.beanpool.org through Playwright's routing (a knock names an https
 * community), nothing leaves the machine: every other host is refused. Fails on any sideways scroll, any policy
 * violation, any read refused as a member's (401/403), any request the key signs that is not a public read or the
 * request's own (the knock, its status), and any request to another community's host.
 *
 * Run: node apps/pwa/e2e/ask-door-shots.mjs [out-dir]
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

const SHOTS_DIR = process.argv[2] || path.join(os.tmpdir(), 'bp-ask-door-shots');
const PHOTO = fs.readFileSync(path.join(PWA_DIR, 'public/assets/header-bg.png'));
const HOST = 'castlemaine.beanpool.org';
const SITE = `https://${HOST}`;
const VIEWS = [
    { name: '320', viewport: { width: 320, height: 568 }, textScale: 1.3, phone: true },
    { name: '1280', viewport: { width: 1280, height: 800 }, textScale: 1, phone: false },
];
const ANDROID_UA = 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Mobile Safari/537.36';
const TICKET = 'AbCdEfGhIjKlMnOpQrSt_-';
const POST_ID = '3f0c8a8e-1b2c-4d5e-8f90-123456789abc';
const PUBLIC = new Set(['/api/community/info', '/api/community/card', '/api/community/health', '/api/community/known-rule', `/api/marketplace/posts/${POST_ID}`]);
const KNOCK = new Set(['/api/join/knock', '/api/join/knock/status']);
const isPhoto = (p) => /^\/api\/marketplace\/posts\/[^/]+\/photos\/[^/]+$/.test(p);

const GUEST_POST = {
    id: POST_ID, type: 'offer', category: 'tools', title: 'Long ladder to lend for the weekend', status: 'active', active: true,
    description: 'A 6 m extension ladder, light enough for one person. Good for gutters and fruit trees.', credits: 15, priceType: 'fixed',
    photos: [`/api/marketplace/posts/${POST_ID}/photos/0?v=1&k=key`], createdAt: new Date(Date.now() - 86_400_000).toISOString(),
    audienceScope: 'public', lat: -37.1, lng: 144.2, repeatable: false,
    authorPublicKey: 'hidden', authorCallsign: '', authorAvatarUrl: null, authorEnergyCycled: 0, authorFoundingNeeded: false,
};
const CARD = {
    name: 'Castlemaine BeanPool', host: HOST, members: 42, area: { name: 'Castlemaine and around', radiusKm: 15 },
    joining: 'requests', askUrl: `${SITE}/app?door=ask`, globalUrl: 'https://global.beanpool.org',
};

async function loadPolicy() {
    const source = fs.readFileSync(POLICY_SOURCE, 'utf8');
    const { code } = await transformWithEsbuild(source, POLICY_SOURCE, { loader: 'ts', format: 'esm' });
    return import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`);
}

class Failure extends Error {}

async function main() {
    const policy = await loadPolicy();
    const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bp-ask-'));
    fs.mkdirSync(SHOTS_DIR, { recursive: true });
    let server;
    let browser;
    const failures = [];
    try {
        await build({ root: PWA_DIR, logLevel: 'error', build: { outDir, emptyOutDir: true } });
        server = await preview({ configFile: false, root: PWA_DIR, build: { outDir }, logLevel: 'warn', preview: { port: 0, open: false } });
        const local = server.resolvedUrls.local[0].replace(/\/$/, '');
        browser = await chromium.launch();
        for (const view of VIEWS) for (const theme of ['light', 'dark']) {
            const run = `${view.name} ${theme}`;
            const seen = { violations: [], signedElsewhere: [], refused: [], otherHosts: [], knocks: 0 };
            let status = { status: 'pending' };
            let asker = null;
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
            await context.route('**/*', async (route) => {
                const req = route.request();
                const url = new URL(req.url());
                if (url.origin !== SITE) {
                    seen.otherHosts.push(url.host);
                    return route.abort();
                }
                const p = url.pathname;
                const reply = (code, body) => route.fulfill({ status: code, contentType: 'application/json', body: JSON.stringify(body) });
                if (!p.startsWith('/api/')) {
                    // The web app as it ships, under the app document's policy.
                    const res = await route.fetch({ url: `${local}${p}${url.search}` });
                    const headers = { ...res.headers() };
                    if ((headers['content-type'] || '').includes('text/html')) {
                        headers['content-security-policy'] = policy.APP_DOCUMENT_CSP;
                        headers['referrer-policy'] = policy.APP_DOCUMENT_REFERRER_POLICY;
                    }
                    return route.fulfill({ response: res, headers });
                }
                const signer = req.headers()['x-public-key'] || null;
                if (signer && !PUBLIC.has(p) && !KNOCK.has(p) && !isPhoto(p)) seen.signedElsewhere.push(p);
                if (p === '/api/community/info') return reply(200, { memberCount: 42, postCount: 30, transactionCount: 0, commonsBalance: 0, profile: 'local', features: { beans: true, shareOutside: true } });
                if (p === '/api/community/card') return reply(200, CARD);
                if (p === '/api/community/health') return reply(200, { status: 'ok', version: '1.2.31' });
                if (p === `/api/marketplace/posts/${POST_ID}` && url.searchParams.get('peek') === TICKET) return reply(200, { post: GUEST_POST });
                if (isPhoto(p)) return route.fulfill({ status: 200, contentType: 'image/png', body: PHOTO });
                if (p === '/api/join/knock' && req.method() === 'POST') {
                    seen.knocks++;
                    asker = signer;
                    const body = JSON.parse(req.postData() || '{}');
                    if (body.toNode !== HOST) return reply(400, { error: 'wrong community', code: 'wrong_community' });
                    return reply(201, { knock: { status: 'pending' } });
                }
                if (p === '/api/join/knock/status') return reply(signer && signer === asker ? 200 : 401, signer === asker ? status : { error: 'no' });
                seen.refused.push(p);
                return reply(401, { error: 'Sign in first', code: 'read_auth' });
            });
            const page = await context.newPage();

            async function shot(name) {
                await page.waitForTimeout(300);
                const { scrollWidth, innerWidth } = await page.evaluate(() => ({
                    scrollWidth: Math.max(document.documentElement.scrollWidth, document.body.scrollWidth), innerWidth: window.innerWidth,
                }));
                if (scrollWidth > innerWidth) throw new Failure(`${name}: the page scrolls sideways (${scrollWidth}px in ${innerWidth}px)`);
                const file = path.join(SHOTS_DIR, `${name}-${view.name}-${theme}.png`);
                await page.screenshot({ path: file });
                console.log(`  ${path.basename(file)}`);
            }

            try {
                // 1. the shared post's doors
                await page.goto(`${SITE}/app?post=${POST_ID}&peek=${TICKET}`);
                await page.getByTestId('peek-page').waitFor({ timeout: 20_000 });
                await page.getByTestId('community-card').waitFor();
                await page.getByTestId('community-card-ask').scrollIntoViewIfNeeded();
                await shot('ask-1-doors');
                const askText = (await page.getByTestId('community-card-ask').textContent()) || '';
                const want = view.phone ? 'or ask here in your browser' : 'Ask to join Castlemaine BeanPool';
                if (askText !== want) throw new Failure(`the ask door reads "${askText}", not "${want}"`);
                // 2. the form
                await page.getByTestId('community-card-ask').click();
                await page.getByTestId('community-card-ask-form-name').fill('Sam Rivers');
                await page.getByTestId('community-card-ask-form-message').fill('I read the ladder listing. I live in Campbells Creek and grow fruit trees.');
                const stored = await page.evaluate(() => localStorage.getItem('beanpool_knock_key'));
                if (stored) throw new Failure('a key was written before Send');
                await page.getByTestId('community-card-ask-form-form').scrollIntoViewIfNeeded();
                await shot('ask-2-form');
                // 3. Send: waiting, and a reload keeps waiting
                await page.getByTestId('community-card-ask-form-send').click();
                await page.getByTestId('knock-waiting').waitFor({ timeout: 15_000 });
                await page.getByText('Your request arrived.').waitFor();
                await shot('ask-3-waiting');
                // 3b. Tell me when they answer: asked only at the tap.
                const workers = () => page.evaluate(async () => (await navigator.serviceWorker.getRegistrations()).length);
                await page.getByTestId('tell-me-card').scrollIntoViewIfNeeded();
                if (await workers()) throw new Failure('a service worker was registered before the tap');
                await shot('ask-3b-tell-me');
                await page.getByTestId('tell-me').click();
                await page.getByTestId('tell-me-off').waitFor({ timeout: 15_000 });
                if (view.phone !== (await page.getByTestId('tell-me-get-app').count() === 1)) throw new Failure('Get the app should show on a phone only');
                if (await workers()) throw new Failure('a service worker was registered though the browser refused');
                await page.getByTestId('tell-me-card').scrollIntoViewIfNeeded();
                await shot('ask-3c-tell-me-blocked');
                // The headless shell refuses notifications whatever it is granted, so the browser's yes is stood in for this
                // one shot (the subscription itself is the server suite's, test-web-push.ts, and the real walk's).
                await page.addInitScript(() => Object.defineProperty(Notification, 'permission', { get: () => 'granted' }));
                await page.evaluate(([origin, publicKey]) => localStorage.setItem('beanpool_web_push',
                    JSON.stringify([{ origin, publicKey, subId: 'ab'.repeat(32), pushKey: null, vapidKey: 'k' }])), [SITE, asker]);
                await page.reload();
                await page.getByTestId('tell-me-on').waitFor({ timeout: 15_000 });
                await page.getByTestId('tell-me-card').scrollIntoViewIfNeeded();
                await shot('ask-3d-tell-me-on');
                await page.reload();
                await page.getByTestId('knock-waiting').waitFor({ timeout: 15_000 });
                await page.getByText('Your request arrived.').waitFor();
                // 4. a yes
                status = { status: 'approved', invite: 'BP-YES1-YES2', expiresAt: null };
                await page.getByTestId('knock-waiting-check').click();
                await page.getByTestId('knock-waiting-yes').waitFor({ timeout: 15_000 });
                await shot('ask-4-yes');
                if (seen.knocks !== 1) throw new Failure(`${seen.knocks} knocks sent, not 1`);
                if (seen.otherHosts.some((h) => h !== HOST && !h.endsWith('.beanpool.org'))) throw new Failure(`requests to other hosts: ${[...new Set(seen.otherHosts)].join(', ')}`);
                if (seen.violations.length) throw new Failure(`policy violations: ${JSON.stringify(seen.violations.slice(0, 3))}`);
                if (seen.refused.length) throw new Failure(`reads refused as a member's: ${[...new Set(seen.refused)].join(', ')}`);
                if (seen.signedElsewhere.length) throw new Failure(`the key signed a member's read: ${[...new Set(seen.signedElsewhere)].join(', ')}`);
                console.log(`✓ ${run}`);
            } catch (e) {
                failures.push(`${run}: ${e instanceof Failure ? e.message : e?.stack || e}`);
                console.log(`✗ ${run}`);
                try { await shot('ask-failed'); } catch { /* the failure is reported */ }
            }
            await context.close();

            // 5. the bare card's `/app?door=ask`, a fresh browser: the form open
            const doorContext = await browser.newContext({
                viewport: view.viewport, reducedMotion: 'reduce', colorScheme: theme,
                ...(view.phone ? { isMobile: true, hasTouch: true, userAgent: ANDROID_UA } : {}),
            });
            try {
                await doorContext.addInitScript(([scale, dark]) => {
                    localStorage.setItem('beanpool-theme-default-light-v1', 'done');
                    localStorage.setItem('beanpool-theme-mode', dark ? 'dark' : 'light');
                    document.addEventListener('DOMContentLoaded', () => {
                        const s = document.createElement('style');
                        s.textContent = `html { font-size: ${scale * 100}% !important; }`;
                        document.head.appendChild(s);
                    });
                }, [view.textScale, theme === 'dark']);
                await doorContext.route('**/*', async (route) => {
                    const url = new URL(route.request().url());
                    if (url.origin !== SITE) return route.abort();
                    if (!url.pathname.startsWith('/api/')) return route.fulfill({ response: await route.fetch({ url: `${local}${url.pathname}${url.search}` }) });
                    const reply = (code, body) => route.fulfill({ status: code, contentType: 'application/json', body: JSON.stringify(body) });
                    if (url.pathname === '/api/community/info') return reply(200, { memberCount: 42, postCount: 30, transactionCount: 0, commonsBalance: 0, profile: 'local', features: { beans: true } });
                    if (url.pathname === '/api/community/card') return reply(200, CARD);
                    return reply(404, { error: 'Not Found' });
                });
                const doorPage = await doorContext.newPage();
                await doorPage.goto(`${SITE}/app?door=ask`);
                await doorPage.getByTestId('community-card-ask-form-form').waitFor({ timeout: 20_000 });
                await doorPage.getByTestId('community-card').scrollIntoViewIfNeeded();
                await doorPage.waitForTimeout(300);
                const { scrollWidth, innerWidth } = await doorPage.evaluate(() => ({ scrollWidth: document.documentElement.scrollWidth, innerWidth: window.innerWidth }));
                if (scrollWidth > innerWidth) throw new Failure(`door=ask: the page scrolls sideways (${scrollWidth}px in ${innerWidth}px)`);
                const file = path.join(SHOTS_DIR, `ask-5-door-${view.name}-${theme}.png`);
                await doorPage.screenshot({ path: file });
                console.log(`  ${path.basename(file)}`);
            } catch (e) {
                failures.push(`${run} door=ask: ${e instanceof Failure ? e.message : e?.stack || e}`);
            }
            await doorContext.close();
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
