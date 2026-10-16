/**
 * The global showcase in the REAL web app (scratch/global-node/DESIGN-global-showcase-fable.md §6 W2), as built and served
 * by a real node on this machine (e2e/home-node-harness.ts: the server's own routes, signature middleware and W1's
 * `showcase` switch), with a signed-in member, in headless Chromium at 320 px with 1.3x text, light and dark.
 *
 *   1. a member of a global node (showcase on): the Ledger in preview (strip expanded and collapsed, the sheet, the Start
 *      a community screen), the Commons and My Deals in preview, a listing's In return line and its "Request · Beans held
 *      safely" action, Invites' line, a profile's line, the composer's price line; every marker never looks locked;
 *   2. the NET SPY over all of that: no POST, PUT, PATCH or DELETE at all, nothing carrying a `sample-` id, no host but
 *      this machine (map tiles aside, aborted), and the reader's own features read from /api/community/me; and on the
 *      Commons, Invites, the profile (with the app shell's load) and a listing, no read of the reader's own data at
 *      all (OWN_READS: their balance, ledger, deals, Decisions and voice credits, the pool, treasuries, invites); and
 *      the same on the Ledger, the Market tab's load with My Deals, and the Map with the composer (review of #2035, N1);
 *   2b. the node's info held back 6 s and the Ledger tapped at once (a slow link): nothing of the member's is read
 *      before the info answers, and no live balance is drawn meanwhile (review of #2035, N2); on a local node the
 *      Ledger then reads the balance and ledger, as before;
 *   3. a member of a local node (Beans live): the real Ledger, no strip, no line, the real deal button; and the same
 *      screens DO read the reader's own data there, as they always have.
 *
 * Fails on any sideways scroll, a write, a `sample-` id on the wire, a read of the reader's own data on a screen whose
 * feature is in preview (global previews audit, "Across all five", P3), a local screen that no longer reads it, a marker in a locked or greyed style, or a control in
 * a preview, a marker, the sheet or the Start screen smaller than 44 x 44 px, a sheet or Start screen that does not cover the
 * screen (review of #2057, B3), or, with the Invites QR card open, a control or the QR past the screen or its card (B2).
 *
 * Run: pnpm --filter @beanpool/pwa showcase-check   (SHOWCASE_SHOTS: where the pictures go)
 * Needs Chromium for Playwright once: pnpm --filter @beanpool/pwa exec playwright install --only-shell chromium
 */
/* global URL, console, process, setTimeout, document, window, indexedDB, localStorage, getComputedStyle, HTMLButtonElement, Element, navigator -- Node, and the page's side of evaluate() */
import { build } from 'vite';
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { createRequire } from 'node:module';

const PWA_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** jsqr + pngjs decode the Invites QR: from QRDEPS (a folder holding both) or the pwa's own node_modules. Missing, the
 *  decode check fails (it is never skipped quietly). */
let jsQR = null;
let PNG = null;
let qrDepsMissing = '';
for (const from of [process.env.QRDEPS, PWA_DIR].filter(Boolean)) {
    try {
        const qreq = createRequire(path.join(from, 'package.json'));
        jsQR = qreq('jsqr');
        PNG = qreq('pngjs').PNG;
        break;
    } catch (e) {
        qrDepsMissing = `${from}: ${e.code || e.message}`;
    }
}
const SERVER_DIR = path.resolve(PWA_DIR, '../server');
process.chdir(PWA_DIR);

const SHOTS_DIR = process.env.SHOWCASE_SHOTS || path.join(os.tmpdir(), 'bp-showcase-shots');
const VIEW = { width: 320, height: 720 };
const TEXT_SCALE = 1.3;

const failures = [];
function check(ok, what) {
    if (ok) console.log(`  ✓ ${what}`);
    else { failures.push(what); console.error(`  ✗ ${what}`); }
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/** A real Ed25519 key in the shape the web app keeps it (identity.ts). */
function memberIdentity(callsign) {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    return {
        publicKey: publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('hex'),
        privateKey: privateKey.export({ type: 'pkcs8', format: 'der' }).toString('hex'),
        callsign,
        createdAt: new Date().toISOString(),
    };
}

async function startNode(root, profile, members) {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), `bp-showcase-${profile}-data-`));
    const child = spawn(process.execPath, ['--import', 'tsx', '../pwa/e2e/home-node-harness.ts'], {
        cwd: SERVER_DIR,
        env: { ...process.env, BEANPOOL_DATA_DIR: dataDir, FIXTURE_ROOT: root, FIXTURE_PROFILE: profile, FIXTURE_MEMBERS: JSON.stringify(members) },
        stdio: ['pipe', 'pipe', 'pipe'],
    });
    console.log(`  (node PID ${child.pid})`);
    const log = [];
    let ready;
    const readyAt = new Promise((resolve, reject) => {
        ready = resolve;
        child.on('exit', (code) => reject(new Error(`the node exited (${code}) before it was ready:\n${log.slice(-30).join('\n')}`)));
    });
    readline.createInterface({ input: child.stdout }).on('line', (line) => {
        if (line.startsWith('FIXTURE_READY ')) ready(JSON.parse(line.slice('FIXTURE_READY '.length)));
        else log.push(line);
    });
    readline.createInterface({ input: child.stderr }).on('line', (line) => log.push(line));
    const { port } = await readyAt;
    const stop = async () => {
        child.kill('SIGTERM');
        await wait(300);
        if (child.exitCode === null) child.kill('SIGKILL');
        fs.rmSync(dataDir, { recursive: true, force: true });
    };
    return { port, log, stop, origin: `https://localhost:${port}` };
}

