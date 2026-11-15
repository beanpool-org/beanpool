/**
 * Messages across communities on the web (X4b: components/AddressCardPanel.tsx, components/OutsideChats.tsx, the hooks in
 * pages/MessagesPage.tsx) in headless Chromium at 320 px with 1.3x text, against a REAL node on this machine
 * (e2e/home-node-harness.ts on the global profile, where outsideMessages is on: the server's own mailbox, its device rows and
 * its signature middleware). The web app is built as it ships and served by that node. One member, Ben:
 *   Chat → ✉️ New DM → Someone in another community → Show my card: the QR code, the switch "… in this browser" and "Each
 *     phone or browser you use has its own switch." (DECISION-outside-door.md, X2b).
 *   Sol, at another community (riverside.example), writes him a first line: sealed and signed here as Sol's phone would, put in
 *     the node's own relay_mail as its receive would. Ben's page runs its round: "Message requests ›", Sol's card behind it,
 *     the request with Accept / Decline / Block and no box; Accept; the chat: "Kept in this browser only." and "What you write
 *     on another phone or browser shows only there."; Ben answers. The node recorded this browser's device and its confirm.
 *   Cy's card (hillside.example) pasted: the first-message box, sent, on into the chat.
 * Light for the walk; then Dark for the card, the requests and the chat. Fails on any sideways scroll at 320 px, a control
 * under 44 px on these screens, or a request from the browser to any host but this machine.
 *
 * Run (from apps/pwa): node e2e/outside-chats-320.mjs   OUTSIDE_TMP sets where the build and the node's data go (os.tmpdir());
 * OUTSIDE_SHOTS a folder for screenshots. Needs Chromium for Playwright once: pnpm --filter @beanpool/pwa exec playwright install --only-shell chromium
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
import {
    addressCardLink, ed25519Signer, relayPayloadHash, sealOutsideLine, signAddressCard, signRelayEnvelope,
} from '@beanpool/core';

const PWA_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SERVER_DIR = path.resolve(PWA_DIR, '../server');
process.chdir(PWA_DIR);
const TMP = process.env.OUTSIDE_TMP || os.tmpdir();
const SHOTS = process.env.OUTSIDE_SHOTS || '';
const VIEW = { width: 320, height: 720 };
const LIMIT_S = Number(process.env.OUTSIDE_LIMIT_S || 420);
setTimeout(() => { console.error(`\nStopped after ${LIMIT_S} s, not finished.`); process.exit(2); }, LIMIT_S * 1000).unref();

const SWITCH = 'People in other communities can send me a message request in this browser';
const EACH_DEVICE = 'Each phone or browser you use has its own switch.';
const WRITES_STAY = 'What you write on another phone or browser shows only there.';

const failures = [];
function check(ok, what) {
    if (ok) console.log(`  ✓ ${what}`);
    else { failures.push(what); console.error(`  ✗ ${what}`); }
}

function keyPair() {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    return {
        key: publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('hex'),
        seed: privateKey.export({ type: 'pkcs8', format: 'der' }).subarray(-32).toString('hex'),
        pkcs8: privateKey.export({ type: 'pkcs8', format: 'der' }).toString('hex'),
    };
}
const signerOf = (seedHex) => ed25519Signer(Uint8Array.from(Buffer.from(seedHex, 'hex')));

async function startNode(root, members) {
    const dataDir = fs.mkdtempSync(path.join(TMP, 'bp-outside-data-'));
    const child = spawn(process.execPath, ['--import', 'tsx', '../pwa/e2e/home-node-harness.ts'], {
        cwd: SERVER_DIR,
        // Its public name first (as outside-mail-e2e.test.ts names its nodes): a card names it as the member's home.
        env: { ...process.env, BEANPOOL_DATA_DIR: dataDir, BEANPOOL_ADDRESSES: 'meadow.example,localhost', FIXTURE_ROOT: root, FIXTURE_PROFILE: 'global', FIXTURE_MEMBERS: JSON.stringify(members) },
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
    const sql = (q, params = [], all = true) => ask({ op: 'sql', sql: q, params, all });
    const stop = async () => {
        child.kill('SIGTERM');
        await new Promise((r) => setTimeout(r, 300));
        if (child.exitCode === null) child.kill('SIGKILL');
        fs.rmSync(dataDir, { recursive: true, force: true });
    };
    return { ask, sql, log, stop, origin: `https://localhost:${port}` };
}

async function shot(page, name) {
    if (SHOTS) await page.screenshot({ path: path.join(SHOTS, `${name}.png`), fullPage: false }).catch((e) => console.error('shot', name, e?.message));
}

const otherHosts = new Set();
async function openAs(browser, origin, identity) {
    const context = await browser.newContext({ viewport: VIEW, ignoreHTTPSErrors: true, reducedMotion: 'reduce', colorScheme: 'light' });
    await context.addInitScript(() => {
        try {
            if (!localStorage.getItem('beanpool-theme-mode')) localStorage.setItem('beanpool-theme-mode', 'light');
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
    return { context, page };
}

/** The Chat tab, as a member gets there, at 1.3x text: its page runs a round of the mailbox on open. */
async function openChat(page, node, theme) {
    await node.ask({ op: 'resetLimits' });
    await page.evaluate((mode) => { localStorage.setItem('beanpool-theme-mode', mode); }, theme);
    await page.emulateMedia({ colorScheme: theme });
    await page.goto(`${node.origin}/app`, { waitUntil: 'load' });
    await page.addStyleTag({ content: 'html { font-size: 130% !important; }' });
    const ack = page.getByRole('button', { name: 'Acknowledge' });
    for (let i = 0; i < 4; i++) {
        if (!(await ack.first().isVisible({ timeout: 2500 }).catch(() => false))) break;
        await ack.first().click();
    }
    try {
        await page.getByRole('button', { name: /Chat$/ }).first().click({ timeout: 30_000 });
    } catch (e) {
        await page.screenshot({ path: path.join(SHOTS || TMP, 'fail-no-chat-tab.png') }).catch(() => {});
        throw e;
    }
}

