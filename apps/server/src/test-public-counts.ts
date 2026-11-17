/**
 * Risk 10 of the security inventory (scratch/security/ENTRY-POINTS.md, 17 Nov 2026): a stranger learned a community's
 * exact size and activity, the build it runs and when it last crashed, with the owners' "Share Member Count" off. Over
 * REAL HTTPS through the real middleware, on a local node (NODE_PROFILE unset, as a community like the inventory's runs):
 *
 *   1. With both switches on (the defaults), a stranger reads the counts on GET /api/community/info, /api/community/health
 *      and /api/node/info: the fields the sweep looks for are there to find, so section 2 can fail.
 *   2. The sweep, both switches off: every route the node serves (the router's own list, which test-guest-view's
 *      EVERY_ROUTE must equal), every method, as an unsigned caller and as a signed key that is no member here. No JSON
 *      answer holds a member, listing or trade count, the activity over 7 and 30 days, the active or inactive members,
 *      the host watchdog's report, the commit or the update check; and no answer's text holds the commit.
 *   3. The /ws greeting, unsigned and signed by a non-member, carries no count with "Share Member Count" off.
 *   4. A member, signing, still reads every figure with both switches off (info, health, node info, the socket greeting).
 *   5. Each switch alone: Share Member Count off leaves the activity and the watchdog (Share Node Health on) and takes the
 *      totals and the active and inactive members (which add up to the member count); Share Node Health off leaves the
 *      totals and takes the activity, the watchdog and the active and inactive members.
 *   6. GET /api/version: the version to anyone; the commit and the update check to an owner's or admin's session only,
 *      never to a moderator's, a member's signature or nobody.
 *
 * Run: BEANPOOL_DATA_DIR=$(mktemp -d) pnpm exec tsx src/test-public-counts.ts
 */
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
delete process.env.CF_RECORD_NAME;
delete process.env.NODE_PROFILE;
delete process.env.ENFORCE_READ_AUTH;
delete process.env.ENFORCE_WS_AUTH;

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import WebSocket from 'ws';
import { initTls } from './services/tls.js';
import { initStateEngine, seedGenesisMember, grantNodeRole, updateNodeConfig, resetCommunityReadCaches } from './state-engine.js';
import { db } from './db/db.js';
import { pruneAuthAttempts } from './auth-rate-limit.js';
import { resetGatewayRateLimit } from './gateway-rate-limit.js';
import { resetAdminAuthTarpit } from './admin-auth.js';
import { resetChatRateLimit } from './chat-rate-limit.js';
import { resetPasswordBrake } from './password-brake.js';
import { mintHandshakeToken, consumeHandshakeToken } from './admin-key-auth.js';
import { backgroundUpdateCheck, cachedNodeUpdateInfo } from './node-release-check.js';
import { getCommit } from './version.js';
import { signRequest, signSocket, socketBinding, SIGNED_FOR_HEADER, signedForHost } from './signed-request-test-helper.js';

let BASE = '';
let resetAdminRateLimit: (() => void) | undefined;
let run = 0, passed = 0;
function assert(cond: boolean, msg: string): void {
    run++;
    if (cond) { passed++; console.log(`✓ ${msg}`); } else { console.error(`✗ ${msg}`); process.exitCode = 1; }
}

interface Id { pk: string; priv: crypto.KeyObject }
function newId(): Id {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    return { pk: (publicKey.export({ type: 'spki', format: 'der' }) as Buffer).subarray(-32).toString('hex'), priv: privateKey };
}

