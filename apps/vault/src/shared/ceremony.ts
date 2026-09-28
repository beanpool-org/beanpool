import { ed25519 } from '@noble/curves/ed25519.js';
import { sha256, sha512 } from '@noble/hashes/sha2.js';
import { concatBytes, hexToBytes, utf8ToBytes } from '@noble/hashes/utils.js';
import {
    isVaultKeyHex,
    openWithX25519,
    sealToX25519,
    vaultB64,
    vaultUnb64,
    type VaultSealedBox,
} from '@beanpool/core';

/**
 * What custodians and the keyholder exchange (key vault design §2, host design §5.1): the unlock hello and its
 * binding, a share sealed to one custodian's key, a share sent back sealed to this boot's hello key, and the
 * statements a custodian signs. The keyholder checks every one of these itself: vault-api only carries them, so an
 * API changed by a release (which needs no ceremony, design §3) still can't present a share, start a genesis or
 * swap in another vault's state.
 *
 * Keys: a custodian has one Ed25519 key (hex), which signs and, as an X25519 point, receives its shares.
 */

// ─── The hello and its binding ─────────────────────────────────────────────────────────────

export const UNLOCK_BIND_LABEL = 'beanpool-vault-unlock-v1';

/**
 * `bind = SHA-512("beanpool-vault-unlock-v1" ‖ helloPub ‖ bootId ‖ custodianNonce)` over the raw bytes (host design
 * §5.1 item 1). 64 bytes: exactly SEV-SNP's REPORT_DATA and TDX's REPORTDATA, so a later attestor puts it in the
 * signed report and the custodian's tool knows the report was made for its own hello, at this boot, for this key.
 */
export function unlockBind(helloPub: Uint8Array, bootId: Uint8Array, custodianNonce: Uint8Array): Uint8Array {
    return sha512(concatBytes(utf8ToBytes(UNLOCK_BIND_LABEL), helloPub, bootId, custodianNonce));
}

export type AttestationPlatform = 'none' | 'tdx' | 'sev-snp';

/** `/v1/unlock/hello`'s answer. Binary fields are base64url. */
export interface UnlockHello {
    bootId: string;
    helloPub: string;
    releaseHash: string;
    platform: AttestationPlatform;
    evidence: string | null;
}

// ─── A share sealed to its custodian (vault → custodian) ────────────────────────────────────

export const CUSTODIAN_SHARE_TAG = 'beanpool-vault-custodian-share/1';

/** One custodian's share as genesis and reshare hand it out: readable only with that custodian's key. */
export interface CustodianShare {
    v: 1;
    vaultId: string;
    generation: number;
    custodian: string;
    /** 1, 2 or 3: which of the three shares this is. */
    index: number;
    box: VaultSealedBox;
}

function custodianShareAad(vaultId: string, generation: number, custodian: string, index: number): Uint8Array {
    return utf8ToBytes(`${CUSTODIAN_SHARE_TAG}\n${vaultId}\n${generation}\n${custodian}\n${index}`);
}

/** The X25519 point of a custodian's (or any) hex Ed25519 key. */
export function montgomeryOf(keyHex: string): Uint8Array {
    if (!isVaultKeyHex(keyHex)) throw new Error('Not a 64-character hex Ed25519 key.');
    return ed25519.utils.toMontgomery(hexToBytes(keyHex));
}

export function sealCustodianShare(mnemonic: string, custodian: string, vaultId: string, generation: number, index: number): CustodianShare {
    const box = sealToX25519(montgomeryOf(custodian), utf8ToBytes(mnemonic), CUSTODIAN_SHARE_TAG,
        custodianShareAad(vaultId, generation, custodian, index));
    return { v: 1, vaultId, generation, custodian, index, box };
}

/** The custodian's side: the share's words, with their 32-byte Ed25519 seed. */
export function openCustodianShare(share: CustodianShare, custodianSeed: Uint8Array): string {
    const secret = ed25519.utils.toMontgomerySecret(custodianSeed);
    try {
        const plain = openWithX25519(secret, share.box, CUSTODIAN_SHARE_TAG,
            custodianShareAad(share.vaultId, share.generation, share.custodian, share.index), 4096);
        return new TextDecoder().decode(plain);
    } finally {
        secret.fill(0);
    }
}

// ─── Proof that a new share arrived (custodian → vault) ─────────────────────────────────────

/**
 * A genesis or a reshare makes new shares, but the vault switches to them only once two of their custodians have
 * shown they hold theirs (key vault design §2.1, §2.4): until then every unlock uses the shares that already exist.
 * A custodian shows it by opening their share and signing a hash of its words. The hash gives nothing away: a share's
 * value is 256 random bits.
 */
export const SHARE_CHECK_TAG = 'beanpool-vault-share-check/1';
export const CONFIRM_TAG = 'beanpool-vault-confirm/1';
export const CANCEL_TAG = 'beanpool-vault-cancel/1';

/** base64url(SHA-256(tag ‖ vaultId ‖ generation ‖ index ‖ words)): one share, at its place in one split. */
export function shareCheck(words: string, vaultId: string, generation: number, index: number): string {
    return vaultB64(sha256(utf8ToBytes(`${SHARE_CHECK_TAG}\n${vaultId}\n${generation}\n${index}\n${words}`)));
}

export interface ShareConfirmation {
    custodian: string;
    vaultId: string;
    generation: number;
    index: number;
    shareCheck: string;
    sig: string;
}

