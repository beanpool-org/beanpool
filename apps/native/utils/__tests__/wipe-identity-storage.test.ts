import { describe, it, expect, vi } from 'vitest';

vi.mock('react-native', () => ({ Platform: { OS: 'android' } }));
vi.mock('expo-secure-store', () => ({ getItemAsync: vi.fn(), setItemAsync: vi.fn(), deleteItemAsync: vi.fn() }));
vi.mock('expo-crypto', () => ({ randomUUID: () => 'test-uuid', getRandomBytes: vi.fn() }));

import { wipeIdentityScopedStorage } from '../identity';

function fakeStorage(seed: Record<string, string>) {
    const data = new Map(Object.entries(seed));
    return {
        data,
        getAllKeys: async () => [...data.keys()],
        multiRemove: async (keys: string[]) => { keys.forEach((k) => data.delete(k)); },
        removeItem: async (key: string) => { data.delete(key); },
    };
}

describe('wipeIdentityScopedStorage', () => {
    it('clears guest markers so a fresh identity does not inherit them, and keeps saved community addresses', async () => {
        const storage = fakeStorage({
            beanpool_anchor_url: 'https://test.beanpool.org',
            'beanpool:identity': '{}',
            beanpool_guest_nodes: JSON.stringify(['https://test.beanpool.org']),
            beanpool_saved_nodes: JSON.stringify([{ url: 'https://test.beanpool.org', name: 'Test' }]),
            pillar_sync_cursor: '42',
            'pillar:outbox': '[]',
            some_ui_pref: 'dark',
        });

        await wipeIdentityScopedStorage(storage);

        expect([...storage.data.keys()].sort()).toEqual(['beanpool_saved_nodes', 'some_ui_pref']);
    });
});
