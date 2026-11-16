/**
 * The forum on the web (slice F4; DESIGN-forums-fable.md §2, §5, §6, §14): the real ForumPage and its screens over a stand-in
 * node that answers the forum's routes as apps/server/src/routes/forum.ts does. What each request carried is checked, since
 * the node decides who may do what: a reply's quote, the told stamp before a public forum's first post, a report naming the
 * forum post, a first look's answer. e2e/forum-320.mjs walks the same against a real node in Chromium.
 */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type Call = { method: string; path: string; body?: any };
const node = vi.hoisted(() => ({ calls: [] as Call[], answer: null as null | ((c: Call) => unknown), role: 'member' as string | null, linkables: { groups: [] as any[], listings: [] as any[], events: [] as any[], hosted: [] as any[] } }));
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
    // What the Link sheet lists (slice F9): the member's groups, listings and events, as those reads answer them.
    getYourGroups: vi.fn(async () => ({ items: node.linkables.groups })),
    // Events are opt-in on the node: the hosted read asks for them by name (types: 'event'), the listings read never sees one.
    getMarketplacePosts: vi.fn(async (f?: { types?: string }) => (f?.types === 'event' ? node.linkables.hosted ?? [] : node.linkables.listings)),
    getMyEvents: vi.fn(async () => node.linkables.events),
}));
vi.mock('../lib/blocklist', () => ({ blockUser: vi.fn(async () => true) }));

import { useState } from 'react';
import { ForumPage, type ForumDoor } from './ForumPage';
import { forgetForum, keptTopic, searchForum } from '../lib/forum';
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

/** The node's answer to a search (slice F6, engine/forum-search.ts): set per test. */
let searched: (q: string) => unknown = () => ({ hits: [], next: null });
const hit = (number: number, excerpt: string, over: Record<string, unknown> = {}) => ({
    topicId: 'ft-1', sectionId: 's-general', title: 'Seed swap ideas', postId: `fp-${number}`, number, writer: { publicKey: 'ben-key', name: 'Ben' }, createdAt: AT,
    excerpt, ...over,
});

/** `gone`: the topic ft-1 isn't there for this member any more (its opening post removed with no reply, or its writer blocked). */
let state: { front: any; topics: any[]; posts: any[]; waiting: any[]; gone: boolean };
/** The node's refusal as lib/api.ts request throws it: its words, its status and its code. */
const refusal = (status: number, code: string, words: string) => Object.assign(new Error(words), { status, code });
function standIn(c: Call): unknown {
    const p = c.path.split('?')[0];
    if (c.method === 'GET' && p === '/api/forum') return state.front;
    if (c.method === 'GET' && p === '/api/forum/topics') return { topics: state.gone ? state.topics.filter((x) => x.id !== 'ft-1') : state.topics, next: null };
    if (c.method === 'GET' && p === '/api/forum/topics/ft-1') {
        if (state.gone) return refusal(404, 'not_found', 'This topic isn’t here any more.');
        // Paged as engine/forum.ts forumTopic pages: 30 posts after `after`; `next` is the last one's number while more follow.
        const after = Number(new URLSearchParams(c.path.split('?')[1] ?? '').get('after') ?? 0);
        const rest = state.posts.filter((x) => x.number > after);
        const posts = rest.slice(0, 30);
        return { topic: state.topics[0], posts, next: rest.length > 30 ? posts[posts.length - 1].number : null, lastRead: 1 };
    }
    if (c.method === 'POST' && p === '/api/forum/topics/ft-1/follow') { state.topics[0] = { ...state.topics[0], follow: c.body.follow }; return { follow: c.body.follow }; }
    if (c.method === 'POST' && /^\/api\/forum\/posts\/fp-\d+\/remove$/.test(p)) {
        const n = Number(p.split('/')[4].slice(3));
        // Its opening post removed with no one else's reply: the whole topic goes (engine/forum.ts blankTopic).
        if (n === 1 && state.posts.length === 1) state.gone = true;
        else state.posts = state.posts.map((x) => (x.number === n ? { ...x, words: '', removed: 'writer' } : x));
        return { ok: true };
    }
    if (c.method === 'GET' && p === '/api/forum/first-looks/mine') return { waiting: null, usuallyWithinHours: 5 };
    if (c.method === 'GET' && p === '/api/forum/first-looks') return { waiting: state.waiting };
    if (c.method === 'POST' && p === '/api/forum/topics/ft-1/read') return { lastRead: c.body.upTo };
    if (c.method === 'POST' && p === '/api/forum/topics/ft-1/replies') { state.posts = [...state.posts, post(state.posts.length + 1, c.body.words, { writer: { publicKey: ME, name: 'Me' } })]; return { post: state.posts.at(-1) }; }
    if (c.method === 'POST' && p === '/api/forum/told') { state.front = { ...state.front, told: true }; return { told: true }; }
    if (c.method === 'POST' && p === '/api/forum/topics') return state.front.firstTopicWaits ? { waiting: { id: 'fw-1', title: c.body.title } } : { topic: topic('ft-1', c.body.title), post: post(1, c.body.words) };
    if (c.method === 'POST' && p === '/api/reports') return { success: true };
    if (c.method === 'POST' && p.startsWith('/api/forum/first-looks/fw-1/')) { state.waiting = []; return p.endsWith('/ok') ? { topicId: 'ft-9' } : { ok: true }; }
    if (c.method === 'GET' && p === '/api/forum/search') return searched(new URLSearchParams(c.path.split('?')[1] ?? '').get('q') ?? '');
    // Links (slice F9, routes/forum.ts): the writer links one thing, or takes one off; the answer is the topic, links and all.
    if (c.method === 'POST' && p === '/api/forum/topics/ft-1/links') {
        const links = (state.topics[0].links ?? []).filter((l: any) => !(l.shown && l.kind === c.body.kind && l.id === c.body.targetId));
        if (c.body.on !== false) links.push({ kind: c.body.kind, shown: true, id: c.body.targetId, title: `Linked ${c.body.targetId}`, photo: null, listingType: null, startAt: null, byWriter: true });
        state.topics[0] = { ...state.topics[0], links };
        return { topic: state.topics[0] };
    }
    return new Error(`not answered: ${c.method} ${c.path}`);
}

