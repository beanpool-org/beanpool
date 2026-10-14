/**
 * The legacy Settings page (/settings-legacy, static/settings.js) after sign-in step 7c, in a real browser against a
 * real node: headless Chromium signs in through the page itself.
 *
 *   1. 2FA off: the page's password sign-in passes verify-password, then admin routes answer 403 password_needs_2fa. The
 *      page stays on the sign-in view and shows the node's words plus "Open Settings (the new page) to turn it on, then
 *      come back", with a link to /settings. Never an empty Settings view.
 *   2. Control, 2FA on: the password plus a code opens the Settings view, so (1) is the refusal, not a broken page.
 *   2b. A sister node's answer: a 403 password_needs_2fa from another origin (the page asks sister nodes for their status)
 *      neither signs the page out nor shows the sister's words.
 *   3. Any pane: 2FA turned off while signed in, the next admin call is refused the same way and the page goes back to
 *      the sign-in view with the message.
 *
 * Nothing leaves this machine: every request off localhost (unpkg's Leaflet, map tiles) is aborted. The page uses L as
 * it loads, so a stand-in for Leaflet is put in before the page's scripts run (its unpkg tag carries an integrity hash,
 * so a stand-in served in Leaflet's place would be refused), or its script would stop there.
 * Not in scripts/test-all.sh: it needs Playwright's Chromium, which the web app's package brings
 * (pnpm --filter @beanpool/pwa exec playwright install --only-shell chromium, once).
 * Run: BEANPOOL_DATA_DIR=$(mktemp -d) node --import tsx src/check-legacy-settings-browser.ts
 */
delete process.env.CF_RECORD_NAME;
delete process.env.NODE_PROFILE;

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { initTls } from './services/tls.js';
import { initStateEngine } from './state-engine.js';
import { updateLocalConfig, hashPassword, setBreakGlassMode } from './config/local-config.js';
import { generateTotpSecret, generateTotpCode, forgetUsedTotpCodesForTests } from './totp.js';
import { PASSWORD_NEEDS_2FA_ERROR } from './admin-auth.js';

const PORT = 8737;
const BASE = `https://localhost:${PORT}`;
const PWA_PACKAGE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../pwa/package.json');
const PW = 'LegacySettings7c1!';
const SISTER = 'sister.invalid';
const SISTER_WORDS = 'A sister node refused its own password';
const SECRET = generateTotpSecret();

let run = 0, passed = 0;
function assert(cond: boolean, msg: string): void {
    run++;
    if (cond) { passed++; console.log(`✓ ${msg}`); } else console.error(`✗ ${msg}`);
}

function set2fa(on: boolean): void {
    updateLocalConfig(on
        ? { totpEnabled: true, totpSecret: SECRET, totpBackupCodesHashes: [], totpPendingSecret: null, totpPendingBackupCodesHashes: [] }
        : { totpEnabled: false, totpSecret: null, totpBackupCodesHashes: [], totpPendingSecret: null, totpPendingBackupCodesHashes: [] });
}

interface Page {
    goto(url: string, opts?: unknown): Promise<unknown>;
    fill(selector: string, value: string): Promise<void>;
    click(selector: string): Promise<void>;
    waitForFunction(fn: () => boolean, arg?: unknown, opts?: unknown): Promise<unknown>;
    evaluate<T>(fn: () => T): Promise<T>;
    close(): Promise<void>;
    on(event: 'pageerror', fn: (err: Error) => void): void;
}
interface Route {
    request(): { url(): string };
    abort(): Promise<void>;
    continue(): Promise<void>;
    fulfill(opts: { status: number; contentType: string; headers: Record<string, string>; body: string }): Promise<void>;
}
/** Leaflet's stand-in: every property and every call gives the stand-in back, so the page's map code runs and draws nothing. */
const LEAFLET_STAND_IN = 'window.L = new Proxy(function () {}, { get: (t, k) => (k === Symbol.toPrimitive ? undefined : window.L), apply: () => window.L, construct: () => window.L });';
interface Browser {
    newContext(opts: unknown): Promise<{
        route(url: unknown, handler: (route: Route) => unknown): Promise<void>;
        addInitScript(script: { content: string }): Promise<void>;
        newPage(): Promise<Page>;
    }>;
    close(): Promise<void>;
}

