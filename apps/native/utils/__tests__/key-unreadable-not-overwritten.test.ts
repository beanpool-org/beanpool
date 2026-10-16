/**
 * An account the phone holds but can't read is never written over by a new one (verify-audit-key-paths KEY-04).
 *
 * expo-secure-store throws for anything but "not found" (Android DecryptException, iOS KeyChainException), and an item
 * that doesn't parse reads as no account too: `loadIdentity()` answers null, the app goes to Welcome, and "create" used
 * to write a new key over the member's only one. saveIdentity now reads the item first: there but unreadable, or a read
 * that throws, refuses with StoredKeyUnreadableError, unless the member is restoring an account they hold (their 12
 * words or their sign-in, restore-account.ts), which passes `replaceUnreadable`.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { webcrypto } from 'node:crypto';

const os = vi.hoisted(() => ({ current: 'android' as 'ios' | 'android' }));
vi.mock('react-native', () => ({ Platform: { get OS() { return os.current; } } }));
vi.mock('expo-crypto', () => ({
    getRandomBytes: (n: number) => webcrypto.getRandomValues(new Uint8Array(n)),
}));
const store = vi.hoisted(() => new Map<string, string>());
const secure = vi.hoisted(() => ({ getItemAsync: vi.fn(), setItemAsync: vi.fn(), deleteItemAsync: vi.fn() }));
vi.mock('expo-secure-store', () => ({ WHEN_UNLOCKED: 5, WHEN_UNLOCKED_THIS_DEVICE_ONLY: 6, ...secure }));
vi.mock('@react-native-async-storage/async-storage', () => ({
    default: { getItem: vi.fn(async () => null), setItem: vi.fn(), removeItem: vi.fn() },
}));

import type { BeanPoolIdentity } from '../identity';

const ITEM = 'sovereign-identity';
// Test key material only, never a real account's.
const ACCOUNT: BeanPoolIdentity = {
    publicKey: 'ab'.repeat(32), privateKey: 'cd'.repeat(32), callsign: 'Kim', createdAt: '2026-10-16T00:00:00.000Z',
    mnemonic: 'legal winner thank year wave sausage worth useful legal winner thank yellow'.split(' '),
};
const RESTORE_WORDS = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'.split(' ');
const UNREADABLE = '{"publicKey":"ab';

async function onPhone(kind: 'ios' | 'android') {
    os.current = kind;
    vi.resetModules();
    return import('../identity');
}

beforeEach(() => {
    store.clear();
    secure.getItemAsync.mockReset().mockImplementation(async (key: string) => store.get(key) ?? null);
    secure.setItemAsync.mockReset().mockImplementation(async (key: string, value: string) => { store.set(key, value); });
    secure.deleteItemAsync.mockReset().mockImplementation(async (key: string) => { store.delete(key); });
});

describe.each(['android', 'ios'] as const)('on %s: an account the phone can\'t read is never written over', (kind) => {
    it('a new account is refused over an item that is there but does not read as an account, and the item is kept', async () => {
        store.set(ITEM, UNREADABLE);
        const identity = await onPhone(kind);
        await expect(identity.loadIdentity()).resolves.toBeNull();
        await expect(identity.createIdentity('New')).rejects.toBeInstanceOf(identity.StoredKeyUnreadableError);
        expect(store.get(ITEM)).toBe(UNREADABLE);
        expect(secure.setItemAsync).not.toHaveBeenCalled();
    });

    it('a new account is refused when reading the item throws, and nothing is written', async () => {
        store.set(ITEM, JSON.stringify(ACCOUNT));
        secure.getItemAsync.mockImplementation(async () => { throw new Error('DecryptException: could not decrypt the value'); });
        const identity = await onPhone(kind);
        await expect(identity.loadIdentity()).resolves.toBeNull();
        await expect(identity.createIdentity('New')).rejects.toBeInstanceOf(identity.StoredKeyUnreadableError);
        await expect(identity.importIdentity({ ...ACCOUNT, publicKey: 'ef'.repeat(32) })).rejects.toBeInstanceOf(identity.StoredKeyUnreadableError);
        expect(store.get(ITEM)).toBe(JSON.stringify(ACCOUNT));
        expect(secure.setItemAsync).not.toHaveBeenCalled();
    });

    it('a restore the member asked for (their words or their sign-in) still replaces the unreadable item', async () => {
        store.set(ITEM, UNREADABLE);
        const identity = await onPhone(kind);
        const restored = await identity.createIdentityFromMnemonic(RESTORE_WORDS, 'Kim', { replaceUnreadable: true });
        expect(JSON.parse(store.get(ITEM)!).publicKey).toBe(restored.publicKey);
        store.set(ITEM, UNREADABLE);
        await identity.importIdentity(ACCOUNT, { replaceUnreadable: true });
        expect(JSON.parse(store.get(ITEM)!)).toEqual(ACCOUNT);
    });

    it('nothing changes for a phone with no account, or a readable one: the same key or a confirmed other is written', async () => {
        const identity = await onPhone(kind);
        const made = await identity.createIdentity('New');
        expect(JSON.parse(store.get(ITEM)!).publicKey).toBe(made.publicKey);

        store.set(ITEM, JSON.stringify(ACCOUNT));
        await expect(identity.updateCallsign('Kimmy')).resolves.toMatchObject({ publicKey: ACCOUNT.publicKey, callsign: 'Kimmy' });
        expect(JSON.parse(store.get(ITEM)!).callsign).toBe('Kimmy');
        // A readable different account is the confirm-replace screen's to decide (restore-account.ts), as before.
        await identity.importIdentity({ ...ACCOUNT, publicKey: 'ef'.repeat(32) });
        expect(JSON.parse(store.get(ITEM)!).publicKey).toBe('ef'.repeat(32));
    });
});
