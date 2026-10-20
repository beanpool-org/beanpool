import { describe, it, expect, vi, beforeEach } from 'vitest';

// No identity: the call is being checked for the path and the body it sends, not for the signature the shared
// `request` wrapper adds on top (lib/api, "Sign every request that has an identity available").
vi.mock('./identity', () => ({ loadIdentity: vi.fn(async () => null) }));

import { cancelMarketplaceRequest } from './api';

/**
 * Withdrawing a request (a borrower's ask for a lendable Offer, a helper's offer to fulfil a Need). What is being
 * defended: the body carries the one who asked under the name the node reads (routes/marketplace.ts cancel-request
 * reads `buyerPublicKey`, whichever side they are), so the node does not refuse every withdrawal with a 400.
 */

const fetchMock = vi.fn();

function reply(status: number, body: any) {
    return { ok: status >= 200 && status < 300, status, json: async () => body, text: async () => JSON.stringify(body) };
}

beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
});

describe('cancelMarketplaceRequest', () => {
    it('POSTs the request and the one who asked, as the node reads them', async () => {
        fetchMock.mockResolvedValueOnce(reply(200, { success: true }));
        await cancelMarketplaceRequest('tx-ask', 'pk-borrower');

        const [url, init] = fetchMock.mock.calls[0];
        expect(url).toBe('/api/marketplace/transactions/cancel-request');
        expect(init.method).toBe('POST');
        expect(JSON.parse(init.body)).toEqual({ transactionId: 'tx-ask', buyerPublicKey: 'pk-borrower' });
    });
});
