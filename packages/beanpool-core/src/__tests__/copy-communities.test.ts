/**
 * The member's list of communities inside a recovery copy (vault rethink VR5, design §3 item 5): bounded (20, name and
 * address only, a byte bound that keeps every copy under the 4,096-character `kdfParams` every keeper enforces), sealed
 * inside the copy and never beside it, read back at a restore, and a copy without one exactly as before.
 */
import { describe, expect, it } from 'vitest';
import { ed25519 } from '@noble/curves/ed25519.js';
import { hexToBytes } from '@noble/hashes/utils.js';
import {
    copyCommunityName,
    copyCommunityUrl,
    MAX_COPY_COMMUNITIES,
    MAX_COPY_COMMUNITIES_BYTES,
    MAX_COPY_COMMUNITY_NAME_CHARS,
    packCopyCommunities,
    unpackCopyCommunities,
    type CopyCommunity,
} from '../copy-communities.js';
import {
    isKeySealedCopy,
    KEEPER_ALG_COPY_COMMUNITIES,
    openSeedFromSso,
    openSeedWithCopyKey,
    sealSeedToCopyKey,
    sealSeedToSso,
} from '../keeper-crypto.js';
import { isVaultClientCopy, sealVaultDepositBox } from '../vault-wire.js';
import { SSO_SHARE_VECTOR_SEED_HEX, SSO_SHARE_VECTOR_WORDS } from '../sso-share-vectors.js';

const SEED = hexToBytes(SSO_SHARE_VECTOR_SEED_HEX);
const PUB = ed25519.getPublicKey(SEED);
const SUB = '104857600000000000001';
const LIST: CopyCommunity[] = [
    { name: 'Mullumbimby', url: 'https://mullum.beanpool.org' },
    { name: 'Castlemaine', url: 'https://castlemaine.beanpool.org' },
    { name: 'Kitchen garden', url: 'http://192.168.1.20:8080' },
];

function many(n: number, name = (i: number) => `Community ${i}`): CopyCommunity[] {
    return Array.from({ length: n }, (_, i) => ({ name: name(i), url: `https://c${i}.example.org` }));
}

/** The worst a phone can send: 20 addresses at the longest kept, names at 60 characters of three-byte script. */
function worstCase(): CopyCommunity[] {
    const host = (i: number) => `${String(i).padStart(2, '0')}${'a'.repeat(120 - 'https://'.length - 2 - '.org'.length)}.org`;
    return Array.from({ length: 30 }, (_, i) => ({ name: 'മ'.repeat(80), url: `https://${host(i)}` }));
}

