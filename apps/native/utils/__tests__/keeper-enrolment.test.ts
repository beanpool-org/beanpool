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
    bytesToHex: (bytes: Uint8Array) => Buffer.from(bytes).toString('hex'),
}));

vi.mock('../node-post', () => ({
    anchorUrl: vi.fn(async () => 'https://test.beanpool.org'),
    signedPost: vi.fn(),
    signedDelete: vi.fn(),
}));

import { ed25519 } from '@noble/curves/ed25519.js';
import {
    enrolKeepers, enrolFriendKeepers, enrolSsoKeeper, disconnectSsoKeeper,
} from '../keeper-enrolment';
import { signedPost, signedDelete, anchorUrl } from '../node-post';
import { readHubShare, recordShareForHub } from '@beanpool/core';

const HUB_FRAGMENT_PATH = '/api/recovery/shares/hub-fragment';

/**
 * Route the `signedPost` mock by path.
 *
 * `enrolSsoKeeper` now makes two calls — it asks for the stored hub fragment before it splits —
 * so `mockResolvedValueOnce` alone would hand the deposit's answer to the hub-fragment request
 * and the assertions would be reading the wrong call.
 *
 * @param hubFragment the `A` the node already holds, or null for an account with no split yet
 */
function mockNode(opts: { hubFragment?: Uint8Array | null; deposit?: any } = {}) {
    const { hubFragment = null, deposit = { ok: true, json: async () => ({ generation: 2 }) } } = opts;
    (signedPost as any).mockImplementation(async (_url: string, path: string) => {
        if (path === HUB_FRAGMENT_PATH) {
            return {
                ok: true,
                json: async () => (hubFragment
                    ? { ...recordShareForHub(hubFragment), hubFragment: recordShareForHub(hubFragment).encryptedShare }
                    : { hubFragment: null }),
            };
        }
        return deposit;
    });
}

/** The hub fragment the client actually deposited, decoded back to bytes. */
function depositedHub(): Uint8Array {
    const call = (signedPost as any).mock.calls.find((c: any[]) => c[1] === '/api/recovery/shares/sso');
    const hub = call[2].shares.find((sh: any) => sh.holderType === 'hub');
    return readHubShare(hub);
}

