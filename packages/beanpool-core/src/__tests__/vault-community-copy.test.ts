/**
 * The shared placement's wire and its two halves (vault rethink VR4, DESIGN-vault-rethink-fable.md §4.3): a community copy's
 * key split so that neither keeper can open it, the vault's deposit and release of the new kind, and the community's voucher.
 * The vault's own side is apps/vault/src/__tests__/community-copy.test.ts.
 */
import { describe, expect, it } from 'vitest';
import { ed25519, x25519 } from '@noble/curves/ed25519.js';
import { bytesToHex, randomBytes } from '@noble/hashes/utils.js';
import {
    communityHalfForRelease,
    communityHalfFromRelease,
    isCopyKeyHalf,
    joinCopyKeyHalves,
    KeeperCryptoError,
    openReleaseOnDevice,
    openSeedWithCopyKey,
    sealReleaseToDevice,
    sealSeedToCopyKey,
    sealSeedToSso,
    splitCopyKey,
} from '../keeper-crypto.js';
import {
    checkVaultVoucher,
    isVaultCommunityCopy,
    isVaultClientCopy,
    isVaultCommunityRef,
    joinVaultVoucher,
    openVaultDepositBox,
    openVaultRelease,
    parseVaultVoucher,
    sealVaultDepositBox,
    sealVaultRelease,
    vaultB64,
    vaultCommunityRef,
    vaultCopyDigest,
    vaultVoucherHoldId,
    vaultVoucherToSign,
    VAULT_COMMUNITY_PROVIDER,
    VAULT_VOUCHER_TTL_MS,
    type VaultVoucher,
} from '../vault-wire.js';

const SEED = new Uint8Array(32).fill(7);
const PUB = bytesToHex(ed25519.getPublicKey(SEED));
const NODE_SEED = new Uint8Array(32).fill(9);
const NODE_KEY = bytesToHex(ed25519.getPublicKey(NODE_SEED));
const DEPOSIT_SECRET = new Uint8Array(32).fill(3);
const DEPOSIT_KEY = vaultB64(x25519.getPublicKey(DEPOSIT_SECRET));
const PHONE_SEED = new Uint8Array(32).fill(5);
const PHONE = bytesToHex(ed25519.getPublicKey(PHONE_SEED));

function sign(v: VaultVoucher, seed = NODE_SEED): string {
    const { payloadB64, bytes } = vaultVoucherToSign(v);
    return joinVaultVoucher(payloadB64, ed25519.sign(bytes, seed));
}

describe('the two halves of a copy\'s key', () => {
    it('together open the copy; either alone, with the copy in hand, opens nothing', () => {
        const made = sealSeedToCopyKey(SEED);
        const { vaultHalf, nodeHalf } = splitCopyKey(made.copyKey);
        expect(isCopyKeyHalf(vaultHalf) && isCopyKeyHalf(nodeHalf)).toBe(true);
        expect(() => openSeedWithCopyKey(made.copy, vaultHalf, PUB)).toThrow(KeeperCryptoError);
        expect(() => openSeedWithCopyKey(made.copy, nodeHalf, PUB)).toThrow(KeeperCryptoError);
        const joined = joinCopyKeyHalves(vaultHalf, nodeHalf);
        expect(joined).toBe(made.copyKey);
        expect(Buffer.from(openSeedWithCopyKey(made.copy, joined, PUB).seed).equals(Buffer.from(SEED))).toBe(true);
        // In either order: there is no first half.
        expect(joinCopyKeyHalves(nodeHalf, vaultHalf)).toBe(made.copyKey);
    });

    it('a half says nothing of the key: each split is fresh, and neither half is the key', () => {
        const made = sealSeedToCopyKey(SEED);
        const a = splitCopyKey(made.copyKey);
        const b = splitCopyKey(made.copyKey);
        expect(a.vaultHalf).not.toBe(b.vaultHalf);
        expect(a.nodeHalf).not.toBe(b.nodeHalf);
        expect(a.vaultHalf).not.toBe(made.copyKey);
        expect(a.nodeHalf).not.toBe(made.copyKey);
    });

    it('halves from two splits of one key do not join to it, and only 32-byte halves join', () => {
        const made = sealSeedToCopyKey(SEED);
        const a = splitCopyKey(made.copyKey);
        const b = splitCopyKey(made.copyKey);
        expect(joinCopyKeyHalves(a.vaultHalf, b.nodeHalf)).not.toBe(made.copyKey);
        expect(() => joinCopyKeyHalves(a.vaultHalf, 'short')).toThrow(KeeperCryptoError);
        expect(() => splitCopyKey(Buffer.from(new Uint8Array(16)).toString('base64'))).toThrow(KeeperCryptoError);
    });

    it('a half rides to the phone sealed to its key and that code, as a released copy of its own kind', () => {
        const binding = { collectionId: 'BB-AAAA-BBBB', holderType: 'community-half' };
        const { nodeHalf } = splitCopyKey(sealSeedToCopyKey(SEED).copyKey);
        const released = sealReleaseToDevice(communityHalfForRelease({ half: nodeHalf, copy: 'digest' }), PHONE, binding);
        expect(communityHalfFromRelease(openReleaseOnDevice(released, PHONE_SEED, binding))).toEqual({ half: nodeHalf, copy: 'digest' });
        expect(() => openReleaseOnDevice(released, NODE_SEED, binding)).toThrow(KeeperCryptoError);
        expect(() => openReleaseOnDevice(released, PHONE_SEED, { ...binding, holderType: 'community' })).toThrow(KeeperCryptoError);
        expect(() => communityHalfFromRelease({ encryptedShare: nodeHalf, shareIv: '', shareTag: '', kdfParams: null })).toThrow(KeeperCryptoError);
    });
});

