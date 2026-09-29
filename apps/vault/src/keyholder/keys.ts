import crypto from 'node:crypto';
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { xchacha20poly1305 } from '@noble/ciphers/chacha.js';
import { ed25519, x25519 } from '@noble/curves/ed25519.js';
import { isVaultKeyHex, vaultB64, vaultDepositKeyId, vaultUnb64 } from '@beanpool/core';

/**
 * The working keys (`DK`, key vault design §1.1) and the state file that holds them sealed under the master secret
 * `M`. The keyholder is the only reader of either.
 *
 * `DK` sits under `M` rather than being made from it so that a reshare (design §2.4) can change `M` without every
 * member signing in again: `K_index` can't be recomputed without their `sub`s, so it has to survive a new `M`.
 *
 * On disk, `state.json` in the keyholder's state directory:
 *
 *   {v, vaultId, generation, custodians, threshold, mCheck, dk: {n, ct}}
 *
 * and, while a genesis or a reshare waits for two of its custodians to show they hold their shares, `state.next.json`
 * beside it ({@link PendingStateFile}): the new state, a check of each new share, and who has confirmed. The switch
 * rewrites `state.json` and then removes `state.next.json`; a `state.next.json` equal to `state.json` is a switch that
 * finished.
 *
 * - `mCheck = HMAC-SHA256(M, "beanpool-vault-m-check/1" ‖ vaultId)`: how the keyholder tells a wrong `M` (shares from
 *   another split) from a tampered file.
 * - `dk` is XChaCha20-Poly1305 under `HKDF-SHA256(M, salt = vaultId, info = "beanpool-vault-dk/1")`, with the rest of
 *   the file (`v, vaultId, generation, custodians, threshold`) as associated data. So a custodian list edited on disk
 *   (the list is plain, since shares must be checked against it before `M` exists) makes `DK` refuse to open once `M`
 *   is rebuilt, and the vault stays locked and says why.
 *
 * `DK` itself is binary, so no key ever sits in a JavaScript string (which can't be wiped):
 *
 *   "BVDK" | u8 1 | u32 generation | K_index 32 | K_disk 32 | K_backup 32
 *   | u8 n | n × (u32 wrap version | K_wrap 32)     the first is current; a second is kept while a reshare re-wraps
 *   | u8 n | n × Ed25519 ticket seed 32             the first signs; the apps have room for two (design §1.1)
 *   | u8 n | n × X25519 deposit secret 32           the first is current; boxes name theirs by key id
 */

export const STATE_FILE = 'state.json';
export const PENDING_FILE = 'state.next.json';
const DK_MAGIC = Buffer.from('BVDK');
const DK_INFO = Buffer.from('beanpool-vault-dk/1');
const M_CHECK_LABEL = Buffer.from('beanpool-vault-m-check/1');

export interface VaultStateFile {
    v: 1;
    vaultId: string;
    generation: number;
    custodians: string[];
    threshold: number;
    mCheck: string;
    dk: { n: string; ct: string };
}

/** A fresh 32-byte buffer outside Node's shared pool, so wiping it wipes the only copy. */
function key32(source?: Uint8Array): Buffer {
    const b = Buffer.alloc(32);
    if (source) b.set(source.subarray(0, 32));
    else crypto.randomFillSync(b);
    return b;
}

export interface WrapKey {
    version: number;
    key: Buffer;
}

export class WorkingKeys {
    constructor(
        public generation: number,
        public kIndex: Buffer,
        public kDisk: Buffer,
        public kBackup: Buffer,
        public wrap: WrapKey[],
        public ticketSeeds: Buffer[],
        public depositSecrets: Buffer[],
    ) {}

    static fresh(generation: number): WorkingKeys {
        return new WorkingKeys(generation, key32(), key32(), key32(), [{ version: 1, key: key32() }], [key32()], [key32()]);
    }

    get ticketPublicKeys(): string[] {
        return this.ticketSeeds.map(s => Buffer.from(ed25519.getPublicKey(s)).toString('hex'));
    }

    get depositPublicKeys(): { kid: string; key: string }[] {
        return this.depositSecrets.map(s => {
            const pub = x25519.getPublicKey(s);
            return { kid: vaultDepositKeyId(pub), key: vaultB64(pub) };
        });
    }

    depositSecretFor(kid: unknown): Buffer | null {
        if (kid === undefined) return this.depositSecrets[0];
        return this.depositSecrets.find(s => vaultDepositKeyId(x25519.getPublicKey(s)) === kid) ?? null;
    }

    wrapKey(version: number): Buffer | null {
        return this.wrap.find(w => w.version === version)?.key ?? null;
    }

