import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./identity', () => ({
    loadIdentity: vi.fn(async () => ({
        publicKey: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
        privateKey: 'fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210',
        callsign: 'TestUser',
    })),
    signPayload: vi.fn(async (_identity, payload) => 'mock-sig-' + (payload?.id || 'default')),
}));

import { formatRelativeTime, isOfficialSource } from './pulse';
import {
    getPulseFeed,
    getMemberChannels,
    addMemberChannel,
    updateMemberChannel,
    deleteMemberChannel,
    previewPulsePost,
    submitPulsePost,
    getPulseNudges,
    dismissPulseNudge,
    mutePulseItem,
    deletePulseItem,
    type PulseFeedItem,
} from './api';

describe('formatRelativeTime', () => {
    it('handles falsy or empty inputs gracefully', () => {
        expect(formatRelativeTime('')).toBe('');
        expect(formatRelativeTime(null as any)).toBe('');
        expect(formatRelativeTime(undefined as any)).toBe('');
    });

    it('formats just now for recent seconds', () => {
        const date = new Date(Date.now() - 30 * 1000).toISOString();
        expect(formatRelativeTime(date)).toBe('Just now');
    });

    it('formats minutes ago', () => {
        const date = new Date(Date.now() - 15 * 60 * 1000).toISOString();
        expect(formatRelativeTime(date)).toBe('15m ago');
    });

    it('formats hours ago', () => {
        const date = new Date(Date.now() - 3 * 3600 * 1000).toISOString();
        expect(formatRelativeTime(date)).toBe('3h ago');
    });

    it('formats days ago', () => {
        const date = new Date(Date.now() - 4 * 24 * 3600 * 1000).toISOString();
        expect(formatRelativeTime(date)).toBe('4d ago');
    });

    it('formats older dates into localized date string', () => {
        const date = new Date(Date.now() - 40 * 24 * 3600 * 1000).toISOString();
        const formatted = formatRelativeTime(date);
        expect(formatted).not.toContain('ago');
        expect(formatted.length).toBeGreaterThan(0);
    });
});

describe('isOfficialSource', () => {
    it('returns true for items with isOfficial flag', () => {
        const item = {
            id: 'item_1',
            ownerPubkey: 'abc',
            callsign: 'Council',
            platform: 'web',
            category: 'other',
            url: 'https://council.gov.au/news',
            title: 'Flood Notice',
            publishedAt: new Date().toISOString(),
            avatarUrl: null,
            thumbnailUrl: null,
            source: 'admin',
            isVerified: true,
            isOfficial: true,
        };
        expect(isOfficialSource(item)).toBe(true);
    });

    it('returns true for items with official source', () => {
        const item: PulseFeedItem = {
            id: 'item_2',
            ownerPubkey: 'abc',
            callsign: 'Council',
            platform: 'web',
            category: 'other',
            url: 'https://council.gov.au/news',
            title: 'Flood Notice',
            publishedAt: new Date().toISOString(),
            avatarUrl: null,
            thumbnailUrl: null,
            source: 'official',
            isVerified: true,
        };
        expect(isOfficialSource(item)).toBe(true);
    });

    it('returns false for ordinary member posts', () => {
        const item: PulseFeedItem = {
            id: 'item_4',
            ownerPubkey: 'def',
            callsign: 'Farmer Dave',
            platform: 'youtube',
            category: 'garden',
            url: 'https://youtube.com/watch?v=123',
            title: 'Permaculture garden update',
            publishedAt: new Date().toISOString(),
            avatarUrl: null,
            thumbnailUrl: null,
            source: 'creator',
            isVerified: false,
        };
        expect(isOfficialSource(item)).toBe(false);
    });
});