describe('a community copy at the vault', () => {
    const made = sealSeedToCopyKey(SEED);
    const { vaultHalf } = splitCopyKey(made.copyKey);
    const ref = vaultCommunityRef(SEED, NODE_KEY);
    const community = { nodeKey: NODE_KEY, half: vaultHalf, ref };

    it('deposits under its own kind, the node key and the half inside the box', () => {
        const box = sealVaultDepositBox({ clientCopy: made.copy, community }, DEPOSIT_KEY, PUB, VAULT_COMMUNITY_PROVIDER);
        expect(JSON.stringify(box)).not.toContain(NODE_KEY);
        expect(JSON.stringify(box)).not.toContain(vaultHalf);
        expect(openVaultDepositBox(box, DEPOSIT_SECRET, PUB, VAULT_COMMUNITY_PROVIDER)).toEqual({ clientCopy: made.copy, community });
        // A box says which kind it is: this one is no Google deposit, and no other member's.
        expect(() => openVaultDepositBox(box, DEPOSIT_SECRET, PUB, 'google')).toThrow();
        expect(() => openVaultDepositBox(box, DEPOSIT_SECRET, NODE_KEY, VAULT_COMMUNITY_PROVIDER)).toThrow();
    });

    it('one kind\'s fields are never the other\'s', async () => {
        const signIn = await sealSeedToSso(SEED, 'google', 'sub-1');
        expect(isVaultClientCopy(made.copy)).toBe(false);
        expect(isVaultCommunityCopy(signIn)).toBe(false);
        // A sign-in copy can't go in as a community copy, nor a community copy as a sign-in's.
        expect(() => sealVaultDepositBox({ clientCopy: signIn, community }, DEPOSIT_KEY, PUB, VAULT_COMMUNITY_PROVIDER)).toThrow();
        expect(() => sealVaultDepositBox({ clientCopy: made.copy }, DEPOSIT_KEY, PUB, 'google')).toThrow();
        // Nor is a half kept with a sign-in's copy, or a community copy without one.
        expect(() => sealVaultDepositBox({ clientCopy: signIn, community }, DEPOSIT_KEY, PUB, 'google')).toThrow();
        expect(() => sealVaultDepositBox({ clientCopy: made.copy }, DEPOSIT_KEY, PUB, VAULT_COMMUNITY_PROVIDER)).toThrow();
    });

    it('is released with the vault\'s half, sealed to the restoring key', () => {
        const box = sealVaultRelease({ provider: VAULT_COMMUNITY_PROVIDER, pubkey: PUB, clientCopy: made.copy, half: vaultHalf }, PHONE);
        expect(openVaultRelease(box, PHONE_SEED)).toEqual({ provider: VAULT_COMMUNITY_PROVIDER, pubkey: PUB, clientCopy: made.copy, half: vaultHalf });
        expect(() => openVaultRelease(box, NODE_SEED)).toThrow();
        const noHalf = sealVaultRelease({ provider: VAULT_COMMUNITY_PROVIDER, pubkey: PUB, clientCopy: made.copy }, PHONE);
        expect(() => openVaultRelease(noHalf, PHONE_SEED)).toThrow();
    });

    it('goes by a label only the member\'s own seed makes: fixed for them, different for anyone else', () => {
        expect(isVaultCommunityRef(ref)).toBe(true);
        expect(vaultCommunityRef(SEED, NODE_KEY)).toBe(ref);
        expect(vaultCommunityRef(NODE_SEED, NODE_KEY)).not.toBe(ref);
        expect(vaultCommunityRef(SEED, PHONE)).not.toBe(ref);
        expect(isVaultCommunityRef('too-short')).toBe(false);
    });
});

