/**
 * What Settings offers an owner to confirm as this community's address, on a node that knows none of its names
 * (engine/own-addresses.ts `unconfigured`; engine/address-offers.ts).
 *
 * Until the switch such a node accepts a member's request signed for any host, counts it, and Settings offers each host
 * to confirm. A confirmed host is this community's name for good (own-addresses.ts item 3). Before this, ONE member's
 * app signing for a host was enough to get it offered with one tap, another community's name included
 * (mullum.beanpool.org): an owner talked into that tap made the requests members sign for that community valid here.
 *
 * Every node here is a REAL server, its own process in its own process group, over real HTTPS through the real
 * signature middleware. The requests reach it at localhost; the host each is signed for is the one an app would have
 * connected to. U knows none of its names; its members are an owner, an admin, a moderator and ordinary members.
 *
 * Settings offers with ONE TAP only the host it is open at itself (`?host=`, the host the owner's or admin's browser
 * reaches the node at: the director's call, 2026-09-27, f8). Every other host is shown with its counts and needs a tick
 * before it can be confirmed: members' keys can all be one person's (invites she made for herself), and an operator can
 * relay requests members, or the owner, signed for its own host (4114742184).
 *
 *  1. One ordinary member's app, signing for mullum.beanpool.org and for a random host: both requests are accepted
 *     (unchanged), neither host is offered. Each is held back and says why, with the count (1) and no owner's or
 *     admin's app. The same member signing again still counts as one.
 *  2. The owner's own app, and an admin's: shown with the count and saying an owner's or admin's app reached it, but
 *     not one tap (held back, `not-this-page`) unless Settings is open at that host: then it is offered, and nothing
 *     else is. A moderator's is an ordinary member's. The owner's app signing for a beanpool.org name (a hostile node
 *     relaying the owner's own request makes it look like that) is still held back as another community's, even from a
 *     Settings open at it; so is beanpool.org itself.
 *  3. Several members: two and three → held back with the count, never one tap. One member who made two invites for
 *     herself and redeemed them with fresh keys, her three keys signing for mallory.example (the deciding pass's
 *     sequence, 4114742184) → shown with its count (3), never one tap.
 *  4. A host the directory this node holds (directory_cache: on a node that mirrors it) lists as another community's →
 *     held back with its name, even when an admin's app and three members reached it there. The host Settings is open
 *     at: listed, it is held back with the directory's name though no app reached the node there; not listed, it is
 *     offered with one tap and no count; reached by apps, it is listed once.
 *  5. Keys with no member row here count for nothing: not listed, and they move no other host's count.
 *  6. Bounded: one member signing for many hosts puts at most 3 of them on the list, and a real host signed for after
 *     that is still counted; many members' hosts stop at the day's cap (50), in the report, in the counts table and in
 *     the stored owner/admin sightings; a flood of non-member keys adds nothing. Once members' apps have filled the
 *     day's list, another member's host is left off it, but an admin's app reaching the real address is still counted:
 *     members can't crowd it out.
 *  7. A restart: the counts and whether an owner's or admin's app reached a host are still there.
 *  8. Confirming works as before: one tap on an offered host makes it this community's name; requests for it are
 *     accepted and for any other host refused. An owner-confirmed address stays one whatever it is (a beanpool.org
 *     name confirmed before this change is not taken away). A node with a name doesn't hold back the page's host; once
 *     its confirmed names are removed it does again, in the answer to the remove too.
 *  9. A one-person node (its only member is the owner): Settings open at its domain offers it with one tap before any
 *     app reached it there, with the owner's app's count once it has, and still after the switch; one tap confirms it.
 *     The page's host must be one a member's app could sign for here: something that isn't a host, this machine or
 *     its network, or a beanpool.org name is never offered.
 *
 * The node's switch clock is pinned just before the switch (unboundSignaturesCutoff), so the suite holds for any date.
 *
 *   BEANPOOL_DATA_DIR=$(mktemp -d) pnpm exec tsx apps/server/src/test-address-offers.ts
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import https from 'node:https';
import path from 'node:path';
import readline from 'node:readline';
import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SCRIPT = fileURLToPath(import.meta.url);
const PW = 'Address-Offers-Pw-6613!';
const AVATAR = 'data:image/png;base64,iVBORw0KGgo=';
/** The node_config row the owner/admin sightings are kept in (engine/member-signature.ts). */
const STAFF_ROW = 'appAddressStaffSeen';
/** The switch (ms), read from the node once it is up. */
let SWITCH = 0;

