/**
 * The phone's key and 12 words stay on this phone (identity.ts KEY_ITEM_OPTIONS, keepKeyOnThisPhone).
 *
 * Every write of the item that holds them passes WHEN_UNLOCKED_THIS_DEVICE_ONLY. On an iPhone that setting takes effect
 * only when the item is made, so an item an older build made is made again, once, without ever risking the key: a copy
 * first, proven; then the old item goes, proven gone; then the item is made again, proven; then the copy goes.
 *
 * The SecureStore below behaves as expo-secure-store 55's iOS code does (ios/SecureStoreModule.swift):
 * - a write to a key that has no item makes one with the option's setting (SecItemAdd with kSecAttrAccessible, :89-119);
 * - a write to a key that has one changes its data and keeps its setting (errSecDuplicateItem → SecItemUpdate of
 *   kSecValueData alone, :120-144);
 * - a read or a delete finds the item whatever its setting (the query has no kSecAttrAccessible, :172-192).
 * Items an older build made have WHEN_UNLOCKED, the library's default (ios/SecureStoreOptions.swift:8).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { webcrypto } from 'node:crypto';

const os = vi.hoisted(() => ({ current: 'ios' as 'ios' | 'android' }));
vi.mock('react-native', () => ({ Platform: { get OS() { return os.current; } } }));
vi.mock('expo-crypto', () => ({
    getRandomBytes: (n: number) => webcrypto.getRandomValues(new Uint8Array(n)),
}));

const WHEN_UNLOCKED = 5;
const WHEN_UNLOCKED_THIS_DEVICE_ONLY = 6;
type Item = { value: string; accessible: number };
const keychain = vi.hoisted(() => new Map<string, { value: string; accessible: number }>());
/** The same functions whichever copy of identity.ts is loaded (onPhone reloads it). */
const secure = vi.hoisted(() => ({ getItemAsync: vi.fn(), setItemAsync: vi.fn(), deleteItemAsync: vi.fn() }));
vi.mock('expo-secure-store', () => ({ WHEN_UNLOCKED: 5, WHEN_UNLOCKED_THIS_DEVICE_ONLY: 6, ...secure }));

/** The Keychain as expo-secure-store 55's iOS code treats it (see the top of this file). */
function keychainAsOnAnIPhone(): void {
    secure.getItemAsync.mockReset().mockImplementation(async (key: string) => keychain.get(key)?.value ?? null);
    secure.setItemAsync.mockReset().mockImplementation(async (key: string, value: string, options?: { keychainAccessible?: number }) => {
        const item = keychain.get(key);
        if (item) item.value = value;
        else keychain.set(key, { value, accessible: options?.keychainAccessible ?? WHEN_UNLOCKED });
    });
    secure.deleteItemAsync.mockReset().mockImplementation(async (key: string) => { keychain.delete(key); });
}
vi.mock('@react-native-async-storage/async-storage', () => ({
    default: { getItem: vi.fn(async () => null), setItem: vi.fn(), removeItem: vi.fn() },
}));

import type { BeanPoolIdentity, KeyMoveRecord } from '../identity';
import { IDENTITY_THIS_DEVICE_STORE_KEY } from '../storage-keys';

/** identity.ts as a phone of this kind loads it (it reads the platform once, as it loads). */
async function onPhone(kind: 'ios' | 'android') {
    os.current = kind;
    vi.resetModules();
    return import('../identity');
}

const ITEM = 'sovereign-identity';
const COPY = 'sovereign-identity.moving';
// Test key material only, never a real account's.
const ACCOUNT: BeanPoolIdentity = {
    publicKey: 'ab'.repeat(32), privateKey: 'cd'.repeat(32), callsign: 'Kim', createdAt: '2026-09-29T00:00:00.000Z',
    mnemonic: 'legal winner thank year wave sausage worth useful legal winner thank yellow'.split(' '),
};
const OTHER: BeanPoolIdentity = { ...ACCOUNT, publicKey: 'ef'.repeat(32), privateKey: '01'.repeat(32), callsign: 'Lee' };
const SAVED = JSON.stringify(ACCOUNT);

/** An item made by a build before this one. */
function olderBuildItem(value = SAVED): void {
    keychain.set(ITEM, { value, accessible: WHEN_UNLOCKED });
}

function memoryRecord(): KeyMoveRecord & { map: Map<string, string> } {
    const map = new Map<string, string>();
    return {
        map,
        getItem: vi.fn(async (k: string) => map.get(k) ?? null),
        setItem: vi.fn(async (k: string, v: string) => { map.set(k, v); }),
    };
}

