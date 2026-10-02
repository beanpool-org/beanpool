/**
 * The web Home (slice H3 of scratch/global-node/DESIGN-home-dashboard-fable.md) in headless Chromium at 320 px with 1.3x
 * text, against REAL nodes on this machine (e2e/home-node-harness.ts: the server's own GET /api/home, preferences route,
 * signature middleware and socket). The web app is built exactly as it ships and served by that node.
 *
 *   1. a member of a local community lands on Home: one GET /api/home, the cards the node says, no sideways scroll, every
 *      control at least 44 px tall, axe clean (light and dark); a tap on an interest reorders the Market card in place
 *      and saves on the account; "…" Hide gives focus to the next card and survives a reload (the account's layout);
 *      Edit home is a real dialog (axe clean, Escape gives focus back), and its Show brings a card hidden on an earlier
 *      visit back at once; with the node unreachable the kept answer is drawn and the page says so; Sign Out (Device
 *      Only) leaves no cached Home in the browser;
 *   2. the cost (§5.4): the landing's requests against what the Market reads when it is opened, and an idle Home tab's
 *      traffic over a window with one doorbell (a new listing) in it, by Chromium's own byte counts;
 *   3. a visitor in the global lobby: Home first, the Join card, then the public cards from one unsigned read, axe clean;
 *      "Share my area" reads Home again from a rough point; the Market one tap away;
 *   4. a new member of the global node: Find your community first and pinned, no money cards, who joined as a count;
 *   5. two tabs of one browser (PR #1479's second review): a card shown in another browser is drawn at this one's next
 *      landing, and in a tab left open at its next read, with one more read at once. With her Home open in other tabs,
 *      Sign Out (Device Only), the delete at the last community and Force Clear & Re-Sync in one: a tab that hears it
 *      drops her Home at once (axe clean); one that hears nothing finds out at its first write. Nothing of hers is put
 *      back on disk by a Hide (1), a read in flight (2), or, on global, the next read, which would have gone out
 *      unsigned (3); after Force Clear a read from before it is never kept, and the other tab reads afresh with no tag.
 *
 * Fails on any sideways scroll, a control under 44 px, an axe violation, a document-policy violation, or a request to
 * any host but this machine.
 *
 * Run: pnpm --filter @beanpool/pwa home-check   (HOME_IDLE_S sets the idle window, 150 by default)
 * Needs Chromium for Playwright once: pnpm --filter @beanpool/pwa exec playwright install --only-shell chromium
 */
