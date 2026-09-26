/**
 * The recovery seal: every sign-in recovery copy this node stores is locked with a key kept outside its database
 * (scratch design DESIGN-sso-seal-db-fable.md §4, S1; Marty chose it 2026-09-26, card sso-copy-lock).
 *
 * ## Why
 *
 * A member's sign-in copy is their whole seed (and their 12 words) sealed by their app under `scrypt(provider:sub, salt)`,
 * with the salt in the same row. Nothing in that row is secret but the `sub`, and GitHub's is the public user id. So a
 * copy of the database opened every GitHub-linked account in it, one scrypt each. The apps' format stays exactly as it
 * is (the vectors, both apps and every copy already made are untouched); the node adds a second lock, at the storage
 * boundary, with a key the database never holds.
 *
 * ## The key
 *
 * `data/recovery-seal.key`: 32 random bytes, 0600, beside `libp2p_key`. Made at boot by a main server when there is
 * none (installRecoverySealAtBoot), never by a standby: a standby must not hold a key of its own that a later take-over
 * would overwrite or, worse, keep. It is never in the database, so never in a sync payload, a snapshot, or a plain
 * backup (a plain backup is state.db, node_config.json and images: sealed-backup.ts).
 *
 * It travels only inside the take-over bundle (takeover-envelope.ts BUNDLED_FILES), so inside the take-over envelope
 * and a sealed backup, and nowhere else (S2). A take-over and a sealed-backup restore write it here with
 * {@link installCarriedRecoverySealKey}, so the server they bring up opens every copy it inherited. One without it (an
 * envelope or a sealed backup made before it was carried, or a plain backup) still promotes or restores; the server
 * then makes a key of its own and cannot open those copies: members' 12 words still work, and connecting the sign-in
 * again makes a new copy. The take-over and the restore say so ({@link noCarriedKeyLine}).
 *
 * ## A key that opens copies is never lost
 *
 * A server can already hold a DIFFERENT key when one arrives: a standby that was once a main server, or one promoted
 * before the key travelled, which made its own and took deposits under it. The key that arrives is the community's,
 * and the rows that come with it (the standby's copy of the main server, the backup's database) are locked with it,
 * so it becomes `recovery-seal.key`. The one it replaces is never deleted: it is kept beside it as
 * `recovery-seal-retired-<id>.key` (0600), the reader tries it when the live key does not open a row, and at the next
 * boot every row only a retired key opens is locked again with the live one ({@link rewrapRowsFromRetiredKeys}), so the
 * next take-over bundle, which carries the live key only, opens everything the database holds.
 *
 * The file is read on every use (32 bytes; the derivation is cached against its contents). A key that is deleted while
 * the server runs is gone at once, rather than living on in memory to lock new deposits that would not open after the
 * next restart: deposits are refused with {@link RECOVERY_SEAL_KEY_MISSING}, and nothing is stored unwrapped.
 *
 * ## The wrap
 *
 * XChaCha20-Poly1305 under HKDF-SHA256(file key, info 'beanpool-recovery-row/v1'), a random 24-byte nonce per row.
 * Plaintext: the JSON of the client's four fields `{encryptedShare, shareIv, shareTag, kdfParams}`, so the words box in
 * kdfParams is inside the wrap too. Stored: `encrypted_share`, `share_iv`, `share_tag` are the wrap's ciphertext, nonce
 * and tag, and `kdf_params` is `{"alg":"node-wrap-xc20p-v1","inner":"<the client's alg>"}`, so code that only asks
 * "single blob or two-layer?" reads `inner` without the key ({@link isSingleBlobSsoStored}). The lookup hash and its
 * salt stay in the clear: they find the row and reveal nothing.
 *
 * Bound (AAD) to where the row sits: a stored copy to (owner, holder type), never the generation, because a
 * carry-forward writes the same copy into the next generation; a released copy to (collection, share id, holder type),
 * because the share row it came from is deleted by the next re-split while the release stays as history. Not the holder
 * ref, which the design named: this codebase treats it as decorative for a machine keeper (engine/recovery-shares.ts,
 * "the constraint is on the COUNT, not on the name"; a hub stored under an older name must still release), and binding
 * it would add nothing, since every copy one owner holds opens to that owner's own seed.
 *
 * ## Migration, both ways
 *
 * At boot, once the key exists, every row stored before the wrap (phones since #1150, browsers since #1174, and
 * releases) is wrapped in one transaction: idempotent, logged by count, never blocking the boot. It stamps the rows it
 * wraps, so a standby that already holds the unwrapped copy is sent the wrapped one, and it runs with secure_delete on
 * and truncates the WAL after, so the unwrapped bytes do not linger in the database files.
 *
 * Copies DELETED before the seal are not rows any more, so the wrap cannot reach them: the server deleted without zeroing
 * until now, and each one is still in state.db's free pages as the app sealed it. So each server runs one VACUUM, once,
 * and records it ({@link clearCopiesDroppedBeforeSeal}): a main server right after its wrap, a standby once its main
 * server has sealed (its wrapped copies have arrived: until then copies in the old form can still reach it, even when it
 * holds none). From this change on, db.ts zeroes whatever the server deletes or replaces (secure_delete). Backups and
 * snapshots made before the upgrade are copies of the live rows then, unwrapped ones included; no code here reaches them.
 *
 * A standby also holds, as ROWS, the copies its main server deleted before the seal (no deletion of a copy reaches a
 * standby), still in the form that opens with the `sub` alone. It removes them once a whole copy of its main server
 * shows which ones that server no longer holds, whether or not that server has sealed, and asks its puller for one once
 * it has ({@link dropCopiesMainServerDeleted}). A standby left holding no copy that way (its main server deleted every
 * one before the seal, so no wrapped copy comes) runs the VACUUM then too, without recording it.
 * Deletions after the seal still do not reach a standby; those copies are wrapped, and are left to a tombstone.
 *
 * A standby that has recorded its clear and is then sent a copy in the client's form (its main server rolled back past
 * the seal, or it now copies one that has not sealed) forgets the record, as the rollback command does on a main
 * server, and clears again once an import brings the wrapped copies back ({@link REOPENED_KEY}). When the standby ran
 * the older code too while the rollback lasted, this code saw none of those copies arrive: so at its boot it forgets the
 * record too when it holds a copy in the client's form that was not here, as it is now, when the clear was recorded.
 * Nothing on a standby needs a command for a rollback.
 *
 * Rolling the server back past this change needs the rows unwrapped first, by the NEW code, with the server stopped:
 *
 *     node dist/services/recovery-seal-key.js --unwrap-recovery-rows          # in the image (/app/apps/server)
 *     pnpm exec tsx src/services/recovery-seal-key.ts --unwrap-recovery-rows  # from a checkout
 *
 * with BEANPOOL_DATA_DIR pointing at the node's data folder (the image sets /data). It prints counts only.
 *
 * ## What this does not do
 *
 * Lock out the operator. The operator's process holds this key and receives the `sub` on every sign-in; that is a
 * stated trade (design §2), not a gap this file could close.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { xchacha20poly1305 } from '@noble/ciphers/chacha.js';
import { KEEPER_ALG_SSO_SINGLE } from '@beanpool/core';
import { db } from '../db/db.js';

export const RECOVERY_SEAL_KEY_FILE = 'recovery-seal.key';

/** A key a carried one replaced, kept beside it: `recovery-seal-retired-<16 hex>.key`. */
const RETIRED_KEY_FILE = /^recovery-seal-retired-[0-9a-f]{16}\.key$/;

