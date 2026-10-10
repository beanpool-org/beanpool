/**
 * The web Market and Map on a node that reads by area (DESIGN-global-sync-by-area §5, S5), in headless Chromium at 320 px
 * with 1.3x text, against a REAL global node on this machine (e2e/home-node-harness.ts): the server's own posts route,
 * signature middleware and distance search. The web app is built exactly as it ships and served by that node.
 *
 *   1. a member with an area: the Market's one list read carries lat/lng/radiusKm=250/sort=distance, the node answers
 *      the listing near Byron with its distance and leaves out the one in Oslo; the line says where from; no sideways
 *      scroll; Show everywhere reads the newest (Oslo comes back) and Near your area goes back;
 *   2. the Map: one list read with the same point and limit=200;
 *   3. a local node: the Market's list read has no point, as before.
 * In the List, Compact and Card layouts every distance tag is whole: no box that hides its overflow cuts it off.
 *
 * Fails on any sideways scroll, a control in the line under 44 px, or a request to any host but this machine.
 *
 * Run: node e2e/market-near-check.mjs (in apps/pwa; @beanpool/core, engine and signin built)
 */
/* global URL, console, process, setTimeout, document, indexedDB, localStorage, getComputedStyle -- Node, and the page's side of evaluate() */
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
const VIEW = { width: 320, height: 720 };
const BYRON = { lat: -28.6, lng: 153.6 };

const failures = [];
function check(ok, what) {
    if (ok) console.log(`  ✓ ${what}`);
    else { failures.push(what); console.error(`  ✗ ${what}`); }
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

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
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), `bp-near-${profile}-data-`));
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
        await wait(300);
        if (child.exitCode === null) child.kill('SIGKILL');
        fs.rmSync(dataDir, { recursive: true, force: true });
    };
    return { port, ask, log, stop, origin: `https://localhost:${port}` };
}

async function openMember(browser, origin, identity) {
    const context = await browser.newContext({ viewport: VIEW, ignoreHTTPSErrors: true, reducedMotion: 'reduce' });
    const otherHosts = new Set();
    await context.addInitScript(() => {
        try {
            localStorage.setItem('beanpool-theme-mode', 'light');
            localStorage.setItem('beanpool-theme-default-light-v1', 'done');
            localStorage.setItem('beanpool-install-dismissed-forever', '1');
        } catch { /* none */ }
    });
    await context.route((url) => url.hostname !== 'localhost', (route) => {
        otherHosts.add(new URL(route.request().url()).hostname);
        return route.abort();
    });
    const page = await context.newPage();
    const reads = [];
    page.on('request', (r) => {
        const u = new URL(r.url());
        if (u.pathname === '/api/marketplace/posts' && r.method() === 'GET') reads.push(u.searchParams);
    });
    const answers = [];
    page.on('response', async (r) => {
        const u = new URL(r.url());
        if (u.pathname !== '/api/marketplace/posts' || r.request().method() !== 'GET' || u.searchParams.get('author')) return;
        try { answers.push({ params: u.searchParams, body: await r.json() }); } catch { /* not json */ }
    });
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
    // 1.3x text, as the small-screen floor asks.
    await page.addStyleTag({ content: 'html { font-size: 130% !important; }' });
    return { context, page, reads, answers, otherHosts };
}

// A listing on screen by its title (a card's title is the whole text; the activity strip's "Kofi posted: …" is not).
const shown = (page, text) => page.getByText(text, { exact: true }).locator('visible=true').count();
async function until(test, ms = 20_000) {
    const end = Date.now() + ms;
    while (Date.now() < end) { if (await test()) return; await wait(200); }
}
const listReads = (reads) => reads.filter((p) => !p.get('author') && !p.get('id'));
const sideways = (page) => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
// Each distance tag on a card, and whether a box that hides its overflow cuts it off (the List row did at 320 px / 1.3x:
// "138 km" read "📍 1").
const clippedTags = (page) => page.evaluate(() => [...document.querySelectorAll('[data-testid="card-distance"]')]
    .filter((t) => t.getClientRects().length > 0)
    .map((t) => {
        const r = t.getBoundingClientRect();
        let clip = null;
        for (let a = t.parentElement; a && !clip; a = a.parentElement) {
            if (getComputedStyle(a).overflowX !== 'visible') clip = a.getBoundingClientRect();
        }
        const cut = !!clip && (r.right > clip.right + 0.5 || r.left < clip.left - 0.5);
        return { text: t.textContent.trim(), cut };
    }));