/** The sealed member half as the client built it, decoded back to bytes. */
function depositedSsoCiphertextLength(): number {
    const call = (signedPost as any).mock.calls.find((c: any[]) => c[1] === '/api/recovery/shares/sso');
    const sso = call[2].shares.find((sh: any) => sh.holderType === 'sso');
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
    // Friend-tier enrolment
    // ---------------------------------------------------------------------------
    describe('enrolFriendKeepers', () => {
        it('rejects if fewer than 2 friends provided', async () => {
            const result = await enrolFriendKeepers({
                identity: IDENTITY,
                friendPublicKeys: ['11'.repeat(32)],
            });
            expect(result.enrolled).toEqual([]);
            expect(result.error).toContain('need at least 2 friends');
        });

        it('rejects if identity has no mnemonic', async () => {
            const result = await enrolFriendKeepers({
                identity: { ...IDENTITY, mnemonic: undefined },
                friendPublicKeys: FRIEND_KEYS,
            });
            expect(result.enrolled).toEqual([]);
            expect(result.error).toContain('no recovery words');
        });

        it('successfully splits and deposits shares with friends', async () => {
            (signedPost as any).mockResolvedValueOnce({
                ok: true,
                json: async () => ({ generation: 1 }),
            });

            const result = await enrolFriendKeepers({
                identity: IDENTITY,
                friendPublicKeys: FRIEND_KEYS,
            });

            expect(result.enrolled).toEqual(['hub', 'member', 'member', 'member']);
            expect(result.generation).toBe(1);
            expect(result.available).toBe(4);
            expect(result.error).toBeUndefined();
            expect(signedPost).toHaveBeenCalledWith(
                'https://test.beanpool.org',
                '/api/recovery/shares',
                expect.objectContaining({
                    shares: expect.arrayContaining([
                        expect.objectContaining({ holderType: 'hub', shareIndex: 1 }),
                        expect.objectContaining({ holderType: 'member', shareIndex: 2 }),
                        expect.objectContaining({ holderType: 'member', shareIndex: 3 }),
                        expect.objectContaining({ holderType: 'member', shareIndex: 4 }),
                    ]),
                }),
                IDENTITY,
            );
        });

        it('handles node HTTP error gracefully', async () => {
            (signedPost as any).mockResolvedValueOnce({
                ok: false,
                status: 400,
                text: async () => 'Invalid share format',
            });

            const result = await enrolFriendKeepers({
                identity: IDENTITY,
                friendPublicKeys: FRIEND_KEYS,
            });

            expect(result.enrolled).toEqual([]);
            expect(result.error).toContain('node refused the fragments (400)');
        });
    });

    // ---------------------------------------------------------------------------
    // SSO-tier enrolment
    // ---------------------------------------------------------------------------
    describe('enrolSsoKeeper', () => {
        it('rejects if identity has no mnemonic', async () => {
            const result = await enrolSsoKeeper({
                identity: { ...IDENTITY, mnemonic: undefined },
                provider: 'google',
                sub: 'google-sub-12345',
                idToken: 'mock-jwt-token',
                nonce: 'mock-nonce',
            });
            expect(result.enrolled).toEqual([]);
            expect(result.error).toContain('no recovery words');
        });

        it('successfully splits and deposits SSO shares', async () => {
            mockNode();

            const result = await enrolSsoKeeper({
                identity: IDENTITY,
                provider: 'google',
                sub: 'google-sub-12345',
                idToken: 'mock-jwt-token',
                nonce: 'mock-nonce',
            });

            expect(result.enrolled).toEqual(['hub', 'sso']);
            expect(result.generation).toBe(2);
            expect(result.available).toBe(2);
            expect(result.error).toBeUndefined();
            expect(signedPost).toHaveBeenCalledWith(
                'https://test.beanpool.org',
                '/api/recovery/shares/sso',
                expect.objectContaining({
                    provider: 'google',
                    idToken: 'mock-jwt-token',
                    nonce: 'mock-nonce',
                    shares: expect.arrayContaining([
                        expect.objectContaining({ holderType: 'hub', shareIndex: 1 }),
                        expect.objectContaining({ holderType: 'sso', shareIndex: 2 }),
                    ]),
                }),
                IDENTITY,
            );
        });

        it('handles network throw gracefully without throwing', async () => {
            (signedPost as any).mockImplementation(async (_u: string, path: string) => {
                if (path === HUB_FRAGMENT_PATH) return { ok: true, json: async () => ({ hubFragment: null }) };
                throw new Error('Network connection timeout');
            });

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

        // ---------------------------------------------------------------------
        // Multi-provider consistency. The bug these cover destroyed accounts:
        // enrolling a SECOND provider used to mint a fresh `A`, which silently
        // invalidated the FIRST provider's fragment, and recovery through it
        // rebuilt a keypair for an account that never existed.
        // ---------------------------------------------------------------------
        it('splits against the hub fragment the account already has', async () => {
            const storedHub = new Uint8Array(32).map((_, i) => (i * 11 + 5) & 0xff);
            mockNode({ hubFragment: storedHub });

            const result = await enrolSsoKeeper({
                identity: IDENTITY,
                provider: 'apple',
                sub: 'apple-sub-12345',
                idToken: 'mock-jwt-token',
                nonce: 'mock-nonce',
            });

            expect(result.error).toBeUndefined();
            // Byte-identical, not merely present: any other value strands whichever
            // provider was enrolled first.
            expect(Array.from(depositedHub())).toEqual(Array.from(storedHub));
        });

        it('asks the node for the existing fragment before it splits', async () => {
            mockNode();
            await enrolSsoKeeper({
                identity: IDENTITY, provider: 'google', sub: 's', idToken: 't', nonce: 'n',
            });
            const paths = (signedPost as any).mock.calls.map((c: any[]) => c[1]);
            expect(paths[0]).toBe(HUB_FRAGMENT_PATH);
            expect(paths[1]).toBe('/api/recovery/shares/sso');
        });

        it('mints a fresh hub fragment when the account has none yet', async () => {
            mockNode({ hubFragment: null });

            const result = await enrolSsoKeeper({
                identity: IDENTITY, provider: 'google', sub: 's', idToken: 't', nonce: 'n',
            });

            expect(result.error).toBeUndefined();
            expect(depositedHub().length).toBe(32);
            expect(depositedSsoCiphertextLength()).toBeGreaterThan(0);
        });

        it('refuses to split rather than replace a hub fragment it cannot read', async () => {
            (signedPost as any).mockImplementation(async (_u: string, path: string) => {
                if (path === HUB_FRAGMENT_PATH) {
                    // A fragment written by a newer client, or a different keeper type.
                    return { ok: true, json: async () => ({ hubFragment: 'AAAA', kdfParams: '{"alg":"something-else"}' }) };
                }
                return { ok: true, json: async () => ({ generation: 3 }) };
            });

            const result = await enrolSsoKeeper({
                identity: IDENTITY, provider: 'google', sub: 's', idToken: 't', nonce: 'n',
            });

            expect(result.enrolled).toEqual([]);
            expect(result.error).toContain('could not split the seed');
            // The deposit must not have happened at all.
            const paths = (signedPost as any).mock.calls.map((c: any[]) => c[1]);
            expect(paths).not.toContain('/api/recovery/shares/sso');
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