/** The keychain's items, for comparing before and after. */
function snapshot(): Record<string, Item> {
    return Object.fromEntries([...keychain].map(([k, v]) => [k, { ...v }]));
}

beforeEach(() => {
    keychain.clear();
    keychainAsOnAnIPhone();
});

describe('every write of the key passes WHEN_UNLOCKED_THIS_DEVICE_ONLY', () => {
    it('making, restoring, importing, renaming and adding words all write the item this-device-only', async () => {
        const id = await onPhone('ios');
        await id.createIdentity('Kim');
        await id.removeStoredIdentity();
        await id.createIdentityFromMnemonic(ACCOUNT.mnemonic!, 'Kim');
        await id.importIdentity(ACCOUNT);
        await id.updateCallsign('Kim 2');
        // A phone with the key and no words, given its words back.
        const made = await id.createIdentityFromMnemonic(ACCOUNT.mnemonic!, 'Kim');
        await id.removeStoredIdentity();
        await id.importIdentity({ ...made, mnemonic: undefined });
        expect((await id.addMnemonicToIdentity(ACCOUNT.mnemonic!)).ok).toBe(true);

        const writes = vi.mocked(secure.setItemAsync).mock.calls.filter(([key]) => key === ITEM);
        expect(writes.length).toBe(7);
        for (const call of writes) expect(call[2]).toEqual({ keychainAccessible: WHEN_UNLOCKED_THIS_DEVICE_ONLY });
        expect(id.KEY_ITEM_OPTIONS).toEqual({ keychainAccessible: WHEN_UNLOCKED_THIS_DEVICE_ONLY });
    });

    it('a new item is made this-device-only; one an older build made keeps its setting on a plain write (why the move exists)', async () => {
        const id = await onPhone('ios');
        await id.importIdentity(ACCOUNT);
        expect(keychain.get(ITEM)!.accessible).toBe(WHEN_UNLOCKED_THIS_DEVICE_ONLY);

        keychain.clear();
        olderBuildItem();
        await id.updateCallsign('Kim 2');
        expect(keychain.get(ITEM)!.accessible).toBe(WHEN_UNLOCKED);
        expect(JSON.parse(keychain.get(ITEM)!.value).callsign).toBe('Kim 2');
    });

    it('no other code in the app writes, reads or deletes the key item: identity.ts is the only door, and its every write passes the option', () => {
        const root = path.resolve(__dirname, '..', '..');
        const files: string[] = [];
        const walk = (dir: string) => {
            for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
                if (e.name === 'node_modules' || e.name === '__tests__' || e.name.startsWith('.')) continue;
                const p = path.join(dir, e.name);
                if (e.isDirectory()) walk(p);
                else if (/\.(ts|tsx)$/.test(e.name)) files.push(p);
            }
        };
        for (const dir of ['app', 'utils', 'components', 'services', 'hooks']) {
            if (fs.existsSync(path.join(root, dir))) walk(path.join(root, dir));
        }
        const touching = files.filter((f) => /['"]sovereign-identity/.test(fs.readFileSync(f, 'utf8')));
        expect(touching.map((f) => path.relative(root, f))).toEqual([path.join('utils', 'identity.ts')]);

        const src = fs.readFileSync(path.join(root, 'utils', 'identity.ts'), 'utf8');
        const writes = src.match(/SecureStore\.setItemAsync\([^)]*\)/g) ?? [];
        expect(writes.length).toBeGreaterThan(0);
        for (const w of writes) expect(w).toContain('KEY_ITEM_OPTIONS');
    });
});

