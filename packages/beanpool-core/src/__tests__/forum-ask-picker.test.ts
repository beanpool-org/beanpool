/**
 * The asker's picker on Ask to join (forums F11b; DESIGN-forums-fable.md §13): what a request carries of the asker's picks.
 * Both apps build the request's `forumPosts` and `forumSecret` with core's forumAskSend and pick with toggleForumAskPick, so
 * this table is the app side of the invariant: the request carries only posts the asker wrote (the worldwide community's
 * list for their key), at most three, each once, named by post, topic and number only.
 *
 * Axes: how many picked (0, 1, 3, 4) × another writer's post among them × a post gone from the list (deleted since, or never
 * the asker's to offer). The list is read through readForumAskPosts, as both apps read the worldwide community's answer.
 */
import { describe, expect, it } from 'vitest';
import {
    FORUM_ASK_POSTS,
    forumAskPickView,
    forumAskSend,
    readForumAskNamed,
    readForumAskPosts,
    toggleForumAskPick,
    type ForumAskPosts,
} from '../index.js';

const SECRET = 'ab'.repeat(32);
/** Asha's four public posts, as the worldwide community answers GET /api/forum/ask-posts for her key (newest first). */
const RAW = {
    secret: SECRET,
    posts: [
        { postId: 'fp-a1', topicId: 'ft-tools', number: 1, title: 'A tool library for the hill' },
        { postId: 'fp-a2', topicId: 'ft-tools', number: 4, title: 'A tool library for the hill' },
        { postId: 'fp-a3', topicId: 'ft-bikes', number: 1, title: 'I can fix bikes on weekends' },
        { postId: 'fp-a4', topicId: 'ft-seeds', number: 7, title: 'Starting a seed library' },
    ],
};
const OFFERED = readForumAskPosts(RAW) as ForumAskPosts;
const OWN = ['fp-a1', 'fp-a2', 'fp-a3', 'fp-a4'];
/** Ben's post in the same topic: real, public, and not Asha's, so never on her list. */
const OTHERS = 'fp-ben';
/** Asha's post she deleted after the list was read once: the list read now doesn't have it. */
const DELETED = 'fp-a5';
const named = (id: string) => {
    const p = RAW.posts.find((x) => x.postId === id)!;
    return { postId: p.postId, topicId: p.topicId, number: p.number };
};

