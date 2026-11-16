/**
 * People → Invites → "Wants to join" on the web, with forum posts on a request (forums F11; DESIGN-forums-fable.md §13, §14:
 * 320 px, 1.3× text). The phone's twin is apps/native/utils/__tests__/knock-forum-posts-render.test.ts: the same rows, the same
 * line for each outcome, the same table.
 *
 * The real WantsToJoin, KnockForumPosts, lib/api.ts reader and @beanpool/core check. The community's list and the worldwide
 * forum's public JSON are a stubbed fetch, by address: the asker's own post (its proof the kept one), another person's (another
 * proof), one not there (404), the forum unreachable, the forum slower than the wait. Nothing is asked of the worldwide forum
 * before a tap, and the request's buttons work whatever the check says.
 *
 * Round 2 of #3242: every title, word, topic and number on a row is the forum's answer at the check, never the request's (the
 * list below carries made-up titles, as a hand-made request would, and they never show); the line's id names the request,
 * so two requests naming one post keep their own; the button's name carries the check's line.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { FORUM_ASK_CHECK_WORDS, FORUM_ASK_WORDS, forumAskPageUrl, readKnockForum, t, type ForumAskCheck } from '@beanpool/core';
import { FORUM_PROOF_VECTORS } from '@beanpool/core/forum-vectors';

vi.mock('../lib/identity', async (orig) => ({ ...(await orig<typeof import('../lib/identity')>()), loadIdentity: vi.fn(async () => null) }));

import { WantsToJoin } from './WantsToJoin';
import { KnockForumPosts } from './KnockForumPosts';

const FORUM = 'https://forum.example';
const MINE = FORUM_PROOF_VECTORS[0];
const OTHERS = FORUM_PROOF_VECTORS[1];
/** The forum's own title for the asker's topic: long, so it must wrap at 320 px. */
const OWN_TITLE = 'Starting a seed library in a small town hall with neighbours';
/** Each row carries a title the asker made up, as a hand-made request would: none may ever show. */
const MADE_UP = 'Ran the seed swap for two years';
const POSTS = {
    own: { postId: MINE.postId, topicId: 'ft-own', number: 2, title: MADE_UP, proof: MINE.proof },
    other: { postId: 'fp-other', topicId: 'ft-other', number: 1, title: MADE_UP, proof: MINE.proof },
    gone: { postId: 'fp-gone', topicId: 'ft-gone', number: 3, title: MADE_UP, proof: MINE.proof },
    down: { postId: 'fp-down', topicId: 'ft-down', number: 1, title: MADE_UP, proof: MINE.proof },
    slow: { postId: 'fp-slow', topicId: 'ft-slow', number: 1, title: MADE_UP, proof: MINE.proof },
};
const TODAY = new Date().toISOString();
const KNOCKS = [
    { id: 'k1', pubkey: 'b'.repeat(64), callsign: 'Asha', message: 'I keep bees.', avatar: null, fromNode: null, createdAt: TODAY, via: null,
        forum: { at: FORUM, posts: [POSTS.own, POSTS.other, POSTS.gone] } },
    { id: 'k2', pubkey: 'c'.repeat(64), callsign: 'Ben', message: 'I fix bikes.', avatar: null, fromNode: null, createdAt: TODAY, via: null,
        forum: { at: FORUM, posts: [POSTS.down, POSTS.slow, { ...POSTS.own, postId: 'fp-x', proof: 'zz' }] } },
    { id: 'k3', pubkey: 'd'.repeat(64), callsign: 'Cy', message: 'Hello.', avatar: null, fromNode: null, createdAt: TODAY, via: null, forum: null },
];
/** Mallory names Asha's post: the community kept the proof Mallory's key makes (another key's), so it isn't hers. */
const MALLORY = { id: 'k4', pubkey: 'e'.repeat(64), callsign: 'Mallory', message: 'Hi.', avatar: null, fromNode: null, createdAt: TODAY, via: null,
    forum: { at: FORUM, posts: [{ ...POSTS.own, proof: OTHERS.proof }] } };

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const forumAsked: string[] = [];
function serve(knocks: unknown[] = KNOCKS) {
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL) => {
        const url = String(input);
        if (!url.startsWith(FORUM)) return Promise.resolve(json(200, { knocks, total: knocks.length }));
        forumAsked.push(url);
        const topic = new URL(url).pathname.split('/').pop();
        if (topic === 'ft-own') return Promise.resolve(json(200, { topic: { id: 'ft-own', title: OWN_TITLE }, posts: [{ id: MINE.postId, topicId: 'ft-own', number: 2, words: 'We started with one shelf.', proof: MINE.proof }] }));
        if (topic === 'ft-other') return Promise.resolve(json(200, { topic: { id: 'ft-other', title: 'Rainwater tanks' }, posts: [{ id: 'fp-other', topicId: 'ft-other', number: 1, words: 'Ben asks about tanks.', proof: OTHERS.proof }] }));
        if (topic === 'ft-gone') return Promise.resolve(json(404, { code: 'not_found' }));
        if (topic === 'ft-down') return Promise.reject(new TypeError('Failed to fetch'));
        return new Promise<Response>(() => { /* slow: never answers */ });
    }));
}

