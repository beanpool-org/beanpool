/**
 * A sign-in copy that carries the 12 words (sealSeedToSso with words, openSeedFromSso).
 *
 * The seed box must stay exactly what nodes and apps on older code read, so most of what is pinned here is
 * about who ELSE opens these copies: an old copy opens with this code, and a copy with words passes a live
 * node's checks and opens with the opener apps 275/276 run.
 */
import { describe, it, expect } from 'vitest';
import { ed25519 } from '@noble/curves/ed25519.js';
import { xchacha20poly1305 } from '@noble/ciphers/chacha.js';
import { hkdf } from '@noble/hashes/hkdf.js';
import { scryptAsync } from '@noble/hashes/scrypt.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, randomBytes, utf8ToBytes } from '@noble/hashes/utils.js';
import {
    KEEPER_ALG_SSO_SINGLE,
    KEEPER_ALG_SSO_WORDS,
    KeeperCryptoError,
    isSingleBlobSso,
    openSeedFromSso,
    openShareFromSso,
    sealSeedToSso,
    sealShareToSso,
    type SealedShare,
} from '../keeper-crypto.js';
import { splitHubAndWhole } from '../two-layer-split.js';
import { packRecoveryWords } from '../recovery-words.js';

// Test phrases only (a BIP-39 vector and hand-picked words), never a real account's.
const WORDS = 'abandon ability able about above absent absorb abstract absurd abuse access accident'.split(' ');
const OTHER_WORDS = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'.split(' ');

/** The apps' own derivation: seed = SHA256(SHA256(words)). */
function seedOf(words: string[]): Uint8Array {
    return sha256(sha256(utf8ToBytes(words.join(' '))));
}
const SEED = seedOf(WORDS);

function flip(value: string): string {
    const bytes = Buffer.from(value, 'base64');
    bytes[0] ^= 0x01;
    return bytes.toString('base64');
}

function withWordsBox(sealed: SealedShare, change: (box: Record<string, unknown>) => unknown): SealedShare {
    const params = JSON.parse(sealed.kdfParams);
    params.words = change({ ...params.words });
    return { ...sealed, kdfParams: JSON.stringify(params) };
}

/**
 * Written by `sealSeedToSso` on origin/main (db033b2c), before words existed: the shape every sign-in
 * copy on the live nodes has today. The seed is a test pattern, not an account.
 */
const ORIGIN_MAIN_COPY = {
    seed: new Uint8Array(32).map((_, i) => (i * 29 + 17) & 0xff),
    provider: 'google',
    sub: 'fixture-sub-origin-main',
    sealed: {
        encryptedShare: '0PfgPB41SZslCXEdyx6j4uxfDFkc7xPobInIIvASJLs=',
        shareIv: 'Uafoa1tVlE5JpUwBzFtlEQ9OW6wHfIbf',
        shareTag: 'zhFp2KTE9GnShM/0IuHKqw==',
        kdfParams: '{"alg":"scrypt-xc20p-single-v1","salt":"l88mjGeEwDkVthwNsjJ5TXl5S/U4HJljyL3oVkXTKSU=","N":16384,"r":8,"p":1}',
    },
};