interface Res { status: number; body: any; text: string }
type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
async function call(method: Method, id: Id | null, urlPath: string, extra: Record<string, string> = {}): Promise<Res> {
    pruneAuthAttempts(Date.now() + 120_000);
    resetGatewayRateLimit();
    resetAdminAuthTarpit();
    resetAdminRateLimit?.();
    resetChatRateLimit();
    resetPasswordBrake();
    const bodiless = method === 'GET';
    const raw = bodiless ? '' : '{}';
    const headers: Record<string, string> = { ...extra };
    if (!bodiless) headers['Content-Type'] = 'application/json';
    if (id) {
        const ts = Date.now();
        const nonce = crypto.randomBytes(16).toString('hex');
        headers['X-Public-Key'] = id.pk;
        headers['X-Signature'] = signRequest(id.priv, { method, path: urlPath.split('?')[0], timestamp: ts, nonce, body: raw });
        headers[SIGNED_FOR_HEADER] = signedForHost();
        headers['X-Timestamp'] = String(ts);
        headers['X-Nonce'] = nonce;
    }
    try {
        const res = await fetch(`${BASE}${urlPath}`, { method, headers, body: bodiless ? undefined : raw, signal: AbortSignal.timeout(15_000) });
        const text = await res.text();
        let body: any = text;
        try { body = JSON.parse(text); } catch { /* not JSON (a page, an image) */ }
        return { status: res.status, body, text };
    } catch (e) {
        return { status: 0, body: null, text: `no answer: ${(e as Error).message}` };
    }
}

/**
 * A field that tells a stranger the community's size, activity or running, wherever it sits in an answer, when it holds
 * a value: null is how an answer says it is not shared (GET /api/directory/info's memberCount, the card's members).
 */
const FIGURE_KEYS = new Set(['memberCount', 'postCount', 'transactionCount', 'totalMembers', 'totalTransactions', 'totalPosts',
    'last7Days', 'last30Days', 'activeMemberCount', 'inactiveMemberCount', 'watchdog', 'recoveries', 'lastRecoveryAt',
    'commit', 'updateAvailable', 'latestVersion', 'lastUpdateCheck']);
/** Named more plainly elsewhere (the community card, Home): a count only when the value is a number. */
const COUNT_WHEN_NUMBER = new Set(['members', 'listings', 'tradesThisMonth']);

function figuresIn(value: unknown, at = '$', out: string[] = []): string[] {
    if (Array.isArray(value)) value.forEach((v, i) => figuresIn(v, `${at}[${i}]`, out));
    else if (value && typeof value === 'object') {
        for (const [k, v] of Object.entries(value)) {
            if ((FIGURE_KEYS.has(k) && v !== null && v !== undefined) || (COUNT_WHEN_NUMBER.has(k) && typeof v === 'number')) out.push(`${at}.${k}`);
            figuresIn(v, `${at}.${k}`, out);
        }
    }
    return out;
}

function signedWsQuery(id: Id): string {
    const ts = Date.now();
    const nonce = crypto.randomBytes(16).toString('hex');
    const sig = signSocket(id.priv, ts, nonce);
    return `pubkey=${id.pk}&ts=${ts}&nonce=${nonce}&sig=${encodeURIComponent(sig)}&${socketBinding()}`;
}

/** The first thing a /ws socket is told (the greeting, `state_snapshot`), or null if it never opened or said nothing. */
async function greeting(id: Id | null): Promise<any | null> {
    resetGatewayRateLimit();
    const url = `${BASE.replace(/^https/, 'wss')}/ws${id ? `?${signedWsQuery(id)}` : ''}`;
    return new Promise((resolve) => {
        const ws = new WebSocket(url, { rejectUnauthorized: false });
        const done = (v: any) => { clearTimeout(timer); try { ws.close(); } catch { /* closed */ } resolve(v); };
        const timer = setTimeout(() => done(null), 5000);
        ws.on('message', (d) => {
            try { const m = JSON.parse(d.toString()); if (m?.type === 'state_snapshot') done(m); } catch { /* not JSON */ }
        });
        ws.on('error', () => done(null));
    });
}

function setSwitches(publishMembers: boolean, publishHealth: boolean): void {
    updateNodeConfig({ publishMembers, publishHealth });
    resetCommunityReadCaches();
}

