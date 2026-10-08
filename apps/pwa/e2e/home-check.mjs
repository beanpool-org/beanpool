/**
 * The web Home (slice H3 of scratch/global-node/DESIGN-home-dashboard-fable.md) in headless Chromium at 320 px with 1.3x
 * text, against REAL nodes on this machine (e2e/home-node-harness.ts: the server's own GET /api/home, preferences route,
 * signature middleware and socket). The web app is built exactly as it ships and served by that node.
 *
 *   1. a member of a local community who never edited lands on Home (the card frame, scratch/home/CARD-FRAME-DESIGN-
 *      fable.md): one GET /api/home, the newcomer's cards, no sideways scroll, every control at least 44 px tall, axe
 *      clean (light and dark); a tap on an interest reorders the Market card in place and saves on the account; Add a
 *      card is a real dialog (axe clean in both themes, and a saved search's settings sheet too), and Your Beans added
 *      from it by keyboard goes first, under Needs you, read at once, kept on the account (another browser, a reload);
 *      "…" Remove takes a card away with one save and gives focus to the nearest card left; Edit home is a real dialog
 *      with no switches (axe clean, Escape gives focus back), and its Reset to defaults gives back the newcomer's list;
 *      with the node unreachable the kept answer is drawn and the page says so; Sign Out (Device
 *      Only) leaves no cached Home in the browser; the Tips card after First steps on tip 1, Next by keyboard draws the
 *      next one in place, says it and keeps focus, and the tip's text grows with the reader's text size;
 *   2. the cost (§5.4): the landing's requests against what the Market reads when it is opened, and an idle Home tab's
 *      traffic over a window with one doorbell (a new listing) in it, by Chromium's own byte counts;
 *   3. a visitor in the global lobby: Home first, the Join card, then the public cards from one unsigned read, axe clean;
 *      "Share my area" reads Home again from a rough point; the Market one tap away;
 *   4. a new member of the global node: Find your community first and pinned, no money cards on Home or in the picker,
 *      who joined as a count;
 *      the Tips card after First steps, from the worldwide community's own list;
 *   5. two tabs of one browser (PR #1479's second review): a card added in another browser is drawn at this one's next
 *      landing, and in a tab left open at its next read, with one more read at once. With her Home open in other tabs,
 *      Sign Out (Device Only), the delete at the last community and Force Clear & Re-Sync in one: a tab that hears it
 *      drops her Home at once (axe clean); one that hears nothing finds out at its first write. Nothing of hers is put
 *      back on disk by a Remove (1), a read in flight (2), or, on global, the next read, which would have gone out
 *      unsigned (3); after Force Clear a read from before it is never kept, and the other tab reads afresh with no tag.
 *      The third review: after Force Clear a Remove in a deaf tab puts back nothing it read before; and a restore with 12
 *      words in a welcome page that heard another tab's sign-out lands on that account's Home, its Market star saved;
 *   6. the delete at a community the web app was pointed at (two nodes, P and X): a Remove and a doorbell in tabs that
 *      heard nothing put nothing of her Home at X back under X, and file nothing of P's under X; both read P afresh.
 *
 * Fails on any sideways scroll, a control under 44 px, an axe violation, a document-policy violation, or a request to
 * any host but this machine.
 *
 * Run: pnpm --filter @beanpool/pwa home-check   (HOME_IDLE_S sets the idle window, 150 by default)
 * Needs Chromium for Playwright once: pnpm --filter @beanpool/pwa exec playwright install --only-shell chromium
 */
/* global URL, URLSearchParams, console, process, setTimeout, document, window, indexedDB, localStorage, axe, Event, getComputedStyle -- Node, and the page's side of evaluate() */
import { defaultHomeLayout } from '@beanpool/core';
import { build } from 'vite';
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';

const PWA_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SERVER_DIR = path.resolve(PWA_DIR, '../server');
process.chdir(PWA_DIR);

const SHOTS_DIR = process.env.HOME_SHOTS || path.join(os.tmpdir(), 'bp-home-shots');
const IDLE_S = Number(process.env.HOME_IDLE_S || 150);
const VIEW = { width: 320, height: 720 };
const TEXT_SCALE = 1.3;
const AXE = fs.readFileSync(createRequire(import.meta.url).resolve('axe-core/axe.min.js'), 'utf8');

class Failure extends Error {}
const failures = [];
function check(ok, what) {
    if (ok) console.log(`  ✓ ${what}`);
    else { failures.push(what); console.error(`  ✗ ${what}`); }
}

/** A real Ed25519 key in the shape the web app keeps it (identity.ts): hex public key, hex PKCS8 private key. */
function memberIdentity(callsign) {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    return {
        publicKey: publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('hex'),
        privateKey: privateKey.export({ type: 'pkcs8', format: 'der' }).toString('hex'),
        callsign,
        createdAt: new Date().toISOString(),
    };
}

/**
 * An account made from 12 words, as the web app derives it (lib/mnemonic.ts, through tsx): the words, to restore it
 * through the welcome page, and its public key, to make it a member of the node first.
 */
async function wordsIdentity(callsign) {
    const { tsImport } = await import('tsx/esm/api');
    const m = await tsImport(path.join(PWA_DIR, 'src/lib/mnemonic.ts'), import.meta.url);
    const words = m.generateMnemonic();
    const { publicKeyHex } = await m.mnemonicToKeypair(words);
    return { publicKey: publicKeyHex, words, callsign };
}

// ---------- the node ----------

async function startNode(root, profile, members) {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), `bp-home-${profile}-data-`));
    const child = spawn(process.execPath, ['--import', 'tsx', '../pwa/e2e/home-node-harness.ts'], {
        cwd: SERVER_DIR,
        env: { ...process.env, BEANPOOL_DATA_DIR: dataDir, FIXTURE_ROOT: root, FIXTURE_PROFILE: profile, FIXTURE_MEMBERS: JSON.stringify(members) },
        stdio: ['pipe', 'pipe', 'pipe'],
    });
    const log = [];
    const waiting = new Map();
    let ready;
    const readyAt = new Promise((resolve, reject) => {
        ready = resolve;
        child.on('exit', (code) => reject(new Error(`the node exited (${code}) before it was ready:\n${log.slice(-30).join('\n')}`)));
    });
    readline.createInterface({ input: child.stdout }).on('line', (line) => {
        if (line.startsWith('FIXTURE_READY ')) ready(JSON.parse(line.slice('FIXTURE_READY '.length)));
        else if (line.startsWith('FIXTURE_ANSWER ')) {
            const a = JSON.parse(line.slice('FIXTURE_ANSWER '.length));
            waiting.get(a.id)?.(a);
            waiting.delete(a.id);
        } else log.push(line);
    });
    readline.createInterface({ input: child.stderr }).on('line', (line) => log.push(line));
    const { port } = await readyAt;
    let n = 0;
    const ask = (req) => new Promise((resolve, reject) => {
        const id = ++n;
        waiting.set(id, (a) => (a.ok ? resolve(a.result) : reject(new Error(`node: ${a.error}`))));
        child.stdin.write(`${JSON.stringify({ id, ...req })}\n`);
    });
    const stop = async () => {
        child.kill('SIGTERM');
        await new Promise((r) => setTimeout(r, 300));
        if (child.exitCode === null) child.kill('SIGKILL');
        fs.rmSync(dataDir, { recursive: true, force: true });
    };
    return { child, port, ask, log, stop, origin: `https://localhost:${port}` };
}

// ---------- the browser ----------

/** Every request and socket frame, with Chromium's own byte counts (CDP Network). */
function recorder(cdp, origin) {
    const byId = new Map();
    const all = [];
    const frames = [];
    const headerBytes = (h) => Object.entries(h || {}).reduce((n, [k, v]) => n + k.length + String(v).length + 4, 0);
    cdp.on('Network.requestWillBeSent', (e) => {
        const u = new URL(e.request.url);
        const r = { id: e.requestId, at: Date.now(), method: e.request.method, url: e.request.url, origin: u.origin, path: u.pathname, search: u.search,
            signed: !!(e.request.headers['X-Public-Key'] || e.request.headers['x-public-key']),
            signer: e.request.headers['X-Public-Key'] || e.request.headers['x-public-key'] || null,
            tag: e.request.headers['If-None-Match'] ?? e.request.headers['if-none-match'] ?? null, up:e.request.method.length + e.request.url.length + 12 + headerBytes(e.request.headers) + (e.request.postData?.length ?? 0), status: null, down: 0, done: false };
        byId.set(e.requestId, r);
        all.push(r);
    });
    cdp.on('Network.requestWillBeSentExtraInfo', (e) => {
        const r = byId.get(e.requestId);
        if (r) r.up = r.method.length + r.url.length + 12 + headerBytes(e.headers);
    });
    cdp.on('Network.responseReceived', (e) => { const r = byId.get(e.requestId); if (r && r.status === null) r.status = e.response.status; });
    // The status on the wire: a revalidated answer is a 304 there, whatever the page is handed.
    cdp.on('Network.responseReceivedExtraInfo', (e) => { const r = byId.get(e.requestId); if (r) r.status = e.statusCode; });
    cdp.on('Network.loadingFinished', (e) => { const r = byId.get(e.requestId); if (r) { r.down = e.encodedDataLength; r.done = true; } });
    cdp.on('Network.loadingFailed', (e) => { const r = byId.get(e.requestId); if (r) { r.failed = e.errorText; r.done = true; } });
    cdp.on('Network.webSocketFrameSent', (e) => frames.push({ at: Date.now(), dir: 'up', bytes: (e.response?.payloadData ?? '').length }));
    cdp.on('Network.webSocketFrameReceived', (e) => frames.push({ at: Date.now(), dir: 'down', bytes: (e.response?.payloadData ?? '').length, data: (e.response?.payloadData ?? '').slice(0, 60) }));
    return {
        mark: () => Date.now(),
        since: (t, from = origin) => all.filter((r) => r.at >= t && r.origin === from),
        framesSince: (t) => frames.filter((f) => f.at >= t),
        others: () => all.filter((r) => r.origin !== origin && !r.url.startsWith('data:')),
    };
}

