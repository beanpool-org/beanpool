/**
 * Joining the global node in a web browser (design G11-b), in headless Chromium, end to end in the page.
 *
 * Builds the web app exactly as it ships (as app-csp-check.mjs does), serves it under the app document's
 * Content-Security-Policy read from apps/server/src/app-document-csp.ts, and at 1280 px and at 320 px with 1.3x text:
 *   - draws every join screen (lobby, "have you used BeanPool before?", name, sign-in, GitHub's code, the return),
 *     then the photo, 12 words and tour steps, into the app
 *   - leaves the page for Google, Apple and Facebook and comes back: each provider is a Playwright route answering
 *     with a redirect to /app/auth/<provider> carrying a fixture token (Apple: a form POST to the return URL, answered
 *     303 as the node's apple-return route does), and a reload on the way through
 *   - the rate-limit and expired-sign-in paths, 409 already_joined → the restore buttons
 * and fails on any horizontal scroll, any policy violation, a token left in the address bar, or a join the stub node
 * did not expect (wrong key, wrong nonce, an access token sent).
 *
 * Nothing here talks to a node or a provider: /api is answered by the stubs below (and fixtures.mjs for the Market),
 * and every provider host is answered by Playwright. The tokens are fixtures, not signed by anyone.
 *
 * Run: pnpm --filter @beanpool/pwa web-join-check
 * Needs Chromium for Playwright once: pnpm --filter @beanpool/pwa exec playwright install --only-shell chromium
 */
/* global Buffer, URL, URLSearchParams, console, process, document, window, indexedDB, location, localStorage, sessionStorage -- Node, and the page's side of evaluate() */
import { build, preview, transformWithEsbuild } from 'vite';
import { chromium } from 'playwright';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { mockResponse } from './fixtures.mjs';

const PWA_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const POLICY_SOURCE = path.resolve(PWA_DIR, '../server/src/app-document-csp.ts');
process.chdir(PWA_DIR);

const SHOTS_DIR = process.env.WEB_JOIN_SHOTS || path.join(os.tmpdir(), 'bp-web-join-shots');

