/**
 * Locked group chats on the web (slice 4 of scratch/global-node/DESIGN-group-chat-encryption-fable.md) in headless
 * Chromium at 320 px with 1.3x text, against a REAL node on this machine (e2e/home-node-harness.ts: the server's own group
 * routes, keys routes and signature middleware). The web app is built as it ships and served by that node.
 *
 *   1. two members (Ana, Ben) exchange lines in the group's chat: each is drawn under its signer's name, and the node's
 *      messages table holds no readable words (every row a sealed group line);
 *   2. a dishonest node: once Ana's browser has seen the chat locked, a chat answer with no `encryption` still gets a
 *      sealed line while the node serves the keys, and nothing at all once it refuses them (the sticky lock); a keys
 *      answer whose roster names someone the members list doesn't is refused with nothing sent and no wrap made to
 *      them; a `missing` list naming them gets them no top-up (top-ups only to the epoch's signed record's members);
 *   3. across clients: Ana's web line opens with the phone's own crypto module (apps/native/utils/group-chat-crypto.ts)
 *      under Ben's key in the phone's form, and a line the phone module seals as Ben is drawn under Ben on the web.
 *
 * Fails on any sideways scroll at 320 px, a readable word in the messages table, or a request to any host but this machine
 * (the shipped index.html's Google Fonts link aside: aborted, as every other host is).
 *
 * Run: node e2e/group-chat-check.mjs (from apps/pwa). GC_TMP sets where the build and the node's data go (os.tmpdir()).
 * Needs Chromium for Playwright once: pnpm --filter @beanpool/pwa exec playwright install --only-shell chromium
 */
/* global URL, Buffer, fetch, console, process, setTimeout, document, indexedDB, localStorage -- Node, and the page's side of evaluate() */
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
const NATIVE_DIR = path.resolve(PWA_DIR, '../native');
process.chdir(PWA_DIR);
const TMP = process.env.GC_TMP || os.tmpdir();
const VIEW = { width: 320, height: 720 };
const TEXT_SCALE = 1.3;
const GROUP_NONCE_PREFIX = 'group-xc20p-v1:';

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

