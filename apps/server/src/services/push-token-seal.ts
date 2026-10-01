/**
 * Members' push tokens, locked at rest (scratch/global-node/DESIGN-push-relay-fable.md §4.2, the push design's step 2).
 *
 * ## Why
 *
 * A phone's Expo push token is all anyone needs to put words under BeanPool's icon on that phone, and Expo's tokens never
 * expire (on an iPhone they outlive a reinstall). Stored in the clear, every copy of the database held them: a snapshot,
 * a plain backup, a standby's copy, a stolen disk. Now no copy of the database alone holds one anybody can use.
 *
 * ## The rows
 *
 * `push_tokens` keeps, for each member's phone:
 *
 * - `token_id`: HMAC-SHA256 of the token, hex. Everything that names a phone's row names this: the table's key (with the
 *   member's key), a tombstone (`<key>|<token_id>`, db.ts deletePlainRows), a leave statement applied here
 *   (push_token_leaves), the per-key caps (state-engine.ts KEY_PUSH_RULES), the row a dead-token ticket removes. A phone
 *   that registers again gives the same id, so its row is found without opening any;
 * - `token_box`: the token, XChaCha20-Poly1305 with a random 24-byte nonce, bound (AAD) to the member's key and the id;
 *   base64 of the nonce, the ciphertext and the tag. A box opens only to a token whose id under the same key is its row's.
 *
 * Both keys come from data/recovery-seal.key (services/recovery-seal-key.ts recoverySealSubkey): HKDF-SHA256 with info
 * `beanpool-push-token/v1`, 64 bytes, the box's key then the id's. One file to carry. It is never in the database, so
 * never in a sync payload, a snapshot or a plain backup; it travels only in the take-over bundle (a take-over, a sealed
 * backup). The plain token is in memory only while a push is sent to it (state-engine.ts dispatchPushNotification) and
 * while a registration or a leave statement that carries it is handled. It is never logged.
 *
 * ## A standby, a take-over, a restore
 *
 * A standby holds no key of its own (services/recovery-seal-key.ts): it stores its main server's rows as they come and
 * opens none. A take-over brings the main server's key in the bundle, so the server that takes over reaches every phone
 * at once. A server that takes over without it (keys sealed before the key travelled), or a plain backup restored onto
 * a server with another key, can't open those rows: its boot removes them, with tombstones, and says so in one line
 * ({@link checkPushRowsAtBoot}); each phone registers again the next time its app opens (apps/native app/_layout.tsx
 * registers at every start). Nothing waits on it. A row only a key a carried one replaced opens
 * (recovery-seal-retired-<id>.key) is locked again under the live key at the boot, as the recovery seal does its own.
 *
 * ## The update that brings this
 *
 * db.ts moves a table from before (each token in the clear, keyed by it) and its leave statements aside as they are, in
 * one transaction, before schema.sql makes the new tables (db.ts movePlainPushTablesAside). At the boot, a main server
 * locks every row moved aside, names each tombstone and leave statement that named a token by its id instead, and drops
 * the old tables, all in one transaction ({@link lockPlainPushRows}): a server stopped part way (a power cut) has changed
 * nothing, and does it all at its next boot. The rows it locks are stamped, so its standbys are sent the locked form. A
 * standby has no key to lock with: it drops them, and the tombstones that name a token, and takes its main server's locked
 * rows from its next whole copy (engine/sync.ts REPLICA_FORMAT 9). secure_delete (db.ts) zeroes what goes where it lay,
 * and the WAL is emptied after (db/wal-truncate.ts). Backups and snapshots made before the update are copies of the
 * database as it was then, tokens included; nothing here reaches them.
 *
 * Rolling the server back past this change needs the tables in the shape the code before reads, with the server stopped
 * ({@link unlockPushRowsForRollback}):
 *
 *     node dist/services/push-token-seal.js --unlock-push-tokens          # in the image (/app/apps/server)
 *     pnpm exec tsx src/services/push-token-seal.ts --unlock-push-tokens  # from a checkout
 *
 * with BEANPOOL_DATA_DIR pointing at the node's data folder (the image sets /data). It prints counts only, on the main
 * server; a standby holds no key, and takes its main server's rows again from its next whole copy.
 *
 * ## What this does not do
 *
 * Keep the tokens from whoever runs the server: its process holds the key, and sends with the tokens (design §4.2).
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { xchacha20poly1305 } from '@noble/ciphers/chacha.js';
import { db, deletePlainRows, PLAIN_PUSH_TOKENS, PLAIN_PUSH_LEAVES } from '../db/db.js';
import { truncateWalAfterDelete } from '../db/wal-truncate.js';
import {
    ensureRecoverySealKey, recoverySealSubkey, retiredRecoverySealSubkeys, RecoverySealKeyMissing, RECOVERY_SEAL_KEY_FILE,
} from './recovery-seal-key.js';

const INFO = 'beanpool-push-token/v1';
const KEY_BYTES = 32;
const NONCE_BYTES = 24;
const TAG_BYTES = 16;

/** A row's `token_id`: HMAC-SHA256 of the token, hex. */
export const PUSH_TOKEN_ID = /^[0-9a-f]{64}$/;