// ── The node process ───────────────────────────────────────────────────────────────────────

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
    const { normaliseRegistryRow, writeDirectoryRows } = await import('./engine/directory-cache.js');
    const { resetGatewayRateLimit } = await import('./gateway-rate-limit.js');
    const { resetAdminAuthTarpit } = await import('./admin-auth.js');

    initAdminPassword();
    await initTls();
    se.initStateEngine();
    const port = await startHttpsServer(0);

    const commands: Record<string, (a: any) => unknown> = {
        seed: (a: { owner: { pk: string; callsign: string }; members: { pk: string; callsign: string; role?: 'admin' | 'moderator' }[] }) => {
            se.seedGenesisMember(a.owner.pk, a.owner.callsign);
            db.prepare("INSERT OR IGNORE INTO node_roles (member_pubkey, role, granted_by) VALUES (?, 'owner', 'genesis')").run(a.owner.pk);
            db.prepare('UPDATE members SET avatar_url = ? WHERE public_key = ?').run(AVATAR, a.owner.pk);
            for (const m of a.members) {
                db.prepare(`INSERT INTO members (public_key, callsign, joined_at, avatar_url, status, updated_at)
                            VALUES (?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'), ?, 'active', strftime('%Y-%m-%dT%H:%M:%fZ','now'))`)
                    .run(m.pk, m.callsign, AVATAR);
                db.prepare('INSERT OR IGNORE INTO accounts (public_key, balance, last_demurrage_epoch) VALUES (?, 0, 0)').run(m.pk);
                if (m.role) db.prepare('INSERT OR IGNORE INTO node_roles (member_pubkey, role, granted_by) VALUES (?, ?, ?)').run(m.pk, m.role, a.owner.pk);
            }
            return true;
        },
        // The directory as the mirror (or a copy from the main server) leaves it in directory_cache: no fetch here.
        directory: (a: { rows: Record<string, unknown>[] }) => {
            const rows = a.rows.map((r) => normaliseRegistryRow(r)).filter((r) => r !== null);
            return writeDirectoryRows(rows as any, new Date().toISOString()).added.length;
        },
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
        nodeConfig: (a: Record<string, unknown>) => {
            se.updateNodeConfig(a as any);
            forgetOwnAddresses();
            return true;
        },
        // What a client can make the node store: the counts rows and the owner/admin sightings.
        unconfirmedRows: () => (db.prepare("SELECT COUNT(*) AS n FROM signature_audiences WHERE kind = 'unconfirmed'").get() as { n: number }).n,
        staffRow: () => (db.prepare('SELECT value FROM node_config WHERE key = ?').get(STAFF_ROW) as { value: string } | undefined)?.value ?? null,
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
    // ACCEPT_UNBOUND_SIGNATURES_UNTIL is kept: a date set for the run is the node's switch.
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

/** Kill one node's process group (this test started it) and wait until it is gone. */
async function stopNode(n: Node): Promise<void> {
    if (!n.proc.pid || n.proc.exitCode !== null) return;
    const gone = new Promise<void>((r) => n.proc.once('exit', () => r()));
    try { process.kill(-n.proc.pid, 'SIGKILL'); } catch { /* already gone */ }
    await gone;
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

interface Offer { address: string; today: number; busiestDay: number; ownerOrAdmin?: boolean }
interface Held extends Offer { reason?: string; directory?: { name: string | null } | null }

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
    // One app puts at most 3 hosts a day on the list, so each step uses keys that haven't reached that.
    const owner = id('Olive'), ada = id('Ada'), ben = id('Ben'), cy = id('Cy'), mo = id('Mo'), mia = id('Mia'), mallory = id('Mallory');
    const members = Array.from({ length: 20 }, (_, i) => id(`M${i + 1}`));
    const [m1, m2, m3, m4, m5, m6, m7] = members;

    const adminPw = { 'X-Admin-Password': PW };
    /** A member's read as a current app sends it: signed for `host`, sent to the node at localhost. */
    async function readAs(node: Node, who: Id, host: string, reqPath = '/api/community/me'): Promise<Reply> {
        const url = `https://${host}${reqPath}`;
        const headers = await core.buildBoundRequestHeaders({ method: 'GET', url, body: '', publicKeyHex: who.pk, sign: who.sign });
        return call(node, 'GET', core.signedPathOf(url), headers);
    }
    /** A member's signed POST, as a current app sends it for `host`. */
    async function postAs(node: Node, who: Id, host: string, reqPath: string, body: unknown): Promise<Reply> {
        const url = `https://${host}${reqPath}`;
        const text = JSON.stringify(body);
        const headers = await core.buildBoundRequestHeaders({ method: 'POST', url, body: text, publicKeyHex: who.pk, sign: who.sign });
        return call(node, 'POST', core.signedPathOf(url), headers, text);
    }
    let U: Node;
    /** The Settings report; `host` is the host Settings reached the node at, sent as it sends it. */
    const report = async (host?: string) => {
        const r = await call(U, 'GET', `/api/local/admin/app-addresses${host ? `?host=${encodeURIComponent(host)}` : ''}`, adminPw);
        if (r.status !== 200) throw new Error(`the Settings report: ${show(r)}`);
        return r.body as { addresses: { address: string; source: string }[]; unconfirmed: Offer[]; heldBack?: Held[]; named?: boolean };
    };
    const offered = (rep: { unconfirmed: Offer[] }, host: string) => rep.unconfirmed.find((u) => u.address === host);
    const held = (rep: { heldBack?: Held[] }, host: string) => (rep.heldBack ?? []).find((u) => u.address === host);
    const listedAnywhere = (rep: { unconfirmed: Offer[]; heldBack?: Held[] }) => [...rep.unconfirmed, ...(rep.heldBack ?? [])].map((u) => u.address);
    const j = (x: unknown) => JSON.stringify(x);
    const beforeSwitch = (n: Node) => n.send('switchClock', { at: SWITCH - 1 });
    const bootU = async () => {
        U = await startNode('u', {});
        await beforeSwitch(U);
        await U.send('resetLimits');
    };

    try {
        console.log('Settings offers a host to confirm only when an owner\'s or admin\'s app, or several members\' apps, reached the node there, and never another community\'s name\n');
        U = await startNode('u', {});
        await U.send('seed', {
            owner: { pk: owner.pk, callsign: owner.callsign },
            members: [
                { pk: ada.pk, callsign: ada.callsign, role: 'admin' },
                { pk: ben.pk, callsign: ben.callsign, role: 'admin' },
                { pk: cy.pk, callsign: cy.callsign, role: 'admin' },
                { pk: mo.pk, callsign: mo.callsign, role: 'moderator' },
                { pk: mia.pk, callsign: mia.callsign },
                { pk: mallory.pk, callsign: mallory.callsign },
                ...members.map((m) => ({ pk: m.pk, callsign: m.callsign })),
            ],
        });
        const cutoff = await U.send('switchCutoff');
        if (typeof cutoff !== 'number') throw new Error('U refuses the old format already (ACCEPT_UNBOUND_SIGNATURES_UNTIL=never?): this suite needs a switch date');
        SWITCH = cutoff;
        console.log(`the switch: ${new Date(SWITCH).toISOString()}; the node's clock is pinned just before it`);
        await beforeSwitch(U);
        const first = await report();
        assert(first.named === false && first.addresses.length === 0, `U knows none of its names (named: ${j(first.named)}, ${j(first.addresses)})`);

        // ── 1. One ordinary member ──
        console.log('\n— 1. one ordinary member\'s app, for another community\'s name and for a random host —');
        await section('1', async () => {
            const toMullum = await readAs(U, mia, 'mullum.beanpool.org');
            const toRandom = await readAs(U, mia, 'random-host.example');
            assert(toMullum.status === 200 && toRandom.status === 200 && toMullum.body?.publicKey === mia.pk,
                `both requests are accepted until the switch, as before (${toMullum.status}, ${toRandom.status})`);
            for (let i = 0; i < 3; i++) await readAs(U, mia, 'random-host.example');
            const rep = await report();
            assert(!offered(rep, 'mullum.beanpool.org'), `mullum.beanpool.org is not offered to confirm (${j(rep.unconfirmed)})`);
            assert(!offered(rep, 'random-host.example'), 'nor is random-host.example');
            const mullum = held(rep, 'mullum.beanpool.org');
            assert(mullum?.reason === 'another-community' && mullum.busiestDay === 1 && mullum.ownerOrAdmin === false,
                `mullum.beanpool.org is held back as another community's name, with 1 member's app and no owner's or admin's (${j(mullum)})`);
            const random = held(rep, 'random-host.example');
            assert(random?.reason === 'not-this-page' && random.busiestDay === 1 && random.today === 1 && random.ownerOrAdmin === false,
                `random-host.example is held back: 1 member's app (the same member four times counts once), no owner's or admin's (${j(random)})`);
        });

        // ── 2. The owner's and an admin's own apps ──
        console.log('\n— 2. the owner\'s and an admin\'s own apps —');
        await section('2', async () => {
            const r = await readAs(U, owner, 'home.example.org');
            assert(r.status === 200 && r.body?.publicKey === owner.pk, `the owner's app reaches U at home.example.org (${show(r)})`);
            await readAs(U, ada, 'admin.example.org');
            await readAs(U, mo, 'mod.example.org');
            const rep = await report();
            const home = held(rep, 'home.example.org');
            assert(!offered(rep, 'home.example.org') && home?.reason === 'not-this-page' && home.ownerOrAdmin === true && home.busiestDay === 1,
                `home.example.org, which the owner's app reached, is not one tap from a Settings open elsewhere: shown with its count, saying an owner's or admin's app reached it (${j(home)})`);
            const atHome = await report('home.example.org');
            const homeOffer = offered(atHome, 'home.example.org');
            assert(homeOffer?.ownerOrAdmin === true && homeOffer.busiestDay === 1 && !held(atHome, 'home.example.org'),
                `from a Settings open at home.example.org it is offered with one tap, saying an owner's or admin's app reached it (${j(homeOffer)})`);
            assert(atHome.unconfirmed.length === 1 && held(atHome, 'admin.example.org')?.reason === 'not-this-page',
                `and nothing else is: one tap is for the page's own host only (${j(atHome.unconfirmed)})`);
            const admin = held(rep, 'admin.example.org');
            assert(!offered(rep, 'admin.example.org') && admin?.reason === 'not-this-page' && admin.ownerOrAdmin === true && admin.busiestDay === 1,
                `an admin's app's host: shown with the count, saying an owner's or admin's app reached it, not one tap (${j(admin)})`);
            const mod = held(rep, 'mod.example.org');
            assert(!offered(rep, 'mod.example.org') && mod?.reason === 'not-this-page' && mod.ownerOrAdmin === false,
                `a moderator's app counts as one member's: held back (${j(mod)})`);

            // A hostile community's operator relaying the owner's own request (signed for that community) here.
            await readAs(U, owner, 'mullum.beanpool.org');
            await readAs(U, owner, 'beanpool.org');
            await readAs(U, ada, 'deep.sub.beanpool.org');
            const after = await report();
            for (const host of ['mullum.beanpool.org', 'beanpool.org', 'deep.sub.beanpool.org']) {
                const h = held(after, host);
                assert(!offered(after, host) && h?.reason === 'another-community' && h.ownerOrAdmin === true,
                    `${host}: the owner's (or an admin's) app signed for it, and it is still not offered: another community's name (${j(h)})`);
            }
            assert(held(after, 'mullum.beanpool.org')?.busiestDay === 2, 'mullum.beanpool.org counts 2 members\' apps now (Mia and the owner)');
            const atMullum = await report('mullum.beanpool.org');
            assert(!offered(atMullum, 'mullum.beanpool.org') && held(atMullum, 'mullum.beanpool.org')?.reason === 'another-community',
                `a Settings open at mullum.beanpool.org is not offered it either: another community's name (${j(atMullum.unconfirmed)})`);
        });

        // ── 3. Several members ──
        console.log('\n— 3. several members\' apps —');
        await section('3', async () => {
            for (const m of [m1, m2]) await readAs(U, m, 'pair.example.org');
            for (const m of [m1, m2, m3]) await readAs(U, m, 'crowd.example.org');
            const rep = await report();
            const pair = held(rep, 'pair.example.org');
            assert(!offered(rep, 'pair.example.org') && pair?.reason === 'not-this-page' && pair.busiestDay === 2,
                `two members' apps: held back, with the count (${j(pair)})`);
            const crowd = held(rep, 'crowd.example.org');
            assert(!offered(rep, 'crowd.example.org') && crowd?.reason === 'not-this-page' && crowd.busiestDay === 3 && crowd.today === 3 && crowd.ownerOrAdmin === false,
                `three members' apps: shown with the count and no owner's or admin's app among them, never one tap (${j(crowd)})`);

            // One member, three keys: two invites she made for herself, redeemed with fresh keys (4114742184).
            await U.send('resetLimits');
            const keys: Id[] = [mallory];
            for (let i = 1; i <= 2; i++) {
                const gen = await postAs(U, mallory, 'mallory.example', '/api/invite/generate', { publicKey: mallory.pk });
                const code = gen.body?.invite?.code;
                const fresh = id(`Mallory${i + 1}`);
                const joined = await call(U, 'POST', '/api/invite/redeem', {}, j({ code, publicKey: fresh.pk, callsign: fresh.callsign }));
                assert(gen.status === 200 && typeof code === 'string' && joined.status === 200 && joined.body?.success === true && !joined.body?.alreadyMember,
                    `Mallory, an ordinary member, makes invite ${i} for herself and redeems it with a fresh key (${show(gen)}; ${show(joined)})`);
                keys.push(fresh);
            }
            const reads: number[] = [];
            for (const k of keys) reads.push((await readAs(U, k, 'mallory.example')).status);
            assert(reads.every((st) => st === 200), `her three keys each sign a read for mallory.example: accepted until the switch, as before (${reads.join(',')})`);
            const after = await report();
            const mal = held(after, 'mallory.example');
            assert(!offered(after, 'mallory.example') && mal?.reason === 'not-this-page' && mal.busiestDay === 3 && mal.ownerOrAdmin === false,
                `mallory.example is shown with its count (3 members' apps, no owner's or admin's), never offered with one tap (${j(mal)}; offered: ${j(after.unconfirmed)})`);
        });

        // ── 4. The directory ──
        console.log('\n— 4. a host the directory lists as another community\'s —');
        await section('4', async () => {
            const added = await U.send('directory', {
                rows: [
                    { node_id: 'riverbend-peer', community_name: 'Riverbend Commons', node_url: 'https://Riverbend.example:8443' },
                    { node_id: 'nameless-peer', node_url: 'nameless.example' },
                ],
            });
            assert(added === 2, `U's directory holds two communities (${added})`);
            for (const who of [ben, m5, m6, m7]) await readAs(U, who, 'riverbend.example');
            for (const who of [ben, m5, m6, m7]) await readAs(U, who, 'nameless.example');
            const rep = await report();
            const river = held(rep, 'riverbend.example');
            assert(!offered(rep, 'riverbend.example') && river?.reason === 'directory' && river.directory?.name === 'Riverbend Commons'
                && river.ownerOrAdmin === true && river.busiestDay === 4,
                `riverbend.example is held back, named as Riverbend Commons in the directory, though an admin's app and 3 members' reached it (${j(river)})`);
            const nameless = held(rep, 'nameless.example');
            assert(!offered(rep, 'nameless.example') && nameless?.reason === 'directory' && nameless.directory !== undefined && nameless.directory?.name === null,
                `a listed community with no name: held back all the same (${j(nameless)})`);
            const home = offered(await report('home.example.org'), 'home.example.org');
            assert(home && !('directory' in home),
                'a host the directory does not list is offered as before, from a Settings open at it');

            // The host Settings reached the node at. Settings suggests it with one tap as the owner's own doing, so the
            // node says when the directory lists it, though no app has reached the node there yet (4114569450).
            const addedPage = await U.send('directory', {
                rows: [
                    { node_id: 'riverbend-peer', community_name: 'Riverbend Commons', node_url: 'https://Riverbend.example:8443' },
                    { node_id: 'nameless-peer', node_url: 'nameless.example' },
                    { node_id: 'hillside-peer', community_name: 'Hillside Co-op', node_url: 'https://hillside.example' },
                ],
            });
            assert(addedPage === 1, `U's directory holds a third community (${addedPage})`);
            const page = await report('https://Hillside.example:8443');
            const hill = held(page, 'hillside.example');
            assert(!offered(page, 'hillside.example') && hill?.reason === 'directory' && hill.directory?.name === 'Hillside Co-op'
                && hill.today === 0 && hill.busiestDay === 0 && hill.ownerOrAdmin === false,
                `the page's host, listed as Hillside Co-op and reached by no app: held back with the directory's name and no count (${j(hill)})`);
            assert(!listedAnywhere(await report()).includes('hillside.example'), 'a report asked for with no host does not list it');
            const quiet = await report('quiet.example');
            const q = offered(quiet, 'quiet.example');
            assert(q?.today === 0 && q.busiestDay === 0 && q.ownerOrAdmin === false && !held(quiet, 'quiet.example') && quiet.unconfirmed.length === 1,
                `a page host the directory does not list, reached by no app: offered with one tap and no count, and nothing else is (${j(quiet.unconfirmed)})`);
            const counted = (await report('riverbend.example')).heldBack?.filter((h) => h.address === 'riverbend.example') ?? [];
            assert(counted.length === 1 && counted[0].busiestDay === 4, `a page host apps reached is listed once, with their count (${j(counted)})`);
        });

        // ── 5. Keys with no member row ──
        console.log('\n— 5. keys with no member row here —');
        await section('5', async () => {
            const strangers = [1, 2, 3, 4].map((i) => id(`Stranger${i}`));
            const statuses: number[] = [];
            for (const s of strangers) {
                statuses.push((await readAs(U, s, 'stranger.example', '/api/community/info')).status);
                statuses.push((await readAs(U, s, 'pair.example.org', '/api/community/info')).status);
            }
            assert(statuses.every((s) => s === 200), `4 keys with no row here each sign two public reads, and are answered as before (${statuses.join(',')})`);
            const rep = await report();
            assert(!listedAnywhere(rep).includes('stranger.example'), `stranger.example is on neither list (${j(listedAnywhere(rep))})`);
            const pair = held(rep, 'pair.example.org');
            assert(pair?.busiestDay === 2 && !offered(rep, 'pair.example.org'), `and pair.example.org still counts 2 members' apps, not 6: still held back (${j(pair)})`);
        });

        // ── 6. Bounded ──
        console.log('\n— 6. a flood of hosts or keys stays bounded —');
        await section('6', async () => {
            await U.send('resetLimits');
            const flood: number[] = [];
            for (let i = 0; i < 12; i++) flood.push((await readAs(U, m4, `flood-${i}.example`)).status);
            assert(flood.every((s) => s === 200), `one member signs for 12 hosts; every request is accepted, as before (${flood.join(',')})`);
            const rep = await report();
            const flooded = listedAnywhere(rep).filter((a) => a.startsWith('flood-'));
            assert(flooded.length === 3, `only 3 of them are listed: one member's app puts at most 3 hosts on the list in a day (${j(flooded)})`);
            await readAs(U, ada, 'after-flood.example');
            const after = await report();
            const afterFlood = held(after, 'after-flood.example');
            assert(afterFlood?.ownerOrAdmin === true && afterFlood.busiestDay === 1,
                `a host an admin's app reached after the flood is still counted, saying an owner's or admin's app reached it (${j(afterFlood)})`);

            // Many members, 3 new hosts each: the day's list stops at its cap.
            await U.send('resetLimits');
            for (const [i, m] of members.entries()) {
                for (let k = 0; k < 3; k++) await readAs(U, m, `many-${i}-${k}.example`);
                if (i % 6 === 5) await U.send('resetLimits');
            }
            const full = await report();
            const all = listedAnywhere(full);
            assert(all.length <= 50 && all.length >= 45, `20 members × 3 more hosts: the list stops at 50 hosts in a day (${all.length})`);
            assert(['mullum.beanpool.org', 'home.example.org', 'crowd.example.org', 'riverbend.example', 'after-flood.example'].every((h) => all.includes(h)),
                'and the hosts already on it are still there');
            const rows = await U.send('unconfirmedRows');
            assert(rows <= 50, `the counts table holds at most 50 of them (${rows})`);
            const staffRow = await U.send('staffRow');
            const staff = staffRow ? Object.keys(JSON.parse(staffRow)) : [];
            assert(staffRow !== null && staff.length <= 50 && staff.includes('home.example.org') && !staff.some((h) => h.startsWith('many-')),
                `the stored owner/admin sightings are bounded and hold only hosts an owner's or admin's app reached (${staff.length}: ${j(staff.slice(0, 12))})`);

            // A flood of throwaway keys adds nothing.
            await U.send('resetLimits');
            const keyFlood: number[] = [];
            for (let i = 0; i < 60; i++) {
                keyFlood.push((await readAs(U, id(`Nobody${i}`), 'keys.example', '/api/community/info')).status);
                if (i % 25 === 24) await U.send('resetLimits');
            }
            const afterKeys = await report();
            assert(keyFlood.every((s) => s === 200) && !listedAnywhere(afterKeys).includes('keys.example') && (await U.send('unconfirmedRows')) === rows,
                `60 throwaway keys signing for keys.example: answered, listed nowhere, nothing stored (${j([...new Set(keyFlood)])})`);

            // The day's list is full of members' hosts. Another member's host is left off it; an admin's app reaching the
            // real address is still counted, so members' apps can't crowd the real one out.
            await U.send('resetLimits');
            const late = await readAs(U, mia, 'late-member.example');
            const real = await readAs(U, cy, 'real-home.example');
            const crowded = await report();
            assert(rows === 50 && late.status === 200 && !listedAnywhere(crowded).includes('late-member.example'),
                `with the day's list full (${rows} hosts), a member's app reaching late-member.example is answered and left off the list (${late.status})`);
            const realHome = held(crowded, 'real-home.example');
            assert(real.status === 200 && realHome?.ownerOrAdmin === true && realHome.busiestDay === 1,
                `an admin's app reaching real-home.example then: still counted, saying an owner's or admin's app reached it (${real.status}, ${j(realHome)})`);
            const realOffer = offered(await report('real-home.example'), 'real-home.example');
            assert(realOffer?.ownerOrAdmin === true && realOffer.busiestDay === 1,
                `and a Settings open at real-home.example offers it with one tap, with that count (${j(realOffer)})`);
            const staffNow = await U.send('staffRow');
            assert(staffNow !== null && Object.keys(JSON.parse(staffNow)).includes('real-home.example'),
                `and stored as an owner/admin sighting (${staffNow})`);
        });

        // ── 7. A restart ──
        console.log('\n— 7. a restart keeps the counts and the owner/admin sightings —');
        await section('7', async () => {
            await report(); // Settings reading the list writes what memory holds
            await stopNode(U);
            await bootU();
            const rep = await report();
            const home = held(rep, 'home.example.org');
            assert(home?.ownerOrAdmin === true && home.busiestDay === 1, `after a restart home.example.org still says the owner's app reached it (${j(home)})`);
            const homeOffer = offered(await report('home.example.org'), 'home.example.org');
            assert(homeOffer?.ownerOrAdmin === true && homeOffer.busiestDay === 1, `and is still offered as the owner's app's from a Settings open at it (${j(homeOffer)})`);
            const crowd = held(rep, 'crowd.example.org');
            assert(crowd?.busiestDay === 3, `crowd.example.org still counts 3 members' apps (${j(crowd)})`);
            assert(held(rep, 'random-host.example')?.reason === 'not-this-page' && held(rep, 'mullum.beanpool.org')?.reason === 'another-community',
                'and the held-back hosts are still held back');
        });

        // ── 8. Confirming, as before ──
        console.log('\n— 8. confirming works as before —');
        await section('8', async () => {
            const noAuth = await call(U, 'POST', '/api/local/admin/app-addresses/confirm', {}, j({ address: 'home.example.org' }));
            assert(noAuth.status === 401 || noAuth.status === 403, `confirming needs an owner or admin (${show(noAuth)})`);
            const confirmed = await call(U, 'POST', '/api/local/admin/app-addresses/confirm', adminPw, j({ address: 'https://Home.Example.org/settings' }));
            assert(confirmed.status === 200 && confirmed.body?.addresses?.some((a: any) => a.address === 'home.example.org' && a.source === 'owner')
                && !listedAnywhere(confirmed.body).includes('home.example.org'),
                `one tap confirms home.example.org: it is on the address list as the owner's, and on neither offer list (${show(confirmed)})`);
            const own = await readAs(U, mia, 'home.example.org');
            const other = await readAs(U, mia, 'crowd.example.org');
            const mullum = await readAs(U, mia, 'mullum.beanpool.org');
            assert(own.status === 200 && other.status === 421 && other.body?.code === 'wrong_community' && mullum.status === 421,
                `now it is this community's name: accepted; any other host, another community's name included → 421 (${own.status}, ${other.status}, ${mullum.status})`);
            const info = await call(U, 'GET', '/api/community/info');
            assert(j(info.body?.addresses) === j(['home.example.org']), `and /api/community/info lists it (${j(info.body?.addresses)})`);

            // An owner-confirmed address stays one, whatever it is: a beanpool.org name confirmed before this change.
            await U.send('nodeConfig', { ownerAddresses: ['home.example.org', 'kept.beanpool.org'] });
            const kept = await readAs(U, mia, 'kept.beanpool.org');
            const rep = await report();
            assert(kept.status === 200 && rep.addresses.some((a) => a.address === 'kept.beanpool.org' && a.source === 'owner') && !listedAnywhere(rep).includes('kept.beanpool.org'),
                `an already-confirmed kept.beanpool.org is still this community's: accepted, listed as confirmed, offered nowhere (${kept.status}, ${j(rep.addresses)})`);

            // The page's host on a node with a name: Settings suggests nothing there, and the node holds nothing back.
            assert(!listedAnywhere(await report('hillside.example')).includes('hillside.example'), 'a named node does not hold back the page\'s host');
            // Removing its confirmed names leaves it none again: the remove's own answer holds the page's host back.
            let removed: Reply | null = null;
            for (const address of ['home.example.org', 'kept.beanpool.org']) {
                removed = await call(U, 'POST', '/api/local/admin/app-addresses/remove?host=hillside.example', adminPw, j({ address }));
            }
            const hill = held(removed!.body, 'hillside.example');
            assert(removed!.status === 200 && removed!.body?.named === false && hill?.directory?.name === 'Hillside Co-op' && !offered(removed!.body, 'hillside.example'),
                `once its confirmed names are removed, the remove's answer holds the page's host back again (${removed ? show(removed) : 'no reply'})`);
        });

        // ── 9. A one-person node, and which page hosts count ──
        console.log('\n— 9. a one-person node confirms its name with one tap, from the page it is using —');
        await section('9', async () => {
            const solo = id('Solo');
            const S = await startNode('s', {});
            await S.send('seed', { owner: { pk: solo.pk, callsign: solo.callsign }, members: [] });
            await beforeSwitch(S);
            await S.send('resetLimits');
            const soloReport = async (host?: string) => {
                const r = await call(S, 'GET', `/api/local/admin/app-addresses${host ? `?host=${encodeURIComponent(host)}` : ''}`, adminPw);
                if (r.status !== 200) throw new Error(`S's Settings report: ${show(r)}`);
                return r.body as { unconfirmed: Offer[]; heldBack?: Held[]; named?: boolean };
            };
            const fresh = await soloReport('https://Solo.example');
            const first = offered(fresh, 'solo.example');
            assert(fresh.named === false && first?.today === 0 && first.busiestDay === 0 && first.ownerOrAdmin === false && fresh.unconfirmed.length === 1
                && (fresh.heldBack ?? []).length === 0,
                `Settings open at solo.example, before any app reached the node there: offered with one tap (${j(fresh)})`);
            const nothing = [
                ['not a host at all', 'not a host!'], ['a home-network address', '192.168.1.20'], ['this machine', 'localhost'],
                ['another community\'s beanpool.org name', 'solo.beanpool.org'], ['beanpool.org itself', 'beanpool.org'],
            ];
            for (const [what, host] of nothing) {
                const r = await soloReport(host);
                assert(r.unconfirmed.length === 0 && (r.heldBack ?? []).length === 0, `a page host that is ${what} (${host}) is never offered (${j(r)})`);
            }
            const app = await readAs(S, solo, 'solo.example');
            assert(app.status === 200 && app.body?.publicKey === solo.pk, `the owner's app reaches S at solo.example (${show(app)})`);
            const counted = offered(await soloReport('solo.example'), 'solo.example');
            assert(counted?.busiestDay === 1 && counted.ownerOrAdmin === true, `then it is offered with the owner's app's count (${j(counted)})`);
            const elsewhere = await soloReport('192.168.1.20');
            assert(elsewhere.unconfirmed.length === 0 && held(elsewhere, 'solo.example')?.reason === 'not-this-page',
                `from a Settings open at the home-network address it is shown with its count, to tick, not one tap (${j(elsewhere)})`);
            await S.send('switchClock', { at: SWITCH + 1000 });
            const refused = await readAs(S, solo, 'solo.example');
            const late = offered(await soloReport('solo.example'), 'solo.example');
            assert(refused.status === 421 && late?.busiestDay === 1, `after the switch the app is refused there, and Settings open at it still offers it with one tap (${refused.status}, ${j(late)})`);
            const confirmed = await call(S, 'POST', '/api/local/admin/app-addresses/confirm?host=solo.example', adminPw, j({ address: 'solo.example' }));
            const now = await readAs(S, solo, 'solo.example');
            assert(confirmed.status === 200 && confirmed.body?.named === true && confirmed.body?.addresses?.some((a: any) => a.address === 'solo.example' && a.source === 'owner')
                && confirmed.body?.unconfirmed?.length === 0 && now.status === 200,
                `one tap confirms it: S's name, and the owner's app is accepted there again (${show(confirmed)}; ${now.status})`);
            await stopNode(S);
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
