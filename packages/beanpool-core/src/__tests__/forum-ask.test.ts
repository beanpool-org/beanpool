/**
 * Forum posts on an Ask to join, in core (slice F11; DESIGN-forums-fable.md §13): the readers both apps use, the addresses,
 * and the admins' check, held to the frozen proof vectors (forum-vectors.ts) so every runtime compares the same bytes.
 */
import { describe, expect, it, vi } from 'vitest';
import {
    FORUM_ASK_CHECK_MS,
    FORUM_ASK_CHECK_WORDS,
    FORUM_ASK_POSTS,
    FORUM_ASK_WORDS,
    FORUM_LIMITS,
    checkKnockForumPost,
    cleanForumAskTitle,
    forumAskCheckOf,
    forumAskJsonUrl,
    forumAskPageUrl,
    forumPostProof,
    knockForumRowView,
    readForumAskNamed,
    readForumAskPick,
    readForumAskPosts,
    readKnockForum,
    t,
    type ForumAskResult,
    type KnockForumPost,
} from '../index.js';
import { FORUM_PROOF_VECTORS, FORUM_VECTOR_KEY, FORUM_VECTOR_OTHER_KEY, FORUM_VECTOR_SECRET } from '../forum-vectors.js';

const AT = 'https://forum.example';
const [mine] = FORUM_PROOF_VECTORS;
/** A row as the community keeps it: the post it names, and the proof it made with the asking key (the vector's) and the asker's secret. */
const row: KnockForumPost = { postId: mine.postId, topicId: 'ft-1', number: 4, proof: mine.proof };
/** The worldwide forum's public JSON for that topic, starting at the post, with the proof its writer's key makes. */
const answer = (proof: string | undefined, id = mine.postId) =>
    ({ topic: { id: 'ft-1', title: 'Seed swap ideas' }, posts: [{ id, topicId: 'ft-1', number: 4, words: 'Bring seeds.', proof }] });
/** What the forum shows of that post, as the check reads it from the answer. */
const SHOWN = { title: 'Seed swap ideas', words: 'Bring seeds.', topicId: 'ft-1', number: 4 };