async function loadPolicy() {
    const source = fs.readFileSync(POLICY_SOURCE, 'utf8');
    const { code } = await transformWithEsbuild(source, POLICY_SOURCE, { loader: 'ts', format: 'esm' });
    return import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`);
}

const VIEWS = [
    { name: '1280', viewport: { width: 1280, height: 900 }, textScale: 1 },
    { name: '320x1.3', viewport: { width: 320, height: 720 }, textScale: 1.3 },
];

const CLIENT_IDS = { google: 'web-client.apps.googleusercontent.com', apple: 'org.beanpool.web', facebook: '818892721251369' };

function b64url(s) {
    return Buffer.from(s).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** A token in the shape a provider sends, carrying the nonce it was asked for. Unsigned: the stub node does not verify. */
function fixtureToken(provider, nonce, sub) {
    const iss = { google: 'https://accounts.google.com', apple: 'https://appleid.apple.com', facebook: 'https://www.facebook.com' }[provider];
    return `${b64url(JSON.stringify({ alg: 'RS256', kid: 'fixture' }))}.${b64url(JSON.stringify({ iss, aud: CLIENT_IDS[provider], sub, nonce, exp: 9999999999 }))}.Zml4dHVyZQ`;
}

class Failure extends Error {}

/**
 * One browser context with the node and the providers stubbed. `join` answers POST /api/join; everything the stubs
 * saw is kept for the checks.
 */
async function openScenario(browser, origin, view, { join, nonce: nonceAnswer, github } = {}) {
    const seen = { nonces: [], joins: [], providerVisits: [], violations: [], unexpectedHosts: new Set(), members: new Set() };
    const context = await browser.newContext({ viewport: view.viewport, reducedMotion: 'reduce' });
    await context.exposeBinding('__reportCspViolation', (_s, v) => { seen.violations.push(v); });
    await context.addInitScript(([scale]) => {
        document.addEventListener('securitypolicyviolation', (e) => {
            window.__reportCspViolation({ directive: e.effectiveDirective, blocked: e.blockedURI, at: `${e.sourceFile}:${e.lineNumber}`, page: location.href });
        });
        if (scale !== 1) {
            document.addEventListener('DOMContentLoaded', () => {
                const s = document.createElement('style');
                s.textContent = `html { font-size: ${scale * 100}% !important; }`;
                document.head.appendChild(s);
            });
        }
    }, [view.textScale]);

    // Other hosts first: later routes win.
    await context.route((url) => url.origin !== origin, (route) => {
        seen.unexpectedHosts.add(new URL(route.request().url()).hostname);
        return route.abort();
    });
    await context.route('https://fonts.googleapis.com/**', (route) => route.fulfill({ status: 200, contentType: 'text/css', body: '' }));
    await context.route('https://fonts.gstatic.com/**', (route) => route.fulfill({ status: 404, body: '' }));

    // The providers. Each answers as the real one does on success: straight back to the return URL.
    await context.route('https://accounts.google.com/**', (route) => {
        const q = new URL(route.request().url()).searchParams;
        seen.providerVisits.push({ provider: 'google', state: q.get('state'), nonce: q.get('nonce'), query: Object.fromEntries(q) });
        const token = fixtureToken('google', q.get('nonce'), 'google-sub-1');
        return route.fulfill({ status: 302, headers: { Location: `${q.get('redirect_uri')}#state=${encodeURIComponent(q.get('state'))}&id_token=${token}&authuser=0&prompt=consent` } });
    });
    await context.route('https://www.facebook.com/**', (route) => {
        const q = new URL(route.request().url()).searchParams;
        seen.providerVisits.push({ provider: 'facebook', state: q.get('state'), nonce: q.get('nonce'), query: Object.fromEntries(q) });
        const token = fixtureToken('facebook', q.get('nonce'), 'facebook-sub-1');
        return route.fulfill({
            status: 302,
            headers: {
                Location: `${q.get('redirect_uri')}#access_token=EAAB-fixture-access-token&data_access_expiration_time=1&expires_in=5183`
                    + `&id_token=${token}&long_lived_token=LL-fixture-long-lived&state=${encodeURIComponent(q.get('state'))}`,
            },
        });
    });
    await context.route('https://appleid.apple.com/**', (route) => {
        const q = new URL(route.request().url()).searchParams;
        seen.providerVisits.push({ provider: 'apple', state: q.get('state'), nonce: q.get('nonce'), query: Object.fromEntries(q) });
        const token = fixtureToken('apple', q.get('nonce'), 'apple-sub-1');
        // Apple's form_post: its page makes the browser POST the answer to the return URL.
        const html = `<!doctype html><form method="post" action="${q.get('redirect_uri')}">`
            + `<input name="state" value="${q.get('state')}"><input name="code" value="c0de"><input name="id_token" value="${token}">`
            + '</form><script>document.forms[0].submit()</script>';
        return route.fulfill({ status: 200, contentType: 'text/html', body: html });
    });
    // The node's apple-return route (apps/server/src/routes/apple-return.ts): the form POST becomes a 303 with a fragment.
    await context.route(`${origin}/app/auth/apple`, (route) => {
        if (route.request().method() !== 'POST') return route.fallback();
        const form = new URLSearchParams(route.request().postData() || '');
        return route.fulfill({
            status: 303,
            headers: { Location: `/app/auth/apple#state=${encodeURIComponent(form.get('state'))}&id_token=${encodeURIComponent(form.get('id_token'))}`, 'Cache-Control': 'no-store' },
        });
    });

    // The node.
    let nonceCount = 0;
    await context.route(`${origin}/api/**`, async (route) => {
        const req = route.request();
        const url = new URL(req.url());
        const key = req.headers()['x-public-key'];
        const reply = (status, body, headers = {}) => route.fulfill({ status, contentType: 'application/json', headers, body: JSON.stringify(body) });
        const p = url.pathname;
        if (p === '/api/community/info') {
            return reply(200, { memberCount: 3, postCount: 4, transactionCount: 0, commonsBalance: 0, profile: 'global', features: { openJoin: true, beans: false } });
        }
        if (p.startsWith('/api/members/callsign-available/')) return reply(200, { callsign: decodeURIComponent(p.split('/').pop()), available: true, tooShort: false });
        if (p === '/api/join/sso-nonce') {
            if (key && seen.members.has(key)) return reply(409, { error: 'This key is already a member of this community.', code: 'already_member' });
            const nonce = `nonce-${++nonceCount}-${'x'.repeat(30)}`;
            seen.nonces.push({ nonce, key });
            const answer = nonceAnswer ? nonceAnswer(nonce) : null;
            return reply(200, answer ?? { nonce, expiresInSeconds: 600, providers: ['google', 'apple', 'facebook', 'github'], githubFlow: 'node', clientIds: CLIENT_IDS });
        }
        if (p === '/api/join/github/start') {
            return reply(200, { sessionId: 'gh-session-1', userCode: 'WDJB-MJHT', verificationUri: 'https://github.com/login/device', expiresInSeconds: 900, intervalSeconds: 1 });
        }
        if (p === '/api/join/github/poll') {
            const r = github ? github() : { status: 200, body: { status: 'ok', sub: 'github-sub-1' } };
            return reply(r.status, r.body, r.headers);
        }
        if (p === '/api/join') {
            const body = JSON.parse(req.postData() || '{}');
            const raw = req.postData() || '';
            seen.joins.push({ body, key, raw });
            const r = await join(body, key, seen);
            if (r.status === 200) seen.members.add(key);
            if (r.hang) return; // never answered: the page is reloaded under it
            return reply(r.status, r.body);
        }
        if (p.startsWith('/api/community/membership/')) {
            const k = decodeURIComponent(p.split('/').pop());
            return reply(200, { isMember: seen.members.has(k), callsign: seen.members.has(k) ? 'Alice' : null });
        }
        if (p === '/api/community/health') return reply(200, { status: 'ok', memberCount: 4, version: 'harness' });
        const body = mockResponse(p, url.search);
        if (body === undefined) return reply(p.startsWith('/api/onboarding') || req.method() === 'POST' ? 200 : 404, body === undefined ? {} : body);
        return reply(200, body);
    });
    await context.routeWebSocket(/\/ws/, (ws) => ws.close());

    const page = await context.newPage();
    return { context, page, seen };
}

