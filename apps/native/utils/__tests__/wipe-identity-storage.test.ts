import { describe, it, expect, vi } from 'vitest';

vi.mock('react-native', () => ({ Platform: { OS: 'android' } }));
vi.mock('expo-secure-store', () => ({ WHEN_UNLOCKED_THIS_DEVICE_ONLY: 6, getItemAsync: vi.fn(), setItemAsync: vi.fn(), deleteItemAsync: vi.fn() }));
vi.mock('expo-crypto', () => ({ randomUUID: () => 'test-uuid', getRandomBytes: vi.fn() }));

import { wipeIdentityScopedStorage } from '../identity';
import { namesPinSecretName } from '../names-list';

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
            // The background sync's notes on them (sync-notices.ts): this key was an owner there, and saw this many
            // open requests. Both name the key (#2523 review 4383895884).
            beanpool_knock_role_checked: JSON.stringify({ community: 'https://test.beanpool.org', publicKey: 'ab'.repeat(32), role: 'owner', at: 1 }),
            beanpool_admin_knocks_last_count: JSON.stringify({ community: 'https://test.beanpool.org', publicKey: 'ab'.repeat(32), count: 2 }),
            // The offer to bring this key's listings: it names the key and the community it joined.
            beanpool_bring_listings: JSON.stringify({ publicKey: 'ab'.repeat(32), from: 'https://global.beanpool.org', to: 'https://test.beanpool.org', name: 'Test', at: 1 }),
            // The member's profile: none of it keyed to the account, so the next account's profile publish and its
            // knocks would send this photo, bio and contact as its own.
            beanpool_canonical_profile: JSON.stringify({ avatar: 'bundled://koala', bio: 'Grows tomatoes', contactValue: '0400 000 000' }),
            pending_profile_avatar: 'bundled://koala',
            pending_profile_sync: 'true',
            // A profile change waiting to reach each community (pending-profile-sync.ts): this account's new name and photo,
            // kept for the community it was made in. They go with the account, in every community; the saved list stays.
            'beanpool_pending_profile:https://test.beanpool.org': JSON.stringify({ publicKey: 'ab'.repeat(32), callsign: 'Renamed offline', avatar: 'bundled://koala' }),
            'beanpool_pending_profile:https://castlemaine.beanpool.org': JSON.stringify({ publicKey: 'ab'.repeat(32) }),
            // The invite codes this key made, with who each was for (the node keeps them).
            [`bp_offline_invites_${'ab'.repeat(32)}`]: JSON.stringify([{ code: 'INV-ABC', intendedFor: 'Robin' }]),
            // An unfinished post, kept per community: the next account there would be offered it to finish as its own.
            beanpool_offer_draft: JSON.stringify({ anchorUrl: 'https://test.beanpool.org', postTitle: 'Tomatoes', postPhotos: ['bundled://koala'], postLat: -28.55, postLng: 153.5 }),
            // The List sheet's "in your shop" choice beside that draft: the next account would be put in a shop it never chose.
            beanpool_offer_shop_choice: JSON.stringify({ anchorUrl: 'https://test.beanpool.org', title: 'cordless drill', inShop: true, at: Date.now() }),
            // Reports this key queued while offline. A node files a report as whoever signs it, so the next account's
            // retry would file them in its own name.
            beanpool_pending_abuse_reports: JSON.stringify([{ reporterPubkey: 'ab'.repeat(32), targetPubkey: 'cd'.repeat(32), reason: 'spam', timestamp: 1 }]),
            // Where the phone sent its push token for this key (push-registrations.ts). The next account starts its own.
            beanpool_push_registered_at: JSON.stringify(['https://test.beanpool.org']),
            // A registration of this key still due there (push-registrations.ts): never tried for another key.
            beanpool_push_registrations_due: JSON.stringify([{ publicKey: 'ab'.repeat(32), community: 'https://test.beanpool.org', refusals: 0, retryAt: 0 }]),
            // How many notices each community sent this account since it was last open (notice-counts.ts): the next
            // account's rows would show the numbers of notices that were never its own.
            beanpool_notice_counts: JSON.stringify({ 'https://test.beanpool.org': { n: 2, seen: { ['0'.repeat(32)]: 1 } } }),
            // A cache about every member, not this one: stays.
            [`bp_tier_${'cd'.repeat(32)}`]: '2',
            some_ui_pref: 'dark',
            // The account's block list and its own offline reports stay, under its own key (blocklist.ts): restored,
            // it has its blocks back, and no other account reads them or sends those reports (Marty, 2026-09-27).
            [`beanpool_blocked_users:${'ab'.repeat(32)}`]: JSON.stringify(['cd'.repeat(32)]),
            [`beanpool_pending_abuse_reports:${'ab'.repeat(32)}`]: JSON.stringify([{ reporterPubkey: 'ab'.repeat(32), targetPubkey: 'cd'.repeat(32), reason: 'spam', timestamp: 1 }]),
            beanpool_blocked_users_moved: '1',
            // Which of those blocks the phone has put on each community's list (blocklist.ts syncBlocks), kept with the list
            // it describes: restored, the account's unblocks still reach the communities it blocked at.
            [`beanpool_community_blocks:${'ab'.repeat(32)}`]: JSON.stringify({ 'https://test.beanpool.org': { on: ['cd'.repeat(32)], sent: [] } }),
            // The key each of the account's DMs is sealed to (dm-peer-pins.ts), one value per community file, kept like its
            // block list (Marty, 13 Oct): restored here, its DMs aren't met as first sight again. And what a member's reset
            // of one community's chat memory set aside (§3.4 amendment 6), kept with them.
            [`beanpool_dm_peer_pins:${'ab'.repeat(32)}:beanpool_test.beanpool.org.db`]: JSON.stringify({ pins: { d0: { peer: 'cd'.repeat(32), since: '', by: 'first-seen' } } }),
            [`beanpool_dm_peer_pins:${'ab'.repeat(32)}:community_castlemaine.db`]: JSON.stringify({ pins: {} }),
            [`beanpool_dm_peer_pins_set_aside:${'ab'.repeat(32)}:community_castlemaine.db`]: '{not json',
            // And the lines the update held of a DM its rows didn't pin (db.ts), one key per community file, kept with the
            // pins: restored here, that DM is still judged on what the phone held at the update (§3.4 amendment 5).
            [`beanpool_dm_lines_at_update:${'ab'.repeat(32)}:beanpool_test.beanpool.org.db`]: JSON.stringify({ d1: [] }),
            [`beanpool_dm_lines_at_update:${'ab'.repeat(32)}:community_castlemaine.db`]: JSON.stringify({}),
            // The message requests each community's node last listed for the account (db.ts saveMessageRequests): who wrote
            // to it, each stranger's name and picture, and the chat's id. A copy the next sync replaces: it goes with the
            // account, in every community (PR #2540 review 4394671101).
            [`beanpool_message_requests:${'ab'.repeat(32)}:beanpool_test.beanpool.org.db`]: JSON.stringify([{ id: 'r1', peerCallsign: 'Kofi', peerAvatar: 'bundled://koala', participants: ['ab'.repeat(32), 'cd'.repeat(32)] }]),
            [`beanpool_message_requests:${'ab'.repeat(32)}:community_castlemaine.db`]: JSON.stringify([]),
            // The leave statements not yet confirmed (push-leave.ts), and the phone's push stamp: they are how the
            // leaving account's alerts stop where the phone had no connection as it left, so they outlive the wipe.
            beanpool_push_leave_statements: JSON.stringify([{ community: 'https://test.beanpool.org', publicKey: 'ab'.repeat(32) }]),
            beanpool_push_stamp: '1759000000000',
        });

        await wipeIdentityScopedStorage(storage);

        expect([...storage.data.keys()].sort()).toEqual([
            `beanpool_blocked_users:${'ab'.repeat(32)}`,
            'beanpool_blocked_users_moved',
            `beanpool_community_blocks:${'ab'.repeat(32)}`,
            `beanpool_dm_lines_at_update:${'ab'.repeat(32)}:beanpool_test.beanpool.org.db`,
            `beanpool_dm_lines_at_update:${'ab'.repeat(32)}:community_castlemaine.db`,
            `beanpool_dm_peer_pins:${'ab'.repeat(32)}:beanpool_test.beanpool.org.db`,
            `beanpool_dm_peer_pins:${'ab'.repeat(32)}:community_castlemaine.db`,
            `beanpool_dm_peer_pins_set_aside:${'ab'.repeat(32)}:community_castlemaine.db`,
            `beanpool_pending_abuse_reports:${'ab'.repeat(32)}`,
            'beanpool_push_leave_statements',
            'beanpool_push_stamp',
            'beanpool_saved_nodes',
            `bp_tier_${'cd'.repeat(32)}`,
            'some_ui_pref',
        ]);
    });
});

