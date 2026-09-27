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
 *  1. One ordinary member's app, signing for mullum.beanpool.org and for a random host: both requests are accepted
 *     (unchanged), neither host is offered plainly. Each is held back and says why, with the count (1) and no owner's
 *     or admin's app. The same member signing again still counts as one.
 *  2. The owner's own app → offered, saying an owner's or admin's app reached it. An admin's too. A moderator's is an
 *     ordinary member's. The owner's app signing for a beanpool.org name (a hostile node relaying the owner's own
 *     request makes it look like that) is still held back as another community's; so is beanpool.org itself.
 *  3. Several members: two → held back with the count; three (MEMBERS_TO_OFFER) → offered with the count.
 *  4. A host the directory this node already holds (directory_cache) lists as another community's → held back with
 *     its name, even when an admin's app and three members reached it there.
 *  5. Keys with no member row here count for nothing: not listed, and they move no other host's count.
 *  6. Bounded: one member signing for many hosts puts at most 3 of them on the list, and a real host signed for after
 *     that is still offered; many members' hosts stop at the day's cap (50), in the report, in the counts table and in
 *     the stored owner/admin sightings; a flood of non-member keys adds nothing.
 *  7. A restart: the counts and whether an owner's or admin's app reached a host are still there.
 *  8. Confirming works as before: one tap on an offered host makes it this community's name; requests for it are
 *     accepted and for any other host refused. An owner-confirmed address stays one whatever it is (a beanpool.org
 *     name confirmed before this change is not taken away).
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
    const owner = id('Olive'), ada = id('Ada'), ben = id('Ben'), mo = id('Mo'), mia = id('Mia');
    const members = Array.from({ length: 20 }, (_, i) => id(`M${i + 1}`));
    const [m1, m2, m3, m4, m5, m6, m7] = members;

    const adminPw = { 'X-Admin-Password': PW };
    /** A member's read as a current app sends it: signed for `host`, sent to the node at localhost. */
    async function readAs(node: Node, who: Id, host: string, reqPath = '/api/community/me'): Promise<Reply> {
        const url = `https://${host}${reqPath}`;
        const headers = await core.buildBoundRequestHeaders({ method: 'GET', url, body: '', publicKeyHex: who.pk, sign: who.sign });
        return call(node, 'GET', core.signedPathOf(url), headers);
    }
    let U: Node;
    const report = async () => {
        const r = await call(U, 'GET', '/api/local/admin/app-addresses', adminPw);
        if (r.status !== 200) throw new Error(`the Settings report: ${show(r)}`);
        return r.body as { addresses: { address: string; source: string }[]; unconfirmed: Offer[]; heldBack?: Held[]; membersToOffer?: number; named?: boolean };
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
                { pk: mo.pk, callsign: mo.callsign, role: 'moderator' },
                { pk: mia.pk, callsign: mia.callsign },
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
            assert(random?.reason === 'few-members' && random.busiestDay === 1 && random.today === 1 && random.ownerOrAdmin === false,
                `random-host.example is held back: 1 member's app (the same member four times counts once), no owner's or admin's (${j(random)})`);
            assert(rep.membersToOffer === 3, `the report says how many members' apps it takes (${j(rep.membersToOffer)})`);
        });

        // ── 2. The owner's and an admin's own apps ──
        console.log('\n— 2. the owner\'s and an admin\'s own apps —');
        await section('2', async () => {
            const r = await readAs(U, owner, 'home.example.org');
            assert(r.status === 200 && r.body?.publicKey === owner.pk, `the owner's app reaches U at home.example.org (${show(r)})`);
            await readAs(U, ada, 'admin.example.org');
            await readAs(U, mo, 'mod.example.org');
            const rep = await report();
            const home = offered(rep, 'home.example.org');
            assert(home?.ownerOrAdmin === true && home.busiestDay === 1 && !held(rep, 'home.example.org'),
                `home.example.org is offered, saying an owner's or admin's app reached it (a one-person node confirms its name with one tap) (${j(home)})`);
            const admin = offered(rep, 'admin.example.org');
            assert(admin?.ownerOrAdmin === true && admin.busiestDay === 1, `an admin's app's host is offered too (${j(admin)})`);
            const mod = held(rep, 'mod.example.org');
            assert(!offered(rep, 'mod.example.org') && mod?.reason === 'few-members' && mod.ownerOrAdmin === false,
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
        });

        // ── 3. Several members ──
        console.log('\n— 3. several members\' apps —');
        await section('3', async () => {
            for (const m of [m1, m2]) await readAs(U, m, 'pair.example.org');
            for (const m of [m1, m2, m3]) await readAs(U, m, 'crowd.example.org');
            const rep = await report();
            const pair = held(rep, 'pair.example.org');
            assert(!offered(rep, 'pair.example.org') && pair?.reason === 'few-members' && pair.busiestDay === 2,
                `two members' apps: held back, with the count (${j(pair)})`);
            const crowd = offered(rep, 'crowd.example.org');
            assert(crowd?.busiestDay === 3 && crowd.today === 3 && crowd.ownerOrAdmin === false && !held(rep, 'crowd.example.org'),
                `three members' apps: offered, with the count, and no owner's or admin's app among them (${j(crowd)})`);
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
            assert(offered(rep, 'home.example.org') && !offered(rep, 'home.example.org')?.hasOwnProperty('directory'),
                'a host the directory does not list is offered as before');
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
            assert(offered(after, 'after-flood.example')?.ownerOrAdmin === true, `a host an admin's app reached after the flood is still offered (${j(offered(after, 'after-flood.example'))})`);

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
        });

        // ── 7. A restart ──
        console.log('\n— 7. a restart keeps the counts and the owner/admin sightings —');
        await section('7', async () => {
            await report(); // Settings reading the list writes what memory holds
            await stopNode(U);
            await bootU();
            const rep = await report();
            const home = offered(rep, 'home.example.org');
            assert(home?.ownerOrAdmin === true && home.busiestDay === 1, `after a restart home.example.org is still offered as the owner's app's (${j(home)})`);
            const crowd = offered(rep, 'crowd.example.org');
            assert(crowd?.busiestDay === 3, `crowd.example.org still counts 3 members' apps (${j(crowd)})`);
            assert(held(rep, 'random-host.example')?.reason === 'few-members' && held(rep, 'mullum.beanpool.org')?.reason === 'another-community',
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
