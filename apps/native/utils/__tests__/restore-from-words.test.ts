/**
 * A 12-word restore goes through the same gate as a sign-in restore (utils/restore-account.ts): onto a phone that holds
 * another account it asks first, and Cancel keeps the key, its onboarding record and its community. Onto a phone with
 * no account, or with this same account, it restores as it always did.
 *
 * Replace takes the old account's app storage with it (its guest markers, the communities it asked to join, its sync
 * cursors), as the screen said it would, and a replace this phone then can't save leaves neither account (#1179
 * review 4109902595).
 *
 * Nothing here contacts a node: the node's name for the key is a stub.
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

import * as SecureStore from 'expo-secure-store';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { restoreFromWords, ReplaceNotSaved } from '../restore-account';
import { draftIdentity, importIdentity, loadIdentity, type BeanPoolIdentity } from '../identity';
import { KNOCKS_STORE_KEY } from '../storage-keys';
import { mnemonicToKeypair } from '../crypto';
import { getPendingOnboarding, setPendingOnboarding } from '../onboarding-state';

// Test phrase only (a BIP-39 vector), never a real account's.
const WORDS = 'legal winner thank year wave sausage worth useful legal winner thank yellow'.split(' ');
const NODE = 'https://test.beanpool.org';
const MULLUM = 'https://mullum.beanpool.org';
const ANCHOR = 'beanpool_anchor_url';
const INVITE_RECORD = { step: 'profileSetup' as const, inviteCode: 'INV-ABC', anchorUrl: MULLUM, callsign: 'Kim', redeemed: true };
/** What stays through any restore: a list of community addresses, and a setting about the phone, not the member. */
const PHONE_KEPT = { beanpool_saved_nodes: JSON.stringify([{ url: MULLUM, name: 'Mullum' }]), beanpool_light_palette: 'sand' };

