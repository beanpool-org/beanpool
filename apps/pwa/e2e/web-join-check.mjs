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
 *   - a 200 whose body is cut off (asked about, never read as a refusal), and a key restored while a sent join holds
 *     the slot: its own screen with the time left and a way back, and letting that join go only when the member says
 *   - G11-d: a browser cleared after joining gets the same key back with the sign-in it joined with, Google (the round
 *     trip through the same return page) and GitHub (the node's device flow): the stub node keeps the copy each join
 *     carried and answers the recovery routes as apps/server/src/routes/recovery-collect.ts does, and the copy is opened
 *     in the page by core, for real
 * and fails on any horizontal scroll, any policy violation, a token left in the address bar, or a join the stub node
 * did not expect (wrong key, wrong nonce, an access token sent).
 *
 * Nothing here talks to a node or a provider: /api is answered by the stubs below (and fixtures.mjs for the Market),
 * and every provider host is answered by Playwright. The tokens are fixtures, not signed by anyone.
 *
 * Run: pnpm --filter @beanpool/pwa web-join-check   (WEB_JOIN_ONLY=<text> runs only the scenarios whose name has it)
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
    // membershipDown: the membership probe gets no answer, as when the node can't be reached. doorShut: an operator has
    // shut the door (open-join.ts reads it per request). probes: every key the membership probe was asked about.
    // enrolled: key → the sign-in whose recovery copy a join stored (G11-c).
    const seen = {
        nonces: [], joins: [], providerVisits: [], violations: [], unexpectedHosts: new Set(), members: new Set(), membershipDown: false,
        doorShut: false, probes: [], enrolled: new Map(),
        // G11-d: key → the sign-in copy its join carried, with the sign-in's own sub; the recovery sessions and calls.
        copies: new Map(), collections: new Map(), restoreNonces: [], restoreCalls: [],
    };
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
            return reply(200, { memberCount: 3, postCount: 4, transactionCount: 0, commonsBalance: 0, profile: 'global', features: { openJoin: !seen.doorShut, beans: false } });
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
        // The node's recovery routes (routes/recovery-collect.ts), for G11-d: a session bound to the key that opened it.
        if (p.startsWith('/api/recovery/lookup/')) {
            const typed = decodeURIComponent(p.split('/').pop()).toLowerCase();
            return reply(200, [...seen.copies.entries()]
                .filter(([, c]) => c.callsign.toLowerCase().startsWith(typed))
                .map(([publicKey, c]) => ({ publicKey, callsign: c.callsign, joinedAt: 1, avatarUrl: null, canRecoverByGuardians: false, canRecoverBySso: true })));
        }
        // The member's own view of recoveries against their account (the app asks once it is in): not a restore's call.
        if (p === '/api/recovery/collect/mine') return reply(200, { collections: [] });
        if (p.startsWith('/api/recovery/collect')) {
            const body = JSON.parse(req.postData() || '{}');
            seen.restoreCalls.push({ path: p, key, body });
            if (p === '/api/recovery/collect') {
                const owner = [...seen.copies.entries()].find(([, c]) => c.callsign.toLowerCase() === String(body.callsign).toLowerCase());
                if (!owner) return reply(400, { error: 'That account has no recovery fragments to collect.' });
                const id = `col-${seen.collections.size + 1}`;
                seen.collections.set(id, { owner: owner[0], eph: key, released: false });
                return reply(200, { collectionId: id, generation: 1, expiresAt: Date.now() + 3_600_000, threshold: 1, progress: null });
            }
            const col = seen.collections.get(body.collectionId);
            if (!col || col.eph !== key) return reply(404, { error: 'No recovery session for this device.' });
            const copy = seen.copies.get(col.owner);
            if (p === '/api/recovery/collect/sso-nonce') {
                const nonce = `restore-nonce-${seen.restoreNonces.length + 1}-${'y'.repeat(24)}`;
                seen.restoreNonces.push({ nonce, key });
                return reply(200, { nonce, expiresInSeconds: 600, githubFlow: 'node', clientIds: CLIENT_IDS });
            }
            if (p === '/api/recovery/collect/github/start') {
                return reply(200, { sessionId: 'gh-restore-1', userCode: 'RSTR-9QXK', verificationUri: 'https://github.com/login/device', expiresInSeconds: 900, intervalSeconds: 1 });
            }
            if (p === '/api/recovery/collect/github/poll') {
                return reply(200, body.sessionId === 'gh-restore-1' ? { status: 'ok', sub: 'github-sub-1' } : { status: 'expired' });
            }
            if (p === '/api/recovery/collect/sso') {
                let sub = null;
                if (body.provider === 'github') {
                    sub = body.proof?.sessionId === 'gh-restore-1' ? 'github-sub-1' : null;
                } else {
                    const issued = seen.restoreNonces.find((n) => n.nonce === body.nonce && n.key === key);
                    const claims = JSON.parse(Buffer.from(String(body.idToken).split('.')[1] || '', 'base64url').toString() || '{}');
                    sub = issued && claims.nonce === body.nonce ? claims.sub : null;
                    if (issued) seen.restoreNonces = seen.restoreNonces.filter((n) => n !== issued);
                }
                if (!sub) return reply(401, { error: 'That sign-in could not be matched to this request.', code: 'sign_in' });
                if (!copy || copy.provider !== body.provider || copy.sub !== sub) return reply(400, { error: 'That sign-in account is not the keeper for this recovery.' });
                col.released = true;
                return reply(200, { collected: 1, threshold: 1, enough: true });
            }
            if (p === '/api/recovery/collect/fragments') {
                const s = copy?.share;
                return reply(200, {
                    collected: col.released ? 1 : 0, threshold: 1, enough: col.released,
                    fragments: col.released && s ? [{ holderType: 'sso', shareIndex: 1, payload: s.encryptedShare, payloadIv: s.shareIv, payloadTag: s.shareTag, ephemeralPubkey: null, kdfParams: s.kdfParams }] : [],
                });
            }
            return reply(404, { error: 'Not Found' });
        }
        if (p === '/api/join') {
            const body = JSON.parse(req.postData() || '{}');
            const raw = req.postData() || '';
            seen.joins.push({ body, key, raw });
            const r = await join(body, key, seen);
            if (r.status === 200) seen.members.add(key);
            if (r.hang) return; // never answered: the page is reloaded under it
            // A body cut off on the way back: the node's headers arrive, its JSON does not.
            if (r.rawBody !== undefined) return route.fulfill({ status: r.status, contentType: 'application/json', body: r.rawBody });
            return reply(r.status, r.body);
        }
        if (p.startsWith('/api/community/membership/')) {
            if (seen.membershipDown) return route.abort('internetdisconnected');
            const k = decodeURIComponent(p.split('/').pop());
            seen.probes.push(k);
            return reply(200, { isMember: seen.members.has(k), callsign: seen.members.has(k) ? 'Alice' : null });
        }
        if (p === '/api/community/health') return reply(200, { status: 'ok', memberCount: 4, version: 'harness' });
        // Settings asks which sign-ins bring the account back (G11-c): the ones this stub stored with a join.
        if (p === '/api/recovery/shares/status') return reply(200, { enrolledSso: key && seen.enrolled.get(key) ? [seen.enrolled.get(key)] : [] });
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
        const current = await page.locator('[data-testid^="join-screen-"]').first().getAttribute('data-testid', { timeout: 1000 }).catch(() => 'none');
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

/** The pending join as stored (its key and 12 words included: this is a test page with a fixture key). */
async function pendingJoin(page) {
    return page.evaluate(() => new Promise((resolve, reject) => {
        const open = indexedDB.open('beanpool-identity', 1);
        open.onupgradeneeded = () => open.result.createObjectStore('keys');
        open.onerror = () => reject(open.error);
        open.onsuccess = () => {
            const req = open.result.transaction('keys', 'readonly').objectStore('keys').get('pending-join');
            req.onsuccess = () => resolve(req.result ?? null);
            req.onerror = () => reject(req.error);
        };
    }));
}

/** Twelve words from the BIP-39 list, for a key restored at the door. A fixture: no account anywhere holds them. */
const RESTORED_WORDS = 'abandon ability able about above absent absorb abstract absurd abuse access accident';

/** Move the pending join `minutes` into the past, as if the tab had been closed that long ago. */
async function agePendingJoin(page, minutes) {
    return page.evaluate((ms) => new Promise((resolve, reject) => {
        const open = indexedDB.open('beanpool-identity', 1);
        open.onerror = () => reject(open.error);
        open.onsuccess = () => {
            const tx = open.result.transaction('keys', 'readwrite');
            const store = tx.objectStore('keys');
            const req = store.get('pending-join');
            req.onsuccess = () => {
                const p = req.result;
                if (!p) return;
                for (const k of ['startedAt', 'expiresAt', 'sentAt', 'earlierSentAt']) if (typeof p[k] === 'number') p[k] -= ms;
                store.put(p, 'pending-join');
            };
            tx.oncomplete = () => resolve(req.result ?? null);
            tx.onerror = () => reject(tx.error);
            tx.onabort = () => reject(tx.error);
        };
    }), minutes * 60_000);
}

/** An account another tab saved in this browser, written where identity.ts keeps it. A fixture key: nobody holds it. */
const OTHER_TAB_ACCOUNT = {
    publicKey: 'c'.repeat(64), privateKey: 'd'.repeat(64), callsign: 'Alice', createdAt: '2026-09-26T00:00:00.000Z', mnemonic: RESTORED_WORDS.split(' '),
};

async function saveIdentityElsewhere(page, identity) {
    return page.evaluate((id) => new Promise((resolve, reject) => {
        const open = indexedDB.open('beanpool-identity', 1);
        open.onupgradeneeded = () => open.result.createObjectStore('keys');
        open.onerror = () => reject(open.error);
        open.onsuccess = () => {
            const tx = open.result.transaction('keys', 'readwrite');
            tx.objectStore('keys').put(id, 'sovereign-identity');
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error);
            tx.onabort = () => reject(tx.error);
        };
    }), identity);
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

/** The identity as stored (a fixture account's key and words: this is a test page). */
async function storedIdentity(page) {
    return page.evaluate(() => new Promise((resolve, reject) => {
        const open = indexedDB.open('beanpool-identity', 1);
        open.onupgradeneeded = () => open.result.createObjectStore('keys');
        open.onerror = () => reject(open.error);
        open.onsuccess = () => {
            const req = open.result.transaction('keys', 'readonly').objectStore('keys').get('sovereign-identity');
            req.onsuccess = () => resolve(req.result ?? null);
            req.onerror = () => reject(req.error);
        };
    }));
}

/**
 * Everything this site keeps in the browser, gone, as "clear browsing data" does: every IndexedDB database and web
 * storage. Done from a page on the same origin that is not the app, so nothing holds a database open.
 */
async function clearBrowser(page, origin) {
    await page.goto(`${origin}/api/community/health`, { waitUntil: 'load' });
    await page.evaluate(async () => {
        localStorage.clear();
        sessionStorage.clear();
        const all = await indexedDB.databases();
        await Promise.all(all.map((d) => new Promise((resolve, reject) => {
            const req = indexedDB.deleteDatabase(d.name);
            req.onsuccess = () => resolve();
            req.onerror = () => reject(req.error);
        })));
        const left = await indexedDB.databases();
        if (left.length) throw new Error(`databases left: ${left.map((d) => d.name).join(', ')}`);
    });
}

async function restoreScreenIs(page, name, where, timeout = 20_000) {
    try {
        await page.getByTestId(`restore-screen-${name}`).waitFor({ timeout });
    } catch {
        const current = await page.locator('[data-testid^="restore-screen-"], [data-testid^="join-screen-"]').first().getAttribute('data-testid', { timeout: 1000 }).catch(() => 'none');
        throw new Failure(`${where}: expected the restore ${name} screen, found ${current}`);
    }
}

/**
 * The restore the stub node saw: every recovery call signed by one throwaway key that is not the account's, a Google
 * nonce issued to that key and sent back in the release, and the copy released to it.
 */
function checkRestore(seen, provider, accountKey, where) {
    const calls = seen.restoreCalls;
    if (!calls.length) throw new Failure(`${where}: no recovery call reached the node`);
    const eph = calls[0].key;
    if (!eph || eph === accountKey) throw new Failure(`${where}: the recovery calls were signed by ${eph === accountKey ? 'the account itself' : 'nobody'}`);
    const stray = calls.filter((c) => c.key !== eph);
    if (stray.length) throw new Failure(`${where}: ${stray.length} recovery calls signed by another key`);
    const release = calls.filter((c) => c.path === '/api/recovery/collect/sso').at(-1);
    if (!release || release.body.provider !== provider) throw new Failure(`${where}: released with ${release?.body.provider}`);
    if (provider === 'github') {
        if (release.body.proof?.sessionId !== 'gh-restore-1' || release.body.idToken) throw new Failure(`${where}: the GitHub release carried ${JSON.stringify(release.body)}`);
    } else {
        const visit = seen.providerVisits.filter((v) => v.provider === provider).at(-1);
        if (!visit || visit.state !== visit.nonce || release.body.nonce !== visit.nonce) throw new Failure(`${where}: the release's nonce is not the one sent to ${provider}`);
        if (!visit.nonce.startsWith('restore-nonce-')) throw new Failure(`${where}: went to ${provider} with a join's nonce`);
    }
    if (![...seen.collections.values()].some((c) => c.released && c.eph === eph && c.owner === accountKey)) throw new Failure(`${where}: no copy was released`);
}

/** A browser that joined, cleared, and back at the lobby asking for its account with a sign-in: the name, then the sign-ins. */
async function toRestoreSignIns(page, origin, view, { shots = false } = {}) {
    await clearBrowser(page, origin);
    await page.goto(`${origin}/app`, { waitUntil: 'load' });
    await screenIs(page, 'lobby', 'a cleared browser');
    if ((await storedIdentityKey(page)) !== null) throw new Failure('the browser was not cleared');
    await page.getByRole('button', { name: 'Already have BeanPool?' }).click();
    await screenIs(page, 'restore', 'Already have BeanPool?');
    await noSideScroll(page, 'restore choices');
    if (shots) await shot(page, view, 'restore-choices');
    await page.getByTestId('join-restore-signin').click();
    await restoreScreenIs(page, 'name', 'Use my sign-in');
    await page.getByTestId('restore-callsign').fill('Ali');
    await page.getByRole('button', { name: 'Alice', exact: true }).waitFor({ timeout: 10_000 });
    await noSideScroll(page, 'restore name');
    if (shots) await shot(page, view, 'restore-name');
    await page.getByRole('button', { name: 'Alice', exact: true }).click();
    await restoreScreenIs(page, 'providers', 'after picking Alice');
    await page.getByTestId('restore-provider-google').waitFor();
    await noSideScroll(page, 'restore sign-ins');
    if (shots) await shot(page, view, 'restore-sign-ins');
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
async function throughOnboarding(page, view, { shots = false, signIn = null } = {}) {
    await page.getByTestId('onboarding-stepper').waitFor({ timeout: 20_000 });
    const bar = await page.getByTestId('onboarding-stepper').innerText();
    if (!/Sign in/.test(bar)) throw new Failure(`the steps bar says "${bar.replace(/\s+/g, ' ')}", not "Sign in"`);
    await noSideScroll(page, 'photo step');
    if (shots) await shot(page, view, 'photo');
    await page.getByTitle('Green Bean').click();
    await page.getByRole('button', { name: 'Next →' }).click();
    await page.getByText('Your Safety Backup').waitFor();
    if (signIn) {
        const line = await page.getByTestId('backup-signin-recovery').innerText();
        if (line !== `Signing in with ${signIn} also brings this account back.`) throw new Failure(`the 12 words step says "${line}"`);
    }
    await noSideScroll(page, '12 words step');
    if (shots) await shot(page, view, 'words');
    await page.getByRole('button', { name: 'Next →' }).click();
    await page.getByRole('button', { name: "Let's Begin! 🚀" }).waitFor();
    await noSideScroll(page, 'tour step');
    await page.getByRole('button', { name: "Let's Begin! 🚀" }).click();
    await page.getByText('Chainsaw, sharpened').first().waitFor({ timeout: 20_000 });
}

/** A yes, and, as the node does, the sign-in recovery copy the join carried stored and said so (G11-c). */
function joinOk(callsign = 'Alice') {
    return async (body, key, seen) => {
        const stored = Array.isArray(body.recovery?.shares) && body.recovery.shares.length === 1 && body.recovery.shares[0].holderRef === body.provider;
        if (stored) {
            seen.enrolled.set(key, body.provider);
            // As the node keeps it: the copy, and the sign-in it opens with (the token's sub, or GitHub's).
            const sub = body.provider === 'github' ? 'github-sub-1' : JSON.parse(Buffer.from(body.idToken.split('.')[1], 'base64url').toString()).sub;
            seen.copies.set(key, { share: body.recovery.shares[0], provider: body.provider, sub, callsign: body.callsign || callsign });
        }
        return {
            status: 200,
            body: {
                success: true, member: { publicKey: key, callsign: body.callsign || callsign }, provider: body.provider,
                ...(body.recovery ? { recovery: stored ? { enrolled: true, generation: 1, provider: body.provider, enrolledSso: [body.provider] } : { enrolled: false, error: 'not stored' } } : {}),
            },
        };
    };
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
    // G11-c: the key sealed to this sign-in (its 12 words with it) went with the join, one piece, in the phone's shape.
    const shares = j.body.recovery?.shares;
    const share = Array.isArray(shares) && shares.length === 1 ? shares[0] : null;
    let params = null;
    try { params = share ? JSON.parse(share.kdfParams) : null; } catch { params = null; }
    if (!share || share.holderType !== 'sso' || share.holderRef !== provider || share.shareIndex !== 1
        || params?.alg !== 'scrypt-xc20p-single-v1' || params?.words?.alg !== 'bip39-bits-xc20p-v1'
        || Buffer.from(share.encryptedShare, 'base64').length !== 32) {
        throw new Failure(`${where}: the join did not carry the sign-in recovery copy: ${JSON.stringify(j.body.recovery)?.slice(0, 200)}`);
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
            await throughOnboarding(page, view, { shots: true, signIn: 'Google' });
            if ((await storedIdentityKey(page)) !== key) throw new Failure('the app is not using the key that joined');
            if ((await pendingKey(page)) !== null) throw new Failure('the pending join was left behind');
            // Settings says the sign-in is connected (G11-c), read from the node.
            await page.getByRole('button', { name: 'Settings' }).filter({ visible: true }).first().click();
            const line = await page.getByTestId('signin-recovery').innerText({ timeout: 20_000 });
            if (!/Sign-in recovery: connected \(Google\)/.test(line)) throw new Failure(`Settings says "${line.replace(/\s+/g, ' ')}"`);
            await noSideScroll(page, 'Settings');
            await shot(page, view, 'settings');
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
        name: 'the answer was lost and the tab closed; reopened after its time: kept and said so while the node is unreachable, then in',
        async run(page, origin, view, seen) {
            await toSignIn(page, origin, view, 'Alice');
            const key = await pendingKey(page);
            await page.getByTestId('join-provider-google').click();
            await page.getByTestId('join-joining').waitFor({ timeout: 20_000 });
            // The node took the member and its answer never came back. Half an hour later the tab is opened again,
            // long past the pending join's own ten minutes, and the node can't be reached.
            const aged = await agePendingJoin(page, 30);
            if (typeof aged?.sentAt !== 'number') throw new Failure(`the join went out unmarked: ${JSON.stringify(aged && { ...aged, identity: undefined })}`);
            seen.membershipDown = true;
            await page.reload({ waitUntil: 'load' });
            await screenIs(page, 'checking', 'reopened with the node unreachable');
            await page.getByText("We can't tell yet whether you joined as Alice.", { exact: false }).waitFor({ timeout: 20_000 });
            await noSideScroll(page, 'checking');
            await shot(page, view, 'checking');
            if ((await pendingKey(page)) !== key) throw new Failure('the pending join was dropped while the node could not say');
            if ((await storedIdentityKey(page)) !== null) throw new Failure('an identity was saved before the node said yes');
            // The node answers again: a member, so the new member's steps follow.
            seen.membershipDown = false;
            await page.getByRole('button', { name: 'Try again' }).click();
            await page.getByTestId('onboarding-stepper').waitFor({ timeout: 20_000 });
            if ((await storedIdentityKey(page)) !== key) throw new Failure('the identity is not the key that joined');
            if ((await pendingKey(page)) !== null) throw new Failure('the pending join was left behind');
            if (seen.joins.length !== 1) throw new Failure(`${seen.joins.length} joins were sent`);
        },
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
        name: 'a 200 whose body is cut off: the key stays marked sent, the page says it cannot tell, and asking the node lets the member in',
        async run(page, origin, view, seen) {
            await toSignIn(page, origin, view, 'Alice');
            const key = await pendingKey(page);
            seen.membershipDown = true;
            await page.getByTestId('join-provider-google').click();
            await page.getByText("We can't tell if that worked, and you're not in yet.", { exact: false }).waitFor({ timeout: 20_000 });
            await screenIs(page, 'unknown', 'a 200 with its body cut off');
            if (/could not add you/.test(await page.locator('body').innerText())) throw new Failure('a cut-off 200 was read as a refusal');
            const kept = await pendingJoin(page);
            if (kept?.identity?.publicKey !== key || typeof kept.sentAt !== 'number') throw new Failure('the key the node took is no longer marked sent');
            await noSideScroll(page, 'cannot tell');
            await shot(page, view, 'cannot-tell');
            seen.membershipDown = false;
            await page.getByRole('button', { name: 'Try again' }).click();
            await page.getByTestId('onboarding-stepper').waitFor({ timeout: 20_000 });
            if ((await storedIdentityKey(page)) !== key) throw new Failure('the identity is not the key that joined');
            if (seen.joins.length !== 1) throw new Failure(`${seen.joins.length} joins were sent`);
        },
        // The node takes the member; its answer is cut off after the headers.
        join: async () => ({ status: 200, rawBody: '{"success":tr' }),
    },
    {
        name: 'a key restored while a sent join may still land: its own screen, the time left, a way back; let go only when the member says',
        async run(page, origin, view, seen) {
            await toSignIn(page, origin, view, 'Alice');
            const first = await pendingKey(page);
            await page.getByTestId('join-provider-google').click();
            await page.getByTestId('join-joining').waitFor({ timeout: 20_000 });
            // The join never answers, and the node has not taken it (yet). The page is reloaded under it.
            await page.reload({ waitUntil: 'load' });
            await page.getByText("Your join hasn't reached the community yet.", { exact: false }).waitFor({ timeout: 20_000 });
            await page.getByRole('button', { name: '← Change name' }).click();
            await page.getByRole('button', { name: '← Back' }).click();
            await screenIs(page, 'guard', 'back past the name with a sent join');
            if ((await pendingKey(page)) !== first) throw new Failure('going back dropped a sent join');

            const restore = async () => {
                await page.getByLabel('Recovery word 1', { exact: true }).fill(RESTORED_WORDS);
                await page.getByRole('button', { name: 'Recover Identity' }).click();
            };
            await page.getByRole('button', { name: 'I have my 12 words' }).click();
            await restore();
            await screenIs(page, 'held', 'restored while the sent join may still land');
            const text = await page.getByTestId('join-held').innerText();
            if (!/may still go through/.test(text) || !/about \d+ minutes?/.test(text)) throw new Failure(`the held screen says "${text}"`);
            await page.getByRole('button', { name: 'Check again' }).waitFor();
            await page.getByRole('button', { name: 'Finish joining as Alice' }).waitFor();
            await noSideScroll(page, 'held');
            await shot(page, view, 'held');
            await page.getByRole('button', { name: '← Back' }).click();
            await screenIs(page, 'lobby', '← Back from the held screen');
            if ((await pendingKey(page)) !== first) throw new Failure('the held screen dropped the sent join');

            // Half an hour on, that join can no longer land and the node says it is not a member.
            await agePendingJoin(page, 30);
            await page.getByRole('button', { name: 'Already have BeanPool?' }).click();
            await page.getByRole('button', { name: 'Use my 12 words' }).click();
            await restore();
            await screenIs(page, 'held', 'restored after that join could no longer land');
            await page.getByText("isn't a member", { exact: false }).waitFor();
            await page.getByRole('button', { name: 'Use the account I brought here' }).click();
            await screenIs(page, 'abandon', 'asked before letting go');
            await noSideScroll(page, 'abandon');
            await shot(page, view, 'abandon');
            if ((await pendingKey(page)) !== first) throw new Failure('the sent join went before the member said so');
            await page.getByTestId('join-abandon-confirm').click();
            // The 12 words carry no name: the door asks for one, for the restored key.
            await screenIs(page, 'name', 'after letting go');
            const now = await pendingJoin(page);
            if (!now || now.identity.publicKey === first || !now.restored || typeof now.sentAt === 'number') {
                throw new Failure(`after letting go the pending join is ${JSON.stringify(now && { key: now.identity.publicKey, restored: now.restored, sentAt: now.sentAt })}`);
            }
            if (seen.joins.length !== 1) throw new Failure(`${seen.joins.length} joins were sent`);
        },
        join: async () => ({ hang: true }),
    },
    {
        name: 'G11-d: joined with Google, the browser cleared, the same key back with Google, its 12 words with it',
        async run(page, origin, view, seen) {
            await toSignIn(page, origin, view, 'Alice');
            const key = await pendingKey(page);
            await page.getByTestId('join-provider-google').click();
            await throughOnboarding(page, view, { signIn: 'Google' });
            const joined = await storedIdentity(page);
            if (joined?.publicKey !== key) throw new Failure('the join did not save its key');

            await toRestoreSignIns(page, origin, view, { shots: true });
            await page.getByTestId('restore-provider-google').click();
            await page.getByText('Chainsaw, sharpened').first().waitFor({ timeout: 30_000 });
            if (page.url().includes('id_token')) throw new Failure(`the address bar still reads ${page.url()}`);
            const back = await storedIdentity(page);
            if (back?.publicKey !== key) throw new Failure(`restored ${back?.publicKey}, not the key the join made (${key})`);
            if (back.privateKey !== joined.privateKey) throw new Failure('the restored private key is not the one the join made');
            if (JSON.stringify(back.mnemonic) !== JSON.stringify(joined.mnemonic)) throw new Failure('the 12 words did not come back with it');
            if ((await pendingJoin(page)) !== null) throw new Failure('a pending join was left behind');
            checkRestore(seen, 'google', key, 'restore with Google');
            if (seen.joins.length !== 1) throw new Failure(`${seen.joins.length} joins were sent`);
            await noSideScroll(page, 'in, after the restore');
        },
        join: joinOk(),
    },
    {
        name: "G11-d: joined with GitHub, the browser cleared, the same key back with GitHub's device flow",
        async run(page, origin, view, seen) {
            await toSignIn(page, origin, view, 'Alice');
            const key = await pendingKey(page);
            await page.getByTestId('join-provider-github').click();
            await throughOnboarding(page, view, { signIn: 'GitHub' });

            await toRestoreSignIns(page, origin, view);
            await page.getByTestId('restore-provider-github').click();
            await restoreScreenIs(page, 'github', 'GitHub for the restore');
            if ((await page.getByTestId('restore-github-code').innerText()) !== 'RSTR-9QXK') throw new Failure('the restore did not show its own GitHub code');
            await noSideScroll(page, 'restore GitHub code');
            await shot(page, view, 'restore-github-code');
            await page.getByText('Chainsaw, sharpened').first().waitFor({ timeout: 30_000 });
            if ((await storedIdentityKey(page)) !== key) throw new Failure('restored another key than the join made');
            checkRestore(seen, 'github', key, 'restore with GitHub');
        },
        join: joinOk(),
    },
    {
        name: "G11-d: a Google account that isn't the account's: said plainly, nothing saved",
        async run(page, origin, view, seen) {
            await toSignIn(page, origin, view, 'Alice');
            await page.getByTestId('join-provider-github').click();
            await throughOnboarding(page, view, { signIn: 'GitHub' });
            await toRestoreSignIns(page, origin, view);
            // Alice joined with GitHub; Google is not her way back.
            await page.getByTestId('restore-provider-google').click();
            const notice = page.getByTestId('join-notice');
            await notice.waitFor({ timeout: 30_000 });
            if (!(await notice.innerText()).includes("That Google account isn't a way back into Alice.")) throw new Failure(`the restore said "${await notice.innerText()}"`);
            await restoreScreenIs(page, 'providers', 'refused sign-in');
            await noSideScroll(page, 'refused sign-in');
            await shot(page, view, 'restore-refused');
            if ((await storedIdentityKey(page)) !== null) throw new Failure('an identity was saved');
            if ([...seen.collections.values()].some((c) => c.released)) throw new Failure('a copy was released');
        },
        join: joinOk(),
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
    {
        name: 'two tabs (review 4106962020): tab A joins, then tab B, still on the lobby, starts a join: B says so, sends nothing, and opens A',
        async run(page, origin, view, seen) {
            // Tab B opens first and waits on the lobby, as when the link is clicked twice.
            await page.goto(`${origin}/app`, { waitUntil: 'load' });
            await screenIs(page, 'lobby', 'tab B on arrival');
            const tabA = await page.context().newPage();
            await toSignIn(tabA, origin, view, 'Alice');
            const key = await pendingKey(tabA);
            await tabA.getByTestId('join-provider-google').click();
            await tabA.getByTestId('onboarding-stepper').waitFor({ timeout: 20_000 });
            if ((await storedIdentityKey(page)) !== key) throw new Failure("tab A's account was not saved");

            await page.waitForFunction(() => !document.querySelector('[data-testid="join-start"]')?.hasAttribute('disabled'), null, { timeout: 10_000 });
            await page.getByTestId('join-start').click();
            await page.getByTestId('join-new').click();
            await page.getByTestId('join-callsign').fill('Bea');
            await page.getByTestId('join-name-next').click();
            await screenIs(page, 'taken', 'tab B, after tab A joined');
            const text = await page.getByTestId('join-taken').innerText();
            if (!/Alice/.test(text)) throw new Failure(`the taken screen says "${text}"`);
            await noSideScroll(page, 'taken');
            await shot(page, view, 'taken');
            if (seen.joins.length !== 1) throw new Failure(`${seen.joins.length} joins were sent`);
            if ((await storedIdentityKey(page)) !== key) throw new Failure("tab B replaced tab A's account");
            if ((await pendingKey(page)) !== null) throw new Failure('tab B kept a key it never sent');
            await page.getByRole('button', { name: 'Open Alice' }).click();
            await page.getByText('Chainsaw, sharpened').first().waitFor({ timeout: 20_000 });
        },
        join: joinOk(),
    },
    {
        name: "the race (review 4106962020): another tab saves an account while this tab's join is at the node, which takes it: kept, said, its 12 words one tap away",
        async run(page, origin, view, seen) {
            await toSignIn(page, origin, view, 'Bea');
            const bea = await pendingKey(page);
            seen.beforeJoinAnswer = () => saveIdentityElsewhere(page, OTHER_TAB_ACCOUNT);
            await page.getByTestId('join-provider-google').click();
            await screenIs(page, 'taken', 'the node took the join after another tab saved an account');
            await page.getByText('The community took Bea too', { exact: false }).waitFor();
            await page.getByRole('button', { name: "Show Bea's 12 words" }).click();
            await page.getByTestId('join-taken-words').waitFor();
            await noSideScroll(page, 'taken, its 12 words shown');
            // A word copied onto paper is never broken across lines (an inline box that wraps has a rect per line).
            const broken = await page.getByTestId('join-taken-words').evaluate((ol) => [...ol.querySelectorAll('strong')]
                .filter((s) => s.getClientRects().length > 1).map((s) => s.textContent));
            if (broken.length) throw new Failure(`12 words broken across lines: ${broken.length}`);
            await shot(page, view, 'taken-words');
            if ((await storedIdentityKey(page)) !== OTHER_TAB_ACCOUNT.publicKey) throw new Failure("this browser's account was replaced");
            const kept = await pendingJoin(page);
            if (kept?.identity.publicKey !== bea || typeof kept.sentAt !== 'number') throw new Failure('the key the node took was not kept, marked sent');
        },
        join: async (body, key, seen) => {
            await seen.beforeJoinAnswer?.();
            return { status: 200, body: { success: true, member: { publicKey: key, callsign: body.callsign } } };
        },
    },
    {
        name: 'the door shuts while a join is out (review 4106962311): asked first, waited for with no way to join again, then the invite page, where nothing replaces another tab\'s account',
        async run(page, origin, view, seen) {
            await toSignIn(page, origin, view, 'Alice');
            const key = await pendingKey(page);
            await page.getByTestId('join-provider-google').click();
            await page.getByTestId('join-joining').waitFor({ timeout: 20_000 });
            // The join never answers (the node has not taken it), and an operator shuts the door.
            seen.doorShut = true;
            await page.reload({ waitUntil: 'load' });
            await screenIs(page, 'held', 'reopened with the door shut');
            const text = await page.getByTestId('join-held').innerText();
            if (!/may still go through/.test(text) || !/about \d+ minutes?/.test(text)) throw new Failure(`the held screen says "${text}"`);
            if (await page.getByRole('button', { name: /Finish joining/ }).count()) throw new Failure('the shut door offers to join again');
            if (await page.getByText('Join with Invite Code').count()) throw new Failure('the invite page showed before the join was settled');
            if (!seen.probes.includes(key)) throw new Failure('the node was not asked about the sent join');
            await noSideScroll(page, 'held, door shut');
            await shot(page, view, 'held-door-shut');

            // Half an hour on, that join can no longer land: the invite page, and the key kept as it was.
            await agePendingJoin(page, 30);
            await page.getByRole('button', { name: 'Check again' }).click();
            await page.getByText('Join with Invite Code').waitFor({ timeout: 20_000 });
            if ((await pendingKey(page)) !== key) throw new Failure('the sent join was dropped');

            // Another tab saves an account; an invite here never replaces it.
            await saveIdentityElsewhere(page, OTHER_TAB_ACCOUNT);
            await page.getByLabel('Invite Code').fill('BP-7K3X-9M2W');
            await page.getByLabel('Your Callsign (Name)').fill('Rowan');
            await page.getByRole('button', { name: 'Create Identity & Join →' }).click();
            await page.getByTestId('welcome-held').waitFor({ timeout: 20_000 });
            await noSideScroll(page, 'welcome: this browser already has an account');
            await shot(page, view, 'welcome-held');
            if ((await storedIdentityKey(page)) !== OTHER_TAB_ACCOUNT.publicKey) throw new Failure('the invite replaced the account here');
            if (seen.joins.length !== 1) throw new Failure(`${seen.joins.length} joins were sent`);
        },
        join: async () => ({ hang: true }),
    },
];

async function main() {
    const policy = await loadPolicy();
    const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bp-web-join-'));
    fs.rmSync(SHOTS_DIR, { recursive: true, force: true });
    let server;
    let browser;
    const failures = [];
    let runs = 0;
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
        const only = process.env.WEB_JOIN_ONLY;
        const scenarios = only ? SCENARIOS.filter((sc) => sc.name.includes(only)) : SCENARIOS;
        for (const view of VIEWS) {
            for (const scenario of scenarios) {
                const { context, page, seen } = await openScenario(browser, origin, view, scenario);
                const label = `${view.name}: ${scenario.name}`;
                runs++;
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
        console.error(`\n❌ ${failures.length} of ${runs} failed.`);
        process.exit(1);
    }
    console.log(`\n⭐️ Joining in the browser: ${runs} runs, every screen at 1280 px and at 320 px with 1.3x text, no sideways scroll, 0 policy violations.`);
}

main().catch((e) => { console.error('❌', e); process.exit(1); });
