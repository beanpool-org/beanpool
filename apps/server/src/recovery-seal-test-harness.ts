/**
 * Shared by test-recovery-seal.ts, test-recovery-seal-rollback.ts and test-recovery-seal-removed.ts (not a suite
 * itself): the recovery seal's fixtures, the second processes those suites start (child), and the parent they run in
 * (bootParent), a main server in this process with a stand-in Google.
 *
 * The three were one suite until its 236 checks took four minutes, near the 300 s each suite has in CI
 * (scripts/test-all.sh). They are split by section and keep its numbers, so "as in 18" means the same section in
 * whichever file it runs.
 *
 * A suite's second processes are that suite's file again, with RECOVERY_SEAL_CHILD set, which runs child() here; each
 * gets its own data directory and is stopped with the run however it ends.
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
import { sealSeedToSso, openSeedFromSso } from '@beanpool/core';

/** The seal's own command line (the rollback command, run as a command in 7 and 21). */
export const SEAL_CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), 'services', 'recovery-seal-key.ts');
export const CHILD = process.env.RECOVERY_SEAL_CHILD;

/** The design's sentence (§4 "Where"), word for word: what a server without its key says. */
export const SENTENCE = 'This server holds sign-in recovery copies it cannot open: data/recovery-seal.key is missing.';
export const KEY_FILE = 'recovery-seal.key';

// ── fixtures (test-sso-recovery-roundtrip.ts) ─────────────────────────────────────────────────────
export const GOOGLE_KID = 'test-recovery-seal-google-kid';
export const GOOGLE_AUD = '653933790375-vkedasi9cs2aeoo2968ttmscqno484jd.apps.googleusercontent.com';
export const GOOGLE_SUB = '110169484474386276334';
/** A test phrase, not an account. seed = SHA256(SHA256(words)), as both apps derive it. */
export const WORDS = 'abandon ability able about above absent absorb abstract absurd abuse access accident'.split(' ');
export const SEED = crypto.createHash('sha256').update(crypto.createHash('sha256').update(WORDS.join(' ')).digest()).digest();

/** 1b: copies sealed by origin/main's sealSeedToSso and ssoLookupHash at 7f92bd8e, before any wrap existed. */
export const OLD_SEED_HEX = 'cdb6f28510570568bd01d9b982312020b785e3847664cbfb6ee753425085de9e';
export const OLD_LOOKUP_SALT = 'S1-old-enrolment-lookup-salt';
export const OLD_ENROLMENTS = [
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

export interface Sealed { encryptedShare: string; shareIv: string; shareTag: string; kdfParams: string }

/** A copy shaped as the apps seal one (seed box, salt, words box), with random bytes: what 12 and 13 look for. */
export function fakeCopy(): Sealed {
    const b64 = (n: number) => crypto.randomBytes(n).toString('base64');
    return {
        encryptedShare: b64(48), shareIv: b64(24), shareTag: b64(16),
        kdfParams: JSON.stringify({ alg: 'scrypt-xc20p-single-v1', salt: b64(32), N: 16384, r: 8, p: 1, words: { ct: b64(120), iv: b64(24), tag: b64(16) } }),
    };
}

/**
 * 13's history, made in the parent and written by the code before the seal on both sides (child 'pre-seal-history'):
 * each owner's first and second deposit, the owners who then deleted theirs, and the owners whose second copy the app
 * really sealed (the rest are shaped like one), with the seed each opens to.
 */
export interface History {
    owners: string[]; gen1: Sealed[]; gen2: Sealed[]; deleted: number[]; real: { i: number; seedHex: string }[];
    /** When each deposit was stamped, by the main server's clock (default: 2026-06-01 and 2026-06-02). */
    at?: [string, string];
}

/**
 * 16's and 17's standby (child 'standby-script'): what its main server answers to each of the puller's requests in turn
 * (the rows of `recoveryShares`, as the engine's export shapes them), whether it starts with a force-resync, its routine
 * whole-copy cadence, how many requests to wait for, and the copies to look for in its files. `since`: the delta cursor
 * its last pull left it at, for a standby that has none yet (without one, its first pull is a whole copy). `epochs`: the
 * seal epoch each answer names (`sealEpoch`; null names none), the last one for every answer after; without it, none.
 */
export interface StandbyScript {
    resyncFirst: boolean; reconcileMinutes: number; pulls: number; steps: unknown[][]; watch: Sealed[]; since?: string;
    epochs?: (string | null)[];
}

/** Every piece of the client's box an attacker would look for, as base64 text and as raw bytes. */
export function needlesOf(sealed: Sealed): { label: string; bytes: Buffer }[] {
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

/** How many of these copies a data directory's state.db, -wal and -shm hold any piece of, as the files are right now. */
export function copiesFoundIn(dir: string, copies: Sealed[]): number {
    const files = Buffer.concat(['state.db', 'state.db-wal', 'state.db-shm']
        .map(f => path.join(dir, f)).filter(p => fs.existsSync(p)).map(p => fs.readFileSync(p)));
    return copies.filter(c => needlesOf(c).some(n => files.includes(n.bytes))).length;
}

/** A copy as a main server's export sends it (engine/sync.ts exportSyncState), for the rows pre-seal-history writes. */
export function exportRow(owner: string, i: number, c: { encryptedShare: string; shareIv: string; shareTag: string; kdfParams: string | null },
    generation: number, at: string) {
    return {
        ownerPubkey: owner, holderType: 'sso', holderRef: 'google', shareIndex: 1,
        encryptedShare: c.encryptedShare, shareIv: c.shareIv, shareTag: c.shareTag, ephemeralPubkey: null,
        ssoLookupHash: `lookup-${i}`, ssoLookupSalt: 'lookup-salt', kdfParams: c.kdfParams, generation, createdAt: at, updatedAt: at,
    };
}

export const CLEARED_KEY = 'recovery_seal_cleared';
export const FTS_PROBE_WORD = 'sealprobe40';

// ── identities ─────────────────────────────────────────────────────────────────────────────────────
export interface Id { pk: string; priv: crypto.KeyObject; seed: Buffer }
export function idFromSeed(seed: Buffer): Id {
    const priv = crypto.createPrivateKey({
        key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), seed]),
        format: 'der', type: 'pkcs8',
    });
    const pk = (crypto.createPublicKey(priv).export({ type: 'spki', format: 'der' }) as Buffer).subarray(-32).toString('hex');
    return { pk, priv, seed };
}
export const newId = (): Id => idFromSeed(crypto.randomBytes(32));

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