/** The scheme name a wrapped row's `kdf_params` carries. */
export const NODE_WRAP_ALG = 'node-wrap-xc20p-v1';

/** What a server without its key says, to a member and in its log (design §4 "Where"). */
export const RECOVERY_SEAL_KEY_MISSING =
    'This server holds sign-in recovery copies it cannot open: data/recovery-seal.key is missing.';

const KEY_BYTES = 32;
const NONCE_BYTES = 24;
const TAG_BYTES = 16;
const HKDF_INFO = 'beanpool-recovery-row/v1';
const AAD_ROW = 'beanpool-recovery-row/v1';
const AAD_RELEASE = 'beanpool-recovery-release/v1';

/** The key file is missing, or is not a key. Deposits are refused and wrapped rows cannot be read until it is back. */
export class RecoverySealKeyMissing extends Error {
    readonly code = 'recovery_seal_key_missing';
    constructor(message: string = RECOVERY_SEAL_KEY_MISSING) {
        super(message);
        this.name = 'RecoverySealKeyMissing';
    }
}

/** This server's key does not open a wrapped row: it was locked with another key, or it was altered. */
export class RecoverySealUnopenable extends Error {
    readonly code = 'recovery_seal_unopenable';
    constructor() {
        super('This server cannot open a sign-in recovery copy it holds: it was locked with a recovery-seal key '
            + 'this server does not have. Your 12 words still work, and connecting the sign-in again makes a new copy.');
        this.name = 'RecoverySealUnopenable';
    }
}

/** A copy's four client fields, as the client sent them or as they are stored. */
export interface RecoverySealFields {
    encryptedShare: string;
    shareIv: string;
    shareTag: string;
    kdfParams: string | null;
}

function dataDir(): string {
    return process.env.BEANPOOL_DATA_DIR || path.join(process.cwd(), 'data');
}

export function recoverySealKeyPath(): string {
    return path.join(dataDir(), RECOVERY_SEAL_KEY_FILE);
}

let derived: { file: Buffer; key: Uint8Array } | null = null;

/** The wrap key from the file as it is now; null when there is no file. Never makes one. */
function currentKey(): Uint8Array | null {
    let file: Buffer;
    try {
        file = fs.readFileSync(recoverySealKeyPath());
    } catch (e) {
        if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
        throw new RecoverySealKeyMissing(
            `This server holds sign-in recovery copies it cannot open: data/${RECOVERY_SEAL_KEY_FILE} could not be read.`);
    }
    if (file.length !== KEY_BYTES) {
        throw new RecoverySealKeyMissing(
            `This server holds sign-in recovery copies it cannot open: data/${RECOVERY_SEAL_KEY_FILE} is not a ${KEY_BYTES}-byte key.`);
    }
    if (derived && derived.file.equals(file)) return derived.key;
    const key = deriveKey(file);
    derived = { file, key };
    return key;
}

function deriveKey(file: Buffer): Uint8Array {
    return new Uint8Array(crypto.hkdfSync('sha256', file, Buffer.alloc(0), HKDF_INFO, KEY_BYTES));
}

function requireKey(): Uint8Array {
    const key = currentKey();
    if (!key) throw new RecoverySealKeyMissing();
    return key;
}

/** Throws {@link RecoverySealKeyMissing} unless this server can wrap a copy right now. */
export function requireRecoverySealKey(): void {
    requireKey();
}

let retired: { names: string; keys: Uint8Array[] } | null = null;

/**
 * The keys a carried key replaced ({@link installCarriedRecoverySealKey}), derived, in name order. Read when the live
 * key does not open a row, which is rare: the directory listing is the cache's key, so a file added or removed by hand
 * is seen at the next miss.
 */
function retiredKeys(): Uint8Array[] {
    let names: string[];
    try {
        names = fs.readdirSync(dataDir()).filter(n => RETIRED_KEY_FILE.test(n)).sort();
    } catch {
        return [];
    }
    const sig = names.join('\n');
    if (retired && retired.names === sig) return retired.keys;
    const keys: Uint8Array[] = [];
    for (const n of names) {
        try {
            const file = fs.readFileSync(path.join(dataDir(), n));
            if (file.length === KEY_BYTES) keys.push(deriveKey(file));
        } catch { /* unreadable: not a key this server can use */ }
    }
    retired = { names: sig, keys };
    return keys;
}

/** A key file's name when it is retired: a hash of its bytes, never the bytes. */
function retiredNameOf(file: Buffer): string {
    const id = crypto.createHash('sha256').update('beanpool-recovery-seal-key-id/v1\n').update(file).digest('hex').slice(0, 16);
    return `recovery-seal-retired-${id}.key`;
}

/** What {@link installCarriedRecoverySealKey} did. `retiredAs`: where the key it replaced is kept. */
export type CarriedKeyOutcome =
    | { outcome: 'absent' }
    | { outcome: 'invalid' }
    | { outcome: 'same' }
    | { outcome: 'installed' }
    | { outcome: 'replaced'; retiredAs: string };

/** What a take-over or a restore says when the keys it opened carry no recovery-seal key (design §4). */
export function noCarriedKeyLine(where: 'envelope' | 'backup'): string {
    return `No recovery-seal key in this ${where}: members' sign-in copies will not open on this server until they reconnect. `
        + 'Their 12 words still work.';
}

/** Write a file exclusively (never over another), 0600, synced. False when a file is already there. */
function writeExclusive(target: string, bytes: Buffer): boolean {
    let fd: number;
    try {
        fd = fs.openSync(target, 'wx', 0o600);
    } catch (e) {
        if ((e as NodeJS.ErrnoException).code === 'EEXIST') return false;
        throw e;
    }
    try {
        fs.writeSync(fd, bytes);
        fs.fsyncSync(fd);
    } catch (e) {
        try { fs.closeSync(fd); } catch { /* closed */ }
        fs.rmSync(target, { force: true });
        throw e;
    }
    fs.closeSync(fd);
    return true;
}

/**
 * Install the recovery-seal key a take-over bundle carried (a take-over's identity-files step, a sealed-backup restore),
 * as base64 from the bundle, or nothing when the bundle had none (sealed before the key travelled).
 *
 * - None, or not a 32-byte key: nothing is written ('absent', 'invalid'); the caller says so. A key this server already
 *   has stays.
 * - The same key: nothing to do. So running a take-over step again changes nothing.
 * - No key here: written atomically, 0600 (a temporary file, synced, renamed into place, the directory synced).
 * - A different file here (a key, or a file that is not one): it is never deleted. It is kept, byte for byte and 0600,
 *   as `recovery-seal-retired-<id>.key` BEFORE the carried key takes its place, so a crash between the two leaves the
 *   old key in both places and the next run finishes the swap. The reader tries it for a row the live key does not open,
 *   and the next boot locks those rows again with the live key ({@link rewrapRowsFromRetiredKeys}). A file of that name
 *   that holds other bytes (nothing here writes one) is left as it is, and the key is kept under a random name instead:
 *   a take-over never stops over the key, and nothing is written over.
 *
 * An I/O error (a full or read-only disk) is thrown, as for the other identity files: the take-over step that asked
 * is tried again at the next start. Never logs or returns a key's bytes.
 */
