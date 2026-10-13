/**
 * People and Messages on a node where people are asked for, not read whole (features.membersOnDemand; design
 * scratch/global-node/DESIGN-global-members-by-area-fable.md §2.3, slice M3), in headless Chromium at 320 px with 1.3x
 * text, against a REAL node on this machine (e2e/home-node-harness.ts): the server's own GET /api/members forms, read
 * gate and signature middleware. The web app is built exactly as it ships and served by that node.
 *
 *   1. global, a member with an area (Byron): People → Community asks once for the 50 nearest that point
 *      (lat/lng/limit=50), shows each "About N km away" nearest first; one letter asks nothing, two ask the node
 *      (q=…&limit=20); the whole directory is never read anywhere in the visit (People, Market, Chat);
 *   2. global, Chat → New DM: the member's friends (review of #1861, N5), a search the node answers, and a tap starts
 *      the chat;
 *   3. global, a member with no area: no nearness read, the line says how to set one, the search still answers;
 *   4. a local node: People → Community reads the whole directory as before and none of the small forms.
 *
 * Fails on any sideways scroll, a control under 44 px in the People panel or the New DM picker, or a request to any
 * host but this machine.
 *
 * Run: node e2e/people-near-check.mjs (in apps/pwa; @beanpool/core, engine and signin built)
 * PEOPLE_NEAR_SCHEME=dark runs it in the app's dark scheme (default: light).
 */
