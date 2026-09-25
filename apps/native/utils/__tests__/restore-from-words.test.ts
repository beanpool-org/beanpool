/**
 * A 12-word restore goes through the same gate as a sign-in restore (utils/restore-account.ts): onto a phone that holds
 * another account it asks first, and Cancel keeps the key, its onboarding record and its community. Onto a phone with
 * no account, or with this same account, it restores as it always did.
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

import { restoreFromWords } from '../restore-account';
import { draftIdentity, importIdentity, loadIdentity, type BeanPoolIdentity } from '../identity';
import { mnemonicToKeypair } from '../crypto';
import { getPendingOnboarding, setPendingOnboarding } from '../onboarding-state';

// Test phrase only (a BIP-39 vector), never a real account's.
const WORDS = 'legal winner thank year wave sausage worth useful legal winner thank yellow'.split(' ');
const NODE = 'https://test.beanpool.org';
const MULLUM = 'https://mullum.beanpool.org';
const ANCHOR = 'beanpool_anchor_url';
const INVITE_RECORD = { step: 'profileSetup' as const, inviteCode: 'INV-ABC', anchorUrl: MULLUM, callsign: 'Kim', redeemed: true };

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
}

async function expectPhoneKept() {
    expect(await loadIdentity()).toEqual(phone);
    expect(await getPendingOnboarding()).toEqual(INVITE_RECORD);
    expect(mem.async.get(ANCHOR)).toBe(MULLUM);
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

    it('no account on the phone: restores as it always did, never asking; a node that can\'t say leaves the name empty', async () => {
        const confirmReplace = vi.fn(async (_outgoing: BeanPoolIdentity) => false);

        const restored = await restoreFromWords(WORDS, NODE, { confirmReplace, nameOnNode: async () => null });

        expect(confirmReplace).not.toHaveBeenCalled();
        expect(restored).toMatchObject({ publicKey: restoredPub, callsign: '', mnemonic: WORDS });
        expect(await loadIdentity()).toMatchObject({ publicKey: restoredPub, callsign: '' });
        expect(mem.async.get(ANCHOR)).toBe(NODE);
    });
});
