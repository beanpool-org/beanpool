/**
 * Members still using a community's old web address are told where it lives now (lost-name L4; design
 * scratch/registrar/DESIGN-lost-name-audience-opus.md §4.2, §6, §8 L4; Marty's answer 4, 2026-09-28: a web banner now,
 * the phone follows renames later, with aliases).
 *
 * `/api/community/info` says where the community is now (`primaryAddress`: the current live registrar name, else the
 * first of its published names) and which BeanPool names it had before (`formerAddresses`), so the web app opened at
 * one of those can say so. Settings' report (`/api/local/admin/app-addresses`) says how many members' apps reached the
 * community by a former name today, and where it is now. Nothing here changes which hosts are accepted (L1/L3).
 *
 * Every node is a REAL server in its own process (and process group), over real HTTPS through the real signature
 * middleware; a member's request is signed (format 2) for the host an app that reached the community by that name
 * signs for. No node reaches a registrar or Cloudflare: each name is set in node_config as the registrar's answers
 * leave it.
 *
 *  1. L, named by CF_RECORD_NAME (cfname) with a current registrar name livename: while livename is live it is the
 *     primary address, though CF_RECORD_NAME comes first among its names; once the registrar says `paused`, the first
 *     published name is. No former names.
 *  2. C, named only by BEANPOOL_ADDRESSES (first.test, second.test): the first is the primary address, no former names.
 *     K, named only by CF_RECORD_NAME (fleetname, as our fleet is): fleetname.beanpool.org.
 *  3. F, renamed from oldname and older to newname (live): newname is the primary address; oldname and older are
 *     former, still not among `addresses`. Members' apps signing for oldname and older are accepted (as before), and
 *     Settings says 3 members' apps reached the community by a former name today (the owner's and a member's for
 *     newname don't count), where it is now, and each name's own count.
 *  4. G, whose only name is one it released: no primary address (the web app then says nothing), the former name
 *     listed. U, a node with no names: no primary address, no former names.
 *
 *   BEANPOOL_DATA_DIR=$(mktemp -d) pnpm exec tsx apps/server/src/test-former-address.ts
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import https from 'node:https';
import path from 'node:path';
import readline from 'node:readline';
import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SCRIPT = fileURLToPath(import.meta.url);
const PW = 'Former-Address-Pw-4417!';

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
    const { forgetOwnAddresses } = await import('./engine/own-addresses.js');
    const { resetGatewayRateLimit } = await import('./gateway-rate-limit.js');
    const { resetAdminAuthTarpit } = await import('./admin-auth.js');

    initAdminPassword();
    await initTls();
    se.initStateEngine();
    const port = await startHttpsServer(0);

    const commands: Record<string, (a: any) => unknown> = {
        seed: (a: { owner: { pk: string; callsign: string }; members: { pk: string; callsign: string }[] }) => {
            se.seedGenesisMember(a.owner.pk, a.owner.callsign);
            db.prepare("INSERT OR IGNORE INTO node_roles (member_pubkey, role, granted_by) VALUES (?, 'owner', 'genesis')").run(a.owner.pk);
            for (const m of a.members) {
                db.prepare(`INSERT INTO members (public_key, callsign, joined_at, status, updated_at)
                            VALUES (?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'), 'active', strftime('%Y-%m-%dT%H:%M:%fZ','now'))`)
                    .run(m.pk, m.callsign);
                db.prepare('INSERT OR IGNORE INTO accounts (public_key, balance, last_demurrage_epoch) VALUES (?, 0, 0)').run(m.pk);
            }
            return true;
        },
        resetLimits: () => {
            resetGatewayRateLimit();
            resetAdminAuthTarpit();
            return true;
        },
        // The names as the registrar's answers leave them in node_config (engine/registrar-names.ts).
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
                let parsed: any;
                try { parsed = JSON.parse(text); } catch { parsed = text; }
                resolve({ status: res.statusCode || 0, body: parsed, text });
            });
        });
        req.on('error', (e) => resolve({ status: 0, body: { networkError: e.message }, text: '' }));
        if (body !== undefined) req.write(body);
        req.end();
    });
}
const show = (r: Reply) => `${r.status} ${r.text.slice(0, 200)}`;
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

async function main(): Promise<void> {
    if (process.argv.includes('--child')) return child();
    if (!process.env.BEANPOOL_DATA_DIR) throw new Error('Set BEANPOOL_DATA_DIR to a throwaway directory');
    const core = await import('@beanpool/core');
    const { ed25519 } = await import('@noble/curves/ed25519.js');

    type Id = { pk: string; sign: ReturnType<typeof core.ed25519Signer>; callsign: string };
    const id = (callsign: string): Id => {
        const seed = new Uint8Array(crypto.randomBytes(32));
        return { pk: Buffer.from(ed25519.getPublicKey(seed)).toString('hex'), sign: core.ed25519Signer(seed), callsign };
    };
    const owner = id('Olive'), mia = id('Mia'), xan = id('Xan'), zed = id('Zed');

    /** A member's read of their own standing, signed for `host` as an app that reached the community there signs it. */
    async function readAt(node: Node, who: Id, host: string): Promise<Reply> {
        const url = `https://${host}/api/community/me`;
        const headers = await core.buildBoundRequestHeaders({ method: 'GET', url, body: '', publicKeyHex: who.pk, sign: who.sign });
        return call(node, 'GET', core.signedPathOf(url), headers);
    }
    const info = async (node: Node) => (await call(node, 'GET', '/api/community/info')).body;
    const report = async (node: Node) => {
        await node.send('resetLimits');
        return (await call(node, 'GET', '/api/local/admin/app-addresses', { 'X-Admin-Password': PW })).body;
    };
    const iso = (daysAgo: number) => new Date(Date.now() - daysAgo * 86_400_000).toISOString();
    const entry = (address: string, role: 'current' | 'former', status: string, over: Record<string, unknown> = {}) => ({
        address, role, status, reason: null, since: iso(90), formerSince: role === 'former' ? iso(5) : null,
        heldUntil: null, releasedByUsAt: null, renamedByUsAt: role === 'former' ? iso(5) : null, ...over,
    });

    try {
        console.log('Members still using a community\'s old web address are told where it lives now\n');
        const [L, C, K, F, G, U] = await Promise.all([
            startNode('l', { CF_RECORD_NAME: 'cfname' }),
            startNode('c', { BEANPOOL_ADDRESSES: 'first.test, second.test' }),
            startNode('k', { CF_RECORD_NAME: 'fleetname' }),
            startNode('f', {}),
            startNode('g', {}),
            startNode('u', {}),
        ]);
        for (const n of [L, C, K, F, G, U]) {
            await n.send('seed', { owner: { pk: owner.pk, callsign: owner.callsign }, members: [mia, xan, zed].map((m) => ({ pk: m.pk, callsign: m.callsign })) });
        }

        await section('1', async () => {
            await L.send('nodeConfig', { registrarNames: [entry('livename.beanpool.org', 'current', 'live')] });
            let i = await info(L);
            assert(same(i.addresses, ['cfname.beanpool.org', 'livename.beanpool.org']), `L lists both its names, CF_RECORD_NAME's first (${JSON.stringify(i.addresses)})`);
            assert(i.primaryAddress === 'livename.beanpool.org', `L: its live registrar name is the primary address (${JSON.stringify(i.primaryAddress)})`);
            assert(same(i.formerAddresses, []), `L: no former names (${JSON.stringify(i.formerAddresses)})`);
            await L.send('nodeConfig', { registrarNames: [entry('livename.beanpool.org', 'current', 'paused')] });
            i = await info(L);
            assert(i.primaryAddress === 'cfname.beanpool.org', `L: with the registrar name paused, the first published name is (${JSON.stringify(i.primaryAddress)})`);
            // As a real node stores it (#1275 review 4118422613): the current registrar name is also publicAddress (item 1,
            // and then its only published name), and a rename the registrar hasn't made live yet (a gated one, pending) or a
            // paused name is never the primary address: there is none, so the web app says nothing.
            for (const st of ['pending', 'paused']) {
                await L.send('nodeConfig', { publicAddress: { name: 'livename', mode: 'direct', status: st }, registrarNames: [entry('livename.beanpool.org', 'current', st)] });
                i = await info(L);
                assert(i.primaryAddress === null, `L with publicAddress set: with its registrar name ${st}, no primary address (${JSON.stringify({ p: i.primaryAddress, a: i.addresses })})`);
            }
            await L.send('nodeConfig', { publicAddress: { name: 'livename', mode: 'direct', status: 'live' }, registrarNames: [entry('livename.beanpool.org', 'current', 'live')] });
            i = await info(L);
            assert(i.primaryAddress === 'livename.beanpool.org', `L with publicAddress set: once live, the registrar name is the primary address (${JSON.stringify(i.primaryAddress)})`);
        });

        await section('2', async () => {
            const c = await info(C);
            assert(same(c.addresses, ['first.test', 'second.test']), `C lists its configured names (${JSON.stringify(c.addresses)})`);
            assert(c.primaryAddress === 'first.test', `C: the first configured name is the primary address (${JSON.stringify(c.primaryAddress)})`);
            assert(same(c.formerAddresses, []), `C: no former names (${JSON.stringify(c.formerAddresses)})`);
            const k = await info(K);
            assert(k.primaryAddress === 'fleetname.beanpool.org' && same(k.formerAddresses, []),
                `K (CF_RECORD_NAME only, as the fleet): fleetname.beanpool.org, no former names (${JSON.stringify({ p: k.primaryAddress, f: k.formerAddresses })})`);
        });

        await section('3', async () => {
            await F.send('nodeConfig', {
                publicAddress: { name: 'newname', mode: 'direct', status: 'live' },
                registrarNames: [
                    entry('oldname.beanpool.org', 'former', 'live'),
                    entry('older.beanpool.org', 'former', 'none'),
                    entry('newname.beanpool.org', 'current', 'live', { since: iso(5) }),
                ],
            });
            const i = await info(F);
            assert(same(i.addresses, ['newname.beanpool.org']), `F publishes only its current name (${JSON.stringify(i.addresses)})`);
            assert(i.primaryAddress === 'newname.beanpool.org', `F: newname is the primary address (${JSON.stringify(i.primaryAddress)})`);
            assert(same(i.formerAddresses, ['oldname.beanpool.org', 'older.beanpool.org']), `F: oldname and older are its former names (${JSON.stringify(i.formerAddresses)})`);

            // Accepted as before: this change is about telling members, not which hosts count.
            for (const [who, host] of [[mia, 'oldname.beanpool.org'], [xan, 'oldname.beanpool.org'], [zed, 'older.beanpool.org'], [mia, 'newname.beanpool.org'], [owner, 'newname.beanpool.org']] as const) {
                const r = await readAt(F, who, host);
                assert(r.status === 200 && r.body?.publicKey === who.pk, `F: ${who.callsign}'s app signing for ${host} is accepted (${show(r)})`);
            }
            const other = await readAt(F, mia, 'other.test');
            assert(other.status === 421 && other.body?.code === 'wrong_community', `F: a host that is none of its names is still refused (${show(other)})`);

            const r = await report(F);
            assert(r?.primaryAddress === 'newname.beanpool.org', `Settings: where the community is now (${JSON.stringify(r?.primaryAddress)})`);
            assert(same(r?.formerApps, { today: 3, busiestDay: 3 }),
                `Settings: 3 members' apps reached it by a former name today, newname's not counted (${JSON.stringify(r?.formerApps)})`);
            const row = (a: string) => (r?.addresses ?? []).find((x: any) => x.address === a);
            assert(row('oldname.beanpool.org')?.former === true && row('oldname.beanpool.org')?.today === 2
                && row('older.beanpool.org')?.today === 1 && row('newname.beanpool.org')?.today === 2,
                `Settings: each name's own count, as before (${JSON.stringify(r?.addresses)})`);
        });

        await section('4', async () => {
            await G.send('nodeConfig', {
                registrarNames: [entry('gone.beanpool.org', 'former', 'released', { releasedByUsAt: iso(2), heldUntil: new Date(Date.now() + 28 * 86_400_000).toISOString() })],
            });
            const g = await info(G);
            assert(same(g.addresses, []) && g.primaryAddress === null && same(g.formerAddresses, ['gone.beanpool.org']),
                `G (its only name released): no primary address, the former name listed (${JSON.stringify({ a: g.addresses, p: g.primaryAddress, f: g.formerAddresses })})`);
            const gr = await report(G);
            assert(gr?.primaryAddress === null && same(gr?.formerApps, { today: 0, busiestDay: 0 }),
                `G Settings: no primary address, no apps on former names yet (${JSON.stringify({ p: gr?.primaryAddress, f: gr?.formerApps })})`);
            const u = await info(U);
            assert(same(u.addresses, []) && u.primaryAddress === null && same(u.formerAddresses, []),
                `U (no names): no primary address, no former names (${JSON.stringify({ a: u.addresses, p: u.primaryAddress, f: u.formerAddresses })})`);
        });
    } finally {
        stopAll();
    }

    console.log(`\n${passed}/${run} passed`);
    if (passed !== run) process.exitCode = 1;
}

main().catch((e) => {
    console.error(e);
    stopAll();
    process.exit(1);
});
