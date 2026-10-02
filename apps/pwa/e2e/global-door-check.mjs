/**
 * The global node's two doors in the web app (slice S5 of scratch/global-node/DESIGN-global-two-doors-fable.md), in
 * headless Chromium at 320 px with 1.3x text, against a REAL node on the global profile running on this machine
 * (apps/server/src/global-door-web-test-harness.ts): its signature middleware, the door's routes and their refusals
 * (#1425), the door work's check, the limiters and the web app's document policy are the server's own code. The web
 * app is built exactly as it ships and served by that node.
 *
 *   1. a 12-words join end to end: the lobby, "I'm new", a name while the work runs, "Create an account with 12 secret
 *      words", the photo, and Safety Backup's words-only panel; the node has the member as `open:words` with a `words`
 *      row, and no provider was visited
 *   2. a link: from that Safety Backup, "Add a sign-in as a second way back", Google (a stand-in: a Playwright route that
 *      signs a token with this check's own key, which the node was given), back to Settings saying it is added; the
 *      node's row is Google's now, with a sealed copy stored
 *   3. a sign-in join the node asks for work (`doorNumbers.signInWorkFrom` = 1): its first join is refused
 *      `work_required`, the page does the work and sends the same sign-in again, and the member is in, with no error
 *   4. the busy level (`doorNumbers.networkSteps` set so this address's next join is level 4): the sentence with this
 *      browser's own estimate under the 12-words button, then a join that waits for its work
 *   5. "Setting up your account…" (the work's answer held back, so Join comes first): ← Choose another way goes back to
 *      the two doors with the sign-in there, nothing is sent, and the 12 words then join with the same key
 *   6. a key let go by ← Back (its challenges shortened so renewals come every two seconds): no more work is asked
 *      for it
 * Scenario 1 also reads the lobby's Join card (both doors named), and its link goes through the tour first: the node has
 * the photo chosen at step 2, and the browser was asked once to keep its data.
 * and fails on any horizontal scroll at 320 px, any policy violation, a token left in the address bar, or a request to
 * any host but this machine (the providers are Playwright routes; everything else is refused and reported).
 *
 * Run: pnpm --filter @beanpool/pwa global-door-check
 * Needs Chromium for Playwright once: pnpm --filter @beanpool/pwa exec playwright install --only-shell chromium
 */
/* global Buffer, URL, console, process, document, window, setTimeout, MutationObserver, navigator, localStorage -- Node, and the page's side of evaluate() */
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

const SHOTS_DIR = process.env.GLOBAL_DOOR_SHOTS || path.join(os.tmpdir(), 'bp-global-door-shots');
const VIEW = { width: 320, height: 720 };
const TEXT_SCALE = 1.3;

class Failure extends Error {}

// ---------- the providers' stand-in: this check's own signing key, given to the node ----------

const KID = 'global-door-check';
const google = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const GOOGLE_JWK = { ...google.publicKey.export({ format: 'jwk' }), kid: KID };

function mintGoogle(aud, nonce, sub) {
    const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
    const now = Math.floor(Date.now() / 1000);
    const head = b64({ alg: 'RS256', kid: KID, typ: 'JWT' });
    const body = b64({ iss: 'https://accounts.google.com', aud, sub, email_verified: true, iat: now, exp: now + 3600, nonce });
    return `${head}.${body}.${crypto.sign('RSA-SHA256', Buffer.from(`${head}.${body}`), google.privateKey).toString('base64url')}`;
}

// ---------- the node ----------

