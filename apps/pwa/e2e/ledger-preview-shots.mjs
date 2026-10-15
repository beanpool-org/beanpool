/**
 * The Ledger in preview in the REAL web app (scratch/global-node/DESIGN-global-showcase-fable.md §1 row 3): a member of a
 * global node (showcase on, Beans off) opens the Ledger and gets the member's real screen drawn from Example Valley, the
 * header, the credit bar, Levels and Wallet; and a member of a local node gets their own Ledger, unchanged. Built and
 * served by a real node on this machine (e2e/home-node-harness.ts), signed in, in headless Chromium: at 320 px with 1.3x
 * text and at 1280 px, light and dark. Pictures are cut into parts no taller than 1,400 px.
 *
 * Fails on a sideways scroll at 320 px, a marker that looks locked, a showcase control under 44 x 44 px, any request
 * about the reader's own ledger (balance, transactions, members, export) from the preview, or any write.
 *
 * The Wallet's Community Circulation box (fix round 1): in the preview (85 Beans) a sentence that nothing goes to the
 * Commons; on the local node (Ana holds 750) the month's amount and share; in both themes a card of the page's own tone,
 * never a bright box on the dark page.
 *
 * Run: node e2e/ledger-preview-shots.mjs   (LEDGER_SHOTS: where the pictures go; LEDGER_WHEN=before: the local node only,
 * for a build of main's sources; LEDGER_SUFFIX: added to every picture's name, e.g. -fix1)
 */
/* global URL, console, process, setTimeout, document, window, indexedDB, localStorage, getComputedStyle, HTMLButtonElement, Element -- Node, and the page's side of evaluate() */
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

const SHOTS_DIR = process.env.LEDGER_SHOTS || path.join(os.tmpdir(), 'bp-ledger-preview-shots');
/** 'after' (this branch: the global preview and a local ledger) or 'before' (a build of main's sources: the local ledger only). */
const WHEN = process.env.LEDGER_WHEN === 'before' ? 'before' : 'after';
const VIEW = { width: 320, height: 720 };
const TEXT_SCALE = 1.3;
const SUFFIX = process.env.LEDGER_SUFFIX || '';
/** The local member's Beans: over 300, so the Circulation box shows a month's amount. */
const LOCAL_BALANCE = 750;

const failures = [];
function check(ok, what) {
    if (ok) console.log(`  ✓ ${what}`);
    else { failures.push(what); console.error(`  ✗ ${what}`); }
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/** A real Ed25519 key in the shape the web app keeps it (identity.ts). */
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
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), `bp-showcase-${profile}-data-`));
    const child = spawn(process.execPath, ['--import', 'tsx', '../pwa/e2e/home-node-harness.ts'], {
        cwd: SERVER_DIR,
        env: { ...process.env, BEANPOOL_DATA_DIR: dataDir, FIXTURE_ROOT: root, FIXTURE_PROFILE: profile, FIXTURE_MEMBERS: JSON.stringify(members) },
        stdio: ['pipe', 'pipe', 'pipe'],
    });
    console.log(`  (node PID ${child.pid})`);
    const log = [];
    let ready;
    const readyAt = new Promise((resolve, reject) => {
        ready = resolve;
        child.on('exit', (code) => reject(new Error(`the node exited (${code}) before it was ready:\n${log.slice(-30).join('\n')}`)));
    });
    readline.createInterface({ input: child.stdout }).on('line', (line) => {
        if (line.startsWith('FIXTURE_READY ')) ready(JSON.parse(line.slice('FIXTURE_READY '.length)));
        else log.push(line);
    });
    readline.createInterface({ input: child.stderr }).on('line', (line) => log.push(line));
    const { port } = await readyAt;
    const stop = async () => {
        child.kill('SIGTERM');
        await wait(300);
        if (child.exitCode === null) child.kill('SIGKILL');
        fs.rmSync(dataDir, { recursive: true, force: true });
    };
    return { port, log, stop, origin: `https://localhost:${port}` };
}

/** Every request the page makes: method, where, and its body, for the net spy. */
function spy(page) {
    const all = [];
    page.on('request', (r) => {
        all.push({ at: Date.now(), method: r.method(), url: r.url(), body: r.postData() ?? '' });
    });
    return { since: (t) => all.filter((r) => r.at >= t) };
}

