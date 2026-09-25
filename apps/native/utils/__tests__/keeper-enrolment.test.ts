import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@react-native-async-storage/async-storage', () => ({
    default: { getItem: vi.fn(async () => 'https://test.beanpool.org') },
}));

vi.mock('expo-file-system/legacy', () => ({
    documentDirectory: 'file:///docs/',
    EncodingType: { UTF8: 'utf8' },
    writeAsStringAsync: vi.fn(async () => {}),
    deleteAsync: vi.fn(async () => {}),
}));

vi.mock('../crypto', () => ({
    buildSignedHeaders: vi.fn(async () => ({ 'Content-Type': 'application/json' })),
    encodeBase64: (b: Uint8Array) => Buffer.from(b).toString('base64'),
    mnemonicToSeed: vi.fn(async () => new Uint8Array(32).map((_, i) => (i * 7 + 3) & 0xff)),
    hexToBytes: (hex: string) => Uint8Array.from(Buffer.from(hex, 'hex')),
}));

vi.mock('../node-post', () => ({
    anchorUrl: vi.fn(async () => 'https://test.beanpool.org'),
    signedPost: vi.fn(),
    signedDelete: vi.fn(),
}));

// The words are read through the identity module (getMnemonic), which imports these at load.
vi.mock('react-native', () => ({ Platform: { OS: 'android' } }));
vi.mock('expo-secure-store', () => ({
    getItemAsync: vi.fn(),
    setItemAsync: vi.fn(),
    deleteItemAsync: vi.fn(),
}));

import { ed25519 } from '@noble/curves/ed25519.js';
import { sha256 } from '@noble/hashes/sha2.js';
import {
    enrolKeepers, enrolSsoKeeper, disconnectSsoKeeper,
} from '../keeper-enrolment';
import { signedPost, signedDelete, anchorUrl } from '../node-post';
import { openShareFromSso, openSeedFromSso, isSingleBlobSso, toEd25519Pkcs8 } from '@beanpool/core';

/**
 * Route the `signedPost` mock.
 */
function mockNode(opts: { deposit?: any } = {}) {
    const { deposit = { ok: true, json: async () => ({ generation: 2 }) } } = opts;
    (signedPost as any).mockImplementation(async (_url: string, _path: string) => {
        return deposit;
    });
}

/** The SSO share the client actually deposited. */
function depositedSsoShare(): any {
    const call = (signedPost as any).mock.calls.find((c: any[]) => c[1] === '/api/recovery/shares/sso');
    return call?.[2]?.shares?.find((sh: any) => sh.holderType === 'sso');
}

/** The sealed member half as the client built it, decoded back to bytes. */
function depositedSsoCiphertextLength(): number {
    const sso = depositedSsoShare();
    return Buffer.from(sso.encryptedShare, 'base64').length;
}

const IDENTITY = {
    callsign: 'Alice',
    publicKey: Buffer.from(ed25519.getPublicKey(new Uint8Array(32).fill(9))).toString('hex'),
    privateKey: Buffer.from(new Uint8Array(32).fill(9)).toString('hex'),
    createdAt: '2026-08-14T00:00:00.000Z',
    mnemonic: 'abandon ability able about above absent absorb abstract absurd abuse access accident'.split(' '),
} as any;

const FRIEND_KEYS = [
    Buffer.from(ed25519.getPublicKey(new Uint8Array(32).fill(1))).toString('hex'),
    Buffer.from(ed25519.getPublicKey(new Uint8Array(32).fill(2))).toString('hex'),
    Buffer.from(ed25519.getPublicKey(new Uint8Array(32).fill(3))).toString('hex'),
];