/** `installDismissed`: the install banner said no to for good (a device setting, kept across sign-out), so nothing covers a tap. */
async function openContext(browser, origin, { identity = null, dark = false, geolocation = null, installDismissed = false } = {}) {
    const context = await browser.newContext({
        viewport: VIEW, ignoreHTTPSErrors: true, reducedMotion: 'reduce',
        ...(geolocation ? { geolocation, permissions: ['geolocation'] } : {}),
    });
    const seen = { violations: [], otherHosts: new Set() };
    await context.exposeBinding('__reportCspViolation', (_s, v) => { seen.violations.push(v); });
    await context.addInitScript(([mode, quiet]) => {
        document.addEventListener('securitypolicyviolation', (e) => {
            window.__reportCspViolation({ directive: e.effectiveDirective, blocked: e.blockedURI, at: `${e.sourceFile}:${e.lineNumber}` });
        });
        try {
            localStorage.setItem('beanpool-theme-mode', mode);
            localStorage.setItem('beanpool-theme-default-light-v1', 'done');
            if (quiet) localStorage.setItem('beanpool-install-dismissed-forever', '1');
        } catch { /* none */ }
    }, [dark ? 'dark' : 'light', installDismissed]);
    await context.route((url) => url.hostname !== 'localhost', (route) => {
        seen.otherHosts.add(new URL(route.request().url()).hostname);
        return route.abort();
    });
    const page = await context.newPage();
    const cdp = await context.newCDPSession(page);
    await cdp.send('Network.enable');
    const net = recorder(cdp, origin);
    if (identity) await putIdentity(page, origin, identity);
    return { context, page, net, seen };
}

/** The key goes where the web app keeps it (identity.ts), from a page of this origin; then the app opens. */
async function putIdentity(page, origin, identity) {
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
}

/**
 * Another tab of the same browser (one context: one localStorage, one IndexedDB), its requests recorded. `deaf`: a tab
 * that hears nothing of another tab's sign-out or clear (no BroadcastChannel, no `storage` event), as a frozen or busy
 * tab may miss them; it can only find out by checking before it reads or writes (lib/account-epoch.ts).
 */
async function openTab(context, origin, { deaf = false } = {}) {
    const page = await context.newPage();
    if (deaf) {
        await page.addInitScript(() => {
            window.BroadcastChannel = undefined;
            const add = window.addEventListener.bind(window);
            window.addEventListener = (type, ...rest) => (type === 'storage' ? undefined : add(type, ...rest));
        });
    }
    const cdp = await context.newCDPSession(page);
    await cdp.send('Network.enable');
    return { page, net: recorder(cdp, origin) };
}

/**
 * The page's next GET /api/home is answered by the node at once (signed, as the page sent it) but handed to the page only
 * on `release()`: a read still out, as on a 2G phone. `fetched` resolves with the node's status once it answered.
 * It is asked without the page's tag, so the node sends her whole answer (a 200, as when something changed), never a
 * 304 that would leave the page nothing to keep.
 */
async function holdNextHomeRead(page) {
    let release;
    const released = new Promise((r) => { release = r; });
    let fetched;
    const answered = new Promise((r) => { fetched = r; });
    let held = false;
    await page.route('**/api/home*', async (route) => {
        if (held || route.request().method() !== 'GET') return route.continue();
        held = true;
        const headers = { ...route.request().headers() };
        delete headers['if-none-match'];
        const response = await route.fetch({ headers });
        // Marked, so a copy of it kept anywhere can be told from a fresh one with the same contents.
        const body = response.status() === 200 ? JSON.stringify({ ...(await response.json()), heldFromBefore: true }) : await response.text();
        fetched(response.status());
        await released;
        await route.fulfill({ response, body }).catch(() => { /* the page went meanwhile */ });
    });
    return { fetched: answered, release: () => release() };
}

/** Home asks again now, as it does once the member's notices are put away (lib/home-cards.ts NOTICES_SEEN_EVENT). */
const ringHome = (page) => page.evaluate(() => window.dispatchEvent(new Event('beanpool:notices-seen')));

/** Every key in Home's store in this browser (lib/home-cache.ts), `[]` when there is none; never makes the database. */
const homeEntries = (page) => page.evaluate(async () => {
    if (!(await indexedDB.databases()).some((d) => d.name === 'beanpool-home')) return [];
    return new Promise((resolve) => {
        const open = indexedDB.open('beanpool-home');
        open.onsuccess = () => {
            const db = open.result;
            if (!db.objectStoreNames.contains('answers')) { db.close(); resolve([]); return; }
            const store = db.transaction('answers').objectStore('answers');
            const keys = store.getAllKeys();
            const values = store.getAll();
            values.onsuccess = () => { db.close(); resolve(keys.result.map((k, i) => ({ key: String(k), etag: values.result[i]?.etag ?? null, text: JSON.stringify(values.result[i]?.answer ?? null) }))); };
            values.onerror = () => { db.close(); resolve([{ key: '(unreadable)' }]); };
        };
        open.onerror = () => resolve([{ key: '(unopenable)' }]);
    });
});

/** Settings → Sign Out (Device Only) → Confirm, in `page`. Returns when it was confirmed, and the reload that follows. */
async function signOutIn(page) {
    await page.getByRole('button', { name: 'Settings' }).first().click();
    await page.getByText('⚠️ Account Deletion & Sign Out').click();
    await page.getByRole('button', { name: 'Sign Out (Device Only)' }).click();
    const reloaded = page.waitForEvent('load', { timeout: 15_000 });
    const at = Date.now();
    await page.getByRole('button', { name: 'Confirm Sign Out' }).click();
    return { at, reloaded };
}

async function scaleText(page) {
    await page.addStyleTag({ content: `html { font-size: ${TEXT_SCALE * 100}% !important; }` });
}

async function land(page, origin) {
    const t = Date.now();
    await page.goto(`${origin}/app`, { waitUntil: 'load' });
    await scaleText(page);
    return t;
}

async function noSideScroll(page, where) {
    const over = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    check(over <= 1, `${where}: no sideways scroll at 320 px with 1.3x text${over > 1 ? ` (it scrolls ${over}px)` : ''}`);
}

/** Every control inside `selector` at least 44 px tall (and 44 wide where it is an icon), as §8 asks of the web. */
async function touchTargets(page, selector, where) {
    const small = await page.evaluate((sel) => {
        const root = document.querySelector(sel);
        if (!root) return ['(nothing there)'];
        return Array.from(root.querySelectorAll('button, a[href], [role="switch"]'))
            .filter((el) => el.getClientRects().length > 0 && !el.closest('.sr-only'))
            .map((el) => ({ el, r: el.getBoundingClientRect() }))
            .filter(({ r }) => r.height < 43.5 || r.width < 43.5)
            .map(({ el, r }) => `${(el.getAttribute('aria-label') || el.textContent || '').trim().slice(0, 40)} ${Math.round(r.width)}×${Math.round(r.height)}`);
    }, selector);
    check(small.length === 0, `${where}: every control at least 44 × 44 px${small.length ? ` (small: ${small.join('; ')})` : ''}`);
}

async function axeClean(page, selector, where) {
    if (!(await page.evaluate(() => typeof window.axe !== 'undefined'))) await page.evaluate(AXE);
    const result = await page.evaluate((sel) => axe.run(document.querySelector(sel), {
        runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'best-practice'] },
        rules: { region: { enabled: false } },
    }).then((r) => r.violations.map((v) => ({ id: v.id, impact: v.impact, nodes: v.nodes.length, sample: v.nodes[0]?.target?.join(' '), summary: v.nodes[0]?.failureSummary?.split('\n').slice(0, 2).join(' ') }))), selector);
    check(result.length === 0, `${where}: axe finds nothing${result.length ? `: ${JSON.stringify(result)}` : ''}`);
}

/**
 * A picture of the whole page: Home scrolls inside <main>, so the window is made tall enough for all of it, then put
 * back. Cut into parts of at most 1,800 px (`name-1.png`, `name-2.png`, …), a size any image viewer takes whole.
 */
const SHOT_PART = 1800;
async function shot(page, name, { window = false } = {}) {
    fs.mkdirSync(SHOTS_DIR, { recursive: true });
    // A dialog sits at the bottom of the window: drawn as the member sees it, at 320 × 720.
    if (window) return page.screenshot({ path: path.join(SHOTS_DIR, `${name}.png`) });
    const tall = await page.evaluate(() => {
        const main = document.querySelector('main');
        return main ? Math.ceil(main.scrollHeight + main.getBoundingClientRect().top + 90) : 0;
    });
    const height = Math.min(Math.max(tall, VIEW.height), 9000);
    if (height > VIEW.height) await page.setViewportSize({ width: VIEW.width, height });
    for (let i = 0, y = 0; y < height; i++, y += SHOT_PART) {
        await page.screenshot({ path: path.join(SHOTS_DIR, `${name}-${i + 1}.png`), clip: { x: 0, y, width: VIEW.width, height: Math.min(SHOT_PART, height - y) } });
    }
    if (height > VIEW.height) await page.setViewportSize(VIEW);
}

/** Every tab's label whole at 320 px with 1.3x text (design §9: "no clipped label on the tabs"). */
async function tabLabelsWhole(page, navTestId, where) {
    const cut = await page.evaluate((id) => Array.from(document.querySelectorAll(`[data-testid="${id}"] button > div > span:last-child`))
        .filter((el) => el.scrollWidth > el.clientWidth + 0.5)
        .map((el) => `${el.textContent} (${el.scrollWidth} > ${el.clientWidth})`), navTestId);
    check(cut.length === 0, `${where}: every tab label whole${cut.length ? ` (cut: ${cut.join(', ')})` : ''}`);
}

const cardIds = (page) => page.evaluate(() => Array.from(document.querySelectorAll('[data-testid="home-page"] [data-testid^="home-card-"]'))
    .map((e) => e.getAttribute('data-testid').replace('home-card-', '')).filter((id) => id !== 'menu'));
const marketRows = (page) => page.evaluate(() => Array.from(document.querySelectorAll('[data-testid="home-card-market"] [data-testid="home-market-item"]'))
    .map((e) => e.getAttribute('aria-label')));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function summarise(reqs) {
    const byPath = {};
    for (const r of reqs) {
        const k = `${r.method} ${r.path}`;
        byPath[k] ??= { n: 0, statuses: [], down: 0, up: 0 };
        byPath[k].n++;
        byPath[k].statuses.push(r.status);
        byPath[k].down += r.down;
        byPath[k].up += r.up;
    }
    return byPath;
}
function printRequests(title, reqs) {
    const s = summarise(reqs);
    console.log(`    ${title}: ${reqs.length} request(s), ${reqs.reduce((n, r) => n + r.down, 0).toLocaleString('en')} B down, ~${reqs.reduce((n, r) => n + r.up, 0).toLocaleString('en')} B up`);
    for (const [k, v] of Object.entries(s)) console.log(`      ${v.n} × ${k}  [${v.statuses.join(',')}]  ${v.down.toLocaleString('en')} B down`);
}

/**
 * The Tips card on a new member's Home (scratch/home/TIPS-DESIGN-fable.md §6 item 6): tip 1, right after First steps;
 * Next by keyboard draws the next tip in the same place, says it on the live line, and keeps focus on the same button;
 * and the tip's text follows the reader's text size (PR #1694 review 4: a fixed 15 px stayed smaller than every line).
 */