export function installCarriedRecoverySealKey(b64: string | null | undefined): CarriedKeyOutcome {
    if (!b64) return { outcome: 'absent' };
    const carried = Buffer.from(b64, 'base64');
    if (carried.length !== KEY_BYTES) return { outcome: 'invalid' };
    const target = recoverySealKeyPath();
    const dir = path.dirname(target);
    fs.mkdirSync(dir, { recursive: true });
    let existing: Buffer | null = null;
    try {
        existing = fs.readFileSync(target);
    } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
    }
    if (existing && existing.equals(carried)) return { outcome: 'same' };
    let retiredAs: string | null = null;
    if (existing) {
        retiredAs = retiredNameOf(existing);
        if (!writeExclusive(path.join(dir, retiredAs), existing) && !fs.readFileSync(path.join(dir, retiredAs)).equals(existing)) {
            // Not ours: left alone. The key is kept under a name nothing else has.
            do retiredAs = `recovery-seal-retired-${crypto.randomBytes(8).toString('hex')}.key`;
            while (!writeExclusive(path.join(dir, retiredAs), existing));
        }
        fsyncDir(dir);
        retired = null;
    }
    const tmp = `${target}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
    try {
        if (!writeExclusive(tmp, carried)) throw new Error('a temporary key file was already there');
        fs.renameSync(tmp, target);
    } finally {
        fs.rmSync(tmp, { force: true });
    }
    fsyncDir(dir);
    return retiredAs ? { outcome: 'replaced', retiredAs } : { outcome: 'installed' };
}

/**
 * What `link()` says on a data folder that has no hard links: FAT/exFAT, many SMB/CIFS and some FUSE mounts (Linux gives
 * EPERM, macOS ENOTSUP). The same list sealed-backup.ts falls back on, with ENOTSUP.
 */
const NO_HARD_LINKS = new Set(['EPERM', 'ENOTSUP', 'EMLINK', 'ENOSYS', 'EXDEV']);

/** Flush a directory's entries, where the filesystem lets a directory be opened and synced; elsewhere, nothing. */
function fsyncDir(dir: string): void {
    let fd: number | null = null;
    try {
        fd = fs.openSync(dir, 'r');
        fs.fsyncSync(fd);
    } catch { /* not every filesystem (or platform) syncs a directory */ } finally {
        if (fd !== null) try { fs.closeSync(fd); } catch { /* closed */ }
    }
}

/**
 * Make the key file if there is none. Written to a temporary file and linked into place, so a crash leaves no half a key
 * and an existing file (a key, or something that is not one) is never overwritten. On a data folder without hard links,
 * the key is created in place instead, exclusively (`wx`), so that still never overwrites a file: a crash in the moment
 * between the create and the one 32-byte write would leave an empty file, which the boot then names.
 */
export function ensureRecoverySealKey(): { created: boolean } {
    const target = recoverySealKeyPath();
    if (fs.existsSync(target)) return { created: false };
    const dir = path.dirname(target);
    fs.mkdirSync(dir, { recursive: true });
    const key = crypto.randomBytes(KEY_BYTES);
    const tmp = `${target}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
    try {
        const fd = fs.openSync(tmp, 'wx', 0o600);
        try {
            fs.writeSync(fd, key);
            fs.fsyncSync(fd);
        } finally {
            fs.closeSync(fd);
        }
        fs.chmodSync(tmp, 0o600);
        try {
            fs.linkSync(tmp, target);
        } catch (e) {
            const code = (e as NodeJS.ErrnoException).code ?? '';
            if (code === 'EEXIST') return { created: false };
            if (!NO_HARD_LINKS.has(code)) throw e;
            return { created: createKeyInPlace(target, key) };
        }
        fsyncDir(dir);
        return { created: true };
    } finally {
        fs.rmSync(tmp, { force: true });
    }
}

/** The fallback without hard links: create the key file exclusively and write it. False if a file is already there. */
function createKeyInPlace(target: string, key: Buffer): boolean {
    let fd: number;
    try {
        fd = fs.openSync(target, 'wx', 0o600);
    } catch (e) {
        if ((e as NodeJS.ErrnoException).code === 'EEXIST') return false;
        throw e;
    }
    try {
        fs.writeSync(fd, key);
        fs.fsyncSync(fd);
    } catch (e) {
        // This process made the file a moment ago and nothing has used it: a key that did not go down whole is removed,
        // so the next boot makes one rather than finding a file that is not a key.
        try { fs.closeSync(fd); } catch { /* closed */ }
        fs.rmSync(target, { force: true });
        throw e;
    }
    fs.closeSync(fd);
    fsyncDir(path.dirname(target));
    return true;
}

function parseKdf(kdfParams: string | null | undefined): Record<string, unknown> | null {
    if (!kdfParams) return null;
    try {
        const parsed = JSON.parse(kdfParams);
        return parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : null;
    } catch {
        return null;
    }
}

/** Whether a stored row is wrapped by this node. The scheme name decides; a client may not use it (putShareGeneration). */
export function isNodeWrapped(kdfParams: string | null | undefined): boolean {
    return parseKdf(kdfParams)?.alg === NODE_WRAP_ALG;
}

/**
 * Whether a STORED row is a single-blob sign-in copy, wrapped or not, without the key: what the threshold logic asks of
 * rows it never hands out.
 */
export function isSingleBlobSsoStored(kdfParams: string | null | undefined): boolean {
    const parsed = parseKdf(kdfParams);
    if (!parsed) return false;
    return parsed.alg === NODE_WRAP_ALG ? parsed.inner === KEEPER_ALG_SSO_SINGLE : parsed.alg === KEEPER_ALG_SSO_SINGLE;
}

/** Where a stored copy sits: its owner and holder type. */
export function shareRowAad(ownerPubkey: string, holderType: string): Uint8Array {
    return Buffer.from(JSON.stringify([AAD_ROW, ownerPubkey, holderType]), 'utf-8');
}

/** Where a released copy sits: its collection, the share id it was released from, and the holder type. */
export function releaseRowAad(collectionId: string, shareId: number, holderType: string): Uint8Array {
    return Buffer.from(JSON.stringify([AAD_RELEASE, collectionId, shareId, holderType]), 'utf-8');
}

/** Wrap a client's copy for storage. Throws {@link RecoverySealKeyMissing}; never returns the copy unwrapped. */
export function sealRecoveryFields(fields: RecoverySealFields, aad: Uint8Array): RecoverySealFields {
    const key = requireKey();
    const plaintext = Buffer.from(JSON.stringify({
        encryptedShare: fields.encryptedShare,
        shareIv: fields.shareIv,
        shareTag: fields.shareTag,
        kdfParams: fields.kdfParams ?? null,
    }), 'utf-8');
    const nonce = crypto.randomBytes(NONCE_BYTES);
    const sealed = xchacha20poly1305(key, nonce, aad).encrypt(plaintext);
    const inner = parseKdf(fields.kdfParams)?.alg;
    return {
        encryptedShare: Buffer.from(sealed.subarray(0, sealed.length - TAG_BYTES)).toString('base64'),
        shareIv: nonce.toString('base64'),
        shareTag: Buffer.from(sealed.subarray(sealed.length - TAG_BYTES)).toString('base64'),
        kdfParams: JSON.stringify({ alg: NODE_WRAP_ALG, inner: typeof inner === 'string' ? inner : null }),
    };
}

/** The wrap opened with this key, or null when it does not open (another key, or altered). */
function openWith(key: Uint8Array, stored: RecoverySealFields, aad: Uint8Array): Uint8Array | null {
    try {
        const ct = Buffer.from(stored.encryptedShare, 'base64');
        const tag = Buffer.from(stored.shareTag, 'base64');
        const nonce = Buffer.from(stored.shareIv, 'base64');
        if (nonce.length !== NONCE_BYTES || tag.length !== TAG_BYTES) return null;
        return xchacha20poly1305(key, nonce, aad).decrypt(Buffer.concat([ct, tag]));
    } catch {
        return null;
    }
}

