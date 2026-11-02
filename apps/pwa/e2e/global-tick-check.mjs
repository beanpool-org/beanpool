/**
 * "Also show this on the global community" in a real browser (slice G3), headless Chromium against REAL nodes on this machine
 * (e2e/home-node-harness.ts): a local community that serves the web app as it ships, and the global community on another
 * origin. Chromium's own CORS decides, its own IndexedDB keeps the pairs, and its own network stack sends the requests.
 *
 *   1. CORS. A signed create from the community's page lands on global and its answer is read. The same call from a global-profile
 *      origin to a local community is refused by the browser. An ordinary post to global is refused.
 *   2. The request. What Chromium put on the wire to global is the phone's headers and no others: no cookie, no Referer, no
 *      language, no name. What is stored is the rounded pin, no place, no note, 0 Beans.
 *   3. G1's cases: an unlisted community; an edit follows; a rest and its return; a rest waits for reports' hold; a rest waits for
 *      an unread answer; a lost first answer posts nothing twice; a remove nobody answered is tried again; a moderator's
 *      takedown stands; a new tick after Stop showing lands, on an Offer, an event and an Offer back from a rest; two tabs;
 *      sign-out leaves nothing; a phone and a browser on one account post one copy.
 *   4. The screens at 320 px with 1.3x text, light and dark: the tick, the join door, the row in each state. Shots to
 *      GLOBAL_TICK_SHOTS. Fails on sideways scroll, a tap target under 44 px, a policy violation, or a host but this machine.
 *
 * Run: pnpm --filter @beanpool/pwa global-tick-check
 */
/* global URL, console, process, document, window, setTimeout, indexedDB, localStorage, fetch */
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

const SHOTS = process.env.GLOBAL_TICK_SHOTS || path.join(os.tmpdir(), 'bp-global-tick-shots');
const VIEW = { width: 320, height: 720 };
const TEXT_SCALE = 1.3;
const PIN = { lat: -28.68731, lng: 153.52219 };
const HOST = 'mullum.example.org';
const PHOTO = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/58BAwAI/AL+n1z9zwAAAABJRU5ErkJggg==';

const failures = [];
const started = [];
const WATCHDOG_MS = Number(process.env.GLOBAL_TICK_WATCHDOG_MS) || 240_000;
const watchdog = setTimeout(() => {
    console.error(`The check took past ${WATCHDOG_MS} ms: stopped. So far: ${failures.length} failed.`);
    for (const stop of started) stop();
    process.exit(2);
}, WATCHDOG_MS);
function check(ok, what) {
    if (ok) console.log(`  ✓ ${what}`);
    else { failures.push(what); console.error(`  ✗ ${what}`); }
}

function memberIdentity(callsign) {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    return {
        publicKey: publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('hex'),
        privateKey: privateKey.export({ type: 'pkcs8', format: 'der' }).toString('hex'),
        callsign,
        createdAt: new Date().toISOString(),
    };
}