async function tipsCardChecks(page, where) {
    const card = page.getByTestId('home-card-tips');
    const caption = async () => (await card.getByRole('heading').first().textContent())?.trim();
    const first = await caption();
    check(/^Tips · 1 of \d+$/.test(first ?? ''), `${where}: the Tips card starts at tip 1 (${first})`);
    const sizes = await page.evaluate(() => {
        const px = (el) => (el ? parseFloat(getComputedStyle(el).fontSize) : 0);
        return { tip: px(document.querySelector('[data-testid="home-tip-text"]')), root: px(document.documentElement) };
    });
    check(sizes.tip >= sizes.root * 0.9375 - 0.1, `${where}: the tip's text grows with the reader's text size (${sizes.tip} px with the page at ${sizes.root} px)`);
    const next = card.getByRole('button', { name: 'Next tip' });
    await next.focus();
    await page.keyboard.press('Enter');
    const second = await caption();
    const tipText = (await card.getByTestId('home-tip-text').textContent())?.trim() ?? '';
    const live = (await page.getByTestId('home-live').textContent())?.trim() ?? '';
    const focusKept = await page.evaluate(() => document.activeElement?.getAttribute('data-testid') === 'home-tips-next');
    check(/^Tips · 2 of \d+$/.test(second ?? '') && live === tipText && tipText.length > 0 && focusKept,
        `${where}: Next by keyboard draws tip 2 in place, says it, and keeps focus on Next (${second}; said: ${live === tipText ? 'the tip' : JSON.stringify(live)}; focus ${focusKept ? 'kept' : 'lost'})`);
}

// ---------- 1 and 2: a member of a local community ----------

