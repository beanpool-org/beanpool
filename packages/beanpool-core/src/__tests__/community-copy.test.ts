/**
 * The community copy (vault rethink VR3): the seed and the 12 words sealed under a random key that travels beside it
 * (sealSeedToCopyKey, openSeedWithCopyKey), and the two packed into one released copy for a bring-back
 * (communityCopyForRelease, communityCopyFromRelease). The sign-in copy's sibling (sso-words.test.ts).
 */
import { describe, it, expect } from 'vitest';
import { ed25519 } from '@noble/curves/ed25519.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js';
import {
    KEEPER_ALG_COPY_KEY,
    KEEPER_ALG_SSO_WORDS,
    KeeperCryptoError,
    communityCopyForRelease,
    communityCopyFromRelease,
    isKeySealedCopy,
    openReleaseOnDevice,
    openSeedFromSso,
    openSeedWithCopyKey,
    sealReleaseToDevice,
    sealSeedToCopyKey,
    sealSeedToSso,
    type SealedShare,
} from '../keeper-crypto.js';

// Test phrases only (a BIP-39 vector and hand-picked words), never a real account's.
const WORDS = 'abandon ability able about above absent absorb abstract absurd abuse access accident'.split(' ');
const OTHER_WORDS = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'.split(' ');

/** The apps' own derivation: seed = SHA256(SHA256(words)). */
const seedOf = (words: string[]): Uint8Array => sha256(sha256(utf8ToBytes(words.join(' '))));
const SEED = seedOf(WORDS);
const PUB = bytesToHex(ed25519.getPublicKey(SEED));
const OTHER_SEED = seedOf(OTHER_WORDS);
const OTHER_PUB = bytesToHex(ed25519.getPublicKey(OTHER_SEED));

function flip(value: string): string {
    const bytes = Buffer.from(value, 'base64');
    bytes[0] ^= 0x01;
    return bytes.toString('base64');
}

/**
 * Written by sealSeedToCopyKey when it was added (VR3), from the vector words above: the shape every community copy has.
 * Opened here so a later change to the format can't strand a copy a server already keeps. The key is a test value.
 */
const FIRST_COPY: { copy: SealedShare; copyKey: string } | null = {
    copy: {
        encryptedShare: 'XcaOQRba6ZJyNGlaVTR+zq8ApNYTYDEA5mz3TVuSL4g=',
        shareIv: 'LRpOWduwBzEYIKxlVAXJceeuMNPRbcNO',
        shareTag: 'DKaIaQVbbKxulO9d9DSiUw==',
        kdfParams: "{\"alg\":\"copykey-xc20p-v1\",\"words\":{\"alg\":\"bip39-bits-xc20p-v1\",\"iv\":\"EbjboWEZLJIbREzrTvJvw3qQdQjAIKj5\",\"ct\":\"/Ac5OmxwHhEc7Bx+umfB4Ok=\",\"tag\":\"+hYziYQuXAopUNjTXUcO/w==\"}}",
    },
    copyKey: 'tFrKoEx+A6pdY7SG2YE5JIvMqK7v9Au09mRmfqprkKk=',
};