describe('forumAskSend: what a request to join carries', () => {
    const counts = [0, 1, 3, 4];
    const rows: { picks: string[]; sends: string[] }[] = [];
    for (const n of counts) {
        for (const withOthers of [false, true]) {
            for (const withDeleted of [false, true]) {
                const picks = [
                    ...(withOthers ? [OTHERS] : []),
                    ...OWN.slice(0, n),
                    ...(withDeleted ? [DELETED] : []),
                ];
                // Expected, written out from the rule: only Asha's own, in the order picked, the first three.
                rows.push({ picks, sends: OWN.slice(0, Math.min(n, FORUM_ASK_POSTS)) });
            }
        }
    }

    it.each(rows)('picked $picks -> sends $sends', ({ picks, sends }) => {
        const out = forumAskSend(OFFERED, picks);
        if (sends.length === 0) {
            expect(out).toBeNull();
            return;
        }
        expect(out).toEqual({ forumPosts: sends.map(named), forumSecret: SECRET });
        // Each post as the community reads it, whole: nothing but its id, topic and number (no title, no words).
        for (const p of out!.forumPosts) {
            expect(Object.keys(p).sort()).toEqual(['number', 'postId', 'topicId']);
            expect(readForumAskNamed(p)).toEqual(p);
        }
        // No title: none of the four titles' words travels (the topic ids are ft-tools, ft-bikes, ft-seeds).
        expect(JSON.stringify(out)).not.toMatch(/library|weekends|title/);
        expect(out!.forumPosts.map((p) => p.postId)).not.toContain(OTHERS);
        expect(out!.forumPosts.map((p) => p.postId)).not.toContain(DELETED);
    });

    it('measured: 16 rows, 4 send nothing, none sends more than three or anyone else’s', () => {
        expect(rows).toHaveLength(16);
        expect(rows.filter((r) => forumAskSend(OFFERED, r.picks) === null)).toHaveLength(4);
        for (const r of rows) expect((forumAskSend(OFFERED, r.picks)?.forumPosts.length ?? 0)).toBeLessThanOrEqual(FORUM_ASK_POSTS);
    });

    it('only another writer’s post, or only a deleted one: nothing is sent', () => {
        expect(forumAskSend(OFFERED, [OTHERS])).toBeNull();
        expect(forumAskSend(OFFERED, [DELETED])).toBeNull();
        expect(forumAskSend(OFFERED, [OTHERS, DELETED])).toBeNull();
    });

    it('the list read again without a deleted post: a pick of it is dropped, the rest go', () => {
        const before = readForumAskPosts({ secret: SECRET, posts: [...RAW.posts, { postId: DELETED, topicId: 'ft-old', number: 2, title: 'Old' }] });
        expect(forumAskSend(before, ['fp-a1', DELETED])?.forumPosts.map((p) => p.postId)).toEqual(['fp-a1', DELETED]);
        expect(forumAskSend(OFFERED, ['fp-a1', DELETED])?.forumPosts.map((p) => p.postId)).toEqual(['fp-a1']);
    });

    it('a post picked twice goes once; the order is the order picked', () => {
        expect(forumAskSend(OFFERED, ['fp-a3', 'fp-a1', 'fp-a3'])?.forumPosts.map((p) => p.postId)).toEqual(['fp-a3', 'fp-a1']);
    });

    it('no list (not on the worldwide community, or it could not be read), or one with no secret: nothing is sent', () => {
        expect(forumAskSend(null, ['fp-a1'])).toBeNull();
        expect(forumAskSend({ secret: 'not-hex', posts: OFFERED.posts }, ['fp-a1'])).toBeNull();
        expect(forumAskSend(readForumAskPosts({ secret: SECRET, posts: [] }), ['fp-a1'])).toBeNull();
    });

    it('a list that names one post twice still sends it once', () => {
        const twice = { secret: SECRET, posts: [OFFERED.posts[0], { ...OFFERED.posts[0], number: 9 }] };
        expect(forumAskSend(twice, ['fp-a1'])).toEqual({ forumPosts: [named('fp-a1')], forumSecret: SECRET });
    });
});

describe('forumAskPickView: what one row shows', () => {
    it('the forum’s title, where the post is in its topic, and both as the row’s name', () => {
        expect(forumAskPickView(OFFERED.posts[1])).toEqual({
            title: 'A tool library for the hill', where: 'Post 4', label: 'A tool library for the hill. Post 4',
        });
    });
});

describe('toggleForumAskPick: tap to pick, tap again to take it off', () => {
    it('picks up to three; a fourth tap changes nothing; a picked one comes off', () => {
        let picked: string[] = [];
        for (const id of OWN) picked = toggleForumAskPick(picked, id);
        expect(picked).toEqual(['fp-a1', 'fp-a2', 'fp-a3']);
        picked = toggleForumAskPick(picked, 'fp-a2');
        expect(picked).toEqual(['fp-a1', 'fp-a3']);
        picked = toggleForumAskPick(picked, 'fp-a4');
        expect(picked).toEqual(['fp-a1', 'fp-a3', 'fp-a4']);
        expect(forumAskSend(OFFERED, picked)?.forumPosts.map((p) => p.postId)).toEqual(['fp-a1', 'fp-a3', 'fp-a4']);
    });

    it('never changes the list it was given', () => {
        const picked = Object.freeze(['fp-a1', 'fp-a2', 'fp-a3']);
        expect(toggleForumAskPick(picked, 'fp-a4')).not.toBe(picked);
        expect(toggleForumAskPick(picked, 'fp-a1')).toEqual(['fp-a2', 'fp-a3']);
        expect(picked).toEqual(['fp-a1', 'fp-a2', 'fp-a3']);
    });
});