async function startNode(root, profile, members, env = {}) {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), `bp-tick-${profile}-`));
    const child = spawn(process.execPath, ['--import', 'tsx', '../pwa/e2e/home-node-harness.ts'], {
        cwd: SERVER_DIR,
        env: { ...process.env, BEANPOOL_DATA_DIR: dataDir, FIXTURE_ROOT: root, FIXTURE_PROFILE: profile, FIXTURE_MEMBERS: JSON.stringify(members), ...env },
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
    started.push(() => { try { child.kill('SIGKILL'); } catch { /* gone */ } });
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
    return { port, ask, log, stop, origin: `https://localhost:${port}`, dataDir };
}

let globalUrl = '';

async function openContext(browser, origin, identity, { dark = false } = {}) {
    const context = await browser.newContext({ viewport: VIEW, ignoreHTTPSErrors: true, reducedMotion: 'reduce', geolocation: { latitude: PIN.lat, longitude: PIN.lng }, permissions: ['geolocation'] });
    const seen = { violations: [], otherHosts: new Set() };
    await context.exposeBinding('__reportCspViolation', (_s, v) => { seen.violations.push(v); });
    await context.addInitScript(([mode]) => {
        document.addEventListener('securitypolicyviolation', (e) => window.__reportCspViolation({ directive: e.effectiveDirective, blocked: e.blockedURI }));
        try {
            localStorage.setItem('beanpool-theme-mode', mode);
            localStorage.setItem('beanpool-theme-default-light-v1', 'done');
            localStorage.setItem('beanpool-install-dismissed-forever', '1');
        } catch { /* none */ }
    }, [dark ? 'dark' : 'light']);
    await context.route((url) => url.hostname !== 'localhost' && url.hostname !== '127.0.0.1', (route) => {
        const asked = new URL(route.request().url()).hostname;
        // The map under the composer asks for its tiles, as it always does: refused here all the same.
        if (!asked.endsWith('.tile.openstreetmap.org')) seen.otherHosts.add(asked);
        return route.abort();
    });
    // The community's main address, as a node behind a real name says it: this machine's port is no directory row.
    await context.route(`${origin}/api/community/info`, async (route) => {
        const res = await route.fetch();
        await route.fulfill({ response: res, json: { ...(await res.json()), primaryAddress: HOST, globalCommunityUrl: globalUrl } });
    });
    const page = await context.newPage();
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
    return { context, page, seen };
}

const harness = async (context, origin) => {
    const page = await context.newPage();
    await page.goto(`${origin}/e2e/global-tick-harness.html`, { waitUntil: 'load' });
    await page.waitForFunction(() => document.title === 'tick-ready', undefined, { timeout: 90_000 });
    return page;
};

/** A listing of the member's own, made through the web app's own call. */
const listing = (page, title, extra = {}) => page.evaluate(async ([title, extra, pin, photo]) => {
    const me = await window.tick.loadIdentity();
    const made = await window.tick.api.createMarketplacePost({
        type: 'offer', category: 'food', title, description: `About ${title}`, credits: 20, priceType: 'fixed', authorPublicKey: me.publicKey, repeatable: false, ...pin, photos: [photo], ...extra,
    });
    return made.post;
}, [title, extra, PIN, PHOTO]);

/** A page's work never answering must end the check, not hold it: evaluate has no timeout of its own. */
const inTime = (work, what, ms = 90_000) => {
    let timer;
    return Promise.race([work, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`no answer in time: ${what}`)), ms); })]).finally(() => clearTimeout(timer));
};

const tick = (page, post) => inTime(page.evaluate(async (post) => window.tick.copies.showPostOnGlobal(post, await window.tick.loadIdentity()), post), 'the tick');
const tend = (page) => inTime(page.evaluate(async () => window.tick.copies.tendCopies(await window.tick.loadIdentity())), 'a tend');
const pairs = (page) => page.evaluate(() => window.tick.copyPairs.read());
const pairOf = async (page, id) => (await pairs(page)).find((p) => p.homeId === id);
const row = async (global_, id) => (await global_.ask({ op: 'sql', sql: 'SELECT * FROM posts WHERE id = ?', params: [id], all: true }))[0];
const upOf = async (global_, homeId) => global_.ask({ op: 'sql', sql: "SELECT id, status, title FROM posts WHERE shown_from_post_id = ? AND status != 'cancelled'", params: [homeId], all: true });

