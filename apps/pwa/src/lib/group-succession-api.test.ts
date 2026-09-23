import { describe, it, expect, vi, beforeEach } from 'vitest';

// No identity: the three calls are being checked for the path and the body they send, not for the signature the
// shared `request` wrapper adds on top (lib/api, "Sign every request that has an identity available").
vi.mock('./identity', () => ({ loadIdentity: vi.fn(async () => null) }));

import { getGroupSuccession, proposeGroupSuccession, voteGroupSuccession, isRouteMissing } from './api';

/**
 * The three calls the quiet-lead vote makes, and nothing else. What is being defended: the node is told exactly
 * which proposal and which choice, no voter identity travels in a body, and a node too old for the route is
 * told apart from one that refused.
 */

const fetchMock = vi.fn();

function reply(status: number, body: any) {
    return { ok: status >= 200 && status < 300, status, json: async () => body, text: async () => JSON.stringify(body) };
}

beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
});

describe('getGroupSuccession', () => {
    it('GETs the group\'s succession route', async () => {
        const body = { silence: { isEligible: false }, proposals: [], canPropose: false };
        fetchMock.mockResolvedValueOnce(reply(200, body));

        expect(await getGroupSuccession('g1')).toEqual(body);
        const [url, init] = fetchMock.mock.calls[0];
        expect(url).toBe('/api/groups/g1/succession');
        expect(init.method).toBe('GET');
        expect(init.body).toBeUndefined();
    });

    it('carries the 404 through, so an older node hides the section instead of erroring', async () => {
        fetchMock.mockResolvedValueOnce(reply(404, { error: 'Not Found' }));
        await expect(getGroupSuccession('g1')).rejects.toSatisfy(isRouteMissing);
    });

    it('escapes a group id rather than letting it shape the path', async () => {
        fetchMock.mockResolvedValueOnce(reply(200, {}));
        await getGroupSuccession('a/b c');
        expect(fetchMock.mock.calls[0][0]).toBe('/api/groups/a%2Fb%20c/succession');
    });
});

describe('proposeGroupSuccession', () => {
    it('POSTs the candidate and nothing else', async () => {
        fetchMock.mockResolvedValueOnce(reply(200, { success: true, executed: false }));
        await proposeGroupSuccession('g1', 'pk-damo');

        const [url, init] = fetchMock.mock.calls[0];
        expect(url).toBe('/api/groups/g1/succession/propose');
        expect(init.method).toBe('POST');
        expect(JSON.parse(init.body)).toEqual({ candidatePubkey: 'pk-damo' });
    });

    it('passes a refusal through in the node\'s own words', async () => {
        fetchMock.mockResolvedValueOnce(reply(403, { error: 'The candidate cannot be the current convenor' }));
        await expect(proposeGroupSuccession('g1', 'pk-lead')).rejects.toThrow('The candidate cannot be the current convenor');
    });
});

describe('voteGroupSuccession', () => {
    it('POSTs the choice to that one proposal', async () => {
        fetchMock.mockResolvedValueOnce(reply(200, { success: true, executed: false }));
        await voteGroupSuccession('g1', 'prop-1', 'no');

        const [url, init] = fetchMock.mock.calls[0];
        expect(url).toBe('/api/groups/g1/succession/prop-1/vote');
        expect(init.method).toBe('POST');
        // The voter is the signature. The body carries the choice, and never a voter pubkey.
        expect(JSON.parse(init.body)).toEqual({ choice: 'no' });
    });

    it('surfaces the node\'s refusal of a second vote', async () => {
        fetchMock.mockResolvedValueOnce(reply(409, { error: 'You have already voted on this proposal' }));
        await expect(voteGroupSuccession('g1', 'prop-1', 'yes')).rejects.toThrow('You have already voted on this proposal');
    });
});
