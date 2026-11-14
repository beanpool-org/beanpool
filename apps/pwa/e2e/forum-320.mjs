/**
 * The forum on the web (slice F4; DESIGN-forums-fable.md §21 F4 "Playwright at 320 px against a real server: post, reply,
 * report, first look") in headless Chromium at 320 px with 1.3x text, against a REAL node on this machine
 * (e2e/home-node-harness.ts on the global profile: the server's own forum routes, first looks, told stamp, reports and
 * signature middleware). The web app is built as it ships and served by that node. Two members:
 *   Ana, new (joined a day ago): opens Chat → Forum, starts a topic; the sheet that anyone on the web can read it comes first;
 *     her topic waits for a first look (a row in forum_waiting, in no list).
 *   Mo, a moderator: sees "Waiting for a first look (1) ›", says OK; the topic is up; he replies twice (the sheet once only).
 *   Ana: reads his reply, quotes it in hers, and reports it (a report naming the forum post, in abuse_reports).
 * Light for the walk; then Dark for the list, the topic and the new-topic form. Fails on any sideways scroll at 320 px, a
 * button under 44 px in the forum, or a request to any host but this machine.
 *
 * Run (from apps/pwa): node e2e/forum-320.mjs   FORUM_TMP sets where the build and the node's data go (os.tmpdir());
 * FORUM_SHOTS a folder for screenshots. Needs Chromium for Playwright once: pnpm --filter @beanpool/pwa exec playwright install --only-shell chromium
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
const TMP = process.env.FORUM_TMP || os.tmpdir();
const SHOTS = process.env.FORUM_SHOTS || '';
const VIEW = { width: 320, height: 720 };
const LIMIT_S = Number(process.env.FORUM_LIMIT_S || 420);
setTimeout(() => { console.error(`\nStopped after ${LIMIT_S} s, not finished.`); process.exit(2); }, LIMIT_S * 1000).unref();

const failures = [];
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

async function startNode(root, members) {
    const dataDir = fs.mkdtempSync(path.join(TMP, 'bp-forum-data-'));
    const child = spawn(process.execPath, ['--import', 'tsx', '../pwa/e2e/home-node-harness.ts'], {
        cwd: SERVER_DIR,
        env: { ...process.env, BEANPOOL_DATA_DIR: dataDir, FIXTURE_ROOT: root, FIXTURE_PROFILE: 'global', FIXTURE_MEMBERS: JSON.stringify(members) },
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
async function openAs(browser, origin, identity, theme) {
    const context = await browser.newContext({ viewport: VIEW, ignoreHTTPSErrors: true, reducedMotion: 'reduce', colorScheme: theme });
    await context.addInitScript((mode) => {
        try {
            localStorage.setItem('beanpool-theme-mode', mode);
            localStorage.setItem('beanpool-install-dismissed-forever', '1');
        } catch { /* none */ }
    }, theme);
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

/** The Forum side of the Chat tab, as a member gets there: the tab, then the switch, at 1.3x text. */
async function openForum(page, node) {
    await node.ask({ op: 'resetLimits' });
    await page.goto(`${node.origin}/app`, { waitUntil: 'load' });
    await page.addStyleTag({ content: 'html { font-size: 130% !important; }' });
    // A kept notice opens over the app at load (a moderator's "A first topic is waiting for a look", a writer's answer): a
    // member acknowledges it first, as they would.
    const ack = page.getByRole('button', { name: 'Acknowledge' });
    for (let i = 0; i < 4; i++) {
        if (!(await ack.first().isVisible({ timeout: 2500 }).catch(() => false))) {
            await page.waitForTimeout(1500);
            if (!(await ack.first().isVisible().catch(() => false))) break;
        }
        await ack.first().click();
    }
    try {
        await page.getByRole('button', { name: /Chat$/ }).first().click({ timeout: 30_000 });
    } catch (e) {
        await page.screenshot({ path: path.join(SHOTS || TMP, 'fail-no-chat-tab.png') }).catch(() => {});
        throw e;
    }
    await page.getByRole('tab', { name: 'Forum' }).click({ timeout: 30_000 });
    await page.getByTestId('forum-page').waitFor({ timeout: 30_000 });
}