/**
 * A stored copy's client fields. A row stored before the wrap comes back as it is (the boot migration wraps it); a
 * wrapped one needs the key ({@link RecoverySealKeyMissing}) and must open under it, or under a key a carried one
 * replaced ({@link installCarriedRecoverySealKey}), or it is {@link RecoverySealUnopenable}.
 */
export function openRecoveryFields(stored: RecoverySealFields, aad: Uint8Array): RecoverySealFields {
    return openRecoveryFieldsUnder(stored, aad, true);
}

function openRecoveryFieldsUnder(stored: RecoverySealFields, aad: Uint8Array, withRetired: boolean): RecoverySealFields {
    if (!isNodeWrapped(stored.kdfParams)) return stored;
    const key = requireKey();
    let plaintext = openWith(key, stored, aad);
    if (!plaintext && withRetired) {
        for (const k of retiredKeys()) {
            plaintext = openWith(k, stored, aad);
            if (plaintext) break;
        }
    }
    if (!plaintext) throw new RecoverySealUnopenable();
    const f = JSON.parse(Buffer.from(plaintext).toString('utf-8')) as Record<string, unknown>;
    if (typeof f.encryptedShare !== 'string' || typeof f.shareIv !== 'string' || typeof f.shareTag !== 'string'
        || (f.kdfParams !== null && typeof f.kdfParams !== 'string')) {
        throw new RecoverySealUnopenable();
    }
    return { encryptedShare: f.encryptedShare, shareIv: f.shareIv, shareTag: f.shareTag, kdfParams: f.kdfParams as string | null };
}

// ── migration ─────────────────────────────────────────────────────────────────────────────────────

interface ShareRow { id: number; owner_pubkey: string; holder_type: string; holder_ref: string;
    encrypted_share: string; share_iv: string; share_tag: string; kdf_params: string | null }
interface ReleaseRow { id: number; collection_id: string; share_id: number; holder_type: string;
    payload: string; payload_iv: string; payload_tag: string; kdf_params: string | null }

const shareFields = (r: ShareRow): RecoverySealFields =>
    ({ encryptedShare: r.encrypted_share, shareIv: r.share_iv, shareTag: r.share_tag, kdfParams: r.kdf_params });
const releaseFields = (r: ReleaseRow): RecoverySealFields =>
    ({ encryptedShare: r.payload, shareIv: r.payload_iv, shareTag: r.payload_tag, kdfParams: r.kdf_params });

/**
 * Rewrite every row one way, in one transaction, with secure_delete on so the old bytes are zeroed where they lay, then
 * truncate the WAL so no old frame keeps them. Stored copies are stamped (a standby is sent the new form); releases are
 * not replicated and keep their stamp.
 */
function rewriteRows(which: (kdf: string | null) => boolean, map: (f: RecoverySealFields, aad: Uint8Array) => RecoverySealFields | null):
    { shares: number; releases: number } {
    const shares = (db.prepare(`SELECT id, owner_pubkey, holder_type, holder_ref, encrypted_share, share_iv, share_tag, kdf_params
        FROM recovery_shares`).all() as ShareRow[]).filter(r => which(r.kdf_params));
    const releases = (db.prepare(`SELECT id, collection_id, share_id, holder_type, payload, payload_iv, payload_tag, kdf_params
        FROM recovery_releases`).all() as ReleaseRow[]).filter(r => which(r.kdf_params));
    if (shares.length === 0 && releases.length === 0) return { shares: 0, releases: 0 };

    // Every row mapped before anything is written: a row that cannot be mapped fails the run and changes nothing. A map
    // that answers null leaves that row as it is.
    const mapped = <T extends { id: number }>(rows: T[], fields: (r: T) => RecoverySealFields, aad: (r: T) => Uint8Array) =>
        rows.map(r => ({ id: r.id, f: map(fields(r), aad(r)) })).filter((x): x is { id: number; f: RecoverySealFields } => x.f !== null);
    const newShares = mapped(shares, shareFields, r => shareRowAad(r.owner_pubkey, r.holder_type));
    const newReleases = mapped(releases, releaseFields, r => releaseRowAad(r.collection_id, r.share_id, r.holder_type));
    if (newShares.length === 0 && newReleases.length === 0) return { shares: 0, releases: 0 };

    const priorSecureDelete = Number(db.pragma('secure_delete', { simple: true })) || 0;
    db.pragma('secure_delete = ON');
    try {
        const updShare = db.prepare(`UPDATE recovery_shares SET encrypted_share = ?, share_iv = ?, share_tag = ?, kdf_params = ?,
            updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?`);
        const updRelease = db.prepare(`UPDATE recovery_releases SET payload = ?, payload_iv = ?, payload_tag = ?, kdf_params = ?
            WHERE id = ?`);
        db.transaction(() => {
            for (const { id, f } of newShares) updShare.run(f.encryptedShare, f.shareIv, f.shareTag, f.kdfParams, id);
            for (const { id, f } of newReleases) updRelease.run(f.encryptedShare, f.shareIv, f.shareTag, f.kdfParams, id);
        })();
    } finally {
        db.pragma(`secure_delete = ${priorSecureDelete}`);
    }
    try { db.pragma('wal_checkpoint(TRUNCATE)'); } catch { /* best effort: the next checkpoint writes over them */ }
    return { shares: newShares.length, releases: newReleases.length };
}

/** Wrap every row stored before the wrap. Idempotent: a second run finds nothing. Throws {@link RecoverySealKeyMissing}. */
export function wrapRecoveryRows(): { shares: number; releases: number } {
    requireKey();
    return rewriteRows(kdf => !isNodeWrapped(kdf), sealRecoveryFields);
}

/**
 * Lock again with the live key every wrapped row that only a retired key opens ({@link installCarriedRecoverySealKey}):
 * copies this server took under its own key before a take-over or a restore brought the community's. Stamped, so a
 * standby is sent them in the live key's lock, and zeroed where they lay. A row no key here opens is left as it is.
 * Idempotent; the retired key files stay. Throws {@link RecoverySealKeyMissing}.
 */
export function rewrapRowsFromRetiredKeys(): { shares: number; releases: number } {
    const live = requireKey();
    const keys = retiredKeys();
    if (keys.length === 0) return { shares: 0, releases: 0 };
    return rewriteRows(kdf => isNodeWrapped(kdf), (f, aad) => {
        if (openWith(live, f, aad)) return null;
        try {
            return sealRecoveryFields(openRecoveryFieldsUnder(f, aad, true), aad);
        } catch {
            return null;
        }
    });
}

/**
 * The reverse, for a rollback past this change: every wrapped row back to the client's bytes. Refuses (and changes
 * nothing) if any wrapped row does not open with this key, because an older server would then serve it as garbage.
 * It also forgets that the database was cleared ({@link clearCopiesDroppedBeforeSeal}): the older server deletes
 * without zeroing, so coming back to this code clears it again.
 */
export function unwrapRecoveryRows(): { shares: number; releases: number } {
    requireKey();
    const done = rewriteRows(kdf => isNodeWrapped(kdf), openRecoveryFields);
    db.prepare('DELETE FROM node_config WHERE key = ?').run(CLEARED_KEY);
    return done;
}

