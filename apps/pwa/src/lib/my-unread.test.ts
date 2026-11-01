import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * The Chat badge's read (lib/api.ts getMyUnread). A member's badge asks GET /api/me/unread and nothing else. A visitor's row
 * is refused that route, yet what was sent to it still waits and its own list is the one thing it may read, so its badge
 * keeps counting from there; so does a web app at an older node. No other refusal reads the list: a poll that fails
 * has failed, and asking for the whole list on the way out would make a struggling node's day worse.
 */

const identityMock = vi.hoisted(() => ({
    loadIdentity: vi.fn(async () => null as null),
}));
vi.mock('./identity', () => identityMock);

import { getMyUnread } from './api';

const ME = 'a'.repeat(64);
const COUNTS = '/api/me/unread';
const LIST = `/api/messages/conversations/${ME}`;
const fetchMock = vi.fn();

function reply(status: number, body: unknown) {
    return { ok: status >= 200 && status < 300, status, statusText: String(status), json: async () => body };
}

/** The node: each address's answer. */
function node(answers: Record<string, ReturnType<typeof reply>>): void {
    fetchMock.mockImplementation(async (url: string) => answers[url] ?? reply(500, { error: 'not stubbed' }));
}
const asked = (): string[] => fetchMock.mock.calls.map(([url]) => url as string);

beforeEach(() => {
    localStorage.clear();
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
    vi.unstubAllGlobals();
});

describe("the Chat badge's read", () => {
    it('a member: the counts route, and the list is never asked', async () => {
        node({ [COUNTS]: reply(200, { unread: 4, requests: 2, asOf: '2026-11-01T00:00:00.000Z' }) });

        await expect(getMyUnread(ME)).resolves.toEqual({ unread: 4, requests: 2, asOf: '2026-11-01T00:00:00.000Z' });
        expect(asked()).toEqual([COUNTS]);
    });

    it("a visitor's row, refused the counts route: its number from the one list it may read", async () => {
        node({
            [COUNTS]: reply(403, { error: 'Read access requires a member identity', code: 'not_a_member' }),
            [LIST]: reply(200, { conversations: [], totalUnread: 3, requests: { count: 1, conversations: [] } }),
        });

        const answer = await getMyUnread(ME);
        expect(answer).toMatchObject({ unread: 3, requests: 1 });
        expect(Number.isNaN(Date.parse(answer.asOf))).toBe(false);
        expect(asked()).toEqual([COUNTS, LIST]);
    });

    it('a node older than the route: its number from the list, with no requests where it has none', async () => {
        node({
            [COUNTS]: reply(404, { error: 'Not found' }),
            [LIST]: reply(200, { conversations: [], totalUnread: 2 }),
        });

        await expect(getMyUnread(ME)).resolves.toMatchObject({ unread: 2, requests: 0 });
    });

    it('a key that may read neither is refused, as the poll has always been', async () => {
        node({
            [COUNTS]: reply(403, { error: 'Read access requires a member identity', code: 'not_a_member' }),
            [LIST]: reply(403, { error: 'Read access requires a member identity', code: 'not_a_member' }),
        });

        await expect(getMyUnread(ME)).rejects.toMatchObject({ status: 403, code: 'not_a_member' });
    });

    it.each([
        ['a server fault', reply(500, { error: 'Something went wrong' })],
        ['a busy node', reply(503, { error: 'Busy', code: 'store_full' })],
        ['a closed account', reply(403, { error: 'Closed', code: 'account_closed' })],
        ['a replaced key', reply(403, { error: 'Replaced', code: 'key_invalidated' })],
    ])('%s: refused, and the whole list is not asked for on the way out', async (_name, answer) => {
        node({ [COUNTS]: answer });

        await expect(getMyUnread(ME)).rejects.toMatchObject({ status: answer.status });
        expect(asked()).toEqual([COUNTS]);
    });

    it('offline: refused, and the list is not asked', async () => {
        fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));

        await expect(getMyUnread(ME)).rejects.toThrow('Failed to fetch');
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });
});
