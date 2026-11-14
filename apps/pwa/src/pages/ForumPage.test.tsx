/**
 * The forum on the web (slice F4; DESIGN-forums-fable.md §2, §5, §6, §14): the real ForumPage and its screens over a stand-in
 * node that answers the forum's routes as apps/server/src/routes/forum.ts does. What each request carried is checked, since
 * the node decides who may do what: a reply's quote, the told stamp before a public forum's first post, a report naming the
 * forum post, a first look's answer. e2e/forum-320.mjs walks the same against a real node in Chromium.
 */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type Call = { method: string; path: string; body?: any };
const node = vi.hoisted(() => ({ calls: [] as Call[], answer: null as null | ((c: Call) => unknown), role: 'member' as string | null }));
vi.mock('../lib/api', async (orig) => ({
    ...(await orig<typeof import('../lib/api')>()),
    request: vi.fn(async (method: string, path: string, body?: unknown) => {
        const call = { method, path, body };
        node.calls.push(call);
        const out = node.answer!(call);
        if (out instanceof Error) throw out;
        return out;
    }),
    signedFetch: vi.fn(async () => new Response(new Blob(['x']), { status: 200 })),
    myNodeRoleOnce: vi.fn(async () => node.role),
}));
vi.mock('../lib/blocklist', () => ({ blockUser: vi.fn(async () => true) }));

import { ForumPage } from './ForumPage';
import { forgetForum } from '../lib/forum';
import { blockUser } from '../lib/blocklist';

const ME = 'me-key';
const AT = new Date(Date.now() - 3600_000).toISOString();
const SECTIONS = [
    { id: 's-general', starter: 'general', name: null, about: null, position: 0, starts: 'members', listed: false, archived: false },
    { id: 's-news', starter: 'news', name: null, about: null, position: 1, starts: 'staff', listed: true, archived: false },
];
const front = (over: Record<string, unknown> = {}) => ({ sections: SECTIONS, public: false, told: true, moderator: false, firstLooksWaiting: null, firstTopicWaits: false, linksOn: true, ...over });
const topic = (id: string, title: string, over: Record<string, unknown> = {}) => ({
    id, sectionId: 's-general', title, writer: { publicKey: 'asha-key', name: 'Asha' }, place: null, lang: 'en', replyCount: 2, lastActivityAt: AT,
    createdAt: AT, pinned: false, closed: null, removed: false, hidden: false, follow: null, unread: false, ...over,
});
const post = (number: number, words: string, over: Record<string, unknown> = {}) => ({
    id: `fp-${number}`, topicId: 'ft-1', number, writer: { publicKey: 'asha-key', name: 'Asha' }, words, quotes: null, lang: 'en', createdAt: AT,
    editedAt: null, removed: null, photos: 0, hidden: false, linksOn: true, ...over,
});

let state: { front: any; topics: any[]; posts: any[]; waiting: any[] };
function standIn(c: Call): unknown {
    const p = c.path.split('?')[0];
    if (c.method === 'GET' && p === '/api/forum') return state.front;
    if (c.method === 'GET' && p === '/api/forum/topics') return { topics: state.topics, next: null };
    if (c.method === 'GET' && p === '/api/forum/topics/ft-1') return { topic: state.topics[0], posts: state.posts, next: null, lastRead: 1 };
    if (c.method === 'GET' && p === '/api/forum/first-looks/mine') return { waiting: null, usuallyWithinHours: 5 };
    if (c.method === 'GET' && p === '/api/forum/first-looks') return { waiting: state.waiting };
    if (c.method === 'POST' && p === '/api/forum/topics/ft-1/read') return { lastRead: c.body.upTo };
    if (c.method === 'POST' && p === '/api/forum/topics/ft-1/replies') { state.posts = [...state.posts, post(state.posts.length + 1, c.body.words, { writer: { publicKey: ME, name: 'Me' } })]; return { post: state.posts.at(-1) }; }
    if (c.method === 'POST' && p === '/api/forum/told') { state.front = { ...state.front, told: true }; return { told: true }; }
    if (c.method === 'POST' && p === '/api/forum/topics') return state.front.firstTopicWaits ? { waiting: { id: 'fw-1', title: c.body.title } } : { topic: topic('ft-1', c.body.title), post: post(1, c.body.words) };
    if (c.method === 'POST' && p === '/api/reports') return { success: true };
    if (c.method === 'POST' && p.startsWith('/api/forum/first-looks/fw-1/')) { state.waiting = []; return p.endsWith('/ok') ? { topicId: 'ft-9' } : { ok: true }; }
    return new Error(`not answered: ${c.method} ${c.path}`);
}

