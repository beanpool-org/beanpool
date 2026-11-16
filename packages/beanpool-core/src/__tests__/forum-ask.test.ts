/**
 * Forum posts on an Ask to join, in core (slice F11; DESIGN-forums-fable.md §13): the readers both apps use, the addresses,
 * and the admins' check, held to the frozen proof vectors (forum-vectors.ts) so every runtime compares the same bytes.
 */
import { describe, expect, it, vi } from 'vitest';
import {
    FORUM_ASK_CHECK_MS,
    FORUM_ASK_CHECK_WORDS,
    FORUM_ASK_POSTS,
    FORUM_LIMITS,
    checkKnockForumPost,
    cleanForumAskTitle,
    forumAskCheckOf,
    forumAskJsonUrl,
    forumAskPageUrl,
    forumPostProof,
    readForumAskPick,
    readForumAskPosts,
    readKnockForum,
    type KnockForumPost,
} from '../index.js';
import { FORUM_PROOF_VECTORS, FORUM_VECTOR_KEY, FORUM_VECTOR_OTHER_KEY, FORUM_VECTOR_SECRET } from '../forum-vectors.js';

const AT = 'https://forum.example';
const [mine] = FORUM_PROOF_VECTORS;
/** A row as the community keeps it: the proof it made with the asking key (the vector's) and the asker's secret. */
const row: KnockForumPost = { postId: mine.postId, topicId: 'ft-1', number: 4, title: 'Seed swap ideas', proof: mine.proof };
/** The worldwide forum's public JSON for that topic, starting at the post, with the proof its writer's key makes. */
const answer = (proof: string | undefined, id = mine.postId) => ({ topic: { id: 'ft-1' }, posts: [{ id, number: 4, words: 'Bring seeds.', proof }] });

describe('what travels', () => {
    it('a pick reads whole or not at all', () => {
        expect(readForumAskPick({ postId: 'fp-1', topicId: 'ft-1', number: 2, title: '  Seed\nswap  ' })).toEqual({ postId: 'fp-1', topicId: 'ft-1', number: 2, title: 'Seed swap' });
        for (const bad of [null, [], { postId: 'fp 1', topicId: 'ft-1', number: 1, title: 'x' }, { postId: 'fp-1', topicId: 'ft-1', number: 0, title: 'x' },
            { postId: 'fp-1', topicId: 'ft-1', number: 1.5, title: 'x' }, { postId: 'fp-1', topicId: 'ft-1', number: 1, title: '   ' }, { postId: 'x'.repeat(65), topicId: 'ft-1', number: 1, title: 'x' }]) {
            expect(readForumAskPick(bad)).toBeNull();
        }
        expect(cleanForumAskTitle('é'.repeat(300))).toHaveLength(FORUM_LIMITS.title);
    });

    it("the asker's list needs a 64-hex secret; a bad post is left out", () => {
        expect(readForumAskPosts({ secret: FORUM_VECTOR_SECRET, posts: [{ postId: 'fp-1', topicId: 'ft-1', number: 1, title: 'A' }, { postId: '' }] }))
            .toEqual({ secret: FORUM_VECTOR_SECRET, posts: [{ postId: 'fp-1', topicId: 'ft-1', number: 1, title: 'A' }] });
        expect(readForumAskPosts({ secret: FORUM_VECTOR_SECRET.toUpperCase(), posts: [] })).toBeNull();
        expect(readForumAskPosts({ posts: [] })).toBeNull();
    });

    it("a request's rows: an https address, at most three, each with a proof", () => {
        const four = [1, 2, 3, 4].map((n) => ({ ...row, postId: `fp-${n}` }));
        expect(FORUM_ASK_POSTS).toBe(3);
        expect(readKnockForum({ at: AT, posts: four })?.posts.map((p) => p.postId)).toEqual(['fp-1', 'fp-2', 'fp-3']);
        expect(readKnockForum({ at: AT, posts: [{ ...row, proof: 'no' }] })).toBeNull();
        expect(readKnockForum({ at: 'http://forum.example', posts: [row] })).toBeNull();
        expect(readKnockForum({ at: 'https://forum.example/path', posts: [row] })).toBeNull();
        expect(readKnockForum(null)).toBeNull();
    });

    it('the addresses land on the post', () => {
        expect(forumAskJsonUrl(AT, row)).toBe('https://forum.example/api/forum/public/topics/ft-1?after=3');
        expect(forumAskPageUrl(AT, row)).toBe('https://forum.example/forum/t/ft-1?after=3#p4');
    });
});

describe("the admins' check", () => {
    it('the same key and secret: a tick; another key or secret: not theirs; not shown: gone', () => {
        expect(forumAskCheckOf(row, answer(mine.proof))).toEqual({ check: 'same', words: 'Bring seeds.' });
        // Another person wrote it: the forum's proof is made with their key (and their secret).
        expect(forumAskCheckOf(row, answer(forumPostProof({ postId: mine.postId, writerKey: FORUM_VECTOR_OTHER_KEY, secret: FORUM_VECTOR_SECRET }))).check).toBe('other');
        expect(forumAskCheckOf(row, answer(FORUM_PROOF_VECTORS[2].proof)).check).toBe('other');
        expect(forumAskCheckOf(row, answer(undefined)).check).toBe('other');
        expect(forumAskCheckOf(row, answer(mine.proof, 'fp-later')).check).toBe('gone');
        expect(forumAskCheckOf(row, null).check).toBe('gone');
        expect(forumAskCheckOf(row, { nothing: true }).check).toBe('unknown');
        expect(forumPostProof({ postId: mine.postId, writerKey: FORUM_VECTOR_KEY, secret: FORUM_VECTOR_SECRET })).toBe(row.proof);
    });

    const respond = (status: number, body: unknown) => async () => ({ ok: status >= 200 && status < 300, status, json: async () => body });

    it('reads the public JSON once, from the address that lands on the post', async () => {
        const asked: string[] = [];
        const result = await checkKnockForumPost(AT, row, { fetchImpl: async (url) => { asked.push(url); return respond(200, answer(mine.proof))(); } });
        expect(result.check).toBe('same');
        expect(asked).toEqual([forumAskJsonUrl(AT, row)]);
    });

    it('unreachable, an error, a 404, or slower than the wait: never a throw, never a wait past it', async () => {
        expect((await checkKnockForumPost(AT, row, { fetchImpl: async () => { throw new TypeError('Network request failed'); } })).check).toBe('unknown');
        expect((await checkKnockForumPost(AT, row, { fetchImpl: respond(503, {}) })).check).toBe('unknown');
        expect((await checkKnockForumPost(AT, row, { fetchImpl: respond(404, { code: 'not_found' }) })).check).toBe('gone');
        // Slow: the answer is given at the wait, on the clock the check set, never later (fake timers: no wall-clock bound).
        vi.useFakeTimers();
        try {
            let settled: string | null = null;
            const slow = checkKnockForumPost(AT, row, { fetchImpl: () => new Promise(() => { /* never answers */ }), timeoutMs: 50 })
                .then((r) => { settled = r.check; return r; });
            await vi.advanceTimersByTimeAsync(49);
            expect(settled).toBeNull();
            await vi.advanceTimersByTimeAsync(1);
            expect((await slow).check).toBe('unknown');
        } finally {
            vi.useRealTimers();
        }
        expect(FORUM_ASK_CHECK_MS).toBeGreaterThan(0);
    });

    it('every outcome has its line', () => {
        expect(Object.keys(FORUM_ASK_CHECK_WORDS).sort()).toEqual(['checking', 'gone', 'other', 'same', 'unknown']);
    });
});