/**
 * The reads of the reader's own data (and of a previewed feature's own lists) the audit measured on the global node:
 * a screen whose feature is in preview makes none of them (lib/features readsOwn). Matched on the path. Not here: a
 * listing's look-up of its AUTHOR's enterprise (GET /api/treasury/<author>), which is not the reader's.
 */
const OWN_READS = [
    ['their balance', /^\/api\/ledger\/balance\//],
    ['their ledger', /^\/api\/ledger\/transactions/],
    ['their deals', /^\/api\/marketplace\/transactions\/?$/],
    ['Decisions and their voice credits', /^\/api\/commons\/decisions/],
    ['the pool', /^\/api\/commons\/balance/],
    ['the treasuries', /^\/api\/treasuries\/?$/],
    ['their invites', /^\/api\/invite\/mine\//],
    ['their invite tree', /^\/api\/invite\/tree/],
];

/** The reads in `requests` (to `origin`) of the reader's own data, as "what (path)". */
function ownReads(requests, origin) {
    return requests
        .filter((r) => r.method === 'GET' && r.url.startsWith(origin))
        .map((r) => new URL(r.url).pathname)
        .flatMap((p) => OWN_READS.filter(([, re]) => re.test(p)).map(([what]) => `${what} (${p.replace(/[0-9a-f]{64}/g, ':key')})`));
}

/** On a screen whose features are in preview: none of OWN_READS. */
function readsNothingOwn(net, since, origin, where) {
    const bad = ownReads(net.since(since), origin);
    check(bad.length === 0, `net spy, ${where}: no read of the reader's own data${bad.length ? ` (${[...new Set(bad)].join(', ')})` : ''}`);
}

/** On a local screen where the features are live: each of `whats` (OWN_READS names) is read, as before. */
function readsOwnAsBefore(net, since, origin, where, whats) {
    const seen = new Set(ownReads(net.since(since), origin).map((w) => w.replace(/ \(.*$/, '')));
    const missing = whats.filter((w) => !seen.has(w));
    check(missing.length === 0, `net spy, ${where} (local, live): reads ${whats.join(', ')}, as before${missing.length ? ` (missing: ${missing.join(', ')})` : ''}`);
}

/** Every request the page makes: method, where, and its body, for the net spy. */
function spy(page) {
    const all = [];
    page.on('request', (r) => {
        all.push({ at: Date.now(), method: r.method(), url: r.url(), body: r.postData() ?? '' });
    });
    return { since: (t) => all.filter((r) => r.at >= t) };
}

async function openContext(browser, origin, identity, dark, holdInfoMs = 0) {
    const context = await browser.newContext({ viewport: VIEW, ignoreHTTPSErrors: true, reducedMotion: 'reduce' });
    await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin });
    const offHost = new Set();
    await context.addInitScript((mode) => {
        try {
            localStorage.setItem('beanpool-theme-mode', mode);
            localStorage.setItem('beanpool-theme-default-light-v1', 'done');
            localStorage.setItem('beanpool-install-dismissed-forever', '1');
        } catch { /* none */ }
    }, dark ? 'dark' : 'light');
    await context.route((url) => url.hostname !== 'localhost', (route) => {
        offHost.add(new URL(route.request().url()).hostname);
        return route.abort();
    });
    const page = await context.newPage();
    const net = spy(page);
    await page.goto(`${origin}/app`, { waitUntil: 'load' });
    await page.evaluate((id) => new Promise((resolve, reject) => {
        const open = indexedDB.open('beanpool-identity', 1);
        open.onupgradeneeded = () => open.result.createObjectStore('keys');
        open.onerror = () => reject(open.error);
        open.onsuccess = () => {
            const tx = open.result.transaction('keys', 'readwrite');
            tx.objectStore('keys').put(id, 'sovereign-identity');
            tx.oncomplete = () => { open.result.close(); resolve(); };
            tx.onerror = () => reject(tx.error);
        };
    }), identity);
    // A slow link: the node's info answers `holdInfoMs` late on the load that counts (the one below).
    if (holdInfoMs) {
        await context.route((url) => url.hostname === 'localhost' && url.pathname === '/api/community/info', async (route) => {
            await wait(holdInfoMs);
            await route.continue().catch(() => {});
        });
    }
    await page.goto(`${origin}/app`, { waitUntil: 'load' });
    await page.addStyleTag({ content: `html { font-size: ${TEXT_SCALE * 100}% !important; }` });
    return { context, page, net, offHost };
}

async function noSideScroll(page, where) {
    const over = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    check(over <= 1, `${where}: no sideways scroll at 320 px with 1.3x text${over > 1 ? ` (it scrolls ${over}px)` : ''}`);
}

async function shot(page, name) {
    fs.mkdirSync(SHOTS_DIR, { recursive: true });
    await page.screenshot({ path: path.join(SHOTS_DIR, `${name}.png`) });
}

/** No marker on the page in a locked, greyed, dimmed or tier style. */
async function markersNeverLocked(page, where) {
    const bad = await page.evaluate(() => Array.from(document.querySelectorAll('[data-testid^="local-community-"]'))
        .filter((el) => el.getClientRects().length > 0)
        .map((el) => ({ el, cs: getComputedStyle(el) }))
        .filter(({ el, cs }) => /🔒|locked|needs \d|tier/i.test(el.textContent || '') || Number(cs.opacity) < 1
            || (el instanceof HTMLButtonElement && el.disabled) || /grayscale/.test(cs.filter))
        .map(({ el }) => (el.textContent || '').trim().slice(0, 40)));
    check(bad.length === 0, `${where}: no marker looks locked, greyed or dimmed${bad.length ? ` (${bad.join('; ')})` : ''}`);
}

/** Every control the showcase draws (previews, markers, the sheet, the Start screen, My Deals' preview) is 44 x 44 px or more. */
async function targetsAtLeast44(page, where) {
    const small = await page.evaluate(() => {
        const ours = '[data-testid$="-preview"], [data-testid^="local-community-"], [data-testid="start-community-screen"], [role="dialog"][aria-label="My Deals"]';
        return Array.from(document.querySelectorAll('button, a[href], [role="button"], input, select, textarea'))
            .filter((el) => el instanceof Element && (el.matches(ours) || el.closest(ours)) && el.getClientRects().length > 0)
            .map((el) => ({ el, r: el.getBoundingClientRect() }))
            .filter(({ r }) => r.width < 43.5 || r.height < 43.5)
            .map(({ el, r }) => `"${(el.getAttribute('aria-label') || el.textContent || '').trim().slice(0, 30)}" ${Math.round(r.width)}x${Math.round(r.height)}`);
    });
    check(small.length === 0, `${where}: every control is at least 44 x 44 px${small.length ? ` (${small.join('; ')})` : ''}`);
}

/** The open sheet's overlay is the whole screen and its dialog sits on screen, uncovered; or the Start screen fills it. */
async function coversScreen(page, where, testId = 'local-community-sheet') {
    const r = await page.evaluate((id) => {
        const el = document.querySelector(`[data-testid="${id}"]`);
        if (!el) return { missing: true };
        const overlay = id === 'local-community-sheet' ? el.parentElement : el;
        const o = overlay.getBoundingClientRect();
        const d = el.getBoundingClientRect();
        const cx = Math.min(Math.max(d.left + d.width / 2, 0), window.innerWidth - 1);
        const cy = Math.min(Math.max(d.top + Math.min(d.height, window.innerHeight) / 2, 0), window.innerHeight - 1);
        const hit = document.elementFromPoint(cx, cy);
        return {
            overlay: [o.left, o.top, o.width, o.height].map(Math.round), screen: [window.innerWidth, window.innerHeight],
            dialog: [d.left, d.top, d.right, d.bottom].map(Math.round), onTop: !!hit && el.contains(hit),
        };
    }, testId);
    const full = !r.missing && Math.abs(r.overlay[0]) <= 1 && Math.abs(r.overlay[1]) <= 1 && Math.abs(r.overlay[2] - r.screen[0]) <= 1 && Math.abs(r.overlay[3] - r.screen[1]) <= 1;
    const onScreen = !r.missing && r.dialog[0] >= -1 && r.dialog[1] >= -1 && r.dialog[2] <= r.screen[0] + 1 && (testId !== 'local-community-sheet' || r.dialog[3] <= r.screen[1] + 1);
    check(full && onScreen && r.onTop, `${where}: it covers the screen, on top${full && onScreen && r.onTop ? '' : ` (${JSON.stringify(r)})`}`);
}

async function tab(page, label) {
    await page.locator('[data-testid="mobile-bottom-nav"] button', { hasText: label }).first().click();
}

async function closeSheet(page, where) {
    if ((await page.getByTestId('local-community-sheet').count()) > 0) {
        await coversScreen(page, `${where}: the sheet`);
        await page.getByTestId('local-community-sheet').getByRole('button', { name: 'Close' }).click({ force: true, timeout: 5000 }).catch(() => page.keyboard.press('Escape'));
        await page.getByTestId('local-community-sheet').waitFor({ state: 'detached' }).catch(() => {});
    }
    await wait(200);
}

async function globalMember(browser, root, dark) {
    const scheme = dark ? 'dark' : 'light';
    const rua = memberIdentity('Rua');
    const node = await startNode(root, 'global', [{ publicKey: rua.publicKey, callsign: 'Rua', joinedDaysAgo: 1, avatar: true }]);
    console.log(`\nA member of a global node (showcase on), ${scheme}, on ${node.origin}:`);
    const { context, page, net, offHost } = await openContext(browser, node.origin, rua, dark);
    try {
        await page.getByTestId('mobile-bottom-nav').waitFor({ timeout: 30_000 });
        await wait(4_000);
        const t0 = Date.now();

        // The Ledger: the strip, the sheet, the Start screen, collapsed and back.
        await tab(page, 'Ledger');
        await page.getByTestId('ledger-preview').waitFor({ timeout: 10_000 });
        check(await page.getByTestId('local-community-strip').isVisible(), 'Ledger: Example Valley under the strip');
        await noSideScroll(page, 'Ledger preview');
        await targetsAtLeast44(page, 'Ledger preview');
        await markersNeverLocked(page, 'Ledger preview');
        await shot(page, `ledger-strip-${scheme}`);
        await page.getByRole('button', { name: /Send Beans/ }).click();
        await page.getByTestId('local-community-sheet').waitFor();
        await coversScreen(page, 'Ledger, Send Beans: the sheet');
        await noSideScroll(page, 'the sheet');
        await targetsAtLeast44(page, 'the sheet');
        await shot(page, `sheet-${scheme}`);
        await page.getByTestId('local-community-start').click();
        await page.getByTestId('start-community-screen').waitFor();
        await coversScreen(page, 'Ledger: the Start a community screen', 'start-community-screen');
        const runANode = await page.getByTestId('start-community-run-a-node').getAttribute('href');
        check(runANode === 'https://beanpool.org/#run-a-node', `Start a community: How to run a node leads to the node's start link (${runANode})`);
        await noSideScroll(page, 'Start a community');
        await targetsAtLeast44(page, 'Start a community');
        await shot(page, `start-community-${scheme}`);
        await page.getByRole('button', { name: 'Back' }).click();
        await page.getByTestId('local-community-strip-close').click();
        check(await page.getByTestId('local-community-strip-collapsed').isVisible(), 'Ledger: ✕ makes the strip one line');
        await noSideScroll(page, 'Ledger, strip collapsed');
        await targetsAtLeast44(page, 'Ledger, strip collapsed');
        await shot(page, `ledger-collapsed-${scheme}`);
        await page.getByRole('button', { name: 'Show the whole note' }).click();
        await wait(1_000);
        readsNothingOwn(net, t0, node.origin, 'the Ledger');

        // The Commons: enterprise and Decision in preview, Vote opens the sheet.
        const tCommons = Date.now();
        await tab(page, 'Commons');
        await page.getByTestId('commons-preview').waitFor({ timeout: 10_000 });
        await page.getByTestId('sample-decision').getByTestId('local-community-action').click();
        await page.getByTestId('local-community-sheet').waitFor();
        await closeSheet(page, 'Commons, Vote');
        await noSideScroll(page, 'Commons preview');
        await targetsAtLeast44(page, 'Commons preview');
        await markersNeverLocked(page, 'Commons preview');
        await shot(page, `commons-${scheme}`);
        await wait(1_000);
        readsNothingOwn(net, tCommons, node.origin, 'the Commons');

        // The Market: My Deals in preview; a listing's In return and its deal action.
        const tMarket = Date.now();
        await tab(page, 'Market');
        await page.getByRole('button', { name: /My Deals/ }).first().click();
        await page.getByTestId('deals-preview').waitFor({ timeout: 10_000 });
        check(await page.getByRole('button', { name: 'Close My Deals' }).count() === 0 && await page.getByRole('dialog').count() === 1, 'My Deals: the preview alone, never the live My Deals');
        await noSideScroll(page, 'My Deals preview');
        await targetsAtLeast44(page, 'My Deals preview');
        await shot(page, `deals-${scheme}`);
        await page.getByTestId('deals-preview').getByTestId('local-community-action').first().click();
        await page.getByTestId('local-community-sheet').waitFor();
        await closeSheet(page, 'My Deals');
        await page.getByRole('dialog', { name: 'My Deals' }).getByRole('button', { name: 'Close' }).click();
        await wait(1_000);
        readsNothingOwn(net, tMarket, node.origin, 'the Market tab\'s load and My Deals');
        const tListing = Date.now();
        await page.getByText('Sourdough loaves').first().click();
        await page.getByTestId('listing-in-return').waitFor({ timeout: 10_000 });
        const inReturn = await page.getByTestId('listing-in-return').innerText();
        check(/Free, a swap, or ask/.test(inReturn) && /In a local community this is a price in Beans/.test(inReturn), 'listing: In return, with the price line');
        const deal = page.getByTestId('local-community-action').filter({ hasText: 'Request · Beans held safely' });
        check(await deal.count() === 1, 'listing: the deal action reads "Request · Beans held safely" with the pill');
        check(await page.getByRole('button', { name: /Accept Offer|Offer to Fulfill/ }).count() === 0, 'listing: no live Accept button');
        await deal.click();
        await page.getByTestId('local-community-sheet').waitFor();
        await noSideScroll(page, 'listing with the sheet');
        await targetsAtLeast44(page, 'listing with the sheet');
        await shot(page, `listing-sheet-${scheme}`);
        await closeSheet(page, 'listing, the deal action');
        await markersNeverLocked(page, 'listing');
        await wait(1_000);
        readsNothingOwn(net, tListing, node.origin, 'a listing');

        await page.keyboard.press('Escape');

        // People → Invites: preview with strip, actions, QR and no card overflow.
        const tInvites = Date.now();
        await tab(page, 'People');
        await page.getByRole('tab', { name: /Invites/ }).click();
        await page.getByTestId('invites-preview').waitFor({ timeout: 10_000 });
        check(await page.getByTestId('local-community-strip').isVisible(), 'Invites: Example Valley under the strip');
        check(/12 words or a sign-in/.test(await page.locator('body').innerText()), 'Invites: "12 words or a sign-in"');

        // Actions open the sheet and leave clipboard untouched
        await page.evaluate(() => navigator.clipboard.writeText('<cleared>').catch(() => {}));
        const generateBtn = page.getByRole('button', { name: /Generate New Invite/ });
        await generateBtn.click();
        await page.getByTestId('local-community-sheet').waitFor();
        await closeSheet(page, 'Invites, Generate');

        const rowShare = page.getByTestId('invites-preview').getByTestId('local-community-action').filter({ hasText: /Share/ }).first();
        await rowShare.click();
        await page.getByTestId('local-community-sheet').waitFor();
        await closeSheet(page, 'Invites, the row\'s Share');

        const rowCopy = page.getByTestId('invites-preview').getByTestId('local-community-action').filter({ hasText: /Copy/ }).first();
        await rowCopy.click();
        await page.getByTestId('local-community-sheet').waitFor();
        await closeSheet(page, 'Invites, the row\'s Copy');

        // Toggle QR code and check it decodes to EXAMPLE-1234
        await page.getByRole('button', { name: 'Show QR code' }).first().click();
        const box = page.locator('[data-testid="invite-qr-card"] div.bg-white.rounded-xl.inline-block').first();
        await box.waitFor({ timeout: 5_000 });
        check(await box.isVisible(), 'Invites: QR SVG visible');

        // The QR card's own Copy and Share: markers too, each opening the sheet over the screen.
        const qrMarkers = page.getByTestId('invite-qr-card').getByTestId('local-community-action');
        check(await qrMarkers.count() === 2, `Invites: the QR card's Copy and Share are markers (${await qrMarkers.count()})`);
        for (const [i, name] of [[0, 'Copy'], [1, 'Share']]) {
            await qrMarkers.nth(i).click();
            await page.getByTestId('local-community-sheet').waitFor();
            await closeSheet(page, `Invites, the QR card's ${name}`);
        }

        const clipboard = await page.evaluate(() => navigator.clipboard.readText().catch((e) => `ERR: ${e}`));
        check(clipboard === '<cleared>', `Invites: clipboard untouched by preview actions (got: ${clipboard})`);

        check(!!(jsQR && PNG), `Invites: jsqr + pngjs found to decode the QR${jsQR && PNG ? '' : ` (set QRDEPS to a folder holding both; ${qrDepsMissing})`}`);
        if (jsQR && PNG) {
            await box.evaluate((e) => e.scrollIntoView({ block: 'center' }));
            await wait(300);
            const bb = await box.boundingBox();
            if (bb) {
                const buf = await page.screenshot({ clip: bb });
                const png = PNG.sync.read(buf);
                const code = jsQR(new Uint8ClampedArray(png.data), png.width, png.height);
                check(code && code.data === 'EXAMPLE-1234', `Invites: QR decodes to EXAMPLE-1234 via jsQR (got: ${code?.data})`);
            }
        }

        // Every control and the QR, with the QR card open: inside the screen and inside its nearest bordered box.
        await page.getByTestId('invite-qr-card').evaluate((e) => e.scrollIntoView({ block: 'center' }));
        const overflow = await page.evaluate(() => {
            const preview = document.querySelector('[data-testid="invites-preview"]');
            if (!preview) return ['no invites-preview'];
            const bordered = (el) => {
                for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
                    const cs = getComputedStyle(p);
                    if (['Top', 'Right', 'Bottom', 'Left'].some((side) => parseFloat(cs[`border${side}Width`]) > 0)) return p;
                }
                return null;
            };
            const bad = [];
            for (const el of preview.querySelectorAll('button, a[href], [role="button"], svg, [data-testid="invite-qr-card"] div.bg-white')) {
                if (el.getClientRects().length === 0 || el.closest('button') !== el && el.closest('button')) continue;
                const r = el.getBoundingClientRect();
                const what = `${el.tagName.toLowerCase()} "${(el.getAttribute('aria-label') || el.textContent || '').trim().slice(0, 20)}"`;
                if (r.left < -1 || r.right > window.innerWidth + 1) bad.push(`${what} x ${Math.round(r.left)}-${Math.round(r.right)} past the screen`);
                const box = bordered(el);
                if (box) {
                    const b = box.getBoundingClientRect();
                    if (r.left < b.left - 1 || r.right > b.right + 1) bad.push(`${what} x ${Math.round(r.left)}-${Math.round(r.right)} past its box ${Math.round(b.left)}-${Math.round(b.right)}`);
                }
            }
            return bad;
        });
        check(overflow.length === 0, `Invites, the QR card open: every control inside the screen and its card at 320 @130%${overflow.length ? ` (${overflow.join(', ')})` : ''}`);

        await noSideScroll(page, 'Invites');
        await targetsAtLeast44(page, 'Invites');
        await shot(page, `invites-${scheme}`);
        await wait(1_000);
        readsNothingOwn(net, tInvites, node.origin, 'Invites');

        // The composer, on the Map: no price field, the line in its slot.
        const tMap = Date.now();
        await tab(page, 'Map');
        await page.getByRole('button', { name: 'New Post' }).first().click();
        await page.getByTestId('composer-price-line').waitFor({ timeout: 10_000 }).catch(async (e) => {
            await shot(page, `composer-missing-${scheme}`);
            console.error(`    (the composer as drawn: ${(await page.locator('body').innerText()).replace(/\s+/g, ' ').slice(0, 600)})`);
            throw e;
        });
        check(await page.getByPlaceholder('B', { exact: true }).count() === 0, 'composer: no price field');
        await noSideScroll(page, 'composer');
        await shot(page, `composer-${scheme}`);
        await wait(1_000);
        readsNothingOwn(net, tMap, node.origin, 'the Map and the composer');

        // Her own profile (global shows listings, not people: no author to tap), opened as Settings' "View my profile"
        // opens it: the trust card's slot carries the line.
        const tReload = Date.now();
        await page.goto(`${node.origin}/app#profile=${rua.publicKey}`, { waitUntil: 'load' });
        await page.reload({ waitUntil: 'load' });
        await page.addStyleTag({ content: `html { font-size: ${TEXT_SCALE * 100}% !important; }` });
        await page.getByTestId('profile-local-line').waitFor({ timeout: 20_000 });
        check(/Trust badges and Beans are earned in a local community/.test(await page.getByTestId('profile-local-line').innerText()), 'profile: the line in the trust card\'s slot, and no live-empty trust card');
        await noSideScroll(page, 'profile');
        await targetsAtLeast44(page, 'profile');
        await shot(page, `profile-${scheme}`);
        // The reload is the app shell's load too: its deals poll and balance reads come with it.
        await wait(1_500);
        readsNothingOwn(net, tReload, node.origin, 'the profile and the app shell\'s load');

        // The net spy. Every preview screen and marker above, between landing and the reload: no write at all. Over the
        // whole visit, page loads included: no sample- id on the wire, and no write but the app shell's own on a load
        // (the recovery banner reads its list with POST /api/recovery/collect/mine, App-wide, before this PR).
        await wait(1_500);
        const showing = net.since(t0).filter((r) => r.at < tReload);
        const writes = showing.filter((r) => !['GET', 'HEAD', 'OPTIONS'].includes(r.method));
        check(writes.length === 0, `net spy, the preview screens and every marker (${showing.length} requests): no POST, PUT, PATCH or DELETE at all${writes.length ? ` (${writes.map((w) => `${w.method} ${new URL(w.url).pathname}`).join(', ')})` : ''}`);
        const whole = net.since(0);
        const sample = whole.filter((r) => /sample-/.test(r.url) || /sample-/.test(r.body));
        check(sample.length === 0, `net spy, the whole visit (${whole.length} requests): no sample- id in any address or body${sample.length ? ` (${sample.map((r) => r.url).join(', ')})` : ''}`);
        const shellWrites = whole.filter((r) => !['GET', 'HEAD', 'OPTIONS'].includes(r.method));
        const unknown = shellWrites.filter((r) => new URL(r.url).pathname !== '/api/recovery/collect/mine');
        check(unknown.length === 0, `net spy, the whole visit: the only write is the app shell's recovery-banner read on a load (${shellWrites.length}: ${[...new Set(shellWrites.map((w) => `${w.method} ${new URL(w.url).pathname}`))].join(', ') || 'none'})${unknown.length ? `; OTHER: ${unknown.map((w) => `${w.method} ${new URL(w.url).pathname}`).join(', ')}` : ''}`);
        const api = [...new Set(showing.filter((r) => r.url.startsWith(node.origin) && new URL(r.url).pathname.startsWith('/api/')).map((r) => new URL(r.url).pathname.replace(/[0-9a-f]{64}|[0-9a-f-]{36}/g, ':id')))].sort();
        console.log(`    reads while the previews were open (the app's own, Market, Map, People): ${api.join(', ')}`);
        const me = whole.filter((r) => r.url.startsWith(`${node.origin}/api/community/me`) && r.method === 'GET');
        check(me.length >= 1, `the reader's own features read from GET /api/community/me (${me.length} read(s) over the visit, other screens' included)`);
        // The Map's tiles are asked of their host and aborted here; nothing else (the app's fonts come from the node since #1858).
        const others = [...offHost].filter((h) => !/(^|\.)tile\.openstreetmap\.org$/.test(h));
        check(others.length === 0, `no host but this machine, the Map's tiles aside (aborted: ${[...offHost].join(', ') || 'none'})${others.length ? `; OTHER: ${others.join(', ')}` : ''}`);
    } finally {
        await context.close();
        await node.stop();
    }
}

