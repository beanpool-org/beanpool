/**
 * A community adds a new main name and its old name keeps working (rename slice S1, design
 * scratch/fable-design/DESIGN-rename-primary-name-fable.md §2, §4, §6), over the real HTTPS server through every
 * middleware a node runs, with the address service a loopback stub and Expo's push door answered here: nothing leaves
 * this machine, and no node is contacted.
 *
 *  1. A name the node published is never un-published by a claim. On a fleet node (CF_RECORD_NAME, like Mullumbimby) a
 *     member's signature for the old name passes before and after a new name goes live, by real signed requests; the
 *     new name is primary, both are listed; another community's host is still 421. The old name is copied to the
 *     owner-confirmed list, so a promoted standby, which has no CF_RECORD_NAME of the old name, keeps accepting it.
 *  2. A gated claim: from the claim on, while the new name waits for approval, the old name is accepted and primary.
 *     Once approved, the new name is primary and the old name still passes.
 *  3. What a claim copies: a live registrar name stays published; a name that was only pending or paused does not
 *     become one. A name the community then lets go (Release, Take offline) is no longer published, and is accepted
 *     through its hold as a former name is.
 *  4. Fresh proof for a claim whenever the node already publishes an address (design §6): refused with nothing asked of
 *     the address service, on each way a node publishes one; a computer's session is sent to the phone, and the password
 *     is asked for a current code. A first claim on a node with no address, or the same name again, stays plain, and a
 *     name that is no address label is refused before any proof is spent.
 *  5. The members' notice: the soft words once, when the new name is live and the old one really keeps working; never
 *     while it waits, and never twice; no address in what is pushed. A live tunnel name with no token saved has no tunnel to
 *     keep, so it keeps the critical words.
 *  6. The public-address agent's own claim copies and tells as Settings' does.
 *  7. A name on this server's tunnel has no route until that tunnel connects, whatever the registrar says: nobody is told
 *     before it does, on any of the ways a notice goes out, and a tunnel that cannot start tells nobody and loses nothing
 *     (the fake cloudflared, /ready as each case needs). The agent's claim over a live tunnel name keeps that name's child
 *     beside the new one (rename S2), so the soft words are true.
 *  8. The three ways a community moves, end to end (rename S2): (a) its own domain, then a beanpool.org name; (b) its own
 *     name, a gated name pending, then approved: nothing moves until it is, on any surface, and the old name keeps its
 *     tunnel; (c) a registrar name to a registrar name, both answering.
 *
 * Run: SERVER_SUITES_ONLY=test-rename-main-name TEST_ALL_JOBS=2 node scripts/run-server-suites.mjs
 */

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
delete process.env.CF_RECORD_NAME;
delete process.env.BEANPOOL_ADDRESSES;
delete process.env.PUBLIC_ADDRESS_NAME;
delete process.env.PUBLIC_ADDRESS_AUTO;
delete process.env.PUBLIC_IP;

import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { localFetch } from './keepalive-test-fetch.js';

let testsRun = 0;
let testsPassed = 0;
function assert(cond: unknown, msg: string): void {
    testsRun++;
    if (cond) {
        testsPassed++;
        console.log(`✓ ${msg}`);
    } else {
        // Counted, and the run goes on, so a run on main reports every one missing.
        console.error(`✗ ${msg}`);
    }
}
const show = (v: unknown) => JSON.stringify(v);

/** Settings' probe of Cloudflare's edge, refused at once: nothing leaves. */
const CF_EDGE_IP = '104.21.93.179';
function refuseEdge(): void {
    const real = http.request;
    (http as any).request = function (this: unknown, ...args: any[]) {
        const o = args[0];
        const opts = o && typeof o === 'object' && !(o instanceof URL) ? o : null;
        if (opts && (opts.hostname === CF_EDGE_IP || opts.host === CF_EDGE_IP)) {
            const req: any = new EventEmitter();
            req.setTimeout = () => req;
            req.destroy = () => req;
            req.write = () => true;
            req.end = () => { setImmediate(() => req.emit('error', new Error('refused in tests'))); return req; };
            return req;
        }
        return (real as any).apply(this, args);
    };
}

const MULLUM = 'mullum.beanpool.org';
const BYRON = 'byron.beanpool.org';
const IP = '203.0.113.5';
const DOMAIN = 'beans.example.org';
const SOFT_TITLE = 'This community has a new address';
const SOFT_BODY = 'This community is also at byron.beanpool.org. The old address keeps working.';
const CRITICAL_BODY = "This community's address changed. Open the app to follow it.";

