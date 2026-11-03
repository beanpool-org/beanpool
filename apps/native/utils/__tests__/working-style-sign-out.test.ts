import { describe, it, expect, vi } from 'vitest';

// Sign Out wipes the working style (DESIGN-archetype-across-fable.md §3, S3): the device copy, and everything that waits to
// reach a community, a result or a removal. The wipe is the account's own (identity.ts wipeIdentityScopedStorage), so the
// next account on the phone starts with none and publishes none of it.

vi.mock('react-native', () => ({ Platform: { OS: 'android' } }));
vi.mock('expo-secure-store', () => ({ WHEN_UNLOCKED_THIS_DEVICE_ONLY: 6, getItemAsync: vi.fn(), setItemAsync: vi.fn(), deleteItemAsync: vi.fn() }));
vi.mock('expo-crypto', () => ({ randomUUID: () => 'test-uuid', getRandomBytes: vi.fn() }));

import { wipeIdentityScopedStorage } from '../identity';
import { CANONICAL_PROFILE_STORE_KEY, PENDING_ARCHETYPE_STORE_PREFIX } from '../storage-keys';

const ME = 'ab'.repeat(32);

function fakeStorage(seed: Record<string, string>) {
    const data = new Map(Object.entries(seed));
    return {
        data,
        getAllKeys: async () => [...data.keys()],
        multiRemove: async (keys: string[]) => { keys.forEach((k) => data.delete(k)); },
        removeItem: async (key: string) => { data.delete(key); },
    };
}

describe('Sign Out and the working style', () => {
    it('wipes the device copy, a result waiting for a community and a removal waiting for another', async () => {
        const result = JSON.stringify({ primary: 'sage', secondary: 'weaver', mode: 'quick', takenOn: '2026-11-03' });
        const storage = fakeStorage({
            [CANONICAL_PROFILE_STORE_KEY]: JSON.stringify({ bio: 'Grows tomatoes', archetype: JSON.stringify({ primary: 'sage', secondary: 'weaver', mode: 'quick', takenOn: '2026-11-03', scores: { sage: 3 } }) }),
            [`${PENDING_ARCHETYPE_STORE_PREFIX}https://a.beanpool.org`]: JSON.stringify({ publicKey: ME, archetype: result }),
            [`${PENDING_ARCHETYPE_STORE_PREFIX}https://b.example.net`]: JSON.stringify({ publicKey: ME, removedOn: '2026-11-03' }),
            some_ui_pref: 'dark',
        });

        await wipeIdentityScopedStorage(storage);

        expect(storage.data.has(CANONICAL_PROFILE_STORE_KEY)).toBe(false);
        expect([...storage.data.keys()].filter((k) => k.startsWith(PENDING_ARCHETYPE_STORE_PREFIX))).toEqual([]);
        // Only the account's: a preference of the phone stays.
        expect(storage.data.get('some_ui_pref')).toBe('dark');
    });
});