const NOW = `strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`;

interface Keys { box: Uint8Array; id: Uint8Array }

const split = (k: Uint8Array): Keys => ({ box: k.subarray(0, KEY_BYTES), id: k.subarray(KEY_BYTES) });

/** The live key's pair; null when there is no key file. Thrown when the file can't be read or is not a key. */
function liveKeys(): Keys | null {
    const k = recoverySealSubkey(INFO, 2 * KEY_BYTES);
    return k ? split(k) : null;
}

function requireKeys(): Keys {
    const k = liveKeys();
    if (!k) throw new RecoverySealKeyMissing(`This server cannot lock push tokens: data/${RECOVERY_SEAL_KEY_FILE} is missing.`);
    return k;
}

const idUnder = (keys: Keys, token: string): string => crypto.createHmac('sha256', keys.id).update(token, 'utf8').digest('hex');

const aad = (publicKey: string, tokenId: string): Uint8Array => Buffer.from(JSON.stringify([INFO, publicKey, tokenId]), 'utf8');

function boxUnder(keys: Keys, publicKey: string, tokenId: string, token: string): string {
    const nonce = crypto.randomBytes(NONCE_BYTES);
    const sealed = xchacha20poly1305(keys.box, nonce, aad(publicKey, tokenId)).encrypt(Buffer.from(token, 'utf8'));
    return Buffer.concat([nonce, sealed]).toString('base64');
}

/** The token in a row's box under these keys, or null when they don't open it, or it holds a token of another id. */
function openUnder(keys: Keys, publicKey: string, tokenId: unknown, box: unknown): string | null {
    if (typeof tokenId !== 'string' || typeof box !== 'string') return null;
    try {
        const bytes = Buffer.from(box, 'base64');
        if (bytes.length <= NONCE_BYTES + TAG_BYTES) return null;
        const plain = xchacha20poly1305(keys.box, bytes.subarray(0, NONCE_BYTES), aad(publicKey, tokenId)).decrypt(bytes.subarray(NONCE_BYTES));
        const token = Buffer.from(plain).toString('utf8');
        return idUnder(keys, token) === tokenId ? token : null;
    } catch {
        return null;
    }
}

/** The id a phone's row is found by: its token's HMAC under this server's key. Throws {@link RecoverySealKeyMissing}. */
export function pushTokenId(token: string): string {
    return idUnder(requireKeys(), token);
}

/** A new row's id and box for a member's phone. Throws {@link RecoverySealKeyMissing}; never stores a token unlocked. */
export function lockPushToken(publicKey: string, token: string): { tokenId: string; tokenBox: string } {
    const keys = requireKeys();
    const tokenId = idUnder(keys, token);
    return { tokenId, tokenBox: boxUnder(keys, publicKey, tokenId, token) };
}

/** Opens a row's token: {@link openPushToken}'s answer, under the key it was made with. */
export type PushTokenOpener = (publicKey: string, tokenId: unknown, tokenBox: unknown) => string | null;

/**
 * An opener with this server's key as it is now, read once: for a send to many phones, which would otherwise read the
 * key file for each. With no key (or one that can't be read) it opens nothing. Never throws.
 */
export function pushTokenOpener(): PushTokenOpener {
    let keys: Keys | null = null;
    try {
        keys = liveKeys();
    } catch {
        keys = null;
    }
    return (publicKey, tokenId, tokenBox) => (keys ? openUnder(keys, publicKey, tokenId, tokenBox) : null);
}