async function localMember(browser, root) {
    const ana = memberIdentity('Ana');
    const node = await startNode(root, 'local', [{ publicKey: ana.publicKey, callsign: 'Ana', joinedDaysAgo: 1 }]);
    console.log(`\nA local node on ${node.origin}; Ana, a member since yesterday:`);
    try {
        const { context, page, net, seen } = await openContext(browser, node.origin, { identity: ana });
        const t0 = await land(page, node.origin);
        await page.getByTestId('home-card-community').waitFor({ timeout: 30_000 });
        await wait(6_000); // the socket's first sync, and any re-read it might cause, have their turn
        const landing = net.since(t0);
        const homeReads = landing.filter((r) => r.path === '/api/home');
        check(homeReads.length === 1, `the landing reads Home once (${homeReads.length} × GET /api/home, ${homeReads.map((r) => r.status).join(',')})`);
        check(homeReads.every((r) => r.signed), 'the read is signed by the member');
        printRequests('landing on Home', landing.filter((r) => r.path.startsWith('/api/')));

        // She never edited: the newcomer's list (core's defaultCards), Needs you first and her community's card last.
        const ids = await cardIds(page);
        check(JSON.stringify(ids) === JSON.stringify(['needs', 'steps', 'tips', 'interests', 'market', 'events', 'community']),
            `the newcomer's cards, top down: ${ids.join(' · ')}`);
        await tipsCardChecks(page, 'a member\'s Home');
        const needs = await page.getByTestId('home-card-needs').innerText();
        check(/Unread message from Kofi/.test(needs) && /Vote closes (tonight|today|tomorrow).*compost bay/i.test(needs), `Needs you says what waits, in words (${needs.replace(/\s+/g, ' ').slice(0, 120)})`);
        await noSideScroll(page, 'a member\'s Home');
        await tabLabelsWhole(page, 'mobile-bottom-nav', 'the seven tabs');
        await touchTargets(page, '[data-testid="home-page"]', 'a member\'s Home');
        await axeClean(page, '[data-testid="home-page"]', 'a member\'s Home (light)');
        await shot(page, '1-member-home');

        // Interests: the Market card reorders in place, the same second; saved on the account.
        const before = await marketRows(page);
        const saved = page.waitForRequest((r) => r.url().endsWith('/api/members/preferences') && r.method() === 'POST' && /"interests":\["food"\]/.test(r.postData() || ''));
        await page.getByTestId('home-interest-food').click();
        const after = await marketRows(page);
        check(/Sourdough/.test(after[0] ?? '') && after.length === before.length, `a tap on Food puts the food listing first, nothing dropped (${after[0]})`);
        await saved;
        check(true, 'the interests are saved on the account (POST /api/members/preferences)');

        // Add a card, by keyboard (CARD-FRAME §1.2, §5.2 item 17): the picker is a real dialog; Your Beans goes first,
        // under Needs you; it is said, focus goes to its "…", and Home is read again at once with it in cards=.
        const layoutPost = () => page.waitForResponse((r) => r.url().endsWith('/api/members/preferences') && r.request().method() === 'POST' && /home\.layout/.test(r.request().postData() || ''));
        const addOpen = page.getByTestId('home-add-open');
        await addOpen.scrollIntoViewIfNeeded();
        await addOpen.focus();
        await page.keyboard.press('Enter');
        const picker = page.getByRole('dialog', { name: 'Add a card' });
        await picker.waitFor();
        check(await page.evaluate(() => !!document.activeElement?.closest('[data-testid="home-add-dialog"]')), 'Add a card opens a dialog with focus inside it');
        await noSideScroll(page, 'Add a card');
        await touchTargets(page, '[data-testid="home-add-dialog"]', 'Add a card');
        await axeClean(page, '[data-testid="home-add-dialog"]', 'Add a card (light)');
        await shot(page, '2-member-add-a-card', { window: true });
        const listed = await picker.locator('[data-testid^="home-add-row-"]').evaluateAll((els) => els.map((e) => e.getAttribute('data-testid').replace('home-add-row-', '')));
        check(['beans', 'pulse', 'decide', 'groups', 'joined', 'search'].every((t) => listed.includes(t)) && !listed.includes('find') && !(await picker.getByText(/locked/i).count()),
            `the picker lists this node's cards, none locked (${listed.join(' · ')})`);
        check(!!(await picker.getByTestId('home-add-on-market').count()), 'a card already on Home says "On Home", with no Add');
        // A saved search's settings sheet (Add → its words → Add to Home), axe clean; Escape goes back to the picker.
        await picker.getByTestId('home-add-search').click();
        const sheet = page.getByRole('dialog', { name: 'A saved search' });
        await sheet.waitFor();
        await noSideScroll(page, 'a saved search\'s settings');
        await touchTargets(page, '[data-testid="home-settings-dialog"]', 'a saved search\'s settings');
        await axeClean(page, '[data-testid="home-settings-dialog"]', 'a saved search\'s settings (light)');
        await shot(page, '2-member-search-settings', { window: true });
        await page.keyboard.press('Escape');
        await picker.waitFor();
        const addBeans = picker.getByRole('button', { name: 'Add Your Beans to Home' });
        await addBeans.focus();
        const addAt = net.mark();
        const added = layoutPost();
        await page.keyboard.press('Enter');
        await added;
        await picker.waitFor({ state: 'detached' });
        await page.getByTestId('home-card-beans').waitFor({ timeout: 8_000 }).catch(() => {});
        await wait(1_000);
        const afterAdd = await cardIds(page);
        check(afterAdd[0] === 'needs' && afterAdd[1] === 'beans', `Your Beans goes first, under Needs you (${afterAdd.join(' · ')})`);
        const addReads = net.since(addAt).filter((r) => r.path === '/api/home');
        check(addReads.length === 1 && !!new URLSearchParams(addReads[0].search).get('cards')?.split(',').includes('beans'),
            `and Home is read again at once, with it in cards= (${addReads.map((r) => `${r.status} ${Math.round((r.at - addAt) / 100) / 10} s`).join(', ') || 'no read'})`);
        check(/0 Beans · nothing to repay/.test(await page.getByTestId('home-card-beans').innerText()), 'Your Beans: her own, nothing to repay, how credit opens');
        check(await page.evaluate(() => document.activeElement?.closest('[data-testid="home-card-beans"]') && document.activeElement.getAttribute('aria-label') === 'Card options for Your Beans'),
            'focus goes to the new card\'s "…"');
        check((await page.getByTestId('home-live').innerText()).trim() === 'Your Beans added to Home', 'and the page says, politely, that it was added');
        await noSideScroll(page, 'a member\'s Home with Your Beans');
        await shot(page, '2-member-home-beans-added');

        // Kept on the account: another browser of hers draws it in the same place.
        const fresh = await openContext(browser, node.origin, { identity: ana });
        await land(fresh.page, node.origin);
        await fresh.page.getByTestId('home-card-community').waitFor({ timeout: 30_000 });
        check((await cardIds(fresh.page))[1] === 'beans', 'another browser of hers: Your Beans first there too (the layout is on her account)');
        check(!(await fresh.page.getByTestId('home-card-interests').count()), 'and her interests are set there, so the chips are not asked again');
        const freshRows = await marketRows(fresh.page);
        check(/Sourdough/.test(freshRows[0] ?? ''), 'and the node orders the Market card by them (food first)');
        await fresh.context.close();

        // Leave and come back (a reload): Your Beans still first, read with it in cards=.
        const tr = net.mark();
        await page.reload({ waitUntil: 'load' });
        await scaleText(page);
        await page.getByTestId('home-card-community').waitFor({ timeout: 30_000 });
        await wait(1_000);
        const back = net.since(tr).filter((r) => r.path === '/api/home');
        check(back.length === 1 && !!new URLSearchParams(back[0].search).get('cards')?.split(',').includes('beans') && (await cardIds(page))[1] === 'beans',
            `coming back, Your Beans is still first, read in one request with it in cards= (${back.map((r) => new URLSearchParams(r.search).get('cards')).join('; ') || 'no read'})`);

        // "…" Remove: the card goes with one save and no read; focus goes to the nearest card left, never <body>.
        const removeAt = net.mark();
        const removed = layoutPost();
        await page.getByTestId('home-card-events').getByRole('button', { name: 'Card options for Coming up' }).click();
        await shot(page, '2-member-card-menu', { window: true });
        check(!(await page.getByTestId('home-card-events').getByRole('button', { name: 'Hide' }).count()), 'the "…" has no Hide: Remove');
        await page.getByTestId('home-card-events').getByRole('button', { name: 'Remove Coming up from Home' }).click();
        await removed;
        await wait(1_000);
        check(!(await page.getByTestId('home-card-events').count()), 'Remove takes Coming up away');
        const removeReads = net.since(removeAt).filter((r) => r.path === '/api/home');
        check(removeReads.length === 0, `with one save and no read (${removeReads.length} × GET /api/home)`);
        const focusAfter = await page.evaluate(() => {
            const el = document.activeElement;
            return el === document.body || !el ? 'BODY' : `${el.closest('section[data-testid^="home-card-"]')?.getAttribute('data-testid')} ${el.getAttribute('data-testid')}`;
        });
        check(focusAfter === 'home-card-community home-edit-open', `focus goes to the nearest card left (the community card's Edit home), never <body> (${focusAfter})`);
        check((await page.getByTestId('home-live').innerText()).trim() === 'Coming up removed. Add a card brings it back.', 'and the page says, politely, where the card went');

        // Edit home: a real dialog, the cards on Home in her order, no switches and no Hidden list.
        const edit = page.getByTestId('home-edit-open');
        await edit.scrollIntoViewIfNeeded();
        await edit.focus();
        await page.keyboard.press('Enter');
        const dialog = page.getByRole('dialog', { name: 'Edit home' });
        await dialog.waitFor();
        await noSideScroll(page, 'Edit home');
        const covered = await page.evaluate(() => {
            const r = document.querySelector('[role="dialog"]').getBoundingClientRect();
            const bottom = Math.min(r.bottom, window.innerHeight) - 2;
            const points = [];
            for (let y = r.top + 8; y < bottom; y += 40) for (const x of [r.left + 12, r.left + r.width / 2, r.right - 12]) points.push([x, y]);
            return points.filter(([x, y]) => !document.elementFromPoint(x, y)?.closest('[role="dialog"]')).length;
        });
        check(covered === 0, `nothing is drawn over Edit home (the install banner included)${covered ? ` (${covered} points covered)` : ''}`);
        await touchTargets(page, '[data-testid="home-edit-dialog"]', 'Edit home');
        await axeClean(page, '[data-testid="home-edit-dialog"]', 'Edit home (light)');
        await shot(page, '3-member-edit-home', { window: true });
        const editRows = () => dialog.locator('[data-testid^="home-edit-row-"]').evaluateAll((els) => els.map((e) => e.getAttribute('data-testid').replace('home-edit-row-', '')));
        const rows = await editRows();
        check(rows[0] === 'beans' && !rows.includes('events') && !rows.includes('needs') && !rows.includes('community')
            && !(await dialog.getByRole('switch').count()) && !(await dialog.getByText(/^Hidden$/).count()),
            `Edit home lists the cards on Home in her order, Your Beans first, no switches, no Hidden list (${rows.join(' · ')})`);
        for (let i = 0; i < 40; i++) await page.keyboard.press('Tab');
        check(await page.evaluate(() => !!document.activeElement?.closest('[role="dialog"]')), 'Tab keeps focus inside the dialog');
        // Reset to defaults: the newcomer's list again (core's defaultCards), saved, and Home read again with it.
        const resetAt = net.mark();
        const reset = layoutPost();
        await dialog.getByTestId('home-edit-reset').click();
        await reset;
        await wait(1_500);
        const newcomer = defaultHomeLayout().cards.map((c) => c.id);
        const resetRows = await editRows();
        check(JSON.stringify(resetRows) === JSON.stringify(newcomer.filter((id) => resetRows.includes(id))) && resetRows.length >= newcomer.length - 2
            && ['steps', 'tips', 'market', 'events'].every((id) => resetRows.includes(id)) && !resetRows.includes('beans'),
            `Reset to defaults: the newcomer's list (${resetRows.join(' · ')}; core: ${newcomer.join(' · ')})`);
        const resetReads = net.since(resetAt).filter((r) => r.path === '/api/home');
        check(resetReads.length === 1, `and Home is read again once (${resetReads.map((r) => `${r.status} cards=${new URLSearchParams(r.search).get('cards')}`).join('; ') || 'no read'})`);
        await page.keyboard.press('Escape');
        await dialog.waitFor({ state: 'detached' });
        check(await page.evaluate(() => document.activeElement?.getAttribute('data-testid') === 'home-edit-open'), 'Escape closes it and gives focus back to Edit home');
        await page.getByTestId('home-card-events').waitFor({ timeout: 8_000 }).catch(() => {});
        const resetIds = await cardIds(page);
        check(JSON.stringify(resetIds.filter((id) => id !== 'interests')) === JSON.stringify(ids.filter((id) => id !== 'interests')),
            `and Home draws the newcomer's cards she landed on (${resetIds.join(' · ')})`);

        // The Market's own reads when it is opened: what a Market landing makes beyond the shell's.
        const tm = net.mark();
        await page.locator('[data-testid="mobile-bottom-nav"] button').filter({ hasText: /Market$/ }).click();
        await page.getByText('Sourdough loaves').first().waitFor({ timeout: 20_000 });
        await wait(4_000);
        printRequests('opening the Market (today\'s landing page) from Home', net.since(tm).filter((r) => r.path.startsWith('/api/')));
        await page.locator('[data-testid="mobile-bottom-nav"] button').filter({ hasText: /Home$/ }).click();
        await page.getByTestId('home-card-community').waitFor();
        await wait(4_000);

        // The idle tab: a doorbell (a new listing) after 20 s, then nothing but what the app does on its own.
        console.log(`    the idle Home tab, ${IDLE_S} s, with one new listing at 20 s:`);
        const ti = net.mark();
        await wait(20_000);
        const rang = Date.now();
        await node.ask({ op: 'post', title: 'Fresh eggs', category: 'food' });
        await page.getByTestId('home-card-market').getByText('Fresh eggs').waitFor({ timeout: 15_000 });
        const reread = net.since(rang).filter((r) => r.path === '/api/home');
        check(reread.length === 1 && reread[0].status === 200 && reread[0].at - rang >= 2_500, `one doorbell, one re-read ${reread[0] ? Math.round((reread[0].at - rang) / 100) / 10 : '?'} s later (${reread.map((r) => r.status).join(',')})`);
        await wait(Math.max(0, IDLE_S * 1000 - (Date.now() - ti)));
        const idle = net.since(ti).filter((r) => r.done);
        const frames = net.framesSince(ti);
        printRequests('requests while idle', idle);
        const down = idle.reduce((n, r) => n + r.down, 0) + frames.filter((f) => f.dir === 'down').reduce((n, f) => n + f.bytes, 0);
        const up = idle.reduce((n, r) => n + r.up, 0) + frames.filter((f) => f.dir === 'up').reduce((n, f) => n + f.bytes, 0);
        console.log(`      socket: ${frames.length} frame(s), ${frames.reduce((n, f) => n + f.bytes, 0).toLocaleString('en')} B of payload (${[...new Set(frames.map((f) => f.data?.slice(0, 24)))].join(' | ')})`);
        console.log(`      total over ${IDLE_S} s: ${down.toLocaleString('en')} B down + ~${up.toLocaleString('en')} B up = ${Math.round((down + up) / IDLE_S)} B/s`);
        const homeIdle = idle.filter((r) => r.path === '/api/home');
        const polls = homeIdle.filter((r) => r.at - rang > 5_000);
        check(polls.every((r) => r.status === 304), `with nothing new after the doorbell, Home's own reads are 304s (${polls.map((r) => `${r.status}, ${r.down} B`).join('; ') || 'none in the window'})`);
        console.log(`      of which Home: ${homeIdle.length} read(s), ${homeIdle.reduce((n, r) => n + r.down + r.up, 0).toLocaleString('en')} B = ${Math.round(homeIdle.reduce((n, r) => n + r.down + r.up, 0) / IDLE_S)} B/s`);

        // The node unreachable: the kept answer, said plainly.
        await page.route('**/api/home*', (r) => r.abort());
        await page.reload({ waitUntil: 'load' });
        await scaleText(page);
        await page.getByTestId('home-offline').waitFor({ timeout: 20_000 });
        check(!!(await page.getByTestId('home-card-market').count()), 'the node not answering: the answer this browser kept is drawn, and the page says so');
        await shot(page, '4-member-home-node-unreachable');
        await page.unroute('**/api/home*');

        // Sign Out (Device Only): nothing of her Home is left in this browser (her Beans, who wrote to her, her groups).
        const homeKept = () => page.evaluate(async () => {
            const names = (await indexedDB.databases()).map((d) => d.name);
            if (!names.includes('beanpool-home')) return 0;
            return new Promise((resolve) => {
                const open = indexedDB.open('beanpool-home');
                open.onsuccess = () => {
                    const db = open.result;
                    if (!db.objectStoreNames.contains('answers')) { db.close(); resolve(0); return; }
                    const count = db.transaction('answers').objectStore('answers').count();
                    count.onsuccess = () => { db.close(); resolve(count.result); };
                    count.onerror = () => { db.close(); resolve(-1); };
                };
                open.onerror = () => resolve(-1);
            });
        });
        check((await homeKept()) > 0, 'before signing out, this browser keeps her Home (the copy drawn offline)');
        await page.getByRole('button', { name: 'Settings' }).first().click();
        await page.getByText('⚠️ Account Deletion & Sign Out').click();
        await page.getByRole('button', { name: 'Sign Out (Device Only)' }).click();
        const reloaded = page.waitForEvent('load', { timeout: 15_000 });
        await page.getByRole('button', { name: 'Confirm Sign Out' }).click();
        await reloaded;
        await wait(1_000);
        const left = await homeKept();
        const keys = await page.evaluate(() => Object.keys(localStorage));
        check(left === 0, `Sign Out (Device Only): no cached Home is left in the browser (${left} kept; localStorage: ${keys.join(', ') || 'empty'})`);

        check(seen.violations.length === 0, `no document-policy violations${seen.violations.length ? `: ${JSON.stringify(seen.violations)}` : ''}`);
        await context.close();

        // Dark: the same Home, axe again.
        const darkCtx = await openContext(browser, node.origin, { identity: ana, dark: true });
        await land(darkCtx.page, node.origin);
        await darkCtx.page.getByTestId('home-card-community').waitFor({ timeout: 30_000 });
        check(await darkCtx.page.getByTestId('home-card-tips').count() === 1, 'the Tips card is on her Home in dark too (the axe check below takes it in)');
        await axeClean(darkCtx.page, '[data-testid="home-page"]', 'a member\'s Home (dark)');
        await darkCtx.page.getByTestId('home-edit-open').click();
        await axeClean(darkCtx.page, '[data-testid="home-edit-dialog"]', 'Edit home (dark)');
        await shot(darkCtx.page, '5-member-edit-home-dark', { window: true });
        // Edit home's ＋ Add a card opens the picker in its place; a saved search's settings from there.
        await darkCtx.page.getByTestId('home-edit-add').click();
        await darkCtx.page.getByTestId('home-add-dialog').waitFor();
        await axeClean(darkCtx.page, '[data-testid="home-add-dialog"]', 'Add a card (dark)');
        await shot(darkCtx.page, '5-member-add-a-card-dark', { window: true });
        await darkCtx.page.getByTestId('home-add-search').click();
        await darkCtx.page.getByTestId('home-settings-dialog').waitFor();
        await axeClean(darkCtx.page, '[data-testid="home-settings-dialog"]', 'a saved search\'s settings (dark)');
        await darkCtx.page.keyboard.press('Escape');
        await darkCtx.page.keyboard.press('Escape');
        await darkCtx.page.getByTestId('home-add-dialog').waitFor({ state: 'detached' });
        await shot(darkCtx.page, '5-member-home-dark');
        await darkCtx.context.close();
    } finally {
        const blocked = node.log.filter((l) => l.startsWith('BLOCKED-'));
        check(blocked.length === 0, `the local node reached nothing outside this machine${blocked.length ? `: ${blocked.join('; ')}` : ''}`);
        await node.stop();
    }
}

