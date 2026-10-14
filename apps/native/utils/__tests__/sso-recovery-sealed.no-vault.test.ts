import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
    KEEPER_ALG_RELEASE,
    recordShareForHub,
    sealReleaseToDevice,
    sealSeedToSso,
    sealShareToSso,
    splitHubAndWhole,
    type SealedShare,
} from '@beanpool/core';

/**
 * The phone's restore at its community, with the copy sealed to the restore's throwaway key (defence review
 * FABLE-sec-sso finding 2). The node here is a stub that seals exactly as the server does (core sealReleaseToDevice,
 * the function routes/recovery-collect.ts calls), to the key that signed the request, and only when asked. The phone
 * must ask, open it with its own key, and restore; take a community from before the seal as it always did; and save
 * nothing when a sealed copy doesn't open with its key. No provider or node is contacted.
 */

vi.mock('react-native', () => ({ Platform: { OS: 'android' } }));
vi.mock('@react-native-async-storage/async-storage', () => ({
    default: { getItem: vi.fn(), setItem: vi.fn(), removeItem: vi.fn() },
}));
vi.mock('expo-secure-store', () => ({
    WHEN_UNLOCKED_THIS_DEVICE_ONLY: 6,
    getItemAsync: vi.fn(),
    setItemAsync: vi.fn(),
    deleteItemAsync: vi.fn(),
}));
vi.mock('expo-crypto', () => ({
    getRandomBytes: vi.fn((len: number) => {
        const out = new Uint8Array(len);
        for (let i = 0; i < len; i++) out[i] = Math.floor(Math.random() * 256);
        return out;
    }),
}));
vi.mock('../sso-signin', () => ({
    signInWithGoogle: vi.fn(),
    signInWithApple: vi.fn(),
    signInWithFacebook: vi.fn(),
}));
vi.mock('../node-post', () => ({ signedPost: vi.fn() }));

import { signedPost } from '../node-post';
import { signInWithGoogle } from '../sso-signin';
import { recoverAccountWithSso, RELEASED_COPY_NOT_OPENED } from '../sso-recovery';
import { seedToKeypair } from '../crypto';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as SecureStore from 'expo-secure-store';

const SUB = '110169484474386276334';
const COLLECTION = 'coll-sealed-1';

function googleToken(sub: string): string {
    const b64 = (s: string) => Buffer.from(s).toString('base64url');
    return `${b64(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))}.${b64(JSON.stringify({ iss: 'https://accounts.google.com', sub }))}.sig`;
}

interface Stored { holderType: 'sso' | 'hub'; shareIndex: number; copy: SealedShare }
interface Seen { path: string; body: any; signer: string }

/**
 * A community's recovery routes. `seals`: it seals a listed copy to the requesting key when asked (a node with the
 * seal) or never (one from before). `sealTo` overrides the key it seals to, as a node that got it wrong would.
 */
function community(stored: Stored[], opts: { seals: boolean; sealTo?: string; sealFor?: string }): Seen[] {
    const seen: Seen[] = [];
    (signInWithGoogle as any).mockResolvedValue({ idToken: googleToken(SUB), nonce: 'n-1' });
    (signedPost as any).mockImplementation(async (_url: string, path: string, body: any, signer: { publicKey: string }) => {
        seen.push({ path, body, signer: signer.publicKey });
        const ok = (b: unknown) => ({ ok: true, status: 200, json: async () => b });
        if (path === '/api/recovery/collect') return ok({ collectionId: COLLECTION, threshold: stored.length === 1 ? 1 : 2 });
        if (path === '/api/recovery/collect/sso-nonce') return ok({ nonce: 'n-1', expiresInSeconds: 600 });
        if (path === '/api/recovery/collect/sso') return ok({ collected: 1 });
        if (path === '/api/recovery/collect/hub') return ok({ collected: 2 });
        if (path === '/api/recovery/collect/fragments') {
            const sealIt = opts.seals && body?.seal === KEEPER_ALG_RELEASE;
            return ok({
                collected: stored.length,
                fragments: stored.map(({ holderType, shareIndex, copy }) => {
                    if (!sealIt) {
                        return { holderType, shareIndex, payload: copy.encryptedShare, payloadIv: copy.shareIv, payloadTag: copy.shareTag,
                            ephemeralPubkey: null, kdfParams: copy.kdfParams };
                    }
                    const s = sealReleaseToDevice(
                        { encryptedShare: copy.encryptedShare, shareIv: copy.shareIv, shareTag: copy.shareTag, kdfParams: copy.kdfParams },
                        opts.sealTo ?? signer.publicKey,
                        { collectionId: opts.sealFor ?? COLLECTION, holderType },
                    );
                    return { holderType, shareIndex, payload: s.encryptedShare, payloadIv: s.shareIv, payloadTag: s.shareTag,
                        ephemeralPubkey: s.ephemeralPubkey, kdfParams: s.kdfParams };
                }),
            });
        }
        throw new Error(`Unexpected path: ${path}`);
    });
    return seen;
}