async function openContext(browser, origin, identity, dark) {
    const context = await browser.newContext({ viewport: VIEW, ignoreHTTPSErrors: true, reducedMotion: 'reduce' });
    const offHost = new Set();
    await context.addInitScript((mode) => {
        try {
            localStorage.setItem('beanpool-theme-mode', mode);
            localStorage.setItem('beanpool-theme-default-light-v1', 'done');
            localStorage.setItem('beanpool-install-dismissed-forever', '1');
        } catch { /* none */ }
    }, dark ? 'dark' : 'light');
    await context.route((url) => url.hostname !== 'localhost', (route) => {
        offHost.add(new URL(route.request().url()).hostname);
        return route.abort();
    });
    const page = await context.newPage();
    const net = spy(page);
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
    await page.addStyleTag({ content: `html { font-size: ${TEXT_SCALE * 100}% !important; }` });
    return { context, page, net, offHost };
}

async function noSideScroll(page, where) {
    const over = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    check(over <= 1, `${where}: no sideways scroll at 320 px with 1.3x text${over > 1 ? ` (it scrolls ${over}px)` : ''}`);
}

async function shot(page, name) {
    fs.mkdirSync(SHOTS_DIR, { recursive: true });
    await page.screenshot({ path: path.join(SHOTS_DIR, `${name}.png`) });
}

/** No marker on the page in a locked, greyed, dimmed or tier style. */
async function markersNeverLocked(page, where) {
    const bad = await page.evaluate(() => Array.from(document.querySelectorAll('[data-testid^="local-community-"]'))
        .filter((el) => el.getClientRects().length > 0)
        .map((el) => ({ el, cs: getComputedStyle(el) }))
        .filter(({ el, cs }) => /🔒|locked|needs \d|tier/i.test(el.textContent || '') || Number(cs.opacity) < 1
            || (el instanceof HTMLButtonElement && el.disabled) || /grayscale/.test(cs.filter))
        .map(({ el }) => (el.textContent || '').trim().slice(0, 40)));
    check(bad.length === 0, `${where}: no marker looks locked, greyed or dimmed${bad.length ? ` (${bad.join('; ')})` : ''}`);
}

/** Every control the showcase draws (previews, markers, the sheet, the Start screen, My Deals' preview) is 44 x 44 px or more. */
async function targetsAtLeast44(page, where) {
    const small = await page.evaluate(() => {
        const ours = '[data-testid$="-preview"], [data-testid^="local-community-"], [data-testid="start-community-screen"], [role="dialog"][aria-label="My Deals"]';
        return Array.from(document.querySelectorAll('button, a[href], [role="button"], input, select, textarea'))
            .filter((el) => el instanceof Element && (el.matches(ours) || el.closest(ours)) && el.getClientRects().length > 0)
            .map((el) => ({ el, r: el.getBoundingClientRect() }))
            .filter(({ r }) => r.width < 43.5 || r.height < 43.5)
            .map(({ el, r }) => `"${(el.getAttribute('aria-label') || el.textContent || '').trim().slice(0, 30)}" ${Math.round(r.width)}x${Math.round(r.height)}`);
    });
    check(small.length === 0, `${where}: every control is at least 44 x 44 px${small.length ? ` (${small.join('; ')})` : ''}`);
}

/**
 * The Wallet's Community Circulation box: its words (`want`) and, in dark, a deep ground (relative luminance under 0.1)
 * rather than a bright tint; in light a pale one. Its colours come from the chip roles, so no inline colour either.
 */
async function circulationBox(page, where, dark, want) {
    const box = page.getByTestId('ledger-circulation');
    const text = (await box.innerText()).replace(/\s+/g, ' ');
    check(want.every((w) => (w instanceof RegExp ? w.test(text) : text.includes(w))), `${where}: Circulation box reads "${text}"`);
    const { lum, inline } = await box.evaluate((el) => {
        const [r, g, b] = getComputedStyle(el).backgroundColor.match(/\d+(\.\d+)?/g).slice(0, 3).map(Number)
            .map((c) => { const s = c / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; });
        return { lum: 0.2126 * r + 0.7152 * g + 0.0722 * b, inline: [el, ...el.querySelectorAll('*')].some((e) => /color|background/.test(e.getAttribute('style') || '')) };
    });
    check(dark ? lum < 0.1 : lum > 0.5, `${where}: Circulation box ground fits the ${dark ? 'dark' : 'light'} page (luminance ${lum.toFixed(3)})`);
    check(!inline, `${where}: Circulation box has no inline colour`);
}