beforeEach(() => {
    forgetForum();
    node.calls.length = 0;
    node.role = 'member';
    node.answer = standIn;
    state = { front: front(), topics: [topic('ft-1', 'Seed swap ideas', { unread: true, follow: 'following' }), topic('ft-2', 'Welcome: start here', { pinned: true, replyCount: 1 })], posts: [post(1, 'Who has beans to swap?'), post(2, 'I have runner beans.', { writer: { publicKey: 'ben-key', name: 'Ben' } })], waiting: [], gone: false };
});
afterEach(() => { cleanup(); vi.mocked(blockUser).mockReset(); vi.mocked(blockUser).mockImplementation(async () => true); });

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

    it('a topic whose opening post was removed, with others\' replies, is listed as "A removed topic", never a blank title', async () => {
        state.topics = [topic('ft-1', '', { removed: true }), topic('ft-2', 'Welcome: start here')];
        render(<ForumPage me={ME} />);
        const rows = await screen.findAllByTestId('forum-topic-row');
        expect(rows[0]).toHaveTextContent('A removed topic');
        expect(rows[0]).toHaveTextContent('Asha · General');
    });

    it('a slow answer for a section picked before is dropped: the list is always the picked section\'s', async () => {
        render(<ForumPage me={ME} />);
        await screen.findAllByTestId('forum-topic-row');
        let release: (v: unknown) => void = () => {};
        node.answer = (c) => {
            if (c.path === '/api/forum/topics?section=s-general') return new Promise((r) => { release = r; });
            if (c.path === '/api/forum/topics?section=s-news') return { topics: [topic('ft-3', 'Market day moved', { sectionId: 's-news' })], next: null };
            return standIn(c);
        };
        fireEvent.change(screen.getByTestId('forum-section-pick'), { target: { value: 's-general' } });
        fireEvent.change(screen.getByTestId('forum-section-pick'), { target: { value: 's-news' } });
        expect(await screen.findByText('Market day moved')).toBeInTheDocument();
        // General's answer comes last: it is filed under General, and the screen stays News's.
        await act(async () => { release({ topics: [topic('ft-1', 'Seed swap ideas')], next: null }); await new Promise((r) => setTimeout(r, 0)); });
        expect(screen.queryByText('Seed swap ideas')).toBeNull();
        expect(screen.getByText('Market day moved')).toBeInTheDocument();
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

    it('a writer\'s name opens their profile by key, only through onOpenProfile', async () => {
        const opened: string[] = [];
        render(<ForumPage me={ME} onOpenProfile={(k) => opened.push(k)} />);
        fireEvent.click(await screen.findByText('Seed swap ideas'));
        fireEvent.click(within(await screen.findByTestId('forum-post-2')).getByRole('button', { name: 'Ben' }));
        expect(opened).toEqual(['ben-key']);
    });
});

describe('the sheet on a public forum shows once', () => {
    const reply = async (words: string, n: number) => {
        fireEvent.change(screen.getByTestId('forum-reply-box'), { target: { value: words } });
        fireEvent.click(screen.getByTestId('forum-send'));
        await waitFor(() => expect(sent('POST', '/api/forum/topics/ft-1/replies')).toHaveLength(n));
    };

    it('after agreeing, a second reply in the same topic goes with no sheet', async () => {
        state.front = front({ public: true, told: false });
        await openTopic();
        fireEvent.change(screen.getByTestId('forum-reply-box'), { target: { value: 'Hello' } });
        fireEvent.click(screen.getByTestId('forum-send'));
        fireEvent.click(await screen.findByTestId('forum-told-post'));
        expect(await screen.findByTestId('forum-post-3')).toHaveTextContent('Hello');
        await reply('Hello again', 2);
        expect(screen.queryByTestId('forum-told')).toBeNull();
        expect(await screen.findByTestId('forum-post-4')).toHaveTextContent('Hello again');
        expect(sent('POST', '/api/forum/told')).toHaveLength(1);
    });

    it('after agreeing for a topic that goes up at once, its first reply goes with no sheet', async () => {
        state.front = front({ public: true, told: false });
        render(<ForumPage me={ME} />);
        fireEvent.click(await screen.findByTestId('forum-new'));
        fireEvent.change(screen.getByTestId('forum-new-title'), { target: { value: 'Seed swap ideas' } });
        fireEvent.change(screen.getByTestId('forum-new-words'), { target: { value: 'Who has beans?' } });
        fireEvent.click(screen.getByTestId('forum-new-post'));
        fireEvent.click(await screen.findByTestId('forum-told-post'));
        await screen.findByTestId('forum-topic-title');
        await reply('Me too', 1);
        expect(screen.queryByTestId('forum-told')).toBeNull();
        expect(sent('POST', '/api/forum/told')).toHaveLength(1);
    });
});