async function fits(page, where) {
    const r = await page.evaluate(() => {
        const over = document.documentElement.scrollWidth - document.documentElement.clientWidth;
        const scope = document.querySelector('[data-testid="forum-page"], [data-testid="forum-topic"], [data-testid="forum-new-topic"], [data-testid="forum-first-looks"]');
        const small = scope ? Array.from(scope.querySelectorAll('button, select, input:not([type=radio]):not([type=file]), textarea'))
            .filter((el) => el.offsetParent !== null).map((el) => ({ h: el.getBoundingClientRect().height, label: (el.getAttribute('aria-label') || el.textContent || el.tagName).trim().slice(0, 30) }))
            .filter((b) => b.h < 43.5) : [];
        return { over, small };
    });
    check(r.over <= 1, `${where}: no sideways scroll at 320 px with 1.3x text${r.over > 1 ? ` (it scrolls ${r.over}px)` : ''}`);
    check(r.small.length === 0, `${where}: every control is a 44 px target${r.small.length ? ` (${r.small.map((b) => `${b.label} ${Math.round(b.h)}px`).join(', ')})` : ''}`);
}

async function main() {
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
    if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });
    const root = fs.mkdtempSync(path.join(TMP, 'bp-forum-check-'));
    const ana = memberIdentity('Ana');
    const mo = memberIdentity('Mo');
    let browser = null;
    let node = null;
    try {
        console.log('Building the web app…');
        await build({ root: PWA_DIR, logLevel: 'warn', build: { outDir: path.join(root, 'public'), emptyOutDir: true } });
        node = await startNode(root, [{ publicKey: ana.publicKey, callsign: 'Ana', joinedDaysAgo: 1 }, { publicKey: mo.publicKey, callsign: 'Mo', joinedDaysAgo: 60 }]);
        await node.sql("INSERT INTO node_roles (member_pubkey, role, granted_by) VALUES (?, 'moderator', 'e2e')", [mo.publicKey], false);
        browser = await chromium.launch();

        console.log('Ana, new: a first topic, after the sheet that anyone on the web can read it');
        const A = await openAs(browser, node.origin, ana, 'light');
        await openForum(A.page, node);
        await fits(A.page, 'the list (Ana)');
        await A.page.getByTestId('forum-new').click();
        await A.page.getByTestId('forum-new-section').selectOption({ label: 'Introduce yourself' });
        await A.page.getByTestId('forum-new-title').fill('Hello from Ana');
        await A.page.getByTestId('forum-new-words').fill('We grow beans near the river. See www.example.org for our garden.');
        check(await A.page.getByTestId('forum-first-look-note').isVisible(), 'a new member reads that a moderator looks first');
        await fits(A.page, 'the new topic form');
        await shot(A.page, '01-new-topic-light');
        await A.page.getByTestId('forum-new-post').click();
        await A.page.getByTestId('forum-told').waitFor({ timeout: 15_000 });
        await shot(A.page, '02-told-sheet-light');
        await A.page.getByTestId('forum-told-post').click();
        await A.page.getByTestId('forum-mine-waiting').waitFor({ timeout: 15_000 });
        await shot(A.page, '03-waiting-light');
        const held = await node.sql("SELECT state, title FROM forum_waiting WHERE writer_pubkey = ?", [ana.publicKey]);
        check(held.length === 1 && held[0].state === 'waiting', `her topic waits in forum_waiting (${JSON.stringify(held)})`);
        check((await node.sql('SELECT COUNT(*) AS n FROM forum_topics'))[0].n === 0, 'and is in no topic list yet');
        check((await node.sql('SELECT told_public_at FROM forum_members WHERE member_pubkey = ?', [ana.publicKey]))[0]?.told_public_at, 'the node kept the time she agreed');

        console.log('Mo, a moderator: the first look, then a reply');
        const M = await openAs(browser, node.origin, mo, 'light');
        await openForum(M.page, node);
        const row = M.page.getByTestId('forum-first-looks-row');
        await row.waitFor({ timeout: 15_000 });
        check((await row.textContent()).includes('(1)'), 'Mo sees "Waiting for a first look (1) ›"');
        await row.click();
        await M.page.getByTestId('forum-first-look').waitFor();
        check(await M.page.getByTestId('forum-first-look').getByRole('link').count() === 0, "a new writer's link is plain text in the first look");
        await fits(M.page, 'the first looks');
        await shot(M.page, '04-first-look-light');
        await M.page.getByTestId('forum-first-look-ok').click();
        await M.page.getByText('Nothing is waiting. Thank you for looking.').waitFor({ timeout: 15_000 });
        check((await node.sql("SELECT state FROM forum_waiting WHERE writer_pubkey = ?", [ana.publicKey]))[0]?.state === 'ok', 'OK answered it');
        await M.page.getByRole('button', { name: 'Back to the forum' }).click();
        await M.page.getByText('Hello from Ana').click({ timeout: 15_000 });
        await M.page.getByTestId('forum-topic-title').waitFor();
        await M.page.getByTestId('forum-reply-box').fill('Welcome, Ana! Which beans do you grow?');
        await M.page.getByTestId('forum-send').click();
        // His first post on this public forum: the same sheet first, once.
        await M.page.getByTestId('forum-told').waitFor({ timeout: 15_000 });
        check(true, 'his first post on the public forum waits on the sheet too');
        await M.page.getByTestId('forum-told-post').click();
        await M.page.getByTestId('forum-post-2').waitFor({ timeout: 15_000 });
        // A second reply in the same topic goes with no sheet: he agreed once, and the page keeps that (design §5).
        await M.page.getByTestId('forum-reply-box').fill('Mine are climbing ones.');
        await M.page.getByTestId('forum-send').click();
        await M.page.getByTestId('forum-post-3').waitFor({ timeout: 15_000 });
        check(await M.page.getByTestId('forum-told').count() === 0, 'his second reply in the topic goes with no sheet');
        await fits(M.page, 'the topic (Mo)');
        await shot(M.page, '05-topic-reply-light');

        console.log('Ana: reads, quotes and reports');
        await openForum(A.page, node);
        await A.page.getByText('Hello from Ana').click({ timeout: 15_000 });
        await A.page.getByTestId('forum-post-2').waitFor({ timeout: 15_000 });
        check((await A.page.getByTestId('forum-post-2').textContent()).includes('Welcome, Ana!'), "Ana reads Mo's reply");
        await A.page.getByTestId('forum-post-menu-2').click();
        await A.page.getByTestId('forum-menu').getByRole('button', { name: 'Reply' }).click();
        await A.page.getByTestId('forum-reply-box').fill('Runner beans, mostly.');
        await A.page.getByTestId('forum-send').click();
        await A.page.getByTestId('forum-post-4').waitFor({ timeout: 15_000 });
        check((await A.page.getByTestId('forum-post-4').textContent()).includes('Mo: Welcome, Ana!'), 'her reply shows the quote of his');
        check((await node.sql('SELECT quotes FROM forum_posts WHERE number = 4'))[0]?.quotes === 2, 'the node stored the quote');
        await A.page.getByTestId('forum-post-menu-2').click();
        await A.page.getByTestId('forum-menu').getByRole('button', { name: 'Report' }).click();
        await A.page.getByText('Spam or scam').click();
        await shot(A.page, '06-report-light');
        await A.page.getByRole('button', { name: /submit/i }).click();
        await A.page.waitForTimeout(800);
        const reports = await node.sql('SELECT target_forum_post_id AS post, target_pubkey AS who FROM abuse_reports');
        const moPost = (await node.sql('SELECT id FROM forum_posts WHERE number = 2'))[0]?.id;
        check(reports.length === 1 && reports[0].post === moPost && reports[0].who === mo.publicKey, `a report naming his forum post, about him (${JSON.stringify(reports)})`);

        console.log('Dark: the list, the topic, the form');
        const D = await openAs(browser, node.origin, mo, 'dark');
        await openForum(D.page, node);
        await D.page.getByText('Hello from Ana').waitFor({ timeout: 15_000 });
        await fits(D.page, 'the list (dark)');
        await shot(D.page, '07-list-dark');
        await D.page.getByText('Hello from Ana').click();
        await D.page.getByTestId('forum-post-4').waitFor({ timeout: 15_000 });
        await fits(D.page, 'the topic (dark)');
        await shot(D.page, '08-topic-dark');
        await D.page.getByTestId('forum-back').click();
        await D.page.getByTestId('forum-new').click();
        await fits(D.page, 'the new topic form (dark)');
        await shot(D.page, '09-new-topic-dark');
        check(otherHosts.size === 0 || [...otherHosts].every((h) => h === 'fonts.googleapis.com' || h === 'fonts.gstatic.com'), `no request left this machine (${[...otherHosts].join(', ')})`);
    } catch (e) {
        failures.push(String(e?.stack || e));
        console.error(e);
        if (node) console.error(node.log.slice(-25).join('\n'));
    } finally {
        await browser?.close().catch(() => {});
        await node?.stop().catch(() => {});
        fs.rmSync(root, { recursive: true, force: true });
    }
    console.log(failures.length ? `\n${failures.length} failed` : '\nAll forum checks passed.');
    process.exit(failures.length ? 1 : 0);
}

await main();