const tab = (page, name) => page.locator('[data-testid="mobile-bottom-nav"] button').filter({ hasText: new RegExp(`${name}$`) });

async function globalMember(browser, root) {
    console.log('A member with an area on the global node:');
    const me = memberIdentity('Ana');
    const node = await startNode(root, 'global', [{ publicKey: me.publicKey, callsign: 'Ana', joinedDaysAgo: 5 }]);
    try {
        await node.ask({ op: 'sql', sql: 'UPDATE members SET area_lat = ?, area_lng = ? WHERE public_key = ?', params: [BYRON.lat, BYRON.lng, me.publicKey] });
        const far = await node.ask({ op: 'post', title: 'Oslo bicycle', category: 'other' });
        await node.ask({ op: 'sql', sql: 'UPDATE posts SET lat = ?, lng = ? WHERE id = ?', params: [59.9, 10.7, far.id] });
        await node.ask({ op: 'post', title: 'Byron honey', category: 'food' });
        const m = await openMember(browser, node.origin, me);
        await tab(m.page, 'Market').click();
        await m.page.getByText('Byron honey').first().waitFor({ timeout: 20_000 });
        await wait(1_500);
        const first = listReads(m.reads);
        check(first.length >= 1 && first[0].get('lat') === String(BYRON.lat) && first[0].get('lng') === String(BYRON.lng)
            && first[0].get('radiusKm') === '250' && first[0].get('sort') === 'distance', `the Market's first list read: ?${first[0]?.toString()}`);
        check(first.every((p) => p.get('lat') !== null), `no list read without the point (${first.length} read(s))`);
        const ans = m.answers.find((a) => a.params.get('lat'));
        const rows = Array.isArray(ans?.body) ? ans.body : [];
        check(rows.length > 0 && rows.every((r) => typeof r.distanceKm === 'number' && r.distanceKm <= 250), `the node answered ${rows.length} rows, each with a distance within 250 km (${rows.map((r) => `${r.title} ${r.distanceKm} km`).join(', ')})`);
        // Only listings on screen count: Home stays in the page behind the Market, and the activity strip above the
        // list is the community's activity, not its listings.
        check(!rows.some((r) => r.title === 'Oslo bicycle') && !(await shown(m.page, 'Oslo bicycle')), 'the listing in Oslo is not read or shown');
        const line = m.page.getByTestId('market-near-line');
        check((await line.textContent())?.includes('Nearest to your area first, within 250 km.'), `the line: "${(await line.textContent())?.trim()}"`);
        check((await m.page.getByTestId('card-distance').count()) > 0, `cards show the node's distance ("${(await m.page.getByTestId('card-distance').first().textContent())?.trim()}")`);
        const sw = await sideways(m.page);
        check(sw <= 0, `no sideways scroll on the Market at 320 px / 1.3x (${sw})`);
        const btn = line.getByRole('button', { name: 'Show everywhere' });
        const h = (await btn.boundingBox())?.height ?? 0;
        check(h >= 44, `Show everywhere is at least 44 px tall (${h})`);
        fs.mkdirSync(path.join(os.tmpdir(), 'bp-near-shots'), { recursive: true });
        await m.page.screenshot({ path: path.join(os.tmpdir(), 'bp-near-shots', 'market-area.png') });
        // Every layout: the distance tag whole on every card, never cut off by the card's edge.
        for (const [toggle, layout] of [['Switch to List View', 'List'], ['Switch to Compact View', 'Compact'], ['Switch to Card View', 'Card']]) {
            await m.page.getByRole('button', { name: toggle }).click();
            await wait(500);
            const tags = await clippedTags(m.page);
            check(tags.length > 0 && tags.every((t) => !t.cut), `${layout} layout: ${tags.length} distance tag(s), none cut off (${tags.map((t) => `"${t.text}"${t.cut ? ' CUT' : ''}`).join(', ')})`);
            const swl = await sideways(m.page);
            check(swl <= 0, `${layout} layout: no sideways scroll (${swl})`);
            if (layout === 'List') await m.page.screenshot({ path: path.join(os.tmpdir(), 'bp-near-shots', 'market-area-list.png') });
        }
        const n0 = m.reads.length;
        await btn.click();
        await until(() => listReads(m.reads.slice(n0)).length > 0);
        await until(async () => (await shown(m.page, 'Oslo bicycle')) > 0);
        const after = listReads(m.reads.slice(n0)).at(-1);
        check(after?.get('lat') === null && after?.get('radiusKm') === null && (await shown(m.page, 'Oslo bicycle')) > 0,
            `Show everywhere reads with no point (?${after?.toString()}) and Oslo is shown`);
        await m.page.getByTestId('market-near-line').getByRole('button', { name: 'Near your area' }).click();
        await wait(1_500);
        check(listReads(m.reads).at(-1)?.get('lat') === String(BYRON.lat), 'Near your area reads from the area again');

        console.log('The Map, the same member:');
        const before = m.reads.length;
        await tab(m.page, 'Map').click();
        await wait(4_000);
        const mapReads = listReads(m.reads.slice(before));
        check(mapReads.length >= 1 && mapReads.every((p) => p.get('lat') === String(BYRON.lat) && p.get('radiusKm') === '250' && p.get('sort') === 'distance' && p.get('limit') === '200'),
            `the Map's list read(s): ${mapReads.map((p) => `?${p.toString()}`).join(' ; ')}`);
        const swm = await sideways(m.page);
        check(swm <= 0, `no sideways scroll on the Map at 320 px / 1.3x (${swm})`);
        // The map's tiles and the font the app already loads are its own (aborted here); nothing else may leave.
        const others = [...m.otherHosts].filter((h) => !/(^|\.)tile\.openstreetmap\.org$/.test(h) && h !== 'fonts.googleapis.com');
        check(others.length === 0, `no request to any other host but the map tiles and the font (${others.join(', ') || 'none'})`);
        await m.context.close();
    } finally {
        await node.stop();
    }
}

