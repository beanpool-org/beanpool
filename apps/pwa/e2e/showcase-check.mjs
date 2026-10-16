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
 * a preview, a marker, the sheet or the Start screen smaller than 44 x 44 px.
 *
 * Run: pnpm --filter @beanpool/pwa showcase-check   (SHOWCASE_SHOTS: where the pictures go)
 * Needs Chromium for Playwright once: pnpm --filter @beanpool/pwa exec playwright install --only-shell chromium
 */
/* global URL, console, process, setTimeout, document, window, indexedDB, localStorage, getComputedStyle, HTMLButtonElement, Element -- Node, and the page's side of evaluate() */
import { build } from 'vite';
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';

const PWA_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
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
    const { over, past } = await page.evaluate(() => {
        const W = window.innerWidth;
        const docOver = document.documentElement.scrollWidth - document.documentElement.clientWidth;
        const beyond = [];
        for (const el of document.querySelectorAll('[data-testid^="local-community-"]')) {
            const r = el.getBoundingClientRect();
            if (r.width && (r.right > W + 1 || r.left < -1)) {
                beyond.push(`${(el.getAttribute('data-testid') || el.tagName)} "${(el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 30)}" right=${Math.round(r.right)}`);
            }
        }
        return { over: docOver, past: beyond };
    });
    check(over <= 1, `${where}: no sideways scroll at 320 px with 1.3x text${over > 1 ? ` (it scrolls ${over}px)` : ''}`);
    check(past.length === 0, `${where}: no community marker overflows viewport${past.length ? ` (${past.join('; ')})` : ''}`);
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
        const ours = '[data-testid$="-preview"], [data-testid^="local-community-"], [data-testid="start-community-screen"], [role="dialog"][aria-label="My Deals"], [role="dialog"][aria-labelledby="my-deals-title"]';
        return Array.from(document.querySelectorAll('button, a[href], [role="button"], input, select, textarea'))
            .filter((el) => el instanceof Element && (el.matches(ours) || el.closest(ours)) && el.getClientRects().length > 0)
            .map((el) => ({ el, r: el.getBoundingClientRect() }))
            .filter(({ r }) => r.width < 43.5 || r.height < 43.5)
            .map(({ el, r }) => `"${(el.getAttribute('aria-label') || el.textContent || '').trim().slice(0, 30)}" ${Math.round(r.width)}x${Math.round(r.height)}`);
    });
    check(small.length === 0, `${where}: every control is at least 44 x 44 px${small.length ? ` (${small.join('; ')})` : ''}`);
}

async function tab(page, label) {
    await page.locator('[data-testid="mobile-bottom-nav"] button', { hasText: label }).first().click();
}

