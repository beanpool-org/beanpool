import { describe, it, expect, vi, beforeEach } from 'vitest';

// No identity: the call is being checked for the body it sends, not for the signature the shared `request` wrapper
// adds on top (lib/api, "Sign every request that has an identity available").
vi.mock('./identity', () => ({ loadIdentity: vi.fn(async () => null) }));

import { watchPlace } from './api';

/**
 * "Tell me when a community starts near here" (POST /api/global/watches). What is being defended: the node keeps the
 * 0.1° cell (engine place-watches.ts roundToArea), so the browser sends that cell and nothing finer, as both apps send a
 * member's area (@beanpool/core geo.ts roundToArea). Home's point can be the Market's Distance centre (N5, review of #2363).
 */

const fetchMock = vi.fn();

function reply(status: number, body: any) {
    return { ok: status >= 200 && status < 300, status, json: async () => body, text: async () => JSON.stringify(body) };
}

beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
});

describe('watchPlace', () => {
    it('POSTs the 0.1° cell the node keeps, never the point it was given', async () => {
        fetchMock.mockResolvedValueOnce(reply(200, { success: true }));
        await watchPlace(-28.612345678, 153.598765432);

        const [url, init] = fetchMock.mock.calls[0];
        expect(url).toBe('/api/global/watches');
        expect(init.method).toBe('POST');
        expect(JSON.parse(init.body)).toEqual({ lat: -28.6, lng: 153.6 });
    });
});
