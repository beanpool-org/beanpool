/**
 * Test Suite: the open door's key is a file, never in the database (report C12; services/open-join-key.ts). With the key
 * in a node_config row, any copy of the global node's database (a standby's, a snapshot, a backup) could test a known
 * Google `sub` against `open_joins` and learn which member that person is.
 *
 * Every node is its own process with its own data dir (takeover-test-harness.ts), booted as index.ts boots, and the
 * joins go over REAL HTTPS through the real signature middleware. No provider is contacted: each node's Google JWKS
 * cache is primed with a test key.
 *
 *  1. An old database. Ada and Ben joined a global main server, whose key an older version kept as the node_config row
 *     `openJoinSalt`: their records are made with that key, and a snapshot of that database is on disk. A boot killed
 *     (SIGKILL on the node process) between writing data/open-join.key and deleting the row leaves both; the next boot
 *     finishes: the file is the row's key byte for byte, 0600; the row is gone and which key it was is recorded; every
 *     old join_hash still matches its sign-in; Ada from a new key is 409 already_joined with no new member; and the
 *     database, its WAL, the old snapshot and nothing else in the data folder but the file hold a byte of the key.
 *  2. No copy holds the key, in any encoding (raw, base64url, base64, hex): a snapshot made now, the signed replication
 *     payloads a standby pulls (a whole copy and a delta, their bytes as sent), a plain backup (the tar inside its gzip),
 *     and a standby's database after it copied the main server, which holds no key file either and records which key
 *     the rows were made with.
 *  3. A plain backup restored on a new server that had made a key of its own. The restore says in one line that the
 *     backup does not carry the key, and the boot that the door cannot check a sign-in. Failing closed: Ada (a known
 *     sign-in) and a new account are both refused 503 door_key_missing, before the sign-in is checked, and no member or
 *     record is added. With the main server's key file put back by hand, and no restart, Ada is 409 already_joined and
 *     the new account joins.
 *  4. Rolling back past this version (services/open-join-key.ts, the rollback command). With the main server stopped,
 *     `open-join-key --write-key-row` refuses, changing nothing, when the file is missing or is not the records' key.
 *     Otherwise it writes the file back as the `openJoinSalt` row, byte for byte, and prints no key; an older version's
 *     key (the row, decoded as it decodes it) then matches every record, so Ada is not a new member there. Run again, it
 *     changes nothing. Booted on this version again, the row moves out and Ada is still 409.
 *
 * Run:
 *   BEANPOOL_DATA_DIR=$(mktemp -d) pnpm exec tsx src/test-open-join-key-file.ts
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { spawn } from 'node:child_process';
import { spawnNode, runNodeChild, type NodeProc } from './takeover-test-harness.js';

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
delete process.env.GOOGLE_CLIENT_IDS;
delete process.env.CF_RECORD_NAME;

// Nothing in this suite may reach a real identity provider or any other host: every request that is not to this
// machine fails as unreachable.
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    if (url.hostname !== 'localhost' && url.hostname !== '127.0.0.1') throw new TypeError(`this suite reaches no host but this machine (${url.host})`);
    return realFetch(input, init);
}) as typeof fetch;

const SCRIPT = fileURLToPath(import.meta.url);
const KEY_CLI = path.join(path.dirname(SCRIPT), 'services', 'open-join-key.ts');
const PW_MAIN = 'Door-Key-File-Main-Pw-4471!';
const PW_STANDBY = 'Door-Key-File-Standby-Pw-93!';
const PW_RESTORED = 'Door-Key-File-Restored-Pw-26!';
const GOOGLE_KID = 'test-open-join-key-file-google';
const GOOGLE_AUD = '653933790375-vkedasi9cs2aeoo2968ttmscqno484jd.apps.googleusercontent.com';
const KEY_FILE = 'open-join.key';

// ── The node processes' commands ───────────────────────────────────────────────────────────

async function child(): Promise<void> {
    await runNodeChild({
        'setup-primary': async (a: { ownerSeedHex: string; replicationToken: string }) => {
            const { ed25519 } = await import('@noble/curves/ed25519.js');
            const se = await import('./state-engine.js');
            const { setReplicationToken } = await import('./config/local-config.js');
            se.seedGenesisMember(Buffer.from(ed25519.getPublicKey(Buffer.from(a.ownerSeedHex, 'hex'))).toString('hex'), 'Anna');
            setReplicationToken(a.replicationToken);
            return true;
        },
        // The real HTTPS server, signature middleware and all, beside the harness's plain one.
        serve: async (a: { jwk: Record<string, unknown> }) => {
            const { initTls } = await import('./services/tls.js');
            const { startHttpsServer } = await import('./https-server.js');
            const sso = await import('./sso.js');
            await initTls();
            const port = await startHttpsServer(0);
            sso._resetJwksCacheForTests();
            sso._resetJwksCacheForTests('google', { keys: [a.jwk as any], expiresAt: Date.now() + 3600_000 });
            return { port };
        },
        'setup-standby': async (a: { primaryUrl: string; replicationToken: string; primaryPeerId: string }) => {
            const { addConnector } = await import('./connector-manager.js');
            const { updateLocalConfig } = await import('./config/local-config.js');
            addConnector(`/ip4/127.0.0.1/tcp/4998/p2p/${a.primaryPeerId}`, 'mirror', 'main-server', undefined, false);
            updateLocalConfig({ backupPrimaryUrl: a.primaryUrl, backupReplicationToken: a.replicationToken });
            return true;
        },
        pull: async () => {
            const { requestResync } = await import('./services/backup-puller.js');
            return { resync: await requestResync() };
        },
        // The database as an older version left it: the key as the node_config row, the records made with it, no key
        // file and no record of which key. `hashes` are computed by the orchestrator, not by the code under test.
        'plant-old-door': async (a: { keyB64url: string; hashes: { pk: string; hash: string }[] }) => {
            const { db } = await import('./db/db.js');
            db.transaction(() => {
                db.prepare("DELETE FROM node_config WHERE key = 'openJoinKeyId'").run();
                for (const h of a.hashes) db.prepare('UPDATE open_joins SET join_hash = ? WHERE member_pubkey = ?').run(h.hash, h.pk);
                db.prepare("INSERT OR REPLACE INTO node_config (key, value) VALUES ('openJoinSalt', ?)").run(a.keyB64url);
            })();
            fs.rmSync(path.join(process.env.BEANPOOL_DATA_DIR!, KEY_FILE), { force: true });
            db.pragma('wal_checkpoint(TRUNCATE)');
            return true;
        },
        // A snapshot an older version made of that database: a copy holding the row, on disk where snapshots are kept.
        'old-snapshot': async () => {
            const dir = path.join(process.env.BEANPOOL_DATA_DIR!, 'snapshots');
            fs.mkdirSync(dir, { recursive: true });
            const file = path.join(dir, 'beanpool-snapshot-before-c12.db');
            fs.copyFileSync(path.join(process.env.BEANPOOL_DATA_DIR!, 'state.db'), file);
            return file;
        },
        snapshot: async () => {
            const { writeDbSnapshot } = await import('./services/snapshot-scheduler.js');
            const file = path.join(process.env.BEANPOOL_DATA_DIR!, 'snapshots', `beanpool-snapshot-now-${Date.now()}.db`);
            fs.mkdirSync(path.dirname(file), { recursive: true });
            writeDbSnapshot(file);
            return file;
        },
        door: async () => {
            const { db } = await import('./db/db.js');
            const file = path.join(process.env.BEANPOOL_DATA_DIR!, KEY_FILE);
            const config = (key: string) => (db.prepare('SELECT value FROM node_config WHERE key = ?').get(key) as { value?: string } | undefined)?.value ?? null;
            return {
                keyB64: fs.existsSync(file) ? fs.readFileSync(file).toString('base64') : null,
                keyMode: fs.existsSync(file) ? (fs.statSync(file).mode & 0o777).toString(8) : null,
                keyId: config('openJoinKeyId'),
                legacyRow: config('openJoinSalt') !== null,
                rows: db.prepare('SELECT member_pubkey AS member, join_hash AS hash FROM open_joins ORDER BY member_pubkey').all(),
                members: (db.prepare('SELECT COUNT(*) AS n FROM members').get() as { n: number }).n,
            };
        },
        // A key of the server's own, made as the door's first use makes one (a main server with no record).
        'make-own-key': async () => {
            const { openJoinAddressHash } = await import('./engine/open-join.js');
            openJoinAddressHash('198.51.100.7');
            return fs.readFileSync(path.join(process.env.BEANPOOL_DATA_DIR!, KEY_FILE)).toString('base64');
        },
        checkpoint: async () => {
            const { db } = await import('./db/db.js');
            db.pragma('wal_checkpoint(TRUNCATE)');
            return true;
        },
    });
}

// ── The orchestrator ───────────────────────────────────────────────────────────────────────

let testsRun = 0;
let testsPassed = 0;
function assert(cond: unknown, msg: string): void {
    testsRun++;
    if (cond) {
        testsPassed++;
        console.log(`✓ ${msg}`);
    } else {
        console.error(`✗ ${msg}`);
    }
}
/** For a step the rest of the suite cannot run without. */
function require_(cond: unknown, msg: string): void {
    assert(cond, msg);
    if (!cond) throw new Error(`cannot go on: ${msg}`);
}

