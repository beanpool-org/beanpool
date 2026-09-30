/**
 * Linking a sign-in (utils/keeper-enrolment.ts): the copy sealed on the phone, and deposited at BeanPool's key vault
 * (key vault design V4). Before V4 the deposit went to the member's community (`/api/recovery/shares/sso`); these are
 * the same properties, held against what the vault receives: fake-vault.ts plays the vault with core's real deposit
 * boxes, so `depositedSsoShare()` is the copy the vault opened from the box the phone sealed to it.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mem = vi.hoisted(() => ({ async: new Map<string, string>(), secure: new Map<string, string>() }));
vi.mock('@react-native-async-storage/async-storage', () => ({
    default: {
        getItem: vi.fn(async (key: string) => mem.async.get(key) ?? null),
        setItem: vi.fn(async (key: string, value: string) => { mem.async.set(key, value); }),
        removeItem: vi.fn(async (key: string) => { mem.async.delete(key); }),
    },
}));

vi.mock('expo-file-system/legacy', () => ({
    documentDirectory: 'file:///docs/',
    EncodingType: { UTF8: 'utf8' },
    writeAsStringAsync: vi.fn(async () => {}),
    deleteAsync: vi.fn(async () => {}),
}));

vi.mock('expo-crypto', async () => {
    const { randomBytes } = await import('node:crypto');
    return { getRandomBytes: vi.fn((len: number) => new Uint8Array(randomBytes(len))) };
});

// The words are read through the identity module (getMnemonic), which imports these at load.
vi.mock('react-native', () => ({ Platform: { OS: 'android' } }));
vi.mock('expo-secure-store', () => ({
    WHEN_UNLOCKED_THIS_DEVICE_ONLY: 6,
    getItemAsync: vi.fn(async (key: string) => mem.secure.get(key) ?? null),
    setItemAsync: vi.fn(async (key: string, value: string) => { mem.secure.set(key, value); }),
    deleteItemAsync: vi.fn(async (key: string) => { mem.secure.delete(key); }),
}));

import { ed25519 } from '@noble/curves/ed25519.js';
import { sha256 } from '@noble/hashes/sha2.js';
import {
    enrolKeepers, enrolSsoKeeper as enrolAtVault, disconnectSsoKeeper, vaultProtection,
} from '../keeper-enrolment';
import { openShareFromSso, openSeedFromSso, isSingleBlobSso, toEd25519Pkcs8 } from '@beanpool/core';
import { vaultTicket, VAULT_MESSAGES } from '../vault';
import { installNetwork, fakeJwt, noVault, useVault, VAULT, type Network } from './fake-vault';

let net: Network;
const originalFetch = globalThis.fetch;

/**
 * Link a sign-in as the sheet does once the provider is done: a deposit ticket from the vault for this key, and a token
 * for `sub` carrying the ticket's hash. A key that can't sign gets no ticket; its deposit is tried with none.
 */
async function enrolSsoKeeper(input: { identity: any; provider: 'google' | 'apple' | 'facebook'; sub: string; idToken?: string; nonce?: string }) {
    let grant = { ticket: 'no-ticket', nonce: 'no-nonce' };
    try {
        grant = await vaultTicket(input.identity, 'deposit', input.provider);
    } catch {
        // A key it can't read signs nothing: the deposit below refuses it before anything is sent.
    }
    return enrolAtVault({
        identity: input.identity, provider: input.provider, sub: input.sub,
        ticket: grant.ticket, idToken: fakeJwt({ sub: input.sub, nonce: grant.nonce }),
    });
}

/** Nothing to set up: the vault is installed for every test. Kept so each test still says where its deposit goes. */
function mockNode() {}

/** The copy the vault received: opened from the deposit box the phone sealed to its deposit key. */
function depositedSsoShare(): any {
    const copies = [...net.vault.copies.values()];
    return copies[copies.length - 1]?.clientCopy;
}