let shotCount = 0;
async function shot(page, view, name) {
    fs.mkdirSync(SHOTS_DIR, { recursive: true });
    const file = path.join(SHOTS_DIR, `${String(++shotCount).padStart(2, '0')}-${view.name}-${name}.png`);
    await page.screenshot({ path: file, fullPage: true });
}

/** No sideways scrolling: the page is no wider than the window. */
async function noSideScroll(page, where) {
    const { scrollWidth, innerWidth } = await page.evaluate(() => ({
        scrollWidth: Math.max(document.documentElement.scrollWidth, document.body.scrollWidth),
        innerWidth: window.innerWidth,
    }));
    if (scrollWidth > innerWidth) throw new Failure(`${where}: the page scrolls sideways (${scrollWidth}px in a ${innerWidth}px window)`);
}

async function screenIs(page, name, where, timeout = 20_000) {
    try {
        await page.getByTestId(`join-screen-${name}`).waitFor({ timeout });
    } catch {
        const current = await page.locator('[data-testid^="join-screen-"]').first().getAttribute('data-testid').catch(() => 'none');
        throw new Failure(`${where}: expected the ${name} screen, found ${current}`);
    }
}

async function pendingKey(page) {
    return page.evaluate(() => new Promise((resolve, reject) => {
        const open = indexedDB.open('beanpool-identity', 1);
        open.onupgradeneeded = () => open.result.createObjectStore('keys');
        open.onerror = () => reject(open.error);
        open.onsuccess = () => {
            const req = open.result.transaction('keys', 'readonly').objectStore('keys').get('pending-join');
            req.onsuccess = () => resolve(req.result?.identity?.publicKey ?? null);
            req.onerror = () => reject(req.error);
        };
    }));
}