/**
 * The token a row holds, for sending to it now: null when this server's key doesn't open the row (locked with a key it
 * doesn't have, or altered) or it has no key. Never throws. Nothing keeps what it returns.
 */
export function openPushToken(publicKey: string, tokenId: unknown, tokenBox: unknown): string | null {
    return pushTokenOpener()(publicKey, tokenId, tokenBox);
}

/**
 * A phone's row as registerPushToken stores it (state-engine.ts), written with none of its rules (no caps, no leave
 * statement's check): for suites and tools that seed rows, as their raw INSERTs did before the tokens were locked.
 * `INSERT OR REPLACE`. Returns the row's token_id. Throws {@link RecoverySealKeyMissing}.
 */
export function putPushTokenRow(publicKey: string, token: string, platform: string = 'ios'): string {
    const { tokenId, tokenBox } = lockPushToken(publicKey, token);
    db.prepare(`INSERT OR REPLACE INTO push_tokens (public_key, token_id, token_box, platform) VALUES (?, ?, ?, ?)`)
        .run(publicKey, tokenId, tokenBox, platform);
    return tokenId;
}

// ── the update that brings this ───────────────────────────────────────────────────────────────

const hasTable = (name: string): boolean =>
    !!db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`).get(name);

/** A push_tokens tombstone that names its phone by id (`<key>|<token_id>`), as every one written from this change on does. */
export function isLockedPushTombstone(rowKey: string): boolean {
    const bar = rowKey.indexOf('|');
    return bar > 0 && PUSH_TOKEN_ID.test(rowKey.slice(bar + 1));
}

/** The push_tokens tombstones that name a phone by its token in the clear (written before this change). */
function plainTombstones(): { row_key: string; deleted_at: string }[] {
    return (db.prepare(`SELECT row_key, deleted_at FROM tombstones WHERE table_name = 'push_tokens'`).all() as { row_key: string; deleted_at: string }[])
        .filter((t) => !isLockedPushTombstone(t.row_key));
}

/**
 * Tests only: BEANPOOL_TEST_PUSH_LOCK_HOLD=<file> stops this process half way through the lock's transaction, writes the
 * file so the suite knows it is there, and waits to be killed, as a power cut would find it. Unset in every real
 * deployment.
 */
function holdForTests(): void {
    const marker = process.env.BEANPOOL_TEST_PUSH_LOCK_HOLD;
    if (!marker) return;
    fs.writeFileSync(marker, String(process.pid));
    const cell = new Int32Array(new SharedArrayBuffer(4));
    for (let i = 0; i < 4; i++) Atomics.wait(cell, 0, 0, 30_000);
    process.exit(3);
}

export interface PlainPushLocked { tokens: number; leaves: number; tombstones: number }

/**
 * On a main server, at its boot: every row a table from before held, locked under the live key into the new table, the
 * same phone registered since kept as it is; each leave statement and tombstone that named a token in the clear, named by
 * its id instead; the old tables dropped. One transaction, then the WAL emptied. Each row it writes is stamped now, so a
 * standby is sent it. Idempotent: a second run finds nothing. Throws {@link RecoverySealKeyMissing}.
 */
export function lockPlainPushRows(): PlainPushLocked {
    const done: PlainPushLocked = { tokens: 0, leaves: 0, tombstones: 0 };
    const tokens = hasTable(PLAIN_PUSH_TOKENS), leaves = hasTable(PLAIN_PUSH_LEAVES);
    const tombs = plainTombstones();
    if (!tokens && !leaves && tombs.length === 0) return done;
    const keys = requireKeys();
    db.transaction(() => {
        if (tokens) {
            const rows = db.prepare(`SELECT public_key, token, platform, created_at, registered_at FROM ${PLAIN_PUSH_TOKENS}`).all() as
                { public_key: unknown; token: unknown; platform: unknown; created_at: unknown; registered_at: unknown }[];
            const put = db.prepare(`INSERT INTO push_tokens (public_key, token_id, token_box, platform, created_at, registered_at)
                VALUES (?, ?, ?, COALESCE(?, 'ios'), COALESCE(?, ${NOW}), ?) ON CONFLICT (public_key, token_id) DO NOTHING`);
            rows.forEach((r, i) => {
                if (i === Math.floor(rows.length / 2)) holdForTests();
                if (typeof r.public_key !== 'string' || typeof r.token !== 'string' || !r.token) return;
                const id = idUnder(keys, r.token);
                done.tokens += put.run(r.public_key, id, boxUnder(keys, r.public_key, id, r.token),
                    typeof r.platform === 'string' ? r.platform : null, typeof r.created_at === 'string' ? r.created_at : null,
                    typeof r.registered_at === 'number' ? r.registered_at : null).changes;
            });
            db.exec(`DROP TABLE ${PLAIN_PUSH_TOKENS}`);
        }
        if (leaves) {
            const rows = db.prepare(`SELECT public_key, token, left_at, applied_at FROM ${PLAIN_PUSH_LEAVES}`).all() as
                { public_key: unknown; token: unknown; left_at: unknown; applied_at: unknown }[];
            const put = db.prepare(`INSERT INTO push_token_leaves (public_key, token_id, left_at, applied_at) VALUES (?, ?, ?, COALESCE(?, ${NOW}))
                ON CONFLICT (public_key, token_id) DO UPDATE SET
                    left_at = MAX(push_token_leaves.left_at, excluded.left_at), applied_at = MAX(push_token_leaves.applied_at, excluded.applied_at)`);
            for (const r of rows) {
                if (typeof r.public_key !== 'string' || typeof r.token !== 'string' || typeof r.left_at !== 'number') continue;
                done.leaves += put.run(r.public_key, idUnder(keys, r.token), r.left_at, typeof r.applied_at === 'string' ? r.applied_at : null).changes;
            }
            db.exec(`DROP TABLE ${PLAIN_PUSH_LEAVES}`);
        }
        const putTomb = db.prepare(`INSERT INTO tombstones (table_name, row_key, deleted_at) VALUES ('push_tokens', ?, ?)
            ON CONFLICT (table_name, row_key) DO UPDATE SET deleted_at = MAX(tombstones.deleted_at, excluded.deleted_at)`);
        const dropTomb = db.prepare(`DELETE FROM tombstones WHERE table_name = 'push_tokens' AND row_key = ?`);
        for (const t of tombs) {
            dropTomb.run(t.row_key);
            const bar = t.row_key.indexOf('|');
            if (bar <= 0) continue;
            putTomb.run(`${t.row_key.slice(0, bar)}|${idUnder(keys, t.row_key.slice(bar + 1))}`, t.deleted_at);
            done.tombstones++;
        }
    })();
    truncateWalAfterDelete('the push tokens were locked');
    return done;
}

/**
 * On a standby, at its boot: a table from before, and the tombstones that name a token in the clear, dropped. It has no
 * key to lock them with, and its main server's locked rows come with its next whole copy. One transaction, then the WAL
 * emptied. Idempotent.
 */
export function dropPlainPushRows(): PlainPushLocked {
    const done: PlainPushLocked = { tokens: 0, leaves: 0, tombstones: 0 };
    const tokens = hasTable(PLAIN_PUSH_TOKENS), leaves = hasTable(PLAIN_PUSH_LEAVES);
    const tombs = plainTombstones();
    if (!tokens && !leaves && tombs.length === 0) return done;
    const count = (table: string) => (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
    db.transaction(() => {
        if (tokens) {
            done.tokens = count(PLAIN_PUSH_TOKENS);
            db.exec(`DROP TABLE ${PLAIN_PUSH_TOKENS}`);
        }
        if (leaves) {
            done.leaves = count(PLAIN_PUSH_LEAVES);
            db.exec(`DROP TABLE ${PLAIN_PUSH_LEAVES}`);
        }
        const dropTomb = db.prepare(`DELETE FROM tombstones WHERE table_name = 'push_tokens' AND row_key = ?`);
        for (const t of tombs) done.tombstones += dropTomb.run(t.row_key).changes;
    })();
    truncateWalAfterDelete('the push tokens stored in the clear were dropped');
    return done;
}

export interface PushRowsChecked { held: number; relocked: number; removed: number }

/**
 * On a main server, at every boot: each phone's row this server's key opens stays as it is. One only a key a carried one
 * replaced opens (recovery-seal-retired-<id>.key: a phone that registered with this server before a take-over or a
 * restore brought the community's key) is locked again under the live key, the same phone's row under it kept if there
 * is one. One no key here opens (a take-over without the key, a plain backup restored onto a server with another) is
 * removed: its phone registers again when its app next opens. Each row that goes leaves a tombstone, so the standbys drop
 * it too. Throws {@link RecoverySealKeyMissing}.
 */
export function checkPushRowsAtBoot(): PushRowsChecked {
    const live = requireKeys();
    const rows = db.prepare(`SELECT rowid AS id, public_key, token_id, token_box, platform, created_at, registered_at FROM push_tokens`).all() as
        { id: number; public_key: string; token_id: string; token_box: string; platform: string | null; created_at: string | null; registered_at: number | null }[];
    let retired: Keys[] | null = null;
    const relock: (typeof rows[number] & { token: string })[] = [];
    const remove: number[] = [];
    for (const r of rows) {
        if (openUnder(live, r.public_key, r.token_id, r.token_box) !== null) continue;
        retired ??= retiredRecoverySealSubkeys(INFO, 2 * KEY_BYTES).map(split);
        let token: string | null = null;
        for (const k of retired) if ((token = openUnder(k, r.public_key, r.token_id, r.token_box)) !== null) break;
        if (token !== null) relock.push({ ...r, token });
        else remove.push(r.id);
    }
    if (relock.length > 0 || remove.length > 0) {
        db.transaction(() => {
            const gone = [...remove, ...relock.map((r) => r.id)];
            deletePlainRows('push_tokens', 'rowid IN (SELECT value FROM json_each(?))', JSON.stringify(gone));
            const put = db.prepare(`INSERT INTO push_tokens (public_key, token_id, token_box, platform, created_at, registered_at)
                VALUES (?, ?, ?, ?, COALESCE(?, ${NOW}), ?) ON CONFLICT (public_key, token_id) DO NOTHING`);
            for (const r of relock) {
                const id = idUnder(live, r.token);
                put.run(r.public_key, id, boxUnder(live, r.public_key, id, r.token), r.platform ?? 'ios', r.created_at, r.registered_at);
            }
        })();
    }
    return { held: rows.length - relock.length - remove.length, relocked: relock.length, removed: remove.length };
}

let installedAs: 'main' | 'standby' | null = null;

/**
 * At boot, after the recovery seal (its key is this one's): a main server makes the key if it has none, locks what a
 * table from before held ({@link lockPlainPushRows}) and checks every row opens ({@link checkPushRowsAtBoot}); a standby
 * drops what a table from before held ({@link dropPlainPushRows}). Called from initStateEngine and again once the role is
 * final (index.ts, after a take-over step may have changed it); does nothing when the role did not change. Never throws:
 * a failure is logged, the server runs, and the next boot tries again.
 */
export function installPushTokenSealAtBoot(opts: { standby: boolean }): void {
    const as = opts.standby ? 'standby' : 'main';
    if (installedAs === as) return;
    installedAs = as;
    const phones = (n: number) => `${n} phone registration${n === 1 ? '' : 's'}`;
    try {
        if (opts.standby) {
            const dropped = dropPlainPushRows();
            if (dropped.tokens || dropped.leaves || dropped.tombstones) {
                console.log(`🔐 Push tokens: this standby dropped the ${phones(dropped.tokens)}, ${dropped.leaves} leave statement(s) and `
                    + `${dropped.tombstones} deletion record(s) it held with tokens in the clear. It holds no key to lock them; its main `
                    + "server's locked ones come with its next whole copy.");
            }
            return;
        }
        if (ensureRecoverySealKey().created) console.log(`🔐 Push tokens: made data/${RECOVERY_SEAL_KEY_FILE}.`);
        const locked = lockPlainPushRows();
        if (locked.tokens || locked.leaves || locked.tombstones) {
            console.log(`🔐 Push tokens: locked the ${phones(locked.tokens)} and named ${locked.leaves} leave statement(s) and `
                + `${locked.tombstones} deletion record(s) by id, all stored with tokens in the clear before.`);
        }
        const checked = checkPushRowsAtBoot();
        console.log(`🔐 Push tokens: ${phones(checked.held + checked.relocked)}, locked with data/${RECOVERY_SEAL_KEY_FILE}.`);
        if (checked.relocked) {
            console.log(`🔐 Push tokens: locked ${phones(checked.relocked)} again with data/${RECOVERY_SEAL_KEY_FILE}: only a key it `
                + 'replaced opened them (kept as data/recovery-seal-retired-….key).');
        }
        if (checked.removed) {
            console.warn(`⚠️ Push tokens: removed ${phones(checked.removed)} locked with a key this server doesn't have (a take-over `
                + `or a restore without data/${RECOVERY_SEAL_KEY_FILE}). Each of those phones registers again when its app next opens.`);
        }
    } catch (e) {
        installedAs = null;
        console.warn(`⚠️ Push tokens: ${(e as Error)?.message || e} The server runs; the next boot tries again.`);
    }
}

