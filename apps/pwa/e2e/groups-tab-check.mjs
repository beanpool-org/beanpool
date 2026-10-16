/**
 * Messages → Groups on the web (the phone's Talk → Groups; Marty, 16 Oct: "no group button at the top"), in headless
 * Chromium against a REAL node on this machine (e2e/home-node-harness.ts). The web app is built as it ships and served
 * by that node.
 *
 *   1. Ana (convenor of the harness's "Garden group", and a DM from Kofi) opens Chat → Groups: her group is listed, Kofi's
 *      DM is not, and the top offers Find groups and New group. New group opens the Commons form; the group she makes
 *      there opens straight into its chat, and back on Groups both her groups are listed. Find groups opens Commons.
 *   2. Ben, in no group, sees the empty Groups view: what a group is, New group, and Find a group to join.
 *   3. Both at 320 px with 1.3x text and at 1280 px, light and dark: no sideways scroll, all four chips on screen.
 *
 * Run: node e2e/groups-tab-check.mjs (from apps/pwa). GT_TMP sets where the build and the node's data go (os.tmpdir());
 * GT_SHOTS a folder for screenshots. Needs Chromium for Playwright once:
 * pnpm --filter @beanpool/pwa exec playwright install --only-shell chromium
 */
/* global URL, console, process, setTimeout, document, localStorage -- Node, and the page's side of evaluate() */
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
const TMP = process.env.GT_TMP || os.tmpdir();
const SHOTS = process.env.GT_SHOTS || '';
const SIZES = [
    { name: '320', viewport: { width: 320, height: 720 }, textScale: 1.3 },
    { name: '1280', viewport: { width: 1280, height: 800 }, textScale: 1 },
];

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

async function startNode(root, members) {
    const dataDir = fs.mkdtempSync(path.join(TMP, 'bp-gt-data-'));
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
    return { ask, log, stop, origin: `https://localhost:${port}` };
}

/** A signed-in member's browser at one size and theme: the key put where the app keeps it, then the app reloaded. */
async function openAs(browser, node, identity, size, theme) {
    const context = await browser.newContext({ viewport: size.viewport, ignoreHTTPSErrors: true, reducedMotion: 'reduce', colorScheme: theme });
    await context.addInitScript((mode) => {
        try {
            localStorage.setItem('beanpool-theme-mode', mode);
            localStorage.setItem('beanpool-theme-default-light-v1', 'done');
            localStorage.setItem('beanpool-install-dismissed-forever', '1');
        } catch { /* none */ }
    }, theme);
    const otherHosts = new Set();
    await context.route((url) => url.hostname !== 'localhost', (route) => {
        otherHosts.add(new URL(route.request().url()).hostname);
        return route.abort();
    });
    const page = await context.newPage();
    await page.goto(`${node.origin}/app`, { waitUntil: 'load' });
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
    await node.ask({ op: 'resetLimits' });
    await page.goto(`${node.origin}/app`, { waitUntil: 'load' });
    if (size.textScale !== 1) await page.addStyleTag({ content: `html { font-size: ${size.textScale * 100}% !important; }` });
    return { context, page, otherHosts };
}

const chips = (page) => page.getByTestId('conversation-filter-chips');
async function openGroups(page) {
    await page.getByRole('button', { name: /Chat/ }).first().click({ timeout: 30_000 });
    await chips(page).getByRole('button', { name: /^Groups/ }).click({ timeout: 30_000 });
}

async function fits(page, where, wide) {
    const m = await page.evaluate(() => {
        const row = document.querySelector('[data-testid="conversation-filter-chips"]');
        const vw = document.documentElement.clientWidth;
        const buttons = row ? Array.from(row.querySelectorAll('button')) : [];
        return {
            over: document.documentElement.scrollWidth - vw,
            chips: buttons.map((b) => b.textContent),
            offScreen: buttons.filter((b) => { const r = b.getBoundingClientRect(); return r.left < 0 || r.right > vw + 0.5; }).map((b) => b.textContent),
            rowScrolls: row ? row.scrollWidth - row.clientWidth : -1,
        };
    });
    check(m.over <= 1, `${where}: no sideways scroll${wide ? '' : ' at 320 px with 1.3x text'}${m.over > 1 ? ` (it scrolls ${m.over}px)` : ''}`);
    check(m.chips.length === 4 && m.offScreen.length === 0 && m.rowScrolls <= 1,
        `${where}: all four chips on screen (${JSON.stringify(m.chips)}${m.offScreen.length ? `, off screen ${JSON.stringify(m.offScreen)}` : ''})`);
}

async function shot(page, name) {
    if (!SHOTS) return;
    await page.screenshot({ path: path.join(SHOTS, `${name}.png`) }).catch((e) => console.error('shot', name, e?.message));
}

