/**
 * A sign-in restore never writes another account over the one this phone holds without asking (G7 follow-up, 4106492051).
 *
 * The likeliest victim: an invite join has just redeemed a key at a local node and its 12 words were never shown, then
 * "Restore my account" → "Recover with Social" brings back a different account. Before, `importIdentity` replaced that key
 * with no "Replace this phone's account?" screen, and the community kept a member nobody could use.
 *
 * Replace takes the old account's app storage with it (its guest markers, the communities it asked to join, its sync
 * cursors), as the screen said it would, and a replace this phone then can't save leaves neither account (#1179
 * review 4109902595).
 *
 * Nothing here contacts a node or a provider: the node's recovery routes and Google's sheet are stubbed.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('react-native', () => ({ Platform: { OS: 'android' } }));
const mem = vi.hoisted(() => ({ async: new Map<string, string>(), secure: new Map<string, string>() }));
vi.mock('@react-native-async-storage/async-storage', () => ({
    default: {
        getItem: vi.fn(async (key: string) => mem.async.get(key) ?? null),
        setItem: vi.fn(async (key: string, value: string) => { mem.async.set(key, value); }),
        removeItem: vi.fn(async (key: string) => { mem.async.delete(key); }),
        getAllKeys: vi.fn(async () => [...mem.async.keys()]),
        multiRemove: vi.fn(async (keys: string[]) => { keys.forEach((k) => mem.async.delete(k)); }),
    },
}));
vi.mock('expo-secure-store', () => ({
    getItemAsync: vi.fn(async (key: string) => mem.secure.get(key) ?? null),
    setItemAsync: vi.fn(async (key: string, value: string) => { mem.secure.set(key, value); }),
    deleteItemAsync: vi.fn(async (key: string) => { mem.secure.delete(key); }),
}));
vi.mock('expo-crypto', async () => {
    const { randomBytes } = await import('node:crypto');
    return { getRandomBytes: vi.fn((len: number) => new Uint8Array(randomBytes(len))) };
});
vi.mock('../sso-signin', () => ({
    signInWithGoogle: vi.fn(),
    signInWithApple: vi.fn(),
    signInWithFacebook: vi.fn(),
    signInWithGithubViaNode: vi.fn(),
}));
vi.mock('../node-post', () => ({ signedPost: vi.fn() }));

import * as SecureStore from 'expo-secure-store';
import { sealSeedToSso, type SealedShare } from '@beanpool/core';
import { sha256 } from '@noble/hashes/sha2.js';
import { utf8ToBytes } from '@noble/hashes/utils.js';
import { signedPost } from '../node-post';
import { signInWithGoogle } from '../sso-signin';
import { recoverAccountWithSso } from '../sso-recovery';
import { draftIdentity, importIdentity, loadIdentity, type BeanPoolIdentity } from '../identity';
import { ReplaceNotSaved } from '../restore-account';
import { KNOCKS_STORE_KEY } from '../storage-keys';
import { mnemonicToKeypair } from '../crypto';
import { getPendingOnboarding, setPendingOnboarding } from '../onboarding-state';

// Test phrase only (a BIP-39 vector), never a real account's.
const WORDS = 'legal winner thank year wave sausage worth useful legal winner thank yellow'.split(' ');
const SEED = sha256(sha256(utf8ToBytes(WORDS.join(' '))));
const SUB = '110169484474386276334';
const NODE = 'https://test.beanpool.org';
const MULLUM = 'https://mullum.beanpool.org';
const ANCHOR = 'beanpool_anchor_url';
/** An invite join that has just redeemed the phone's key at Mullum: its words not shown yet. */
const INVITE_RECORD = { step: 'profileSetup' as const, inviteCode: 'INV-ABC', anchorUrl: MULLUM, callsign: 'Kim', redeemed: true };
/** What stays through any restore: a list of community addresses, and a setting about the phone, not the member. */
const PHONE_KEPT = { beanpool_saved_nodes: JSON.stringify([{ url: MULLUM, name: 'Mullum' }]), beanpool_light_palette: 'sand' };