/** The app storage an account leaves on the phone: its guest markers, the communities it asked, its sync cursors. */
function accountStorage(publicKey: string): Record<string, string> {
    return {
        beanpool_guest_nodes: JSON.stringify(['https://byron.beanpool.org']),
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

let phone: BeanPoolIdentity;
let restoredPub: string;
const quietError = console.error;

beforeEach(async () => {
    mem.async.clear();
    mem.secure.clear();
    vi.clearAllMocks();
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

describe('a 12-word restore onto a phone that holds another account', () => {
    it('asks first, with the account that would go, and Cancel keeps everything (the node is not even asked for a name)', async () => {
        await phoneWithInviteJoin();
        const confirmReplace = vi.fn(async (_outgoing: BeanPoolIdentity) => false);
        const nameOnNode = vi.fn(async () => 'Marty');

        await expect(restoreFromWords(WORDS, NODE, { confirmReplace, nameOnNode })).rejects.toMatchObject({ reason: 'cancelled' });

        expect(confirmReplace).toHaveBeenCalledTimes(1);
        expect(confirmReplace.mock.calls[0][0]).toEqual(phone);
        expect(nameOnNode).not.toHaveBeenCalled();
        await expectPhoneKept();
    });

    it('Replace: the restored account under the node\'s name, the old wizard gone, the new community set', async () => {
        await phoneWithInviteJoin();
        const confirmReplace = vi.fn(async (_outgoing: BeanPoolIdentity) => {
            await expectPhoneKept();
            return true;
        });

        const restored = await restoreFromWords(WORDS, NODE, { confirmReplace, nameOnNode: async () => 'Marty' });

        expect(restored).toMatchObject({ publicKey: restoredPub, callsign: 'Marty', mnemonic: WORDS });
        expect(await loadIdentity()).toMatchObject({ publicKey: restoredPub, callsign: 'Marty', mnemonic: WORDS });
        expect(await getPendingOnboarding()).toBeNull();
        expect(mem.async.get(ANCHOR)).toBe(NODE);
    });

    it('Replace: nothing of the old account stays in app storage, only the new account\'s community and the phone\'s own', async () => {
        await phoneWithInviteJoin();

        await restoreFromWords(WORDS, NODE, { confirmReplace: async () => true, nameOnNode: async () => 'Marty' });

        // Kim's guest markers, the communities Kim asked to join, Kim's sync cursors, Kim's wizard: all gone.
        expect(asyncStorage()).toEqual({ [ANCHOR]: NODE, ...PHONE_KEPT });
        expect(await loadIdentity()).toMatchObject({ publicKey: restoredPub, callsign: 'Marty' });
    });

    it('a replace this phone can\'t save: Kim\'s account is gone as promised, no success is claimed, and trying again works', async () => {
        await phoneWithInviteJoin();
        const confirmReplace = vi.fn(async (_outgoing: BeanPoolIdentity) => true);
        // The key write fails: by then the new community's address has been written.
        vi.mocked(SecureStore.setItemAsync).mockRejectedValueOnce(new Error('Keystore unavailable'));

        const failed = restoreFromWords(WORDS, NODE, { confirmReplace, nameOnNode: async () => 'Marty' });

        await expect(failed).rejects.toBeInstanceOf(ReplaceNotSaved);
        await expect(failed).rejects.toThrow('Keystore unavailable');
        expect(await loadIdentity()).toBeNull();
        expect(await getPendingOnboarding()).toBeNull();
        expect(asyncStorage()).toEqual(PHONE_KEPT);

        // Again: nothing left to ask about, and the account comes back.
        const restored = await restoreFromWords(WORDS, NODE, { confirmReplace, nameOnNode: async () => 'Marty' });

        expect(confirmReplace).toHaveBeenCalledTimes(1);
        expect(restored).toMatchObject({ publicKey: restoredPub, callsign: 'Marty', mnemonic: WORDS });
        expect(await loadIdentity()).toMatchObject({ publicKey: restoredPub, callsign: 'Marty', mnemonic: WORDS });
        expect(asyncStorage()).toEqual({ [ANCHOR]: NODE, ...PHONE_KEPT });
    });

    it('a replace whose community address can\'t be saved ends the same way: neither account, and nothing of Kim\'s', async () => {
        await phoneWithInviteJoin();
        vi.mocked(AsyncStorage.setItem).mockRejectedValueOnce(new Error('Disk full'));

        await expect(restoreFromWords(WORDS, NODE, { confirmReplace: async () => true, nameOnNode: async () => 'Marty' }))
            .rejects.toBeInstanceOf(ReplaceNotSaved);

        expect(await loadIdentity()).toBeNull();
        expect(await getPendingOnboarding()).toBeNull();
        expect(asyncStorage()).toEqual(PHONE_KEPT);
    });

    it('a caller that cannot ask is refused rather than allowed to replace', async () => {
        await phoneWithInviteJoin();

        await expect(restoreFromWords(WORDS, NODE, { nameOnNode: async () => 'Marty' })).rejects.toThrow(/different BeanPool account/);

        await expectPhoneKept();
    });
});

describe('a 12-word restore with nothing to replace', () => {
    it('the same account (a phone that lost its words): nothing to ask, and the words come back', async () => {
        const keys = await mnemonicToKeypair(WORDS);
        await importIdentity({ publicKey: keys.publicKeyHex, privateKey: keys.privateKeyHex, callsign: 'Marty', createdAt: '2026-01-01T00:00:00.000Z' });
        const confirmReplace = vi.fn(async (_outgoing: BeanPoolIdentity) => false);

        const restored = await restoreFromWords(WORDS, NODE, { confirmReplace, nameOnNode: async () => 'Marty' });

        expect(confirmReplace).not.toHaveBeenCalled();
        expect(restored.mnemonic).toEqual(WORDS);
        expect(await loadIdentity()).toMatchObject({ publicKey: restoredPub, mnemonic: WORDS });
    });

    it('the same account keeps what is its own: its guest markers, the communities it asked, its sync cursors', async () => {
        const keys = await mnemonicToKeypair(WORDS);
        await importIdentity({ publicKey: keys.publicKeyHex, privateKey: keys.privateKeyHex, callsign: 'Marty', createdAt: '2026-01-01T00:00:00.000Z' });
        for (const [k, v] of Object.entries({ [ANCHOR]: MULLUM, ...accountStorage(keys.publicKeyHex), ...PHONE_KEPT })) mem.async.set(k, v);

        await restoreFromWords(WORDS, NODE, { nameOnNode: async () => 'Marty' });

        expect(asyncStorage()).toEqual({ ...accountStorage(keys.publicKeyHex), ...PHONE_KEPT, [ANCHOR]: NODE });
    });

    it('the same account, when this phone can\'t save it: its key stays, and it is not a ReplaceNotSaved', async () => {
        const keys = await mnemonicToKeypair(WORDS);
        const same: BeanPoolIdentity = { publicKey: keys.publicKeyHex, privateKey: keys.privateKeyHex, callsign: 'Marty', createdAt: '2026-01-01T00:00:00.000Z' };
        await importIdentity(same);
        for (const [k, v] of Object.entries(accountStorage(keys.publicKeyHex))) mem.async.set(k, v);
        vi.mocked(SecureStore.setItemAsync).mockRejectedValueOnce(new Error('Keystore unavailable'));

        const failed = restoreFromWords(WORDS, NODE, { nameOnNode: async () => 'Marty' });

        await expect(failed).rejects.toThrow('Keystore unavailable');
        await expect(failed).rejects.not.toBeInstanceOf(ReplaceNotSaved);
        expect(await loadIdentity()).toEqual(same);
        expect(asyncStorage()).toMatchObject(accountStorage(keys.publicKeyHex));
    });

    it('no account on the phone: restores as it always did, never asking; a node that can\'t say leaves the name empty', async () => {
        const confirmReplace = vi.fn(async (_outgoing: BeanPoolIdentity) => false);

        const restored = await restoreFromWords(WORDS, NODE, { confirmReplace, nameOnNode: async () => null });

        expect(confirmReplace).not.toHaveBeenCalled();
        expect(restored).toMatchObject({ publicKey: restoredPub, callsign: '', mnemonic: WORDS });
        expect(await loadIdentity()).toMatchObject({ publicKey: restoredPub, callsign: '' });
        expect(mem.async.get(ANCHOR)).toBe(NODE);
    });
});