export function tempDir(label: string): string {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), `recovery-seal-${label}-`));
    ownedDirs.add(d);
    return d;
}

export interface ChildResult { code: number | null; stdout: string; stderr: string }
export function runChild(args: string[], dataDir: string, env: Record<string, string>): Promise<ChildResult> {
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
export function resultOf(r: ChildResult): any {
    const line = r.stdout.split('\n').reverse().find(l => l.startsWith('RESULT '));
    if (!line) throw new Error(`child gave no result (exit ${r.code}): ${r.stderr.slice(-800)}`);
    return JSON.parse(line.slice('RESULT '.length));
}

export const thrown = (e: unknown) => `threw: ${(e as Error)?.message ?? String(e)}`;

/** The second process. Only ever run by runChild. */
export async function child(mode: string): Promise<void> {
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
            if (process.env.SEAL_THEN_MAIN) {
                // A take-over step that finished at this boot (index.ts step 2.65): the role changes after initStateEngine.
                const seal = await import('./services/recovery-seal-key.js');
                seal.installRecoverySealAtBoot({ standby: false });
            }
            out.booted = true;
        } catch (e) { out.booted = thrown(e); }
        // The watched copies in its state.db, -wal and -shm as they are while it runs.
        if (process.env.SEAL_WATCH) out.inFiles = copiesFoundIn(dataDir, JSON.parse(fs.readFileSync(process.env.SEAL_WATCH, 'utf-8')));
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
        const N = 30;
        const owners = Array.from({ length: N }, () => crypto.randomBytes(32).toString('hex'));
        const gen1 = owners.map(() => fakeCopy());
        const gen2 = owners.map(() => fakeCopy());
        const T = '2026-06-01T00:00:00.000Z';
        const dropOlder = db.prepare('DELETE FROM recovery_shares WHERE owner_pubkey = ? AND generation < ?');
        // A main server stored a deposit with a plain INSERT (putShareGeneration).
        const put = db.prepare(`INSERT INTO recovery_shares
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
    } else if (mode === 'pre-seal-history') {
        // 13's history as the code before the seal made it, on connections with secure_delete off (its default then).
        // The main server: every member deposits, then re-deposits (a re-deposit drops the older generation); then three
        // disconnect their only sign-in (deleteAllShares) and three are purged (purgeMemberSelf), both a DELETE of their
        // rows. Its standby: each of the main server's pulls, written with sync.ts's own statements. The deletions never
        // reach it: a deletion of a copy has no tombstone.
        const { db, initSchema } = await import('./db/db.js');
        initSchema();
        db.pragma('secure_delete = 0');
        const h: History = JSON.parse(fs.readFileSync(process.env.SEAL_HISTORY!, 'utf-8'));
        const standby = process.env.SEAL_SIDE === 'standby';
        const dropOlder = db.prepare('DELETE FROM recovery_shares WHERE owner_pubkey = ? AND generation < ?');
        const put = db.prepare(`INSERT${standby ? ' OR REPLACE' : ''} INTO recovery_shares
            (owner_pubkey, holder_type, holder_ref, share_index, encrypted_share, share_iv, share_tag, ephemeral_pubkey,
             sso_lookup_hash, sso_lookup_salt, kdf_params, generation, created_at, updated_at)
            VALUES (?, 'sso', 'google', 1, ?, ?, ?, NULL, ?, 'lookup-salt', ?, ?, ?, ?)`);
        const stage = (copies: Sealed[], generation: number, at: string) => {
            db.transaction(() => h.owners.forEach((o, i) => {
                dropOlder.run(o, generation);
                const c = copies[i];
                put.run(o, c.encryptedShare, c.shareIv, c.shareTag, `lookup-${i}`, c.kdfParams, generation, at, at);
            }))();
            db.pragma('wal_checkpoint(TRUNCATE)');
        };
        stage(h.gen1, 1, h.at?.[0] ?? '2026-06-01T00:00:00.000Z');
        stage(h.gen2, 2, h.at?.[1] ?? '2026-06-02T00:00:00.000Z');
        if (!standby) {
            // Left in the WAL, as the last writes before the upgrade.
            for (const i of h.deleted) db.prepare('DELETE FROM recovery_shares WHERE owner_pubkey = ?').run(h.owners[i]);
        }
        out.rows = db.prepare('SELECT COUNT(*) FROM recovery_shares').pluck().get();
    } else if (mode === 'older-standby-import') {
        // 20's standby while a fleet rollback lasts: it runs the code before the seal too, and imports each of its main
        // server's pulls (SEAL_BATCHES) with sync.ts's own statements, on a connection with secure_delete off (that code's
        // default). That code has never heard of a recorded clear, so it keeps whatever node_config holds.
        const { db } = await import('./db/db.js');
        db.pragma('secure_delete = 0');
        const batches: any[][] = JSON.parse(fs.readFileSync(process.env.SEAL_BATCHES!, 'utf-8'));
        const dropOlder = db.prepare(`DELETE FROM recovery_shares WHERE owner_pubkey = ? AND generation < ?`);
        const insertShare = db.prepare(`INSERT OR REPLACE INTO recovery_shares
            (owner_pubkey, holder_type, holder_ref, share_index, encrypted_share,
             share_iv, share_tag, ephemeral_pubkey, sso_lookup_hash, sso_lookup_salt,
             kdf_params, generation, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
        for (const batch of batches) {
            db.transaction(() => {
                for (const rs of batch) {
                    dropOlder.run(rs.ownerPubkey, rs.generation);
                    insertShare.run(
                        rs.ownerPubkey, rs.holderType, rs.holderRef, rs.shareIndex,
                        rs.encryptedShare, rs.shareIv, rs.shareTag,
                        rs.ephemeralPubkey ?? null, rs.ssoLookupHash ?? null,
                        rs.ssoLookupSalt ?? null, rs.kdfParams ?? null,
                        rs.generation, rs.createdAt, rs.updatedAt || rs.createdAt,
                    );
                }
            })();
            db.pragma('wal_checkpoint(TRUNCATE)');
        }
        const kdfs = db.prepare('SELECT kdf_params FROM recovery_shares').pluck().all() as (string | null)[];
        out.cleared = (db.prepare('SELECT value FROM node_config WHERE key = ?').get(CLEARED_KEY) as any)?.value ?? null;
        out.rows = kdfs.length;
        out.unwrapped = kdfs.filter(k => !k?.includes('node-wrap-xc20p-v1')).length;
    } else if (mode === 'main-export') {
        // The main server after the upgrade's boot (the wrap and its VACUUM), and what its two pull routes send a standby:
        // a delta since the standby's last pull before the seal (sync-delta), and a whole copy (sync-snapshot).
        const { initStateEngine, exportSyncState } = await import('./state-engine.js');
        initStateEngine();
        const { db } = await import('./db/db.js');
        out.cleared = (db.prepare('SELECT value FROM node_config WHERE key = ?').get(CLEARED_KEY) as any)?.value ?? null;
        out.mainEpochKept = !!db.prepare("SELECT 1 FROM node_config WHERE key = 'recovery_seal_main_epoch'").get();
        // The watched copies in its state.db, -wal and -shm as they are while it runs.
        if (process.env.SEAL_WATCH) out.inFiles = copiesFoundIn(dataDir, JSON.parse(fs.readFileSync(process.env.SEAL_WATCH, 'utf-8')));
        const delta = await exportSyncState('main-server', process.env.SEAL_SINCE!);
        const full = await exportSyncState('main-server');
        out.delta = delta.recoveryShares ?? [];
        out.full = full.recoveryShares ?? [];
        out.deltaEpoch = delta.sealEpoch ?? null;
        out.epoch = full.sealEpoch ?? null;
    } else if (mode === 'standby-pull') {
        // A standby (NODE_ROLE=backup) running its real puller against its main server's two pull routes, served here on
        // localhost: each answers with the main server's own rows (SEAL_MAIN_EXPORT) in a payload signed by the key this
        // standby trusts as its mirror, and records what the puller asked for and what the standby held at that moment.
        // Routine whole copies are off (as on a large database), so the pull after the seal is a delta.
        const { initStateEngine, exportSyncState, signSyncPayload, setSyncCursor } = await import('./state-engine.js');
        initStateEngine();
        const { db } = await import('./db/db.js');
        const state = () => {
            const kdfs = db.prepare('SELECT kdf_params FROM recovery_shares').pluck().all() as (string | null)[];
            return {
                cleared: (db.prepare('SELECT value FROM node_config WHERE key = ?').get(CLEARED_KEY) as any)?.value ?? null,
                rows: kdfs.length,
                unwrapped: kdfs.filter(k => !k?.includes('node-wrap-xc20p-v1')).length,
                owners: db.prepare('SELECT owner_pubkey FROM recovery_shares ORDER BY owner_pubkey').pluck().all(),
            };
        };
        out.secureDelete = db.pragma('secure_delete', { simple: true });
        out.keyExists = fs.existsSync(path.join(dataDir, KEY_FILE));
        out.atBoot = state();
        const main: { delta: unknown[]; full: unknown[] } = JSON.parse(fs.readFileSync(process.env.SEAL_MAIN_EXPORT!, 'utf-8'));
        const { startP2P } = await import('./p2p.js');
        const { addConnector } = await import('./connector-manager.js');
        const { updateLocalConfig } = await import('./config/local-config.js');
        const puller = await import('./services/backup-puller.js');
        const http = await import('node:http');
        const node = await startP2P(0, 0);
        const nodeId = node.peerId.toString();
        const pulls: { route: string; since: string | null; snapshotCursor: string | null; at: number; before: ReturnType<typeof state> }[] = [];
        const server = http.createServer((req, res) => {
            const route = (req.url ?? '').split('?')[0];
            const which = route === '/api/local/admin/sync-delta' ? 'delta' : route === '/api/local/admin/sync-snapshot' ? 'snapshot' : null;
            if (!which) { res.writeHead(404).end(); return; }
            pulls.push({
                route: which, since: (req.headers['x-since-cursor'] as string) ?? null,
                snapshotCursor: (req.headers['x-snapshot-cursor'] as string) ?? null, at: Date.now(), before: state(),
            });
            void (async () => {
                const payload: any = await exportSyncState(nodeId);
                payload.recoveryShares = which === 'delta' ? main.delta : main.full;
                delete payload.signature;
                delete payload.publicKey;
                res.writeHead(200, { 'Content-Type': 'application/json', 'X-Node-Role': 'primary' })
                    .end(JSON.stringify(await signSyncPayload(payload)));
            })();
        });
        await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => resolve()));
        try {
            addConnector(`/ip4/127.0.0.1/tcp/1/p2p/${nodeId}`, 'mirror', 'main-server');
            updateLocalConfig({
                backupPrimaryUrl: `http://localhost:${(server.address() as { port: number }).port}`,
                backupReplicationToken: 'test-replication-token', backupPullSeconds: 5, backupReconcileMinutes: 0,
            });
            // Where its last pull before the seal left it: the puller resumes deltas from here.
            setSyncCursor('backup:primary', process.env.SEAL_SINCE!);
            puller.initBackupPuller();
            const deadline = Date.now() + 45_000;
            while (Date.now() < deadline && !(pulls.length >= 3 && (puller.getBackupStatus().lastSuccessAt ?? 0) >= pulls[2].at)) {
                await new Promise(r => setTimeout(r, 100));
            }
        } finally {
            puller.stopBackupPuller();
            server.close();
            await node.stop();
        }
        out.pulls = pulls.map(p => ({ route: p.route, since: p.since, snapshotCursor: p.snapshotCursor, before: p.before }));
        out.final = state();
    } else if (mode === 'standby-script') {
        // A standby (NODE_ROLE=backup) running its real puller against a localhost stand-in for its main server, which
        // answers the puller's requests in turn with SEAL_SCRIPT's steps (then with no copy), in a payload signed by the
        // key this standby trusts as its mirror. At each request, and at the end, it records what the standby holds and
        // how many of the watched copies its state.db, -wal and -shm hold as they are while it runs: a clean close would
        // fold the WAL away, and a node that is stopped does not close its database (engine/shutdown-recovery.ts).
        const script: StandbyScript = JSON.parse(fs.readFileSync(process.env.SEAL_SCRIPT!, 'utf-8'));
        if (process.env.SEAL_FREE_BYTES) {
            const seal = await import('./services/recovery-seal-key.js');
            seal._setFreeBytesForTests(Number(process.env.SEAL_FREE_BYTES));
        }
        const { initStateEngine, exportSyncState, signSyncPayload, setSyncCursor } = await import('./state-engine.js');
        initStateEngine();
        const { db } = await import('./db/db.js');
        const state = () => {
            const kdfs = db.prepare('SELECT kdf_params FROM recovery_shares').pluck().all() as (string | null)[];
            return {
                cleared: (db.prepare('SELECT value FROM node_config WHERE key = ?').get(CLEARED_KEY) as any)?.value ?? null,
                rows: kdfs.length,
                unwrapped: kdfs.filter(k => !k?.includes('node-wrap-xc20p-v1')).length,
                inFiles: copiesFoundIn(dataDir, script.watch),
            };
        };
        out.atBoot = state();
        const { startP2P } = await import('./p2p.js');
        const { addConnector } = await import('./connector-manager.js');
        const { updateLocalConfig } = await import('./config/local-config.js');
        const puller = await import('./services/backup-puller.js');
        const http = await import('node:http');
        const node = await startP2P(0, 0);
        const nodeId = node.peerId.toString();
        const pulls: { route: string; snapshotCursor: string | null; at: number; before: ReturnType<typeof state> }[] = [];
        const server = http.createServer((req, res) => {
            const route = (req.url ?? '').split('?')[0];
            const which = route === '/api/local/admin/sync-delta' ? 'delta' : route === '/api/local/admin/sync-snapshot' ? 'snapshot' : null;
            if (!which) { res.writeHead(404).end(); return; }
            const rows = script.steps[pulls.length] ?? [];
            const epoch = script.epochs?.length ? script.epochs[Math.min(pulls.length, script.epochs.length - 1)] : null;
            pulls.push({ route: which, snapshotCursor: (req.headers['x-snapshot-cursor'] as string) ?? null, at: Date.now(), before: state() });
            void (async () => {
                const payload: any = await exportSyncState(nodeId);
                // What this standby's own export names: a standby names no epoch of its own.
                if (!('ownEpoch' in out)) out.ownEpoch = payload.sealEpoch ?? null;
                payload.recoveryShares = rows;
                if (epoch) payload.sealEpoch = epoch; else delete payload.sealEpoch;
                delete payload.signature;
                delete payload.publicKey;
                res.writeHead(200, { 'Content-Type': 'application/json', 'X-Node-Role': 'primary' })
                    .end(JSON.stringify(await signSyncPayload(payload)));
            })();
        });
        await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => resolve()));
        try {
            addConnector(`/ip4/127.0.0.1/tcp/1/p2p/${nodeId}`, 'mirror', 'main-server');
            updateLocalConfig({
                backupPrimaryUrl: `http://localhost:${(server.address() as { port: number }).port}`,
                backupReplicationToken: 'test-replication-token', backupPullSeconds: 5, backupReconcileMinutes: script.reconcileMinutes,
            });
            if (script.since) setSyncCursor('backup:primary', script.since);
            if (script.resyncFirst) out.resync = await puller.requestResync();
            if (pulls.length < script.pulls) {
                puller.initBackupPuller();
                const deadline = Date.now() + 45_000;
                while (Date.now() < deadline && !(pulls.length >= script.pulls
                    && (puller.getBackupStatus().lastSuccessAt ?? 0) >= pulls[script.pulls - 1].at)) {
                    await new Promise(r => setTimeout(r, 100));
                }
            }
        } finally {
            puller.stopBackupPuller();
            server.close();
            await node.stop();
        }
        out.pulls = pulls.map(p => ({ route: p.route, snapshotCursor: p.snapshotCursor, before: p.before }));
        out.final = state();
    } else if (mode === 'takeover-open') {
        // The standby promoted (NODE_ROLE=primary), then every member's copy read through the server's own reader.
        const { initStateEngine } = await import('./state-engine.js');
        initStateEngine();
        const { getCurrentShares } = await import('./engine/recovery-shares.js');
        const h: History = JSON.parse(fs.readFileSync(process.env.SEAL_HISTORY!, 'utf-8'));
        const deleted = new Set(h.deleted);
        const same: number[] = [], differ: number[] = [], missing: number[] = [], unopenable: string[] = [], held: number[] = [];
        const opened: Record<number, string> = {};
        for (let i = 0; i < h.owners.length; i++) {
            let sso;
            try { sso = getCurrentShares(h.owners[i]).find(s => s.holderType === 'sso'); }
            catch (e) { unopenable.push(`${i}: ${thrown(e)}`); continue; }
            if (deleted.has(i)) { if (sso) held.push(i); continue; }
            if (!sso) { missing.push(i); continue; }
            const c = h.gen2[i];
            const exact = sso.encryptedShare === c.encryptedShare && sso.shareIv === c.shareIv
                && sso.shareTag === c.shareTag && sso.kdfParams === c.kdfParams;
            (exact ? same : differ).push(i);
            const real = h.real.find(r => r.i === i);
            if (real) {
                try {
                    const o = await openSeedFromSso(
                        { encryptedShare: sso.encryptedShare, shareIv: sso.shareIv, shareTag: sso.shareTag, kdfParams: sso.kdfParams ?? '' },
                        'google', GOOGLE_SUB,
                    );
                    opened[i] = Buffer.from(o.seed).toString('hex') === real.seedHex ? 'its seed' : 'another seed';
                } catch (e) { opened[i] = thrown(e); }
            }
        }
        Object.assign(out, { same: same.length, differ, missing, unopenable, held, opened });
    } else if (mode === 'main-envelope') {
        // The main server's take-over envelope, as its own service seals it (S2): its node key, its genesis, and a
        // recovery code, over the database main-export left.
        const { initStateEngine } = await import('./state-engine.js');
        initStateEngine();
        const { ensureGenesis } = await import('./genesis.js');
        await ensureGenesis();
        const keyFile = path.join(dataDir, 'libp2p_key');
        const { generateKeyPair, privateKeyToProtobuf, privateKeyFromProtobuf } = await import('@libp2p/crypto/keys');
        if (!fs.existsSync(keyFile)) fs.writeFileSync(keyFile, privateKeyToProtobuf(await generateKeyPair('Ed25519')), { mode: 0o600 });
        const { peerIdFromPrivateKey } = await import('@libp2p/peer-id');
        const { makeRecoveryCode, getSealedTakeoverEnvelope } = await import('./services/takeover-envelope.js');
        const made = await makeRecoveryCode();
        const got = await getSealedTakeoverEnvelope();
        if (got.envelopeId === null) throw new Error(`no envelope: ${got.status.message}`);
        Object.assign(out, {
            code: made.code, envelopeId: got.envelopeId, envelope: got.bytes.toString('base64'),
            peerId: peerIdFromPrivateKey(privateKeyFromProtobuf(fs.readFileSync(keyFile))).toString(),
        });
    } else if (mode === 'takeover-confirm') {
        // The standby takes over by recovery code through the real take-over (services/takeover.ts): the envelope its
        // puller keeps, pinned to its main server; the code opens it; the confirm runs every step up to the restart.
        const { initStateEngine } = await import('./state-engine.js');
        initStateEngine();
        const { addConnector } = await import('./connector-manager.js');
        addConnector(`/ip4/127.0.0.1/tcp/1/p2p/${process.env.SEAL_MAIN_PEER}`, 'mirror', 'main-server');
        const envelope = Buffer.from(fs.readFileSync(process.env.SEAL_ENVELOPE!, 'utf-8'), 'base64');
        const { readSealedHeader } = await import('@beanpool/core');
        const held = path.join(dataDir, 'held-takeover-envelopes');
        fs.mkdirSync(held, { recursive: true });
        fs.writeFileSync(path.join(held, `${String(Date.now()).padStart(13, '0')}-${readSealedHeader(new Uint8Array(envelope)).envelopeId}.bpseal`), envelope, { mode: 0o600 });
        const t = await import('./services/takeover.js');
        t.setTakeoverRestartForTests(() => { /* the next child is the restart */ });
        const code = process.env.SEAL_CODE!;
        const preview = await t.openTakeoverSession(code, t.pickEnvelope(t.parseTypedCode(code).codeId));
        t.confirmTakeover(preview.sessionId);
        const journal = JSON.parse(fs.readFileSync(path.join(dataDir, 'takeover-journal.json'), 'utf-8'));
        Object.assign(out, { recoverySealKey: preview.recoverySealKey, identityFiles: journal.steps['identity-files']?.detail ?? null });
    } else if (mode === 'carried-key-rewrap') {
        // 19: a main server (key K1) holds copies and a release under K1; a carried key K2 takes its place.
        const { initStateEngine } = await import('./state-engine.js');
        initStateEngine();
        const { db } = await import('./db/db.js');
        const seal = await import('./services/recovery-seal-key.js');
        const { storeVerifiedSsoKeeperGeneration } = await import('./engine/keeper-deposit.js');
        const { getCurrentShares } = await import('./engine/recovery-shares.js');
        const k1 = fs.readFileSync(path.join(dataDir, KEY_FILE));
        // Each owner's own 12 words (the fixture phrase turned round), and the seed they make, as the apps derive it.
        const phrases = [1, 2, 3].map(n => [...WORDS.slice(n), ...WORDS.slice(0, n)]);
        const owners = phrases.map(w => idFromSeed(crypto.createHash('sha256').update(crypto.createHash('sha256').update(w.join(' ')).digest()).digest()));
        const deposits: Sealed[] = [];
        for (const [i, o] of owners.entries()) {
            db.prepare(`INSERT INTO members (public_key, callsign, status, joined_at, invited_by, invite_code)
                        VALUES (?, ?, 'active', strftime('%Y-%m-%dT%H:%M:%fZ','now'), 'seal-test', 'TEST')`).run(o.pk, `S2-${o.pk.slice(0, 6)}`);
            const c = await sealSeedToSso(new Uint8Array(o.seed), 'google', GOOGLE_SUB, { words: phrases[i] }) as Sealed;
            deposits.push(c);
            await storeVerifiedSsoKeeperGeneration({ provider: 'google', sub: GOOGLE_SUB } as any, o.pk, [{ holderType: 'sso', holderRef: 'google', shareIndex: 1, ...c } as any]);
        }
        // A release of the first owner's copy, stored as the release path stores it: wrapped, bound to where it sits.
        db.prepare(`INSERT INTO recovery_collections (id, owner_pubkey, generation, requester_ephemeral_pubkey, status, created_at, expires_at)
                    VALUES ('s2-collection', ?, 1, 'eph', 'complete', ?, ?)`).run(owners[0].pk, '2026-09-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z');
        const rel = seal.sealRecoveryFields(deposits[0], seal.releaseRowAad('s2-collection', 7, 'sso'));
        db.prepare(`INSERT INTO recovery_releases (collection_id, share_id, holder_type, share_index, payload, payload_iv, payload_tag, kdf_params, released_at)
                    VALUES ('s2-collection', 7, 'sso', 1, ?, ?, ?, ?, ?)`).run(rel.encryptedShare, rel.shareIv, rel.shareTag, rel.kdfParams, '2026-09-01T00:00:00.000Z');
        // The third owner's row is altered: no key opens it.
        db.prepare("UPDATE recovery_shares SET share_tag = ? WHERE owner_pubkey = ?").run(Buffer.alloc(16, 9).toString('base64'), owners[2].pk);
        const raw = (pk: string) => db.prepare('SELECT encrypted_share, share_iv, share_tag, kdf_params, updated_at FROM recovery_shares WHERE owner_pubkey = ?').get(pk) as any;
        const before = owners.map(o => raw(o.pk));
        const rows = () => db.prepare('SELECT owner_pubkey, holder_type, encrypted_share, share_iv, share_tag, kdf_params FROM recovery_shares').all() as any[];

        const k2 = crypto.randomBytes(32);
        out.install = seal.installCarriedRecoverySealKey(k2.toString('base64'));
        out.liveIsK2 = fs.readFileSync(path.join(dataDir, KEY_FILE)).equals(k2);
        const retired = fs.readdirSync(dataDir).filter(n => n.startsWith('recovery-seal-retired-'));
        out.retired = retired.map(n => ({ n, isK1: fs.readFileSync(path.join(dataDir, n)).equals(k1), mode: (fs.statSync(path.join(dataDir, n)).mode & 0o777).toString(8) }));
        out.liveOnlyBefore = seal.countUnopenable(rows(), { retired: false });
        out.withRetiredBefore = seal.countUnopenable(rows());
        // The reader opens what only the retired key opens, before anything is locked again.
        try {
            const got = getCurrentShares(owners[0].pk).find(x => x.holderType === 'sso')!;
            out.readerBefore = got.encryptedShare === deposits[0].encryptedShare && got.kdfParams === deposits[0].kdfParams ? 'the deposit' : 'other bytes';
        } catch (e) { out.readerBefore = thrown(e); }
        await new Promise(r => setTimeout(r, 5));
        out.rewrap = seal.rewrapRowsFromRetiredKeys();
        const after = owners.map(o => raw(o.pk));
        out.liveOnlyAfter = seal.countUnopenable(rows(), { retired: false });
        out.stamped = [0, 1].every(i => after[i].updated_at !== before[i].updated_at && after[i].encrypted_share !== before[i].encrypted_share);
        out.alteredLeft = JSON.stringify(after[2]) === JSON.stringify(before[2]);
        const relRow = db.prepare("SELECT payload, payload_iv, payload_tag, kdf_params FROM recovery_releases WHERE collection_id = 's2-collection'").get() as any;
        try {
            const back = seal.openRecoveryFields({ encryptedShare: relRow.payload, shareIv: relRow.payload_iv, shareTag: relRow.payload_tag, kdfParams: relRow.kdf_params },
                seal.releaseRowAad('s2-collection', 7, 'sso'));
            out.releaseAfter = relRow.payload !== rel.encryptedShare && back.encryptedShare === deposits[0].encryptedShare ? 're-locked, same inside' : 'unchanged';
        } catch (e) { out.releaseAfter = thrown(e); }
        out.rewrapAgain = seal.rewrapRowsFromRetiredKeys();
        out.retiredStill = fs.readdirSync(dataDir).filter(n => n.startsWith('recovery-seal-retired-')).length;
        out.tmpLeft = fs.readdirSync(dataDir).filter(n => n.includes('.tmp')).length;
    } else {
        out.error = `unknown child mode ${mode}`;
    }
    console.log(`RESULT ${JSON.stringify(out)}`);
}