/** The page's own top-level lets: globals of its classic script, so a function run in the page reads them by name. */
declare const authToken: string | null, tfaSessionToken: string | null;

interface Seen { login: boolean; settings: boolean; status: string; link: string | null }
// Functions, not strings: the page's policy has no 'unsafe-eval', so a string predicate would never run there.
const SEEN = (): Seen => ({
    login: !document.getElementById('view-login')?.classList.contains('hidden'),
    settings: !document.getElementById('view-settings')?.classList.contains('hidden'),
    status: document.getElementById('login-status')?.textContent || '',
    link: document.querySelector('#login-status a')?.getAttribute('href') ?? null,
});
/** Notes, in the page, whether the Settings view was ever shown: a flash of it before the refusal counts. */
const WATCH_SETTINGS_VIEW = `addEventListener('DOMContentLoaded', () => {
    const view = document.getElementById('view-settings');
    new MutationObserver(() => { if (!view.classList.contains('hidden')) window.settingsOpened = true; }).observe(view, { attributes: true });
});`;
const REFUSAL_SHOWN = (): boolean => (document.getElementById('login-status')?.textContent || '').includes('then come back');

async function main(): Promise<void> {
    const { chromium } = createRequire(PWA_PACKAGE)('playwright') as { chromium: { launch(): Promise<Browser> } };

    const webRoot = fs.mkdtempSync(path.join(path.resolve(os.tmpdir()), 'bp-legacy-settings-browser-'));
    fs.mkdirSync(path.join(webRoot, 'public', 'settings'), { recursive: true });
    fs.writeFileSync(path.join(webRoot, 'public', 'index.html'), '<!doctype html><title>BeanPool</title>');
    fs.writeFileSync(path.join(webRoot, 'public', 'settings', 'index.html'), '<!doctype html><title>Settings</title>');
    process.chdir(webRoot);

    await initTls();
    initStateEngine();
    const { hash, salt } = hashPassword(PW);
    updateLocalConfig({ adminHash: hash, salt, isLocked: true, replicationTokenOnly: false });
    setBreakGlassMode(false);
    set2fa(false);
    const { startHttpsServer } = await import('./https-server.js');
    await startHttpsServer(PORT);

    const browser = await chromium.launch();
    const context = await browser.newContext({ ignoreHTTPSErrors: true });
    await context.addInitScript({ content: LEAFLET_STAND_IN });
    await context.addInitScript({ content: WATCH_SETTINGS_VIEW });
    let offMachine = 0;
    await context.route('**/*', (route) => {
        const host = new URL(route.request().url()).hostname;
        if (host === 'localhost') return route.continue();
        if (host === SISTER) {
            return route.fulfill({ status: 403, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' },
                body: JSON.stringify({ error: SISTER_WORDS, code: 'password_needs_2fa' }) });
        }
        offMachine++;
        return route.abort();
    });

    /** A page whose script errors are printed, so a page that never ran says why. */
    async function openPage(): Promise<Page> {
        const page = await context.newPage();
        page.on('pageerror', (err) => console.log(`  (page error: ${err.message})`));
        return page;
    }

    try {
        console.log('\n── 1. 2FA off: the password sign-in, then the admin routes are refused ──');
        let page = await openPage();
        await page.goto(`${BASE}/settings-legacy`, { waitUntil: 'load' });
        await page.fill('#login-password', PW);
        await page.click('#login-btn');
        await page.waitForFunction(REFUSAL_SHOWN, undefined, { timeout: 10_000 })
            .catch(() => { /* the checks below say what was on screen */ });
        const flashed = await page.evaluate<boolean>(() => (window as unknown as { settingsOpened?: boolean }).settingsOpened === true);
        let seen = await page.evaluate<Seen>(SEEN);
        assert(seen.login && !seen.settings && !flashed, `the sign-in view stays up and Settings never opened, not even for a moment (login ${seen.login}, settings ${seen.settings}, opened ${flashed})`);
        assert(seen.status.includes(PASSWORD_NEEDS_2FA_ERROR), `the node's words are shown: "${seen.status}"`);
        assert(seen.status.includes('Open Settings (the new page) to turn it on, then come back.'), 'and the way out');
        assert(seen.status.split('Turn on two-factor sign-in').length <= 2, `the way out isn't said twice: "${seen.status}"`);
        assert(seen.link === '/settings', `with a link to the new Settings page (${seen.link})`);
        await page.close();

        console.log('\n── 2. control, 2FA on: the password plus a code opens Settings ──');
        set2fa(true);
        forgetUsedTotpCodesForTests();
        page = await openPage();
        await page.goto(`${BASE}/settings-legacy`, { waitUntil: 'load' });
        await page.fill('#login-password', PW);
        await page.click('#login-btn');
        await page.waitForFunction(() => !document.getElementById('login-2fa-field')?.classList.contains('hidden'), undefined, { timeout: 10_000 });
        await page.fill('#login-totp', generateTotpCode(SECRET));
        await page.click('#login-btn');
        await page.waitForFunction(() => !document.getElementById('view-settings')?.classList.contains('hidden'), undefined, { timeout: 10_000 })
            .catch(() => { /* the check below says what was on screen */ });
        seen = await page.evaluate<Seen>(SEEN);
        assert(seen.settings && !seen.login, `the Settings view opens (settings ${seen.settings}, status "${seen.status}")`);

        console.log('\n── 2b. a sister node answers 403 password_needs_2fa ──');
        const sisterStatus = await page.evaluate<Promise<number>>(() => fetch('https://sister.invalid/api/local/status').then((r) => r.status, () => 0));
        await page.waitForFunction(REFUSAL_SHOWN, undefined, { timeout: 2_000 }).catch(() => { /* expected: nothing shown */ });
        seen = await page.evaluate<Seen>(SEEN);
        assert(sisterStatus === 403, `the sister's answer reached the page (${sisterStatus})`);
        assert(seen.settings && !seen.login && !seen.status.includes(SISTER_WORDS), `Settings stays open and the sister's words are not shown (settings ${seen.settings}, status "${seen.status}")`);
        const stillSignedIn = await page.evaluate<boolean>(() => authToken !== null);
        assert(stillSignedIn, 'the page is still signed in');

        console.log('\n── 3. any pane: 2FA turned off while signed in ──');
        set2fa(false);
        await page.evaluate(() => { void (window as unknown as { loadCommunityInfo(): Promise<void> }).loadCommunityInfo(); });
        await page.waitForFunction(REFUSAL_SHOWN, undefined, { timeout: 10_000 }).catch(() => { /* the checks below say */ });
        seen = await page.evaluate<Seen>(SEEN);
        assert(seen.login && !seen.settings, `the page goes back to the sign-in view (login ${seen.login}, settings ${seen.settings})`);
        assert(seen.status.includes(PASSWORD_NEEDS_2FA_ERROR) && seen.link === '/settings', `with the node's words and the link: "${seen.status}"`);
        const pwKept = await page.evaluate<boolean>(() => authToken !== null || tfaSessionToken !== null);
        assert(!pwKept, 'the password and the 2FA session are dropped from the page');
        await page.close();
        console.log(`(${offMachine} request(s) off localhost aborted)`);
    } finally {
        await browser.close();
        fs.rmSync(webRoot, { recursive: true, force: true });
    }

    console.log(`\n${passed}/${run} checks passed.`);
    if (passed !== run) throw new Error(`${run - passed} check(s) failed`);
}

main().then(() => process.exit(0), (err) => { console.error(err); process.exit(1); });
