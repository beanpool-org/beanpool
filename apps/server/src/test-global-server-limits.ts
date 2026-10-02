/**
 * The global node's server limits (scratch/global-node/DESIGN-global-two-doors-fable.md §6, slice S7), over real HTTP
 * and WebSockets on the tunnel-origin port, where each client is told apart by CF-Connecting-IP as cloudflared sends it.
 * Local nodes keep today's numbers; every behaviour below that changes is the global profile's.
 *
 *   1. Local, unchanged: the socket caps are today's (2,000 on the node, 1,000 strangers, 8 strangers and 64 sockets an
 *      address, 8 a member), the listeners hold 4,096 connections, the non-member bucket is 120 a minute (the 121st
 *      unsigned request from one address is 429), a socket over a cap is refused with a plain 429 and charged to the
 *      address's requests, and every member socket hears member_joined.
 *   2. Global, the numbers (§6.4): 5,000 sockets on the node, 1,500 of them strangers', 1,000 an address, 8 strangers an
 *      address, 4 a member; the listeners hold every socket that allows and as many again; an operator's .env scales
 *      each (WS_MAX_SOCKETS and the rest), and a value that isn't a whole number is ignored, said once in the log.
 *   3. Global, real sockets at those numbers: a member's fifth socket is refused; 1,000 sockets from one address (250
 *      members, 4 each) open and the 1,001st is refused while another address still gets in; a ninth stranger's from an
 *      address is refused; 1,500 strangers' sockets from 188 addresses open and the 1,501st is refused, while a member
 *      still gets in.
 *   4. Global, the stopgap (§6.4, until the guest pass): 600 unsigned requests a minute from one address pass and the
 *      601st is 429; a member behind that address keeps their own 120; a fresh keypair's signed read is still charged
 *      to the address (M-4), so it is refused once the address's 600 are spent.
 *   5. Global, a socket refused for a cap (§6.5): the upgrade completes and closes at once with the "no room" close
 *      code and the minutes to wait, which the apps read (@beanpool/core wsNoRoomRetrySec); it is not charged to the
 *      address's request bucket (at a limit of 2 a minute, 10 for non-members on global: 8 held and 5 refused sockets
 *      leave its HTTP answered 200); past the non-member bucket's worth of refused sockets in a minute the old refusal
 *      (plain 429, charged) comes back; a full node refuses the same way, uncharged.
 *   6. Global, member_joined (§6.5): a join reaches the joiner's own socket, which becomes a member's, and no other
 *      member's socket; the members' version still moves, so the next read sees the newcomer; the operator's
 *      node_config row nodeProfile.announceJoins = true puts the broadcast back.
 *
 * On origin/main sections 2 to 6 fail (the new names are loaded only if they exist, so the suite runs there); section
 * 1 pins what must not change, and passes there by design.
 *
 * Run: BEANPOOL_DATA_DIR=$(mktemp -d) pnpm exec tsx src/test-global-server-limits.ts
 */
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
delete process.env.CF_RECORD_NAME;
delete process.env.ENFORCE_WS_AUTH;
delete process.env.NODE_PROFILE;
for (const name of ['WS_MAX_SOCKETS', 'WS_MAX_STRANGER_SOCKETS', 'WS_MAX_SOCKETS_PER_ADDRESS', 'WS_MAX_STRANGER_SOCKETS_PER_ADDRESS', 'WS_MAX_SOCKETS_PER_MEMBER']) {
    delete process.env[name];
}

import crypto from 'node:crypto';
import WebSocket from 'ws';
import { localFetch } from './keepalive-test-fetch.js';

let run = 0, passed = 0;
function assert(cond: boolean, msg: string): void {
    run++;
    if (cond) { passed++; console.log(`✓ ${msg}`); } else console.error(`✗ ${msg}`);
}
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

type Id = { pubKeyHex: string; privateKey: crypto.KeyObject };
function keypair(): Id {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    return { pubKeyHex: publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('hex'), privateKey };
}

