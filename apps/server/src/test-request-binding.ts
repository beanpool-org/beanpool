/**
 * A member's signature counts only at the community it was signed for (request binding; design
 * scratch/global-node/DESIGN-replay-binding-opus.md §4, accepted 2026-09-27).
 *
 * Before this, a request a member sent to community A was, for five minutes, just as good at every other community B
 * where the same key is a member: A's operator sees every request in plain text and could replay it at B ("delete my
 * account", "send 20 Beans", a private read, the live feed). The format-2 request names the host the app connected to
 * (@beanpool/core request-signing.ts) and each server accepts only its own names (engine/own-addresses.ts,
 * engine/member-signature.ts).
 *
 * Every node here is a REAL server, its own process in its own process group, over real HTTPS through the real
 * signature middleware: A (`a.test`) and B (`b.test`, and `b2.test` from BEANPOOL_ADDRESSES), the same member keys
 * members of both; C (`c.test`) with ENFORCE_WS_AUTH=true and ACCEPT_UNBOUND_SIGNATURES_UNTIL=never; G on the global
 * profile (`global.test`); U, a self-hoster's node with no address configured. The apps are played by the core
 * builders PR 2 (native) and PR 3 (PWA) use. The requests reach each server at localhost: the host a request is signed
 * for is the one a phone would have connected to.
 *
 *  1. Old apps keep working until the switch: an old-format send, read and socket, and they are counted.
 *  2. Replay refused: a Beans transfer signed for A and sent to B → 421 wrong_community, B's balances unchanged, the
 *     nonce unspent at B (the same request re-signed for b.test, same nonce and timestamp, succeeds there, once).
 *  3. A gated read signed for A → 421 at B, with nothing of the read in the answer.
 *  4. /ws: a token signed for A gets no member feed at B (doorbells only by default; 401 at C, strict).
 *  5. Two names: B accepts b.test and b2.test and refuses c.test; a spoofed Host or X-Forwarded-Host changes nothing;
 *     /api/community/info says requestSigning 2 and lists both names.
 *  6. The directory: on the global node, a signed /api/global/home read for global.test shows the member's watches;
 *     signed for b.test → 421.
 *  7. The switch: before the date the old format is accepted; after it (the clock injected) 426 app_too_old and an
 *     old-format socket is treated as unsigned; env ACCEPT_UNBOUND_SIGNATURES_UNTIL=never refuses it now.
 *  8. The Manage button: a hostile node's "challenge" that is a request's text, signed as an old app signs it, is
 *     refused as a request after the switch and never accepted as a format-2 sign-in; the format-2 sign-in for this
 *     host opens a session, for another host 421; the old sign-in form works until the switch and 426 after.
 *  9. Pairing and offline tickets made for A are refused at B; the old forms until the switch only.
 * 10. The self-hoster: any host accepted (and offered in Settings) until an owner confirms one; then only that one;
 *     after the switch, an unconfirmed host is refused.
 * 11. Settings: the address list with its sources and counts, and the old-app count. No key is stored.
 * 12. "Delete my account" signed for A, replayed at B → 421, B's row unchanged; re-signed for b.test it works there.
 *
 *   BEANPOOL_DATA_DIR=$(mktemp -d) pnpm exec tsx apps/server/src/test-request-binding.ts
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import https from 'node:https';
import path from 'node:path';
import readline from 'node:readline';
import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SCRIPT = fileURLToPath(import.meta.url);
const PW = 'Request-Binding-Pw-4471!';
const AVATAR = 'data:image/png;base64,iVBORw0KGgo=';
const SWITCH = Date.parse('2026-12-15T00:00:00Z');

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
    // Loaded when a command needs it, so the servers boot on a tree without it (the fail-first run on origin/main).
    const ms = () => import('./engine/member-signature.js');
    const { createPairing } = await import('./settings-signin-pairing.js');
    const { setPlaceWatch } = await import('./engine/place-watches.js');
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
        seed: (a: { owner: { pk: string; callsign: string }; members: { pk: string; callsign: string }[]; beans: boolean; trader?: string; partner?: string }) => {
            se.seedGenesisMember(a.owner.pk, a.owner.callsign);
            db.prepare("INSERT OR IGNORE INTO node_roles (member_pubkey, role, granted_by) VALUES (?, 'owner', 'genesis')").run(a.owner.pk);
            db.prepare('UPDATE members SET avatar_url = ? WHERE public_key = ?').run(AVATAR, a.owner.pk);
            for (const m of a.members) {
                db.prepare(`INSERT INTO members (public_key, callsign, joined_at, avatar_url, status, updated_at)
                            VALUES (?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'), ?, 'active', strftime('%Y-%m-%dT%H:%M:%fZ','now'))`)
                    .run(m.pk, m.callsign, AVATAR);
                db.prepare('INSERT OR IGNORE INTO accounts (public_key, balance, last_demurrage_epoch) VALUES (?, 0, 0)').run(m.pk);
                if (a.beans) se.transfer('genesis', m.pk, 100, `seed ${m.callsign}`, 'direct', true);
            }
            // A completed trade, so the trader may send Beans directly (the send gate).
            if (a.trader && a.partner) {
                offer(a.trader, 'Trader seedlings');
                const t = se.acceptPost(offer(a.partner, 'Partner bread').id, a.trader);
                se.completePostTransaction(t.id, a.trader);
            }
            return true;
        },
        balance: (a: { pk: string }) => (db.prepare('SELECT balance FROM accounts WHERE public_key = ?').get(a.pk) as { balance: number } | undefined)?.balance ?? null,
        member: (a: { pk: string }) => (db.prepare('SELECT status FROM members WHERE public_key = ?').get(a.pk) as { status: string } | undefined)?.status ?? null,
        transfers: (a: { memo: string }) => (db.prepare('SELECT COUNT(*) AS n FROM transactions WHERE memo = ?').get(a.memo) as { n: number }).n,
        nonceSpent: async (a: { nonce: string }) => (await ms()).requestNonces.isSpent(a.nonce),
        switchClock: async (a: { at: number | null }) => {
            (await ms()).setSignatureSwitchClockForTests(a.at === null ? null : () => a.at as number);
            return true;
        },
        announce: (a: { title: string }) => {
            se.adminBroadcastAnnouncement(a.title, 'at the hall', 'info');
            return true;
        },
        watch: (a: { pk: string }) => setPlaceWatch(a.pk, { lat: -28.55, lng: 153.5 }, 25).created,
        pairing: () => {
            const p = createPairing({ clientKey: `test-${crypto.randomBytes(4).toString('hex')}` });
            if (!p.ok) throw new Error(p.error);
            return { pairingId: p.pairingId, shortCode: p.shortCode };
        },
        resetLimits: () => {
            resetGatewayRateLimit();
            resetAdminAuthTarpit();
            return true;
        },
        // What the database holds that could be a key: the counts table has none.
        countsTable: () => db.prepare('SELECT day, kind, address, people FROM signature_audiences ORDER BY kind, address').all(),
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
    for (const k of ['CF_RECORD_NAME', 'BEANPOOL_ADDRESSES', 'ACCEPT_UNBOUND_SIGNATURES_UNTIL', 'ENFORCE_WS_AUTH', 'ENFORCE_READ_AUTH', 'NODE_PROFILE', 'NODE_ROLE']) delete childEnv[k];
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
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** One numbered section: an error in it fails it and the next one still runs. */
async function section(n: string, body: () => Promise<void>): Promise<void> {
    try {
        await body();
    } catch (e: any) {
        assert(false, `section ${n} ran to the end (${e?.message || e})`);
    }
}

