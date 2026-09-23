import { describe, it, expect, vi, beforeEach } from 'vitest';

// db.ts pulls in device modules at import time; stub them at the boundary (same set as event-reminders-api.test.ts).
vi.mock('expo-sqlite', () => ({ openDatabaseAsync: vi.fn() }));
vi.mock('@react-native-async-storage/async-storage', () => ({
    default: {
        getItem: vi.fn(async (k: string) => (k === 'beanpool_anchor_url' ? 'https://test.beanpool.org' : null)),
        setItem: vi.fn(async () => {}),
        removeItem: vi.fn(async () => {}),
        getAllKeys: vi.fn(async () => []),
    },
}));
vi.mock('expo-crypto', () => ({ randomUUID: () => 'test-uuid' }));
vi.mock('expo-file-system/legacy', () => ({ cacheDirectory: '/tmp/cache/' }));
vi.mock('../identity', () => ({
    loadIdentity: vi.fn(async () => ({ publicKey: 'me-pub', privateKey: 'me-priv', callsign: 'Me' })),
}));
vi.mock('../nodes', () => ({ getDatabaseFilenameForNode: vi.fn(), addSavedNode: vi.fn() }));
vi.mock('../canonical-profile', () => ({ getCanonicalProfile: vi.fn(), saveCanonicalProfile: vi.fn() }));
vi.mock('../crypto', async (orig) => ({
    ...(await orig<any>()),
    buildSignedHeaders: vi.fn(async (method: string, path: string) => ({ 'X-Signed': `${method} ${path}` })),
}));

import {
    fetchGroupSuccession, proposeGroupSuccessionApi, voteGroupSuccessionApi, isRouteMissing,
} from '../db';
import { buildSignedHeaders } from '../crypto';

/**
 * The three calls the quiet-lead vote makes, and nothing else. What is being defended: the node is told exactly
 * which proposal and which choice, the signature is what says whose vote it is, and a node too old for the route
 * is told apart from one that refused.
 */

const fetchMock = vi.fn();

function reply(status: number, body: any) {
    return {
        ok: status >= 200 && status < 300,
        status,
        json: async () => body,
        text: async () => JSON.stringify(body),
    };
}

beforeEach(() => {
    fetchMock.mockReset();
    (buildSignedHeaders as any).mockClear();
    (globalThis as any).fetch = fetchMock;
});

describe('fetchGroupSuccession', () => {
    it('is a signed GET on the group\'s succession route, with no member named in it', async () => {
        const body = { silence: { isEligible: false }, proposals: [], canPropose: false };
        fetchMock.mockResolvedValueOnce(reply(200, body));

        expect(await fetchGroupSuccession('g1')).toEqual(body);
        const [url, init] = fetchMock.mock.calls[0];
        expect(url).toBe('https://test.beanpool.org/api/groups/g1/succession');
        expect(init.method).toBe('GET');
        // Whose view of the vote this is comes from the signature, never from a parameter.
        expect(url).not.toContain('publicKey');
        expect(buildSignedHeaders).toHaveBeenCalledWith('GET', '/api/groups/g1/succession', '', 'me-priv', 'me-pub');
    });

    it('throws a route-missing error on 404, so an older node hides the section instead of erroring', async () => {
        fetchMock.mockResolvedValueOnce(reply(404, { error: 'Not Found' }));
        await expect(fetchGroupSuccession('g1')).rejects.toSatisfy(isRouteMissing);
    });

    it('passes a refusal through in the node\'s own words', async () => {
        fetchMock.mockResolvedValueOnce(reply(403, { error: 'Only a member of this group can see it' }));
        await expect(fetchGroupSuccession('g1')).rejects.toThrow('Only a member of this group can see it');
    });

    it('escapes a group id rather than letting it shape the path', async () => {
        fetchMock.mockResolvedValueOnce(reply(200, { silence: {}, proposals: [], canPropose: false }));
        await fetchGroupSuccession('a/b c');
        expect(fetchMock.mock.calls[0][0]).toBe('https://test.beanpool.org/api/groups/a%2Fb%20c/succession');
    });
});

describe('proposeGroupSuccessionApi', () => {
    it('POSTs the candidate and nothing else', async () => {
        fetchMock.mockResolvedValueOnce(reply(200, { success: true, executed: false }));
        await proposeGroupSuccessionApi('g1', 'pk-damo');

        const [url, init] = fetchMock.mock.calls[0];
        expect(url).toBe('https://test.beanpool.org/api/groups/g1/succession/propose');
        expect(init.method).toBe('POST');
        expect(JSON.parse(init.body)).toEqual({ candidatePubkey: 'pk-damo' });
    });
});

describe('voteGroupSuccessionApi', () => {
    it('POSTs the choice to that one proposal', async () => {
        fetchMock.mockResolvedValueOnce(reply(200, { success: true, executed: false }));
        await voteGroupSuccessionApi('g1', 'prop-1', 'no');

        const [url, init] = fetchMock.mock.calls[0];
        expect(url).toBe('https://test.beanpool.org/api/groups/g1/succession/prop-1/vote');
        expect(init.method).toBe('POST');
        // The voter is the signature. The body carries the choice, and never a voter pubkey.
        expect(JSON.parse(init.body)).toEqual({ choice: 'no' });
        expect(init.body).not.toContain('me-pub');
    });

    it('surfaces the node\'s refusal of a second vote', async () => {
        fetchMock.mockResolvedValueOnce(reply(409, { error: 'You have already voted on this proposal' }));
        await expect(voteGroupSuccessionApi('g1', 'prop-1', 'yes')).rejects.toThrow('You have already voted on this proposal');
    });
});
