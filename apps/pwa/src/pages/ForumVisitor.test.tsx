/**
 * The forum for a visitor in the lobby (slice F7, the apps' part; core forum-visitors.ts): the Forum tab, read only, the door
 * where the reply box would be, the door that lands on a topic, and the Home card "From the forum".
 *
 * One table over (visitor on global, member on global, visitor on a local community) x (the forum has public topics / none /
 * no answer): what the card and the tab show. Never a join wall, never a false empty, never an empty card.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { forumDoorOfSearch, forumTopicDoor, visitorForumShows, type ForumPublicAnswer } from '@beanpool/core';
import { shownFrame, type HomeAnswer } from '../lib/home-cards';
import { ForumVisitorHome } from '../components/forum/ForumVisitorHome';
import { ForumVisitorPage } from './ForumVisitorPage';
import { takeKeptLinkedTopic } from '../lib/forum-public';

vi.mock('./HomePage', () => ({ HomePage: () => <div data-testid="stub-home" /> }));
vi.mock('./MarketplacePage', () => ({ MarketplacePage: () => <div data-testid="stub-market" /> }));
vi.mock('./LedgerPage', () => ({ LedgerPage: () => <div data-testid="stub-ledger" /> }));
vi.mock('./WelcomePage', () => ({ WelcomePage: () => <div data-testid="stub-welcome" /> }));
vi.mock('./MapPage', () => ({ MapPage: () => <div data-testid="stub-map" /> }));
vi.mock('../lib/sync', () => ({ connectToAnchor: vi.fn(), reconnectToAnchor: vi.fn() }));
vi.mock('../lib/web-join', () => ({ browserKeyProblem: vi.fn(async () => null) }));

import { GuestLobby } from './GuestLobby';

const GLOBAL = { forum: true, forumPublic: true, guestListingsOnly: true, beans: false };
const LOCAL = { forum: true, guestListingsOnly: true };
// The global community in a private preview: the server drops `forumPublic` (feat/forum-f7-server round 2, node-profile.ts),
// because a preview shows visitors nothing.
const PREVIEW = { forum: true, guestListingsOnly: true, beans: false, openJoin: false, wordsDoor: false, privatePreview: true };
const day = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString();
const writer = { name: 'Asha', community: null };
const topic = (id: string, title: string, created: number, sectionId = 's-ideas') => ({
    id, sectionId, title, writer, createdAt: day(created), lastActivityAt: day(created), replyCount: 2, pinned: false, closed: null, place: null, lang: 'en', indexable: true,
});
const SECTIONS = [{ id: 's-ideas', starter: null, name: 'Seed swaps', about: null, position: 1, topicCount: 4 }];
const TOPICS = [topic('ft-1', 'Oldest topic', 9), topic('ft-2', 'A tool library in a shed', 1), topic('ft-3', 'Seed swap ideas', 2), topic('ft-4', 'Starting small', 3)];
const page = (id: string) => ({
    section: SECTIONS[0],
    topic: TOPICS.find((x) => x.id === id) ?? topic(id, 'A door topic', 1),
    posts: [
        { id: `${id}-1`, topicId: id, number: 1, writer, words: `We share tools for ${id}.\nSecond line`, quotes: null, createdAt: day(1), edited: false, photos: 0, lang: 'en' },
        { id: `${id}-2`, topicId: id, number: 2, writer: { name: 'Dax', community: { kind: 'community', community: 'Riverside' } }, words: 'Count me in.', quotes: 1, createdAt: day(0), edited: false, photos: 0, lang: 'en' },
    ],
    next: null,
});

/**
 * The node's public reads, by what the forum holds, at the server's routes (feat/forum-f7-server routes/forum-public.ts). Anything
 * else read is a test failure (a member's route, say).
 */
function stubForum(holds: ForumPublicAnswer) {
    const calls: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        calls.push(url);
        expect(JSON.stringify(init?.headers ?? {})).not.toMatch(/signature|x-public-key/i);
        if (holds === 'unreachable') throw new TypeError('Failed to fetch');
        const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
        const path = url.replace(/^https?:\/\/[^/]+/, '').split('?')[0];
        const topics = holds === 'topics' ? TOPICS : [];
        if (path.startsWith('/api/forum/public/topics/')) return json(page(decodeURIComponent(path.split('/').pop()!)));
        if (path.startsWith('/api/forum/public/sections/')) return json({ section: SECTIONS[0], topics, next: null });
        if (path === '/api/forum/public') return json({ sections: SECTIONS, topics, next: null });
        throw new Error(`not a public forum read: ${url}`);
    }));
    return calls;
}

const visitorAnswer = (features: Record<string, unknown>): HomeAnswer => ({
    generatedAt: day(0), profile: 'global', welcome: true, me: null, layout: null, features,
    cards: {
        find: { point: null, communities: [], communityCount: 3, nearbyPosts: null, watches: null, knock: null, directoryFetchedAt: null },
        market: { items: [], total14d: 0, more: false, examples: true },
        community: { name: null, members: 20, communities: 3 },
    },
} as unknown as HomeAnswer);
const memberAnswer = (): HomeAnswer => ({ ...visitorAnswer(GLOBAL), welcome: false, me: { publicKey: 'a'.repeat(64) } } as unknown as HomeAnswer);