const restore = () => recoverAccountWithSso({ callsign: 'Monnunit', anchorUrl: 'https://test.beanpool.org', provider: 'google' });

function nothingSaved(): void {
    expect(SecureStore.setItemAsync).not.toHaveBeenCalledWith('sovereign-identity', expect.anything(), expect.anything());
    expect(AsyncStorage.setItem).not.toHaveBeenCalledWith('beanpool_anchor_url', expect.anything());
}

describe('the copy comes back sealed to the restore, and only this phone opens it', () => {
    beforeEach(() => vi.clearAllMocks());

    it('asks for it sealed, with the key that opened the session, opens it, and restores the account', async () => {
        const seed = new Uint8Array(32).fill(42);
        const account = await seedToKeypair(seed);
        const seen = community([{ holderType: 'sso', shareIndex: 1, copy: await sealSeedToSso(seed, 'google', SUB) }], { seals: true });

        const result = await restore();
        expect(result.identity.publicKey).toBe(account.publicKeyHex);
        const asked = seen.find(s => s.path === '/api/recovery/collect/fragments');
        expect(asked?.body).toEqual({ collectionId: COLLECTION, seal: KEEPER_ALG_RELEASE });
        expect(asked?.signer).toBe(seen.find(s => s.path === '/api/recovery/collect')?.signer);
        expect(asked?.signer).not.toBe(account.publicKeyHex);
    });

    it('opens both pieces of an old two-part copy, each sealed to the restore', async () => {
        const seed = new Uint8Array(32).fill(7);
        const account = await seedToKeypair(seed);
        const { hubShare, otherHalf } = await splitHubAndWhole(seed);
        const seen = community([
            { holderType: 'sso', shareIndex: 2, copy: await sealShareToSso(otherHalf, 'google', SUB) },
            { holderType: 'hub', shareIndex: 1, copy: recordShareForHub(hubShare) },
        ], { seals: true });

        expect((await restore()).identity.publicKey).toBe(account.publicKeyHex);
        expect(seen.filter(s => s.path === '/api/recovery/collect/fragments').map(s => s.body?.seal))
            .toEqual([KEEPER_ALG_RELEASE, KEEPER_ALG_RELEASE]);
    });

    it('a community from before the seal sends the copy as stored, and the restore works as it always did', async () => {
        const seed = new Uint8Array(32).fill(42);
        const account = await seedToKeypair(seed);
        community([{ holderType: 'sso', shareIndex: 1, copy: await sealSeedToSso(seed, 'google', SUB) }], { seals: false });
        expect((await restore()).identity.publicKey).toBe(account.publicKeyHex);
    });

    it('a copy sealed to another key, or for another session, saves nothing', async () => {
        const seed = new Uint8Array(32).fill(42);
        const copy = await sealSeedToSso(seed, 'google', SUB);
        const someoneElse = (await seedToKeypair(new Uint8Array(32).fill(3))).publicKeyHex;

        community([{ holderType: 'sso', shareIndex: 1, copy }], { seals: true, sealTo: someoneElse });
        await expect(restore()).rejects.toThrow(RELEASED_COPY_NOT_OPENED);
        nothingSaved();

        vi.clearAllMocks();
        community([{ holderType: 'sso', shareIndex: 1, copy }], { seals: true, sealFor: 'coll-other' });
        await expect(restore()).rejects.toThrow(RELEASED_COPY_NOT_OPENED);
        nothingSaved();
    });
});