describe('packing the list', () => {
    it('keeps name and address only, in order, each address once', () => {
        const packed = packCopyCommunities([
            ...LIST,
            { name: 'Mullum again', url: 'https://MULLUM.beanpool.org/' },
            { name: 'Extra', url: 'https://x.example.org', role: 'owner', balance: 42 } as unknown as CopyCommunity,
        ]);
        expect(packed.kept).toEqual([...LIST, { name: 'Extra', url: 'https://x.example.org' }]);
        expect(packed.leftOut).toBe(0);
        expect(new TextDecoder().decode(packed.bytes)).not.toMatch(/owner|balance|42/);
        expect(unpackCopyCommunities(packed.bytes)).toEqual(packed.kept);
    });

    it('takes 20; the 21st and on are left out and counted, for the member\'s words', () => {
        const packed = packCopyCommunities(many(23));
        expect(MAX_COPY_COMMUNITIES).toBe(20);
        expect(packed.kept).toHaveLength(20);
        expect(packed.kept.map((c) => c.name)).toEqual(many(20).map((c) => c.name));
        expect(packed.leftOut).toBe(3);
    });

    it('skips what isn\'t a community address (a path, a user part, a script, nothing), uncounted', () => {
        const packed = packCopyCommunities([
            { name: 'path', url: 'https://a.example.org/app' },
            { name: 'user', url: 'https://me@a.example.org' },
            { name: 'js', url: 'javascript:alert(1)' },
            { name: 'none', url: '' },
            null, 7, 'https://bare.example.org',
            { name: 'ok', url: 'HTTPS://ok.example.org' },
        ]);
        expect(packed.kept).toEqual([{ name: 'ok', url: 'https://ok.example.org' }]);
        expect(packed.leftOut).toBe(0);
    });

    it('cleans a name: no control or direction characters, at most 60 characters, never half a character', () => {
        expect(copyCommunityName('  Mullum\u0000‮ bimby\n ')).toBe('Mullum bimby');
        const long = '🌱'.repeat(70);
        expect(Array.from(copyCommunityName(long))).toHaveLength(MAX_COPY_COMMUNITY_NAME_CHARS);
        expect(copyCommunityName(long)).toBe('🌱'.repeat(60));
        expect(copyCommunityUrl(`https://${'a'.repeat(130)}.org`)).toBeNull();
    });

    it('stays inside its byte bound whatever the names are written in, and says how many did not fit', () => {
        const packed = packCopyCommunities(worstCase());
        expect(packed.bytes.length).toBeLessThanOrEqual(MAX_COPY_COMMUNITIES_BYTES);
        expect(packed.kept.length).toBeGreaterThan(0);
        expect(packed.kept.length + packed.leftOut).toBe(30);
    });

    it('reads back no more than 20, and refuses bytes that are not a list', () => {
        const forged = new TextEncoder().encode(JSON.stringify(many(25).map((c) => [c.url, c.name])));
        expect(unpackCopyCommunities(forged)).toHaveLength(20);
        expect(() => unpackCopyCommunities(new TextEncoder().encode('{"a":1}'))).toThrow();
        expect(unpackCopyCommunities(new TextEncoder().encode('[["https://a.example.org/x","bad"],["https://b.example.org","ok"]]')))
            .toEqual([{ url: 'https://b.example.org', name: 'ok' }]);
    });
});