describe('a long topic keeps the reader\'s place', () => {
    const many = (n: number) => Array.from({ length: n }, (_, i) => post(i + 1, `Post ${i + 1}`, i ? { writer: { publicKey: 'ben-key', name: 'Ben' } } : {}));
    const send = (words: string) => {
        fireEvent.change(screen.getByTestId('forum-reply-box'), { target: { value: words } });
        fireEvent.click(screen.getByTestId('forum-send'));
    };

    it('read to the end of 40 posts, Send draws the reply after #40, and every post read stays', async () => {
        state.posts = many(40);
        await openTopic();
        expect(screen.queryByTestId('forum-post-31')).toBeNull();
        fireEvent.click(screen.getByRole('button', { name: 'Show more replies' }));
        expect(await screen.findByTestId('forum-post-40')).toHaveTextContent('Post 40');
        send('My reply');
        expect(await screen.findByTestId('forum-post-41')).toHaveTextContent('My reply');
        for (const n of [2, 30, 31, 40]) expect(screen.getByTestId(`forum-post-${n}`)).toBeInTheDocument();
    });

    it('Send from the first 30 of 70 draws the reply too, reading on to it', async () => {
        state.posts = many(70);
        await openTopic();
        send('Late to this');
        expect(await screen.findByTestId('forum-post-71')).toHaveTextContent('Late to this');
        expect(screen.getByTestId('forum-post-30')).toBeInTheDocument();
    });

    it('a ⋯ action keeps every post read, each read afresh', async () => {
        state.posts = many(40);
        await openTopic();
        fireEvent.click(screen.getByRole('button', { name: 'Show more replies' }));
        await screen.findByTestId('forum-post-40');
        // Meanwhile a moderator removed #35: the read after the member's own action draws that too.
        state.posts = state.posts.map((x) => (x.number === 35 ? { ...x, words: '', removed: 'moderator' } : x));
        fireEvent.click(screen.getByTestId('forum-follow'));
        await waitFor(() => expect(screen.getByTestId('forum-post-35')).toHaveTextContent('Removed by a moderator'));
        expect(screen.getByTestId('forum-post-40')).toBeInTheDocument();
        // ft-1 was followed: the bell stopped following it, and the re-read drew that too.
        expect(sent('POST', '/api/forum/topics/ft-1/follow')[0]?.body).toEqual({ follow: null });
        expect(screen.getByTestId('forum-follow')).toHaveAttribute('aria-pressed', 'false');
    });

    it('reopening a topic read to #40 reads all 40 again, not only the first 30', async () => {
        state.posts = many(40);
        await openTopic();
        fireEvent.click(screen.getByRole('button', { name: 'Show more replies' }));
        await screen.findByTestId('forum-post-40');
        fireEvent.click(screen.getByTestId('forum-back'));
        fireEvent.click(await screen.findByText('Seed swap ideas'));
        await screen.findByTestId('forum-topic-title');
        await waitFor(() => expect(sent('GET', '/api/forum/topics/ft-1?after=30')).toHaveLength(2));
        expect(screen.getByTestId('forum-post-40')).toBeInTheDocument();
    });
});

