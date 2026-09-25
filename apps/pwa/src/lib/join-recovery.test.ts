/**
 * Sign-in recovery at the web door (G11-c): the browser's copy is the phone's, byte for byte, and it seals the raw
 * seed whatever form the browser keeps the key in. The phone's side of the same vectors is
 * apps/native/utils/__tests__/sso-share-vectors.test.ts; core's is sso-share-vectors.test.ts. No provider and no node
 * is contacted: every sign-in here is a fixture.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ed25519 } from '@noble/curves/ed25519.js';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';
import { openSeedFromSso } from '@beanpool/core';
import {
    SSO_SHARE_VECTORS,
    SSO_SHARE_VECTOR_PKCS8_HEX,
    SSO_SHARE_VECTOR_PUBLIC_KEY,
    SSO_SHARE_VECTOR_SEED_HEX,
    SSO_SHARE_VECTOR_WORDS,
    seededGetRandomValues,
    type SsoShareVector,
} from '@beanpool/core/sso-share-vectors';
import { recoveryStored, sealJoinRecovery, signInNames } from './join-recovery';
import { joinBody, type SignInProof } from './web-join';
import { generateIdentity, importIdentity, type BeanPoolIdentity } from './identity';
import { getSignInRecovery } from './api';
import { memoryIndexedDB } from './memory-indexeddb';

afterEach(() => {
    vi.restoreAllMocks();
});

/** The vector key as this browser keeps it: 48-byte PKCS8, with its words when the vector seals them. */
function browserIdentity(v: SsoShareVector): BeanPoolIdentity {
    return {
        publicKey: SSO_SHARE_VECTOR_PUBLIC_KEY,
        privateKey: SSO_SHARE_VECTOR_PKCS8_HEX,
        callsign: 'Vector',
        createdAt: '2026-09-26T00:00:00.000Z',
        ...(v.withWords ? { mnemonic: [...SSO_SHARE_VECTOR_WORDS] } : {}),
    };
}

/** A fixture sign-in for the vector: a token that is never checked (nothing here reaches a node), or GitHub's session. */
function fixtureProof(v: SsoShareVector): SignInProof {
    return v.provider === 'github'
        ? { provider: 'github', sessionId: 'node-session-1', sub: v.sub }
        : { provider: v.provider, idToken: 'eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJmaXh0dXJlIn0.c2ln', nonce: 'node-nonce-1', sub: v.sub };
}

describe("the browser's copy is the phone's, byte for byte (@beanpool/core/sso-share-vectors)", () => {
    it.each(SSO_SHARE_VECTORS.map((v) => [v.name, v] as const))('%s', async (_name, v) => {
        expect(browserIdentity(v).privateKey).toHaveLength(96);
        vi.spyOn(globalThis.crypto, 'getRandomValues').mockImplementation(seededGetRandomValues(v.name) as never);
        const sealed = await sealJoinRecovery(browserIdentity(v), v.provider, v.sub);
        expect(sealed).not.toBeNull();
        expect(sealed!.shares).toEqual(v.shares);
        expect(JSON.stringify(sealed!.shares)).toBe(JSON.stringify(v.shares));
        expect(sealed!.wordsSealed).toBe(v.withWords);

        // The join body, as the phone's utils/global-join.ts submitJoin builds it for the same sign-in: the same
        // fields in the same order, so even the serialised request bodies match.
        const proof = fixtureProof(v);
        const credential = proof.provider === 'github'
            ? { proof: { sessionId: proof.sessionId } }
            : { idToken: proof.idToken, nonce: proof.nonce };
        const phoneBody = { callsign: 'Vector', provider: v.provider, ...credential, recovery: { shares: v.shares } };
        const body = joinBody('Vector', proof, { shares: sealed!.shares });
        expect(JSON.stringify(body)).toBe(JSON.stringify(phoneBody));
    });
});

describe('the key the browser holds as PKCS8 is sealed as the raw 32-byte seed', () => {
    it('a key made here (96 hex characters) opens as 32 bytes that sign as this account, with its 12 words', async () => {
        const identity = await generateIdentity('Pat');
        expect(identity.privateKey).toHaveLength(96);
        const sealed = await sealJoinRecovery(identity, 'google', '112233445566778899001');
        expect(sealed?.wordsSealed).toBe(true);
        const opened = await openSeedFromSso(sealed!.shares[0], 'google', '112233445566778899001');
        expect(opened.seed).toHaveLength(32);
        expect(bytesToHex(opened.seed)).toBe(identity.privateKey.slice(32));
        expect(bytesToHex(ed25519.getPublicKey(opened.seed))).toBe(identity.publicKey);
        expect(opened.words).toEqual(identity.mnemonic);
        expect(opened.wordsStatus).toBe('carried');
    });

    it('a key brought here from the phone (the raw seed) is sealed the same way', async () => {
        const v = SSO_SHARE_VECTORS[0];
        vi.spyOn(globalThis.crypto, 'getRandomValues').mockImplementation(seededGetRandomValues(v.name) as never);
        const sealed = await sealJoinRecovery({ ...browserIdentity(v), privateKey: SSO_SHARE_VECTOR_SEED_HEX }, v.provider, v.sub);
        expect(sealed!.shares).toEqual(v.shares);
    });

    it('words that make another key are left out, and the key goes alone', async () => {
        const other = await generateIdentity('Other');
        const v = SSO_SHARE_VECTORS[0];
        const sealed = await sealJoinRecovery({ ...browserIdentity(v), mnemonic: other.mnemonic }, 'apple', 'apple-sub');
        expect(sealed?.wordsSealed).toBe(false);
        const opened = await openSeedFromSso(sealed!.shares[0], 'apple', 'apple-sub');
        expect(bytesToHex(opened.seed)).toBe(SSO_SHARE_VECTOR_SEED_HEX);
        expect(opened.wordsStatus).toBe('absent');
    });
});

