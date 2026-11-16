/**
 * People → Invites → "Wants to join" on the web, with forum posts on a request (forums F11; DESIGN-forums-fable.md §13, §14:
 * 320 px, 1.3× text). The phone's twin is apps/native/utils/__tests__/knock-forum-posts-render.test.ts: the same rows, the same
 * line for each outcome.
 *
 * The real WantsToJoin, KnockForumPosts, lib/api.ts reader and @beanpool/core check. The community's list and the worldwide
 * forum's public JSON are a stubbed fetch, by address: the asker's own post (its proof the kept one), another person's (another
 * proof), one not there (404), the forum unreachable, the forum slower than the wait. Nothing is asked of the worldwide forum
 * before a tap, and the request's buttons work whatever the check says.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { FORUM_ASK_CHECK_WORDS, FORUM_ASK_WORDS, forumAskPageUrl } from '@beanpool/core';
import { FORUM_PROOF_VECTORS } from '@beanpool/core/forum-vectors';

vi.mock('../lib/identity', async (orig) => ({ ...(await orig<typeof import('../lib/identity')>()), loadIdentity: vi.fn(async () => null) }));

import { WantsToJoin } from './WantsToJoin';

const FORUM = 'https://forum.example';
const MINE = FORUM_PROOF_VECTORS[0];
const OTHERS = FORUM_PROOF_VECTORS[1];
const POSTS = {
    own: { postId: MINE.postId, topicId: 'ft-own', number: 2, title: 'Starting a seed library in a small town hall with neighbours', proof: MINE.proof },
    other: { postId: 'fp-other', topicId: 'ft-other', number: 1, title: 'Rainwater tanks', proof: MINE.proof },
    gone: { postId: 'fp-gone', topicId: 'ft-gone', number: 3, title: 'A removed reply', proof: MINE.proof },
    down: { postId: 'fp-down', topicId: 'ft-down', number: 1, title: 'Bikes on Saturdays', proof: MINE.proof },
    slow: { postId: 'fp-slow', topicId: 'ft-slow', number: 1, title: 'Compost', proof: MINE.proof },
};
const TODAY = new Date().toISOString();
const KNOCKS = [
    { id: 'k1', pubkey: 'b'.repeat(64), callsign: 'Asha', message: 'I keep bees.', avatar: null, fromNode: null, createdAt: TODAY, via: null,
        forum: { at: FORUM, posts: [POSTS.own, POSTS.other, POSTS.gone] } },
    { id: 'k2', pubkey: 'c'.repeat(64), callsign: 'Ben', message: 'I fix bikes.', avatar: null, fromNode: null, createdAt: TODAY, via: null,
        forum: { at: FORUM, posts: [POSTS.down, POSTS.slow, { ...POSTS.own, postId: 'fp-x', proof: 'zz' }] } },
    { id: 'k3', pubkey: 'd'.repeat(64), callsign: 'Cy', message: 'Hello.', avatar: null, fromNode: null, createdAt: TODAY, via: null, forum: null },
];

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const forumAsked: string[] = [];
function serve() {
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL) => {
        const url = String(input);
        if (!url.startsWith(FORUM)) return Promise.resolve(json(200, { knocks: KNOCKS, total: KNOCKS.length }));
        forumAsked.push(url);
        const topic = new URL(url).pathname.split('/').pop();
        if (topic === 'ft-own') return Promise.resolve(json(200, { posts: [{ id: MINE.postId, number: 2, words: 'We started with one shelf.', proof: MINE.proof }] }));
        if (topic === 'ft-other') return Promise.resolve(json(200, { posts: [{ id: 'fp-other', number: 1, words: 'Ben asks about tanks.', proof: OTHERS.proof }] }));
        if (topic === 'ft-gone') return Promise.resolve(json(404, { code: 'not_found' }));
        if (topic === 'ft-down') return Promise.reject(new TypeError('Failed to fetch'));
        return new Promise<Response>(() => { /* slow: never answers */ });
    }));
}

beforeEach(() => { localStorage.clear(); forumAsked.length = 0; });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.useRealTimers(); });