beforeEach(() => {
    forgetForum();
    node.calls.length = 0;
    node.role = 'member';
    node.answer = standIn;
    state = { front: front(), topics: [topic('ft-1', 'Seed swap ideas', { unread: true, follow: 'following' }), topic('ft-2', 'Welcome: start here', { pinned: true, replyCount: 1 })], posts: [post(1, 'Who has beans to swap?'), post(2, 'I have runner beans.', { writer: { publicKey: 'ben-key', name: 'Ben' } })], waiting: [] };
});
afterEach(() => { cleanup(); vi.mocked(blockUser).mockClear(); });

const sent = (method: string, path: string) => node.calls.filter((c) => c.method === method && c.path === path);
const openTopic = async () => {
    render(<ForumPage me={ME} />);
    fireEvent.click(await screen.findByText('Seed swap ideas'));
    await screen.findByTestId('forum-topic-title');
};

describe('the list', () => {
    it('draws the topics as the node orders them, with replies, the unread dot and the pin; each row opens its topic', async () => {
        render(<ForumPage me={ME} />);
        const rows = await screen.findAllByTestId('forum-topic-row');
        expect(rows.map((r) => r.textContent)).toEqual([expect.stringContaining('Seed swap ideas'), expect.stringContaining('📌 Welcome: start here')]);
        expect(rows[0]).toHaveTextContent('2 replies');
        expect(rows[1]).toHaveTextContent('1 reply');
        expect(within(rows[0]).getByRole('img', { name: 'New replies' })).toBeInTheDocument();
        expect(within(rows[1]).queryByRole('img', { name: 'New replies' })).toBeNull();
        // All sections: each row names its section, in the reader's language (a starter's word).
        expect(rows[0]).toHaveTextContent('Asha · General');
        expect(screen.queryByTestId('forum-first-looks-row')).toBeNull();
    });

    it('a section picked lists that section only', async () => {
        render(<ForumPage me={ME} />);
        await screen.findAllByTestId('forum-topic-row');
        fireEvent.change(screen.getByTestId('forum-section-pick'), { target: { value: 's-news' } });
        await waitFor(() => expect(node.calls.some((c) => c.path === '/api/forum/topics?section=s-news')).toBe(true));
    });

    it('moderators see "Waiting for a first look (n) ›"; OK puts one up, No takes one of the five reasons', async () => {
        state.front = front({ moderator: true, firstLooksWaiting: 2 });
        state.waiting = [{ id: 'fw-1', sectionId: 's-general', title: 'Hello from Nia', words: 'See www.example.org', place: null, lang: 'en', photos: 0, writer: { publicKey: 'nia', name: 'Nia' }, createdAt: AT }];
        render(<ForumPage me={ME} />);
        fireEvent.click(await screen.findByText('Waiting for a first look (2) ›'));
        const look = await screen.findByTestId('forum-first-look');
        expect(look).toHaveTextContent('Hello from Nia');
        // A new writer's link is plain text until a moderator says OK.
        expect(within(look).queryByRole('link')).toBeNull();
        fireEvent.click(within(look).getByTestId('forum-first-look-no'));
        const say = within(look).getByRole('button', { name: 'Say no' });
        expect(say).toBeDisabled();
        fireEvent.click(within(look).getByLabelText('Spam or a scam'));
        fireEvent.click(say);
        await waitFor(() => expect(sent('POST', '/api/forum/first-looks/fw-1/no')[0]?.body).toEqual({ reason: 'spam' }));
        expect(await screen.findByText('Nothing is waiting. Thank you for looking.')).toBeInTheDocument();
    });
});