describe('what travels', () => {
    it('a pick reads whole or not at all', () => {
        expect(readForumAskPick({ postId: 'fp-1', topicId: 'ft-1', number: 2, title: '  Seed\nswap  ' })).toEqual({ postId: 'fp-1', topicId: 'ft-1', number: 2, title: 'Seed swap' });
        for (const bad of [null, [], { postId: 'fp 1', topicId: 'ft-1', number: 1, title: 'x' }, { postId: 'fp-1', topicId: 'ft-1', number: 0, title: 'x' },
            { postId: 'fp-1', topicId: 'ft-1', number: 1.5, title: 'x' }, { postId: 'fp-1', topicId: 'ft-1', number: 1, title: '   ' }, { postId: 'x'.repeat(65), topicId: 'ft-1', number: 1, title: 'x' }]) {
            expect(readForumAskPick(bad)).toBeNull();
        }
        expect(cleanForumAskTitle('é'.repeat(300))).toHaveLength(FORUM_LIMITS.title);
    });

    it('a post a request names is the post, its topic and its number: a title or words sent with it are dropped, and none is needed', () => {
        const named = { postId: 'fp-1', topicId: 'ft-1', number: 2 };
        expect(readForumAskNamed({ ...named, title: 'Ran the seed swap for two years', words: 'I organised every swap.' })).toEqual(named);
        expect(readForumAskNamed(named)).toEqual(named);
        expect(readForumAskNamed({ ...named, title: '' })).toEqual(named);
        for (const bad of [{ ...named, topicId: '' }, { ...named, number: undefined }, { ...named, postId: 7 }]) expect(readForumAskNamed(bad)).toBeNull();
        expect(readKnockForum({ at: AT, posts: [{ ...row, title: 'Made up', words: 'Made up too' }] })).toEqual({ at: AT, posts: [row] });
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
        expect(forumAskCheckOf(row, answer(mine.proof))).toEqual({ check: 'same', shown: SHOWN });
        expect(forumAskCheckOf(row, answer(FORUM_PROOF_VECTORS[1].proof))).toEqual({ check: 'other', shown: SHOWN });
        // Another person wrote it: the forum's proof is made with their key (and their secret).
        expect(forumAskCheckOf(row, answer(forumPostProof({ postId: mine.postId, writerKey: FORUM_VECTOR_OTHER_KEY, secret: FORUM_VECTOR_SECRET }))).check).toBe('other');
        expect(forumAskCheckOf(row, answer(FORUM_PROOF_VECTORS[2].proof)).check).toBe('other');
        expect(forumAskCheckOf(row, answer(undefined)).check).toBe('other');
        expect(forumAskCheckOf(row, answer(mine.proof, 'fp-later')).check).toBe('gone');
        expect(forumAskCheckOf(row, null).check).toBe('gone');
        expect(forumAskCheckOf(row, { nothing: true }).check).toBe('unknown');
        expect(forumPostProof({ postId: mine.postId, writerKey: FORUM_VECTOR_KEY, secret: FORUM_VECTOR_SECRET })).toBe(row.proof);
    });

    it("what it shows is the forum's: the post's own topic and number, the title only of that topic; a post without them isn't the forum's answer", () => {
        const base = answer(mine.proof);
        const withPost = (post: Record<string, unknown>, topic: unknown = base.topic) => ({ topic, posts: [{ ...base.posts[0], ...post }] });
        // Named as number 2, the forum has it at 4 (on the same page): the forum's number.
        expect(forumAskCheckOf({ ...row, number: 2 }, base)).toEqual({ check: 'same', shown: SHOWN });
        expect(forumAskCheckOf(row, withPost({}, { id: 'ft-elsewhere', title: 'Another topic' })).shown?.title).toBeNull();
        expect(forumAskCheckOf(row, withPost({}, { id: 'ft-1', title: '  Seed\nswap\tideas ' })).shown?.title).toBe('Seed swap ideas');
        expect(forumAskCheckOf(row, withPost({}, null)).shown).toEqual({ ...SHOWN, title: null });
        expect(forumAskCheckOf(row, withPost({ words: 7 })).shown?.words).toBeNull();
        expect(forumAskCheckOf(row, withPost({ topicId: undefined }))).toEqual({ check: 'unknown', shown: null });
        expect(forumAskCheckOf(row, withPost({ number: '4' }))).toEqual({ check: 'unknown', shown: null });
        expect(forumAskCheckOf(row, 'not json')).toEqual({ check: 'unknown', shown: null });
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

/**
 * Closing the class (round 2 of #3242): nothing the request carried is ever drawn as the forum's. One table:
 *   (a field a hand-made request carries: title, words, topicId, number)
 *   x (what the asker put there: the forum's own value, a made-up one, empty)
 *   x (the check: the same key wrote it, another key did, could not check)
 *   -> what the row shows, both apps (knockForumRowView, which each app draws, and nothing else).
 * The forum is the real check reading a stubbed answer: topic ft-1 "Seed swap ideas", the post at number 4, "Bring seeds.".
 * Every title, word, topic and number beside or under the tick is that answer's; before a check, and when it couldn't ask,
 * the row says only that a post was named. The asker's made-up values show nowhere on the row, under the tick or not.
 */
describe("what a row shows comes from the forum's answer, never from the request", () => {
    const FORUM = { title: 'Seed swap ideas', words: 'Bring seeds.', topicId: 'ft-1', number: 4 };
    const MADE_UP = { title: 'Ran the seed swap for two years', words: 'I organised every swap since 2019.', topicId: 'ft-madeup', number: 2 };
    const fields = ['title', 'words', 'topicId', 'number'] as const;
    const values = ['forum', 'made up', 'empty'] as const;
    const checks: Record<string, string | null> = { 'same key': mine.proof, 'other key': FORUM_PROOF_VECTORS[1].proof, 'could not check': null };

    /** The forum: its JSON for ft-1 holds the post at 4, in pages of 30 after `after`; any other topic is not there (404). */
    const forumFetch = (proof: string | null) => async (url: string) => {
        if (proof === null) throw new TypeError('Network request failed');
        const u = new URL(url);
        const after = Number(u.searchParams.get('after'));
        if (u.pathname.split('/').pop() !== FORUM.topicId) return { ok: false, status: 404, json: async () => ({ code: 'not_found' }) };
        const posts = FORUM.number > after && FORUM.number <= after + 30
            ? [{ id: mine.postId, topicId: FORUM.topicId, number: FORUM.number, words: FORUM.words, proof }] : [];
        return { ok: true, status: 200, json: async () => ({ topic: { id: FORUM.topicId, title: FORUM.title }, posts }) };
    };
    const named = () => t(FORUM_ASK_WORDS.named);
    const fromForum = () => t(FORUM_ASK_WORDS.fromForum, { title: FORUM.title });

    it.each(fields.flatMap((field) => values.flatMap((value) => Object.keys(checks).map((check) => [field, value, check] as const))))(
        '%s · %s · %s',
        async (field, value, checkName) => {
            const sent: Record<string, unknown> = { postId: mine.postId, topicId: FORUM.topicId, number: FORUM.number, proof: mine.proof };
            sent[field] = value === 'forum' ? FORUM[field] : value === 'made up' ? MADE_UP[field] : field === 'number' ? undefined : '';
            const forum = readKnockForum({ at: AT, posts: [sent] });
            // A request that names no topic or no number names no post: no row (and the community refuses it: bad_forum_posts).
            if (value === 'empty' && (field === 'topicId' || field === 'number')) { expect(forum).toBeNull(); return; }
            const post = forum!.posts[0];
            expect(post).toEqual({
                postId: mine.postId, proof: mine.proof,
                topicId: field === 'topicId' ? sent.topicId : FORUM.topicId, number: field === 'number' ? sent.number : FORUM.number,
            });

            // Before a tap, and while it waits: only that a post was named.
            for (const [state, line] of [[undefined, t(FORUM_ASK_WORDS.tapToCheck)], ['checking', t(FORUM_ASK_CHECK_WORDS.checking)]] as const) {
                expect(knockForumRowView(AT, post, state)).toEqual({ headline: named(), line, tone: null, words: null, openUrl: null, label: `${named()}. ${line}` });
            }

            const proof = checks[checkName];
            const result: ForumAskResult = await checkKnockForumPost(AT, post, { fetchImpl: forumFetch(proof) });
            const view = knockForumRowView(AT, post, result);
            const want = proof === null ? 'unknown' : field === 'topicId' && value === 'made up' ? 'gone' : proof === mine.proof ? 'same' : 'other';
            expect(result.check).toBe(want);
            const line = t(FORUM_ASK_CHECK_WORDS[want]);
            if (want === 'same' || want === 'other') {
                // The forum's title, words, topic and number (the link lands at 4, wherever the request said it was).
                expect(view).toEqual({ headline: fromForum(), line, tone: want, words: FORUM.words, openUrl: forumAskPageUrl(AT, FORUM), label: `${fromForum()}. ${line}` });
            } else {
                // Not there, or could not check: only that a post was named. Could not check links to the forum's own page for it.
                expect(view).toEqual({
                    headline: named(), line, tone: null, words: null,
                    openUrl: want === 'unknown' ? forumAskPageUrl(AT, post) : null, label: `${named()}. ${line}`,
                });
            }
            const drawn = [view.headline, view.line, view.words ?? '', view.label].join(' | ');
            for (const madeUp of [MADE_UP.title, MADE_UP.words, MADE_UP.topicId]) expect(drawn).not.toContain(madeUp);
        },
    );
});
