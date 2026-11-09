/**
 * The web proof for the Riverbend demo node (DESIGN-app-screenshots-fable.md §2, lane L1): Home and Market of the web app, as
 * Sam, in light and dark at 390 px and 320 px, against the seeded node. The question it answers is a look, not a number: does
 * the Market read like a real small town? The pictures go to PROOF_OUT (default: scratch/store-shots/l1-proof in the
 * worktree, never committed); look at each one.
 *
 * The pattern is apps/pwa/e2e/home-check.mjs: the web app built as it ships, served by the real node (here demo-node.ts),
 * driven in headless Chromium with Sam's key put where the web app keeps it. Nothing leaves this machine: Chromium may reach
 * localhost only (every other request is aborted and counted), and the node's own guard logs any BLOCKED-FETCH.
 *
 * Run (no lock held by anyone else): node apps/native/e2e/demo/web-proof.mjs
 * Needs Chromium for Playwright once: pnpm --filter @beanpool/pwa exec playwright install --only-shell chromium
 */
/* global document, localStorage, indexedDB, window, process, console, setTimeout, Buffer, URL -- Node, and the page's side of evaluate() */
import { execFileSync, spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '../../../..');
const PWA_DIR = path.join(REPO, 'apps/pwa');
const SERVER_DIR = path.join(REPO, 'apps/server');
const OUT = process.env.PROOF_OUT || path.join(REPO, 'scratch/store-shots/l1-proof');
const requireFromPwa = createRequire(path.join(PWA_DIR, 'package.json'));
const { chromium } = requireFromPwa('playwright');
const riverbend = JSON.parse(fs.readFileSync(path.join(HERE, 'riverbend.json'), 'utf8'));

const sha256 = (b) => crypto.createHash('sha256').update(b).digest();
/** Sam's key as the web app keeps it (identity.ts): hex public key, hex PKCS8 private key, from the 12 words as the apps derive them. */
function samIdentity() {
    const seed = sha256(sha256(riverbend.sam.words.join(' ')));
    const priv = crypto.createPrivateKey({ key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), seed]), format: 'der', type: 'pkcs8' });
    return {
        publicKey: crypto.createPublicKey(priv).export({ type: 'spki', format: 'der' }).subarray(-32).toString('hex'),
        privateKey: priv.export({ type: 'pkcs8', format: 'der' }).toString('hex'),
        callsign: riverbend.sam.callsign,
        createdAt: new Date().toISOString(),
    };
}

async function startNode(root) {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bp-demo-proof-data-'));
    const child = spawn(process.execPath, ['--import', 'tsx', path.join(HERE, 'demo-node.ts')], {
        cwd: SERVER_DIR, env: { ...process.env, BEANPOOL_DATA_DIR: dataDir, FIXTURE_ROOT: root }, stdio: ['pipe', 'pipe', 'pipe'],
    });
    const log = [];
    const waiting = new Map();
    const ready = new Promise((resolve, reject) => {
        child.on('exit', (code) => reject(new Error(`the node exited (${code}) before it was ready:\n${log.slice(-30).join('\n')}`)));
        readline.createInterface({ input: child.stdout }).on('line', (l) => {
            if (l.startsWith('FIXTURE_READY ')) resolve(JSON.parse(l.slice(14)));
            else if (l.startsWith('FIXTURE_ANSWER ')) { const a = JSON.parse(l.slice(15)); waiting.get(a.id)?.(a); waiting.delete(a.id); } else log.push(l);
        });
        readline.createInterface({ input: child.stderr }).on('line', (l) => log.push(l));
    });
    const { port } = await ready;
    let n = 0;
    const ask = (req) => new Promise((resolve, reject) => {
        const id = ++n;
        waiting.set(id, (a) => (a.ok ? resolve(a.result) : reject(new Error(`node: ${a.error}`))));
        child.stdin.write(`${JSON.stringify({ id, ...req })}\n`);
    });
    const stop = async () => {
        child.removeAllListeners('exit');
        child.kill('SIGTERM');
        await new Promise((r) => setTimeout(r, 300));
        if (child.exitCode === null) child.kill('SIGKILL');
        fs.rmSync(dataDir, { recursive: true, force: true });
    };
    return { origin: `https://localhost:${port}`, log, stop, ask };
}