async function storedIdentityKey(page) {
    return page.evaluate(() => new Promise((resolve, reject) => {
        const open = indexedDB.open('beanpool-identity', 1);
        open.onupgradeneeded = () => open.result.createObjectStore('keys');
        open.onerror = () => reject(open.error);
        open.onsuccess = () => {
            const req = open.result.transaction('keys', 'readonly').objectStore('keys').get('sovereign-identity');
            req.onsuccess = () => resolve(req.result?.publicKey ?? null);
            req.onerror = () => reject(req.error);
        };
    }));
}

/** Lobby → "I'm new" → name → the sign-in screen, drawing and checking each. */
async function toSignIn(page, origin, view, name, { shots = false } = {}) {
    await page.goto(`${origin}/app`, { waitUntil: 'load' });
    await screenIs(page, 'lobby', 'arrival');
    await noSideScroll(page, 'lobby');
    if (shots) await shot(page, view, 'lobby');
    const join = page.getByTestId('join-start');
    await join.waitFor();
    await page.waitForFunction(() => !document.querySelector('[data-testid="join-start"]')?.hasAttribute('disabled'), null, { timeout: 10_000 });
    await join.click();
    await screenIs(page, 'guard', 'after Join');
    await noSideScroll(page, 'guard');
    if (shots) await shot(page, view, 'guard');
    await page.getByTestId('join-new').click();
    await screenIs(page, 'name', 'after "I\'m new"');
    await page.getByTestId('join-callsign').fill(name);
    await page.getByText('✓ Available').waitFor({ timeout: 10_000 });
    await noSideScroll(page, 'name');
    if (shots) await shot(page, view, 'name');
    await page.getByTestId('join-name-next').click();
    await screenIs(page, 'providers', 'after the name');
    await page.getByTestId('join-provider-google').waitFor();
    await noSideScroll(page, 'sign-in');
    if (shots) await shot(page, view, 'sign-in');
}

/** Back from a provider, the address bar holds nothing of the token. */
async function addressBarClean(page, origin, where) {
    const url = page.url();
    if (url !== `${origin}/app`) throw new Failure(`${where}: the address bar still reads ${url}`);
}

/** Photo, 12 words, tour, and into the app. */
async function throughOnboarding(page, view, { shots = false } = {}) {
    await page.getByTestId('onboarding-stepper').waitFor({ timeout: 20_000 });
    const bar = await page.getByTestId('onboarding-stepper').innerText();
    if (!/Sign in/.test(bar)) throw new Failure(`the steps bar says "${bar.replace(/\s+/g, ' ')}", not "Sign in"`);
    await noSideScroll(page, 'photo step');
    if (shots) await shot(page, view, 'photo');
    await page.getByTitle('Green Bean').click();
    await page.getByRole('button', { name: 'Next →' }).click();
    await page.getByText('Your Safety Backup').waitFor();
    await noSideScroll(page, '12 words step');
    if (shots) await shot(page, view, 'words');
    await page.getByRole('button', { name: 'Next →' }).click();
    await page.getByRole('button', { name: "Let's Begin! 🚀" }).waitFor();
    await noSideScroll(page, 'tour step');
    await page.getByRole('button', { name: "Let's Begin! 🚀" }).click();
    await page.getByText('Chainsaw, sharpened').first().waitFor({ timeout: 20_000 });
}

function joinOk(callsign = 'Alice') {
    return async (body, key) => ({ status: 200, body: { success: true, member: { publicKey: key, callsign: body.callsign || callsign }, provider: body.provider } });
}