describe('a sign-in copy with the list', () => {
    it('opens to the key, the words and the list', async () => {
        const copy = await sealSeedToSso(SEED, 'google', SUB, { words: SSO_SHARE_VECTOR_WORDS, communities: LIST });
        const opened = await openSeedFromSso(copy, 'google', SUB);
        expect(opened.seed).toEqual(SEED);
        expect(opened.words).toEqual(SSO_SHARE_VECTOR_WORDS);
        expect(opened.communitiesStatus).toBe('carried');
        expect(opened.communities).toEqual(LIST);
        expect(JSON.parse(copy.kdfParams).communities.alg).toBe(KEEPER_ALG_COPY_COMMUNITIES);
        // Another sign-in account opens neither the copy nor the list.
        await expect(openSeedFromSso(copy, 'google', `${SUB}0`)).rejects.toThrow();
    });

    it('without the list, the copy is exactly as before: no field, and the opener says absent', async () => {
        for (const communities of [undefined, null, [] as CopyCommunity[], [{ name: 'bad', url: 'nope' }]]) {
            const copy = await sealSeedToSso(SEED, 'google', SUB, { words: SSO_SHARE_VECTOR_WORDS, communities });
            expect(Object.keys(JSON.parse(copy.kdfParams))).toEqual(['alg', 'salt', 'N', 'r', 'p', 'words']);
            const opened = await openSeedFromSso(copy, 'google', SUB);
            expect(opened.communities).toBeNull();
            expect(opened.communitiesStatus).toBe('absent');
            expect(opened.words).toEqual(SSO_SHARE_VECTOR_WORDS);
        }
    });

    it('a damaged or swapped list costs the list, never the account or the words', async () => {
        const a = await sealSeedToSso(SEED, 'google', SUB, { words: SSO_SHARE_VECTOR_WORDS, communities: LIST });
        const b = await sealSeedToSso(SEED, 'google', SUB, { communities: [{ name: 'Other', url: 'https://other.example.org' }] });
        const params = JSON.parse(a.kdfParams);
        const tampered = { ...params, communities: { ...params.communities, ct: Buffer.from('x'.repeat(20)).toString('base64') } };
        const swapped = { ...params, communities: JSON.parse(b.kdfParams).communities };
        for (const kdf of [tampered, swapped, { ...params, communities: { alg: 'other-v9' } }, { ...params, communities: 'x' }]) {
            const opened = await openSeedFromSso({ ...a, kdfParams: JSON.stringify(kdf) }, 'google', SUB);
            expect(opened.seed).toEqual(SEED);
            expect(opened.words).toEqual(SSO_SHARE_VECTOR_WORDS);
            expect(opened.communitiesStatus).toBe('unreadable');
            expect(opened.communities).toBeNull();
        }
    });

    it('an app that predates lists reads the same key and words: the seed and words boxes do not depend on the list', async () => {
        const copy = await sealSeedToSso(SEED, 'google', SUB, { words: SSO_SHARE_VECTOR_WORDS, communities: LIST });
        // What an older opener reads is alg, salt, N and words; the list field is one it never names. Taking it away
        // changes nothing it opens.
        const { communities: _list, ...older } = JSON.parse(copy.kdfParams);
        const opened = await openSeedFromSso({ ...copy, kdfParams: JSON.stringify(older) }, 'google', SUB);
        expect(opened.seed).toEqual(SEED);
        expect(opened.words).toEqual(SSO_SHARE_VECTOR_WORDS);
        expect(opened.communitiesStatus).toBe('absent');
    });

    it('the list is never in the clear: not in the copy, not in the vault deposit box', async () => {
        const copy = await sealSeedToSso(SEED, 'google', SUB, { words: SSO_SHARE_VECTOR_WORDS, communities: LIST });
        const wire = JSON.stringify(copy);
        const depositKey = Buffer.alloc(32, 9).toString('base64url');
        const box = JSON.stringify(sealVaultDepositBox({ clientCopy: copy }, depositKey, Buffer.from(PUB).toString('hex'), 'google'));
        for (const bytes of [wire, box]) {
            for (const c of LIST) {
                expect(bytes).not.toContain(c.name);
                expect(bytes).not.toContain(c.url);
                expect(bytes).not.toContain(new URL(c.url).host);
                expect(bytes.toLowerCase()).not.toContain('mullum');
            }
        }
    });

    it('the largest list still fits every keeper: kdfParams ≤ 4096, and the vault takes the copy', async () => {
        const copy = await sealSeedToSso(SEED, 'google', SUB, { words: SSO_SHARE_VECTOR_WORDS, communities: worstCase() });
        expect(copy.kdfParams.length).toBeLessThanOrEqual(4096);
        expect(isVaultClientCopy(copy)).toBe(true);
        const opened = await openSeedFromSso(copy, 'google', SUB);
        expect(opened.communities).toEqual(packCopyCommunities(worstCase()).kept);
    });
});

describe('a community copy with the list', () => {
    it('opens to the key, the words and the list; without one, as before', () => {
        const withList = sealSeedToCopyKey(SEED, { words: SSO_SHARE_VECTOR_WORDS, communities: LIST });
        const opened = openSeedWithCopyKey(withList.copy, withList.copyKey, PUB);
        expect(opened.words).toEqual(SSO_SHARE_VECTOR_WORDS);
        expect(opened.communities).toEqual(LIST);
        expect(opened.communitiesStatus).toBe('carried');
        const without = sealSeedToCopyKey(SEED, { words: SSO_SHARE_VECTOR_WORDS });
        expect(Object.keys(JSON.parse(without.copy.kdfParams))).toEqual(['alg', 'words']);
        expect(openSeedWithCopyKey(without.copy, without.copyKey, PUB).communitiesStatus).toBe('absent');
    });

    it('the largest list still fits the community\'s 4096-character limit, and never shows in the clear', () => {
        const made = sealSeedToCopyKey(SEED, { words: SSO_SHARE_VECTOR_WORDS, communities: worstCase() });
        expect(made.copy.kdfParams.length).toBeLessThanOrEqual(4096);
        expect(isKeySealedCopy(made.copy.kdfParams)).toBe(true);
        const small = sealSeedToCopyKey(SEED, { communities: LIST });
        expect(JSON.stringify(small.copy)).not.toContain('mullum');
    });
});