async function tab(page, label) {
    await page.locator('[data-testid="mobile-bottom-nav"] button', { hasText: label }).first().click();
}


/** The page in parts no taller than 1,400 px: the app scrolls inside <main>, so each part is the window after a scroll. */
async function shots(page, name, width) {
    fs.mkdirSync(SHOTS_DIR, { recursive: true });
    await page.setViewportSize({ width, height: 1400 });
    await wait(400);
    const scroller = await page.evaluateHandle(() => {
        const main = document.querySelector('main');
        return main && main.scrollHeight > main.clientHeight + 4 ? main : document.scrollingElement;
    });
    await scroller.evaluate((el) => { el.scrollTop = 0; });
    const total = await scroller.evaluate((el) => el.scrollHeight);
    const step = 1200;
    let part = 1;
    for (let top = 0; top < total && part <= 4; top += step, part++) {
        await scroller.evaluate((el, y) => { el.scrollTop = y; }, top);
        await wait(250);
        await page.screenshot({ path: path.join(SHOTS_DIR, `${name}-${part}${SUFFIX}.png`) });
        const at = await scroller.evaluate((el) => el.scrollTop);
        if (at + 1400 >= total) break;
    }
    await scroller.evaluate((el) => { el.scrollTop = 0; });
    await page.setViewportSize(VIEW);
    await wait(300);
}

const OWN_LEDGER = /\/api\/(ledger|members|repay|community\/members)/;

async function globalMember(browser, root, dark) {
    const scheme = dark ? 'dark' : 'light';
    const rua = memberIdentity('Rua');
    const node = await startNode(root, 'global', [{ publicKey: rua.publicKey, callsign: 'Rua', joinedDaysAgo: 1, avatar: true }]);
    console.log(`\nA member of a global node (showcase on), ${scheme}, on ${node.origin}:`);
    const { context, page, net } = await openContext(browser, node.origin, rua, dark);
    try {
        await page.getByTestId('mobile-bottom-nav').waitFor({ timeout: 30_000 });
        await wait(4_000);
        const t0 = Date.now();
        await tab(page, 'Ledger');
        await page.getByTestId('ledger-preview').waitFor({ timeout: 10_000 });
        await wait(1_500);
        const text = await page.getByTestId('ledger-preview').innerText();
        check(/an example member/.test(text) && /\+85\.0B/.test(text), 'Ledger: Example Valley\'s example member, +85.0B');
        check(/Level 2 of 4 · 200 trust/.test(text), 'Levels: Level 2 of 4 · 200 trust');
        check(!/Rua/.test(text), 'the reader\'s own name never shows');
        check(await page.getByTestId('levels-shelf').locator('button').count() === 4, 'Levels: the four tiles');
        await noSideScroll(page, 'Ledger preview, Levels');
        await targetsAtLeast44(page, 'Ledger preview, Levels');
        await markersNeverLocked(page, 'Ledger preview, Levels');
        await shots(page, `global-levels-320-${scheme}`, 320);
        await page.getByRole('button', { name: /Wallet/ }).click();
        await page.getByTestId('ledger-wallet').waitFor();
        const wallet = await page.getByTestId('ledger-wallet').innerText();
        check(/A loaf of bread/.test(wallet) && /FROM A NEIGHBOUR · YESTERDAY/i.test(wallet), 'Wallet: the sample rows, who and when');
        await circulationBox(page, 'Ledger preview, Wallet', dark, ['Nothing goes to the Commons while you hold 200 Beans or less.']);
        check(!/0\.00|%/.test(await page.getByTestId('ledger-circulation').innerText()), 'Ledger preview, Wallet: no zero amount or rate under the line');
        await noSideScroll(page, 'Ledger preview, Wallet');
        await targetsAtLeast44(page, 'Ledger preview, Wallet');
        await markersNeverLocked(page, 'Ledger preview, Wallet');
        await shots(page, `global-wallet-320-${scheme}`, 320);
        await page.getByRole('button', { name: /Send Beans/ }).click();
        await page.getByTestId('local-community-sheet').waitFor();
        await shots(page, `global-wallet-send-sheet-320-${scheme}`, 320);
        await page.getByTestId('local-community-sheet').getByRole('button', { name: 'Close' }).click();
        await page.getByRole('button', { name: /Export mine/ }).click();
        await page.getByTestId('local-community-sheet').waitFor();
        await page.getByTestId('local-community-sheet').getByRole('button', { name: 'Close' }).click();
        // Wide: 1280 px, both tabs (text at 100%: the browser's default).
        await page.evaluate(() => { for (const s of document.querySelectorAll('style')) if (/font-size: 130%/.test(s.textContent || '')) s.remove(); });
        await shots(page, `global-wallet-1280-${scheme}`, 1280);
        await page.getByRole('button', { name: /Levels/ }).click();
        await shots(page, `global-levels-1280-${scheme}`, 1280);

        const sent = net.since(t0);
        const own = sent.filter((r) => OWN_LEDGER.test(new URL(r.url).pathname)).map((r) => `${r.method} ${new URL(r.url).pathname}`);
        check(own.length === 0, `the preview asked nothing about the reader's own ledger${own.length ? ` (${own.join(', ')})` : ''}`);
        const writes = sent.filter((r) => !['GET', 'HEAD', 'OPTIONS'].includes(r.method)).map((r) => `${r.method} ${new URL(r.url).pathname}`);
        check(writes.length === 0, `nothing written${writes.length ? ` (${writes.join(', ')})` : ''}`);
        console.log(`  (requests while on the Ledger: ${[...new Set(sent.map((r) => new URL(r.url).pathname))].join(', ') || 'none'})`);
    } finally {
        await context.close();
        await node.stop();
    }
}