describe('sealing the words with the seed', () => {
    it('opens to the same seed and the same words', async () => {
        const sealed = await sealSeedToSso(SEED, 'google', 'sub-1', { words: WORDS });
        const opened = await openSeedFromSso(sealed, 'google', 'sub-1');
        expect(opened.seed).toEqual(SEED);
        expect(opened.words).toEqual(WORDS);
        expect(opened.wordsStatus).toBe('carried');
    });

    it('seals the words as typed on the phone, forgiving case and stray spaces, and gives them back normalised', async () => {
        const sealed = await sealSeedToSso(SEED, 'apple', 'sub-2', { words: WORDS.map((w) => ` ${w.toUpperCase()}`) });
        expect((await openSeedFromSso(sealed, 'apple', 'sub-2')).words).toEqual(WORDS);
    });

    it('without words, opens to the seed alone and writes exactly the old kdfParams', async () => {
        for (const words of [undefined, null, []]) {
            const sealed = await sealSeedToSso(SEED, 'google', 'sub-3', { words });
            expect(Object.keys(JSON.parse(sealed.kdfParams))).toEqual(['alg', 'salt', 'N', 'r', 'p']);
            const opened = await openSeedFromSso(sealed, 'google', 'sub-3');
            expect(opened.seed).toEqual(SEED);
            expect(opened.words).toBeNull();
            expect(opened.wordsStatus).toBe('absent');
        }
        const noOptions = await sealSeedToSso(SEED, 'google', 'sub-3');
        expect(Object.keys(JSON.parse(noOptions.kdfParams))).toEqual(['alg', 'salt', 'N', 'r', 'p']);
    });

    it('refuses words that make another account, and words that are not 12 listed words', async () => {
        await expect(sealSeedToSso(SEED, 'google', 'sub-4', { words: OTHER_WORDS })).rejects.toThrow(KeeperCryptoError);
        await expect(sealSeedToSso(SEED, 'google', 'sub-4', { words: WORDS.slice(0, 11) })).rejects.toThrow(KeeperCryptoError);
        await expect(sealSeedToSso(SEED, 'google', 'sub-4', { words: [...WORDS.slice(0, 11), 'accidnet'] }))
            .rejects.toThrow(KeeperCryptoError);
    });

    it('writes a words box of fixed size whatever the words are', async () => {
        const other = seedOf(OTHER_WORDS);
        const a = JSON.parse((await sealSeedToSso(SEED, 'google', 's', { words: WORDS })).kdfParams).words;
        const b = JSON.parse((await sealSeedToSso(other, 'google', 's', { words: OTHER_WORDS })).kdfParams).words;
        expect(a.alg).toBe(KEEPER_ALG_SSO_WORDS);
        expect(Buffer.from(a.ct, 'base64').length).toBe(17);
        expect(Buffer.from(b.ct, 'base64').length).toBe(17);
        expect(Buffer.from(a.iv, 'base64').length).toBe(24);
        expect(Buffer.from(a.tag, 'base64').length).toBe(16);
    });
});

describe('who else reads a copy that carries words', () => {
    it('passes the checks a node on older code makes (recovery-shares.ts, routes/keepers.ts) unchanged', async () => {
        const sealed = await sealSeedToSso(SEED, 'google', 'sub-5', { words: WORDS });
        expect(isSingleBlobSso(sealed.kdfParams)).toBe(true);
        expect(typeof JSON.parse(sealed.kdfParams).salt).toBe('string');
        expect(Buffer.from(sealed.encryptedShare, 'base64').length).toBe(32);
        expect(Buffer.from(sealed.shareIv, 'base64').length).toBe(24);
        expect(Buffer.from(sealed.shareTag, 'base64').length).toBe(16);
        expect(sealed.kdfParams.length).toBeLessThanOrEqual(4096);
        expect(sealed.kdfParams.length).toBeLessThan(400);
    });

    it('opens with the opener apps on older code run, to exactly the 32-byte seed', async () => {
        const sealed = await sealSeedToSso(SEED, 'facebook', 'sub-6', { words: WORDS });
        const seed = await openShareFromSso(sealed, 'facebook', 'sub-6');
        expect(seed.length).toBe(32);
        expect(seed).toEqual(SEED);
    });

    it('an old copy (origin/main, before words) still opens, to the seed alone', async () => {
        const { seed, provider, sub, sealed } = ORIGIN_MAIN_COPY;
        const opened = await openSeedFromSso(sealed, provider, sub);
        expect(opened.seed).toEqual(seed);
        expect(opened.words).toBeNull();
        expect(opened.wordsStatus).toBe('absent');
        expect(await openShareFromSso(sealed, provider, sub)).toEqual(seed);
    });

    it('the single-blob copy the old seal path writes opens here too', async () => {
        const sealed = await sealShareToSso(SEED, 'google', 'sub-7', { alg: KEEPER_ALG_SSO_SINGLE });
        const opened = await openSeedFromSso(sealed, 'google', 'sub-7');
        expect(opened.seed).toEqual(SEED);
        expect(opened.wordsStatus).toBe('absent');
    });

    it('refuses a two-layer copy, which holds half a seed and never words', async () => {
        const { otherHalf } = await splitHubAndWhole(SEED);
        const legacy = await sealShareToSso(otherHalf, 'google', 'sub-8');
        await expect(openSeedFromSso(legacy, 'google', 'sub-8')).rejects.toThrow(KeeperCryptoError);
        // …and the opener for it is unchanged.
        expect(await openShareFromSso(legacy, 'google', 'sub-8')).toEqual(otherHalf);
    });
});