export function confirmStatement(c: Omit<ShareConfirmation, 'sig'>): Uint8Array {
    return utf8ToBytes(`${CONFIRM_TAG}\n${c.vaultId}\n${c.generation}\n${c.custodian}\n${c.index}\n${c.shareCheck}`);
}

/** The custodian's side: open the share (so it is known to have arrived whole) and sign its check. */
export function buildConfirmation(share: CustodianShare, custodianSeed: Uint8Array): ShareConfirmation {
    const words = openCustodianShare(share, custodianSeed);
    const body = {
        custodian: share.custodian, vaultId: share.vaultId, generation: share.generation, index: share.index,
        shareCheck: shareCheck(words, share.vaultId, share.generation, share.index),
    };
    return { ...body, sig: signStatement(custodianSeed, confirmStatement(body)) };
}

/** Two current custodians drop a genesis or reshare nobody finished. `pendingId` names that one, so a signature can't drop a later one. */
export function cancelStatement(pendingId: string): Uint8Array {
    return utf8ToBytes(`${CANCEL_TAG}\n${pendingId}`);
}

// ─── A share presented to the keyholder (custodian → vault) ─────────────────────────────────

export const SHARE_TAG = 'beanpool-vault-share/1';
export type SharePurpose = 'unlock' | 'reshare';

/**
 * A share on its way in: sealed to this boot's hello key and signed by the custodian. `proposal` is '-' for an
 * unlock and the hash of the new custodian list for a reshare, so two custodians can only reshare to the same list.
 */
export interface ShareSubmission {
    purpose: SharePurpose;
    custodian: string;
    proposal: string;
    /** A reshare's new custodians, whose hash is `proposal`. */
    newCustodians?: string[];
    box: VaultSealedBox;
    sig: string;
}

export function shareAad(purpose: SharePurpose, bootId: string, custodian: string, proposal: string): Uint8Array {
    return utf8ToBytes(`${SHARE_TAG}\n${purpose}\n${bootId}\n${custodian}\n${proposal}`);
}

export function shareStatement(purpose: SharePurpose, bootId: string, helloPub: string, proposal: string, box: VaultSealedBox): Uint8Array {
    return utf8ToBytes(`${SHARE_TAG}\n${purpose}\n${bootId}\n${helloPub}\n${proposal}\n${box.epk}\n${box.n}\n${box.ct}`);
}

export function buildShareSubmission(args: {
    mnemonic: string;
    purpose: SharePurpose;
    hello: Pick<UnlockHello, 'bootId' | 'helloPub'>;
    custodianSeed: Uint8Array;
    /** For a reshare: who receives the new shares. */
    newCustodians?: string[];
}): ShareSubmission {
    const helloPub = vaultUnb64(args.hello.helloPub, 32);
    if (!helloPub || helloPub.length !== 32) throw new Error('The hello has no 32-byte key.');
    const custodian = Buffer.from(ed25519.getPublicKey(args.custodianSeed)).toString('hex');
    const proposal = args.newCustodians ? proposalHash({ custodians: args.newCustodians }) : '-';
    const box = sealToX25519(helloPub, utf8ToBytes(args.mnemonic), SHARE_TAG, shareAad(args.purpose, args.hello.bootId, custodian, proposal));
    const sig = signStatement(args.custodianSeed, shareStatement(args.purpose, args.hello.bootId, args.hello.helloPub, proposal, box));
    return {
        purpose: args.purpose, custodian, proposal, box, sig,
        ...(args.newCustodians ? { newCustodians: [...args.newCustodians] } : {}),
    };
}

// ─── Reshare proposals and signed statements ────────────────────────────────────────────────

/** What a reshare hands the new shares to. */
export interface ReshareProposal {
    custodians: string[];
}

export function proposalHash(p: ReshareProposal): string {
    return vaultB64(sha256(utf8ToBytes(JSON.stringify({ custodians: p.custodians }))));
}

export const GENESIS_TAG = 'beanpool-vault-genesis/1';
export const RESTORE_TAG = 'beanpool-vault-restore/1';

/** A genesis is asked for by one pinned custodian, for this boot. */
export function genesisStatement(bootId: string, helloPub: string): Uint8Array {
    return utf8ToBytes(`${GENESIS_TAG}\n${bootId}\n${helloPub}`);
}

/**
 * A fresh vault takes a backup's state only when a custodian names the backup, for this boot. The keyholder keeps the
 * name and the state it was given, and after the unlock opens only that backup, with exactly that state in its signed
 * header: so the API can't swap in another backup between the custodian's word and the restore.
 */
export function restoreStatement(bootId: string, helloPub: string, backupName: string): Uint8Array {
    return utf8ToBytes(`${RESTORE_TAG}\n${bootId}\n${helloPub}\n${backupName}`);
}

/** base64url(SHA-256(text)), for naming a state file in a statement. */
export function textHash(text: string): string {
    return vaultB64(sha256(utf8ToBytes(text)));
}

export function signStatement(seed: Uint8Array, bytes: Uint8Array): string {
    return vaultB64(ed25519.sign(bytes, seed));
}

/** RFC 8032 verification (not ZIP-215): one signature per statement. */
export function verifyStatement(keyHex: string, bytes: Uint8Array, sig: unknown): boolean {
    const s = vaultUnb64(sig, 64);
    if (!isVaultKeyHex(keyHex) || !s || s.length !== 64) return false;
    try {
        return ed25519.verify(s, bytes, hexToBytes(keyHex), { zip215: false });
    } catch {
        return false;
    }
}