async function startNode(root, members) {
    const dataDir = fs.mkdtempSync(path.join(TMP, 'bp-gc-data-'));
    const child = spawn(process.execPath, ['--import', 'tsx', '../pwa/e2e/home-node-harness.ts'], {
        cwd: SERVER_DIR,
        env: { ...process.env, BEANPOOL_DATA_DIR: dataDir, FIXTURE_ROOT: root, FIXTURE_PROFILE: 'local', FIXTURE_MEMBERS: JSON.stringify(members) },
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
    return { port, ask, log, stop, origin: `https://localhost:${port}` };
}

// ---------- the browser ----------

async function openAs(browser, origin, identity) {
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
    return { context, page, otherHosts };
}

/**
 * The group's chat, opened as a member would: the Chat tab, then the group, at 1.3x text. The node's limiters start again
 * first: two browsers and this script's own reads from one address would otherwise trip them (a 429 reads as Offline).
 */
async function openGroupChat(page, node, name) {
    await node.ask({ op: 'resetLimits' });
    await page.goto(`${node.origin}/app`, { waitUntil: 'load' });
    await page.addStyleTag({ content: `html { font-size: ${TEXT_SCALE * 100}% !important; }` });
    await page.getByRole('button', { name: /Chat/ }).first().click({ timeout: 30_000 });
    await page.getByText(name, { exact: true }).first().click({ timeout: 30_000 });
    await page.getByPlaceholder('Message...').waitFor({ timeout: 30_000 });
    await page.getByTestId('group-chat-notice').waitFor({ timeout: 30_000 });
}

async function send(page, text) {
    const composer = page.getByPlaceholder('Message...');
    await composer.fill(text);
    await composer.press('Enter');
}

async function noSidewaysScroll(page, where) {
    const over = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    check(over <= 1, `${where}: no sideways scroll at 320 px with 1.3x text${over > 1 ? ` (it scrolls ${over}px)` : ''}`);
}

// ---------- signed requests from here, as the phone makes them ----------

async function signedFetch(core, origin, identity, method, p, body) {
    const bodyString = body === undefined ? '' : JSON.stringify(body);
    const key = crypto.createPrivateKey({ key: Buffer.from(identity.privateKey, 'hex'), format: 'der', type: 'pkcs8' });
    const headers = await core.buildBoundRequestHeaders({
        method, url: `${origin}${p}`, body: bodyString, publicKeyHex: identity.publicKey,
        sign: async (bytes) => new Uint8Array(crypto.sign(null, Buffer.from(bytes), key)),
    });
    const res = await fetch(`${origin}${p}`, { method, headers: { 'Content-Type': 'application/json', ...headers }, ...(body === undefined ? {} : { body: bodyString }) });
    return { status: res.status, body: await res.json().catch(() => null) };
}

// ---------- the run ----------

async function main() {
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
    const root = fs.mkdtempSync(path.join(TMP, 'bp-gc-check-'));
    const ana = memberIdentity('Ana');
    const ben = memberIdentity('Ben');
    const mal = memberIdentity('Mal');
    let browser = null;
    let node = null;
    try {
        console.log('Building the web app…');
        await build({ root: PWA_DIR, logLevel: 'warn', build: { outDir: path.join(root, 'public'), emptyOutDir: true } });
        node = await startNode(root, [{ publicKey: ana.publicKey, callsign: 'Ana' }, { publicKey: ben.publicKey, callsign: 'Ben' }]);
        const [{ id: G }] = await node.ask({ op: 'sql', sql: "SELECT id FROM groups WHERE name = 'Garden group'", all: true });
        await node.ask({ op: 'joinGroup', groupId: G, member: ben.publicKey });
        const rows = () => node.ask({ op: 'sql', sql: "SELECT id, author_pubkey AS author, ciphertext, nonce, metadata, type FROM messages WHERE conversation_id = ? AND type != 'system' AND author_pubkey != 'SYSTEM' ORDER BY timestamp", params: [G], all: true });
        /** The members' rows once there are `n` of them (a send is in when the node has stored it), or as they are after 15 s. */
        const rowsReach = async (n) => {
            for (let i = 0; i < 60; i++) {
                const r = await rows();
                if (r.length >= n) return r;
                await new Promise((res) => setTimeout(res, 250));
            }
            return rows();
        };
        const wrapsTo = (pk) => node.ask({ op: 'sql', sql: 'SELECT epoch FROM group_key_wraps WHERE group_id = ? AND recipient_pubkey = ?', params: [G, pk], all: true });
        browser = await chromium.launch();

        console.log('1. Two members exchange sealed lines');
        const a = await openAs(browser, node.origin, ana);
        await openGroupChat(a.page, node, 'Garden group');
        const notice = await a.page.getByTestId('group-chat-notice').textContent();
        check(notice.includes('End-to-end encrypted'), `Ana's chat says it is locked, in the app's words ("${notice.trim()}")`);
        await send(a.page, 'Working bee Saturday at nine');
        await a.page.getByText('Working bee Saturday at nine').waitFor({ timeout: 20_000 });
        await noSidewaysScroll(a.page, "Ana's group chat");

        const b = await openAs(browser, node.origin, ben);
        await openGroupChat(b.page, node, 'Garden group');
        await rowsReach(1);
        await b.page.getByText('Working bee Saturday at nine').waitFor({ timeout: 20_000 });
        const authors = await b.page.getByTestId('group-line-author').allTextContents();
        check(authors.length === 1 && authors[0].startsWith('Ana'), `Ben sees Ana's line under her signing key's name (${JSON.stringify(authors)})`);
        await send(b.page, 'I will bring the gloves');
        await b.page.getByText('I will bring the gloves').waitFor({ timeout: 20_000 });
        await noSidewaysScroll(b.page, "Ben's group chat");

        await openGroupChat(a.page, node, 'Garden group');
        await a.page.getByText('I will bring the gloves').waitFor({ timeout: 20_000 });
        const anaSees = await a.page.getByTestId('group-line-author').allTextContents();
        check(anaSees.some((t) => t.startsWith('Ben')), `Ana sees Ben's reply under his name (${JSON.stringify(anaSees)})`);

        const words = ['Working bee', 'Saturday', 'gloves'];
        const stored = await rowsReach(2);
        // The node's own lines (a join, as the node words it) carry no member's words; every member's row must be sealed.
        const nodeLines = await node.ask({ op: 'sql', sql: "SELECT type, author_pubkey AS author, ciphertext FROM messages WHERE conversation_id = ? AND (type = 'system' OR author_pubkey = 'SYSTEM')", params: [G], all: true });
        console.log(`    (the node's own lines in this chat: ${nodeLines.length})`);
        const readable = [...stored, ...nodeLines].filter((r) => {
            const raw = String(r.ciphertext ?? '');
            const decoded = Buffer.from(raw, 'base64').toString('latin1');
            return words.some((w) => raw.includes(w) || decoded.includes(w));
        });
        check(stored.length === 2 && stored.every((r) => String(r.nonce).startsWith(GROUP_NONCE_PREFIX)),
            `the messages table holds the members' 2 lines, both sealed group lines (${stored.map((r) => String(r.nonce).slice(0, 15)).join(', ')})`);
        check(readable.length === 0, `no readable words in the messages table (${readable.length} rows readable)`);

        console.log('2. A dishonest node');
        // The node now says the chat isn't locked, and still serves the keys: the line goes sealed.
        const dropEncryption = async (route) => {
            const res = await route.fetch();
            const body = await res.json();
            delete body.encryption;
            await route.fulfill({ response: res, json: body });
        };
        const isChat = (url) => url.pathname === `/api/groups/${G}/chat`;
        const isKeys = (url) => url.pathname.startsWith(`/api/groups/${G}/keys`);
        const isKeysRoot = (url) => url.pathname === `/api/groups/${G}/keys`;
        const isMissing = (url) => url.pathname === `/api/groups/${G}/keys/missing`;
        const isPlain = (url) => url.pathname === '/api/messages' || url.pathname.startsWith('/api/messages/');
        await a.context.route(isChat, dropEncryption);
        await openGroupChat(a.page, node, 'Garden group');
        const lost = await a.page.getByTestId('group-chat-notice').textContent();
        check(lost.includes("isn't locked"), `with "unlocked" from the node, Ana's chat says it still locks (${JSON.stringify(lost.trim())})`);
        await send(a.page, 'Compost after lunch');
        const afterUnlocked = await rowsReach(3);
        check(afterUnlocked.length === 3 && String(afterUnlocked[2].nonce).startsWith(GROUP_NONCE_PREFIX),
            'an "unlocked" chat answer with keys served still gets a sealed line');
        // And refuses the keys: nothing goes at all, readable or sealed.
        let plainPosts = 0;
        await a.context.route(isPlain, (route) => {
            if (route.request().method() !== 'GET') plainPosts++;
            return route.continue();
        });
        const refuseKeys = (route) => route.fulfill({ status: 404, json: { error: 'Not found' } });
        await a.context.route(isKeys, refuseKeys);
        await send(a.page, 'Gate code is 4321');
        const told = await a.page.getByTestId('chat-refusal').textContent({ timeout: 20_000 }).catch(() => '');
        const afterRefused = await rows();
        check(afterRefused.length === 3, `"unlocked" and the keys refused: no line reaches the node (${afterRefused.length} rows)`);
        check(plainPosts === 0, `nothing goes by the readable messages route (${plainPosts} posts)`);
        check(/held its keys|Only members of this group/.test(told), `Ana is told why nothing was sent (${JSON.stringify(told)})`);
        await a.page.getByRole('button', { name: /dismiss|close/i }).first().click({ timeout: 2_000 }).catch(() => {});
        await a.context.unroute(isKeys, refuseKeys);
        await a.context.unroute(isChat, dropEncryption);

        // A keys answer whose roster names Mal, who isn't in the members list, with the epoch gone stale: refused, no wrap.
        const addMal = async (route) => {
            const res = await route.fetch();
            const body = await res.json();
            if (Array.isArray(body.roster)) body.roster = [...body.roster, mal.publicKey];
            body.stale = true;
            await route.fulfill({ response: res, json: body });
        };
        // Every write Ana's browser makes from here, as it leaves the page (before the node can refuse it).
        const anaPosts = [];
        a.context.on('request', (req) => {
            if (req.method() !== 'GET') anaPosts.push({ path: new URL(req.url()).pathname, body: req.postData() ?? '' });
        });
        const naming = (pk) => anaPosts.filter((p) => p.body.includes(pk));
        let missingReads = 0;
        const malMissing = (route) => {
            missingReads++;
            return route.fulfill({ json: { missing: [{ pubkey: mal.publicKey, epochs: [1] }] } });
        };
        await a.context.route(isKeysRoot, addMal);
        await a.context.route(isMissing, malMissing);
        await openGroupChat(a.page, node, 'Garden group');
        const beforeShed = (await rows()).length;
        await send(a.page, 'Who has the shed key');
        const rosterTold = await a.page.getByTestId('chat-refusal').textContent({ timeout: 20_000 }).catch(() => '');
        check(/isn't in its members list/.test(rosterTold), `a roster naming someone the members list doesn't is refused (${JSON.stringify(rosterTold)})`);
        check(naming(mal.publicKey).length === 0 && (await wrapsTo(mal.publicKey)).length === 0,
            `nothing Ana's browser sent names the recipient only the node's keys roster names (${JSON.stringify(naming(mal.publicKey).map((p) => p.path))})`);
        check((await rows()).length === beforeShed, 'and no line went, sealed or readable');
        await a.context.unroute(isKeysRoot, addMal);
        await a.context.unroute(isMissing, malMissing);

        // Decision (a): a top-up goes only to a member the epoch's signed record wrapped it to. The node now shows Mal in
        // the members list as well and says he lacks epoch 1's key; its record (signed by Ana) never named him.
        const malShown = async (route) => {
            const res = await route.fetch();
            const body = await res.json();
            const list = Array.isArray(body) ? [...body, { groupId: G, memberPubkey: mal.publicKey, callsign: 'Mal', role: 'member', status: 'active', joinedAt: new Date().toISOString() }] : body;
            await route.fulfill({ response: res, json: list });
        };
        const isMembers = (url) => url.pathname === `/api/groups/${G}/members`;
        missingReads = 0;
        await a.context.route(isMembers, malShown);
        await a.context.route(isMissing, malMissing);
        await openGroupChat(a.page, node, 'Garden group');
        for (let i = 0; i < 40 && missingReads === 0; i++) await new Promise((r) => setTimeout(r, 250));
        await a.page.waitForLoadState('networkidle', { timeout: 5_000 }).catch(() => {});
        await new Promise((r) => setTimeout(r, 1_500));
        const topUps = anaPosts.filter((p) => p.path.endsWith('/keys/wrap'));
        check(missingReads > 0, `Ana's browser read the node's missing list (${missingReads})`);
        check(topUps.length === 0 && naming(mal.publicKey).length === 0,
            `no top-up to a member the epoch's signed record didn't wrap to, though the node lists him as a member missing it (${topUps.length} sent)`);
        await a.context.unroute(isMembers, malShown);
        await a.context.unroute(isMissing, malMissing);

        console.log('3. Across clients: the web and the phone module');
        const { tsImport } = await import('tsx/esm/api');
        const phoneModule = await tsImport(path.join(NATIVE_DIR, 'utils/group-chat-crypto.ts'), import.meta.url);
        const phone = phoneModule.openMyKey ? phoneModule : phoneModule.default;
        const core = await import('@beanpool/core');
        // Ben as the phone keeps him: the raw seed, not the web's PKCS8.
        const benPhone = { ...ben, privateKey: Buffer.from(ben.privateKey, 'hex').subarray(-32).toString('hex') };
        const keys = await signedFetch(core, node.origin, ben, 'GET', `/api/groups/${G}/keys`);
        const e1 = keys.body?.epochs?.find((e) => e.epoch === 1);
        const w1 = keys.body?.myWraps?.find((w) => w.epoch === 1);
        let groupKey = null;
        try {
            groupKey = phone.openMyKey({ ...e1, groupId: G, subject: e1.subject ?? null }, w1, benPhone.privateKey, G);
        } catch (e) { console.error('   ', e?.message); }
        check(!!groupKey, "the phone module opens Ben's wrap from the node (seed form)");
        const anaLine = stored.find((r) => r.author === ana.publicKey);
        let opened = null;
        try {
            const meta = JSON.parse(anaLine.metadata || '{}');
            opened = phone.openLine({ ciphertext: anaLine.ciphertext, nonce: anaLine.nonce },
                { groupId: G, epoch: meta.epoch, senderPubHex: meta.sender ?? anaLine.author, messageId: anaLine.id }, groupKey);
        } catch (e) { console.error('   ', e?.message); }
        check(opened?.text === 'Working bee Saturday at nine', `Ana's web line opens in the phone module, signed by her (${JSON.stringify(opened?.text)})`);
        const messageId = crypto.randomUUID();
        const sealed = phone.sealLine('Seedlings are by the gate', { myEdPrivHex: benPhone.privateKey, groupKey, groupId: G, epoch: 1, messageId });
        const posted = await signedFetch(core, node.origin, ben, 'POST', `/api/groups/${G}/chat/message`,
            { ciphertext: sealed.ciphertext, nonce: sealed.nonce, metadata: { epoch: 1 }, clientId: messageId });
        check(posted.status < 300, `the node takes the phone-sealed line (${posted.status})`);
        await openGroupChat(a.page, node, 'Garden group');
        await a.page.getByText('Seedlings are by the gate').waitFor({ timeout: 20_000 }).catch(() => {});
        const drawn = await a.page.locator('[data-testid="group-line-author"]').allTextContents();
        check(await a.page.getByText('Seedlings are by the gate').count() === 1 && drawn.filter((t) => t.startsWith('Ben')).length >= 2,
            `the phone module's line is drawn on the web under Ben (${JSON.stringify(drawn)})`);

        // The shipped index.html links Google Fonts (aborted here, as every other host is); anything else fails.
        const elsewhere = [...a.otherHosts, ...b.otherHosts].filter((h) => h !== 'fonts.googleapis.com' && h !== 'fonts.gstatic.com');
        check(elsewhere.length === 0, `no request left this machine but the app's font link (${elsewhere.join(', ') || 'none'})`);
        await a.context.close();
        await b.context.close();
    } catch (e) {
        if (process.env.GC_SHOTS && browser) {
            for (const [i, c] of browser.contexts().entries()) for (const [j, p] of c.pages().entries()) await p.screenshot({ path: path.join(process.env.GC_SHOTS, `fail-${i}-${j}.png`) }).catch(() => {});
        }
        throw e;
    } finally {
        if (browser) await browser.close().catch(() => {});
        if (node) {
            const blocked = node.log.filter((l) => l.includes('BLOCKED-FETCH'));
            if (blocked.length) { failures.push('the node tried to reach another host'); console.error(blocked.join('\n')); }
            await node.stop();
        }
        fs.rmSync(root, { recursive: true, force: true });
    }
    if (failures.length) {
        console.error(`\n❌ ${failures.length} failed:\n - ${failures.join('\n - ')}`);
        process.exit(1);
    }
    console.log('\n✅ group chat check passed');
}

main().catch((e) => { console.error('❌', e); process.exit(1); });
