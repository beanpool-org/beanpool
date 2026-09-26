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
 * backup (a plain backup is state.db, node_config.json and images: sealed-backup.ts). Carrying it inside the take-over
 * bundle and a sealed backup is S2; until then a server restored from any backup, or promoted from a standby, makes a
 * key of its own and cannot open the copies it inherited: members' 12 words still work, and connecting the sign-in
 * again makes a new copy.
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
 * Bound (AAD) to where the row sits: a stored copy to (owner, holder type, holder ref), never the generation, because a
 * carry-forward writes the same copy into the next generation; a released copy to (collection, share id, holder type),
 * because the share row it came from is deleted by the next re-split while the release stays as history.
 *
 * ## Migration, both ways
 *
 * At boot, once the key exists, every row stored before the wrap (phones since #1150, browsers since #1174, and
 * releases) is wrapped in one transaction: idempotent, logged by count, never blocking the boot. It stamps the rows it
 * wraps, so a standby that already holds the unwrapped copy is sent the wrapped one, and it runs with secure_delete on
 * and truncates the WAL after, so the unwrapped bytes do not linger in the database files.
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
    const key = new Uint8Array(crypto.hkdfSync('sha256', file, Buffer.alloc(0), HKDF_INFO, KEY_BYTES));
    derived = { file, key };
    return key;
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

/**
 * Make the key file if there is none. Written to a temporary file and linked into place, so a crash leaves no half a key
 * and an existing file (a key, or something that is not one) is never overwritten.
 */
export function ensureRecoverySealKey(): { created: boolean } {
    const target = recoverySealKeyPath();
    if (fs.existsSync(target)) return { created: false };
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const tmp = `${target}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
    const fd = fs.openSync(tmp, 'wx', 0o600);
    try {
        fs.writeSync(fd, crypto.randomBytes(KEY_BYTES));
        fs.fsyncSync(fd);
    } finally {
        fs.closeSync(fd);
    }
    try {
        fs.chmodSync(tmp, 0o600);
        fs.linkSync(tmp, target);
        return { created: true };
    } catch (e) {
        if ((e as NodeJS.ErrnoException).code === 'EEXIST') return { created: false };
        throw e;
    } finally {
        fs.rmSync(tmp, { force: true });
    }
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

/** Where a stored copy sits: its owner, holder type and holder ref. */
export function shareRowAad(ownerPubkey: string, holderType: string, holderRef: string): Uint8Array {
    return Buffer.from(JSON.stringify([AAD_ROW, ownerPubkey, holderType, holderRef]), 'utf-8');
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

/**
 * A stored copy's client fields. A row stored before the wrap comes back as it is (the boot migration wraps it); a
 * wrapped one needs the key ({@link RecoverySealKeyMissing}) and must open under it ({@link RecoverySealUnopenable}).
 */
export function openRecoveryFields(stored: RecoverySealFields, aad: Uint8Array): RecoverySealFields {
    if (!isNodeWrapped(stored.kdfParams)) return stored;
    const key = requireKey();
    let plaintext: Uint8Array;
    try {
        const ct = Buffer.from(stored.encryptedShare, 'base64');
        const tag = Buffer.from(stored.shareTag, 'base64');
        const nonce = Buffer.from(stored.shareIv, 'base64');
        if (nonce.length !== NONCE_BYTES || tag.length !== TAG_BYTES) throw new Error('bad shape');
        plaintext = xchacha20poly1305(key, nonce, aad).decrypt(Buffer.concat([ct, tag]));
    } catch {
        throw new RecoverySealUnopenable();
    }
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
function rewriteRows(which: (kdf: string | null) => boolean, map: (f: RecoverySealFields, aad: Uint8Array) => RecoverySealFields):
    { shares: number; releases: number } {
    const shares = (db.prepare(`SELECT id, owner_pubkey, holder_type, holder_ref, encrypted_share, share_iv, share_tag, kdf_params
        FROM recovery_shares`).all() as ShareRow[]).filter(r => which(r.kdf_params));
    const releases = (db.prepare(`SELECT id, collection_id, share_id, holder_type, payload, payload_iv, payload_tag, kdf_params
        FROM recovery_releases`).all() as ReleaseRow[]).filter(r => which(r.kdf_params));
    if (shares.length === 0 && releases.length === 0) return { shares: 0, releases: 0 };

    // Every row mapped before anything is written: a row that cannot be mapped fails the run and changes nothing.
    const newShares = shares.map(r => ({ id: r.id, f: map(shareFields(r), shareRowAad(r.owner_pubkey, r.holder_type, r.holder_ref)) }));
    const newReleases = releases.map(r => ({ id: r.id, f: map(releaseFields(r), releaseRowAad(r.collection_id, r.share_id, r.holder_type)) }));

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
 * The reverse, for a rollback past this change: every wrapped row back to the client's bytes. Refuses (and changes
 * nothing) if any wrapped row does not open with this key, because an older server would then serve it as garbage.
 */
export function unwrapRecoveryRows(): { shares: number; releases: number } {
    requireKey();
    return rewriteRows(kdf => isNodeWrapped(kdf), openRecoveryFields);
}

/** How many stored rows are wrapped, and how many of those this server's key does not open. Needs the key. */
function countWrapped(): { wrapped: number; unopenable: number } {
    const rows = db.prepare('SELECT owner_pubkey, holder_type, holder_ref, encrypted_share, share_iv, share_tag, kdf_params FROM recovery_shares')
        .all() as ShareRow[];
    let wrapped = 0, unopenable = 0;
    for (const r of rows) {
        if (!isNodeWrapped(r.kdf_params)) continue;
        wrapped++;
        try { openRecoveryFields(shareFields(r), shareRowAad(r.owner_pubkey, r.holder_type, r.holder_ref)); }
        catch { unopenable++; }
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
            console.log(`🔐 Recovery seal: a standby holds no key of its own (data/${RECOVERY_SEAL_KEY_FILE} comes with a take-over).`);
            return;
        }
        if (ensureRecoverySealKey().created) console.log(`🔐 Recovery seal: made data/${RECOVERY_SEAL_KEY_FILE}.`);
        const moved = wrapRecoveryRows();
        if (moved.shares || moved.releases) {
            console.log(`🔐 Recovery seal: wrapped ${moved.shares} recovery cop${moved.shares === 1 ? 'y' : 'ies'} and ${moved.releases} released cop${moved.releases === 1 ? 'y' : 'ies'} stored before it.`);
        }
        const { wrapped, unopenable } = countWrapped();
        console.log(`🔐 Recovery seal: ${wrapped} recovery cop${wrapped === 1 ? 'y' : 'ies'}, key present.`);
        if (unopenable) {
            console.warn(`⚠️ Recovery seal: ${unopenable} of them were locked with another recovery-seal key and cannot be opened `
                + 'here. Those members\' 12 words still work; connecting their sign-in again makes a new copy.');
        }
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