describe('the community copy: sealSeedToCopyKey / openSeedWithCopyKey', () => {
    it('round-trips the seed and the 12 words, as the account the copy was made for', () => {
        const made = sealSeedToCopyKey(SEED, { words: WORDS });
        expect(JSON.parse(made.copy.kdfParams).alg).toBe(KEEPER_ALG_COPY_KEY);
        expect(JSON.parse(made.copy.kdfParams).words.alg).toBe(KEEPER_ALG_SSO_WORDS);
        expect(isKeySealedCopy(made.copy.kdfParams)).toBe(true);
        expect(Buffer.from(made.copyKey, 'base64')).toHaveLength(32);
        const back = openSeedWithCopyKey(made.copy, made.copyKey, PUB);
        expect(bytesToHex(back.seed)).toBe(bytesToHex(SEED));
        expect(back.words).toEqual(WORDS);
        expect(back.wordsStatus).toBe('carried');
    });

    it('seals the seed alone when there are no words, and says so', () => {
        const made = sealSeedToCopyKey(SEED);
        expect(JSON.parse(made.copy.kdfParams).words).toBeUndefined();
        const back = openSeedWithCopyKey(made.copy, made.copyKey, PUB);
        expect(bytesToHex(back.seed)).toBe(bytesToHex(SEED));
        expect(back).toMatchObject({ words: null, wordsStatus: 'absent' });
    });

    it('makes a new key and a new box every time', () => {
        const a = sealSeedToCopyKey(SEED, { words: WORDS });
        const b = sealSeedToCopyKey(SEED, { words: WORDS });
        expect(a.copyKey).not.toBe(b.copyKey);
        expect(a.copy.encryptedShare).not.toBe(b.copy.encryptedShare);
        expect(a.copy.shareIv).not.toBe(b.copy.shareIv);
    });

    it('refuses a wrong key', () => {
        const made = sealSeedToCopyKey(SEED, { words: WORDS });
        const other = sealSeedToCopyKey(SEED, { words: WORDS });
        expect(() => openSeedWithCopyKey(made.copy, other.copyKey, PUB)).toThrow(KeeperCryptoError);
        expect(() => openSeedWithCopyKey(made.copy, flip(made.copyKey), PUB)).toThrow(KeeperCryptoError);
        expect(() => openSeedWithCopyKey(made.copy, Buffer.alloc(16).toString('base64'), PUB)).toThrow(/32 bytes/);
    });

    it('refuses a copy opened as another account (the box is bound to the member\'s key)', () => {
        const made = sealSeedToCopyKey(SEED, { words: WORDS });
        expect(() => openSeedWithCopyKey(made.copy, made.copyKey, OTHER_PUB)).toThrow(KeeperCryptoError);
        // Another member's copy and key handed out under this member's name: refused, not opened as theirs.
        const theirs = sealSeedToCopyKey(OTHER_SEED, { words: OTHER_WORDS });
        expect(() => openSeedWithCopyKey(theirs.copy, theirs.copyKey, PUB)).toThrow(KeeperCryptoError);
    });

    it('refuses a tampered copy: the box, its nonce or its tag', () => {
        const made = sealSeedToCopyKey(SEED, { words: WORDS });
        for (const field of ['encryptedShare', 'shareIv', 'shareTag'] as const) {
            const tampered = { ...made.copy, [field]: flip(made.copy[field]) };
            expect(() => openSeedWithCopyKey(tampered, made.copyKey, PUB), field).toThrow(KeeperCryptoError);
        }
    });

    it('a damaged words box costs the words, never the account', () => {
        const made = sealSeedToCopyKey(SEED, { words: WORDS });
        const params = JSON.parse(made.copy.kdfParams);
        params.words.ct = flip(params.words.ct);
        const back = openSeedWithCopyKey({ ...made.copy, kdfParams: JSON.stringify(params) }, made.copyKey, PUB);
        expect(bytesToHex(back.seed)).toBe(bytesToHex(SEED));
        expect(back).toMatchObject({ words: null, wordsStatus: 'unreadable' });
    });

    it('refuses words that are not the seed\'s, or not 12 BIP-39 words, before sealing anything', () => {
        expect(() => sealSeedToCopyKey(SEED, { words: OTHER_WORDS })).toThrow(/different account/);
        expect(() => sealSeedToCopyKey(SEED, { words: WORDS.slice(0, 11) })).toThrow(/12 words/);
        expect(() => sealSeedToCopyKey(new Uint8Array(31))).toThrow(/32 bytes/);
    });

    it('is never confused with a sign-in copy, either way', async () => {
        const made = sealSeedToCopyKey(SEED, { words: WORDS });
        await expect(openSeedFromSso(made.copy, 'google', 'fixture-sub')).rejects.toThrow(KeeperCryptoError);
        const signIn = await sealSeedToSso(SEED, 'google', 'fixture-sub', { words: WORDS });
        expect(isKeySealedCopy(signIn.kdfParams)).toBe(false);
        expect(() => openSeedWithCopyKey(signIn, made.copyKey, PUB)).toThrow(/scheme/);
    });

    it.skipIf(!FIRST_COPY)('opens the copy its first version wrote', () => {
        const back = openSeedWithCopyKey(FIRST_COPY!.copy, FIRST_COPY!.copyKey, PUB);
        expect(bytesToHex(back.seed)).toBe(bytesToHex(SEED));
        expect(back.words).toEqual(WORDS);
    });
});

describe('a bring-back\'s release: the copy and its key in one box, sealed to the new phone', () => {
    const phoneSeed = new Uint8Array(32).map((_, i) => (i * 7 + 3) & 0xff);
    const phonePub = ed25519.getPublicKey(phoneSeed);
    const binding = { collectionId: 'BB-0A1B-2C3D', holderType: 'community' };

    it('packs and unpacks, and the phone opens the account with it', () => {
        const made = sealSeedToCopyKey(SEED, { words: WORDS });
        const sealed = sealReleaseToDevice(communityCopyForRelease(made), phonePub, binding);
        const released = openReleaseOnDevice(sealed, phoneSeed, binding);
        const copy = communityCopyFromRelease(released);
        expect(copy.copyKey).toBe(made.copyKey);
        const back = openSeedWithCopyKey(copy.copy, copy.copyKey, PUB);
        expect(bytesToHex(back.seed)).toBe(bytesToHex(SEED));
        expect(back.words).toEqual(WORDS);
    });

    it('opens for that phone and that code only', () => {
        const made = sealSeedToCopyKey(SEED);
        const sealed = sealReleaseToDevice(communityCopyForRelease(made), phonePub, binding);
        const otherPhone = new Uint8Array(32).fill(9);
        expect(() => openReleaseOnDevice(sealed, otherPhone, binding)).toThrow(KeeperCryptoError);
        expect(() => openReleaseOnDevice(sealed, phoneSeed, { ...binding, collectionId: 'BB-0A1B-2C3E' })).toThrow(KeeperCryptoError);
    });

    it('refuses a released copy that holds no community copy', () => {
        expect(() => communityCopyFromRelease({ encryptedShare: 'AA==', shareIv: 'AA==', shareTag: 'AA==', kdfParams: '{"alg":"scrypt-xc20p-single-v1"}' }))
            .toThrow(/not a community copy/);
        expect(() => communityCopyFromRelease({ encryptedShare: 'AA==', shareIv: 'AA==', shareTag: 'AA==', kdfParams: null }))
            .toThrow(/not a community copy/);
    });
});
