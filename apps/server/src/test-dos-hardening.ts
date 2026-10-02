/**
 * DoS hardening (the Fable DoS review, scratch/reviews/FABLE-sec-dos.md, F1-F5, and global-abuse M-4), over real HTTP and
 * WebSockets on the tunnel-origin port, where each client is told apart by CF-Connecting-IP as cloudflared sends it:
 *
 *   1. F1, /ws frames: a frame over the 4 KiB cap closes the socket with 1009; a socket sending more than 60 frames a
 *      minute is closed with 1008; the heartbeat still gets its pong.
 *   2. F1, /ws sockets: a ninth stranger's socket from one address is refused 429, another address's is not; a member's
 *      ninth socket is refused 429; a closed socket gives its place back; strangers never take more than their half of
 *      the node, so a member still gets in when they have, and the node's cap holds for everyone (503).
 *   3. F1, upgrades are charged to the gateway limiter: an address's sixth upgrade in a minute at a limit of 5 is refused
 *      429, and so is its next unsigned HTTP request (the same bucket); a member's signed upgrade from it is not.
 *   4. F2, a forged signature claim is charged before its body is read: at a limit of 5 the sixth forged claim with a
 *      64 KB body from one address is refused 429 by the gateway; a member's small signed write from that address still
 *      gets through, as does a small forged claim (refused by the signature check, its body held to 16 KiB); a chunked
 *      one is refused 429. Claims whose body the parser never reads past 16 KiB (bodiless signed reads, small forged
 *      writes, /ws connect tokens) don't spend that allowance: after twice the limit of each from one address, a
 *      member's 20 KB chat line from it is answered 200, and forged claims with 1 MB bodies are still refused 429 past
 *      the limit (review 4150386879: a community event behind one NAT address). Only what the parser actually reads past
 *      16 KiB is charged (the confirm review of #1384, finding 2): after twice the limit of chunked forged claims carrying
 *      `{}`, and twice the limit declaring 1 MB that send 5 bytes and drop the connection, the member's chat line is
 *      still answered 200; chunked forged claims carrying 20 KB are refused 429 past the limit; and of two large claims
 *      let in together with one place left, the second is refused 429 once its body passes 16 KiB.
 *   5. M-4: fresh keypairs signing a public read from one address are charged to its unsigned bucket (429 on the sixth);
 *      members behind one address each keep their own.
 *   6. F4: /api/community/info and /health have a per-address bucket (429 past five times the minute's limit); a burst of
 *      50 of each runs the member and transaction counts once, not 50 times, and never the fraud analysis; a new member
 *      shows at once (the members version); /ws greetings use the same cached counts.
 *   7. F5, in part: a nearest-first read from a point far from every post measures at most ONE_PASS_MAX_MEASURED posts
 *      on a node holding more, and pages past the bound are empty; a page for a filter few posts match is still the
 *      brute-force page. With a radius or a filter only the distance CALLS are bounded, not the scan and sort before
 *      them (review 4150386976): those checks count calls and claim no more. F5 stays open for radius and filter reads.
 *   8. F3: a client that dribbles its headers is dropped at the header timeout; a body that takes longer than it (as the
 *      admin restore's 500 MB does) is not; the request timeout is still Node's 300 s; past the connection cap a new
 *      connection is closed at once.
 *   9. The limiter's upkeep (review 4150386780): a flood of forged claims from rotating IPv6 /64s, past the 20,000 live
 *      buckets that start its prune, prunes at most once a request and once a second, and costs a small fraction of the
 *      CPU it did at 06491de5 (three full prunes a request); flooding on, the buckets stay under GATEWAY_MAX_BUCKETS; the
 *      limiter still limits afterwards.
 *  10. The cap forgets the least-counted buckets first (the confirm review of #1384, finding 1): an address at its
 *      unsigned limit, a member at theirs, an address at its signed ceiling, one that spent its large claims and one at
 *      its peer reads are each still refused 429 after a flood from rotating /64s, inside the same minute, that asked
 *      for several times GATEWAY_MAX_BUCKETS new buckets.
 *
 * On origin/main every numbered section fails (its modules are loaded here only if they exist, so the suite runs there).
 *
 * Run: BEANPOOL_DATA_DIR=$(mktemp -d) pnpm exec tsx src/test-dos-hardening.ts
 */
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
delete process.env.CF_RECORD_NAME;
delete process.env.ENFORCE_WS_AUTH;
delete process.env.NODE_PROFILE;

import crypto from 'node:crypto';
import net from 'node:net';
import WebSocket from 'ws';
import { lockedDm } from './dm-test-payload.js';
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

function signedHeaders(id: Id, method: string, path: string, body = '', signer?: crypto.KeyObject): Record<string, string> {
    const ts = String(Date.now()), nonce = crypto.randomBytes(16).toString('hex');
    const sig = crypto.sign(null, Buffer.from(`${method}\n${path.split('?')[0]}\n${ts}\n${nonce}\n${body}`), signer ?? id.privateKey).toString('base64');
    return { 'X-Public-Key': id.pubKeyHex, 'X-Signature': sig, 'X-Timestamp': ts, 'X-Nonce': nonce };
}

/** What cloudflared forwards for a client at `ip`. */
const via = (ip: string) => ({ 'cf-connecting-ip': ip, 'x-forwarded-for': ip });

type Outcome = { kind: 'open'; ws: WebSocket; closed: Promise<number>; frames: string[] } | { kind: 'status'; status: number } | { kind: 'destroyed'; error: string };

function upgrade(url: string, ip: string): Promise<Outcome> {
    return new Promise((resolve) => {
        const ws = new WebSocket(url, { headers: via(ip) });
        const frames: string[] = [];
        let settled = false;
        const done = (o: Outcome) => { if (!settled) { settled = true; resolve(o); } };
        const closed = new Promise<number>(r => ws.on('close', (code) => r(code)));
        ws.on('message', (d) => frames.push(d.toString()));
        ws.on('open', () => done({ kind: 'open', ws, closed, frames }));
        ws.on('unexpected-response', (_req, res) => { done({ kind: 'status', status: res.statusCode || 0 }); res.resume(); ws.terminate(); });
        ws.on('error', (e) => done({ kind: 'destroyed', error: e.message }));
        setTimeout(() => done({ kind: 'destroyed', error: 'timeout' }), 4000);
    });
}
const show = (o: Outcome) => o.kind === 'open' ? '101' : o.kind === 'status' ? String(o.status) : `destroyed (${o.error})`;

