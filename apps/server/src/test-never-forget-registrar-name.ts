/**
 * A community never forgets a registrar name it held (design scratch/registrar/DESIGN-lost-name-audience-opus.md §8, L1;
 * Marty's rule, 2026-09-24: a community never loses its own name through a check, a bug or a stale registrar).
 *
 * Before this, Settings' status check wiped the saved address and the tunnel token when the registrar answered `none`
 * (as one that lost its data answers every key), a live answer naming another name replaced the old one, and Take
 * offline dropped it: members' apps that still reached the community by that name were refused (421), or a node with no
 * other name became `unconfigured` and accepted any host.
 *
 * Every node is a REAL server in its own process (takeover-test-harness.ts) with its real HTTPS server and signature
 * middleware. The registrar is a mock in this process (REGISTRAR_URL), never the live one. A member's request is signed
 * (format 2) for a host, as an app that reached the community by that name signs it, and sent over HTTPS. No node here
 * reaches Cloudflare: each refuses its own requests to the edge Settings probes, and its tunnel is the fake cloudflared
 * (takeover-test-harness.ts). Nor Docker: no server code talks to its socket (test-no-docker-socket.ts).
 *
 * Node N (BEANPOOL_ADDRESSES=b2.test, so it has another name):
 *  1. The registrar answers live `bname`; Settings' status stores it. Requests signed for bname.beanpool.org and b2.test
 *     are accepted, other.test → 421.
 *  2. The registrar answers `none`, and the admin opens Settings: bname is still accepted (main: 421), the tunnel token
 *     file is intact (main: deleted), and Settings says the address service has no record of the name.
 *  3. The registrar answers live `newname` (renamed): bname and newname are both accepted (main: bname 421), only
 *     newname is published. An answer the node doesn't store adds no name (`paused` for `stranger`), and one for a
 *     recorded name is written on it (newname paused, still accepted).
 *  4. Take offline: newname is still accepted during the hold (main: 421), held until the registrar's held_until; the
 *     token is removed. A release answer without held_until holds 30 days. Claiming a released name again takes it back.
 * Node U (no other name):
 *  5. The registrar answers `none`: U still knows its name, so a request for random.example → 421 rather than accepted
 *     as an unconfigured node's (main: accepted until the switch), and Settings says it knows its names.
 * The take-over:
 *  6. N's standby holds the keys sealed after all that; N dies and the standby takes over with the recovery code. It
 *     accepts every name N's key held, former ones included (main: 421 for them), and refuses other.test.
 *
 *   BEANPOOL_DATA_DIR=$(mktemp -d) pnpm exec tsx apps/server/src/test-never-forget-registrar-name.ts
 */

import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import path from 'node:path';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import { fileURLToPath } from 'node:url';
import { spawnNode, post, runNodeChild, type NodeProc } from './takeover-test-harness.js';

const SCRIPT = fileURLToPath(import.meta.url);
const PW_N = 'Never-Forget-N-Pw-5521!';
const PW_U = 'Never-Forget-U-Pw-6083!';
const PW_STANDBY = 'Never-Forget-Standby-Pw-7194!';
/** The Cloudflare edge Settings' probe asks (routes/public-address.ts verifyEdgeStatus). */
const CF_EDGE_IP = '104.21.93.179';

// ── The node processes' commands ───────────────────────────────────────────────────────────

/**
 * No test node reaches Cloudflare's edge (Settings' claim and Take offline probe it): those requests fail at once instead.
 */
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

let httpsBase: string | null = null;

/** This process's real HTTPS server, started once: every route and the signature middleware a node runs. */
async function ownHttps(): Promise<string> {
    if (httpsBase) return httpsBase;
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
    delete process.env.CF_RECORD_NAME;
    const { initTls } = await import('./services/tls.js');
    const { startHttpsServer } = await import('./https-server.js');
    await initTls();
    httpsBase = `https://localhost:${await startHttpsServer(0)}`;
    return httpsBase;
}

