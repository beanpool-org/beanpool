/**
 * A poll's typed Other in the real web app on a real node (e2e/home-node-harness.ts), in Chromium at 320 px with 1.3x text, both
 * themes: the maker's tick, answering with Other, a member's result, the maker's result, the owner's Remove. Shots go to
 * POLL_SHOTS. Run: node e2e/poll-other-shots.mjs (cwd apps/pwa).
 */
/* global URL, console, process, setTimeout, document, indexedDB, localStorage */
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
const SHOTS = process.env.POLL_SHOTS || fs.mkdtempSync(path.join(os.tmpdir(), 'poll-other-'));
fs.mkdirSync(SHOTS, { recursive: true });
const VIEW = { width: 320, height: 720 };
const failures = [];
const check = (ok, what) => { if (ok) console.log(`  ✓ ${what}`); else { failures.push(what); console.error(`  ✗ ${what}`); } };

function identity(callsign) {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    return {
        publicKey: publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('hex'),
        privateKey: privateKey.export({ type: 'pkcs8', format: 'der' }).toString('hex'),
        callsign, createdAt: new Date().toISOString(),
    };
}

async function startNode(root, members) {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bp-poll-other-'));
    const child = spawn(process.execPath, ['--import', 'tsx', '../pwa/e2e/home-node-harness.ts'], {
        cwd: SERVER_DIR, env: { ...process.env, BEANPOOL_DATA_DIR: dataDir, FIXTURE_ROOT: root, FIXTURE_PROFILE: 'local', FIXTURE_MEMBERS: JSON.stringify(members) }, stdio: ['pipe', 'pipe', 'pipe'],
    });
    const log = []; const waiting = new Map(); let ready;
    const readyAt = new Promise((resolve, reject) => { ready = resolve; child.on('exit', c => reject(new Error(`node exited ${c}:\n${log.slice(-20).join('\n')}`))); });
    readline.createInterface({ input: child.stdout }).on('line', (line) => {
        if (line.startsWith('FIXTURE_READY ')) ready(JSON.parse(line.slice(14)));
        else if (line.startsWith('FIXTURE_ANSWER ')) { const a = JSON.parse(line.slice(15)); waiting.get(a.id)?.(a); waiting.delete(a.id); } else log.push(line);
    });
    readline.createInterface({ input: child.stderr }).on('line', l => log.push(l));
    const { port } = await readyAt;
    let n = 0;
    const ask = (req) => new Promise((resolve, reject) => { const id = ++n; waiting.set(id, a => (a.ok ? resolve(a.result) : reject(new Error(a.error)))); child.stdin.write(`${JSON.stringify({ id, ...req })}\n`); });
    return { port, ask, origin: `https://localhost:${port}`, stop: async () => { child.kill('SIGTERM'); await new Promise(r => setTimeout(r, 300)); if (child.exitCode === null) child.kill('SIGKILL'); fs.rmSync(dataDir, { recursive: true, force: true }); } };
}

async function open(browser, origin, who, dark) {
    const context = await browser.newContext({ viewport: VIEW, ignoreHTTPSErrors: true, reducedMotion: 'reduce' });
    await context.addInitScript(([mode]) => {
        try { localStorage.setItem('beanpool-theme-mode', mode); localStorage.setItem('beanpool-theme-default-light-v1', 'done'); localStorage.setItem('beanpool-install-dismissed-forever', '1'); } catch { /* none */ }
        document.addEventListener('DOMContentLoaded', () => { const s = document.createElement('style'); s.textContent = 'html { font-size: 130% !important; }'; document.head.appendChild(s); });
    }, [dark ? 'dark' : 'light']);
    const page = await context.newPage();
    await page.goto(`${origin}/app`, { waitUntil: 'load' });
    await page.evaluate(id => new Promise((resolve, reject) => {
        const o = indexedDB.open('beanpool-identity', 1);
        o.onupgradeneeded = () => o.result.createObjectStore('keys');
        o.onerror = () => reject(o.error);
        o.onsuccess = () => { const tx = o.result.transaction('keys', 'readwrite'); tx.objectStore('keys').put(id, 'sovereign-identity'); tx.oncomplete = () => { o.result.close(); resolve(); }; tx.onerror = () => reject(tx.error); };
    }), who);
    return { context, page };
}

