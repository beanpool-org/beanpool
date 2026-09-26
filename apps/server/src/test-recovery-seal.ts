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
 *  13. the same on a standby, which never wraps, with the history of a real one: it imported deposits and re-deposits,
 *      then its main server's members disconnected or were purged, which no pull carries, so their copies are still rows
 *      there that open with the sub alone. Its one VACUUM waits while every copy is in the old form and runs after the
 *      delta that brings the main server's wrapped ones; that delta removes nothing, and the standby's real puller then
 *      pulls one whole copy, after which none of the deleted copies is a row, none of any dropped or replaced copy is left
 *      in its state.db, -wal or -shm, and after a take-over (the real one, by recovery code: the main server's key comes
 *      inside its take-over envelope, S2) every current copy opens to exactly what its member deposited and no deleted
 *      one came back;
 *  14. a data folder without hard links (link() fails with EPERM, ENOTSUP, EMLINK, ENOSYS or EXDEV) still gets its key,
 *      made in place, never over a file already there, and a failed write leaves nothing behind;
 *  15. on a standby, only a whole copy removes a copy in the old form, and only one its main server no longer holds;
 *  16. a standby that holds no copy at its first boot on this code (a new one beside a main server that has not updated,
 *      or one whose main server holds none yet) records no clear: it seeds by its real force-resync from the main server
 *      before the seal, takes the members' re-deposits, and only the delta that brings the wrapped copies clears it, after
 *      which its running state.db, -wal and -shm hold none of the copies it was sent in the client's form;
 *  17. a standby whose main server deleted every copy before the seal: a routine whole copy of that server removes all
 *      of them and a force-resync clears them, and either way its running files hold none of them, nor of the older copies
 *      its re-deposits dropped, while it records no clear until the first wrapped copy arrives;
 *  18. (S2, S1's last finding) a standby that recorded its clear and is then sent copies in the client's form (its main
 *      server rolled back past the seal) forgets the record, waits through the rollback's deltas, and clears again after
 *      the delta that brings the wrapped copies back, after which its running files hold none of them;
 *  19. (S2) a carried key never loses one already there: the one it replaces is kept (retired), byte for byte, 0600;
 *      the reader opens what only the retired key opens; the boot locks those rows again with the live key; a crash
 *      between the two writes finishes at the next run; nothing is ever written over a different file.
 *  20. (S2, the deciding pass on 45ee304a) 18 in a FLEET rollback, where the standby runs the older code too while it
 *      lasts, so this code never sees a copy in the client's form arrive: at its next boot on this code it forgets its
 *      clear, and clears again after the delta that brings the wrapped copies back, after which its running files hold
 *      none of them. The copies its main server deleted before the seal, still rows here when it recorded its clear,
 *      never make it forget, at any boot, whichever way the two servers' clocks differ.
 *  21. (the seal epoch) a main server names a seal epoch when it records its clear, and a delta and a whole copy both
 *      carry it; a later boot keeps it; after the rollback command the next seal names a new one; a clear recorded
 *      before epochs is named one at the next boot, with no second VACUUM.
 *  22. a rollback where the main server is updated first: the standby's OLDER code pulls the re-sealed copies itself, so
 *      nothing here is in the client's form when this code boots. Its first pull names the new epoch, and it clears again
 *      at once, recorded under that epoch, after which its running files hold none of the copies sent in the client's form.
 *  23. a rollback where the standby runs this code before any wrapped pull: it waits while its main server is rolled back,
 *      and clears after the pull that brings the wrapped copies and the new epoch, recorded under it; files clean.
 *  24. a clear that fails for disk room after a forget is tried again at the next boot, which clears before any pull.
 *  25. copies its main server deleted before the seal (rows until a whole copy removes them) never make a standby forget
 *      or clear again across boots; a new epoch clears once, at the whole copy it asks for; one VACUUM per epoch, not
 *      per boot; a pull from a main server that names no epoch changes nothing.
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

/**
 * 13's history, made in the parent and written by the code before the seal on both sides (child 'pre-seal-history'):
 * each owner's first and second deposit, the owners who then deleted theirs, and the owners whose second copy the app
 * really sealed (the rest are shaped like one), with the seed each opens to.
 */
interface History {
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
interface StandbyScript {
    resyncFirst: boolean; reconcileMinutes: number; pulls: number; steps: unknown[][]; watch: Sealed[]; since?: string;
    epochs?: (string | null)[];
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

/** How many of these copies a data directory's state.db, -wal and -shm hold any piece of, as the files are right now. */
function copiesFoundIn(dir: string, copies: Sealed[]): number {
    const files = Buffer.concat(['state.db', 'state.db-wal', 'state.db-shm']
        .map(f => path.join(dir, f)).filter(p => fs.existsSync(p)).map(p => fs.readFileSync(p)));
    return copies.filter(c => needlesOf(c).some(n => files.includes(n.bytes))).length;
}

/** A copy as a main server's export sends it (engine/sync.ts exportSyncState), for the rows pre-seal-history writes. */
function exportRow(owner: string, i: number, c: { encryptedShare: string; shareIv: string; shareTag: string; kdfParams: string | null },
    generation: number, at: string) {
    return {
        ownerPubkey: owner, holderType: 'sso', holderRef: 'google', shareIndex: 1,
        encryptedShare: c.encryptedShare, shareIv: c.shareIv, shareTag: c.shareTag, ephemeralPubkey: null,
        ssoLookupHash: `lookup-${i}`, ssoLookupSalt: 'lookup-salt', kdfParams: c.kdfParams, generation, createdAt: at, updatedAt: at,
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
        const fx = resultOf(await runChild([SCRIPT], dir, { RECOVERY_SEAL_CHILD: 'pre-seal-node' }));
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
    await section('13. a standby holding copies its main server deleted before the seal clears its files, then the copies, and keeps every current one', async () => {
        const mainDir = tempDir('history-main');
        const standbyDir = tempDir('history-standby');
        const N = 24;
        const owners = Array.from({ length: N }, () => crypto.randomBytes(32).toString('hex'));
        const h: History = { owners, gen1: owners.map(() => fakeCopy()), gen2: owners.map(() => fakeCopy()), deleted: [18, 19, 20, 21, 22, 23], real: [] };
        // Two members who keep their copy and one who deletes it have copies the app really sealed, so each can be opened.
        for (const i of [0, 1, 18]) {
            const words = [...WORDS.slice(i % WORDS.length), ...WORDS.slice(0, i % WORDS.length)].reverse();
            const seed = crypto.createHash('sha256').update(crypto.createHash('sha256').update(words.join(' ')).digest()).digest();
            h.gen2[i] = await sealSeedToSso(new Uint8Array(seed), 'google', GOOGLE_SUB, { words }) as Sealed;
            h.real.push({ i, seedHex: seed.toString('hex') });
        }
        const historyFile = path.join(tempDir('history'), 'history.json');
        fs.writeFileSync(historyFile, JSON.stringify(h));
        const deleted = new Set(h.deleted);
        const current = owners.filter((_, i) => !deleted.has(i));
        const orphanCopies = h.gen2.filter((_, i) => deleted.has(i));
        const currentCopies = h.gen2.filter((_, i) => !deleted.has(i));

        const m = resultOf(await runChild([SCRIPT], mainDir, { RECOVERY_SEAL_CHILD: 'pre-seal-history', SEAL_HISTORY: historyFile, SEAL_SIDE: 'main' }));
        const sb = resultOf(await runChild([SCRIPT], standbyDir, { RECOVERY_SEAL_CHILD: 'pre-seal-history', SEAL_HISTORY: historyFile, SEAL_SIDE: 'standby' }));
        check(m.rows === N - h.deleted.length && sb.rows === N,
            `control: before the upgrade the main server holds ${m.rows} copies and its standby ${sb.rows}: the ${h.deleted.length} deleted there are still rows here`);
        const before = copiesFoundIn(standbyDir, h.gen1);
        check(before > 0, `control: ${before} of the ${N} copies the re-deposits dropped are still in the standby's state.db`);
        // What anyone holding a copy of the standby's database could do before: open a deleted member's copy with the sub.
        const snapshotOf = (dir: string) => {
            const copy = tempDir('standby-copy');
            for (const f of ['state.db', 'state.db-wal', 'state.db-shm']) if (fs.existsSync(path.join(dir, f))) fs.copyFileSync(path.join(dir, f), path.join(copy, f));
            return copy;
        };
        const orphanBefore = resultOf(await runChild([SCRIPT], snapshotOf(standbyDir), { RECOVERY_SEAL_CHILD: 'open-without-key', SEAL_OWNER: owners[18] }));
        check(orphanBefore.rowFound === true && orphanBefore.asStored === 'opened',
            `control: on the standby, the copy member 18 deleted is still a row that opens with the sub alone (${orphanBefore.asStored})`);

        // The main server upgrades: the wrap stamps every copy it holds, and its VACUUM runs. SINCE: its standby's last pull
        // before that, after the deletions.
        const SINCE = '2026-06-03T00:00:00.000Z';
        const me = resultOf(await runChild([SCRIPT], mainDir, { RECOVERY_SEAL_CHILD: 'main-export', NODE_ROLE: 'primary', SEAL_SINCE: SINCE }));
        const wrappedOnly = (rows: any[]) => rows.every(r => String(r.kdfParams).includes('node-wrap-xc20p-v1'));
        check(typeof me.cleared === 'string' && me.delta.length === current.length && me.full.length === current.length
            && wrappedOnly(me.delta) && wrappedOnly(me.full),
            `the main server seals, and its next delta, like a whole copy, carries every copy it holds, wrapped (${me.delta.length} and ${me.full.length} of ${current.length})`);
        const exportFile = path.join(tempDir('main-export'), 'export.json');
        fs.writeFileSync(exportFile, JSON.stringify({ delta: me.delta, full: me.full }));

        const r = await runChild([SCRIPT], standbyDir, { RECOVERY_SEAL_CHILD: 'standby-pull', NODE_ROLE: 'backup', SEAL_MAIN_EXPORT: exportFile, SEAL_SINCE: SINCE });
        const s = resultOf(r);
        const [p1, p2, p3] = s.pulls ?? [];
        const brief = (x: any) => JSON.stringify(x && { cleared: !!x.cleared, rows: x.rows, unwrapped: x.unwrapped });
        check(s.keyExists === false && s.secureDelete === 1 && s.atBoot?.cleared === null && s.atBoot?.unwrapped === N,
            `at boot the standby makes no key, zeroes what it deletes, and waits: every copy it holds is in the old form (${JSON.stringify({ key: s.keyExists, secureDelete: s.secureDelete, cleared: s.atBoot?.cleared, unwrapped: s.atBoot?.unwrapped })})`);
        check(/every sign-in recovery copy it holds \(24\) is still in the form stored before the seal/.test(r.stdout + r.stderr),
            `...and says why it waits (${sealLines(r)})`);
        check(p1?.route === 'delta' && p1.since === SINCE, `its first pull after the seal is a delta from where it left off (${JSON.stringify(p1 && { route: p1.route, since: p1.since })})`);
        check(typeof p2?.before?.cleared === 'string' && p2.before.rows === N && p2.before.unwrapped === h.deleted.length,
            `after that delta brings the wrapped copies, it runs its one VACUUM, and a delta removes nothing: the ${h.deleted.length} deleted copies are still rows (${brief(p2?.before)})`);
        check(p2?.route === 'snapshot' && p2.snapshotCursor === null && /6 sign-in recovery copies in the form stored before the seal/.test(r.stdout + r.stderr),
            `...its next pull is a whole copy, never a 304, which it asked for and says why (${JSON.stringify(p2 && { route: p2.route, snapshotCursor: p2.snapshotCursor })})`);
        check(p3?.route === 'delta' && s.final?.unwrapped === 0 && s.final.rows === current.length
            && JSON.stringify(s.final.owners) === JSON.stringify([...current].sort()) && JSON.stringify(p3.before) === JSON.stringify(s.final),
            `after the whole copy, no copy the main server deleted is left, every copy it holds is here, wrapped, and the pulls go back to deltas (${brief(p3?.before)}, then ${p3?.route})`);
        check(/removed 6 sign-in recovery copies its main server deleted before the seal/.test(r.stdout),
            `...and says so (${sealLines(r)})`);
        check((r.stdout.match(/one VACUUM/g) ?? []).length === 1, `the VACUUM ran once (${(r.stdout.match(/one VACUUM/g) ?? []).length})`);

        const dropped = copiesFoundIn(standbyDir, [...h.gen1, ...orphanCopies]);
        check(dropped === 0, `none of the ${N + orphanCopies.length} copies dropped or deleted before the seal is left in the standby's state.db, -wal or -shm (found ${dropped}; ${before} re-deposits before)`);
        const replaced = copiesFoundIn(standbyDir, currentCopies);
        check(replaced === 0, `nor any current copy in the form the wrapped ones replaced (found ${replaced} of ${currentCopies.length})`);
        const orphanAfter = resultOf(await runChild([SCRIPT], snapshotOf(standbyDir), { RECOVERY_SEAL_CHILD: 'open-without-key', SEAL_OWNER: owners[18] }));
        check(orphanAfter.rowFound === false, `the copy member 18 deleted is no longer a row on the standby (${orphanAfter.rowFound})`);

        // A take-over, the real one (S2): the main server's own envelope service seals its keys, the key that opens these
        // copies among them; the standby keeps that envelope, pinned to its main server, and the recovery code opens it.
        const env = resultOf(await runChild([SCRIPT], mainDir, { RECOVERY_SEAL_CHILD: 'main-envelope', NODE_ROLE: 'primary' }));
        check(!fs.existsSync(path.join(standbyDir, KEY_FILE)), 'control: before the take-over the standby has no key file');
        fs.copyFileSync(path.join(mainDir, 'genesis.json'), path.join(standbyDir, 'genesis.json'));
        const envFile = path.join(tempDir('history-envelope'), 'envelope.b64');
        fs.writeFileSync(envFile, env.envelope);
        const tc = resultOf(await runChild([SCRIPT], standbyDir, {
            RECOVERY_SEAL_CHILD: 'takeover-confirm', NODE_ROLE: 'backup', SEAL_ENVELOPE: envFile, SEAL_MAIN_PEER: env.peerId, SEAL_CODE: env.code,
        }));
        const standbyKey = path.join(standbyDir, KEY_FILE);
        check(tc.recoverySealKey === true && /the key that opens members' sign-in recovery copies/.test(tc.identityFiles ?? '')
            && fs.existsSync(standbyKey) && fs.readFileSync(standbyKey).equals(fs.readFileSync(path.join(mainDir, KEY_FILE))) && (fs.statSync(standbyKey).mode & 0o777) === 0o600,
            `the take-over by recovery code brings the main server's key inside its envelope, byte for byte, 0600 (${JSON.stringify({ carried: tc.recoverySealKey, step: tc.identityFiles })})`);
        const t = await runChild([SCRIPT], standbyDir, { RECOVERY_SEAL_CHILD: 'takeover-open', NODE_ROLE: 'primary', SEAL_HISTORY: historyFile });
        const o = resultOf(t);
        check(o.same === current.length && o.differ.length === 0 && o.missing.length === 0 && o.unopenable.length === 0,
            `after a take-over, all ${current.length} current copies open to exactly what each member deposited (same ${o.same}, differ ${JSON.stringify(o.differ)}, missing ${JSON.stringify(o.missing)}, unopenable ${JSON.stringify(o.unopenable)})`);
        check(o.opened?.[0] === 'its seed' && o.opened?.[1] === 'its seed',
            `...and the two the app really sealed open with the sub to their member's seed (${JSON.stringify(o.opened)})`);
        check(o.held.length === 0 && o.opened?.[18] === undefined, `...and none of the ${h.deleted.length} deleted copies came back (${JSON.stringify(o.held)})`);
        check(!/cannot be opened here/.test(t.stderr), `...and the promoted server's boot names no copy it cannot open (${sealLines(t)})`);
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

    // ── 15. only a whole copy removes a copy, and only one the main server no longer holds ───────
    await section('15. on a standby, only a whole copy removes a copy in the old form, and only one its main server no longer holds', async () => {
        const seal = await import('./services/recovery-seal-key.js');
        // This database's other copies are all wrapped, as a standby's are once its main server has sealed.
        const owner = newId().pk, other = newId().pk;
        const put = db.prepare(`INSERT INTO recovery_shares (owner_pubkey, holder_type, holder_ref, share_index, encrypted_share, share_iv,
            share_tag, sso_lookup_hash, sso_lookup_salt, kdf_params, generation) VALUES (?, 'sso', ?, 1, ?, ?, ?, ?, 'lookup-salt', ?, ?)`);
        const add = (o: string, ref: string, generation: number, c: { encryptedShare: string; shareIv: string; shareTag: string; kdfParams: string | null }) =>
            put.run(o, ref, c.encryptedShare, c.shareIv, c.shareTag, crypto.randomBytes(16).toString('hex'), c.kdfParams, generation);
        const held = fakeCopy(), deleted = fakeCopy(), otherSignIn = fakeCopy();
        add(owner, 'google', 2, held);          // still held by the main server in the old form (one rolled back, say)
        add(owner, 'github', 2, otherSignIn);   // same owner and generation, a sign-in the main server no longer holds
        add(other, 'google', 1, deleted);       // deleted there before the seal
        add(other, 'facebook', 1, seal.sealRecoveryFields(fakeCopy(), seal.shareRowAad(other, 'sso')));  // deleted there after it: wrapped
        const count = () => db.prepare('SELECT COUNT(*) FROM recovery_shares').pluck().get() as number;
        const refsOf = (o: string) => db.prepare('SELECT holder_ref FROM recovery_shares WHERE owner_pubkey = ? ORDER BY holder_ref').pluck().all(o);
        const before = count();

        seal.clearCopiesDroppedBeforeSeal({ standby: true, wholeCopy: null });
        check(count() === before && seal.takeRecoverySealFullPull() === true && seal.takeRecoverySealFullPull() === false,
            `after a delta nothing is removed, and the puller is asked once for a whole copy (${before - count()} removed)`);

        const wholeCopy = (db.prepare('SELECT owner_pubkey, generation, holder_type, holder_ref FROM recovery_shares').all() as any[])
            .filter(r => !(r.owner_pubkey === other || (r.owner_pubkey === owner && r.holder_ref === 'github')))
            .map(r => ({ ownerPubkey: r.owner_pubkey, generation: r.generation, holderType: r.holder_type, holderRef: r.holder_ref }));
        seal.clearCopiesDroppedBeforeSeal({ standby: true, wholeCopy });
        check(count() === before - 2 && JSON.stringify(refsOf(owner)) === '["google"]' && JSON.stringify(refsOf(other)) === '["facebook"]',
            `a whole copy removes the 2 copies in the old form it does not hold, and keeps the one it holds in that form and the wrapped one (${JSON.stringify({ owner: refsOf(owner), other: refsOf(other) })})`);
        const left = foundInDbFiles([...needlesOf(deleted), ...needlesOf(otherSignIn)]);
        check(left.length === 0, `...zeroed: none of their bytes is left in state.db, -wal or -shm (found: ${left.join(', ') || 'none'})`);
        db.prepare('DELETE FROM recovery_shares WHERE owner_pubkey IN (?, ?)').run(owner, other);
    });

    // ── 16. a standby that held no copy at its first boot on this code ───────────────────────────
    await section('16. a standby that holds no copy at its first boot waits, and clears its files only once its main server\'s wrapped copies arrive', async () => {
        const mainDir = tempDir('empty-standby-main');
        const standbyDir = tempDir('empty-standby');
        const N = 12;
        const owners = Array.from({ length: N }, () => crypto.randomBytes(32).toString('hex'));
        const h: History = { owners, gen1: owners.map(() => fakeCopy()), gen2: owners.map(() => fakeCopy()), deleted: [], real: [] };
        const historyFile = path.join(tempDir('empty-standby-history'), 'history.json');
        fs.writeFileSync(historyFile, JSON.stringify(h));
        // Its main server, on the code before the seal: every member deposits, then re-deposits. Then it upgrades: the wrap
        // stamps every copy, and its next delta carries them all, wrapped.
        const SINCE = '2026-06-03T00:00:00.000Z';
        resultOf(await runChild([SCRIPT], mainDir, { RECOVERY_SEAL_CHILD: 'pre-seal-history', SEAL_HISTORY: historyFile, SEAL_SIDE: 'main' }));
        const me = resultOf(await runChild([SCRIPT], mainDir, { RECOVERY_SEAL_CHILD: 'main-export', NODE_ROLE: 'primary', SEAL_SINCE: SINCE }));
        check(me.delta.length === N && me.delta.every((r: any) => String(r.kdfParams).includes('node-wrap-xc20p-v1')),
            `control: after the main server seals, its delta carries all ${N} copies, wrapped (${me.delta.length})`);

        // The standby boots on this code holding nothing, and seeds by its real force-resync from the main server before
        // the seal; the members' re-deposits reach it by a delta; then the delta after the seal.
        const scriptFile = path.join(tempDir('empty-standby-script'), 'script.json');
        const script: StandbyScript = {
            resyncFirst: true, reconcileMinutes: 0, pulls: 4, watch: [...h.gen1, ...h.gen2],
            steps: [
                owners.map((o, i) => exportRow(o, i, h.gen1[i], 1, '2026-06-01T00:00:00.000Z')),
                owners.map((o, i) => exportRow(o, i, h.gen2[i], 2, '2026-06-02T00:00:00.000Z')),
                me.delta,
            ],
        };
        fs.writeFileSync(scriptFile, JSON.stringify(script));
        const r = await runChild([SCRIPT], standbyDir, { RECOVERY_SEAL_CHILD: 'standby-script', NODE_ROLE: 'backup', SEAL_SCRIPT: scriptFile });
        const s = resultOf(r);
        const [seed, redeposits, wrapped, after] = s.pulls ?? [];
        const brief = (x: any) => JSON.stringify(x && { cleared: !!x.cleared, rows: x.rows, unwrapped: x.unwrapped, inFiles: x.inFiles });
        check(s.atBoot?.rows === 0 && s.atBoot?.cleared === null,
            `at its first boot, holding no copy, the standby records no clear: nothing shows its main server has sealed (${brief(s.atBoot)})`);
        check(/this standby waits to clear state\.db of sign-in recovery copies deleted before the seal/.test(r.stdout + r.stderr),
            `...and says it waits (${sealLines(r)})`);
        check(s.resync?.ok === true && seed?.route === 'snapshot' && redeposits?.route === 'delta' && wrapped?.route === 'delta' && after?.route === 'delta',
            `it seeds by a force-resync, then pulls deltas (${JSON.stringify({ resync: s.resync, routes: (s.pulls ?? []).map((p: any) => p.route) })})`);
        check(redeposits?.before?.rows === N && redeposits.before.unwrapped === N && redeposits.before.cleared === null && redeposits.before.inFiles > 0,
            `control: after the seed, its files hold copies in the client's form, and it still records nothing (${brief(redeposits?.before)})`);
        check(wrapped?.before?.rows === N && wrapped.before.unwrapped === N && wrapped.before.cleared === null,
            `after the re-deposits it still waits: every copy it holds is in the old form (${brief(wrapped?.before)})`);
        check(typeof after?.before?.cleared === 'string' && after.before.rows === N && after.before.unwrapped === 0,
            `the delta that brings the wrapped copies is when it clears, and records it (${brief(after?.before)})`);
        check(after?.before?.inFiles === 0,
            `...after which its running state.db, -wal and -shm hold none of the ${script.watch.length} copies in the client's form it was sent before the seal (found ${after?.before?.inFiles})`);
        check(s.final?.inFiles === 0 && s.final?.cleared === after?.before?.cleared,
            `...nor after the next pull (found ${s.final?.inFiles})`);
        check((r.stdout.match(/one VACUUM/g) ?? []).length === 1, `the VACUUM ran once (${(r.stdout.match(/one VACUUM/g) ?? []).length})`);
    });

    // ── 17. a standby whose main server deleted every copy before the seal ─────────────────────
    await section('17. a standby whose main server deleted every copy before the seal clears its files once they are gone, and records the clear only when wrapped copies arrive', async () => {
        const N = 12;
        const owners = Array.from({ length: N }, () => crypto.randomBytes(32).toString('hex'));
        const h: History = { owners, gen1: owners.map(() => fakeCopy()), gen2: owners.map(() => fakeCopy()), deleted: owners.map((_, i) => i), real: [] };
        const historyFile = path.join(tempDir('all-deleted-history'), 'history.json');
        fs.writeFileSync(historyFile, JSON.stringify(h));
        // The standby before the seal: it imported every deposit and re-deposit. Its main server then deleted every copy,
        // which never reached it: all N are still rows here, and the re-deposits' older copies are in its free pages.
        const pristine = tempDir('all-deleted-standby');
        const sb = resultOf(await runChild([SCRIPT], pristine, { RECOVERY_SEAL_CHILD: 'pre-seal-history', SEAL_HISTORY: historyFile, SEAL_SIDE: 'standby' }));
        const watch = [...h.gen1, ...h.gen2];
        const before = copiesFoundIn(pristine, h.gen1);
        check(sb.rows === N && before > 0,
            `control: before the upgrade the standby holds all ${sb.rows} copies its main server deleted, and ${before} of the ${N} older ones in its free pages`);
        const copyOf = (dir: string, label: string) => {
            const d = tempDir(label);
            for (const f of ['state.db', 'state.db-wal', 'state.db-shm']) if (fs.existsSync(path.join(dir, f))) fs.copyFileSync(path.join(dir, f), path.join(d, f));
            return d;
        };
        const brief = (x: any) => JSON.stringify(x && { cleared: !!x.cleared, rows: x.rows, unwrapped: x.unwrapped, inFiles: x.inFiles });
        // A member who deposits after the seal: the first wrapped copy the standby is sent.
        const seal = await import('./services/recovery-seal-key.js');
        const newcomer = newId().pk;
        const later = exportRow(newcomer, N, seal.sealRecoveryFields(fakeCopy(), seal.shareRowAad(newcomer, 'sso')), 1, new Date().toISOString());

        // (1) Its routine whole copy of the main server, which holds no copy, then a delta with the newcomer's.
        const routineDir = copyOf(pristine, 'all-deleted-routine');
        const routineFile = path.join(tempDir('all-deleted-routine-script'), 'script.json');
        fs.writeFileSync(routineFile, JSON.stringify({ resyncFirst: false, reconcileMinutes: 60, pulls: 3, watch, steps: [[], [later]] } satisfies StandbyScript));
        const r = await runChild([SCRIPT], routineDir, { RECOVERY_SEAL_CHILD: 'standby-script', NODE_ROLE: 'backup', SEAL_SCRIPT: routineFile });
        const s = resultOf(r);
        const [whole, delta, next] = s.pulls ?? [];
        check(s.atBoot?.rows === N && s.atBoot?.unwrapped === N && s.atBoot?.cleared === null,
            `at boot it waits: every copy it holds is in the old form (${brief(s.atBoot)})`);
        check(whole?.route === 'snapshot' && whole.snapshotCursor === null && delta?.route === 'delta',
            `its first pull is a routine whole copy, never a 304, then a delta (${JSON.stringify((s.pulls ?? []).map((p: any) => p.route))})`);
        check(delta?.before?.rows === 0 && /removed 12 sign-in recovery copies its main server deleted before the seal/.test(r.stdout),
            `the whole copy, which holds none of them, removes all ${N} (${brief(delta?.before)}; ${sealLines(r)})`);
        check(delta?.before?.inFiles === 0,
            `...after which its running state.db, -wal and -shm hold none of the ${watch.length} copies deleted or dropped before the seal (found ${delta?.before?.inFiles}; ${before} older ones before)`);
        check(delta?.before?.cleared === null,
            `...and it records no clear: nothing yet shows its main server has sealed (${brief(delta?.before)})`);
        const unrecorded = /holds no sign-in recovery copy now: the 12 sign-in recovery copies it held in the form stored before the seal are gone\. It cleared state\.db/;
        check(unrecorded.test(r.stdout), '...and says so');
        check(typeof next?.before?.cleared === 'string' && next.before.rows === 1 && next.before.unwrapped === 0 && next.before.inFiles === 0,
            `the delta that brings the first wrapped copy is when it records the clear (${brief(next?.before)})`);

        // (2) The same standby force-resynced from the main server, which holds no copy.
        const resyncDir = copyOf(pristine, 'all-deleted-resync');
        const resyncFile = path.join(tempDir('all-deleted-resync-script'), 'script.json');
        fs.writeFileSync(resyncFile, JSON.stringify({ resyncFirst: true, reconcileMinutes: 0, pulls: 1, watch, steps: [[]] } satisfies StandbyScript));
        const rr = await runChild([SCRIPT], resyncDir, { RECOVERY_SEAL_CHILD: 'standby-script', NODE_ROLE: 'backup', SEAL_SCRIPT: resyncFile });
        const t = resultOf(rr);
        check(t.atBoot?.rows === N && t.resync?.ok === true && t.final?.rows === 0,
            `a force-resync from it leaves the standby holding no copy (${JSON.stringify({ boot: t.atBoot?.rows, resync: t.resync, after: t.final?.rows })})`);
        check(t.final?.inFiles === 0,
            `...and its running state.db, -wal and -shm hold none of the ${watch.length} copies deleted or dropped before the seal (found ${t.final?.inFiles})`);
        check(t.final?.cleared === null && unrecorded.test(rr.stdout), `...and it records no clear, and says so (${brief(t.final)}; ${sealLines(rr)})`);
    });

    // ── 18. a rollback after the standby recorded its clear ────────────────────────────────────────
    await section('18. a standby that recorded its clear and is then sent copies in the client\'s form (a rollback) forgets it, and clears again once the wrapped copies return', async () => {
        const seal = await import('./services/recovery-seal-key.js');
        const standbyDir = tempDir('rollback-standby');
        const N = 12;
        const owners = Array.from({ length: N }, () => crypto.randomBytes(32).toString('hex'));
        const gen2 = owners.map(() => fakeCopy());
        const gen3 = owners.map(() => fakeCopy());
        // What its main server sends, wrapped the way that server wraps (this process's key stands in for it: the standby
        // holds none and never opens a copy, it only tells the forms apart).
        const wrapped = (copiesOf: Sealed[], generation: number, at: string) => owners.map((o, i) =>
            exportRow(o, i, seal.sealRecoveryFields(copiesOf[i], seal.shareRowAad(o, 'sso')), generation, at));
        const clientForm = (copiesOf: Sealed[], generation: number, at: string) => owners.map((o, i) => exportRow(o, i, copiesOf[i], generation, at));
        const scriptFile = path.join(tempDir('rollback-script'), 'script.json');
        const script: StandbyScript = {
            resyncFirst: true, reconcileMinutes: 0, pulls: 5, watch: [...gen2, ...gen3],
            steps: [
                wrapped(gen2, 2, '2026-06-02T00:00:00.000Z'),      // its main server has sealed: the seed is all wrapped
                clientForm(gen2, 2, '2026-06-05T00:00:00.000Z'),   // the rollback command unwraps and stamps every copy
                clientForm(gen3, 3, '2026-06-06T00:00:00.000Z'),   // the older code stores the re-deposits as the app sealed them
                wrapped(gen3, 3, '2026-06-07T00:00:00.000Z'),      // the upgrade again: the wrap stamps every copy
            ],
        };
        fs.writeFileSync(scriptFile, JSON.stringify(script));
        const r = await runChild([SCRIPT], standbyDir, { RECOVERY_SEAL_CHILD: 'standby-script', NODE_ROLE: 'backup', SEAL_SCRIPT: scriptFile });
        const st = resultOf(r);
        const [, afterSeed, afterRollback, afterRedeposits, afterReseal] = (st.pulls ?? []).map((x: any) => x.before);
        const brief = (x: any) => JSON.stringify(x && { cleared: !!x.cleared, rows: x.rows, unwrapped: x.unwrapped, inFiles: x.inFiles });
        check(st.resync?.ok === true && typeof afterSeed?.cleared === 'string' && afterSeed.unwrapped === 0 && afterSeed.inFiles === 0,
            `control: seeded with its main server's wrapped copies, the standby records its clear (${brief(afterSeed)})`);
        check(afterRollback?.cleared === null && afterRollback.unwrapped === N,
            `the rollback's delta brings every copy in the client's form, and it forgets the clear (${brief(afterRollback)})`);
        check(/was then sent 12 sign-in recovery copies in the client's form .* So it forgets that clear/.test(r.stdout + r.stderr),
            `...and says why (${sealLines(r)})`);
        check(afterRedeposits?.cleared === null && afterRedeposits.inFiles > 0,
            `control: after the re-deposits it still waits, and its files hold copies in the client's form (${brief(afterRedeposits)})`);
        check(typeof afterReseal?.cleared === 'string' && afterReseal.unwrapped === 0,
            `the delta that brings the wrapped copies back is when it clears again, and records it (${brief(afterReseal)})`);
        check(afterReseal?.inFiles === 0,
            `...after which its running state.db, -wal and -shm hold none of the ${script.watch.length} copies it was sent in the client's form (found ${afterReseal?.inFiles})`);
        check(st.final?.inFiles === 0 && st.final?.cleared === afterReseal?.cleared, `...nor after the next pull (found ${st.final?.inFiles})`);
        check((r.stdout.match(/one VACUUM/g) ?? []).length === 2, `it cleared twice: at the seed, and after the wrapped copies came back (${(r.stdout.match(/one VACUUM/g) ?? []).length})`);
    });

    // ── 19. a carried key never loses one already there ──────────────────────────────────────────
    await section('19. a carried key never loses one already there: the one it replaces is kept, opens what it locked, and those rows are locked again', async () => {
        const seal = await import('./services/recovery-seal-key.js');
        const savedDir = process.env.BEANPOOL_DATA_DIR;
        const b64 = (b: Buffer) => b.toString('base64');
        const listing = (dir: string) => fs.readdirSync(dir).sort();
        try {
            // Nothing carried, or not a key: nothing is written, and a key already there stays.
            const d1 = tempDir('carried-none');
            process.env.BEANPOOL_DATA_DIR = d1;
            const own = crypto.randomBytes(32);
            fs.writeFileSync(path.join(d1, KEY_FILE), own, { mode: 0o600 });
            const absent = seal.installCarriedRecoverySealKey(null);
            const invalid = seal.installCarriedRecoverySealKey(b64(crypto.randomBytes(31)));
            check(absent.outcome === 'absent' && invalid.outcome === 'invalid' && fs.readFileSync(path.join(d1, KEY_FILE)).equals(own)
                && JSON.stringify(listing(d1)) === JSON.stringify([KEY_FILE]),
                `nothing carried, or not a 32-byte key: nothing is written, and the key already there stays (${absent.outcome}, ${invalid.outcome})`);
            // No key here: it is written, 0600, nothing beside it.
            const d2 = tempDir('carried-fresh');
            process.env.BEANPOOL_DATA_DIR = d2;
            const community = crypto.randomBytes(32);
            const fresh = seal.installCarriedRecoverySealKey(b64(community));
            check(fresh.outcome === 'installed' && fs.readFileSync(path.join(d2, KEY_FILE)).equals(community)
                && (fs.statSync(path.join(d2, KEY_FILE)).mode & 0o777) === 0o600 && JSON.stringify(listing(d2)) === JSON.stringify([KEY_FILE]),
                `no key here: the carried one is written, 0600, and nothing is left beside it (${fresh.outcome})`);
            const same = seal.installCarriedRecoverySealKey(b64(community));
            check(same.outcome === 'same' && JSON.stringify(listing(d2)) === JSON.stringify([KEY_FILE]), 'the same key again (a take-over step run twice) changes nothing');
            // A different key here: kept beside it, byte for byte, 0600, before the carried one takes its place.
            const replaced = seal.installCarriedRecoverySealKey(b64(crypto.randomBytes(32)));
            const kept = replaced.outcome === 'replaced' ? path.join(d2, replaced.retiredAs) : '';
            check(replaced.outcome === 'replaced' && /^recovery-seal-retired-[0-9a-f]{16}\.key$/.test(replaced.retiredAs)
                && fs.readFileSync(kept).equals(community) && (fs.statSync(kept).mode & 0o777) === 0o600 && listing(d2).length === 2,
                `a different key here is never lost: it is kept as ${replaced.outcome === 'replaced' ? replaced.retiredAs : '?'}, byte for byte, 0600`);
            check(!listing(d2).some(n => n.includes(b64(community).slice(0, 12)) || n.includes(community.toString('hex').slice(0, 16))),
                "...under a name that is a hash of it, never its bytes");
            // A crash between the two writes: the old key is in both places; the next run finishes the swap.
            const d3 = tempDir('carried-crash');
            process.env.BEANPOOL_DATA_DIR = d3;
            const old3 = crypto.randomBytes(32), new3 = crypto.randomBytes(32);
            fs.writeFileSync(path.join(d3, KEY_FILE), old3, { mode: 0o600 });
            const first = seal.installCarriedRecoverySealKey(b64(new3));
            const retiredName = first.outcome === 'replaced' ? first.retiredAs : '';
            fs.writeFileSync(path.join(d3, KEY_FILE), old3, { mode: 0o600 }); // as if the rename never happened
            const rerun = seal.installCarriedRecoverySealKey(b64(new3));
            check(rerun.outcome === 'replaced' && rerun.retiredAs === retiredName && fs.readFileSync(path.join(d3, KEY_FILE)).equals(new3)
                && fs.readFileSync(path.join(d3, retiredName)).equals(old3) && listing(d3).length === 2,
                'a crash between keeping the old key and writing the new one: the next run finishes it, with the same kept file');
            // A file of the kept name that holds other bytes is never written over, and never stops the install: the key
            // is kept under another name.
            const d4 = tempDir('carried-collision');
            process.env.BEANPOOL_DATA_DIR = d4;
            const old4 = crypto.randomBytes(32), new4 = crypto.randomBytes(32);
            fs.writeFileSync(path.join(d4, KEY_FILE), old4, { mode: 0o600 });
            const probe = seal.installCarriedRecoverySealKey(b64(crypto.randomBytes(32)));
            const name4 = probe.outcome === 'replaced' ? probe.retiredAs : '';
            fs.writeFileSync(path.join(d4, KEY_FILE), old4, { mode: 0o600 });
            fs.writeFileSync(path.join(d4, name4), Buffer.from('other bytes'), { mode: 0o600 });
            let collided: any;
            try { collided = seal.installCarriedRecoverySealKey(b64(new4)); } catch (e) { collided = thrown(e); }
            const other4 = collided?.outcome === 'replaced' ? path.join(d4, collided.retiredAs) : '';
            check(collided?.outcome === 'replaced' && collided.retiredAs !== name4 && /^recovery-seal-retired-[0-9a-f]{16}\.key$/.test(collided.retiredAs)
                && fs.readFileSync(other4).equals(old4) && (fs.statSync(other4).mode & 0o777) === 0o600
                && fs.readFileSync(path.join(d4, name4)).equals(Buffer.from('other bytes')) && fs.readFileSync(path.join(d4, KEY_FILE)).equals(new4),
                `a file of the kept name holding other bytes is left as it is; the key is kept under another name, and the install goes on (${JSON.stringify(collided)})`);
        } finally {
            process.env.BEANPOOL_DATA_DIR = savedDir;
        }

        // The rows: a main server's copies and a release under its own key (K1), then a carried key (K2).
        const r = await runChild([SCRIPT], tempDir('carried-rewrap'), { RECOVERY_SEAL_CHILD: 'carried-key-rewrap', NODE_ROLE: 'primary' });
        const o = resultOf(r);
        check(o.install?.outcome === 'replaced' && o.liveIsK2 === true && o.retired?.length === 1 && o.retired[0].isK1 && o.retired[0].mode === '600',
            `the carried key takes the place of K1, which is kept (${JSON.stringify({ install: o.install?.outcome, retired: o.retired })})`);
        check(o.liveOnlyBefore?.wrapped === 3 && o.liveOnlyBefore.unopenable === 3 && o.withRetiredBefore?.unopenable === 1,
            `before anything is locked again, the live key alone opens none of the 3, and with the kept key only the altered one stays shut (${JSON.stringify({ live: o.liveOnlyBefore, all: o.withRetiredBefore })})`);
        check(o.readerBefore === 'the deposit', `the reader opens a copy only the kept key opens, to exactly what was deposited (${o.readerBefore})`);
        check(o.rewrap?.shares === 2 && o.rewrap.releases === 1 && o.liveOnlyAfter?.unopenable === 1 && o.stamped === true,
            `locking again: the 2 copies and the release K1 locked, with the live key, stamped so a standby is sent them (${JSON.stringify({ rewrap: o.rewrap, live: o.liveOnlyAfter, stamped: o.stamped })})`);
        check(o.alteredLeft === true, 'a row no key here opens is left exactly as it was');
        check(o.releaseAfter === 're-locked, same inside', `the release, locked again, still opens to what was released (${o.releaseAfter})`);
        check(o.rewrapAgain?.shares === 0 && o.rewrapAgain.releases === 0 && o.retiredStill === 1 && o.tmpLeft === 0,
            `a second run finds nothing; the kept key stays; no temporary file is left (${JSON.stringify({ again: o.rewrapAgain, kept: o.retiredStill, tmp: o.tmpLeft })})`);
    });

    // ── 20. a fleet rollback: the standby runs the older code too ───────────────────────────────
    await section('20. a fleet rollback, the standby on the older code too: at its next boot on this code it forgets its clear and clears again once the wrapped copies return; copies deleted before the seal never make it forget', async () => {
        const seal = await import('./services/recovery-seal-key.js');
        const brief = (x: any) => JSON.stringify(x && { cleared: !!x.cleared, rows: x.rows, unwrapped: x.unwrapped, inFiles: x.inFiles });
        const forgetsAtBoot = /at this boot holds \d+ sign-in recovery cop(y|ies) in the client's form that (was|were) not here when it cleared .* So it forgets that clear/;
        const vacuums = (r: ChildResult) => (r.stdout.match(/one VACUUM/g) ?? []).length;
        const N = 12;
        const owners = Array.from({ length: N }, () => crypto.randomBytes(32).toString('hex'));
        const gen2 = owners.map(() => fakeCopy());
        const gen3 = owners.map(() => fakeCopy());
        // As in 18: this process's key stands in for the main server's, which the standby never holds.
        const wrapped = (copiesOf: Sealed[], generation: number, at: string) => owners.map((o, i) =>
            exportRow(o, i, seal.sealRecoveryFields(copiesOf[i], seal.shareRowAad(o, 'sso')), generation, at));
        const clientForm = (copiesOf: Sealed[], generation: number, at: string) => owners.map((o, i) => exportRow(o, i, copiesOf[i], generation, at));
        const watch = [...gen2, ...gen3];
        const standbyDir = tempDir('fleet-standby');
        const scriptFile = (label: string, script: StandbyScript) => {
            const f = path.join(tempDir(label), 'script.json');
            fs.writeFileSync(f, JSON.stringify(script));
            return f;
        };

        // (1) This code: seeded with its main server's wrapped copies, the standby records its clear.
        const r1 = await runChild([SCRIPT], standbyDir, {
            RECOVERY_SEAL_CHILD: 'standby-script', NODE_ROLE: 'backup',
            SEAL_SCRIPT: scriptFile('fleet-seed', { resyncFirst: true, reconcileMinutes: 0, pulls: 2, watch, steps: [wrapped(gen2, 2, '2026-06-02T00:00:00.000Z')] }),
        });
        const s1 = resultOf(r1);
        const afterSeed = s1.pulls?.[1]?.before;
        check(s1.resync?.ok === true && typeof afterSeed?.cleared === 'string' && afterSeed.unwrapped === 0 && afterSeed.inFiles === 0,
            `control: seeded with its main server's wrapped copies, the standby records its clear (${brief(afterSeed)})`);

        // (2) The rollback, on both servers. The main server's rollback command unwraps and stamps every copy, the older
        // code there stores the re-deposits as the app sealed them, and the standby, on the older code too, imports both.
        // The main server's clock is behind the standby's: every stamp is before the clear the standby recorded.
        const batches = path.join(tempDir('fleet-batches'), 'batches.json');
        fs.writeFileSync(batches, JSON.stringify([clientForm(gen2, 2, '2026-06-05T00:00:00.000Z'), clientForm(gen3, 3, '2026-06-06T00:00:00.000Z')]));
        const older = resultOf(await runChild([SCRIPT], standbyDir, { RECOVERY_SEAL_CHILD: 'older-standby-import', NODE_ROLE: 'backup', SEAL_BATCHES: batches }));
        const olderInFiles = copiesFoundIn(standbyDir, watch);
        check(older.cleared === afterSeed?.cleared && older.rows === N && older.unwrapped === N && olderInFiles > 0,
            `control: after the rollback on the older code the standby still records its clear, beside ${older.unwrapped} copies in the client's form, and its files hold ${olderInFiles} of the ${watch.length}`);

        // (3) This code again, on both. The main server wrapped every copy at its own boot, before it served anything, so
        // every pull this standby now makes is wrapped: no import shows it a copy in the client's form.
        const r3 = await runChild([SCRIPT], standbyDir, {
            RECOVERY_SEAL_CHILD: 'standby-script', NODE_ROLE: 'backup',
            SEAL_SCRIPT: scriptFile('fleet-again', { resyncFirst: false, reconcileMinutes: 0, pulls: 3, watch, steps: [wrapped(gen3, 3, '2026-06-07T00:00:00.000Z')] }),
        });
        const s3 = resultOf(r3);
        const [atWrapped, afterWrapped] = (s3.pulls ?? []).map((x: any) => x.before);
        check(s3.atBoot?.cleared === null && s3.atBoot?.unwrapped === N,
            `at its boot on this code it forgets its clear: ${N} copies in the client's form are here that were not when it cleared (${brief(s3.atBoot)})`);
        check(forgetsAtBoot.test(r3.stdout + r3.stderr), `...and says why (${sealLines(r3)})`);
        check(atWrapped?.cleared === null && (s3.pulls ?? [])[0]?.route === 'delta',
            `...and waits until its main server's wrapped copies come (${brief(atWrapped)}; ${JSON.stringify((s3.pulls ?? []).map((p: any) => p.route))})`);
        check(typeof afterWrapped?.cleared === 'string' && afterWrapped.cleared !== afterSeed?.cleared && afterWrapped.unwrapped === 0,
            `the delta that brings the wrapped copies back is when it clears again, and records it (${brief(afterWrapped)})`);
        check(afterWrapped?.inFiles === 0,
            `...after which its running state.db, -wal and -shm hold none of the ${watch.length} copies it was sent in the client's form (found ${afterWrapped?.inFiles})`);
        check(s3.final?.inFiles === 0 && s3.final?.cleared === afterWrapped?.cleared, `...nor after the next pull (found ${s3.final?.inFiles})`);
        check(vacuums(r3) === 1, `it cleared once, after the wrapped copies came back (${vacuums(r3)})`);

        // Control: a standby whose main server deleted copies before the seal still holds those as rows, in the client's
        // form, when it records its clear (a delta cannot show which ones; the next whole copy removes them). Here that
        // whole copy has not come yet, and the main server's clock runs a day ahead of the standby's, so every stamp is
        // after the clear. None of that is a copy that arrived after the clear: no boot forgets it.
        const ahead = (ms: number) => new Date(Date.now() + 86_400_000 + ms).toISOString();
        const h: History = { owners, gen1: gen2, gen2: gen3, deleted: [0, 1, 2], real: [], at: [ahead(0), ahead(1000)] };
        const historyFile = path.join(tempDir('fleet-orphans-history'), 'history.json');
        fs.writeFileSync(historyFile, JSON.stringify(h));
        const orphanDir = tempDir('fleet-orphans');
        resultOf(await runChild([SCRIPT], orphanDir, { RECOVERY_SEAL_CHILD: 'pre-seal-history', SEAL_HISTORY: historyFile, SEAL_SIDE: 'standby' }));
        const keptOwners = owners.map((_, i) => i).filter(i => !h.deleted.includes(i));
        const delta = keptOwners.map(i => exportRow(owners[i], i, seal.sealRecoveryFields(gen3[i], seal.shareRowAad(owners[i], 'sso')), 2, ahead(5000)));
        const o1 = await runChild([SCRIPT], orphanDir, {
            RECOVERY_SEAL_CHILD: 'standby-script', NODE_ROLE: 'backup',
            SEAL_SCRIPT: scriptFile('fleet-orphans-seal', { resyncFirst: false, since: ahead(2000), reconcileMinutes: 0, pulls: 1, watch: [], steps: [delta] }),
        });
        const t1 = resultOf(o1);
        check((t1.pulls ?? [])[0]?.route === 'delta' && typeof t1.final?.cleared === 'string' && t1.final.unwrapped === h.deleted.length,
            `control: the delta that brings the wrapped copies records its clear, with the ${h.deleted.length} copies its main server deleted before the seal still rows here (${brief(t1.final)})`);
        for (const n of [1, 2]) {
            const ob = await runChild([SCRIPT], orphanDir, {
                RECOVERY_SEAL_CHILD: 'standby-script', NODE_ROLE: 'backup',
                SEAL_SCRIPT: scriptFile(`fleet-orphans-boot-${n}`, { resyncFirst: false, reconcileMinutes: 0, pulls: 0, watch: [], steps: [] }),
            });
            const tb = resultOf(ob);
            check(tb.atBoot?.cleared === t1.final?.cleared && tb.atBoot?.unwrapped === h.deleted.length && !forgetsAtBoot.test(ob.stdout + ob.stderr) && vacuums(ob) === 0,
                `boot ${n} after it: the clear stays recorded beside those ${h.deleted.length}, with no VACUUM (${brief(tb.atBoot)}; ${sealLines(ob)})`);
        }
    });

    // ── 21–25: the seal epoch ─────────────────────────────────────────────────────────────────────
    // What every rollback order has in common: the main server names a new epoch when it records its clear after sealing
    // again, and a standby that cleared under another one clears again, whichever code imported what in between.
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
    const eClientForm = (copiesOf: Sealed[], generation: number, at: string) => eOwners.map((o, i) => exportRow(o, i, copiesOf[i], generation, at));
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
        runChild([SCRIPT], dir, { RECOVERY_SEAL_CHILD: 'standby-script', NODE_ROLE: 'backup', SEAL_SCRIPT: jsonFile(label, script), ...env });
    const olderImport = (dir: string, label: string, batches: unknown[][]) =>
        runChild([SCRIPT], dir, { RECOVERY_SEAL_CHILD: 'older-standby-import', NODE_ROLE: 'backup', SEAL_BATCHES: jsonFile(label, batches) });
    /** A stopped standby's data folder, copied whole: its files as they lie, WAL included. */
    const copyOfDir = (dir: string, label: string) => {
        const d = tempDir(label);
        fs.cpSync(dir, d, { recursive: true });
        return d;
    };
    const T2 = '2026-06-02T00:00:00.000Z', T5 = '2026-06-05T00:00:00.000Z', T6 = '2026-06-06T00:00:00.000Z', T7 = '2026-06-07T00:00:00.000Z';
    // The standby, seeded (22) with its main server's wrapped copies under E1; 23 and 24 start from copies of it.
    let seededUnderE1 = '';
    let seededRecord: string | null = null;
    // 23's standby after its older code imported the rollback's copies; 24 starts from a copy of it.
    let rolledBackUnderOlderCode = '';

    // ── 21. the main server's seal epoch ───────────────────────────────────────────────────────────
    await section('21. a main server names a seal epoch when it records its clear, in every payload; a later boot keeps it, and the rollback command makes the next seal name a new one', async () => {
        const dir = tempDir('epoch-main');
        const owners = eOwners.slice(0, 4);
        const h: History = { owners, gen1: owners.map(() => fakeCopy()), gen2: owners.map(() => fakeCopy()), deleted: [], real: [] };
        resultOf(await runChild([SCRIPT], dir, { RECOVERY_SEAL_CHILD: 'pre-seal-history', SEAL_HISTORY: jsonFile('epoch-main-history', h), SEAL_SIDE: 'main' }));
        const exportOf = async () => {
            const r = await runChild([SCRIPT], dir, { RECOVERY_SEAL_CHILD: 'main-export', NODE_ROLE: 'primary', SEAL_SINCE: '2026-06-03T00:00:00.000Z' });
            return { r, o: resultOf(r) };
        };
        const a = await exportOf();
        check(typeof a.o.epoch === 'string' && EPOCH_RE.test(a.o.epoch) && a.o.deltaEpoch === a.o.epoch && epochOf(a.o.cleared) === a.o.epoch && vacuumsOf(a.r) === 1,
            `after its seal the main server records its clear under a new epoch, and a whole copy and a delta both name it (epoch ${a.o.epoch}, delta ${a.o.deltaEpoch}, record ${epochOf(a.o.cleared)})`);
        const b = await exportOf();
        check(b.o.epoch === a.o.epoch && b.o.cleared === a.o.cleared && vacuumsOf(b.r) === 0,
            `a later boot keeps the same epoch and runs no VACUUM (${b.o.epoch === a.o.epoch ? 'same' : `${a.o.epoch} → ${b.o.epoch}`})`);
        const rollback = await runChild([SEAL_CLI, '--unwrap-recovery-rows'], dir, {});
        check(rollback.code === 0, `the rollback command runs (exit ${rollback.code}: ${rollback.stderr.slice(-300)})`);
        const c = await exportOf();
        check(typeof c.o.epoch === 'string' && EPOCH_RE.test(c.o.epoch) && c.o.epoch !== a.o.epoch && epochOf(c.o.cleared) === c.o.epoch && vacuumsOf(c.r) === 1,
            `back on this code after the rollback, the main server seals and clears again, under a new epoch (${a.o.epoch} → ${c.o.epoch})`);
        // A clear recorded before clears named an epoch (the first code with the seal).
        const raw = new Database(path.join(dir, 'state.db'));
        const record = JSON.parse(raw.prepare('SELECT value FROM node_config WHERE key = ?').pluck().get(CLEARED_KEY) as string);
        delete record.epoch;
        raw.prepare('UPDATE node_config SET value = ? WHERE key = ?').run(JSON.stringify(record), CLEARED_KEY);
        raw.close();
        const d = await exportOf();
        check(typeof d.o.epoch === 'string' && EPOCH_RE.test(d.o.epoch) && d.o.epoch !== c.o.epoch && JSON.parse(d.o.cleared).at === record.at && vacuumsOf(d.r) === 0,
            `a clear recorded before epochs is named one at the next boot, the same clear, with no second VACUUM (${d.o.epoch})`);
    });

    // ── 22. the main server updated first ──────────────────────────────────────────────────────────
    await section('22. the main server updated first: the standby\'s older code pulls the re-sealed copies itself, and this code, booting after, clears again at its first pull, under the new epoch', async () => {
        seededUnderE1 = tempDir('epoch-seed');
        const seed = await runStandby(seededUnderE1, 'epoch-seed', { resyncFirst: true, reconcileMinutes: 0, pulls: 1, watch: eWatch, steps: [eWrapped(eGen2, 2, T2)], epochs: [E1] });
        const s1 = resultOf(seed);
        seededRecord = s1.final?.cleared ?? null;
        check(s1.resync?.ok === true && epochOf(seededRecord) === E1 && s1.final?.unwrapped === 0 && s1.final?.inFiles === 0 && s1.ownEpoch === null,
            `control: seeded with its main server's wrapped copies, which name E1, the standby records its clear under E1, and names no epoch of its own (${briefE(s1.final)}, own ${s1.ownEpoch})`);

        // The rollback on both servers; then the main server comes back to this code first. Its wrap stamps every copy, and
        // the standby, still on the older code, pulls them too: every row here is wrapped again.
        const dir = copyOfDir(seededUnderE1, 'epoch-order-b');
        const older = resultOf(await olderImport(dir, 'epoch-order-b-batches', [eClientForm(eGen2, 2, T5), eClientForm(eGen3, 3, T6), eWrapped(eGen3, 3, T7)]));
        const olderInFiles = copiesFoundIn(dir, eWatch);
        check(older.cleared === seededRecord && older.rows === EN && older.unwrapped === 0 && olderInFiles > 0,
            `control: on the older code it imported the rollback's copies, the re-deposits and the re-sealed copies: every row is wrapped, its clear is still recorded under E1, and its files hold ${olderInFiles} of the ${eWatch.length} copies sent in the client's form`);

        // This code on the standby. The main server has nothing new to send, and names E2.
        const r = await runStandby(dir, 'epoch-order-b-again', { resyncFirst: false, reconcileMinutes: 0, pulls: 1, watch: eWatch, steps: [[]], epochs: [E2] });
        const s = resultOf(r);
        check(s.atBoot?.unwrapped === 0 && s.atBoot?.rows === EN,
            `control: at its boot on this code no copy here is in the client's form, so none shows it anything (${briefE(s.atBoot)})`);
        check(epochForgets.test(r.stdout + r.stderr), `its first pull names E2: it forgets its clear under E1, and says why (${sealLines(r)})`);
        check(epochOf(s.final?.cleared) === E2 && s.final?.unwrapped === 0,
            `...and clears again at once, recorded under E2: no copy it holds is in the client's form (${briefE(s.final)})`);
        check(s.final?.inFiles === 0,
            `...after which its running state.db, -wal and -shm hold none of the ${eWatch.length} copies it was sent in the client's form (found ${s.final?.inFiles}; ${olderInFiles} before)`);
        check(vacuumsOf(r) === 1, `it cleared once (${vacuumsOf(r)})`);
    });

    // ── 23. the standby on this code before any wrapped pull ───────────────────────────────────────
    await section('23. the standby on this code before any wrapped pull: it waits while its main server is rolled back, and clears after the pull that brings the wrapped copies, under the new epoch', async () => {
        const dir = copyOfDir(seededUnderE1, 'epoch-order-a');
        const older = resultOf(await olderImport(dir, 'epoch-order-a-batches', [eClientForm(eGen2, 2, T5), eClientForm(eGen3, 3, T6)]));
        check(older.cleared === seededRecord && older.unwrapped === EN,
            `control: on the older code while the rollback lasts it imports the rollback's copies and the re-deposits, and keeps its clear under E1 (${older.unwrapped} in the client's form)`);
        rolledBackUnderOlderCode = copyOfDir(dir, 'epoch-rolled-back');

        // This code on the standby while its main server is still rolled back (its pull names no epoch), then the pull from
        // the main server back on this code: the wrapped copies, naming E2.
        const r = await runStandby(dir, 'epoch-order-a-again', { resyncFirst: false, reconcileMinutes: 0, pulls: 2, watch: eWatch, steps: [[], eWrapped(eGen3, 3, T7)], epochs: [null, E2] });
        const s = resultOf(r);
        const whileRolledBack = s.pulls?.[1]?.before;
        check(s.atBoot?.cleared === null && s.atBoot?.unwrapped === EN,
            `at its boot on this code it forgets its clear: copies in the client's form are here that were not when it cleared (${briefE(s.atBoot)})`);
        check(whileRolledBack?.cleared === null && whileRolledBack.unwrapped === EN && (s.pulls ?? []).every((p: any) => p.route === 'delta'),
            `...and while its main server is still rolled back it waits (${briefE(whileRolledBack)})`);
        check(epochOf(s.final?.cleared) === E2 && s.final?.unwrapped === 0,
            `the pull that brings the wrapped copies and E2 is when it clears again, recorded under E2 (${briefE(s.final)})`);
        check(s.final?.inFiles === 0,
            `...after which its running state.db, -wal and -shm hold none of the ${eWatch.length} copies it was sent in the client's form (found ${s.final?.inFiles})`);
        check(vacuumsOf(r) === 1, `it cleared once (${vacuumsOf(r)})`);
    });

    // ── 24. a clear that fails for room is tried again at the next boot ────────────────────────────
    await section('24. a clear that fails for disk room after a forget is tried again at the next boot, and succeeds', async () => {
        const dir = copyOfDir(rolledBackUnderOlderCode, 'epoch-room');
        const tight = await runStandby(dir, 'epoch-room-tight', { resyncFirst: false, reconcileMinutes: 0, pulls: 1, watch: eWatch, steps: [eWrapped(eGen3, 3, T7)], epochs: [E2] },
            { SEAL_FREE_BYTES: String(1024 * 1024) });
        const t = resultOf(tight);
        check(t.final?.cleared === null && t.final?.unwrapped === 0 && vacuumsOf(tight) === 0
            && /needs about \d+ MB free in .*, which has 1 MB\. The server runs; the next boot tries again/.test(tight.stderr),
            `with no room when the wrapped copies arrive, it records nothing and says the next boot tries again (${briefE(t.final)}; ${sealLines(tight)})`);
        check((t.final?.inFiles ?? 0) > 0, `control: its files still hold ${t.final?.inFiles} of the ${eWatch.length} copies sent in the client's form`);
        const next = await runStandby(dir, 'epoch-room-boot', { resyncFirst: false, reconcileMinutes: 0, pulls: 0, watch: eWatch, steps: [] });
        const n = resultOf(next);
        check(epochOf(n.atBoot?.cleared) === E2 && vacuumsOf(next) === 1,
            `the next boot, with room, clears before any pull, recorded under E2, the epoch it last imported (${briefE(n.atBoot)}; ${sealLines(next)})`);
        check(n.atBoot?.inFiles === 0, `...after which its running files hold none of them (found ${n.atBoot?.inFiles})`);
    });

    // ── 25. copies deleted before the seal; one VACUUM per epoch; a main server with no epoch ──────
    await section('25. copies deleted before the seal never make a standby clear again across boots; a new epoch clears once, at the whole copy; a main server that names no epoch changes nothing', async () => {
        const deleted = [0, 1, 2];
        const kept = eOwners.map((_, i) => i).filter(i => !deleted.includes(i));
        const h: History = { owners: eOwners, gen1: eGen2, gen2: eGen3, deleted, real: [] };
        const dir = tempDir('epoch-orphans');
        resultOf(await runChild([SCRIPT], dir, { RECOVERY_SEAL_CHILD: 'pre-seal-history', SEAL_HISTORY: jsonFile('epoch-orphans-history', h), SEAL_SIDE: 'standby' }));
        const sealed = eWrapped(eGen3, 2, T7, kept);
        const o1 = await runStandby(dir, 'epoch-orphans-seal', { resyncFirst: false, since: '2026-06-03T00:00:00.000Z', reconcileMinutes: 0, pulls: 1, watch: [], steps: [sealed], epochs: [E1] });
        const t1 = resultOf(o1);
        check(t1.pulls?.[0]?.route === 'delta' && epochOf(t1.final?.cleared) === E1 && t1.final?.unwrapped === deleted.length && vacuumsOf(o1) === 1,
            `control: the delta that brings the wrapped copies under E1 records its clear under E1, with the ${deleted.length} copies deleted before the seal still rows here (${briefE(t1.final)})`);
        for (const n of [1, 2]) {
            const ob = await runStandby(dir, `epoch-orphans-boot-${n}`, { resyncFirst: false, reconcileMinutes: 0, pulls: 0, watch: [], steps: [] });
            const tb = resultOf(ob);
            check(tb.atBoot?.cleared === t1.final?.cleared && tb.atBoot?.unwrapped === deleted.length && vacuumsOf(ob) === 0 && !/forgets that clear/.test(ob.stdout + ob.stderr),
                `boot ${n}: beside those ${deleted.length}, its clear under E1 stays, with no VACUUM (${briefE(tb.atBoot)}; ${sealLines(ob)})`);
        }
        // The main server rolled back and sealed again: E2. The pull after the boot is the whole copy the standby asks for.
        const o2 = await runStandby(dir, 'epoch-orphans-again', { resyncFirst: false, reconcileMinutes: 0, pulls: 1, watch: [], steps: [sealed], epochs: [E2] });
        const t2 = resultOf(o2);
        check(t2.pulls?.[0]?.route === 'snapshot' && /removed 3 sign-in recovery copies its main server deleted before the seal/.test(o2.stdout),
            `under E2, its first pull is the whole copy it asks for, which removes the ${deleted.length} (${JSON.stringify((t2.pulls ?? []).map((p: any) => p.route))}; ${sealLines(o2)})`);
        check(epochForgets.test(o2.stdout + o2.stderr) && epochOf(t2.final?.cleared) === E2 && t2.final?.unwrapped === 0 && t2.final?.rows === kept.length && vacuumsOf(o2) === 1,
            `...and it clears again once, recorded under E2, with no copy left in the client's form (${briefE(t2.final)})`);
        // A later boot, and a pull from a main server that names no epoch (one from before it, or rolled back again).
        const o3 = await runStandby(dir, 'epoch-orphans-none', { resyncFirst: false, reconcileMinutes: 0, pulls: 1, watch: [], steps: [[]] });
        const t3 = resultOf(o3);
        check(t3.atBoot?.cleared === t2.final?.cleared && t3.final?.cleared === t2.final?.cleared && vacuumsOf(o3) === 0
            && !/forgets that clear/.test(o3.stdout + o3.stderr) && (t3.pulls ?? []).length === 1,
            `a later boot, and a pull that names no epoch, change nothing: the clear under E2 stays, with no VACUUM (${briefE(t3.final)}; ${sealLines(o3)})`);
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