async function child(): Promise<void> {
    refuseEdge();
    await runNodeChild({
        setup: async (a: { ownerSeedHex: string; replicationToken?: string }) => {
            const { ed25519 } = await import('@noble/curves/ed25519.js');
            const se = await import('./state-engine.js');
            const anna = Buffer.from(ed25519.getPublicKey(Buffer.from(a.ownerSeedHex, 'hex'))).toString('hex');
            se.seedGenesisMember(anna, 'Anna');
            let code: string | null = null;
            let envelopeId: string | null = null;
            if (a.replicationToken) {
                const { setReplicationToken } = await import('./config/local-config.js');
                const { makeRecoveryCode, flushTakeoverChecks } = await import('./services/takeover-envelope.js');
                setReplicationToken(a.replicationToken);
                code = (await makeRecoveryCode()).code;
                envelopeId = (await flushTakeoverChecks()).envelopeId;
            }
            return { anna, code, envelopeId, https: await ownHttps() };
        },
        https: async () => ownHttps(),
        flush: async () => {
            const { flushTakeoverChecks } = await import('./services/takeover-envelope.js');
            return { envelopeId: (await flushTakeoverChecks()).envelopeId };
        },
        'setup-standby': async (a: { primaryUrl: string; replicationToken: string; primaryPeerId: string }) => {
            const { addConnector } = await import('./connector-manager.js');
            const { updateLocalConfig } = await import('./config/local-config.js');
            addConnector(`/ip4/127.0.0.1/tcp/4998/p2p/${a.primaryPeerId}`, 'mirror', 'main-server', undefined, false);
            updateLocalConfig({ backupPrimaryUrl: a.primaryUrl, backupReplicationToken: a.replicationToken });
            return true;
        },
        pull: async () => {
            const { requestResync, pullTakeoverEnvelopeNow } = await import('./services/backup-puller.js');
            const { listHeldEnvelopes } = await import('./services/standby-envelopes.js');
            const resync = await requestResync();
            const envelope = await pullTakeoverEnvelopeNow();
            return { resync, envelope, held: listHeldEnvelopes().map((h) => h.envelopeId) };
        },
        // What the node holds, as stored: node_config's row (not as a reader tidies it), the tunnel it runs, its names.
        inspect: async () => {
            const { db } = await import('./db/db.js');
            const { configuredAddresses, publishedAddresses, knowsItsNames, forgetOwnAddresses } = await import('./engine/own-addresses.js');
            const { tunnelConnectorForTests } = await import('./services/tunnel-connector.js');
            const row = db.prepare("SELECT value FROM node_config WHERE key = 'node_config'").get() as { value?: string } | undefined;
            const stored = row?.value ? JSON.parse(row.value) : {};
            const tokenFile = path.join(process.env.BEANPOOL_DATA_DIR!, 'tunnel-token');
            // Read afresh, at the real time: a list cached for a later moment would be what requests get until then.
            forgetOwnAddresses();
            return {
                publicAddress: stored.publicAddress ?? null,
                registrarNames: stored.registrarNames ?? null,
                tokenFile: fs.existsSync(tokenFile) ? fs.readFileSync(tokenFile, 'utf-8') : null,
                // The token the tunnel inside the server runs (it was the token file, for a sidecar, until 2026-09-28).
                tunnel: tunnelConnectorForTests().runningToken,
                configured: configuredAddresses(),
                published: publishedAddresses(),
                named: knowsItsNames(),
            };
        },
        // Anna's app reads her own standing here, signed (format 2) for each host, over this node's real HTTPS server.
        bound: async (a: { ownerSeedHex: string; hosts: string[] }) => {
            const core = await import('@beanpool/core');
            const { ed25519 } = await import('@noble/curves/ed25519.js');
            const base = await ownHttps();
            const seed = new Uint8Array(Buffer.from(a.ownerSeedHex, 'hex'));
            const pk = Buffer.from(ed25519.getPublicKey(seed)).toString('hex');
            const out: Record<string, number> = {};
            for (const host of a.hosts) {
                const headers = await core.buildBoundRequestHeaders({ method: 'GET', url: `https://${host}/api/community/me`, body: '', publicKeyHex: pk, sign: core.ed25519Signer(seed) });
                const res = await fetch(`${base}/api/community/me`, { headers });
                const body: any = await res.json().catch(() => null);
                out[host] = res.status === 200 && body?.publicKey !== pk ? -1 : res.status;
            }
            return out;
        },
    });
}