describe('the community\'s voucher', () => {
    const NOW = 1_790_000_000_000;
    const digest = vaultCopyDigest(sealSeedToCopyKey(SEED).copy);
    const voucher = (over: Partial<VaultVoucher> = {}): VaultVoucher => ({ v: 1, community: NODE_KEY, member: PUB, phone: PHONE, copy: digest, exp: NOW + 3_600_000, ...over });

    it('names the community, the member, the phone and the copy, and checks for that phone alone', () => {
        const check = checkVaultVoucher(sign(voucher()), { now: NOW, key: PHONE });
        expect(check).toMatchObject({ ok: true, voucher: voucher() });
        expect(checkVaultVoucher(sign(voucher()), { now: NOW, key: PUB })).toEqual({ ok: false, reason: 'wrong_key' });
    });

    it('is refused when signed by any key but the one it names', () => {
        expect(checkVaultVoucher(sign(voucher(), PHONE_SEED), { now: NOW, key: PHONE })).toEqual({ ok: false, reason: 'signature' });
        const other = bytesToHex(ed25519.getPublicKey(randomBytes(32)));
        expect(checkVaultVoucher(sign(voucher({ community: other })), { now: NOW, key: PHONE })).toEqual({ ok: false, reason: 'signature' });
    });

    it('lasts at most a code\'s day', () => {
        expect(checkVaultVoucher(sign(voucher({ exp: NOW })), { now: NOW, key: PHONE })).toEqual({ ok: false, reason: 'expired' });
        expect(checkVaultVoucher(sign(voucher({ exp: NOW + VAULT_VOUCHER_TTL_MS })), { now: NOW, key: PHONE }).ok).toBe(true);
        expect(checkVaultVoucher(sign(voucher({ exp: NOW + 7 * VAULT_VOUCHER_TTL_MS })), { now: NOW, key: PHONE })).toEqual({ ok: false, reason: 'malformed' });
    });

    it('has one spelling, so one voucher is one hold', () => {
        const signed = sign(voucher());
        const parsed = parseVaultVoucher(signed)!;
        expect(parsed.payload).toEqual(voucher());
        const padded = vaultB64(Buffer.from(`${JSON.stringify(voucher())} `));
        expect(parseVaultVoucher(`${padded}.${signed.split('.')[1]}`)).toBeNull();
        expect(vaultVoucherHoldId(parsed.payloadB64)).toBe(vaultVoucherHoldId(parseVaultVoucher(sign(voucher()))!.payloadB64));
        expect(vaultVoucherHoldId(parsed.payloadB64)).not.toBe(vaultVoucherHoldId(parseVaultVoucher(sign(voucher({ exp: NOW + 1 })))!.payloadB64));
    });

    it('refuses what is not one', () => {
        for (const bad of [null, 7, '', 'a.b.c', 'no-dot', `${'a'.repeat(2000)}.b`]) {
            expect(checkVaultVoucher(bad, { now: NOW, key: PHONE })).toEqual({ ok: false, reason: 'malformed' });
        }
    });
});