/**
 * The app storage an account leaves on the phone: its guest markers, the communities it asked, its sync cursors, its
 * profile (photo, bio, contact) with a photo parked for the next sync, the invite codes it made, an unfinished post,
 * and the reports it has yet to send.
 */
function accountStorage(publicKey: string): Record<string, string> {
    return {
        beanpool_guest_nodes: JSON.stringify(['https://byron.beanpool.org']),
        beanpool_canonical_profile: JSON.stringify({ avatar: 'bundled://koala', bio: 'Grows tomatoes', contactValue: '0400 000 000' }),
        pending_profile_avatar: 'bundled://koala',
        pending_profile_sync: 'true',
        [`bp_offline_invites_${publicKey}`]: JSON.stringify([{ code: 'INV-ABC', intendedFor: 'Robin' }]),
        beanpool_offer_draft: JSON.stringify({ anchorUrl: MULLUM, postTitle: 'Tomatoes', postPhotos: ['bundled://koala'], postLat: -28.55, postLng: 153.5 }),
        beanpool_pending_abuse_reports: JSON.stringify([
            { reporterPubkey: publicKey, targetPubkey: 'cd'.repeat(32), reason: 'User Blocked by Member', timestamp: Date.parse('2026-09-25T00:00:00.000Z') },
        ]),
        [KNOCKS_STORE_KEY]: JSON.stringify({
            pubkey: publicKey,
            knocks: [{ url: 'https://near.example', name: 'Near Home', key: 'k1', sentAt: '2026-09-20T00:00:00.000Z' }],
        }),
        'pillar_sync_beanpool_https___mullum_beanpool_org.db_last-sync': '2026-09-25T00:00:00.000Z',
        'pillar:outbox': '[]',
    };
}

function asyncStorage(): Record<string, string> {
    return Object.fromEntries(mem.async);
}

/** Google hands back a token whose `sub` is SUB; the node releases `sealed` as a single blob. */
function mockSignInAndNode(sealed: SealedShare) {
    const b64 = (s: string) => Buffer.from(s).toString('base64url');
    const token = `${b64(JSON.stringify({ alg: 'RS256' }))}.${b64(JSON.stringify({ sub: SUB }))}.sig`;
    vi.mocked(signInWithGoogle).mockResolvedValue({ idToken: token, nonce: 'n' });
    vi.mocked(signedPost).mockImplementation(async (_url: string, path: string) => {
        const ok = (body: unknown) => ({ ok: true, status: 200, json: async () => body }) as unknown as Response;
        if (path === '/api/recovery/collect') return ok({ collectionId: 'c1', threshold: 1 });
        if (path === '/api/recovery/collect/sso-nonce') return ok({ nonce: 'n' });
        if (path === '/api/recovery/collect/sso') return ok({ collected: 1, threshold: 1, enough: true });
        if (path === '/api/recovery/collect/fragments') {
            return ok({
                collected: 1, threshold: 1, enough: true,
                fragments: [{
                    holderType: 'sso', shareIndex: 1,
                    payload: sealed.encryptedShare, payloadIv: sealed.shareIv, payloadTag: sealed.shareTag,
                    kdfParams: sealed.kdfParams,
                }],
            });
        }
        throw new Error(`Unexpected path: ${path}`);
    });
}

function restore(confirmReplace?: (outgoing: BeanPoolIdentity) => Promise<boolean>) {
    return recoverAccountWithSso({
        callsign: 'Marty', anchorUrl: NODE, provider: 'google', onDeviceCode: () => {},
        ...(confirmReplace ? { confirmReplace } : {}),
    });
}

let phone: BeanPoolIdentity;
let restoredPub: string;
const quietError = console.error;

beforeEach(async () => {
    mem.async.clear();
    mem.secure.clear();
    vi.clearAllMocks();
    // identity.ts's legacy migration reaches AsyncStorage through `require`, which no vi.mock reaches: quietened.
    vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
        if (typeof args[0] === 'string' && args[0].startsWith('Failed to migrate legacy identity')) return;
        quietError(...args);
    });
    restoredPub = (await mnemonicToKeypair(WORDS)).publicKeyHex;
    phone = await draftIdentity('Kim');
});

