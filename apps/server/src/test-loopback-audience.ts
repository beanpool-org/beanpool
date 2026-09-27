/**
 * Loopback (localhost, 127.0.0.1, [::1]) is this community's own name only on a node that knows none of its names
 * (engine/own-addresses.ts rule 5; director's call 2026-09-27).
 *
 * Request binding (#1219) accepts a format-2 signature only for one of this community's names. It counted loopback as
 * every node's own, always, so a signature for 127.0.0.1 was good at every community in the world: anything that got a
 * member's app to sign for it (#1224's iOS URL-parsing gap, an app on the phone listening on 127.0.0.1) collected
 * requests valid everywhere. Now a node with any name of its own (a public address, BEANPOOL_ADDRESSES, an
 * owner-confirmed address, a registrar name) treats loopback like any other host: another community's (421).
 *
 * Every node here is a REAL server, its own process in its own process group, over real HTTPS through the real
 * signature middleware. The requests reach each one at localhost; the host a request is signed for is what the app
 * says it connected to.
 *
 *  1. N, named by CF_RECORD_NAME (named.test), ENFORCE_WS_AUTH=true. For 127.0.0.1, localhost and [::1] each:
 *     a Beans send signed for it → 421 wrong_community, nothing written, the nonce unspent (the same body re-signed
 *     for named.test with that nonce and timestamp is accepted); a /ws token → 401, nonce unspent (re-signed for
 *     named.test it opens); a Manage sign-in → 421, no session, the challenge still open (signed for named.test it
 *     opens one). /api/community/info lists named.test and no loopback name.
 *  2. The old format (bound to no community) is untouched on N before the switch: a send, a socket and the old
 *     Manage sign-in form work as they did. This change is about format-2 audiences only.
 *  3. A node named only by BEANPOOL_ADDRESSES (E), only by an owner-confirmed address (O), only by a registrar name
 *     (R): loopback → 421 with the nonce unspent; its own name → accepted.
 *  4. U, a node with none of those (a developer's): loopback and the rest of 127.0.0.0/8 are accepted, also after the
 *     switch (while a host it doesn't know is refused then); a /ws token and a Manage sign-in for 127.0.0.1 work.
 *     Loopback is never listed: not in /api/community/info, not among the addresses Settings offers to confirm or
 *     holds back.
 *  5. L, named (optin.test) with BEANPOOL_ADDRESSES=localhost, 127.0.0.1, [::1], ::1: the explicit way in. Those three
 *     are accepted and 127.0.0.2 is not; Settings lists them as set on the server; /api/community/info still lists
 *     only optin.test; the log names the bare ::1 as left out and gives its bracketed form.
 *  6. Z, with ONLY BEANPOOL_ADDRESSES=localhost (an owner who followed the SSH-tunnel advice on a node with no other
 *     name): still a node that knows none of its names (4113741087). Before the switch it accepts its domain
 *     (community.example.org) and a home-network address as it did with nothing set, and localhost and 127.0.0.1;
  *     Settings says it has no name, offers the domain to confirm (Settings open at it) and lists localhost as set on
 *     the server;
 *     /api/community/info lists nothing. After the switch the domain is refused, localhost and the home network not.
 *  7. T, named (tunnel.test) with BEANPOOL_ADDRESSES=localhost: localhost and tunnel.test are accepted; the domain,
 *     a home-network address and 127.0.0.1 (not listed) are refused with the nonce unspent. Settings says it has a
 *     name and offers nothing.
 *
 * The nodes' switch clocks are pinned just before the switch (unboundSignaturesCutoff), except where a step moves one
 * past it, so the suite holds for any date.
 *
 *   BEANPOOL_DATA_DIR=$(mktemp -d) pnpm exec tsx apps/server/src/test-loopback-audience.ts
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import https from 'node:https';
import path from 'node:path';
import readline from 'node:readline';
import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SCRIPT = fileURLToPath(import.meta.url);
const PW = 'Loopback-Audience-Pw-5820!';
const AVATAR = 'data:image/png;base64,iVBORw0KGgo=';
const LOOPBACK = ['127.0.0.1', 'localhost', '[::1]'];
/** The switch (ms), read from the nodes once they are up. */
let SWITCH = 0;

// ── The node processes ─────────────────────────────────────────────────────────────────────

function reply(msg: Record<string, unknown>): void {
    process.stdout.write('@@ ' + JSON.stringify(msg) + '\n');
}

