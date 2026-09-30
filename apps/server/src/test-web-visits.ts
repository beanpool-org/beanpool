/**
 * Web app visits a day (engine/web-visits.ts): counted where the page is served, with no address, cookie or lasting hash.
 * Over REAL HTTPS through the node's own middleware, with a stand-in web app in public/:
 *
 *   1. a person's browser opening the web app (/app, where / redirects; /app/…; an old browser asking for text/html) is
 *      one visit, once per page load; / itself, its files, the API, Settings, the manager, an invite's install page, a
 *      sign-in's return, HEAD, a prefetch, a page's own fetch, and crawlers, link previews, uptime checks, headless
 *      browsers, scripts and an empty User-Agent are not. Phones named CUBOT, and the Telegram and Facebook in-app
 *      browsers, are people
 *   2. uniques: one address and browser once a day; another browser or another address is another visitor; two
 *      addresses in one IPv6 /64 are one subscriber
 *   3. nothing identifying is kept: the table is exactly (day, visits, uniques); no answer sets a cookie; the database
 *      file and its WAL, and everything the server printed (stdout, stderr) or logged (system_logs), hold none of the
 *      addresses, the browsers or the day's tags
 *   4. the admin route: unsigned, a wrong password, a member's signature and a moderator's session are refused; an admin's
 *      session and the owner's password read 30 days by default, oldest first, today last and as counted; `days` clamped
 *      to 1..400; read-only
 *   5. the prune: today and the 399 days before are kept, older rows deleted with no tombstone, by pruneWebVisits (which
 *      the server's start runs) and on a day's first visit (6); reading deletes nothing
 *   6. the day rolls over: a new day's first visit makes its own row and a new key (the same person, a new tag, counted
 *      again), and drops the old day's tags; the day's memory is set to go at the next UTC midnight, and does go then
 *
 * Run: BEANPOOL_DATA_DIR=$(mktemp -d) pnpm exec tsx src/test-web-visits.ts
 */
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
delete process.env.CF_RECORD_NAME;
delete process.env.NODE_PROFILE;

import crypto from 'node:crypto';
import fs from 'node:fs';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';

// Everything the server prints, from before it loads: section 3 looks through it. This suite's own lines (which quote the
// browsers it sends) go straight to the streams, past the capture.
const printed: string[] = [];
const toStdout = process.stdout.write.bind(process.stdout) as (s: string) => boolean;
const toStderr = process.stderr.write.bind(process.stderr) as (s: string) => boolean;
for (const stream of [process.stdout, process.stderr]) {
    const write = stream.write.bind(stream) as (...a: unknown[]) => boolean;
    (stream as unknown as { write: (...a: unknown[]) => boolean }).write = (chunk: unknown, ...rest: unknown[]) => {
        printed.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk as Uint8Array).toString('utf8'));
        return write(chunk, ...rest);
    };
}
const say = (line: string) => toStdout(`${line}\n`);

import { initTls } from './services/tls.js';
import { initStateEngine, seedGenesisMember, grantNodeRole } from './state-engine.js';
import { db } from './db/db.js';
import { updateLocalConfig, hashPassword } from './config/local-config.js';
import { resetAdminAuthTarpit } from './admin-auth.js';
import { createAdminChallenge, verifyAndSolveChallenge, consumeHandshakeToken } from './admin-key-auth.js';
import { limiterKeyForIp } from './client-ip.js';
import {
    recordWebVisit, pruneWebVisits, getWebVisits, isWebAppPageLoad, utcDay, VISIT_RETENTION_DAYS,
    webVisitMemoryForTests, webVisitTagForTests, forgetWebVisitDayForTests,
} from './engine/web-visits.js';

let run = 0, passed = 0;
function assert(cond: boolean, msg: string): void {
    run++;
    if (cond) { passed++; say(`✓ ${msg}`); } else { toStderr(`✗ ${msg}\n`); process.exitCode = 1; }
}

const DAY_MS = 24 * 60 * 60 * 1000;
let PORT = 0;

