/**
 * The forum in core (slice F0; scratch/fable-design/DESIGN-forums-fable.md §2, §5, §7, §13, §21, as changed by the joint
 * design §2.6): its limits, starter sections, link and mention rules, the order topics list in, the fields a public answer
 * may hold, and the proof an Ask to join carries, held to frozen vectors made independently with Node's HMAC.
 */
import { describe, expect, it } from 'vitest';
import {
    FORUM_DAY_LIMITS,
    FORUM_LIMITS,
    FORUM_PROOF_TAG,
    FORUM_PUBLIC_FIELDS,
    FORUM_STARTER_SECTIONS,
    FORUM_TIMES,
    compareForumTopics,
    forumLinks,
    forumLinksFit,
    forumMentions,
    forumMentionsFit,
    forumOn,
    forumPostProof,
    forumPostProofMatches,
    forumPublicShapeProblems,
    forumSectionName,
    forumStarterSection,
    forumWordRuns,
    nameLine,
} from '../index.js';
import {
    FORUM_PROOF_VECTORS,
    FORUM_PUBLIC_NEVER,
    FORUM_PUBLIC_POST_OK,
    FORUM_PUBLIC_TOPIC_OK,
    FORUM_VECTOR_KEY,
    FORUM_VECTOR_OTHER_KEY,
    FORUM_VECTOR_OTHER_SECRET,
    FORUM_VECTOR_SECRET,
} from '../forum-vectors.js';

describe('limits', () => {
    it('are the design’s numbers, frozen', () => {
        expect(FORUM_LIMITS).toMatchObject({ title: 100, opening: 5000, reply: 3000, photos: 3, place: 80, mentions: 5, links: 5, sections: 12, pinsPerSection: 2, postsPerPage: 30, topicLinks: 3 });
        expect(FORUM_DAY_LIMITS).toEqual({ known: { topics: 10, replies: 100 }, new: { topics: 2, replies: 10 }, newWords: { topics: 1, replies: 5 } });
        expect(FORUM_TIMES).toEqual({ newEditMinutes: 60, quietCloseDays: 180, editsKeptDays: 30, firstLookDays: 30, indexAfterDays: 2 });
        for (const o of [FORUM_LIMITS, FORUM_DAY_LIMITS, FORUM_DAY_LIMITS.known, FORUM_TIMES, FORUM_STARTER_SECTIONS, FORUM_PUBLIC_FIELDS]) expect(Object.isFrozen(o)).toBe(true);
    });
    it('a server that says nothing has no forum', () => {
        expect(forumOn({ forum: true })).toBe(true);
        expect(forumOn({})).toBe(false);
        expect(forumOn(null)).toBe(false);
        expect(forumOn({ forum: 'yes' })).toBe(false);
    });
});

describe('starter sections', () => {
    it('global: five, News for owners and admins, Introduce yourself never listed; local: General and Ideas (Marty, Q3)', () => {
        expect(FORUM_STARTER_SECTIONS.global.map((s) => s.id)).toEqual(['news', 'introduce', 'start-community', 'skills', 'ideas-beanpool']);
        expect(FORUM_STARTER_SECTIONS.global.filter((s) => s.starts === 'staff').map((s) => s.id)).toEqual(['news']);
        expect(forumStarterSection('introduce')?.listed).toBe(false);
        expect(FORUM_STARTER_SECTIONS.local.map((s) => [s.id, forumSectionName({ starter: s.id })])).toEqual([['general', 'General'], ['ideas-local', 'Ideas for our community']]);
        expect(FORUM_STARTER_SECTIONS.local.every((s) => s.starts === 'members' && !s.listed)).toBe(true);
    });
    it('a renamed section shows as typed; an unknown starter has no name', () => {
        expect(forumSectionName({ starter: null, name: 'Garden club' })).toBe('Garden club');
        expect(forumSectionName({ starter: 'news', name: null })).toBe('News from BeanPool');
        expect(forumSectionName({ starter: 'nope' })).toBe('');
    });
});

describe('links and mentions', () => {
    it('links are the chat’s: http, https, www; five fit, six do not', () => {
        expect(forumLinks('see https://a.example/x and www.b.example, not ftp://c.example or d.example')).toEqual(['https://a.example/x', 'www.b.example,']);
        expect(forumLinksFit('https://a.example '.repeat(5))).toBe(true);
        expect(forumLinksFit('https://a.example '.repeat(6))).toBe(false);
    });
    it('a new writer’s links are plain text', () => {
        expect(forumWordRuns('go to https://a.example now', true).some((r) => r.isUrl)).toBe(true);
        expect(forumWordRuns('go to https://a.example now', false).some((r) => r.isUrl)).toBe(false);
        expect(forumWordRuns('go to https://a.example now', false).map((r) => r.text).join('')).toBe('go to https://a.example now');
    });
    it('mentions: @name at a start or after a space, each once, never inside an address', () => {
        expect(forumMentions('@Asha thanks, and @Dax. @asha again; mail me@example.org')).toEqual(['Asha', 'Dax']);
        expect(forumMentions('(@Marty) hi')).toEqual(['Marty']);
        expect(forumMentions('@ alone')).toEqual([]);
        expect(forumMentionsFit('@a @b @c @d @e')).toBe(true);
        expect(forumMentionsFit('@a @b @c @d @e @f')).toBe(false);
    });
});