async function child(): Promise<void> {
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
    // Never a real certificate or DNS: a self-signed certificate whatever the name.
    delete process.env.CF_API_TOKEN;
    delete process.env.CF_ZONE_ID;
    const { initAdminPassword } = await import('./config/local-config.js');
    const { initTls } = await import('./services/tls.js');
    const se = await import('./state-engine.js');
    const { startHttpsServer } = await import('./https-server.js');
    const { db } = await import('./db/db.js');
    const ms = await import('./engine/member-signature.js');
    const { forgetOwnAddresses } = await import('./engine/own-addresses.js');
    const { resetGatewayRateLimit } = await import('./gateway-rate-limit.js');
    const { resetAdminAuthTarpit } = await import('./admin-auth.js');

    initAdminPassword();
    await initTls();
    se.initStateEngine();
    const port = await startHttpsServer(0);

    const offer = (pk: string, title: string) => {
        const post = se.createPost('offer', 'produce', title, `${title}, fresh`, 10, 'fixed', pk);
        if (!post) throw new Error(`could not list ${title}`);
        return post;
    };
    const commands: Record<string, (a: any) => unknown> = {
        seed: (a: { owner: { pk: string; callsign: string }; members: { pk: string; callsign: string }[]; trader: string; partner: string }) => {
            se.seedGenesisMember(a.owner.pk, a.owner.callsign);
            db.prepare("INSERT OR IGNORE INTO node_roles (member_pubkey, role, granted_by) VALUES (?, 'owner', 'genesis')").run(a.owner.pk);
            db.prepare('UPDATE members SET avatar_url = ? WHERE public_key = ?').run(AVATAR, a.owner.pk);
            for (const m of a.members) {
                db.prepare(`INSERT INTO members (public_key, callsign, joined_at, avatar_url, status, updated_at)
                            VALUES (?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'), ?, 'active', strftime('%Y-%m-%dT%H:%M:%fZ','now'))`)
                    .run(m.pk, m.callsign, AVATAR);
                db.prepare('INSERT OR IGNORE INTO accounts (public_key, balance, last_demurrage_epoch) VALUES (?, 0, 0)').run(m.pk);
                se.transfer('genesis', m.pk, 100, `seed ${m.callsign}`, 'direct', true);
            }
            // A completed trade, so the trader may send Beans directly (the send gate).
            offer(a.trader, 'Trader seedlings');
            const t = se.acceptPost(offer(a.partner, 'Partner bread').id, a.trader);
            se.completePostTransaction(t.id, a.trader);
            return true;
        },
        balance: (a: { pk: string }) => (db.prepare('SELECT balance FROM accounts WHERE public_key = ?').get(a.pk) as { balance: number } | undefined)?.balance ?? null,
        transfers: (a: { memo: string }) => (db.prepare('SELECT COUNT(*) AS n FROM transactions WHERE memo = ?').get(a.memo) as { n: number }).n,
        nonceSpent: (a: { nonce: string }) => ms.requestNonces.isSpent(a.nonce),
        switchCutoff: () => ms.unboundSignaturesCutoff(),
        switchClock: (a: { at: number | null }) => {
            ms.setSignatureSwitchClockForTests(a.at === null ? null : () => a.at as number);
            return true;
        },
        resetLimits: () => {
            resetGatewayRateLimit();
            resetAdminAuthTarpit();
            return true;
        },
        // A name from node_config: an owner-confirmed address (3), or the registrar's (1 and 4), as each is stored.
        nodeConfig: (a: Record<string, unknown>) => {
            se.updateNodeConfig(a as any);
            forgetOwnAddresses();
            return true;
        },
    };

    const rl = readline.createInterface({ input: process.stdin });
    rl.on('line', async (line) => {
        let id = 0;
        try {
            const msg = JSON.parse(line);
            id = msg.id;
            const fn = commands[msg.cmd];
            if (!fn) throw new Error(`no such command ${msg.cmd}`);
            reply({ reply: id, result: await fn(msg.args || {}) });
        } catch (e: any) {
            reply({ reply: id, error: e?.message || String(e) });
        }
    });
    rl.on('close', () => process.exit(0));
    reply({ ready: true, port });
}

// ── The orchestrator ───────────────────────────────────────────────────────────────────────

interface Node {
    name: string;
    port: number;
    proc: ChildProcess;
    output: () => string;
    send: (cmd: string, args?: Record<string, unknown>) => Promise<any>;
}

const started: Node[] = [];
let seq = 0;