/** Close every open socket in `list` and wait until the server has seen each go. */
async function closeAll(list: Outcome[]): Promise<void> {
    const open = list.filter((o): o is Extract<Outcome, { kind: 'open' }> => o.kind === 'open');
    for (const o of open) o.ws.close();
    await Promise.all(open.map(o => Promise.race([o.closed, sleep(2000)])));
    await sleep(150);
}

/**
 * A request written by hand to `port`, for bodies fetch can't send: chunked ones, or a length declared and never sent.
 * The status the server answered, or 0 when none came; with `drop`, the connection is closed 100 ms after the bytes are
 * written, answered or not.
 */
function rawRequest(port: number, bytes: string, drop = false): Promise<number> {
    return new Promise((resolve) => {
        const sock = net.connect(port, '127.0.0.1', () => {
            sock.write(bytes);
            if (drop) setTimeout(() => sock.destroy(), 100);
        });
        let buf = '';
        sock.on('data', d => { buf += d.toString(); });
        sock.on('error', () => { /* answered on close */ });
        sock.on('close', () => resolve(Number(/^HTTP\/1\.1 (\d{3})/.exec(buf)?.[1] ?? 0)));
        setTimeout(() => sock.destroy(), 5000);
    });
}

/** The code a socket closes with, or -1 if it is still open after `ms`. */
async function closeCode(o: Extract<Outcome, { kind: 'open' }>, ms = 3000): Promise<number> {
    return Promise.race([o.closed, sleep(ms).then(() => -1)]);
}