async function localMember(browser, root) {
    const ana = memberIdentity('Ana');
    const node = await startNode(root, 'local', [{ publicKey: ana.publicKey, callsign: 'Ana', joinedDaysAgo: 30 }]);
    console.log(`\nA member of a local node (Beans live), light, on ${node.origin}:`);
    const { context, page, net } = await openContext(browser, node.origin, ana, false);
    try {
        const tLoad = Date.now() - 60_000;
        await page.getByTestId('mobile-bottom-nav').waitFor({ timeout: 30_000 });
        await wait(3_000);
        // The app shell's load reads the member's deals, as before.
        readsOwnAsBefore(net, tLoad, node.origin, 'the app shell\'s load', ['their deals']);
        const tLedger = Date.now();
        await tab(page, 'Ledger');
        await wait(2_500);
        check(await page.getByTestId('ledger-preview').count() === 0 && await page.getByTestId('local-community-strip').count() === 0, 'Ledger: the real one, no strip');
        readsOwnAsBefore(net, tLedger, node.origin, 'the Ledger', ['their balance', 'their ledger']);
        const tMarket = Date.now();
        await tab(page, 'Market');
        await wait(2_500);
        // The Offer-first gate's balance, as before.
        readsOwnAsBefore(net, tMarket, node.origin, 'the Market tab\'s load', ['their balance']);
        await page.getByText('Sourdough loaves').first().click();
        await page.getByRole('button', { name: /Accept Offer/ }).waitFor({ timeout: 10_000 });
        check(await page.getByTestId('listing-in-return').count() === 0 && await page.getByTestId('local-community-action').count() === 0, 'listing: the price and the real Accept, no marker');
        await shot(page, 'local-listing-light');
        await page.keyboard.press('Escape');
        const tMap = Date.now();
        await tab(page, 'Map');
        await wait(2_500);
        readsOwnAsBefore(net, tMap, node.origin, 'the Map', ['their balance']);

        // The Commons, Invites and her own profile read her own data here, as they always have.
        const tCommons = Date.now();
        await tab(page, 'Commons');
        await page.getByTestId('voice-credits-card').waitFor({ timeout: 10_000 });
        await wait(1_500);
        readsOwnAsBefore(net, tCommons, node.origin, 'the Commons', ['their balance', 'Decisions and their voice credits', 'the pool', 'the treasuries']);
        const tInvites = Date.now();
        await tab(page, 'People');
        await page.getByRole('tab', { name: /Invites/ }).click();
        await wait(2_000);
        check(await page.getByRole('button', { name: 'Show QR code' }).count() === 0, 'Invites (local, live): no 📱 button');
        check(await page.locator('button').filter({ hasText: '📱' }).count() === 0, 'Invites (local, live): no 📱 button text');
        readsOwnAsBefore(net, tInvites, node.origin, 'Invites', ['their invites', 'their invite tree']);
        const tProfile = Date.now();
        await page.goto(`${node.origin}/app#profile=${ana.publicKey}`, { waitUntil: 'load' });
        await page.reload({ waitUntil: 'load' });
        await page.getByText(/trust points/).first().waitFor({ timeout: 30_000 });
        await wait(2_000);
        readsOwnAsBefore(net, tProfile, node.origin, 'her own profile and the app shell\'s load', ['their balance', 'their deals']);
    } finally {
        await context.close();
        await node.stop();
    }
}