/** The sealed member half as the client built it, decoded back to bytes. */
function depositedSsoCiphertextLength(): number {
    const sso = depositedSsoShare();
    return Buffer.from(sso.encryptedShare, 'base64').length;
}

/** The deposit requests the phone sent to the vault. */
const deposits = () => net.sent.filter(s => s.origin === VAULT && s.path === '/v1/copies');

const IDENTITY = {
    callsign: 'Alice',
    publicKey: Buffer.from(ed25519.getPublicKey(new Uint8Array(32).fill(9))).toString('hex'),
    privateKey: Buffer.from(new Uint8Array(32).fill(9)).toString('hex'),
    createdAt: '2026-08-14T00:00:00.000Z',
    mnemonic: 'abandon ability able about above absent absorb abstract absurd abuse access accident'.split(' '),
} as any;

afterEach(() => {
    globalThis.fetch = originalFetch;
    noVault();
});

describe('keeper-enrolment.ts', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mem.async.clear();
        mem.secure.clear();
        useVault();
        net = installNetwork();
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
                // A copy at the vault has no community generation (the node's used to).
                expect(result.generation).toBeNull();
                expect(deposits()).toHaveLength(1);
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

            it('deposits for Apple, and the sealed seed opens to this identity\'s key', async () => {
                mockNode();

                const result = await enrolSsoKeeper({
                    identity: WORDLESS,
                    provider: 'apple',
                    sub: 'apple-sub-restored',
                    idToken: 'mock-jwt-token',
                    nonce: 'mock-nonce',
                });

                expect(result.error).toBeUndefined();
                expect(result.enrolled).toEqual(['sso']);
                expect(await openedPublicKey('apple', 'apple-sub-restored')).toBe(WORDLESS.publicKey);
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
                expect(deposits()).toEqual([]);
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

            it.each(['apple', 'facebook'] as const)('seals them for %s too', async (provider) => {
                mockNode();
                const result = await enrolSsoKeeper({ identity: WORDED, provider, sub: '13579', idToken: 'mock-jwt-token', nonce: 'mock-nonce' });
                expect(result.wordsSealed).toBe(true);
                expect((await openSeedFromSso(depositedSsoShare(), provider, '13579')).words).toEqual(WORDS);
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
            expect(result.generation).toBeNull();
            expect(result.available).toBe(1);
            expect(result.error).toBeUndefined();
            // To the vault, signed by this member's key, with one single-blob copy in the box.
            const [deposit] = deposits();
            expect(deposit.url).toBe(`${VAULT}/v1/copies`);
            expect(deposit.headers['X-Public-Key']).toBe(IDENTITY.publicKey);
            expect(deposit.body).toMatchObject({ provider: 'google', ticket: expect.any(String), idToken: expect.any(String), box: { v: 1 } });
            expect(Object.keys(depositedSsoShare()).sort()).toEqual(['encryptedShare', 'kdfParams', 'shareIv', 'shareTag']);
        });

        it('handles network throw gracefully without throwing', async () => {
            // The vault takes the ticket, then doesn't answer the deposit.
            const handle = net.vault.handle.bind(net.vault);
            net.vault.handle = (req) => {
                if (req.path === '/v1/copies') throw new TypeError('Network connection timeout');
                return handle(req);
            };

            const result = await enrolSsoKeeper({
                identity: IDENTITY,
                provider: 'apple',
                sub: 'apple-sub-12345',
                idToken: 'mock-jwt-token',
                nonce: 'mock-nonce',
            });

            expect(result.enrolled).toEqual([]);
            // Was "could not reach the node": the vault's words now, for a member to read.
            expect(result).toMatchObject({ error: VAULT_MESSAGES.unreachable, failure: 'unreachable' });
        });

        it('maps multiple enrolled SSO providers so spare counter does not desync', async () => {
            // Was the node's deposit answer listing both. A deposit at the vault answers for its own sign-in; what
            // protects the account is the vault's status, which Account Protection reads (vaultProtection).
            await enrolSsoKeeper({ identity: IDENTITY, provider: 'google', sub: 'google-sub-12345' });
            await enrolSsoKeeper({ identity: IDENTITY, provider: 'apple', sub: 'apple-sub-12345' });

            const result = await vaultProtection(IDENTITY);

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

            // One copy at the vault, and nothing but the copy in it: no hub row, no holder fields, no second piece.
            expect(deposits()).toHaveLength(1);
            expect(net.vault.copies.size).toBe(1);
            expect(Object.keys(depositedSsoShare()).sort()).toEqual(['encryptedShare', 'kdfParams', 'shareIv', 'shareTag']);
            expect(net.sent.some(s => /hub/.test(s.path))).toBe(false);
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

        it('a deposit proves the sign-in with the vault\'s ticket and the provider\'s idToken, and carries only the box', async () => {
            await enrolSsoKeeper({ identity: IDENTITY, provider: 'google', sub: 'google-sub-12345' });

            // Was `{provider, idToken, nonce, shares}` to the community. The vault takes its own ticket (whose hash
            // is the token's nonce, so no nonce field), the token, and the copy sealed in a box to its deposit key.
            const [deposit] = deposits();
            expect(Object.keys(deposit.body).sort()).toEqual(['box', 'idToken', 'provider', 'ticket']);
            const ticketRequest = net.sent.find(s => s.path === '/v1/ticket')!;
            expect(ticketRequest.body).toEqual({ purpose: 'deposit', provider: 'google' });
            expect(JSON.parse(Buffer.from(deposit.body.idToken.split('.')[1], 'base64url').toString()).sub).toBe('google-sub-12345');
            // The copy never travels in the clear.
            expect(deposit.raw).not.toContain(depositedSsoShare().encryptedShare);
        });
    });

    // ---------------------------------------------------------------------------
    // Disconnect
    // ---------------------------------------------------------------------------
    describe('disconnectSsoKeeper', () => {
        it('deletes the copy at the vault, signed by this key, and says what is still linked', async () => {
            // Was a signed DELETE at the community. The vault's route is a signed POST that deletes this key's copy.
            await enrolSsoKeeper({ identity: IDENTITY, provider: 'google', sub: 'google-sub-12345' });
            await enrolSsoKeeper({ identity: IDENTITY, provider: 'apple', sub: 'apple-sub-12345' });

            const result = await disconnectSsoKeeper('apple', IDENTITY);

            expect(result.success).toBe(true);
            expect(result.enrolledSso).toEqual(['google']);
            const del = net.sent.find(s => s.path === '/v1/copies/delete')!;
            expect(del).toMatchObject({ origin: VAULT, method: 'POST', body: { provider: 'apple' } });
            expect(del.headers['X-Public-Key']).toBe(IDENTITY.publicKey);
            expect(net.vault.copiesOf(IDENTITY.publicKey).map(c => c.provider)).toEqual(['google']);
        });

        // Was "in its own words": an answer at the vault's address can't be told from the vault's until it is checked, and
        // a refusal can't be, so the app says it in its own words (PR #1336 review finding 9).
        it('surfaces the vault refusing a disconnect, in the app\'s own words, never the answer\'s text', async () => {
            net.vault.handle = () => ({ status: 400, body: { error: 'Say which sign-in to disconnect, or all.', code: 'bad_provider' } });

            const result = await disconnectSsoKeeper('google', IDENTITY);

            expect(result.success).toBe(false);
            expect(result.error).toBe("BeanPool's key vault couldn't do that (400). Try again later. Your 12 words work any time.");
        });

        it('a paused vault disconnects nothing, and says so', async () => {
            net.vault.locked = true;
            expect(await disconnectSsoKeeper('google', IDENTITY)).toEqual({ success: false, error: VAULT_MESSAGES.paused });
        });
    });
});