// ── copies deleted before the seal ────────────────────────────────────────────────────────────────

/**
 * node_config: when this database was cleared of copies deleted before the seal. Written only after the VACUUM and its
 * checkpoint finished, so one that failed or was cut off runs again. node_config is not replicated: each server
 * clears its own file. `clientForm`: a print of each copy in the client's form still here then
 * ({@link clientFormPrints}), what a standby's boot compares with ({@link forgetClearIfClientFormArrivedWhileDown}).
 */
export const CLEARED_KEY = 'recovery_seal_cleared';

/**
 * node_config, on a standby: it had recorded its clear, and was then sent copies in the client's form, so it forgot the
 * record ({@link forgetClearIfSentClientForm}). While this is here the standby clears again only after an import that
 * brings its main server's wrapped copies and none in the client's form: the evidence that server has sealed again.
 * Its copies deleted on the main server after the seal stay wrapped here (no deletion reaches a standby), so "a wrapped
 * copy is here" no longer shows that. Removed with the clear it waits for.
 */
export const REOPENED_KEY = 'recovery_seal_reopened';

const UPSERT_CONFIG = 'INSERT INTO node_config (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value';

/** Head room left on a disk after the VACUUM, on top of what it writes. */
const VACUUM_MARGIN_BYTES = 64 * 1024 * 1024;

let clearedSettled = false;
let clearTriedThisProcess = false;
let standbyWaitLogged = false;
/**
 * On a standby: how many copies in the old form it held at its last look (at boot, and after each import), so the look
 * that finds it holding none after a whole copy or a force-resync knows that they were there ({@link clearWithoutRecording}).
 * Null before the first.
 */
let standbyOldAtLastLook: number | null = null;
let freeBytesForTests: number | null = null;

/** Tests: pretend every disk has this many bytes free (null: measure). */
export function _setFreeBytesForTests(bytes: number | null): void {
    freeBytesForTests = bytes;
}

/** Where SQLite puts VACUUM's temporary copy: the first writable directory of these (unixTempFileDir in os_unix.c). */
function sqliteTempDir(): string {
    for (const d of [process.env.SQLITE_TMPDIR, process.env.TMPDIR, '/var/tmp', '/usr/tmp', '/tmp']) {
        if (!d) continue;
        try {
            if (!fs.statSync(d).isDirectory()) continue;
            fs.accessSync(d, fs.constants.W_OK | fs.constants.X_OK);
            return d;
        } catch { /* the next one */ }
    }
    return '.';
}

function freeBytes(dir: string): number | null {
    if (freeBytesForTests !== null) return freeBytesForTests;
    try {
        const s = fs.statfsSync(dir);
        return Number(s.bavail) * (s.bsize || 4096);
    } catch {
        return null;
    }
}

const mb = (n: number) => `${Math.ceil(n / 1048576)} MB`;

function dbFile(): string {
    return path.join(dataDir(), 'state.db');
}

function fileBytes(p: string): number {
    try { return fs.statSync(p).size; } catch { return 0; }
}

/**
 * Whether the disks have room for the VACUUM. It writes a copy of every page in use to SQLite's temporary directory, and
 * then the whole database again into the WAL beside state.db, before the checkpoint folds it back. The data folder is
 * asked for both, since on most hosts the temporary directory is the same disk under another name (a container's
 * layer); the room is checked, never assumed, because nodes share small disks.
 */
function roomForVacuum(): { ok: true } | { ok: false; why: string } {
    const pageSize = Number(db.pragma('page_size', { simple: true }));
    const inUse = (Number(db.pragma('page_count', { simple: true })) - Number(db.pragma('freelist_count', { simple: true }))) * pageSize;
    const checks = [
        { dir: dataDir(), need: 2 * inUse + VACUUM_MARGIN_BYTES },
        { dir: sqliteTempDir(), need: inUse + VACUUM_MARGIN_BYTES },
    ];
    for (const { dir, need } of checks) {
        const free = freeBytes(dir);
        if (free === null) return { ok: false, why: `the free space in ${dir} could not be measured` };
        if (free < need) return { ok: false, why: `it needs about ${mb(need)} free in ${dir}, which has ${mb(free)}` };
    }
    return { ok: true };
}

const copies = (n: number) => `${n} sign-in recovery cop${n === 1 ? 'y' : 'ies'}`;

/** One recovery_shares row by the key the table is unique on: what a whole copy of the main server is compared by. */
export interface RecoveryRowKey { ownerPubkey: string; generation: number; holderType: string; holderRef: string }

const rowKey = (ownerPubkey: string, generation: number, holderType: string, holderRef: string) =>
    JSON.stringify([ownerPubkey, Number(generation), holderType, holderRef]);

let wholeCopyWanted = false;
let wholeCopyAsked = false;
let keptLogged = false;

/**
 * Asked by a standby's puller before each pull (services/backup-puller.ts): true once, when this standby needs a whole
 * copy of its main server to tell which of its copies that server deleted before the seal ({@link dropCopiesMainServerDeleted}).
 * Asking resets it, so a whole copy that fails is not tried again on every tick: the next routine one, or the next boot,
 * brings it.
 */
export function takeRecoverySealFullPull(): boolean {
    const wanted = wholeCopyWanted;
    wholeCopyWanted = false;
    return wanted;
}

/**
 * On a standby, after an import: remove the copies its main server deleted before the seal. No deletion of a copy
 * reaches a standby (a copy has no tombstone). A re-deposit's older generation does go, because the import drops it; a
 * member disconnecting their only sign-in, removing their keepers or deleting their account does not. Each copy deleted
 * that way before the seal is still a row here, as the app sealed it, and opens with the `sub` alone: what the seal is
 * for. Once a take-over made this server a main one, its wrap would lock them in again, with its own key.
 *
 * Whether or not the main server has sealed: nothing in the proof below asks it. Before the seal it may delete more,
 * and the next whole copy removes those too. So a main server that deleted every copy before the seal leaves its
 * standby holding none, where waiting for wrapped copies it will never send would keep them for good.
 *
 * Only with a whole copy of the main server (the puller's snapshot, never a delta), and only the rows that copy does not
 * hold, compared by the key the table is unique on. A whole copy is every row the main server held when it made it (the
 * engine's export without a cursor: no WHERE and no LIMIT, in every version that sends recovery rows at all since they
 * were first replicated, #261; one that sends none removes nothing here). The import that wrote it here was one
 * transaction that either wrote every row or failed, with no row skipped: each under that same key (INSERT OR REPLACE).
 * This runs only after that import succeeded. So a row here that the copy does not hold is one the main server did not
 * hold, and no copy it still holds is ever removed, whatever the clocks, the order of the pulls, or the form its own
 * copies are in. And nothing else adds a row in the old form between the import and this: this code stores every copy
 * wrapped, or not at all without the key.
 *
 * A delta is no such proof: it carries only the rows changed since the last pull, found by the main server's clock. So
 * after a delta, or at boot, once the main server has sealed (its wrapped copies are here beside ones in the old form),
 * this asks the puller once for a whole copy ({@link takeRecoverySealFullPull}). Before that it does not ask: until its
 * main server seals, every standby holds only copies in the old form, and it takes the whole copies that come anyway
 * (a routine one, a force-resync).
 */