describe('the move, on an iPhone', () => {
    it('makes an older build\'s item this-device-only, with the same bytes, under the same name, and records the key', async () => {
        const id = await onPhone('ios');
        olderBuildItem();
        const record = memoryRecord();

        expect(await id.keepKeyOnThisPhone(record)).toBe('moved');

        expect(keychain.get(ITEM)).toEqual({ value: SAVED, accessible: WHEN_UNLOCKED_THIS_DEVICE_ONLY });
        expect(keychain.has(COPY)).toBe(false);
        expect(record.map.get(IDENTITY_THIS_DEVICE_STORE_KEY)).toBe(ACCOUNT.publicKey);
        expect(await id.loadIdentity()).toEqual(ACCOUNT);
    });

    it('copies and proves the copy before the item is touched, and proves the old item gone before making it again', async () => {
        const id = await onPhone('ios');
        olderBuildItem();
        await id.keepKeyOnThisPhone(memoryRecord());

        const calls = [
            ...vi.mocked(secure.setItemAsync).mock.calls.map((c, i) => ({ at: vi.mocked(secure.setItemAsync).mock.invocationCallOrder[i], what: `set ${c[0]}` })),
            ...vi.mocked(secure.getItemAsync).mock.calls.map((c, i) => ({ at: vi.mocked(secure.getItemAsync).mock.invocationCallOrder[i], what: `get ${c[0]}` })),
            ...vi.mocked(secure.deleteItemAsync).mock.calls.map((c, i) => ({ at: vi.mocked(secure.deleteItemAsync).mock.invocationCallOrder[i], what: `delete ${c[0]}` })),
        ].sort((a, b) => a.at - b.at).map((c) => c.what);
        expect(calls).toEqual([
            `get ${ITEM}`, `get ${COPY}`,
            `set ${COPY}`, `get ${COPY}`,
            `delete ${ITEM}`, `get ${ITEM}`,
            `set ${ITEM}`, `get ${ITEM}`,
            `delete ${COPY}`,
        ]);
    });

    it('runs once: a second launch finds the key recorded and writes nothing', async () => {
        const id = await onPhone('ios');
        olderBuildItem();
        const record = memoryRecord();
        expect(await id.keepKeyOnThisPhone(record)).toBe('moved');
        vi.mocked(secure.setItemAsync).mockClear();
        vi.mocked(secure.deleteItemAsync).mockClear();

        expect(await id.keepKeyOnThisPhone(record)).toBe('not-needed');
        expect(secure.setItemAsync).not.toHaveBeenCalled();
        expect(secure.deleteItemAsync).not.toHaveBeenCalled();
    });

    it('a new key on the phone (a restore, another account) is moved once too', async () => {
        const id = await onPhone('ios');
        olderBuildItem();
        const record = memoryRecord();
        await id.keepKeyOnThisPhone(record);
        keychain.clear();
        olderBuildItem(JSON.stringify(OTHER));

        expect(await id.keepKeyOnThisPhone(record)).toBe('moved');
        expect(keychain.get(ITEM)).toEqual({ value: JSON.stringify(OTHER), accessible: WHEN_UNLOCKED_THIS_DEVICE_ONLY });
        expect(record.map.get(IDENTITY_THIS_DEVICE_STORE_KEY)).toBe(OTHER.publicKey);
    });

    it('no key on the phone: nothing to do, nothing written', async () => {
        const id = await onPhone('ios');
        const record = memoryRecord();
        expect(await id.keepKeyOnThisPhone(record)).toBe('not-needed');
        expect(secure.setItemAsync).not.toHaveBeenCalled();
        expect(record.setItem).not.toHaveBeenCalled();
    });

    it('a failed read changes nothing', async () => {
        const id = await onPhone('ios');
        olderBuildItem();
        const before = snapshot();
        const record = memoryRecord();
        vi.mocked(secure.getItemAsync).mockRejectedValueOnce(new Error('User interaction is not allowed.'));

        expect(await id.keepKeyOnThisPhone(record)).toBe('kept');
        expect(snapshot()).toEqual(before);
        expect(secure.setItemAsync).not.toHaveBeenCalled();
        expect(secure.deleteItemAsync).not.toHaveBeenCalled();
        expect(record.map.size).toBe(0);
    });

    it('a record that can\'t be read changes nothing', async () => {
        const id = await onPhone('ios');
        olderBuildItem();
        const before = snapshot();
        const record = memoryRecord();
        vi.mocked(record.getItem).mockRejectedValueOnce(new Error('storage full'));

        expect(await id.keepKeyOnThisPhone(record)).toBe('kept');
        expect(snapshot()).toEqual(before);
        expect(record.map.size).toBe(0);
    });

    it('a failed copy write leaves the old item as it was, no copy and no record', async () => {
        const id = await onPhone('ios');
        olderBuildItem();
        const before = snapshot();
        const record = memoryRecord();
        vi.mocked(secure.setItemAsync).mockRejectedValueOnce(new Error('errSecIO'));

        expect(await id.keepKeyOnThisPhone(record)).toBe('kept');
        expect(snapshot()).toEqual(before);
        expect(record.map.size).toBe(0);
        expect(await id.loadIdentity()).toEqual(ACCOUNT);
    });

    it('a copy that reads back different leaves the old item as it was, the copy removed, and no record', async () => {
        const id = await onPhone('ios');
        olderBuildItem();
        const before = snapshot();
        const record = memoryRecord();
        vi.mocked(secure.getItemAsync).mockImplementation(async (key: string) =>
            key === COPY && keychain.has(COPY) ? `${keychain.get(COPY)!.value.slice(0, -1)}` : keychain.get(key)?.value ?? null);
        try {
            expect(await id.keepKeyOnThisPhone(record)).toBe('kept');
        } finally {
            vi.mocked(secure.getItemAsync).mockImplementation(async (key: string) => keychain.get(key)?.value ?? null);
        }
        expect(snapshot()).toEqual(before);
        expect(record.map.size).toBe(0);
    });

    it('an old item that won\'t go stays the key: nothing is recorded, and reads still find it', async () => {
        const id = await onPhone('ios');
        olderBuildItem();
        const record = memoryRecord();
        vi.mocked(secure.deleteItemAsync).mockImplementationOnce(async () => { /* the Keychain said nothing, and kept it */ });

        expect(await id.keepKeyOnThisPhone(record)).toBe('kept');
        expect(keychain.get(ITEM)).toEqual({ value: SAVED, accessible: WHEN_UNLOCKED });
        expect(record.map.size).toBe(0);
        expect(await id.loadIdentity()).toEqual(ACCOUNT);
    });

    it('a failed write of the new item leaves the key in the copy: reads find it, and the next launch finishes the move', async () => {
        const id = await onPhone('ios');
        olderBuildItem();
        const record = memoryRecord();
        const realSet = vi.mocked(secure.setItemAsync).getMockImplementation()!;
        vi.mocked(secure.setItemAsync).mockImplementation(async (key, value, options) => {
            if (key === ITEM) throw new Error('errSecInteractionNotAllowed');
            return realSet(key, value, options);
        });
        try {
            expect(await id.keepKeyOnThisPhone(record)).toBe('kept');
        } finally {
            vi.mocked(secure.setItemAsync).mockImplementation(realSet);
        }
        expect(keychain.has(ITEM)).toBe(false);
        expect(keychain.get(COPY)).toEqual({ value: SAVED, accessible: WHEN_UNLOCKED_THIS_DEVICE_ONLY });
        expect(record.map.size).toBe(0);
        expect(await id.loadIdentity()).toEqual(ACCOUNT);

        // The next launch.
        const next = await onPhone('ios');
        expect(await next.keepKeyOnThisPhone(record)).toBe('moved');
        expect(keychain.get(ITEM)).toEqual({ value: SAVED, accessible: WHEN_UNLOCKED_THIS_DEVICE_ONLY });
        expect(keychain.has(COPY)).toBe(false);
        expect(record.map.get(IDENTITY_THIS_DEVICE_STORE_KEY)).toBe(ACCOUNT.publicKey);
    });

    it('a new item that reads back different is taken away again, so reads find the key in the copy', async () => {
        const id = await onPhone('ios');
        olderBuildItem();
        const record = memoryRecord();
        let made = false;
        vi.mocked(secure.getItemAsync).mockImplementation(async (key: string) => {
            if (key === ITEM && made && keychain.has(ITEM)) return 'garbled';
            return keychain.get(key)?.value ?? null;
        });
        const realSet = vi.mocked(secure.setItemAsync).getMockImplementation()!;
        vi.mocked(secure.setItemAsync).mockImplementation(async (key, value, options) => {
            if (key === ITEM) made = true;
            return realSet(key, value, options);
        });
        try {
            expect(await id.keepKeyOnThisPhone(record)).toBe('kept');
        } finally {
            vi.mocked(secure.getItemAsync).mockImplementation(async (key: string) => keychain.get(key)?.value ?? null);
            vi.mocked(secure.setItemAsync).mockImplementation(realSet);
        }
        expect(keychain.has(ITEM)).toBe(false);
        expect(keychain.get(COPY)!.value).toBe(SAVED);
        expect(record.map.size).toBe(0);
        expect(await id.loadIdentity()).toEqual(ACCOUNT);
    });

    it('the app stopped after the old item went: the key is read from the copy, and the next launch puts the item back', async () => {
        const id = await onPhone('ios');
        keychain.set(COPY, { value: SAVED, accessible: WHEN_UNLOCKED_THIS_DEVICE_ONLY });
        const record = memoryRecord();

        expect(await id.loadIdentity()).toEqual(ACCOUNT);
        expect(await id.keepKeyOnThisPhone(record)).toBe('moved');
        expect(keychain.get(ITEM)).toEqual({ value: SAVED, accessible: WHEN_UNLOCKED_THIS_DEVICE_ONLY });
        expect(keychain.has(COPY)).toBe(false);
        expect(record.map.get(IDENTITY_THIS_DEVICE_STORE_KEY)).toBe(ACCOUNT.publicKey);
    });

    it('the app stopped with both there: the item wins and the copy goes, even when a later save put another account in the item', async () => {
        const id = await onPhone('ios');
        olderBuildItem(JSON.stringify(OTHER));
        keychain.set(COPY, { value: SAVED, accessible: WHEN_UNLOCKED_THIS_DEVICE_ONLY });
        const record = memoryRecord();

        expect(await id.loadIdentity()).toEqual(OTHER);
        expect(await id.keepKeyOnThisPhone(record)).toBe('moved');
        expect(keychain.get(ITEM)).toEqual({ value: JSON.stringify(OTHER), accessible: WHEN_UNLOCKED_THIS_DEVICE_ONLY });
        expect(keychain.has(COPY)).toBe(false);
        expect(await id.loadIdentity()).toEqual(OTHER);
    });

    it('an item that is not an identity is left exactly as it is', async () => {
        const id = await onPhone('ios');
        keychain.set(ITEM, { value: 'not json', accessible: WHEN_UNLOCKED });
        keychain.set(COPY, { value: SAVED, accessible: WHEN_UNLOCKED_THIS_DEVICE_ONLY });
        const before = snapshot();

        expect(await id.keepKeyOnThisPhone(memoryRecord())).toBe('kept');
        expect(snapshot()).toEqual(before);
    });

    it('Sign Out after a stopped move takes the copy too: the account never comes back on its own', async () => {
        const id = await onPhone('ios');
        keychain.set(COPY, { value: SAVED, accessible: WHEN_UNLOCKED_THIS_DEVICE_ONLY });
        expect(await id.loadIdentity()).toEqual(ACCOUNT);

        await id.removeStoredIdentity();
        expect(keychain.size).toBe(0);
        expect(await id.loadIdentity()).toBeNull();
    });

    it('a read made while the move runs answers the key, never "no key"', async () => {
        const id = await onPhone('ios');
        olderBuildItem();
        const moving = id.keepKeyOnThisPhone(memoryRecord());
        const read = id.loadIdentity();
        expect(await read).toEqual(ACCOUNT);
        expect(await moving).toBe('moved');
    });

    it('a save made while the move runs lands after it, and is kept, this-device-only', async () => {
        const id = await onPhone('ios');
        olderBuildItem();
        const moving = id.keepKeyOnThisPhone(memoryRecord());
        const saved = id.importIdentity({ ...ACCOUNT, callsign: 'Kim 2' });
        await Promise.all([moving, saved]);
        expect(JSON.parse(keychain.get(ITEM)!.value).callsign).toBe('Kim 2');
        expect(keychain.get(ITEM)!.accessible).toBe(WHEN_UNLOCKED_THIS_DEVICE_ONLY);
        expect(keychain.has(COPY)).toBe(false);
    });

    it('never throws, whatever the Keychain does', async () => {
        const id = await onPhone('ios');
        olderBuildItem();
        vi.mocked(secure.deleteItemAsync).mockRejectedValueOnce(new Error('boom'));
        await expect(id.keepKeyOnThisPhone(memoryRecord())).resolves.toBe('kept');
        // The key is still readable: in the item or in the copy.
        expect(await id.loadIdentity()).toEqual(ACCOUNT);
    });
});