describe('a topic', () => {
    it('shows the opening words, the replies in order, and marks it read up to the last post drawn', async () => {
        await openTopic();
        expect(screen.getByTestId('forum-topic-title')).toHaveTextContent('Seed swap ideas');
        expect(screen.getByTestId('forum-words-1')).toHaveTextContent('Who has beans to swap?');
        expect(screen.getByTestId('forum-post-2')).toHaveTextContent('Ben');
        await waitFor(() => expect(sent('POST', '/api/forum/topics/ft-1/read')[0]?.body).toEqual({ upTo: 2 }));
    });

    it('a removed and a hidden reply keep their place in words, never their old words; a new writer\'s links are not links', async () => {
        state.posts = [post(1, 'Opening www.example.org', { linksOn: false }), post(2, '', { removed: 'writer' }), post(3, '', { hidden: true }), post(4, 'Read https://example.org/a', { linksOn: true })];
        await openTopic();
        expect(screen.getByTestId('forum-post-2')).toHaveTextContent('Removed by its writer');
        expect(screen.getByTestId('forum-post-3')).toHaveTextContent('Hidden while moderators look');
        expect(within(screen.getByTestId('forum-words-1')).queryByRole('link')).toBeNull();
        const link = within(screen.getByTestId('forum-words-4')).getByRole('link');
        expect(link).toHaveAttribute('rel', 'noopener noreferrer nofollow ugc');
    });

    it('Reply from a post\'s ⋯ quotes it: the reply carries its number, and the new reply shows the quote', async () => {
        await openTopic();
        fireEvent.click(screen.getByTestId('forum-post-menu-2'));
        fireEvent.click(within(screen.getByTestId('forum-menu')).getByRole('button', { name: 'Reply' }));
        expect(screen.getByTestId('forum-quote')).toHaveTextContent('Replying to Ben: I have runner beans.');
        fireEvent.change(screen.getByTestId('forum-reply-box'), { target: { value: 'Can I have some?' } });
        fireEvent.click(screen.getByTestId('forum-send'));
        await waitFor(() => expect(sent('POST', '/api/forum/topics/ft-1/replies')[0]?.body).toMatchObject({ words: 'Can I have some?', quotes: 2 }));
        expect(await screen.findByTestId('forum-post-3')).toHaveTextContent('Can I have some?');
        expect(screen.queryByTestId('forum-quote')).toBeNull();
    });

    it('on a public forum the first post waits on the sheet: Not now sends nothing, Post stamps told and then sends', async () => {
        state.front = front({ public: true, told: false });
        await openTopic();
        fireEvent.change(screen.getByTestId('forum-reply-box'), { target: { value: 'Hello' } });
        fireEvent.click(screen.getByTestId('forum-send'));
        expect(await screen.findByTestId('forum-told')).toHaveTextContent('Anyone on the web can read this forum, with your name.');
        fireEvent.click(screen.getByRole('button', { name: 'Not now' }));
        expect(screen.queryByTestId('forum-told')).toBeNull();
        expect(sent('POST', '/api/forum/topics/ft-1/replies')).toHaveLength(0);
        fireEvent.click(screen.getByTestId('forum-send'));
        fireEvent.click(await screen.findByTestId('forum-told-post'));
        await waitFor(() => expect(sent('POST', '/api/forum/topics/ft-1/replies')).toHaveLength(1));
        const order = node.calls.map((c) => c.path).filter((p) => p === '/api/forum/told' || p === '/api/forum/topics/ft-1/replies');
        expect(order).toEqual(['/api/forum/told', '/api/forum/topics/ft-1/replies']);
        expect(screen.queryByTestId('forum-told')).toBeNull();
    });

    it('Report sends a report naming the forum post; Block asks first, then blocks its writer', async () => {
        await openTopic();
        fireEvent.click(screen.getByTestId('forum-post-menu-2'));
        fireEvent.click(within(screen.getByTestId('forum-menu')).getByRole('button', { name: 'Report' }));
        fireEvent.click(await screen.findByText('Spam or scam'));
        fireEvent.click(screen.getByRole('button', { name: /submit/i }));
        await waitFor(() => expect(sent('POST', '/api/reports')[0]?.body).toEqual({ targetForumPostId: 'fp-2', reason: 'Spam or scam' }));
        cleanup();
        await openTopic();
        fireEvent.click(screen.getByTestId('forum-post-menu-2'));
        fireEvent.click(within(screen.getByTestId('forum-menu')).getByRole('button', { name: 'Block Ben' }));
        expect(blockUser).not.toHaveBeenCalled();
        expect(screen.getByTestId('forum-menu')).toHaveTextContent('Block Ben? You won’t see their posts or messages.');
        fireEvent.click(within(screen.getByTestId('forum-menu')).getByRole('button', { name: 'Block Ben' }));
        await waitFor(() => expect(blockUser).toHaveBeenCalledWith('ben-key'));
    });

    it('a post of one\'s own offers Remove, not Report or Block; a closed topic has no reply box', async () => {
        state.posts = [post(1, 'Mine', { writer: { publicKey: ME, name: 'Me' } })];
        state.topics = [topic('ft-1', 'Seed swap ideas', { closed: 'writer' })];
        await openTopic();
        fireEvent.click(screen.getByTestId('forum-post-menu-1'));
        const menu = screen.getByTestId('forum-menu');
        expect(within(menu).queryByRole('button', { name: 'Report' })).toBeNull();
        expect(within(menu).queryByRole('button', { name: /Block/ })).toBeNull();
        expect(within(menu).getByRole('button', { name: 'Remove' })).toBeInTheDocument();
        expect(screen.getByTestId('forum-closed')).toBeInTheDocument();
        expect(screen.queryByTestId('forum-reply-box')).toBeNull();
    });
});

