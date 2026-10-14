import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DatabaseSync } from 'node:sqlite';

// Where a poll's votes came from (FABLE-sec-global-abuse LOW-7), kept in the phone's own cache: the node's count of votes
// from new or 12-word accounts (`pollNewOrWordsVotes`, column poll_new_or_words_votes) and each answer's share inside
// poll_options, through every writer of a poll's row: a delta sync, a push over /ws and the phone's own vote. Real SQL
// against the phone's real schema (getDb() runs the app's own _doInitDB over this in-memory database), device modules
// stubbed at the boundary as in live-post-apply.test.ts.

const sql = new DatabaseSync(':memory:');
const params = (p: unknown) => (p === undefined ? [] : Array.isArray(p) ? p : [p]) as any[];
const adapter = {
    runAsync: vi.fn(async (q: string, p?: unknown) => {
        const r = sql.prepare(q).run(...params(p));
        return { changes: Number(r.changes), lastInsertRowId: Number(r.lastInsertRowid) };
    }),
    execAsync: vi.fn(async (q: string) => { sql.exec(q); }),
    getAllAsync: vi.fn(async (q: string, p?: unknown) => sql.prepare(q).all(...params(p))),
    getFirstAsync: vi.fn(async (q: string, p?: unknown) => sql.prepare(q).get(...params(p)) ?? null),
    closeAsync: vi.fn(async () => {}),
    withTransactionAsync: vi.fn(async (cb: () => Promise<void>) => { await cb(); }),
};