afterEach(() => {
    vi.restoreAllMocks();
});

/** The phone as an invite join leaves it: Kim's key, Kim's wizard record, Mullum as the community. */
async function phoneWithInviteJoin() {
    await importIdentity(phone);
    await setPendingOnboarding(INVITE_RECORD);
    mem.async.set(ANCHOR, MULLUM);
    for (const [k, v] of Object.entries({ ...accountStorage(phone.publicKey), ...PHONE_KEPT })) mem.async.set(k, v);
}

async function expectPhoneKept() {
    expect(await loadIdentity()).toEqual(phone);
    expect(await getPendingOnboarding()).toEqual(INVITE_RECORD);
    expect(mem.async.get(ANCHOR)).toBe(MULLUM);
    expect(asyncStorage()).toMatchObject({ ...accountStorage(phone.publicKey), ...PHONE_KEPT });
}

describe('a sign-in restore onto a phone that holds another account', () => {
    it('asks first, with the account that would go (its 12 words one tap away), and Cancel keeps everything', async () => {
        mockSignInAndNode(await sealSeedToSso(SEED, 'google', SUB, { words: WORDS }));
        await phoneWithInviteJoin();
        const confirmReplace = vi.fn(async (_outgoing: BeanPoolIdentity) => false);

        await expect(restore(confirmReplace)).rejects.toMatchObject({ reason: 'cancelled' });

        expect(confirmReplace).toHaveBeenCalledTimes(1);
        expect(confirmReplace.mock.calls[0][0]).toEqual(phone);
        expect(confirmReplace.mock.calls[0][0].mnemonic).toEqual(phone.mnemonic);
        await expectPhoneKept();
    });

    it('asks before anything is written, and replaces only when the member says so', async () => {
        mockSignInAndNode(await sealSeedToSso(SEED, 'google', SUB, { words: WORDS }));
        await phoneWithInviteJoin();
        const confirmReplace = vi.fn(async (_outgoing: BeanPoolIdentity) => {
            // The screen is up: nothing has changed on the phone yet.
            await expectPhoneKept();
            return true;
        });

        const result = await restore(confirmReplace);

        expect(confirmReplace).toHaveBeenCalledTimes(1);
        expect(result.identity.publicKey).toBe(restoredPub);
        expect(await loadIdentity()).toMatchObject({ publicKey: restoredPub, mnemonic: WORDS });
        expect(await getPendingOnboarding()).toBeNull();
        expect(mem.async.get(ANCHOR)).toBe(NODE);
    });

    it('Replace: nothing of the old account stays in app storage, only the new account\'s community and the phone\'s own', async () => {
        mockSignInAndNode(await sealSeedToSso(SEED, 'google', SUB, { words: WORDS }));
        await phoneWithInviteJoin();

        await restore(async () => true);

        // Kim's guest markers, the communities Kim asked to join, Kim's sync cursors, Kim's wizard: all gone.
        expect(asyncStorage()).toEqual({ [ANCHOR]: NODE, ...PHONE_KEPT });
        expect(await loadIdentity()).toMatchObject({ publicKey: restoredPub, callsign: 'Marty', mnemonic: WORDS });
    });

    it('a replace this phone can\'t save: Kim\'s account is gone as promised, no success is claimed, and trying again works', async () => {
        mockSignInAndNode(await sealSeedToSso(SEED, 'google', SUB, { words: WORDS }));
        await phoneWithInviteJoin();
        const confirmReplace = vi.fn(async (_outgoing: BeanPoolIdentity) => true);
        const progress: string[] = [];
        // The key write fails: by then the new community's address has been written.
        vi.mocked(SecureStore.setItemAsync).mockRejectedValueOnce(new Error('Keystore unavailable'));

        const failed = recoverAccountWithSso({
            callsign: 'Marty', anchorUrl: NODE, provider: 'google', onDeviceCode: () => {}, confirmReplace,
            onProgress: (p) => progress.push(p.step),
        });

        await expect(failed).rejects.toBeInstanceOf(ReplaceNotSaved);
        await expect(failed).rejects.toThrow('Keystore unavailable');
        expect(progress).not.toContain('done');
        expect(await loadIdentity()).toBeNull();
        expect(await getPendingOnboarding()).toBeNull();
        expect(asyncStorage()).toEqual(PHONE_KEPT);

        // Again: nothing left to ask about, and the account comes back.
        const result = await restore(confirmReplace);

        expect(confirmReplace).toHaveBeenCalledTimes(1);
        expect(result.identity.publicKey).toBe(restoredPub);
        expect(await loadIdentity()).toMatchObject({ publicKey: restoredPub, mnemonic: WORDS });
        expect(asyncStorage()).toEqual({ [ANCHOR]: NODE, ...PHONE_KEPT });
    });

    it('a caller that cannot ask is refused rather than allowed to replace', async () => {
        mockSignInAndNode(await sealSeedToSso(SEED, 'google', SUB, { words: WORDS }));
        await phoneWithInviteJoin();

        await expect(restore()).rejects.toThrow(/different BeanPool account/);

        await expectPhoneKept();
    });

    it('an account with no 12 words on the phone (restored by a sign-in before copies carried them) is asked about the same way', async () => {
        mockSignInAndNode(await sealSeedToSso(SEED, 'google', SUB));
        const noWords: BeanPoolIdentity = { ...phone };
        delete noWords.mnemonic;
        phone = noWords;
        await phoneWithInviteJoin();
        const confirmReplace = vi.fn(async (_outgoing: BeanPoolIdentity) => false);

        await expect(restore(confirmReplace)).rejects.toMatchObject({ reason: 'cancelled' });

        expect(confirmReplace).toHaveBeenCalledTimes(1);
        await expectPhoneKept();
    });
});