describe('a new topic', () => {
    it('lists only the sections the member may start in, and a new member\'s waits for a first look', async () => {
        state.front = front({ firstTopicWaits: true, linksOn: false });
        render(<ForumPage me={ME} />);
        fireEvent.click(await screen.findByTestId('forum-new'));
        const pick = screen.getByTestId('forum-new-section') as HTMLSelectElement;
        expect(Array.from(pick.options).map((o) => o.textContent)).toEqual(['General']);
        expect(screen.getByTestId('forum-first-look-note')).toHaveTextContent('Usually within 5 hours.');
        fireEvent.change(screen.getByTestId('forum-new-title'), { target: { value: 'Hello all' } });
        fireEvent.change(screen.getByTestId('forum-new-words'), { target: { value: 'I am new here.' } });
        await act(async () => { fireEvent.click(screen.getByTestId('forum-new-post')); });
        await waitFor(() => expect(sent('POST', '/api/forum/topics')[0]?.body).toMatchObject({ sectionId: 's-general', title: 'Hello all', words: 'I am new here.' }));
        expect(await screen.findByText(/A moderator looks at your first topic before it shows/)).toBeInTheDocument();
    });

    it('an owner may start in a staff section; a topic that goes up at once opens', async () => {
        node.role = 'owner';
        render(<ForumPage me={ME} />);
        await screen.findAllByTestId('forum-topic-row');
        await waitFor(() => expect(node.calls.length).toBeGreaterThan(0));
        fireEvent.click(screen.getByTestId('forum-new'));
        const pick = await screen.findByTestId('forum-new-section') as HTMLSelectElement;
        await waitFor(() => expect(Array.from(pick.options).map((o) => o.textContent)).toEqual(['General', 'News from BeanPool']));
        fireEvent.change(screen.getByTestId('forum-new-title'), { target: { value: 'Seed swap ideas' } });
        fireEvent.change(screen.getByTestId('forum-new-words'), { target: { value: 'Who has beans?' } });
        fireEvent.click(screen.getByTestId('forum-new-post'));
        expect(await screen.findByTestId('forum-topic')).toBeInTheDocument();
    });
});
