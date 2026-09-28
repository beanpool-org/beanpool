/**
 * The example cards on a nearly empty Market (lib/example-listings.ts; Marty, 2026-09-27): on a node that asks for
 * them (`features.exampleListings`, the global profile), while fewer than EXAMPLES_UNTIL real listings are in view, for
 * a member and for a visitor to the lobby. Never on a local community or a node that says nothing, never under a
 * search or a filter, and never something that can be opened, messaged or traded. The node is stubbed at lib/api.
 */
import { render, screen, waitFor, act, within, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import React from 'react';
import { MarketplacePage } from './MarketplacePage';
import type { BeanPoolIdentity } from '../lib/identity';
import * as api from '../lib/api';
import { resetCommunityInfoOnce } from '../lib/visitor-lobby-gate';
import { EXAMPLES_UNTIL, EXAMPLE_LISTINGS, EXAMPLES_HEADING, exampleLabel, showExampleListings } from '../lib/example-listings';

vi.mock('../lib/avatar', () => ({ resolveAvatarUrl: vi.fn((url) => url) }));
vi.mock('../lib/sync', () => ({ onSyncActivity: vi.fn(() => () => {}) }));
vi.mock('../lib/blocklist', () => ({ getBlockedUsers: vi.fn(() => []), onBlocklistUpdated: vi.fn(() => () => {}) }));
vi.mock('../lib/geo', () => ({
    loadRadiusSettings: vi.fn(() => null), saveRadiusSettings: vi.fn(), clearRadiusSettings: vi.fn(), haversineDistance: vi.fn(() => 0),
}));
vi.mock('../lib/peer-prefs', () => ({ loadEnabledPeers: vi.fn(() => new Set()), togglePeer: vi.fn() }));
vi.mock('../lib/profile-status', () => ({ getProfileStatus: vi.fn(async () => ({ complete: true })), describeMissing: vi.fn(() => '') }));
vi.mock('../components/ImageLightbox', () => ({ ImageLightbox: () => null }));
vi.mock('../components/ActivityWaterfall', () => ({ ActivityWaterfall: () => <p>Welcome to the Community</p> }));

const identity: BeanPoolIdentity = {
    publicKey: 'member-pk', privateKey: 'mock-private-key-hex', callsign: 'Ana', createdAt: '2026-09-17T00:00:00.000Z',
};

const GLOBAL_INFO = {
    memberCount: 3, postCount: 0, transactionCount: 0, commonsBalance: 0, profile: 'global' as const,
    features: { openJoin: true, guestListingsOnly: true, beans: false, exampleListings: true },
};
const LOCAL_INFO = { ...GLOBAL_INFO, profile: 'local' as const, features: { openJoin: false, guestListingsOnly: false, beans: true, exampleListings: false } };
// A node from before the switch: says nothing about it.
const OLD_INFO = { ...GLOBAL_INFO, features: { openJoin: true, guestListingsOnly: true, beans: false } };

const listing = (i: number) => ({
    id: `real-${i}`, title: `Real listing ${i}`, description: 'Real words', type: i % 2 ? 'need' : 'offer', category: 'general',
    credits: 0, priceType: 'fixed', status: 'active', active: true, authorPublicKey: `author-${i}`, authorCallsign: `Author ${i}`,
    createdAt: new Date(Date.now() - i * 60_000).toISOString(), photos: [],
});
const listings = (n: number) => Array.from({ length: n }, (_, i) => listing(i + 1));

function stubNode(info: unknown, posts: unknown[]) {
    vi.restoreAllMocks();
    resetCommunityInfoOnce();
    vi.spyOn(api, 'getCommunityInfo').mockImplementation(async () => {
        if (info instanceof Error) throw info;
        return info as api.CommunityInfo;
    });
    vi.spyOn(api, 'getMarketplacePosts').mockResolvedValue(posts as any);
    vi.spyOn(api, 'getTreasuries').mockResolvedValue({ treasuries: [] });
    vi.spyOn(api, 'getMembers').mockResolvedValue([]);
    vi.spyOn(api, 'getNodeInfo').mockResolvedValue({ peerNodes: [] } as any);
    vi.spyOn(api, 'getNodeConfig').mockResolvedValue({} as any);
    vi.spyOn(api, 'getBalance').mockResolvedValue({ balance: 0, isBlockedFromTrading: false } as any);
    vi.spyOn(api, 'getGroups').mockResolvedValue([]);
}

/** Lets the page's reads (the posts, and the one read of /api/community/info) land. */
async function settle() {
    await act(async () => { await new Promise(r => setTimeout(r, 30)); });
}

async function renderMember(info: unknown, posts: unknown[]) {
    stubNode(info, posts);
    const view = render(<MarketplacePage identity={identity} isMember={true} />);
    await waitFor(() => expect(api.getMarketplacePosts).toHaveBeenCalled());
    await waitFor(() => expect(api.getCommunityInfo).toHaveBeenCalled());
    await settle();
    return view;
}

async function renderVisitor(info: unknown, posts: unknown[]) {
    stubNode(info, posts);
    const joinCard = <div data-testid="join-card"><button type="button">Join</button></div>;
    const view = render(<MarketplacePage identity={null} isMember={false} visitor={{ joinCard, onJoin: vi.fn(), beans: false }} />);
    await waitFor(() => expect(api.getMarketplacePosts).toHaveBeenCalled());
    await waitFor(() => expect(api.getCommunityInfo).toHaveBeenCalled());
    await settle();
    return view;
}

const exampleCards = () => screen.queryAllByTestId('example-card');

describe('the rule', () => {
    it('shows the examples only where the node asks, nothing narrows the list, it loaded, and fewer than EXAMPLES_UNTIL are real', () => {
        expect(EXAMPLES_UNTIL).toBe(6);
        const base = { on: true, narrowed: false, failed: false, realInView: 0 };
        expect(showExampleListings(base)).toBe(true);
        expect(showExampleListings({ ...base, realInView: EXAMPLES_UNTIL - 1 })).toBe(true);
        expect(showExampleListings({ ...base, realInView: EXAMPLES_UNTIL })).toBe(false);
        expect(showExampleListings({ ...base, realInView: 40 })).toBe(false);
        expect(showExampleListings({ ...base, on: false })).toBe(false);
        expect(showExampleListings({ ...base, narrowed: true })).toBe(false);
        expect(showExampleListings({ ...base, failed: true })).toBe(false);
    });

    it('has 3 or 4 examples of everyday things, with no name, place, price, Beans or link in them', () => {
        expect(EXAMPLE_LISTINGS.length).toBeGreaterThanOrEqual(3);
        expect(EXAMPLE_LISTINGS.length).toBeLessThanOrEqual(4);
        expect(new Set(EXAMPLE_LISTINGS.map(e => e.type))).toEqual(new Set(['offer', 'need']));
        for (const e of EXAMPLE_LISTINGS) {
            const words = `${e.title} ${e.description}`;
            expect(words).not.toMatch(/\bbeans?\b|🫘|Ʀ|\$|€|£|\d+\s*(km|m)\b|https?:|www\.|@/i);
            expect(Object.keys(e).sort()).toEqual(['description', 'emoji', 'key', 'title', 'type']);
            expect(exampleLabel(e)).toMatch(/^Example, not a real listing\. (Offer|Need): /);
        }
    });
});

describe('a member\'s Market on the global community', () => {
    beforeEach(() => { localStorage.clear(); });

    it('with nothing posted: the examples, each badged and labelled as an example, above the welcome and its way to post', async () => {
        await renderMember(GLOBAL_INFO, []);
        const section = screen.getByTestId('example-listings');
        expect(section).toHaveAttribute('aria-label', EXAMPLES_HEADING);
        expect(section).toHaveTextContent(/not real listings/);
        const cards = exampleCards();
        expect(cards).toHaveLength(EXAMPLE_LISTINGS.length);
        cards.forEach((card, i) => {
            expect(within(card).getByTestId('example-badge')).toHaveTextContent('Example');
            expect(card).toHaveAttribute('aria-label', exampleLabel(EXAMPLE_LISTINGS[i]));
            expect(card).toHaveTextContent(EXAMPLE_LISTINGS[i].title);
        });
        // Beside today's empty state, not in place of it.
        const welcome = screen.getByText('Welcome to the Community');
        expect(section.compareDocumentPosition(welcome) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    });

    it(`with ${EXAMPLES_UNTIL - 1} real listings: the examples, after every real one`, async () => {
        await renderMember(GLOBAL_INFO, listings(EXAMPLES_UNTIL - 1));
        expect(exampleCards()).toHaveLength(EXAMPLE_LISTINGS.length);
        const section = screen.getByTestId('example-listings');
        for (let i = 1; i < EXAMPLES_UNTIL; i++) {
            const real = screen.getByText(`Real listing ${i}`);
            expect(section.compareDocumentPosition(real) & Node.DOCUMENT_POSITION_PRECEDING).toBeTruthy();
            expect(section.contains(real)).toBe(false);
        }
    });

    it(`with ${EXAMPLES_UNTIL} real listings: none`, async () => {
        await renderMember(GLOBAL_INFO, listings(EXAMPLES_UNTIL));
        expect(screen.getByText(`Real listing ${EXAMPLES_UNTIL}`)).toBeInTheDocument();
        expect(screen.queryByTestId('example-listings')).toBeNull();
        expect(exampleCards()).toHaveLength(0);
    });

    it('no example can be opened, followed or acted on: no button, link or focus stop, and a click opens nothing', async () => {
        await renderMember(GLOBAL_INFO, listings(2));
        const section = screen.getByTestId('example-listings');
        expect(within(section).queryAllByRole('button')).toHaveLength(0);
        expect(within(section).queryAllByRole('link')).toHaveLength(0);
        expect(section.querySelectorAll('[tabindex], input, textarea, select')).toHaveLength(0);
        for (const card of exampleCards()) {
            expect(card.closest('button, a, [role="button"]')).toBeNull();
            const reads = vi.mocked(api.getMarketplacePosts).mock.calls.length;
            await act(async () => { fireEvent.click(card); });
            // Still the Market, with its examples: no detail sheet, and no read of any post by id.
            expect(screen.getByTestId('example-listings')).toBeInTheDocument();
            expect(screen.queryByTestId('event-detail')).toBeNull();
            expect(vi.mocked(api.getMarketplacePosts).mock.calls.length).toBe(reads);
            expect(vi.mocked(api.getMarketplacePosts).mock.calls.every(([f]) => !(f as any)?.id)).toBe(true);
        }
    });

    it('a search never finds an example, and a filter shows none', async () => {
        await renderMember(GLOBAL_INFO, listings(2));
        expect(exampleCards()).toHaveLength(EXAMPLE_LISTINGS.length);
        const search = screen.getByPlaceholderText('Search marketplace...');
        await act(async () => { fireEvent.change(search, { target: { value: EXAMPLE_LISTINGS[0].title.split(' ')[0] } }); });
        await settle();
        expect(exampleCards()).toHaveLength(0);
        expect(screen.queryByText(EXAMPLE_LISTINGS[0].title)).toBeNull();
        await act(async () => { fireEvent.change(search, { target: { value: '' } }); });
        await settle();
        expect(exampleCards()).toHaveLength(EXAMPLE_LISTINGS.length);
        await act(async () => { screen.getByRole('button', { name: '🟢 Offers' }).click(); });
        await settle();
        expect(exampleCards()).toHaveLength(0);
    });

    it('none where the Market failed to load', async () => {
        stubNode(GLOBAL_INFO, []);
        vi.mocked(api.getMarketplacePosts).mockRejectedValue(new Error('offline'));
        render(<MarketplacePage identity={identity} isMember={true} />);
        await screen.findByText('offline');
        await settle();
        expect(exampleCards()).toHaveLength(0);
    });
});

describe('never where the node does not ask for them', () => {
    beforeEach(() => { localStorage.clear(); });

    it('a local community with nothing posted: none', async () => {
        await renderMember(LOCAL_INFO, []);
        expect(screen.getByText('Welcome to the Community')).toBeInTheDocument();
        expect(exampleCards()).toHaveLength(0);
    });

    it('a node that says nothing about them (older than the switch): none', async () => {
        await renderMember(OLD_INFO, []);
        expect(exampleCards()).toHaveLength(0);
    });

    it('a node whose info could not be read: none', async () => {
        await renderMember(new Error('unreachable'), []);
        expect(exampleCards()).toHaveLength(0);
    });
});

describe('a visitor to the global lobby', () => {
    beforeEach(() => { localStorage.clear(); });

    it('with nothing posted: the Join card, then the examples, then "Nothing posted here yet"', async () => {
        await renderVisitor(GLOBAL_INFO, []);
        const join = screen.getByTestId('join-card');
        const section = screen.getByTestId('example-listings');
        const empty = screen.getByText('Nothing posted here yet');
        expect(join.compareDocumentPosition(section) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
        expect(section.compareDocumentPosition(empty) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
        expect(screen.getByText('Join to post the first offer.')).toBeInTheDocument();
        expect(exampleCards()).toHaveLength(EXAMPLE_LISTINGS.length);
        for (const card of exampleCards()) expect(within(card).getByTestId('example-badge')).toHaveTextContent('Example');
        // The Join card's button is the only button: an example is not one.
        expect(within(section).queryAllByRole('button')).toHaveLength(0);
    });

    it(`with ${EXAMPLES_UNTIL - 1} real listings: after the list, outside it`, async () => {
        await renderVisitor(GLOBAL_INFO, listings(EXAMPLES_UNTIL - 1));
        const list = screen.getByTestId('visitor-list');
        const section = screen.getByTestId('example-listings');
        expect(list.contains(section)).toBe(false);
        expect(list.compareDocumentPosition(section) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
        expect(within(list).queryAllByTestId('example-card')).toHaveLength(0);
    });

    it(`with ${EXAMPLES_UNTIL} real listings: none`, async () => {
        await renderVisitor(GLOBAL_INFO, listings(EXAMPLES_UNTIL));
        expect(screen.getAllByTestId('visitor-card')).toHaveLength(EXAMPLES_UNTIL);
        expect(exampleCards()).toHaveLength(0);
    });

    it('on a node that says nothing about them: none', async () => {
        await renderVisitor(OLD_INFO, []);
        expect(screen.getByText('Nothing posted here yet')).toBeInTheDocument();
        expect(exampleCards()).toHaveLength(0);
    });
});

describe('the examples stay on the Market', () => {
    it('only the Market draws them: the Map, search and every count read the node\'s posts, which never hold one', () => {
        const src = path.resolve(__dirname, '..');
        const files: string[] = [];
        const walk = (dir: string) => {
            for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
                const full = path.join(dir, entry.name);
                if (entry.isDirectory()) walk(full);
                else if (/\.(ts|tsx)$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) files.push(full);
            }
        };
        walk(src);
        const users = files
            .filter(f => /example-listings'|ExampleListings'/.test(fs.readFileSync(f, 'utf8')))
            .map(f => path.relative(src, f).split(path.sep).join('/'))
            .sort();
        expect(users).toEqual(['components/ExampleListings.tsx', 'pages/MarketplacePage.tsx']);
        // And the Market draws them outside its posts: the component takes no post and hands nothing back.
        const component = fs.readFileSync(path.join(src, 'components/ExampleListings.tsx'), 'utf8');
        expect(component).toMatch(/export function ExampleListings\(\)/);
        expect(component).not.toMatch(/onClick|href=|onKeyDown|tabIndex|setSelectedPost|MarketplacePost/);
    });
});
