import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../node-post', () => ({
    anchorUrl: vi.fn(async () => 'https://test.beanpool.org'),
}));

import { fetchPublicChannels } from '../channels';
import { anchorUrl } from '../node-post';
import { platformMeta, categoryMeta, PLATFORMS, CATEGORIES } from '@beanpool/core';

describe('channels utility (native)', () => {
    const validPubkey = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

    beforeEach(() => {
        vi.clearAllMocks();
        vi.mocked(anchorUrl).mockResolvedValue('https://test.beanpool.org');
    });

    it('returns empty array when pubkey is invalid', async () => {
        expect(await fetchPublicChannels('')).toEqual([]);
        expect(await fetchPublicChannels('invalid-pubkey')).toEqual([]);
    });

    it('returns empty array when anchorUrl is not set', async () => {
        vi.mocked(anchorUrl).mockResolvedValueOnce(null);
        const result = await fetchPublicChannels(validPubkey);
        expect(result).toEqual([]);
    });

    it('fetches and returns channels when request succeeds', async () => {
        vi.mocked(anchorUrl).mockResolvedValueOnce('https://test.beanpool.org');
        const mockChannels = [
            {
                id: 'ch_1',
                platform: 'youtube',
                url: 'https://www.youtube.com/@mullum_ceramics',
                handle: '@mullum_ceramics',
                category: 'craft',
                isPrimaryVideo: true,
                supportsAutolist: true,
                isVerified: true,
            },
            {
                id: 'ch_2',
                platform: 'instagram',
                url: 'https://www.instagram.com/mullum_ceramics/',
                handle: '@mullum_ceramics',
                category: 'craft',
                isPrimaryVideo: false,
                supportsAutolist: false,
                isVerified: false,
            },
        ];

        const mockFetch = vi.fn().mockResolvedValueOnce({
            ok: true,
            json: async () => ({ channels: mockChannels }),
        });
        global.fetch = mockFetch;

        const result = await fetchPublicChannels(validPubkey);
        expect(result).toEqual(mockChannels);
        expect(mockFetch).toHaveBeenCalledWith(
            `https://test.beanpool.org/api/members/${validPubkey}/channels`
        );
    });

    it('handles trailing slash on node URL correctly without doubling slashes', async () => {
        vi.mocked(anchorUrl).mockResolvedValueOnce('https://test.beanpool.org/');
        const mockFetch = vi.fn().mockResolvedValueOnce({
            ok: true,
            json: async () => ({ channels: [] }),
        });
        global.fetch = mockFetch;

        await fetchPublicChannels(validPubkey);
        expect(mockFetch).toHaveBeenCalledWith(
            `https://test.beanpool.org/api/members/${validPubkey}/channels`
        );
    });

    it('handles HTTP error gracefully by returning empty array', async () => {
        vi.mocked(anchorUrl).mockResolvedValueOnce('https://test.beanpool.org');
        global.fetch = vi.fn().mockResolvedValueOnce({
            ok: false,
            status: 404,
            json: async () => ({ error: 'not_found' }),
        });

        const result = await fetchPublicChannels(validPubkey);
        expect(result).toEqual([]);
    });

    it('handles network throw gracefully without throwing', async () => {
        vi.mocked(anchorUrl).mockResolvedValueOnce('https://test.beanpool.org');
        global.fetch = vi.fn().mockRejectedValueOnce(new Error('Network error'));

        const result = await fetchPublicChannels(validPubkey);
        expect(result).toEqual([]);
    });

    it('uses shared platformMeta and never falls back to PLATFORMS[0]', () => {
        const meta = platformMeta('unknown_custom_platform');
        expect(meta.icon).toBe('🔗');
        expect(meta.label).toBe('Link');
        expect(meta.label).not.toBe(PLATFORMS[0].label);
    });

    it('uses shared categoryMeta and never falls back to CATEGORIES[0]', () => {
        const meta = categoryMeta('unknown_custom_category');
        expect(meta.icon).toBe('✨');
        expect(meta.label).toBe('Other');
        expect(meta.label).not.toBe(CATEGORIES[0].label);
    });
});
