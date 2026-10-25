import { describe, it, expect } from 'vitest';
import { yoursRows } from './yours-rows';
import type { Treasury, Group, YourChat } from './api';

describe('yoursRows', () => {
    it('omits events and separates enterprises from groups with lead/convenor first', () => {
        const yourChats: YourChat[] = [
            {
                kind: 'event',
                id: 'evt-1',
                conversationId: 'evt-1',
                name: 'Spring Equinox',
                avatarUrl: null,
                role: 'host',
                badge: '📅',
                readOnly: false,
                unreadCount: 0,
                lastActivityAt: '',
            },
            {
                kind: 'group',
                id: 'grp-member',
                conversationId: 'grp-member',
                name: 'Book Club',
                avatarUrl: null,
                role: 'member',
                badge: null,
                readOnly: false,
                unreadCount: 0,
                lastActivityAt: '',
            },
            {
                kind: 'group',
                id: 'grp-convenor',
                conversationId: 'grp-convenor',
                name: 'Garden Circle',
                avatarUrl: null,
                role: 'convenor',
                badge: null,
                readOnly: false,
                unreadCount: 0,
                lastActivityAt: '',
            },
            {
                kind: 'enterprise',
                id: 'ent-keeper',
                conversationId: 'ent-keeper',
                name: 'Community Bakery',
                avatarUrl: null,
                role: 'keeper',
                badge: '🏛️',
                lifecycle: 'ongoing',
                readOnly: false,
                unreadCount: 0,
                lastActivityAt: '',
            },
            {
                kind: 'enterprise',
                id: 'ent-lead-project',
                conversationId: 'ent-lead-project',
                name: 'Shade House',
                avatarUrl: null,
                role: 'lead',
                badge: '🌱',
                lifecycle: 'bounded',
                readOnly: false,
                unreadCount: 0,
                lastActivityAt: '',
            },
        ];

        const treasuries: Treasury[] = [
            {
                publicKey: 'ent-keeper',
                name: 'Community Bakery',
                callsign: 'bakery',
                balance: 150,
                creditLine: 0,
                liveOffers: 2,
                lifecycle: 'ongoing',
                status: 'active',
                keepers: [{ publicKey: 'alice', callsign: 'Alice', role: 'keeper' }],
            },
        ];

        const result = yoursRows(yourChats, treasuries, 'alice');

        // Events omitted
        expect(result.kept.length).toBe(2);
        expect(result.groups.length).toBe(2);

        // Kept: lead first (Shade House), then Bakery
        expect(result.kept[0].chat.id).toBe('ent-lead-project');
        expect(result.kept[0].summary).toBeUndefined(); // Project was absent from /api/treasuries
        expect(result.kept[1].chat.id).toBe('ent-keeper');
        expect(result.kept[1].summary?.balance).toBe(150);

        // Groups: convenor first (Garden Circle), then Book Club
        expect(result.groups[0].id).toBe('grp-convenor');
        expect(result.groups[1].id).toBe('grp-member');
    });

    it('falls back to deriving kept from treasuries and groups from allGroups when yourChats is empty/null', () => {
        const treasuries: Treasury[] = [
            {
                publicKey: 'ent-2',
                name: 'Zebra Enterprise',
                callsign: 'zebra',
                balance: 10,
                creditLine: 0,
                liveOffers: 0,
                lifecycle: 'ongoing',
                status: 'active',
                keepers: [{ publicKey: 'my-key', role: 'lead', callsign: 'lead' }],
            },
            {
                publicKey: 'ent-1',
                name: 'Apple Enterprise',
                callsign: 'apple',
                balance: 20,
                creditLine: 0,
                liveOffers: 0,
                lifecycle: 'ongoing',
                status: 'active',
                keepers: [{ publicKey: 'other-key', role: 'lead', callsign: 'lead' }],
            },
        ];

        const allGroups: Group[] = [
            {
                id: 'grp-active',
                slug: 'active',
                name: 'Active Group',
                category: 'social',
                joinPolicy: 'open',
                memberCount: 2,
                viewerStatus: 'active',
                viewerRole: 'member',
                createdAt: '',
                createdBy: '',
            },
            {
                id: 'grp-invited',
                slug: 'invited',
                name: 'Invited Group',
                category: 'social',
                joinPolicy: 'invite_only',
                memberCount: 2,
                viewerStatus: 'invited',
                viewerRole: 'member',
                createdAt: '',
                createdBy: '',
            },
        ];

        const result = yoursRows(null, treasuries, 'my-key', allGroups);

        expect(result.kept.map(k => k.chat.id)).toEqual(['ent-2']);
        expect(result.groups.map(g => g.id)).toEqual(['grp-active']);
    });

    it('does not resurrect suspended keeperships during fallback', () => {
        const treasuries: Treasury[] = [
            {
                publicKey: 'ent-suspended',
                name: 'Suspended Enterprise',
                balance: 10,
                creditLine: 0,
                liveOffers: 0,
                lifecycle: 'ongoing',
                status: 'active',
                keepers: [{ publicKey: 'my-key', role: 'lead', callsign: 'lead', suspended: true }],
            },
        ];

        const result = yoursRows(null, treasuries, 'my-key');
        expect(result.kept).toHaveLength(0);
    });

    it('does not run treasuries or groups fallback when yourChats is provided (even if empty)', () => {
        const treasuries: Treasury[] = [
            {
                publicKey: 'ent-active',
                name: 'Active Enterprise',
                balance: 10,
                creditLine: 0,
                liveOffers: 0,
                lifecycle: 'ongoing',
                status: 'active',
                keepers: [{ publicKey: 'my-key', role: 'lead', callsign: 'lead', suspended: false }],
            },
        ];

        const allGroups: Group[] = [
            {
                id: 'grp-active',
                slug: 'active',
                name: 'Active Group',
                category: 'social',
                joinPolicy: 'open',
                memberCount: 2,
                viewerStatus: 'active',
                viewerRole: 'member',
                createdAt: '',
                createdBy: '',
            },
        ];

        const result = yoursRows([], treasuries, 'my-key', allGroups);
        expect(result.kept).toHaveLength(0);
        expect(result.groups).toHaveLength(0);
    });
});