const ANCHOR = 'https://global.beanpool.org';
vi.mock('expo-sqlite', () => ({ openDatabaseAsync: vi.fn(async () => adapter) }));
vi.mock('@react-native-async-storage/async-storage', () => ({
    default: {
        getItem: vi.fn(async (k: string) => (k === 'beanpool_anchor_url' ? ANCHOR : null)),
        setItem: vi.fn(async () => {}),
        removeItem: vi.fn(async () => {}),
        getAllKeys: vi.fn(async () => []),
        multiRemove: vi.fn(async () => {}),
    },
}));
vi.mock('expo-crypto', () => ({ randomUUID: () => 'test-uuid', getRandomBytes: (n: number) => new Uint8Array(n) }));
vi.mock('expo-file-system/legacy', () => ({
    cacheDirectory: '/tmp/cache/',
    getInfoAsync: vi.fn().mockResolvedValue({ exists: false }),
    makeDirectoryAsync: vi.fn().mockResolvedValue(undefined),
    writeAsStringAsync: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('expo-constants', () => ({ default: { expoConfig: undefined } }));
// A real seed (the phone's raw 32-byte form), so the vote below is signed as the app signs it.
vi.mock('../identity', () => ({ loadIdentity: vi.fn(async () => ({ publicKey: 'me'.padEnd(64, '0'), privateKey: '11'.repeat(32), callsign: 'Me' })) }));
vi.mock('../nodes', () => ({
    getDatabaseFilenameForNode: vi.fn((url: string | null) => (url ? `beanpool_${new URL(url).hostname}.db` : 'beanpool_none.db')),
    addSavedNode: vi.fn(async () => {}),
}));
vi.mock('../canonical-profile', () => ({ getCanonicalProfile: vi.fn(async () => null), saveCanonicalProfile: vi.fn(async () => {}) }));

import { applyDelta, getDb, getPosts, votePoll } from '../db';
import { livePostChange } from '@beanpool/core';

const ANN = 'a'.repeat(64);

function poll(extra: Record<string, unknown> = {}) {
    return {
        id: 'poll-1', type: 'poll', category: 'community', title: 'Should the lobby have a weekly swap day?', description: '',
        credits: 0, priceType: 'fixed', authorPublicKey: ANN, authorCallsign: 'Ann',
        createdAt: '2026-10-01T01:00:00.000Z', updatedAt: '2026-10-01T01:00:00.000Z', active: true, status: 'active',
        audienceScope: 'public', pollOpenVote: false, pollClosesAt: '2026-10-08T01:00:00.000Z', totalVotes: 12,
        pollNewOrWordsVotes: 5,
        pollOptions: [
            { id: 'opt_yes', text: 'Yes', votes: 7, percentage: 58, newOrWordsVotes: 4 },
            { id: 'opt_no', text: 'No', votes: 3, percentage: 25, newOrWordsVotes: 1 },
            { id: 'opt_maybe', text: 'Maybe', votes: 2, percentage: 17, newOrWordsVotes: 0 },
        ],
        ...extra,
    };
}
const row = () => sql.prepare('SELECT poll_new_or_words_votes, poll_options FROM posts WHERE id = ?').get('poll-1') as any;
const cached = async () => (await getPosts({} as any)).find((p: any) => p.id === 'poll-1') as any;
const splitOf = (p: any) => (p?.pollOptions ?? []).map((o: any) => o.newOrWordsVotes ?? '-').join('/');

const fetchMock = vi.fn();
beforeEach(async () => {
    fetchMock.mockReset().mockResolvedValue({ ok: false, status: 404, json: async () => ({}), text: async () => '' });
    (globalThis as any).fetch = fetchMock;
    await getDb();
    sql.exec('DELETE FROM posts');
});

describe('the phone keeps where a poll\'s votes came from', () => {
    it('a delta sync stores the count and each answer\'s share, and the Market reads them back', async () => {
        await applyDelta({ posts: [poll()] });
        expect(row().poll_new_or_words_votes).toBe(5);
        const p = await cached();
        expect(p.pollNewOrWordsVotes).toBe(5);
        expect(splitOf(p)).toBe('4/1/0');
        expect(p.pollOptions.map((o: any) => o.votes).join('/')).toBe('7/3/2');
    });

    it('another vote\'s push is a doorbell for a poll, and the sync it starts brings the new count; one that says nothing (a local node) clears it', async () => {
        // A poll's broadcast carries the voter's own choice, so the app never writes it as it comes (@beanpool/core
        // live-updates): it runs its catch-up sync, which writes through the same row writer.
        expect(livePostChange({ type: 'post_updated', post: poll() })).toBeNull();
        await applyDelta({ posts: [poll()] });
        await applyDelta({ posts: [poll({ updatedAt: '2026-10-01T01:30:00.000Z', totalVotes: 13, pollNewOrWordsVotes: 6 })] });
        expect(row().poll_new_or_words_votes).toBe(6);
        const { pollNewOrWordsVotes: _n, ...silent } = poll({
            updatedAt: '2026-10-01T02:00:00.000Z',
            pollOptions: [{ id: 'opt_yes', text: 'Yes', votes: 7, percentage: 58 }, { id: 'opt_no', text: 'No', votes: 5, percentage: 42 }],
        });
        await applyDelta({ posts: [silent] });
        expect(row().poll_new_or_words_votes).toBeNull();
        const p = await cached();
        expect('pollNewOrWordsVotes' in p).toBe(false);
        expect(splitOf(p)).toBe('-/-');
    });

    it('the phone\'s own vote stores the node\'s new count from its answer', async () => {
        await applyDelta({ posts: [poll()] });
        const answer = poll({ totalVotes: 13, pollNewOrWordsVotes: 6, userVotedOptionId: 'opt_maybe', pollOptions: [
            { id: 'opt_yes', text: 'Yes', votes: 7, percentage: 54, newOrWordsVotes: 4 },
            { id: 'opt_no', text: 'No', votes: 3, percentage: 23, newOrWordsVotes: 1 },
            { id: 'opt_maybe', text: 'Maybe', votes: 3, percentage: 23, newOrWordsVotes: 1 },
        ] });
        fetchMock.mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ success: true, post: answer }), text: async () => '' });
        await votePoll('poll-1', 'opt_maybe');
        expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining('/api/marketplace/posts/poll-1/vote'), expect.anything());
        expect(row().poll_new_or_words_votes).toBe(6);
        const p = await cached();
        expect(p.pollNewOrWordsVotes).toBe(6);
        expect(splitOf(p)).toBe('4/1/1');
    });

    it('anything but a whole number of votes is stored as nothing', async () => {
        for (const bad of ['5', -1, Number.NaN, null]) {
            sql.exec('DELETE FROM posts');
            await applyDelta({ posts: [poll({ pollNewOrWordsVotes: bad })] });
            expect(row().poll_new_or_words_votes).toBeNull();
        }
    });
});
