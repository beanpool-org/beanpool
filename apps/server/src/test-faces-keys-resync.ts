/**
 * test-faces-keys-resync.ts — members' face URLs heal on the phones when they change shape (engine/avatar-keys.ts
 * avatarKeysSince, routes/community.ts faceUrlsChangedAfter), over HTTP through the real middleware (startHttpsServer),
 * each boot its own process on the one data dir.
 *
 * Review of #1645: a private preview turned on over a local node's phones left every member's face blank until the
 * phone's next whole directory read. The saved URL had no key (a local node keyed no face), the preview refuses it
 * unsigned, and the phone's members delta (`/api/members?updatedAfter=`, apps/native services/pillar-sync.ts) did not
 * send again a member who had not changed.
 *
 *   1. A local node, no preview: faces at plain URLs that open unsigned. The phone syncs.
 *   2. Restart with PRIVATE_PREVIEW=1: the phone's saved URL is refused, and its next members delta (cursor from before
 *      the switch) carries every member, each face at a keyed URL that opens unsigned (200). A phone that has synced
 *      since gets a plain delta.
 *   3. Restart with the preview off again: the same heal back to plain URLs.
 *   4. Restart with nothing changed: the record is kept, and the delta is byte for byte the delta before the restart.
 *      Sections 1 and 5 print the sha256 of a delta that carries every member, to compare with origin/main's.
 *   5. A global node (faces keyed by guestListingsOnly): its first boot with this record answers no delta whole, and a
 *      restart into the preview changes no face URL and answers no delta whole.
 *   6. A local node from before this record (no rows) restarted straight into the preview: it heals too.
 *
 * Run: BEANPOOL_DATA_DIR=$(mktemp -d) node --import tsx src/test-faces-keys-resync.ts
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import https from 'node:https';
import path from 'node:path';
import readline from 'node:readline';
import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { setMemberPhoto } from '@beanpool/engine';

const SCRIPT = fileURLToPath(import.meta.url);
const PW = 'Faces-Keys-Resync-Pw-4417!';
const TINY_PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/58BAwAI/AL+n1z9zwAAAABJRU5ErkJggg==';
const MIN = 60 * 1000;
/** Every member's row and profile written at this time, so a delta's bytes are the same on every run. */
const WRITTEN = '2026-01-01T00:00:00.000Z';

// ── The node process ───────────────────────────────────────────────────────────────────────

function reply(msg: Record<string, unknown>): void {
    process.stdout.write('@@ ' + JSON.stringify(msg) + '\n');
}

