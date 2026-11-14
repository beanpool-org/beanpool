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
import { forgetForum, keptTopic } from '../lib/forum';
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
