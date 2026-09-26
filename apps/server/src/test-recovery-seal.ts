/**
 * The node locks every sign-in recovery copy with a key kept outside its database (recovery seal S1:
 * services/recovery-seal-key.ts, engine/recovery-shares.ts). Over real HTTP, through the real signature
 * middleware, with the round-trip suite's Google fixture (test-sso-recovery-roundtrip.ts):
 *
 *   1. after a deposit, the database FILE holds none of the client's seed box, salt or words box;
 *   2. a copy of state.db, opened in a second process with no key file, does not open with the sub;
 *   3. the same copy beside the key file opens, to the same seed;
 *   4. with the key file deleted at runtime, a deposit is refused (503, the sentence) and stores nothing, and a
 *      collect answers the sentence;
 *   5. rows written before the wrap (the frozen 1b fixtures) are wrapped by the migration, a second run changes
 *      nothing, and they still recover end to end;
 *   6. a released row in recovery_releases holds none of the inner bytes, and the fragments route hands back
 *      exactly what the client deposited;
 *   7. the reverse migration (the rollback command, run as a command) restores the rows byte for byte;
 *   8. a standby (NODE_ROLE=backup) makes no key file, a main server makes one (0600), and an unreadable key
 *      file never stops a boot;
 *   9. moving a member to a new key (the re-key wizard) keeps their copy openable, and stamps what it moves;
 *  10. without the key file, a re-key is refused and changes nothing, and the same code works once the key is back;
 *  11. a copy locked with another key stays under the old key it is bound to, and the re-key does not wait on it.
 *  12. copies a main server dropped BEFORE the seal (re-deposits, removals, a purge, the way the code before it deleted:
 *      secure_delete off) are gone from state.db and its WAL after the upgrade's boot: one VACUUM, once, retried at the
 *      next boot when the disk has no room, and posts' search still finds the right post after it;
 *  13. the same on a standby, which never wraps: its one VACUUM waits until the main server's wrapped copies have
 *      replaced its own, runs after the import that does it (here, a force-resync past copies the main deleted), and
 *      leaves none of the copies it replaced or dropped in its files;
 *  14. a data folder without hard links (link() fails with EPERM, ENOTSUP, EMLINK, ENOSYS or EXDEV) still gets its key,
 *      made in place, never over a file already there, and a failed write leaves nothing behind.
 *
 *   BEANPOOL_DATA_DIR=$(mktemp -d) pnpm exec tsx src/test-recovery-seal.ts
 *
 * The second processes are this file again, with RECOVERY_SEAL_CHILD set; each gets its own data directory and is
 * stopped with this run however it ends.
 */

// Self-signed cert in LAN mode → relax TLS verification for the test client only.
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
delete process.env.CF_RECORD_NAME; // force self-signed / LAN mode

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { sealSeedToSso, openSeedFromSso, openShareFromSso } from '@beanpool/core';

const SCRIPT = fileURLToPath(import.meta.url);
const SEAL_CLI = path.join(path.dirname(SCRIPT), 'services', 'recovery-seal-key.ts');
const CHILD = process.env.RECOVERY_SEAL_CHILD;

/** The design's sentence (§4 "Where"), word for word: what a server without its key says. */
const SENTENCE = 'This server holds sign-in recovery copies it cannot open: data/recovery-seal.key is missing.';
const KEY_FILE = 'recovery-seal.key';

// ── fixtures (test-sso-recovery-roundtrip.ts) ─────────────────────────────────────────────────────
const GOOGLE_KID = 'test-recovery-seal-google-kid';
const GOOGLE_AUD = '653933790375-vkedasi9cs2aeoo2968ttmscqno484jd.apps.googleusercontent.com';
const GOOGLE_SUB = '110169484474386276334';
/** A test phrase, not an account. seed = SHA256(SHA256(words)), as both apps derive it. */
const WORDS = 'abandon ability able about above absent absorb abstract absurd abuse access accident'.split(' ');
const SEED = crypto.createHash('sha256').update(crypto.createHash('sha256').update(WORDS.join(' ')).digest()).digest();

/** 1b: copies sealed by origin/main's sealSeedToSso and ssoLookupHash at 7f92bd8e, before any wrap existed. */
const OLD_SEED_HEX = 'cdb6f28510570568bd01d9b982312020b785e3847664cbfb6ee753425085de9e';
const OLD_LOOKUP_SALT = 'S1-old-enrolment-lookup-salt';
const OLD_ENROLMENTS = [
    {
        provider: 'google',
        sub: '104729384756102938475',
        lookupHash: '-YIm_AtQgZa5zOM4Eh_-j80Ae5R5287GVhyPxMQSpY8',
        sealed: {
            encryptedShare: 'YRS1xq1OhCe0aLFLR06B9MRqj33l+c8QiyE9g7f5SyE=',
            shareIv: 'x8qPfZ/8xacJuwXBtdtOwJC/wUGx3lr0',
            shareTag: 'UJJwcoVHxrysQnywAsoAqg==',
            kdfParams: '{"alg":"scrypt-xc20p-single-v1","salt":"lCAsfDPf6FmyKHL7tGQT+wPYIrUMUZiDSZQYYHsU7dc=","N":16384,"r":8,"p":1}',
        },
    },
    {
        provider: 'facebook',
        sub: '2718281828459045',
        lookupHash: 'W2ArgJjZyHbXaMlPtZ6HvQe9LEZ13_fbNMJcL4yiXyc',
        sealed: {
            encryptedShare: '1kGt6XHXTzy5EeRlKA3aFysAbX/B8xNinFHcSVaaFDE=',
            shareIv: 'gm0Zee4o8UYUrVSOTbPg2E0hqnWcjfzM',
            shareTag: 'AkyT9x4sncyx30vs2vLCtg==',
            kdfParams: '{"alg":"scrypt-xc20p-single-v1","salt":"OomrCz8p0MKmpuIHvp2M4Rl/VAeLqqECQCRJe9oXQB4=","N":16384,"r":8,"p":1}',
        },
    },
] as const;

interface Sealed { encryptedShare: string; shareIv: string; shareTag: string; kdfParams: string }

/** A copy shaped as the apps seal one (seed box, salt, words box), with random bytes: what 12 and 13 look for. */
function fakeCopy(): Sealed {
    const b64 = (n: number) => crypto.randomBytes(n).toString('base64');
    return {
        encryptedShare: b64(48), shareIv: b64(24), shareTag: b64(16),
        kdfParams: JSON.stringify({ alg: 'scrypt-xc20p-single-v1', salt: b64(32), N: 16384, r: 8, p: 1, words: { ct: b64(120), iv: b64(24), tag: b64(16) } }),
    };
}

const CLEARED_KEY = 'recovery_seal_cleared';
const FTS_PROBE_WORD = 'sealprobe40';

// ── identities ─────────────────────────────────────────────────────────────────────────────────────
interface Id { pk: string; priv: crypto.KeyObject; seed: Buffer }
function idFromSeed(seed: Buffer): Id {
    const priv = crypto.createPrivateKey({
        key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), seed]),
        format: 'der', type: 'pkcs8',
    });
    const pk = (crypto.createPublicKey(priv).export({ type: 'spki', format: 'der' }) as Buffer).subarray(-32).toString('hex');
    return { pk, priv, seed };
}
const newId = (): Id => idFromSeed(crypto.randomBytes(32));

// ── child processes: this file again, in a data directory of its own ──────────────────────────────
const children = new Set<ChildProcess>();
const ownedDirs = new Set<string>();
process.on('exit', () => {
    for (const c of children) c.kill('SIGTERM');
    for (const d of ownedDirs) fs.rmSync(d, { recursive: true, force: true });
});
for (const sig of ['SIGTERM', 'SIGINT', 'SIGHUP'] as const) {
    process.on(sig, () => process.exit(128 + os.constants.signals[sig]));
}

function tempDir(label: string): string {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), `recovery-seal-${label}-`));
    ownedDirs.add(d);
    return d;
}