// ---------- 5: two tabs of one browser ----------

/**
 * PR #1479's second review: a tab still on Home put the member's Home back on disk after Sign Out in another tab, by a
 * Remove there (1), a read in flight (2), and on global its next unsigned read (3, in globalNode). Every tab here is a page
 * of one browser, sharing its storage. A tab that hears drops her Home at once; a deaf one finds out before it writes.
 */
async function twoTabs(browser, root) {
    const ana = memberIdentity('Ana');
    const bea = memberIdentity('Bea');
    const cal = await wordsIdentity('Cal');
    const node = await startNode(root, 'local', [{ publicKey: ana.publicKey, callsign: 'Ana', joinedDaysAgo: 1 }, { publicKey: bea.publicKey, callsign: 'Bea', joinedDaysAgo: 1 },
        { publicKey: cal.publicKey, callsign: 'Cal', joinedDaysAgo: 1 }]);
    console.log(`\nTwo tabs of one browser, on a local node on ${node.origin}:`);
    const contexts = [];
    /** What this browser keeps of `pk`: Home's entries under its key, and localStorage keys naming it or the favourites. */
    const leftOf = async (page, pk) => {
        const entries = (await homeEntries(page)).filter((e) => e.key.includes(pk)).map((e) => e.key);
        const keys = (await page.evaluate(() => Object.keys(localStorage))).filter((k) => k.includes(pk) || k === 'bp_fav_categories');
        return [...entries, ...keys];
    };
    try {
        // ── A card shown on another device: this browser's next landing draws it at once, and so does an open tab ──
        console.log('  Ana removes the Market card in this browser, adds it again in another, and comes back here:');
        await node.ask({ op: 'resetLimits' });
        const x = await openContext(browser, node.origin, { identity: ana, installDismissed: true });
        contexts.push(x);
        const x2 = await openTab(x.context, node.origin);
        for (const t of [x, x2]) await land(t.page, node.origin);
        for (const t of [x, x2]) await t.page.getByTestId('home-card-market').waitFor({ timeout: 30_000 });
        const layoutPost = (page) => page.waitForResponse((r) => r.url().endsWith('/api/members/preferences') && r.request().method() === 'POST' && /home\.layout/.test(r.request().postData() || ''));
        const marketGone = layoutPost(x.page);
        await x.page.getByTestId('home-card-market').getByTestId('home-card-menu').click();
        await x.page.getByTestId('home-card-market').getByTestId('home-menu-remove').click();
        await marketGone;
        await ringHome(x2.page);
        await x2.page.getByTestId('home-card-market').waitFor({ state: 'detached', timeout: 8_000 });
        const y = await openContext(browser, node.origin, { identity: ana, installDismissed: true });
        contexts.push(y);
        await land(y.page, node.origin);
        await y.page.getByTestId('home-card-community').waitFor({ timeout: 30_000 });
        await y.page.getByTestId('home-add-open').click();
        const shown = layoutPost(y.page);
        await y.page.getByRole('dialog', { name: 'Add a card' }).getByTestId('home-add-market').click();
        await shown;
        await y.context.close();
        const withMarket = (r) => !!new URLSearchParams(r.search).get('cards')?.split(',').includes('market');
        const says = (reads, t) => reads.map((r) => `${r.status}${withMarket(r) ? ' with' : ' without'} market +${((r.at - t) / 1000).toFixed(1)} s`).join('; ') || 'no read';
        // This browser lands again: its kept layout has no Market card, the account's newer one has it.
        const back = x.net.mark();
        await x.page.reload({ waitUntil: 'load' });
        await scaleText(x.page);
        const drawn = await x.page.getByTestId('home-card-market').waitFor({ timeout: 10_000 }).then(() => Date.now() - back, () => null);
        await wait(1_000);
        const reads = x.net.since(back).filter((r) => r.path === '/api/home');
        check(drawn !== null && reads.length === 2 && !withMarket(reads[0]) && withMarket(reads[1]),
            `the next landing draws the Market card added in the other browser at once (${drawn === null ? 'not drawn in 10 s' : `drawn ${(drawn / 1000).toFixed(1)} s in`}; ${says(reads, back)})`);
        // The other tab, still open: its next read brings the account's layout, and it reads again at once.
        const rung = Date.now();
        await ringHome(x2.page);
        const drawn2 = await x2.page.getByTestId('home-card-market').waitFor({ timeout: 8_000 }).then(() => Date.now() - rung, () => null);
        await wait(1_000);
        const reads2 = x2.net.since(rung).filter((r) => r.path === '/api/home');
        check(drawn2 !== null && reads2.length === 2 && withMarket(reads2[1]),
            `and a tab left open draws it on its next read, not two reads later (${drawn2 === null ? 'not drawn' : `drawn ${(drawn2 / 1000).toFixed(1)} s in`}; ${says(reads2, rung)})`);
        await x.context.close();

        // ── Sign Out (Device Only) in one tab, her Home open in four more ──
        console.log('  Ana signs out in one tab, her Home open in four more (one hears it, three hear nothing):');
        // Five tabs of one browser read from one address: the node's limiters start afresh for each part.
        await node.ask({ op: 'resetLimits' });
        const a = await openContext(browser, node.origin, { identity: ana, installDismissed: true });
        contexts.push(a);
        const hears = await openTab(a.context, node.origin);
        const deafRemove = await openTab(a.context, node.origin, { deaf: true });
        const deafRead = await openTab(a.context, node.origin, { deaf: true });
        const deafChip = await openTab(a.context, node.origin, { deaf: true });
        const tabs = [a, hears, deafRemove, deafRead, deafChip];
        for (const t of tabs) await land(t.page, node.origin);
        for (const t of tabs) await t.page.getByText('Unread message from Kofi').waitFor({ timeout: 30_000 });
        await wait(1_500);
        check((await leftOf(a.page, ana.publicKey)).some((k) => k.endsWith(`|${ana.publicKey}`)), 'before: this browser keeps her Home');
        // A read still out in two tabs as she signs out (2): signed, answered by the node, not yet handed to the page.
        const heldHears = await holdNextHomeRead(hears.page);
        const heldDeaf = await holdNextHomeRead(deafRead.page);
        await ringHome(hears.page);
        await ringHome(deafRead.page);
        const heldStatus = await Promise.all([heldHears.fetched, heldDeaf.fetched]);
        check(heldStatus.every((s) => s === 200), `two reads held across the sign-out, each her whole answer (${heldStatus.join(', ')})`);
        const out = await signOutIn(a.page);

        const gone = await hears.page.getByTestId('home-signed-out').waitFor({ timeout: 5_000 }).then(() => Date.now() - out.at, () => null);
        check(gone !== null && !(await hears.page.getByText('Unread message from Kofi').count()) && !(await hears.page.getByRole('button', { name: /^Card options for / }).count()),
            `the tab that hears it drops her Home at once (${gone === null ? 'it stayed' : `${(gone / 1000).toFixed(1)} s after Confirm`}): nothing of hers left to tap`);
        await noSideScroll(hears.page, 'the signed-out notice');
        await touchTargets(hears.page, '[data-testid="home-page"]', 'the signed-out notice');
        await axeClean(hears.page, '[data-testid="home-page"]', 'the signed-out notice');
        await shot(hears.page, '9-signed-out-in-another-tab');

        // (1) A tab that heard nothing still draws her Home: "…" → Remove there (the reviewer's Hide, before the card frame).
        const stillDrawn = !!(await deafRemove.page.getByText('Unread message from Kofi').count());
        await deafRemove.page.getByTestId('home-card-market').getByTestId('home-card-menu').click();
        await deafRemove.page.getByTestId('home-card-market').getByTestId('home-menu-remove').click();
        // And a chip tap in another (her favourites and the unsaved mark, before).
        await deafChip.page.getByTestId('home-interest-food').click();
        const found = await Promise.all([deafRemove, deafChip].map((t) => t.page.getByTestId('home-signed-out').waitFor({ timeout: 3_000 }).then(() => true, () => false)));
        check(stillDrawn && found.every(Boolean), `a tab that heard nothing finds out at its first write, a Remove or a chip tap, and drops her Home there too (${stillDrawn ? 'drawn until then' : 'not drawn'}; ${found.map((f) => (f ? 'dropped' : 'still drawn')).join(', ')})`);
        // Read from a tab that stays (the one she signed out in reloads), once anything the taps wrote has landed.
        await wait(1_500);
        const afterTaps = await leftOf(hears.page, ana.publicKey);
        check(afterTaps.length === 0, `(1) that Remove and that chip tap put nothing of hers back (${afterTaps.join(', ') || 'nothing kept'})`);

        // (2) The two reads held across the sign-out land now.
        const released = Date.now();
        heldHears.release();
        heldDeaf.release();
        const deafReadFound = await deafRead.page.getByTestId('home-signed-out').waitFor({ timeout: 3_000 }).then(() => true, () => false);
        check(deafReadFound && !(await hears.page.getByText('Unread message from Kofi').count()),
            `a read in flight across the sign-out lands, and nothing of it is drawn (${deafReadFound ? 'the deaf tab drops her Home' : 'the deaf tab still draws it'})`);
        await wait(1_500);
        const heldKept = (await homeEntries(hears.page)).filter((e) => e.text.includes('heldFromBefore')).map((e) => e.key);
        check(heldKept.length === 0, `(2) and nothing of those reads is kept (${heldKept.join(', ') || 'nothing kept'})`);

        // Nothing more is read as her, however Home is asked.
        for (const t of [hears, deafRemove, deafRead, deafChip]) {
            await ringHome(t.page);
            await t.page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
        }
        await out.reloaded;
        await wait(4_000);
        const readsAfter = [hears, deafRemove, deafRead, deafChip].flatMap((t) => t.net.since(out.at).filter((r) => r.path === '/api/home'));
        check(readsAfter.length === 0, `no tab reads Home as her after the sign-out (${readsAfter.length} × GET /api/home${readsAfter.length ? `, ${readsAfter.map((r) => (r.signed ? 'signed' : 'unsigned')).join(',')}` : ''})`);
        const left = await leftOf(a.page, ana.publicKey);
        check(left.length === 0, `Sign Out (Device Only) with her Home open in other tabs: nothing of hers is put back, ${((Date.now() - released) / 1000).toFixed(0)} s on (${left.join(', ') || 'nothing kept'})`);
        check(a.seen.violations.length === 0, `no document-policy violations${a.seen.violations.length ? `: ${JSON.stringify(a.seen.violations)}` : ''}`);
        await a.context.close();

        // ── Force Clear & Re-Sync in one tab: the account stays, the copy goes, and another tab reads afresh ──
        console.log('  Ana again, in a fresh browser: Force Clear & Re-Sync in one tab, her Home open in two more:');
        await node.ask({ op: 'resetLimits' });
        const f = await openContext(browser, node.origin, { identity: ana, installDismissed: true });
        contexts.push(f);
        const fHears = await openTab(f.context, node.origin);
        const fDeaf = await openTab(f.context, node.origin, { deaf: true });
        // (PR #1479's third review) A deaf tab whose answers before the clear are marked, and always whole (asked without
        // the tag), so a copy of one kept after the clear can be told from a fresh read.
        const fDeafRemove = await openTab(f.context, node.origin, { deaf: true });
        const markBefore = async (route) => {
            if (route.request().method() !== 'GET') return route.continue();
            const headers = { ...route.request().headers() };
            delete headers['if-none-match'];
            const response = await route.fetch({ headers });
            if (response.status() !== 200) return route.fulfill({ response });
            return route.fulfill({ response, body: JSON.stringify({ ...(await response.json()), readBeforeTheClear: true }) });
        };
        await fDeafRemove.page.route('**/api/home*', markBefore);
        // Its socket quiet too, so no doorbell finds the clear for it before its Remove does.
        await fDeafRemove.page.routeWebSocket(/\/ws/, () => { /* open, and silent */ });
        for (const t of [f, fHears, fDeaf, fDeafRemove]) await land(t.page, node.origin);
        for (const t of [f, fHears, fDeaf, fDeafRemove]) await t.page.getByText('Unread message from Kofi').waitFor({ timeout: 30_000 });
        await wait(1_500);
        const fHeld = await holdNextHomeRead(fDeaf.page);
        await ringHome(fDeaf.page);
        const fHeldStatus = await fHeld.fetched;
        check(fHeldStatus === 200, `a read held across the clear, her whole answer (${fHeldStatus})`);
        f.page.on('dialog', (dlg) => { void dlg.accept(); });
        await f.page.getByRole('button', { name: 'Settings' }).first().click();
        await f.page.getByText('Database Health & Stats').click();
        await node.ask({ op: 'resetLimits' });
        const fReloaded = f.page.waitForEvent('load', { timeout: 15_000 });
        const cleared = Date.now();
        await f.page.getByText('⚡ Force Clear & Re-Sync Database').click();
        await wait(2_500);
        const afresh = fHears.net.since(cleared).filter((r) => r.path === '/api/home');
        check(afresh.length === 1 && afresh[0].tag === null && afresh[0].status === 200,
            `the tab that hears it reads Home afresh at once, with no tag (${afresh.map((r) => `${r.status}, ${r.tag ? 'tagged' : 'no tag'}, +${((r.at - cleared) / 1000).toFixed(1)} s`).join('; ') || 'no read'})`);
        await fReloaded;
        await wait(2_000);
        fHeld.release();
        await wait(3_000);
        const fKept = (await homeEntries(f.page)).filter((e) => e.key.endsWith(`|${ana.publicKey}`));
        check(fKept.length <= 1 && fKept.every((e) => !e.text.includes('heldFromBefore')),
            `a read from before the clear, landing after it, is never kept (${fKept.length} kept${fKept.some((e) => e.text.includes('heldFromBefore')) ? ', the held one among them' : ', each read afresh'})`);
        // (1 of the third review) A deaf tab, still drawing the answer it read before the clear, is tapped: "…" → Remove. It
        // learns of the clear inside that call, and nothing of what it held is kept or sent. Its read afresh is held, so
        // a copy kept by the Remove can't be overwritten before it is looked for.
        await fDeafRemove.page.unroute('**/api/home*', markBefore);
        const stillBefore = !!(await fDeafRemove.page.getByText('Unread message from Kofi').count());
        const fAfresh = await holdNextHomeRead(fDeafRemove.page);
        const tapped = Date.now();
        await fDeafRemove.page.getByTestId('home-card-market').getByTestId('home-card-menu').click();
        await fDeafRemove.page.getByTestId('home-card-market').getByTestId('home-menu-remove').click();
        const fAfreshStatus = await Promise.race([fAfresh.fetched, wait(5_000).then(() => null)]);
        await wait(1_500);
        const putBack = (await homeEntries(f.page)).filter((e) => e.text.includes('readBeforeTheClear')).map((e) => e.key.replace(/^.*\|/, '…|').slice(0, 14));
        const fSaves = fDeafRemove.net.since(tapped).filter((r) => r.path === '/api/members/preferences' && r.method === 'POST');
        check(stillBefore && putBack.length === 0 && fSaves.length === 0,
            `Force Clear, then a Remove in a tab that heard nothing: the answer it read before the clear is not put back, and its layout is not sent (${stillBefore ? 'drawn until the tap' : 'not drawn'}; ${putBack.length ? `put back under ${putBack.join(', ')}` : 'nothing put back'}; ${fSaves.length} layout save(s))`);
        fAfresh.release();
        await fDeafRemove.page.getByTestId('home-card-community').waitFor({ timeout: 8_000 }).catch(() => {});
        await wait(1_500);
        const fAfreshRead = fDeafRemove.net.since(tapped).filter((r) => r.path === '/api/home');
        const fNow = (await homeEntries(f.page)).filter((e) => e.key.endsWith(`|${ana.publicKey}`));
        check(fAfreshStatus === 200 && fAfreshRead.length === 1 && fAfreshRead[0].signed && fNow.every((e) => !e.text.includes('readBeforeTheClear')),
            `and that tab reads her Home afresh, once, signed, and keeps only that (${fAfreshRead.map((r) => `${r.status} ${r.signed ? 'signed' : 'unsigned'}`).join('; ') || 'no read'})`);
        check(f.seen.violations.length === 0, `no document-policy violations${f.seen.violations.length ? `: ${JSON.stringify(f.seen.violations)}` : ''}`);
        await f.context.close();

        // ── Permanently Delete Account at the last community, her Home open in two more tabs ──
        console.log('  Bea deletes her account at the last community in one tab, her Home open in two more:');
        await node.ask({ op: 'resetLimits' });
        const d = await openContext(browser, node.origin, { identity: bea, installDismissed: true });
        contexts.push(d);
        const dHears = await openTab(d.context, node.origin);
        const dDeaf = await openTab(d.context, node.origin, { deaf: true });
        for (const t of [d, dHears, dDeaf]) await land(t.page, node.origin);
        for (const t of [d, dHears, dDeaf]) await t.page.getByTestId('home-card-community').waitFor({ timeout: 30_000 });
        await wait(1_500);
        check((await leftOf(d.page, bea.publicKey)).some((k) => k.endsWith(`|${bea.publicKey}`)), 'before: this browser keeps her Home');
        const dHeld = await holdNextHomeRead(dDeaf.page);
        await ringHome(dDeaf.page);
        const dHeldStatus = await dHeld.fetched;
        check(dHeldStatus === 200, `a read held across the delete, her whole answer (${dHeldStatus})`);
        await d.page.getByRole('button', { name: 'Settings' }).first().click();
        await d.page.getByText('⚠️ Account Deletion & Sign Out').click();
        await d.page.getByRole('button', { name: 'Permanently Delete Account' }).click();
        await d.page.getByLabel(/Type callsign Bea or DELETE/).fill('DELETE');
        await d.page.getByTestId('delete-key-plan').getByText(/Your key (and 12 words )?leaves? this browser/).waitFor({ timeout: 15_000 });
        const dReloaded = d.page.waitForEvent('load', { timeout: 30_000 });
        await node.ask({ op: 'resetLimits' });
        const purged = Date.now();
        await d.page.getByRole('button', { name: /Purge Account/ }).click();
        const dGone = await dHears.page.getByTestId('home-signed-out').waitFor({ timeout: 25_000 }).then(() => Date.now() - purged, () => null);
        check(dGone !== null, `the tab that hears it drops her Home (${dGone === null ? 'it stayed' : `${(dGone / 1000).toFixed(1)} s after Purge, the node's answer included`})`);
        dHeld.release();
        await dDeaf.page.getByTestId('home-signed-out').waitFor({ timeout: 3_000 }).catch(() => {});
        await dReloaded;
        await wait(3_000);
        const dLeft = await leftOf(d.page, bea.publicKey);
        check(dLeft.length === 0, `the delete at the last community with her Home open in other tabs: nothing of hers is put back (${dLeft.join(', ') || 'nothing kept'})`);
        check(d.seen.violations.length === 0, `no document-policy violations${d.seen.violations.length ? `: ${JSON.stringify(d.seen.violations)}` : ''}`);
        await d.context.close();

        // ── A fresh sign-in in a page that heard another tab's sign-out (PR #1479's third review) ──
        console.log('  The welcome page open in one tab; Ana signs in and out in another; then Cal restores with his 12 words in the first:');
        await node.ask({ op: 'resetLimits' });
        const w = await openContext(browser, node.origin, { installDismissed: true });
        contexts.push(w);
        await land(w.page, node.origin);
        await w.page.getByRole('button', { name: 'Restore existing identity' }).waitFor({ timeout: 30_000 });
        const wAna = await openTab(w.context, node.origin);
        await putIdentity(wAna.page, node.origin, ana);
        await land(wAna.page, node.origin);
        await wAna.page.getByText('Unread message from Kofi').waitFor({ timeout: 30_000 });
        const wOut = await signOutIn(wAna.page);
        await wOut.reloaded;
        await wait(1_000);
        await node.ask({ op: 'resetLimits' });
        const restored = Date.now();
        await w.page.getByRole('button', { name: 'Restore existing identity' }).click();
        await w.page.getByRole('button', { name: /Recover with 12 Words/ }).click();
        for (let i = 0; i < 12; i++) await w.page.getByLabel(`Recovery word ${i + 1}`, { exact: true }).fill(cal.words[i]);
        await w.page.getByRole('button', { name: 'Recover Identity' }).click();
        const calHome = await Promise.race([
            w.page.getByTestId('home-card-community').waitFor({ timeout: 30_000 }).then(() => 'his Home'),
            w.page.getByTestId('home-signed-out').waitFor({ timeout: 30_000 }).then(() => '"You signed out of this browser in another tab"'),
        ]).catch(() => 'nothing');
        await wait(1_500);
        const calReads = w.net.since(restored).filter((r) => r.path === '/api/home');
        check(calHome === 'his Home' && calReads.length >= 1 && calReads.every((r) => r.signer === cal.publicKey),
            `a restore in a page that heard Ana's sign-out lands on his Home, read as him (${calHome}; ${calReads.length} × GET /api/home${calReads.length ? `, ${calReads.map((r) => (r.signer === cal.publicKey ? 'his' : r.signer ? 'another key' : 'unsigned')).join(',')}` : ''})`);
        await w.page.locator('[data-testid="mobile-bottom-nav"] button').filter({ hasText: /Market$/ }).click();
        await w.page.getByRole('button', { name: '★ For You' }).click();
        const customizer = w.page.locator('div', { has: w.page.locator('h4', { hasText: 'Customize Interests' }) }).last();
        const starred = Date.now();
        await customizer.getByRole('button', { name: /Tools/ }).click();
        await wait(2_500);
        const starSaves = w.net.since(starred).filter((r) => r.path === '/api/members/preferences' && r.method === 'POST');
        const favs = await w.page.evaluate(() => localStorage.getItem('bp_fav_categories'));
        const onAccount = await node.ask({ op: 'sql', sql: "SELECT pref_value AS v FROM member_preferences WHERE public_key = ? AND pref_key = 'interests'", params: [cal.publicKey], all: true });
        check(starSaves.length === 1 && starSaves[0].signer === cal.publicKey && favs === '["tools"]' && /"tools"/.test(onAccount[0]?.v ?? ''),
            `and his star in the Market is saved on his account and kept as this browser's (${starSaves.length} save(s); favourites ${favs ?? 'none'}; his account: ${onAccount[0]?.v ?? 'no interests'})`);
        check(w.seen.violations.length === 0, `no document-policy violations${w.seen.violations.length ? `: ${JSON.stringify(w.seen.violations)}` : ''}`);
        await w.context.close();
    } finally {
        for (const c of contexts) await c.context.close().catch(() => {});
        const blocked = node.log.filter((l) => l.startsWith('BLOCKED-'));
        check(blocked.length === 0, `the local node reached nothing outside this machine${blocked.length ? `: ${blocked.join('; ')}` : ''}`);
        await node.stop();
    }
}

// ---------- 6: the delete at a community the web app was pointed at ----------

/**
 * PR #1479's third review: the web app on community P's address, pointed at community X (Settings → Sovereign Node
 * Connection), her Home from X open in two tabs that hear nothing. She deletes her account at X in a third: the web app
 * goes back to P, and Home's kept answers go (lib/delete-here.ts leaveThisCommunity). Then a Remove in one deaf tab (2) and
 * a doorbell in the other (3). Neither may put her Home at X back on disk under X, nor file P's answer under X's key;
 * both read her Home at P afresh. Two real nodes on this machine; X lets P's address call it (CORS), as an operator sets.
 */
async function pointedAtAnother(browser, root) {
    const ana = memberIdentity('Ana');
    const p = await startNode(root, 'local', [{ publicKey: ana.publicKey, callsign: 'Ana', joinedDaysAgo: 1 }]);
    const x = await startNode(root, 'local', [{ publicKey: ana.publicKey, callsign: 'Ana', joinedDaysAgo: 1 }]);
    console.log(`\nThe web app on ${p.origin} (P), pointed at ${x.origin} (X); Ana is a member of both:`);
    let ctx = null;
    try {
        await x.ask({ op: 'cors', origins: [p.origin] });
        // Her Home at X can be told from P's by this listing, only there.
        await x.ask({ op: 'post', title: 'Kept only at X', category: 'food' });
        const keyAt = (node) => `${node.origin}|${ana.publicKey}`;
        ctx = await openContext(browser, p.origin, { identity: ana, installDismissed: true });
        await ctx.page.evaluate((url) => localStorage.setItem('bp_node_url', url), x.origin);
        const deafRemove = await openTab(ctx.context, p.origin, { deaf: true });
        const deafBell = await openTab(ctx.context, p.origin, { deaf: true });
        // Their sockets are quiet too (a phone's asleep, a 2G line): no doorbell finds the delete for them first, so the
        // Remove (2) and the read asked here (3) are each the first call to hear of it.
        for (const t of [deafRemove, deafBell]) await t.page.routeWebSocket(/\/ws/, () => { /* open, and silent */ });
        const tabs = [ctx, deafRemove, deafBell];
        for (const t of tabs) await land(t.page, p.origin);
        for (const t of tabs) await t.page.getByText('Kept only at X').first().waitFor({ timeout: 30_000 });
        await wait(1_500);
        const xReads = tabs.flatMap((t) => t.net.since(0, x.origin).filter((r) => r.path === '/api/home' && r.method === 'GET'));
        check(xReads.length >= 3 && xReads.every((r) => r.signed), `her Home is read from X, signed, in each tab (${xReads.length} × GET /api/home at X)`);
        check((await homeEntries(ctx.page)).some((e) => e.key === keyAt(x)), 'before: this browser keeps her Home from X, under X');

        // Settings → Permanently Delete Account, at X: the panel says the key stays, for P.
        await ctx.page.getByRole('button', { name: 'Settings' }).first().click();
        await ctx.page.getByText('⚠️ Account Deletion & Sign Out').click();
        await ctx.page.getByRole('button', { name: 'Permanently Delete Account' }).click();
        await ctx.page.getByLabel(/Type callsign Ana or DELETE/).fill('DELETE');
        await ctx.page.getByTestId('delete-key-plan').getByText(/stays? in this browser/).waitFor({ timeout: 15_000 });
        const reloaded = ctx.page.waitForEvent('load', { timeout: 30_000 });
        await x.ask({ op: 'resetLimits' });
        const purged = Date.now();
        await ctx.page.getByRole('button', { name: /Purge Account/ }).click();
        await reloaded;
        await scaleText(ctx.page);
        await ctx.page.getByTestId('home-card-community').waitFor({ timeout: 30_000 });
        const gone = await x.ask({ op: 'sql', sql: 'SELECT status FROM members WHERE public_key = ?', params: [ana.publicKey], all: true });
        check(gone[0]?.status === 'pruned' && !(await ctx.page.getByText('Kept only at X').count()), `deleted at X (her row there: ${gone[0]?.status ?? 'none'}); the web app is back at P, her Home read there`);
        await wait(1_500);
        const leftAtX = async () => (await homeEntries(ctx.page)).filter((e) => e.key === keyAt(x));
        const describe = (entries) => entries.map((e) => (e.text.includes('Kept only at X') ? 'her Home at X' : "P's answer")).join(', ') || 'nothing';
        check((await leftAtX()).length === 0, `the delete takes her Home at X out of this browser (under X: ${describe(await leftAtX())})`);

        // (2) A deaf tab, still drawing her Home at X: "…" → Remove.
        const stillX = !!(await deafRemove.page.getByText('Kept only at X').count());
        const tapped = Date.now();
        await deafRemove.page.getByTestId('home-card-market').getByTestId('home-card-menu').click();
        await deafRemove.page.getByTestId('home-card-market').getByTestId('home-menu-remove').click();
        await wait(3_000);
        const afterRemove = await leftAtX();
        const removeSaves = [p, x].flatMap((n) => deafRemove.net.since(tapped, n.origin).filter((r) => r.path === '/api/members/preferences' && r.method === 'POST'));
        check(stillX && afterRemove.length === 0 && removeSaves.length === 0,
            `(2) a Remove in a tab that heard nothing puts nothing back under X, and sends X's layout nowhere (${stillX ? 'her Home at X drawn until the tap' : 'not drawn'}; under X: ${describe(afterRemove)}; ${removeSaves.length} layout save(s))`);
        const removeReads = deafRemove.net.since(tapped, p.origin).filter((r) => r.path === '/api/home' && r.method === 'GET');
        const removeDrawsP = await deafRemove.page.getByTestId('home-card-community').waitFor({ timeout: 8_000 }).then(() => true, () => false);
        check(removeDrawsP && !(await deafRemove.page.getByText('Kept only at X').count()) && removeReads.length === 1 && removeReads[0].signed && removeReads[0].tag === null
            && deafRemove.net.since(tapped, x.origin).length === 0,
            `and that tab reads her Home at P afresh, once, signed, and asks X nothing (${removeReads.map((r) => `${r.status} ${r.signed ? 'signed' : 'unsigned'} ${r.tag ? 'tagged' : 'no tag'}`).join('; ') || 'no read at P'}; ${deafRemove.net.since(tapped, x.origin).length} request(s) to X)`);
        // Whatever (2) left, (3) starts from nothing under X.
        await ctx.page.evaluate((k) => new Promise((resolve) => {
            const open = indexedDB.open('beanpool-home');
            open.onsuccess = () => {
                const db = open.result;
                if (!db.objectStoreNames.contains('answers')) { db.close(); resolve(); return; }
                const tx = db.transaction('answers', 'readwrite');
                tx.objectStore('answers').delete(k);
                tx.oncomplete = () => { db.close(); resolve(); };
                tx.onerror = () => { db.close(); resolve(); };
            };
            open.onerror = () => resolve();
        }), keyAt(x));

        // (3) The other deaf tab's next read: Home asked again, as a doorbell does.
        const rung = Date.now();
        await ringHome(deafBell.page);
        const bellDrawsP = await deafBell.page.getByTestId('home-card-community').filter({ hasNotText: 'Kept only at X' }).waitFor({ timeout: 8_000 }).then(() => true, () => false);
        await wait(3_000);
        const afterBell = await leftAtX();
        const atP = (await homeEntries(ctx.page)).filter((e) => e.key === keyAt(p));
        check(afterBell.length === 0 && atP.length === 1 && !atP[0].text.includes('Kept only at X'),
            `(3) a doorbell read in a tab that heard nothing keeps P's answer under P, never under X's key (under X: ${describe(afterBell)}; under P: ${atP.length ? describe(atP) : 'nothing'})`);
        const bellReads = deafBell.net.since(rung, p.origin).filter((r) => r.path === '/api/home' && r.method === 'GET');
        check(bellDrawsP && !(await deafBell.page.getByText('Kept only at X').count()) && bellReads.length === 1 && bellReads[0].tag === null && deafBell.net.since(rung, x.origin).length === 0,
            `and that tab draws her Home at P from one read afresh (${bellReads.map((r) => `${r.status} ${r.tag ? 'tagged' : 'no tag'}`).join('; ') || 'no read at P'}; ${deafBell.net.since(rung, x.origin).length} request(s) to X)`);
        await shot(deafBell.page, '10-after-delete-at-pointed-at-community');
        console.log(`    (${((Date.now() - purged) / 1000).toFixed(0)} s from Purge to the last check)`);
    } finally {
        await ctx?.context.close().catch(() => {});
        for (const n of [p, x]) {
            const blocked = n.log.filter((l) => l.startsWith('BLOCKED-'));
            check(blocked.length === 0, `node ${n === p ? 'P' : 'X'} reached nothing outside this machine${blocked.length ? `: ${blocked.join('; ')}` : ''}`);
            await n.stop();
        }
    }
}

// ---------- 3 and 4: the global node ----------

async function globalNode(browser, root) {
    const rua = memberIdentity('Rua');
    const node = await startNode(root, 'global', [{ publicKey: rua.publicKey, callsign: 'Rua', joinedDaysAgo: 1 }]);
    console.log(`\nA global node on ${node.origin}:`);
    try {
        // A visitor in the lobby.
        console.log('  a visitor, no key:');
        const { context, page, net, seen } = await openContext(browser, node.origin, { geolocation: { latitude: -28.6012, longitude: 153.5987 } });
        const t0 = await land(page, node.origin);
        await page.getByTestId('home-card-community').waitFor({ timeout: 30_000 });
        await wait(6_000);
        const landing = net.since(t0).filter((r) => r.path.startsWith('/api/'));
        printRequests('landing in the lobby', landing);
        check(landing.every((r) => !r.signed), 'every read unsigned: a visitor has no key');
        check(landing.filter((r) => r.path === '/api/home').length === 1, 'one GET /api/home');
        const tabs = await page.locator('[data-testid="lobby-bottom-nav"] button').allInnerTexts();
        check(JSON.stringify(tabs.map((t) => t.replace(/\s+/g, ''))) === JSON.stringify(['🏠Home', '🤝Market', '🗺️Map']), `three lobby tabs, Home first (${tabs.join(' · ').replace(/\n/g, '')})`);
        const first = await page.evaluate(() => document.querySelector('[data-testid="home-page"] section')?.getAttribute('data-testid'));
        check(first === 'lobby-join-card', 'the Join card first');
        const ids = await cardIds(page);
        check(JSON.stringify(ids) === JSON.stringify(['find', 'events', 'market', 'community']), `the visitors' cards: ${ids.join(' · ')}`);
        const market = await page.getByTestId('home-card-market').innerText();
        check(/What people post/i.test(market) && /Free, a swap, or ask/.test(market) && !/Beans/.test(market), 'What people post: the terms with no Beans');
        check(/Place shown after you join/.test(await page.getByTestId('home-card-events').innerText()), 'an event\'s place held back until joining');
        check(!(await page.getByTestId('home-card-menu').count()) && !(await page.getByTestId('home-edit-open').count()) && !(await page.getByTestId('home-add-open').count()),
            'nothing to tailor (no "…", no Add a card, no Edit home), nothing of a member\'s');
        await noSideScroll(page, 'the visitors\' Home');
        await tabLabelsWhole(page, 'lobby-bottom-nav', 'the lobby\'s three tabs');
        await touchTargets(page, '[data-testid="home-page"]', 'the visitors\' Home');
        await axeClean(page, '[data-testid="home-page"]', 'the visitors\' Home');
        await shot(page, '6-visitor-home');

        const ts = net.mark();
        await page.getByTestId('home-share-area').click();
        await page.getByTestId('home-card-find').getByText(/Byron Shire BeanPool/).first().waitFor({ timeout: 15_000 });
        const asked = net.since(ts).filter((r) => r.path === '/api/home');
        const q = new URLSearchParams(asked[0]?.search ?? '');
        check(asked.length === 1 && q.get('lat') === '-28.6' && q.get('lng') === '153.6', `"Share my area" reads Home again from a rough point (${asked[0]?.search})`);
        const findText = (await page.getByTestId('home-card-find').innerText()).replace(/\s+/g, ' ');
        check(/listings? within \d+ km/.test(findText), `and the find card counts the listings near it (${findText})`);
        await shot(page, '7-visitor-home-near');
        await page.locator('[data-testid="lobby-bottom-nav"] button').filter({ hasText: /Market$/ }).click();
        await page.getByTestId('visitor-list').waitFor({ timeout: 15_000 });
        check(true, 'the lobby\'s Market, one tap away');
        check(seen.violations.length === 0, `no document-policy violations${seen.violations.length ? `: ${JSON.stringify(seen.violations)}` : ''}`);
        await context.close();

        // A new member of the global node.
        console.log('  Rua, a member since yesterday:');
        const m = await openContext(browser, node.origin, { identity: rua });
        await land(m.page, node.origin);
        await m.page.getByTestId('home-card-community').waitFor({ timeout: 30_000 });
        const mids = await cardIds(m.page);
        check(mids[0] === 'find' && !mids.some((id) => ['beans', 'deals', 'invite', 'decide'].includes(id)), `Find your community first, no money cards (${mids.join(' · ')})`);
        check(!(await m.page.getByTestId('home-card-find').getByTestId('home-card-menu').count()), 'Find your community is pinned in the first 30 days (no "…")');
        check(JSON.stringify(mids.slice(0, 3)) === JSON.stringify(['find', 'steps', 'tips']), `the Tips card after First steps (${mids.slice(0, 3).join(' · ')})`);
        const globalCaption = (await m.page.getByTestId('home-card-tips').getByRole('heading').first().textContent())?.trim();
        check(globalCaption === 'Tips · 1 of 11', `the worldwide community's own list: tip 1 of 11 (${globalCaption})`);
        const joined = m.page.getByTestId('home-card-joined');
        if (await joined.count()) check(!/Kofi|Mere/.test(await joined.innerText()), `Who joined is a count, no names (${(await joined.innerText()).replace(/\s+/g, ' ')})`);
        const steps = await m.page.getByTestId('home-card-steps').innerText();
        check(/Post something free or for swap/.test(steps) && /For your first \d+ days?: \d+ posts? and \d+ new chats? a day\./.test(steps), `First steps: the global lines and the limits said first (${steps.replace(/\s+/g, ' ').slice(0, 140)})`);
        // The picker lists only what the worldwide community shows: no money cards, never one shown as locked, and not the pinned Find.
        await m.page.getByTestId('home-add-open').click();
        await m.page.getByTestId('home-add-dialog').waitFor();
        const offered = await m.page.locator('[data-testid^="home-add-row-"]').evaluateAll((els) => els.map((e) => e.getAttribute('data-testid').replace('home-add-row-', '')));
        check(offered.length > 0 && !offered.some((id) => ['beans', 'deals', 'enterprise', 'decide', 'invite', 'find'].includes(id)) && !(await m.page.getByTestId('home-add-dialog').getByText(/locked/i).count()),
            `Add a card on global: no money cards, nothing locked, Find (pinned) not offered (${offered.join(' · ')})`);
        await axeClean(m.page, '[data-testid="home-add-dialog"]', 'Add a card on global');
        await m.page.keyboard.press('Escape');
        await m.page.getByTestId('home-add-dialog').waitFor({ state: 'detached' });
        await noSideScroll(m.page, 'a global member\'s Home');
        await touchTargets(m.page, '[data-testid="home-page"]', 'a global member\'s Home');
        await axeClean(m.page, '[data-testid="home-page"]', 'a global member\'s Home');
        await shot(m.page, '8-global-member-home');
        await m.context.close();

        // Two tabs (5, path 3): after Sign Out in one, another tab's next read went out unsigned, and the visitors' answer
        // was kept under her key, with her layout. No tap needed: a doorbell or coming back to the tab did it.
        console.log('  Rua signs out in one tab, her Home open in two more (one hears it, one hears nothing):');
        await node.ask({ op: 'resetLimits' });
        const g = await openContext(browser, node.origin, { identity: rua, installDismissed: true });
        try {
            const gHears = await openTab(g.context, node.origin);
            const gDeaf = await openTab(g.context, node.origin, { deaf: true });
            for (const t of [g, gHears, gDeaf]) await land(t.page, node.origin);
            for (const t of [g, gHears, gDeaf]) await t.page.getByTestId('home-card-find').waitFor({ timeout: 30_000 });
            await wait(1_500);
            check((await homeEntries(g.page)).some((e) => e.key.endsWith(`|${rua.publicKey}`)), 'before: this browser keeps her Home');
            const out = await signOutIn(g.page);
            const gone = await gHears.page.getByTestId('home-signed-out').waitFor({ timeout: 5_000 }).then(() => Date.now() - out.at, () => null);
            check(gone !== null, `the tab that hears it drops her Home at once (${gone === null ? 'it stayed' : `${(gone / 1000).toFixed(1)} s after Confirm`})`);
            await out.reloaded;
            for (const t of [gHears, gDeaf]) {
                await ringHome(t.page);
                await t.page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
            }
            await wait(4_000);
            const readsAfter = [gHears, gDeaf].flatMap((t) => t.net.since(out.at).filter((r) => r.path === '/api/home'));
            check(readsAfter.length === 0, `neither tab reads Home again, so no visitors' answer is read in her place (${readsAfter.length} × GET /api/home${readsAfter.length ? `, ${readsAfter.map((r) => `${r.signed ? 'signed' : 'unsigned'} ${r.status}`).join(',')}` : ''})`);
            const kept = (await homeEntries(g.page)).map((e) => e.key);
            check(!kept.some((k) => k.includes(rua.publicKey)), `(3) nothing is kept under her key (kept: ${kept.map((k) => k.replace(/^.*\|/, '…|').slice(0, 14)).join(', ') || 'nothing'})`);
            check(g.seen.violations.length === 0, `no document-policy violations${g.seen.violations.length ? `: ${JSON.stringify(g.seen.violations)}` : ''}`);
        } finally {
            await g.context.close();
        }
    } finally {
        const blocked = node.log.filter((l) => l.startsWith('BLOCKED-'));
        check(blocked.length === 0, `the global node reached nothing outside this machine${blocked.length ? `: ${blocked.join('; ')}` : ''}`);
        await node.stop();
    }
}

async function main() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bp-home-check-'));
    let browser;
    try {
        await build({ root: PWA_DIR, logLevel: 'warn', build: { outDir: path.join(root, 'public'), emptyOutDir: true } });
        browser = await chromium.launch();
        console.log('The web app as built; Chromium at 320 px, 1.3x text, reduced motion.');
        for (const run of [localMember, twoTabs, pointedAtAnother, globalNode]) {
            try {
                await run(browser, root);
            } catch (e) {
                failures.push(e instanceof Failure ? e.message : String(e?.stack || e));
                console.error(`  ✗ ${e instanceof Failure ? e.message : e?.stack || e}`);
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
    console.log('\n⭐️ Home holds in the web app against real nodes at 320 px with 1.3x text.');
}

main().catch((e) => { console.error('❌', e); process.exit(1); });
