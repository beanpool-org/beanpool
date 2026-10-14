import { describe, it, expect } from 'vitest';
import { ed25519 } from '@noble/curves/ed25519.js';
import { randomBytes } from '@noble/hashes/utils.js';
import {
    KEEPER_ALG_RELEASE,
    KeeperCryptoError,
    isSealedToDevice,
    openListedFragment,
    openReleaseOnDevice,
    openSeedFromSso,
    recordShareForHub,
    sealReleaseToDevice,
    sealSeedToSso,
    type ReleasedCopy,
} from '../keeper-crypto.js';
import { toEd25519Pkcs8 } from '../ed25519-key.js';

/**
 * A released copy sealed to the recovering device's throwaway key (FABLE-sec-sso finding 2): the node seals, both
 * apps open. A copy in transit or in a log is nothing without that key's private half.
 */

/** A throwaway key as each app holds it: the phone's raw seed, the web's PKCS8, both hex. */
function throwaway(): { seedHex: string; pkcs8Hex: string; pub: string } {
    const seed = randomBytes(32);
    return {
        seedHex: Buffer.from(seed).toString('hex'),
        pkcs8Hex: Buffer.from(toEd25519Pkcs8(seed)).toString('hex'),
        pub: Buffer.from(ed25519.getPublicKey(seed)).toString('hex'),
    };
}

const SUB = '110169484474386276334';
const binding = { collectionId: 'col-abc', holderType: 'sso' };

async function signInCopy(): Promise<{ seed: Uint8Array; copy: ReleasedCopy }> {
    const seed = randomBytes(32);
    const sealed = await sealSeedToSso(seed, 'google', SUB);
    return { seed, copy: { encryptedShare: sealed.encryptedShare, shareIv: sealed.shareIv, shareTag: sealed.shareTag, kdfParams: sealed.kdfParams } };
}

function listed(sealed: ReturnType<typeof sealReleaseToDevice>, holderType = 'sso') {
    return {
        holderType,
        shareIndex: 1,
        payload: sealed.encryptedShare,
        payloadIv: sealed.shareIv,
        payloadTag: sealed.shareTag,
        ephemeralPubkey: sealed.ephemeralPubkey ?? null,
        kdfParams: sealed.kdfParams,
    };
}

describe('a released copy sealed to the recovering device', () => {
    it('opens with the throwaway key, held either way, to exactly the copy the client deposited', async () => {
        const device = throwaway();
        const { copy } = await signInCopy();
        const sealed = sealReleaseToDevice(copy, device.pub, binding);
        expect(JSON.parse(sealed.kdfParams)).toEqual({ alg: KEEPER_ALG_RELEASE });
        expect(isSealedToDevice(sealed.kdfParams)).toBe(true);
        // None of the copy's bytes are on the wire as they were.
        for (const field of [copy.encryptedShare, copy.shareIv, copy.shareTag, copy.kdfParams!]) {
            expect(JSON.stringify(sealed)).not.toContain(field);
        }
        expect(openReleaseOnDevice(sealed, device.seedHex, binding)).toEqual(copy);
        expect(openReleaseOnDevice(sealed, device.pkcs8Hex, binding)).toEqual(copy);
    });

    it('is nothing to anyone else: another key, another session, another keeper type, or one bit changed', async () => {
        const device = throwaway();
        const other = throwaway();
        const { copy } = await signInCopy();
        const sealed = sealReleaseToDevice(copy, device.pub, binding);
        expect(() => openReleaseOnDevice(sealed, other.seedHex, binding)).toThrow(KeeperCryptoError);
        expect(() => openReleaseOnDevice(sealed, device.seedHex, { ...binding, collectionId: 'col-other' })).toThrow(KeeperCryptoError);
        expect(() => openReleaseOnDevice(sealed, device.seedHex, { ...binding, holderType: 'hub' })).toThrow(KeeperCryptoError);
        const flipped = Buffer.from(sealed.encryptedShare, 'base64');
        flipped[0] ^= 1;
        expect(() => openReleaseOnDevice({ ...sealed, encryptedShare: flipped.toString('base64') }, device.seedHex, binding))
            .toThrow(KeeperCryptoError);
        expect(() => openReleaseOnDevice({ ...sealed, ephemeralPubkey: undefined }, device.seedHex, binding)).toThrow(KeeperCryptoError);
    });

    it('refuses a device key that is not one, before sealing anything', async () => {
        const { copy } = await signInCopy();
        expect(() => sealReleaseToDevice(copy, 'abcd', binding)).toThrow(KeeperCryptoError);
        expect(() => sealReleaseToDevice(copy, throwaway().pub, { collectionId: '', holderType: 'sso' })).toThrow(KeeperCryptoError);
    });

    it('the restore both apps run: a listed copy opens with the key, then with the sign-in, to the seed', async () => {
        const device = throwaway();
        const { seed, copy } = await signInCopy();
        const onTheWire = listed(sealReleaseToDevice(copy, device.pub, binding));
        const asDeposited = openListedFragment(onTheWire, device.pkcs8Hex, binding.collectionId);
        expect(asDeposited).toMatchObject({ holderType: 'sso', shareIndex: 1, payload: copy.encryptedShare, payloadIv: copy.shareIv,
            payloadTag: copy.shareTag, kdfParams: copy.kdfParams, ephemeralPubkey: null });
        const opened = await openSeedFromSso({ encryptedShare: asDeposited.payload, shareIv: asDeposited.payloadIv,
            shareTag: asDeposited.payloadTag, kdfParams: asDeposited.kdfParams! }, 'google', SUB);
        expect(Buffer.from(opened.seed).toString('hex')).toBe(Buffer.from(seed).toString('hex'));
        // ...and the listing's own collection id is what binds it.
        expect(() => openListedFragment(onTheWire, device.seedHex, 'col-other')).toThrow(KeeperCryptoError);
    });

    it('a node from before the seal lists the copy as stored, and that is returned untouched', async () => {
        const { copy } = await signInCopy();
        const old = { holderType: 'sso', payload: copy.encryptedShare, payloadIv: copy.shareIv, payloadTag: copy.shareTag,
            ephemeralPubkey: null, kdfParams: copy.kdfParams };
        expect(openListedFragment(old, throwaway().seedHex, 'col-abc')).toBe(old);
    });

    it("carries the hub's copy, and a stored copy with no kdfParams, as they were", () => {
        const device = throwaway();
        const hub = recordShareForHub(randomBytes(32));
        const hubCopy: ReleasedCopy = { encryptedShare: hub.encryptedShare, shareIv: hub.shareIv, shareTag: hub.shareTag, kdfParams: hub.kdfParams };
        const hubBinding = { collectionId: 'col-abc', holderType: 'hub' };
        expect(openReleaseOnDevice(sealReleaseToDevice(hubCopy, device.pub, hubBinding), device.seedHex, hubBinding)).toEqual(hubCopy);
        const bare = { ...hubCopy, kdfParams: null };
        expect(openReleaseOnDevice(sealReleaseToDevice(bare, device.pub, hubBinding), device.seedHex, hubBinding)).toEqual(bare);
    });
});