async function main() {
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
    if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });
    const root = fs.mkdtempSync(path.join(TMP, 'bp-gt-check-'));
    const ana = memberIdentity('Ana');
    const ben = memberIdentity('Ben');
    let browser = null;
    let node = null;
    try {
        console.log('Building the web app…');
        await build({ root: PWA_DIR, logLevel: 'warn', build: { outDir: path.join(root, 'public'), emptyOutDir: true } });
        node = await startNode(root, [{ publicKey: ana.publicKey, callsign: 'Ana' }, { publicKey: ben.publicKey, callsign: 'Ben' }]);
        browser = await chromium.launch();
        const groupsOf = (pk) => node.ask({ op: 'sql', sql: "SELECT g.name FROM group_members m JOIN groups g ON g.id = m.group_id WHERE m.member_pubkey = ? AND m.status = 'active' ORDER BY g.name", params: [pk], all: true });

        console.log('1. Ana: Groups lists her group, New group makes a second, Find groups opens Commons');
        {
            const { context, page, otherHosts } = await openAs(browser, node, ana, SIZES[0], 'light');
            await page.getByRole('button', { name: /Chat/ }).first().click({ timeout: 30_000 });
            await page.getByText('Garden group', { exact: true }).first().waitFor({ timeout: 30_000 });
            check(await page.getByText('Kofi').first().isVisible(), 'All lists Kofi\'s DM beside the group');
            await chips(page).getByRole('button', { name: /^Groups/ }).click();
            check(await page.getByText('Garden group', { exact: true }).first().isVisible(), 'Groups lists "Garden group"');
            check(!(await page.getByText('Kofi').first().isVisible().catch(() => false)), 'Groups does not list Kofi\'s DM');
            check(await page.getByRole('button', { name: 'Find groups' }).isVisible() && await page.getByRole('button', { name: 'New group' }).isVisible(),
                'the top offers Find groups and New group');
            check(!(await page.getByText('New DM').isVisible().catch(() => false)), 'New DM gives way to them on Groups');

            await page.getByRole('button', { name: 'New group' }).click();
            const dialog = page.getByRole('dialog');
            await dialog.waitFor({ timeout: 10_000 });
            await shot(page, 'ana-320-light-new-group-form');
            await dialog.getByPlaceholder(/Garden Crew/).fill('Street choir');
            await dialog.getByRole('button', { name: /Create Group/ }).click();
            await page.getByPlaceholder('Message...').waitFor({ timeout: 30_000 });
            check(await page.getByText('Street choir').first().isVisible(), 'the new group opens straight into its chat');
            const mine = (await groupsOf(ana.publicKey)).map((r) => r.name);
            check(JSON.stringify(mine) === JSON.stringify(['Garden group', 'Street choir']), `the node has Ana in both groups (${JSON.stringify(mine)})`);

            await page.getByRole('button', { name: 'Back to messages' }).click();
            await chips(page).getByRole('button', { name: /^Groups/ }).click();
            await page.getByText('Street choir', { exact: true }).first().waitFor({ timeout: 30_000 });
            check(await page.getByText('Garden group', { exact: true }).first().isVisible(), 'back on Groups, both her groups are listed');

            await page.getByRole('button', { name: 'Find groups' }).click();
            await page.getByTestId('commons-section-tabs').waitFor({ timeout: 30_000 });
            check(true, 'Find groups opens Commons');
            check(otherHosts.size === 0 || [...otherHosts].every((h) => h.endsWith('googleapis.com') || h.endsWith('gstatic.com')),
                `no request left this machine but the shipped fonts link (aborted: ${JSON.stringify([...otherHosts])})`);
            await context.close();
        }

        console.log('2 + 3. Ana (2 groups) and Ben (none) at 320 px with 1.3x text and at 1280 px, light and dark');
        for (const theme of ['light', 'dark']) {
            for (const size of SIZES) {
                for (const [who, identity] of [['ana', ana], ['ben', ben]]) {
                    const { context, page } = await openAs(browser, node, identity, size, theme);
                    await openGroups(page);
                    if (who === 'ana') {
                        await page.getByText('Street choir', { exact: true }).first().waitFor({ timeout: 30_000 });
                    } else {
                        await page.getByTestId('groups-empty').waitFor({ timeout: 30_000 });
                        if (theme === 'light' && size.name === '320') {
                            const empty = page.getByTestId('groups-empty');
                            check(await empty.getByText('No groups yet').isVisible(), 'Ben: "No groups yet"');
                            check(await empty.getByText(/A group is a chat for some people/).isVisible(), 'Ben: says what a group is');
                            check(await empty.getByRole('button', { name: 'New group' }).isVisible()
                                && await empty.getByRole('button', { name: 'Find a group to join →' }).isVisible(), 'Ben: offers New group and Find a group to join');
                        }
                    }
                    const isDark = await page.evaluate(() => document.documentElement.classList.contains('dark'));
                    check(isDark === (theme === 'dark'), `${who} ${size.name} ${theme}: the page is in ${theme}`);
                    await fits(page, `${who} ${size.name} ${theme}`, size.name !== '320');
                    await shot(page, `${who}-${size.name}-${theme}-groups`);
                    await context.close();
                }
            }
        }
    } finally {
        await browser?.close();
        if (failures.length && node) console.error(node.log.slice(-20).join('\n'));
        await node?.stop();
        fs.rmSync(root, { recursive: true, force: true });
    }
    if (failures.length) {
        console.error(`\n${failures.length} check(s) failed`);
        process.exit(1);
    }
    console.log('\nAll checks passed');
}

main().catch((e) => { console.error(e); process.exit(1); });