describe('a topic the member\'s own action takes away', () => {
    it('removing their opening post in a topic nobody answered goes back to the list, in the node\'s words', async () => {
        state.posts = [post(1, 'Mine', { writer: { publicKey: ME, name: 'Me' } })];
        state.topics = [topic('ft-1', 'Seed swap ideas', { writer: { publicKey: ME, name: 'Me' }, replyCount: 0 }), topic('ft-2', 'Welcome: start here')];
        await openTopic();
        fireEvent.click(screen.getByTestId('forum-post-menu-1'));
        fireEvent.click(within(screen.getByTestId('forum-menu')).getByRole('button', { name: 'Remove' }));
        fireEvent.click(within(screen.getByTestId('forum-menu')).getByRole('button', { name: 'Remove' }));
        expect(await screen.findByTestId('forum-gone')).toHaveTextContent('This topic isn’t here any more.');
        expect(screen.queryByTestId('forum-topic')).toBeNull();
        expect(keptTopic('ft-1')).toBeNull();
        await waitFor(() => expect(screen.getAllByTestId('forum-topic-row').map((r) => r.textContent)).toEqual([expect.stringContaining('Welcome: start here')]));
    });

    it('blocking the topic\'s own writer goes back to the list, saying why it went', async () => {
        vi.mocked(blockUser).mockImplementation(async () => { state.gone = true; return true; });
        await openTopic();
        fireEvent.click(screen.getByTestId('forum-post-menu-1'));
        fireEvent.click(within(screen.getByTestId('forum-menu')).getByRole('button', { name: 'Block Asha' }));
        fireEvent.click(within(screen.getByTestId('forum-menu')).getByRole('button', { name: 'Block Asha' }));
        expect(await screen.findByTestId('forum-gone')).toHaveTextContent('You blocked Asha, so their topic no longer shows for you.');
        expect(screen.queryByTestId('forum-topic')).toBeNull();
        // Opening another topic takes the line away.
        fireEvent.click(await screen.findByText('Welcome: start here'));
        fireEvent.click(await screen.findByTestId('forum-back'));
        await screen.findAllByTestId('forum-topic-row');
        expect(screen.queryByTestId('forum-gone')).toBeNull();
    });

    it('a slow answer for a topic the member already left changes nothing: they stay in the topic they opened next', async () => {
        render(<ForumPage me={ME} />);
        await screen.findAllByTestId('forum-topic-row');
        let refuse: (e: unknown) => void = () => {};
        node.answer = (c) => {
            if (c.method === 'GET' && c.path === '/api/forum/topics/ft-1') return new Promise((_, no) => { refuse = no; });
            if (c.method === 'GET' && c.path === '/api/forum/topics/ft-2') return { topic: state.topics[1], posts: [post(1, 'Start here.', { topicId: 'ft-2' })], next: null, lastRead: 1 };
            if (c.method === 'POST' && c.path === '/api/forum/topics/ft-2/read') return { lastRead: 1 };
            return standIn(c);
        };
        fireEvent.click(screen.getByText('Seed swap ideas'));
        fireEvent.click(await screen.findByTestId('forum-back'));
        fireEvent.click(await screen.findByText('Welcome: start here'));
        expect(await screen.findByTestId('forum-words-1')).toHaveTextContent('Start here.');
        await act(async () => { refuse(refusal(404, 'not_found', 'This topic isn’t here any more.')); await new Promise((r) => setTimeout(r, 0)); });
        expect(screen.getByTestId('forum-topic')).toBeInTheDocument();
        expect(screen.getByTestId('forum-words-1')).toHaveTextContent('Start here.');
        expect(screen.queryByTestId('forum-gone')).toBeNull();
    });
});

