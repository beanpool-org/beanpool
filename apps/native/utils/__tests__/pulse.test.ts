import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../node-post', () => ({
    anchorUrl: vi.fn(async () => 'https://test.beanpool.org'),
    signedPost: vi.fn(async () => ({
        ok: true,
        json: async () => ({ success: true, item: { id: 'item_1', muted: 1 } }),
    })),
}));

import {
    fetchPulseFeed,
    getFixturePulseFeed,
    mutePulseItem,
    formatRelativeTime,
    PULSE_FIXTURE_ITEMS,
    type PulseFeedItem,
} from '../pulse';
import { anchorUrl, signedPost } from '../node-post';

describe('pulse utility (native)', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.mocked(anchorUrl).mockResolvedValue('https://test.beanpool.org');
    });

    describe('formatRelativeTime', () => {
        it('returns empty string for null, undefined, or invalid date', () => {
            expect(formatRelativeTime(null)).toBe('');
            expect(formatRelativeTime(undefined)).toBe('');
            expect(formatRelativeTime('')).toBe('');
            expect(formatRelativeTime('not-a-date')).toBe('');
        });

        it('returns "Just now" for recent or future dates', () => {
            const now = new Date().toISOString();
            expect(formatRelativeTime(now)).toBe('Just now');
            const future = new Date(Date.now() + 10000).toISOString();
            expect(formatRelativeTime(future)).toBe('Just now');
        });

        it('formats minutes ago', () => {
            const twentyMinAgo = new Date(Date.now() - 20 * 60 * 1000).toISOString();
            expect(formatRelativeTime(twentyMinAgo)).toBe('20m ago');
        });

        it('formats hours ago', () => {
            const fiveHoursAgo = new Date(Date.now() - 5 * 60 * 60 * 1000).toISOString();
            expect(formatRelativeTime(fiveHoursAgo)).toBe('5h ago');
        });

        it('formats days ago up to 6 days', () => {
            const threeDaysAgo = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString();
            expect(formatRelativeTime(threeDaysAgo)).toBe('3d ago');
        });

        it('formats older dates with month and day', () => {
            const oldDate = new Date(2026, 7, 15).toISOString(); // Aug 15 2026
            const formatted = formatRelativeTime(oldDate);
            expect(formatted).toMatch(/Aug\s+15/);
        });
    });

    describe('getFixturePulseFeed', () => {
        it('returns fixture items sorted by publishedAt descending', () => {
            const res = getFixturePulseFeed();
            expect(res.items.length).toBeGreaterThan(0);
            for (let i = 0; i < res.items.length - 1; i++) {
                const cur = new Date(res.items[i].publishedAt!).getTime();
                const next = new Date(res.items[i + 1].publishedAt!).getTime();
                expect(cur).toBeGreaterThanOrEqual(next);
            }
        });

        it('filters by category', () => {
            const res = getFixturePulseFeed({ category: 'craft' });
            expect(res.items.length).toBeGreaterThan(0);
            for (const item of res.items) {
                expect(item.category).toBe('craft');
            }
        });

        it('paginates with limit and cursor', () => {
            const page1 = getFixturePulseFeed({ limit: 2 });
            expect(page1.items.length).toBe(2);
            expect(page1.nextCursor).toBeTruthy();

            const page2 = getFixturePulseFeed({ limit: 2, cursor: page1.nextCursor });
            expect(page2.items.length).toBe(2);
            expect(page2.items[0].id).not.toBe(page1.items[0].id);
        });
    });

    describe('fetchPulseFeed', () => {
        it('fetches from node when online and formats query parameters', async () => {
            const mockItems: PulseFeedItem[] = [
                {
                    id: 'item_100',
                    ownerPubkey: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
                    callsign: 'Alice',
                    avatarUrl: null,
                    platform: 'youtube',
                    category: 'food',
                    url: 'https://youtube.com/watch?v=123',
                    title: 'Fresh Bread',
                    thumbnailUrl: 'https://img.youtube.com/vi/123/hqdefault.jpg',
                    publishedAt: '2026-08-30T10:00:00Z',
                    source: 'autolist',
                    isVerified: true,
                },
            ];

            const mockFetch = vi.fn().mockResolvedValueOnce({
                ok: true,
                json: async () => ({ items: mockItems, nextCursor: 'next_100' }),
            });
            global.fetch = mockFetch;

            const res = await fetchPulseFeed({ category: 'food', limit: 10, cursor: 'c_99' });
            expect(res.items).toEqual(mockItems);
            expect(res.nextCursor).toBe('next_100');
            expect(mockFetch).toHaveBeenCalledWith(
                'https://test.beanpool.org/api/pulse/feed?cursor=c_99&category=food&limit=10',
                expect.objectContaining({ method: 'GET' })
            );
        });

        it('falls back to fixture when anchorUrl is null', async () => {
            vi.mocked(anchorUrl).mockResolvedValueOnce(null);
            const res = await fetchPulseFeed();
            expect(res.items.length).toBe(PULSE_FIXTURE_ITEMS.length);
        });

        it('falls back to fixture when node returns 404/500', async () => {
            global.fetch = vi.fn().mockResolvedValueOnce({
                ok: false,
                status: 404,
                json: async () => ({ error: 'not_found' }),
            });

            const res = await fetchPulseFeed();
            expect(res.items.length).toBe(PULSE_FIXTURE_ITEMS.length);
        });

        it('falls back to fixture when network error throws', async () => {
            global.fetch = vi.fn().mockRejectedValueOnce(new Error('Network error'));
            const res = await fetchPulseFeed();
            expect(res.items.length).toBe(PULSE_FIXTURE_ITEMS.length);
        });

        it('respects forceFixture option directly without hitting network', async () => {
            const mockFetch = vi.fn();
            global.fetch = mockFetch;

            const res = await fetchPulseFeed({ forceFixture: true });
            expect(mockFetch).not.toHaveBeenCalled();
            expect(res.items.length).toBe(PULSE_FIXTURE_ITEMS.length);
        });
    });

    describe('mutePulseItem', () => {
        const mockIdentity: any = {
            publicKey: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
            privateKey: 'mock-priv-key',
            callsign: 'Alice',
        };

        it('throws error when identity is missing', async () => {
            await expect(mutePulseItem('item_1', true, null)).rejects.toThrow('Identity required');
        });

        it('throws error when itemId is empty', async () => {
            await expect(mutePulseItem('', true, mockIdentity)).rejects.toThrow('Item ID is required');
        });

        it('calls signedPost with correct path and body', async () => {
            const result = await mutePulseItem('item_1', true, mockIdentity);
            expect(result.success).toBe(true);
            expect(signedPost).toHaveBeenCalledWith(
                'https://test.beanpool.org',
                '/api/member/pulse/items/item_1/mute',
                { muted: true },
                mockIdentity
            );
        });

        it('propagates error message from node on failure', async () => {
            vi.mocked(signedPost).mockResolvedValueOnce({
                ok: false,
                status: 403,
                json: async () => ({ message: 'Not your item to mute' }),
            } as any);

            await expect(mutePulseItem('item_1', true, mockIdentity)).rejects.toThrow('Not your item to mute');
        });
    });
});