describe('a tampered or wrong copy', () => {
    it('fails outright when the seed box is altered, or the sign-in is another', async () => {
        const sealed = await sealSeedToSso(SEED, 'google', 'sub-9', { words: WORDS });
        await expect(openSeedFromSso({ ...sealed, encryptedShare: flip(sealed.encryptedShare) }, 'google', 'sub-9'))
            .rejects.toThrow(KeeperCryptoError);
        await expect(openSeedFromSso({ ...sealed, shareTag: flip(sealed.shareTag) }, 'google', 'sub-9'))
            .rejects.toThrow(KeeperCryptoError);
        await expect(openSeedFromSso(sealed, 'google', 'another-sub')).rejects.toThrow(KeeperCryptoError);
        await expect(openSeedFromSso(sealed, 'apple', 'sub-9')).rejects.toThrow(KeeperCryptoError);
    });

    it('still gives the seed when only the words box is damaged, and never words from it', async () => {
        const sealed = await sealSeedToSso(SEED, 'google', 'sub-10', { words: WORDS });
        const damaged = [
            withWordsBox(sealed, (w) => ({ ...w, ct: flip(w.ct as string) })),
            withWordsBox(sealed, (w) => ({ ...w, tag: flip(w.tag as string) })),
            withWordsBox(sealed, (w) => ({ ...w, iv: flip(w.iv as string) })),
            withWordsBox(sealed, (w) => ({ ...w, alg: 'bip39-bits-xc20p-v2' })),
            withWordsBox(sealed, (w) => ({ ...w, ct: undefined })),
            withWordsBox(sealed, () => 'not a box'),
            // Another deposit's words box: a different salt, so a different key.
            withWordsBox(sealed, () => ({ alg: KEEPER_ALG_SSO_WORDS, iv: 'AAAA', ct: 'AAAA', tag: 'AAAA' })),
        ];
        for (const copy of damaged) {
            const opened = await openSeedFromSso(copy, 'google', 'sub-10');
            expect(opened.seed).toEqual(SEED);
            expect(opened.words).toBeNull();
            expect(opened.wordsStatus).toBe('unreadable');
        }
    });

    it('never returns words that open but make another account', async () => {
        // A box built with the right key (as someone holding the provider's sub could) around another
        // account's words. It opens; the words are still refused, because they do not make this seed's key.
        const sealed = await sealSeedToSso(SEED, 'google', 'sub-11');
        const params = JSON.parse(sealed.kdfParams);
        const ssoKey = await scryptAsync(utf8ToBytes('google:sub-11'), Buffer.from(params.salt, 'base64'), {
            N: params.N, r: 8, p: 1, dkLen: 32,
        });
        const wordsKey = hkdf(sha256, ssoKey, undefined, utf8ToBytes('beanpool-keeper-sso-words'), 32);
        const nonce = randomBytes(24);
        const box = xchacha20poly1305(wordsKey, nonce, utf8ToBytes('beanpool-keeper-sso-words-v1'))
            .encrypt(packRecoveryWords(OTHER_WORDS));
        params.words = {
            alg: KEEPER_ALG_SSO_WORDS,
            iv: Buffer.from(nonce).toString('base64'),
            ct: Buffer.from(box.subarray(0, 17)).toString('base64'),
            tag: Buffer.from(box.subarray(17)).toString('base64'),
        };
        const opened = await openSeedFromSso({ ...sealed, kdfParams: JSON.stringify(params) }, 'google', 'sub-11');
        expect(opened.seed).toEqual(SEED);
        expect(opened.words).toBeNull();
        expect(opened.wordsStatus).toBe('mismatch');
        // The same box around THIS account's words is accepted, so the refusal above is the words, not the box.
        const good = xchacha20poly1305(wordsKey, nonce, utf8ToBytes('beanpool-keeper-sso-words-v1'))
            .encrypt(packRecoveryWords(WORDS));
        params.words = { ...params.words, ct: Buffer.from(good.subarray(0, 17)).toString('base64'), tag: Buffer.from(good.subarray(17)).toString('base64') };
        const right = await openSeedFromSso({ ...sealed, kdfParams: JSON.stringify(params) }, 'google', 'sub-11');
        expect(right.words).toEqual(WORDS);
        expect(bytesToHex(ed25519.getPublicKey(right.seed))).toBe(bytesToHex(ed25519.getPublicKey(SEED)));
    });
});