describe('kept copies', () => {
    it('draw at once on a return, and are dropped when the account in this tab changes', async () => {
        const first = render(<ForumPage me={ME} />);
        await screen.findAllByTestId('forum-topic-row');
        first.unmount();
        node.answer = () => new Promise(() => {}); // the node says nothing now
        const again = render(<ForumPage me={ME} />);
        expect(screen.getAllByTestId('forum-topic-row')).toHaveLength(2);
        again.unmount();
        render(<ForumPage me="someone-else" />);
        expect(screen.queryAllByTestId('forum-topic-row')).toHaveLength(0);
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

describe('search (slice F6)', () => {
    it('asks only on Search; its hits replace the list; a hit opens its topic at the post found; back, the same hits without asking again; ✕ brings the list back', async () => {
        searched = () => ({ hits: [hit(2, 'I have runner beans.'), hit(1, 'Who has beans to swap?', { title: '', writer: { publicKey: 'asha-key', name: 'Asha' } })], next: null });
        const scrolled = vi.fn();
        Element.prototype.scrollIntoView = scrolled;
        render(<ForumPage me={ME} />);
        await screen.findAllByTestId('forum-topic-row');
        fireEvent.change(screen.getByTestId('forum-search-box'), { target: { value: 'runner beans' } });
        expect(node.calls.some((c) => c.path.startsWith('/api/forum/search'))).toBe(false);
        fireEvent.click(screen.getByRole('button', { name: 'Search' }));
        const hits = await screen.findAllByTestId('forum-search-hit');
        expect(sent('GET', '/api/forum/search?q=runner%20beans')).toHaveLength(1);
        expect(screen.queryByTestId('forum-topics')).toBeNull();
        expect(hits[0]).toHaveTextContent('Seed swap ideas');
        expect(hits[0]).toHaveTextContent('Ben · General');
        expect(hits[0]).toHaveTextContent('I have runner beans.');
        // A topic its writer removed, its replies kept: the node sends no title.
        expect(hits[1]).toHaveTextContent('A removed topic');
        fireEvent.click(hits[0]);
        await screen.findByTestId('forum-topic-title');
        await waitFor(() => expect(scrolled).toHaveBeenCalledTimes(1));
        expect(scrolled.mock.contexts[0]).toBe(screen.getByTestId('forum-post-2'));
        fireEvent.click(screen.getByTestId('forum-back'));
        expect(await screen.findAllByTestId('forum-search-hit')).toHaveLength(2);
        expect(sent('GET', '/api/forum/search?q=runner%20beans')).toHaveLength(1);
        expect((screen.getByTestId('forum-search-box') as HTMLInputElement).value).toBe('runner beans');
        fireEvent.click(screen.getByRole('button', { name: 'Clear the search' }));
        expect(await screen.findAllByTestId('forum-topic-row')).toHaveLength(2);
        expect(screen.queryByTestId('forum-search-hit')).toBeNull();
    });

    it('🔍 is a live button with the box empty too (walk 2: faded, it read as off): the tap asks nothing and puts the cursor in the box', async () => {
        render(<ForumPage me={ME} />);
        await screen.findAllByTestId('forum-topic-row');
        const go = screen.getByRole('button', { name: 'Search' });
        expect(go).toBeEnabled();
        expect(go.className).not.toMatch(/(^| )opacity-/);
        const before = node.calls.length;
        fireEvent.click(go);
        expect(screen.getByTestId('forum-search-box')).toHaveFocus();
        fireEvent.change(screen.getByTestId('forum-search-box'), { target: { value: '   ' } });
        fireEvent.click(go);
        await act(async () => {});
        expect(node.calls.slice(before).some((c) => c.path.startsWith('/api/forum/search'))).toBe(false);
        expect(screen.queryByTestId('forum-search-none')).toBeNull();
    });

    it('says so when nothing has every word, and shows the node\'s words when it refuses (the day\'s searches spent)', async () => {
        searched = () => ({ hits: [], next: null });
        render(<ForumPage me={ME} />);
        fireEvent.change(await screen.findByTestId('forum-search-box'), { target: { value: 'zebra' } });
        fireEvent.submit(screen.getByRole('search'));
        expect(await screen.findByTestId('forum-search-none')).toHaveTextContent('Nothing in the forum has every word of “zebra”.');
        searched = () => refusal(429, 'searches_per_day', 'You can search the forum 100 times in any 24 hours. Try again later.');
        fireEvent.change(screen.getByTestId('forum-search-box'), { target: { value: 'beans' } });
        fireEvent.submit(screen.getByRole('search'));
        expect(await screen.findByRole('alert')).toHaveTextContent('You can search the forum 100 times in any 24 hours.');
    });

    it('a second page adds its hits under the first', async () => {
        searched = () => ({ hits: Array.from({ length: 20 }, (_, i) => hit(i + 2, `beans ${i}`)), next: 20 });
        render(<ForumPage me={ME} />);
        fireEvent.change(await screen.findByTestId('forum-search-box'), { target: { value: 'beans' } });
        fireEvent.submit(screen.getByRole('search'));
        expect(await screen.findAllByTestId('forum-search-hit')).toHaveLength(20);
        searched = () => ({ hits: [hit(40, 'beans last')], next: null });
        fireEvent.click(screen.getByRole('button', { name: 'Show more results' }));
        await waitFor(() => expect(screen.getAllByTestId('forum-search-hit')).toHaveLength(21));
        expect(sent('GET', '/api/forum/search?q=beans&offset=20')).toHaveLength(1);
        expect(screen.queryByRole('button', { name: 'Show more results' })).toBeNull();
    });
});

/**
 * Chat chosen in the menu while the Forum shows (ChatTabPage's homeNonce; Marty, 16 Nov: "clicking on chat in menu should take
 * you back to the main chat menu - not just need the tiny back arrow"): from a topic, a new topic or the first looks, the topic
 * list; a reply typed and not sent is in the box when the topic opens again.
 */
describe('Chat chosen in the menu while the Forum shows', () => {
    it('from a topic: the topic list, and the reply typed is kept for the topic', async () => {
        const view = render(<ForumPage me={ME} homeNonce={0} />);
        fireEvent.click(await screen.findByText('Seed swap ideas'));
        await screen.findByTestId('forum-topic-title');
        fireEvent.change(await screen.findByTestId('forum-reply-box'), { target: { value: 'I can bring a few' } });
        view.rerender(<ForumPage me={ME} homeNonce={1} />);
        expect(await screen.findAllByTestId('forum-topic-row')).toHaveLength(2);
        expect(screen.queryByTestId('forum-topic-title')).toBeNull();
        fireEvent.click(await screen.findByText('Seed swap ideas'));
        await screen.findByTestId('forum-topic-title');
        expect(await screen.findByTestId('forum-reply-box')).toHaveValue('I can bring a few');
    });

    it('from a new topic: the topic list', async () => {
        const view = render(<ForumPage me={ME} homeNonce={0} />);
        await screen.findAllByTestId('forum-topic-row');
        fireEvent.click(screen.getByRole('button', { name: '＋ New topic' }));
        await waitFor(() => expect(screen.queryByTestId('forum-topic-row')).toBeNull());
        view.rerender(<ForumPage me={ME} homeNonce={1} />);
        expect(await screen.findAllByTestId('forum-topic-row')).toHaveLength(2);
    });

    it('on the topic list: it stays', async () => {
        const view = render(<ForumPage me={ME} homeNonce={0} />);
        await screen.findAllByTestId('forum-topic-row');
        view.rerender(<ForumPage me={ME} homeNonce={1} />);
        expect(await screen.findAllByTestId('forum-topic-row')).toHaveLength(2);
    });

    it("opened by a door on one topic (slice F7): the topic, whatever count it is born with; a new count, the list, and the door's topic stays shut", async () => {
        const view = render(<ForumPage me={ME} topicId="ft-1" homeNonce={3} />);
        expect(await screen.findByTestId('forum-topic-title')).toHaveTextContent('Seed swap ideas');
        view.rerender(<ForumPage me={ME} topicId="ft-1" homeNonce={4} />);
        expect(await screen.findAllByTestId('forum-topic-row')).toHaveLength(2);
        expect(screen.queryByTestId('forum-topic-title')).toBeNull();
        // Drawn again with the same door (App keeps the topic while the tab shows): still the list.
        view.rerender(<ForumPage me={ME} topicId="ft-1" homeNonce={4} />);
        expect(screen.queryByTestId('forum-topic-title')).toBeNull();
        expect(screen.getAllByTestId('forum-topic-row')).toHaveLength(2);
    });
});

describe('links (slice F9)', () => {
    const shownLink = (kind: string, id: string, title: string, over: Record<string, unknown> = {}) => ({ kind, shown: true, id, title, photo: null, listingType: null, startAt: null, byWriter: false, ...over });
    const mine = (over: Record<string, unknown> = {}) => { state.topics[0] = { ...state.topics[0], writer: { publicKey: ME, name: 'Me' }, ...over }; };
    const menu = async () => { fireEvent.click(screen.getByTestId('forum-topic-menu')); return screen.findByTestId('forum-menu'); };
    beforeEach(() => { node.linkables = { groups: [], listings: [], events: [], hosted: [] }; });

    it('the chips under the opening words are the node\'s answer: a shown link opens its thing, a placeholder says its kind and opens nothing', async () => {
        state.topics[0] = { ...state.topics[0], links: [shownLink('group', 'g-1', 'Garden Crew'), { kind: 'listing', shown: false }, shownLink('listing', 'n-1', 'Seed swap', { listingType: 'need', byWriter: true })] };
        const navigate = vi.fn();
        render(<ForumPage me={ME} onNavigate={navigate} />);
        fireEvent.click(await screen.findByText('Seed swap ideas'));
        const chips = await screen.findByTestId('forum-link-chips');
        expect(Array.from(chips.children).map((li) => li.textContent)).toEqual(['👥Garden Crew›', 'Linked: a listing', '🛍️Posted as a Need ›']);
        fireEvent.click(within(chips).getByTestId('forum-link-group'));
        expect(navigate).toHaveBeenLastCalledWith('group', 'g-1');
        fireEvent.click(within(chips).getByText('Posted as a Need ›'));
        expect(navigate).toHaveBeenLastCalledWith('marketplace', 'n-1');
        expect(within(chips).getByTestId('forum-link-listing-placeholder').closest('button')).toBeNull();
    });

    it('the writer links one of their listings from ⋯ Link: the node is asked with its kind and id, and the chip comes from its answer', async () => {
        mine();
        node.linkables = {
            groups: [{ kind: 'group', id: 'g-1', name: 'Garden Crew', role: 'member' }, { kind: 'group', id: 'g-old', name: 'Closed one', role: 'member', readOnly: true }],
            listings: [{ id: 'n-1', type: 'need', title: 'Spade', authorPublicKey: ME }, { id: 'e-9', type: 'event', title: 'Not a listing', authorPublicKey: ME }],
            events: [{ postId: 'ev-1', title: 'Seed day' }],
        };
        await openTopic();
        fireEvent.click(within(await menu()).getByText('Link'));
        const sheet = await screen.findByTestId('forum-link-sheet');
        await within(sheet).findByText('Spade');
        expect(within(sheet).queryByText('Closed one')).toBeNull();
        expect(within(sheet).queryByText('Not a listing')).toBeNull();
        expect(within(sheet).getByText('Garden Crew')).toBeInTheDocument();
        expect(within(sheet).getByText('Seed day')).toBeInTheDocument();
        await act(async () => { fireEvent.click(within(sheet).getByText('Spade')); });
        expect(sent('POST', '/api/forum/topics/ft-1/links').map((c) => c.body)).toEqual([{ kind: 'listing', targetId: 'n-1' }]);
        expect(await screen.findByTestId('forum-link-listing')).toHaveTextContent('Linked n-1');
        // Linked now, with Take off; the same listing can't be linked twice.
        expect(within(sheet).getByText('Spade').closest('button')).toBeDisabled();
        await act(async () => { fireEvent.click(within(sheet).getByTestId('forum-link-take-off')); });
        expect(sent('POST', '/api/forum/topics/ft-1/links').at(-1)!.body).toEqual({ kind: 'listing', targetId: 'n-1', on: false });
        await waitFor(() => expect(screen.queryByTestId('forum-link-chips')).toBeNull());
    });

    it('a topic with three things linked offers no more, and no Make this a Need: the Decision chip counts, and so does a placeholder', async () => {
        mine({ links: [shownLink('group', 'g-1', 'Garden Crew'), { kind: 'event', shown: false }], decision: { id: 'd-1', title: 'Budget', status: 'open' } });
        render(<ForumPage me={ME} onMakeNeed={vi.fn()} />);
        fireEvent.click(await screen.findByText('Seed swap ideas'));
        await screen.findByTestId('forum-topic-title');
        const m = await menu();
        expect(within(m).queryByText('Make this a Need')).toBeNull();
        fireEvent.click(within(m).getByText('Link'));
        expect(await screen.findByTestId('forum-link-full')).toHaveTextContent('A topic can link at most 3 things. Take one off first.');
    });

    it('someone else\'s topic: no Link and no Make this a Need for a member; an owner may take a shown link off, never add one', async () => {
        state.topics[0] = { ...state.topics[0], links: [shownLink('group', 'g-1', 'Garden Crew'), { kind: 'listing', shown: false }] };
        render(<ForumPage me={ME} onMakeNeed={vi.fn()} />);
        fireEvent.click(await screen.findByText('Seed swap ideas'));
        await screen.findByTestId('forum-topic-title');
        let m = await menu();
        expect(within(m).queryByText('Link')).toBeNull();
        expect(within(m).queryByText('Make this a Need')).toBeNull();
        cleanup();
        node.role = 'owner';
        await openTopic();
        await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
        m = await menu();
        fireEvent.click(within(m).getByText('Link'));
        const sheet = await screen.findByTestId('forum-link-sheet');
        // Only what the node showed can be taken off: the placeholder has no id, so it isn't listed.
        expect(within(sheet).getAllByTestId('forum-link-take-off')).toHaveLength(1);
        expect(within(sheet).queryByTestId('forum-link-pick-listing')).toBeNull();
    });

    it('Make this a Need: the Market\'s Need form, filled with the title and the opening words, naming the topic', async () => {
        mine();
        const makeNeed = vi.fn();
        render(<ForumPage me={ME} onMakeNeed={makeNeed} />);
        fireEvent.click(await screen.findByText('Seed swap ideas'));
        await screen.findByTestId('forum-topic-title');
        fireEvent.click(within(await menu()).getByText('Make this a Need'));
        expect(makeNeed).toHaveBeenCalledWith(expect.objectContaining({ type: 'need', title: 'Seed swap ideas', description: 'Who has beans to swap?', forumTopicId: 'ft-1', credits: null }));
        expect(screen.queryByTestId('forum-menu')).toBeNull();
    });

    it('a new topic links what was picked, once the node has made it a topic', async () => {
        node.linkables = { groups: [{ kind: 'group', id: 'g-1', name: 'Garden Crew', role: 'member' }], listings: [], events: [] };
        render(<ForumPage me={ME} />);
        fireEvent.click(await screen.findByTestId('forum-new'));
        fireEvent.change(screen.getByTestId('forum-new-title'), { target: { value: 'Seed swap ideas' } });
        fireEvent.change(screen.getByTestId('forum-new-words'), { target: { value: 'Bring a jar.' } });
        fireEvent.click(screen.getByTestId('forum-new-link'));
        const sheet = await screen.findByTestId('forum-link-sheet');
        await act(async () => { fireEvent.click(await within(sheet).findByText('Garden Crew')); });
        fireEvent.click(within(sheet).getByText('Done'));
        expect(sent('POST', '/api/forum/topics/ft-1/links')).toHaveLength(0);
        await act(async () => { fireEvent.click(screen.getByTestId('forum-new-post')); });
        await waitFor(() => expect(sent('POST', '/api/forum/topics/ft-1/links').map((c) => c.body)).toEqual([{ kind: 'group', targetId: 'g-1' }]));
    });

    it('a first topic that waits for a look offers no Link: it is no topic yet', async () => {
        state.front = front({ firstTopicWaits: true });
        render(<ForumPage me={ME} />);
        fireEvent.click(await screen.findByTestId('forum-new'));
        expect(screen.queryByTestId('forum-new-link')).toBeNull();
    });

    it('a door from elsewhere opens its topic; the Start a community door picks that section and searches for the town', async () => {
        state.front = front({ sections: [...SECTIONS, { id: 's-start', starter: 'start-community', name: null, about: null, position: 2, starts: 'members', listed: true, archived: false }] });
        const { rerender } = render(<ForumPage me={ME} door={{ topic: 'ft-1' }} />);
        expect(await screen.findByTestId('forum-topic-title')).toHaveTextContent('Seed swap ideas');
        rerender(<ForumPage me={ME} door={{ starter: 'start-community', q: 'Riverside' }} />);
        await waitFor(() => expect((screen.getByTestId('forum-section-pick') as HTMLSelectElement).value).toBe('s-start'));
        // Kept to the section it names (round 2, #3252 finding 4): the town's posts in "Start a community near you" alone.
        await waitFor(() => expect(node.calls.some((c) => c.path === '/api/forum/search?q=Riverside&section=s-start')).toBe(true));
        expect(node.calls.some((c) => c.path === '/api/forum/search?q=Riverside')).toBe(false);
        expect(screen.getByTestId('forum-search-box')).toHaveValue('Riverside');
    });
});

/**
 * Round 2 (#3252 findings 3 and 4): every door into the forum is one-shot and lands exactly where it names. A table over the
 * doors (the town search, a circle's row, a group's Topics row, a topic) x the paths after it (used, back from a topic, the
 * member's own search or ✕ first, the Chats side and back), each from a forum where the member had searched before.
 * The harness holds the door as App does and lets go of it when the Forum says it took it; "side" mounts the Forum afresh.
 */
describe('doors are one-shot and land where they name (round 2)', () => {
    const START = { id: 's-start', starter: 'start-community', name: null, about: null, position: 2, starts: 'members', listed: true, archived: false };
    function Harness({ initial, taken }: { initial: ForumDoor; taken: () => void }) {
        const [door, setDoor] = useState<ForumDoor | null>(initial);
        const [shown, setShown] = useState(true);
        return (
            <>
                <button type="button" data-testid="h-side" onClick={() => setShown((v) => !v)}>side</button>
                {shown && <ForumPage me={ME} door={door} onDoorTaken={() => { taken(); setDoor(null); }} />}
            </>
        );
    }
    const DOORS: { name: string; door: ForumDoor; section?: string; town?: string }[] = [
        { name: 'the Find card\'s town search', door: { starter: 'start-community', q: 'Riverside' }, section: 's-start', town: 'Riverside' },
        { name: 'a circle\'s Talk about it row', door: { starter: 'start-community', q: '' }, section: 's-start' },
        { name: 'a group\'s Topics row', door: { section: 's-news' }, section: 's-news' },
        { name: 'a topic\'s door', door: { topic: 'ft-1' } },
    ];
    const PATHS = ['used', 'back from a topic', 'the member\'s own search, or ✕, first', 'the Chats side and back'] as const;
    const townAsks = () => node.calls.filter((c) => c.path.startsWith('/api/forum/search?q=Riverside')).length;
    const pick = () => (screen.getByTestId('forum-section-pick') as HTMLSelectElement).value;
    const side = () => { fireEvent.click(screen.getByTestId('h-side')); fireEvent.click(screen.getByTestId('h-side')); };

    beforeEach(async () => {
        state.front = front({ sections: [...SECTIONS, START] });
        searched = (q) => ({ hits: [hit(2, `${q} by the river`)], next: null });
        // An earlier search of the member's, kept for the page's life: its hits would show in the list's place.
        await searchForum('beans');
        node.calls.length = 0;
    });

    it.each(DOORS.flatMap((d) => PATHS.map((path) => [d.name, path, d] as const)))('%s, %s', async (_name, path, d) => {
        const taken = vi.fn();
        render(<Harness initial={d.door} taken={taken} />);
        // Used: it lands where it names, the kept search gone from over it.
        if (!d.section) {
            expect(await screen.findByTestId('forum-topic-title')).toHaveTextContent('Seed swap ideas');
        } else {
            await waitFor(() => expect(pick()).toBe(d.section));
            if (d.town) {
                expect(await screen.findAllByTestId('forum-search-hit')).toHaveLength(1);
                expect(screen.getByTestId('forum-search-box')).toHaveValue(d.town);
                expect(sent('GET', `/api/forum/search?q=${d.town}&section=${d.section}`)).toHaveLength(1);
            } else {
                expect(await screen.findAllByTestId('forum-topic-row')).toHaveLength(2);
                expect(screen.queryByTestId('forum-search-hit')).toBeNull();
                expect(screen.getByTestId('forum-search-box')).toHaveValue('');
            }
        }
        expect(node.calls.some((c) => c.path.includes('q=beans'))).toBe(false);
        expect(taken).toHaveBeenCalledTimes(1);
        if (path === 'used') return;

        if (path === 'back from a topic') {
            if (d.section) {
                fireEvent.click((await screen.findAllByTestId(d.town ? 'forum-search-hit' : 'forum-topic-row'))[0]);
                await screen.findByTestId('forum-topic-title');
            }
            fireEvent.click(screen.getByTestId('forum-back'));
            // Back on the list: the door's hits drawn from the kept copy (asked once), else the section's topics.
            if (d.town) expect(await screen.findAllByTestId('forum-search-hit')).toHaveLength(1);
            else expect(await screen.findAllByTestId('forum-topic-row')).toHaveLength(2);
            if (d.section) expect(pick()).toBe(d.section);
        } else if (path === 'the member\'s own search, or ✕, first') {
            if (!d.section) { fireEvent.click(screen.getByTestId('forum-back')); await screen.findAllByTestId('forum-topic-row'); }
            if (d.town) {
                // ✕, a topic from the list, back: the list the member chose, not the town's hits again.
                fireEvent.click(screen.getByRole('button', { name: 'Clear the search' }));
                fireEvent.click((await screen.findAllByTestId('forum-topic-row'))[0]);
                await screen.findByTestId('forum-topic-title');
                fireEvent.click(screen.getByTestId('forum-back'));
                expect(await screen.findAllByTestId('forum-topic-row')).toHaveLength(2);
                expect(screen.queryByTestId('forum-search-hit')).toBeNull();
            }
            // Their own search, a hit, back: their hits, not the door's.
            fireEvent.change(screen.getByTestId('forum-search-box'), { target: { value: 'garden' } });
            fireEvent.click(screen.getByRole('button', { name: 'Search' }));
            fireEvent.click((await screen.findAllByTestId('forum-search-hit'))[0]);
            await screen.findByTestId('forum-topic-title');
            fireEvent.click(screen.getByTestId('forum-back'));
            expect(await screen.findAllByTestId('forum-search-hit')).toHaveLength(1);
            expect(screen.getByTestId('forum-search-box')).toHaveValue('garden');
            expect(sent('GET', '/api/forum/search?q=garden')).toHaveLength(1);
        } else {
            side();
            // Mounted afresh with the door let go of: the list, nothing opened or asked again.
            await screen.findByTestId('forum-page');
            expect(screen.queryByTestId('forum-topic-title')).toBeNull();
            expect(taken).toHaveBeenCalledTimes(1);
        }
        expect(townAsks()).toBe(d.town ? 1 : 0);
    });

    it('a door still waiting for the front is dropped by the member\'s own move: a section picked first asks nothing', async () => {
        state.front = null as any;
        let answerFront: (f: unknown) => void = () => {};
        const later = new Promise((r) => { answerFront = r; });
        node.answer = (c) => (c.path === '/api/forum' ? later : standIn(c));
        render(<ForumPage me={ME} door={{ starter: 'start-community', q: 'Riverside' }} />);
        await screen.findAllByTestId('forum-topic-row');
        fireEvent.change(screen.getByTestId('forum-section-pick'), { target: { value: '' } });
        await act(async () => { answerFront(front({ sections: [...SECTIONS, START] })); await later; });
        await screen.findByRole('option', { name: 'General' });
        expect(pick()).toBe('');
        expect(townAsks()).toBe(0);
    });
});