// ── the parent ─────────────────────────────────────────────────────────────────────────────────────
let run = 0, passed = 0;
export function check(cond: boolean, msg: string): void {
    run++;
    if (cond) { passed++; console.log(`✓ ${msg}`); } else console.error(`✗ ${msg}`);
}
export async function section(name: string, fn: () => Promise<void>): Promise<void> {
    console.log(`\n── ${name} ──`);
    try { await fn(); } catch (e) { check(false, `${name}: ${thrown(e)}`); }
}

/** The end of every suite: the count, and a failure if any check failed. */
export function finish(done: string): void {
    console.log(`\n${passed}/${run} checks passed.`);
    if (passed !== run) throw new Error(`${run - passed} check(s) failed`);
    console.log(done);
}

/** The lines a child printed about the seal, for a check's message. */
export const sealLines = (r: ChildResult) => (r.stdout + r.stderr).split('\n').filter(l => l.includes('Recovery seal')).join(' | ');

/**
 * This process as a main server: its database in BEANPOOL_DATA_DIR, its key file beside it, its HTTPS server on a free
 * port, and a stand-in Google; with the signed calls, members and deposits the suites make to it. Where a section
 * scripts a standby's main server, this process's key stands in for that server's.
 */
export async function bootParent() {
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

    return { dataDir, keyPath, dbPath, getCurrentShares, listReleases, call, addMember, deposit, collectGoogle, dbFiles, foundInDbFiles };
}