    encode(): Buffer {
        const parts: Buffer[] = [DK_MAGIC, Buffer.from([1])];
        const gen = Buffer.alloc(4);
        gen.writeUInt32BE(this.generation);
        parts.push(gen, this.kIndex, this.kDisk, this.kBackup, Buffer.from([this.wrap.length]));
        for (const w of this.wrap) {
            const v = Buffer.alloc(4);
            v.writeUInt32BE(w.version);
            parts.push(v, w.key);
        }
        parts.push(Buffer.from([this.ticketSeeds.length]), ...this.ticketSeeds);
        parts.push(Buffer.from([this.depositSecrets.length]), ...this.depositSecrets);
        return Buffer.concat(parts);
    }

    static decode(bytes: Uint8Array): WorkingKeys {
        const b = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        let at = 0;
        const need = (n: number) => {
            if (at + n > b.length) throw new Error('The working keys are cut short.');
        };
        need(9);
        if (!b.subarray(0, 4).equals(DK_MAGIC) || b[4] !== 1) throw new Error('Not a working-keys file this keyholder reads.');
        const generation = b.readUInt32BE(5);
        at = 9;
        const take = () => {
            need(32);
            const k = key32(b.subarray(at, at + 32));
            at += 32;
            return k;
        };
        const kIndex = take();
        const kDisk = take();
        const kBackup = take();
        need(1);
        const nWrap = b[at++];
        const wrap: WrapKey[] = [];
        for (let i = 0; i < nWrap; i++) {
            need(4);
            const version = b.readUInt32BE(at);
            at += 4;
            wrap.push({ version, key: take() });
        }
        need(1);
        const nTicket = b[at++];
        const ticketSeeds = Array.from({ length: nTicket }, take);
        need(1);
        const nDeposit = b[at++];
        const depositSecrets = Array.from({ length: nDeposit }, take);
        if (at !== b.length || !wrap.length || !ticketSeeds.length || !depositSecrets.length) {
            throw new Error('The working keys are not in the expected layout.');
        }
        return new WorkingKeys(generation, kIndex, kDisk, kBackup, wrap, ticketSeeds, depositSecrets);
    }

    wipe(): void {
        for (const b of [this.kIndex, this.kDisk, this.kBackup, ...this.wrap.map(w => w.key), ...this.ticketSeeds, ...this.depositSecrets]) {
            b.fill(0);
        }
        this.wrap = [];
        this.ticketSeeds = [];
        this.depositSecrets = [];
    }
}

// ─── The state file ────────────────────────────────────────────────────────────────────────

function headerText(s: Pick<VaultStateFile, 'v' | 'vaultId' | 'generation' | 'custodians' | 'threshold'>): string {
    return JSON.stringify({ v: s.v, vaultId: s.vaultId, generation: s.generation, custodians: s.custodians, threshold: s.threshold });
}

function vaultIdBytes(vaultId: string): Uint8Array {
    const id = vaultUnb64(vaultId, 16);
    if (!id || id.length !== 16) throw new Error('A vault id is 16 bytes.');
    return id;
}

export function mCheckOf(m: Uint8Array, vaultId: string): string {
    return vaultB64(crypto.createHmac('sha256', m).update(M_CHECK_LABEL).update(vaultIdBytes(vaultId)).digest());
}

function dkSealKey(m: Uint8Array, vaultId: string): Buffer {
    return Buffer.from(crypto.hkdfSync('sha256', m, vaultIdBytes(vaultId), DK_INFO, 32));
}

/** A state file for `keys`, sealed under `m`. */
export function sealState(m: Uint8Array, header: Omit<VaultStateFile, 'mCheck' | 'dk'>, keys: WorkingKeys): VaultStateFile {
    const plain = keys.encode();
    const k = dkSealKey(m, header.vaultId);
    const n = crypto.randomBytes(24);
    try {
        const ct = xchacha20poly1305(k, n, Buffer.from(headerText(header))).encrypt(plain);
        return { ...header, mCheck: mCheckOf(m, header.vaultId), dk: { n: vaultB64(n), ct: vaultB64(ct) } };
    } finally {
        plain.fill(0);
        k.fill(0);
    }
}

export type OpenStateResult = { ok: true; keys: WorkingKeys } | { ok: false; reason: 'wrong_m' | 'tampered_state' };

/** The working keys, if `m` is this vault's master secret and the file is as it was sealed. */
export function openState(m: Uint8Array, state: VaultStateFile): OpenStateResult {
    const expected = Buffer.from(mCheckOf(m, state.vaultId));
    const stored = Buffer.from(state.mCheck);
    if (expected.length !== stored.length || !crypto.timingSafeEqual(expected, stored)) return { ok: false, reason: 'wrong_m' };
    const k = dkSealKey(m, state.vaultId);
    let plain: Uint8Array | null = null;
    try {
        const n = vaultUnb64(state.dk.n, 24);
        const ct = vaultUnb64(state.dk.ct, 4096);
        if (!n || !ct) return { ok: false, reason: 'tampered_state' };
        plain = xchacha20poly1305(k, n, Buffer.from(headerText(state))).decrypt(ct);
        const keys = WorkingKeys.decode(plain);
        if (keys.generation !== state.generation) {
            keys.wipe();
            return { ok: false, reason: 'tampered_state' };
        }
        return { ok: true, keys };
    } catch {
        return { ok: false, reason: 'tampered_state' };
    } finally {
        k.fill(0);
        plain?.fill(0);
    }
}

