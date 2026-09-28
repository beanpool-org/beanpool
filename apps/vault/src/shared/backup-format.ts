/**
 * A backup file (key vault design §4). The keyholder seals it and opens it; the API only moves it and reads its
 * header (to find a backup's state when restoring into a fresh vault).
 *
 *   "BVBK"
 *   u32 BE  header length, then the header: JSON {v, vaultId, name, createdAt, generation, state}
 *   u32 BE  deletions length, then 24-byte nonce ‖ XChaCha20-Poly1305 ciphertext of the deletion records
 *   24-byte nonce ‖ XChaCha20-Poly1305 ciphertext of the database snapshot (to 64 bytes from the end)
 *   64 bytes Ed25519 signature by the ticket key over "beanpool-vault-backup/1\n" ‖ SHA-512(everything before it)
 *
 * - `state` is the vault's state file as it was: the working keys sealed under `M`. So a backup opens only with `M`,
 *   i.e. with two custodians, and a fresh vault can take a backup with nothing else.
 * - The snapshot is sealed under a key from `K_backup`, which a reshare replaces: a backup made after a reshare
 *   doesn't open with the old shares.
 * - The deletion records (§1.7) are sealed under a key from `K_index`, which a reshare keeps. So a vault restored from
 *   an older backup reads every newer backup's deletions and drops those copies again, across a reshare too. They are
 *   HMACs and days only: someone who can read them learns nothing a `K_index` holder couldn't test anyway.
 * - Both ciphertexts take the header as associated data, so a header can't be moved onto another backup's contents.
 */

import type { VaultStateFile } from '../keyholder/keys.js';

export const BACKUP_MAGIC = Buffer.from('BVBK');
export const BACKUP_SIG_TAG = 'beanpool-vault-backup/1\n';
export const BACKUP_DELETIONS_AAD = 'beanpool-vault-backup-deletions/1';
export const BACKUP_BODY_AAD = 'beanpool-vault-backup-body/1';

export interface BackupHeader {
    v: 1;
    vaultId: string;
    name: string;
    createdAt: number;
    generation: number;
    state: VaultStateFile;
}

export interface ParsedBackup {
    header: BackupHeader;
    headerBytes: Buffer;
    deletions: { nonce: Buffer; ct: Buffer };
    body: { nonce: Buffer; ct: Buffer };
    signed: Buffer;
    signature: Buffer;
}

export const BACKUP_NAME_RE = /^bv-\d{8}T\d{6}Z(?:-\d+)?\.bin$/;

/** `bv-YYYYMMDDTHHMMSSZ.bin`: names sort in time order, which is how "newer" is decided. */
export function backupNameFor(ms: number): string {
    return `bv-${new Date(ms).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '')}.bin`;
}

/** When a backup name says it was made, or NaN. */
export function backupTimeOf(name: string): number {
    const m = /^bv-(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z/.exec(name);
    return m ? Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]) : NaN;
}

/**
 * Backup names in the order they were made: by time, then by the `-N` a second backup in the same second gets. Plain
 * string order would put `…Z-1.bin` before `…Z.bin`, since '-' sorts before '.'.
 */
export function compareBackupNames(a: string, b: string): number {
    const seq = (n: string) => Number(/-(\d+)\.bin$/.exec(n)?.[1] ?? 0);
    return (backupTimeOf(a) - backupTimeOf(b)) || (seq(a) - seq(b));
}

export function parseBackupFile(file: Uint8Array): ParsedBackup {
    const b = Buffer.from(file.buffer, file.byteOffset, file.byteLength);
    const fail = (why: string): never => {
        throw new Error(`Not a vault backup: ${why}.`);
    };
    if (b.length < 4 + 4 + 4 + 24 + 16 + 24 + 16 + 64) fail('too short');
    if (!b.subarray(0, 4).equals(BACKUP_MAGIC)) fail('wrong magic');
    const headerLength = b.readUInt32BE(4);
    let at = 8;
    if (headerLength > 64 * 1024 || at + headerLength + 4 > b.length) fail('header length');
    const headerBytes = b.subarray(at, at + headerLength);
    at += headerLength;
    const delLength = b.readUInt32BE(at);
    at += 4;
    if (delLength < 24 + 16 || at + delLength + 24 + 16 + 64 > b.length) fail('deletions length');
    const deletions = { nonce: b.subarray(at, at + 24), ct: b.subarray(at + 24, at + delLength) };
    at += delLength;
    const bodyEnd = b.length - 64;
    const body = { nonce: b.subarray(at, at + 24), ct: b.subarray(at + 24, bodyEnd) };
    let header: BackupHeader;
    try {
        header = JSON.parse(headerBytes.toString('utf8')) as BackupHeader;
    } catch {
        return fail('header is not JSON');
    }
    if (!header || header.v !== 1 || typeof header.vaultId !== 'string' || typeof header.name !== 'string'
        || !Number.isSafeInteger(header.createdAt) || !Number.isSafeInteger(header.generation) || !header.state) {
        fail('header fields');
    }
    return { header, headerBytes, deletions, body, signed: b.subarray(0, bodyEnd), signature: b.subarray(bodyEnd) };
}
