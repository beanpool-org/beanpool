import { describe, it, expect, vi, beforeEach } from 'vitest';

// No identity: the ask is checked for what it reads and how it fails, not for the signature lib/api adds on top.
vi.mock('./identity', () => ({ loadIdentity: vi.fn(async () => null) }));

import { getLibraryTagFor } from './api';

/**
 * "Did you mean …?" (slice F5): getLibraryTagFor reads the node's answer to GET /api/free-tags?q=, the label's tag and its
 * language. What is defended (review of #3164, not blocking): a FAILED ask rejects, never resolves "none", because the
 * picker keeps an answer for the life of the composer and declines to keep a rejection. A word asked during a network blip
 * must be asked again, not remembered as naming nothing.
 */

const fetchMock = vi.fn();

function reply(status: number, body: unknown) {
    return { ok: status >= 200 && status < 300, status, statusText: '', headers: new Headers(), json: async () => body, text: async () => JSON.stringify(body) };
}

beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
});

describe('getLibraryTagFor', () => {
    it('asks for the word and reads the tag with its language', async () => {
        fetchMock.mockResolvedValueOnce(reply(200, { library: 'garden.soil.manure', lang: 'de' }));
        await expect(getLibraryTagFor('mist')).resolves.toEqual({ id: 'garden.soil.manure', lang: 'de' });
        expect(fetchMock.mock.calls[0][0]).toBe('/api/free-tags?q=mist');
    });

    it('an answer naming none is none, and so is an F3 node\'s tag list (it does not read q)', async () => {
        fetchMock.mockResolvedValueOnce(reply(200, { library: null, lang: null }));
        await expect(getLibraryTagFor('zzqx')).resolves.toBeNull();
        fetchMock.mockResolvedValueOnce(reply(200, { tags: [] }));
        await expect(getLibraryTagFor('zzqx')).resolves.toBeNull();
    });

    it('a failed ask rejects: offline, the node down, a refusal, a node without the route', async () => {
        fetchMock.mockRejectedValueOnce(new TypeError('Failed to fetch'));
        await expect(getLibraryTagFor('mist')).rejects.toThrow();
        fetchMock.mockResolvedValueOnce(reply(502, { error: 'Bad gateway' }));
        await expect(getLibraryTagFor('mist')).rejects.toThrow();
        fetchMock.mockResolvedValueOnce(reply(403, { error: 'Only a member', code: 'not_member' }));
        await expect(getLibraryTagFor('mist')).rejects.toThrow();
        fetchMock.mockResolvedValueOnce(reply(404, { error: 'Not found' }));
        await expect(getLibraryTagFor('mist')).rejects.toThrow();
    });
});