async function fits(page, where) {
    const r = await page.evaluate(() => {
        const over = document.documentElement.scrollWidth - document.documentElement.clientWidth;
        const scope = document.querySelector('[data-testid="address-card"], [data-testid="outside-chat"], [data-testid="outside-request-card"]');
        const small = scope ? Array.from(scope.querySelectorAll('button, input:not([type=file]):not([type=checkbox]), textarea'))
            .filter((el) => el.offsetParent !== null).map((el) => ({ h: el.getBoundingClientRect().height, label: (el.getAttribute('aria-label') || el.textContent || el.tagName).trim().slice(0, 30) }))
            .filter((b) => b.h < 43.5) : [];
        return { over, small, scoped: !!scope };
    });
    check(r.over <= 1, `${where}: no sideways scroll at 320 px with 1.3x text${r.over > 1 ? ` (it scrolls ${r.over}px)` : ''}`);
    check(r.small.length === 0, `${where}: every control is a 44 px target${r.small.length ? ` (${r.small.map((b) => `${b.label} ${Math.round(b.h)}px`).join(', ')})` : ''}`);
}

/** Sol's first line to Ben, as Sol's phone seals and signs it and Sol's community's server brings it: held for Ben here. */
async function holdFirstLine(node, sol, ben, benHome, text) {
    const itemId = crypto.randomUUID();
    const payload = sealOutsideLine({ text, name: 'Sol', myEdPrivHex: sol.seed, myKey: sol.key, peerKey: ben.key, messageId: itemId });
    const envelope = await signRelayEnvelope({
        kind: 'dm-line', itemId, senderKey: sol.key, senderHome: 'riverside.example', recipient: ben.key, recipientHome: benHome,
        at: Date.now(), payloadHash: relayPayloadHash(payload),
    }, signerOf(sol.seed));
    await node.sql(`INSERT INTO relay_mail (sender_key, item_id, kind, recipient, sender_home, envelope, payload, bytes, received_at)
                    VALUES (?, ?, 'dm-line', ?, 'riverside.example', ?, ?, ?, ?)`, [sol.key, itemId, ben.key, JSON.stringify(envelope), payload, payload.length, Date.now()], false);
    return itemId;
}