/** The join the stub node saw: the pending key signed it, with the nonce the page sent to the provider, and nothing else. */
function checkJoin(seen, provider, key, where) {
    const j = seen.joins.at(-1);
    if (!j) throw new Failure(`${where}: no join reached the node`);
    if (j.key !== key) throw new Failure(`${where}: the join was signed by ${j.key}, not the pending key ${key}`);
    if (j.body.provider !== provider) throw new Failure(`${where}: joined with ${j.body.provider}`);
    if (/EAAB-fixture|LL-fixture|access_token|long_lived/.test(j.raw)) throw new Failure(`${where}: the join carried Facebook's access or long-lived token`);
    if (provider !== 'github') {
        const visit = seen.providerVisits.filter((v) => v.provider === provider).at(-1);
        if (!visit) throw new Failure(`${where}: never went to ${provider}`);
        if (visit.state !== visit.nonce) throw new Failure(`${where}: state ${visit.state} is not the nonce ${visit.nonce}`);
        if (j.body.nonce !== visit.nonce) throw new Failure(`${where}: the join's nonce ${j.body.nonce} is not the one sent to ${provider} (${visit.nonce})`);
        const issued = seen.nonces.find((n) => n.nonce === visit.nonce);
        if (!issued || issued.key !== key) throw new Failure(`${where}: the nonce was not issued to the joining key`);
        if (!j.body.idToken || j.body.idToken.split('.').length !== 3) throw new Failure(`${where}: no id_token in the join`);
    } else if (j.body.proof?.sessionId !== 'gh-session-1') {
        throw new Failure(`${where}: the GitHub join carried ${JSON.stringify(j.body.proof)}`);
    }
}