const google = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const googleJwk = { ...google.publicKey.export({ format: 'jwk' }), kid: GOOGLE_KID, alg: 'RS256', use: 'sig' };

function mintGoogle(sub: string, nonce: string): string {
    const b64 = (obj: unknown) => Buffer.from(JSON.stringify(obj)).toString('base64url');
    const now = Math.floor(Date.now() / 1000);
    const header = b64({ alg: 'RS256', kid: GOOGLE_KID, typ: 'JWT' });
    const payload = b64({ iss: 'https://accounts.google.com', aud: GOOGLE_AUD, sub, email_verified: true, iat: now, exp: now + 3600, nonce });
    return `${header}.${payload}.${crypto.sign('RSA-SHA256', Buffer.from(`${header}.${payload}`), google.privateKey).toString('base64url')}`;
}

interface Id { pk: string; priv: crypto.KeyObject }
function newId(): Id {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    return { pk: (publicKey.export({ type: 'spki', format: 'der' }) as Buffer).subarray(-32).toString('hex'), priv: privateKey };
}

async function signedPost(port: number, id: Id, route: string, body: unknown): Promise<{ status: number; body: any }> {
    const raw = JSON.stringify(body ?? {});
    const ts = Date.now();
    const nonce = crypto.randomBytes(16).toString('hex');
    const res = await fetch(`https://127.0.0.1:${port}${route}`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'X-Public-Key': id.pk,
            'X-Signature': crypto.sign(null, Buffer.from(`POST\n${route}\n${ts}\n${nonce}\n${raw}`), id.priv).toString('base64'),
            'X-Timestamp': String(ts),
            'X-Nonce': nonce,
        },
        body: raw,
    });
    const text = await res.text();
    let json: any = null;
    try { json = JSON.parse(text); } catch { json = text; }
    return { status: res.status, body: json };
}

