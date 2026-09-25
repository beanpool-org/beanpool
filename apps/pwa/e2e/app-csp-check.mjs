/**
 * The real web app under the app document's Content-Security-Policy, in headless Chromium (design G11 §3.6 change 3).
 *
 * The node sends that policy with the web app on EVERY node (apps/server/src/app-document-csp.ts), so anything it
 * blocks breaks the web app everywhere. This builds the web app exactly as it ships (index.html, src/main.tsx, the
 * project's vite.config.ts) into a temp folder, serves it with the policy read from that server file, and opens it at
 * 320 px with 1.3x text and at 1280 px:
 *   - a fresh browser: the welcome page draws
 *   - a member: the Market draws its listings, the Map draws its tiles
 * and fails if the browser reports any violation of the policy, or asks any host outside the policy's own list.
 * A canary inline script is added last on each page; the check fails unless the policy blocks it and the violation
 * is reported, so "no violations" is never a watcher that saw nothing.
 *
 * Nothing here talks to a node or a provider: every /api call is answered from fixtures.mjs, and Google Fonts and
 * OpenStreetMap's tiles are answered by Playwright with stand-ins.
 *
 * Run: pnpm --filter @beanpool/pwa app-csp-check
 * Needs Chromium for Playwright once: pnpm --filter @beanpool/pwa exec playwright install --only-shell chromium
 */
/* global Buffer, URL, console, process, document, window, indexedDB -- Node, and the page's side of evaluate() */
import { build, preview, transformWithEsbuild } from 'vite';
import { chromium } from 'playwright';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { mockResponse } from './fixtures.mjs';

const PWA_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const POLICY_SOURCE = path.resolve(PWA_DIR, '../server/src/app-document-csp.ts');
process.chdir(PWA_DIR);