// ── The orchestrator ───────────────────────────────────────────────────────────────────────

let run = 0, passed = 0;
function assert(cond: unknown, msg: string): void {
    run++;
    if (cond) { passed++; console.log(`✓ ${msg}`); } else { console.error(`✗ ${msg}`); process.exitCode = 1; }
}

/**
 * A node reads its names again at most a second after they change (own-addresses.ts's cache), so each check waits that
 * long first: it sees what a member's app gets from then on, never a copy from before the change.
 */
const settled = () => new Promise((r) => setTimeout(r, 1_100));

/** One numbered section: an error in it fails it and the next one still runs. */
async function section(n: string, body: () => Promise<void>): Promise<void> {
    try {
        await body();
    } catch (e: any) {
        assert(false, `section ${n} ran to the end (${e?.message || e})`);
    }
}

interface Reply { status: number; body: any }

/** A request to a node's HTTPS server (its certificate is self-signed), as Settings makes it. */
function call(base: string, method: string, route: string, headers: Record<string, string> = {}, body?: unknown): Promise<Reply> {
    const url = new URL(route, base);
    const text = body === undefined ? undefined : JSON.stringify(body);
    return new Promise((resolve) => {
        const req = https.request({
            host: url.hostname, port: url.port, path: url.pathname + url.search, method, rejectUnauthorized: false,
            headers: { ...(text !== undefined ? { 'Content-Type': 'application/json', 'Content-Length': String(Buffer.byteLength(text)) } : {}), ...headers },
        }, (res) => {
            let out = '';
            res.on('data', (c) => { out += c; });
            res.on('end', () => {
                let parsed: any = out;
                try { parsed = JSON.parse(out); } catch { /* not JSON */ }
                resolve({ status: res.statusCode || 0, body: parsed });
            });
        });
        req.on('error', (e) => resolve({ status: 0, body: { networkError: e.message } }));
        if (text !== undefined) req.write(text);
        req.end();
    });
}
const show = (r: Reply) => `${r.status} ${JSON.stringify(r.body).slice(0, 200)}`;

