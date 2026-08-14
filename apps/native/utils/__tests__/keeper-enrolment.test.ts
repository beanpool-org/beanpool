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
}));

import { enrolKeepers, enrolFriendKeepers, enrolSsoKeeper } from '../keeper-enrolment';
import { signedPost, anchorUrl } from '../node-post';

const IDENTITY = {
    callsign: 'Alice',
    publicKey: 'aa'.repeat(32),
    privateKey: 'bb'.repeat(32),
    createdAt: '2026-08-14T00:00:00.000Z',
    mnemonic: 'abandon ability able about above absent absorb abstract absurd abuse access accident'.split(' '),
} as any;

const FRIEND_KEYS = [
    '11'.repeat(32),
    '22'.repeat(32),
    '33'.repeat(32),
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
            (signedPost as any).mockResolvedValueOnce({
                ok: true,
                json: async () => ({ generation: 2 }),
            });

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
    });
});