const frame = (body: ReactNode) => <section data-testid="forum-card-frame"><h2>From the forum</h2>{body}</section>;

beforeEach(() => { sessionStorage.clear(); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('who sees the visitors\' forum: the table (card + tab)', () => {
    const readers = [
        ['a visitor on the global community', 'visitor', GLOBAL],
        ['a member of the global community', 'member', GLOBAL],
        ['a visitor on a local community', 'visitor', LOCAL],
        ['a visitor on the global community in a private preview', 'visitor', PREVIEW],
    ] as const;
    const answers: ForumPublicAnswer[] = ['topics', 'none', 'unreachable'];
    for (const [who, reader, features] of readers) {
        for (const answer of answers) {
            it(`${who}, the forum has ${answer === 'topics' ? 'public topics' : answer === 'none' ? 'none public' : 'no answer'}`, () => {
                const shows = visitorForumShows(reader, features, answer);
                const cards = shownFrame(reader === 'member' ? memberAnswer() : visitorAnswer(features), null).map((c) => c.type);
                if (reader === 'visitor' && features === GLOBAL) {
                    // The tab whatever the answer; the card third, beside Near you and What people post, never empty.
                    expect(shows).toEqual({ tab: true, card: answer === 'topics' ? 'topics' : 'guide' });
                    expect(cards.slice(0, 3)).toEqual(['find', 'market', 'forum']);
                } else {
                    // A member reads the members' forum (the Chat tab's Forum side); a local community's forum is its members'.
                    expect(shows).toEqual({ tab: false, card: null });
                    if (reader === 'visitor') expect(cards).not.toContain('forum');
                }
            });
        }
    }
});

describe('the Home card "From the forum"', () => {
    it('public topics: the three newest, each with its first line and section; a tap opens it in the Forum tab', async () => {
        stubForum('topics');
        const onNavigate = vi.fn();
        render(<ForumVisitorHome features={GLOBAL} onNavigate={onNavigate} frame={frame} />);
        const rows = await screen.findAllByTestId('home-forum-visitor-topic');
        expect(rows.map((r) => r.textContent)).toEqual([
            'A tool library in a shedWe share tools for ft-2.Seed swaps',
            'Seed swap ideasWe share tools for ft-3.Seed swaps',
            'Starting smallWe share tools for ft-4.Seed swaps',
        ]);
        fireEvent.click(rows[1]);
        expect(onNavigate).toHaveBeenCalledWith('forum', 'ft-3');
        fireEvent.click(screen.getByTestId('home-forum-visitor-open'));
        expect(onNavigate).toHaveBeenLastCalledWith('forum');
    });

    for (const answer of ['none', 'unreachable'] as const) {
        it(`${answer === 'none' ? 'no public topic' : 'no answer'}: the guide's How BeanPool works, never an empty card or "no topics"`, async () => {
            stubForum(answer);
            const onNavigate = vi.fn();
            render(<ForumVisitorHome features={GLOBAL} onNavigate={onNavigate} frame={frame} />);
            const guide = await screen.findByTestId('home-forum-visitor-guide');
            expect(guide).toHaveTextContent('How BeanPool works');
            expect(screen.queryByTestId('home-forum-visitor-topic')).toBeNull();
            expect(screen.getByTestId('forum-card-frame')).not.toHaveTextContent(/No topics/);
            fireEvent.click(guide);
            expect(onNavigate).toHaveBeenCalledWith('guide', 'how-it-works');
        });
    }
});

describe("the lobby's Forum tab, read only", () => {
    it('public topics: the list, a topic with its writers and words, and Join to reply where the reply box would be', async () => {
        const calls = stubForum('topics');
        const onJoin = vi.fn();
        const { rerender } = render(<ForumVisitorPage topicId={null} onTopic={vi.fn()} onJoin={onJoin} />);
        expect((await screen.findAllByTestId('forum-visitor-topic-row')).map((r) => r.querySelector('span')!.textContent)).toEqual(TOPICS.map((x) => x.title));
        rerender(<ForumVisitorPage topicId="ft-2" onTopic={vi.fn()} onJoin={onJoin} />);
        expect(await screen.findByTestId('forum-visitor-title')).toHaveTextContent('A tool library in a shed');
        expect(screen.getByTestId('forum-visitor-post-2')).toHaveTextContent('Dax · Riverside');
        expect(screen.getByTestId('forum-visitor-post-2')).toHaveTextContent('Count me in.');
        expect(document.querySelector('textarea')).toBeNull();
        expect(screen.queryByTestId('forum-reply-box')).toBeNull();
        fireEvent.click(screen.getByTestId('forum-visitor-join'));
        expect(onJoin).toHaveBeenCalledTimes(1);
        // Kept for after the join, so the new member lands on it.
        expect(takeKeptLinkedTopic()).toBe('ft-2');
        expect(calls.every((u) => u.includes('/api/forum/public'))).toBe(true);
    });

    it('none public: says so, with the door (never a wall)', async () => {
        stubForum('none');
        const onJoin = vi.fn();
        render(<ForumVisitorPage topicId={null} onTopic={vi.fn()} onJoin={onJoin} />);
        expect(await screen.findByTestId('forum-visitor-none')).toHaveTextContent('No topics here yet. Join to start the first one.');
        fireEvent.click(screen.getByTestId('forum-visitor-join'));
        expect(onJoin).toHaveBeenCalled();
    });

    it('no answer: the forum\'s own "Couldn\'t load" with Try again, never "no topics"', async () => {
        stubForum('unreachable');
        render(<ForumVisitorPage topicId={null} onTopic={vi.fn()} onJoin={vi.fn()} />);
        expect(await screen.findByTestId('forum-visitor-failed')).toHaveTextContent('Couldn’t load the forum');
        expect(screen.queryByTestId('forum-visitor-none')).toBeNull();
        stubForum('topics');
        fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
        expect(await screen.findAllByTestId('forum-visitor-topic-row')).toHaveLength(4);
    });
});

describe('the lobby: the tab where the forum is public, and the door that lands on a topic', () => {
    const info = (features: Record<string, unknown>) => ({ profile: 'global', features } as never);

    it('the global community: a Forum tab beside Home, Market and Map; a tap opens the list', async () => {
        stubForum('topics');
        render(<GuestLobby info={info(GLOBAL)} onComplete={vi.fn()} />);
        const tabs = screen.getByTestId('lobby-bottom-nav');
        expect(Array.from(tabs.querySelectorAll('button')).map((b) => b.textContent)).toEqual(['🏠Home', '🤝Market', '🗺️Map', '💬Forum']);
        fireEvent.click(Array.from(tabs.querySelectorAll('button')).find((b) => b.textContent?.includes('Forum'))!);
        expect(await screen.findAllByTestId('forum-visitor-topic-row')).toHaveLength(4);
    });

    for (const [where, features] of [['a local community (its forum is for its members)', LOCAL], ['the global community in a private preview (it shows visitors nothing)', PREVIEW]] as const) {
        it(`${where}: no Forum tab`, () => {
            stubForum('topics');
            render(<GuestLobby info={info(features)} onComplete={vi.fn()} />);
            expect(screen.getByTestId('lobby-bottom-nav')).not.toHaveTextContent('Forum');
        });
    }

    it("a public page's Join to reply (/app?forumTopic=<id>): the Forum tab opens on that topic, read only, with the door", async () => {
        stubForum('topics');
        expect(forumDoorOfSearch(forumTopicDoor('ft-3').split('?')[1])).toEqual({ topic: 'ft-3' });
        const taken = vi.fn();
        render(<GuestLobby info={info(GLOBAL)} onComplete={vi.fn()} linkedForum={{ topic: 'ft-3' }} onLinkedForumTaken={taken} />);
        expect(await screen.findByTestId('forum-visitor-title')).toHaveTextContent('Seed swap ideas');
        expect(screen.getByTestId('forum-visitor-join')).toHaveTextContent('Join to reply');
        await waitFor(() => expect(taken).toHaveBeenCalled());
    });

    it("Forum chosen in the menu: its list, from a topic and from another tab (as a member's Chat in the menu, #3223)", async () => {
        stubForum('topics');
        render(<GuestLobby info={info(GLOBAL)} onComplete={vi.fn()} linkedForum={{ topic: 'ft-3' }} />);
        expect(await screen.findByTestId('forum-visitor-title')).toHaveTextContent('Seed swap ideas');
        const tab = (name: string) => Array.from(screen.getByTestId('lobby-bottom-nav').querySelectorAll('button')).find((b) => b.textContent?.includes(name))!;
        fireEvent.click(tab('Forum'));
        expect(await screen.findAllByTestId('forum-visitor-topic-row')).toHaveLength(4);
        expect(screen.queryByTestId('forum-visitor-title')).toBeNull();
        fireEvent.click(screen.getAllByTestId('forum-visitor-topic-row')[1]);
        expect(await screen.findByTestId('forum-visitor-title')).toHaveTextContent('A tool library in a shed');
        fireEvent.click(tab('Home'));
        fireEvent.click(tab('Forum'));
        expect(await screen.findAllByTestId('forum-visitor-topic-row')).toHaveLength(4);
        expect(screen.queryByTestId('forum-visitor-title')).toBeNull();
    });

    it('/app?forum=1 opens the list; a door address that is not a topic id opens nothing', async () => {
        expect(forumDoorOfSearch('?forum=1')).toEqual({ topic: null });
        expect(forumDoorOfSearch('?forumTopic=../api/me')).toBeNull();
        expect(forumDoorOfSearch('?post=ft-1')).toBeNull();
        stubForum('topics');
        render(<GuestLobby info={info(GLOBAL)} onComplete={vi.fn()} linkedForum={{ topic: null }} />);
        expect(await screen.findAllByTestId('forum-visitor-topic-row')).toHaveLength(4);
    });
});