/**
 * Join through the door at `port` as `id`, signed in with the Google account `sub`. `nonceStatus` is what the nonce
 * route answered, so a refusal there (before any sign-in is checked) can be told from one at the join.
 */
async function join(port: number, id: Id, sub: string, callsign: string): Promise<{ status: number; body: any; at: 'nonce' | 'join' }> {
    const n = await signedPost(port, id, '/api/join/sso-nonce', {});
    if (n.status !== 200) return { ...n, at: 'nonce' };
    return { ...(await signedPost(port, id, '/api/join', { callsign, provider: 'google', idToken: mintGoogle(sub, n.body.nonce), nonce: n.body.nonce })), at: 'join' };
}

/** The join hash as the door makes it (engine/open-join.ts), computed here from the key alone. */
const joinHashOf = (key: Buffer, sub: string) =>
    crypto.createHmac('sha256', key).update(['beanpool-open-join/v1', 'google', sub].join('|'), 'utf-8').digest('base64url');

/** Which key this is, as the database records it (services/open-join-key.ts openJoinKeyId), computed here. */
const keyIdOf = (key: Buffer) =>
    crypto.createHash('sha256').update('beanpool-open-join-key-id/v1\n').update(key).digest('hex').slice(0, 32);

/** Which encodings of `key` appear in `bytes`: raw, base64url, base64 (with and without padding), hex (either case). */
function keyIn(bytes: Buffer, key: Buffer): string[] {
    const forms: [string, Buffer][] = [
        ['raw', key],
        ['base64url', Buffer.from(key.toString('base64url'))],
        ['base64', Buffer.from(key.toString('base64').replace(/=+$/, ''))],
        ['hex', Buffer.from(key.toString('hex'))],
        ['HEX', Buffer.from(key.toString('hex').toUpperCase())],
    ];
    return forms.filter(([, b]) => bytes.includes(b)).map(([n]) => n);
}

/** Every file under `dir` (but `except`) whose bytes hold the key in any encoding, as `path: encodings`. */
function filesHoldingKey(dir: string, key: Buffer, except: (rel: string) => boolean): string[] {
    const hits: string[] = [];
    const walk = (d: string) => {
        for (const e of fs.readdirSync(d, { withFileTypes: true })) {
            const p = path.join(d, e.name);
            const rel = path.relative(dir, p);
            if (e.isDirectory()) walk(p);
            else if (e.isFile() && !except(rel)) {
                const found = keyIn(fs.readFileSync(p), key);
                if (found.length) hits.push(`${rel}: ${found.join('/')}`);
            }
        }
    };
    walk(dir);
    return hits;
}