function dropCopiesMainServerDeleted(wholeCopy: RecoveryRowKey[] | null): void {
    const rows = db.prepare('SELECT id, owner_pubkey, generation, holder_type, holder_ref, kdf_params FROM recovery_shares').all() as
        { id: number; owner_pubkey: string; generation: number; holder_type: string; holder_ref: string; kdf_params: string | null }[];
    const old = rows.filter(r => !isNodeWrapped(r.kdf_params));
    if (old.length === 0) return;
    const sealed = old.length < rows.length;
    if (!wholeCopy) {
        if (sealed && !wholeCopyAsked) {
            wholeCopyAsked = true;
            wholeCopyWanted = true;
            console.warn(`⚠️ Recovery seal: this standby holds ${copies(old.length)} in the form stored before the seal beside its main `
                + 'server\'s wrapped ones: copies deleted there before the seal (a deletion of a copy does not reach a standby). It asks '
                + 'the main server for one whole copy, to tell them by what that server still holds, and removes them.');
        }
        return;
    }
    wholeCopyWanted = false;
    const held = new Set(wholeCopy.map(k => rowKey(k.ownerPubkey, k.generation, k.holderType, k.holderRef)));
    const gone = old.filter(r => !held.has(rowKey(r.owner_pubkey, r.generation, r.holder_type, r.holder_ref)));
    if (gone.length > 0) {
        // db.ts turns secure_delete on for the connection; said again here, because these rows are the reason for it.
        const priorSecureDelete = Number(db.pragma('secure_delete', { simple: true })) || 0;
        db.pragma('secure_delete = ON');
        try {
            const del = db.prepare('DELETE FROM recovery_shares WHERE id = ?');
            db.transaction(() => { for (const r of gone) del.run(r.id); })();
        } finally {
            db.pragma(`secure_delete = ${priorSecureDelete}`);
        }
        try { db.pragma('wal_checkpoint(TRUNCATE)'); } catch { /* best effort: the next checkpoint writes over them */ }
        console.log(`🔐 Recovery seal: removed ${copies(gone.length)} its main server deleted before the seal, zeroed where they lay.`);
    }
    const kept = old.length - gone.length;
    if (sealed && kept > 0 && !keptLogged) {
        keptLogged = true;
        console.warn(`⚠️ Recovery seal: ${copies(kept)} here in the form stored before the seal ${kept === 1 ? 'is one' : 'are ones'} this `
            + 'standby\'s main server still holds in that form (it has not wrapped them), so they stay as they are.');
    }
}

/**
 * On a standby, after an import: when it has recorded its clear and the import wrote a copy in the client's form, forget
 * the record, as the rollback command does on a main server. The recorded clear assumes nothing reaches it in that form
 * afterwards, and a rollback breaks that: the command unwraps and stamps every copy the main server holds, and the older
 * code stores re-deposits in the client's form, so all of them come here. Once the main server seals again the wrapped
 * copies replace them, and their old page images would stay in earlier -wal frames with nothing to clear them. A standby
 * re-pointed at a main server that has not sealed is the same case. So it forgets, waits ({@link REOPENED_KEY}), and runs
 * the recorded clear again after the import that brings the wrapped copies back.
 */
function forgetClearIfSentClientForm(imported: { kdfParams?: string | null }[]): void {
    const clientForm = imported.filter(r => !isNodeWrapped(r?.kdfParams ?? null)).length;
    if (clientForm === 0) return;
    if (!db.prepare('SELECT 1 FROM node_config WHERE key = ?').get(CLEARED_KEY)) return;
    forgetClear(clientForm);
    console.warn(`⚠️ Recovery seal: this standby had cleared state.db of sign-in recovery copies deleted before the seal, and was then sent `
        + `${copies(clientForm)} in the client's form (its main server rolled back past the seal, or has not sealed). So it forgets that `
        + 'clear, and clears again once its main server\'s wrapped copies come back.');
}

/**
 * On a standby, at boot: {@link forgetClearIfSentClientForm} for the copies that came while it ran other code. In a
 * rollback of every server at once the standby runs the older code too while it lasts, and imports the copies the
 * rollback command unwrapped and the re-deposits in the client's form with no thought of a recorded clear. Its main
 * server wraps them all again at its own boot, before it serves anything, so no import this code makes afterwards shows
 * one in the client's form: this boot is the only place it can tell.
 *
 * A copy in the client's form here that was not here, as it is now, when the clear was recorded came after it: nothing
 * else writes one on a standby. The record keeps a print of each copy in the client's form that was here then (the ones
 * its main server deleted before the seal, rows here until a whole copy removes them), so those never make it forget, at
 * this boot or any other. The print covers where the copy sits, its bytes and its stamp, and the stamp is the main
 * server's: the rollback command stamps every copy it unwraps and the older code stamps each re-deposit, so neither is
 * the copy that was here. Prints are compared, never clocks: the stamps are the main server's clock and the record's
 * `at` is this server's, and no skew between the two changes what matches. A record made before it kept prints (the
 * first code with the seal) is taken to have held none: every copy in the client's form here then forgets it, once,
 * at the cost of one more VACUUM, and the clear recorded after that keeps them.
 */
function forgetClearIfClientFormArrivedWhileDown(): void {
    const record = db.prepare('SELECT value FROM node_config WHERE key = ?').pluck().get(CLEARED_KEY) as string | undefined;
    if (record === undefined) return;
    let kept: unknown;
    try { kept = (JSON.parse(record) as { clientForm?: unknown })?.clientForm; } catch { kept = null; }
    const then = new Set(Array.isArray(kept) ? kept.filter((p): p is string => typeof p === 'string') : []);
    const arrived = clientFormPrints().filter(p => !then.has(p)).length;
    if (arrived === 0) return;
    forgetClear(arrived);
    console.warn(`⚠️ Recovery seal: this standby had cleared state.db of sign-in recovery copies deleted before the seal, and at this boot `
        + `holds ${copies(arrived)} in the client's form that ${arrived === 1 ? 'was' : 'were'} not here when it cleared (its main server `
        + 'rolled back past the seal while this standby ran older code). So it forgets that clear, and clears again once its main '
        + 'server\'s wrapped copies come back.');
}

/** Forget the recorded clear, and wait for an import that brings the main server's wrapped copies ({@link REOPENED_KEY}). */
function forgetClear(clientForm: number): void {
    db.transaction(() => {
        db.prepare('DELETE FROM node_config WHERE key = ?').run(CLEARED_KEY);
        db.prepare(UPSERT_CONFIG).run(REOPENED_KEY, JSON.stringify({ at: new Date().toISOString(), copies: clientForm }));
    })();
    clearedSettled = false;
    clearTriedThisProcess = false;
    standbyWaitLogged = false;
}

/**
 * A print of each copy in the client's form here: a hash of where it sits (the key the table is unique on), its stamp
 * and its bytes, 16 hex characters. It shows only whether that same copy is still here; a copy cannot be read from it.
 */
function clientFormPrints(): string[] {
    const rows = db.prepare(`SELECT owner_pubkey, generation, holder_type, holder_ref, updated_at, encrypted_share, share_iv, share_tag, kdf_params
        FROM recovery_shares`).all() as (Omit<ShareRow, 'id'> & { generation: number; updated_at: string | null })[];
    return rows.filter(r => !isNodeWrapped(r.kdf_params)).map(r => crypto.createHash('sha256')
        .update(JSON.stringify(['beanpool-recovery-clear-print/v1', r.owner_pubkey, Number(r.generation), r.holder_type, r.holder_ref,
            r.updated_at, r.encrypted_share, r.share_iv, r.share_tag, r.kdf_params]))
        .digest('hex').slice(0, 16));
}