const SCENARIOS = [
    {
        name: 'Google: every screen, a reload on the sign-in screen, the round trip, into the app',
        async run(page, origin, view, seen) {
            await toSignIn(page, origin, view, 'Alice', { shots: true });
            const key = await pendingKey(page);
            // A reload (or a closed tab) on the way: the same key and name, and a fresh nonce.
            await page.reload({ waitUntil: 'load' });
            await screenIs(page, 'providers', 'after a reload');
            if ((await page.getByTestId('join-as').innerText()) !== 'Alice') throw new Failure('the name was lost on reload');
            if ((await pendingKey(page)) !== key) throw new Failure('a reload made a second key');
            await page.getByTestId('join-provider-google').click();
            await page.getByTestId('onboarding-stepper').waitFor({ timeout: 20_000 });
            await addressBarClean(page, origin, 'back from Google');
            checkJoin(seen, 'google', key, 'Google');
            const q = seen.providerVisits[0].query;
            if (q.client_id !== CLIENT_IDS.google || q.response_type !== 'id_token' || q.redirect_uri !== `${origin}/app/auth/google`) {
                throw new Failure(`Google was asked ${JSON.stringify(q)}`);
            }
            await throughOnboarding(page, view, { shots: true });
            if ((await storedIdentityKey(page)) !== key) throw new Failure('the app is not using the key that joined');
            if ((await pendingKey(page)) !== null) throw new Failure('the pending join was left behind');
        },
        join: joinOk(),
    },
    {
        name: 'the return survives a reload: the join was sent, the page reloaded before it answered, and the member is in',
        async run(page, origin, view, seen) {
            await toSignIn(page, origin, view, 'Alice');
            const key = await pendingKey(page);
            await page.getByTestId('join-provider-google').click();
            await page.getByTestId('join-joining').waitFor({ timeout: 20_000 });
            await addressBarClean(page, origin, 'back from Google');
            await page.reload({ waitUntil: 'load' });
            // The node had the member: the page asks, is told "already a member", and carries on.
            await page.getByTestId('onboarding-stepper').waitFor({ timeout: 20_000 });
            if ((await storedIdentityKey(page)) !== key) throw new Failure('after the reload the identity is not the one that joined');
            if (seen.joins.length !== 1) throw new Failure(`${seen.joins.length} joins were sent`);
        },
        // The node takes the member and never answers this request.
        join: async (_b, key, seen) => { seen.members.add(key); return { hang: true }; },
    },
    {
        name: 'Apple: form_post to the return URL, 303 with the fragment, joined',
        async run(page, origin, view, seen) {
            await toSignIn(page, origin, view, 'Alice');
            const key = await pendingKey(page);
            await page.getByTestId('join-provider-apple').click();
            await page.getByTestId('onboarding-stepper').waitFor({ timeout: 20_000 });
            await addressBarClean(page, origin, 'back from Apple');
            checkJoin(seen, 'apple', key, 'Apple');
            const q = seen.providerVisits[0].query;
            if ('scope' in q || q.response_mode !== 'form_post' || q.client_id !== CLIENT_IDS.apple) throw new Failure(`Apple was asked ${JSON.stringify(q)}`);
        },
        join: joinOk(),
    },
    {
        name: "Facebook: only the id_token is sent; the access and long-lived tokens leave the address bar unread",
        async run(page, origin, view, seen) {
            await toSignIn(page, origin, view, 'Alice');
            const key = await pendingKey(page);
            await page.getByTestId('join-provider-facebook').click();
            await page.getByTestId('onboarding-stepper').waitFor({ timeout: 20_000 });
            await addressBarClean(page, origin, 'back from Facebook');
            checkJoin(seen, 'facebook', key, 'Facebook');
            const stored = await page.evaluate(() => JSON.stringify({ ls: { ...localStorage }, ss: { ...sessionStorage } }));
            if (/EAAB-fixture|LL-fixture/.test(stored)) throw new Failure("Facebook's tokens were kept in web storage");
        },
        join: joinOk(),
    },
    {
        name: "GitHub: the code screen, the wait, joined with the node's session",
        async run(page, origin, view, seen) {
            await toSignIn(page, origin, view, 'Alice');
            const key = await pendingKey(page);
            await page.getByTestId('join-provider-github').click();
            await screenIs(page, 'github', 'after GitHub');
            await page.getByTestId('join-github-code').waitFor();
            await noSideScroll(page, 'GitHub code');
            await shot(page, view, 'github-code');
            await page.getByTestId('onboarding-stepper').waitFor({ timeout: 20_000 });
            checkJoin(seen, 'github', key, 'GitHub');
        },
        join: joinOk(),
        // First poll pending (the code is being typed), then ok.
        github: (() => { let n = 0; return () => (++n === 1 ? { status: 200, body: { status: 'pending', intervalSeconds: 1 } } : { status: 200, body: { status: 'ok', sub: 'github-sub-1' } }); })(),
    },
    {
        name: "rate limited: the node's sentence, and the same key kept for later",
        async run(page, origin, view) {
            await toSignIn(page, origin, view, 'Alice');
            const key = await pendingKey(page);
            await page.getByTestId('join-provider-google').click();
            const notice = page.getByTestId('join-notice');
            await notice.waitFor({ timeout: 20_000 });
            const text = await notice.innerText();
            if (!text.includes('Too many new accounts have joined from this network in the last hour (5).')) throw new Failure(`the rate limit said "${text}"`);
            await screenIs(page, 'providers', 'rate limited');
            await noSideScroll(page, 'rate limited');
            await shot(page, view, 'rate-limited');
            await page.reload({ waitUntil: 'load' });
            await screenIs(page, 'providers', 'rate limited, reloaded');
            if ((await pendingKey(page)) !== key) throw new Failure('the key was not kept after the rate limit');
        },
        join: async () => ({ status: 429, body: { code: 'rate_limited', error: 'Too many new accounts have joined from this network in the last hour (5). Please try again later.' } }),
    },
    {
        name: 'expired sign-in: one automatic trip back to Google with a fresh nonce, then joined',
        async run(page, origin, view, seen) {
            await toSignIn(page, origin, view, 'Alice');
            const key = await pendingKey(page);
            await page.getByTestId('join-provider-google').click();
            await page.getByTestId('onboarding-stepper').waitFor({ timeout: 30_000 });
            const google = seen.providerVisits.filter((v) => v.provider === 'google');
            if (google.length !== 2) throw new Failure(`went to Google ${google.length} times`);
            if (google[0].nonce === google[1].nonce) throw new Failure('the retry reused the spent nonce');
            if (seen.joins.length !== 2) throw new Failure(`${seen.joins.length} joins`);
            checkJoin(seen, 'google', key, 'after the retry');
        },
        join: async (body, key, seen) => (seen.joins.length === 1
            ? { status: 401, body: { code: 'sign_in', error: 'Google sign-in could not be matched to this request.' } }
            : { status: 200, body: { success: true, member: { publicKey: key, callsign: body.callsign } } }),
    },
    {
        name: 'expired twice: the message and the buttons, no third trip',
        async run(page, origin, view, seen) {
            await toSignIn(page, origin, view, 'Alice');
            await page.getByTestId('join-provider-google').click();
            await page.waitForFunction(() => /expired/.test(document.querySelector('[data-testid="join-notice"]')?.textContent || '')
                && !!document.querySelector('[data-testid="join-provider-google"]'), null, { timeout: 30_000 });
            await screenIs(page, 'providers', 'expired twice');
            if (seen.providerVisits.length !== 2) throw new Failure(`went to Google ${seen.providerVisits.length} times`);
            await noSideScroll(page, 'expired');
            await shot(page, view, 'expired');
        },
        join: async () => ({ status: 401, body: { code: 'sign_in', error: 'Google sign-in could not be matched to this request.' } }),
    },
    {
        name: '409 already_joined: the restore buttons, and the new key is gone',
        async run(page, origin, view) {
            await toSignIn(page, origin, view, 'Alice');
            await page.getByTestId('join-provider-google').click();
            await screenIs(page, 'already_joined', '409 already_joined');
            await page.getByTestId('join-restore-words').waitFor();
            await page.getByTestId('join-restore-phone').waitFor();
            await noSideScroll(page, 'already joined');
            await shot(page, view, 'already-joined');
            if ((await pendingKey(page)) !== null) throw new Failure('the unused key was kept');
            if ((await storedIdentityKey(page)) !== null) throw new Failure('an identity was saved');
            await page.getByTestId('join-restore-words').click();
            await page.getByText('Recover with 12 Words').waitFor();
            await noSideScroll(page, 'restore with words');
        },
        join: async () => ({ status: 409, body: { code: 'already_joined', error: 'This Google account already has a BeanPool identity here. Restore it with your 12 words or your sign-in instead.' } }),
    },
];

