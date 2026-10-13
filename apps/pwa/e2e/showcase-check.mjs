/**
 * The global showcase in the REAL web app (scratch/global-node/DESIGN-global-showcase-fable.md §6 W2), as built and served
 * by a real node on this machine (e2e/home-node-harness.ts: the server's own routes, signature middleware and W1's
 * `showcase` switch), with a signed-in member, in headless Chromium at 320 px with 1.3x text, light and dark.
 *
 *   1. a member of a global node (showcase on): the Ledger in preview (strip expanded and collapsed, the sheet, the Start
 *      a community screen), the Commons and My Deals in preview, a listing's In return line and its "Request · Beans held
 *      safely" action, Invites' line, a profile's line, the composer's price line; every marker never looks locked;
 *   2. the NET SPY over all of that: no POST, PUT, PATCH or DELETE at all, nothing carrying a `sample-` id, no host but
 *      this machine (map tiles aside, aborted), and the reader's own features read from /api/community/me;
 *   3. a member of a local node (Beans live): the real Ledger, no strip, no line, the real deal button.
 *
 * Fails on any sideways scroll, a write, a `sample-` id on the wire, a marker in a locked or greyed style, or a control in
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

/** Every request the page makes: method, where, and its body, for the net spy. */
function spy(page) {
    const all = [];
    page.on('request', (r) => {
        all.push({ at: Date.now(), method: r.method(), url: r.url(), body: r.postData() ?? '' });
    });
    return { since: (t) => all.filter((r) => r.at >= t) };
}

async function openContext(browser, origin, identity, dark) {
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

        // The Commons: enterprise and Decision in preview, Vote opens the sheet.
        await tab(page, 'Commons');
        await page.getByTestId('commons-preview').waitFor({ timeout: 10_000 });
        await page.getByTestId('sample-decision').getByTestId('local-community-action').click();
        await page.getByTestId('local-community-sheet').waitFor();
        await closeSheet(page);
        await noSideScroll(page, 'Commons preview');
        await targetsAtLeast44(page, 'Commons preview');
        await markersNeverLocked(page, 'Commons preview');
        await shot(page, `commons-${scheme}`);

        // The Market: My Deals in preview; a listing's In return and its deal action.
        await tab(page, 'Market');
        await page.getByRole('button', { name: /My Deals/ }).first().click();
        await page.getByTestId('deals-preview').waitFor({ timeout: 10_000 });
        check(await page.getByRole('button', { name: 'Close My Deals' }).count() === 0 && await page.getByRole('dialog').count() === 1, 'My Deals: the preview alone, never the live My Deals');
        await noSideScroll(page, 'My Deals preview');
        await targetsAtLeast44(page, 'My Deals preview');
        await shot(page, `deals-${scheme}`);
        await page.getByTestId('deals-preview').getByTestId('local-community-action').first().click();
        await page.getByTestId('local-community-sheet').waitFor();
        await closeSheet(page);
        await page.getByRole('dialog', { name: 'My Deals' }).getByRole('button', { name: 'Close' }).click();
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

        await page.keyboard.press('Escape');

        // People → Invites: the line.
        await tab(page, 'People');
        await page.getByRole('tab', { name: /Invites/ }).click();
        await page.getByTestId('invites-local-line').waitFor({ timeout: 10_000 });
        check(/12 words or a sign-in/.test(await page.locator('body').innerText()), 'Invites: "12 words or a sign-in"');
        await noSideScroll(page, 'Invites');
        await targetsAtLeast44(page, 'Invites');
        await shot(page, `invites-${scheme}`);

        // The composer, on the Map: no price field, the line in its slot.
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
        // The app's font (src/main.tsx) and the Map's tiles are asked of their hosts and aborted here; nothing else.
        const others = [...offHost].filter((h) => h !== 'fonts.googleapis.com' && !/(^|\.)tile\.openstreetmap\.org$/.test(h));
        check(others.length === 0, `no host but this machine, the app's font and the Map's tiles aside (aborted: ${[...offHost].join(', ') || 'none'})${others.length ? `; OTHER: ${others.join(', ')}` : ''}`);
    } finally {
        await context.close();
        await node.stop();
    }
}

async function localMember(browser, root) {
    const ana = memberIdentity('Ana');
    const node = await startNode(root, 'local', [{ publicKey: ana.publicKey, callsign: 'Ana', joinedDaysAgo: 30 }]);
    console.log(`\nA member of a local node (Beans live), light, on ${node.origin}:`);
    const { context, page } = await openContext(browser, node.origin, ana, false);
    try {
        await page.getByTestId('mobile-bottom-nav').waitFor({ timeout: 30_000 });
        await wait(3_000);
        await tab(page, 'Ledger');
        await wait(2_500);
        check(await page.getByTestId('ledger-preview').count() === 0 && await page.getByTestId('local-community-strip').count() === 0, 'Ledger: the real one, no strip');
        await tab(page, 'Market');
        await page.getByText('Sourdough loaves').first().click();
        await page.getByRole('button', { name: /Accept Offer/ }).waitFor({ timeout: 10_000 });
        check(await page.getByTestId('listing-in-return').count() === 0 && await page.getByTestId('local-community-action').count() === 0, 'listing: the price and the real Accept, no marker');
        await shot(page, 'local-listing-light');
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
        for (const run of [() => globalMember(browser, root, false), () => globalMember(browser, root, true), () => localMember(browser, root)]) {
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