describe('a copy that cannot be made is null, never a throw (the join then goes without it)', () => {
    it.each([
        ['a key that is not hex', 'not-a-key'],
        ['a key of the wrong length', '00'.repeat(20)],
        ['a PKCS8 envelope with a wrong header', 'ff'.repeat(16) + SSO_SHARE_VECTOR_SEED_HEX],
    ])('%s', async (_label, privateKey) => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        await expect(sealJoinRecovery({ ...browserIdentity(SSO_SHARE_VECTORS[0]), privateKey }, 'google', 'sub')).resolves.toBeNull();
        // The reason is logged; the key is not.
        expect(warn).toHaveBeenCalled();
        expect(JSON.stringify(warn.mock.calls)).not.toContain(SSO_SHARE_VECTOR_SEED_HEX);
    });

    it('no sign-in subject', async () => {
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        await expect(sealJoinRecovery(browserIdentity(SSO_SHARE_VECTORS[0]), 'google', '')).resolves.toBeNull();
    });

    it('no random source in this browser', async () => {
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        vi.spyOn(globalThis.crypto, 'getRandomValues').mockImplementation(() => { throw new Error('QuotaExceededError'); });
        await expect(sealJoinRecovery(browserIdentity(SSO_SHARE_VECTORS[0]), 'google', 'sub')).resolves.toBeNull();
    });
});

describe("asking the node which sign-ins bring this account back (Settings)", () => {
    function answer(status: number, body: unknown) {
        const fetchMock = vi.fn(async () => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } }));
        vi.stubGlobal('fetch', fetchMock);
        return fetchMock;
    }
    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it("the node's list, asked with a signed POST", async () => {
        vi.stubGlobal('indexedDB', memoryIndexedDB());
        const me = await generateIdentity('Me');
        await importIdentity(me);
        const fetchMock = answer(200, { enrolledSso: ['google', 7, 'github'], total: 1 });
        expect(await getSignInRecovery()).toEqual(['google', 'github']);
        const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
        expect(url).toMatch(/\/api\/recovery\/shares\/status$/);
        expect(init.method).toBe('POST');
        expect((init.headers as Record<string, string>)['X-Public-Key']).toBe(me.publicKey);
    });

    it.each([
        ['none', 200, { enrolledSso: [] }, []],
        ['an answer without the list', 200, { total: 0 }, null],
        ['an older node', 404, { error: 'Not Found' }, null],
        ['not signed', 401, { error: 'Unauthenticated' }, null],
    ])('%s', async (_label, status, body, expected) => {
        vi.stubGlobal('indexedDB', memoryIndexedDB());
        answer(status, body);
        expect(await getSignInRecovery()).toEqual(expected);
    });

    it('no answer at all', async () => {
        vi.stubGlobal('indexedDB', memoryIndexedDB());
        vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('Failed to fetch'); }));
        expect(await getSignInRecovery()).toBeNull();
    });
});

describe("the node's word on the copy", () => {
    it('stored only when it says enrolled: true', () => {
        expect(recoveryStored({ enrolled: true, generation: 1, enrolledSso: ['google'] })).toBe(true);
        expect(recoveryStored({ enrolled: false, error: 'The recovery keeper could not be stored.' })).toBe(false);
        expect(recoveryStored({ enrolled: 'true' })).toBe(false);
        expect(recoveryStored({})).toBe(false);
        expect(recoveryStored(null)).toBe(false);
        expect(recoveryStored(undefined)).toBe(false);
    });

    it('the sign-ins named as a member reads them; one this app has no name for is left out', () => {
        expect(signInNames(['google'])).toBe('Google');
        expect(signInNames(['google', 'github'])).toBe('Google and GitHub');
        expect(signInNames(['google', 'apple', 'github'])).toBe('Google, Apple and GitHub');
        expect(signInNames(['google', 'google'])).toBe('Google');
        expect(signInNames(['facebook', 'myspace'])).toBe('Facebook');
        expect(signInNames(['toString'])).toBeNull();
        expect(signInNames([])).toBeNull();
    });

    it('the vector key really is the words\' key (a check on the fixture, not the code)', () => {
        expect(bytesToHex(ed25519.getPublicKey(hexToBytes(SSO_SHARE_VECTOR_SEED_HEX)))).toBe(SSO_SHARE_VECTOR_PUBLIC_KEY);
    });
});