async function localMember(browser, root) {
    console.log('A member with an area on a local node:');
    const me = memberIdentity('Bea');
    const node = await startNode(root, 'local', [{ publicKey: me.publicKey, callsign: 'Bea', joinedDaysAgo: 5 }]);
    try {
        await node.ask({ op: 'sql', sql: 'UPDATE members SET area_lat = ?, area_lng = ? WHERE public_key = ?', params: [BYRON.lat, BYRON.lng, me.publicKey] });
        await node.ask({ op: 'post', title: 'Byron honey', category: 'food' });
        const m = await openMember(browser, node.origin, me);
        await tab(m.page, 'Market').click();
        await m.page.getByText('Byron honey').first().waitFor({ timeout: 20_000 });
        await wait(2_000);
        const reads = listReads(m.reads);
        check(reads.length >= 1 && reads.every((p) => p.get('lat') === null && p.get('radiusKm') === null && p.get('sort') === null),
            `the Market's list read(s) carry no point: ${reads.map((p) => `?${p.toString()}`).join(' ; ')}`);
        check(!(await m.page.getByTestId('market-near-line').count()), 'no line about where');
        await m.context.close();
    } finally {
        await node.stop();
    }
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bp-near-check-'));
let browser;
try {
    await build({ root: PWA_DIR, logLevel: 'warn', build: { outDir: path.join(root, 'public'), emptyOutDir: true } });
    browser = await chromium.launch();
    console.log('The web app as built; Chromium at 320 px, 1.3x text, reduced motion.');
    for (const run of [globalMember, localMember]) {
        try { await run(browser, root); } catch (e) { failures.push(String(e?.stack || e)); console.error(e); }
    }
} finally {
    await browser?.close();
    fs.rmSync(root, { recursive: true, force: true });
}
console.log(failures.length ? `\nFAILED: ${failures.length}\n${failures.join('\n')}` : '\nAll checks passed.');
process.exit(failures.length ? 1 : 0);