describe('a sign-in restore with nothing to replace', () => {
    it('the same account: nothing to ask, and the phone keeps its 12 words when the copy has none', async () => {
        mockSignInAndNode(await sealSeedToSso(SEED, 'google', SUB));
        const keys = await mnemonicToKeypair(WORDS);
        const same: BeanPoolIdentity = { publicKey: keys.publicKeyHex, privateKey: keys.privateKeyHex, callsign: 'Marty', createdAt: '2026-01-01T00:00:00.000Z', mnemonic: WORDS };
        await importIdentity(same);
        const confirmReplace = vi.fn(async (_outgoing: BeanPoolIdentity) => false);

        const result = await restore(confirmReplace);

        expect(confirmReplace).not.toHaveBeenCalled();
        expect(result.identity.mnemonic).toEqual(WORDS);
        expect(await loadIdentity()).toMatchObject({ publicKey: restoredPub, mnemonic: WORDS });
    });

    it('the same account keeps what is its own: its guest markers, the communities it asked, its sync cursors', async () => {
        mockSignInAndNode(await sealSeedToSso(SEED, 'google', SUB, { words: WORDS }));
        const keys = await mnemonicToKeypair(WORDS);
        await importIdentity({ publicKey: keys.publicKeyHex, privateKey: keys.privateKeyHex, callsign: 'Marty', createdAt: '2026-01-01T00:00:00.000Z', mnemonic: WORDS });
        for (const [k, v] of Object.entries({ [ANCHOR]: MULLUM, ...accountStorage(keys.publicKeyHex), ...PHONE_KEPT })) mem.async.set(k, v);

        await restore();

        expect(asyncStorage()).toEqual({ ...accountStorage(keys.publicKeyHex), ...PHONE_KEPT, [ANCHOR]: NODE });
    });

    it('no account on the phone: restores as it always did, never asking', async () => {
        mockSignInAndNode(await sealSeedToSso(SEED, 'google', SUB, { words: WORDS }));
        const confirmReplace = vi.fn(async (_outgoing: BeanPoolIdentity) => false);

        const result = await restore(confirmReplace);

        expect(confirmReplace).not.toHaveBeenCalled();
        expect(result.identity.publicKey).toBe(restoredPub);
        expect(await loadIdentity()).toMatchObject({ publicKey: restoredPub, callsign: 'Marty', mnemonic: WORDS });
        expect(mem.async.get(ANCHOR)).toBe(NODE);
    });
});