describe('§8 22. the names list leaves with the account (design-locked-copy §5)', () => {
    const ME = 'ab'.repeat(32);
    const OTHER = 'cd'.repeat(32);
    const pinA = `beanpool:names-trust:${ME}:mullum.beanpool.org`;
    const pinB = `beanpool:names-trust:${OTHER}:test.beanpool.org`;
    const namesKeys = {
        [pinA]: 'sealed-pin-a',
        [pinB]: 'sealed-pin-b',
        [`beanpool:names-checked:${ME}:mullum.beanpool.org`]: '{}',
        [`beanpool:names-unsaid:${ME}:mullum.beanpool.org`]: '[]',
        [`beanpool:names-copied:${ME}:mullum.beanpool.org`]: '{}',
    };
    /** The order the wipe touched things in: `secret:<name>` and `blob:<label>`. */
    function recorded(seed: Record<string, string>, failSecret: string | null = null) {
        const order: string[] = [];
        const storage = fakeStorage(seed);
        const removeItem = storage.removeItem;
        storage.removeItem = async (key: string) => { if (key.startsWith('beanpool:names-')) order.push(`blob:${key}`); await removeItem(key); };
        const secrets = {
            gone: [] as string[],
            deleteSecret: async (name: string) => {
                order.push(`secret:${name}`);
                if (name === failSecret) throw new Error('the keystore said no');
                secrets.gone.push(name);
            },
        };
        return { storage, secrets, order };
    }

    it('removes every beanpool:names- key, and each pin\'s sealing key before its blob', async () => {
        const { storage, secrets, order } = recorded({ ...namesKeys, some_ui_pref: 'dark' });
        await wipeIdentityScopedStorage(storage, secrets);
        expect([...storage.data.keys()]).toEqual(['some_ui_pref']);
        expect(secrets.gone.sort()).toEqual([namesPinSecretName(pinA), namesPinSecretName(pinB)].sort());
        for (const label of [pinA, pinB]) {
            expect(order.indexOf(`secret:${namesPinSecretName(label)}`)).toBeGreaterThan(-1);
            expect(order.indexOf(`secret:${namesPinSecretName(label)}`)).toBeLessThan(order.indexOf(`blob:${label}`));
        }
    });

    it('a sealing key that fails to delete still lets its blob go, and the warning names no key', async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        try {
            const { storage, secrets } = recorded(namesKeys, namesPinSecretName(pinA));
            await wipeIdentityScopedStorage(storage, secrets);
            expect([...storage.data.keys()]).toEqual([]);
            expect(secrets.gone).toEqual([namesPinSecretName(pinB)]);
            expect(warn).toHaveBeenCalled();
            const logged = JSON.stringify(warn.mock.calls);
            for (const k of [ME, OTHER, namesPinSecretName(pinA), 'sealed-pin-a']) expect(logged).not.toContain(k);
        } finally {
            warn.mockRestore();
        }
    });
});