/** A node in its own process group (detached), so teardown kills exactly the group this test started. */
function startNode(name: string, env: Record<string, string | undefined>): Promise<Node> {
    const dataDir = path.join(process.env.BEANPOOL_DATA_DIR!, name);
    fs.mkdirSync(dataDir, { recursive: true });
    const childEnv: NodeJS.ProcessEnv = { ...process.env, BEANPOOL_DATA_DIR: dataDir, ADMIN_PASSWORD: PW };
    // ACCEPT_UNBOUND_SIGNATURES_UNTIL is kept: a date set for the run is every node's switch.
    for (const k of ['CF_RECORD_NAME', 'BEANPOOL_ADDRESSES', 'ENFORCE_WS_AUTH', 'ENFORCE_READ_AUTH', 'NODE_PROFILE', 'NODE_ROLE']) delete childEnv[k];
    Object.assign(childEnv, env);
    const proc = spawn(process.execPath, [...process.execArgv, SCRIPT, '--child'], { env: childEnv, stdio: ['pipe', 'pipe', 'pipe'], detached: true });
    let out = '';
    const waiting = new Map<number, (m: any) => void>();
    const rl = readline.createInterface({ input: proc.stdout! });
    return new Promise((resolve, reject) => {
        rl.on('line', (line) => {
            out += line + '\n';
            if (!line.startsWith('@@ ')) return;
            const msg = JSON.parse(line.slice(3));
            if (msg.ready) {
                const node: Node = {
                    name, port: msg.port, proc, output: () => out,
                    send: (cmd, args = {}) => new Promise((res, rej) => {
                        const id = ++seq;
                        waiting.set(id, (m) => {
                            waiting.delete(id);
                            if (m.error) rej(new Error(`${name} ${cmd}: ${m.error}`)); else res(m.result);
                        });
                        proc.stdin!.write(JSON.stringify({ id, cmd, args }) + '\n');
                    }),
                };
                started.push(node);
                resolve(node);
            } else if (typeof msg.reply === 'number') {
                waiting.get(msg.reply)?.(msg);
            }
        });
        proc.stderr!.on('data', (d) => { out += d.toString(); });
        proc.on('exit', (code) => reject(Object.assign(new Error(`${name} exited (${code}) before it was ready\n${out.slice(-3000)}`))));
    });
}

function stopAll(): void {
    for (const n of started) {
        try { if (n.proc.pid && n.proc.exitCode === null) process.kill(-n.proc.pid, 'SIGKILL'); } catch { /* already gone */ }
    }
}

let run = 0, passed = 0;
function assert(cond: unknown, msg: string): void {
    run++;
    if (cond) { passed++; console.log(`✓ ${msg}`); } else { console.error(`✗ ${msg}`); process.exitCode = 1; }
}

/** One numbered section: an error in it fails it and the next one still runs. */
async function section(n: string, body: () => Promise<void>): Promise<void> {
    try {
        await body();
    } catch (e: any) {
        assert(false, `section ${n} ran to the end (${e?.message || e})`);
    }
}

interface Reply { status: number; body: any; text: string }

/** A request to a node over HTTPS at localhost. */
function call(node: Node, method: string, reqPath: string, headers: Record<string, string> = {}, body?: string): Promise<Reply> {
    return new Promise((resolve) => {
        const req = https.request({
            host: 'localhost', port: node.port, path: reqPath, method, rejectUnauthorized: false,
            headers: { ...(body !== undefined ? { 'Content-Type': 'application/json', 'Content-Length': String(Buffer.byteLength(body)) } : {}), ...headers },
        }, (res) => {
            let text = '';
            res.on('data', (c) => { text += c; });
            res.on('end', () => {
                let parsed: any = null;
                try { parsed = JSON.parse(text); } catch { parsed = text; }
                resolve({ status: res.statusCode || 0, body: parsed, text });
            });
        });
        req.on('error', (e) => resolve({ status: 0, body: { networkError: e.message }, text: '' }));
        if (body !== undefined) req.write(body);
        req.end();
    });
}
const show = (r: Reply) => `${r.status} ${r.text.slice(0, 160)}`;