/** The server's own policy file, compiled on the fly: the check can never drift from what the node sends. */
async function loadPolicy() {
    const source = fs.readFileSync(POLICY_SOURCE, 'utf8');
    const { code } = await transformWithEsbuild(source, POLICY_SOURCE, { loader: 'ts', format: 'esm' });
    return import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`);
}

/** Hosts the policy lets the web app reach, and so the only ones it may ask. */
const ALLOWED_EXTERNAL = [/^fonts\.googleapis\.com$/, /^fonts\.gstatic\.com$/, /^[a-z]\.tile\.openstreetmap\.org$/, /^nominatim\.openstreetmap\.org$/];

const ONE_PIXEL_PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64');

/** A real Ed25519 key in the shape the web app keeps it (identity.ts): hex public key, hex PKCS8 private key. */
function memberIdentity() {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    return {
        publicKey: publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('hex'),
        privateKey: privateKey.export({ type: 'pkcs8', format: 'der' }).toString('hex'),
        callsign: 'Harness',
        createdAt: new Date().toISOString(),
    };
}

function apiAnswer(pathname, search, me) {
    if (pathname === `/api/community/membership/${me.publicKey}`) return { isMember: true, callsign: me.callsign };
    if (pathname === '/api/community/health') return { status: 'ok', memberCount: 4, version: 'harness' };
    return mockResponse(pathname, search);
}

const VIEWS = [
    { name: '320 px, 1.3x text', viewport: { width: 320, height: 720 }, textScale: 1.3 },
    { name: '1280 px', viewport: { width: 1280, height: 900 }, textScale: 1 },
];

async function checkView(browser, origin, view, me) {
    const failures = [];
    const violations = [];
    const consoleCsp = [];
    const unexpectedHosts = new Set();
    const asked = { fontCss: 0, tiles: 0 };

    const context = await browser.newContext({ viewport: view.viewport, reducedMotion: 'reduce' });
    await context.exposeBinding('__reportCspViolation', (_source, v) => { violations.push(v); });
    await context.addInitScript(() => {
        document.addEventListener('securitypolicyviolation', (e) => {
            window.__reportCspViolation({ directive: e.effectiveDirective, blocked: e.blockedURI, sample: e.sample, at: `${e.sourceFile}:${e.lineNumber}` });
        });
    });

    // Later routes win, so the catch-all for other hosts goes first. A request the policy blocks never gets here.
    await context.route((url) => url.origin !== origin, (route) => {
        const host = new URL(route.request().url()).hostname;
        if (!ALLOWED_EXTERNAL.some((re) => re.test(host))) unexpectedHosts.add(host);
        return route.abort();
    });
    await context.route('https://fonts.googleapis.com/**', (route) => {
        asked.fontCss++;
        return route.fulfill({
            status: 200,
            contentType: 'text/css',
            body: "@font-face { font-family: 'Inter'; font-style: normal; font-weight: 400; font-display: swap; src: url(https://fonts.gstatic.com/s/inter/v0/harness.woff2) format('woff2'); }",
        });
    });
    await context.route('https://fonts.gstatic.com/**', (route) => route.fulfill({ status: 404, body: '' }));
    await context.route(/^https:\/\/[a-z]\.tile\.openstreetmap\.org\//, (route) => {
        asked.tiles++;
        return route.fulfill({ status: 200, contentType: 'image/png', body: ONE_PIXEL_PNG });
    });
    await context.route(`${origin}/api/**`, (route) => {
        const url = new URL(route.request().url());
        const body = apiAnswer(url.pathname, url.search, me);
        if (body === undefined) return route.fulfill({ status: 404, contentType: 'application/json', body: JSON.stringify({ error: 'Not Found' }) });
        return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
    });
    // The live feed has nothing to say here; closed, so it does not retry noisily.
    await context.routeWebSocket(/\/ws/, (ws) => ws.close());

    const page = await context.newPage();
    page.on('console', (msg) => { if (/content security policy/i.test(msg.text())) consoleCsp.push(msg.text()); });
    const scaleText = async () => {
        if (view.textScale !== 1) await page.addStyleTag({ content: `html { font-size: ${view.textScale * 100}% !important; }` });
    };

    // A fresh browser: the welcome page.
    const doc = await page.goto(`${origin}/app`, { waitUntil: 'load' });
    const servedPolicy = doc?.headers()['content-security-policy'];
    if (!servedPolicy?.includes("script-src 'self';")) failures.push(`the document was not served under the app policy (got ${servedPolicy})`);
    await scaleText();
    try {
        await page.getByText('Welcome to BeanPool').waitFor({ timeout: 20_000 });
    } catch {
        failures.push('the welcome page did not draw');
    }

    // A member: the key goes where the web app keeps it, then the app opens on the Market.
    await page.evaluate((identity) => new Promise((resolve, reject) => {
        const open = indexedDB.open('beanpool-identity', 1);
        open.onupgradeneeded = () => open.result.createObjectStore('keys');
        open.onerror = () => reject(open.error);
        open.onsuccess = () => {
            const tx = open.result.transaction('keys', 'readwrite');
            tx.objectStore('keys').put(identity, 'sovereign-identity');
            tx.oncomplete = () => { open.result.close(); resolve(); };
            tx.onerror = () => reject(tx.error);
        };
    }), me);
    await page.goto(`${origin}/app`, { waitUntil: 'load' });
    await scaleText();
    try {
        await page.getByText('Chainsaw, sharpened').first().waitFor({ timeout: 20_000 });
    } catch {
        failures.push('the Market did not draw its listings');
    }

    // The Map: Leaflet and OpenStreetMap's tiles.
    try {
        await page.locator('button:visible').filter({ has: page.locator('span', { hasText: /^Map$/ }) }).first().click();
        await page.locator('.leaflet-container').waitFor({ timeout: 20_000 });
        await page.locator('img.leaflet-tile-loaded').first().waitFor({ timeout: 20_000 });
    } catch (e) {
        failures.push(`the Map did not draw its tiles (${e.message.split('\n')[0]})`);
    }
    await page.waitForLoadState('networkidle').catch(() => {});
    await page.waitForTimeout(500);

    if (asked.fontCss === 0) failures.push('the Inter stylesheet was never asked for');
    if (asked.tiles === 0) failures.push('no map tile was asked for');
    if (unexpectedHosts.size) failures.push(`asked hosts outside the policy's list: ${[...unexpectedHosts].join(', ')}`);
    const seen = violations.slice();
    const seenConsole = consoleCsp.slice();
    if (seen.length) failures.push(`policy violations: ${JSON.stringify(seen)}`);
    if (seenConsole.length) failures.push(`CSP errors in the console: ${JSON.stringify(seenConsole)}`);

    // The canary: an inline script must be refused, and reported.
    const canaryRan = await page.evaluate(() => {
        const s = document.createElement('script');
        s.textContent = 'window.__cspCanaryRan = true;';
        document.head.appendChild(s);
        return window.__cspCanaryRan === true;
    });
    await page.waitForTimeout(300);
    const canaryReported = violations.slice(seen.length).some((v) => v.directive.startsWith('script-src') && v.blocked === 'inline');
    if (canaryRan) failures.push('the canary inline script RAN: the policy is not in force');
    if (!canaryReported) failures.push('the canary inline script was not reported: the violation watcher is not working');

    await context.close();
    return { failures, asked, violations: seen.length, canary: !canaryRan && canaryReported };
}

async function main() {
    const policy = await loadPolicy();
    const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bp-app-csp-'));
    let server;
    let browser;
    let failed = false;
    try {
        await build({ root: PWA_DIR, logLevel: 'warn', build: { outDir, emptyOutDir: true } });
        server = await preview({
            configFile: false,
            root: PWA_DIR,
            build: { outDir },
            logLevel: 'warn',
            preview: {
                port: 0,
                open: false,
                headers: { 'Content-Security-Policy': policy.APP_DOCUMENT_CSP, 'Referrer-Policy': policy.APP_DOCUMENT_REFERRER_POLICY },
            },
        });
        const origin = server.resolvedUrls.local[0].replace(/\/$/, '');
        browser = await chromium.launch();
        console.log(`The web app under: ${policy.APP_DOCUMENT_CSP}\n`);
        for (const view of VIEWS) {
            const result = await checkView(browser, origin, view, memberIdentity());
            if (result.failures.length) {
                failed = true;
                console.error(`✗ ${view.name}:`);
                for (const f of result.failures) console.error(`    ${f}`);
            } else {
                console.log(`✓ ${view.name}: welcome page, Market and Map drew; Inter asked ${result.asked.fontCss}x, `
                    + `${result.asked.tiles} tile(s); 0 violations; the canary inline script was blocked and reported`);
            }
        }
    } finally {
        await browser?.close();
        if (server) await new Promise((resolve) => server.httpServer.close(resolve));
        fs.rmSync(outDir, { recursive: true, force: true });
    }
    if (failed) {
        console.error('\n❌ The web app does not run cleanly under the app document policy.');
        process.exit(1);
    }
    console.log('\n⭐️ The web app runs under the app document policy at 320 px and 1280 px with nothing blocked.');
}

main().catch((e) => { console.error('❌', e); process.exit(1); });