/**
 * The node's info held back 6 s, and the Ledger tapped as soon as the app is up (review of #2035, N2): on a global node
 * nothing of the member's is read before the info answers, the page draws no live balance meanwhile, and the preview
 * comes after. On a local node the Ledger waits too, then reads the balance and ledger, as before.
 */
async function slowInfoLedger(browser, root, profile) {
    const HOLD = 6_000;
    const who = memberIdentity(profile === 'global' ? 'Rua' : 'Ana');
    const node = await startNode(root, profile, [{ publicKey: who.publicKey, callsign: profile === 'global' ? 'Rua' : 'Ana', joinedDaysAgo: profile === 'global' ? 1 : 30 }]);
    console.log(`\nA member of a ${profile} node, the node's info held back ${HOLD / 1000} s, the Ledger tapped at once, on ${node.origin}:`);
    const { context, page, net } = await openContext(browser, node.origin, who, false, HOLD);
    try {
        const infoAnswered = page.waitForResponse((r) => new URL(r.url()).pathname === '/api/community/info', { timeout: 30_000 });
        await page.getByTestId('mobile-bottom-nav').waitFor({ timeout: 30_000 });
        const tTap = Date.now();
        await tab(page, 'Ledger');
        await wait(1_500);
        const drawnLive = await page.getByTestId('ledger-balance').count();
        await shot(page, `ledger-waiting-${profile}-light`);
        await infoAnswered;
        const tInfo = Date.now();
        const early = ownReads(net.since(tTap).filter((r) => r.at < tInfo), node.origin);
        check(early.length === 0, `net spy, the Ledger before the info answered (${tInfo - tTap} ms): no read of the member's own data${early.length ? ` (${[...new Set(early)].join(', ')})` : ''}`);
        check(drawnLive === 0, 'the Ledger before the info answered: no live balance drawn (a neutral wait)');
        if (profile === 'global') {
            await page.getByTestId('ledger-preview').waitFor({ timeout: 10_000 });
            await wait(1_500);
            readsNothingOwn(net, tTap, node.origin, 'the Ledger once the info said preview');
        } else {
            await page.getByTestId('ledger-balance').waitFor({ timeout: 10_000 });
            await wait(1_500);
            readsOwnAsBefore(net, tInfo, node.origin, 'the Ledger once the info answered', ['their balance', 'their ledger']);
        }
    } finally {
        await context.close();
        await node.stop();
    }
}

async function main() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bp-showcase-check-'));
    let browser;
    try {
        await build({ root: PWA_DIR, logLevel: 'warn', build: { outDir: path.join(root, 'public'), emptyOutDir: true } });
        browser = await chromium.launch();
        console.log('The web app as built; one Chromium at 320 px, 1.3x text, reduced motion.');
        for (const run of [() => globalMember(browser, root, false), () => globalMember(browser, root, true), () => localMember(browser, root),
            () => slowInfoLedger(browser, root, 'global'), () => slowInfoLedger(browser, root, 'local')]) {
            try {
                await run();
            } catch (e) {
                failures.push(String(e?.stack || e));
                console.error(`  ✗ ${e?.stack || e}`);
            }
        }
    } finally {
        await browser?.close();
        fs.rmSync(root, { recursive: true, force: true });
    }
    console.log(`\nScreenshots: ${SHOTS_DIR}`);
    if (failures.length) {
        console.error(`\n❌ ${failures.length} check(s) failed.`);
        process.exit(1);
    }
    console.log('\n⭐️ The showcase holds in the real web app against real nodes at 320 px with 1.3x text.');
}

main().catch((e) => { console.error('❌', e); process.exit(1); });