/**
 * Clear state.db of the copies deleted before the seal, once. Until this change the server deleted without zeroing
 * (secure_delete was off), so every copy a re-deposit dropped, a member removed or a purge took is still in the file's
 * free pages as the app sealed it: a whole seed box, its salt and the words box, which opens with the `sub` alone to the
 * member's current seed. The wrap cannot reach them; one VACUUM rewrites the file from the live rows only, and the
 * checkpoint after it empties the WAL. From here on db.ts zeroes whatever is deleted (secure_delete), so once is enough.
 *
 * On a main server it runs at boot, right after the wrap. On a standby, which never wraps, it runs at boot and after each
 * import once its main server has sealed: once wrapped copies are here. The import that brought them replaced every copy
 * the main server still holds (its wrap stamped every one), and the VACUUM after it clears those replaced copies from
 * the WAL too. It waits while no wrapped copy is here, including while it holds no copy at all: the main server has not
 * sealed, or holds no copy, and nothing here says which. A clear recorded then would come too early: copies in the old
 * form that reach it afterwards go into the WAL, and once the wrapped ones replace them their old page images stay in
 * its earlier frames, which nothing would truncate again. Copies its main server deleted before the seal are still rows
 * here, which no VACUUM clears; they are removed at a whole copy ({@link dropCopiesMainServerDeleted}), zeroed, before
 * or after it.
 *
 * One case would wait for good: a main server that deleted every copy before the seal sends no wrapped one, and its
 * standby, once a whole copy (or a force-resync) has removed the copies it held in the old form, holds none. The copies
 * its re-deposits dropped before the seal are still in its free pages. So a standby whose last look found copies in the
 * old form, and which now holds none, runs the same VACUUM then, and does not record it ({@link clearWithoutRecording}):
 * copies in the old form can still reach it, and the recorded clear still runs when wrapped ones arrive.
 *
 * A standby that has recorded its clear and is then sent a copy in the client's form forgets the record
 * ({@link forgetClearIfSentClientForm}), and clears again after an import that brings the wrapped copies back. So does
 * one that finds such a copy at its boot that was not here when it cleared ({@link forgetClearIfClientFormArrivedWhileDown}):
 * it ran the older code while its main server was rolled back.
 *
 * `boot`: called at boot ({@link installRecoverySealAtBoot}), not after an import.
 * `wholeCopy`: on a standby, the rows of the whole copy of its main server just imported; null after a delta or at boot.
 * `imported`: on a standby, the recovery rows the import just wrote, a delta's included; null at boot.
 * Never throws and never stops a boot. A VACUUM that fails, or that the disks have no room for, is logged and tried again
 * at the next boot; one that finished is recorded ({@link CLEARED_KEY}) and never runs again.
 */
export function clearCopiesDroppedBeforeSeal(opts: {
    standby: boolean; boot?: boolean; wholeCopy?: RecoveryRowKey[] | null; imported?: { kdfParams?: string | null }[] | null;
}): void {
    const imported = Array.isArray(opts.imported) ? opts.imported : null;
    if (opts.standby) {
        try {
            if (imported) forgetClearIfSentClientForm(imported);
            else if (opts.boot) forgetClearIfClientFormArrivedWhileDown();
        } catch (e) {
            console.warn(`⚠️ Recovery seal: checking whether this standby was sent sign-in recovery copies in the client's form failed: `
                + `${(e as Error)?.message || e}.`);
        }
        try {
            dropCopiesMainServerDeleted(opts.wholeCopy ?? null);
        } catch (e) {
            console.warn(`⚠️ Recovery seal: removing the sign-in recovery copies this standby's main server deleted before the seal failed: `
                + `${(e as Error)?.message || e}. The next whole copy of the main server tries again.`);
        }
    }
    if (clearedSettled) return;
    try {
        if (db.prepare('SELECT 1 FROM node_config WHERE key = ?').get(CLEARED_KEY)) { clearedSettled = true; return; }
        const kdfs = db.prepare('SELECT kdf_params FROM recovery_shares').pluck().all() as (string | null)[];
        const old = kdfs.filter(k => !isNodeWrapped(k)).length;
        const oldAtLastLook = standbyOldAtLastLook;
        if (opts.standby) standbyOldAtLastLook = old;
        // A main server whose wrap did not run has said why; the next boot tries again.
        if (old > 0 && !opts.standby) return;
        if (opts.standby && old === kdfs.length) {
            // No wrapped copy here, including no copy at all: nothing shows that the main server has sealed, and until it has,
            // copies in the old form can still arrive, into the WAL, after a clear recorded now.
            if (kdfs.length === 0 && oldAtLastLook) {
                clearWithoutRecording(oldAtLastLook);
                return;
            }
            if (!standbyWaitLogged) {
                standbyWaitLogged = true;
                console.log('🔐 Recovery seal: this standby waits to clear state.db of sign-in recovery copies deleted before the seal: '
                    + (old > 0
                        ? `every sign-in recovery copy it holds (${old}) is still in the form stored before the seal`
                        : 'it holds no sign-in recovery copy yet')
                    + ', so its main server has not sealed yet, or holds no copy at all. It clears once the main server\'s wrapped copies arrive.');
            }
            return;
        }
        if (opts.standby && db.prepare('SELECT 1 FROM node_config WHERE key = ?').get(REOPENED_KEY)
            && !(imported && imported.length > 0 && imported.every(r => isNodeWrapped(r?.kdfParams ?? null)))) {
            // It forgot its clear: copies in the client's form came after it. Wrapped copies here (the ones its main server
            // deleted after the seal stay, wrapped) do not show that server has sealed again; an import of wrapped ones does.
            if (!standbyWaitLogged) {
                standbyWaitLogged = true;
                console.log('🔐 Recovery seal: this standby was sent sign-in recovery copies in the client\'s form after it had cleared '
                    + 'state.db, so it clears again once an import brings its main server\'s wrapped copies back.');
            }
            return;
        }
        if (clearTriedThisProcess) return;
        clearTriedThisProcess = true;
        const room = roomForVacuum();
        if (!room.ok) {
            console.warn(`⚠️ Recovery seal: sign-in recovery copies deleted before the seal may still be readable in state.db's free space. `
                + `Clearing them takes one VACUUM, and ${room.why}. The server runs; the next boot tries again.`);
            return;
        }
        const { seconds, before, after } = vacuumAndCheckpoint();
        db.transaction(() => {
            db.prepare(UPSERT_CONFIG).run(CLEARED_KEY, JSON.stringify({
                at: new Date().toISOString(), seconds: Number(seconds.toFixed(2)), bytesBefore: before, bytesAfter: after,
                clientForm: clientFormPrints(),
            }));
            db.prepare('DELETE FROM node_config WHERE key = ?').run(REOPENED_KEY);
        })();
        clearedSettled = true;
        console.log(`🔐 Recovery seal: cleared state.db of sign-in recovery copies deleted before the seal (one VACUUM, ${seconds.toFixed(1)} s, `
            + `${mb(before)} → ${mb(after)}). This runs once.`
            + (old > 0 ? ` ${copies(old)} in the form stored before the seal ${old === 1 ? 'is' : 'are'} still here as rows: the next whole copy `
                + 'of the main server removes those it no longer holds.' : ''));
    } catch (e) {
        console.warn(`⚠️ Recovery seal: the one VACUUM that clears sign-in recovery copies deleted before the seal from state.db failed: `
            + `${(e as Error)?.message || e}. The server runs; the next boot tries again.`);
    }
}