describe('keeper-enrolment.ts', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        (anchorUrl as any).mockResolvedValue('https://test.beanpool.org');
    });

    // ---------------------------------------------------------------------------
    // Signup — sovereign by default
    // ---------------------------------------------------------------------------
    describe('enrolKeepers at signup — sovereign', () => {
        it('returns sovereign (nothing enrolled) for every member at signup', async () => {
            const result = await enrolKeepers(IDENTITY);
            expect(result.enrolled).toEqual([]);
            expect(result.generation).toBeNull();
            expect(result.available).toBe(0);
            expect(result.error).toBeUndefined();
        });

        it('never throws — the never-throws contract is unchanged', async () => {
            await expect(enrolKeepers(IDENTITY)).resolves.toBeDefined();
            await expect(enrolKeepers({ ...IDENTITY, mnemonic: [] })).resolves.toBeDefined();
            await expect(enrolKeepers({ ...IDENTITY, mnemonic: undefined })).resolves.toBeDefined();
        });

        it('returns empty skipped array — nothing was attempted', async () => {
            const result = await enrolKeepers(IDENTITY);
            expect(result.skipped).toEqual([]);
        });
    });

    // ---------------------------------------------------------------------------
    // SSO-tier enrolment
    // ---------------------------------------------------------------------------
    describe('enrolSsoKeeper', () => {
        // A phone restored with a sign-in holds no words: they can't be rebuilt from the seed
        // (sso-recovery.ts saves the identity without them). The deposit seals the seed, never the
        // words, so these members — the ones with no 12 words to fall back on — must still be able
        // to protect their account. Android 275 refused them: "this identity has no recovery words
        // to split".
        describe('an identity with no words (restored with a sign-in)', () => {
            const WORDLESS_SEED = new Uint8Array(32).map((_, i) => (i * 11 + 5) & 0xff);
            const WORDLESS = {
                callsign: 'Restored',
                publicKey: Buffer.from(ed25519.getPublicKey(WORDLESS_SEED)).toString('hex'),
                privateKey: Buffer.from(WORDLESS_SEED).toString('hex'),
                createdAt: '2026-09-25T00:00:00.000Z',
            } as any;

            /** The deposited piece, opened with the same provider and sub, as the public key it gives. */
            async function openedPublicKey(provider: string, sub: string): Promise<string> {
                const opened = await openShareFromSso(depositedSsoShare(), provider, sub);
                return Buffer.from(ed25519.getPublicKey(opened)).toString('hex');
            }

            it.each([
                ['no mnemonic field', undefined],
                ['an empty mnemonic', []],
            ])('deposits with %s, and the sealed seed opens to this identity\'s key', async (_label, mnemonic) => {
                mockNode();

                const result = await enrolSsoKeeper({
                    identity: { ...WORDLESS, mnemonic },
                    provider: 'google',
                    sub: 'google-sub-restored',
                    idToken: 'mock-jwt-token',
                    nonce: 'mock-nonce',
                });

                expect(result.error).toBeUndefined();
                expect(result.enrolled).toEqual(['sso']);
                expect(result.generation).toBe(2);
                expect(signedPost).toHaveBeenCalledTimes(1);
                expect(await openedPublicKey('google', 'google-sub-restored')).toBe(WORDLESS.publicKey);
            });

            it('deposits with a PKCS8 private key (the PWA\'s format), and the sealed seed opens to this identity\'s key', async () => {
                mockNode();
                const pkcs8 = toEd25519Pkcs8(WORDLESS_SEED);
                expect(pkcs8.length).toBe(48);

                const result = await enrolSsoKeeper({
                    identity: { ...WORDLESS, privateKey: Buffer.from(pkcs8).toString('hex') },
                    provider: 'facebook',
                    sub: 'facebook-sub-restored',
                    idToken: 'mock-jwt-token',
                    nonce: 'mock-nonce',
                });

                expect(result.error).toBeUndefined();
                expect(result.enrolled).toEqual(['sso']);
                expect(await openedPublicKey('facebook', 'facebook-sub-restored')).toBe(WORDLESS.publicKey);
            });

            it('deposits for GitHub with the node\'s session, and the sealed seed opens to this identity\'s key', async () => {
                mockNode();

                const result = await enrolSsoKeeper({
                    identity: WORDLESS,
                    provider: 'github',
                    sub: '24680',
                    proof: { sessionId: 'node-session-restored' },
                });

                expect(result.error).toBeUndefined();
                expect(result.enrolled).toEqual(['sso']);
                expect(await openedPublicKey('github', '24680')).toBe(WORDLESS.publicKey);
            });

            it('still refuses a key it cannot read, and sends nothing', async () => {
                const result = await enrolSsoKeeper({
                    identity: { ...WORDLESS, privateKey: '12345678' },
                    provider: 'google',
                    sub: 'google-sub-restored',
                    idToken: 'mock-jwt-token',
                    nonce: 'mock-nonce',
                });

                expect(result.enrolled).toEqual([]);
                expect(result.error).toContain('could not read the private key');
                expect(signedPost).not.toHaveBeenCalled();
            });
        });

        // A phone that has the 12 words seals them with the seed, so a sign-in restore gives them back
        // (keeper-crypto.ts sealSeedToSso). Test phrase only, never a real account's.
        describe('an identity with its 12 words', () => {
            const PHRASE = 'legal winner thank year wave sausage worth useful legal winner thank yellow';
            const WORDS = PHRASE.split(' ');
            const WORDS_SEED = sha256(sha256(Buffer.from(PHRASE, 'utf8')));
            const WORDED = {
                callsign: 'HasWords',
                publicKey: Buffer.from(ed25519.getPublicKey(WORDS_SEED)).toString('hex'),
                privateKey: Buffer.from(WORDS_SEED).toString('hex'),
                createdAt: '2026-09-25T00:00:00.000Z',
                mnemonic: WORDS,
            } as any;

            it.each([
                ['a raw seed', WORDED],
                ['a PKCS8 key (the PWA\'s format)', { ...WORDED, privateKey: Buffer.from(toEd25519Pkcs8(WORDS_SEED)).toString('hex') }],
            ])('with %s, seals the words, and the copy opens to this key and these words', async (_label, identity) => {
                mockNode();

                const result = await enrolSsoKeeper({
                    identity, provider: 'google', sub: 'google-sub-words', idToken: 'mock-jwt-token', nonce: 'mock-nonce',
                });

                expect(result.error).toBeUndefined();
                expect(result.wordsSealed).toBe(true);
                const opened = await openSeedFromSso(depositedSsoShare(), 'google', 'google-sub-words');
                expect(Buffer.from(ed25519.getPublicKey(opened.seed)).toString('hex')).toBe(WORDED.publicKey);
                expect(opened.words).toEqual(WORDS);
                expect(opened.wordsStatus).toBe('carried');
            });

            it('seals them for GitHub too', async () => {
                mockNode();
                const result = await enrolSsoKeeper({ identity: WORDED, provider: 'github', sub: '13579', proof: { sessionId: 's' } });
                expect(result.wordsSealed).toBe(true);
                expect((await openSeedFromSso(depositedSsoShare(), 'github', '13579')).words).toEqual(WORDS);
            });

            it('seals the key alone when the phone\'s words make a different key, and never logs the words', async () => {
                mockNode();
                const log = vi.spyOn(console, 'log');

                const result = await enrolSsoKeeper({
                    identity: { ...WORDED, mnemonic: IDENTITY.mnemonic },
                    provider: 'google', sub: 'google-sub-words', idToken: 'mock-jwt-token', nonce: 'mock-nonce',
                });

                expect(result.error).toBeUndefined();
                expect(result.enrolled).toEqual(['sso']);
                expect(result.wordsSealed).toBe(false);
                const opened = await openSeedFromSso(depositedSsoShare(), 'google', 'google-sub-words');
                expect(Buffer.from(ed25519.getPublicKey(opened.seed)).toString('hex')).toBe(WORDED.publicKey);
                expect(opened.wordsStatus).toBe('absent');
                expect(Object.keys(JSON.parse(depositedSsoShare().kdfParams))).not.toContain('words');
                const logged = log.mock.calls.flat().join('\n');
                expect(logged).toContain('do not make its key');
                for (const w of [...IDENTITY.mnemonic, ...WORDS]) expect(logged).not.toMatch(new RegExp(`\\b${w}\\b`));
                log.mockRestore();
            });
        });

        it('a phone with no words deposits the seed alone, as #1147 made it (no words box, words absent on open)', async () => {
            for (const mnemonic of [undefined, []]) {
                vi.clearAllMocks();
                mockNode();
                const seed = new Uint8Array(32).map((_, i) => (i * 11 + 5) & 0xff);
                const result = await enrolSsoKeeper({
                    identity: {
                        callsign: 'Restored', createdAt: '2026-09-25T00:00:00.000Z', mnemonic,
                        publicKey: Buffer.from(ed25519.getPublicKey(seed)).toString('hex'),
                        privateKey: Buffer.from(seed).toString('hex'),
                    } as any,
                    provider: 'google', sub: 'google-sub-restored', idToken: 'mock-jwt-token', nonce: 'mock-nonce',
                });
                expect(result.error).toBeUndefined();
                expect(result.wordsSealed).toBe(false);
                expect(Object.keys(JSON.parse(depositedSsoShare().kdfParams))).toEqual(['alg', 'salt', 'N', 'r', 'p']);
                const opened = await openSeedFromSso(depositedSsoShare(), 'google', 'google-sub-restored');
                expect(opened.seed).toEqual(seed);
                expect(opened.words).toBeNull();
                expect(opened.wordsStatus).toBe('absent');
            }
        });

        it('successfully seals and deposits single-blob SSO share', async () => {
            mockNode();

            const result = await enrolSsoKeeper({
                identity: IDENTITY,
                provider: 'google',
                sub: 'google-sub-12345',
                idToken: 'mock-jwt-token',
                nonce: 'mock-nonce',
            });

            expect(result.enrolled).toEqual(['sso']);
            expect(result.generation).toBe(2);
            expect(result.available).toBe(1);
            expect(result.error).toBeUndefined();
            expect(signedPost).toHaveBeenCalledWith(
                'https://test.beanpool.org',
                '/api/recovery/shares/sso',
                expect.objectContaining({
                    provider: 'google',
                    idToken: 'mock-jwt-token',
                    nonce: 'mock-nonce',
                    shares: [
                        expect.objectContaining({ holderType: 'sso', shareIndex: 1 }),
                    ],
                }),
                IDENTITY,
            );
        });

        it('handles network throw gracefully without throwing', async () => {
            (signedPost as any).mockRejectedValueOnce(new Error('Network connection timeout'));

            const result = await enrolSsoKeeper({
                identity: IDENTITY,
                provider: 'apple',
                sub: 'apple-sub-12345',
                idToken: 'mock-jwt-token',
                nonce: 'mock-nonce',
            });

            expect(result.enrolled).toEqual([]);
            expect(result.error).toContain('could not reach the node');
        });

        it('maps multiple enrolled SSO providers so spare counter does not desync', async () => {
            mockNode({
                deposit: {
                    ok: true,
                    json: async () => ({ generation: 3, enrolledSso: ['google', 'apple'], threshold: 1 }),
                },
            });

            const result = await enrolSsoKeeper({
                identity: IDENTITY,
                provider: 'apple',
                sub: 'apple-sub-12345',
                idToken: 'mock-jwt-token',
                nonce: 'mock-nonce',
            });

            expect(result.enrolled).toEqual(['sso', 'sso']);
            expect(result.available).toBe(2);
            expect(result.enrolledSso).toEqual(['google', 'apple']);
            expect(result.threshold).toBe(1);
        });

        it('deposits single-blob SSO share with explicit single-blob algorithm in kdfParams', async () => {
            mockNode();

            await enrolSsoKeeper({
                identity: IDENTITY,
                provider: 'google',
                sub: 'google-sub-12345',
                idToken: 'mock-jwt-token',
                nonce: 'mock-nonce',
            });

            const sso = depositedSsoShare();
            expect(sso).toBeDefined();
            expect(isSingleBlobSso(sso.kdfParams)).toBe(true);
            expect(depositedSsoCiphertextLength()).toBeGreaterThan(0);
        });

        it('does not request a hub fragment or include a hub row in deposit', async () => {
            mockNode();

            await enrolSsoKeeper({
                identity: IDENTITY,
                provider: 'google',
                sub: 'google-sub-12345',
                idToken: 'mock-jwt-token',
                nonce: 'mock-nonce',
            });

            const call = (signedPost as any).mock.calls.find((c: any[]) => c[1] === '/api/recovery/shares/sso');
            expect(call[2].shares.length).toBe(1);
            expect(call[2].shares.some((sh: any) => sh.holderType === 'hub')).toBe(false);
        });

        it('deposited share can be decrypted back to the original seed', async () => {
            mockNode();

            await enrolSsoKeeper({
                identity: IDENTITY,
                provider: 'google',
                sub: 'google-sub-12345',
                idToken: 'mock-jwt-token',
                nonce: 'mock-nonce',
            });

            const sso = depositedSsoShare();
            const opened = await openShareFromSso(sso, 'google', 'google-sub-12345');
            expect(Array.from(opened)).toEqual(Array.from(new Uint8Array(32).fill(9)));
        });

        it('enrols with a 48-byte PKCS8 key (PWA-origin) and produces the same decrypted seed as the equivalent 32-byte seed', async () => {
            mockNode();

            // 1. Enrol with 32-byte seed identity
            const rawResult = await enrolSsoKeeper({
                identity: IDENTITY,
                provider: 'google',
                sub: 'google-sub-12345',
                idToken: 'mock-jwt-token',
                nonce: 'mock-nonce',
            });
            const rawSso = depositedSsoShare();
            const rawOpened = await openShareFromSso(rawSso, 'google', 'google-sub-12345');

            // 2. Enrol with 48-byte PKCS8 identity
            vi.clearAllMocks();
            mockNode();

            const pkcs8Bytes = toEd25519Pkcs8(Buffer.from(IDENTITY.privateKey, 'hex'));
            expect(pkcs8Bytes.length).toBe(48);
            const pwaIdentity = {
                ...IDENTITY,
                privateKey: Buffer.from(pkcs8Bytes).toString('hex'),
            };
            expect(pwaIdentity.privateKey.length).toBe(96); // 48 hex bytes

            const pkcs8Result = await enrolSsoKeeper({
                identity: pwaIdentity,
                provider: 'google',
                sub: 'google-sub-12345',
                idToken: 'mock-jwt-token',
                nonce: 'mock-nonce',
            });

            expect(pkcs8Result.error).toBeUndefined();
            expect(pkcs8Result.enrolled).toEqual(rawResult.enrolled);
            expect(pkcs8Result.generation).toEqual(rawResult.generation);
            expect(pkcs8Result.available).toEqual(rawResult.available);

            const pkcs8Sso = depositedSsoShare();
            const pkcs8Opened = await openShareFromSso(pkcs8Sso, 'google', 'google-sub-12345');
            expect(Array.from(pkcs8Opened)).toEqual(Array.from(rawOpened));
        });

        it('rejects an invalid private key with a clear error', async () => {
            const invalidIdentity = {
                ...IDENTITY,
                privateKey: '12345678', // 4 bytes
            };
            const result = await enrolSsoKeeper({
                identity: invalidIdentity,
                provider: 'google',
                sub: 'google-sub-12345',
                idToken: 'mock-jwt-token',
                nonce: 'mock-nonce',
            });
            expect(result.enrolled).toEqual([]);
            expect(result.error).toContain('could not read the private key');
        });

        // GitHub's proof is the node's own finished device-flow session (S2): a GitHub token proves
        // nothing a node can check, so the deposit names the session and carries no token and no nonce.
        it('a GitHub deposit carries proof: { sessionId } and no idToken or nonce', async () => {
            mockNode();

            const result = await enrolSsoKeeper({
                identity: IDENTITY,
                provider: 'github',
                sub: '987654',
                proof: { sessionId: 'node-session-1' },
            });

            expect(result.error).toBeUndefined();
            expect(result.enrolled).toEqual(['sso']);
            const call = (signedPost as any).mock.calls.find((c: any[]) => c[1] === '/api/recovery/shares/sso');
            expect(call[2].provider).toBe('github');
            expect(call[2].proof).toEqual({ sessionId: 'node-session-1' });
            expect(call[2]).not.toHaveProperty('idToken');
            expect(call[2]).not.toHaveProperty('nonce');
            // Sealed to the `sub` the node read from GitHub, which is what recovery opens it with.
            const opened = await openShareFromSso(depositedSsoShare(), 'github', '987654');
            expect(Array.from(opened)).toEqual(Array.from(new Uint8Array(32).fill(9)));
        });

        it('refuses a GitHub deposit that carries a token instead of the node session, and sends nothing', async () => {
            mockNode();

            const result = await enrolSsoKeeper({
                identity: IDENTITY,
                provider: 'github',
                sub: '987654',
                idToken: 'gho_token_from_anywhere',
                nonce: 'mock-nonce',
            } as any);

            expect(result.enrolled).toEqual([]);
            expect(result.error).toMatch(/GitHub/);
            expect(signedPost).not.toHaveBeenCalled();
        });

        it('an Apple, Google or Facebook deposit sends its idToken and nonce, and no GitHub proof', async () => {
            mockNode();

            await enrolSsoKeeper({
                identity: IDENTITY,
                provider: 'google',
                sub: 'google-sub-12345',
                idToken: 'mock-jwt-token',
                nonce: 'mock-nonce',
            });

            const call = (signedPost as any).mock.calls.find((c: any[]) => c[1] === '/api/recovery/shares/sso');
            expect(call[2]).toMatchObject({ provider: 'google', idToken: 'mock-jwt-token', nonce: 'mock-nonce' });
            expect(call[2]).not.toHaveProperty('proof');
        });
    });

    // ---------------------------------------------------------------------------
    // Disconnect
    // ---------------------------------------------------------------------------
    describe('disconnectSsoKeeper', () => {
        it('uses DELETE, which is the verb the route is registered under and the one signed', async () => {
            (signedDelete as any).mockResolvedValueOnce({
                ok: true,
                json: async () => ({ enrolledSso: ['google'] }),
            });

            const result = await disconnectSsoKeeper('apple', IDENTITY);

            expect(result.success).toBe(true);
            expect(result.enrolledSso).toEqual(['google']);
            expect(signedDelete).toHaveBeenCalledWith(
                'https://test.beanpool.org',
                '/api/recovery/shares/sso/apple',
                IDENTITY,
            );
            // A signed POST here 404s: koa-router has no POST at that path.
            expect(signedPost).not.toHaveBeenCalled();
        });

        it('surfaces the node refusing a disconnect that would strand the account', async () => {
            (signedDelete as any).mockResolvedValueOnce({
                ok: false,
                status: 400,
                text: async () => 'would leave this account unrecoverable',
            });

            const result = await disconnectSsoKeeper('google', IDENTITY);

            expect(result.success).toBe(false);
            expect(result.error).toContain('unrecoverable');
        });
    });
});