/** The mock registrar: signed requests only; what it answers is set by the steps. */
interface Registrar {
    url: string;
    status: any;
    release: any;
    calls: string[];
    close: () => void;
}
async function startRegistrar(): Promise<Registrar> {
    const reg: Registrar = { url: '', status: { status: 'none' }, release: { status: 'none' }, calls: [], close: () => {} };
    const server = http.createServer((req, res) => {
        let text = '';
        req.on('data', (c) => { text += c; });
        req.on('end', () => {
            const send = (code: number, body: unknown) => {
                res.writeHead(code, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify(body));
            };
            const p = new URL(req.url || '/', 'http://registrar').pathname;
            reg.calls.push(`${req.method} ${p}`);
            if (!req.headers['x-bp-pubkey'] || !req.headers['x-bp-timestamp'] || !req.headers['x-bp-signature']) return send(401, { error: 'unsigned' });
            if (req.method === 'GET' && p === '/api/registrar/status') return send(200, reg.status);
            if (req.method === 'POST' && p === '/api/registrar/claim') {
                const name = String(JSON.parse(text || '{}').name || '');
                return send(200, { status: 'live', name, hostname: `${name}.beanpool.org`, tunnelToken: `T-${name}` });
            }
            if (req.method === 'POST' && (p === '/api/registrar/offline' || p === '/api/registrar/release')) return send(200, reg.release);
            send(404, { error: 'not found' });
        });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    reg.url = `http://127.0.0.1:${(server.address() as any).port}`;
    reg.close = () => server.close();
    return reg;
}

const live = (name: string) => ({ status: 'live', name, hostname: `${name}.beanpool.org`, mode: 'tunnel', tunnelToken: `T-${name}` });
const entry = (names: any, address: string) => (Array.isArray(names) ? names.find((e: any) => e?.address === address) : undefined);

async function main(): Promise<void> {
    const root = process.env.BEANPOOL_DATA_DIR;
    if (!root) throw new Error('Set BEANPOOL_DATA_DIR to a throwaway directory');
    const dirs = { n: path.join(root, 'n'), u: path.join(root, 'u'), standby: path.join(root, 'standby') };
    const nodes: NodeProc[] = [];
    const ownerSeedHex = crypto.randomBytes(32).toString('hex');
    const replicationToken = crypto.randomBytes(32).toString('hex');
    const reg = await startRegistrar();
    const noAgent = { PUBLIC_ADDRESS_AUTO: undefined, PUBLIC_ADDRESS_NAME: undefined, CF_RECORD_NAME: undefined, CF_API_TOKEN: undefined, CF_ZONE_ID: undefined };

    try {
        console.log('A community never forgets a registrar name it held\n');
        const N = await spawnNode(SCRIPT, dirs.n, { ...noAgent, ADMIN_PASSWORD: PW_N, NODE_ROLE: 'primary', BEANPOOL_ADDRESSES: 'b2.test', REGISTRAR_URL: reg.url });
        nodes.push(N);
        const setup = await N.send('setup', { ownerSeedHex, replicationToken });
        const nBase: string = setup.https;
        const admin = { 'X-Admin-Password': PW_N };
        const statusOpen = () => call(nBase, 'GET', '/api/local/admin/public-address/status', admin);
        const bound = async (node: NodeProc, hosts: string[]) => {
            await settled();
            return node.send('bound', { ownerSeedHex, hosts });
        };

        // A standby of N, copying it from the start (its keys are pulled again at the end).
        fs.mkdirSync(dirs.standby, { recursive: true });
        fs.copyFileSync(path.join(dirs.n, 'genesis.json'), path.join(dirs.standby, 'genesis.json'));
        let standby = await spawnNode(SCRIPT, dirs.standby, { ...noAgent, ADMIN_PASSWORD: PW_STANDBY, NODE_ROLE: 'backup', BEANPOOL_ADDRESSES: undefined, REGISTRAR_URL: reg.url });
        nodes.push(standby);
        await standby.send('setup-standby', { primaryUrl: N.base, replicationToken, primaryPeerId: N.ready.peerId });
        const pull1 = await standby.send('pull');
        assert(pull1.resync.ok && pull1.envelope === 'stored', `N's standby copies it and holds its keys (${JSON.stringify(pull1.resync)}, ${pull1.envelope})`);

        // ── 1 ──
        console.log('\n— 1. N stores its registrar name —');
        await section('1', async () => {
            reg.status = live('bname');
            const opened = await statusOpen();
            assert(opened.status === 200 && opened.body?.status === 'live' && opened.body?.hostname === 'bname.beanpool.org', `Settings shows bname live (${show(opened)})`);
            const s = await N.send('inspect');
            assert(s.tunnel === 'T-bname' && s.tokenFile === null, `the tunnel runs on bname's token, with no copy in a file (${s.tunnel}, ${s.tokenFile})`);
            const r = await bound(N, ['bname.beanpool.org', 'b2.test', 'other.test']);
            assert(r['bname.beanpool.org'] === 200 && r['b2.test'] === 200, `requests signed for bname.beanpool.org and b2.test are accepted (${JSON.stringify(r)})`);
            assert(r['other.test'] === 421, `other.test → 421 (${r['other.test']})`);
        });

        // ── 2 ──
        console.log('\n— 2. the registrar answers none, and the admin opens Settings —');
        await section('2', async () => {
            reg.status = { status: 'none' };
            const opened = await statusOpen();
            assert(opened.status === 200 && opened.body?.status === 'none', `Settings' status answers, with the registrar's none (${show(opened)})`);
            assert(opened.body?.kept?.hostname === 'bname.beanpool.org',
                `and names the address this server keeps, for Settings to say the address service has no record of it (${JSON.stringify(opened.body?.kept ?? null)})`);
            const r = await bound(N, ['bname.beanpool.org', 'b2.test', 'other.test']);
            assert(r['bname.beanpool.org'] === 200, `a request signed for bname.beanpool.org is still accepted (${r['bname.beanpool.org']}; main: 421)`);
            assert(r['b2.test'] === 200 && r['other.test'] === 421, `b2.test still accepted, other.test still 421 (${r['b2.test']}, ${r['other.test']})`);
            const s = await N.send('inspect');
            assert(s.tunnel === 'T-bname', `the tunnel still runs on bname's token (${s.tunnel === null ? 'stopped' : s.tunnel}; before L1: its token deleted)`);
            assert(s.publicAddress?.name === 'bname' && s.publicAddress?.tunnelToken === 'T-bname', `the stored address is kept, token and all (${JSON.stringify(s.publicAddress)})`);
            const e = entry(s.registrarNames, 'bname.beanpool.org');
            assert(e?.role === 'current' && e?.status === 'none', `the record keeps bname, current, with the registrar's none written on it (${JSON.stringify(e ?? null)})`);
        });

        // ── 3 ──
        console.log('\n— 3. the registrar answers live newname (renamed) —');
        await section('3', async () => {
            reg.status = live('newname');
            const opened = await statusOpen();
            assert(opened.status === 200 && opened.body?.hostname === 'newname.beanpool.org', `Settings shows newname live (${show(opened)})`);
            const r = await bound(N, ['bname.beanpool.org', 'newname.beanpool.org', 'other.test']);
            assert(r['bname.beanpool.org'] === 200, `a request signed for the old name, bname.beanpool.org, is still accepted (${r['bname.beanpool.org']}; main: 421)`);
            assert(r['newname.beanpool.org'] === 200 && r['other.test'] === 421, `newname accepted, other.test 421 (${r['newname.beanpool.org']}, ${r['other.test']})`);
            const s = await N.send('inspect');
            assert(entry(s.registrarNames, 'newname.beanpool.org')?.role === 'current' && entry(s.registrarNames, 'bname.beanpool.org')?.role === 'former',
                `the record: newname current, bname former (${JSON.stringify(s.registrarNames)})`);
            assert(s.tunnel === 'T-newname', `the tunnel runs on newname's token (${s.tunnel})`);
            await settled();
            const info = await call(nBase, 'GET', '/api/community/info');
            const published: string[] = info.body?.addresses ?? [];
            assert(published.includes('newname.beanpool.org') && published.includes('b2.test') && !published.includes('bname.beanpool.org'),
                `/api/community/info publishes newname and b2.test, never the former bname (${JSON.stringify(published)})`);
            const list = await call(nBase, 'GET', '/api/local/admin/app-addresses', admin);
            const row = (list.body?.addresses ?? []).find((a: any) => a.address === 'bname.beanpool.org');
            assert(row?.source === 'registrar' && row?.former === true, `Settings lists bname as a former registrar name (${JSON.stringify(row ?? null)})`);

            reg.status = { status: 'paused', name: 'stranger', hostname: 'stranger.beanpool.org', reason: 'impostor' };
            await statusOpen();
            const r2 = await bound(N, ['stranger.beanpool.org', 'newname.beanpool.org']);
            assert(r2['stranger.beanpool.org'] === 421, `an answer the node doesn't store adds no name: stranger.beanpool.org → 421 (${r2['stranger.beanpool.org']})`);
            const s2 = await N.send('inspect');
            assert(!entry(s2.registrarNames, 'stranger.beanpool.org'), `and the record has no stranger (${JSON.stringify(s2.registrarNames)})`);

            reg.status = { status: 'paused', name: 'newname', hostname: 'newname.beanpool.org', reason: 'unverified' };
            await statusOpen();
            const s3 = await N.send('inspect');
            const nn = entry(s3.registrarNames, 'newname.beanpool.org');
            assert(nn?.status === 'paused' && nn?.reason === 'unverified' && nn?.role === 'current', `a paused answer for newname is written on it (${JSON.stringify(nn ?? null)})`);
            assert(r2['newname.beanpool.org'] === 200 && (await bound(N, ['newname.beanpool.org']))['newname.beanpool.org'] === 200, 'and newname is still accepted');
        });

        // ── 4 ──
        console.log('\n— 4. Take offline —');
        await section('4', async () => {
            const heldUntilS = Math.floor(Date.now() / 1000) + 12 * 86_400;
            reg.release = { status: 'released', name: 'newname', held_until: heldUntilS };
            const off = await call(nBase, 'POST', '/api/local/admin/public-address/offline', admin, {});
            assert(off.status === 200 && off.body?.success === true, `Take offline answers (${show(off)})`);
            const r = await bound(N, ['newname.beanpool.org', 'bname.beanpool.org', 'other.test']);
            assert(r['newname.beanpool.org'] === 200, `during the hold a request signed for newname.beanpool.org is still accepted (${r['newname.beanpool.org']}; main: 421)`);
            assert(r['bname.beanpool.org'] === 200 && r['other.test'] === 421, `bname still accepted, other.test 421 (${r['bname.beanpool.org']}, ${r['other.test']})`);
            await settled();
            const s = await N.send('inspect');
            assert(s.tunnel === null && s.tokenFile === null && s.publicAddress === null,
                `the tunnel is stopped and the stored address cleared, as before (${s.tunnel}, ${JSON.stringify(s.publicAddress)})`);
            const nn = entry(s.registrarNames, 'newname.beanpool.org');
            assert(nn?.role === 'former' && nn?.status === 'released' && typeof nn?.releasedByUsAt === 'string'
                && Date.parse(nn?.heldUntil) === heldUntilS * 1000, `the record: newname former, released by this node, held until the registrar's held_until (${JSON.stringify(nn ?? null)})`);
            assert(s.named === true && !s.published.includes('newname.beanpool.org'), `N still knows its names; newname is no longer published (${JSON.stringify(s.published)})`);

            // Another name, claimed in Settings, then released with an answer that gives no held_until: the registrar freed
            // it at once, so no hold is recorded (#1247's review 4115220670; this assertion said 30 days before).
            const claimed = await call(nBase, 'POST', '/api/local/admin/public-address/claim', admin, { name: 'third', mode: 'tunnel' });
            assert(claimed.status === 200 && claimed.body?.hostname === 'third.beanpool.org', `Settings claims third (${show(claimed)})`);
            reg.release = { status: 'released', name: 'third' };
            const before = Date.now();
            const off2 = await call(nBase, 'POST', '/api/local/admin/public-address/offline', admin, {});
            assert(off2.status === 200, `and takes it offline (${show(off2)})`);
            const s2 = await N.send('inspect');
            const third = entry(s2.registrarNames, 'third.beanpool.org');
            assert(third?.role === 'former' && third?.heldUntil === null && typeof third?.releasedByUsAt === 'string'
                && Date.parse(third.releasedByUsAt) >= before - 1000,
                `with no held_until in the answer, released by this node and no hold recorded (${JSON.stringify(third ?? null)})`);
            const r2 = await bound(N, ['third.beanpool.org']);
            assert(r2['third.beanpool.org'] === 200, `third is still accepted (${r2['third.beanpool.org']}; main: 421)`);

            // Taking newname back: current again, the hold over.
            const back = await call(nBase, 'POST', '/api/local/admin/public-address/claim', admin, { name: 'newname', mode: 'tunnel' });
            assert(back.status === 200, `Settings claims newname again (${show(back)})`);
            const s3 = await N.send('inspect');
            const nb = entry(s3.registrarNames, 'newname.beanpool.org');
            assert(nb?.role === 'current' && nb?.status === 'live' && nb?.releasedByUsAt === null && nb?.heldUntil === null,
                `newname is current again, its release and hold cleared (${JSON.stringify(nb ?? null)})`);
            assert(s3.registrarNames.length === 3 && s3.tunnel === 'T-newname', `the record still has all three names, and the tunnel runs on newname's token (${s3.registrarNames.map((e: any) => `${e.address} ${e.role}`).join(', ')}; ${s3.tunnel})`);
        });

        // ── 5 ──
        console.log('\n— 5. a node whose only name is its registrar name, answered none —');
        await section('5', async () => {
            const U = await spawnNode(SCRIPT, dirs.u, { ...noAgent, ADMIN_PASSWORD: PW_U, NODE_ROLE: 'primary', BEANPOOL_ADDRESSES: undefined, REGISTRAR_URL: reg.url });
            nodes.push(U);
            const uSetup = await U.send('setup', { ownerSeedHex });
            const uAdmin = { 'X-Admin-Password': PW_U };
            reg.status = live('uname');
            const first = await call(uSetup.https, 'GET', '/api/local/admin/public-address/status', uAdmin);
            assert(first.status === 200 && first.body?.status === 'live', `U stores uname (${show(first)})`);
            reg.status = { status: 'none' };
            const opened = await call(uSetup.https, 'GET', '/api/local/admin/public-address/status', uAdmin);
            assert(opened.status === 200 && opened.body?.kept?.hostname === 'uname.beanpool.org', `Settings says the address service has no record, and U keeps uname (${show(opened)})`);
            const r = await bound(U, ['uname.beanpool.org', 'random.example']);
            assert(r['uname.beanpool.org'] === 200, `uname is still accepted (${r['uname.beanpool.org']})`);
            assert(r['random.example'] === 421, `random.example → 421: U never falls back to accepting any host (${r['random.example']}; main: 200 until the switch)`);
            await settled();
            const list = await call(uSetup.https, 'GET', '/api/local/admin/app-addresses', uAdmin);
            assert(list.body?.named === true, `Settings says U knows its names (named: ${list.body?.named}; main: false)`);
            await U.kill('SIGKILL');
        });

        // ── 6 ──
        console.log('\n— 6. N dies; its standby takes over and accepts every name N\'s key held —');
        await section('6', async () => {
            const flushed = await N.send('flush');
            const pull2 = await standby.send('pull');
            assert(pull2.envelope === 'stored' && pull2.held.at(-1) === flushed.envelopeId, `the standby holds N's newest keys (${pull2.envelope}, ${flushed.envelopeId})`);
            await N.kill('SIGKILL');
            const opened = await post(standby.base, '/api/local/admin/takeover/open', { code: setup.code }, { 'X-Admin-Password': PW_STANDBY });
            assert(opened.status === 200 && opened.body?.preview?.sessionId, `the recovery code opens the keys (${opened.status})`);
            const confirmed = await post(standby.base, '/api/local/admin/takeover/confirm', { sessionId: opened.body.preview.sessionId, confirm: true }, { 'X-Admin-Password': PW_STANDBY });
            assert(confirmed.status === 200, `the take-over is confirmed (${confirmed.status} ${JSON.stringify(confirmed.body).slice(0, 160)})`);
            assert((await standby.exited) === 0, 'the standby restarts itself');
            standby = await spawnNode(SCRIPT, dirs.standby, { ...noAgent, ADMIN_PASSWORD: PW_STANDBY, NODE_ROLE: 'backup', BEANPOOL_ADDRESSES: undefined, REGISTRAR_URL: reg.url });
            nodes.push(standby);
            assert(standby.ready.role === 'primary', 'it is the main server now');
            const s = await standby.send('inspect');
            assert(Array.isArray(s.registrarNames) && s.registrarNames.length === 3, `the record came with the keys (${JSON.stringify(s.registrarNames)})`);
            const r = await bound(standby, ['newname.beanpool.org', 'bname.beanpool.org', 'third.beanpool.org', 'other.test']);
            assert(r['newname.beanpool.org'] === 200, `newname, the current name, is accepted (${r['newname.beanpool.org']})`);
            assert(r['bname.beanpool.org'] === 200 && r['third.beanpool.org'] === 200,
                `the former names bname and third are accepted too (${r['bname.beanpool.org']}, ${r['third.beanpool.org']}; main: 421)`);
            assert(r['other.test'] === 421, `other.test → 421 (${r['other.test']})`);
        });

        assert(!reg.calls.some((c) => !/^(GET|POST) \/api\/registrar\/(status|claim|offline)$/.test(c)), `the nodes asked the mock registrar only for status, claim and release (${[...new Set(reg.calls)].join(', ')})`);
    } catch (e: any) {
        assert(false, `the suite ran to the end (${e?.message || e})`);
        for (const n of nodes) console.error(`--- node output (tail) ---\n${n.output().slice(-2500)}`);
    } finally {
        for (const n of nodes) await n.kill('SIGKILL').catch(() => {});
        reg.close();
    }
    console.log(`\n${passed}/${run} checks passed.`);
    process.exit(process.exitCode ?? 0);
}

if (process.argv.includes('--child')) {
    child().catch((e) => { console.error(e); process.exit(1); });
} else {
    main().catch((e) => { console.error(e); process.exit(1); });
}