/** The database file and its WAL, as they lie. */
function dbBytes(dir: string): Buffer {
    return Buffer.concat(['state.db', 'state.db-wal'].map((f) => (fs.existsSync(path.join(dir, f)) ? fs.readFileSync(path.join(dir, f)) : Buffer.alloc(0))));
}

async function getBytes(url: string, headers: Record<string, string>, method = 'GET'): Promise<{ status: number; bytes: Buffer }> {
    const res = await fetch(url, { method, headers });
    return { status: res.status, bytes: Buffer.from(await res.arrayBuffer()) };
}

/** The rollback command, as an operator runs it: its own process, on a stopped server's data folder. */
function runKeyCli(dataDir: string): Promise<{ code: number | null; out: string }> {
    const cli = spawn(process.execPath, [...process.execArgv, KEY_CLI, '--write-key-row'], {
        env: { ...process.env, BEANPOOL_DATA_DIR: dataDir }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    cli.stdout!.on('data', (d) => { out += d.toString(); });
    cli.stderr!.on('data', (d) => { out += d.toString(); });
    return new Promise((resolve) => {
        const timer = setTimeout(() => cli.kill('SIGKILL'), 60_000);
        cli.on('exit', (code) => { clearTimeout(timer); resolve({ code, out }); });
    });
}

/** The node_config rows the rollback is about, read straight from a stopped server's database. */
function keyRows(dataDir: string): { legacy: string | null; keyId: string | null; hashes: Record<string, string>; members: number } {
    const handle = new Database(path.join(dataDir, 'state.db'), { readonly: true });
    try {
        const config = (key: string) => (handle.prepare('SELECT value FROM node_config WHERE key = ?').get(key) as { value?: string } | undefined)?.value ?? null;
        const hashes: Record<string, string> = {};
        for (const r of handle.prepare('SELECT member_pubkey AS pk, join_hash AS hash FROM open_joins').all() as { pk: string; hash: string }[]) hashes[r.pk] = r.hash;
        return { legacy: config('openJoinSalt'), keyId: config('openJoinKeyId'), hashes, members: (handle.prepare('SELECT COUNT(*) AS n FROM members').get() as { n: number }).n };
    } finally {
        handle.close();
    }
}

async function main(): Promise<void> {
    const root = process.env.BEANPOOL_DATA_DIR;
    if (!root) throw new Error('Set BEANPOOL_DATA_DIR to a throwaway directory');
    delete process.env.NODE_PROFILE;
    delete process.env.NODE_PROFILE_ALLOW_CHANGE_FROM;
    // Only the one boot below crashes; this file is also each node's script, so the child keeps what it is given.
    delete process.env.BEANPOOL_TEST_OPEN_JOIN_KEY_CRASH;
    const dirs = { main: path.join(root, 'main'), standby: path.join(root, 'standby'), restored: path.join(root, 'restored') };
    const nodes: NodeProc[] = [];
    const ownerSeedHex = crypto.randomBytes(32).toString('hex');
    const replicationToken = crypto.randomBytes(32).toString('hex');
    const GLOBAL = { NODE_PROFILE: 'global' };
    const mainEnv = { ADMIN_PASSWORD: PW_MAIN, NODE_ROLE: 'primary', ...GLOBAL };
    const ada = newId(), ben = newId();
    const suiteStart = new Date(Date.now() - 1_000).toISOString();

    try {
        // ── 1. An old database: the key in node_config ──
        console.log('\n— 1. an old database, its key as the node_config row; a boot killed half way through the move —');
        let main = await spawnNode(SCRIPT, dirs.main, mainEnv);
        nodes.push(main);
        await main.send('setup-primary', { ownerSeedHex, replicationToken });
        let mainHttps = (await main.send('serve', { jwk: googleJwk })).port as number;
        const adaJoin = await join(mainHttps, ada, 'ada-google-sub', 'Ada');
        const benJoin = await join(mainHttps, ben, 'ben-google-sub', 'Ben');
        require_(adaJoin.status === 200 && benJoin.status === 200, `Ada and Ben join over HTTPS (${adaJoin.status} ${adaJoin.body?.code ?? ''}, ${benJoin.status} ${benJoin.body?.code ?? ''})`);

        // The key an older version made and kept in the row, and the records made with it.
        const oldKey = crypto.randomBytes(32);
        await main.send('plant-old-door', {
            keyB64url: oldKey.toString('base64url'),
            hashes: [{ pk: ada.pk, hash: joinHashOf(oldKey, 'ada-google-sub') }, { pk: ben.pk, hash: joinHashOf(oldKey, 'ben-google-sub') }],
        });
        const oldSnapshot = await main.send('old-snapshot') as string;
        const planted = await main.send('door');
        require_(planted.legacyRow && planted.keyB64 === null && planted.keyId === null && planted.rows.length === 2,
            'the database as an older version left it: the key in node_config, no key file, two records made with the key');
        const membersBefore = planted.members as number;
        await main.kill('SIGKILL');

        let crashed: { code: number | null; output: string } | null = null;
        try {
            const n = await spawnNode(SCRIPT, dirs.main, { ...mainEnv, BEANPOOL_TEST_OPEN_JOIN_KEY_CRASH: 'after-file' });
            nodes.push(n);
            await n.kill();
        } catch (e: any) {
            crashed = { code: e?.code ?? null, output: String(e?.output ?? '') };
        }
        assert(!!crashed && crashed.code === -1 && /test crash after the key file was written/.test(crashed.output),
            `the node process is killed (SIGKILL) between writing the key file and deleting the row (exit ${crashed?.code})`);
        const fileAfterCrash = fs.existsSync(path.join(dirs.main, KEY_FILE)) ? fs.readFileSync(path.join(dirs.main, KEY_FILE)) : null;
        {
            const handle = new Database(path.join(dirs.main, 'state.db'), { readonly: true });
            try {
                const row = handle.prepare("SELECT value FROM node_config WHERE key = 'openJoinSalt'").get() as { value?: string } | undefined;
                assert(!!fileAfterCrash && fileAfterCrash.equals(oldKey) && row?.value === oldKey.toString('base64url'),
                    'it left both: the file, whole, and the row');
            } finally {
                handle.close();
            }
        }

        main = await spawnNode(SCRIPT, dirs.main, mainEnv);
        nodes.push(main);
        require_(main.ready.role === 'primary', 'the next boot starts clean');
        assert(/moved the key for the door's hashes out of the database into data\/open-join\.key/.test(main.output()),
            'and says it moved the key out of the database');
        const moved = await main.send('door');
        const keyNow = moved.keyB64 ? Buffer.from(moved.keyB64, 'base64') : null;
        assert(!!keyNow && keyNow.equals(oldKey) && moved.keyMode === '600', `data/open-join.key is the row's key, byte for byte, 0600 (${moved.keyMode})`);
        assert(!moved.legacyRow && moved.keyId === keyIdOf(oldKey),
            'the row is gone, and the database records which key it was (a hash of it)');
        assert(!!keyNow && moved.rows.length === 2 && moved.rows.every((r: any) => r.hash === joinHashOf(keyNow, r.member === ada.pk ? 'ada-google-sub' : 'ben-google-sub')),
            'every old join_hash still matches its sign-in under the key in the file');
        mainHttps = (await main.send('serve', { jwk: googleJwk })).port as number;
        const adaAgain = await join(mainHttps, newId(), 'ada-google-sub', 'Ada two');
        assert(adaAgain.status === 409 && adaAgain.body?.code === 'already_joined',
            `Ada's Google account, from a new key: 409 already_joined (${adaAgain.status} ${adaAgain.body?.code})`);
        assert((await main.send('door')).members === membersBefore, 'and no member was added');

        await main.send('checkpoint');
        assert(keyIn(dbBytes(dirs.main), oldKey).length === 0, `the database and its WAL hold no byte of the key (${keyIn(dbBytes(dirs.main), oldKey).join(', ') || 'none'})`);
        // The boot's scrub of the copies kept on disk runs in the background (services/address-retention.ts).
        let oldSnapHits: string[] = ['not scrubbed yet'];
        for (let i = 0; i < 100 && oldSnapHits.length; i++) {
            await new Promise((r) => setTimeout(r, 100));
            try {
                const handle = new Database(oldSnapshot, { readonly: true });
                const hasRow = !!handle.prepare("SELECT 1 FROM node_config WHERE key = 'openJoinSalt'").get();
                handle.close();
                oldSnapHits = hasRow ? ['the row'] : keyIn(fs.readFileSync(oldSnapshot), oldKey);
            } catch { /* being rewritten */ }
        }
        assert(oldSnapHits.length === 0, `the snapshot an older version made loses the row at this boot, and holds no byte of the key (${oldSnapHits.join(', ') || 'none'})`);
        const elsewhere = filesHoldingKey(dirs.main, oldKey, (rel) => rel === KEY_FILE);
        assert(elsewhere.length === 0, `nothing in the data folder but data/open-join.key holds the key (${elsewhere.join('; ') || 'none'})`);

        // ── 2. No copy holds the key ──
        console.log('\n— 2. no copy of the database holds the key, in any encoding —');
        const key = keyNow ?? oldKey;
        const snap = await main.send('snapshot') as string;
        assert(keyIn(fs.readFileSync(snap), key).length === 0, `a snapshot made now holds none of it (${keyIn(fs.readFileSync(snap), key).join(', ') || 'none'})`);

        const token = { 'X-Replication-Token': replicationToken };
        const whole = await getBytes(`${main.base}/api/local/admin/sync-snapshot`, token);
        const seed = await getBytes(`${main.base}/api/local/admin/sync-delta`, token);
        const delta = await getBytes(`${main.base}/api/local/admin/sync-delta`, { ...token, 'X-Since-Cursor': suiteStart });
        require_(whole.status === 200 && seed.status === 200 && delta.status === 200,
            `the replication routes answer the standby's token (${whole.status}, ${seed.status}, ${delta.status})`);
        const payloads = [['whole copy', whole.bytes], ['delta from nothing', seed.bytes], ['delta since before the joins', delta.bytes]] as const;
        for (const [what, bytes] of payloads) {
            const parsed = JSON.parse(bytes.toString('utf-8'));
            assert(!!parsed.signature && (parsed.openJoins ?? []).length === 2 && !('openJoinSalt' in parsed) && parsed.openJoinKeyId === moved.keyId,
                `the ${what}, signed, carries the two records and which key made them, and no openJoinSalt`);
            assert(keyIn(bytes, key).length === 0, `…and none of the key, in the bytes as sent (${keyIn(bytes, key).join(', ') || 'none'})`);
        }

        const backup = await getBytes(`${main.base}/api/local/admin/backup`, { 'X-Admin-Password': PW_MAIN }, 'POST');
        require_(backup.status === 200 && backup.bytes.length > 0, `a backup downloads (${backup.status}, ${backup.bytes.length} bytes)`);
        const isGz = backup.bytes[0] === 0x1f && backup.bytes[1] === 0x8b;
        const tar = isGz ? zlib.gunzipSync(backup.bytes) : backup.bytes;
        assert(isGz && tar.includes(Buffer.from('state.db')), 'it is a plain backup: the tar.gz, state.db inside (no recovery code here to lock it)');
        assert(keyIn(tar, key).length === 0 && keyIn(backup.bytes, key).length === 0,
            `the plain backup holds none of the key, in the tar inside its gzip (${keyIn(tar, key).join(', ') || 'none'})`);
        const plainBackup = path.join(root, 'plain-backup.tar.gz');
        fs.writeFileSync(plainBackup, backup.bytes);

        fs.mkdirSync(dirs.standby, { recursive: true });
        fs.copyFileSync(path.join(dirs.main, 'genesis.json'), path.join(dirs.standby, 'genesis.json'));
        const standby = await spawnNode(SCRIPT, dirs.standby, { ADMIN_PASSWORD: PW_STANDBY, NODE_ROLE: 'backup', ...GLOBAL });
        nodes.push(standby);
        await standby.send('setup-standby', { primaryUrl: main.base, replicationToken, primaryPeerId: main.ready.peerId });
        const pulled = await standby.send('pull');
        require_(pulled.resync?.ok, `the standby copies the main server (${JSON.stringify(pulled.resync)})`);
        const copied = await standby.send('door');
        assert(copied.rows.length === 2 && JSON.stringify(copied.rows.map((r: any) => r.hash)) === JSON.stringify(moved.rows.map((r: any) => r.hash)),
            'the standby holds both records, the same hashes');
        assert(copied.keyB64 === null && !copied.legacyRow && copied.keyId === moved.keyId,
            'and no key file, no key row, only which key made them');
        await standby.send('checkpoint');
        const standbyHits = filesHoldingKey(dirs.standby, key, () => false);
        assert(keyIn(dbBytes(dirs.standby), key).length === 0 && standbyHits.length === 0,
            `its database, its WAL and every other file in its data folder hold none of the key (${standbyHits.join('; ') || 'none'})`);
        await standby.kill();

        // ── 3. A plain backup restored on a new server ──
        console.log('\n— 3. a plain backup restored on a new server that made a key of its own —');
        fs.mkdirSync(dirs.restored, { recursive: true });
        fs.copyFileSync(path.join(dirs.main, 'genesis.json'), path.join(dirs.restored, 'genesis.json'));
        const restoredEnv = { ADMIN_PASSWORD: PW_RESTORED, NODE_ROLE: 'primary', ...GLOBAL };
        let restored = await spawnNode(SCRIPT, dirs.restored, restoredEnv);
        nodes.push(restored);
        const ownKey = Buffer.from(await restored.send('make-own-key') as string, 'base64');
        require_(ownKey.length === 32 && !ownKey.equals(key), 'the new server made a key of its own at the door\'s first use');
        const answer = await fetch(`${restored.base}/api/local/admin/restore`, {
            method: 'POST', headers: { 'X-Admin-Password': PW_RESTORED, 'Content-Type': 'application/octet-stream' }, body: fs.readFileSync(plainBackup),
        });
        const restoreBody = await answer.json() as any;
        require_(answer.status === 200 && restoreBody.success === true && restoreBody.sealed === false, `the plain backup restores (${answer.status} ${restoreBody.error ?? ''})`);
        const RESTORE_LINE = 'Open door: this server holds 2 sign-in records of members who joined through the open door, but this backup does not carry the key they were made with';
        assert(restoreBody.openDoor?.records === 2 && restoreBody.openDoor.message.startsWith(RESTORE_LINE),
            `the restore says, in its answer, that the door cannot check a sign-in (${restoreBody.openDoor?.message})`);
        const restoreLog = restored.output().split('\n').filter((l) => l.includes(RESTORE_LINE));
        assert(restoreLog.length === 1, `and logs it in one line (${restoreLog.length})`);
        assert(await restored.exited === 0, 'the server restarts itself after the restore');
        restored = await spawnNode(SCRIPT, dirs.restored, restoredEnv);
        nodes.push(restored);
        const BOOT_LINE = 'Open door: this server holds 2 sign-in records of members who joined through the open door, but data/open-join.key is not the key they were made with';
        const bootLines = restored.output().split('\n').filter((l) => l.includes(BOOT_LINE));
        assert(bootLines.length === 1, `its boot says so, once (${bootLines.length})`);
        const before = await restored.send('door');
        assert(before.keyB64 === ownKey.toString('base64') && before.keyId === moved.keyId && before.rows.length === 2,
            'it holds the backup\'s two records and which key made them, and still its own key');
        const restoredHttps = (await restored.send('serve', { jwk: googleJwk })).port as number;
        const adaShut = await join(restoredHttps, newId(), 'ada-google-sub', 'Ada three');
        assert(adaShut.status === 503 && adaShut.body?.code === 'door_key_missing' && adaShut.at === 'nonce',
            `Ada (a known sign-in), from a new key: refused 503 door_key_missing before any sign-in is checked (${adaShut.status} ${adaShut.body?.code} at ${adaShut.at})`);
        const newShut = await join(restoredHttps, newId(), 'cara-google-sub', 'Cara');
        assert(newShut.status === 503 && newShut.body?.code === 'door_key_missing', `a new account too: it cannot be told from one already here (${newShut.status})`);
        // Straight to the join with a nonce from another route's nonce: the join itself refuses too, before the token.
        const direct = await signedPost(restoredHttps, newId(), '/api/join', { callsign: 'Dora', provider: 'google', idToken: mintGoogle('ada-google-sub', 'x'), nonce: 'x' });
        assert(direct.status === 503 && direct.body?.code === 'door_key_missing', `the join itself refuses a known sign-in the same way (${direct.status} ${direct.body?.code})`);
        const shut = await restored.send('door');
        assert(shut.members === before.members && shut.rows.length === 2, `no member and no record was added (${shut.members} / ${before.members})`);

        fs.copyFileSync(path.join(dirs.main, KEY_FILE), path.join(dirs.restored, KEY_FILE));
        const adaBack = await join(restoredHttps, newId(), 'ada-google-sub', 'Ada four');
        assert(adaBack.status === 409 && adaBack.body?.code === 'already_joined',
            `with the main server's key file put back by hand, no restart: Ada is 409 already_joined (${adaBack.status} ${adaBack.body?.code})`);
        const cara = await join(restoredHttps, newId(), 'cara-google-sub', 'Cara');
        assert(cara.status === 200, `and the new account joins (${cara.status} ${cara.body?.code ?? ''})`);
        assert((await restored.send('door')).members === before.members + 1, 'one member added: Cara');
        await restored.kill();

        // ── 4. Rolling back past this version ──
        console.log('\n— 4. rolling back past this version: the key written back as the row an older version reads —');
        await main.kill();
        const mainKey = fs.readFileSync(path.join(dirs.main, KEY_FILE));
        const beforeCli = keyRows(dirs.main);
        require_(beforeCli.legacy === null && beforeCli.keyId === keyIdOf(mainKey) && Object.keys(beforeCli.hashes).length === 2,
            'setup: the stopped main server holds its two records, which key made them, and no key row');

        // Refusals first, each on a copy of that data folder: an older version could not recognise the accounts.
        const copyOfMain = (label: string) => {
            const d = path.join(root, label);
            fs.mkdirSync(d, { recursive: true });
            for (const f of ['state.db', 'state.db-wal', 'state.db-shm', 'genesis.json']) {
                if (fs.existsSync(path.join(dirs.main, f))) fs.copyFileSync(path.join(dirs.main, f), path.join(d, f));
            }
            return d;
        };
        const noKeyDir = copyOfMain('rollback-no-key');
        const noKey = await runKeyCli(noKeyDir);
        assert(noKey.code === 1 && /Nothing was changed: data\/open-join\.key is missing, and 2 sign-in records need it/.test(noKey.out)
            && keyRows(noKeyDir).legacy === null,
            `with no key file, the command refuses and writes no row (exit ${noKey.code}: ${noKey.out.trim().split('\n').pop()})`);
        const otherKeyDir = copyOfMain('rollback-other-key');
        fs.writeFileSync(path.join(otherKeyDir, KEY_FILE), crypto.randomBytes(32), { mode: 0o600 });
        const otherKey = await runKeyCli(otherKeyDir);
        assert(otherKey.code === 1 && /Nothing was changed: data\/open-join\.key is not the key the 2 sign-in records here were made with/.test(otherKey.out)
            && keyRows(otherKeyDir).legacy === null,
            `with a key file that is not the records' key, it refuses and writes no row (exit ${otherKey.code}: ${otherKey.out.trim().split('\n').pop()})`);

        const cli = await runKeyCli(dirs.main);
        assert(cli.code === 0 && /Wrote data\/open-join\.key as node_config openJoinSalt, for the 2 sign-in records/.test(cli.out),
            `the command writes the key back as the row (exit ${cli.code}: ${cli.out.trim().split('\n').pop()})`);
        assert(keyIn(Buffer.from(cli.out), mainKey).length === 0, `and prints none of the key (${keyIn(Buffer.from(cli.out), mainKey).join(', ') || 'none'})`);
        const afterCli = keyRows(dirs.main);
        assert(afterCli.legacy === mainKey.toString('base64url'), 'the row is the file\'s key, byte for byte, in base64url as an older version stored it');
        assert(fs.readFileSync(path.join(dirs.main, KEY_FILE)).equals(mainKey) && afterCli.keyId === beforeCli.keyId,
            'the file and the recorded id stay, for coming back to this version');
        // What an older version does (engine/open-join.ts nodeKey on origin/main): the row, decoded from base64url, is the
        // key; with it, every record matches its sign-in, so Ada's account is found, not joined again.
        const olderKey = Buffer.from(afterCli.legacy ?? '', 'base64url');
        assert(olderKey.length >= 16 && afterCli.hashes[ada.pk] === joinHashOf(olderKey, 'ada-google-sub')
            && afterCli.hashes[ben.pk] === joinHashOf(olderKey, 'ben-google-sub'),
            'the key an older version reads from the row matches Ada\'s and Ben\'s records');
        const again = await runKeyCli(dirs.main);
        assert(again.code === 0 && /The database already held/.test(again.out) && keyRows(dirs.main).legacy === afterCli.legacy,
            `run again, it changes nothing (exit ${again.code})`);

        main = await spawnNode(SCRIPT, dirs.main, mainEnv);
        nodes.push(main);
        assert(/moved the key for the door's hashes out of the database into data\/open-join\.key/.test(main.output()) && !/🚨 Open door/.test(main.output()),
            'booted on this version again, the row moves out, with no mismatch');
        const forward = await main.send('door');
        assert(!forward.legacyRow && forward.keyId === beforeCli.keyId && Buffer.from(forward.keyB64 ?? '', 'base64').equals(mainKey),
            'the row is gone, the file and the id are as they were');
        mainHttps = (await main.send('serve', { jwk: googleJwk })).port as number;
        const adaForward = await join(mainHttps, newId(), 'ada-google-sub', 'Ada five');
        assert(adaForward.status === 409 && adaForward.body?.code === 'already_joined' && (await main.send('door')).members === forward.members,
            `and Ada is still 409 already_joined, no member added (${adaForward.status} ${adaForward.body?.code})`);
    } finally {
        for (const n of nodes) await n.kill();
    }

    console.log(`\n${testsPassed}/${testsRun} checks passed.`);
    if (testsPassed !== testsRun) throw new Error(`${testsRun - testsPassed} check(s) failed`);
    console.log('⭐️ The open door\'s key is a file: no copy of the database holds it, and without it the door stays shut.');
}

if (process.argv.includes('--child')) {
    child().catch((e) => {
        console.error('child failed:', e);
        process.exit(1);
    });
} else {
    main().then(() => process.exit(0)).catch((e) => {
        console.error('❌ Test failed:', e?.message || e);
        process.exit(1);
    });
}