describe('the order topics list in', () => {
    it('pinned first, then the newest activity, then the id', () => {
        const topics = [
            { id: 'b', pinned: false, lastActivityAt: '2026-11-14T02:00:00.000Z' },
            { id: 'p', pinned: true, lastActivityAt: '2026-11-01T00:00:00.000Z' },
            { id: 'a', pinned: false, lastActivityAt: '2026-11-14T02:00:00.000Z' },
            { id: 'c', pinned: false, lastActivityAt: '2026-11-14T03:00:00.000Z' },
        ];
        expect([...topics].sort(compareForumTopics).map((t) => t.id)).toEqual(['p', 'c', 'a', 'b']);
    });
});

describe('what a public answer may hold', () => {
    it('every allowed field passes', () => {
        expect(forumPublicShapeProblems('topic', FORUM_PUBLIC_TOPIC_OK)).toEqual([]);
        expect(forumPublicShapeProblems('post', FORUM_PUBLIC_POST_OK)).toEqual([]);
        expect(forumPublicShapeProblems('section', { id: 's', starter: 'news', name: null, position: 0, topicCount: 2 })).toEqual([]);
    });
    it('any other field fails, on the topic, the post or its writer', () => {
        for (const field of FORUM_PUBLIC_NEVER) {
            expect(forumPublicShapeProblems('topic', { ...FORUM_PUBLIC_TOPIC_OK, [field]: 'x' })).toEqual([`topic.${field}`]);
            expect(forumPublicShapeProblems('post', { ...FORUM_PUBLIC_POST_OK, [field]: 'x' })).toEqual([`post.${field}`]);
            expect(forumPublicShapeProblems('post', { ...FORUM_PUBLIC_POST_OK, writer: { name: 'Asha', community: null, [field]: 'x' } })).toEqual([`writer.${field}`]);
        }
        expect(forumPublicShapeProblems('topic', null)).toEqual(['topic']);
        expect(forumPublicShapeProblems('post', [FORUM_PUBLIC_POST_OK])).toEqual(['post']);
    });
});

describe('the proof an Ask to join carries', () => {
    it('makes every frozen vector exactly', () => {
        expect(FORUM_PROOF_TAG).toBe('beanpool-forum-post-proof-v1');
        for (const v of FORUM_PROOF_VECTORS) {
            expect(forumPostProof(v)).toBe(v.proof);
            expect(forumPostProofMatches(v.proof, v)).toBe(true);
        }
    });
    it('a proof made with another key, another secret or for another post does not match', () => {
        const [mine, otherKey, otherSecret, otherPost] = FORUM_PROOF_VECTORS;
        const asking = { postId: mine.postId, writerKey: FORUM_VECTOR_KEY, secret: FORUM_VECTOR_SECRET };
        expect(forumPostProofMatches(otherKey.proof, asking)).toBe(false);
        expect(forumPostProofMatches(otherSecret.proof, asking)).toBe(false);
        expect(forumPostProofMatches(otherPost.proof, asking)).toBe(false);
        expect(forumPostProofMatches(mine.proof, { ...asking, writerKey: FORUM_VECTOR_OTHER_KEY })).toBe(false);
        expect(forumPostProofMatches(mine.proof, { ...asking, secret: FORUM_VECTOR_OTHER_SECRET })).toBe(false);
    });
    it('anything malformed is no match, never a throw; making one refuses a bad key or secret', () => {
        const ok = FORUM_PROOF_VECTORS[0];
        for (const proof of [undefined, null, 42, '', ok.proof.toUpperCase(), ok.proof.slice(1)]) expect(forumPostProofMatches(proof, ok)).toBe(false);
        expect(forumPostProofMatches(ok.proof, { ...ok, secret: 'nothex' })).toBe(false);
        expect(() => forumPostProof({ ...ok, writerKey: ok.writerKey.toUpperCase() })).toThrow();
        expect(() => forumPostProof({ ...ok, secret: ok.secret.slice(2) })).toThrow();
        expect(() => forumPostProof({ ...ok, postId: '' })).toThrow();
    });
});

describe('the name line (joint design §2.6)', () => {
    it('writes the four lines, and a name alone', () => {
        expect(nameLine({ name: 'Marty', kind: 'community', community: 'Riverside' })).toBe('Marty · Riverside');
        expect(nameLine({ name: 'Asha', kind: 'waiting' })).toBe('Asha · waiting to join');
        expect(nameLine({ name: 'Asha', kind: 'unconfirmed', community: 'Hillside' })).toBe('Asha · Hillside · name not confirmed');
        expect(nameLine({ name: 'Dax', kind: 'guest' })).toBe('Dax · guest');
        expect(nameLine({ name: 'Marty' })).toBe('Marty');
    });
    it('a community line with no community reads as the name alone', () => {
        expect(nameLine({ name: 'Marty', kind: 'community', community: '  ' })).toBe('Marty');
        expect(nameLine({ name: 'Asha', kind: 'unconfirmed', community: null })).toBe('Asha');
    });
});