async function main(): Promise<void> {
    if (process.argv.includes('--child')) return child();
    if (!process.env.BEANPOOL_DATA_DIR) throw new Error('Set BEANPOOL_DATA_DIR to a throwaway directory');
    const core = await import('@beanpool/core');
    const { ed25519 } = await import('@noble/curves/ed25519.js');
    const WebSocket = (await import('ws')).default;

    type Id = { pk: string; seed: Uint8Array; sign: ReturnType<typeof core.ed25519Signer>; callsign: string };
    const id = (callsign: string): Id => {
        const seed = new Uint8Array(crypto.randomBytes(32));
        return { pk: Buffer.from(ed25519.getPublicKey(seed)).toString('hex'), seed, sign: core.ed25519Signer(seed), callsign };
    };
    const owner = id('Olive'), mia = id('Mia'), xan = id('Xan');

    /** A format-2 request as a current app makes it: signed for `forUrl`'s host, sent to the node at localhost. */
    async function bound(who: Id, method: string, forUrl: string, body?: unknown, opts: { timestamp?: number; nonce?: string } = {}) {
        const bodyString = body === undefined ? '' : JSON.stringify(body);
        const headers = await core.buildBoundRequestHeaders({ method, url: forUrl, body: bodyString, publicKeyHex: who.pk, sign: who.sign, ...opts });
        return { headers, body: body === undefined ? undefined : bodyString, path: core.signedPathOf(forUrl), nonce: headers['X-Nonce'], timestamp: Number(headers['X-Timestamp']) };
    }
    /** An old-format request, as every app before binding makes it. */
    function unbound(who: Id, method: string, reqPath: string, body?: unknown) {
        const bodyString = body === undefined ? '' : JSON.stringify(body);
        const timestamp = String(Date.now());
        const nonce = crypto.randomBytes(16).toString('hex');
        const text = core.unboundRequestText({ method, path: reqPath, timestamp, nonce, body: bodyString });
        const sig = Buffer.from(ed25519.sign(core.utf8Bytes(text), who.seed)).toString('base64');
        return { headers: { 'X-Public-Key': who.pk, 'X-Signature': sig, 'X-Timestamp': timestamp, 'X-Nonce': nonce }, body: body === undefined ? undefined : bodyString, path: reqPath };
    }
    const sendTo = (node: Node, method: string, r: { headers: Record<string, string>; body?: string; path: string }) =>
        call(node, method, r.path, r.headers, r.body);
    type Sock = { kind: 'open'; ws: any } | { kind: 'status'; status: number } | { kind: 'error'; error: string };
    const socket = (node: Node, query: string): Promise<Sock> => new Promise((resolve) => {
        const ws = new WebSocket(`wss://localhost:${node.port}/ws?${query}`, { rejectUnauthorized: false });
        let done = false;
        const settle = (s: Sock) => { if (!done) { done = true; resolve(s); } };
        ws.on('open', () => { settle({ kind: 'open', ws }); ws.terminate(); });
        ws.on('unexpected-response', (_q: any, res: any) => { settle({ kind: 'status', status: res.statusCode }); res.resume(); ws.terminate(); });
        ws.on('error', (e: any) => settle({ kind: 'error', error: e.message }));
        setTimeout(() => settle({ kind: 'error', error: 'timeout' }), 4000);
    });
    const sockShow = (s: Sock) => s.kind === 'open' ? '101' : s.kind === 'status' ? String(s.status) : s.error;
    const oldWsQuery = (who: Id) => {
        const ts = String(Date.now());
        const nonce = crypto.randomBytes(16).toString('hex');
        const sig = Buffer.from(ed25519.sign(core.utf8Bytes(`WS\n/ws\n${ts}\n${nonce}\n`), who.seed)).toString('base64');
        return `pubkey=${who.pk}&ts=${ts}&nonce=${nonce}&sig=${encodeURIComponent(sig)}`;
    };
    const adminPw = { 'X-Admin-Password': PW };
    const challenge = async (node: Node) => (await call(node, 'POST', '/api/local/admin/auth/challenge', {}, '{}')).body;
    const verifySignin = (node: Node, body: Record<string, unknown>) =>
        call(node, 'POST', '/api/local/admin/auth/verify-challenge', {}, JSON.stringify(body));
    /** A node's switch clock just before the switch. */
    const beforeSwitch = (n: Node) => n.send('switchClock', { at: SWITCH - 1 });
    const wrongCommunity = (r: Reply) => r.status === 421 && r.body?.code === 'wrong_community';

    /** A read signed for `host` is refused at `node` with its nonce unspent, and the same request for `own` is accepted. */
    async function refusedThenOwn(node: Node, host: string, own: string): Promise<void> {
        await node.send('resetLimits');
        const req = await bound(mia, 'GET', `https://${host}/api/community/me`);
        const r = await sendTo(node, 'GET', req);
        assert(wrongCommunity(r) && r.body?.publicKey === undefined, `${node.name}: a read signed for ${host} → 421 wrong_community, nothing of the read in it (${show(r)})`);
        assert((await node.send('nonceSpent', { nonce: req.nonce })) === false, `${node.name}: its nonce is unspent`);
        const again = await sendTo(node, 'GET', await bound(mia, 'GET', `https://${own}/api/community/me`, undefined, { timestamp: req.timestamp, nonce: req.nonce }));
        assert(again.status === 200 && again.body?.publicKey === mia.pk, `${node.name}: re-signed for ${own} with that nonce and timestamp, accepted (${show(again)})`);
    }

    try {
        console.log('Loopback is this community\'s name only on a node that knows none of its names\n');
        const [N, E, O, R, U, L, Z, T] = await Promise.all([
            startNode('n', { CF_RECORD_NAME: 'named.test', ENFORCE_WS_AUTH: 'true' }),
            startNode('e', { BEANPOOL_ADDRESSES: 'env.test' }),
            startNode('o', {}),
            startNode('r', {}),
            startNode('u', { ENFORCE_WS_AUTH: 'true' }),
            startNode('l', { CF_RECORD_NAME: 'optin.test', BEANPOOL_ADDRESSES: 'localhost, 127.0.0.1, [::1], ::1' }),
            startNode('z', { BEANPOOL_ADDRESSES: 'localhost' }),
            startNode('t', { CF_RECORD_NAME: 'tunnel.test', BEANPOOL_ADDRESSES: 'localhost' }),
        ]);
        for (const n of [N, E, O, R, U, L, Z, T]) {
            await n.send('seed', { owner: { pk: owner.pk, callsign: owner.callsign }, members: [mia, xan].map((m) => ({ pk: m.pk, callsign: m.callsign })), trader: mia.pk, partner: xan.pk });
        }
        await O.send('nodeConfig', { ownerAddresses: ['owner.test'] });
        await R.send('nodeConfig', { publicAddress: { name: 'reg.test', mode: 'direct', status: 'live' } });
        const cutoff = await N.send('switchCutoff');
        if (typeof cutoff !== 'number') throw new Error('N refuses the old format already (ACCEPT_UNBOUND_SIGNATURES_UNTIL=never?): this suite needs a switch date');
        SWITCH = cutoff;
        console.log(`the switch: ${new Date(SWITCH).toISOString()}; the nodes' clocks are pinned just before it`);
        for (const n of [N, E, O, R, U, L, Z, T]) await beforeSwitch(n);

        // ── 1. A node named by CF_RECORD_NAME ──
        console.log('\n— 1. a node with a name: a request, a socket and a Manage sign-in signed for loopback —');
        await section('1', async () => {
            for (const host of LOOPBACK) {
                await N.send('resetLimits');
                const memo = `loopback send ${host} ${crypto.randomBytes(3).toString('hex')}`;
                const send = { from: mia.pk, to: xan.pk, amount: 2, memo };
                const [miaBefore, xanBefore] = [await N.send('balance', { pk: mia.pk }), await N.send('balance', { pk: xan.pk })];
                const req = await bound(mia, 'POST', `https://${host}/api/ledger/transfer`, send);
                const r = await sendTo(N, 'POST', req);
                assert(wrongCommunity(r), `a Beans send signed for ${host} → 421 wrong_community (${show(r)})`);
                assert((await N.send('balance', { pk: mia.pk })) === miaBefore && (await N.send('balance', { pk: xan.pk })) === xanBefore
                    && (await N.send('transfers', { memo })) === 0, 'no Beans moved and no transfer was written');
                assert((await N.send('nonceSpent', { nonce: req.nonce })) === false, 'its nonce is unspent');
                const own = await sendTo(N, 'POST', await bound(mia, 'POST', 'https://named.test/api/ledger/transfer', send, { timestamp: req.timestamp, nonce: req.nonce }));
                assert(own.status === 200 && (await N.send('balance', { pk: xan.pk })) === xanBefore + 2 && (await N.send('transfers', { memo })) === 1,
                    `the same send re-signed for named.test, with that nonce and timestamp, is accepted once (${show(own)})`);
            }
            for (const host of LOOPBACK) {
                const params = new URLSearchParams(await core.buildBoundWsParams({ wsUrl: `wss://${host}/ws`, publicKeyHex: mia.pk, sign: mia.sign }));
                const s = await socket(N, params.toString());
                assert(s.kind === 'status' && s.status === 401, `a /ws token signed for ${host} → 401 (ENFORCE_WS_AUTH=true) (${sockShow(s)})`);
                assert((await N.send('nonceSpent', { nonce: params.get('nonce') })) === false, 'its nonce is unspent');
                const own = await socket(N, await core.buildBoundWsParams({
                    wsUrl: 'wss://named.test/ws', publicKeyHex: mia.pk, sign: mia.sign, timestamp: Number(params.get('ts')), nonce: params.get('nonce') as string,
                }));
                assert(own.kind === 'open', `re-signed for named.test with that nonce and timestamp, it opens (${sockShow(own)})`);
            }
            const ch = await challenge(N);
            assert(/^[0-9a-f]{64}$/.test(ch?.challengeId), 'N hands out a Manage sign-in challenge');
            for (const host of LOOPBACK) {
                await N.send('resetLimits');
                const r = await verifySignin(N, { challengeId: ch.challengeId, memberPubkey: owner.pk, signature: await core.signAdminSignin(`https://${host}`, ch.challengeId, owner.sign), signedFor: host });
                assert(wrongCommunity(r) && !r.body?.handshakeToken, `the Manage sign-in signed for ${host} → 421 wrong_community, no session (${show(r)})`);
            }
            await N.send('resetLimits');
            const own = await verifySignin(N, { challengeId: ch.challengeId, memberPubkey: owner.pk, signature: await core.signAdminSignin('https://named.test', ch.challengeId, owner.sign), signedFor: 'named.test' });
            assert(own.status === 200 && /^[0-9a-f]{64}$/.test(own.body?.handshakeToken) && own.body?.role === 'owner',
                `the same challenge, still open, signed for named.test opens a session (${show(own)})`);
            const info = await call(N, 'GET', '/api/community/info');
            assert(JSON.stringify(info.body?.addresses) === JSON.stringify(['named.test']), `/api/community/info lists named.test and no loopback name (${JSON.stringify(info.body?.addresses)})`);
        });

        // ── 2. The old format is untouched ──
        console.log('\n— 2. the old format, bound to no community, is untouched before the switch —');
        await section('2', async () => {
            await N.send('resetLimits');
            const before = await N.send('balance', { pk: xan.pk });
            const r = await sendTo(N, 'POST', unbound(mia, 'POST', '/api/ledger/transfer', { from: mia.pk, to: xan.pk, amount: 1, memo: 'old app send' }));
            assert(r.status === 200 && (await N.send('balance', { pk: xan.pk })) === before + 1, `an old-format Beans send is accepted at N (${show(r)})`);
            const s = await socket(N, oldWsQuery(mia));
            assert(s.kind === 'open', `an old-format /ws token opens a member socket at N (ENFORCE_WS_AUTH=true) (${sockShow(s)})`);
            const ch = await challenge(N);
            const old = await verifySignin(N, { challengeId: ch.challengeId, memberPubkey: owner.pk, signature: Buffer.from(ed25519.sign(core.utf8Bytes(ch.challenge), owner.seed)).toString('base64') });
            assert(old.status === 200 && old.body?.handshakeToken, `the old Manage sign-in form opens a session (${show(old)})`);
        });

        // ── 3. Each other source of a name ──
        console.log('\n— 3. a node named only by BEANPOOL_ADDRESSES, an owner-confirmed address, or a registrar name —');
        await section('3', async () => {
            for (const [node, own] of [[E, 'env.test'], [O, 'owner.test'], [R, 'reg.test']] as const) {
                for (const host of LOOPBACK) await refusedThenOwn(node, host, own);
                const info = await call(node, 'GET', '/api/community/info');
                assert(JSON.stringify(info.body?.addresses) === JSON.stringify([own]), `${node.name}: /api/community/info lists ${own} only (${JSON.stringify(info.body?.addresses)})`);
            }
        });

        // ── 4. A node that knows none of its names ──
        console.log('\n— 4. a node with no name (a developer\'s): loopback still works —');
        await section('4', async () => {
            await U.send('resetLimits');
            for (const host of [...LOOPBACK, '127.0.0.2']) {
                const r = await sendTo(U, 'GET', await bound(mia, 'GET', `https://${host}:8443/api/community/me`));
                assert(r.status === 200 && r.body?.publicKey === mia.pk, `a read signed for ${host} is accepted (${show(r)})`);
            }
            const offered = await sendTo(U, 'GET', await bound(mia, 'GET', 'https://community.example.org/api/community/me'));
            assert(offered.status === 200, `(and one for community.example.org, before the switch) (${show(offered)})`);
            const s = await socket(U, await core.buildBoundWsParams({ wsUrl: 'wss://127.0.0.1:8443/ws', publicKeyHex: mia.pk, sign: mia.sign }));
            assert(s.kind === 'open', `a /ws token signed for 127.0.0.1 opens a member socket (ENFORCE_WS_AUTH=true) (${sockShow(s)})`);
            const ch = await challenge(U);
            const signin = await verifySignin(U, { challengeId: ch.challengeId, memberPubkey: owner.pk, signature: await core.signAdminSignin('https://127.0.0.1:8443', ch.challengeId, owner.sign), signedFor: '127.0.0.1' });
            assert(signin.status === 200 && signin.body?.handshakeToken, `a Manage sign-in signed for 127.0.0.1 opens a session (${show(signin)})`);

            await U.send('switchClock', { at: SWITCH + 1000 });
            const late = await sendTo(U, 'GET', await bound(mia, 'GET', 'https://community.example.org/api/community/me'));
            assert(late.status === 421, `after the switch, community.example.org (not confirmed) is refused (${show(late)})`);
            for (const host of LOOPBACK) {
                const r = await sendTo(U, 'GET', await bound(mia, 'GET', `https://${host}/api/community/me`));
                assert(r.status === 200, `while a read signed for ${host} is still accepted (${show(r)})`);
            }
            await beforeSwitch(U);

            const info = await call(U, 'GET', '/api/community/info');
            assert(Array.isArray(info.body?.addresses) && info.body.addresses.length === 0, `/api/community/info lists no address (${JSON.stringify(info.body?.addresses)})`);
            // Settings offers with one tap only the host it is open at itself (engine/address-offers.ts): asked as
            // Settings open at community.example.org asks (?host=).
            const ownersApp = await sendTo(U, 'GET', await bound(owner, 'GET', 'https://community.example.org/api/community/me'));
            assert(ownersApp.status === 200, `the owner's app reaches U at community.example.org too (${show(ownersApp)})`);
            const listed = await call(U, 'GET', '/api/local/admin/app-addresses?host=community.example.org', adminPw);
            const unconfirmed: string[] = (listed.body?.unconfirmed ?? []).map((a: any) => a.address);
            assert(listed.status === 200 && listed.body?.addresses?.length === 0 && unconfirmed.includes('community.example.org')
                && !unconfirmed.some((a) => a === '127.0.0.2' || LOOPBACK.includes(a)),
                `Settings offers community.example.org to confirm, and no loopback name (${JSON.stringify(unconfirmed)})`);
            const heldBack: string[] = (listed.body?.heldBack ?? []).map((a: any) => a.address);
            assert(!heldBack.some((a) => a === '127.0.0.2' || LOOPBACK.includes(a)), `nor lists one as held back (${JSON.stringify(heldBack)})`);
        });

        // ── 5. The explicit way in ──
        console.log('\n— 5. BEANPOOL_ADDRESSES=localhost, 127.0.0.1, [::1] on a named node —');
        await section('5', async () => {
            await L.send('resetLimits');
            for (const host of [...LOOPBACK, 'optin.test']) {
                const r = await sendTo(L, 'GET', await bound(mia, 'GET', `https://${host}:8443/api/community/me`));
                assert(r.status === 200 && r.body?.publicKey === mia.pk, `a read signed for ${host} is accepted (${show(r)})`);
            }
            await refusedThenOwn(L, '127.0.0.2', 'localhost');
            const info = await call(L, 'GET', '/api/community/info');
            assert(JSON.stringify(info.body?.addresses) === JSON.stringify(['optin.test']), `/api/community/info lists optin.test only, no loopback name (${JSON.stringify(info.body?.addresses)})`);
            const listed = await call(L, 'GET', '/api/local/admin/app-addresses', adminPw);
            const bySource = (listed.body?.addresses ?? []).map((a: any) => `${a.address}:${a.source}`);
            assert(listed.status === 200 && JSON.stringify(bySource) === JSON.stringify(['optin.test:public-address', 'localhost:env', '127.0.0.1:env', '[::1]:env']),
                `Settings lists each, the loopback names as set on the server (${JSON.stringify(bySource)})`);
            const dropped = L.output().split('\n').filter((line) => line.includes('BEANPOOL_ADDRESSES'));
            assert(dropped.length === 1 && dropped[0].includes('"::1" is not an address') && dropped[0].includes('[::1]'),
                `the log names the bare ::1 as left out, once, and gives its bracketed form (${JSON.stringify(dropped.map((l) => l.slice(0, 300)))})`);
        });

        // ── 6. Only localhost listed, and no other name ──
        console.log('\n— 6. BEANPOOL_ADDRESSES=localhost on a node with no other name: it still knows none of its names —');
        await section('6', async () => {
            await Z.send('resetLimits');
            for (const host of ['community.example.org', '192.168.1.20', 'localhost', '127.0.0.1']) {
                const r = await sendTo(Z, 'GET', await bound(mia, 'GET', `https://${host}/api/community/me`));
                assert(r.status === 200 && r.body?.publicKey === mia.pk, `before the switch, a read signed for ${host} is accepted (${show(r)})`);
            }
            // Settings offers with one tap only the host it is open at itself (engine/address-offers.ts): asked as
            // Settings open at community.example.org asks (?host=).
            const ownersApp = await sendTo(Z, 'GET', await bound(owner, 'GET', 'https://community.example.org/api/community/me'));
            assert(ownersApp.status === 200, `the owner's app reaches Z at community.example.org too (${show(ownersApp)})`);
            const listed = await call(Z, 'GET', '/api/local/admin/app-addresses?host=community.example.org', adminPw);
            const bySource = (listed.body?.addresses ?? []).map((a: any) => `${a.address}:${a.source}`);
            const unconfirmed: string[] = (listed.body?.unconfirmed ?? []).map((a: any) => a.address);
            assert(listed.status === 200 && listed.body?.named === false, `Settings says the community has no name set up (named: ${JSON.stringify(listed.body?.named)})`);
            assert(JSON.stringify(bySource) === JSON.stringify(['localhost:env']), `Settings lists localhost as set on the server (${JSON.stringify(bySource)})`);
            assert(JSON.stringify(unconfirmed) === JSON.stringify(['community.example.org']),
                `Settings offers community.example.org to confirm, and neither the home-network address nor a loopback name (${JSON.stringify(unconfirmed)})`);
            assert(Array.isArray(listed.body?.heldBack) && listed.body.heldBack.length === 0,
                `and holds none back: the home-network and loopback names are this node's own, never on either list (${JSON.stringify(listed.body?.heldBack)})`);
            const info = await call(Z, 'GET', '/api/community/info');
            assert(Array.isArray(info.body?.addresses) && info.body.addresses.length === 0, `/api/community/info lists no address (${JSON.stringify(info.body?.addresses)})`);

            await Z.send('switchClock', { at: SWITCH + 1000 });
            const late = await sendTo(Z, 'GET', await bound(mia, 'GET', 'https://community.example.org/api/community/me'));
            assert(wrongCommunity(late), `after the switch, community.example.org (not confirmed) is refused (${show(late)})`);
            for (const host of ['localhost', '127.0.0.1', '192.168.1.20']) {
                const r = await sendTo(Z, 'GET', await bound(mia, 'GET', `https://${host}/api/community/me`));
                assert(r.status === 200, `while a read signed for ${host} is still accepted (${show(r)})`);
            }
            await beforeSwitch(Z);
        });

        // ── 7. A name, and localhost listed ──
        console.log('\n— 7. BEANPOOL_ADDRESSES=localhost on a named node: localhost and its name, nothing else —');
        await section('7', async () => {
            await T.send('resetLimits');
            for (const host of ['localhost', 'tunnel.test']) {
                const r = await sendTo(T, 'GET', await bound(mia, 'GET', `https://${host}/api/community/me`));
                assert(r.status === 200 && r.body?.publicKey === mia.pk, `a read signed for ${host} is accepted (${show(r)})`);
            }
            for (const host of ['community.example.org', '192.168.1.20', '127.0.0.1']) await refusedThenOwn(T, host, 'tunnel.test');
            const listed = await call(T, 'GET', '/api/local/admin/app-addresses', adminPw);
            const bySource = (listed.body?.addresses ?? []).map((a: any) => `${a.address}:${a.source}`);
            assert(listed.status === 200 && listed.body?.named === true && listed.body?.unconfirmed?.length === 0
                && JSON.stringify(bySource) === JSON.stringify(['tunnel.test:public-address', 'localhost:env']),
                `Settings says it has a name, lists tunnel.test and localhost, and offers nothing (named: ${JSON.stringify(listed.body?.named)}, ${JSON.stringify(bySource)}, unconfirmed ${JSON.stringify(listed.body?.unconfirmed)})`);
            const info = await call(T, 'GET', '/api/community/info');
            assert(JSON.stringify(info.body?.addresses) === JSON.stringify(['tunnel.test']), `/api/community/info lists tunnel.test only (${JSON.stringify(info.body?.addresses)})`);
        });
    } catch (e: any) {
        assert(false, `the suite ran to the end (${e?.stack || e})`);
        for (const n of started) console.error(`--- ${n.name} output (tail) ---\n${n.output().slice(-2500)}`);
    } finally {
        stopAll();
    }
    console.log(`\n${passed}/${run} passed`);
    process.exit(passed === run && run > 0 ? 0 : 1);
}

main().catch((e) => {
    console.error(e);
    stopAll();
    process.exit(1);
});