async function main() {
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
    if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });
    const root = fs.mkdtempSync(path.join(TMP, 'bp-outside-check-'));
    const benKeys = keyPair(), sol = keyPair(), cy = keyPair();
    const ben = { publicKey: benKeys.key, privateKey: benKeys.pkcs8, callsign: 'Ben', createdAt: new Date().toISOString() };
    let browser = null;
    let node = null;
    try {
        console.log('Building the web app…');
        await build({ root: PWA_DIR, logLevel: 'warn', build: { outDir: path.join(root, 'public'), emptyOutDir: true } });
        node = await startNode(root, [{ publicKey: ben.publicKey, callsign: 'Ben', joinedDaysAgo: 30 }]);
        browser = await chromium.launch();

        console.log('Ben: his card and this browser\'s door');
        const B = await openAs(browser, node.origin, ben);
        const page = B.page;
        await openChat(page, node, 'light');
        await page.getByRole('button', { name: /New DM/ }).first().click({ timeout: 30_000 });
        await page.getByTestId('new-message-outside').first().click({ timeout: 30_000 });
        await page.getByTestId('address-card').waitFor({ timeout: 15_000 });
        check(await page.getByTestId('door-switch').count() === 0, 'no switch before the card is shown');
        await fits(page, 'the address cards, before');
        await shot(page, '01-cards-before-light');
        await page.getByTestId('show-my-card').click();
        await page.getByTestId('door-switch').waitFor({ timeout: 15_000 }).catch(async (e) => { await shot(page, 'fail-show-my-card'); throw e; });
        check(await page.getByTestId('door-switch').isChecked(), 'showing the card opened this browser\'s door');
        check(await page.getByText(SWITCH).isVisible(), 'the switch ends "in this browser"');
        check((await page.getByTestId('door-each-device').textContent()) === EACH_DEVICE, `under it: "${EACH_DEVICE}"`);
        const link = (await page.getByTestId('my-card-link').textContent()) ?? '';
        const benHome = new URL(link).host;
        check(!!benHome, `the card names his community's home (${benHome})`);
        await fits(page, 'my card');
        await shot(page, '02-my-card-light');
        await page.getByTestId('door-each-device').scrollIntoViewIfNeeded();
        await shot(page, '03-my-card-switch-light');

        console.log('Sol, at another community: a first line, held at Ben\'s node');
        const itemId = await holdFirstLine(node, sol, benKeys, benHome, 'Hello Ben, I saw your card at the market.');
        await openChat(page, node, 'light');
        const row = page.getByTestId('message-requests-row');
        await row.waitFor({ timeout: 30_000 });
        await shot(page, '04-requests-row-light');
        await row.click();
        await page.getByTestId('outside-request-card').waitFor({ timeout: 15_000 });
        check((await page.getByTestId('outside-request-card').textContent()).includes('riverside.example'), 'the request card names their community');
        await fits(page, 'the request card');
        await shot(page, '05-request-card-light');
        const devices = await node.sql('SELECT device FROM relay_mail_devices WHERE member = ?', [ben.publicKey]);
        check(devices.length === 1 && /^[0-9a-f]{32}$/.test(devices[0].device), `the node lists this browser as one device (${devices.length})`);
        const got = await node.sql('SELECT device FROM relay_mail_got WHERE recipient = ? AND item_id = ?', [ben.publicKey, itemId]);
        const gone = (await node.sql('SELECT COUNT(*) AS n FROM relay_mail WHERE item_id = ?', [itemId]))[0].n === 0;
        check(gone || (got.length === 1 && got[0].device === devices[0]?.device), 'this browser confirmed it under its own id (the only device: it is gone)');
        await page.getByTestId('outside-request-open').click();
        await page.getByTestId('outside-request').waitFor({ timeout: 15_000 });
        check(await page.getByTestId('outside-chat-input').count() === 0, 'a request takes no reply until Accept');
        check((await page.getByTestId('outside-chat-writes-stay').textContent()) === WRITES_STAY, `the banner: "${WRITES_STAY}"`);
        await fits(page, 'the request');
        await shot(page, '06-request-light');
        await page.getByTestId('outside-request-accept').click();
        await page.getByTestId('outside-chat-input').waitFor({ timeout: 15_000 });
        await page.getByTestId('outside-chat-input').fill('Hello Sol! Yes, the bean stall.');
        await page.getByTestId('outside-chat-send').click();
        await page.getByTestId('outside-line-mine').waitFor({ timeout: 15_000 });
        await fits(page, 'the chat');
        await shot(page, '07-chat-light');

        console.log('Cy\'s card, pasted: one line as a request');
        const cyCard = await signAddressCard({ key: cy.key, home: 'hillside.example', name: 'Cy' }, signerOf(cy.seed));
        await page.getByRole('button', { name: 'Back to chats' }).first().click();
        await page.getByRole('button', { name: /New DM/ }).first().click({ timeout: 30_000 });
        await page.getByTestId('new-message-outside').first().click({ timeout: 30_000 });
        await page.getByTestId('paste-card').fill(addressCardLink(cyCard));
        await page.getByTestId('read-card').click();
        await page.getByTestId('first-message').waitFor({ timeout: 15_000 });
        await page.getByTestId('first-message').fill('Hi Cy, Ben here from the swap table.');
        await fits(page, 'someone else\'s card');
        await shot(page, '08-their-card-light');
        await page.getByTestId('send-request').click();
        await page.getByTestId('outside-chat').waitFor({ timeout: 25_000 });
        check((await page.getByTestId('outside-chat-home').textContent()).includes('hillside.example'), 'on into the chat with Cy, their community on its own line');

        console.log('Dark: the card, the chats, the chat');
        await openChat(page, node, 'dark');
        await page.getByTestId('outside-chats').waitFor({ timeout: 30_000 });
        await fits(page, 'Chat with outside chats (dark)');
        await shot(page, '09-chats-dark');
        await page.getByTestId('outside-chat-row').first().click();
        await page.getByTestId('outside-chat').waitFor({ timeout: 15_000 });
        await fits(page, 'the chat (dark)');
        await shot(page, '10-chat-dark');
        await page.getByRole('button', { name: 'Back to chats' }).first().click();
        await page.getByRole('button', { name: /New DM/ }).first().click({ timeout: 30_000 });
        await page.getByTestId('new-message-outside').first().click({ timeout: 30_000 });
        await page.getByTestId('door-switch').waitFor({ timeout: 15_000 });
        check(await page.getByTestId('door-switch').isChecked(), 'the door stays open in this browser');
        await fits(page, 'the address cards (dark)');
        await shot(page, '11-cards-dark');
        check(otherHosts.size === 0, `no request left this machine from the browser (${[...otherHosts].join(', ')})`);
    } catch (e) {
        failures.push(String(e?.stack || e));
        console.error(e);
        if (node) console.error(node.log.slice(-25).join('\n'));
    } finally {
        await browser?.close().catch(() => {});
        await node?.stop().catch(() => {});
        fs.rmSync(root, { recursive: true, force: true });
    }
    console.log(failures.length ? `\n${failures.length} failed` : '\nAll outside-chat checks passed.');
    process.exit(failures.length ? 1 : 0);
}

await main();