/** A parsed state file, or null when `value` isn't one. */
export function asStateFile(value: unknown): VaultStateFile | null {
    const s = value as Partial<VaultStateFile> | null;
    if (!s || typeof s !== 'object' || s.v !== 1 || typeof s.vaultId !== 'string' || !vaultUnb64(s.vaultId, 16)
        || !Number.isSafeInteger(s.generation) || (s.generation as number) < 1
        || !Array.isArray(s.custodians) || s.custodians.length < 2 || s.custodians.length > 16
        || !s.custodians.every(isVaultKeyHex) || new Set(s.custodians).size !== s.custodians.length
        || !Number.isSafeInteger(s.threshold) || (s.threshold as number) < 2 || (s.threshold as number) > s.custodians.length
        || typeof s.mCheck !== 'string' || !s.dk || typeof s.dk.n !== 'string' || typeof s.dk.ct !== 'string') {
        return null;
    }
    return {
        v: 1, vaultId: s.vaultId, generation: s.generation as number, custodians: [...s.custodians], threshold: s.threshold as number,
        mCheck: s.mCheck, dk: { n: s.dk.n, ct: s.dk.ct },
    };
}

export function readStateFile(dir: string): VaultStateFile | null {
    const file = path.join(dir, STATE_FILE);
    if (!existsSync(file)) return null;
    const parsed = asStateFile(JSON.parse(readFileSync(file, 'utf8')));
    if (!parsed) throw new Error(`${file} is not a vault state file.`);
    return parsed;
}

/** Written whole or not at all: a temp file, fsync, rename, fsync of the directory. */
function writeJsonFile(dir: string, name: string, value: unknown): void {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const file = path.join(dir, name);
    const tmp = `${file}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(value)}\n`, { mode: 0o600 });
    const fd = openSync(tmp, 'r+');
    try {
        fsyncSync(fd);
    } finally {
        closeSync(fd);
    }
    renameSync(tmp, file);
    syncDir(dir);
}

function syncDir(dir: string): void {
    try {
        const dfd = openSync(dir, 'r');
        try {
            fsyncSync(dfd);
        } finally {
            closeSync(dfd);
        }
    } catch {
        // Some filesystems can't fsync a directory; the rename is still atomic.
    }
}

export function writeStateFile(dir: string, state: VaultStateFile): void {
    writeJsonFile(dir, STATE_FILE, state);
}

// ─── A genesis or reshare waiting for its custodians ───────────────────────────────────────

export type PendingPurpose = 'genesis' | 'reshare';

export interface PendingStateFile {
    v: 1;
    purpose: PendingPurpose;
    /** The state the vault switches to. */
    state: VaultStateFile;
    /** `shareCheck` (shared/ceremony.ts) of each new share, in custodian order. */
    shareChecks: string[];
    /** The new custodians who have shown they hold their share. */
    confirmed: string[];
}

export function readPendingFile(dir: string): PendingStateFile | null {
    const file = path.join(dir, PENDING_FILE);
    if (!existsSync(file)) return null;
    const p = JSON.parse(readFileSync(file, 'utf8')) as Partial<PendingStateFile> | null;
    const state = asStateFile(p?.state);
    if (!p || p.v !== 1 || (p.purpose !== 'genesis' && p.purpose !== 'reshare') || !state
        || !Array.isArray(p.shareChecks) || p.shareChecks.length !== state.custodians.length || !p.shareChecks.every(c => typeof c === 'string')
        || !Array.isArray(p.confirmed) || !p.confirmed.every(c => state.custodians.includes(c))) {
        throw new Error(`${file} is not a pending vault state.`);
    }
    return { v: 1, purpose: p.purpose, state, shareChecks: [...p.shareChecks], confirmed: [...new Set(p.confirmed)] };
}

export function writePendingFile(dir: string, pending: PendingStateFile): void {
    writeJsonFile(dir, PENDING_FILE, pending);
}

export function removePendingFile(dir: string): void {
    rmSync(path.join(dir, PENDING_FILE), { force: true });
    syncDir(dir);
}

/** The same sealed state: the same `M` check and the same sealed `DK`. */
export function sameState(a: VaultStateFile, b: VaultStateFile): boolean {
    return a.vaultId === b.vaultId && a.generation === b.generation && a.mCheck === b.mCheck && a.dk.n === b.dk.n && a.dk.ct === b.dk.ct;
}