// ── the rollback command ──────────────────────────────────────────────────────────────────────

/**
 * The reverse, for a rollback past this change, with the server stopped: push_tokens and push_token_leaves rebuilt in the
 * shape the code before reads (each token in the clear, and in the key), each row this server's key opens put back with
 * its token, in one transaction. A row it doesn't open is left out, and so is every leave statement (it names its phone
 * by id, which can't be undone; one refuses a late registration for a day at most): those phones register again when
 * their apps next open. Tombstones stay as they are; the code before matches no row by them. The next boot on this code
 * locks the rows again. Throws {@link RecoverySealKeyMissing}, changing nothing.
 */
export function unlockPushRowsForRollback(): { tokens: number; leftOut: number; leaves: number } {
    const keys = requireKeys();
    if (!hasTable('push_tokens') || db.prepare(`SELECT 1 FROM pragma_table_info('push_tokens') WHERE name = 'token'`).get()) {
        return { tokens: 0, leftOut: 0, leaves: 0 };
    }
    const rows = db.prepare('SELECT public_key, token_id, token_box, platform, created_at, registered_at FROM push_tokens').all() as
        { public_key: string; token_id: string; token_box: string; platform: string | null; created_at: string | null; registered_at: number | null }[];
    const leaves = (db.prepare('SELECT COUNT(*) AS n FROM push_token_leaves').get() as { n: number }).n;
    let tokens = 0;
    db.transaction(() => {
        db.exec(`DROP TABLE push_tokens; DROP TABLE push_token_leaves;
            CREATE TABLE push_tokens (
                public_key TEXT NOT NULL REFERENCES members(public_key),
                token TEXT NOT NULL,
                platform TEXT DEFAULT 'ios',
                created_at DATETIME DEFAULT (${NOW}),
                registered_at INTEGER,
                updated_at DATETIME DEFAULT (${NOW}),
                PRIMARY KEY (public_key, token)
            );
            CREATE TABLE push_token_leaves (
                public_key TEXT NOT NULL,
                token TEXT NOT NULL,
                left_at INTEGER NOT NULL,
                applied_at DATETIME NOT NULL DEFAULT (${NOW}),
                updated_at DATETIME DEFAULT (${NOW}),
                PRIMARY KEY (public_key, token)
            );
            CREATE INDEX IF NOT EXISTS idx_push_token_leaves_applied_at ON push_token_leaves(applied_at);
            CREATE INDEX IF NOT EXISTS idx_push_tokens_created_at ON push_tokens(created_at);`);
        const put = db.prepare(`INSERT OR IGNORE INTO push_tokens (public_key, token, platform, created_at, registered_at) VALUES (?, ?, ?, COALESCE(?, ${NOW}), ?)`);
        for (const r of rows) {
            const token = openUnder(keys, r.public_key, r.token_id, r.token_box);
            if (token !== null) tokens += put.run(r.public_key, token, r.platform ?? 'ios', r.created_at, r.registered_at).changes;
        }
    })();
    return { tokens, leftOut: rows.length - tokens, leaves };
}

const invokedDirectly = !!process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (invokedDirectly) {
    if (!process.argv.includes('--unlock-push-tokens')) {
        console.error('Usage: push-token-seal --unlock-push-tokens   (with the server stopped; BEANPOOL_DATA_DIR = its data folder)');
        process.exit(2);
    }
    try {
        const done = unlockPushRowsForRollback();
        console.log(`Put back ${done.tokens} phone registration${done.tokens === 1 ? '' : 's'} in the clear for an older server; `
            + `${done.leftOut} that this key doesn't open and ${done.leaves} leave statement(s) were left out. `
            + 'Start the older server before this one, which would lock them again at boot.');
        process.exit(0);
    } catch (e) {
        console.error(`Nothing was changed: ${(e as Error)?.message || e}`);
        process.exit(1);
    }
}