async function closeSheet(page) {
    await page.getByTestId('local-community-sheet').getByRole('button', { name: 'Close' }).click();
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
        await noSideScroll(page, 'the sheet');
        await targetsAtLeast44(page, 'the sheet');
        await shot(page, `sheet-${scheme}`);
        await page.getByTestId('local-community-start').click();
        await page.getByTestId('start-community-screen').waitFor();
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

        // The Commons: enterprises in preview, Pledge opens the sheet.
        const tCommons = Date.now();
        await tab(page, 'Commons');
        await page.getByTestId('commons-preview').waitFor({ timeout: 10_000 });
        await page.getByTestId('commons-preview').getByTestId('local-community-action').first().click();
        await page.getByTestId('local-community-sheet').waitFor();
        await closeSheet(page);
        await noSideScroll(page, 'Commons preview');
        await targetsAtLeast44(page, 'Commons preview');
        await markersNeverLocked(page, 'Commons preview');
        await shot(page, `commons-${scheme}`);
        await wait(1_000);
        readsNothingOwn(net, tCommons, node.origin, 'the Commons');

        // The enterprise page in preview (review of #2063): the Bakery's real card, once, marked, opens the real page fed
        // the sample; each of its six controls is a marker; a keeper row is no button, and a tap on one opens no profile.
        const cards = page.getByTestId('sample-enterprise-card');
        check(await cards.count() === 2 && await page.getByTestId('commons-preview').getByTestId('sample-enterprise-card').count() === 2,
            'Commons: the Bakery and the compost bay are the real cards, inside the preview');
        check((await page.locator('main').innerText()).split('Example Valley Bakery').length === 2, 'Commons: the Bakery shows once');
        const tPage = Date.now();
        await cards.first().click();
        const overlay = page.getByTestId('page-overlay');
        await overlay.waitFor({ timeout: 10_000 });
        await wait(1_000);
        check(await overlay.getByTestId('sample-header').count() === 1, 'enterprise page: the Example header');
        const pageMarkers = overlay.getByTestId('local-community-action');
        const markerCount = await pageMarkers.count();
        check(markerCount === 6, `enterprise page: its six controls are markers (${markerCount})`);
        for (let i = 0; i < markerCount; i++) {
            await pageMarkers.nth(i).click();
            await page.getByTestId('local-community-sheet').waitFor();
            await closeSheet(page);
        }
        check(await overlay.getByRole('button', { name: /a neighbour/ }).count() === 0, 'enterprise page: a keeper row is no button');
        await overlay.getByText('a neighbour', { exact: true }).first().click();
        await wait(1_000);
        check(await overlay.count() === 1 && await page.getByText('sample-keeper-1').count() === 0, 'enterprise page: a tap on a keeper row opens no profile');
        await noSideScroll(page, 'enterprise page');
        await targetsAtLeast44(page, 'enterprise page');
        await markersNeverLocked(page, 'enterprise page');
        await shot(page, `enterprise-${scheme}`);
        const pageReqs = net.since(tPage).filter((r) => r.url.startsWith(node.origin) && new URL(r.url).pathname.startsWith('/api/'));
        check(pageReqs.length === 0, `net spy, the enterprise page, every marker and a keeper tap: not one request${pageReqs.length ? ` (${pageReqs.map((r) => `${r.method} ${new URL(r.url).pathname}`).join(', ')})` : ''}`);
        await overlay.getByRole('button', { name: 'Go back' }).click();
        await overlay.waitFor({ state: 'detached', timeout: 5_000 });

        // Commons → Decide in preview: each marker in it and the header opens the sheet.
        const tDecide = Date.now();
        await page.getByTestId('commons-section-tabs').getByRole('button', { name: /Decide/ }).click();
        await page.getByTestId('decide-preview').waitFor({ timeout: 10_000 });
        const decideActs = page.getByTestId('decide-preview').getByTestId('local-community-action');
        const nDecide = await decideActs.count();
        check(nDecide === 3, `Decide preview: 3 marker actions in Decide (${nDecide})`);
        for (let i = 0; i < nDecide; i++) {
            await decideActs.nth(i).click();
            await page.getByTestId('local-community-sheet').waitFor({ timeout: 5_000 });
            await closeSheet(page);
            await wait(300);
        }
        const headerPropose = page.getByTestId('local-community-action').filter({ hasText: '+ Propose' }).filter({ hasNotText: 'Decision' });
        const headerProposeCount = await headerPropose.count();
        check(headerProposeCount === 1, `Decide preview: the header's + Propose marker is there (${headerProposeCount})`);
        if (headerProposeCount > 0) {
            await headerPropose.first().click();
            await page.getByTestId('local-community-sheet').waitFor({ timeout: 5_000 });
            await closeSheet(page);
            await wait(300);
        }
        await noSideScroll(page, 'Decide preview');
        await targetsAtLeast44(page, 'Decide preview');
        await markersNeverLocked(page, 'Decide preview');
        await shot(page, `decide-${scheme}`);
        await wait(1_000);
        readsNothingOwn(net, tDecide, node.origin, 'Decide');

        // The Market: My Deals in preview; a listing's In return and its deal action.
        const tMarket = Date.now();
        await tab(page, 'Market');
        await page.getByRole('button', { name: /My Deals/ }).first().click();
        await page.getByTestId('deals-preview').waitFor({ timeout: 10_000 });
        check(await page.getByTestId('local-community-strip').isVisible() && await page.getByTestId('sample-header').isVisible(), 'My Deals: strip + EXAMPLE present');
        check(await page.getByTestId('sample-deal-sample-deal-shelves').isVisible() && await page.getByTestId('sample-deal-sample-deal-bike').isVisible(), 'My Deals: In Progress sample deals present');
        await noSideScroll(page, 'My Deals preview');
        await targetsAtLeast44(page, 'My Deals preview');
        await shot(page, `deals-${scheme}`);
        await page.getByTestId('sample-deal-sample-deal-shelves').getByTestId('local-community-action').click();
        await page.getByTestId('local-community-sheet').waitFor();
        await closeSheet(page);
        await page.getByTestId('sample-deal-sample-deal-bike').getByTestId('local-community-action').click();
        await page.getByTestId('local-community-sheet').waitFor();
        await closeSheet(page);
        await page.getByRole('button', { name: /History/ }).click();
        await page.getByTestId('sample-deal-sample-deal-mending').waitFor({ timeout: 5_000 });
        check(await page.getByTestId('sample-deal-sample-deal-mending').isVisible(), 'My Deals: History sample deal present');
        await page.getByTestId('sample-deal-sample-deal-mending').getByTestId('local-community-action').click();
        await page.getByTestId('local-community-sheet').waitFor();
        await closeSheet(page);
        await page.getByRole('button', { name: /Close My Deals/ }).first().click();
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
        await closeSheet(page);
        await markersNeverLocked(page, 'listing');
        await wait(1_000);
        readsNothingOwn(net, tListing, node.origin, 'a listing');

        await page.keyboard.press('Escape');

        // People → Invites: the line.
        const tInvites = Date.now();
        await tab(page, 'People');
        await page.getByRole('tab', { name: /Invites/ }).click();
        await page.getByTestId('invites-local-line').waitFor({ timeout: 10_000 });
        check(/12 words or a sign-in/.test(await page.locator('body').innerText()), 'Invites: "12 words or a sign-in"');
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