const market = async (page) => {
    await page.locator('[data-testid="mobile-bottom-nav"] button').filter({ hasText: /Market$/ }).first().click({ timeout: 20000 });
    await page.waitForTimeout(700);
    await page.getByRole('button', { name: /Polls/ }).first().click({ timeout: 10000 }).catch(() => {});
    await page.waitForTimeout(800);
};

const noSideScroll = async (page, where) => {
    const over = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    check(over <= 1, `${where}: no sideways scroll (${over})`);
};

async function run(browser, root, dark) {
    const theme = dark ? 'dark' : 'light';
    console.log(`\n── ${theme} ──`);
    const owner = identity('Oona Owner'); const maker = identity('Mo Maker'); const member = identity('Tess Typist'); const reader = identity('Ray Reader');
    const node = await startNode(root, [owner, maker, member, reader].map(m => ({ publicKey: m.publicKey, callsign: m.callsign, avatar: true })));
    await node.ask({ op: 'sql', sql: "INSERT OR REPLACE INTO node_roles (member_pubkey, role, granted_by) VALUES (?, 'owner', 'SYSTEM')", params: [owner.publicKey] });
    try {
        const shot = async (page, name) => {
            const file = path.join(SHOTS, `web-${theme}-${name}.png`);
            await page.screenshot({ path: file });
            console.log(`  md5 ${crypto.createHash('md5').update(fs.readFileSync(file)).digest('hex')}  ${path.basename(file)}`);
        };

        // The maker's tick, on the Map's composer.
        const m = await open(browser, node.origin, maker, dark);
        await m.page.goto(`${node.origin}/app`, { waitUntil: 'load' });
        await m.page.locator('[data-testid="mobile-bottom-nav"] button').filter({ hasText: /Market$/ }).first().click({ timeout: 20000 });
        await m.page.waitForTimeout(800);
        await m.page.getByRole('button', { name: /add post|new post|create a post|post something/i }).first().click({ timeout: 15000 });
        await m.page.waitForTimeout(500);
        await m.page.getByRole('button', { name: /Poll/ }).first().click({ timeout: 15000 });
        await m.page.waitForTimeout(500);
        const tick = m.page.getByTestId('poll-other');
        await tick.waitFor({ timeout: 10000 });
        check(!(await tick.isChecked()), 'the tick is off by default');
        await m.page.getByPlaceholder('What should our community decide?').fill('What is missing here?');
        const optionInputs = m.page.locator('input[placeholder^="Option "]');
        await optionInputs.nth(0).fill('More buses');
        await optionInputs.nth(1).fill('More Beans');
        await tick.check();
        await tick.scrollIntoViewIfNeeded();
        await noSideScroll(m.page, 'the composer');
        await shot(m.page, '1-maker-tick');
        await m.page.getByRole('button', { name: /Create Poll/ }).click();
        await m.page.waitForTimeout(1200);
        const row = await node.ask({ op: 'sql', sql: "SELECT id, poll_options FROM posts WHERE type = 'poll'", all: true });
        const pollId = row[0].id;
        check(JSON.parse(row[0].poll_options).some(o => o.other === true), 'the node holds Other on the poll made in the web app');

        // Answering with Other.
        await node.ask({ op: 'resetLimits' });
        const t = await open(browser, node.origin, member, dark);
        await t.page.goto(`${node.origin}/app?post=${pollId}`, { waitUntil: 'load' });
        await market(t.page);
        const otherBtn = t.page.getByRole('button', { name: /Other: 0%|Other/ }).last();
        await otherBtn.click({ timeout: 10000 });
        await t.page.getByTestId('poll-other-words').fill('A bus on Sundays, please');
        check((await t.page.getByTestId('poll-other-no-name').textContent()) === "Don't put your name", 'the line says not to put a name');
        await t.page.getByTestId('poll-other-words').scrollIntoViewIfNeeded();
        await noSideScroll(t.page, 'answering');
        await shot(t.page, '2-answering-other');
        await t.page.getByTestId('poll-other-send').click();
        await t.page.getByTestId('poll-answered').waitFor({ timeout: 10000 });
        const ballots = await node.ask({ op: 'sql', sql: 'SELECT option_id, signature FROM poll_votes', all: true });
        check(ballots.length === 1 && ballots[0].option_id === 'sealed' && ballots[0].signature === '', 'the database holds a ballot with no choice');

        // A member's result.
        await node.ask({ op: 'resetLimits' });
        const r = await open(browser, node.origin, reader, dark);
        await r.page.goto(`${node.origin}/app`, { waitUntil: 'load' });
        await market(r.page);
        await r.page.getByRole('button', { name: /More buses/ }).first().click({ timeout: 10000 });
        await r.page.getByTestId('poll-answered').waitFor({ timeout: 10000 });
        await r.page.getByTestId('poll-answered').scrollIntoViewIfNeeded();
        check(!(await r.page.content()).includes('A bus on Sundays'), 'a member never gets the words');
        check(await r.page.getByText(/\(1\)/).count() >= 2, 'a member sees the count for Other');
        check(await r.page.getByTestId('poll-other-answers').count() === 0, 'a member has no panel of words');
        await noSideScroll(r.page, "a member's result");
        await shot(r.page, '3-member-result');

        // The maker: held, then closed.
        await node.ask({ op: 'resetLimits' });
        await m.page.goto(`${node.origin}/app`, { waitUntil: 'load' });
        await market(m.page);
        await m.page.getByRole('button', { name: /Read the typed answers/ }).first().click({ timeout: 10000 });
        await m.page.getByTestId('poll-other-held').waitFor({ timeout: 10000 });
        await m.page.getByTestId('poll-other-held').scrollIntoViewIfNeeded();
        check(!(await m.page.content()).includes('A bus on Sundays'), 'while it is open the maker gets no words');
        await shot(m.page, '4-maker-held');
        m.page.once('dialog', d => d.accept());
        const closeBtn = m.page.getByRole('button', { name: /^Close poll$/i }).first();
        await closeBtn.scrollIntoViewIfNeeded();
        await closeBtn.click({ timeout: 10000 });
        await m.page.waitForTimeout(1500);
        console.log('  status after close:', JSON.stringify(await node.ask({ op: 'sql', sql: "SELECT status FROM posts WHERE type = 'poll'", all: true })));
        await node.ask({ op: 'resetLimits' });
        await m.page.goto(`${node.origin}/app`, { waitUntil: 'load' });
        await market(m.page);
        await m.page.getByRole('button', { name: /Read the typed answers/ }).first().click({ timeout: 10000 });
        await m.page.getByTestId('poll-other-line').first().waitFor({ timeout: 10000 }).catch(async (e) => { await m.page.screenshot({ path: path.join(SHOTS, 'debug.png') }); console.log(await m.page.getByTestId('poll-other-answers').first().textContent()); throw e; });
        await m.page.getByTestId('poll-other-line').first().scrollIntoViewIfNeeded();
        check((await m.page.getByTestId('poll-other-line').first().textContent()).includes('A bus on Sundays'), 'closed, the maker reads the words');
        await noSideScroll(m.page, "the maker's result");
        await shot(m.page, '5-maker-result');

        // The owner.
        await node.ask({ op: 'resetLimits' });
        const o = await open(browser, node.origin, owner, dark);
        await o.page.goto(`${node.origin}/app`, { waitUntil: 'load' });
        await market(o.page);
        await o.page.getByRole('button', { name: /Read the typed answers/ }).first().click({ timeout: 10000 });
        await o.page.getByTestId('poll-other-line').first().waitFor({ timeout: 10000 });
        await o.page.getByTestId('poll-other-line').first().scrollIntoViewIfNeeded();
        await shot(o.page, '6-owner-remove');
        for (const c of [m, t, r, o]) await c.context.close();
    } finally {
        await node.stop();
    }
}

async function main() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bp-poll-other-root-'));
    await build({ root: PWA_DIR, logLevel: 'warn', build: { outDir: path.join(root, 'public'), emptyOutDir: true } });
    const browser = await chromium.launch();
    try {
        for (const dark of [false, true]) await run(browser, root, dark);
    } finally {
        await browser.close();
        fs.rmSync(root, { recursive: true, force: true });
    }
    console.log(`\nshots in ${SHOTS}; ${failures.length} failed`);
    process.exit(failures.length ? 1 : 0);
}
main().catch(e => { console.error(e); process.exit(1); });