async function child(): Promise<void> {
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
    delete process.env.CF_API_TOKEN;
    delete process.env.CF_ZONE_ID;
    const { initAdminPassword } = await import('./config/local-config.js');
    const { initTls } = await import('./services/tls.js');
    const se = await import('./state-engine.js');
    const { startHttpsServer } = await import('./https-server.js');
    const { db } = await import('./db/db.js');

    initAdminPassword();
    await initTls();
    se.initStateEngine();
    const port = await startHttpsServer(0);
    const row = (key: string) => (db.prepare('SELECT value FROM node_config WHERE key = ?').get(key) as { value: string } | undefined)?.value ?? null;

    const commands: Record<string, (a: any) => unknown> = {
        seed: (a: { owner: { pk: string; callsign: string }; members: { pk: string; callsign: string }[] }) => {
            se.seedGenesisMember(a.owner.pk, a.owner.callsign);
            db.prepare("INSERT OR IGNORE INTO node_roles (member_pubkey, role, granted_by) VALUES (?, 'owner', 'genesis')").run(a.owner.pk);
            setMemberPhoto(db, a.owner.pk, TINY_PNG);
            for (const m of a.members) {
                db.prepare(`INSERT INTO members (public_key, callsign, joined_at, status, updated_at, invited_by, invite_code)
                            VALUES (?, ?, ?, 'active', ?, 'seed', ?)`)
                    .run(m.pk, m.callsign, WRITTEN, WRITTEN, `INV-${m.callsign.toUpperCase()}`);
                setMemberPhoto(db, m.pk, TINY_PNG);
            }
            // Every row as written long ago: a cursor from now leaves them all out of a delta.
            db.prepare('UPDATE members SET joined_at = ?, updated_at = ?, profile_updated_at = ?').run(WRITTEN, WRITTEN, WRITTEN);
            return true;
        },
        records: () => ({ shape: row('avatarKeysShape'), since: row('avatarKeysSince') }),
        // A node from before this record.
        dropRecords: () => db.prepare("DELETE FROM node_config WHERE key IN ('avatarKeysShape', 'avatarKeysSince')").run().changes,
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
    port: number;
    proc: ChildProcess;
    send: (cmd: string, args?: Record<string, unknown>) => Promise<any>;
}

const started: Node[] = [];
let seq = 0;

/** One boot of the node, on data dir `dir`, in its own process group so teardown kills exactly what it started. */
function boot(env: Record<string, string | undefined>, dir: string): Promise<Node> {
    const dataDir = path.join(process.env.BEANPOOL_DATA_DIR!, dir);
    fs.mkdirSync(dataDir, { recursive: true });
    const childEnv: NodeJS.ProcessEnv = { ...process.env, BEANPOOL_DATA_DIR: dataDir, ADMIN_PASSWORD: PW };
    for (const k of ['CF_RECORD_NAME', 'BEANPOOL_ADDRESSES', 'ENFORCE_WS_AUTH', 'ENFORCE_READ_AUTH', 'NODE_PROFILE', 'NODE_ROLE', 'PRIVATE_PREVIEW']) delete childEnv[k];
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
                    port: msg.port, proc,
                    send: (cmd, args = {}) => new Promise((res, rej) => {
                        const id = ++seq;
                        waiting.set(id, (m) => {
                            waiting.delete(id);
                            if (m.error) rej(new Error(`${cmd}: ${m.error}`)); else res(m.result);
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
        proc.on('exit', (code) => reject(new Error(`the node exited (${code}) before it was ready\n${out.slice(-3000)}`)));
    });
}

/** Stops a boot as Docker does (SIGTERM to its group), and waits for it to be gone. */
async function stop(node: Node): Promise<void> {
    if (node.proc.exitCode !== null || node.proc.signalCode !== null) return;
    const gone = new Promise<void>((r) => node.proc.once('exit', () => r()));
    try { process.kill(-node.proc.pid!, 'SIGTERM'); } catch { /* already gone */ }
    const timer = setTimeout(() => { try { process.kill(-node.proc.pid!, 'SIGKILL'); } catch { /* gone */ } }, 8000);
    await gone;
    clearTimeout(timer);
}

function stopAll(): void {
    for (const n of started) {
        try { if (n.proc.pid && n.proc.exitCode === null && n.proc.signalCode === null) process.kill(-n.proc.pid, 'SIGKILL'); } catch { /* already gone */ }
    }
}

let run = 0, passed = 0;
function assert(cond: unknown, msg: string): void {
    run++;
    if (cond) { passed++; console.log(`✓ ${msg}`); } else { console.error(`✗ ${msg}`); process.exitCode = 1; }
}

async function section(n: string, body: () => Promise<void>): Promise<void> {
    console.log(`\n── ${n} ──`);
    try {
        await body();
    } catch (e: any) {
        assert(false, `section ${n} ran to the end (${e?.stack || e})`);
    }
}

interface Reply { status: number; body: any; text: string }

function call(node: Node, method: string, reqPath: string, headers: Record<string, string> = {}): Promise<Reply> {
    return new Promise((resolve) => {
        const req = https.request({ host: 'localhost', port: node.port, path: reqPath, method, rejectUnauthorized: false, headers }, (res) => {
            let text = '';
            res.on('data', (c) => { text += c; });
            res.on('end', () => {
                let parsed: any = null;
                try { parsed = JSON.parse(text); } catch { parsed = text; }
                resolve({ status: res.statusCode || 0, body: parsed, text });
            });
        });
        req.on('error', (e) => resolve({ status: 0, body: { networkError: e.message }, text: '' }));
        req.end();
    });
}
const show = (r: Reply) => `${r.status} ${r.text.slice(0, 160)}`;

async function main(): Promise<void> {
    if (process.argv.includes('--child')) return child();
    if (!process.env.BEANPOOL_DATA_DIR) throw new Error('Set BEANPOOL_DATA_DIR to a throwaway directory');
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
    const core = await import('@beanpool/core');
    const { ed25519 } = await import('@noble/curves/ed25519.js');

    type Id = { pk: string; sign: ReturnType<typeof core.ed25519Signer>; callsign: string };
    // Fixed seeds: the same keys on every run, so a delta's bytes are too.
    const id = (callsign: string): Id => {
        const seed = new Uint8Array(crypto.createHash('sha256').update(`faces-keys-resync|${callsign}`).digest());
        return { pk: Buffer.from(ed25519.getPublicKey(seed)).toString('hex'), sign: core.ed25519Signer(seed), callsign };
    };
    const owner = id('Olive'), alice = id('Alice'), bob = id('Bob'), cara = id('Cara');
    const everyone = [owner, alice, bob, cara].map(m => m.pk).sort();

    async function signed(node: Node, who: Id, reqPath: string): Promise<Reply> {
        const headers = await core.buildBoundRequestHeaders({ method: 'GET', url: `https://localhost:${node.port}${reqPath}`, body: '', publicKeyHex: who.pk, sign: who.sign });
        return call(node, 'GET', reqPath, headers);
    }
    // The phone's members delta (services/pillar-sync.ts), with its cursor: its last sync less five minutes.
    const deltaPath = (lastSync: number) => `/api/members?updatedAfter=${encodeURIComponent(new Date(lastSync - 5 * MIN).toISOString())}`;
    const delta = (node: Node, lastSync: number) => signed(node, alice, deltaPath(lastSync));
    const rows = (r: Reply): any[] => (Array.isArray(r.body) ? r.body : []);
    const pks = (r: Reply) => rows(r).map(m => m.publicKey).filter((pk: string) => everyone.includes(pk)).sort();
    const faces = (r: Reply) => rows(r).filter(m => everyone.includes(m.publicKey)).map(m => m.avatarUrl as string | null);
    const keyed = (u: string | null | undefined) => !!u && /[?&]k=[A-Za-z0-9_-]{22}(&|$)/.test(u);
    /** Every URL as an <img> asks it: unsigned. */
    const opens = async (node: Node, urls: (string | null)[]) => {
        const statuses: number[] = [];
        for (const u of urls) statuses.push(u ? (await call(node, 'GET', u)).status : 0);
        return statuses;
    };
    const allOk = (s: number[]) => s.length === everyone.length && s.every(x => x === 200);
    const seed = (node: Node) => node.send('seed', { owner: { pk: owner.pk, callsign: owner.callsign }, members: [alice, bob, cara].map(m => ({ pk: m.pk, callsign: m.callsign })) });

    // A delta whose cursor is before every member's row (WRITTEN): every member, so its bytes say what a delta holds.
    const OLD_CURSOR = '2025-12-01T00:00:00.000Z';
    const OLD_DELTA = `/api/members?updatedAfter=${encodeURIComponent(OLD_CURSOR)}`;
    const sha = (t: string) => crypto.createHash('sha256').update(t).digest('hex').slice(0, 16);
    const LOCAL = { NODE_PROFILE: 'local' };
    const LOCAL_PREVIEW = { NODE_PROFILE: 'local', PRIVATE_PREVIEW: '1' };

    let node!: Node;
    let lastSync = 0;
    let plainFaces: (string | null)[] = [];
    let keyedFaces: (string | null)[] = [];
    let quietDelta = '';

    try {
        await section('1. a local node, no preview: plain faces, and the phone syncs', async () => {
            node = await boot(LOCAL, 'local');
            await seed(node);
            const rec = await node.send('records');
            assert(rec.shape === 'open', `the face URLs' shape is recorded as plain (${rec.shape})`);
            assert(Date.parse(rec.since) === 0, `no face had changed shape: no delta is answered whole (${rec.since})`);
            const dir = await signed(node, alice, '/api/members');
            plainFaces = faces(dir);
            assert(dir.status === 200 && plainFaces.length === 4 && plainFaces.every(u => !!u && !keyed(u)), `every face at a plain URL (${plainFaces[0]})`);
            assert(allOk(await opens(node, plainFaces)), 'and each opens unsigned');
            lastSync = Date.now();
            const d = await delta(node, lastSync);
            assert(d.status === 200 && pks(d).length === 0, `a delta from now carries no unchanged member (${show(d)})`);
            quietDelta = d.text;
            const old = await signed(node, alice, OLD_DELTA);
            assert(old.status === 200 && JSON.stringify(pks(old)) === JSON.stringify(everyone), `a delta from before every member's last change carries them all (${pks(old).length})`);
            console.log(`   local, no change: delta from ${OLD_CURSOR}: ${old.text.length} bytes, sha256 ${sha(old.text)}`);
            await stop(node);
        });

        await section('2. restart into the private preview: the phone\'s next delta heals every face', async () => {
            node = await boot(LOCAL_PREVIEW, 'local');
            const rec = await node.send('records');
            assert(typeof rec.shape === 'string' && rec.shape.startsWith('keyed:') && Date.parse(rec.since) > lastSync,
                `the shape is keyed, and avatarKeysSince is later than the phone's last sync (${rec.shape} ${rec.since})`);
            const saved = await opens(node, plainFaces);
            assert(saved.every(s => s === 403), `the phone's saved plain URLs are refused unsigned (${saved.join(',')})`);
            const d = await delta(node, lastSync);
            assert(d.status === 200 && JSON.stringify(pks(d)) === JSON.stringify(everyone),
                `the phone's delta from before the switch carries every member (${pks(d).length} of ${everyone.length}: ${show(d)})`);
            keyedFaces = faces(d);
            assert(keyedFaces.every(keyed), `each face at a keyed URL (${keyedFaces[0]})`);
            assert(allOk(await opens(node, keyedFaces)), 'and each opens unsigned (200)');
            const dir = await signed(node, alice, '/api/members');
            assert(JSON.stringify(faces(dir).slice().sort()) === JSON.stringify(keyedFaces.slice().sort()), 'the same URLs the whole directory hands out');
            // The phone synced: its next cursor is that sync less five minutes, inside the change's overlap. A delta.
            lastSync = Date.now();
            const after = await delta(node, lastSync);
            assert(after.status === 200 && pks(after).length === 0, `a phone that has synced since gets a plain delta (${show(after)})`);
            await stop(node);
        });

        await section('3. restart with the preview off again: the same heal back to plain faces', async () => {
            node = await boot(LOCAL, 'local');
            const rec = await node.send('records');
            assert(rec.shape === 'open' && Date.parse(rec.since) > lastSync, `the shape is plain again, and avatarKeysSince moves (${rec.shape} ${rec.since})`);
            const d = await delta(node, lastSync);
            assert(d.status === 200 && JSON.stringify(pks(d)) === JSON.stringify(everyone),
                `the phone's delta from before the switch carries every member (${pks(d).length} of ${everyone.length}: ${show(d)})`);
            const now = faces(d);
            assert(now.every(u => !!u && !keyed(u)), `each face at a plain URL (${now[0]})`);
            assert(allOk(await opens(node, now)), 'and each opens unsigned (200)');
            lastSync = Date.now();
            const after = await delta(node, lastSync);
            assert(after.status === 200 && pks(after).length === 0, `a phone that has synced since gets a plain delta (${show(after)})`);
            await stop(node);
        });

        await section('4. restart with nothing changed: the record kept, the delta the same bytes', async () => {
            node = await boot(LOCAL, 'local');
            const before = await node.send('records');
            await stop(node);
            node = await boot(LOCAL, 'local');
            const rec = await node.send('records');
            assert(rec.shape === before.shape && rec.since === before.since, `the restart keeps the shape and avatarKeysSince (${rec.since})`);
            // A phone whose last sync is after avatarKeysSince but before this restart.
            const d = await delta(node, lastSync);
            assert(d.status === 200 && d.text === quietDelta, `its delta is byte for byte the delta before any change (${d.text.length} bytes)`);
            await stop(node);
        });

        await section('5. a global node: faces were keyed already, so nothing heals', async () => {
            node = await boot({ NODE_PROFILE: 'global' }, 'global');
            await seed(node);
            const first = await node.send('records');
            assert(typeof first.shape === 'string' && first.shape.startsWith('keyed:') && Date.parse(first.since) === 0,
                `its first boot with this record answers no delta whole (${first.shape} ${first.since})`);
            await stop(node);
            // A node from before this record, as global is at its first boot with it: still no heal.
            node = await boot({ NODE_PROFILE: 'global' }, 'global');
            await node.send('dropRecords');
            await stop(node);
            node = await boot({ NODE_PROFILE: 'global' }, 'global');
            const upgraded = await node.send('records');
            assert(upgraded.shape === first.shape && Date.parse(upgraded.since) === 0, `upgraded with members' faces: the same shape, no heal (${upgraded.since})`);
            const dir = await signed(node, alice, '/api/members');
            const held = faces(dir);
            assert(held.length === 4 && held.every(keyed), `faces keyed (${held[0]})`);
            const synced = Date.now();
            const quiet = await delta(node, synced);
            const old = await signed(node, alice, OLD_DELTA);
            assert(old.status === 200 && JSON.stringify(pks(old)) === JSON.stringify(everyone), `a delta from before every member's last change carries them all (${pks(old).length})`);
            // Its keys come from a secret made at its first boot: hashed without them, so two runs compare.
            console.log(`   global, no change: delta from ${OLD_CURSOR}: ${old.text.length} bytes, sha256 without the keys ${sha(old.text.replace(/&k=[A-Za-z0-9_-]{22}/g, ''))}`);
            await stop(node);
            node = await boot({ NODE_PROFILE: 'global', PRIVATE_PREVIEW: '1' }, 'global');
            const rec = await node.send('records');
            assert(rec.shape === first.shape && rec.since === upgraded.since, `into the preview: the same shape, avatarKeysSince kept (${rec.shape} ${rec.since})`);
            const again = faces(await signed(node, alice, '/api/members'));
            assert(JSON.stringify(again) === JSON.stringify(held), 'every face URL the same as before the preview');
            assert(allOk(await opens(node, held)), 'and each saved one opens unsigned (200)');
            const d = await delta(node, synced);
            assert(d.status === 200 && pks(d).length === 0 && d.text === quiet.text, `the phone's delta from before is a plain delta, the same bytes (${show(d)})`);
            await stop(node);
        });

        await section('6. a local node from before this record, restarted straight into the preview: it heals', async () => {
            node = await boot(LOCAL, 'upgrade');
            await seed(node);
            await node.send('dropRecords');
            const synced = Date.now();
            await stop(node);
            node = await boot(LOCAL_PREVIEW, 'upgrade');
            const rec = await node.send('records');
            assert(typeof rec.shape === 'string' && rec.shape.startsWith('keyed:') && Date.parse(rec.since) > synced,
                `with no record, the shape before is the one guestListingsOnly made (plain): a change (${rec.shape} ${rec.since})`);
            const d = await delta(node, synced);
            assert(JSON.stringify(pks(d)) === JSON.stringify(everyone) && faces(d).every(keyed), `the phone's delta carries every member, keyed (${pks(d).length})`);
            assert(allOk(await opens(node, faces(d))), 'and each opens unsigned (200)');
            await stop(node);
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