function signedWsQuery(id: Id): string {
    const ts = Date.now();
    const nonce = crypto.randomBytes(16).toString('hex');
    const sig = crypto.sign(null, Buffer.from(`WS\n/ws\n${ts}\n${nonce}\n`), id.privateKey).toString('base64');
    return `pubkey=${id.pubKeyHex}&ts=${ts}&nonce=${nonce}&sig=${encodeURIComponent(sig)}`;
}

function signedHeaders(id: Id, method: string, path: string, body = ''): Record<string, string> {
    const ts = String(Date.now()), nonce = crypto.randomBytes(16).toString('hex');
    const sig = crypto.sign(null, Buffer.from(`${method}\n${path.split('?')[0]}\n${ts}\n${nonce}\n${body}`), id.privateKey).toString('base64');
    return { 'X-Public-Key': id.pubKeyHex, 'X-Signature': sig, 'X-Timestamp': ts, 'X-Nonce': nonce };
}

/** What cloudflared forwards for a client at `ip`. */
const via = (ip: string) => ({ 'cf-connecting-ip': ip, 'x-forwarded-for': ip });

type Closed = { code: number; reason: string };
type Open = { kind: 'open'; ws: WebSocket; closed: Promise<Closed>; events: any[] };
type Outcome = Open | { kind: 'status'; status: number } | { kind: 'destroyed'; error: string };

/** `old`: an app built before the "no room" close, which doesn't send `nr=1` (a current one does). */
function upgrade(url: string, ip: string, old = false): Promise<Outcome> {
    if (!old) url += `${url.includes('?') ? '&' : '?'}nr=1`;
    return new Promise((resolve) => {
        const ws = new WebSocket(url, { headers: via(ip) });
        const events: any[] = [];
        let settled = false;
        const done = (o: Outcome) => { if (!settled) { settled = true; resolve(o); } };
        const closed = new Promise<Closed>(r => ws.on('close', (code, reason) => r({ code, reason: reason.toString() })));
        ws.on('message', (d) => { try { events.push(JSON.parse(d.toString())); } catch { /* not JSON */ } });
        ws.on('open', () => done({ kind: 'open', ws, closed, events }));
        ws.on('unexpected-response', (_req, res) => { done({ kind: 'status', status: res.statusCode || 0 }); res.resume(); ws.terminate(); });
        ws.on('error', (e) => done({ kind: 'destroyed', error: e.message }));
        setTimeout(() => done({ kind: 'destroyed', error: 'timeout' }), 8000);
    });
}
const show = (o: Outcome) => o.kind === 'open' ? '101' : o.kind === 'status' ? String(o.status) : `destroyed (${o.error})`;

/** Opened and still open after `ms`: the server kept it (a socket refused for a cap closes at once). */
async function stillOpenAfter(o: Outcome, ms = 300): Promise<boolean> {
    if (o.kind !== 'open') return false;
    const r = await Promise.race([o.closed, sleep(ms).then(() => null)]);
    return r === null;
}

/** How a socket over a cap was answered: `kept`, a plain HTTP status, or the close (code and reason) it got at once. */
async function answer(o: Outcome, ms = 1500): Promise<string> {
    if (o.kind !== 'open') return show(o);
    const r = await Promise.race([o.closed, sleep(ms).then(() => null)]);
    return r === null ? 'kept' : `closed ${r.code} ${r.reason}`;
}

/** Close every open socket in `list` and wait until the server has seen each go. */
async function closeAll(list: Outcome[]): Promise<void> {
    const open = list.filter((o): o is Open => o.kind === 'open');
    for (const o of open) { try { o.ws.close(); } catch { /* closing */ } }
    await Promise.all(open.map(o => Promise.race([o.closed, sleep(3000)])));
    await sleep(200);
}

/** Open `urls` (with their address) a few at a time, in order. */
async function openMany(items: Array<{ url: string; ip: string }>, parallel = 25): Promise<Outcome[]> {
    const out: Outcome[] = new Array(items.length);
    for (let i = 0; i < items.length; i += parallel) {
        const batch = items.slice(i, i + parallel);
        const got = await Promise.all(batch.map(({ url, ip }) => upgrade(url, ip)));
        got.forEach((o, j) => { out[i + j] = o; });
    }
    return out;
}