interface ChildResult { code: number | null; stdout: string; stderr: string }
function runChild(args: string[], dataDir: string, env: Record<string, string>): Promise<ChildResult> {
    const child = spawn(process.execPath, [...process.execArgv, ...args], {
        env: { ...process.env, BEANPOOL_DATA_DIR: dataDir, ...env } as NodeJS.ProcessEnv,
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    children.add(child);
    let stdout = '', stderr = '';
    child.stdout!.on('data', (d) => { stdout += d.toString(); });
    child.stderr!.on('data', (d) => { stderr += d.toString(); });
    return new Promise((resolve) => {
        const timer = setTimeout(() => child.kill('SIGKILL'), 60_000);
        child.on('exit', (code, signal) => {
            clearTimeout(timer);
            children.delete(child);
            resolve({ code: code ?? (signal ? -1 : null), stdout, stderr });
        });
    });
}

/** A child's answer: the last stdout line that starts with RESULT. */
function resultOf(r: ChildResult): any {
    const line = r.stdout.split('\n').reverse().find(l => l.startsWith('RESULT '));
    if (!line) throw new Error(`child gave no result (exit ${r.code}): ${r.stderr.slice(-800)}`);
    return JSON.parse(line.slice('RESULT '.length));
}

const thrown = (e: unknown) => `threw: ${(e as Error)?.message ?? String(e)}`;

/** The second process. Only ever run by runChild. */
async function child(mode: string): Promise<void> {
    const out: Record<string, unknown> = {};
    const dataDir = process.env.BEANPOOL_DATA_DIR!;
    if (mode === 'open-without-key' || mode === 'open-with-key') {
        const owner = process.env.SEAL_OWNER!;
        // What anyone holding the file does first: read the row as it lies, and try the sub on it.
        const raw = new Database(path.join(dataDir, 'state.db'), { readonly: true });
        const row = raw.prepare("SELECT * FROM recovery_shares WHERE owner_pubkey = ? AND holder_type = 'sso'").get(owner) as any;
        raw.close();
        out.rowFound = !!row;
        try {
            await openSeedFromSso(
                { encryptedShare: row.encrypted_share, shareIv: row.share_iv, shareTag: row.share_tag, kdfParams: row.kdf_params },
                'google', GOOGLE_SUB,
            );
            out.asStored = 'opened';
        } catch (e) { out.asStored = thrown(e); }
        // And the most they could hope for: the client's own kdfParams (its salt), which the row no longer shows.
        try {
            await openSeedFromSso(
                { encryptedShare: row.encrypted_share, shareIv: row.share_iv, shareTag: row.share_tag, kdfParams: process.env.SEAL_CLIENT_KDF! },
                'google', GOOGLE_SUB,
            );
            out.withClientSalt = 'opened';
        } catch (e) { out.withClientSalt = thrown(e); }
        // Then this server's own reader, on that copy.
        try {
            const { getCurrentShares } = await import('./engine/recovery-shares.js');
            const sso = getCurrentShares(owner).find(s => s.holderType === 'sso')!;
            const opened = await openSeedFromSso(
                { encryptedShare: sso.encryptedShare, shareIv: sso.shareIv, shareTag: sso.shareTag, kdfParams: sso.kdfParams ?? '' },
                'google', GOOGLE_SUB,
            );
            out.serverReader = 'opened';
            out.seedHex = Buffer.from(opened.seed).toString('hex');
            out.words = opened.words;
        } catch (e) { out.serverReader = thrown(e); }
    } else if (mode === 'boot') {
        if (process.env.SEAL_FREE_BYTES) {
            const seal: any = await import('./services/recovery-seal-key.js');
            seal._setFreeBytesForTests?.(Number(process.env.SEAL_FREE_BYTES));
        }
        try {
            const { initStateEngine } = await import('./state-engine.js');
            initStateEngine();
            out.booted = true;
        } catch (e) { out.booted = thrown(e); }
        const keyPath = path.join(dataDir, KEY_FILE);
        out.keyExists = fs.existsSync(keyPath);
        if (out.keyExists) {
            out.keyBytes = fs.statSync(keyPath).size;
            out.keyMode = (fs.statSync(keyPath).mode & 0o777).toString(8);
        }
        const { db } = await import('./db/db.js');
        out.secureDelete = db.pragma('secure_delete', { simple: true });
        out.cleared = (db.prepare('SELECT value FROM node_config WHERE key = ?').get(CLEARED_KEY) as any)?.value ?? null;
        if (process.env.SEAL_FTS_PROBE) {
            try { db.exec("INSERT INTO posts_fts(posts_fts, rank) VALUES ('integrity-check', 1)"); out.ftsIntegrity = 'ok'; }
            catch (e) { out.ftsIntegrity = thrown(e); }
            out.ftsHit = db.prepare('SELECT p.id FROM posts p WHERE p.rowid IN (SELECT rowid FROM posts_fts WHERE posts_fts MATCH ?)')
                .pluck().all(FTS_PROBE_WORD);
        }
    } else if (mode === 'pre-seal-node') {
        // A database as the code before the seal left it: the schema, then copies deposited, re-deposited, removed and
        // purged the way that code did it, on a connection with secure_delete off (its default; db.ts turns it on now).
        const { db, initSchema } = await import('./db/db.js');
        initSchema();
        db.pragma('secure_delete = 0');
        const standby = process.env.SEAL_FIXTURE === 'standby';
        const N = 30;
        const owners = Array.from({ length: N }, () => crypto.randomBytes(32).toString('hex'));
        const gen1 = owners.map(() => fakeCopy());
        const gen2 = owners.map(() => fakeCopy());
        const T = '2026-06-01T00:00:00.000Z';
        const dropOlder = db.prepare('DELETE FROM recovery_shares WHERE owner_pubkey = ? AND generation < ?');
        // A main server stored a deposit with a plain INSERT (putShareGeneration); a standby with sync.ts's own statement.
        const put = db.prepare(`INSERT${standby ? ' OR REPLACE' : ''} INTO recovery_shares
            (owner_pubkey, holder_type, holder_ref, share_index, encrypted_share, share_iv, share_tag, ephemeral_pubkey,
             sso_lookup_hash, sso_lookup_salt, kdf_params, generation, created_at, updated_at)
            VALUES (?, 'sso', 'google', 1, ?, ?, ?, NULL, ?, 'lookup-salt', ?, ?, ?, ?)`);
        const deposit = (i: number, c: Sealed, generation: number) => {
            dropOlder.run(owners[i], generation);
            put.run(owners[i], c.encryptedShare, c.shareIv, c.shareTag, `lookup-${i}`, c.kdfParams, generation, T, T);
        };
        db.transaction(() => owners.forEach((_, i) => deposit(i, gen1[i], 1)))();
        db.pragma('wal_checkpoint(TRUNCATE)');
        db.transaction(() => owners.forEach((_, i) => deposit(i, gen2[i], 2)))();
        db.pragma('wal_checkpoint(TRUNCATE)');
        if (!standby) {
            // Posts with gaps in their rowids, to show the search still finds the right post after the VACUUM.
            const post = db.prepare(`INSERT INTO posts (id, type, category, title, description, author_pubkey)
                VALUES (?, 'offer', 'general', ?, ?, ?)`);
            for (let i = 0; i < 60; i++) post.run(`fixture-post-${i}`, `fixture post ${i}`, `sealprobe${i}`, owners[0]);
            db.prepare("DELETE FROM posts WHERE CAST(substr(id, 14) AS INTEGER) % 3 = 0").run();
            // Owners 25-29 had a copy released before they were purged.
            const col = db.prepare(`INSERT INTO recovery_collections (id, owner_pubkey, generation, requester_ephemeral_pubkey, status, created_at, expires_at)
                VALUES (?, ?, 2, 'eph', 'complete', ?, ?)`);
            const rel = db.prepare(`INSERT INTO recovery_releases (collection_id, share_id, holder_type, share_index, payload, payload_iv, payload_tag, kdf_params, released_at)
                VALUES (?, 0, 'sso', 1, ?, ?, ?, ?, ?)`);
            for (let i = 25; i < N; i++) {
                col.run(`fixture-collection-${i}`, owners[i], T, T);
                rel.run(`fixture-collection-${i}`, gen2[i].encryptedShare, gen2[i].shareIv, gen2[i].shareTag, gen2[i].kdfParams, T);
            }
            db.pragma('wal_checkpoint(TRUNCATE)');
            // Owners 20-24 removed their copy (DELETE /api/recovery/shares); 25-29 were purged (state-engine's purge).
            // Left in the WAL, as the last writes before the upgrade.
            for (let i = 20; i < 25; i++) db.prepare('DELETE FROM recovery_shares WHERE owner_pubkey = ?').run(owners[i]);
            for (let i = 25; i < N; i++) {
                db.prepare('DELETE FROM recovery_shares WHERE owner_pubkey = ?').run(owners[i]);
                db.prepare('DELETE FROM recovery_releases WHERE collection_id IN (SELECT id FROM recovery_collections WHERE owner_pubkey = ?)').run(owners[i]);
                db.prepare('DELETE FROM recovery_collections WHERE owner_pubkey = ?').run(owners[i]);
            }
            out.dropped = [...gen1, ...gen2.slice(20)];
            out.live = gen2.slice(0, 20);
        } else {
            // A force-resync before the seal: every row cleared (clearReplicatedTables) and the snapshot imported again.
            db.prepare('DELETE FROM recovery_shares').run();
            db.transaction(() => owners.forEach((_, i) => deposit(i, gen2[i], 2)))();
            out.dropped = gen1;
            out.live = gen2;
            // The main server has since deleted the last two members' copies; a deletion of a copy does not reach a
            // standby, so these stay here, unwrapped, until a force-resync.
            out.orphans = owners.slice(N - 2);
            out.owners = owners;
        }
    } else if (mode === 'standby-import') {
        // A standby (NODE_ROLE=backup) meeting its main server's wrapped copies through the real import path: a signed
        // payload from a trusted mirror. The main server has deleted the orphans, so its payload does not carry them.
        const { initStateEngine, exportSyncState, signSyncPayload, importRemoteState, clearReplicatedTables } = await import('./state-engine.js');
        initStateEngine();
        const { db } = await import('./db/db.js');
        const clearedNow = () => (db.prepare('SELECT value FROM node_config WHERE key = ?').get(CLEARED_KEY) as any)?.value ?? null;
        const stored = () => db.prepare('SELECT kdf_params FROM recovery_shares').pluck().all() as string[];
        out.secureDelete = db.pragma('secure_delete', { simple: true });
        out.keyExists = fs.existsSync(path.join(dataDir, KEY_FILE));
        out.clearedAtBoot = clearedNow();
        const { startP2P } = await import('./p2p.js');
        const { addConnector } = await import('./connector-manager.js');
        const node = await startP2P(0, 0);
        try {
            const nodeId = node.peerId.toString();
            addConnector(`/ip4/127.0.0.1/tcp/1/p2p/${nodeId}`, 'mirror', 'main-server');
            const owners: string[] = JSON.parse(process.env.SEAL_OWNERS!);
            const orphans = new Set<string>(JSON.parse(process.env.SEAL_ORPHANS!));
            const now = new Date().toISOString();
            const wrapped = owners.filter(o => !orphans.has(o)).map((o) => {
                const i = owners.indexOf(o);
                return {
                    ownerPubkey: o, holderType: 'sso', holderRef: 'google', shareIndex: 1,
                    encryptedShare: crypto.randomBytes(200).toString('base64'), shareIv: crypto.randomBytes(24).toString('base64'),
                    shareTag: crypto.randomBytes(16).toString('base64'), ephemeralPubkey: null,
                    ssoLookupHash: `lookup-${i}`, ssoLookupSalt: 'lookup-salt',
                    kdfParams: JSON.stringify({ alg: 'node-wrap-xc20p-v1', inner: 'scrypt-xc20p-single-v1' }),
                    generation: 2, createdAt: now, updatedAt: now,
                };
            });
            const importWrapped = async () => {
                const payload: any = await exportSyncState(nodeId);
                payload.recoveryShares = wrapped;
                delete payload.signature;
                delete payload.publicKey;
                await importRemoteState(await signSyncPayload(payload));
            };
            await importWrapped();
            out.afterImport = { cleared: clearedNow(), unwrapped: stored().filter(k => !k?.includes('node-wrap-xc20p-v1')).length };
            clearReplicatedTables();
            await importWrapped();
            out.afterResync = { cleared: clearedNow(), unwrapped: stored().filter(k => !k?.includes('node-wrap-xc20p-v1')).length, rows: stored().length };
        } finally {
            await node.stop();
        }
    } else {
        out.error = `unknown child mode ${mode}`;
    }
    console.log(`RESULT ${JSON.stringify(out)}`);
}

// ── the parent ─────────────────────────────────────────────────────────────────────────────────────
let run = 0, passed = 0;
function check(cond: boolean, msg: string): void {
    run++;
    if (cond) { passed++; console.log(`✓ ${msg}`); } else console.error(`✗ ${msg}`);
}
async function section(name: string, fn: () => Promise<void>): Promise<void> {
    console.log(`\n── ${name} ──`);
    try { await fn(); } catch (e) { check(false, `${name}: ${thrown(e)}`); }
}

async function main(): Promise<void> {
    console.log('\nRecovery seal S1: sign-in recovery copies a database alone cannot open\n');
    const dataDir = process.env.BEANPOOL_DATA_DIR;
    if (!dataDir) throw new Error('Set BEANPOOL_DATA_DIR to a throwaway directory');
    const keyPath = path.join(dataDir, KEY_FILE);
    const dbPath = path.join(dataDir, 'state.db');

    const { initTls } = await import('./services/tls.js');
    const { initStateEngine } = await import('./state-engine.js');
    const { db } = await import('./db/db.js');
    const { startHttpsServer } = await import('./https-server.js');
    const { _resetJwksCacheForTests, _clearNoncesForTests } = await import('./sso.js');
    const { resetGatewayRateLimit } = await import('./gateway-rate-limit.js');
    const { pruneAuthAttempts } = await import('./auth-rate-limit.js');
    const { getCurrentShares } = await import('./engine/recovery-shares.js');
    const { listReleases } = await import('./engine/recovery-release.js');

    await initTls();
    initStateEngine();
    const port = await startHttpsServer(0);
    const BASE = `https://localhost:${port}`;

    const { publicKey: rsaPub, privateKey: rsaPriv } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
    _resetJwksCacheForTests();
    _resetJwksCacheForTests('google', {
        keys: [{ ...rsaPub.export({ format: 'jwk' }), kid: GOOGLE_KID, alg: 'RS256', use: 'sig' } as any],
        expiresAt: Date.now() + 3600_000,
    });
    _clearNoncesForTests();
    function googleToken(sub: string, nonce: string): string {
        const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
        const now = Math.floor(Date.now() / 1000);
        const header = b64({ alg: 'RS256', kid: GOOGLE_KID, typ: 'JWT' });
        const payload = b64({
            iss: 'https://accounts.google.com', aud: GOOGLE_AUD, sub, email: 'seal@example.com', email_verified: true,
            iat: now, exp: now + 3600, nonce,
        });
        const sig = crypto.sign('RSA-SHA256', Buffer.from(`${header}.${payload}`), rsaPriv).toString('base64url');
        return `${header}.${payload}.${sig}`;
    }

    /** Signed exactly as the real middleware requires: method, path, timestamp, nonce and body. */
    async function call(id: Id, p: string, body: unknown): Promise<{ status: number; body: any }> {
        // Every limiter emptied first: this suite makes more recovery calls from one address than a person would.
        resetGatewayRateLimit();
        pruneAuthAttempts(Date.now() + 120_000);
        const bodyString = JSON.stringify(body ?? {});
        const ts = Date.now();
        const nonce = crypto.randomBytes(16).toString('hex');
        const res = await fetch(`${BASE}${p}`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-Public-Key': id.pk,
                'X-Signature': crypto.sign(null, Buffer.from(`POST\n${p}\n${ts}\n${nonce}\n${bodyString}`), id.priv).toString('base64'),
                'X-Timestamp': String(ts),
                'X-Nonce': nonce,
            },
            body: bodyString,
        });
        let parsed: any;
        try { parsed = await res.json(); } catch { parsed = undefined; }
        return { status: res.status, body: parsed };
    }

    function addMember(id: Id, prefix: string): string {
        const callsign = `${prefix}-${id.pk.slice(0, 6)}`;
        db.prepare(`INSERT INTO members (public_key, callsign, status, joined_at, invited_by, invite_code)
                    VALUES (?, ?, 'active', strftime('%Y-%m-%dT%H:%M:%fZ','now'), 'genesis', 'genesis')`).run(id.pk, callsign);
        return callsign;
    }

    async function deposit(id: Id, sealed: Sealed, nonce?: string, token?: string) {
        const n = nonce ?? (await call(id, '/api/recovery/sso-nonce', {})).body?.nonce;
        return {
            nonce: n,
            token: token ?? googleToken(GOOGLE_SUB, n),
            res: await call(id, '/api/recovery/shares/sso', {
                provider: 'google', idToken: token ?? googleToken(GOOGLE_SUB, n), nonce: n,
                shares: [{ holderType: 'sso', holderRef: 'google', shareIndex: 1, ...sealed }],
            }),
        };
    }

    /** Open a collection for `callsign` and release its Google copy with `sub`. */
    async function collectGoogle(callsign: string, sub: string) {
        const eph = newId();
        const opened = await call(eph, '/api/recovery/collect', { callsign });
        const collectionId = opened.body?.collectionId;
        const n = (await call(eph, '/api/recovery/collect/sso-nonce', { collectionId })).body?.nonce;
        const token = googleToken(sub, n);
        const released = await call(eph, '/api/recovery/collect/sso', {
            collectionId, provider: 'google', idToken: token, nonce: n,
        });
        return { eph, opened, collectionId, released, nonce: n, token };
    }

    /** Every piece of the client's box an attacker would look for, as base64 text and as raw bytes. */
    function needlesOf(sealed: Sealed): { label: string; bytes: Buffer }[] {
        const kdf = JSON.parse(sealed.kdfParams);
        const b64s: [string, string][] = [
            ['seed box', sealed.encryptedShare], ['seed box nonce', sealed.shareIv], ['seed box tag', sealed.shareTag],
            ['salt', kdf.salt],
        ];
        if (kdf.words) b64s.push(['words box', kdf.words.ct], ['words box nonce', kdf.words.iv], ['words box tag', kdf.words.tag]);
        const out: { label: string; bytes: Buffer }[] = [];
        for (const [label, v] of b64s) {
            out.push({ label: `${label} (base64)`, bytes: Buffer.from(v, 'utf-8') });
            out.push({ label: `${label} (bytes)`, bytes: Buffer.from(v, 'base64') });
        }
        return out;
    }

    /** The database as files on disk: state.db and whatever WAL sits beside it. */
    function dbFiles(): Buffer {
        return Buffer.concat(['', '-wal', '-shm']
            .map(s => dbPath + s)
            .filter(p => fs.existsSync(p))
            .map(p => fs.readFileSync(p)));
    }
    function foundInDbFiles(needles: { label: string; bytes: Buffer }[]): string[] {
        const files = dbFiles();
        return needles.filter(n => files.includes(n.bytes)).map(n => n.label);
    }
    /** How many of these copies another data directory's state.db, -wal and -shm still hold any piece of. */
    function copiesFoundIn(dir: string, copies: Sealed[]): number {
        const files = Buffer.concat(['state.db', 'state.db-wal', 'state.db-shm']
            .map(f => path.join(dir, f)).filter(p => fs.existsSync(p)).map(p => fs.readFileSync(p)));
        return copies.filter(c => needlesOf(c).some(n => files.includes(n.bytes))).length;
    }

    // ── 1. after a deposit, the database file holds none of the client's box ───────────────────
    const m1 = idFromSeed(SEED);
    const callsign1 = addMember(m1, 'Seal');
    const sealed1 = await sealSeedToSso(new Uint8Array(SEED), 'google', GOOGLE_SUB, { words: WORDS }) as Sealed;
    const needles1 = needlesOf(sealed1);
    await section('1. a deposit leaves nothing in the database that the sub alone opens', async () => {
        const { res } = await deposit(m1, sealed1);
        check(res.status === 200 && res.body?.threshold === 1, `the deposit is accepted through the real middleware (got ${res.status} ${JSON.stringify(res.body)})`);
        check(foundInDbFiles([{ label: 'callsign', bytes: Buffer.from(callsign1) }]).length === 1,
            'control: the search does find what the database really holds (the callsign)');
        const inWal = foundInDbFiles(needles1);
        check(inWal.length === 0, `state.db and its WAL hold none of the client's seed box, salt or words box (found: ${inWal.join(', ') || 'none'})`);
        db.pragma('wal_checkpoint(TRUNCATE)');
        const inFile = foundInDbFiles(needles1);
        check(inFile.length === 0, `...nor does state.db after a checkpoint (found: ${inFile.join(', ') || 'none'})`);
        const row = db.prepare("SELECT kdf_params, sso_lookup_hash FROM recovery_shares WHERE owner_pubkey = ?").get(m1.pk) as any;
        check(!!row?.sso_lookup_hash, 'the lookup hash stays in the clear, where it finds the row and reveals nothing');
        check(!!row && JSON.parse(row.kdf_params).alg === 'node-wrap-xc20p-v1' && JSON.parse(row.kdf_params).inner === 'scrypt-xc20p-single-v1',
            `the stored kdf_params names the node wrap and the client scheme inside it, and nothing else (got ${row?.kdf_params})`);
        const served = getCurrentShares(m1.pk)[0];
        check(!!served && served.encryptedShare === sealed1.encryptedShare && served.shareIv === sealed1.shareIv
            && served.shareTag === sealed1.shareTag && served.kdfParams === sealed1.kdfParams,
            'every caller above storage still sees the bytes the client deposited');
    });

    // ── 6. a released row holds none of the inner bytes; the fragments route returns the deposit ──
    let collection6 = '';
    let eph6: Id | null = null;
    await section('6. a released copy is no more readable in the database than a stored one', async () => {
        const { eph, collectionId, released } = await collectGoogle(callsign1, GOOGLE_SUB);
        collection6 = collectionId; eph6 = eph;
        check(released.status === 200 && released.body?.enough === true, `a verified sign-in releases the copy (got ${released.status} ${JSON.stringify(released.body)})`);
        const rel = db.prepare('SELECT * FROM recovery_releases WHERE collection_id = ?').get(collectionId) as any;
        check(!!rel, 'the release is recorded in recovery_releases');
        const relText = Buffer.from(JSON.stringify(rel ?? {}));
        const inRow = needles1.filter(n => relText.includes(n.bytes)).map(n => n.label);
        check(!!rel && inRow.length === 0 && rel.payload !== sealed1.encryptedShare,
            `the release row holds none of the inner bytes (found: ${inRow.join(', ') || 'none'})`);
        db.pragma('wal_checkpoint(TRUNCATE)');
        const inFile = foundInDbFiles(needles1);
        check(inFile.length === 0, `...and neither does the database file (found: ${inFile.join(', ') || 'none'})`);
        const frags = await call(eph, '/api/recovery/collect/fragments', { collectionId });
        const f = frags.body?.fragments?.[0];
        check(frags.status === 200 && frags.body?.fragments?.length === 1, `the fragments route answers the device (got ${frags.status})`);
        check(!!f && f.payload === sealed1.encryptedShare && f.payloadIv === sealed1.shareIv && f.payloadTag === sealed1.shareTag
            && f.kdfParams === sealed1.kdfParams, '...with exactly what the client deposited, byte for byte');
        const opened = await openSeedFromSso({ encryptedShare: f.payload, shareIv: f.payloadIv, shareTag: f.payloadTag, kdfParams: f.kdfParams }, 'google', GOOGLE_SUB);
        check(Buffer.from(opened.seed).equals(SEED) && JSON.stringify(opened.words) === JSON.stringify(WORDS),
            '...which the recovering device opens with its sign-in to the seed and the 12 words');
    });

    // ── 2 and 3. a copy of the database, in another process, without and with the key ─────────
    await section('2. a copy of state.db in a second process, with no key file, does not open with the sub', async () => {
        db.pragma('wal_checkpoint(TRUNCATE)');
        const copy = tempDir('nokey');
        fs.copyFileSync(dbPath, path.join(copy, 'state.db'));
        const r = resultOf(await runChild([SCRIPT], copy, {
            RECOVERY_SEAL_CHILD: 'open-without-key', SEAL_OWNER: m1.pk, SEAL_CLIENT_KDF: sealed1.kdfParams,
        }));
        check(r.rowFound === true, 'the copy holds the member\'s sign-in row');
        check(typeof r.asStored === 'string' && r.asStored.startsWith('threw:'), `the row as stored does not open with the sub (${r.asStored})`);
        check(typeof r.withClientSalt === 'string' && /did not open/.test(r.withClientSalt),
            `even with the client's own salt beside the sub, the stored box fails on the tag (${r.withClientSalt})`);
        check(r.serverReader === `threw: ${SENTENCE}`, `and this server's own reader, with no key file, says the sentence (${r.serverReader})`);
    });

    await section('3. the same copy beside the key file opens, to the same seed', async () => {
        check(fs.existsSync(keyPath), 'the main server keeps data/recovery-seal.key');
        const st = fs.existsSync(keyPath) ? fs.statSync(keyPath) : null;
        check(!!st && st.size === 32 && (st.mode & 0o777) === 0o600, `...32 bytes, readable by the server alone (0600) (got ${st?.size} bytes, ${st ? (st.mode & 0o777).toString(8) : '-'})`);
        const copy = tempDir('withkey');
        fs.copyFileSync(dbPath, path.join(copy, 'state.db'));
        if (st) fs.copyFileSync(keyPath, path.join(copy, KEY_FILE));
        const r = resultOf(await runChild([SCRIPT], copy, {
            RECOVERY_SEAL_CHILD: 'open-with-key', SEAL_OWNER: m1.pk, SEAL_CLIENT_KDF: sealed1.kdfParams,
        }));
        check(r.serverReader === 'opened' && r.seedHex === SEED.toString('hex'), `with the key, the copy opens to the member's seed (${r.serverReader})`);
        check(JSON.stringify(r.words) === JSON.stringify(WORDS), '...and the 12 words inside it');
    });

    // ── 4. the key file deleted while the server runs ───────────────────────────────────────────
    await section('4. with the key file gone, a deposit is refused and stores nothing, and a collect says so', async () => {
        const saved = fs.existsSync(keyPath) ? fs.readFileSync(keyPath) : null;
        check(!!saved, 'setup: the key file exists before it is deleted');
        fs.rmSync(keyPath, { force: true });
        try {
            const m4 = newId();
            addMember(m4, 'SealNoKey');
            const sealed4 = await sealSeedToSso(new Uint8Array(m4.seed), 'google', GOOGLE_SUB) as Sealed;
            const d = await deposit(m4, sealed4);
            check(d.res.status === 503 && d.res.body?.error === SENTENCE,
                `a deposit is refused with 503 and the sentence (got ${d.res.status} ${JSON.stringify(d.res.body)})`);
            const stored = (db.prepare('SELECT COUNT(*) AS n FROM recovery_shares WHERE owner_pubkey = ?').get(m4.pk) as any).n;
            check(stored === 0, `...and nothing is stored, wrapped or not (${stored} rows)`);

            const c = await collectGoogle(callsign1, GOOGLE_SUB);
            check(c.opened.status === 200, `a recovering device can still open a collection (got ${c.opened.status})`);
            check(c.released.status === 503 && c.released.body?.error === SENTENCE,
                `...and the sign-in release answers 503 with the sentence (got ${c.released.status} ${JSON.stringify(c.released.body)})`);
            if (eph6) {
                const frags = await call(eph6, '/api/recovery/collect/fragments', { collectionId: collection6 });
                check(frags.status === 503 && frags.body?.error === SENTENCE,
                    `a copy already released is not served either (got ${frags.status} ${JSON.stringify(frags.body)})`);
            }
            const status = await call(m1, '/api/recovery/shares/status', {});
            check(status.status === 503 && status.body?.error === SENTENCE,
                `the member's protection status says the same rather than reporting a copy that cannot open (got ${status.status})`);

            if (saved) fs.writeFileSync(keyPath, saved, { mode: 0o600 });
            const again = await deposit(m4, sealed4, d.nonce, d.token);
            check(again.res.status === 200,
                `with the key back, the same sign-in deposits: the refusal did not spend its nonce (got ${again.res.status} ${JSON.stringify(again.res.body)})`);
            const releasedNow = await call(c.eph, '/api/recovery/collect/sso', {
                collectionId: c.collectionId, provider: 'google', idToken: c.token, nonce: c.nonce,
            });
            check(releasedNow.status === 200 && releasedNow.body?.enough === true,
                `...and the recovering device's same sign-in releases: its nonce was not spent either (got ${releasedNow.status} ${JSON.stringify(releasedNow.body)})`);
        } finally {
            if (saved && !fs.existsSync(keyPath)) fs.writeFileSync(keyPath, saved, { mode: 0o600 });
        }
    });

    // ── 5. rows written before the wrap are wrapped in place, once ──────────────────────────────
    const oldMember = idFromSeed(Buffer.from(OLD_SEED_HEX, 'hex'));
    const oldCallsign = addMember(oldMember, 'SealOld');
    const PRE_COLLECTION = `pre-wrap-${crypto.randomBytes(8).toString('hex')}`;
    const STALE = '2026-01-01T00:00:00.000Z';
    await section('5. the migration wraps copies stored before it, a second run changes nothing, and they still recover', async () => {
        const seal = await import('./services/recovery-seal-key.js');
        const ins = db.prepare(`INSERT INTO recovery_shares
            (owner_pubkey, holder_type, holder_ref, share_index, encrypted_share, share_iv, share_tag,
             sso_lookup_hash, sso_lookup_salt, kdf_params, generation, created_at, updated_at)
            VALUES (?, 'sso', ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`);
        const ids: number[] = [];
        OLD_ENROLMENTS.forEach((o, i) => {
            ids.push(Number(ins.run(oldMember.pk, o.provider, i + 1, o.sealed.encryptedShare, o.sealed.shareIv, o.sealed.shareTag,
                o.lookupHash, OLD_LOOKUP_SALT, o.sealed.kdfParams, STALE, STALE).lastInsertRowid));
        });
        db.prepare(`INSERT INTO recovery_collections (id, owner_pubkey, generation, requester_ephemeral_pubkey, status, created_at, expires_at)
                    VALUES (?, ?, 1, ?, 'complete', ?, ?)`).run(PRE_COLLECTION, oldMember.pk, newId().pk, STALE, STALE);
        const g = OLD_ENROLMENTS[0].sealed;
        db.prepare(`INSERT INTO recovery_releases (collection_id, share_id, holder_type, share_index, payload, payload_iv, payload_tag, kdf_params, released_at)
                    VALUES (?, ?, 'sso', 1, ?, ?, ?, ?, ?)`).run(PRE_COLLECTION, ids[0], g.encryptedShare, g.shareIv, g.shareTag, g.kdfParams, STALE);

        const first = seal.wrapRecoveryRows();
        check(first.shares === 2 && first.releases === 1, `the first run wraps the two copies and the one release stored before it (got ${JSON.stringify(first)})`);
        const snap = () => JSON.stringify({
            shares: db.prepare('SELECT id, encrypted_share, share_iv, share_tag, kdf_params, updated_at FROM recovery_shares ORDER BY id').all(),
            releases: db.prepare('SELECT id, payload, payload_iv, payload_tag, kdf_params, updated_at FROM recovery_releases ORDER BY id').all(),
        });
        const afterFirst = snap();
        const wrapped = db.prepare('SELECT * FROM recovery_shares WHERE owner_pubkey = ? ORDER BY id').all(oldMember.pk) as any[];
        check(wrapped.length === 2 && wrapped.every(r => JSON.parse(r.kdf_params).alg === 'node-wrap-xc20p-v1'),
            'both are now wrapped');
        check(wrapped.every(r => r.updated_at > STALE), '...and stamped, so a standby that already holds the unwrapped copy is sent the wrapped one');
        check(wrapped.every(r => r.sso_lookup_hash === OLD_ENROLMENTS.find(o => o.provider === r.holder_ref)!.lookupHash
            && r.sso_lookup_salt === OLD_LOOKUP_SALT), '...with their lookup hashes untouched');
        const second = seal.wrapRecoveryRows();
        check(second.shares === 0 && second.releases === 0, `a second run finds nothing to do (got ${JSON.stringify(second)})`);
        check(snap() === afterFirst, '...and every row is byte for byte what the first run left');
        const oldNeedles = OLD_ENROLMENTS.flatMap(o => needlesOf(o.sealed as Sealed));
        const left = foundInDbFiles(oldNeedles);
        check(left.length === 0, `the migration leaves none of the unwrapped bytes in the database files (found: ${left.join(', ') || 'none'})`);

        const c = await collectGoogle(oldCallsign, OLD_ENROLMENTS[0].sub);
        check(c.released.status === 200 && c.released.body?.enough === true, `a copy stored before the wrap still releases on a verified sign-in (got ${c.released.status} ${JSON.stringify(c.released.body)})`);
        const frags = await call(c.eph, '/api/recovery/collect/fragments', { collectionId: c.collectionId });
        const f = frags.body?.fragments?.[0];
        check(!!f && f.payload === g.encryptedShare && f.payloadIv === g.shareIv && f.payloadTag === g.shareTag && f.kdfParams === g.kdfParams,
            '...as exactly the bytes the earlier code stored');
        const seed = f ? await openShareFromSso({ encryptedShare: f.payload, shareIv: f.payloadIv, shareTag: f.payloadTag, kdfParams: f.kdfParams }, 'google', OLD_ENROLMENTS[0].sub) : null;
        check(!!seed && Buffer.from(seed).toString('hex') === OLD_SEED_HEX, '...which opens with the sign-in to the member\'s seed');
        const pre = listReleases(PRE_COLLECTION)[0];
        check(!!pre && pre.payload === g.encryptedShare && pre.payloadIv === g.shareIv && pre.payloadTag === g.shareTag && pre.kdfParams === g.kdfParams,
            'a release recorded before the wrap reads back as it was recorded');
    });

    // ── 7. the reverse migration: the rollback command ──────────────────────────────────────────
    await section('7. the reverse migration restores every row byte for byte', async () => {
        db.pragma('wal_checkpoint(TRUNCATE)');
        const copy = tempDir('rollback');
        fs.copyFileSync(dbPath, path.join(copy, 'state.db'));
        if (fs.existsSync(keyPath)) fs.copyFileSync(keyPath, path.join(copy, KEY_FILE));
        check(!!db.prepare('SELECT 1 FROM node_config WHERE key = ?').get(CLEARED_KEY),
            'setup: this server recorded clearing its database at boot');
        const r = await runChild([SEAL_CLI, '--unwrap-recovery-rows'], copy, {});
        check(r.code === 0, `the rollback command exits 0 (got ${r.code}: ${r.stderr.slice(-400)})`);
        check(!/[A-Za-z0-9+/]{40,}={0,2}/.test(r.stdout.replace(/[0-9a-f]{64}/g, '')), 'its output holds counts, not keys or copies');
        const back = new Database(path.join(copy, 'state.db'), { readonly: true });
        try {
            const cols = (row: any) => row && { encryptedShare: row.encrypted_share, shareIv: row.share_iv, shareTag: row.share_tag, kdfParams: row.kdf_params };
            const same = (a: any, b: Sealed) => !!a && a.encryptedShare === b.encryptedShare && a.shareIv === b.shareIv
                && a.shareTag === b.shareTag && a.kdfParams === b.kdfParams;
            for (const o of OLD_ENROLMENTS) {
                const row = back.prepare('SELECT * FROM recovery_shares WHERE owner_pubkey = ? AND holder_ref = ?').get(oldMember.pk, o.provider);
                check(same(cols(row), o.sealed as Sealed), `${o.provider}: the copy stored before the wrap is back exactly as it was`);
            }
            const m1Row = back.prepare("SELECT * FROM recovery_shares WHERE owner_pubkey = ? AND holder_type = 'sso'").get(m1.pk);
            check(same(cols(m1Row), sealed1), 'a copy deposited after the wrap comes back as exactly what the client sent');
            const rel = (id: string) => {
                const x = back.prepare('SELECT * FROM recovery_releases WHERE collection_id = ?').get(id) as any;
                return x && { encryptedShare: x.payload, shareIv: x.payload_iv, shareTag: x.payload_tag, kdfParams: x.kdf_params };
            };
            check(same(rel(PRE_COLLECTION), OLD_ENROLMENTS[0].sealed as Sealed), 'the release recorded before the wrap is back as it was');
            if (collection6) check(same(rel(collection6), sealed1), 'a release recorded after the wrap comes back as the client\'s bytes');
            const still = (back.prepare("SELECT COUNT(*) AS n FROM recovery_shares WHERE kdf_params LIKE '%node-wrap-xc20p-v1%'").get() as any).n
                + (back.prepare("SELECT COUNT(*) AS n FROM recovery_releases WHERE kdf_params LIKE '%node-wrap-xc20p-v1%'").get() as any).n;
            check(still === 0, `no wrapped row is left for the older server to trip on (${still})`);
            check(!back.prepare('SELECT 1 FROM node_config WHERE key = ?').get(CLEARED_KEY),
                'the record of the clearing is gone: the older server deletes without zeroing, so coming back clears again');
        } finally { back.close(); }
    });

    // ── 8. who makes a key, and a boot that never stops for one ─────────────────────────────────
    await section('8. a standby makes no key file; a main server makes one; a bad key file never stops a boot', async () => {
        const standby = resultOf(await runChild([SCRIPT], tempDir('standby'), { RECOVERY_SEAL_CHILD: 'boot', NODE_ROLE: 'backup' }));
        check(standby.booted === true && standby.keyExists === false, `a standby (NODE_ROLE=backup) boots with no key of its own (${JSON.stringify(standby)})`);
        const main = resultOf(await runChild([SCRIPT], tempDir('main'), { RECOVERY_SEAL_CHILD: 'boot', NODE_ROLE: 'primary' }));
        check(main.booted === true && main.keyExists === true && main.keyBytes === 32 && main.keyMode === '600',
            `a main server makes its key at boot: 32 bytes, 0600 (${JSON.stringify(main)})`);
        const badDir = tempDir('badkey');
        fs.writeFileSync(path.join(badDir, KEY_FILE), Buffer.from('short'), { mode: 0o600 });
        const bad = resultOf(await runChild([SCRIPT], badDir, { RECOVERY_SEAL_CHILD: 'boot', NODE_ROLE: 'primary' }));
        check(bad.booted === true, `a key file that is not a key does not stop the boot (${JSON.stringify(bad)})`);
        check(fs.readFileSync(path.join(badDir, KEY_FILE)).toString() === 'short', '...and is never overwritten: it may be the only copy someone can repair');
    });

    // ── 9. a member moved to a new key keeps an openable copy ───────────────────────────────────
    await section('9. moving a member to a new key keeps their copy openable', async () => {
        const { issueRekeyCode, completeRekey } = await import('./engine/member-wizards.js');
        const m9 = newId();
        addMember(m9, 'SealRekey');
        const sealed9 = await sealSeedToSso(new Uint8Array(m9.seed), 'google', GOOGLE_SUB) as Sealed;
        const { res } = await deposit(m9, sealed9);
        check(res.status === 200, `setup: the member deposits a copy (got ${res.status})`);
        // A copy another member holds for m9 (a member keeper), so the rename is seen too. Both rows stamped long ago.
        const other9 = newId();
        addMember(other9, 'SealRekeyOther');
        const keeperRowId = Number(db.prepare(`INSERT INTO recovery_shares
            (owner_pubkey, holder_type, holder_ref, share_index, encrypted_share, share_iv, share_tag, generation)
            VALUES (?, 'member', ?, 1, 'a', 'b', 'c', 1)`).run(other9.pk, m9.pk).lastInsertRowid);
        const ownRowId = (db.prepare('SELECT id FROM recovery_shares WHERE owner_pubkey = ?').get(m9.pk) as any)?.id;
        db.prepare('UPDATE recovery_shares SET updated_at = ? WHERE id IN (?, ?)').run(STALE, ownRowId, keeperRowId);
        const moved = newId();
        const { code } = issueRekeyCode(m9.pk, 'owner:password');
        completeRekey(m9.pk, moved.pk, code, 'owner:password');
        const shares = getCurrentShares(moved.pk);
        check(shares.length === 1 && shares[0].encryptedShare === sealed9.encryptedShare && shares[0].kdfParams === sealed9.kdfParams,
            'after the move, the copy is filed under the new key and still opens with the server\'s key');
        const seed = shares[0] ? await openShareFromSso(shares[0] as Sealed, 'google', GOOGLE_SUB) : null;
        check(!!seed && Buffer.from(seed).equals(m9.seed), '...to the seed it was made from');
        const own = db.prepare('SELECT owner_pubkey, updated_at FROM recovery_shares WHERE id = ?').get(ownRowId) as any;
        check(own?.owner_pubkey === moved.pk && own.updated_at > STALE,
            `the moved copy is stamped, so a standby is sent the move (updated_at ${own?.updated_at})`);
        const keeper = db.prepare('SELECT holder_ref, updated_at FROM recovery_shares WHERE id = ?').get(keeperRowId) as any;
        check(keeper?.holder_ref === moved.pk && keeper.updated_at > STALE,
            `...and so is a copy the member keeps for someone else, renamed to the new key (updated_at ${keeper?.updated_at})`);
    });

    // ── 10. without the key file, a re-key moves nothing, and runs once the key is back ────────
    await section('10. without the key file, a re-key is refused and changes nothing, and runs once the key is back', async () => {
        const { issueRekeyCode, completeRekey } = await import('./engine/member-wizards.js');
        const { getMember } = await import('./state-engine.js');
        const m10 = newId();
        addMember(m10, 'SealRekeyNoKey');
        const sealed10 = await sealSeedToSso(new Uint8Array(m10.seed), 'google', GOOGLE_SUB) as Sealed;
        const { res } = await deposit(m10, sealed10);
        check(res.status === 200, `setup: the member deposits a copy (got ${res.status})`);
        const moved = newId();
        const { code } = issueRekeyCode(m10.pk, 'owner:password');
        const saved = fs.existsSync(keyPath) ? fs.readFileSync(keyPath) : null;
        check(!!saved, 'setup: the key file exists before it is deleted');
        fs.rmSync(keyPath, { force: true });
        try {
            let refused = '';
            try { completeRekey(m10.pk, moved.pk, code, 'owner:password'); } catch (e) { refused = (e as Error)?.message ?? String(e); }
            check(refused === SENTENCE, `the re-key is refused with the sentence (got ${refused || 'no refusal'})`);
            const under = (pk: string) => (db.prepare('SELECT COUNT(*) AS n FROM recovery_shares WHERE owner_pubkey = ?').get(pk) as any).n;
            check(under(m10.pk) === 1 && under(moved.pk) === 0, 'the copy stays under the old key, where it is bound');
            check(!!getMember(m10.pk) && !getMember(moved.pk), '...and nothing else moved: the whole re-key rolled back');
            const req = db.prepare('SELECT status FROM rekey_requests WHERE code = ?').get(code) as any;
            check(req?.status === 'pending', `the re-enrolment code is still pending (got ${req?.status})`);

            if (saved) fs.writeFileSync(keyPath, saved, { mode: 0o600 });
            completeRekey(m10.pk, moved.pk, code, 'owner:password');
            const shares = getCurrentShares(moved.pk);
            const seed = shares[0] ? await openShareFromSso(shares[0] as Sealed, 'google', GOOGLE_SUB) : null;
            check(shares.length === 1 && !!seed && Buffer.from(seed).equals(m10.seed),
                'with the key back, the same code moves the member, and the copy opens under the new key to their seed');
        } finally {
            if (saved && !fs.existsSync(keyPath)) fs.writeFileSync(keyPath, saved, { mode: 0o600 });
        }
    });

    // ── 11. a copy another key locked stays where it is bound, and the re-key does not wait on it ──
    await section('11. a copy locked with another key stays under the old key, where it still opens, and the re-key completes', async () => {
        const { issueRekeyCode, completeRekey } = await import('./engine/member-wizards.js');
        const { getMember } = await import('./state-engine.js');
        const m11 = newId();
        addMember(m11, 'SealRekeyLocked');
        const sealed11 = await sealSeedToSso(new Uint8Array(m11.seed), 'google', GOOGLE_SUB) as Sealed;
        const { res } = await deposit(m11, sealed11);
        check(res.status === 200, `setup: the member deposits a copy (got ${res.status})`);
        const rowId = (db.prepare('SELECT id FROM recovery_shares WHERE owner_pubkey = ?').get(m11.pk) as any)?.id;
        const moved = newId();
        const { code } = issueRekeyCode(m11.pk, 'owner:password');
        const saved = fs.readFileSync(keyPath);
        // Another server's key, as after a restore from a plain backup: this one does not open the copy.
        fs.writeFileSync(keyPath, crypto.randomBytes(32), { mode: 0o600 });
        try {
            let threw = '';
            try { completeRekey(m11.pk, moved.pk, code, 'owner:password'); } catch (e) { threw = (e as Error)?.message ?? String(e); }
            check(threw === '' && !!getMember(moved.pk) && !getMember(m11.pk), `the re-key completes (${threw || 'no error'})`);
            const row = db.prepare('SELECT owner_pubkey FROM recovery_shares WHERE id = ?').get(rowId) as any;
            check(row?.owner_pubkey === m11.pk, 'the copy it cannot open stays under the old key it is bound to');
            check(getCurrentShares(moved.pk).length === 0, '...so the new key holds no copy that could never open');

            fs.writeFileSync(keyPath, saved, { mode: 0o600 });
            const back = getCurrentShares(m11.pk);
            const seed = back[0] ? await openShareFromSso(back[0] as Sealed, 'google', GOOGLE_SUB) : null;
            check(back.length === 1 && back[0].encryptedShare === sealed11.encryptedShare && !!seed && Buffer.from(seed).equals(m11.seed),
                'with the key that locked it back, the copy left there still opens, to the seed it was made from');
        } finally {
            fs.writeFileSync(keyPath, saved, { mode: 0o600 });
        }
    });

    // ── 12. copies a main server dropped before the seal ────────────────────────────────────────
    const sealLines = (r: ChildResult) => (r.stdout + r.stderr).split('\n').filter(l => l.includes('Recovery seal')).join(' | ');
    await section('12. copies a main server dropped before the seal are gone from state.db and its WAL after the upgrade', async () => {
        const dir = tempDir('dropped-main');
        const fx = resultOf(await runChild([SCRIPT], dir, { RECOVERY_SEAL_CHILD: 'pre-seal-node', SEAL_FIXTURE: 'main' }));
        const dropped: Sealed[] = fx.dropped;
        const live: Sealed[] = fx.live;
        const before = copiesFoundIn(dir, dropped);
        check(before > 0, `control: before the upgrade, ${before} of the ${dropped.length} copies re-deposits, removals and a purge dropped are still in state.db or its WAL`);

        // The upgrade's first boot, on a disk without room for the VACUUM: the wrap runs, the clearing waits.
        const tight = await runChild([SCRIPT], dir, { RECOVERY_SEAL_CHILD: 'boot', NODE_ROLE: 'primary', SEAL_FREE_BYTES: String(1024 * 1024) });
        const t = resultOf(tight);
        check(t.booted === true && t.keyExists === true, `a disk without room never stops the boot (booted ${t.booted}, key ${t.keyExists})`);
        check(t.cleared === null && /needs about \d+ MB free in .*, which has 1 MB\. The server runs; the next boot tries again/.test(tight.stderr),
            `...it says why it did not clear, and records nothing, so the next boot tries again (${sealLines(tight)})`);
        check(copiesFoundIn(dir, dropped) > 0, '...and the dropped copies are still there: it does not claim what it did not do');

        const first = await runChild([SCRIPT], dir, { RECOVERY_SEAL_CHILD: 'boot', NODE_ROLE: 'primary', SEAL_FTS_PROBE: '1' });
        const f = resultOf(first);
        check(f.booted === true && f.secureDelete === 1, `the next boot runs, with secure_delete on for the connection (secure_delete ${f.secureDelete})`);
        check(typeof f.cleared === 'string' && /cleared state\.db of sign-in recovery copies deleted before the seal \(one VACUUM, [\d.]+ s/.test(first.stdout),
            `...it runs the VACUUM, says so, and records it (${sealLines(first)})`);
        const after = copiesFoundIn(dir, dropped);
        check(after === 0, `none of the ${dropped.length} dropped copies is left in state.db, -wal or -shm (found ${after}; ${before} before)`);
        const liveLeft = copiesFoundIn(dir, live);
        check(liveLeft === 0, `nor any of the ${live.length} copies the wrap rewrote (found ${liveLeft})`);
        check(f.ftsIntegrity === 'ok' && JSON.stringify(f.ftsHit) === JSON.stringify(['fixture-post-40']),
            `posts' search index still matches its posts after the VACUUM (integrity ${f.ftsIntegrity}, '${FTS_PROBE_WORD}' finds ${JSON.stringify(f.ftsHit)})`);

        const second = await runChild([SCRIPT], dir, { RECOVERY_SEAL_CHILD: 'boot', NODE_ROLE: 'primary' });
        const s = resultOf(second);
        check(s.booted === true && s.cleared === f.cleared && !/one VACUUM/.test(second.stdout), `a later boot does not run it again (${sealLines(second)})`);
    });

    // ── 13. the same on a standby, which never wraps ────────────────────────────────────────────
    await section('13. a standby clears the copies it dropped before the seal once its main server\'s wrapped copies replace its own', async () => {
        const dir = tempDir('dropped-standby');
        const fx = resultOf(await runChild([SCRIPT], dir, { RECOVERY_SEAL_CHILD: 'pre-seal-node', SEAL_FIXTURE: 'standby' }));
        const before = copiesFoundIn(dir, fx.dropped);
        check(before > 0, `control: before the upgrade, ${before} of the ${fx.dropped.length} copies the standby's imports and a force-resync dropped are still in its state.db`);
        const r = await runChild([SCRIPT], dir, {
            RECOVERY_SEAL_CHILD: 'standby-import', NODE_ROLE: 'backup',
            SEAL_OWNERS: JSON.stringify(fx.owners), SEAL_ORPHANS: JSON.stringify(fx.orphans),
        });
        const s = resultOf(r);
        check(s.keyExists === false && s.secureDelete === 1 && s.clearedAtBoot === null,
            `at boot the standby makes no key, zeroes what it deletes, and waits: it still holds its copies in the old form (${JSON.stringify({ key: s.keyExists, secureDelete: s.secureDelete, cleared: s.clearedAtBoot })})`);
        check(s.afterImport?.cleared === null && s.afterImport?.unwrapped === 2,
            `after its main server's wrapped copies arrive, the 2 copies the main server deleted are still here unwrapped, so it still waits (${JSON.stringify(s.afterImport)})`);
        check(/still holds 2 sign-in recovery copies in the form stored before the seal.*A force-resync removes them/.test(r.stderr),
            `...and says so, and what removes them (${sealLines(r)})`);
        check(typeof s.afterResync?.cleared === 'string' && s.afterResync.unwrapped === 0 && s.afterResync.rows === 28,
            `after a force-resync it holds only wrapped copies, and has run its one VACUUM (${JSON.stringify(s.afterResync)})`);
        const dropped = copiesFoundIn(dir, fx.dropped);
        check(dropped === 0, `none of the ${fx.dropped.length} copies it dropped before the seal is left in its state.db, -wal or -shm (found ${dropped}; ${before} before)`);
        const replaced = copiesFoundIn(dir, fx.live);
        check(replaced === 0, `nor any of the ${fx.live.length} it held until the wrapped copies and the force-resync replaced them (found ${replaced})`);
    });

    // ── 14. a data folder without hard links ─────────────────────────────────────────────────────
    await section('14. a data folder without hard links still gets its key, made in place and never over another file', async () => {
        const seal = await import('./services/recovery-seal-key.js');
        const fsw = fs as any;
        const realLink = fs.linkSync, realFsync = fs.fsyncSync;
        const savedDir = process.env.BEANPOOL_DATA_DIR;
        const errno = (code: string) => Object.assign(new Error(`${code}: operation not permitted, link`), { code });
        const others = (dir: string) => fs.readdirSync(dir).filter(f => f !== KEY_FILE);
        try {
            for (const code of ['EPERM', 'ENOTSUP', 'EMLINK', 'ENOSYS', 'EXDEV']) {
                const dir = tempDir(`nolink-${code.toLowerCase()}`);
                process.env.BEANPOOL_DATA_DIR = dir;
                fsw.linkSync = () => { throw errno(code); };
                const kp = path.join(dir, KEY_FILE);
                let made: { created: boolean } | string;
                try { made = seal.ensureRecoverySealKey(); } catch (e) { made = thrown(e); }
                const st = fs.existsSync(kp) ? fs.statSync(kp) : null;
                check(typeof made === 'object' && made.created && st?.size === 32 && (st.mode & 0o777) === 0o600 && others(dir).length === 0,
                    `${code}: the key is made in place, 32 bytes, 0600, with no temporary file left (${JSON.stringify(made)}, ${st?.size} bytes, left ${JSON.stringify(others(dir))})`);
                const bytes = st ? fs.readFileSync(kp) : Buffer.alloc(0);
                const again = seal.ensureRecoverySealKey();
                check(!again.created && fs.readFileSync(kp).equals(bytes), `${code}: a second boot keeps it, byte for byte`);
            }
            // A key that appears between the look and the create is never written over.
            const raceDir = tempDir('nolink-race');
            process.env.BEANPOOL_DATA_DIR = raceDir;
            const theirs = crypto.randomBytes(32);
            fsw.linkSync = () => { fs.writeFileSync(path.join(raceDir, KEY_FILE), theirs, { mode: 0o600 }); throw errno('EPERM'); };
            const raced = seal.ensureRecoverySealKey();
            check(!raced.created && fs.readFileSync(path.join(raceDir, KEY_FILE)).equals(theirs) && others(raceDir).length === 0,
                'a key file that appears in the meantime is kept as it is, and nothing is left beside it');
            // Any other failure of link is not a filesystem without links: it is thrown, and nothing is left.
            const accDir = tempDir('nolink-eacces');
            process.env.BEANPOOL_DATA_DIR = accDir;
            fsw.linkSync = () => { throw errno('EACCES'); };
            let accErr = '';
            try { seal.ensureRecoverySealKey(); } catch (e) { accErr = thrown(e); }
            check(accErr.includes('EACCES') && fs.readdirSync(accDir).length === 0, `EACCES is thrown, not worked around, and leaves nothing (${accErr})`);
            // A write that fails leaves no temporary file behind (it did, before: the parked "a .tmp left on a failed fsync").
            fsw.linkSync = realLink;
            const ioDir = tempDir('fsync-fails');
            process.env.BEANPOOL_DATA_DIR = ioDir;
            fsw.fsyncSync = () => { throw Object.assign(new Error('EIO: i/o error, fsync'), { code: 'EIO' }); };
            let ioErr = '';
            try { seal.ensureRecoverySealKey(); } catch (e) { ioErr = thrown(e); }
            check(ioErr.includes('EIO') && fs.readdirSync(ioDir).length === 0, `a failed fsync is thrown and leaves no file at all (${ioErr}; left ${JSON.stringify(fs.readdirSync(ioDir))})`);
            // Without links, a key whose own write fails is removed, so the next boot makes a whole one.
            const halfDir = tempDir('nolink-fsync-fails');
            process.env.BEANPOOL_DATA_DIR = halfDir;
            fsw.linkSync = () => { throw errno('EPERM'); };
            let syncs = 0;
            fsw.fsyncSync = (fd: number) => { if (++syncs === 2) throw Object.assign(new Error('EIO: i/o error, fsync'), { code: 'EIO' }); return realFsync(fd); };
            let halfErr = '';
            try { seal.ensureRecoverySealKey(); } catch (e) { halfErr = thrown(e); }
            check(halfErr.includes('EIO') && fs.readdirSync(halfDir).length === 0, `without links, a key whose write fails is removed rather than left half made (${halfErr}; left ${JSON.stringify(fs.readdirSync(halfDir))})`);
            fsw.fsyncSync = realFsync;
            const retry = seal.ensureRecoverySealKey();
            check(retry.created && fs.statSync(path.join(halfDir, KEY_FILE)).size === 32, '...and the next try makes it');
        } finally {
            fsw.linkSync = realLink;
            fsw.fsyncSync = realFsync;
            process.env.BEANPOOL_DATA_DIR = savedDir;
        }
    });

    console.log(`\n${passed}/${run} checks passed.`);
    if (passed !== run) throw new Error(`${run - passed} check(s) failed`);
    console.log('⭐️ Recovery seal: a database, a copy of it or a released row opens nothing without the key kept beside it.');
}

if (CHILD) {
    child(CHILD).then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
} else {
    main().then(() => process.exit(0)).catch((e) => { console.error('❌ Test failed:', e); process.exit(1); });
}