// Each browser carries a marker, so a copy of it anywhere is easy to find.
const CUBOT = 'Mozilla/5.0 (Linux; Android 8.1.0; CUBOT J3) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/96.0.4664.104 Mobile Safari/537.36 visitmark-one';
const OLD_ANDROID = 'Mozilla/5.0 (Linux; U; Android 4.4.2; en-us; SM-G350E Build/KOT49H) AppleWebKit/534.30 (KHTML, like Gecko) Version/4.0 Mobile Safari/534.30 visitmark-two';
const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1 visitmark-three';
const ADDR_A = '203.0.113.77';
const ADDR_B = '198.51.100.23';
const V6_ONE = '2001:db8:4a7f:9c01::17';
const V6_SAME_64 = '2001:db8:4a7f:9c01:ffff::99';
const V6_OTHER_64 = '2001:db8:4a7f:9c02::17';

/** A browser opening a page: the headers a current one sends for a top-level navigation. */
const opening = (ua: string, from: string): Record<string, string> => ({
    'User-Agent': ua,
    Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
    'Sec-Fetch-Dest': 'document',
    'Sec-Fetch-Mode': 'navigate',
    'X-Forwarded-For': from, // from loopback, a trusted proxy: the client's address (client-ip.ts)
});

interface Answer { status: number; headers: Record<string, string | string[] | undefined>; body: string }
const setCookies: string[] = [];

/** A request with the path sent exactly as written and these headers only. */
function send(method: string, rawPath: string, headers: Record<string, string>): Promise<Answer> {
    return new Promise((resolve, reject) => {
        const req = https.request({ host: 'localhost', port: PORT, path: rawPath, method, headers, rejectUnauthorized: false }, (res) => {
            const chunks: Buffer[] = [];
            res.on('data', (c: Buffer) => chunks.push(c));
            res.on('end', () => {
                const cookie = res.headers['set-cookie'];
                if (cookie) setCookies.push(...cookie);
                resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') });
            });
        });
        req.on('error', reject);
        req.end();
    });
}

function today(): { visits: number; uniques: number } {
    const row = db.prepare('SELECT visits, uniques FROM web_visit_days WHERE day = ?').get(utcDay()) as { visits: number; uniques: number } | undefined;
    return row ?? { visits: 0, uniques: 0 };
}

function makeKeypair() {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    return { privateKey, pk: (publicKey.export({ type: 'spki', format: 'der' }) as Buffer).subarray(-32).toString('hex') };
}
function addMember(pk: string, callsign: string, invitedBy: string): void {
    db.prepare('INSERT INTO members (public_key, callsign, joined_at, invited_by, invite_code) VALUES (?, ?, ?, ?, ?)')
        .run(pk, callsign, new Date().toISOString(), invitedBy, 'TEST');
    db.prepare('INSERT INTO accounts (public_key, balance, last_demurrage_epoch) VALUES (?, 0, 0)').run(pk);
}
/** Key sign-in as the app does it: challenge, signature, handshake token, session. */
function keySession(kp: ReturnType<typeof makeKeypair>): string | undefined {
    const chal = createAdminChallenge();
    const signature = crypto.sign(null, Buffer.from(chal.challenge, 'utf-8'), kp.privateKey).toString('hex');
    const solved = verifyAndSolveChallenge({ challengeId: chal.challengeId, memberPubkey: kp.pk, signature });
    if (!solved.ok) return undefined;
    const ex = consumeHandshakeToken(solved.handshakeToken!);
    return ex.ok ? ex.sessionId : undefined;
}
function signed(kp: ReturnType<typeof makeKeypair>, method: string, urlPath: string): Record<string, string> {
    const ts = Date.now();
    const nonce = crypto.randomBytes(16).toString('hex');
    return {
        'X-Public-Key': kp.pk,
        'X-Signature': crypto.sign(null, Buffer.from(`${method}\n${urlPath.split('?')[0]}\n${ts}\n${nonce}\n`), kp.privateKey).toString('base64'),
        'X-Timestamp': String(ts),
        'X-Nonce': nonce,
    };
}