const tally = (list: Outcome[]) => {
    const counts = new Map<string, number>();
    for (const o of list) counts.set(show(o), (counts.get(show(o)) ?? 0) + 1);
    return [...counts].map(([k, n]) => `${n}×${k}`).join(', ');
};

async function main() {
    const wsl: any = await import('./ws-limits.js');
    const svl: any = await import('./server-limits.js');
    const core: any = await import('@beanpool/core');
    const NO_ROOM: number | undefined = core.WS_NO_ROOM_CLOSE_CODE;

    const { initTls } = await import('./services/tls.js');
    const se: any = await import('./state-engine.js');
    const { startHttpServer } = await import('./http-server.js');
    const { startHttpsServer } = await import('./https-server.js');
    const { db } = await import('./db/db.js');
    const { updateGatewayConfig, DEFAULT_GATEWAY_CONFIG } = await import('./config/local-config.js');
    const { resetGatewayRateLimit } = await import('./gateway-rate-limit.js');
    const { registerOpenJoin } = await import('./engine/open-join.js');
    const { getMembersVersion } = await import('./engine/versions.js');
    const { NODE_PROFILE_KEY } = await import('./config/node-profile.js');

    await initTls();
    se.initStateEngine();
    const httpPort = await startHttpServer(0);
    await startHttpsServer(0);
    const BASE = `http://127.0.0.1:${httpPort}`;
    const WS = `ws://127.0.0.1:${httpPort}/ws`;

    const unlimited = { ...DEFAULT_GATEWAY_CONFIG, rateLimiting: { enabled: false, maxRequestsPerMinute: 120 } };
    const atDefault = { ...DEFAULT_GATEWAY_CONFIG, rateLimiting: { enabled: true, maxRequestsPerMinute: 120 } };
    const atTen = { ...DEFAULT_GATEWAY_CONFIG, rateLimiting: { enabled: true, maxRequestsPerMinute: 10 } };
    // 10 a minute for non-members on global (five times the limit), and as many refused sockets answered with the close.
    const atTwo = { ...DEFAULT_GATEWAY_CONFIG, rateLimiting: { enabled: true, maxRequestsPerMinute: 2 } };
    updateGatewayConfig(unlimited);

    const insertMember = db.prepare(`INSERT INTO members (public_key, callsign, status, joined_at, invited_by, invite_code)
                VALUES (?, ?, 'active', strftime('%Y-%m-%dT%H:%M:%fZ','now'), 'seed', 'seed')`);
    const insertAccount = db.prepare(`INSERT OR IGNORE INTO accounts (public_key, balance, last_demurrage_epoch) VALUES (?, 0, 0)`);
    let made = 0;
    const member = (): Id => {
        const id = keypair();
        insertMember.run(id.pubKeyHex, `Lim${++made}`);
        insertAccount.run(id.pubKeyHex);
        return id;
    };

    const call = async (method: string, path: string, ip: string, headers: Record<string, string> = {}) => {
        const r = await localFetch(`${BASE}${path}`, { method, headers: { ...via(ip), ...headers } });
        await r.arrayBuffer();
        return r.status;
    };
    /** `n` unsigned GETs of a cheap public route from `ip`, in order: the statuses. */
    const unsignedReads = async (ip: string, n: number) => {
        const out: number[] = [];
        for (let i = 0; i < n; i += 20) {
            const batch = await Promise.all(Array.from({ length: Math.min(20, n - i) }, () => call('GET', '/api/version', ip)));
            out.push(...batch);
        }
        return out;
    };

    const setProfile = (p: 'local' | 'global') => {
        if (p === 'global') process.env.NODE_PROFILE = 'global'; else delete process.env.NODE_PROFILE;
        wsl.setWsLimitsForTests?.(undefined);
    };

    // ── 1. Local, unchanged ──────────────────────────────────────────────────────────────────────────────
    console.log('\n— 1. local: today\'s numbers —');
    {
        setProfile('local');
        const l = wsl.wsLimits();
        assert(l.maxSockets === 2000 && l.maxStrangerSockets === 1000 && l.maxStrangerSocketsPerAddress === 8
            && l.maxSocketsPerAddress === 64 && l.maxSocketsPerMember === 8 && l.maxLogSockets === 16 && l.framesPerMinute === 60
            && l.maxPayloadBytes === 4096,
            `the socket caps are today's: 2,000 / 1,000 strangers / 8 strangers and 64 an address / 8 a member (${JSON.stringify(l)})`);
        assert(!l.noRoomClose, 'a socket over a cap is refused before the upgrade, as today (no "no room" close)');
        assert(svl.serverLimits().maxConnections === 4096, `each listener holds 4,096 connections, as today (${svl.serverLimits().maxConnections})`);

        updateGatewayConfig(atDefault);
        resetGatewayRateLimit();
        const reads = await unsignedReads('203.0.113.1', 121);
        assert(reads.slice(0, 120).every(s => s === 200) && reads[120] === 429,
            `120 unsigned requests a minute from one address, the 121st 429 (${reads.filter(s => s === 200).length} × 200, last ${reads[120]})`);

        updateGatewayConfig(atTen);
        resetGatewayRateLimit();
        const held = await openMany(Array.from({ length: 8 }, () => ({ url: WS, ip: '203.0.113.2' })));
        const ninth = await upgrade(WS, '203.0.113.2');
        const tenth = await upgrade(WS, '203.0.113.2');
        assert(held.every(o => o.kind === 'open') && [ninth, tenth].every(o => o.kind === 'status' && o.status === 429),
            `a ninth and tenth stranger's socket from an address are refused with a plain 429 (${tally(held)}; then ${show(ninth)}, ${show(tenth)})`);
        const http = await call('GET', '/api/version', '203.0.113.2');
        assert(http === 429, `and the refused sockets were charged to the address: 8 held and 2 refused spend a limit of 10, so its next request is 429 (got ${http})`);
        await closeAll([...held, ninth, tenth]);

        updateGatewayConfig(unlimited);
        const watcher = member();
        const w = await upgrade(`${WS}?${signedWsQuery(watcher)}`, '203.0.113.3');
        const joiner = keypair();
        registerOpenJoin(se.broadcast, { publicKey: joiner.pubKeyHex, callsign: 'LocalJoiner', provider: 'google', joinHash: crypto.randomBytes(32).toString('hex'), ipHash: crypto.randomBytes(16).toString('hex') });
        await sleep(400);
        assert(w.kind === 'open' && w.events.some(e => e.type === 'member_joined' && e.member?.publicKey === joiner.pubKeyHex),
            'every member socket hears member_joined, as today');
        await closeAll([w]);
    }

    // ── 2. Global, the numbers ───────────────────────────────────────────────────────────────────────────
    console.log('\n— 2. global: the numbers —');
    {
        setProfile('global');
        const g = wsl.wsLimits();
        assert(g.maxSockets === 5000 && g.maxStrangerSockets === 1500 && g.maxSocketsPerAddress === 1000
            && g.maxStrangerSocketsPerAddress === 8 && g.maxSocketsPerMember === 4,
            `global: 5,000 sockets, 1,500 strangers', 1,000 an address, 8 strangers an address, 4 a member (${JSON.stringify(g)})`);
        assert(g.maxPayloadBytes === 4096 && g.framesPerMinute === 60 && g.maxLogSockets === 16, 'the frame caps and the admin\'s log sockets are the same on both profiles');
        assert(g.noRoomClose === true, 'a socket over a cap gets the "no room" close');
        const conns = svl.serverLimits().maxConnections;
        assert(conns >= 2 * (5000 + 16), `each listener holds every socket allowed and as many again for HTTP (${conns} ≥ ${2 * 5016})`);

        const warns: string[] = [];
        const origWarn = console.warn;
        console.warn = (...a: unknown[]) => { warns.push(a.map(String).join(' ')); };
        try {
            process.env.WS_MAX_SOCKETS = '20000';
            process.env.WS_MAX_STRANGER_SOCKETS = '6000';
            const scaled = wsl.wsLimits();
            assert(scaled.maxSockets === 20000 && scaled.maxStrangerSockets === 6000 && scaled.maxSocketsPerMember === 4,
                `WS_MAX_SOCKETS=20000 and WS_MAX_STRANGER_SOCKETS=6000 in the .env scale the node (a 4 GB server), the rest stay (${scaled.maxSockets}, ${scaled.maxStrangerSockets}, ${scaled.maxSocketsPerMember})`);
            assert(svl.serverLimits().maxConnections >= 2 * (20000 + 16), `and the listeners follow (${svl.serverLimits().maxConnections})`);
            process.env.WS_MAX_STRANGER_SOCKETS = '90000';
            assert(wsl.wsLimits().maxStrangerSockets === 20000, `strangers never get more places than the node has (${wsl.wsLimits().maxStrangerSockets})`);
            process.env.WS_MAX_SOCKETS = 'lots';
            delete process.env.WS_MAX_STRANGER_SOCKETS;
            for (let i = 0; i < 5; i++) wsl.wsLimits();
            assert(wsl.wsLimits().maxSockets === 5000, `WS_MAX_SOCKETS=lots is ignored: the profile's 5,000 (${wsl.wsLimits().maxSockets})`);
            const said = warns.filter(w => w.includes('WS_MAX_SOCKETS'));
            assert(said.length === 1, `and said once in the log, however often the caps are read (${said.length}: ${said[0] ?? ''})`);
            process.env.WS_MAX_SOCKETS_PER_MEMBER = '0';
            assert(wsl.wsLimits().maxSocketsPerMember === 4, 'a cap of 0 is not a cap: ignored');
        } finally {
            console.warn = origWarn;
            delete process.env.WS_MAX_SOCKETS;
            delete process.env.WS_MAX_STRANGER_SOCKETS;
            delete process.env.WS_MAX_SOCKETS_PER_MEMBER;
        }
        setProfile('local');
        process.env.WS_MAX_SOCKETS_PER_ADDRESS = '200';
        assert(wsl.wsLimits().maxSocketsPerAddress === 200 && wsl.wsLimits().maxSockets === 2000,
            'the .env tunes a local community too, and nothing else of it moves');
        delete process.env.WS_MAX_SOCKETS_PER_ADDRESS;
        assert(wsl.wsLimits().maxSocketsPerAddress === 64, 'without it, today\'s 64');
        setProfile('global');
    }

    // ── 3. Global, real sockets at the numbers ───────────────────────────────────────────────────────────
    console.log('\n— 3. global: real sockets at the numbers —');
    {
        setProfile('global');
        updateGatewayConfig(unlimited);
        resetGatewayRateLimit();
        const ada = member();
        const four = await openMany(Array.from({ length: 4 }, (_, i) => ({ url: `${WS}?${signedWsQuery(ada)}`, ip: `203.0.113.${10 + i}` })));
        const fifth = await upgrade(`${WS}?${signedWsQuery(ada)}`, '203.0.113.14');
        const fifthAnswer = await answer(fifth);
        assert(four.every(o => o.kind === 'open') && fifthAnswer.startsWith(`closed ${NO_ROOM} `),
            `a member's 4 sockets open and the fifth is refused with the "no room" close (${tally(four)}; fifth ${fifthAnswer})`);
        await closeAll([...four, fifth]);

        const HALL = '203.0.113.20';
        const t0 = Date.now();
        const crowd = Array.from({ length: 250 }, () => member());
        const hall = await openMany(crowd.flatMap(m => Array.from({ length: 4 }, () => ({ url: `${WS}?${signedWsQuery(m)}`, ip: HALL }))));
        const hallMs = Date.now() - t0;
        const opened = hall.filter(o => o.kind === 'open').length;
        assert(opened === 1000, `1,000 sockets from one address (250 members, 4 each) open (${tally(hall)}, ${hallMs} ms)`);
        const extra = await upgrade(`${WS}?${signedWsQuery(member())}`, HALL);
        const extraAnswer = await answer(extra);
        assert(extraAnswer.startsWith(`closed ${NO_ROOM} `), `the 1,001st from that address is refused (${extraAnswer})`);
        const elsewhere = await upgrade(`${WS}?${signedWsQuery(member())}`, '203.0.113.21');
        assert(await stillOpenAfter(elsewhere), `another address's socket still opens (${show(elsewhere)})`);
        const counts = wsl.wsSocketCounts();
        assert(counts.total === 1001, `the node holds exactly those 1,001 (${JSON.stringify(counts)})`);
        await closeAll([...hall, extra, elsewhere]);

        const strangers = await openMany(Array.from({ length: 8 }, () => ({ url: WS, ip: '203.0.113.30' })));
        const ninth = await upgrade(WS, '203.0.113.30');
        const ninthAnswer = await answer(ninth);
        assert(strangers.every(o => o.kind === 'open') && ninthAnswer.startsWith(`closed ${NO_ROOM} `),
            `8 strangers' sockets from one address open and the ninth is refused (${tally(strangers)}; ninth ${ninthAnswer})`);
        await closeAll([...strangers, ninth]);

        const t1 = Date.now();
        const lobby = await openMany(Array.from({ length: 1500 }, (_, i) => ({ url: WS, ip: `198.18.${Math.floor(i / 8)}.${(i % 8) + 1}` })));
        const lobbyMs = Date.now() - t1;
        assert(lobby.filter(o => o.kind === 'open').length === 1500, `1,500 strangers' sockets from 188 addresses open (${tally(lobby)}, ${lobbyMs} ms)`);
        const over = await upgrade(WS, '198.18.200.1');
        const overAnswer = await answer(over);
        assert(overAnswer.startsWith(`closed ${NO_ROOM} `), `the 1,501st stranger, from a fresh address, is refused: strangers hold at most their share (${overAnswer})`);
        const bea = await upgrade(`${WS}?${signedWsQuery(member())}`, '198.18.200.2');
        assert(await stillOpenAfter(bea), `a member still gets in (${show(bea)})`);
        await closeAll([...lobby, over, bea]);
        const after = wsl.wsSocketCounts();
        assert(after.total === 0 && after.strangers === 0, `every place is given back (${JSON.stringify(after)})`);
    }

    // ── 4. Global, the stopgap ───────────────────────────────────────────────────────────────────────────
    console.log('\n— 4. global: 600 a minute for non-members —');
    {
        setProfile('global');
        updateGatewayConfig(atDefault);
        resetGatewayRateLimit();
        const ADDR = '203.0.113.40';
        const reads = await unsignedReads(ADDR, 601);
        const ok = reads.filter(s => s === 200).length;
        assert(reads.slice(0, 600).every(s => s === 200) && reads[600] === 429,
            `600 unsigned requests a minute from one address pass, the 601st is 429 (${ok} × 200, last ${reads[600]})`);
        const cy = member();
        const own: number[] = [];
        for (let i = 0; i < 120; i++) own.push(await call('GET', '/api/version', ADDR, signedHeaders(cy, 'GET', '/api/version')));
        const ownOver = await call('GET', '/api/version', ADDR, signedHeaders(cy, 'GET', '/api/version'));
        assert(own.every(s => s === 200) && ownOver === 429,
            `a member behind that address keeps their own 120 a minute, as before (${own.filter(s => s === 200).length} × 200, then ${ownOver})`);
        const fresh = await call('GET', '/api/version', ADDR, signedHeaders(keypair(), 'GET', '/api/version'));
        assert(fresh === 429, `a fresh keypair's signed read is charged to the spent address, not a bucket of its own (M-4) (got ${fresh})`);
        updateGatewayConfig(unlimited);
    }

    // ── 5. Global, a socket refused for a cap ────────────────────────────────────────────────────────────
    console.log('\n— 5. global: the "no room" close —');
    {
        setProfile('global');
        updateGatewayConfig(atTwo);
        resetGatewayRateLimit();
        const ADDR = '203.0.113.50';
        const held = await openMany(Array.from({ length: 8 }, () => ({ url: WS, ip: ADDR })));
        const refused: string[] = [];
        let first: Closed | null = null;
        for (let i = 0; i < 5; i++) {
            const o = await upgrade(WS, ADDR);
            refused.push(await answer(o));
            if (o.kind === 'open' && !first) first = await Promise.race([o.closed, sleep(10).then(() => null)]);
        }
        assert(held.every(o => o.kind === 'open') && refused.every(a => a.startsWith(`closed ${NO_ROOM} `)),
            `at a limit of 2 (10 for non-members): 8 strangers' sockets held, 5 more refused with the "no room" close (${refused.join(' | ')})`);
        const wait = core.wsNoRoomRetrySec?.(first?.code, first?.reason);
        assert(wait === 300, `the close says to come back in 5 minutes, as the apps read it (${first?.code} "${first?.reason}" → ${wait})`);
        const http = await call('GET', '/api/version', ADDR);
        assert(http === 200, `the refused sockets were not charged to the address: its next request is 200 (got ${http})`);

        // The refused sockets an address may have answered with the close are its non-member bucket's worth a minute
        // (10 here); past that the old refusal, charged, comes back.
        const more: string[] = [];
        for (let i = 0; i < 6; i++) more.push(await answer(await upgrade(WS, ADDR)));
        assert(more.slice(0, 5).every(a => a.startsWith(`closed ${NO_ROOM} `)) && more[5] === '429',
            `the 11th refused socket in a minute from that address gets a plain 429 (${more.join(' | ')})`);
        const afterFlood = await call('GET', '/api/version', ADDR);
        assert(afterFlood === 429, `and that one is charged: 8 held, 1 request and 1 charged refusal spend the address's 10, so its next request is 429 (got ${afterFlood})`);
        await closeAll(held);

        // A full node: the first check, before anything is charged.
        resetGatewayRateLimit();
        wsl.setWsLimitsForTests({ maxSockets: 3 });
        const full = await openMany(Array.from({ length: 3 }, (_, i) => ({ url: `${WS}?${signedWsQuery(member())}`, ip: `203.0.113.${60 + i}` })));
        const turnedAway: string[] = [];
        for (let i = 0; i < 4; i++) turnedAway.push(await answer(await upgrade(`${WS}?${signedWsQuery(member())}`, '203.0.113.63')));
        assert(full.every(o => o.kind === 'open') && turnedAway.every(a => a.startsWith(`closed ${NO_ROOM} `)),
            `a full node lets the socket in and closes it with "no room" (${turnedAway.join(' | ')})`);
        const fromThere: number[] = [];
        for (let i = 0; i < 10; i++) fromThere.push(await call('GET', '/api/version', '203.0.113.63'));
        assert(fromThere.every(s => s === 200), `uncharged: that address still has its 10 requests (${fromThere.join(',')})`);
        await closeAll(full);
        wsl.setWsLimitsForTests(undefined);
        updateGatewayConfig(unlimited);
    }

    // ── 6. Global, member_joined ─────────────────────────────────────────────────────────────────────────
    console.log('\n— 6. global: member_joined to the joiner only —');
    {
        setProfile('global');
        updateGatewayConfig(unlimited);
        const watcher = member();
        const w = await upgrade(`${WS}?${signedWsQuery(watcher)}`, '203.0.113.70');
        const joiner = keypair();
        const mine = await upgrade(`${WS}?${signedWsQuery(joiner)}`, '203.0.113.71');
        const before = getMembersVersion();
        const joined = registerOpenJoin(se.broadcast, { publicKey: joiner.pubKeyHex, callsign: 'GlobalJoiner', provider: 'google', joinHash: crypto.randomBytes(32).toString('hex'), ipHash: crypto.randomBytes(16).toString('hex') });
        await sleep(400);
        assert(joined.ok, 'the join went through');
        assert(w.kind === 'open' && !w.events.some(e => e.type === 'member_joined'),
            `another member's socket does not hear it (${w.kind === 'open' ? w.events.map(e => e.type).join(',') : show(w)})`);
        assert(mine.kind === 'open' && mine.events.some(e => e.type === 'member_joined' && e.member?.publicKey === joiner.pubKeyHex),
            "the joiner's own socket does");
        assert(getMembersVersion() > before, `the members' version still moves, so the next read sees them (${before} → ${getMembersVersion()})`);
        // The joiner's socket is a member's now: it hears the member feed (a profile change, which strangers never get).
        se.broadcast({ type: 'profile_updated', publicKey: watcher.pubKeyHex });
        await sleep(300);
        assert(mine.kind === 'open' && mine.events.some(e => e.type === 'profile_updated'), "and the joiner's socket was made a member's: it hears the member feed");

        db.prepare('INSERT INTO node_config (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(`${NODE_PROFILE_KEY}.announceJoins`, 'true');
        const second = keypair();
        registerOpenJoin(se.broadcast, { publicKey: second.pubKeyHex, callsign: 'SecondJoiner', provider: 'google', joinHash: crypto.randomBytes(32).toString('hex'), ipHash: crypto.randomBytes(16).toString('hex') });
        await sleep(400);
        assert(w.kind === 'open' && w.events.some(e => e.type === 'member_joined' && e.member?.publicKey === second.pubKeyHex),
            'the operator\'s nodeProfile.announceJoins = true puts the broadcast back');
        db.prepare('DELETE FROM node_config WHERE key = ?').run(`${NODE_PROFILE_KEY}.announceJoins`);
        await closeAll([w, mine]);
    }

    // ── 7. Old apps are refused the old way; a lowered node cap keeps the members' places ──────────────────
    console.log('\n— 7. old clients get the plain 503; WS_MAX_SOCKETS alone scales strangers —');
    {
        setProfile('global');
        updateGatewayConfig(unlimited);
        wsl.setWsLimitsForTests({ maxSockets: 2, maxStrangerSockets: 2, maxSocketsPerAddress: 100 });
        const two = [await upgrade(WS, '203.0.113.90'), await upgrade(WS, '203.0.113.91')];
        const oldOne = await upgrade(WS, '203.0.113.92', true);
        assert(oldOne.kind === 'status' && oldOne.status === 503, `a client that doesn't send nr=1 on a full global node gets the plain 503, as before (${show(oldOne)})`);
        const newOne = await upgrade(WS, '203.0.113.93');
        const newAnswer = await answer(newOne);
        assert(newAnswer === `closed ${NO_ROOM} retry=300`, `a client that sends nr=1 gets the 4429 close (${newAnswer})`);
        await closeAll([...two, newOne]);
        wsl.setWsLimitsForTests(undefined);

        // The strangers' cap follows the node's cap when only that is set: half on local, 30% on global.
        setProfile('local');
        process.env.WS_MAX_SOCKETS = '20';
        const warns: string[] = [];
        const origWarn = console.warn;
        console.warn = (...a: unknown[]) => { warns.push(a.map(String).join(' ')); };
        try {
            assert(wsl.wsLimits().maxSockets === 20 && wsl.wsLimits().maxStrangerSockets === 10,
                `local WS_MAX_SOCKETS=20 alone: strangers capped at 10 (${wsl.wsLimits().maxStrangerSockets})`);
            const strangers = await openMany(Array.from({ length: 12 }, (_, i) => ({ url: WS, ip: `198.51.100.${i + 1}` })));
            const kept = strangers.filter(o => o.kind === 'open').length;
            const refusedStrangers = strangers.filter(o => o.kind === 'status' && o.status === 503).length;
            assert(kept === 10 && refusedStrangers === 2, `12 strangers from 12 addresses: 10 kept, 2 refused (${tally(strangers)})`);
            const m = await upgrade(`${WS}?${signedWsQuery(member())}`, '198.51.100.200');
            assert(await stillOpenAfter(m), `and a member still connects (${show(m)})`);
            await closeAll([...strangers, m]);

            setProfile('global');
            process.env.WS_MAX_SOCKETS = '1500';
            assert(wsl.wsLimits().maxStrangerSockets === 450, `global WS_MAX_SOCKETS=1500 alone: strangers capped at 450 (${wsl.wsLimits().maxStrangerSockets})`);
            process.env.WS_MAX_STRANGER_SOCKETS = '1500';
            for (let i = 0; i < 3; i++) wsl.wsLimits();
            assert(wsl.wsLimits().maxStrangerSockets === 1500, 'an explicit WS_MAX_STRANGER_SOCKETS is kept');
            const said = warns.filter(w => w.includes('WS_MAX_STRANGER_SOCKETS'));
            assert(said.length === 1, `an explicit value that leaves members no places is said once in the log (${said.length}: ${said[0] ?? ''})`);
        } finally {
            console.warn = origWarn;
            delete process.env.WS_MAX_SOCKETS;
            delete process.env.WS_MAX_STRANGER_SOCKETS;
        }
        setProfile('global');
    }

    setProfile('local');
    console.log(`\n${passed}/${run} passed`);
    process.exit(passed === run ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