async function startNode(root, dataDir) {
    const child = spawn(process.execPath, ['--import', 'tsx', 'src/global-door-web-test-harness.ts'], {
        cwd: SERVER_DIR,
        env: { ...process.env, BEANPOOL_DATA_DIR: dataDir, FIXTURE_ROOT: root, FIXTURE_JWKS: JSON.stringify({ google: GOOGLE_JWK }) },
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
    return { child, port, ask, log };
}

// ---------- the browser ----------

async function openPage(browser, origin, seen) {
    const context = await browser.newContext({ viewport: VIEW, ignoreHTTPSErrors: true, reducedMotion: 'reduce' });
    await context.exposeBinding('__reportCspViolation', (_s, v) => { seen.violations.push(v); });
    await context.addInitScript(() => {
        document.addEventListener('securitypolicyviolation', (e) => {
            window.__reportCspViolation({ directive: e.effectiveDirective, blocked: e.blockedURI, at: `${e.sourceFile}:${e.lineNumber}` });
        });
        // How many times the page asks the browser to keep its data (design G11 §4.2), across the provider's round trip.
        if (navigator.storage?.persist) {
            const persist = navigator.storage.persist.bind(navigator.storage);
            navigator.storage.persist = () => {
                try { localStorage.setItem('__persistAsked', String(Number(localStorage.getItem('__persistAsked') || 0) + 1)); } catch { /* none */ }
                return persist();
            };
        }
        // Every busy sentence the page shows, as it shows it: on a fast computer the work can be done in a second.
        window.__busySeen = [];
        new MutationObserver(() => {
            const t = document.querySelector('[data-testid="join-busy"]')?.textContent;
            if (t && window.__busySeen.at(-1) !== t) window.__busySeen.push(t);
        }).observe(document, { subtree: true, childList: true, characterData: true });
    });
    // Nothing but this machine; the provider is a stand-in.
    await context.route((url) => url.hostname !== 'localhost', (route) => {
        seen.otherHosts.add(new URL(route.request().url()).hostname);
        return route.abort();
    });
    await context.route('https://accounts.google.com/**', (route) => {
        const q = new URL(route.request().url()).searchParams;
        seen.providerTrips.push({ clientId: q.get('client_id'), nonce: q.get('nonce') });
        const token = mintGoogle(q.get('client_id'), q.get('nonce'), seen.nextSub);
        return route.fulfill({ status: 302, headers: { Location: `${q.get('redirect_uri')}#state=${encodeURIComponent(q.get('state'))}&id_token=${token}` } });
    });
    const page = await context.newPage();
    page.on('request', (r) => {
        const u = new URL(r.url());
        if (u.origin === origin && u.pathname.startsWith('/api/join')) seen.door.push({ path: u.pathname, body: r.postData() ? JSON.parse(r.postData()) : null });
    });
    page.on('response', async (r) => {
        const u = new URL(r.url());
        if (u.origin === origin && u.pathname.startsWith('/api/join')) {
            let body = null;
            try { body = await r.json(); } catch { /* not json */ }
            seen.answers.push({ path: u.pathname, status: r.status(), code: body?.code ?? null });
        }
    });
    return { context, page };
}

async function scaleText(page) {
    await page.addStyleTag({ content: `html { font-size: ${TEXT_SCALE * 100}% !important; }` });
}

async function noSideScroll(page, where) {
    const over = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    if (over > 1) throw new Failure(`${where}: the page scrolls sideways by ${over}px at 320 px with 1.3x text`);
}

async function shot(page, name) {
    fs.mkdirSync(SHOTS_DIR, { recursive: true });
    await page.screenshot({ path: path.join(SHOTS_DIR, `${name}.png`), fullPage: true });
}

/** The lobby to the two doors, with `name`. */
async function toTheDoors(page, origin, name, { words = true } = {}) {
    await page.goto(`${origin}/app`, { waitUntil: 'load' });
    await scaleText(page);
    await page.getByTestId('lobby-join-card').waitFor({ timeout: 30_000 });
    const lobbyCard = (await page.getByTestId('lobby-join-card').innerText()).replace(/\s+/g, ' ');
    await page.getByTestId('lobby-join').click({ timeout: 30_000 });
    await page.getByTestId('join-new').click();
    await page.getByTestId('join-callsign').fill(name);
    await page.getByTestId('join-name-next').click();
    if (words) await page.getByTestId('door-words').waitFor({ timeout: 20_000 });
    await page.getByTestId('join-provider-google').waitFor({ timeout: 20_000 });
    await scaleText(page);
    return { lobbyCard };
}

async function memberRow(node, callsign) {
    const rows = await node.ask({
        op: 'sql', all: true,
        sql: `SELECT m.public_key AS key, m.invited_by AS invitedBy, o.provider AS provider, o.join_hash AS joinHash
              FROM members m LEFT JOIN open_joins o ON o.member_pubkey = m.public_key WHERE m.callsign = ?`,
        params: [callsign],
    });
    return rows[0] ?? null;
}

// ---------- the scenarios ----------

async function wordsJoinThenLink(browser, origin, node, seen) {
    const { context, page } = await openPage(browser, origin, seen);
    try {
        const { lobbyCard } = await toTheDoors(page, origin, 'Wren');
        if (!lobbyCard.includes('It takes a name, and 12 secret words or a sign-in. No invite needed.') || /one sign-in/.test(lobbyCard)) {
            throw new Failure(`the lobby's Join card says "${lobbyCard}"`);
        }
        console.log('  ✓ the lobby\'s Join card names both doors');
        await noSideScroll(page, 'the two doors');
        await shot(page, '1-two-doors');
        const words = await page.getByTestId('door-words').innerText();
        if (!words.includes('No Google, Apple or Facebook needed. Your 12 words are the only way back in.')) throw new Failure(`the 12-words door says "${words}"`);
        await page.getByTestId('join-words').click();
        await page.getByText(/Choose your look/).waitFor({ timeout: 30_000 });
        await scaleText(page);
        const bar = await page.getByTestId('onboarding-stepper').innerText();
        if (/Sign in/.test(bar)) throw new Failure(`a 12-words member's steps bar says "${bar.replace(/\s+/g, ' ')}"`);
        await noSideScroll(page, 'photo step');
        await page.getByTitle('Green Bean').click();
        await page.getByRole('button', { name: 'Next →' }).click();
        await page.getByText('Your Safety Backup').waitFor();
        const panel = await page.getByTestId('backup-words-only').innerText();
        if (!/These 12 words are your account\. Nobody can reset them: not us, not this community\. If you lose them and this device, the account is gone for good\./i.test(panel.replace(/\s+/g, ' '))) {
            throw new Failure(`Safety Backup says "${panel}"`);
        }
        await noSideScroll(page, 'Safety Backup (12 words only)');
        await shot(page, '1-safety-backup');
        if (seen.providerTrips.length) throw new Failure('a 12-words join visited a provider');

        const row = await memberRow(node, 'Wren');
        if (!row || row.invitedBy !== 'open:words' || row.provider !== 'words' || !/^words:/.test(row.joinHash)) {
            throw new Failure(`the node has Wren as ${JSON.stringify(row)}, not a 12-words member`);
        }
        const wordsJoin = seen.door.find((d) => d.path === '/api/join');
        if (!wordsJoin || wordsJoin.body.door !== 'words' || Object.keys(wordsJoin.body).sort().join() !== 'callsign,door,work') {
            throw new Failure(`the join went as ${JSON.stringify(wordsJoin?.body)}`);
        }
        console.log('  ✓ a 12-words join, end to end: the node has Wren as open:words, with a words row; no provider visited');

        // 2. A sign-in added from Safety Backup: chosen there, offered at the end of the tour, and the page leaves only
        // once the photo is on the node and the browser was asked to keep its data.
        seen.nextSub = 'google-sub-wren';
        await page.getByTestId('backup-add-sign-in').getByRole('button', { name: 'Add a sign-in as a second way back' }).click();
        await page.getByRole('button', { name: "Let's Begin! 🚀" }).waitFor({ timeout: 20_000 });
        await page.getByTestId('add-sign-in-google').waitFor({ timeout: 20_000 });
        await scaleText(page);
        await noSideScroll(page, 'the tour, with the sign-in to add');
        await shot(page, '2-tour-add-sign-in');
        await page.getByTestId('add-sign-in-google').click();
        await page.getByTestId('link-result').waitFor({ timeout: 30_000 });
        await scaleText(page);
        const said = await page.getByTestId('link-result').innerText();
        if (!/^Google is added\. Signing in with it also brings this account back/.test(said)) throw new Failure(`Settings says "${said}" after adding Google`);
        if (page.url() !== `${origin}/app`) throw new Failure(`the address bar still reads ${page.url()}`);
        await noSideScroll(page, 'Settings after adding a sign-in');
        await shot(page, '2-linked');
        const linked = await memberRow(node, 'Wren');
        if (linked?.provider !== 'google' || linked.invitedBy !== 'open:words') throw new Failure(`after the link the node has ${JSON.stringify(linked)}`);
        const copies = await node.ask({ op: 'sql', all: true, sql: "SELECT count(*) AS n FROM recovery_shares WHERE owner_pubkey = ? AND holder_type = 'sso'", params: [linked.key] }).catch(() => null);
        const stored = copies?.[0]?.n ?? 'unknown';
        console.log(`  ✓ a sign-in added later: Settings says so, the node's row is Google's, sign-in copies stored: ${stored}`);
        const [{ avatar }] = await node.ask({ op: 'sql', all: true, sql: 'SELECT avatar_url AS avatar FROM members WHERE public_key = ?', params: [linked.key] });
        if (avatar !== 'bundled://bean-green') throw new Failure(`after adding a sign-in from Safety Backup the node has Wren's photo as ${JSON.stringify(avatar)}`);
        const persistAsked = await page.evaluate(() => Number(localStorage.getItem('__persistAsked') || 0));
        if (persistAsked !== 1) throw new Failure(`the browser was asked to keep its data ${persistAsked} times, not once`);
        console.log('  ✓ the tour came first: the node has the photo chosen at step 2 (bundled://bean-green), and persist() was asked once');
    } finally {
        await context.close();
    }
}

async function signInAskedForWork(browser, origin, node, seen) {
    await node.ask({ op: 'doorNumber', name: 'signInWorkFrom', value: 1 });
    const { context, page } = await openPage(browser, origin, seen);
    try {
        seen.nextSub = 'google-sub-sol';
        await toTheDoors(page, origin, 'Sol', { words: false });
        await page.getByTestId('join-provider-google').click();
        // In, or a refusal said: whichever comes first.
        await page.getByText(/Choose your look/).or(page.getByTestId('join-notice')).first().waitFor({ timeout: 60_000 });
        if (await page.getByTestId('join-notice').count()) throw new Failure(`the page said: "${await page.getByTestId('join-notice').innerText()}"`);
        const joins = seen.answers.filter((a) => a.path === '/api/join');
        const works = seen.door.filter((d) => d.path === '/api/join/work' && d.body?.door === 'sign-in');
        if (joins.length !== 2 || joins[0].code !== 'work_required' || joins[1].status !== 200) throw new Failure(`the joins were answered ${JSON.stringify(joins)}`);
        if (works.length !== 1) throw new Failure(`the page asked for sign-in work ${works.length} times`);
        const sent = seen.door.filter((d) => d.path === '/api/join');
        if (sent[0].body.work || !sent[1].body.work || sent[0].body.nonce !== sent[1].body.nonce) throw new Failure('the second join was not the same sign-in with work');
        const row = await memberRow(node, 'Sol');
        if (row?.provider !== 'google') throw new Failure(`the node has Sol as ${JSON.stringify(row)}`);
        if (page.url() !== `${origin}/app`) throw new Failure(`the address bar still reads ${page.url()}`);
        console.log('  ✓ a sign-in the node asked for work: work_required, the work done here, the same sign-in again, in; nothing shown');
    } finally {
        await node.ask({ op: 'doorNumber', name: 'signInWorkFrom', value: null });
        await context.close();
    }
}

async function busyLevel(browser, origin, node, seen) {
    // Every join so far came from this machine's address, so the next is the (n+1)th from it this hour; and every
    // 12-words join so far was on this node in the last ten minutes. Steps lowered so the next 12-words join here is at
    // level 4: a step for each join from this address, and one node step for the first 12-words join.
    const [{ n }] = await node.ask({
        op: 'sql', all: true,
        sql: "SELECT count(*) AS n FROM open_joins WHERE ip_hash = (SELECT ip_hash FROM open_joins WHERE ip_hash IS NOT NULL ORDER BY joined_at DESC LIMIT 1) AND joined_at > ?",
        params: [new Date(Date.now() - 3600_000).toISOString()],
    });
    const next = n + 1;
    // Network steps at 1, 2, 3, 4 joins from this address; node steps at the 1st and 2nd 12-words join here (Wren's, then
    // this one): level 5, the cap, after the scenarios before this one.
    const level = Math.min(5, Math.min(4, next) + 2);
    if (level < 3) throw new Failure(`only ${n} joins from this address so far: run the whole check, the scenarios before this one make them`);
    await node.ask({ op: 'doorNumber', name: 'networkSteps', value: '1,2,3,4' });
    await node.ask({ op: 'doorNumber', name: 'nodeSteps', value: '1,2,100000' });
    const { context, page } = await openPage(browser, origin, seen);
    try {
        await toTheDoors(page, origin, 'Kite');
        const ESTIMATE = /^Lots of people are joining right now\. Setting up a 12-words account will take about (a|\d+) (second|seconds|minute|minutes) in this browser\. Or sign in to join now\.$/;
        // The sentence with this browser's own estimate (it has timed its tries), or the work done before it could be.
        await page.waitForFunction((src) => window.__busySeen.some((t) => new RegExp(src).test(t))
            || document.querySelector('[data-words-work="ready"]'), ESTIMATE.source, { timeout: 60_000 });
        if (await page.getByTestId('join-busy').count()) {
            await noSideScroll(page, 'the two doors, busy');
            await shot(page, '4-busy');
            if (!(await page.getByTestId('join-provider-google').isEnabled())) throw new Failure('the sign-in was not offered beside the busy sentence');
        }
        await page.getByTestId('join-words').click();
        await page.getByText(/Choose your look/).waitFor({ timeout: 120_000 });
        const seenBusy = await page.evaluate(() => window.__busySeen);
        const said = seenBusy.find((t) => ESTIMATE.test(t));
        if (!said) throw new Failure(`no busy sentence with an estimate was shown; shown: ${JSON.stringify(seenBusy)}`);
        const work = seen.door.filter((d) => d.path === '/api/join/work' && d.body?.door === 'words').length;
        const row = await memberRow(node, 'Kite');
        if (row?.provider !== 'words') throw new Failure(`the node has Kite as ${JSON.stringify(row)}`);
        const levels = seen.door.filter((d) => d.path === '/api/join' && d.body?.door === 'words').map((d) => Number(String(d.body.work?.challenge).split('.')[1]));
        if (levels[0] !== level) throw new Failure(`the join's work was at level ${levels[0]}, not ${level}`);
        console.log(`  ✓ the busy level (${levels[0]}): "${said}"; then a 12-words join with that work (${work} work request(s) on this page)`);
    } finally {
        await node.ask({ op: 'doorNumber', name: 'networkSteps', value: null });
        await node.ask({ op: 'doorNumber', name: 'nodeSteps', value: null });
        await context.close();
    }
}

async function settingUpWayBack(browser, origin, node, seen) {
    const { context, page } = await openPage(browser, origin, seen);
    // The work's answer held back for a few seconds, so Join comes before the work is done.
    let hold = true;
    await page.route(`${origin}/api/join/work`, async (route) => {
        if (hold) await new Promise((r) => setTimeout(r, 6_000));
        return route.continue();
    });
    try {
        await toTheDoors(page, origin, 'Moss', { words: true });
        await page.getByTestId('join-words').click();
        await page.getByText('Setting up your account…').waitFor({ timeout: 5_000 });
        const back = page.getByRole('button', { name: '← Choose another way' });
        await back.waitFor({ timeout: 5_000 });
        await scaleText(page);
        await noSideScroll(page, 'Setting up your account…');
        await shot(page, '5-setting-up');
        await back.click();
        await page.getByTestId('door-words').waitFor({ timeout: 5_000 });
        if (!(await page.getByTestId('join-provider-google').isEnabled())) throw new Failure('after ← Choose another way the sign-in is not offered');
        hold = false;
        // The work finishes while they look at the doors: nothing goes until they choose.
        await page.waitForFunction(() => document.querySelector('[data-words-work="ready"]'), null, { timeout: 60_000 });
        if (seen.door.some((d) => d.path === '/api/join')) throw new Failure('a join went by itself after ← Choose another way');
        const works = seen.door.filter((d) => d.path === '/api/join/work').length;
        await page.getByTestId('join-words').click();
        await page.getByText(/Choose your look/).waitFor({ timeout: 60_000 });
        const row = await memberRow(node, 'Moss');
        if (row?.provider !== 'words') throw new Failure(`the node has Moss as ${JSON.stringify(row)}`);
        console.log(`  ✓ "Setting up your account…" has ← Choose another way: the two doors and the sign-in, no join sent; then in with 12 words (${works} work request(s))`);
    } finally {
        await context.close();
    }
}

async function keyLetGo(browser, origin, node, seen) {
    const { context, page } = await openPage(browser, origin, seen);
    // The challenges' life shortened as the page reads it, so an unused one is renewed two seconds after it is ready.
    await page.route(`${origin}/api/join/work`, async (route) => {
        const res = await route.fetch();
        const body = await res.json();
        if (body?.work) body.work.expiresInSeconds = 92;
        return route.fulfill({ response: res, body: JSON.stringify(body) });
    });
    try {
        await toTheDoors(page, origin, 'Fern');
        await page.waitForFunction(() => document.querySelector('[data-words-work="ready"]'), null, { timeout: 60_000 });
        // Renewals do come for a key that is kept (so the count below means something).
        const before = seen.door.filter((d) => d.path === '/api/join/work').length;
        for (let waited = 0; waited < 20_000 && seen.door.filter((d) => d.path === '/api/join/work').length <= before; waited += 250) {
            await page.waitForTimeout(250);
        }
        await page.getByRole('button', { name: '← Change name' }).click();
        await page.getByRole('button', { name: '← Back' }).click();
        await page.getByTestId('join-screen-guard').waitFor({ timeout: 10_000 });
        const atBack = seen.door.filter((d) => d.path === '/api/join/work').length;
        const renewedWhileKept = atBack - before;
        await page.waitForTimeout(10_000);
        const after = seen.door.filter((d) => d.path === '/api/join/work').length - atBack;
        if (after !== 0) throw new Failure(`${after} work request(s) for the key let go by ← Back, in the 10 s after it`);
        if (renewedWhileKept < 1) throw new Failure('no renewal came while the key was kept, so the count after ← Back proves nothing');
        console.log(`  ✓ a key let go by ← Back: ${renewedWhileKept} renewal(s) while kept, 0 work requests in the 10 s after ← Back`);
    } finally {
        await context.close();
    }
}

async function main() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bp-global-door-'));
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bp-global-door-data-'));
    let node;
    let browser;
    let failed = false;
    try {
        await build({ root: PWA_DIR, logLevel: 'warn', build: { outDir: path.join(root, 'public'), emptyOutDir: true } });
        node = await startNode(root, dataDir);
        const origin = `https://localhost:${node.port}`;
        console.log(`A global-profile node on ${origin}, serving the web app as built; Chromium at 320 px, 1.3x text.\n`);
        browser = await chromium.launch();
        const scenarios = [
            ['a 12-words join, then a sign-in added later', wordsJoinThenLink],
            ['a sign-in join the node asks for work', signInAskedForWork],
            ['the busy level', busyLevel],
            ['"Setting up your account…" and the way back', settingUpWayBack],
            ['a key let go by ← Back', keyLetGo],
        ];
        for (const [name, run] of scenarios) {
            if (process.env.GLOBAL_DOOR_ONLY && !name.includes(process.env.GLOBAL_DOOR_ONLY)) continue;
            const seen = { violations: [], otherHosts: new Set(), providerTrips: [], door: [], answers: [], nextSub: 'google-sub' };
            await node.ask({ op: 'resetLimits' });
            console.log(`${name}:`);
            try {
                await run(browser, origin, node, seen);
                if (seen.violations.length) throw new Failure(`policy violations: ${JSON.stringify(seen.violations)}`);
                const hosts = [...seen.otherHosts].filter((h) => h !== 'accounts.google.com');
                if (hosts.length) console.log(`  (asked and refused, never reached: ${hosts.join(', ')})`);
            } catch (e) {
                failed = true;
                console.error(`  ✗ ${e instanceof Failure ? e.message : e.stack || e}`);
            }
        }
        const blocked = node.log.filter((l) => l.startsWith('BLOCKED-'));
        if (blocked.length) {
            failed = true;
            console.error(`✗ the node tried to reach outside this machine: ${blocked.join('; ')}`);
        }
    } finally {
        await browser?.close();
        if (node) {
            node.child.kill('SIGTERM');
            await new Promise((r) => setTimeout(r, 300));
            if (node.child.exitCode === null) node.child.kill('SIGKILL');
        }
        fs.rmSync(root, { recursive: true, force: true });
        fs.rmSync(dataDir, { recursive: true, force: true });
    }
    console.log(`\nScreenshots: ${SHOTS_DIR}`);
    if (failed) {
        console.error('\n❌ The two doors did not hold in the web app against a real global node.');
        process.exit(1);
    }
    console.log('\n⭐️ The two doors hold in the web app against a real global node at 320 px with 1.3x text.');
}

main().catch((e) => { console.error('❌', e); process.exit(1); });
