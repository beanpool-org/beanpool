/**
 * An account the phone holds but can't read is never written over by a new one (verify-audit-key-paths KEY-04).
 *
 * expo-secure-store throws for anything but "not found" (Android DecryptException, iOS KeyChainException), and an item
 * that doesn't parse reads as no account too: `loadIdentity()` answers null, the app goes to Welcome, and "create" used
 * to write a new key over the member's only one. saveIdentity now reads the item first: there but unreadable, or a read
 * that throws, refuses with StoredKeyUnreadableError, unless the member is restoring an account they hold (their 12
 * words or their sign-in, restore-account.ts), which passes `replaceUnreadable`.
 *
 * Nor is a readable DIFFERENT account (the deciding review of #2051, NB1): a fault that has passed by the time "create"
 * writes leaves the member's account readable again, and a new key must not go over it. StoredKeyDiffersError, a kind of
 * StoredKeyUnreadableError. The same account's own writes (a new name, its words added, a legacy copy moved in, a re-key's
 * key, the iPhone's this-device-only move) still go through, compared on the public key alone.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { webcrypto } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

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
import { finishRekey, type RekeyDeps, type RekeySlot } from '../rekey-redeem';

const ITEM = 'sovereign-identity';
// Test key material only, never a real account's.
const ACCOUNT: BeanPoolIdentity = {
    publicKey: 'ab'.repeat(32), privateKey: 'cd'.repeat(32), callsign: 'Kim', createdAt: '2026-10-16T00:00:00.000Z',
    mnemonic: 'legal winner thank year wave sausage worth useful legal winner thank yellow'.split(' '),
};
const RESTORE_WORDS = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'.split(' ');
const UNREADABLE = '{"publicKey":"ab';
const OTHER_KEY = 'ef'.repeat(32);

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

    it('nothing changes for a phone with no account, or the same account: a new account is made, a new name is kept', async () => {
        const identity = await onPhone(kind);
        const made = await identity.createIdentity('New');
        expect(JSON.parse(store.get(ITEM)!).publicKey).toBe(made.publicKey);

        store.set(ITEM, JSON.stringify(ACCOUNT));
        await expect(identity.updateCallsign('Kimmy')).resolves.toMatchObject({ publicKey: ACCOUNT.publicKey, callsign: 'Kimmy' });
        expect(JSON.parse(store.get(ITEM)!).callsign).toBe('Kimmy');
    });

    it('a readable different account is refused (StoredKeyDiffersError) and kept, unless the member confirmed the replace', async () => {
        store.set(ITEM, JSON.stringify(ACCOUNT));
        const identity = await onPhone(kind);
        const refused = await identity.importIdentity({ ...ACCOUNT, publicKey: OTHER_KEY }).catch((e: unknown) => e);
        expect(refused).toBeInstanceOf(identity.StoredKeyDiffersError);
        // A kind of the unreadable refusal: every screen that catches that one says the same sentence.
        expect(refused).toBeInstanceOf(identity.StoredKeyUnreadableError);
        await expect(identity.createIdentity('New')).rejects.toBeInstanceOf(identity.StoredKeyDiffersError);
        await expect(identity.createIdentityFromMnemonic(RESTORE_WORDS, 'New')).rejects.toBeInstanceOf(identity.StoredKeyDiffersError);
        expect(store.get(ITEM)).toBe(JSON.stringify(ACCOUNT));
        expect(secure.setItemAsync).not.toHaveBeenCalled();

        // The replace restore-account.ts asked the member about goes over it.
        await identity.importIdentity({ ...ACCOUNT, publicKey: OTHER_KEY }, { replaceUnreadable: true });
        expect(JSON.parse(store.get(ITEM)!).publicKey).toBe(OTHER_KEY);
    });

    it('Welcome\'s race: the item reads as no account, the fault passes, and "create" is refused rather than written over it', async () => {
        store.set(ITEM, JSON.stringify(ACCOUNT));
        secure.getItemAsync.mockImplementationOnce(async () => { throw new Error('KeyChainException: interaction not allowed'); });
        const identity = await onPhone(kind);
        // Welcome's read (welcome.tsx handleCreate) sees no account...
        await expect(identity.loadIdentity()).resolves.toBeNull();
        // ...and by the write the member's account reads again.
        await expect(identity.createIdentity('New')).rejects.toBeInstanceOf(identity.StoredKeyDiffersError);
        expect(store.get(ITEM)).toBe(JSON.stringify(ACCOUNT));
        expect(secure.setItemAsync).not.toHaveBeenCalled();
        await expect(identity.loadIdentity()).resolves.toEqual(ACCOUNT);
    });
});

describe.each(['android', 'ios'] as const)('on %s: the same account\'s own writes still go through', (kind) => {
    it('the same public key in another spelling is the same account: compared lower case, trimmed', async () => {
        store.set(ITEM, JSON.stringify({ ...ACCOUNT, publicKey: ACCOUNT.publicKey.toUpperCase() }));
        const identity = await onPhone(kind);
        await identity.importIdentity({ ...ACCOUNT, callsign: 'Kim 2' });
        expect(JSON.parse(store.get(ITEM)!)).toEqual({ ...ACCOUNT, callsign: 'Kim 2' });
        store.set(ITEM, JSON.stringify({ ...ACCOUNT, publicKey: ` ${ACCOUNT.publicKey} ` }));
        await identity.importIdentity({ ...ACCOUNT, callsign: 'Kim 3' });
        expect(JSON.parse(store.get(ITEM)!).callsign).toBe('Kim 3');
    });

    it('a new name (updateCallsign) and the 12 words added back (addMnemonicToIdentity)', async () => {
        const identity = await onPhone(kind);
        const made = await identity.createIdentityFromMnemonic(RESTORE_WORDS, 'Kim');
        await expect(identity.updateCallsign('Kimmy')).resolves.toMatchObject({ publicKey: made.publicKey, callsign: 'Kimmy' });
        // A sign-in restore from before copies carried the words: the key, no words.
        store.set(ITEM, JSON.stringify({ ...made, callsign: 'Kimmy', mnemonic: undefined }));
        await expect(identity.addMnemonicToIdentity(RESTORE_WORDS)).resolves.toMatchObject({ ok: true });
        expect(JSON.parse(store.get(ITEM)!)).toMatchObject({ publicKey: made.publicKey, callsign: 'Kimmy', mnemonic: RESTORE_WORDS });
    });

    it('a legacy copy moves in onto an empty phone and is renamed after; over another account it is refused and both stay', async () => {
        const legacy = new Map<string, string>([['beanpool:identity', JSON.stringify(ACCOUNT)]]);
        const storage = {
            getItem: async (key: string) => legacy.get(key) ?? null,
            removeItem: async (key: string) => { legacy.delete(key); },
        };
        const identity = await onPhone(kind);
        await identity.migrateLegacyIdentity(storage);
        expect(JSON.parse(store.get(ITEM)!)).toEqual(ACCOUNT);
        expect(legacy.has('beanpool:identity')).toBe(false);
        await expect(identity.updateCallsign('Kim 2')).resolves.toMatchObject({ publicKey: ACCOUNT.publicKey, callsign: 'Kim 2' });

        // The same legacy copy again, onto its own account: the same key, written as before.
        legacy.set('beanpool:identity', JSON.stringify(ACCOUNT));
        await identity.migrateLegacyIdentity(storage);
        expect(legacy.has('beanpool:identity')).toBe(false);

        // Another account's legacy copy never goes over the one the phone holds, readable or not; it stays for the next read.
        const theirs = JSON.stringify({ ...ACCOUNT, publicKey: OTHER_KEY });
        for (const held of [JSON.stringify(ACCOUNT), UNREADABLE]) {
            store.set(ITEM, held);
            legacy.set('beanpool:identity', theirs);
            await identity.migrateLegacyIdentity(storage);
            expect(store.get(ITEM)).toBe(held);
            expect(legacy.get('beanpool:identity')).toBe(theirs);
        }
    });

    it('a re-key (finishRekey) writes the key it made onto an empty phone, and refuses if an account reads there by the write', async () => {
        const identity = await onPhone(kind);
        const draft = await identity.draftIdentity('');
        const slot: RekeySlot = { community: 'https://x.example', code: 'RK-ABCD-1234', publicKey: draft.publicKey, madeHere: true, draft, startedAt: 0 };
        const deps = (loadIdentity: RekeyDeps['loadIdentity']) => ({
            slot: { get: async () => slot, set: async () => {}, clear: vi.fn(async () => {}) },
            loadIdentity, importIdentity: identity.importIdentity,
        }) as unknown as RekeyDeps;

        const done = await finishRekey(slot, { callsign: 'Sam' }, deps(identity.loadIdentity));
        expect(done.newWords).toBe(true);
        expect(JSON.parse(store.get(ITEM)!)).toMatchObject({ publicKey: draft.publicKey, callsign: 'Sam' });

        // The phone's own key, bound: nothing written, the stored account answered.
        const own: RekeySlot = { ...slot, madeHere: false, draft: undefined };
        vi.mocked(secure.setItemAsync).mockClear();
        await expect(finishRekey(own, { callsign: 'Sam' }, deps(identity.loadIdentity))).resolves.toMatchObject({ newWords: false });
        expect(secure.setItemAsync).not.toHaveBeenCalled();

        // finishRekey's read saw no account (a passing fault), and the member's account reads again by the write.
        store.set(ITEM, JSON.stringify(ACCOUNT));
        await expect(finishRekey(slot, { callsign: 'Sam' }, deps(async () => null))).rejects.toBeInstanceOf(identity.StoredKeyDiffersError);
        expect(store.get(ITEM)).toBe(JSON.stringify(ACCOUNT));
    });

    it('after the iPhone\'s this-device-only move, and part-way through one (the key only in its copy), the account is renamed', async () => {
        const identity = await onPhone(kind);
        const record = new Map<string, string>();
        const moveRecord = { getItem: async (k: string) => record.get(k) ?? null, setItem: async (k: string, v: string) => { record.set(k, v); } };
        store.set(ITEM, JSON.stringify(ACCOUNT));
        await expect(identity.keepKeyOnThisPhone(moveRecord)).resolves.toBe(kind === 'ios' ? 'moved' : 'not-needed');
        await expect(identity.updateCallsign('Kim 2')).resolves.toMatchObject({ publicKey: ACCOUNT.publicKey, callsign: 'Kim 2' });
        expect(JSON.parse(store.get(ITEM)!).callsign).toBe('Kim 2');

        if (kind !== 'ios') return;
        // A move stopped after the old item went: reads, and the guard's read, find the copy; the same key is written.
        store.delete(ITEM);
        store.set(identity.KEY_ID_MOVING, JSON.stringify(ACCOUNT));
        await expect(identity.updateCallsign('Kim 3')).resolves.toMatchObject({ publicKey: ACCOUNT.publicKey, callsign: 'Kim 3' });
        expect(JSON.parse(store.get(ITEM)!).callsign).toBe('Kim 3');
        // ...and another account is still refused over that copy.
        store.delete(ITEM);
        await expect(identity.importIdentity({ ...ACCOUNT, publicKey: OTHER_KEY })).rejects.toBeInstanceOf(identity.StoredKeyDiffersError);
        expect(store.has(ITEM)).toBe(false);
    });
});

describe('every write of the phone\'s key, by file', () => {
    const root = path.resolve(__dirname, '..', '..');
    const sources = (): Map<string, string> => {
        const out = new Map<string, string>();
        const walk = (dir: string) => {
            for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
                if (e.name === 'node_modules' || e.name === '__tests__' || e.name.startsWith('.')) continue;
                const p = path.join(dir, e.name);
                if (e.isDirectory()) walk(p);
                else if (/\.(ts|tsx)$/.test(e.name)) out.set(path.relative(root, p), fs.readFileSync(p, 'utf8'));
            }
        };
        walk(root);
        return out;
    };

    it('is one of the known callers, and only a restore passes the confirmed replace; Link a device writes no key on the phone', () => {
        const writers: string[] = [];
        const confirmed: string[] = [];
        for (const [file, text] of sources()) {
            if (/\b(importIdentity|createIdentity|createIdentityFromMnemonic|saveIdentity|migrateLegacyIdentity)\s*\(/.test(text)) writers.push(file);
            if (/replaceUnreadable:\s*true/.test(text)) confirmed.push(file);
        }
        // A new caller is looked at here: does it check the phone's account first, and is a replace ever confirmed?
        expect(writers.sort()).toEqual([
            'app/welcome.tsx',          // createIdentity, only when Welcome read no account (handleCreate)
            'utils/global-join.ts',     // commitJoinKey, keepJoinedIdentity: the stored key or none
            'utils/identity.ts',
            'utils/rekey-redeem.ts',    // finishRekey: the key it made, only onto no account
            'utils/restore-account.ts', // saveRestoredAccount, after clearToRestore asked the member
        ]);
        expect(confirmed).toEqual(['utils/restore-account.ts']);
        // "Use your account on another device" sends the phone's account; nothing on the phone receives one.
        for (const file of ['app/pair-device.tsx', 'utils/pair-link.ts', 'utils/pair-device-target.ts']) {
            expect(sources().has(file)).toBe(true);
            expect(writers).not.toContain(file);
        }
    });
});