async function main() {
    // The new modules, only where they exist (on origin/main they don't, and the checks below fail there instead).
    const wsl: any = await import('./ws-limits.js').catch(() => null);
    const svl: any = await import('./server-limits.js').catch(() => null);
    // A second's header timeout, checked every 200 ms, and a connection cap a test can reach (section 8). Read when the
    // servers start.
    svl?.setServerLimitsForTests({ headersTimeoutMs: 1000, connectionsCheckingIntervalMs: 200, maxConnections: 300 });

    const { initTls } = await import('./services/tls.js');
    const se: any = await import('./state-engine.js');
    const { startHttpServer } = await import('./http-server.js');
    const { startHttpsServer } = await import('./https-server.js');
    const { db } = await import('./db/db.js');
    const { updateGatewayConfig, DEFAULT_GATEWAY_CONFIG } = await import('./config/local-config.js');
    const { resetGatewayRateLimit } = await import('./gateway-rate-limit.js');
    const engine: any = await import('@beanpool/engine');

    await initTls();
    se.initStateEngine();
    const httpPort = await startHttpServer(0);
    await startHttpsServer(0);
    const BASE = `http://127.0.0.1:${httpPort}`;
    const WS = `ws://127.0.0.1:${httpPort}/ws`;

    const LIMIT = 5;
    const limited = { ...DEFAULT_GATEWAY_CONFIG, rateLimiting: { enabled: true, maxRequestsPerMinute: LIMIT } };
    const unlimited = { ...DEFAULT_GATEWAY_CONFIG, rateLimiting: { enabled: false, maxRequestsPerMinute: LIMIT } };
    updateGatewayConfig(unlimited);

    const member = (callsign: string): Id => {
        const id = keypair();
        db.prepare(`INSERT INTO members (public_key, callsign, status, joined_at, invited_by, invite_code, avatar_url)
                    VALUES (?, ?, 'active', strftime('%Y-%m-%dT%H:%M:%fZ','now'), 'seed', 'seed', '/uploads/avatar.jpg')`).run(id.pubKeyHex, callsign);
        db.prepare(`INSERT OR IGNORE INTO accounts (public_key, balance, last_demurrage_epoch) VALUES (?, 0, 0)`).run(id.pubKeyHex);
        return id;
    };
    const ada = member('DosAda');
    const bea = member('DosBea');
    const cy = member('DosCy');

    const call = async (method: string, path: string, ip: string, headers: Record<string, string> = {}, body?: string) => {
        const r = await localFetch(`${BASE}${path}`, { method, headers: { ...via(ip), ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...headers }, body });
        const text = await r.text();
        let json: any = null;
        try { json = JSON.parse(text); } catch { /* not JSON */ }
        return { status: r.status, json, text };
    };

    // ── 1. Frames ────────────────────────────────────────────────────────────────────────────────────────
    console.log('\n— 1. /ws frames —');
    {
        const s = await upgrade(WS, '198.51.100.1');
        assert(s.kind === 'open', `an unsigned socket opens (${show(s)})`);
        if (s.kind === 'open') {
            s.ws.send(JSON.stringify({ type: 'ping', wantPong: true }));
            await sleep(200);
            assert(s.frames.some(f => f.includes('"pong"')), 'the heartbeat gets its pong');
            s.ws.send('x'.repeat(5000));
            const code = await closeCode(s);
            assert(code === 1009, `a 5,000-byte frame (over the 4 KiB cap) closes the socket with 1009 (got ${code})`);
        }
        const r = await upgrade(WS, '198.51.100.1');
        if (r.kind === 'open') {
            for (let i = 0; i < 61; i++) r.ws.send(JSON.stringify({ type: 'ping', wantPong: true }));
            const code = await closeCode(r);
            assert(code === 1008, `61 frames in a minute close the socket with 1008 (got ${code})`);
            assert(r.frames.filter(f => f.includes('"pong"')).length >= 50, `the frames before the cap were answered (${r.frames.filter(f => f.includes('"pong"')).length} pongs)`);
        } else assert(false, `a second socket opens (${show(r)})`);
        await sleep(200);
    }

    // ── 2. Sockets ───────────────────────────────────────────────────────────────────────────────────────
    console.log('\n— 2. /ws sockets —');
    {
        const strangers: Outcome[] = [];
        for (let i = 0; i < 8; i++) strangers.push(await upgrade(WS, '198.51.100.2'));
        assert(strangers.every(o => o.kind === 'open'), `8 unsigned sockets from one address open (${strangers.map(show).join(',')})`);
        const ninth = await upgrade(WS, '198.51.100.2');
        assert(ninth.kind === 'status' && ninth.status === 429, `the ninth from that address is refused 429 (got ${show(ninth)})`);
        const other = await upgrade(WS, '198.51.100.3');
        assert(other.kind === 'open', `another address's socket still opens (${show(other)})`);
        const guest = await upgrade(`${WS}?${signedWsQuery(keypair())}`, '198.51.100.2');
        assert(guest.kind === 'status' && guest.status === 429, `a socket signed by a key that is no member here is a stranger's too: refused 429 there (got ${show(guest)})`);
        const adaFromThere = await upgrade(`${WS}?${signedWsQuery(ada)}`, '198.51.100.2');
        assert(adaFromThere.kind === 'open', `a member's socket from that address still opens (${show(adaFromThere)})`);

        const first = strangers[0];
        if (first.kind === 'open') { first.ws.close(); await Promise.race([first.closed, sleep(2000)]); await sleep(150); }
        const again = await upgrade(WS, '198.51.100.2');
        assert(again.kind === 'open', `once one of them closes, its place is free again (${show(again)})`);
        await closeAll([...strangers, ninth, other, guest, adaFromThere, again]);

        const beas: Outcome[] = [];
        for (let i = 0; i < 8; i++) beas.push(await upgrade(`${WS}?${signedWsQuery(bea)}`, `198.51.100.${20 + i}`));
        assert(beas.every(o => o.kind === 'open'), `8 sockets signed by one member open (${beas.map(show).join(',')})`);
        const beaNinth = await upgrade(`${WS}?${signedWsQuery(bea)}`, '198.51.100.29');
        assert(beaNinth.kind === 'status' && beaNinth.status === 429, `that member's ninth socket is refused 429 (got ${show(beaNinth)})`);
        await closeAll([...beas, beaNinth]);

        // The node's caps, made small enough to fill: 10 sockets, strangers at most 4.
        wsl?.setWsLimitsForTests({ maxSockets: 10, maxStrangerSockets: 4 });
        const held: Outcome[] = [];
        for (let i = 0; i < 4; i++) held.push(await upgrade(WS, `198.51.100.${40 + i}`));
        assert(held.every(o => o.kind === 'open'), `4 strangers from 4 addresses open (${held.map(show).join(',')})`);
        const fifth = await upgrade(WS, '198.51.100.44');
        assert(fifth.kind === 'status' && fifth.status === 503, `a fifth stranger is refused 503: strangers hold at most their share of the node (got ${show(fifth)})`);
        for (let i = 0; i < 6; i++) held.push(await upgrade(`${WS}?${signedWsQuery(i < 3 ? ada : cy)}`, '198.51.100.45'));
        assert(held.slice(4).every(o => o.kind === 'open'), `members still get in, to the node's cap of 10 (${held.slice(4).map(show).join(',')})`);
        const overflow = await upgrade(`${WS}?${signedWsQuery(cy)}`, '198.51.100.46');
        assert(overflow.kind === 'status' && overflow.status === 503, `the eleventh socket, a member's, is refused 503: the node's cap holds (got ${show(overflow)})`);
        await closeAll([...held, fifth, overflow]);
        wsl?.setWsLimitsForTests(undefined);
        const counts = wsl?.wsSocketCounts?.();
        assert(!!counts && counts.total === 0 && counts.strangers === 0 && counts.addresses === 0 && counts.keys === 0,
            `every place is given back once the sockets close (${JSON.stringify(counts)})`);
    }

    // ── 3. Upgrades are charged to the gateway limiter ───────────────────────────────────────────────────
    console.log('\n— 3. upgrades are counted —');
    {
        updateGatewayConfig(limited);
        resetGatewayRateLimit();
        const statuses: string[] = [];
        for (let i = 0; i < LIMIT; i++) {
            const o = await upgrade(WS, '198.51.100.50');
            statuses.push(show(o));
            await closeAll([o]);
        }
        assert(statuses.every(s => s === '101'), `${LIMIT} unsigned upgrades from one address at a limit of ${LIMIT} open (${statuses.join(',')})`);
        const sixth = await upgrade(WS, '198.51.100.50');
        assert(sixth.kind === 'status' && sixth.status === 429, `the sixth is refused 429 by the gateway (got ${show(sixth)})`);
        const http = await call('GET', '/api/version', '198.51.100.50');
        assert(http.status === 429, `and that address's next unsigned HTTP request is 429 too: one bucket (got ${http.status})`);
        const signed = await upgrade(`${WS}?${signedWsQuery(ada)}`, '198.51.100.50');
        assert(signed.kind === 'open', `a member's signed upgrade from that address is charged to the member, and opens (${show(signed)})`);
        await closeAll([sixth, signed]);
        updateGatewayConfig(unlimited);
    }

    // ── 4. Forged signature claims ───────────────────────────────────────────────────────────────────────
    console.log('\n— 4. forged signature claims —');
    {
        updateGatewayConfig(limited);
        resetGatewayRateLimit();
        const PATH = '/api/marketplace/posts';
        const big = JSON.stringify({ type: 'offer', title: 'Forged', authorPublicKey: ada.pubKeyHex, pad: 'x'.repeat(64 * 1024) });
        const forged = () => signedHeaders(ada, 'POST', PATH, big, keypair().privateKey);
        const statuses: number[] = [];
        for (let i = 0; i < LIMIT; i++) statuses.push((await call('POST', PATH, '198.51.100.60', forged(), big)).status);
        assert(statuses.every(s => s === 401 || s === 403), `${LIMIT} forged claims with 64 KB bodies are refused by the signature check (${statuses.join(',')})`);
        const next = await call('POST', PATH, '198.51.100.60', forged(), big);
        assert(next.status === 429 && /Gateway rate limit/.test(next.json?.error ?? ''),
            `the sixth is refused 429 by the gateway, before its body is read: forged claims get the unsigned rate, not ${LIMIT * 10} (got ${next.status} ${next.text.slice(0, 80)})`);

        const small = JSON.stringify({ conversationId: 'none' });
        const adaWrite = await call('POST', '/api/messages/mark-read', '198.51.100.60', signedHeaders(ada, 'POST', '/api/messages/mark-read', small), small);
        assert(adaWrite.status !== 429, `a member's small signed write from that address still gets through (got ${adaWrite.status})`);
        const smallForged = await call('POST', PATH, '198.51.100.60', signedHeaders(ada, 'POST', PATH, small, keypair().privateKey), small);
        assert(smallForged.status === 401 || smallForged.status === 403, `a small forged claim is let through to the signature check, its body held to 16 KiB (got ${smallForged.status})`);
        const chunked = await new Promise<number>((resolve) => {
            const sock = net.connect(httpPort, '127.0.0.1', () => {
                const h = signedHeaders(ada, 'POST', PATH, '{}', keypair().privateKey);
                sock.write(`POST ${PATH} HTTP/1.1\r\nHost: x\r\nCF-Connecting-IP: 198.51.100.60\r\nContent-Type: application/json\r\nTransfer-Encoding: chunked\r\n`
                    + Object.entries(h).map(([k, v]) => `${k}: ${v}\r\n`).join('') + 'Connection: close\r\n\r\n2\r\n{}\r\n0\r\n\r\n');
            });
            let buf = '';
            sock.on('data', d => { buf += d.toString(); });
            sock.on('close', () => resolve(Number(/^HTTP\/1\.1 (\d{3})/.exec(buf)?.[1] ?? 0)));
            setTimeout(() => sock.destroy(), 3000);
        });
        assert(chunked === 429, `a forged claim with a chunked body (no length to hold it to) is refused 429 (got ${chunked})`);

        // M-4: a verified key that is no member here is charged to the address, as if it had not signed.
        resetGatewayRateLimit();
        const rotating: number[] = [];
        for (let i = 0; i <= LIMIT; i++) rotating.push((await call('GET', '/api/version', '198.51.100.61', signedHeaders(keypair(), 'GET', '/api/version'))).status);
        assert(rotating.slice(0, LIMIT).every(s => s === 200) && rotating[LIMIT] === 429,
            `a fresh keypair for each public read gets the unsigned rate: 429 on the ${LIMIT + 1}th (${rotating.join(',')})`);
        resetGatewayRateLimit();
        const crowd = [ada, bea, cy, member('DosDee'), member('DosEd'), member('DosFi'), member('DosGus')];
        const members = [];
        for (const m of crowd) members.push((await call('GET', '/api/version', '198.51.100.62', signedHeaders(m, 'GET', '/api/version'))).status);
        assert(members.every(s => s === 200), `${crowd.length} members behind one address each keep their own bucket (${members.join(',')})`);

        // Claims the body parser never reads past 16 KiB don't spend the address's allowance for large ones (review
        // 4150386879): a community event behind one NAT address, where one phone (or someone) sends junk signatures.
        resetGatewayRateLimit();
        const HALL = '198.51.100.63';
        const junk: string[] = [];
        for (let i = 0; i < LIMIT * 2; i++) {
            junk.push(String((await call('GET', '/api/version', HALL, signedHeaders(ada, 'GET', '/api/version', '', keypair().privateKey))).status));
        }
        const tiny = JSON.stringify({ conversationId: 'none' });
        for (let i = 0; i < LIMIT * 2; i++) {
            junk.push(String((await call('POST', '/api/messages/mark-read', HALL, signedHeaders(ada, 'POST', '/api/messages/mark-read', tiny, keypair().privateKey), tiny)).status));
        }
        for (let i = 0; i < LIMIT * 2; i++) {
            const k = keypair();
            const o = await upgrade(`${WS}?pubkey=${k.pubKeyHex}&ts=${Date.now()}&nonce=${crypto.randomBytes(16).toString('hex')}&sig=bm90LWEtc2ln`, HALL);
            junk.push(show(o));
            await closeAll([o]);
        }
        assert(junk.every(s => s !== '429'), `${LIMIT * 2} bodiless forged reads, ${LIMIT * 2} small forged writes and ${LIMIT * 2} made-up /ws tokens from one address pass the gateway (${[...new Set(junk)].join(',')})`);
        const conv = se.createConversation('dm', [ada.pubKeyHex, bea.pubKeyHex], ada.pubKeyHex);
        const line = JSON.stringify({ conversationId: conv?.id, authorPubkey: ada.pubKeyHex, ...lockedDm(15_000) });
        const adaLine = await call('POST', '/api/messages/send', HALL, signedHeaders(ada, 'POST', '/api/messages/send', line), line);
        assert(line.length > 20_000 && adaLine.status === 200,
            `then a member's ${Math.round(line.length / 1000)} KB chat line from that address is answered 200 (got ${adaLine.status} ${adaLine.text.slice(0, 80)})`);
        const huge = JSON.stringify({ type: 'offer', title: 'Forged', authorPublicKey: ada.pubKeyHex, pad: 'x'.repeat(1024 * 1024) });
        const bigForged: number[] = [];
        for (let i = 0; i <= LIMIT; i++) bigForged.push((await call('POST', PATH, HALL, signedHeaders(ada, 'POST', PATH, huge, keypair().privateKey), huge)).status);
        assert(bigForged.slice(0, LIMIT).every(s => s === 401 || s === 403) && bigForged[LIMIT] === 429,
            `forged claims with 1 MB bodies from it still get the unsigned rate: 429 on the ${LIMIT + 1}th (${bigForged.join(',')})`);

        // Only what the body parser actually reads past 16 KiB is charged (the confirm review of #1384, finding 2): at 2
        // requests a second, chunked junk claims of a few bytes, or lengths declared and dropped, shut off every member's
        // writes over 16 KiB from that address (photos in a listing) for a minute.
        const NAT = '198.51.100.64';
        const forgedBy = (ip: string, body: string, framing: string, id: Id = ada, signer: crypto.KeyObject | undefined = keypair().privateKey) =>
            `POST ${PATH} HTTP/1.1\r\nHost: x\r\nCF-Connecting-IP: ${ip}\r\nContent-Type: application/json\r\n${framing}\r\n`
            + Object.entries(signedHeaders(id, 'POST', PATH, body, signer)).map(([k, v]) => `${k}: ${v}\r\n`).join('') + 'Connection: close\r\n\r\n';
        const chunk = (s: string) => `${Buffer.byteLength(s).toString(16)}\r\n${s}\r\n`;
        const freshLine = () => JSON.stringify({ conversationId: conv?.id, authorPubkey: ada.pubKeyHex, ...lockedDm(15_000) });
        const adaSends = (ip: string) => { const l = freshLine(); return call('POST', '/api/messages/send', ip, signedHeaders(ada, 'POST', '/api/messages/send', l), l); };

        resetGatewayRateLimit();
        const tinyChunked: number[] = [];
        for (let i = 0; i < LIMIT * 2; i++) tinyChunked.push(await rawRequest(httpPort, forgedBy(NAT, '{}', 'Transfer-Encoding: chunked') + chunk('{}') + '0\r\n\r\n'));
        const afterTiny = await adaSends(NAT);
        assert(tinyChunked.every(s => s === 401 || s === 403) && afterTiny.status === 200,
            `${LIMIT * 2} forged chunked claims carrying {} from one address reach the signature check (${[...new Set(tinyChunked)].join(',')}), and then a member's 20 KB chat line from it is answered 200 (got ${afterTiny.status} ${afterTiny.text.slice(0, 80)})`);

        resetGatewayRateLimit();
        const dropped: number[] = [];
        for (let i = 0; i < LIMIT * 2; i++) dropped.push(await rawRequest(httpPort, forgedBy(NAT, '{}', 'Content-Length: 1000000') + '{"a":', true));
        await sleep(200);
        const afterDropped = await adaSends(NAT);
        assert(afterDropped.status === 200,
            `${LIMIT * 2} forged claims declaring 1 MB that send 5 bytes and drop the connection spend nothing: a member's 20 KB chat line from that address is then answered 200 (got ${afterDropped.status} ${afterDropped.text.slice(0, 80)}; the dropped ones saw ${[...new Set(dropped)].join(',')})`);

        resetGatewayRateLimit();
        const pad = JSON.stringify({ type: 'offer', title: 'Forged', authorPublicKey: ada.pubKeyHex, pad: 'z'.repeat(20 * 1024) });
        const bigChunked: number[] = [];
        for (let i = 0; i <= LIMIT; i++) {
            bigChunked.push(await rawRequest(httpPort, forgedBy(NAT, pad, 'Transfer-Encoding: chunked') + chunk(pad.slice(0, 10_000)) + chunk(pad.slice(10_000)) + '0\r\n\r\n'));
        }
        assert(bigChunked.slice(0, LIMIT).every(s => s === 401 || s === 403) && bigChunked[LIMIT] === 429,
            `forged chunked claims carrying 20 KB are charged once the parser reads past 16 KiB: 429 on the ${LIMIT + 1}th (${bigChunked.join(',')})`);

        // A member's chunked large write is charged the same way and given back when it verifies: with one place left,
        // it is answered 200 and the place is still there for the next forged claim, which then fills it.
        resetGatewayRateLimit();
        const statusesBefore: number[] = [];
        for (let i = 0; i < LIMIT - 1; i++) statusesBefore.push(await rawRequest(httpPort, forgedBy(NAT, pad, 'Transfer-Encoding: chunked') + chunk(pad) + '0\r\n\r\n'));
        const own = freshLine();
        const adaChunked = await rawRequest(httpPort,
            `POST /api/messages/send HTTP/1.1\r\nHost: x\r\nCF-Connecting-IP: ${NAT}\r\nContent-Type: application/json\r\nTransfer-Encoding: chunked\r\n`
            + Object.entries(signedHeaders(ada, 'POST', '/api/messages/send', own)).map(([k, v]) => `${k}: ${v}\r\n`).join('')
            + 'Connection: close\r\n\r\n' + chunk(own.slice(0, 9_000)) + chunk(own.slice(9_000)) + '0\r\n\r\n');
        const lastPlace = await rawRequest(httpPort, forgedBy(NAT, pad, 'Transfer-Encoding: chunked') + chunk(pad) + '0\r\n\r\n');
        const full = await rawRequest(httpPort, forgedBy(NAT, pad, 'Transfer-Encoding: chunked') + chunk(pad) + '0\r\n\r\n');
        assert(statusesBefore.every(s => s === 401 || s === 403) && adaChunked === 200 && (lastPlace === 401 || lastPlace === 403) && full === 429,
            `with one place left, a member's chunked 20 KB chat line is answered 200 and gives its place back: the next forged claim takes it, the one after is 429 (${statusesBefore.join(',')}, member ${adaChunked}, ${lastPlace}, ${full})`);

        // Two large claims let in together with one place left: the one whose body passes 16 KiB second is refused then,
        // through the gateway's own admit and charge, as https-server.ts calls them.
        const gw: any = await import('./gateway-rate-limit.js');
        resetGatewayRateLimit();
        const T = Date.now();
        const largeClaim = () => ({
            method: 'POST', path: PATH, ip: '198.51.100.65', state: {} as Record<string, unknown>, status: 404, body: undefined as unknown,
            get: (h: string) => h.toLowerCase() === 'content-length' ? String(1024 * 1024) : '', set: () => { /* headers */ },
        }) as any;
        const charge: ((ctx: unknown, now: number) => boolean) | null = typeof gw.gatewayChargeLargeClaim === 'function' ? gw.gatewayChargeLargeClaim : null;
        for (let i = 0; i < LIMIT - 1; i++) { const c = largeClaim(); gw.gatewayAdmit(c, LIMIT, true, T); charge?.(c, T); }
        const first = largeClaim(), second = largeClaim();
        const admittedBoth = [gw.gatewayAdmit(first, LIMIT, true, T), gw.gatewayAdmit(second, LIMIT, true, T)];
        const readPast = charge ? [charge(first, T), charge(second, T)] : [];
        assert(admittedBoth.every(Boolean) && readPast[0] === true && readPast[1] === false && second.status === 429,
            `two large claims let in together with one place left: both are admitted (${admittedBoth.join(',')}), the first is charged as its body passes 16 KiB and the second is refused 429 then (${charge ? `${readPast.join(',')}, ${second.status}` : 'no charge at the read'})`);
        resetGatewayRateLimit();
        updateGatewayConfig(unlimited);
    }

    // ── 5/6. The peer protocol's reads ───────────────────────────────────────────────────────────────────
    console.log('\n— 6. /api/community/info and /health —');
    {
        updateGatewayConfig(limited);
        resetGatewayRateLimit();
        const statuses: number[] = [];
        for (let i = 0; i < LIMIT * 5; i++) statuses.push((await call('GET', i % 2 ? '/api/community/health' : '/api/community/info', '198.51.100.70')).status);
        const over = await call('GET', '/api/community/info', '198.51.100.70');
        assert(statuses.every(s => s === 200) && over.status === 429,
            `the peer reads have a bucket of their own: ${LIMIT * 5} from one address, then 429 (${[...new Set(statuses)].join(',')} then ${over.status})`);
        const elsewhere = await call('GET', '/api/community/info', '198.51.100.71');
        assert(elsewhere.status === 200, `another address still reads (${elsewhere.status})`);
        updateGatewayConfig(unlimited);

        se.resetCommunityReadCaches?.();
        const prepared: string[] = [];
        const realPrepare = db.prepare.bind(db);
        (db as any).prepare = (sql: string) => { prepared.push(sql); return realPrepare(sql); };
        const memberCounts = () => prepared.filter(s => /COUNT\(\*\) as c FROM members WHERE status != 'pruned'/.test(s)).length;
        const txCounts = () => prepared.filter(s => /^\s*SELECT COUNT\(\*\) as c FROM transactions\s*$/.test(s)).length;
        try {
            const bodies: any[] = [];
            for (let i = 0; i < 50; i++) bodies.push((await call('GET', '/api/community/info', `198.51.101.${i}`)).json);
            assert(memberCounts() <= 1 && txCounts() <= 1,
                `50 reads of /api/community/info count the members and transactions once (members ${memberCounts()}, transactions ${txCounts()})`);
            assert(bodies.every(b => typeof b?.memberCount === 'number' && b.memberCount === bodies[0].memberCount && typeof b?.features === 'object'),
                'each answers the counts and the features');
            const before = bodies[0].memberCount;
            member('DosNew');
            se.bumpMembersVersion();
            const after = (await call('GET', '/api/community/info', '198.51.101.200')).json;
            assert(after?.memberCount === before + 1, `a new member is counted at once, not after the cache runs out (${before} → ${after?.memberCount})`);
            const own = (await call('GET', '/api/community/info', '198.51.101.201', signedHeaders(ada, 'GET', '/api/community/info'))).json;
            assert(own?.transactionCount === 0 && after?.transactionCount >= 0, `a signed read still gets the signer's own transaction count (${own?.transactionCount})`);

            prepared.length = 0;
            se.resetCommunityReadCaches?.();
            const sockets: Outcome[] = [];
            for (let i = 0; i < 10; i++) sockets.push(await upgrade(WS, `198.51.102.${i}`));
            await sleep(200);
            assert(sockets.every(o => o.kind === 'open' && o.frames.some(f => f.includes('state_snapshot'))) && memberCounts() <= 1,
                `10 sockets each get their greeting, from one count (members counted ${memberCounts()} time(s))`);
            await closeAll(sockets);

            prepared.length = 0;
            const healths: any[] = [];
            for (let i = 0; i < 50; i++) healths.push((await call('GET', '/api/community/health', `198.51.103.${i}`)).json);
            const activity = prepared.filter(s => s.includes('COUNT(DISTINCT m.public_key)')).length;
            const fraud = prepared.filter(s => s.includes('puppet_count')).length;
            assert(activity <= 2 && fraud === 0,
                `50 reads of /api/community/health count the active members once and never run the fraud analysis (activity ${activity}, funnel queries ${fraud})`);
            assert(healths.every(h => h && h.flags === undefined && typeof h.minAppVersion === 'string' && typeof h.activity?.totalTransactions === 'number' && h.tree?.totalMembers >= 1),
                'each answers the fields the apps read, and no flags');
        } finally {
            delete (db as any).prepare;
        }
    }

    // ── 7. The nearest-first pass is bounded ─────────────────────────────────────────────────────────────
    console.log('\n— 7. nearest first —');
    {
        const BOUND: number = engine.ONE_PASS_MAX_MEASURED ?? 10_000;
        const N = BOUND + 2_000;
        const author = member('DosSeller');
        const ins = db.prepare(`INSERT INTO posts (id, type, category, title, description, credits, author_pubkey, created_at, updated_at, lat, lng, audience_scope)
                                VALUES (?, 'offer', ?, ?, '', 0, ?, ?, ?, ?, ?, 'public')`);
        let seed = 7;
        const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
        const rare: Array<{ id: string; lat: number; lng: number; at: string }> = [];
        db.transaction(() => {
            for (let i = 0; i < N; i++) {
                const at = new Date(Date.UTC(2026, 0, 1) + i * 60_000).toISOString();
                const lat = -28.55 + (rnd() - 0.5) * 0.4, lng = 153.5 + (rnd() - 0.5) * 0.4;
                const category = i % 400 === 0 ? 'dosrare' : 'other';
                if (category === 'dosrare') rare.push({ id: `dos-${i}`, lat, lng, at });
                ins.run(`dos-${i}`, category, `Dos ${i}`, author.pubKeyHex, at, at, lat, lng);
            }
        })();
        se.bumpPostsVersion();

        let calls = 0;
        const count = (f: (a: number, b: number, c: number, d: number) => number) => (a: unknown, b: unknown, c: unknown, d: unknown) => {
            calls++;
            if (typeof a !== 'number' || typeof b !== 'number' || typeof c !== 'number' || typeof d !== 'number') return null;
            const km = f(a, b, c, d);
            return Number.isFinite(km) ? km : null;
        };
        db.function('haversine_km', { deterministic: true }, count(engine.haversineKm));
        db.function('area_km', { deterministic: true }, count((a, b, c, d) => engine.haversineKm(a, b, engine.roundToArea(c), engine.roundToArea(d))));
        const read = async (query: string) => {
            calls = 0;
            const path = '/api/marketplace/posts';
            const r = await call('GET', `${path}?${query}`, '198.51.104.1', signedHeaders(ada, 'GET', path));
            return { status: r.status, ids: Array.isArray(r.json) ? r.json.map((p: any) => p.id) as string[] : null, calls };
        };
        try {
            const far = await read('lat=-80&lng=0&sort=distance&limit=50');
            assert(far.status === 200 && far.ids?.length === 50 && far.calls <= BOUND + 100,
                `from a point far from all ${N} posts, a nearest-first page measures at most ${BOUND} (${far.calls} measured, ${far.ids?.length} rows)`);
            // With a radius or a filter the planner sorts every matching post before the bound applies (review
            // 4150386976): these two check only that the distance is worked out for at most BOUND of them, not that
            // the read's cost is bounded. F5 is still open for them.
            const earth = await read('lat=-28.55&lng=153.5&radiusKm=20000&sort=distance&limit=50&category=other');
            assert(earth.status === 200 && earth.ids?.length === 50 && earth.calls <= BOUND + 100,
                `with a radius of the whole Earth and a filter, distance calls stay at ${BOUND} or fewer (${earth.calls}; the scan and sort are NOT bounded)`);
            const recent = await read('lat=-28.55&lng=153.5&radiusKm=20000&sort=recent&limit=50');
            assert(recent.status === 200 && recent.ids?.length === 50 && recent.calls <= BOUND + 100,
                `and in today's order with that radius, distance calls stay at ${BOUND} or fewer (${recent.calls}; the scan and sort are NOT bounded)`);
            const deep = await read(`lat=-80&lng=0&sort=distance&limit=50&offset=${BOUND}`);
            assert(deep.status === 200 && deep.ids?.length === 0 && deep.calls <= BOUND + 100,
                `a page past the bound is empty, and costs no more (${deep.ids?.length} rows, ${deep.calls} measured)`);

            const at = { lat: -28.6, lng: 153.4 };
            const expected = rare.map(p => ({ ...p, d: engine.haversineKm(at.lat, at.lng, p.lat, p.lng) }))
                .sort((a, b) => a.d - b.d || (a.at < b.at ? 1 : a.at > b.at ? -1 : 0)).slice(0, 20).map(p => p.id);
            const page = await read(`lat=${at.lat}&lng=${at.lng}&sort=distance&limit=20&category=dosrare`);
            assert(JSON.stringify(page.ids) === JSON.stringify(expected),
                `a filter ${rare.length} posts match still gets the brute-force nearest page (${page.ids?.slice(0, 3).join(',')}…)`);
        } finally {
            engine.registerGeoFunctions(db);
        }
    }

    // ── 8. Server timeouts and the connection cap ────────────────────────────────────────────────────────
    console.log('\n— 8. timeouts —');
    {
        const slowHeaders = await new Promise<string>((resolve) => {
            const sock = net.connect(httpPort, '127.0.0.1', () => sock.write('GET /api/version HTTP/1.1\r\nHost: x\r\n'));
            let buf = '';
            sock.on('data', d => { buf += d.toString(); });
            sock.on('close', () => resolve(`closed ${buf.slice(0, 12)}`.trim()));
            setTimeout(() => { resolve('still open after 4 s'); sock.destroy(); }, 4000);
        });
        assert(/^closed/.test(slowHeaders), `a client that never finishes its headers is dropped at the header timeout (${slowHeaders})`);

        const slowBody = await new Promise<number>((resolve) => {
            const body = JSON.stringify({ type: 'offer', title: 'Slow', pad: 'y'.repeat(600) });
            const sock = net.connect(httpPort, '127.0.0.1', async () => {
                sock.write(`POST /api/marketplace/posts HTTP/1.1\r\nHost: x\r\nContent-Type: application/json\r\nContent-Length: ${body.length}\r\nConnection: close\r\n\r\n`);
                // The body over 2.5 s, longer than the 1 s header timeout, as a big restore's is over minutes.
                for (let i = 0; i < 10; i++) { sock.write(body.slice(i * body.length / 10, (i + 1) * body.length / 10)); await sleep(250); }
            });
            let buf = '';
            sock.on('data', d => { buf += d.toString(); });
            sock.on('close', () => resolve(Number(/^HTTP\/1\.1 (\d{3})/.exec(buf)?.[1] ?? 0)));
            setTimeout(() => sock.destroy(), 8000);
        });
        assert(slowBody !== 0 && slowBody !== 408, `a body sent over longer than the header timeout is read and answered (${slowBody}, the signature check's refusal)`);
        const defaults = svl?.DEFAULT_SERVER_LIMITS;
        assert(!!defaults && defaults.requestTimeoutMs >= 300_000 && defaults.headersTimeoutMs <= 30_000 && defaults.maxConnections > 2016,
            `the defaults: 300 s for a whole request (the 500 MB restore keeps its time), a short header timeout, and room for every live socket (${JSON.stringify(defaults)})`);

        const sockets: net.Socket[] = [];
        let refused = 0;
        await Promise.all(Array.from({ length: 320 }, () => new Promise<void>((resolve) => {
            const sock = net.connect(httpPort, '127.0.0.1');
            sockets.push(sock);
            const t = setTimeout(resolve, 600);
            sock.on('close', () => { refused++; clearTimeout(t); resolve(); });
            sock.on('error', () => { /* counted on close */ });
        })));
        assert(refused >= 15, `past the connection cap (300 in this suite) a new connection is closed at once (${refused} of 320 closed within 0.6 s)`);
        for (const s of sockets) s.destroy();
    }

    // ── 9. The limiter's upkeep under a flood ───────────────────────────────────────────────────────────
    console.log('\n— 9. the limiter under a flood from rotating addresses —');
    {
        const gw: any = await import('./gateway-rate-limit.js');
        const counted = typeof gw.gatewayPruneRuns === 'function' && typeof gw.gatewayBucketCount === 'function';
        resetGatewayRateLimit();
        // A forged claim with a 1 MB body from its own IPv6 /64, as the review's flood (each charges sig:, claim: and
        // ip:), through the gateway's own admit, charge (the body parser's, as the body passes 16 KiB) and settle, as
        // https-server.ts calls them. The clock is the one passed in.
        const chargeRead = (ctx: unknown, now: number) => { if (typeof gw.gatewayChargeLargeClaim === 'function') gw.gatewayChargeLargeClaim(ctx, now); };
        const forged = (i: number) => ({
            method: 'POST', path: '/api/marketplace/posts', ip: `2001:db8:${(i >>> 16) & 0xffff}:${i & 0xffff}::1`,
            state: {} as Record<string, unknown>, status: 404, body: undefined as unknown,
            get: (h: string) => h.toLowerCase() === 'content-length' ? String(1024 * 1024) : '', set: () => { /* headers */ },
        });
        const T0 = Date.now();
        const N = 20_000;
        let maxPerRequest = 0;
        const cpu0 = process.cpuUsage();
        for (let i = 0; i < N; i++) {
            const now = T0 + i; // 1 ms apart: the flood spans 20 s of the limiter's clock
            const before = counted ? gw.gatewayPruneRuns() : 0;
            const ctx = forged(i) as any;
            if (gw.gatewayAdmit(ctx, 120, true, now)) { chargeRead(ctx, now); gw.gatewaySettle(ctx, now); }
            if (counted) maxPerRequest = Math.max(maxPerRequest, gw.gatewayPruneRuns() - before);
        }
        const cpu = process.cpuUsage(cpu0);
        const cpuMs = (cpu.user + cpu.system) / 1000;
        const runs = counted ? gw.gatewayPruneRuns() : NaN;
        assert(counted && maxPerRequest <= 1, `no request of a ${N}-claim flood from rotating /64s prunes more than once (most in one request: ${counted ? maxPerRequest : 'not counted'})`);
        // At 06491de5 each request past 20,000 live buckets pruned three times; on main once. Once a second is far below both.
        assert(counted && runs <= Math.ceil(N / 1000) + 2, `the flood prunes at most once a second of its ${N / 1000} s (${runs} prunes)`);
        assert(cpuMs < 1000, `and costs ${Math.round(cpuMs)} ms of CPU for ${N} claims (06491de5: about 5 s, three full prunes a request; main about 1 s, one)`);

        // Flooding on inside one minute: every bucket is live, so a prune frees nothing. The buckets must still stop at
        // GATEWAY_MAX_BUCKETS, not grow with the flood.
        const cap: number = gw.GATEWAY_MAX_BUCKETS ?? 0;
        if (counted && cap > 0) {
            const more = Math.ceil(cap / 3) + 5_000;
            let peak = 0;
            for (let i = N; i < N + more; i++) {
                const now = T0 + N + Math.floor((i - N) / 10); // about 4 s more: all within the first bucket's minute
                const ctx = forged(i) as any;
                if (gw.gatewayAdmit(ctx, 120, true, now)) { chargeRead(ctx, now); gw.gatewaySettle(ctx, now); }
                peak =Math.max(peak, gw.gatewayBucketCount());
            }
            assert(peak <= cap, `${more} more claims inside the minute (${(N + more) * 3} buckets asked for, all live) hold the buckets at ${cap} or fewer (peak ${peak})`);
        } else assert(false, `the limiter has a hard cap on its buckets (GATEWAY_MAX_BUCKETS: ${cap || 'none'})`);

        // The limiter still limits after the flood: a fresh address's unsigned requests, at a limit of 5.
        const later = T0 + 30_000;
        const plain = { method: 'GET', path: '/api/version', ip: '198.51.100.99', state: {}, status: 404, body: undefined as unknown, get: () => '', set: () => { /* headers */ } };
        const admitted: boolean[] = [];
        for (let i = 0; i <= LIMIT; i++) admitted.push(gw.gatewayAdmit({ ...plain, state: {} } as any, LIMIT, false, later + i));
        assert(admitted.slice(0, LIMIT).every(Boolean) && admitted[LIMIT] === false, `the limiter still limits afterwards: 429 on the ${LIMIT + 1}th (${admitted.join(',')})`);
        resetGatewayRateLimit();
    }

    // ── 10. The cap keeps the buckets that limit someone ────────────────────────────────────────────────
    console.log('\n— 10. the cap forgets the least counted first —');
    {
        const gw: any = await import('./gateway-rate-limit.js');
        resetGatewayRateLimit();
        const MAX = 120; // the default
        const cap: number = gw.GATEWAY_MAX_BUCKETS ?? 100_000;
        const T = Date.now() + 10 * 60_000; // a minute of its own on the limiter's clock
        const fake = (ip: string, method = 'GET', length = '') => ({
            method, path: method === 'GET' ? '/api/version' : '/api/marketplace/posts', ip, state: {} as Record<string, unknown>,
            status: 404, body: undefined as unknown, get: (h: string) => h.toLowerCase() === 'content-length' ? length : '', set: () => { /* headers */ },
        }) as any;
        const charge = (ctx: unknown, now: number): boolean => typeof gw.gatewayChargeLargeClaim === 'function' ? gw.gatewayChargeLargeClaim(ctx, now) : true;
        // Each victim, one request at a time, true when admitted. The member's requests come from addresses of their own.
        let memberHop = 0;
        const victims: Array<{ name: string; limit: number; once: (now: number) => boolean }> = [
            { name: 'an address at its unsigned limit (ip:)', limit: MAX, once: (now) => gw.gatewayAdmit(fake('198.51.105.1'), MAX, false, now) },
            {
                name: 'a member at theirs (m:)', limit: MAX, once: (now) => {
                    const c = fake(`198.51.106.${memberHop++ % 250}`);
                    c.state.gatewaySignedClaim = true;
                    c.state.actor = ada.pubKeyHex;
                    return gw.gatewayAdmitMember(c, MAX, true, now);
                },
            },
            { name: 'an address at its signed ceiling (sig:)', limit: MAX * 10, once: (now) => gw.gatewayAdmit(fake('198.51.105.3'), MAX, true, now) },
            {
                name: 'an address that spent its large claims (claim:)', limit: MAX, once: (now) => {
                    const c = fake('198.51.105.4', 'POST', String(1024 * 1024));
                    return gw.gatewayAdmit(c, MAX, true, now) && charge(c, now);
                },
            },
            { name: 'an address at its peer reads (peer:)', limit: MAX * 5, once: (now) => gw.gatewayAdmitPeerRead(fake('198.51.105.5'), MAX, now) },
        ];
        const filled = victims.map(v => { let n = 0; while (n <= v.limit && v.once(T)) n++; return n; });
        assert(victims.every((v, i) => filled[i] === v.limit),
            `each victim is let in to its limit and refused after it (${victims.map((v, i) => `${filled[i]}/${v.limit}`).join(', ')})`);

        // The flood: a fresh IPv6 /64 for each request, within the same minute.
        const FLOOD = Math.ceil(cap * 2.5);
        let peak = 0;
        const cpu0 = process.cpuUsage();
        for (let i = 0; i < FLOOD; i++) {
            const now = T + 1 + Math.floor(i * 40_000 / FLOOD); // over 40 s: every bucket stays live
            gw.gatewayAdmit(fake(`2001:db8:${(i >>> 16) & 0xffff}:${i & 0xffff}::1`), MAX, false, now);
            if (i % 1000 === 0) peak = Math.max(peak, gw.gatewayBucketCount());
        }
        const cpu = process.cpuUsage(cpu0);
        const cpuMs = Math.round((cpu.user + cpu.system) / 1000);
        assert(peak <= cap, `a flood of ${FLOOD} requests from as many /64s in one minute keeps the buckets at ${cap} or fewer (peak ${peak}, ${cpuMs} ms of CPU)`);
        const later = T + 45_000;
        const after = victims.map(v => v.once(later));
        for (const [i, v] of victims.entries()) {
            assert(!after[i], `after the flood, ${v.name} is still refused inside its minute (${after[i] ? 'let in again: its bucket was forgotten' : 'refused'})`);
        }
        resetGatewayRateLimit();
    }

    console.log(`\n${passed}/${run} checks passed.`);
    if (passed !== run) throw new Error(`${run - passed} check(s) failed`);
    console.log('⭐️ The WebSocket caps, the claim bucket, the cached peer reads, the bounded nearest-first pass and the server timeouts hold.');
}

main().then(() => process.exit(0)).catch(e => { console.error('❌ Test failed:', e); process.exit(1); });