beforeEach(() => { localStorage.clear(); forumAsked.length = 0; });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.useRealTimers(); });

const row = (knock: string, post: string) => screen.queryByTestId(`knock-forum-${knock}-${post}`);
const lineOf = (knock: string, post: string) => screen.queryByTestId(`knock-forum-check-${knock}-${post}`)?.textContent ?? null;
/** The row's button's accessible name, as a screen reader reads it. */
function nameOf(knock: string, post: string): string {
    let name = '';
    within(row(knock, post)!).getByRole('button', { name: (n) => { name = n; return true; } });
    return name;
}
async function tap(knock: string, post: string, settled: string | RegExp) {
    fireEvent.click(within(row(knock, post)!).getByRole('button'));
    await screen.findByText(settled, { selector: `[data-testid="knock-forum-check-${knock}-${post}"]` });
}

describe('forum posts under a request to join, on the web at 320 px', () => {
    it('draws one row a post saying only that a post was named, and asks the worldwide forum nothing before a tap', async () => {
        serve();
        render(<WantsToJoin />);
        const own = await screen.findByTestId(`knock-forum-k1-${MINE.postId}`);
        const button = within(own).getByRole('button');
        expect(own.textContent).toBe(`${FORUM_ASK_WORDS.named}› ${FORUM_ASK_WORDS.tapToCheck}`);
        expect(button.className).toContain('min-h-[48px]');
        expect(nameOf('k1', MINE.postId)).toBe(`${FORUM_ASK_WORDS.named} ${FORUM_ASK_WORDS.tapToCheck}`);
        expect(document.body.textContent).not.toContain(MADE_UP);
        expect(row('k2', 'fp-x')).toBeNull();
        expect(screen.queryByTestId('knock-forum-k3')).toBeNull();
        expect(forumAsked).toEqual([]);
        expect(screen.getByRole('button', { name: 'Invite Asha' })).toBeTruthy();
    });

    it("after a check that read the post: the forum's title, whole, and its words; never the title the request carried", async () => {
        serve();
        render(<WantsToJoin />);
        await screen.findByTestId(`knock-forum-k1-${MINE.postId}`);
        await tap('k1', MINE.postId, FORUM_ASK_CHECK_WORDS.same);
        const own = row('k1', MINE.postId)!;
        const headline = `From the worldwide forum: ${OWN_TITLE}`;
        // The title wraps at 320 px: no truncation or line cap on it.
        const titleEl = within(own).getByText(headline);
        expect(titleEl.className).toContain('break-words');
        expect(titleEl.className).not.toMatch(/truncate|line-clamp/);
        expect(within(own).getByText('We started with one shelf.')).toBeTruthy();
        expect(nameOf('k1', MINE.postId)).toBe(`${headline} ${FORUM_ASK_CHECK_WORDS.same}`);
        expect(document.body.textContent).not.toContain(MADE_UP);
    });

    it('each outcome its line: the same key ✓, another key, not there now, unreachable', async () => {
        serve();
        render(<WantsToJoin />);
        await screen.findByTestId(`knock-forum-k1-${MINE.postId}`);
        await tap('k1', MINE.postId, FORUM_ASK_CHECK_WORDS.same);
        await tap('k1', 'fp-other', FORUM_ASK_CHECK_WORDS.other);
        expect(row('k1', 'fp-other')!.textContent).toContain('From the worldwide forum: Rainwater tanks');
        await tap('k1', 'fp-gone', FORUM_ASK_CHECK_WORDS.gone);
        await tap('k2', 'fp-down', FORUM_ASK_CHECK_WORDS.unknown);
        expect(row('k1', 'fp-gone')!.textContent).toBe(`${FORUM_ASK_WORDS.named}› ${FORUM_ASK_CHECK_WORDS.gone}`);
        expect(row('k2', 'fp-down')!.textContent).toBe(`${FORUM_ASK_WORDS.named}› ${FORUM_ASK_CHECK_WORDS.unknown}${FORUM_ASK_WORDS.open}`);
        expect(forumAsked).toEqual([
            `${FORUM}/api/forum/public/topics/ft-own?after=1`, `${FORUM}/api/forum/public/topics/ft-other?after=0`,
            `${FORUM}/api/forum/public/topics/ft-gone?after=2`, `${FORUM}/api/forum/public/topics/ft-down?after=0`,
        ]);
        expect(document.body.textContent).not.toContain(MADE_UP);
    });

    it('slow: "Checking…" while it waits, then "Could not check" at the wait; the buttons answer meanwhile', async () => {
        serve();
        render(<WantsToJoin />);
        await screen.findByTestId('knock-forum-k2-fp-slow');
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
        const button = within(row('k2', 'fp-slow')!).getByRole('button');
        await act(async () => { fireEvent.click(button); });
        expect(lineOf('k2', 'fp-slow')).toBe(FORUM_ASK_CHECK_WORDS.checking);
        expect(button.getAttribute('aria-busy')).toBe('true');
        expect(screen.getByRole('button', { name: 'Not now, Ben' })).toBeTruthy();
        await act(async () => { vi.advanceTimersByTime(8_100); });
        vi.useRealTimers();
        await screen.findByText(FORUM_ASK_CHECK_WORDS.unknown, { selector: '[data-testid="knock-forum-check-k2-fp-slow"]' });
    });

    it('"Open in the forum" lands where the forum has the post, in a new tab, after a check that found it; none for a post not there', async () => {
        serve();
        render(<WantsToJoin />);
        await screen.findByTestId(`knock-forum-k1-${MINE.postId}`);
        await tap('k1', MINE.postId, FORUM_ASK_CHECK_WORDS.same);
        await tap('k1', 'fp-gone', FORUM_ASK_CHECK_WORDS.gone);
        const link = within(row('k1', MINE.postId)!).getByRole('link', { name: FORUM_ASK_WORDS.open });
        expect(link.getAttribute('href')).toBe(forumAskPageUrl(FORUM, { topicId: 'ft-own', number: 2 }));
        expect(link.getAttribute('target')).toBe('_blank');
        expect(link.getAttribute('rel')).toContain('noopener');
        expect(within(row('k1', 'fp-gone')!).queryByRole('link')).toBeNull();
    });

    it("two requests naming the same post: each line's id is its own, and each button is described by its own row's answer", async () => {
        serve([KNOCKS[0], MALLORY]);
        render(<WantsToJoin />);
        await screen.findByTestId(`knock-forum-k4-${MINE.postId}`);
        await tap('k1', MINE.postId, FORUM_ASK_CHECK_WORDS.same);
        await tap('k4', MINE.postId, FORUM_ASK_CHECK_WORDS.other);
        const ids = Array.from(document.querySelectorAll('[id]'), (el) => el.id);
        expect(new Set(ids).size).toBe(ids.length);
        for (const [knock, check] of [['k1', 'same'], ['k4', 'other']] as const) {
            const button = within(row(knock, MINE.postId)!).getByRole('button');
            const described = document.getElementById(button.getAttribute('aria-describedby') ?? '');
            expect(row(knock, MINE.postId)!.contains(described)).toBe(true);
            expect(described?.textContent).toBe(FORUM_ASK_CHECK_WORDS[check]);
            expect(nameOf(knock, MINE.postId)).toContain(FORUM_ASK_CHECK_WORDS[check]);
        }
    });
});