async function putIdentity(page, origin, identity) {
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

async function main() {
    fs.mkdirSync(OUT, { recursive: true });
    // PROOF_ROOT: a folder that already holds public/ (a web build from an earlier run): the build is skipped.
    const root = process.env.PROOF_ROOT || fs.mkdtempSync(path.join(os.tmpdir(), 'bp-demo-proof-'));
    let browser;
    let node;
    const offHost = new Set();
    const problems = [];
    try {
        if (!fs.existsSync(path.join(root, 'public', 'index.html'))) {
            console.log('Building the web app as it ships…');
            try {
                execFileSync('pnpm', ['--filter', '@beanpool/pwa', 'exec', 'vite', 'build', '--outDir', path.join(root, 'public'), '--emptyOutDir', '--logLevel', 'error'], { cwd: REPO, stdio: 'pipe', maxBuffer: 64 * 1024 * 1024 });
            } catch (e) {
                throw new Error(`the web build failed:\n${String(e.stderr || e.stdout || e).slice(-1500)}`);
            }
        }
        node = await startNode(root);
        browser = await chromium.launch();
        const sam = samIdentity();
        for (const dark of [false, true]) {
            for (const [width, height] of [[390, 844], [320, 720]]) {
                const tag = `${dark ? 'dark' : 'light'}-${width}`;
                await node.ask({ op: 'resetLimits' }); // the gateway's limiter counts every page's polling: start each look afresh
                const context = await browser.newContext({ viewport: { width, height }, ignoreHTTPSErrors: true, reducedMotion: 'reduce', deviceScaleFactor: 1 });
                await context.addInitScript(([mode]) => {
                    try {
                        localStorage.setItem('beanpool-theme-mode', mode);
                        localStorage.setItem('beanpool-theme-default-light-v1', 'done');
                        localStorage.setItem('beanpool-install-dismissed-forever', '1');
                    } catch { /* none */ }
                }, [dark ? 'dark' : 'light']);
                await context.route((url) => url.hostname !== 'localhost', (route) => { offHost.add(new URL(route.request().url()).hostname); return route.abort(); });
                const page = await context.newPage();
                // The node's certificate is its own, so the browser refuses its service worker: the harness, not the app.
                page.on('pageerror', (e) => { if (!/Failed to register a ServiceWorker/.test(String(e))) problems.push(`${tag}: page error ${String(e).slice(0, 160)}`); });
                await putIdentity(page, node.origin, sam);
                await node.ask({ op: 'resetLimits' });
                await page.goto(`${node.origin}/app`, { waitUntil: 'load' });
                try {
                    await page.getByTestId('home-card-community').waitFor({ timeout: 30_000 });
                } catch {
                    await page.screenshot({ path: path.join(OUT, `debug-${tag}.png`) });
                    const text = await page.evaluate(() => document.body.innerText.slice(0, 600));
                    throw new Error(`Home did not draw (${tag}); the page says: ${text.replace(/\s+/g, ' ')}`);
                }
                await page.waitForTimeout(1200);
                await page.screenshot({ path: path.join(OUT, `home-${tag}.png`) });
                // Further down Home: the cards under the first screen, each brought to the top by name.
                for (const [n, card] of [[2, 'home-card-decide'], [3, 'home-card-events'], [4, 'home-card-market'], [5, 'home-card-chat-demo']]) {
                    await page.evaluate((id) => document.querySelector(`[data-testid="${id}"]`)?.scrollIntoView({ block: 'start' }), card);
                    await page.waitForTimeout(500);
                    await page.screenshot({ path: path.join(OUT, `home-${tag}-${n}.png`) });
                }
                await page.evaluate(() => window.scrollTo(0, 0));
                await page.locator('[data-testid="mobile-bottom-nav"] button').filter({ hasText: /Market$/ }).click();
                await page.waitForTimeout(2500);
                await page.screenshot({ path: path.join(OUT, `market-${tag}.png`) });
                for (const n of [2, 3]) {
                    await page.evaluate(() => {
                        const scrollers = [document.scrollingElement, ...Array.from(document.querySelectorAll('main, [class*="overflow-y"]'))];
                        for (const s of scrollers) if (s && s.scrollHeight > s.clientHeight + 40) s.scrollBy(0, Math.round(window.innerHeight * 0.85));
                    });
                    await page.waitForTimeout(600);
                    await page.screenshot({ path: path.join(OUT, `market-${tag}-${n}.png`) });
                }
                await context.close();
            }
        }
        if (offHost.size) problems.push(`the browser tried to reach: ${[...offHost].join(', ')} (aborted)`);
        const blocked = node.log.filter((l) => /BLOCKED-FETCH|BLOCKED-CONNECT/.test(l));
        if (blocked.length) problems.push(`the node's guard refused: ${blocked.join(' | ')}`);
    } finally {
        await browser?.close();
        await node?.stop();
        if (!process.env.PROOF_ROOT) fs.rmSync(root, { recursive: true, force: true });
    }
    console.log(`Pictures: ${OUT}`);
    console.log(problems.length ? `Problems:\n  ${problems.join('\n  ')}` : 'Nothing left this machine (no off-host request, no BLOCKED-FETCH/BLOCKED-CONNECT).');
    if (problems.length) process.exit(1);
}

main().catch((e) => { console.error('❌', e); process.exit(1); });
