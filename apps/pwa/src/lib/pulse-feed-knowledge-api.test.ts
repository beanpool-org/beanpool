import { beforeEach, describe, expect, it, vi } from 'vitest';

// No identity: the call is checked for the address it reads, not for the signature the shared `request` wrapper adds.
vi.mock('./identity', () => ({ loadIdentity: vi.fn(async () => null) }));

import { getPulseFeed } from './api';

/**
 * GET /api/pulse/feed with `with=knowledge` (slice KP; DESIGN-local-knowledge-amend-fable.md §2.3, §2.12): the Pulse page
 * asks for Local knowledge's card; every other read of the feed (the guide's How it works videos, any caller that does not
 * say so) never does, so it never holds a card it does not draw.
 */

const fetchMock = vi.fn();
const reply = (body: unknown) => ({ ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) });

beforeEach(() => {
    fetchMock.mockReset();
    fetchMock.mockResolvedValue(reply({ items: [], nextCursor: null }));
    vi.stubGlobal('fetch', fetchMock);
});

describe('getPulseFeed and knowledge cards', () => {
    it('asks for them only when told to', async () => {
        await getPulseFeed({ limit: 20, withKnowledge: true });
        const asked = new URL(fetchMock.mock.calls[0][0], 'https://riverside.example');
        expect(asked.pathname).toBe('/api/pulse/feed');
        expect(asked.searchParams.get('with')).toBe('knowledge');
        expect(asked.searchParams.get('limit')).toBe('20');
    });

    it('keeps the cursor beside it on the next page', async () => {
        await getPulseFeed({ cursor: '2026-11-14T00:00:00.000Z|p9', limit: 20, withKnowledge: true });
        const asked = new URL(fetchMock.mock.calls[0][0], 'https://riverside.example');
        expect(asked.searchParams.get('with')).toBe('knowledge');
        expect(asked.searchParams.get('cursor')).toBe('2026-11-14T00:00:00.000Z|p9');
    });

    it('a read that does not say so never asks (the guide\'s videos, a category)', async () => {
        await getPulseFeed({ category: 'learn', limit: 50 });
        await getPulseFeed();
        for (const [url] of fetchMock.mock.calls) {
            expect(new URL(url, 'https://riverside.example').searchParams.has('with')).toBe(false);
        }
    });
});