async function localMember(browser, root, dark) {
    const scheme = dark ? 'dark' : 'light';
    const ana = memberIdentity('Ana');
    const node = await startNode(root, 'local', [{ publicKey: ana.publicKey, callsign: 'Ana', joinedDaysAgo: 30, balance: LOCAL_BALANCE }]);
    console.log(`\nA member of a local node (Beans live), ${scheme}, ${WHEN}, on ${node.origin}:`);
    const { context, page } = await openContext(browser, node.origin, ana, dark);
    try {
        await page.getByTestId('mobile-bottom-nav').waitFor({ timeout: 30_000 });
        await wait(3_000);
        await tab(page, 'Ledger');
        await wait(3_000);
        check(await page.getByTestId('ledger-preview').count() === 0 && await page.getByTestId('local-community-strip').count() === 0, 'Ledger: the real one, no strip');
        check(/Ana/.test(await page.locator('main').innerText()), 'Ledger: the member\'s own name');
        await shots(page, `local-levels-320-${scheme}-${WHEN}`, 320);
        await page.getByRole('button', { name: /Wallet/ }).click();
        await wait(800);
        if (WHEN === 'after') {
            // 750: 300 at 1 % + 250 at 1.5 % = 6.75 a month, 0.90 % of the balance.
            await circulationBox(page, 'Local Ledger, Wallet', dark, ['−6.75', 'about 0.90% of your balance']);
            await noSideScroll(page, 'Local Ledger, Wallet');
        }
        await shots(page, `local-wallet-320-${scheme}-${WHEN}`, 320);
        await page.evaluate(() => { for (const s of document.querySelectorAll('style')) if (/font-size: 130%/.test(s.textContent || '')) s.remove(); });
        await shots(page, `local-wallet-1280-${scheme}-${WHEN}`, 1280);
    } finally {
        await context.close();
        await node.stop();
    }
}

async function main() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bp-ledger-preview-'));
    let browser;
    try {
        await build({ root: PWA_DIR, logLevel: 'warn', build: { outDir: path.join(root, 'public'), emptyOutDir: true } });
        browser = await chromium.launch();
        console.log(`The web app as built (${WHEN}); one Chromium, reduced motion.`);
        const runs = WHEN === 'before'
            ? [() => localMember(browser, root, false)]
            : [() => globalMember(browser, root, false), () => globalMember(browser, root, true), () => localMember(browser, root, false), () => localMember(browser, root, true)];
        for (const run of runs) {
            try {
                await run();
            } catch (e) {
                failures.push(String(e?.stack || e));
                console.error(`  ✗ ${e?.stack || e}`);
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
    console.log('\n⭐️ The Ledger in preview holds in the real web app against real nodes.');
}

main().catch((e) => { console.error('❌', e); process.exit(1); });