function adminSession(role: 'owner' | 'admin' | 'moderator'): Record<string, string> {
    const pub = newId().pk;
    db.prepare(`INSERT INTO members (public_key, callsign, status, joined_at, invited_by, invite_code)
        VALUES (?, ?, 'active', strftime('%Y-%m-%dT%H:%M:%fZ','now'), 'genesis', 'genesis')`).run(pub, `${role}-${pub.slice(0, 6)}`);
    grantNodeRole(pub, role, 'SYSTEM');
    const { handshakeToken } = mintHandshakeToken(pub, role);
    const s = consumeHandshakeToken(handshakeToken);
    if (!s.ok || !s.sessionId) throw new Error(`could not open a ${role} session: ${s.error}`);
    return { 'X-Admin-Session': s.sessionId };
}

async function main(): Promise<void> {
    console.log('\n=== Risk 10: a stranger reads no count, activity, watchdog or build the owners did not share ===\n');
    if (!process.env.BEANPOOL_DATA_DIR) throw new Error('BEANPOOL_DATA_DIR must be set');

    await initTls();
    initStateEngine();
    const olive = newId();
    const reed = newId();
    seedGenesisMember(olive.pk, 'Olive');
    seedGenesisMember(reed.pk, 'Reed');
    // A host watchdog that has restarted this node twice (ops/watchdog's status file).
    fs.writeFileSync(path.join(process.env.BEANPOOL_DATA_DIR, 'watchdog-status.json'), JSON.stringify({
        lastSeenAt: new Date().toISOString(), status: 'ok', recoveries: 2, lastRecoveryAt: new Date(Date.now() - 3_600_000).toISOString(),
    }));
    // The update check has found a newer release (GitHub faked: nothing leaves this machine).
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (input: any, init?: any) => {
        const url = typeof input === 'string' ? input : input?.url ?? String(input);
        if (url.startsWith('https://api.github.com/')) {
            return new Response(JSON.stringify([{ tag_name: 'v99.0.0', name: 'v99.0.0', body: '', html_url: 'https://example.org/r', published_at: '2026-11-01T00:00:00Z', draft: false, prerelease: false }]),
                { status: 200, headers: { 'Content-Type': 'application/json' } });
        }
        return realFetch(input, init);
    }) as typeof fetch;
    await backgroundUpdateCheck();
    globalThis.fetch = realFetch;
    assert(cachedNodeUpdateInfo()?.updateAvailable === true, `the update check holds a newer release, so /api/version has one to tell (${JSON.stringify(cachedNodeUpdateInfo()?.latestVersion)})`);
    const commit = getCommit();

    const https = await import('./https-server.js');
    BASE = `https://localhost:${await https.startHttpsServer(0)}`;
    resetAdminRateLimit = (https as any).resetAdminRateLimit;
    // The admin tarpit (admin-auth.ts) sleeps before it refuses, on each of the ~180 admin routes a caller sends here: as in
    // test-guest-view §11, a timer set from admin-auth fires at once. It decides only WHEN the 401 goes out, never what it
    // says, which is all this suite reads; every other timer keeps its delay.
    const realSetTimeout = globalThis.setTimeout;
    globalThis.setTimeout = ((fn: (...args: unknown[]) => void, ms?: number, ...args: unknown[]) =>
        realSetTimeout(fn, /[\\/]admin-auth\.[cm]?[jt]s:\d+/.test(new Error().stack ?? '') ? 0 : ms, ...args)) as unknown as typeof setTimeout;
    const stranger = newId();

    // ── 1. with both switches on, the figures are there to find ──
    setSwitches(true, true);
    {
        const info = await call('GET', null, '/api/community/info');
        const health = await call('GET', null, '/api/community/health');
        const node = await call('GET', null, '/api/node/info');
        const snap = await greeting(null);
        assert(info.body?.memberCount >= 2 && typeof info.body?.postCount === 'number' && typeof info.body?.transactionCount === 'number',
            `switches on: a stranger reads the member, listing and trade counts on /api/community/info (${JSON.stringify([info.body?.memberCount, info.body?.postCount, info.body?.transactionCount])})`);
        assert(health.body?.tree?.totalMembers >= 2 && typeof health.body?.activity?.last30Days === 'number'
            && typeof health.body?.activity?.activeMemberCount === 'number' && health.body?.watchdog?.recoveries === 2,
            `switches on: and the totals, the activity and the watchdog's 2 recoveries on /api/community/health (${JSON.stringify(health.body?.activity)}, ${JSON.stringify(health.body?.watchdog)})`);
        assert(node.body?.memberCount >= 2 && typeof node.body?.postCount === 'number', `switches on: and the counts on /api/node/info (${node.text.slice(0, 120)})`);
        assert(snap?.memberCount >= 2, `switches on: and the /ws greeting carries the member count (${JSON.stringify(snap)})`);
        assert(figuresIn(info.body).length > 0 && figuresIn(health.body).length > 0, 'the sweep\'s field scan finds them, so it can fail');
    }

    // ── 2. the sweep, both switches off ──
    setSwitches(false, false);
    const app = https.getKoaApp();
    if (!app) throw new Error('the server has no app to list the routes of');
    const served = [...new Set<string>(app.middleware.filter((m: any) => m.router).flatMap((m: any) => m.router.stack)
        .flatMap((l: any) => (l.methods as string[]).filter(m => m !== 'HEAD').map(m => `${m} ${l.path}`)))].sort();
    assert(served.length > 400, `the node serves ${served.length} routes, every one swept below`);
    const materialise = (p: string) => p.replace('(.*)', 'sentinel').replace(/:([A-Za-z]+)/g, (_, name: string) =>
        ['pubkey', 'publicKey'].includes(name) ? olive.pk : 'sentinel');
    const tally: Record<string, number> = {};
    for (const [who, id] of [['unsigned', null], ['a key that is no member here', stranger]] as const) {
        const failures: string[] = [];
        const unanswered: string[] = [];
        for (const route of served) {
            const [method, routePath] = route.split(' ') as [Method, string];
            const r = await call(method, id, materialise(routePath));
            tally[r.status] = (tally[r.status] ?? 0) + 1;
            if (r.status === 0 || r.status === 429) unanswered.push(`${route} ${r.status}`);
            const found = typeof r.body === 'object' ? figuresIn(r.body) : [];
            if (commit && commit !== 'unknown' && r.text.includes(commit)) found.push('the commit');
            if (found.length) failures.push(`${route} → ${r.status}: ${found.slice(0, 4).join(', ')}`);
        }
        if (failures.length) console.error(`  ${who}, every answer that gave a figure:\n    ${failures.join('\n    ')}`);
        assert(failures.length === 0, `switches off, ${who}: none of the ${served.length} routes (every method) gives a count, the activity, `
            + `the watchdog, the commit or the update check${failures.length ? ` — ${failures.length}: ${failures.slice(0, 6).join(' | ')}` : ''}`);
        assert(unanswered.length === 0, `switches off, ${who}: every route answered, none held back by a limit or a hang (so each was examined)${unanswered.length ? ` — ${unanswered.slice(0, 6).join(', ')}` : ''}`);
    }
    console.log(`  (answers by status: ${Object.entries(tally).map(([k, v]) => `${k}×${v}`).join(', ')})`);

    // ── 3. the socket greeting ──
    for (const [who, id] of [['unsigned', null], ['signed by a key that is no member here', stranger]] as const) {
        const snap = await greeting(id);
        assert(!!snap && figuresIn(snap).length === 0, `switches off: a socket ${who} is greeted with no count (${JSON.stringify(snap)})`);
    }

    // ── 4. a member reads every figure, whatever the switches say ──
    {
        const info = await call('GET', olive, '/api/community/info');
        const health = await call('GET', olive, '/api/community/health');
        const node = await call('GET', olive, '/api/node/info');
        const snap = await greeting(olive);
        assert(info.body?.memberCount >= 2 && typeof info.body?.postCount === 'number' && typeof info.body?.transactionCount === 'number',
            `switches off: a member, signing, still reads the counts on /api/community/info (${JSON.stringify([info.body?.memberCount, info.body?.postCount, info.body?.transactionCount])})`);
        assert(health.body?.tree?.totalMembers >= 2 && typeof health.body?.activity?.last7Days === 'number'
            && typeof health.body?.activity?.inactiveMemberCount === 'number' && health.body?.watchdog?.recoveries === 2,
            `switches off: and the totals, the activity and the watchdog on /api/community/health (${JSON.stringify([health.body?.tree?.totalMembers, health.body?.activity, health.body?.watchdog])})`);
        assert(node.body?.memberCount >= 2, `switches off: and the counts on /api/node/info (${node.text.slice(0, 120)})`);
        assert(snap?.memberCount >= 2, `switches off: and the /ws greeting's member count (${JSON.stringify(snap)})`);
        const strangerHealth = await call('GET', null, '/api/community/health');
        assert(typeof strangerHealth.body?.version === 'string' && typeof strangerHealth.body?.minAppVersion === 'string' && !!strangerHealth.body?.appFloors,
            `switches off: a stranger still reads the version and the app floors the apps check before anyone signs in (${strangerHealth.text.slice(0, 160)})`);
    }

    // ── 5. each switch alone ──
    {
        setSwitches(false, true);
        const h = (await call('GET', null, '/api/community/health')).body;
        const i = (await call('GET', null, '/api/community/info')).body;
        assert(i?.memberCount === undefined && h?.tree === undefined && h?.activity?.totalTransactions === undefined && h?.activity?.totalPosts === undefined
            && h?.activity?.activeMemberCount === undefined && h?.activity?.inactiveMemberCount === undefined
            && typeof h?.activity?.last30Days === 'number' && h?.watchdog?.recoveries === 2,
            `Share Member Count off, Share Node Health on: the totals and the active and inactive members (their sum is the member count) go, the activity and the watchdog stay (${JSON.stringify(h?.activity)})`);
        setSwitches(true, false);
        const h2 = (await call('GET', null, '/api/community/health')).body;
        const i2 = (await call('GET', null, '/api/community/info')).body;
        assert(i2?.memberCount >= 2 && h2?.tree?.totalMembers >= 2 && typeof h2?.activity?.totalPosts === 'number'
            && h2?.activity?.last7Days === undefined && h2?.activity?.last30Days === undefined && h2?.activity?.activeMemberCount === undefined
            && h2?.watchdog === undefined,
            `Share Member Count on, Share Node Health off: the totals stay, the activity, the active members and the watchdog go (${JSON.stringify(h2?.activity)})`);
    }

    // ── 6. /api/version: the commit and the update check to an owner or admin only ──
    {
        setSwitches(true, true);
        const looks: Array<[string, Id | null, Record<string, string>, boolean]> = [
            ['unsigned', null, {}, false],
            ['a member, signing', olive, {}, false],
            ["a moderator's session", null, adminSession('moderator'), false],
            ["an admin's session", null, adminSession('admin'), true],
            ["an owner's session", null, adminSession('owner'), true],
            ['an ended session', null, { 'X-Admin-Session': 'sentinel-session' }, false],
        ];
        for (const [who, id, headers, told] of looks) {
            const v = await call('GET', id, '/api/version', headers);
            const has = ['commit', 'updateAvailable', 'latestVersion', 'lastUpdateCheck'].filter(k => k in (v.body ?? {}));
            assert(v.status === 200 && typeof v.body?.version === 'string' && (told ? has.length === 4 && v.body.updateAvailable === true : has.length === 0),
                `/api/version to ${who}: the version${told ? ', the commit and the update check' : ', and no commit or update check'} (${v.status} ${v.text.slice(0, 160)})`);
        }
    }

    console.log(`\n${passed}/${run} passed`);
    if (passed !== run) process.exitCode = 1;
}

main().then(() => process.exit(process.exitCode ?? 0)).catch(e => { console.error('❌ Test failed:', e); process.exit(1); });