/**
 * Closing the class, the web's half (core runs the same table on knockForumRowView; the phone runs it too):
 *   (a field a hand-made request carries: title, words, topicId, number) x (the forum's own value, a made-up one, empty)
 *   x (the check: the same key, another key, could not check) -> what the row shows and its button's name.
 * Every title, word, topic and number on the row is the forum's answer; the made-up values show nowhere.
 */
describe("closing the class: a row shows the forum's answer, never what the request carried", () => {
    const REAL = { title: 'Seed swap ideas', words: 'Bring seeds.', topicId: 'ft-1', number: 4 };
    const FAKE = { title: 'Ran the seed swap for two years', words: 'I organised every swap since 2019.', topicId: 'ft-madeup', number: 2 };
    const checks: Record<string, string | null> = { 'same key': MINE.proof, 'other key': OTHERS.proof, 'could not check': null };
    const cases = (['title', 'words', 'topicId', 'number'] as const)
        .flatMap((field) => (['forum', 'made up', 'empty'] as const).flatMap((value) => Object.keys(checks).map((check) => [field, value, check] as const)));

    it.each(cases)('%s · %s · %s', async (field, value, checkName) => {
        const proof = checks[checkName];
        vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL) => {
            if (proof === null) return Promise.reject(new TypeError('Failed to fetch'));
            const u = new URL(String(input));
            const after = Number(u.searchParams.get('after'));
            if (u.pathname.split('/').pop() !== REAL.topicId) return Promise.resolve(json(404, { code: 'not_found' }));
            const posts = REAL.number > after && REAL.number <= after + 30 ? [{ id: MINE.postId, topicId: REAL.topicId, number: REAL.number, words: REAL.words, proof }] : [];
            return Promise.resolve(json(200, { topic: { id: REAL.topicId, title: REAL.title }, posts }));
        }));
        const sent: Record<string, unknown> = { postId: MINE.postId, topicId: REAL.topicId, number: REAL.number, proof: MINE.proof };
        sent[field] = value === 'forum' ? REAL[field] : value === 'made up' ? FAKE[field] : field === 'number' ? undefined : '';
        const forum = readKnockForum({ at: FORUM, posts: [sent] });
        if (value === 'empty' && (field === 'topicId' || field === 'number')) { expect(forum).toBeNull(); return; }
        render(<KnockForumPosts forum={forum!} knockId="k1" />);
        expect(row('k1', MINE.postId)!.textContent).toBe(`${FORUM_ASK_WORDS.named}› ${FORUM_ASK_WORDS.tapToCheck}`);

        const want: ForumAskCheck = proof === null ? 'unknown' : field === 'topicId' && value === 'made up' ? 'gone' : proof === MINE.proof ? 'same' : 'other';
        const line = t(FORUM_ASK_CHECK_WORDS[want]);
        await tap('k1', MINE.postId, line);
        const el = row('k1', MINE.postId)!;
        const read = want === 'same' || want === 'other';
        const headline = read ? t(FORUM_ASK_WORDS.fromForum, { title: REAL.title }) : t(FORUM_ASK_WORDS.named);
        const link = within(el).queryByRole('link');
        expect(el.textContent).toBe(`${headline}› ${line}${read ? REAL.words : ''}${read || want === 'unknown' ? FORUM_ASK_WORDS.open : ''}`);
        expect(nameOf('k1', MINE.postId)).toBe(`${headline} ${line}`);
        expect(link?.getAttribute('href') ?? null).toBe(read ? forumAskPageUrl(FORUM, REAL) : want === 'unknown' ? forumAskPageUrl(FORUM, forum!.posts[0]) : null);
        for (const madeUp of [FAKE.title, FAKE.words, FAKE.topicId]) expect(`${el.textContent} ${nameOf('k1', MINE.postId)}`).not.toContain(madeUp);
    });
});
