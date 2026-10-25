import { describe, it, expect, vi, beforeEach } from 'vitest';

// No identity: the refusal is being checked for what it carries back, not for the signature the shared `request` wrapper
// adds on top (lib/api, "Sign every request that has an identity available").
vi.mock('./identity', () => ({ loadIdentity: vi.fn(async () => null) }));

import { acceptMarketplacePost, requestMarketplacePost, openDealIn } from './api';

/**
 * A member who already has a deal under way on a listing (the node's 409 `deal_open`, apps/server engine/escrow.ts;
 * scratch/fable-design/DESIGN-deals-fable.md S2). What is being defended: the refusal reaches the page with its code and the
 * deal the node named, so the listing can open that deal; the sentence beside them is the member's language and is never read.
 */

const fetchMock = vi.fn();

function reply(status: number, body: any) {
    return { ok: status >= 200 && status < 300, status, json: async () => body, text: async () => JSON.stringify(body) };
}

beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
});

const DEAL_OPEN = { error: 'Vous avez déjà un échange en cours ici.', code: 'deal_open', transactionId: 'tx-under-way' };

describe('a deal already under way (deal_open)', () => {
    it('an accept refused: the code and the deal the node named come back with the error', async () => {
        fetchMock.mockResolvedValueOnce(reply(409, DEAL_OPEN));
        const err = await acceptMarketplacePost('post-1', 'pk-me').then(() => null, (e) => e);
        expect(err).toBeInstanceOf(Error);
        expect(err.status).toBe(409);
        expect(err.code).toBe('deal_open');
        expect(openDealIn(err)).toEqual({ transactionId: 'tx-under-way' });
    });

    it('a request refused the same way', async () => {
        fetchMock.mockResolvedValueOnce(reply(409, DEAL_OPEN));
        const err = await requestMarketplacePost('need-1', 'pk-me').then(() => null, (e) => e);
        expect(openDealIn(err)).toEqual({ transactionId: 'tx-under-way' });
    });

    it('any other refusal is not one, whatever its words', async () => {
        fetchMock.mockResolvedValueOnce(reply(400, { error: 'Post not found or not active', code: 'post_gone' }));
        const gone = await acceptMarketplacePost('post-1', 'pk-me').then(() => null, (e) => e);
        expect(openDealIn(gone)).toBeNull();
        fetchMock.mockResolvedValueOnce(reply(400, { error: 'You already have a deal under way on this. Finish or cancel it first.' }));
        const uncoded = await acceptMarketplacePost('post-1', 'pk-me').then(() => null, (e) => e);
        expect(openDealIn(uncoded)).toBeNull();
        expect(openDealIn(undefined)).toBeNull();
        expect(openDealIn('deal_open')).toBeNull();
    });

    it('a deal_open with no deal named still reads as one, with nothing to open', async () => {
        fetchMock.mockResolvedValueOnce(reply(409, { error: 'x', code: 'deal_open' }));
        const err = await acceptMarketplacePost('post-1', 'pk-me').then(() => null, (e) => e);
        expect(openDealIn(err)).toEqual({});
    });
});