/** One VACUUM, then a checkpoint that empties the WAL. Throws if either fails, after giving the disk its space back. */
function vacuumAndCheckpoint(): { seconds: number; before: number; after: number } {
    const before = fileBytes(dbFile());
    const t0 = performance.now();
    try {
        db.exec('VACUUM');
        const [cp] = db.pragma('wal_checkpoint(TRUNCATE)') as { busy: number; log: number; checkpointed: number }[];
        if (!cp || cp.busy !== 0) throw new Error('the checkpoint after it could not finish (another connection was reading)');
    } catch (e) {
        // A VACUUM that stopped part way leaves its frames in the WAL: give the disk its space back.
        try { db.pragma('wal_checkpoint(TRUNCATE)'); } catch { /* the next checkpoint does */ }
        throw e;
    }
    return { seconds: (performance.now() - t0) / 1000, before, after: fileBytes(dbFile()) };
}

/**
 * A standby that held copies in the old form at its last look and holds no copy now: a whole copy of its main server,
 * or a force-resync, removed them (zeroed), because that server deleted every one before the seal. The same VACUUM as
 * the recorded clear, for the copies its re-deposits dropped before the seal, still in its free pages; not recorded, so
 * the recorded clear still runs once wrapped copies arrive. Disk room checked first; never throws. A clear that did not
 * run here runs with the recorded one.
 */
function clearWithoutRecording(removed: number): void {
    const room = roomForVacuum();
    if (!room.ok) {
        console.warn(`⚠️ Recovery seal: this standby holds no sign-in recovery copy now, but copies deleted before the seal may still be `
            + `readable in state.db's free space. Clearing them takes one VACUUM, and ${room.why}. The server runs; it clears once its `
            + 'main server\'s wrapped copies arrive.');
        return;
    }
    try {
        const { seconds, before, after } = vacuumAndCheckpoint();
        console.log(`🔐 Recovery seal: this standby holds no sign-in recovery copy now: the ${copies(removed)} it held in the form stored `
            + `before the seal are gone. It cleared state.db of copies deleted before the seal (one VACUUM, ${seconds.toFixed(1)} s, `
            + `${mb(before)} → ${mb(after)}), and clears once more, and records it, when its main server's wrapped copies arrive.`);
    } catch (e) {
        console.warn(`⚠️ Recovery seal: the VACUUM that clears sign-in recovery copies deleted before the seal from this standby's state.db `
            + `failed: ${(e as Error)?.message || e}. The server runs; it clears once its main server's wrapped copies arrive.`);
    }
}

/** How many stored rows are wrapped, and how many of those this server's key does not open. Needs the key. */
function countWrapped(): { wrapped: number; unopenable: number } {
    return countUnopenable(db.prepare('SELECT owner_pubkey, holder_type, holder_ref, encrypted_share, share_iv, share_tag, kdf_params FROM recovery_shares')
        .all() as ShareRow[]);
}

/**
 * Of these recovery_shares rows (as stored, from any database), how many are wrapped and how many of those the keys in
 * this data folder do not open (all of them when there is no key file). For a restore, which asks it of the database it
 * just put in place, so the operator hears at the restore, not at a member's recovery, what will not open.
 */
export function countUnopenable(
    rows: Pick<ShareRow, 'owner_pubkey' | 'holder_type' | 'encrypted_share' | 'share_iv' | 'share_tag' | 'kdf_params'>[],
    opts: { retired?: boolean } = {},
): { wrapped: number; unopenable: number } {
    let wrapped = 0, unopenable = 0;
    for (const r of rows) {
        if (!isNodeWrapped(r.kdf_params)) continue;
        wrapped++;
        try {
            openRecoveryFieldsUnder({ encryptedShare: r.encrypted_share, shareIv: r.share_iv, shareTag: r.share_tag, kdfParams: r.kdf_params },
                shareRowAad(r.owner_pubkey, r.holder_type), opts.retired !== false);
        } catch { unopenable++; }
    }
    return { wrapped, unopenable };
}

let installedAs: 'main' | 'standby' | null = null;

/**
 * At boot: a main server makes its key if it has none and wraps what is not wrapped yet; a standby does neither. Called
 * from initStateEngine and again once the role is final (index.ts, after a take-over step 2.6 may have changed it);
 * does nothing when nothing changed. Never throws: a failure is logged, the server runs, and the next boot tries again.
 */
export function installRecoverySealAtBoot(opts: { standby: boolean }): void {
    const as = opts.standby ? 'standby' : 'main';
    if (installedAs === as) return;
    installedAs = as;
    try {
        if (opts.standby) {
            console.log(`🔐 Recovery seal: a standby holds no key of its own. A take-over brings its main server's data/${RECOVERY_SEAL_KEY_FILE} `
                + 'inside the locked keys, when they carry it, so the promoted server opens the sign-in recovery copies it inherited.');
            clearCopiesDroppedBeforeSeal({ ...opts, boot: true });
            return;
        }
        if (ensureRecoverySealKey().created) console.log(`🔐 Recovery seal: made data/${RECOVERY_SEAL_KEY_FILE}.`);
        const moved = wrapRecoveryRows();
        if (moved.shares || moved.releases) {
            console.log(`🔐 Recovery seal: wrapped ${moved.shares} recovery cop${moved.shares === 1 ? 'y' : 'ies'} and ${moved.releases} released cop${moved.releases === 1 ? 'y' : 'ies'} stored before it.`);
        }
        const relocked = rewrapRowsFromRetiredKeys();
        if (relocked.shares || relocked.releases) {
            console.log(`🔐 Recovery seal: locked ${relocked.shares} recovery cop${relocked.shares === 1 ? 'y' : 'ies'} and ${relocked.releases} released `
                + `cop${relocked.releases === 1 ? 'y' : 'ies'} again with data/${RECOVERY_SEAL_KEY_FILE}: only a key it replaced opened them `
                + '(kept as data/recovery-seal-retired-….key).');
        }
        const { wrapped, unopenable } = countWrapped();
        console.log(`🔐 Recovery seal: ${wrapped} recovery cop${wrapped === 1 ? 'y' : 'ies'}, key present.`);
        if (unopenable) {
            console.warn(`⚠️ Recovery seal: ${unopenable} of them were locked with another recovery-seal key and cannot be opened `
                + 'here. Those members\' 12 words still work; connecting their sign-in again makes a new copy.');
        }
        clearCopiesDroppedBeforeSeal({ ...opts, boot: true });
    } catch (e) {
        installedAs = null;
        console.warn(`⚠️ Recovery seal: ${(e as Error)?.message || e} The server runs; the next boot tries again.`);
    }
}

// ── the rollback command ──────────────────────────────────────────────────────────────────────────

const invokedDirectly = !!process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (invokedDirectly) {
    if (!process.argv.includes('--unwrap-recovery-rows')) {
        console.error('Usage: recovery-seal-key --unwrap-recovery-rows   (with the server stopped; BEANPOOL_DATA_DIR = its data folder)');
        process.exit(2);
    }
    try {
        const done = unwrapRecoveryRows();
        console.log(`Unwrapped ${done.shares} recovery cop${done.shares === 1 ? 'y' : 'ies'} and ${done.releases} released cop${done.releases === 1 ? 'y' : 'ies'}. `
            + 'An older server can serve them now; start it before this one, which would wrap them again at boot.');
        process.exit(0);
    } catch (e) {
        console.error(`Nothing was changed: ${(e as Error)?.message || e}`);
        process.exit(1);
    }
}