async function main(): Promise<void> {
    say('\n=== Web app visits a day: counted where the page is served, nobody identified ===\n');

    const webRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'bp-web-visits-'));
    const publicDir = path.join(webRoot, 'public');
    for (const dir of ['settings', 'manager', 'assets']) fs.mkdirSync(path.join(publicDir, dir), { recursive: true });
    fs.writeFileSync(path.join(publicDir, 'index.html'), '<!doctype html><title>BeanPool</title><div id="root">the web app</div>');
    fs.writeFileSync(path.join(publicDir, 'settings', 'index.html'), '<!doctype html><title>Settings</title>');
    fs.writeFileSync(path.join(publicDir, 'manager', 'index.html'), '<!doctype html><title>Manager</title>');
    fs.writeFileSync(path.join(publicDir, 'assets', 'app.js'), 'window.app = 1;');
    // https-server.ts takes public/ from the working directory when it has one, as it loads.
    process.chdir(webRoot);

    await initTls();
    initStateEngine();
    const PW = 'WebVisits-Owner-9!';
    const { hash, salt } = hashPassword(PW);
    updateLocalConfig({ adminHash: hash, salt, totpEnabled: false });
    const olive = makeKeypair(), adam = makeKeypair(), mo = makeKeypair(), mem = makeKeypair();
    seedGenesisMember(olive.pk, 'Olive');
    addMember(adam.pk, 'Adam', olive.pk);
    addMember(mo.pk, 'Mo', olive.pk);
    addMember(mem.pk, 'Mem', olive.pk);
    grantNodeRole(adam.pk, 'admin', 'owner:password');
    grantNodeRole(mo.pk, 'moderator', 'owner:password');

    const { startHttpsServer } = await import('./https-server.js');
    PORT = await startHttpsServer(0);

    // ── 1. what counts as a visit ────────────────────────────────────────────────────────────────
    say('\n--- 1. a person opening the web app is one visit; nothing else is ---');
    assert(today().visits === 0, 'a new server has counted no visit');
    let r = await send('GET', '/', opening(CUBOT, ADDR_A));
    assert(r.status === 302 && String(r.headers.location) === '/app' && today().visits === 0, `GET / redirects to /app and is no visit itself (got ${r.status} → ${r.headers.location})`);
    r = await send('GET', '/app', opening(CUBOT, ADDR_A));
    assert(r.status === 200 && r.body.includes('the web app'), `GET /app serves the web app (got ${r.status})`);
    assert(today().visits === 1, 'opening / and following it to /app is one visit, not two (a CUBOT phone is a person)');
    for (const p of ['/app', '/app/', '/app/profile', '/app/market?post=42', '/app?tab=people']) {
        const before = today().visits;
        r = await send('GET', p, opening(CUBOT, ADDR_A));
        assert(r.status === 200 && today().visits === before + 1, `opening ${p} is one visit (${before} → ${today().visits})`);
    }
    {
        const before = today().visits;
        // A browser too old to send Sec-Fetch-* headers still asks for text/html.
        r = await send('GET', '/app', { 'User-Agent': OLD_ANDROID, Accept: 'text/html,application/xhtml+xml,*/*;q=0.8', 'X-Forwarded-For': ADDR_A });
        assert(r.status === 200 && today().visits === before + 1, 'an old browser (no Sec-Fetch-Dest, Accept text/html) opening /app is one visit');
    }

    const notVisits: Array<[string, string, string, Record<string, string>]> = [
        ['its script', 'GET', '/assets/app.js', { ...opening(CUBOT, ADDR_A), 'Sec-Fetch-Dest': 'script', 'Sec-Fetch-Mode': 'no-cors' }],
        ['its script opened as a page', 'GET', '/assets/app.js', opening(CUBOT, ADDR_A)],
        ['a missing file', 'GET', '/assets/missing.js', opening(CUBOT, ADDR_A)],
        ['an API read', 'GET', '/api/community/health', opening(CUBOT, ADDR_A)],
        ['an API read from the page', 'GET', '/api/community/info', { ...opening(CUBOT, ADDR_A), 'Sec-Fetch-Dest': 'empty', 'Sec-Fetch-Mode': 'cors', Accept: 'application/json' }],
        ['Settings', 'GET', '/settings', opening(CUBOT, ADDR_A)],
        ['a Settings page', 'GET', '/settings/backups', opening(CUBOT, ADDR_A)],
        ['the manager', 'GET', '/manager', opening(CUBOT, ADDR_A)],
        ['a sign-in returning to the app', 'GET', '/app/auth/google', opening(CUBOT, ADDR_A)],
        ['an invite link (the install page, not the app)', 'GET', '/?invite=BP-ABCD-EFGH', opening(CUBOT, ADDR_A)],
        ['HEAD /app', 'HEAD', '/app', opening(CUBOT, ADDR_A)],
        ['a prefetch (Sec-Purpose)', 'GET', '/app', { ...opening(CUBOT, ADDR_A), 'Sec-Purpose': 'prefetch' }],
        ['a prerender', 'GET', '/app', { ...opening(CUBOT, ADDR_A), 'Sec-Purpose': 'prefetch;prerender' }],
        ['an old prefetch (Purpose)', 'GET', '/app', { ...opening(CUBOT, ADDR_A), Purpose: 'prefetch' }],
        ["the page's own fetch of /app", 'GET', '/app', { ...opening(CUBOT, ADDR_A), 'Sec-Fetch-Dest': 'empty', 'Sec-Fetch-Mode': 'cors' }],
        ['an iframe', 'GET', '/app', { ...opening(CUBOT, ADDR_A), 'Sec-Fetch-Dest': 'iframe' }],
        ['curl', 'GET', '/app', { 'User-Agent': 'curl/8.4.0', Accept: '*/*', 'X-Forwarded-For': ADDR_A }],
        ['a script with a browser name and no Accept', 'GET', '/app', { 'User-Agent': CUBOT, 'X-Forwarded-For': ADDR_A }],
        ['Googlebot', 'GET', '/app', opening('Mozilla/5.0 (Linux; Android 6.0.1; Nexus 5X Build/MMB29P) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.6478.126 Mobile Safari/537.36 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)', ADDR_A)],
        ['bingbot', 'GET', '/app', opening('Mozilla/5.0 (compatible; bingbot/2.0; +http://www.bing.com/bingbot.htm)', ADDR_A)],
        ["WhatsApp's link preview", 'GET', '/app', opening('WhatsApp/2.23.20.0 A', ADDR_A)],
        ["Telegram's link preview", 'GET', '/app', opening('TelegramBot (like TwitterBot)', ADDR_A)],
        ["Facebook's link preview", 'GET', '/app', opening('facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)', ADDR_A)],
        ['UptimeRobot', 'GET', '/app', opening('Mozilla/5.0+(compatible; UptimeRobot/2.0; http://www.uptimerobot.com/)', ADDR_A)],
        ['Uptime Kuma', 'GET', '/app', opening('Uptime-Kuma/1.23.13', ADDR_A)],
        ['Better Uptime', 'GET', '/app', opening('Better Uptime Bot Mozilla/5.0 (Windows NT 10.0; Win64; x64)', ADDR_A)],
        ['headless Chrome', 'GET', '/app', opening('Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/126.0.0.0 Safari/537.36', ADDR_A)],
        ['python-requests', 'GET', '/app', opening('python-requests/2.32.3', ADDR_A)],
        ['an empty User-Agent', 'GET', '/app', opening('', ADDR_A)],
    ];
    for (const [what, method, p, headers] of notVisits) {
        const before = today().visits;
        await send(method, p, headers);
        assert(today().visits === before, `${what} (${method} ${p}) is no visit`);
    }

    const people = [
        CUBOT, OLD_ANDROID, IPHONE,
        'Mozilla/5.0 (Linux; Android 9; CUBOT_X19) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/88.0.4324.93 Mobile Safari/537.36',
        'Mozilla/5.0 (Linux; Android 10; CUBOT) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/13.0 Chrome/83.0.4103.106 Mobile Safari/537.36',
        'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Mobile Safari/537.36',
        'Mozilla/5.0 (Linux; Android 13; SAMSUNG SM-A145F) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/25.0 Chrome/121.0.0.0 Mobile Safari/537.36',
        'Mozilla/5.0 (Mobile; LYF/F271i/LYF_F271i-000-01-26-130819; Android; rv:48.0) Gecko/48.0 Firefox/48.0 KAIOS/2.5',
        'Mozilla/5.0 (Linux; Android 12; TECNO KG5m Build/SP1A.210812.016; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/120.0.6099.230 Mobile Safari/537.36 Telegram-Android/10.6.2 (Tecno TECNO KG5m; Android 12; SDK 31; LOW)',
        'Mozilla/5.0 (Linux; Android 11; itel A571W Build/RP1A.201005.001; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/118.0.5993.111 Mobile Safari/537.36 [FB_IAB/FB4A;FBAV/440.0.0.33.116;]',
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36 Edg/129.0.0.0',
    ];
    for (const ua of people) {
        const headers = Object.fromEntries(Object.entries(opening(ua, ADDR_A)).map(([k, v]) => [k.toLowerCase(), v]));
        assert(isWebAppPageLoad('/', headers), `a person: ${ua.slice(0, 60)}…`);
    }

    // ── 2. uniques ───────────────────────────────────────────────────────────────────────────────
    say('\n--- 2. uniques: an address and a browser, a day ---');
    {
        const t = today();
        assert(t.uniques === 2, `so far one address with two browsers: 2 visitors (got ${t.uniques}) over ${t.visits} visits`);
        await send('GET', '/app', opening(CUBOT, ADDR_A));
        assert(today().uniques === 2 && today().visits === t.visits + 1, 'the same address and browser again: one more visit, no more visitors');
        await send('GET', '/app', opening(IPHONE, ADDR_A));
        assert(today().uniques === 3, 'another browser at the same address: another visitor');
        await send('GET', '/app', opening(CUBOT, ADDR_B));
        assert(today().uniques === 4, 'the same browser at another address: another visitor');
        await send('GET', '/app', opening(CUBOT, V6_ONE));
        await send('GET', '/app/profile', opening(CUBOT, V6_SAME_64));
        assert(today().uniques === 5, 'two addresses in one IPv6 /64 with one browser: one visitor (one subscriber)');
        await send('GET', '/app', opening(CUBOT, V6_OTHER_64));
        assert(today().uniques === 6, 'another /64: another visitor');
        const mem = webVisitMemoryForTests();
        assert(mem?.day === utcDay() && mem.visitors === 6, `today's memory holds 6 tags and nothing else about them (got ${JSON.stringify(mem)})`);
    }

    // ── 3. nothing identifying is kept ───────────────────────────────────────────────────────────
    say('\n--- 3. no address, browser, cookie or lasting hash in the database or the logs ---');
    {
        const columns = (db.prepare('PRAGMA table_info(web_visit_days)').all() as Array<{ name: string }>).map((c) => c.name);
        assert(JSON.stringify(columns) === JSON.stringify(['day', 'visits', 'uniques']), `web_visit_days is (day, visits, uniques) and nothing else (got ${columns.join(', ')})`);
        assert(setCookies.length === 0, `no answer set a cookie (got ${setCookies.length})`);

        const seen: Array<[string, string]> = [
            [ADDR_A, CUBOT], [ADDR_A, OLD_ANDROID], [ADDR_A, IPHONE], [ADDR_B, CUBOT], [V6_ONE, CUBOT], [V6_OTHER_64, CUBOT],
        ];
        const tags = seen.map(([addr, ua]) => webVisitTagForTests(limiterKeyForIp(addr), ua));
        assert(tags.every((t) => typeof t === 'string' && t.length === 16) && new Set(tags).size === 6, "each visitor's tag is known to this process today, and they differ");

        const dbPath = db.name;
        const files = [dbPath, `${dbPath}-wal`].filter((f) => fs.existsSync(f));
        const stored = files.map((f) => fs.readFileSync(f).toString('latin1')).join('\n');
        const logRows = (db.prepare('SELECT message, metadata FROM system_logs').all() as Array<{ message: string; metadata: string | null }>)
            .map((r) => `${r.message} ${r.metadata ?? ''}`).join('\n');
        const logs = `${printed.join('')}\n${logRows}`;
        assert(stored.length > 0 && logs.length > 0, `looked through ${files.length} database files (${stored.length} bytes) and ${logs.length} characters of logs`);
        // Controls: the search finds what is there, so the misses below mean something.
        assert(stored.includes('Olive') && stored.includes('web_visit_days'), "the database search finds what the database holds (a member's callsign, the table's name)");
        assert(logs.includes('listening on https://'), 'the log search finds what the server printed (its listening line)');

        const needles: Array<[string, string]> = [
            [ADDR_A, 'an IPv4 address'], [ADDR_B, 'another IPv4 address'], ['2001:db8:4a7f:9c0', 'an IPv6 prefix'],
            ['visitmark-', "a browser's User-Agent"], ['CUBOT J3', "a phone's model"], ['SM-G350E', "another phone's model"],
            ...tags.map((t, i): [string, string] => [t!, `visitor ${i + 1}'s tag`]),
        ];
        for (const [needle, what] of needles) {
            assert(!stored.includes(needle), `the database holds no ${what}`);
            assert(!logs.includes(needle), `the logs hold no ${what}`);
        }
    }

    // ── 4. the admin route ──────────────────────────────────────────────────────────────────────
    say('\n--- 4. the admin route: owners and admins only ---');
    {
        const route = '/api/local/admin/web-visits';
        resetAdminAuthTarpit();
        r = await send('GET', route, {});
        assert(r.status === 401, `unsigned: 401 (got ${r.status})`);
        r = await send('GET', route, { 'X-Admin-Password': 'not-the-password' });
        assert(r.status === 401, `a wrong password: 401 (got ${r.status})`);
        resetAdminAuthTarpit();
        r = await send('GET', route, signed(mem, 'GET', route));
        assert(r.status === 401 && !r.body.includes('"series"'), `a member's signature: 401, no counts (got ${r.status})`);
        const moSid = keySession(mo);
        assert(!!moSid, 'a moderator signs in with their key');
        r = await send('GET', route, { 'X-Admin-Session': moSid! });
        assert(r.status === 403 && !r.body.includes('"series"'), `a moderator's session: 403, no counts (got ${r.status})`);
        assert(!keySession(mem), 'a member with no role gets no key session at all');

        const adminSid = keySession(adam);
        r = await send('GET', route, { 'X-Admin-Session': adminSid! });
        assert(r.status === 200, `an admin's session: 200 (got ${r.status})`);
        let body = JSON.parse(r.body);
        const t = today();
        const last = body.series?.[body.series.length - 1];
        assert(body.days === 30 && body.series.length === 30 && body.retentionDays === VISIT_RETENTION_DAYS, `30 days by default, 400 kept (got days ${body.days}, ${body.series?.length} entries)`);
        assert(last?.day === utcDay() && last.visits === t.visits && last.uniques === t.uniques, `today last, as counted (${JSON.stringify(last)})`);
        assert(body.series[0].day === utcDay(Date.now() - 29 * DAY_MS) && body.series[0].visits === 0, 'oldest first: 29 days ago, with none');
        assert(String(r.headers['cache-control']).includes('no-store'), 'not cached');
        assert(JSON.stringify(Object.keys(body.series[0]).sort()) === JSON.stringify(['day', 'uniques', 'visits']), 'each day is (day, visits, uniques) only');

        resetAdminAuthTarpit();
        for (const [q, want] of [['0', 1], ['7', 7], ['9999', 400], ['abc', 30], ['-5', 1]] as const) {
            r = await send('GET', `${route}?days=${q}`, { 'X-Admin-Password': PW });
            body = JSON.parse(r.body);
            assert(r.status === 200 && body.days === want && body.series.length === want, `the owner's password, days=${q}: ${want} days (got ${r.status}, ${body.days})`);
        }
        r = await send('POST', route, { 'X-Admin-Password': PW, 'Content-Type': 'application/json' });
        assert(r.status === 404 || r.status === 405, `read-only: a POST is no route (got ${r.status})`);
    }

    // ── 5. the prune ────────────────────────────────────────────────────────────────────────────
    say('\n--- 5. 400 days kept, older rows deleted with no tombstone ---');
    {
        const now = Date.now();
        const insert = db.prepare('INSERT OR REPLACE INTO web_visit_days (day, visits, uniques) VALUES (?, ?, ?)');
        const kept = utcDay(now - 399 * DAY_MS), gone = utcDay(now - 400 * DAY_MS), long = utcDay(now - 1000 * DAY_MS);
        insert.run(kept, 5, 4);
        insert.run(gone, 6, 5);
        insert.run(long, 7, 6);
        const rowsBefore = (db.prepare('SELECT COUNT(*) AS n FROM web_visit_days').get() as { n: number }).n;
        const series = getWebVisits(400, now);
        assert(series.length === 400 && series[0].day === kept && series[0].visits === 5, 'a 400-day read starts at the oldest kept day');
        assert((db.prepare('SELECT COUNT(*) AS n FROM web_visit_days').get() as { n: number }).n === rowsBefore, 'reading deletes nothing');
        const deleted = pruneWebVisits(now);
        const days = new Set((db.prepare('SELECT day FROM web_visit_days').all() as Array<{ day: string }>).map((r) => r.day));
        assert(deleted === 2 && days.has(kept) && !days.has(gone) && !days.has(long), `the prune keeps ${kept} and deletes ${gone} and ${long} (deleted ${deleted})`);
        assert(days.has(utcDay(now)), "today's row stays");
        const tombstones = (db.prepare("SELECT COUNT(*) AS n FROM tombstones WHERE table_name = 'web_visit_days'").get() as { n: number }).n;
        assert(tombstones === 0, 'no tombstone');
    }

    // ── 6. the day rolls over (last: it moves the day's memory on) ──────────────────────────────
    say('\n--- 6. the day rolls over: new row, new key, old tags gone ---');
    {
        const startOf = (t: number) => Math.floor(t / DAY_MS) * DAY_MS;
        const d0 = startOf(Date.now()) + 3 * DAY_MS + 10 * 60 * 60 * 1000; // 10:00 UTC, three days on
        const d1 = d0 + DAY_MS;
        const key = limiterKeyForIp(ADDR_A);
        const insert = db.prepare('INSERT OR REPLACE INTO web_visit_days (day, visits, uniques) VALUES (?, ?, ?)');
        insert.run(utcDay(d1 - 399 * DAY_MS), 3, 3);
        insert.run(utcDay(d1 - 400 * DAY_MS), 3, 3);

        recordWebVisit(key, CUBOT, d0);
        recordWebVisit(key, CUBOT, d0 + 60_000);
        const row = (day: string) => db.prepare('SELECT visits, uniques FROM web_visit_days WHERE day = ?').get(day) as { visits: number; uniques: number } | undefined;
        assert(row(utcDay(d0))?.visits === 2 && row(utcDay(d0))?.uniques === 1, 'day 0: two visits, one visitor');
        const tag0 = webVisitTagForTests(key, CUBOT);
        let mem = webVisitMemoryForTests();
        assert(mem?.day === utcDay(d0) && mem.visitors === 1, "day 0's memory: its own day, one tag");
        assert(mem?.dropsAt === startOf(d0) + DAY_MS, `day 0's memory is set to go at the next UTC midnight (${new Date(mem?.dropsAt ?? 0).toISOString()})`);

        recordWebVisit(key, CUBOT, d1);
        const tag1 = webVisitTagForTests(key, CUBOT);
        mem = webVisitMemoryForTests();
        assert(row(utcDay(d1))?.visits === 1 && row(utcDay(d1))?.uniques === 1, 'day 1: its own row; the same person is a visitor again');
        assert(row(utcDay(d0))?.visits === 2 && row(utcDay(d0))?.uniques === 1, "day 0's row is as it was");
        assert(mem?.day === utcDay(d1) && mem.visitors === 1, "day 0's tags are gone: day 1's memory holds only its own");
        assert(!!tag0 && !!tag1 && tag0 !== tag1, "a new day's key: the same person's tag is new, and yesterday's matches nothing");
        assert(!!row(utcDay(d1 - 399 * DAY_MS)) && !row(utcDay(d1 - 400 * DAY_MS)), "day 1's first visit pruned the day 400 days before it, and kept the 399th");

        forgetWebVisitDayForTests();
        assert(webVisitMemoryForTests() === null && row(utcDay(d1))?.visits === 1, "dropping the day's memory leaves the counts");

        // The midnight timer, for real: a visit 150 ms before a UTC midnight is set to drop its day 150 ms later.
        const nextMidnight = startOf(Date.now()) + DAY_MS;
        recordWebVisit(limiterKeyForIp(ADDR_B), IPHONE, nextMidnight - 150);
        mem = webVisitMemoryForTests();
        assert(mem?.dropsAt === nextMidnight, "a visit just before midnight: its day's memory goes at midnight");
        await new Promise((resolve) => setTimeout(resolve, 600));
        assert(webVisitMemoryForTests() === null, 'at midnight the key and the tags are gone, with nothing else happening');
    }

    say(`\n${passed}/${run} passed`);
    if (passed !== run) process.exitCode = 1;
    process.exit();
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