describe('Android', () => {
    it('has no move: its item is bound to the phone by the Keystore already, and nothing is read, written or recorded', async () => {
        const id = await onPhone('android');
        olderBuildItem();
        const before = snapshot();
        const record = memoryRecord();

        expect(await id.keepKeyOnThisPhone(record)).toBe('not-needed');
        expect(snapshot()).toEqual(before);
        expect(secure.getItemAsync).not.toHaveBeenCalled();
        expect(record.getItem).not.toHaveBeenCalled();
    });

    it('reads never look for a copy, and Sign Out deletes only the item', async () => {
        const id = await onPhone('android');
        olderBuildItem();
        expect(await id.loadIdentity()).toEqual(ACCOUNT);
        await id.removeStoredIdentity();
        expect(vi.mocked(secure.getItemAsync).mock.calls.map(([k]) => k)).toEqual([ITEM]);
        expect(vi.mocked(secure.deleteItemAsync).mock.calls.map(([k]) => k)).toEqual([ITEM]);
    });
});

describe('the app runs the move', () => {
    it('once the first read has answered, and nothing waits on it', () => {
        const src = fs.readFileSync(path.resolve(__dirname, '..', '..', 'app', 'IdentityContext.tsx'), 'utf8');
        const read = src.indexOf('loadIdentity()');
        const done = src.indexOf('setIsLoading(false)');
        const move = src.indexOf('keepKeyOnThisPhone(AsyncStorage)');
        expect(read).toBeGreaterThan(-1);
        expect(done).toBeGreaterThan(read);
        expect(move).toBeGreaterThan(done);
        expect(src).not.toMatch(/await\s+keepKeyOnThisPhone/);
    });
});