interface Reply { status: number; body: any; text: string }

/** A request to a node over HTTPS at localhost, with whatever headers (a spoofed Host included). */
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

    /** A format-2 request as a current app makes it: signed for `forUrl`'s host, sent anywhere. */
    async function bound(who: Id, method: string, forUrl: string, body?: unknown, opts: { timestamp?: number; nonce?: string } = {}) {
        const bodyString = body === undefined ? '' : JSON.stringify(body);
        const headers = await core.buildBoundRequestHeaders({ method, url: forUrl, body: bodyString, publicKeyHex: who.pk, sign: who.sign, ...opts });
        return { headers, body: body === undefined ? undefined : bodyString, path: core.signedPathOf(forUrl), nonce: headers['X-Nonce'] };
    }
    /** An old-format request, as every app before binding makes it. */
    function unbound(who: Id, method: string, reqPath: string, body?: unknown) {
        const bodyString = body === undefined ? '' : JSON.stringify(body);
        const timestamp = String(Date.now());
        const nonce = crypto.randomBytes(16).toString('hex');
        const text = core.unboundRequestText({ method, path: reqPath.split('?')[0], timestamp, nonce, body: bodyString });
        const sig = Buffer.from(ed25519.sign(core.utf8Bytes(text), who.seed)).toString('base64');
        return { headers: { 'X-Public-Key': who.pk, 'X-Signature': sig, 'X-Timestamp': timestamp, 'X-Nonce': nonce }, body: body === undefined ? undefined : bodyString, path: reqPath };
    }
    const sendTo = (node: Node, method: string, r: { headers: Record<string, string>; body?: string; path: string }, extra: Record<string, string> = {}) =>
        call(node, method, r.path, { ...r.headers, ...extra }, r.body);
    const oldWsQuery = (who: Id) => {
        const ts = String(Date.now());
        const nonce = crypto.randomBytes(16).toString('hex');
        const sig = Buffer.from(ed25519.sign(core.utf8Bytes(`WS\n/ws\n${ts}\n${nonce}\n`), who.seed)).toString('base64');
        return `pubkey=${who.pk}&ts=${ts}&nonce=${nonce}&sig=${encodeURIComponent(sig)}`;
    };
    type Sock = { kind: 'open'; ws: any; events: any[] } | { kind: 'status'; status: number } | { kind: 'error'; error: string };
    const socket = (node: Node, query: string): Promise<Sock> => new Promise((resolve) => {
        const ws = new WebSocket(`wss://localhost:${node.port}/ws?${query}`, { rejectUnauthorized: false });
        const events: any[] = [];
        let done = false;
        const settle = (s: Sock) => { if (!done) { done = true; resolve(s); } };
        ws.on('message', (d: any) => { try { events.push(JSON.parse(d.toString())); } catch { /* */ } });
        ws.on('open', () => settle({ kind: 'open', ws, events }));
        ws.on('unexpected-response', (_q: any, res: any) => { settle({ kind: 'status', status: res.statusCode }); res.resume(); ws.terminate(); });
        ws.on('error', (e: any) => settle({ kind: 'error', error: e.message }));
        setTimeout(() => settle({ kind: 'error', error: 'timeout' }), 4000);
    });
    const sockShow = (s: Sock) => s.kind === 'open' ? '101' : s.kind === 'status' ? String(s.status) : s.error;
    const adminPw = { 'X-Admin-Password': PW };

    try {
        console.log('Request binding: a member\'s signature counts only at the community it was signed for\n');
        const [A, B, C, G, U] = await Promise.all([
            startNode('a', { CF_RECORD_NAME: 'a.test' }),
            startNode('b', { CF_RECORD_NAME: 'b.test', BEANPOOL_ADDRESSES: 'b2.test, https://B2.test:8443/ ' }),
            startNode('c', { CF_RECORD_NAME: 'c.test', ENFORCE_WS_AUTH: 'true', ACCEPT_UNBOUND_SIGNATURES_UNTIL: 'never' }),
            startNode('g', { CF_RECORD_NAME: 'global.test', NODE_PROFILE: 'global' }),
            startNode('u', {}),
        ]);
        for (const n of [A, B, C, U]) {
            await n.send('seed', { owner: { pk: owner.pk, callsign: owner.callsign }, members: [mia, xan].map((m) => ({ pk: m.pk, callsign: m.callsign })), beans: true, trader: mia.pk, partner: xan.pk });
        }
        await G.send('seed', { owner: { pk: owner.pk, callsign: owner.callsign }, members: [{ pk: mia.pk, callsign: mia.callsign }], beans: false });

        // ── 1. Old apps keep working until the switch ──
        console.log('\n— 1. an app from before binding keeps working until the switch —');
        await section('1', async () => {
            const before = await A.send('balance', { pk: xan.pk });
            const r = await sendTo(A, 'POST', unbound(mia, 'POST', '/api/ledger/transfer', { from: mia.pk, to: xan.pk, amount: 1, memo: 'old app send' }));
            assert(r.status === 200 && (await A.send('balance', { pk: xan.pk })) === before + 1, `an old-format Beans send is accepted at A (${show(r)})`);
            const read = await sendTo(B, 'GET', unbound(mia, 'GET', `/api/messages/conversations/${mia.pk}`));
            assert(read.status === 200, `an old-format gated read is accepted at B (${show(read)})`);
            const sock = await socket(B, oldWsQuery(mia));
            assert(sock.kind === 'open', `an old-format /ws token opens a socket at B (${sockShow(sock)})`);
            await B.send('announce', { title: 'OLD-APP-FEED' });
            await sleep(300);
            assert(sock.kind === 'open' && sock.events.some((e) => e.type === 'system_announcement' && e.title === 'OLD-APP-FEED'),
                'and it gets the member feed, as before');
            if (sock.kind === 'open') sock.ws.terminate();
        });

        // ── 2. Replay refused: a Beans transfer ──
        console.log('\n— 2. a Beans send signed for A, replayed at B —');
        await section('2', async () => {
            const memo = `bound send ${crypto.randomBytes(3).toString('hex')}`;
            const req = await bound(mia, 'POST', 'https://a.test/api/ledger/transfer', { from: mia.pk, to: xan.pk, amount: 3, memo });
            const aBefore = await A.send('balance', { pk: xan.pk });
            const atA = await sendTo(A, 'POST', req);
            assert(atA.status === 200 && (await A.send('balance', { pk: xan.pk })) === aBefore + 3, `signed for a.test, the send is accepted at A (${show(atA)})`);
            const [bMia, bXan] = [await B.send('balance', { pk: mia.pk }), await B.send('balance', { pk: xan.pk })];
            const atB = await sendTo(B, 'POST', req);
            assert(atB.status === 421 && atB.body?.code === 'wrong_community', `the identical bytes at B → 421 wrong_community (${show(atB)})`);
            assert((await B.send('balance', { pk: mia.pk })) === bMia && (await B.send('balance', { pk: xan.pk })) === bXan && (await B.send('transfers', { memo })) === 0,
                "B's balances are unchanged and no transfer was written there");
            assert((await B.send('nonceSpent', { nonce: req.nonce })) === false, 'the nonce is unspent at B');
            assert((await A.send('nonceSpent', { nonce: req.nonce })) === true, '(and spent at A, where it was accepted)');
            const again = await bound(mia, 'POST', 'https://b.test/api/ledger/transfer', { from: mia.pk, to: xan.pk, amount: 3, memo },
                { timestamp: Number(req.headers['X-Timestamp']), nonce: req.nonce });
            const reSigned = await sendTo(B, 'POST', again);
            assert(reSigned.status === 200 && (await B.send('balance', { pk: xan.pk })) === bXan + 3 && (await B.send('transfers', { memo })) === 1,
                `the same body re-signed for b.test, with the same nonce and timestamp, is accepted at B, once (${show(reSigned)})`);
            const replayAtB = await sendTo(B, 'POST', again);
            assert(replayAtB.status === 403 && (await B.send('transfers', { memo })) === 1, `and replayed there it is refused as a replay (${show(replayAtB)})`);
        });

        // ── 3. A gated read ──
        console.log('\n— 3. a private read signed for A, replayed at B —');
        await section('3', async () => {
            const req = await bound(mia, 'GET', `https://a.test/api/messages/conversations/${mia.pk}`);
            const atA = await sendTo(A, 'GET', { ...req, path: `/api/messages/conversations/${mia.pk}` });
            assert(atA.status === 200, `accepted at A (${show(atA)})`);
            const atB = await sendTo(B, 'GET', { ...req, path: `/api/messages/conversations/${mia.pk}` });
            assert(atB.status === 421 && atB.body?.code === 'wrong_community' && Object.keys(atB.body).sort().join(',') === 'code,error',
                `at B → 421, and the answer holds nothing of the read (${show(atB)})`);
        });

        // ── 4. /ws ──
        console.log('\n— 4. a /ws connect token signed for A, used at B —');
        await section('4', async () => {
            const forB = await socket(B, await core.buildBoundWsParams({ wsUrl: 'wss://b.test/ws', publicKeyHex: mia.pk, sign: mia.sign }));
            const forA = await socket(B, await core.buildBoundWsParams({ wsUrl: 'wss://a.test/ws', publicKeyHex: mia.pk, sign: mia.sign }));
            assert(forB.kind === 'open' && forA.kind === 'open', `at B (default mode) both open (${sockShow(forB)}, ${sockShow(forA)})`);
            await B.send('announce', { title: 'MEMBERS-ONLY-NEWS' });
            await sleep(300);
            const got = (s: Sock) => s.kind === 'open' && s.events.some((e) => e.type === 'system_announcement' && e.title === 'MEMBERS-ONLY-NEWS');
            assert(got(forB), 'the token signed for b.test gets the member feed');
            assert(!got(forA), 'the token signed for a.test gets no member feed (what an unsigned socket gets)');
            for (const s of [forA, forB]) if (s.kind === 'open') s.ws.terminate();
            const strictForA = await socket(C, await core.buildBoundWsParams({ wsUrl: 'wss://a.test/ws', publicKeyHex: mia.pk, sign: mia.sign }));
            assert(strictForA.kind === 'status' && strictForA.status === 401, `at C (ENFORCE_WS_AUTH=true) a token signed for a.test → 401 (${sockShow(strictForA)})`);
            const strictForC = await socket(C, await core.buildBoundWsParams({ wsUrl: 'wss://c.test/ws', publicKeyHex: mia.pk, sign: mia.sign }));
            assert(strictForC.kind === 'open', `and one signed for c.test opens (${sockShow(strictForC)})`);
            if (strictForC.kind === 'open') strictForC.ws.terminate();
            const damaged = await socket(B, (await core.buildBoundWsParams({ wsUrl: 'wss://b.test/ws', publicKeyHex: mia.pk, sign: mia.sign })).replace(/&v=2$/, ''));
            assert(damaged.kind === 'status' && damaged.status === 401, `a token with for= but no v=2 is a damaged token → 401 (${sockShow(damaged)})`);
        });

        // ── 5. Two names; the Host header changes nothing ──
        console.log('\n— 5. a community with two names —');
        await section('5', async () => {
            for (const host of ['b.test', 'b2.test']) {
                const r = await sendTo(B, 'GET', await bound(mia, 'GET', `https://${host}/api/community/me`));
                assert(r.status === 200 && r.body?.publicKey === mia.pk, `B accepts a read signed for ${host} (${show(r)})`);
            }
            const third = await sendTo(B, 'GET', await bound(mia, 'GET', 'https://c.test/api/community/me'));
            assert(third.status === 421, `c.test → 421 (${show(third)})`);
            const spoofed = await sendTo(B, 'GET', await bound(mia, 'GET', 'https://c.test/api/community/me'), { Host: 'b.test', 'X-Forwarded-Host': 'b.test' });
            assert(spoofed.status === 421, `signed for c.test with Host and X-Forwarded-Host saying b.test → still 421 (${show(spoofed)})`);
            const spoofedOther = await sendTo(B, 'GET', await bound(mia, 'GET', 'https://b.test/api/community/me'), { Host: 'a.test', 'X-Forwarded-Host': 'a.test' });
            assert(spoofedOther.status === 200, `signed for b.test with Host saying a.test → still accepted (${show(spoofedOther)})`);
            const wrongPath = await sendTo(B, 'GET', { ...(await bound(mia, 'GET', 'https://b.test/api/community/me')), path: '/api/community/info' });
            assert(wrongPath.status === 403, `a signature for one path presented at another → 403 (${show(wrongPath)})`);
            const info = await call(B, 'GET', '/api/community/info');
            assert(info.status === 200 && info.body?.requestSigning === 2 && JSON.stringify(info.body?.addresses) === JSON.stringify(['b.test', 'b2.test']),
                `/api/community/info says requestSigning 2 and lists b.test and b2.test (${JSON.stringify({ r: info.body?.requestSigning, a: info.body?.addresses })})`);
        });

        // ── 6. The directory call to the global node ──
        console.log('\n— 6. the global node —');
        await section('6', async () => {
            assert((await G.send('watch', { pk: mia.pk })) === true, 'setup: Mia watches a place on the global node');
            const home = await sendTo(G, 'GET', await bound(mia, 'GET', 'https://global.test/api/global/home'));
            assert(home.status === 200 && Array.isArray(home.body?.watches) && home.body.watches.length === 1,
                `a signed /api/global/home for global.test shows Mia's watch (${show(home)})`);
            const elsewhere = await sendTo(G, 'GET', await bound(mia, 'GET', 'https://b.test/api/global/home'));
            assert(elsewhere.status === 421 && !('watches' in (elsewhere.body || {})), `the same read signed for b.test → 421, no watches (${show(elsewhere)})`);
        });

        // ── 7. The switch ──
        console.log('\n— 7. the switch —');
        await section('7', async () => {
            await A.send('switchClock', { at: SWITCH - 1 });
            const lastDay = await sendTo(A, 'POST', unbound(mia, 'POST', '/api/ledger/transfer', { from: mia.pk, to: xan.pk, amount: 1, memo: 'last day' }));
            assert(lastDay.status === 200, `the last moment before ${new Date(SWITCH).toISOString().slice(0, 10)}: old format accepted (${show(lastDay)})`);
            await A.send('switchClock', { at: SWITCH });
            const before = await A.send('balance', { pk: xan.pk });
            const after = await sendTo(A, 'POST', unbound(mia, 'POST', '/api/ledger/transfer', { from: mia.pk, to: xan.pk, amount: 1, memo: 'after the switch' }));
            assert(after.status === 426 && after.body?.code === 'app_too_old' && /too old/.test(after.body?.error) && (await A.send('balance', { pk: xan.pk })) === before,
                `from the switch: old format → 426 app_too_old, nothing moves (${show(after)})`);
            const oldRead = await sendTo(A, 'GET', unbound(mia, 'GET', `/api/messages/conversations/${mia.pk}`));
            assert(oldRead.status === 426, `an old-format read too (${show(oldRead)})`);
            const newStill = await sendTo(A, 'POST', await bound(mia, 'POST', 'https://a.test/api/ledger/transfer', { from: mia.pk, to: xan.pk, amount: 1, memo: 'new app after switch' }));
            assert(newStill.status === 200, `format 2 is unaffected (${show(newStill)})`);
            const oldSock = await socket(A, oldWsQuery(mia));
            assert(oldSock.kind === 'open', `an old-format /ws token after the switch still opens a socket in the default mode (${sockShow(oldSock)})`);
            await A.send('announce', { title: 'AFTER-SWITCH-NEWS' });
            await sleep(300);
            assert(oldSock.kind === 'open' && !oldSock.events.some((e) => e.type === 'system_announcement'), 'but it is treated as unsigned: no member feed');
            if (oldSock.kind === 'open') oldSock.ws.terminate();
            await A.send('switchClock', { at: null });

            const never = await sendTo(C, 'POST', unbound(mia, 'POST', '/api/ledger/transfer', { from: mia.pk, to: xan.pk, amount: 1, memo: 'never' }));
            assert(never.status === 426 && never.body?.code === 'app_too_old', `with ACCEPT_UNBOUND_SIGNATURES_UNTIL=never (C) the old format is refused now (${show(never)})`);
            const cBound = await sendTo(C, 'POST', await bound(mia, 'POST', 'https://c.test/api/ledger/transfer', { from: mia.pk, to: xan.pk, amount: 1, memo: 'c bound' }));
            assert(cBound.status === 200, `and format 2 for c.test is accepted (${show(cBound)})`);
            const strictOldSock = await socket(C, oldWsQuery(mia));
            assert(strictOldSock.kind === 'status' && strictOldSock.status === 401, `an old-format /ws token at C (strict, switch passed) → 401 (${sockShow(strictOldSock)})`);
        });

        // ── 8. The Manage button ──
        console.log('\n— 8. the Settings sign-in (the app\'s Manage button) —');
        await section('8', async () => {
            // A hostile node's "challenge": the complete text of a request for another community. Every app before this
            // signs whatever challenge text the node sends (native node-admin.ts), as plain UTF-8.
            const ts = String(Date.now());
            const nonce = crypto.randomBytes(16).toString('hex');
            const stubChallenge = core.unboundRequestText({ method: 'POST', path: '/api/member/purge', timestamp: ts, nonce, body: '' });
            const oldPhoneSig = Buffer.from(ed25519.sign(core.utf8Bytes(stubChallenge), mia.seed)).toString('base64');
            const forged = { headers: { 'X-Public-Key': mia.pk, 'X-Signature': oldPhoneSig, 'X-Timestamp': ts, 'X-Nonce': nonce }, path: '/api/member/purge', body: undefined };
            const atC = await sendTo(C, 'POST', forged);
            assert(atC.status === 426 && (await C.send('member', { pk: mia.pk })) === 'active',
                `that signature used as "delete my account" at a community past the switch → 426, the account is untouched (${show(atC)})`);
            await B.send('switchClock', { at: SWITCH + 1000 });
            const atB = await sendTo(B, 'POST', forged);
            assert(atB.status === 426 && (await B.send('member', { pk: mia.pk })) === 'active', `and at B once its clock passes the switch (${show(atB)})`);
            await B.send('switchClock', { at: null });

            const challenge = async () => (await call(B, 'POST', '/api/local/admin/auth/challenge', {}, '{}')).body;
            const verify = (body: Record<string, unknown>) => call(B, 'POST', '/api/local/admin/auth/verify-challenge', {}, JSON.stringify(body));
            let ch = await challenge();
            assert(/^[0-9a-f]{64}$/.test(ch?.challengeId), 'B hands out a challenge id');
            const rawSig = Buffer.from(ed25519.sign(core.utf8Bytes(stubChallenge), owner.seed)).toString('base64');
            const rawAsV2 = await verify({ challengeId: ch.challengeId, memberPubkey: owner.pk, signature: rawSig, signedFor: 'b.test' });
            assert(rawAsV2.status === 403, `a signature over a node's text (a request's) is never the format-2 sign-in (${show(rawAsV2)})`);
            const nodeTextSig = Buffer.from(ed25519.sign(core.utf8Bytes(ch.challenge), owner.seed)).toString('base64');
            const nodeTextAsV2 = await verify({ challengeId: ch.challengeId, memberPubkey: owner.pk, signature: nodeTextSig, signedFor: 'b.test' });
            assert(nodeTextAsV2.status === 403, `nor is a signature over the node's own challenge text, when the app says format 2 (${show(nodeTextAsV2)})`);
            const forA = await verify({ challengeId: ch.challengeId, memberPubkey: owner.pk, signature: await core.signAdminSignin('https://a.test', ch.challengeId, owner.sign), signedFor: 'a.test' });
            assert(forA.status === 421 && forA.body?.code === 'wrong_community' && !forA.body?.handshakeToken, `the format-2 sign-in signed for a.test → 421 at B (${show(forA)})`);
            const forB = await verify({ challengeId: ch.challengeId, memberPubkey: owner.pk, signature: await core.signAdminSignin('https://b.test', ch.challengeId, owner.sign), signedFor: 'b.test' });
            assert(forB.status === 200 && /^[0-9a-f]{64}$/.test(forB.body?.handshakeToken) && forB.body?.role === 'owner', `signed for b.test it opens a sign-in (${show(forB)})`);

            ch = await challenge();
            const oldForm = await verify({ challengeId: ch.challengeId, memberPubkey: owner.pk, signature: Buffer.from(ed25519.sign(core.utf8Bytes(ch.challenge), owner.seed)).toString('base64') });
            assert(oldForm.status === 200 && oldForm.body?.handshakeToken, `the old sign-in form (the node's text) still works before the switch (${show(oldForm)})`);
            ch = await challenge();
            await B.send('switchClock', { at: SWITCH });
            const oldAfter = await verify({ challengeId: ch.challengeId, memberPubkey: owner.pk, signature: Buffer.from(ed25519.sign(core.utf8Bytes(ch.challenge), owner.seed)).toString('base64') });
            assert(oldAfter.status === 426 && oldAfter.body?.code === 'app_too_old' && !oldAfter.body?.handshakeToken, `and is refused after it: 426 (${show(oldAfter)})`);
            const bareId = await verify({ challengeId: ch.challengeId, memberPubkey: owner.pk, signature: Buffer.from(ed25519.sign(core.utf8Bytes(ch.challengeId), owner.seed)).toString('base64') });
            assert(bareId.status === 426, `so is the bare-id form (${show(bareId)})`);
            const v2After = await verify({ challengeId: ch.challengeId, memberPubkey: owner.pk, signature: await core.signAdminSignin('https://b.test', ch.challengeId, owner.sign), signedFor: 'b.test' });
            assert(v2After.status === 200 && v2After.body?.handshakeToken, `the format-2 sign-in for b.test works after the switch (${show(v2After)})`);
            await B.send('switchClock', { at: null });
        });

        // ── 9. Pairing and offline tickets ──
        console.log('\n— 9. phone pairing and offline tickets —');
        await section('9', async () => {
            await B.send('resetLimits');
            const approve = (p: { pairingId: string }, body: Record<string, unknown>) =>
                call(B, 'POST', `/api/local/admin/auth/pairing/${p.pairingId}/approve`, {}, JSON.stringify({ memberPubkey: owner.pk, ...body }));
            let p = await B.send('pairing');
            const madeAtA = await approve(p, { signature: await core.signSettingsSignin('https://a.test', 'approve', p.pairingId, p.shortCode, owner.sign), signedFor: 'a.test' });
            assert(madeAtA.status === 421 && madeAtA.body?.code === 'wrong_community', `a pairing approved for a.test (A showed B's code) → 421 at B (${show(madeAtA)})`);
            const describe = await call(B, 'GET', `/api/local/admin/auth/pairing/${p.pairingId}`);
            assert(describe.status === 200, `and the pairing is not approved: it still waits (${show(describe)})`);
            const madeAtB = await approve(p, { signature: await core.signSettingsSignin('https://b.test', 'approve', p.pairingId, p.shortCode, owner.sign), signedFor: 'b.test' });
            assert(madeAtB.status === 200 && madeAtB.body?.role === 'owner', `approved for b.test it is accepted (${show(madeAtB)})`);
            p = await B.send('pairing');
            const v1 = `beanpool-settings-signin:v1:approve:${p.pairingId}:${p.shortCode}`;
            const v1Sig = Buffer.from(ed25519.sign(core.utf8Bytes(v1), owner.seed)).toString('base64');
            await B.send('switchClock', { at: SWITCH });
            const v1After = await approve(p, { signature: v1Sig });
            assert(v1After.status === 426, `the old v1 approval after the switch → 426 (${show(v1After)})`);
            await B.send('switchClock', { at: null });
            const v1Before = await approve(p, { signature: v1Sig });
            assert(v1Before.status === 200, `and before it, accepted as before (${show(v1Before)})`);

            const joiner = (n: string) => id(n);
            const redeem = (node: Node, ticket: string, j: Id) =>
                call(node, 'POST', '/api/invite/redeem-offline', {}, JSON.stringify({ ticketB64: ticket, publicKey: j.pk, callsign: j.callsign }));
            const check = (node: Node, ticket: string) => call(node, 'GET', `/api/invite/check?code=${encodeURIComponent(`BP-${ticket}`)}`);
            const ticketA = await core.buildInviteTicket('https://a.test', mia.pk, mia.sign);
            const jA = joiner('JoA'), jB = joiner('JoB');
            const atA = await redeem(A, ticketA, jA);
            assert(atA.status === 200 && atA.body?.success && (await A.send('member', { pk: jA.pk })) === 'active', `a ticket made for a.test joins A (${show(atA)})`);
            const checkB = await check(B, ticketA);
            assert(checkB.status === 200 && checkB.body?.valid === false && checkB.body?.reason === 'wrong_community', `B's pre-flight says it is for another community (${show(checkB)})`);
            const atB = await redeem(B, ticketA, jB);
            assert(atB.status === 400 && /another community/.test(atB.body?.error) && (await B.send('member', { pk: jB.pk })) === null,
                `presented at B it is refused and nobody joins (${show(atB)})`);

            const oldTicket = () => {
                const payload = JSON.stringify({ i: mia.pk, t: Date.now() });
                const s = Buffer.from(ed25519.sign(core.utf8Bytes(payload), mia.seed)).toString('base64');
                return Buffer.from(JSON.stringify({ p: payload, s })).toString('base64');
            };
            const jOld = joiner('JoOld');
            const oldBefore = await redeem(B, oldTicket(), jOld);
            assert(oldBefore.status === 200 && oldBefore.body?.success, `an old app's ticket still joins before the switch (${show(oldBefore)})`);
            await B.send('switchClock', { at: SWITCH });
            const late = oldTicket();
            const jLate = joiner('JoLate');
            const oldAfter = await redeem(B, late, jLate);
            assert(oldAfter.status === 400 && /old version/.test(oldAfter.body?.error) && (await B.send('member', { pk: jLate.pk })) === null,
                `after it, refused, and the joiner is told to ask for a new one (${show(oldAfter)})`);
            const lateCheck = await check(B, late);
            assert(lateCheck.body?.valid === false && lateCheck.body?.reason === 'app_too_old', `the pre-flight says so too (${show(lateCheck)})`);
            await B.send('switchClock', { at: null });
        });

        // ── 10. The self-hoster with no address configured ──
        console.log('\n— 10. a node that knows none of its names —');
        await section('10', async () => {
            const infoBefore = await call(U, 'GET', '/api/community/info');
            assert(infoBefore.body?.requestSigning === 2 && Array.isArray(infoBefore.body?.addresses) && infoBefore.body.addresses.length === 0,
                `it lists no address (${JSON.stringify(infoBefore.body?.addresses)})`);
            const any = await sendTo(U, 'GET', await bound(mia, 'GET', 'https://community.example.org/api/community/me'));
            assert(any.status === 200, `a request signed for community.example.org is accepted until the switch (${show(any)})`);
            const lan = await sendTo(U, 'GET', await bound(mia, 'GET', 'https://192.168.1.20:8443/api/community/me'));
            assert(lan.status === 200, `so is one for its LAN address (${show(lan)})`);
            await U.send('switchClock', { at: SWITCH });
            const late = await sendTo(U, 'GET', await bound(mia, 'GET', 'https://community.example.org/api/community/me'));
            assert(late.status === 421, `after the switch an unconfirmed host is refused (${show(late)})`);
            const lanLate = await sendTo(U, 'GET', await bound(mia, 'GET', 'https://192.168.1.20:8443/api/community/me'));
            assert(lanLate.status === 200, `while its LAN address still works (${show(lanLate)})`);
            await U.send('switchClock', { at: null });
            const stranger = id('Stranger');
            const strangerRead = await sendTo(U, 'GET', await bound(stranger, 'GET', 'https://spam.example/api/community/info'));
            assert(strangerRead.status === 200, `a key with no row here signing for spam.example is answered as before (${show(strangerRead)})`);
            {
                const ts = String(Date.now());
                const nonce = crypto.randomBytes(16).toString('hex');
                const text = core.signedRequestText({ host: 'Community.Example.org', method: 'GET', path: '/api/community/me', timestamp: ts, nonce, body: '' });
                const sig = Buffer.from(ed25519.sign(core.signedRequestBytes(text), mia.seed)).toString('base64');
                const odd = await call(U, 'GET', '/api/community/me', { 'X-Public-Key': mia.pk, 'X-Signature': sig, 'X-Timestamp': ts, 'X-Nonce': nonce, 'X-Signed-For': 'Community.Example.org' });
                assert(odd.status === 421, `a host not in the form apps sign (capitals) is nobody's name, even here → 421 (${show(odd)})`);
            }
            const listed = await call(U, 'GET', '/api/local/admin/app-addresses', adminPw);
            assert(listed.status === 200 && listed.body?.addresses?.length === 0 && listed.body?.unconfirmed?.some((u: any) => u.address === 'community.example.org' && u.today >= 1),
                `Settings offers community.example.org to confirm (${show(listed)})`);
            assert(!listed.body?.unconfirmed?.some((u: any) => u.address === 'spam.example'), "but not spam.example: only members' apps put an address on that list");
            const noAuth = await call(U, 'POST', '/api/local/admin/app-addresses/confirm', {}, JSON.stringify({ address: 'community.example.org' }));
            assert(noAuth.status === 401 || noAuth.status === 403, `confirming needs an owner or admin (${show(noAuth)})`);
            const confirmed = await call(U, 'POST', '/api/local/admin/app-addresses/confirm', adminPw, JSON.stringify({ address: 'https://Community.Example.org/settings' }));
            assert(confirmed.status === 200 && confirmed.body?.addresses?.some((a: any) => a.address === 'community.example.org' && a.source === 'owner')
                && !confirmed.body?.unconfirmed?.some((u: any) => u.address === 'community.example.org'),
                `one tap confirms it, and it moves to the address list as the owner's (${show(confirmed)})`);
            const nowOwn = await sendTo(U, 'GET', await bound(mia, 'GET', 'https://community.example.org/api/community/me'));
            const other = await sendTo(U, 'GET', await bound(mia, 'GET', 'https://elsewhere.example.org/api/community/me'));
            const lanNow = await sendTo(U, 'GET', await bound(mia, 'GET', 'https://192.168.1.20:8443/api/community/me'));
            assert(nowOwn.status === 200 && other.status === 421 && lanNow.status === 421,
                `now it is this community's name: accepted, any other host → 421, the LAN address too (${nowOwn.status}, ${other.status}, ${lanNow.status})`);
            const info = await call(U, 'GET', '/api/community/info');
            assert(JSON.stringify(info.body?.addresses) === JSON.stringify(['community.example.org']), `and /api/community/info lists it (${JSON.stringify(info.body?.addresses)})`);
            const bad = await call(U, 'POST', '/api/local/admin/app-addresses/confirm', adminPw, JSON.stringify({ address: 'not a host' }));
            assert(bad.status === 400, `something that is not an address is refused (${show(bad)})`);
            const removed = await call(U, 'POST', '/api/local/admin/app-addresses/remove', adminPw, JSON.stringify({ address: 'community.example.org' }));
            assert(removed.status === 200 && removed.body?.addresses?.length === 0, `and it can be removed again (${show(removed)})`);
        });

        // ── 11. Settings on B: the list and the counts ──
        console.log('\n— 11. Settings: the address list and the old-app count —');
        await section('11', async () => {
            const r = await call(B, 'GET', '/api/local/admin/app-addresses', adminPw);
            const b = r.body || {};
            const by = (a: string) => b.addresses?.find((x: any) => x.address === a);
            assert(r.status === 200 && by('b.test')?.source === 'public-address' && by('b2.test')?.source === 'env',
                `B lists b.test (its public address) and b2.test (BEANPOOL_ADDRESSES) (${JSON.stringify(b.addresses)})`);
            assert(by('b.test')?.today >= 1 && by('b2.test')?.today >= 1, 'each with how many people\'s apps used it today');
            assert(b.oldApps?.today >= 1 && b.unboundSignaturesUntil === '2026-12-15' && b.unboundSignaturesAccepted === true,
                `and how many signed with an old app, and the switch date (${JSON.stringify({ o: b.oldApps, u: b.unboundSignaturesUntil })})`);
            const rows: any[] = await B.send('countsTable');
            const keys = [owner, mia, xan].map((m) => m.pk);
            assert(rows.length > 0 && !JSON.stringify(rows).match(new RegExp(keys.map((k) => k.slice(0, 16)).join('|'))),
                `the counts table holds counts and addresses, no key (${rows.length} rows)`);
            const moderatorless = await call(B, 'GET', '/api/local/admin/app-addresses');
            assert(moderatorless.status === 401, `and the list needs admin auth (${show(moderatorless)})`);
        });

        // ── 12. "Delete my account", replayed ──
        console.log('\n— 12. "delete my account" signed for A, replayed at B —');
        await section('12', async () => {
            const req = await bound(mia, 'POST', 'https://a.test/api/member/purge', {});
            const atA = await sendTo(A, 'POST', req);
            assert(atA.status === 200 && (await A.send('member', { pk: mia.pk })) !== 'active', `accepted at A: Mia's account there is closed (${show(atA)})`);
            const bBalance = await B.send('balance', { pk: mia.pk });
            const atB = await sendTo(B, 'POST', req);
            assert(atB.status === 421 && (await B.send('member', { pk: mia.pk })) === 'active' && (await B.send('balance', { pk: mia.pk })) === bBalance,
                `the identical bytes at B → 421; Mia's row and balance at B are unchanged (${show(atB)})`);
            assert((await B.send('nonceSpent', { nonce: req.nonce })) === false, 'the nonce is unspent at B');
            const reSigned = await sendTo(B, 'POST', await bound(mia, 'POST', 'https://b.test/api/member/purge', {},
                { timestamp: Number(req.headers['X-Timestamp']), nonce: req.nonce }));
            assert(reSigned.status === 200 && (await B.send('member', { pk: mia.pk })) !== 'active', `re-signed for b.test (same nonce) it is accepted at B (${show(reSigned)})`);
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