/* global URL, console, process, setTimeout, document, indexedDB, localStorage -- Node, and the page's side of evaluate() */
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
const SCHEME = process.env.PEOPLE_NEAR_SCHEME === 'dark' ? 'dark' : 'light';
const BYRON = { lat: -28.6, lng: 153.6 };
const LAGOS = { lat: 6.5, lng: 3.4 };
const LENNOX = { lat: -28.8, lng: 153.6 };

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
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), `bp-people-${profile}-data-`));
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
    await context.addInitScript((scheme) => {
        try {
            localStorage.setItem('beanpool-theme-mode', scheme);
            localStorage.setItem('beanpool-theme-default-light-v1', 'done');
            localStorage.setItem('beanpool-install-dismissed-forever', '1');
        } catch { /* none */ }
    }, SCHEME);
    await context.route((url) => url.hostname !== 'localhost', (route) => {
        otherHosts.add(new URL(route.request().url()).hostname);
        return route.abort();
    });
    const page = await context.newPage();
    // Every read of the member directory, whole or small: path and query.
    const reads = [];
    page.on('request', (r) => {
        const u = new URL(r.url());
        if ((u.pathname === '/api/members' || u.pathname === '/api/community/members') && r.method() === 'GET') reads.push({ path: u.pathname, params: u.searchParams });
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
    await until(() => page.evaluate(() => document.documentElement.classList.contains('dark')).then(d => d === (SCHEME === 'dark')), 5_000);
    check(await page.evaluate(() => document.documentElement.classList.contains('dark')) === (SCHEME === 'dark'), `the page is drawn in the ${SCHEME} scheme`);
    return { context, page, reads, otherHosts };
}

async function until(test, ms = 20_000) {
    const end = Date.now() + ms;
    while (Date.now() < end) { if (await test()) return; await wait(200); }
}
const sideways = (page) => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
// Every control on screen inside `selector` (a button, a link, a text box) shorter than 44 px: its words and height.
const shortControls = (page, selector) => page.evaluate((sel) => [...document.querySelectorAll(`${sel} button, ${sel} a[href], ${sel} input`)]
    .filter((el) => el.getClientRects().length > 0)
    .map((el) => ({ what: (el.getAttribute('aria-label') || el.textContent || el.getAttribute('placeholder') || el.tagName).trim().slice(0, 40), h: el.getBoundingClientRect().height }))
    .filter((c) => c.h < 44), selector);
const small = (reads) => reads.filter((r) => r.path === '/api/members' && (r.params.get('q') || r.params.get('keys') || r.params.get('limit')));
const whole = (reads) => reads.filter((r) => r.path === '/api/community/members' || (r.path === '/api/members' && !r.params.get('q') && !r.params.get('keys') && !r.params.get('limit')));
const tab = (page, name) => page.locator('[data-testid="mobile-bottom-nav"] button').filter({ hasText: new RegExp(`${name}$`) });


async function globalMembers(browser, root) {
    console.log('A member with an area on the global node:');
    const ana = memberIdentity('Ana');
    const people = [
        { id: ana, at: BYRON }, { id: memberIdentity('Bodhi'), at: LENNOX }, { id: memberIdentity('Ade'), at: LAGOS },
        { id: memberIdentity('Adaeze'), at: LAGOS }, { id: memberIdentity('Cy'), at: null },
    ];
    const node = await startNode(root, 'global', people.map((p) => ({ publicKey: p.id.publicKey, callsign: p.id.callsign, joinedDaysAgo: 5 })));
    try {
        for (const p of people) {
            if (p.at) await node.ask({ op: 'sql', sql: 'UPDATE members SET area_lat = ?, area_lng = ? WHERE public_key = ?', params: [p.at.lat, p.at.lng, p.id.publicKey] });
        }
        // Ana's one friend, Adaeze, in Lagos: no chat with her, so New DM offers her only as a friend.
        const adaeze = people.find((p) => p.id.callsign === 'Adaeze').id;
        await node.ask({ op: 'sql', sql: 'INSERT INTO friends (owner_pubkey, friend_pubkey, added_at) VALUES (?, ?, ?)', params: [ana.publicKey, adaeze.publicKey, new Date().toISOString()] });
        const m = await openMember(browser, node.origin, ana);
        await tab(m.page, 'People').click();
        await m.page.getByRole('tab', { name: /Community/ }).click();
        const near = m.page.getByTestId('people-near');
        await near.waitFor({ timeout: 20_000 });
        await wait(800);
        const nearReads = small(m.reads).filter((r) => r.params.get('lat'));
        check(nearReads.length === 1 && nearReads[0].params.get('lat') === String(BYRON.lat) && nearReads[0].params.get('lng') === String(BYRON.lng)
            && nearReads[0].params.get('limit') === '50', `one nearness read from the area: ${nearReads.map((r) => `?${r.params}`).join(' ; ')}`);
        // The harness seeds its own members too (some near Byron, some with no area): the rule, not a fixed list.
        const rows = (await near.getByTestId('people-row').allTextContents()).map((t) => t.replace(/\s+/g, ' '));
        const km = rows.map((r) => (/Under 1 km away/.test(r) ? 0 : /About (\d+) km away/.test(r) ? Number(r.match(/About (\d+) km away/)[1]) : null));
        const placed = km.filter((k) => k !== null);
        const firstUnplaced = km.indexOf(null);
        check(placed.every((k, i) => i === 0 || k >= placed[i - 1]) && (firstUnplaced === -1 || km.slice(firstUnplaced).every((k) => k === null)),
            `nearest first, those with no area after them: ${km.map((k) => (k === null ? '—' : k)).join(', ')}`);
        check(rows.some((r) => r.includes('Bodhi') && r.includes('About 22 km away')) && rows.some((r) => r.includes('Ade') && /About \d+ km away/.test(r))
            && rows.some((r) => r.includes('Cy') && /Joined/.test(r)) && !rows.some((r) => /\bAna\b/.test(r)) && rows.length <= 50,
            `Bodhi about 22 km, Ade far, Cy with no area, never the member herself, at most 50: ${rows.length} rows`);
        check((await sideways(m.page)) <= 0, `no sideways scroll on People → Community at 320 px / 1.3x (${await sideways(m.page)})`);
        const shortP = await shortControls(m.page, '[data-testid="people-on-demand"]');
        check(shortP.length === 0, `every control in People → Community is at least 44 px (${shortP.map((c) => `${c.what} ${c.h}`).join(', ') || 'all'})`);
        fs.mkdirSync(path.join(os.tmpdir(), 'bp-people-shots'), { recursive: true });
        await near.scrollIntoViewIfNeeded();
        await m.page.screenshot({ path: path.join(os.tmpdir(), 'bp-people-shots', `${SCHEME}-people-near.png`), fullPage: true });

        const box = m.page.getByLabel('Search members by name');
        const n0 = m.reads.length;
        await box.fill('a');
        await wait(1_000);
        check(small(m.reads.slice(n0)).length === 0, 'one letter asks the node nothing');
        check((await m.page.getByTestId('people-search-status').textContent())?.includes('Type at least 2 letters'), 'and says to type 2');
        await box.fill('ad');
        const found = m.page.getByTestId('people-found');
        await found.waitFor({ timeout: 10_000 });
        const searched = small(m.reads.slice(n0));
        check(searched.length === 1 && searched[0].params.get('q') === 'ad' && searched[0].params.get('limit') === '20', `one search: ${searched.map((r) => `?${r.params}`).join(' ; ')}`);
        const names = (await found.getByTestId('people-row').allTextContents()).map((t) => t.replace(/\s+/g, ' '));
        check(names.length === 2 && names[0].includes('Ade') && names[1].includes('Adaeze'), `the node's prefix answer, shortest first: ${names.join(' | ')}`);
        check((await sideways(m.page)) <= 0, 'no sideways scroll with search results');
        const shortS = await shortControls(m.page, '[data-testid="people-on-demand"]');
        check(shortS.length === 0, `every control with results is at least 44 px (${shortS.map((c) => `${c.what} ${c.h}`).join(', ') || 'all'})`);
        await m.page.screenshot({ path: path.join(os.tmpdir(), 'bp-people-shots', `${SCHEME}-people-search.png`), fullPage: true });

        console.log('Chat → New DM, the same member:');
        await tab(m.page, 'Chat').click();
        await m.page.getByRole('button', { name: /New DM/ }).click();
        const picker = m.page.getByTestId('new-message-on-demand');
        await picker.waitFor({ timeout: 10_000 });
        const friendsBox = m.page.getByTestId('new-message-friends');
        await friendsBox.waitFor({ timeout: 10_000 });
        const friendNames = (await friendsBox.getByTestId('dm-pick').allTextContents()).map((t) => t.replace(/\s+/g, ' ').trim());
        check(friendNames.length === 1 && friendNames[0].endsWith('Adaeze'), `New DM offers the member's friend, from the friends list: ${friendNames.join(' | ')}`);
        check((await sideways(m.page)) <= 0, 'no sideways scroll on New DM with friends');
        const shortF = await shortControls(m.page, '[data-testid="new-message-on-demand"]');
        check(shortF.length === 0, `every control on New DM with friends is at least 44 px (${shortF.map((c) => `${c.what} ${c.h}`).join(', ') || 'all'})`);
        await friendsBox.evaluate((el) => el.scrollIntoView({ block: 'center' }));
        await m.page.screenshot({ path: path.join(os.tmpdir(), 'bp-people-shots', `${SCHEME}-new-dm-friends.png`), fullPage: true });
        const n1 = m.reads.length;
        await m.page.getByLabel('Find someone by name').fill('bo');
        await m.page.getByTestId('new-message-found').waitFor({ timeout: 10_000 });
        const dmSearch = small(m.reads.slice(n1));
        check(dmSearch.length === 1 && dmSearch[0].params.get('q') === 'bo', `New DM asks the node: ${dmSearch.map((r) => `?${r.params}`).join(' ; ')}`);
        check((await sideways(m.page)) <= 0, 'no sideways scroll on New DM');
        const shortD = await shortControls(m.page, '[data-testid="new-message-on-demand"]');
        check(shortD.length === 0, `every control on New DM is at least 44 px (${shortD.map((c) => `${c.what} ${c.h}`).join(', ') || 'all'})`);
        await m.page.screenshot({ path: path.join(os.tmpdir(), 'bp-people-shots', `${SCHEME}-new-dm.png`), fullPage: true });
        await m.page.getByTestId('new-message-found').getByRole('button', { name: /Bodhi/ }).click();
        await until(async () => (await picker.count()) === 0, 10_000);
        check((await picker.count()) === 0, 'tapping Bodhi opens the chat');

        await tab(m.page, 'Market').click();
        await wait(2_500);
        check(whole(m.reads).length === 0, `the whole directory is never read in the visit (${whole(m.reads).map((r) => `${r.path}?${r.params}`).join(' ; ') || 'none'})`);
        check(m.otherHosts.size === 0, `no request to any other host (fonts come from the node since #1858) (${[...m.otherHosts].join(', ') || 'none'})`);
        await m.context.close();

        console.log('A member with no area on the global node:');
        const cy = people.find((p) => p.id.callsign === 'Cy').id;
        const c = await openMember(browser, node.origin, cy);
        await tab(c.page, 'People').click();
        await c.page.getByRole('tab', { name: /Community/ }).click();
        await c.page.getByTestId('people-no-area').waitFor({ timeout: 20_000 });
        check(small(c.reads).every((r) => !r.params.get('lat')), 'no nearness read without an area');
        await c.page.getByLabel('Search members by name').fill('ana');
        await c.page.getByTestId('people-found').waitFor({ timeout: 10_000 });
        check((await c.page.getByTestId('people-found').textContent())?.includes('Ana'), 'the search still answers');
        check((await sideways(c.page)) <= 0, 'no sideways scroll');
        const shortC = await shortControls(c.page, '[data-testid="people-on-demand"]');
        check(shortC.length === 0, `every control is at least 44 px (${shortC.map((x) => `${x.what} ${x.h}`).join(', ') || 'all'})`);
        check(whole(c.reads).length === 0, 'and the whole directory is never read');
        await c.page.screenshot({ path: path.join(os.tmpdir(), 'bp-people-shots', `${SCHEME}-people-no-area.png`), fullPage: true });
        await c.context.close();
    } finally {
        await node.stop();
    }
}

async function localMember(browser, root) {
    console.log('A member on a local node:');
    const bea = memberIdentity('Bea');
    const cal = memberIdentity('Cal');
    const node = await startNode(root, 'local', [bea, cal].map((p) => ({ publicKey: p.publicKey, callsign: p.callsign, joinedDaysAgo: 5 })));
    try {
        await node.ask({ op: 'sql', sql: 'UPDATE members SET area_lat = ?, area_lng = ? WHERE public_key = ?', params: [BYRON.lat, BYRON.lng, bea.publicKey] });
        const m = await openMember(browser, node.origin, bea);
        await tab(m.page, 'People').click();
        await m.page.getByRole('tab', { name: /Community/ }).click();
        await m.page.getByText('All members on this node.', { exact: false }).waitFor({ timeout: 20_000 });
        await m.page.getByText('Cal', { exact: true }).first().waitFor({ timeout: 20_000 });
        await wait(1_000);
        const wholeReads = m.reads.filter((r) => r.path === '/api/community/members');
        check(wholeReads.length >= 1 && wholeReads.every((r) => [...r.params.keys()].length === 0), `the whole directory, as before: ${wholeReads.length} read(s) of /api/community/members with no parameters`);
        check(small(m.reads).length === 0, 'none of the small forms');
        check(!(await m.page.getByTestId('people-on-demand').count()), 'and none of the by-area screen');
        await m.context.close();
    } finally {
        await node.stop();
    }
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bp-people-check-'));
let browser;
try {
    await build({ root: PWA_DIR, logLevel: 'warn', build: { outDir: path.join(root, 'public'), emptyOutDir: true } });
    browser = await chromium.launch();
    console.log(`The web app as built; Chromium at 320 px, 1.3x text, reduced motion, the ${SCHEME} scheme.`);
    for (const run of [globalMembers, localMember]) {
        try { await run(browser, root); } catch (e) { failures.push(String(e?.stack || e)); console.error(e); }
    }
} finally {
    await browser?.close();
    fs.rmSync(root, { recursive: true, force: true });
}
console.log(failures.length ? `\nFAILED: ${failures.length}\n${failures.join('\n')}` : '\nAll checks passed.');
process.exit(failures.length ? 1 : 0);
