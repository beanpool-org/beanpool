import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./identity', () => ({
    loadIdentity: vi.fn(async () => null),
}));

import { getPublicChannels } from './api';
import { platformMeta, categoryMeta } from '@beanpool/core';

describe('PWA channel integration', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('getPublicChannels calls GET /api/members/:pubkey/channels', async () => {
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
        ];

        const mockFetch = vi.fn().mockResolvedValueOnce({
            ok: true,
            json: async () => ({ channels: mockChannels }),
        });
        global.fetch = mockFetch;

        const pubkey = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
        const res = await getPublicChannels(pubkey);

        expect(res.channels).toEqual(mockChannels);
        expect(mockFetch).toHaveBeenCalledWith(
            `/api/members/${pubkey}/channels`,
            expect.objectContaining({ method: 'GET' })
        );
    });

    it('platformMeta safely falls back for unrecognised platform', () => {
        const meta = platformMeta('unknown');
        expect(meta.icon).toBe('🔗');
        expect(meta.label).toBe('Link');
        expect(meta.listing).toBe('card');
    });

    it('categoryMeta safely falls back for unrecognised category', () => {
        const meta = categoryMeta('unknown');
        expect(meta.icon).toBe('✨');
        expect(meta.label).toBe('Other');
    });
});
