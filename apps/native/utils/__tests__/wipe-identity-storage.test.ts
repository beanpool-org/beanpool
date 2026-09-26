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
    it('clears guest markers, the communities this key asked to join and the member\'s profile, and keeps saved community addresses', async () => {
        const storage = fakeStorage({
            beanpool_anchor_url: 'https://test.beanpool.org',
            'beanpool:identity': '{}',
            beanpool_guest_nodes: JSON.stringify(['https://test.beanpool.org']),
            beanpool_saved_nodes: JSON.stringify([{ url: 'https://test.beanpool.org', name: 'Test' }]),
            pillar_sync_cursor: '42',
            'pillar:outbox': '[]',
            // The communities this key asked to join (#1179 review 4109868126): they say where the member lives.
            beanpool_knocks: JSON.stringify({ pubkey: 'ab'.repeat(32), knocks: [{ node: 'https://near.example', name: 'Near' }] }),
            // The member's profile: none of it keyed to the account, so the next account's profile publish and its
            // knocks would send this photo, bio and contact as its own.
            beanpool_canonical_profile: JSON.stringify({ avatar: 'bundled://koala', bio: 'Grows tomatoes', contactValue: '0400 000 000' }),
            pending_profile_avatar: 'bundled://koala',
            pending_profile_sync: 'true',
            // The invite codes this key made, with who each was for (the node keeps them).
            [`bp_offline_invites_${'ab'.repeat(32)}`]: JSON.stringify([{ code: 'INV-ABC', intendedFor: 'Robin' }]),
            // An unfinished post, kept per community: the next account there would be offered it to finish as its own.
            beanpool_offer_draft: JSON.stringify({ anchorUrl: 'https://test.beanpool.org', postTitle: 'Tomatoes', postPhotos: ['bundled://koala'], postLat: -28.55, postLng: 153.5 }),
            // Reports this key queued while offline. A node files a report as whoever signs it, so the next account's
            // retry would file them in its own name.
            beanpool_pending_abuse_reports: JSON.stringify([{ reporterPubkey: 'ab'.repeat(32), targetPubkey: 'cd'.repeat(32), reason: 'spam', timestamp: 1 }]),
            // Where the phone sent its push token for this key (push-registrations.ts). The next account starts its own.
            beanpool_push_registered_at: JSON.stringify(['https://test.beanpool.org']),
            // A cache about every member, not this one: stays.
            [`bp_tier_${'cd'.repeat(32)}`]: '2',
            some_ui_pref: 'dark',
        });

        await wipeIdentityScopedStorage(storage);

        expect([...storage.data.keys()].sort()).toEqual(['beanpool_saved_nodes', `bp_tier_${'cd'.repeat(32)}`, 'some_ui_pref']);
    });
});