async function corsAndRequest(ctx) {
    const { page, global_, local, listed, member } = ctx;
    console.log('1. CORS, 2. what goes on the wire');
    const onWire = [];
    page.on('request', async (r) => {
        if (r.url().startsWith(global_.origin)) onWire.push({ url: r.url(), method: r.method(), headers: await r.allHeaders() });
    });
    const post = await listing(page, 'Tomatoes');
    const line = await tick(page, post);
    check(line === null, `the tick lands, in the browser's own CORS: nothing owed to the member (${line})`);
    const copyId = (await pairOf(page, post.id))?.copyId;
    const stored = await row(global_, copyId);
    check(!!stored && stored.author_pubkey === member.publicKey, 'the copy is on global by the same key');
    check(stored?.shown_from_host === HOST && stored?.shown_from_post_id === post.id, 'global keeps the listed host and the home id');
    check(stored?.lat === -28.7 && stored?.lng === 153.5, `the pin is the rounded one (${stored?.lat}, ${stored?.lng})`);
    check(stored?.credits === 0 && stored?.shown_price === '20 fixed', `no money: 0 Beans, the price in words (${stored?.credits}, ${stored?.shown_price})`);
    const photos = await global_.ask({ op: 'sql', sql: 'SELECT COUNT(*) AS n FROM post_photos WHERE post_id = ?', params: [copyId], all: true });
    check(photos[0].n === 1, 'its photo came from home, inside the create');

    const refusedThere = await page.evaluate(async (other) => {
        try {
            await fetch(`${other}/api/marketplace/posts`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-signature': 'x', 'x-public-key': 'x', 'x-timestamp': '1', 'x-nonce': 'x', 'x-signed-for': 'x' }, body: '{}' });
            return false;
        } catch { return true; }
    }, listed.origin);
    check(refusedThere, 'the same call to another local community is refused by the browser');
    const ordinary = await page.evaluate(async ([global_, body]) => {
        const res = await window.tick.api.signedCopyFetch('POST', global_, '/api/marketplace/posts', { ...body, authorPublicKey: (await window.tick.loadIdentity()).publicKey }, await window.tick.loadIdentity());
        return { status: res.status, body: await res.json() };
    }, [global_.origin, { id: crypto.randomUUID(), type: 'offer', category: 'food', title: 'Plain', credits: 0, ...PIN, photos: [PHOTO] }]);
    check(ordinary.status === 403 && ordinary.body?.code === 'copy_only', `an ordinary post from the community's page is refused (${ordinary.status})`);

    const wire = onWire.filter((r) => r.method === 'POST' && r.url.endsWith('/api/marketplace/posts'))[0];
    check(!!wire, 'the create was seen on the wire');
    const names = Object.keys(wire?.headers ?? {}).filter((h) => !h.startsWith(':'));
    const allowed = new Set(['content-type', 'x-signature', 'x-public-key', 'x-timestamp', 'x-nonce', 'x-signed-for', 'origin', 'accept', 'accept-encoding', 'accept-language', 'user-agent', 'content-length', 'host', 'connection', 'sec-fetch-site', 'sec-fetch-mode', 'sec-fetch-dest', 'sec-ch-ua', 'sec-ch-ua-mobile', 'sec-ch-ua-platform']);
    check(names.every((h) => allowed.has(h)), `only the phone's headers, and what any browser adds itself (${names.filter((h) => !allowed.has(h)).join(' ')})`);
    check(!wire?.headers.cookie && !wire?.headers.referer && !wire?.headers['x-language'], 'no cookie, no Referer, no language header');
    check(wire?.headers['accept-language'] === 'en', `not the browser's own language either (${wire?.headers['accept-language']})`);
    const atHome = await local.ask({ op: 'sql', sql: 'SELECT COUNT(*) AS n FROM posts WHERE id = ?', params: [copyId], all: true });
    check(atHome[0].n === 0, 'home holds nothing of the copy');
    const logged = [...global_.log].join('\n');
    check(!logged.includes(local.origin) && !logged.includes(`localhost:${local.port}`), "global's log says nothing of the origin");
    return post;
}

async function firstCases(ctx) {
    const { page, global_, context } = ctx;
    console.log('3. G1\'s cases');

    // Unlisted.
    await global_.ask({ op: 'directory' });
    const hidden = await listing(page, 'Unlisted plums');
    const noRow = await tick(page, hidden);
    const quiet = await row(global_, (await pairOf(page, hidden.id))?.copyId);
    check(quiet?.shown_from_host === '' && quiet?.shown_from_post_id === null, 'a community the directory does not show: nothing of it is kept');
    check(typeof noRow === 'string' && noRow.includes('directory'), `and the member is told once (${noRow})`);
    await global_.ask({ op: 'directory', url: `https://${HOST}`, name: 'Mullumbimby' });

    // An edit follows.
    const edited = await listing(page, 'Pumpkins');
    await tick(page, edited);
    await page.evaluate(async (post) => {
        const me = await window.tick.loadIdentity();
        await window.tick.api.updateMarketplacePost(post.id, me.publicKey, { title: 'Big pumpkins', category: post.category, description: post.description, credits: 20, priceType: 'fixed', type: 'offer', repeatable: false });
    }, edited);
    await page.waitForTimeout(800);
    check((await row(global_, (await pairOf(page, edited.id))?.copyId))?.title === 'Big pumpkins', 'an edit at home follows at the moment');

    // A rest and its return.
    const rests = await listing(page, 'Eggs');
    await tick(page, rests);
    const before = (await pairOf(page, rests.id)).copyId;
    await page.evaluate(async (id) => window.tick.api.pauseMarketplacePost(id, (await window.tick.loadIdentity()).publicKey), rests.id);
    await page.waitForTimeout(800);
    check((await row(global_, before))?.status === 'cancelled', 'a pause at home takes the copy down');
    check((await pairOf(page, rests.id))?.resting === true, 'and the pair waits');
    await page.evaluate(async (id) => window.tick.api.resumeMarketplacePost(id, (await window.tick.loadIdentity()).publicKey), rests.id);
    await page.waitForTimeout(800);
    await tend(page);
    const back = await pairOf(page, rests.id);
    check(back && !back.resting && back.copyId !== before, 'its return is a new copy under the next id');
    check((await row(global_, back?.copyId))?.status === 'active', 'and it is up');

    // A rest waits for reports' hold.
    const held = await listing(page, 'Honey');
    await tick(page, held);
    const heldId = (await pairOf(page, held.id)).copyId;
    await global_.ask({ op: 'sql', sql: 'UPDATE posts SET hidden_by_reports_at = ? WHERE id = ?', params: [new Date().toISOString(), heldId] });
    await page.evaluate(async (id) => window.tick.api.pauseMarketplacePost(id, (await window.tick.loadIdentity()).publicKey), held.id);
    await page.waitForTimeout(800);
    check((await row(global_, heldId))?.status === 'active', "a rest waits while global's reports hold the copy");
    check((await pairOf(page, held.id))?.resting !== true, 'and the pair stays as it was');

    // A rest waits for an unread answer.
    const unread = await listing(page, 'Limes');
    await tick(page, unread);
    const unreadId = (await pairOf(page, unread.id)).copyId;
    await page.route(`${global_.origin}/api/marketplace/posts?id=*`, (route) => route.abort());
    await page.evaluate(async (id) => window.tick.api.pauseMarketplacePost(id, (await window.tick.loadIdentity()).publicKey), unread.id);
    await page.waitForTimeout(800);
    await page.unroute(`${global_.origin}/api/marketplace/posts?id=*`);
    check((await row(global_, unreadId))?.status === 'active', 'an unread answer: the rest waits, the copy stays');
    await tend(page);
    check((await row(global_, unreadId))?.status === 'cancelled', 'and the next tend finishes it');

    // A lost first answer.
    const lost = await listing(page, 'Lemons');
    const lostRoute = async (route) => { await route.fetch(); await route.abort(); };
    await page.route(`${global_.origin}/api/marketplace/posts`, lostRoute);
    const lostLine = await tick(page, lost);
    await page.unroute(`${global_.origin}/api/marketplace/posts`, lostRoute);
    check(typeof lostLine === 'string', `a lost answer: it says it will go up (${lostLine})`);
    await tend(page);
    check((await upOf(global_, lost.id)).length === 1, 'and the next tend finds it there: one copy');
    check((await pairOf(page, lost.id))?.sent, 'the pair took it up');

    // A retry after an unanswered remove.
    const retried = await listing(page, 'Oranges');
    await tick(page, retried);
    const retriedId = (await pairOf(page, retried.id)).copyId;
    await page.route(`${global_.origin}/api/marketplace/posts/remove`, (route) => route.abort());
    const stopped = await page.evaluate(async (id) => window.tick.copies.stopShowing(id, await window.tick.loadIdentity()), retried.id);
    await page.unroute(`${global_.origin}/api/marketplace/posts/remove`);
    check(stopped === false, 'a Stop showing nobody answered says so');
    check((await row(global_, retriedId))?.status === 'active', 'and the copy is still up');
    await tend(page);
    check((await row(global_, retriedId))?.status === 'cancelled', 'the next tend takes it down');
    check(!(await pairOf(page, retried.id)), 'and the pair goes');

    // A moderator's takedown.
    const moderated = await listing(page, 'Apples');
    await tick(page, moderated);
    const moderatedId = (await pairOf(page, moderated.id)).copyId;
    await global_.ask({ op: 'sql', sql: "UPDATE posts SET status = 'cancelled', hidden_by_reports_at = ? WHERE id = ?", params: [new Date().toISOString(), moderatedId] });
    await page.evaluate(async (id) => window.tick.api.pauseMarketplacePost(id, (await window.tick.loadIdentity()).publicKey), moderated.id);
    await page.waitForTimeout(800);
    await page.evaluate(async (id) => window.tick.api.resumeMarketplacePost(id, (await window.tick.loadIdentity()).publicKey), moderated.id);
    await page.waitForTimeout(800);
    await tend(page);
    check((await upOf(global_, moderated.id)).length === 0, "a moderator's takedown stands: no rest and no return brings it back");

    // A new tick after Stop showing. Global keeps a removed row and reads an Offer's as nothing, so the only word that the id is
    // held is the create's refusal, which has to reach the page: this is the one case a stand-in for global got wrong.
    // Every request here comes from one address, and each step below is several: the allowance is reset as the walk spends it.
    const fresh = () => Promise.all([ctx.local.ask({ op: 'resetLimits' }), global_.ask({ op: 'resetLimits' })]);
    await fresh();
    const stopAndTick = async (post, what) => {
        const before = (await pairOf(page, post.id)).copyId;
        const stop = await page.evaluate(async (id) => window.tick.copies.stopShowing(id, await window.tick.loadIdentity()), post.id);
        check(stop === true && (await row(global_, before))?.status === 'cancelled', `${what}: Stop showing takes it down`);
        check(!(await pairOf(page, post.id)), `${what}: and the pair goes`);
        const again = await tick(page, post);
        const after = await pairOf(page, post.id);
        check(again === null, `${what}: a second tick lands, nothing owed to the member (${again})`);
        check(!!after?.sent && after.copyId !== before, `${what}: under a new id, and the pair took it up`);
        check((await upOf(global_, post.id)).length === 1, `${what}: one copy up`);
    };
    const offerAgain = await listing(page, 'Plums');
    await tick(page, offerAgain);
    await stopAndTick(offerAgain, 'an Offer');
    await stopAndTick(offerAgain, 'an Offer, a second time');
    const startAt = new Date(Date.now() + 7 * 86_400_000).toISOString();
    const endAt = new Date(Date.now() + 7 * 86_400_000 + 3_600_000).toISOString();
    const eventAgain = await listing(page, 'Plum picking', { type: 'event', category: 'community', credits: 0, eventStartAt: startAt, eventEndAt: endAt, eventTz: 'UTC' });
    await tick(page, eventAgain);
    await stopAndTick(eventAgain, 'an event');
    await fresh();
    const restedAgain = await listing(page, 'Damsons');
    await tick(page, restedAgain);
    await page.evaluate(async (id) => window.tick.api.pauseMarketplacePost(id, (await window.tick.loadIdentity()).publicKey), restedAgain.id);
    await page.waitForTimeout(800);
    await page.evaluate(async (id) => window.tick.api.resumeMarketplacePost(id, (await window.tick.loadIdentity()).publicKey), restedAgain.id);
    await page.waitForTimeout(800);
    await tend(page);
    check((await pairOf(page, restedAgain.id))?.generation === 1, 'an Offer back from a rest holds the next id');
    await stopAndTick(restedAgain, 'an Offer after a rest and its return');
    check((await pairOf(page, restedAgain.id))?.generation === 2, 'and the tick went past both ids');
    await fresh();

    // The app's load brings a copy into step, as the phone's coming to the front does: a change made elsewhere.
    const stale = await listing(page, 'Pears');
    await tick(page, stale);
    const staleId = (await pairOf(page, stale.id)).copyId;
    await ctx.local.ask({ op: 'sql', sql: 'UPDATE posts SET title = ? WHERE id = ?', params: ['Ripe pears', stale.id] });
    await page.evaluate(() => localStorage.removeItem('beanpool_copies_tended'));
    await ctx.local.ask({ op: 'resetLimits' });
    await global_.ask({ op: 'resetLimits' });
    const app = await context.newPage();
    await app.goto(`${ctx.local.origin}/app`, { waitUntil: 'load' });
    let caughtUp = false;
    for (let i = 0; i < 40 && !caughtUp; i++) {
        caughtUp = (await row(global_, staleId))?.title === 'Ripe pears';
        if (!caughtUp) await app.waitForTimeout(250);
    }
    check(caughtUp, "opening the app brings a copy into step");
    await app.close();

    // Two tabs share the store, and each change is whole.
    const other = await harness(context, ctx.local.origin);
    const a = await listing(page, 'Quinces');
    const b = await listing(page, 'Figs');
    await Promise.all([tick(page, a), tick(other, b)]);
    const both = await pairs(page);
    check(both.some((p) => p.homeId === a.id) && both.some((p) => p.homeId === b.id), 'two tabs ticking at once: neither loses the other\'s pair');
    const race = (tab, n) => tab.evaluate((n) => Promise.all(Array.from({ length: 10 }, (_, i) => window.tick.copyPairs.change((held) => [...held, { copyId: `race-${n}-${i}`, publicKey: 'nobody', homeId: 'race' }]))), n);
    await Promise.all([race(page, 1), race(other, 2)]);
    const raced = (await pairs(page)).filter((p) => p.copyId.startsWith('race-'));
    check(raced.length === 20, `twenty changes at once from two tabs on real IndexedDB: all kept (${raced.length})`);
    await page.evaluate(() => window.tick.copyPairs.change((held) => held.filter((p) => !p.copyId.startsWith('race-'))));
    await other.close();

    // A phone on the same account: another browser, its store its own, the same key.
    const phone = await openContext(ctx.browser, ctx.local.origin, ctx.member);
    const phonePage = await harness(phone.context, ctx.local.origin);
    await tick(phonePage, a);
    check((await upOf(global_, a.id)).length === 1, 'a second device on one account takes up the copy: one row');
    check((await pairOf(phonePage, a.id))?.copyId === (await pairOf(page, a.id))?.copyId, 'both hold one id');
    await phone.context.close();

    // Sign-out.
    await page.evaluate(() => window.tick.clearAccountStorage());
    check((await pairs(page)).length === 0, 'signing out leaves no pair in this browser');
}

async function screens(ctx, dark) {
    const { browser, local, global_, member, stranger, shop } = ctx;
    const mode = dark ? 'dark' : 'light';
    console.log(`4. the screens, ${mode}`);
    // Every request here comes from one address, and the walk above has spent its minute's allowance.
    const fresh = () => Promise.all([local.ask({ op: 'resetLimits' }), global_.ask({ op: 'resetLimits' })]);
    await fresh();
    const opened = await openContext(browser, local.origin, member, { dark });
    const { page, seen, context } = opened;
    const work = await harness(context, local.origin);
    const post = await listing(work, `Tomatoes ${mode}`);
    await work.close();
    await fresh();
    await page.goto(`${local.origin}/app`, { waitUntil: 'load' });
    await page.addStyleTag({ content: `html { font-size: ${TEXT_SCALE * 100}% !important; }` });
    const tall = async (testid) => {
        const box = await page.getByTestId(testid).boundingBox();
        check(!!box && box.height >= 44, `${testid}: at least 44 px tall (${box?.height})`);
    };
    const noSideways = async (what) => {
        const over = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
        check(over <= 0, `${what}: no sideways scroll (${over})`);
    };
    const shot = async (name) => {
        const file = path.join(SHOTS, `${name}-${mode}.png`);
        await page.screenshot({ path: file });
        shop.push(file);
    };

    await page.goto(`${local.origin}/app?post=${post.id}`, { waitUntil: 'load' });
    const opened1 = await page.getByTestId('show-on-global-host').waitFor({ timeout: 15000 }).then(() => true, () => false);
    check(opened1, 'the row is on the member\'s own listing');
    if (!opened1) await page.screenshot({ path: path.join(SHOTS, `debug-no-row-${mode}.png`) });
    if (opened1) {
        await page.addStyleTag({ content: `html { font-size: ${TEXT_SCALE * 100}% !important; }` });
        await page.getByTestId('show-on-global-host').scrollIntoViewIfNeeded();
        await tall('show-on-global-act');
        await noSideways('the listing, offered');
        await shot('row-offered');
        await page.getByTestId('show-on-global-act').click();
        await page.getByText('Stop showing').waitFor({ timeout: 15000 });
        check((await upOf(global_, post.id)).length === 1, 'a tap on the row puts the copy up');
        await page.getByTestId('show-on-global-host').scrollIntoViewIfNeeded();
        await noSideways('the listing, shown');
        await shot('row-shown');
        await page.getByTestId('show-on-global-act').click();
        await page.getByText('Also show this on the global community').first().waitFor({ timeout: 15000 });
        check((await upOf(global_, post.id)).length === 0, 'Stop showing takes it down');
    }
    // The composer: the same tick, off, on an Offer with a place and on an event.
    await fresh();
    await page.goto(`${local.origin}/app?post=${post.id}`, { waitUntil: 'load' });
    await page.addStyleTag({ content: `html { font-size: ${TEXT_SCALE * 100}% !important; }` });
    await page.getByRole('button', { name: /Back|←/ }).first().click({ timeout: 5000 }).catch(() => {});
    await page.getByRole('button', { name: 'ADD POST' }).last().click({ timeout: 15000 });
    await page.getByTestId('map-new-post-panel').waitFor({ timeout: 15000 });
    const panel = page.getByTestId('map-new-post-panel');
    await panel.getByRole('button', { name: /Offer/ }).first().click();
    await panel.locator('button', { hasText: /location/i }).first().click();
    const listingTick = await page.getByTestId('show-on-global-tick').waitFor({ timeout: 15000 }).then(() => true, () => false);
    check(listingTick, 'the Offer composer has the tick once it has a place');
    if (listingTick) {
        check(!(await page.getByTestId('show-on-global-tick').locator('input').isChecked()), 'off until it is ticked');
        await page.getByTestId('show-on-global-tick').scrollIntoViewIfNeeded();
        await tall('show-on-global-tick');
        await noSideways('the Offer composer');
        await shot('composer-offer');
    }
    await panel.getByRole('button', { name: /^Event$/ }).first().click();
    const eventTick = await page.getByTestId('show-on-global-tick').waitFor({ timeout: 15000 }).then(() => true, () => false);
    check(eventTick, 'the event composer has the tick');
    if (eventTick) {
        await page.getByTestId('show-on-global-tick').scrollIntoViewIfNeeded();
        await noSideways('the event composer');
        await shot('composer-event');
    } else await shot('debug-composer');
    check(seen.violations.length === 0, `no document policy violation (${JSON.stringify(seen.violations.slice(0, 2))})`);
    check(seen.otherHosts.size === 0, `no host but this machine (${[...seen.otherHosts].join(' ')})`);
    await context.close();

    // A stranger to global: the door, from what the tap heard.
    const asStranger = await openContext(browser, local.origin, stranger, { dark });
    const strangerWork = await harness(asStranger.context, local.origin);
    const theirs = await listing(strangerWork, `Beans ${mode}`);
    await strangerWork.close();
    await fresh();
    const p2 = asStranger.page;
    await p2.goto(`${local.origin}/app?post=${theirs.id}`, { waitUntil: 'load' });
    await p2.addStyleTag({ content: `html { font-size: ${TEXT_SCALE * 100}% !important; }` });
    const offered = await p2.getByTestId('show-on-global-act').waitFor({ timeout: 15000 }).then(() => true, () => false);
    if (offered) {
        await p2.getByTestId('show-on-global-act').click();
        const door = await p2.getByTestId('show-on-global-join').waitFor({ timeout: 15000 }).then(() => true, () => false);
        check(door, 'a stranger to global is offered the door at the tap');
        if (door) {
            const a = p2.getByTestId('show-on-global-join').locator('a');
            check((await a.getAttribute('href'))?.startsWith(global_.origin), 'it goes to the global this community names');
            check((await a.getAttribute('rel'))?.includes('noreferrer'), 'and takes no Referer along');
            await p2.getByTestId('show-on-global-join').scrollIntoViewIfNeeded();
            await p2.screenshot({ path: path.join(SHOTS, `row-join-${mode}.png`) });
            shop.push(path.join(SHOTS, `row-join-${mode}.png`));
        }
    }
    await asStranger.context.close();
    await fresh();
}

async function main() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bp-tick-check-'));
    fs.mkdirSync(SHOTS, { recursive: true });
    const nodes = [];
    let browser;
    try {
        await build({
            root: PWA_DIR, logLevel: 'warn',
            build: { outDir: path.join(root, 'public'), emptyOutDir: true, rollupOptions: { input: { index: path.join(PWA_DIR, 'index.html'), tick: path.join(PWA_DIR, 'e2e/global-tick-harness.html') } } },
        });
        const member = memberIdentity('River');
        const stranger = memberIdentity('Sparrow');
        const members = [{ publicKey: member.publicKey, callsign: 'River', joinedDaysAgo: 30, avatar: true }];
        const global_ = await startNode(root, 'global', members);
        nodes.push(global_);
        // Another host, as it always is: a community's address is compared without its port, so two `localhost`s read as one.
        global_.origin = `https://127.0.0.1:${global_.port}`;
        globalUrl = global_.origin;
        const local = await startNode(root, 'local', [...members, { publicKey: stranger.publicKey, callsign: 'Sparrow', joinedDaysAgo: 30, avatar: true }], {});
        nodes.push(local);
        const listed = await startNode(root, 'local', []);
        nodes.push(listed);
        await global_.ask({ op: 'directory', url: `https://${HOST}`, name: 'Mullumbimby' });
        browser = await chromium.launch();
        const { context } = await openContext(browser, local.origin, member);
        const page = await harness(context, local.origin);
        const ctx = { browser, context, page, global_, local, listed, member, stranger, shop: [] };
        if (process.env.GLOBAL_TICK_ONLY !== 'screens') {
            await corsAndRequest(ctx);
            await firstCases(ctx);
        }
        await context.close();
        for (const dark of [false, true]) await screens(ctx, dark);
        console.log(`Shots:\n${ctx.shop.join('\n')}`);
    } finally {
        await browser?.close().catch(() => {});
        for (const n of nodes) await n.stop().catch(() => {});
        fs.rmSync(root, { recursive: true, force: true });
    }
    clearTimeout(watchdog);
    if (failures.length) {
        console.error(`\n${failures.length} failed:\n- ${failures.join('\n- ')}`);
        process.exit(1);
    }
    console.log('\nThe web app\'s tick holds in a real browser.');
}

main().catch((e) => { console.error(e); process.exit(1); });