const row = (knock: string, post: string) => screen.queryByTestId(`knock-forum-${knock}-${post}`);
const lineOf = (post: string) => screen.queryByTestId(`knock-forum-check-${post}`)?.textContent ?? null;
async function tap(knock: string, post: string, settled: string | RegExp) {
    fireEvent.click(within(row(knock, post)!).getByRole('button'));
    await screen.findByText(settled, { selector: `[data-testid="knock-forum-check-${post}"]` });
}

describe('forum posts under a request to join, on the web at 320 px', () => {
    it('draws one row a post, its title whole, and asks the worldwide forum nothing before a tap', async () => {
        serve();
        render(<WantsToJoin />);
        const title = `From the worldwide forum: ${POSTS.own.title}`;
        const own = await screen.findByTestId(`knock-forum-k1-${MINE.postId}`);
        expect(own.textContent).toContain(title);
        const button = within(own).getByRole('button');
        // The title wraps at 320 px: no truncation or line cap on it; the row is a 48 px target.
        const titleEl = within(own).getByText(title);
        expect(titleEl.className).toContain('break-words');
        expect(titleEl.className).not.toMatch(/truncate|line-clamp/);
        expect(button.className).toContain('min-h-[48px]');
        expect(lineOf(MINE.postId)).toBe(FORUM_ASK_WORDS.tapToCheck);
        expect(row('k2', 'fp-x')).toBeNull();
        expect(screen.queryByTestId('knock-forum-k3')).toBeNull();
        expect(forumAsked).toEqual([]);
        expect(screen.getByRole('button', { name: 'Invite Asha' })).toBeTruthy();
    });

    it('each outcome its line: the same key ✓, another key, not there now, unreachable', async () => {
        serve();
        render(<WantsToJoin />);
        await screen.findByTestId(`knock-forum-k1-${MINE.postId}`);
        await tap('k1', MINE.postId, FORUM_ASK_CHECK_WORDS.same);
        expect(within(row('k1', MINE.postId)!).getByText('We started with one shelf.')).toBeTruthy();
        await tap('k1', 'fp-other', FORUM_ASK_CHECK_WORDS.other);
        await tap('k1', 'fp-gone', FORUM_ASK_CHECK_WORDS.gone);
        await tap('k2', 'fp-down', FORUM_ASK_CHECK_WORDS.unknown);
        expect(forumAsked).toEqual([
            `${FORUM}/api/forum/public/topics/ft-own?after=1`, `${FORUM}/api/forum/public/topics/ft-other?after=0`,
            `${FORUM}/api/forum/public/topics/ft-gone?after=2`, `${FORUM}/api/forum/public/topics/ft-down?after=0`,
        ]);
    });

    it('slow: "Checking…" while it waits, then "Could not check" at the wait; the buttons answer meanwhile', async () => {
        serve();
        render(<WantsToJoin />);
        await screen.findByTestId('knock-forum-k2-fp-slow');
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
        const button = within(row('k2', 'fp-slow')!).getByRole('button');
        await act(async () => { fireEvent.click(button); });
        expect(lineOf('fp-slow')).toBe(FORUM_ASK_CHECK_WORDS.checking);
        expect(button.getAttribute('aria-busy')).toBe('true');
        expect(screen.getByRole('button', { name: 'Not now, Ben' })).toBeTruthy();
        await act(async () => { vi.advanceTimersByTime(8_100); });
        vi.useRealTimers();
        await screen.findByText(FORUM_ASK_CHECK_WORDS.unknown, { selector: '[data-testid="knock-forum-check-fp-slow"]' });
    });

    it('"Open in the forum" lands on the post, in a new tab, after a check that found it; none for a post not there', async () => {
        serve();
        render(<WantsToJoin />);
        await screen.findByTestId(`knock-forum-k1-${MINE.postId}`);
        await tap('k1', MINE.postId, FORUM_ASK_CHECK_WORDS.same);
        await tap('k1', 'fp-gone', FORUM_ASK_CHECK_WORDS.gone);
        const link = within(row('k1', MINE.postId)!).getByRole('link', { name: FORUM_ASK_WORDS.open });
        expect(link.getAttribute('href')).toBe(forumAskPageUrl(FORUM, POSTS.own));
        expect(link.getAttribute('target')).toBe('_blank');
        expect(link.getAttribute('rel')).toContain('noopener');
        expect(within(row('k1', 'fp-gone')!).queryByRole('link')).toBeNull();
    });
});