async function main(): Promise<void> {
    const dataDir = process.env.BEANPOOL_DATA_DIR;
    if (!dataDir) throw new Error('Set BEANPOOL_DATA_DIR to a throwaway directory');
    refuseEdge();

    // Expo's push door answered here: every message is kept as it would have left.
    const pushed: any[] = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (input: any, init?: any) => {
        const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
        if (url.hostname === '127.0.0.1' || url.hostname === 'localhost') return realFetch(input, init);
        if (url.hostname === 'exp.host') {
            const batch = JSON.parse(String(init?.body ?? '[]')) as any[];
            pushed.push(...batch);
            return new Response(JSON.stringify({ data: batch.map(() => ({ status: 'ok', id: crypto.randomUUID() })) }), { status: 200 });
        }
        throw new Error(`nothing leaves this machine (${url.hostname})`);
    }) as typeof fetch;

    // The address service: names by key, as it holds them. `gated` names wait for approval; approve() makes one live.
    const held = new Map<string, any>();
    const gated = new Set<string>();
    let claimsAsked = 0;
    /** Set: what /status answers whatever it is asked, as a registrar older than the one that reads `name` (the key's first name). */
    let statusAnswer: any = null;
    /** Set: the mode the service answers whatever is asked. A direct name is reachable once live, so its notice goes at once. */
    let answerMode: string | null = null;
    const liveAnswer =(name: string, mode = 'tunnel') => ({ status: 'live', name, hostname: `${name}.beanpool.org`, mode });
    const approve = (name: string) => held.set(name, liveAnswer(name, held.get(name)?.mode));
    const registrar = http.createServer((req, res) => {
        let raw = '';
        req.on('data', (c) => { raw += c; });
        req.on('end', () => {
            let body: any = {};
            try { body = JSON.parse(raw); } catch { /* none */ }
            const url = new URL(req.url ?? '/', 'http://registrar.test');
            res.setHeader('Content-Type', 'application/json');
            if (url.pathname === '/api/registrar/claim') {
                claimsAsked++;
                const mode = answerMode ?? body.mode;
                const answer = gated.has(body.name) && !held.has(body.name)
                    ? { status: 'pending', name: body.name, mode, reason: 'awaiting-approval' }
                    : (held.get(body.name) ?? liveAnswer(body.name, mode));
                held.set(body.name, answer);
                return res.end(JSON.stringify(answer));
            }
            if (url.pathname === '/api/registrar/status') {
                const name = url.searchParams.get('name') ?? '';
                return res.end(JSON.stringify(statusAnswer ?? held.get(name) ?? { status: 'none' }));
            }
            if (url.pathname === '/api/registrar/holder') {
                const row = held.get(body.name);
                return res.end(JSON.stringify(row ? { name: body.name, held: 'you', state: row.status } : { name: body.name, held: 'nobody' }));
            }
            if (url.pathname === '/api/registrar/offline') {
                held.delete(body.name);
                return res.end(JSON.stringify({ status: 'released', name: body.name ?? null, held_until: Math.floor(Date.now() / 1000) + 30 * 86_400 }));
            }
            res.statusCode = 404;
            res.end('{"error":"not found"}');
        });
    });
    await new Promise<void>((r) => registrar.listen(0, '127.0.0.1', () => r()));
    process.env.REGISTRAR_URL = `http://127.0.0.1:${(registrar.address() as any).port}`;

    const core = await import('@beanpool/core');
    const { ed25519 } = await import('@noble/curves/ed25519.js');
    const { initStateEngine, seedGenesisMember, grantNodeRole, getNodeConfig, updateNodeConfig } = await import('./state-engine.js');
    const { db } = await import('./db/db.js');
    const { ensureGenesis } = await import('./genesis.js');
    const { generateKeyPair, privateKeyToProtobuf } = await import('@libp2p/crypto/keys');
    const { getLocalConfig, hashPassword, updateLocalConfig } = await import('./config/local-config.js');
    const { resetAdminAuthTarpit } = await import('./admin-auth.js');
    const { mintHandshakeToken, consumeHandshakeToken, PHONE_HANDOFF_IDLE_TTL_MS } = await import('./admin-key-auth.js');
    const { putPushTokenRow } = await import('./services/push-token-seal.js');
    const { turnOn2faForTests } = await import('./admin-auth-test-harness.js');
    const { setSecurityAlertHandler } = await import('./services/security-signal.js');
    const { audienceStanding, forgetOwnAddresses, primaryAddress, publishedAddresses, formerAddresses, ownerConfirmedAddresses } = await import('./engine/own-addresses.js');
    const { reconcile, tick } = await import('./services/public-address-agent.js');
    const { getTunnelStatus, resetTunnelConnectorForTests, setTunnelConnectorForTests, syncTunnel, tunnelConnectorForTests } = await import('./services/tunnel-connector.js');
    const { useFakeCloudflared } = await import('./tunnel-test-fake.js');
    const { initTls } = await import('./services/tls.js');
    const { startP2P } = await import('./p2p.js');
    const https = await import('./https-server.js');
    const { resetGatewayRateLimit } = await import('./gateway-rate-limit.js');

    initStateEngine();
    await ensureGenesis();
    fs.writeFileSync(path.join(dataDir, 'libp2p_key'), privateKeyToProtobuf(await generateKeyPair('Ed25519')));
    const PW = 'Rename-Main-Name-Pw-7741!';
    const { hash, salt } = hashPassword(PW);
    updateLocalConfig({ adminHash: hash, salt, totpEnabled: false, totpSecret: null, communityName: 'Mullumbimby', callsign: 'MULLUM' } as any);

    // The owner: a real key, so a request signed for a host goes through the real signature middleware.
    const seed = new Uint8Array(crypto.randomBytes(32));
    const owner = Buffer.from(ed25519.getPublicKey(seed)).toString('hex');
    const sign = core.ed25519Signer(seed);
    seedGenesisMember(owner, 'Olive');
    grantNodeRole(owner, 'owner', owner);
    const memberKey = crypto.randomBytes(32).toString('hex');
    db.prepare('INSERT INTO members (public_key, callsign, joined_at, invited_by, invite_code) VALUES (?, ?, ?, ?, ?)')
        .run(memberKey, 'Mia', new Date().toISOString(), owner, 'TEST');
    db.prepare('INSERT INTO accounts (public_key, balance, last_demurrage_epoch) VALUES (?, 0, 0)').run(memberKey);
    putPushTokenRow(memberKey, 'ExponentPushToken[rename-main-name]', 'android');

    const session = (phone = false) => {
        const ex = consumeHandshakeToken(mintHandshakeToken(owner, 'owner').handshakeToken, Date.now(), phone ? { idleTtlMs: PHONE_HANDOFF_IDLE_TTL_MS } : {});
        if (!ex.ok || ex.role !== 'owner') throw new Error(`setup: no owner session: ${ex.error}`);
        return { 'x-admin-session': ex.sessionId! };
    };
    /** The owner's phone, Manage pressed just now: the fresh proof. */
    const phone = () => session(true);
    /** The owner's computer ("Sign in with your phone"): signed in, with no unlock of its own. */
    const computer = () => session(false);

    await startP2P(0, 0);
    await initTls();
    const port = await https.startHttpsServer(0);
    const base = `https://localhost:${port}`;
    const post = async (route: string, headers: Record<string, string>, body: unknown = {}) => {
        resetAdminAuthTarpit();
        https.resetAdminRateLimit();
        const res = await localFetch(base + route, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
        let json: any = null;
        try { json = await res.json(); } catch { /* none */ }
        return { status: res.status, json };
    };
    const CLAIM = '/api/local/admin/public-address/claim';
    /** Set: what every claim asks for besides. A direct name is reachable once live, so its notice goes at once. */
    let claimAsks: Record<string, unknown> = {};
    const claim = (name: string, headers: Record<string, string> = phone(), extra: Record<string, unknown> = {}) => post(CLAIM, headers, { name, mode: 'tunnel', ...claimAsks, ...extra });
    const statusRead = async () => {
        https.resetAdminRateLimit();
        const res = await localFetch(`${base}/api/local/admin/public-address/status`, { headers: computer() });
        return { status: res.status, json: await res.json().catch(() => null) as any };
    };
    /** A private read, as a current app makes it: signed for `host`, through the real signature middleware. */
    const signedFor = async (host: string) => {
        resetGatewayRateLimit();
        const url = `https://${host}/api/messages/conversations/${owner}`;
        const headers = await core.buildBoundRequestHeaders({ method: 'GET', url, body: '', publicKeyHex: owner, sign });
        const res = await localFetch(`${base}${core.signedPathOf(url)}`, { headers });
        return { status: res.status, json: await res.json().catch(() => null) as any };
    };
    const info = async () => (await (await localFetch(`${base}/api/community/info`)).json()) as any;

    const notes: any[] = [];
    setSecurityAlertHandler((n) => { notes.push(n); });
    const notices = () => db.prepare("SELECT title, body FROM push_notices WHERE kind = 'community.notice' ORDER BY rowid").all() as Array<{ title: string; body: string }>;
    /** Forget everything of the scene before: a node as `scene` says, with what it holds at the address service. */
    const scene = (s: { cf?: string; env?: string; config?: Record<string, unknown>; names?: string[] } = {}) => {
        delete process.env.CF_RECORD_NAME;
        delete process.env.BEANPOOL_ADDRESSES;
        if (s.cf) process.env.CF_RECORD_NAME = s.cf;
        if (s.env) process.env.BEANPOOL_ADDRESSES = s.env;
        updateNodeConfig({ publicAddress: null, ownerAddresses: [], registrarNames: [], ...s.config } as any);
        updateLocalConfig({ turnedAwayNames: [], addressNoticeDue: null } as any);
        held.clear();
        gated.clear();
        statusAnswer = null;
        for (const n of s.names ?? []) held.set(n, liveAnswer(n));
        forgetOwnAddresses();
        notes.length = 0;
        pushed.length = 0;
    };
    const liveTunnel = (name: string) => ({ name, mode: 'tunnel', hostname: `${name}.beanpool.org`, status: 'live' });
    const liveDirect = (name: string) => ({ name, mode: 'direct', hostname: `${name}.beanpool.org`, status: 'live' });
    const stored = () => (getNodeConfig() as any);

    // ── 1 ──
    console.log('\n— 1. a new name goes live on a fleet node: the old name keeps passing —');
    scene({ cf: MULLUM });
    const before = await signedFor(MULLUM);
    assert(before.status === 200, `before the claim a signature for ${MULLUM} passes (${before.status} ${show(before.json)})`);
    const byron = await claim('byron');
    assert(byron.status === 200 && byron.json?.status === 'live', `the owner claims byron from the phone's Manage (${byron.status} ${show(byron.json)})`);
    const mullumAfter = await signedFor(MULLUM);
    assert(mullumAfter.status === 200, `after it a signature for ${MULLUM} still passes (${mullumAfter.status} ${show(mullumAfter.json)}; on main: 421 wrong_community)`);
    const byronAfter = await signedFor(BYRON);
    assert(byronAfter.status === 200, `a signature for ${BYRON} passes (${byronAfter.status})`);
    const stranger = await signedFor('other.test');
    assert(stranger.status === 421 && stranger.json?.code === 'wrong_community', `another community's host is still 421 (${stranger.status} ${show(stranger.json)})`);
    const i1 = await info();
    assert(i1.addresses?.includes(MULLUM) && i1.addresses?.includes(BYRON), `/api/community/info lists both names (${show(i1.addresses)})`);
    assert(i1.primaryAddress === BYRON, `byron is the main name (${i1.primaryAddress})`);
    assert((i1.formerAddresses ?? []).length === 0, `neither is a former name (${show(i1.formerAddresses)})`);
    assert(ownerConfirmedAddresses().includes(MULLUM), `the claim copied ${MULLUM} into ownerAddresses, so it travels in the take-over envelope (${show(stored().ownerAddresses)})`);
    delete process.env.CF_RECORD_NAME;
    forgetOwnAddresses();
    const promoted = await signedFor(MULLUM);
    assert(promoted.status === 200 && publishedAddresses().includes(MULLUM),
        `a server without that CF_RECORD_NAME (a promoted standby) keeps it from the list (${promoted.status}, ${show(publishedAddresses())})`);

    // ── 2 ──
    console.log('\n— 2. a gated claim: the old name passes and stays main while the new one waits —');
    scene({ cf: MULLUM });
    gated.add('byron');
    const waiting = await claim('byron');
    assert(waiting.status === 200 && waiting.json?.status === 'pending', `the claim waits for approval (${waiting.status} ${show(waiting.json)})`);
    const whileWaiting = await signedFor(MULLUM);
    assert(whileWaiting.status === 200, `while it waits a signature for ${MULLUM} passes (${whileWaiting.status} ${show(whileWaiting.json)}; on main: 421 from the claim on)`);
    assert(primaryAddress() === MULLUM, `while it waits ${MULLUM} is the main name, not a name with no route yet (${primaryAddress()})`);
    approve('byron');
    const opened = await statusRead();
    assert(opened.status === 200 && opened.json?.status === 'live', `approved: Settings' status read stores it live (${opened.status} ${show(opened.json)})`);
    assert(primaryAddress() === BYRON && publishedAddresses().includes(MULLUM), `byron is the main name, mullum still published (${primaryAddress()}, ${show(publishedAddresses())})`);
    assert((await signedFor(MULLUM)).status === 200, 'and a signature for the old name still passes');

    // ── 3 ──
    console.log('\n— 3. what a claim copies, and what a release takes back —');
    scene({ config: { publicAddress: liveTunnel('oldvale') }, names: ['oldvale'] });
    const moved = await claim('newvale');
    const OLD = 'oldvale.beanpool.org', NEW = 'newvale.beanpool.org';
    assert(moved.status === 200 && ownerConfirmedAddresses().includes(OLD), `a live registrar name replaced is copied (${moved.status}, ${show(stored().ownerAddresses)})`);
    assert(publishedAddresses().includes(OLD) && !formerAddresses().includes(OLD) && primaryAddress() === NEW,
        `and stays published, the new name main (${show(publishedAddresses())}, former ${show(formerAddresses())}, ${primaryAddress()})`);
    assert((await signedFor(OLD)).status === 200, 'a signature for it passes');
    const released = await post('/api/local/admin/public-address/release-name', phone(), { name: 'oldvale' });
    assert(released.status === 200, `Release lets it go (${released.status} ${show(released.json)})`);
    assert(!ownerConfirmedAddresses().includes(OLD) && !publishedAddresses().includes(OLD) && formerAddresses().includes(OLD),
        `released, it is no longer published, only former (${show(stored().ownerAddresses)}, ${show(publishedAddresses())}, ${show(formerAddresses())})`);
    assert(audienceStanding(OLD) === 'own', 'and is accepted through its hold, as a former name is');

    // A → B → A, then Take offline: the name that went offline was also on the list from the first move.
    scene({ config: { publicAddress: liveTunnel('oldvale') }, names: ['oldvale'] });
    await claim('newvale');
    await claim('oldvale');
    const offline = await post('/api/local/admin/public-address/offline', phone(), {});
    assert(offline.status === 200 && !publishedAddresses().includes(OLD) && primaryAddress() !== OLD,
        `taken offline, a name the list also held is not published or main (${offline.status}, ${show(publishedAddresses())}, ${primaryAddress()})`);
    assert(primaryAddress() === NEW, `the community falls back to the name it still holds (${primaryAddress()})`);

    // The way back (design §6): Take offline on the new name, and the fleet name is main again.
    scene({ cf: MULLUM });
    await claim('byron');
    const undone = await post('/api/local/admin/public-address/offline', phone(), {});
    assert(undone.status === 200 && primaryAddress() === MULLUM && !publishedAddresses().includes(BYRON),
        `the new name taken offline: the old one is main again, the new one unpublished (${undone.status}, ${primaryAddress()}, ${show(publishedAddresses())})`);
    assert((await signedFor(BYRON)).status === 200, 'and a signature for the new name is accepted through its hold');

    scene({ config: { publicAddress: { name: 'waitvale', mode: 'tunnel', status: 'pending' } } });
    await claim('nextvale');
    assert(!ownerConfirmedAddresses().includes('waitvale.beanpool.org') && !publishedAddresses().includes('waitvale.beanpool.org'),
        `a name that was only waiting is not copied: this community never went by it (${show(stored().ownerAddresses)}, ${show(publishedAddresses())})`);
    scene({
        config: {
            publicAddress: { name: 'pausedvale', mode: 'tunnel', hostname: 'pausedvale.beanpool.org', status: 'paused' },
            registrarNames: [{ address: 'pausedvale.beanpool.org', role: 'current', status: 'paused', reason: null, since: new Date().toISOString(), formerSince: null, heldUntil: null, releasedByUsAt: null, renamedByUsAt: null, lost: null }],
        },
    });
    await claim('nextvale');
    assert(!ownerConfirmedAddresses().includes('pausedvale.beanpool.org'), `a name the registrar paused is not copied (${show(stored().ownerAddresses)})`);
    // A replaced address the list is full of: the name is kept all the same, past the bound of what a Settings session adds.
    const full = Array.from({ length: 20 }, (_, i) => `198.51.100.${i + 1}`);
    scene({ cf: MULLUM, config: { ownerAddresses: full } });
    assert((await claim('byron')).status === 200 && ownerConfirmedAddresses().includes(MULLUM), `with the list full the replaced name is still kept (${ownerConfirmedAddresses().length})`);

    // ── 4 ──
    console.log('\n— 4. fresh proof whenever the node already publishes an address —');
    const publishing: { what: string; s: NonNullable<Parameters<typeof scene>[0]> }[] = [
        { what: "the fleet's CF_RECORD_NAME", s: { cf: MULLUM } },
        { what: 'its own IP', s: { config: { publicAddress: { mode: 'ip', hostname: IP, status: 'live' }, ownerAddresses: [IP] } } },
        { what: 'its own domain', s: { config: { publicAddress: { mode: 'own', hostname: DOMAIN, status: 'live' }, ownerAddresses: [DOMAIN] } } },
        { what: 'BEANPOOL_ADDRESSES', s: { env: DOMAIN } },
        { what: 'an address confirmed in Settings', s: { config: { ownerAddresses: [DOMAIN] } } },
        { what: 'a live registrar name', s: { config: { publicAddress: liveTunnel('oldvale') }, names: ['oldvale'] } },
        { what: 'the fleet name beside a name still waiting', s: { cf: MULLUM, config: { publicAddress: { name: 'waitvale', mode: 'tunnel', status: 'pending' } } } },
    ];
    for (const { what, s } of publishing) {
        scene(s);
        const was = claimsAsked;
        const r = await claim('byron', computer());
        assert(r.status === 403 && r.json?.code === 'phone_required' && claimsAsked === was,
            `${what}: a computer's session is sent to the phone, nothing asked of the address service (${r.status} ${show(r.json)})`);
        const held1 = show(stored().publicAddress);
        assert(held1 === show(s.config?.publicAddress ?? null), `${what}: nothing changed here (${held1})`);
        const ok = await claim('byron', phone());
        assert(ok.status === 200, `${what}: from the phone, Manage just pressed, it goes through (${ok.status} ${show(ok.json)})`);
    }
    const plain: { what: string; s: Parameters<typeof scene>[0]; name?: string }[] = [
        { what: 'no address at all', s: {} },
        { what: 'only a former name', s: { config: { registrarNames: [{ address: 'gone.beanpool.org', role: 'former', status: 'released', reason: null, since: new Date().toISOString(), formerSince: new Date().toISOString(), heldUntil: null, releasedByUsAt: new Date().toISOString(), renamedByUsAt: null, lost: null }] } } },
        { what: 'only a loopback name for an SSH tunnel', s: { env: 'localhost' } },
        { what: 'a name still waiting, nothing else', s: { config: { publicAddress: { name: 'waitvale', mode: 'tunnel', status: 'pending' } } } },
        { what: 'the same live name again', s: { config: { publicAddress: liveTunnel('byron') }, names: ['byron'] } },
        { what: 'the same waiting name again, beside the fleet name', s: { cf: MULLUM, config: { publicAddress: { name: 'byron', mode: 'tunnel', status: 'pending' } } } },
        { what: 'the name it is already published at', s: { cf: BYRON } },
    ];
    for (const { what, s } of plain) {
        scene(s);
        const r = await claim('byron', computer());
        assert(r.status === 200, `${what}: plain, no proof asked (${r.status} ${show(r.json)})`);
    }
    scene({ cf: MULLUM });
    const noLabel = await post(CLAIM, computer(), { name: 'no', mode: 'tunnel' });
    assert(noLabel.status === 400, `a name that is no address label: 400 before any proof is spent (${noLabel.status} ${show(noLabel.json)})`);
    {
        const totp = turnOn2faForTests(PW);
        scene({ cf: MULLUM });
        const was = claimsAsked;
        const noCode = await post(CLAIM, { 'X-Admin-Password': PW, 'X-Admin-TOTP': totp.code() }, { name: 'byron', mode: 'tunnel' });
        assert(noCode.status === 200 && claimsAsked === was + 1, `the password with a current code goes through (${noCode.status} ${show(noCode.json)})`);
        updateLocalConfig({ totpEnabled: false, totpSecret: null } as any);
        scene({ cf: MULLUM });
        const noTwoFactor = await post(CLAIM, { 'X-Admin-Password': PW }, { name: 'byron', mode: 'tunnel' });
        assert(noTwoFactor.status !== 200 && claimsAsked === was + 1, `the password alone with 2FA off fails closed: nothing asked of the address service (${noTwoFactor.status} ${show(noTwoFactor.json)})`);
    }

    // ── 5 ──
    console.log('\n— 5. the members\' notice —');
    answerMode = 'direct'; // Section 7 has the tunnels.
    claimAsks = { mode: 'direct', publicIp: '8.8.8.8' };
    const addressIn = (msg: unknown) => /beanpool\.org|byron|mullum/i.test(JSON.stringify(msg));
    {
        scene({ cf: MULLUM });
        const n0 = notices().length;
        const r = await claim('byron');
        const told = notices().slice(n0);
        assert(r.status === 200 && told.length === 1 && told[0].title === SOFT_TITLE && told[0].body === SOFT_BODY,
            `a fleet name joined by a live name: the soft words, once (${show(told)})`);
        assert(notes.filter((n) => n.key === 'sec.address').length === 1, `the owners are told once (${show(notes.map((n) => n.detail))})`);
        await new Promise((res) => setTimeout(res, 50));
        const notice = pushed.filter((m) => m.data?.k === 'community.notice');
        assert(notice.length === 1 && !addressIn(notice[0]), `what is pushed names no address (${show(notice)})`);
        await statusRead();
        await reconcile();
        await claim('byron');
        assert(notices().length === n0 + 1, `no read, tick or claim of the same name tells again (${notices().length - n0})`);
    }
    {
        scene({ cf: MULLUM });
        gated.add('byron');
        const n0 = notices().length;
        await claim('byron');
        await statusRead();
        await reconcile();
        assert(notices().length === n0, `nothing is said while the new name waits (${show(notices().slice(n0))})`);
        await claim('byron', computer());
        assert(notes.filter((n) => n.key === 'sec.address').length === 1, `claiming the waiting name again changes nothing: the owners are told once (${show(notes.map((n) => n.detail))})`);
        approve('byron');
        await reconcile();
        const told = notices().slice(n0);
        assert(told.length === 1 && told[0].body === SOFT_BODY, `the agent's tick that finds it live tells, once (${show(told)})`);
        await reconcile();
        await statusRead();
        assert(notices().length === n0 + 1, `and no later tick or read tells again (${notices().length - n0})`);
    }
    {
        scene({ cf: MULLUM });
        gated.add('byron');
        const n0 = notices().length;
        await claim('byron');
        approve('byron');
        await statusRead();
        const told = notices().slice(n0);
        assert(told.length === 1 && told[0].body === SOFT_BODY, `Settings' status read that finds it live tells too, once (${show(told)})`);
        await statusRead();
        await reconcile();
        assert(notices().length === n0 + 1, `and nothing tells again (${notices().length - n0})`);
    }
    {
        scene({ config: { publicAddress: { mode: 'ip', hostname: IP, status: 'live' }, ownerAddresses: [IP] } });
        const n0 = notices().length;
        await claim('byron');
        const told = notices().slice(n0);
        assert(told.length === 1 && told[0].body === SOFT_BODY && publishedAddresses().includes(IP), `an own address joined by a name: the soft words (${show(told)})`);
    }
    {
        scene({ config: { publicAddress: liveDirect('oldvale') }, names: ['oldvale'] });
        const n0 = notices().length;
        await claim('byron');
        const told = notices().slice(n0);
        assert(told.length === 1 && told[0].body === SOFT_BODY, `a live direct name replaced: its record stays at the address service, so the soft words (${show(told)})`);
    }
    {
        scene({ config: { publicAddress: liveTunnel('oldvale') }, names: ['oldvale'] });
        const n0 = notices().length;
        await claim('byron');
        await statusRead();
        await reconcile();
        const told = notices().slice(n0);
        assert(told.length === 1 && told[0].body === CRITICAL_BODY,
            `a live tunnel name with no token saved has no tunnel to keep: the critical words, once (${show(told)})`);
    }
    {
        scene();
        const n0 = notices().length;
        await claim('byron');
        assert(notices().length === n0, `a first name on a node with none: nothing to tell (${show(notices().slice(n0))})`);
    }
    {
        scene({ cf: MULLUM });
        gated.add('byron');
        const n0 = notices().length;
        await claim('byron');
        assert(getLocalConfig().addressNoticeDue === BYRON, `a claim that waits leaves the notice due (${getLocalConfig().addressNoticeDue})`);
        await post('/api/local/admin/public-address/offline', phone(), {});
        assert(!getLocalConfig().addressNoticeDue && notices().length === n0, `a waiting name taken offline tells nobody, and nothing stays due (${show(notices().slice(n0))})`);
        // The old name is still this community's: claimed again, byron joins it, and that is told once it is live.
        gated.clear();
        await claim('byron');
        assert(notices().length === n0 + 1 && notices()[n0].body === SOFT_BODY, `claimed again, it joins the old name, and the members are told (${show(notices().slice(n0))})`);
    }
    {
        // The stored name, paused in the record, with another address beside it: primaryAddress is that other address, and
        // a claim of the stored name replaces nothing. Nobody is told of the name they were already on.
        scene({ config: { publicAddress: liveDirect('mullum'), ownerAddresses: ['oldvale.beanpool.org'] }, names: ['mullum'] });
        statusAnswer = { status: 'paused', name: 'mullum', hostname: MULLUM, mode: 'direct' };
        await statusRead();
        statusAnswer = null;
        updateNodeConfig({ publicAddress: liveDirect('mullum') } as any);
        forgetOwnAddresses();
        const n0 = notices().length;
        assert(primaryAddress() === 'oldvale.beanpool.org', `the record's pause leaves the other address main (${primaryAddress()})`);
        await claim('mullum');
        assert(notices().length === n0 && !getLocalConfig().addressNoticeDue, `a claim of the name already stored tells nobody and leaves nothing due (${show(notices().slice(n0))}, ${getLocalConfig().addressNoticeDue})`);
    }
    {
        // A notice left due for a name that is replaced by a claim beside no other address ends with that claim.
        scene({ cf: MULLUM });
        gated.add('byron');
        const n0 = notices().length;
        await claim('byron');
        delete process.env.CF_RECORD_NAME;
        updateNodeConfig({ ownerAddresses: [] } as any);
        forgetOwnAddresses();
        await claim('nextvale');
        assert(!getLocalConfig().addressNoticeDue && notices().length === n0, `a claim that replaces nothing ends a notice due for another name (${show(notices().slice(n0))})`);
    }

    // ── 6 ──
    console.log('\n— 6. the public-address agent claims too —');
    {
        scene({ cf: MULLUM });
        process.env.PUBLIC_ADDRESS_NAME = 'byron';
        const n0 = notices().length;
        await reconcile();
        delete process.env.PUBLIC_ADDRESS_NAME;
        const told = notices().slice(n0);
        assert(stored().publicAddress?.name === 'byron' && ownerConfirmedAddresses().includes(MULLUM), `the agent's claim copies the old name too (${show(stored().ownerAddresses)})`);
        assert(told.length === 1 && told[0].body === SOFT_BODY, `and tells the members once (${show(told)})`);
    }

    // ── 7 ──
    console.log('\n— 7. told once the tunnel carries the new name —');
    answerMode = null;
    claimAsks = {};
    const fake = await useFakeCloudflared(path.join(dataDir, 'fake-cloudflared'), { pollStartingMs: 20, pollConnectedMs: 20 });
    const until = async (cond: () => boolean, ms = 5_000): Promise<boolean> => {
        const end = Date.now() + ms;
        while (!cond() && Date.now() < end) await new Promise((r) => setTimeout(r, 20));
        return cond();
    };
    /** Past a few of the connector's polls: long enough for a notice that was going to go out. */
    const polls = () => new Promise((r) => setTimeout(r, 150));
    const withToken = (name: string) => ({ ...liveAnswer(name), tunnelToken: `T-${name}` });
    /** `scene`, with no tunnel running and cloudflared's /ready saying it has not connected. */
    const tunnelScene = async (s: Parameters<typeof scene>[0]) => {
        scene(s);
        fake.ready(503);
        await resetTunnelConnectorForTests();
    };
    const due = () => getLocalConfig().addressNoticeDue ?? null;
    const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
    /** The tokens running now, sorted: every child the connector started, whichever name it is for. */
    const onTokens = () => fake.runs().filter((r) => alive(r.pid)).map((r) => r.env.TUNNEL_TOKEN).sort();
    /** The agent's own tick, past its quiet wait. */
    let tickNow = Date.now() + 1_000_000_000;
    const tickOnce = () => tick((tickNow += 3_600_000));
    {
        await tunnelScene({ cf: MULLUM });
        held.set('byron', withToken('byron'));
        const n0 = notices().length;
        const r = await claim('byron');
        assert(r.status === 200 && r.json?.status === 'live' && (await until(() => tunnelConnectorForTests().runningToken === 'T-byron')),
            `the claim answers live and the tunnel starts on its token (${r.status} ${show(r.json)})`);
        await polls();
        assert(notices().length === n0 && due() === BYRON, `while the tunnel connects nobody is told, and the notice stays due (${show(notices().slice(n0))}, ${due()})`);
        await statusRead();
        await reconcile();
        await polls();
        assert(notices().length === n0 && due() === BYRON, `nor does a status read or a tick tell before it connects (${show(notices().slice(n0))}, ${due()})`);
        fake.ready(200);
        assert(await until(() => notices().length > n0), `the tunnel connects: the members are told without any tick or read (${getTunnelStatus().state})`);
        assert(notices().length === n0 + 1 && notices()[n0].body === SOFT_BODY && due() === null, `once, in the soft words, and nothing stays due (${show(notices().slice(n0))}, ${due()})`);
        await polls();
        await statusRead();
        await reconcile();
        assert(notices().length === n0 + 1, `and no later poll, read or tick tells again (${notices().length - n0})`);
    }
    {
        await tunnelScene({ cf: MULLUM });
        gated.add('byron');
        const n0 = notices().length;
        await claim('byron');
        held.set('byron', withToken('byron'));
        await reconcile();
        await polls();
        assert(stored().publicAddress?.status === 'live' && notices().length === n0 && due() === BYRON,
            `approved, the tick stores it live and still waits for the tunnel (${stored().publicAddress?.status}, ${show(notices().slice(n0))}, ${due()})`);
        fake.ready(200);
        assert(await until(() => notices().length > n0) && notices()[n0].body === SOFT_BODY, `and it connects: told (${show(notices().slice(n0))})`);
    }
    {
        await tunnelScene({ cf: MULLUM });
        gated.add('byron');
        const n0 = notices().length;
        await claim('byron');
        held.set('byron', withToken('byron'));
        await statusRead();
        await polls();
        assert(stored().publicAddress?.status === 'live' && notices().length === n0 && due() === BYRON,
            `approved, Settings' read stores it live and still waits for the tunnel (${stored().publicAddress?.status}, ${show(notices().slice(n0))}, ${due()})`);
        fake.ready(200);
        assert(await until(() => notices().length > n0) && notices()[n0].body === SOFT_BODY, `and it connects: told (${show(notices().slice(n0))})`);
    }
    {
        // The registrar answers live with no token when its Cloudflare call fails: no route yet, however live it says.
        await tunnelScene({ cf: MULLUM });
        const n0 = notices().length;
        const r = await claim('byron');
        await polls();
        assert(r.json?.status === 'live' && tunnelConnectorForTests().wantedToken === null && notices().length === n0 && due() === BYRON,
            `live with no token: nobody told, and the notice stays due (${r.json?.status}, ${show(notices().slice(n0))}, ${due()})`);
        held.set('byron', withToken('byron'));
        await reconcile();
        fake.ready(200);
        assert(await until(() => notices().length > n0) && notices()[n0].body === SOFT_BODY, `a later tick brings the token, it connects: told (${show(notices().slice(n0))})`);
    }
    {
        await tunnelScene({ cf: MULLUM });
        gated.add('byron');
        const n0 = notices().length;
        await claim('byron');
        approve('byron');
        await reconcile();
        await polls();
        assert(stored().publicAddress?.status === 'live' && notices().length === n0 && due() === BYRON,
            `approved with no token, the tick stores it live and tells nobody (${stored().publicAddress?.status}, ${show(notices().slice(n0))}, ${due()})`);
    }
    {
        // The form stays on screen while a tunnel retries: pressing Claim on the same name keeps the notice.
        await tunnelScene({ cf: MULLUM });
        held.set('byron', withToken('byron'));
        const n0 = notices().length;
        await claim('byron');
        await claim('byron');
        await polls();
        assert(notices().length === n0 && due() === BYRON, `claimed again while it connects, the notice stays due (${show(notices().slice(n0))}, ${due()})`);
        fake.ready(200);
        assert(await until(() => notices().length > n0) && notices().length === n0 + 1 && notices()[n0].body === SOFT_BODY && due() === null,
            `and it connects: told, once (${show(notices().slice(n0))}, ${due()})`);
    }
    {
        // The notice is kept in local config: a restart before the tunnel connects loses nothing.
        await tunnelScene({ cf: MULLUM });
        held.set('byron', withToken('byron'));
        const n0 = notices().length;
        await claim('byron');
        await resetTunnelConnectorForTests();
        assert(notices().length === n0 && due() === BYRON, `a restart before it connects: nobody told, still due (${due()})`);
        await syncTunnel();
        fake.ready(200);
        assert(await until(() => notices().length > n0), 'and the tunnel of the next start tells when it connects');
    }
    {
        // cloudflared can't start: syncTunnel answers, nothing is reachable, and the members are not sent there.
        await tunnelScene({ cf: MULLUM });
        setTunnelConnectorForTests({ command: path.join(dataDir, 'no-such-dir', 'cloudflared') });
        held.set('byron', withToken('byron'));
        const n0 = notices().length;
        await claim('byron');
        await polls();
        assert(getTunnelStatus().state === 'missing' && notices().length === n0 && due() === BYRON,
            `a tunnel that cannot start tells nobody, and the notice stays due (${getTunnelStatus().state}, ${show(notices().slice(n0))}, ${due()})`);
        setTunnelConnectorForTests({ command: process.execPath });
        fake.ready(200);
        await syncTunnel();
        assert(await until(() => notices().length > n0) && notices()[n0].body === SOFT_BODY, `fixed, it connects and the notice goes out (${show(notices().slice(n0))})`);
    }
    {
        // The agent claims over a live tunnel name: an older registrar answers about the key's first name, gone, so the
        // record still says the stored name is live and main; and the env names another. The old name keeps its child.
        const oldvale = { ...liveTunnel('oldvale'), tunnelToken: 'T-oldvale' };
        await tunnelScene({ config: { publicAddress: oldvale } });
        fake.ready(200);
        await syncTunnel();
        assert(await until(() => getTunnelStatus().state === 'connected'), `the old name's tunnel is connected (${getTunnelStatus().state})`);
        statusAnswer = { status: 'released', name: 'firstname' };
        held.set('byron', withToken('byron'));
        const n0 = notices().length;
        process.env.PUBLIC_ADDRESS_NAME = 'byron';
        await reconcile();
        delete process.env.PUBLIC_ADDRESS_NAME;
        assert(stored().publicAddress?.name === 'byron' && ownerConfirmedAddresses().includes('oldvale.beanpool.org') && tunnelConnectorForTests().runningToken === 'T-byron',
            `the agent's claim keeps the old name, and the stored name's connector runs the new one (${stored().publicAddress?.name}, ${show(stored().ownerAddresses)}, ${tunnelConnectorForTests().runningToken})`);
        assert(await until(() => getTunnelStatus().state === 'connected'), `and it connects (${getTunnelStatus().state})`);
        assert(await until(() => show(onTokens()) === show(['T-byron', 'T-oldvale'])), `the old name's child keeps running beside it (${show(onTokens())})`);
        assert(await until(() => notices().length > n0) && notices().length === n0 + 1 && notices()[n0].body === SOFT_BODY && due() === null,
            `the old address really keeps working, so the members are told that, once (${show(notices().slice(n0))}, ${due()})`);
    }

    // ── 8 ──
    console.log('\n— 8. the three ways a community moves —');
    const { getDirectoryInfo } = await import('./state-engine.js');
    const { communityCard } = await import('./routes/community-card.js');
    const { nodeUrlFor, ownOrigin } = await import('./agent/mcp-route.js');
    const { tlsIdentifiers } = await import('./engine/own-addresses.js');
    /** Where each surface sends people. `want`: a host. */
    const surfaces = () => ({
        primary: primaryAddress(), directory: getDirectoryInfo().publicUrl, card: communityCard().host,
        assistant: nodeUrlFor({ req: {}, host: 'unused' }), origin: ownOrigin(),
    });
    const onlyAt = (want: string) => show(surfaces()) === show({ primary: want, directory: `https://${want}`, card: want, assistant: `https://${want}`, origin: `https://${want}` });
    {
        // (a) Its own domain, then a beanpool.org name, live at once.
        await tunnelScene({ config: { publicAddress: { mode: 'own', hostname: DOMAIN, status: 'live' }, ownerAddresses: [DOMAIN] } });
        fake.ready(200);
        held.set('byron', withToken('byron'));
        const n0 = notices().length;
        assert(onlyAt(DOMAIN), `(a) before: every surface says the domain (${show(surfaces())})`);
        const r = await claim('byron');
        assert(r.status === 200 && r.json?.status === 'live', `(a) the claim answers live (${r.status} ${show(r.json)})`);
        assert(await until(() => getTunnelStatus().state === 'connected') && show(onTokens()) === show(['T-byron']), `(a) one tunnel: the domain needs none (${show(onTokens())})`);
        assert(await until(() => notices().length > n0) && notices().slice(n0).every((n) => n.body === SOFT_BODY), `(a) the members are told, softly (${show(notices().slice(n0))})`);
        assert(onlyAt(BYRON), `(a) after: every surface says the name (${show(surfaces())})`);
        assert((await signedFor(DOMAIN)).status === 200 && (await signedFor(BYRON)).status === 200, '(a) a signature for either passes');
        const i = await info();
        assert(i.addresses?.includes(DOMAIN) && i.addresses?.includes(BYRON) && i.primaryAddress === BYRON, `(a) both are listed, the name main (${show(i.addresses)})`);
        assert(tlsIdentifiers().includes(DOMAIN), `(a) and the domain keeps its own certificate (${show(tlsIdentifiers())})`);
    }
    {
        // (b) Its own domain, a gated name pending, then approved.
        await tunnelScene({ config: { publicAddress: { mode: 'own', hostname: DOMAIN, status: 'live' }, ownerAddresses: [DOMAIN] } });
        fake.ready(200);
        gated.add('byron');
        const n0 = notices().length;
        const r = await claim('byron');
        assert(r.status === 200 && r.json?.status === 'pending', `(b, domain) the claim waits (${r.status} ${show(r.json)})`);
        assert(onlyAt(DOMAIN), `(b, domain) while it waits nothing moves: not the directory, the card or an assistant (${show(surfaces())}; on main all but primaryAddress say the waiting name)`);
        assert((await info()).primaryAddress === DOMAIN && (await signedFor(DOMAIN)).status === 200, '(b, domain) the app is told the domain, and it passes');
        assert(notices().length === n0, `(b, domain) nobody is told (${show(notices().slice(n0))})`);
        held.set('byron', withToken('byron'));
        await reconcile();
        assert(await until(() => getTunnelStatus().state === 'connected'), `(b, domain) approved, its tunnel connects (${getTunnelStatus().state})`);
        assert(onlyAt(BYRON), `(b, domain) and only now does every surface move (${show(surfaces())})`);
        assert(await until(() => notices().length > n0) && notices()[n0].body === SOFT_BODY && notices().length === n0 + 1, `(b, domain) told once (${show(notices().slice(n0))})`);
        assert((await signedFor(DOMAIN)).status === 200 && (await signedFor(BYRON)).status === 200, '(b, domain) a signature for either passes');
    }
    {
        // (b) A registrar name on its tunnel, a gated name pending, then approved. On main the old name's tunnel stops at the claim.
        const oldvale = { ...liveTunnel('oldvale'), tunnelToken: 'T-oldvale' };
        const OLD = 'oldvale.beanpool.org';
        await tunnelScene({ config: { publicAddress: oldvale } });
        fake.ready(200);
        held.set('oldvale', withToken('oldvale'));
        gated.add('byron');
        await syncTunnel();
        assert(await until(() => getTunnelStatus().state === 'connected'), `(b, name) the old name is connected (${getTunnelStatus().state})`);
        const pid = fake.runs().filter((x) => x.env.TUNNEL_TOKEN === 'T-oldvale').at(-1)!.pid;
        const n0 = notices().length;
        const r = await claim('byron');
        assert(r.status === 200 && r.json?.status === 'pending', `(b, name) the claim waits (${r.status} ${show(r.json)})`);
        await polls();
        assert(show(onTokens()) === show(['T-oldvale']) && alive(pid), `(b, name) while it waits the old name's tunnel keeps running (${show(onTokens())}; on main it stops here)`);
        assert(onlyAt(OLD), `(b, name) and nothing moves (${show(surfaces())})`);
        assert((await signedFor(OLD)).status === 200, '(b, name) a signature for it passes');
        assert(notices().length === n0, `(b, name) nobody is told anything, least of all that the address changed (${show(notices().slice(n0))})`);
        await reconcile();
        await tickOnce();
        assert(alive(pid) && onlyAt(OLD), `(b, name) a tick changes nothing while it waits (${show(surfaces())})`);
        held.set('byron', withToken('byron'));
        await reconcile();
        assert(await until(() => show(onTokens()) === show(['T-byron', 'T-oldvale'])), `(b, name) approved, both run (${show(onTokens())})`);
        assert(alive(pid) && await until(() => getTunnelStatus().state === 'connected'), '(b, name) the old child never stopped');
        assert(onlyAt(BYRON), `(b, name) and only now does every surface move (${show(surfaces())})`);
        assert(await until(() => notices().length > n0) && notices().length === n0 + 1 && notices()[n0].body === SOFT_BODY, `(b, name) told once, softly (${show(notices().slice(n0))})`);
        assert((await signedFor(OLD)).status === 200 && (await signedFor(BYRON)).status === 200, '(b, name) a signature for either passes');
    }
    {
        // (b) Refused: the name never comes, and the community stays where it is, its tunnel running.
        const oldvale = { ...liveTunnel('oldvale'), tunnelToken: 'T-oldvale' };
        const OLD = 'oldvale.beanpool.org';
        await tunnelScene({ config: { publicAddress: oldvale } });
        fake.ready(200);
        held.set('oldvale', withToken('oldvale'));
        gated.add('byron');
        await syncTunnel();
        await until(() => getTunnelStatus().state === 'connected');
        await claim('byron');
        held.delete('byron');
        await reconcile();
        await tickOnce();
        assert(show(onTokens()) === show(['T-oldvale']) && onlyAt(OLD), `(b, refused) nothing moved (${show(onTokens())}, ${show(surfaces())})`);
    }
    {
        // (c) A registrar name to a registrar name, both live.
        const oldvale = { ...liveTunnel('oldvale'), tunnelToken: 'T-oldvale' };
        const OLD = 'oldvale.beanpool.org';
        await tunnelScene({ config: { publicAddress: oldvale } });
        fake.ready(200);
        held.set('oldvale', withToken('oldvale'));
        held.set('byron', withToken('byron'));
        await syncTunnel();
        await until(() => getTunnelStatus().state === 'connected');
        const pid = fake.runs().filter((x) => x.env.TUNNEL_TOKEN === 'T-oldvale').at(-1)!.pid;
        const n0 = notices().length;
        const r = await claim('byron');
        assert(r.status === 200 && r.json?.status === 'live', `(c) the claim answers live (${r.status} ${show(r.json)})`);
        assert(await until(() => show(onTokens()) === show(['T-byron', 'T-oldvale'])) && alive(pid), `(c) both names run, the old child never stopped (${show(onTokens())}; on main only T-byron)`);
        assert(await until(() => notices().length > n0) && notices().length === n0 + 1 && notices()[n0].body === SOFT_BODY, `(c) the members hear the soft words, once (${show(notices().slice(n0))}; on main the critical ones)`);
        assert(onlyAt(BYRON) && (await info()).addresses?.includes(OLD), `(c) every surface says the new name, the old one still listed (${show(surfaces())})`);
        assert((await signedFor(OLD)).status === 200 && (await signedFor(BYRON)).status === 200, '(c) a signature for either passes');
    }
    await resetTunnelConnectorForTests();

    await new Promise<void>((r) => registrar.close(() => r()));
    console.log(`\n${testsPassed}/${testsRun} passed`);
    process.exit(testsPassed === testsRun ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