async function main() {
    const policy = await loadPolicy();
    const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bp-web-join-'));
    fs.rmSync(SHOTS_DIR, { recursive: true, force: true });
    let server;
    let browser;
    const failures = [];
    try {
        await build({ root: PWA_DIR, logLevel: 'error', build: { outDir, emptyOutDir: true } });
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
        for (const view of VIEWS) {
            for (const scenario of SCENARIOS) {
                const { context, page, seen } = await openScenario(browser, origin, view, scenario);
                const label = `${view.name}: ${scenario.name}`;
                try {
                    await scenario.run(page, origin, view, seen);
                    await page.waitForTimeout(200);
                    if (seen.violations.length) throw new Failure(`policy violations: ${JSON.stringify(seen.violations)}`);
                    const hosts = [...seen.unexpectedHosts].filter((h) => h !== 'github.com');
                    if (hosts.length) throw new Failure(`asked hosts outside the stubs: ${hosts.join(', ')}`);
                    console.log(`✓ ${label}`);
                } catch (e) {
                    failures.push(label);
                    console.error(`✗ ${label}\n    ${e instanceof Failure ? e.message : e.stack}`);
                    await shot(page, view, 'FAILED').catch(() => {});
                } finally {
                    await context.close();
                }
            }
        }
    } finally {
        await browser?.close();
        if (server) await new Promise((resolve) => server.httpServer.close(resolve));
        fs.rmSync(outDir, { recursive: true, force: true });
    }
    console.log(`\nPictures: ${SHOTS_DIR}`);
    if (failures.length) {
        console.error(`\n❌ ${failures.length} of ${VIEWS.length * SCENARIOS.length} failed.`);
        process.exit(1);
    }
    console.log(`\n⭐️ Joining in the browser: ${VIEWS.length * SCENARIOS.length} runs, every screen at 1280 px and at 320 px with 1.3x text, no sideways scroll, 0 policy violations.`);
}

main().catch((e) => { console.error('❌', e); process.exit(1); });