describe('Pulse API Client Integration', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('getPulseFeed requests feed with params and returns items', async () => {
        const mockResponse = {
            items: [
                {
                    id: 'p1',
                    ownerPubkey: 'k1',
                    callsign: 'Potter',
                    avatarUrl: null,
                    platform: 'youtube',
                    url: 'https://youtube.com/watch?v=xyz',
                    title: 'Clay Workshop',
                    thumbnailUrl: null,
                    category: 'craft',
                    publishedAt: '2026-09-08T00:00:00Z',
                    source: 'creator',
                    isVerified: false,
                },
            ],
            nextCursor: 'cursor_123',
        };

        const mockFetch = vi.fn().mockResolvedValueOnce({
            ok: true,
            json: async () => mockResponse,
        });
        global.fetch = mockFetch;

        const res = await getPulseFeed({ cursor: 'cur_0', category: 'craft', limit: 10 });
        expect(res).toEqual(mockResponse);
        expect(mockFetch).toHaveBeenCalledWith(
            '/api/pulse/feed?cursor=cur_0&category=craft&limit=10',
            expect.objectContaining({ method: 'GET' })
        );
    });

    it('getMemberChannels requests member creator channels via POST /api/channels/mine', async () => {
        const mockChannels = [
            {
                id: 'ch_1',
                memberPubkey: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
                platform: 'youtube' as const,
                url: 'https://youtube.com/@pottery',
                handle: '@pottery',
                category: 'craft' as const,
                isPrimaryVideo: true,
                supportsAutolist: false,
                oauthVerifiedAt: null,
                syndicateToNode: true,
                isVerified: false,
            },
        ];

        const mockFetch = vi.fn().mockResolvedValueOnce({
            ok: true,
            json: async () => ({ channels: mockChannels }),
        });
        global.fetch = mockFetch;

        const res = await getMemberChannels();
        expect(res.channels).toEqual(mockChannels);
        expect(mockFetch).toHaveBeenCalledWith(
            '/api/channels/mine',
            expect.objectContaining({ method: 'POST' })
        );
    });

    it('addMemberChannel signs and posts new channel to /api/member/channels', async () => {
        const newChannel = {
            id: 'ch_new',
            platform: 'substack' as const,
            url: 'https://mullum.substack.com',
            handle: '@mullum',
            category: 'words' as const,
            memberPubkey: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
            isPrimaryVideo: false,
            supportsAutolist: false,
            oauthVerifiedAt: null,
            syndicateToNode: true,
            isVerified: false,
        };

        const mockFetch = vi.fn().mockResolvedValueOnce({
            ok: true,
            json: async () => ({ success: true, channel: newChannel, otherVideoChannels: [] }),
        });
        global.fetch = mockFetch;

        const res = await addMemberChannel({
            platform: 'substack',
            url: 'https://mullum.substack.com',
            category: 'words',
        });

        expect(res.success).toBe(true);
        expect(mockFetch).toHaveBeenCalledWith(
            '/api/member/channels',
            expect.objectContaining({
                method: 'POST',
                headers: expect.objectContaining({ 'Content-Type': 'application/json' }),
            })
        );
    });

    it('updateMemberChannel updates channel attributes via POST /api/member/channels/:id', async () => {
        const mockFetch = vi.fn().mockResolvedValueOnce({
            ok: true,
            json: async () => ({ success: true, channel: {} }),
        });
        global.fetch = mockFetch;

        const res = await updateMemberChannel('ch_1', { syndicateToNode: false });
        expect(res.success).toBe(true);
        expect(mockFetch).toHaveBeenCalledWith(
            '/api/member/channels/ch_1',
            expect.objectContaining({
                method: 'POST',
                body: JSON.stringify({ syndicateToNode: false }),
            })
        );
    });

    it('deleteMemberChannel sends delete request via POST /api/member/channels/:id/delete', async () => {
        const mockFetch = vi.fn().mockResolvedValueOnce({
            ok: true,
            json: async () => ({ success: true }),
        });
        global.fetch = mockFetch;

        const res = await deleteMemberChannel('ch_1');
        expect(res.success).toBe(true);
        expect(mockFetch).toHaveBeenCalledWith(
            '/api/member/channels/ch_1/delete',
            expect.objectContaining({ method: 'POST' })
        );
    });

    it('previewPulsePost requests SSRF-safe URL preview via POST /api/member/pulse/preview', async () => {
        const mockPreview = {
            success: true,
            preview: {
                channelId: 'ch_1',
                platform: 'youtube' as const,
                externalId: '123',
                url: 'https://youtube.com/watch?v=123',
                title: 'Building a Cob Oven',
                thumbnailUrl: 'https://img.youtube.com/vi/123/hqdefault.jpg',
                publishedAt: '2026-09-08T00:00:00Z',
                category: 'craft' as const,
                alreadyImported: false,
            },
        };

        const mockFetch = vi.fn().mockResolvedValueOnce({
            ok: true,
            json: async () => mockPreview,
        });
        global.fetch = mockFetch;

        const res = await previewPulsePost('https://youtube.com/watch?v=123');
        expect(res.preview?.title).toBe('Building a Cob Oven');
        expect(res.preview?.alreadyImported).toBe(false);
        expect(mockFetch).toHaveBeenCalledWith(
            '/api/member/pulse/preview',
            expect.objectContaining({
                method: 'POST',
                body: JSON.stringify({ url: 'https://youtube.com/watch?v=123' }),
            })
        );
    });

    it('submitPulsePost submits post to /api/member/pulse/submit', async () => {
        const mockItem: PulseFeedItem = {
            id: 'pulse_post_1',
            ownerPubkey: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
            callsign: 'TestUser',
            avatarUrl: null,
            platform: 'youtube',
            category: 'craft',
            url: 'https://youtube.com/watch?v=123',
            title: 'Building a Cob Oven',
            thumbnailUrl: null,
            publishedAt: '2026-09-08T00:00:00Z',
            source: 'creator',
            isVerified: false,
        };

        const mockFetch = vi.fn().mockResolvedValueOnce({
            ok: true,
            json: async () => ({ success: true, item: mockItem, deduplicated: false }),
        });
        global.fetch = mockFetch;

        const res = await submitPulsePost({
            url: 'https://youtube.com/watch?v=123',
            channelId: 'ch_1',
            category: 'craft',
            title: 'Building a Cob Oven',
        });

        expect(res.success).toBe(true);
        expect(res.item.id).toBe('pulse_post_1');
        expect(mockFetch).toHaveBeenCalledWith(
            '/api/member/pulse/submit',
            expect.objectContaining({ method: 'POST' })
        );
    });

    it('getPulseNudges fetches nudges via POST /api/member/pulse/nudges', async () => {
        const mockNudges = {
            nudges: [
                {
                    channelId: 'ch_1',
                    platform: 'youtube' as const,
                    handle: '@mullumpottery',
                    url: null,
                    currentCount: 15,
                    postCountSeen: 12,
                    newPostsCount: 3,
                },
            ],
        };

        const mockFetch = vi.fn().mockResolvedValueOnce({
            ok: true,
            json: async () => mockNudges,
        });
        global.fetch = mockFetch;

        const res = await getPulseNudges();
        expect(res.nudges.length).toBe(1);
        expect(res.nudges[0].newPostsCount).toBe(3);
        expect(mockFetch).toHaveBeenCalledWith(
            '/api/member/pulse/nudges',
            expect.objectContaining({ method: 'POST' })
        );
    });

    it('dismissPulseNudge posts dismissal via POST /api/member/pulse/channels/:id/dismiss-nudge', async () => {
        const mockFetch = vi.fn().mockResolvedValueOnce({
            ok: true,
            json: async () => ({ success: true, channelId: 'ch_1', postCountSeen: 13 }),
        });
        global.fetch = mockFetch;

        const res = await dismissPulseNudge('ch_1');
        expect(res.success).toBe(true);
        expect(mockFetch).toHaveBeenCalledWith(
            '/api/member/pulse/channels/ch_1/dismiss-nudge',
            expect.objectContaining({ method: 'POST' })
        );
    });

    it('mutePulseItem sends signed mute mutation via POST /api/member/pulse/items/:id/mute', async () => {
        const mockFetch = vi.fn().mockResolvedValueOnce({
            ok: true,
            json: async () => ({ success: true }),
        });
        global.fetch = mockFetch;

        const res = await mutePulseItem('item_1', true);
        expect(res.success).toBe(true);
        expect(mockFetch).toHaveBeenCalledWith(
            '/api/member/pulse/items/item_1/mute',
            expect.objectContaining({
                method: 'POST',
                body: JSON.stringify({ muted: true }),
            })
        );
    });

    it('deletePulseItem sends delete mutation via POST /api/member/pulse/items/:id/delete', async () => {
        const mockFetch = vi.fn().mockResolvedValueOnce({
            ok: true,
            json: async () => ({ success: true }),
        });
        global.fetch = mockFetch;

        const res = await deletePulseItem('item_1');
        expect(res.success).toBe(true);
        expect(mockFetch).toHaveBeenCalledWith(
            '/api/member/pulse/items/item_1/delete',
            expect.objectContaining({ method: 'POST' })
        );
    });
});