/* global Buffer, URL, URLSearchParams, console, process, setTimeout, document, window, indexedDB, localStorage, axe, Event -- Node, and the page's side of evaluate() */
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
        since: (t) => all.filter((r) => r.at >= t && r.origin === origin),
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
    if (identity) {
        // The key goes where the web app keeps it (identity.ts), from a page of this origin; then the app opens.
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
    return { context, page, net, seen };
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

        const ids = await cardIds(page);
        check(JSON.stringify(ids) === JSON.stringify(['needs', 'steps', 'interests', 'events', 'market', 'decide', 'groups', 'joined', 'pulse', 'beans', 'community']),
            `the cards, top down: ${ids.join(' · ')}`);
        const needs = await page.getByTestId('home-card-needs').innerText();
        check(/Unread message from Kofi/.test(needs) && /Vote closes (tonight|today|tomorrow).*compost bay/i.test(needs), `Needs you says what waits, in words (${needs.replace(/\s+/g, ' ').slice(0, 120)})`);
        check(/0 Beans · nothing to repay/.test(await page.getByTestId('home-card-beans').innerText()), 'Your Beans: her own, nothing to repay, how credit opens');
        check(/Kofi|Mere/.test(await page.getByTestId('home-card-joined').innerText()), 'Who joined: faces and names (a local community)');
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

        // "…" Hide, kept on the account: a reload in a browser with no copy still hides it.
        await page.getByTestId('home-card-pulse').getByRole('button', { name: 'Card options for The Pulse' }).click();
        await shot(page, '2-member-card-menu', { window: true });
        const layoutSaved = page.waitForResponse((r) => r.url().endsWith('/api/members/preferences') && r.request().method() === 'POST' && /home\.layout/.test(r.request().postData() || ''));
        await page.getByTestId('home-card-pulse').getByRole('button', { name: 'Hide' }).click();
        await layoutSaved;
        check(!(await page.getByTestId('home-card-pulse').count()), 'Hide takes the Pulse card away');
        await wait(300);
        const focusAfter = await page.evaluate(() => {
            const el = document.activeElement;
            return el === document.body || !el ? 'BODY' : `${el.closest('section[data-testid^="home-card-"]')?.getAttribute('data-testid')} ${el.getAttribute('aria-label') || el.textContent}`;
        });
        check(focusAfter === 'home-card-beans Card options for Your Beans', `focus goes to the next card's "…", never <body> (${focusAfter})`);
        check(/The Pulse is hidden\. Edit home brings it back\./.test(await page.getByTestId('home-live').innerText()), 'and the page says, politely, where the card went');
        const fresh = await openContext(browser, node.origin, { identity: ana });
        await land(fresh.page, node.origin);
        await fresh.page.getByTestId('home-card-community').waitFor({ timeout: 30_000 });
        check(!(await fresh.page.getByTestId('home-card-pulse').count()), 'another browser of hers: the Pulse stays hidden (the layout is on her account)');
        check(!(await fresh.page.getByTestId('home-card-interests').count()), 'and her interests are set there, so the chips are not asked again');
        const freshRows = await marketRows(fresh.page);
        check(/Sourdough/.test(freshRows[0] ?? ''), 'and the node orders the Market card by them (food first)');
        await fresh.context.close();

        // Leave and come back (a reload): the landing leaves the hidden Pulse out of `cards=`, so the node leaves it out.
        const tr = net.mark();
        await page.reload({ waitUntil: 'load' });
        await scaleText(page);
        await page.getByTestId('home-card-community').waitFor({ timeout: 30_000 });
        await wait(1_000);
        const back = net.since(tr).filter((r) => r.path === '/api/home').at(-1);
        check(!!back && !new URLSearchParams(back.search).get('cards')?.split(',').includes('pulse'), `coming back, Home is read without the hidden Pulse (cards=${new URLSearchParams(back?.search ?? '').get('cards')})`);

        // Edit home: a real dialog.
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
        for (let i = 0; i < 40; i++) await page.keyboard.press('Tab');
        check(await page.evaluate(() => !!document.activeElement?.closest('[role="dialog"]')), 'Tab keeps focus inside the dialog');
        const shownAt = net.mark();
        await dialog.getByRole('switch', { name: 'Show The Pulse' }).click();
        await page.keyboard.press('Escape');
        await dialog.waitFor({ state: 'detached' });
        check(await page.evaluate(() => document.activeElement?.getAttribute('data-testid') === 'home-edit-open'), 'Escape closes it and gives focus back to Edit home');
        // Shown on a visit whose answer was built without it: Home is read again with it, at once (not at the 120 s poll).
        await page.getByTestId('home-card-pulse').waitFor({ timeout: 8_000 }).catch(() => {});
        const showRead = net.since(shownAt).filter((r) => r.path === '/api/home');
        const pulseBack = !!(await page.getByTestId('home-card-pulse').count());
        check(pulseBack && showRead.length === 1 && new URLSearchParams(showRead[0].search).get('cards')?.split(',').includes('pulse'),
            `Show brings the Pulse back at once: one read with it in cards= (${showRead.map((r) => `${r.status} ${Math.round((r.at - shownAt) / 100) / 10} s`).join(', ') || 'no read'}), the card ${pulseBack ? 'drawn' : 'missing'}`);

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
        await axeClean(darkCtx.page, '[data-testid="home-page"]', 'a member\'s Home (dark)');
        await darkCtx.page.getByTestId('home-edit-open').click();
        await axeClean(darkCtx.page, '[data-testid="home-edit-dialog"]', 'Edit home (dark)');
        await shot(darkCtx.page, '5-member-edit-home-dark', { window: true });
        await darkCtx.page.keyboard.press('Escape');
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
 * Hide there (1), a read in flight (2), and on global its next unsigned read (3, in globalNode). Every tab here is a page
 * of one browser, sharing its storage. A tab that hears drops her Home at once; a deaf one finds out before it writes.
 */
async function twoTabs(browser, root) {
    const ana = memberIdentity('Ana');
    const bea = memberIdentity('Bea');
    const node = await startNode(root, 'local', [{ publicKey: ana.publicKey, callsign: 'Ana', joinedDaysAgo: 1 }, { publicKey: bea.publicKey, callsign: 'Bea', joinedDaysAgo: 1 }]);
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
        console.log('  Ana hides the Pulse in this browser, shows it again in another, and comes back here:');
        await node.ask({ op: 'resetLimits' });
        const x = await openContext(browser, node.origin, { identity: ana, installDismissed: true });
        contexts.push(x);
        const x2 = await openTab(x.context, node.origin);
        for (const t of [x, x2]) await land(t.page, node.origin);
        for (const t of [x, x2]) await t.page.getByTestId('home-card-pulse').waitFor({ timeout: 30_000 });
        const layoutPost = (page) => page.waitForResponse((r) => r.url().endsWith('/api/members/preferences') && r.request().method() === 'POST' && /home\.layout/.test(r.request().postData() || ''));
        const hid = layoutPost(x.page);
        await x.page.getByTestId('home-card-pulse').getByRole('button', { name: 'Card options for The Pulse' }).click();
        await x.page.getByTestId('home-card-pulse').getByRole('button', { name: 'Hide' }).click();
        await hid;
        await ringHome(x2.page);
        await x2.page.getByTestId('home-card-pulse').waitFor({ state: 'detached', timeout: 8_000 });
        const y = await openContext(browser, node.origin, { identity: ana, installDismissed: true });
        contexts.push(y);
        await land(y.page, node.origin);
        await y.page.getByTestId('home-card-community').waitFor({ timeout: 30_000 });
        await y.page.getByTestId('home-edit-open').click();
        const shown = layoutPost(y.page);
        await y.page.getByRole('dialog', { name: 'Edit home' }).getByRole('switch', { name: 'Show The Pulse' }).click();
        await shown;
        await y.context.close();
        const withPulse = (r) => !!new URLSearchParams(r.search).get('cards')?.split(',').includes('pulse');
        const says = (reads, t) => reads.map((r) => `${r.status}${withPulse(r) ? ' with' : ' without'} pulse +${((r.at - t) / 1000).toFixed(1)} s`).join('; ') || 'no read';
        // This browser lands again: its kept layout hides the Pulse, the account's newer one shows it.
        const back = x.net.mark();
        await x.page.reload({ waitUntil: 'load' });
        await scaleText(x.page);
        const drawn = await x.page.getByTestId('home-card-pulse').waitFor({ timeout: 10_000 }).then(() => Date.now() - back, () => null);
        await wait(1_000);
        const reads = x.net.since(back).filter((r) => r.path === '/api/home');
        check(drawn !== null && reads.length === 2 && !withPulse(reads[0]) && withPulse(reads[1]),
            `the next landing draws the Pulse shown in the other browser at once (${drawn === null ? 'not drawn in 10 s' : `drawn ${(drawn / 1000).toFixed(1)} s in`}; ${says(reads, back)})`);
        // The other tab, still open: its next read brings the account's layout, and it reads again at once.
        const rung = Date.now();
        await ringHome(x2.page);
        const drawn2 = await x2.page.getByTestId('home-card-pulse').waitFor({ timeout: 8_000 }).then(() => Date.now() - rung, () => null);
        await wait(1_000);
        const reads2 = x2.net.since(rung).filter((r) => r.path === '/api/home');
        check(drawn2 !== null && reads2.length === 2 && withPulse(reads2[1]),
            `and a tab left open draws it on its next read, not two reads later (${drawn2 === null ? 'not drawn' : `drawn ${(drawn2 / 1000).toFixed(1)} s in`}; ${says(reads2, rung)})`);
        await x.context.close();

        // ── Sign Out (Device Only) in one tab, her Home open in four more ──
        console.log('  Ana signs out in one tab, her Home open in four more (one hears it, three hear nothing):');
        // Five tabs of one browser read from one address: the node's limiters start afresh for each part.
        await node.ask({ op: 'resetLimits' });
        const a = await openContext(browser, node.origin, { identity: ana, installDismissed: true });
        contexts.push(a);
        const hears = await openTab(a.context, node.origin);
        const deafHide = await openTab(a.context, node.origin, { deaf: true });
        const deafRead = await openTab(a.context, node.origin, { deaf: true });
        const deafChip = await openTab(a.context, node.origin, { deaf: true });
        const tabs = [a, hears, deafHide, deafRead, deafChip];
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

        // (1) A tab that heard nothing still draws her Home: "…" → Hide there, as the reviewer did.
        const stillDrawn = !!(await deafHide.page.getByText('Unread message from Kofi').count());
        await deafHide.page.getByTestId('home-card-pulse').getByRole('button', { name: 'Card options for The Pulse' }).click();
        await deafHide.page.getByTestId('home-card-pulse').getByRole('button', { name: 'Hide' }).click();
        // And a chip tap in another (her favourites and the unsaved mark, before).
        await deafChip.page.getByTestId('home-interest-food').click();
        const found = await Promise.all([deafHide, deafChip].map((t) => t.page.getByTestId('home-signed-out').waitFor({ timeout: 3_000 }).then(() => true, () => false)));
        check(stillDrawn && found.every(Boolean), `a tab that heard nothing finds out at its first write, a Hide or a chip tap, and drops her Home there too (${stillDrawn ? 'drawn until then' : 'not drawn'}; ${found.map((f) => (f ? 'dropped' : 'still drawn')).join(', ')})`);
        // Read from a tab that stays (the one she signed out in reloads), once anything the taps wrote has landed.
        await wait(1_500);
        const afterTaps = await leftOf(hears.page, ana.publicKey);
        check(afterTaps.length === 0, `(1) that Hide and that chip tap put nothing of hers back (${afterTaps.join(', ') || 'nothing kept'})`);

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
        for (const t of [hears, deafHide, deafRead, deafChip]) {
            await ringHome(t.page);
            await t.page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
        }
        await out.reloaded;
        await wait(4_000);
        const readsAfter = [hears, deafHide, deafRead, deafChip].flatMap((t) => t.net.since(out.at).filter((r) => r.path === '/api/home'));
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
        for (const t of [f, fHears, fDeaf]) await land(t.page, node.origin);
        for (const t of [f, fHears, fDeaf]) await t.page.getByText('Unread message from Kofi').waitFor({ timeout: 30_000 });
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
    } finally {
        for (const c of contexts) await c.context.close().catch(() => {});
        const blocked = node.log.filter((l) => l.startsWith('BLOCKED-'));
        check(blocked.length === 0, `the local node reached nothing outside this machine${blocked.length ? `: ${blocked.join('; ')}` : ''}`);
        await node.stop();
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
        check(!(await page.getByTestId('home-card-menu').count()) && !(await page.getByTestId('home-edit-open').count()), 'nothing to tailor, nothing of a member\'s');
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
        const joined = m.page.getByTestId('home-card-joined');
        if (await joined.count()) check(!/Kofi|Mere/.test(await joined.innerText()), `Who joined is a count, no names (${(await joined.innerText()).replace(/\s+/g, ' ')})`);
        const steps = await m.page.getByTestId('home-card-steps').innerText();
        check(/Post something free or for swap/.test(steps) && /For your first \d+ days?: \d+ posts? and \d+ new chats? a day\./.test(steps), `First steps: the global lines and the limits said first (${steps.replace(/\s+/g, ' ').slice(0, 140)})`);
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
        for (const run of [localMember, twoTabs, globalNode]) {
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