/**
 * What 21–29 share: 12 members with two generations of copies, the seal epochs E1 and E2 their main server names, and
 * the standby runs they go through. `suite` is the file the standby processes are started from (the caller's own).
 */
export async function epochFixtures(suite: string) {
    const sealLib = await import('./services/recovery-seal-key.js');
    const EPOCH_RE = /^[0-9a-f]{16}$/;
    const EN = 12;
    const eOwners = Array.from({ length: EN }, () => crypto.randomBytes(32).toString('hex'));
    const eGen2 = eOwners.map(() => fakeCopy());
    const eGen3 = eOwners.map(() => fakeCopy());
    const eWatch = [...eGen2, ...eGen3];
    // As in 18: this process's key stands in for the main server's, which the standby never holds.
    const eWrapped = (copiesOf: Sealed[], generation: number, at: string, only?: number[]) => eOwners.map((o, i) => ({ o, i }))
        .filter(({ i }) => !only || only.includes(i))
        .map(({ o, i }) => exportRow(o, i, sealLib.sealRecoveryFields(copiesOf[i], sealLib.shareRowAad(o, 'sso')), generation, at));
    const eClientForm = (copiesOf: Sealed[], generation: number, at: string, only?: number[]) => eOwners.map((o, i) => ({ o, i }))
        .filter(({ i }) => !only || only.includes(i))
        .map(({ o, i }) => exportRow(o, i, copiesOf[i], generation, at));
    const E1 = crypto.randomBytes(8).toString('hex');
    const E2 = crypto.randomBytes(8).toString('hex');
    const epochOf = (cleared: unknown) => {
        if (typeof cleared !== 'string') return null;
        try { return JSON.parse(cleared).epoch ?? 'none'; } catch { return 'unparseable'; }
    };
    const briefE = (x: any) => JSON.stringify(x && { cleared: !!x.cleared, epoch: epochOf(x.cleared) === E1 ? 'E1' : epochOf(x.cleared) === E2 ? 'E2' : epochOf(x.cleared),
        rows: x.rows, unwrapped: x.unwrapped, inFiles: x.inFiles });
    const epochForgets = /now names a seal epoch it did not clear under .* So it forgets that clear/;
    const vacuumsOf = (r: ChildResult) => (r.stdout.match(/one VACUUM/g) ?? []).length;
    const jsonFile = (label: string, value: unknown) => {
        const f = path.join(tempDir(label), `${label}.json`);
        fs.writeFileSync(f, JSON.stringify(value));
        return f;
    };
    const runStandby = (dir: string, label: string, script: StandbyScript, env: Record<string, string> = {}) =>
        runChild([suite], dir, { RECOVERY_SEAL_CHILD: 'standby-script', NODE_ROLE: 'backup', SEAL_SCRIPT: jsonFile(label, script), ...env });
    const olderImport = (dir: string, label: string, batches: unknown[][]) =>
        runChild([suite], dir, { RECOVERY_SEAL_CHILD: 'older-standby-import', NODE_ROLE: 'backup', SEAL_BATCHES: jsonFile(label, batches) });
    /** A stopped standby's data folder, copied whole: its files as they lie, WAL included. */
    const copyOfDir = (dir: string, label: string) => {
        const d = tempDir(label);
        fs.cpSync(dir, d, { recursive: true });
        return d;
    };
    const T2 = '2026-06-02T00:00:00.000Z', T5 = '2026-06-05T00:00:00.000Z', T6 = '2026-06-06T00:00:00.000Z', T7 = '2026-06-07T00:00:00.000Z';
    // 26–28: the member who removes their copy while the rollback lasts, and what the standby says about it.
    const REMOVER = 3;
    const allBut = (skip: number[]) => eOwners.map((_, i) => i).filter(i => !skip.includes(i));
    const asksAgain = /still in the client's form after its main server sealed again\. This standby asks that server for one whole copy/;
    const removedOne = /removed 1 sign-in recovery copy its main server deleted before the seal/;

    return {
        sealLib, EPOCH_RE, EN, eOwners, eGen2, eGen3, eWatch, eWrapped, eClientForm, E1, E2, epochOf, briefE, epochForgets, vacuumsOf,
        jsonFile, runStandby, olderImport, copyOfDir, T2, T5, T6, T7, REMOVER, allBut, asksAgain, removedOne,
    };
}
