/**
 * A refused forum call says the node's sentence, never its code (#3184 review: a report on a post Hidden while moderators look
 * alerted "not_found"). The forum's routes answer `{ error: <sentence>, code }`; a report (POST /api/reports) answers
 * `{ error: <code>, message: <sentence> }`. Each comes out as the sentence, with its `status` and `code`. An answer with no
 * words (a proxy's page) and no answer at all (no connection) say nothing of their own: the screen says its line.
 *
 * The real db.ts request and the real forum.ts; fetch is a stub, so nothing here contacts a node.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

// db.ts pulls in device modules at import time; stubbed at the boundary as report-abuse-sentence.test.ts does.
vi.mock('expo-sqlite', () => ({ openDatabaseAsync: vi.fn() }));
vi.mock('@react-native-async-storage/async-storage', () => ({
    default: {
        getItem: vi.fn(async (k: string) => (k === 'beanpool_anchor_url' ? 'https://riverside.example' : null)),
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
    buildSignedHeaders: vi.fn(async (method: string, url: string) => ({ 'X-Signed': `${method} ${url}` })),
}));
// No kept copies in this file: a read's copy is never written, and that is never a reason to fail.
vi.mock('../node-post', () => ({ anchorUrl: async () => null, signedGet: vi.fn() }));
vi.mock('../blocklist', () => ({ getBlockedUsers: async () => [] }));

import { closeForumTopic, getForumFront, replyInForum, reportForumPost } from '../forum';

const fetchMock = vi.fn();
const reply = (status: number, body: unknown) =>
    ({ ok: status >= 200 && status < 300, status, json: async () => body, text: async () => JSON.stringify(body) });
const noJson = (status: number) =>
    ({ ok: false, status, json: async () => { throw new SyntaxError('Unexpected token <'); }, text: async () => '<html>Bad gateway</html>' });
const refusal = (p: Promise<unknown>) => p.then(() => { throw new Error('expected a refusal'); }, (e) => e as Error & { status?: number; code?: string; unsaid?: boolean });

beforeEach(() => {
    fetchMock.mockReset();
    (globalThis as any).fetch = fetchMock;
});

describe('a refused report of a forum post', () => {
    it("a post no longer there for them (Hidden while moderators look, or removed since): the node's sentence, code not_found", async () => {
        fetchMock.mockResolvedValueOnce(reply(404, { error: 'not_found', message: 'That forum post is not here any more.' }));
        const err = await refusal(reportForumPost('post-1', 'Spam or scam'));
        expect(err.message).toBe('That forum post is not here any more.');
        expect(err.code).toBe('not_found');
        expect(err.status).toBe(404);
        expect(fetchMock.mock.calls[0][0]).toBe('https://riverside.example/api/reports');
    });

    it("the hourly limit: the node's sentence, code rate_limited", async () => {
        fetchMock.mockResolvedValueOnce(reply(429, { error: 'rate_limited', message: 'You have sent a lot of reports recently. Please try again in an hour.' }));
        const err = await refusal(reportForumPost('post-1', 'Spam or scam'));
        expect(err.message).toBe('You have sent a lot of reports recently. Please try again in an hour.');
        expect(err.code).toBe('rate_limited');
        expect(err.status).toBe(429);
    });

    it('their own post: the sentence, code own_post', async () => {
        fetchMock.mockResolvedValueOnce(reply(400, { error: 'own_post', message: 'You cannot report your own post.' }));
        const err = await refusal(reportForumPost('post-1', 'Other'));
        expect(err.message).toBe('You cannot report your own post.');
        expect(err.code).toBe('own_post');
    });

    it('an answer with a sentence and no code keeps the sentence', async () => {
        fetchMock.mockResolvedValueOnce(reply(400, { error: 'Failed — must be a registered member, cannot report yourself' }));
        const err = await refusal(reportForumPost('post-1', 'Other'));
        expect(err.message).toBe('Failed — must be a registered member, cannot report yourself');
        expect(err.status).toBe(400);
    });
});

describe("the forum's own refusals", () => {
    it('a closed topic: the sentence the node wrote, with its status and code, as before', async () => {
        fetchMock.mockResolvedValueOnce(reply(409, { error: 'This topic is closed.', code: 'closed' }));
        const err = await refusal(replyInForum('t1', { words: 'Hello' }));
        expect(err.message).toBe('This topic is closed.');
        expect(err.code).toBe('closed');
        expect(err.status).toBe(409);
    });

    it('not theirs to close: the sentence, code not_yours', async () => {
        fetchMock.mockResolvedValueOnce(reply(403, { error: 'Only the writer or a moderator can close this topic.', code: 'not_yours' }));
        const err = await refusal(closeForumTopic('t1'));
        expect(err.message).toBe('Only the writer or a moderator can close this topic.');
        expect(err.code).toBe('not_yours');
    });

    it("an answer with no words (a proxy's page): nothing of its own, so the screen says its line, never 'Request failed: 502'", async () => {
        fetchMock.mockResolvedValueOnce(noJson(502));
        const err = await refusal(getForumFront());
        expect(err.message).toBe('');
        expect(err.status).toBe(502);
        expect(err.unsaid).toBe(true);
    });

    it("no answer at all (no connection): nothing of its own, never the platform's English", async () => {
        fetchMock.mockRejectedValueOnce(new TypeError('Network request failed'));
        const err = await refusal(replyInForum('t1', { words: 'Hello' }));
        expect(err.message).toBe('');
        expect(err.status).toBeUndefined();
    });
});
