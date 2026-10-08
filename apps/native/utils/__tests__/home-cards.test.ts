/**
 * Home's rules (utils/home-cards.ts; scratch/global-node/DESIGN-home-dashboard-fable.md, slice H2): the default order, the
 * shown-when rules for each person in §3.2, the layout (which copy wins, hide, move, reset), interests reordering
 * without filtering, unknown ids dropped, Needs you as the header builds it, each card's words, and the doorbell.
 * The safety card's schedule is the "one way back" card's (utils/one-way-back.ts), with the account's dismissal.
 */
import { describe, expect, it, vi } from 'vitest';

// utils/one-way-back.ts (the safety card's schedule) loads the phone's storage and signing: stood in for here.
vi.mock('react-native', () => ({ Platform: { OS: 'android' }, DeviceEventEmitter: { addListener: vi.fn(), emit: vi.fn() } }));
vi.mock('@react-native-async-storage/async-storage', () => ({ default: { getItem: vi.fn(), setItem: vi.fn(), removeItem: vi.fn() } }));
vi.mock('expo-secure-store', () => ({ getItemAsync: vi.fn(), setItemAsync: vi.fn(), deleteItemAsync: vi.fn() }));
vi.mock('expo-crypto', () => ({ getRandomBytes: vi.fn((n: number) => new Uint8Array(n)) }));

import {
    HOME_CARD_IDS, HOME_CARD_NAMES, HOME_DRAWN, HOME_DOORBELL_SETTLE_MS, beansLines, canHideCard, cardOrder, cardsToAsk, cardsToDraw, communityLines,
    DECIDE_HREF, POLLS_HREF, canTailor, cardOnNode, createDoorbellDebounce, decideLines, dealsLine, dismissSafety, effectiveInterests, enterpriseLine, eventDay, formatBeans, groupLine,
    invitesForReader, FIND_PINNED_DAYS, askPinned, canMoveCard, findPinned, firstSteps, globalStepLines, isFindCard, joinedNames, marketInOrder,
    pinnedCards, probationSentence,
    hideCard, isHidden, joinedLine, localNeeds, marketForward, mergeNeeds, moveCard, pickLayout, readHomeAnswer, readHomeLayout,
    needsLineA11y, resetLayout, safetyWord, sentence, showCard, starredFirst, stepLines, voteLabelHere,
    type HomeAnswer, type HomeCards, type HomeLayout,
} from '../home-cards';
import { dismissedOneWayBack, oneWayBackPlace, withAccountDismissal, ONE_WAY_BACK_WEEK_MS, type OneWayBack } from '../one-way-back';
import { normalizeCategory } from '@beanpool/core';
import { mayInviteHere } from '../invite-entries';

const ME = 'a'.repeat(64);
// A fixed local afternoon, so "tonight" and "tomorrow" are stable wherever the suite runs.
const NOW = new Date(2026, 9, 2, 14, 0, 0).getTime();
const H = 3600_000;
const iso = (ms: number) => new Date(ms).toISOString();

function answer(over: Partial<HomeAnswer> & { cards?: HomeCards } = {}): HomeAnswer {
    return {
        generatedAt: iso(NOW),
        profile: 'local',
        features: { beans: true, escrow: true, invites: true, exampleListings: false, decisions: true },
        me: { joinedAt: iso(NOW - 2 * 24 * H), isKeeper: false, probation: null, interests: [], area: null, firstOffer: false, standing: 'member' },
        layout: null,
        cards: { community: { name: 'Mullumbimby', members: 81, tradesThisMonth: 23 } },
        ...over,
    };
}
const ctx = (over: Partial<Parameters<typeof cardsToDraw>[2]> = {}) => ({ interests: [] as string[], tuneOpen: false, safetyUp: false, ...over });
const layout = (over: Partial<HomeLayout> = {}): HomeLayout => ({ v: 1, order: [], hidden: [], dismissed: {}, updatedAt: iso(NOW), ...over });

const market = (n: number, cats: string[] = []): HomeCards['market'] => ({
    items: Array.from({ length: n }, (_, i) => ({ id: `p${i}`, type: i % 2 ? 'need' : 'offer', title: `Listing ${i}`, category: cats[i] ?? 'goods', credits: 10 + i, photoUrl: null })),
    total14d: n, more: false,
});
const events: HomeCards['events'] = { items: [{ id: 'e1', title: 'Seed swap', startsAt: iso(NOW + 24 * H), endsAt: null, place: 'Town Hall', rsvp: null }], radiusKm: null };
const steps = (over: Partial<NonNullable<HomeCards['steps']>> = {}): NonNullable<HomeCards['steps']> => ({
    joinedAt: iso(NOW - 2 * 24 * H), firstOffer: false, firstPost: false, photo: false, interests: false, invited: false, area: false, knocked: null, ...over,
});
/** Find your community's body as the global node sends it (routes/global-directory.ts landingCardFor): one community 12 km away. */
const find = (over: Partial<NonNullable<HomeCards['find']>> = {}): NonNullable<HomeCards['find']> => ({
    point: 'area',
    communities: [{ key: 'byron', name: 'Byron Shire BeanPool', url: 'https://byron.example.org', lat: -28.6, lng: 153.6, radiusKm: 20, memberCount: 40, contactEmail: null, contactPhone: null, distanceKm: 12 }],
    communityCount: 38, nearbyPosts: { radiusKm: 25, count: 9, more: false }, watches: [], knock: null, directoryFetchedAt: iso(NOW - H), ...over,
});

describe('the catalogue and the default order (§3.1)', () => {
    it('18 cards in the design\'s order (the 17 and Tips after First steps), the node\'s own list (apps/server engine/home-preferences.ts)', () => {
        expect(HOME_CARD_IDS).toEqual([
            'needs', 'safety', 'find', 'steps', 'tips', 'interests', 'deals', 'enterprise', 'events', 'market', 'decide', 'groups',
            'joined', 'pulse', 'beans', 'notices', 'invite', 'community',
        ]);
        expect(cardOrder(null)).toEqual([...HOME_CARD_IDS]);
    });

    it('this build draws the whole catalogue: Find your community came to Home in H4', () => {
        expect(HOME_DRAWN).toContain('find');
        expect(HOME_DRAWN).toEqual([...HOME_CARD_IDS]);
    });

    it('`needs` and `community` can\'t be hidden or moved; everything else can', () => {
        expect(canHideCard('needs')).toBe(false);
        expect(canHideCard('community')).toBe(false);
        for (const id of HOME_CARD_IDS.filter(i => i !== 'needs' && i !== 'community')) expect(canHideCard(id)).toBe(true);
    });
});

describe('what each person sees, top down (§3.2)', () => {
    it('Tips (TIPS-DESIGN §1): right after First steps for a new member with a tip to show; never a visitor, never asked of the node', () => {
        const a = answer({ cards: { steps: steps(), events, community: { name: 'Mullumbimby', members: 81, tradesThisMonth: 23 } } });
        expect(cardsToDraw(a, null, ctx({ tipsUp: true }))).toEqual(['steps', 'tips', 'interests', 'events', 'community']);
        expect(cardsToDraw(a, null, ctx({ tipsUp: false }))).toEqual(['steps', 'interests', 'events', 'community']);
        expect(cardsToDraw({ ...a, me: null }, null, ctx({ tipsUp: true }))).not.toContain('tips');
        expect(cardsToDraw({ ...a, me: { ...a.me!, standing: 'suspended' } }, null, ctx({ tipsUp: true }))).toContain('tips');
        expect(cardsToDraw(a, layout({ hidden: ['tips'] }), ctx({ tipsUp: true }))).not.toContain('tips');
        expect(cardsToAsk(null)).not.toContain('tips');
        expect(cardsToAsk(layout({ hidden: ['tips'] }))).toEqual(cardsToAsk(null));
        expect(HOME_CARD_NAMES.tips).toBe('Tips');
    });

    it('(b) a new local member: steps · interests · events · market · joined · pulse · beans · community', () => {
        const a = answer({
            cards: {
                steps: steps(), events, market: market(3), joined: { count7d: 5, radiusKm: null, names: [{ callsign: 'Ana', avatarUrl: null }, { callsign: 'Kofi', avatarUrl: null }] },
                pulse: { items: [{ id: 'q1', title: 'How our LETS started', thumbnailUrl: null, platform: 'youtube', callsign: 'River Folk Studio', category: 'education', url: null }] },
                beans: { balance: 0, room: 0, tier: 'Newcomer', activated: false, frozen: false },
                community: { name: 'Mullumbimby', members: 81, tradesThisMonth: 23 },
            },
        });
        expect(cardsToDraw(a, null, ctx())).toEqual(['steps', 'interests', 'events', 'market', 'joined', 'pulse', 'beans', 'community']);
    });

    it('(b) the same member a month in: needs when something waits, the invite card after their first Offer; steps and interests gone', () => {
        const a = answer({
            me: { ...answer().me!, interests: ['food'], firstOffer: true },
            cards: {
                needs: { items: [{ kind: 'deal', count: 1, accent: true, label: 'A deal is waiting for you: Sourdough', target: { to: 'deal', postId: 'p1', txId: 't1' } }] },
                events, market: market(4), joined: { count7d: 2, radiusKm: null, names: [{ callsign: 'Ana', avatarUrl: null }] },
                pulse: { items: [{ id: 'q1', title: 'x', thumbnailUrl: null, platform: 'youtube', callsign: 'y', category: 'food', url: null }] },
                beans: { balance: 12, room: 212, tier: 'Resident', activated: true, frozen: false },
                community: { name: 'Mullumbimby', members: 81, tradesThisMonth: 23 },
            },
        });
        expect(cardsToDraw(a, null, ctx({ interests: ['food'] }))).toEqual(['needs', 'events', 'market', 'joined', 'pulse', 'beans', 'invite', 'community']);
    });

    it('(b) an active trader: needs · deals · events · market · decide · groups · pulse · beans · community (+ invite, by its rule)', () => {
        const a = answer({
            me: { ...answer().me!, interests: ['food'], firstOffer: true },
            cards: {
                needs: { items: [{ kind: 'vote', count: 1, accent: true, label: 'Vote closes in 9 hours: Compost bay', target: { to: 'decide' }, closesAt: iso(NOW + 9 * H) }] },
                deals: { open: 2, waiting: 1, waitingOnMe: { txId: 't1', postId: 'p1', title: 'Sourdough' } },
                events, market: market(2), decide: { open: 1, soonestClosesAt: iso(NOW + 9 * H), polls: 2, pollsMore: false },
                groups: { items: [{ id: 'c1', kind: 'group', name: 'Garden Group', unread: 4, muted: false }], total: 1 },
                pulse: { items: [{ id: 'q1', title: 'x', thumbnailUrl: null, platform: 'youtube', callsign: 'y', category: 'food', url: null }] },
                beans: { balance: -35, room: 165, tier: 'Resident', activated: true, frozen: false },
                community: { name: 'Mullumbimby', members: 81, tradesThisMonth: 23 },
            },
        });
        expect(cardsToDraw(a, null, ctx({ interests: ['food'] }))).toEqual(['needs', 'deals', 'events', 'market', 'decide', 'groups', 'pulse', 'beans', 'invite', 'community']);
        // Where invites are off there is no invite card.
        expect(cardsToDraw({ ...a, features: { ...a.features, invites: false } }, null, ctx({ interests: ['food'] }))).not.toContain('invite');
    });

    it('(b) an enterprise keeper: the enterprise card after deals', () => {
        const a = answer({
            me: { ...answer().me!, interests: ['tools'], firstOffer: true, isKeeper: true },
            features: { beans: true, escrow: true, invites: false },
            cards: {
                deals: { open: 1, waiting: 0, waitingOnMe: null }, enterprise: { id: 'b'.repeat(64), name: 'Tool Library', requests: 3, others: 0 },
                events, market: market(1), community: { name: 'Mullumbimby', members: 81, tradesThisMonth: 23 },
            },
        });
        expect(cardsToDraw(a, null, ctx({ interests: ['tools'] }))).toEqual(['deals', 'enterprise', 'events', 'market', 'community']);
    });

    it('(b) the operator of a brand-new node, alone: steps · market (examples, when the node asks) · community', () => {
        const a = answer({
            features: { beans: true, escrow: true, invites: true, exampleListings: true },
            cards: { steps: steps(), market: { items: [], total14d: 0, more: false, examples: true }, community: { name: 'Newtown', members: 1, tradesThisMonth: 0 } },
        });
        // `interests` too: nothing starred yet (the card is the design's empty state for that, §3.2 day one).
        expect(cardsToDraw(a, null, ctx())).toEqual(['steps', 'interests', 'market', 'community']);
        expect(communityLines(a.cards.community, 'local', true).line).toBe("1 member. You're first. Invite someone.");
        // A local node that doesn't ask for examples: no market card at all when nothing is listed.
        expect(cardsToDraw(answer({ cards: { market: undefined, community: a.cards.community } }), null, ctx({ interests: ['food'] }))).toEqual(['community']);
    });

    it('(a) a new global member by 12 words, a community 12 km away: safety · find · steps · interests · market · events · joined · community', () => {
        const a = answer({
            profile: 'global',
            features: { beans: false, escrow: false, invites: false, exampleListings: true },
            cards: {
                safety: { words: true, signInLinked: false }, find: find(), steps: steps({ area: false, firstPost: false }),
                market: market(2), events, joined: { count7d: 14, radiusKm: 50 }, community: { name: 'Global', members: 2310, communities: 38 },
            },
        });
        expect(cardsToDraw(a, null, ctx({ safetyUp: true, now: NOW }))).toEqual(['safety', 'find', 'steps', 'interests', 'events', 'market', 'joined', 'community']);
        expect(cardsToDraw(a, null, ctx({ safetyUp: false, interests: ['food'], now: NOW }))).toEqual(['find', 'steps', 'events', 'market', 'joined', 'community']);
        expect(joinedLine(a.cards.joined!, 'global')).toBe('14 people within 50 km joined this week.');
        expect(communityLines(a.cards.community, 'global', false)).toEqual({ title: 'The worldwide community', line: '2,310 members · 38 communities listed.' });
    });

    it('a suspended member\'s answer (no community cards) still draws their own and the community card', () => {
        const a = answer({
            me: { ...answer().me!, standing: 'suspended', interests: ['food'] },
            cards: { beans: { balance: 4, room: 0, tier: 'Newcomer', activated: true, frozen: true }, community: { name: 'M', members: 3 } },
        });
        expect(cardsToDraw(a, null, ctx({ interests: ['food'] }))).toEqual(['beans', 'community']);
    });

    it('a card with nothing to say takes no space, and an empty Market card isn\'t drawn without examples', () => {
        const a = answer({ me: { ...answer().me!, interests: ['food'] }, cards: { market: { items: [], total14d: 0, more: false }, community: { name: 'M', members: 9 } } });
        expect(cardsToDraw(a, null, ctx({ interests: ['food'] }))).toEqual(['community']);
    });

    it('First steps shows while any line is undone, and goes once all are done', () => {
        const a = (s: HomeCards['steps']) => answer({ me: { ...answer().me!, interests: ['food'] }, cards: { steps: s, community: { name: 'M', members: 9 } } });
        expect(cardsToDraw(a(steps({ firstOffer: true, photo: true, interests: true, invited: true })), null, ctx({ interests: ['food'] }))).toEqual(['community']);
        expect(cardsToDraw(a(steps({ firstOffer: true, photo: false, interests: true, invited: true })), null, ctx({ interests: ['food'] }))).toEqual(['steps', 'community']);
        // The invite line only after the first Offer, and none where invites are off (null).
        expect(stepLines(steps({ firstOffer: false }), false).map(l => l.id)).toEqual(['offer', 'photo', 'interests']);
        expect(stepLines(steps({ firstOffer: true }), false).map(l => l.id)).toEqual(['offer', 'photo', 'interests', 'invite']);
        expect(stepLines(steps({ firstOffer: true, invited: null }), false).map(l => l.id)).toEqual(['offer', 'photo', 'interests']);
        // Starred on the phone a moment ago counts before the node says so.
        expect(stepLines(steps(), true).find(l => l.id === 'interests')!.done).toBe(true);
    });

    it('the interests card: while nothing is starred, or opened from "Tune"', () => {
        const a = answer({ cards: { community: { name: 'M', members: 9 } } });
        expect(cardsToDraw(a, null, ctx())).toContain('interests');
        expect(cardsToDraw(a, null, ctx({ interests: ['food'] }))).not.toContain('interests');
        expect(cardsToDraw(a, null, ctx({ interests: ['food'], tuneOpen: true }))).toContain('interests');
        // A visitor's answer (no `me`) has no interests card.
        expect(cardsToDraw({ ...a, me: null }, null, ctx())).not.toContain('interests');
    });

    it('Needs you counts the phone\'s own lines too (an unread message the answer doesn\'t carry yet)', () => {
        const a = answer({ me: { ...answer().me!, interests: ['food'] } });
        expect(cardsToDraw(a, null, ctx({ interests: ['food'], needs: 1 }))[0]).toBe('needs');
        expect(cardsToDraw(a, null, ctx({ interests: ['food'], needs: 0 }))).not.toContain('needs');
    });
});

describe('the layout (§4)', () => {
    const full = answer({
        me: { ...answer().me!, interests: ['food'] },
        cards: { events, market: market(2), beans: { balance: 1, room: 1, tier: 'Resident', activated: true, frozen: false }, community: { name: 'M', members: 9 } },
    });

    it('a hidden card is never drawn, nor asked for; `needs` and `community` can\'t be hidden', () => {
        const l = layout({ hidden: ['market', 'beans'] });
        expect(cardsToDraw(full, l, ctx({ interests: ['food'] }))).toEqual(['events', 'community']);
        expect(cardsToAsk(l)).not.toContain('market');
        expect(cardsToAsk(l)).not.toContain('beans');
        expect(hideCard(null, 'needs', NOW)).toBeNull();
        expect(hideCard(null, 'community', NOW)).toBeNull();
        expect(readHomeLayout({ v: 1, hidden: ['needs', 'community', 'pulse'] })!.hidden).toEqual(['pulse']);
    });

    it('cards= is the catalogue\'s order, the same each time: `find` too (a local node answers none), no data-less cards; a move doesn\'t change it', () => {
        expect(cardsToAsk(null)).toEqual(['needs', 'safety', 'find', 'steps', 'deals', 'enterprise', 'events', 'market', 'decide', 'groups', 'joined', 'pulse', 'beans', 'notices', 'community']);
        expect(cardsToAsk(layout({ order: ['beans', 'market'] }))).toEqual(cardsToAsk(null));
    });

    it('cards= never depends on what the last answer said of the node: a community that changed still gets First steps', () => {
        // Measured on the emulator: built from a cached global answer, the list left out `steps`, and the community's
        // First steps never came. The list is the layout's (and a pin's) alone; whether a card is drawn is cardsToDraw's.
        expect(cardsToAsk.length).toBe(1);
        expect(cardsToAsk(null)).toContain('steps');
        // A local answer that names a First steps card with every line done draws none; the global one draws its own lines.
        const done = steps({ firstOffer: true, firstPost: true, photo: true, interests: true, invited: true });
        expect(cardsToDraw(answer({ cards: { steps: done, community: { name: 'L', members: 9 } } }), null, ctx({ interests: ['food'] }))).not.toContain('steps');
        const global = answer({ profile: 'global', cards: { steps: steps(), community: { name: 'G', members: 9 } } });
        expect(cardsToDraw(global, null, ctx({ interests: ['food'] }))).toContain('steps');
    });

    it('hide, show again, and the date moves on each edit', () => {
        const hidden = hideCard(null, 'pulse', NOW)!;
        expect(hidden.hidden).toEqual(['pulse']);
        expect(hidden.updatedAt).toBe(iso(NOW));
        expect(isHidden(hidden, 'pulse')).toBe(true);
        expect(hideCard(hidden, 'pulse', NOW + 1)).toBeNull();
        const back = showCard(hidden, 'pulse', NOW + 1000)!;
        expect(back.hidden).toEqual([]);
        expect(back.updatedAt).toBe(iso(NOW + 1000));
        expect(showCard(back, 'pulse', NOW)).toBeNull();
    });

    it('move up and down past the card next to it on screen, keeping every other card\'s place', () => {
        const onScreen = ['needs', 'events', 'market', 'beans', 'community'] as const;
        const up = moveCard(null, 'beans', 'up', onScreen, NOW)!;
        const order = cardOrder(up);
        expect(order.indexOf('beans')).toBeLessThan(order.indexOf('market'));
        expect(cardsToDraw(full, up, ctx({ interests: ['food'] }))).toEqual(['events', 'beans', 'market', 'community']);
        // Not past `needs` or `community`, and not off the ends.
        expect(moveCard(null, 'events', 'up', onScreen, NOW)).toBeNull();
        expect(moveCard(up, 'market', 'down', ['needs', 'events', 'beans', 'market', 'community'], NOW)).toBeNull();
        expect(moveCard(null, 'needs', 'down', onScreen, NOW)).toBeNull();
        // `needs` stays first and `community` last whatever a layout says.
        expect(cardOrder(layout({ order: ['community', 'beans', 'needs'] }))[0]).toBe('needs');
        expect(cardOrder(layout({ order: ['community', 'beans', 'needs'] })).at(-1)).toBe('community');
    });

    it('reset: the default order, nothing hidden; the safety card\'s dismissal (a schedule, not a choice) is kept', () => {
        const l = layout({ order: ['beans'], hidden: ['pulse'], dismissed: { safety: iso(NOW - H) } });
        const r = resetLayout(l, NOW);
        expect(r).toEqual({ v: 1, order: [], hidden: [], dismissed: { safety: iso(NOW - H) }, updatedAt: iso(NOW) });
        expect(cardOrder(r)).toEqual([...HOME_CARD_IDS]);
    });

    it('the newer copy wins by updatedAt; a phone copy newer than the account\'s is sent', () => {
        const account = layout({ hidden: ['pulse'], updatedAt: iso(NOW - H) });
        const phone = layout({ hidden: ['beans'], updatedAt: iso(NOW) });
        expect(pickLayout(account, phone)).toEqual({ layout: phone, push: true });
        expect(pickLayout(phone, account)).toEqual({ layout: phone, push: false });
        expect(pickLayout(account, null)).toEqual({ layout: account, push: false });
        expect(pickLayout(null, phone)).toEqual({ layout: phone, push: true });
        expect(pickLayout(account, layout({ updatedAt: iso(NOW - H) }))).toEqual({ layout: account, push: false });
        // A copy with no date is the oldest there is.
        expect(pickLayout(layout({ updatedAt: null }), layout({ updatedAt: iso(0) })).push).toBe(true);
    });

    it('unknown ids are dropped, never refused (a node or app older or newer); repeats too; at most 32', () => {
        const l = readHomeLayout({ v: 1, order: ['weather', 'beans', 'beans', 42, 'pulse'], hidden: ['news', 'joined'], dismissed: { safety: iso(NOW), widgets: iso(NOW), needs: iso(NOW), beans: 'not a date' }, updatedAt: iso(NOW) })!;
        expect(l.order).toEqual(['beans', 'pulse']);
        expect(l.hidden).toEqual(['joined']);
        expect(l.dismissed).toEqual({ safety: iso(NOW) });
        expect(readHomeLayout({ v: 2 })).toBeNull();
        expect(readHomeLayout('nope')).toBeNull();
        expect(readHomeLayout({ updatedAt: 'yesterday' })!.updatedAt).toBeNull();
        const many = readHomeLayout({ order: Array.from({ length: 40 }, () => 'beans') })!;
        expect(many.order).toEqual(['beans']);
    });

    it('an answer is read tolerantly: unknown cards stay unknown, a non-answer is null', () => {
        expect(readHomeAnswer(null)).toBeNull();
        expect(readHomeAnswer({ profile: 'local' })).toBeNull();
        const a = readHomeAnswer({ profile: 'local', cards: { widget: { x: 1 }, community: { name: 'M', members: 2 } }, me: { interests: ['food', 3] }, layout: { hidden: ['nope'] } })!;
        expect(a.me!.interests).toEqual(['food']);
        expect(a.layout!.hidden).toEqual([]);
        expect(cardsToDraw(a, a.layout, ctx({ interests: ['food'] }))).toEqual(['community']);
    });
});

describe('interests reorder, they never filter (§4.3)', () => {
    const items = market(4, ['goods', 'food', 'tools', 'food'])!.items;

    it('starred categories first, the rest after, each part in its order', () => {
        expect(starredFirst(items, i => i.category, ['food']).map(i => i.id)).toEqual(['p1', 'p3', 'p0', 'p2']);
        expect(starredFirst(items, i => i.category, ['food', 'tools']).map(i => i.id)).toEqual(['p1', 'p2', 'p3', 'p0']);
    });

    it('a member who starred Food on a node with no food still sees the newest four', () => {
        const none = market(4, ['goods', 'goods', 'tools', 'arts'])!.items;
        expect(starredFirst(none, i => i.category, ['food'])).toHaveLength(4);
        expect(starredFirst(none, i => i.category, ['food']).map(i => i.id)).toEqual(['p0', 'p1', 'p2', 'p3']);
    });

    it('an old category word counts as its id', () => {
        const old = [{ id: 'x', category: 'Food & Produce' }, { id: 'y', category: 'goods' }];
        const n = normalizeCategory('Food & Produce');
        expect(starredFirst(old, i => i.category, [n], normalizeCategory).map(i => i.id)[0]).toBe('x');
    });

    it('the account\'s stars, else the phone\'s (the Market\'s For You stars from before Home)', () => {
        expect(effectiveInterests(['food'], ['tools'])).toEqual(['food']);
        expect(effectiveInterests([], ['tools'])).toEqual(['tools']);
        expect(effectiveInterests(null, null)).toEqual([]);
    });
});

describe('Needs you: the phone\'s own lines and the node\'s, as the header shows them', () => {
    const node = [
        { kind: 'admin' as const, count: 2, accent: true, label: '2 reports to review', target: { to: 'admin' as const, section: 'moderation' as never } },
        { kind: 'deal' as const, count: 1, accent: true, label: 'A deal is waiting for you: Sourdough', target: { to: 'deal' as const, postId: 'p1', txId: 't1' } },
        { kind: 'vote' as const, count: 1, accent: true, label: 'Vote closes in 7 hours: Compost bay', target: { to: 'decide' as const }, closesAt: iso(NOW + 7 * H) },
        { kind: 'message' as const, count: 1, accent: false, label: 'Unread message from Kim', target: { to: 'chat' as const, conversationId: 'c9' } },
        { kind: 'group' as const, count: 1, accent: false, label: '4 new lines in Garden Group', target: { to: 'chat' as const, conversationId: 'g1', thread: 'group' as const } },
    ];

    it('the phone\'s deals and unread messages replace the node\'s (fresher, no request); highest first', () => {
        const local = localNeeds(ME, NOW,
            [{ id: 't1', postId: 'p1', status: 'requested', buyerPublicKey: 'b', sellerPublicKey: ME }],
            [{ id: 'c1', type: 'dm', unread: 2, peer: 'Ana' }, { id: 'c2', type: 'dm', unread: 1, peer: 'Kofi' }]);
        const merged = mergeNeeds(node, local, NOW);
        expect(merged.map(e => e.kind)).toEqual(['admin', 'deal', 'vote', 'message', 'group']);
        expect(merged.find(e => e.kind === 'message')!.label).toBe('Unread messages from 2 people');
        // The one deal the node names too: its words carry the listing's title.
        expect(merged.find(e => e.kind === 'deal')!.label).toBe('A deal is waiting for you: Sourdough');
        // Nothing of the node's `closesAt` leaks into the entries.
        expect(merged.every(e => !('closesAt' in e))).toBe(true);
    });

    it('a kind the phone couldn\'t read (null) is the node\'s line', () => {
        const merged = mergeNeeds(node, localNeeds(ME, NOW, null, null), NOW);
        expect(merged.find(e => e.kind === 'message')!.label).toBe('Unread message from Kim');
        expect(merged.find(e => e.kind === 'deal')!.label).toBe('A deal is waiting for you: Sourdough');
    });

    it('the phone\'s trades not synced yet: the node\'s deal line still shows (measured on the emulator); unread is the phone\'s', () => {
        const merged = mergeNeeds(node, localNeeds(ME, NOW, [], []), NOW);
        expect(merged.map(e => e.kind)).toEqual(['admin', 'deal', 'vote', 'group']);
        expect(merged.find(e => e.kind === 'deal')!.label).toBe('A deal is waiting for you: Sourdough');
        // Read on this phone a moment ago: the node's older unread line is not shown.
        expect(merged.some(e => e.kind === 'message')).toBe(false);
    });

    it('a vote\'s closing in the member\'s own time ("tonight"), from the node\'s hours', () => {
        const morning = new Date(2026, 9, 2, 6, 0, 0).getTime();
        const evening = new Date(2026, 9, 2, 20, 0, 0).toISOString();
        expect(voteLabelHere({ ...node[2], label: 'Vote closes in 14 hours: Compost bay', closesAt: evening }, morning)).toBe('Vote closes tonight: Compost bay');
        expect(voteLabelHere({ ...node[2], label: 'Vote closes in 6 hours: Compost bay', closesAt: evening }, NOW)).toBe('Vote closes in 6 hours: Compost bay');
        expect(voteLabelHere({ ...node[2], label: '3 votes to cast, the first closes in 30 hours', closesAt: new Date(2026, 9, 3, 20, 0, 0).toISOString() }, NOW))
            .toBe('3 votes to cast, the first closes tomorrow');
        expect(voteLabelHere({ ...node[2], label: 'Vote closes in 5 days: X', closesAt: undefined }, NOW)).toBe('Vote closes in 5 days: X');
    });
});

describe('each card\'s words', () => {
    it('Your Beans: own balance only; a new member\'s credit opens with a first trade; tiers are a word, nothing unlocked', () => {
        expect(beansLines({ balance: 0, room: 0, tier: 'Newcomer', activated: false, frozen: false }))
            .toEqual({ main: '0 Beans · nothing to repay', sub: 'Your credit opens with a first trade.' });
        expect(beansLines({ balance: -35, room: 165, tier: 'Resident', activated: true, frozen: false }))
            .toEqual({ main: '−35 Beans · room to spend 165', sub: 'Resident' });
        expect(beansLines({ balance: -210, room: 0, tier: 'Resident', activated: true, frozen: true }).sub).toBe('Spending is paused for now. You can still receive and sell.');
        for (const b of [beansLines({ balance: 3, room: 3, tier: 'Elder', activated: true, frozen: false })]) {
            expect(`${b.main} ${b.sub}`).not.toMatch(/unlock|Ʀ|locked/i);
        }
        expect(formatBeans(12.5)).toBe('12.5');
        expect(formatBeans(1234)).toBe('1,234');
        expect(formatBeans(-0.25)).toBe('−0.25');
    });

    it('the community\'s card: its name and totals; the worldwide community\'s', () => {
        expect(communityLines({ name: 'Mullumbimby', members: 81, tradesThisMonth: 23 }, 'local', true)).toEqual({ title: 'Mullumbimby', line: '81 members · 23 trades this month.' });
        expect(communityLines({ name: null, members: 2, tradesThisMonth: 1 }, 'local', true)).toEqual({ title: 'Your community', line: '2 members · 1 trade this month.' });
    });

    it('who joined: names on a local community, a count by area on the global one', () => {
        expect(joinedLine({ count7d: 5, radiusKm: null, names: [{ callsign: 'Ana', avatarUrl: null }, { callsign: 'Kofi', avatarUrl: null }] })).toBe('Ana, Kofi and 3 more joined this week.');
        expect(joinedLine({ count7d: 2, radiusKm: null, names: [{ callsign: 'Ana', avatarUrl: null }, { callsign: 'Kofi', avatarUrl: null }] })).toBe('Ana and Kofi joined this week.');
        expect(joinedLine({ count7d: 1, radiusKm: null, names: [{ callsign: 'Ana', avatarUrl: null }] })).toBe('Ana joined this week.');
        expect(joinedLine({ count7d: 1, radiusKm: 50 })).toBe('1 person within 50 km joined this week.');
    });

    it('a screen reader\'s label ends member text with one stop (measured on the emulator: "kept it up.. Opens it.")', () => {
        expect(sentence('A moderator kept it up.')).toBe('A moderator kept it up.');
        expect(sentence('Mend clothes')).toBe('Mend clothes.');
        expect(sentence('Who has a drill?  ')).toBe('Who has a drill?');
        expect(needsLineA11y({ kind: 'deal', count: 1, accent: true, label: 'A deal is waiting for you: Bread.', target: { to: 'my-deals' } }))
            .toBe('A deal is waiting for you: Bread. Waiting on you.');
    });

    it('deals, enterprise, decide, groups, an event\'s day', () => {
        expect(dealsLine({ open: 2, waiting: 1, waitingOnMe: { txId: 't', postId: 'p', title: 'Mend clothes' } })).toBe('2 open · waiting on you: Mend clothes');
        expect(dealsLine({ open: 2, waiting: 0, waitingOnMe: null })).toBe('2 open');
        expect(enterpriseLine({ id: 'x', name: 'T', requests: 3, others: 1 })).toBe('3 requests to approve · and 1 more you keep');
        expect(enterpriseLine({ id: 'x', name: 'T', requests: 0, others: 0 })).toBe('No requests waiting');
        const local = { beans: true, decisions: true };
        const texts = (card: Parameters<typeof decideLines>[0]) => decideLines(card, local, NOW).map(l => l.text);
        expect(texts({ open: 1, soonestClosesAt: new Date(2026, 9, 3, 20, 0, 0).toISOString(), polls: 2, pollsMore: false })).toEqual(['1 Decision open, closes tomorrow', '2 polls open']);
        expect(texts({ open: 3, soonestClosesAt: new Date(2026, 9, 2, 21, 0, 0).toISOString(), polls: 0, pollsMore: false })).toEqual(['3 Decisions open, the first closes in 7 hours']);
        expect(texts({ open: 0, soonestClosesAt: null, polls: 50, pollsMore: true })).toEqual(['50+ polls open']);
        expect(groupLine({ id: 'g', kind: 'group', name: 'Garden Group', unread: 4, muted: false })).toBe('Garden Group · 4 new');
        expect(groupLine({ id: 'g', kind: 'group', name: 'Tool Library', unread: 0, muted: false })).toBe('Tool Library · quiet');
        expect(groupLine({ id: 'g', kind: 'group', name: 'Noisy', unread: 9, muted: true })).toBe('Noisy · muted');
        expect(eventDay(new Date(2026, 9, 3, 9, 0, 0).toISOString())).toBe('Sat 3 Oct');
    });
});

describe('the safety card\'s schedule (two-doors §2.5) with the account\'s dismissal (§3.1)', () => {
    const joined = NOW - 2 * 24 * H;
    const record: OneWayBack = { url: 'https://global.beanpool.org', joinedAt: joined };

    it('up until put away; back once after the first post and once after a week; then Settings only', () => {
        expect(oneWayBackPlace(record, NOW, false)).toBe('card');
        const away = dismissedOneWayBack(record, NOW, false);
        expect(oneWayBackPlace(away, NOW + H, false)).toBe('settings');
        expect(oneWayBackPlace(away, NOW + H, true)).toBe('card');
        const afterPost = dismissedOneWayBack(away, NOW + 2 * H, true);
        expect(oneWayBackPlace(afterPost, NOW + 3 * H, true)).toBe('settings');
        expect(oneWayBackPlace(afterPost, joined + ONE_WAY_BACK_WEEK_MS, true)).toBe('card');
        const afterWeek = dismissedOneWayBack(afterPost, joined + ONE_WAY_BACK_WEEK_MS, true);
        expect(oneWayBackPlace(afterWeek, joined + 30 * ONE_WAY_BACK_WEEK_MS, true)).toBe('settings');
    });

    it('a dismissal on the account (another phone, the web app) puts it away here too, its waiting returns used', () => {
        const fromAccount = withAccountDismissal(record, iso(NOW), true)!;
        expect(fromAccount.dismissedAt).toBe(NOW);
        expect(fromAccount.postReturnUsed).toBe(true);
        expect(oneWayBackPlace(fromAccount, NOW + H, true)).toBe('settings');
        // The week's return is still to come (it wasn't due when it was put away).
        expect(oneWayBackPlace(fromAccount, joined + ONE_WAY_BACK_WEEK_MS, true)).toBe('card');
    });

    it('the phone\'s own dismissal at the same moment or later wins; a done record is left alone; no date, nothing', () => {
        const mine = dismissedOneWayBack(record, NOW, false);
        expect(withAccountDismissal(mine, iso(NOW), true)).toBe(mine);
        expect(withAccountDismissal(mine, iso(NOW - H), true)).toBe(mine);
        const done: OneWayBack = { ...record, done: 'checked' };
        expect(withAccountDismissal(done, iso(NOW), true)).toBe(done);
        expect(withAccountDismissal(record, null, true)).toBe(record);
        expect(withAccountDismissal(record, 'not a date', true)).toBe(record);
    });

    it('Home keeps the dismissal on the account at the card\'s own moment', () => {
        const l = dismissSafety(layout({ hidden: ['pulse'] }), NOW);
        expect(l.dismissed.safety).toBe(iso(NOW));
        expect(l.updatedAt).toBe(iso(NOW));
        expect(l.hidden).toEqual(['pulse']);
    });

    it('the community\'s word from Home\'s answer: only when it asked for the card and answered as the account\'s own', () => {
        const words = answer({ cards: { safety: { words: true, signInLinked: false }, community: { name: 'G', members: 9 } } });
        expect(safetyWord(words, ['safety', 'community'])).toEqual({ words: true, joinedAt: NOW - 2 * 24 * H });
        expect(safetyWord(answer(), ['safety', 'community'])).toEqual({ words: false, joinedAt: NOW - 2 * 24 * H });
        expect(safetyWord(words, ['community'])).toBeNull();
        expect(safetyWord({ ...words, me: null }, ['safety'])).toBeNull();
    });
});

describe('deep links and doorbells', () => {
    it('the map\'s `/` deals link goes on to the Market', () => {
        expect(marketForward({ tab: 'deals', dealsTab: 'active' })).toEqual({ tab: 'deals', dealsTab: 'active' });
        expect(marketForward({ tab: 'deals' })).toEqual({ tab: 'deals' });
        expect(marketForward({ dealsTab: 'pending' })).toEqual({ tab: 'deals', dealsTab: 'pending' });
        expect(marketForward({ tab: '' })).toBeNull();
        expect(marketForward({})).toBeNull();
    });

    it('a burst of doorbells Home cares about is one read, 3 s after the last; others are ignored', () => {
        vi.useFakeTimers();
        try {
            const run = vi.fn();
            const bell = createDoorbellDebounce(run);
            bell.ring({ type: 'new_post' });
            vi.advanceTimersByTime(2000);
            bell.ring({ type: 'transaction_completed' });
            bell.ring({ type: 'new_message' });
            bell.ring({ type: 'pong' });
            bell.ring('junk');
            vi.advanceTimersByTime(HOME_DOORBELL_SETTLE_MS - 1);
            expect(run).not.toHaveBeenCalled();
            vi.advanceTimersByTime(1);
            expect(run).toHaveBeenCalledTimes(1);
            bell.ring({ type: 'new_message' });
            vi.advanceTimersByTime(10_000);
            expect(run).toHaveBeenCalledTimes(1);
            for (const type of ['decision_vote_cast', 'group_updated', 'profile_updated', 'system_announcement']) {
                bell.ring({ type });
                vi.advanceTimersByTime(HOME_DOORBELL_SETTLE_MS);
            }
            expect(run).toHaveBeenCalledTimes(5);
            bell.ring({ type: 'new_post' });
            bell.cancel();
            vi.advanceTimersByTime(HOME_DOORBELL_SETTLE_MS);
            expect(run).toHaveBeenCalledTimes(5);
        } finally {
            vi.useRealTimers();
        }
    });
});

describe('what a node can show, and where the Decide card leads (PR #1483 review 4165383429, 4165384151)', () => {
    const LOCAL = { profile: 'local', features: { beans: true, escrow: true, enterprises: true, invites: true, decisions: true } };
    const GLOBAL = { profile: 'global', features: { beans: false, escrow: false, enterprises: false, invites: false, decisions: false } };

    it('the money cards and the invite card only where the node has them; Find your community only on the global node, First steps on both', () => {
        const on = (n: typeof LOCAL) => HOME_CARD_IDS.filter(id => cardOnNode(id, n));
        expect(on(LOCAL)).toEqual(HOME_CARD_IDS.filter(id => id !== 'find'));
        expect(on(GLOBAL)).toEqual(['needs', 'safety', 'find', 'steps', 'tips', 'interests', 'events', 'market', 'decide', 'groups', 'joined', 'pulse', 'notices', 'community']);
        // A node that says nothing has everything, as every node before the switches.
        expect(on({ profile: 'local', features: { invites: true } } as typeof LOCAL)).toEqual(on(LOCAL));
    });

    it('Home never draws a card its node can\'t show, whatever the answer holds', () => {
        const a = answer({
            profile: 'global', features: GLOBAL.features,
            cards: {
                beans: { balance: 5, room: 0, tier: 'Newcomer', activated: true, frozen: false },
                deals: { open: 1, waiting: 1, waitingOnMe: null },
                enterprise: { id: 'x', name: 'T', requests: 1, others: 0 },
                decide: { open: 2, soonestClosesAt: null, polls: 0, pollsMore: false },
                community: { name: 'BeanPool', members: 2, communities: 1 },
            },
        });
        expect(cardsToDraw(a, null, ctx({ interests: ['food'] }))).toEqual(['community']);
    });

    it('Decisions open Commons → Decide; polls open the Market\'s Polls; each line says where it goes', () => {
        const card = { open: 1, soonestClosesAt: null, polls: 2, pollsMore: false };
        expect(decideLines(card, LOCAL.features, NOW)).toEqual([
            { id: 'decisions', text: '1 Decision open', a11y: '1 Decision open. Opens Decide, in Commons.', href: DECIDE_HREF },
            { id: 'polls', text: '2 polls open', a11y: '2 polls open. Opens the polls, in the Market.', href: POLLS_HREF },
        ]);
        expect(DECIDE_HREF).toEqual({ pathname: '/(tabs)/projects', params: { section: 'decide' } });
        expect(POLLS_HREF).toEqual({ pathname: '/(tabs)/market', params: { filter: 'polls' } });
        // The global node: no Decisions and no Commons tab, so never a line there.
        expect(decideLines(card, GLOBAL.features, NOW).map(l => l.id)).toEqual(['polls']);
        // A node with Beans but no Decisions: the same.
        expect(decideLines(card, { ...LOCAL.features, decisions: false }, NOW).map(l => l.id)).toEqual(['polls']);
    });

    it('a member tailors their Home; a visitor\'s answer (no `me`) tailors nothing', () => {
        expect(canTailor(answer())).toBe(true);
        expect(canTailor(answer({ me: null, welcome: true }))).toBe(false);
        expect(canTailor(null)).toBe(false);
    });
});

describe('where only a community\'s admins invite, Home asks only them to (PR #1483 review 4166559683)', () => {
    /** A local community whose door is "Known" (`features.door === 'admins'`, apps/server config/door.ts): every other First step done. */
    const known = (over: Partial<HomeAnswer> = {}) => answer({
        features: { beans: true, escrow: true, invites: true, exampleListings: false, decisions: true, door: 'admins' },
        me: { ...answer().me!, interests: ['food'], firstOffer: true },
        cards: {
            steps: steps({ firstOffer: true, photo: true, interests: true, invited: false }),
            community: { name: 'Mullumbimby', members: 81, tradesThisMonth: 23 },
        },
        ...over,
    });

    it('a plain member (no role, a moderator, or a role not heard yet): no Grow your community, and First steps completes without an invite', () => {
        for (const role of [null, 'moderator', undefined] as const) {
            expect(cardsToDraw(known(), null, ctx({ interests: ['food'], role })), String(role)).toEqual(['community']);
            expect(cardOnNode('invite', known(), role), String(role)).toBe(false);
        }
        // The node sends `invited: false` there whatever the door (routes/home-answer.ts): the phone leaves the line out.
        expect(stepLines(known().cards.steps!, true, false).map(l => l.id)).toEqual(['offer', 'photo', 'interests']);
        // With a photo still to add, First steps stays for that, and still has no invite line to press.
        const photoLeft = known({ cards: { ...known().cards, steps: steps({ firstOffer: true, photo: false, interests: true, invited: false }) } });
        expect(cardsToDraw(photoLeft, null, ctx({ interests: ['food'], role: null }))).toEqual(['steps', 'community']);
    });

    it('an owner or admin there: the card and the step, as before', () => {
        for (const role of ['owner', 'admin'] as const) {
            expect(cardsToDraw(known(), null, ctx({ interests: ['food'], role }))).toEqual(['steps', 'invite', 'community']);
            expect(cardOnNode('invite', known(), role)).toBe(true);
        }
        expect(stepLines(known().cards.steps!, true, true).map(l => l.id)).toEqual(['offer', 'photo', 'interests', 'invite']);
    });

    it('Home\'s rule is People → Invites\' own for every role the node has said, on every door (invite-entries.ts mayInviteHere)', () => {
        for (const invites of [true, false]) {
            for (const door of [undefined, 'members', 'admins']) {
                for (const role of ['owner', 'admin', 'moderator', null] as const) {
                    expect(invitesForReader({ invites, door }, role), `${invites} ${door} ${role}`).toBe(mayInviteHere({ invites, door } as never, role));
                }
            }
        }
        // Not heard yet: People lets the node decide at the press; Home asks nothing of them where only admins invite.
        expect(mayInviteHere({ invites: true, door: 'admins' } as never, undefined)).toBe(true);
        expect(invitesForReader({ invites: true, door: 'admins' }, undefined)).toBe(false);
    });

    it('any other door, or a node too old to say: every member invites, the role never needed', () => {
        for (const door of [undefined, 'members', 'open']) {
            const a = known({ features: { ...known().features, door } });
            expect(cardsToDraw(a, null, ctx({ interests: ['food'] }))).toEqual(['steps', 'invite', 'community']);
        }
        // Invites off (the node then sends `invited: null`): neither, whatever the role.
        const off = known({ features: { ...known().features, invites: false }, cards: { ...known().cards, steps: steps({ firstOffer: true, photo: true, interests: true, invited: null }) } });
        expect(cardsToDraw(off, null, ctx({ interests: ['food'], role: 'owner' }))).toEqual(['community']);
    });
});

// ── The global flavour (slice H4: §3.1, §7, §13 Q4 and Q5) ─────────────────────────────────────────────────────────────

describe('the global node\'s Home (H4)', () => {
    const GLOBAL_FEATURES = { beans: false, escrow: false, enterprises: false, invites: false, exampleListings: true, decisions: false, wordsDoor: true };
    const DAY = 24 * H;
    /** A global member `days` days after joining (null: a join date the node didn't send). */
    const member = (days: number | null, over: Partial<HomeAnswer> & { cards?: HomeCards } = {}) => answer({
        profile: 'global', features: GLOBAL_FEATURES,
        me: { ...answer().me!, interests: ['food'], joinedAt: days === null ? null : iso(NOW - days * DAY) },
        cards: { find: find(), market: market(2), events, community: { name: 'BeanPool', members: 2310, communities: 38 } },
        ...over,
    });
    const hidesFind = layout({ hidden: ['find'], order: ['market', 'events', 'find'] });

    it('Find your community is first, and can\'t be hidden or moved, for the first 30 days', () => {
        const a = member(3);
        expect(findPinned(a, NOW)).toBe(true);
        const pins = pinnedCards(a, NOW);
        expect(pins).toEqual(['find']);
        // First, whatever the layout says: hidden and moved down on another copy, it is still drawn at the top.
        expect(cardsToDraw(a, hidesFind, ctx({ interests: ['food'], now: NOW }))).toEqual(['find', 'market', 'events', 'community']);
        expect(cardsToDraw(a, null, ctx({ interests: ['food'], now: NOW }))[0]).toBe('find');
        expect(canHideCard('find', pins)).toBe(false);
        expect(canMoveCard('find', pins)).toBe(false);
        expect(hideCard(null, 'find', NOW, pins)).toBeNull();
        expect(isHidden(hidesFind, 'find', pins)).toBe(false);
        expect(moveCard(null, 'find', 'down', ['find', 'events', 'market'], NOW, pins)).toBeNull();
        // Nothing moves up past it: the card under it has no movable card above it on screen.
        expect(moveCard(null, 'events', 'up', ['needs', 'find', 'events', 'market', 'community'], NOW, pins)).toBeNull();
        // Asked for even where the layout hides it, so the node builds it.
        expect(cardsToAsk(hidesFind, pins)).toContain('find');
        // The last moment of day 30 is still pinned; a join date the node didn't send counts as pinned (the node's rule).
        expect(findPinned(member(FIND_PINNED_DAYS - 0.001), NOW)).toBe(true);
        expect(findPinned(member(null), NOW)).toBe(true);
    });

    it('after 30 days it is a card like any other: hidden from its "…" or Edit home, moved, and not asked for once hidden', () => {
        const a = member(FIND_PINNED_DAYS + 1);
        expect(findPinned(a, NOW)).toBe(false);
        const pins = pinnedCards(a, NOW);
        expect(pins).toEqual([]);
        expect(canHideCard('find', pins)).toBe(true);
        const hidden = hideCard(null, 'find', NOW, pins)!;
        expect(hidden.hidden).toEqual(['find']);
        expect(cardsToDraw(a, hidden, ctx({ interests: ['food'], now: NOW }))).toEqual(['events', 'market', 'community']);
        expect(cardsToAsk(hidden, pins)).not.toContain('find');
        expect(cardsToDraw(a, null, ctx({ interests: ['food'], now: NOW }))).toEqual(['find', 'events', 'market', 'community']);
        // It moves now.
        const down = moveCard(null, 'find', 'down', ['needs', 'find', 'events', 'market', 'community'], NOW, pins)!;
        expect(cardsToDraw(a, down, ctx({ interests: ['food'], now: NOW }))).toEqual(['events', 'find', 'market', 'community']);
    });

    it('pinned: under Needs you, and under "Your way back in" while that one leads; a move made during the pin keeps it near the top after', () => {
        const pins: ['find'] = ['find'];
        expect(cardOrder(null, pins).slice(0, 4)).toEqual(['needs', 'safety', 'find', 'steps']);
        expect(cardOrder(layout({ order: ['market', 'events'] }), pins).slice(0, 4)).toEqual(['needs', 'find', 'market', 'events']);
        expect(cardOrder(layout({ order: ['safety', 'market', 'find'] }), pins).slice(0, 4)).toEqual(['needs', 'safety', 'find', 'market']);
        expect(cardOrder(null, pins).at(-1)).toBe('community');
        // Events moved above market during the pin: the whole order is written with find where it stands.
        const moved = moveCard(null, 'market', 'up', ['find', 'events', 'market'], NOW, pins)!;
        expect(moved.order.slice(0, 3)).toEqual(['safety', 'find', 'steps']);
        expect(cardOrder(moved).slice(0, 4)).toEqual(['needs', 'safety', 'find', 'steps']);
    });

    it('no answer yet: a hidden `find` is asked for until an answer says whether it is pinned; a local node never pins', () => {
        expect(askPinned(null, NOW)).toEqual(['find']);
        expect(cardsToAsk(hidesFind, askPinned(null, NOW))).toContain('find');
        expect(askPinned(member(40), NOW)).toEqual([]);
        expect(askPinned(answer({ me: { ...answer().me!, joinedAt: iso(NOW) } }), NOW)).toEqual([]);
        expect(findPinned(answer(), NOW)).toBe(false);
    });

    it('a local community never draws Find your community, whatever an answer holds', () => {
        const local = answer({ me: { ...answer().me!, interests: ['food'] }, cards: { find: find(), community: { name: 'M', members: 9 } } });
        expect(cardsToDraw(local, null, ctx({ interests: ['food'], now: NOW }))).toEqual(['community']);
        // A body that isn't one is no card.
        expect(isFindCard({ communities: 'nope' })).toBe(false);
        expect(cardsToDraw(member(3, { cards: { find: { anything: true } as never, community: { name: 'G', members: 9 } } }), null, ctx({ interests: ['food'], now: NOW }))).toEqual(['community']);
    });

    it('First steps\' global words: a first post free or for swap; asking a community near while no knock is remembered', () => {
        expect(globalStepLines(steps(), find(), false)).toEqual([
            { id: 'post', text: 'Post something free or for swap', done: false },
            { id: 'ask', text: 'Ask a community to let you in', done: false, suggestion: true },
        ]);
        // A knock sent from this phone: the ask goes (the find card says the answer).
        expect(globalStepLines(steps(), find(), true).map(l => l.id)).toEqual(['post']);
        // No community near, or none with an address to knock on: no ask.
        expect(globalStepLines(steps(), find({ communities: [] }), false).map(l => l.id)).toEqual(['post']);
        expect(globalStepLines(steps(), find({ communities: [{ key: 'x', name: 'X', url: null }] }), false).map(l => l.id)).toEqual(['post']);
        expect(globalStepLines(steps(), find({ communities: [{ key: 'x', name: 'X', url: 'http://plain.example.org' }] }), false).map(l => l.id)).toEqual(['post']);
        expect(globalStepLines(steps(), undefined, false).map(l => l.id)).toEqual(['post']);
        expect(globalStepLines(steps({ firstPost: true }), find(), false)[0].done).toBe(true);
        // Never a local line on the global node: no Offer, photo, interests or invite.
        const g = firstSteps(member(3, { cards: { steps: steps(), find: find(), community: { name: 'G', members: 9 } } }), { interests: [], knocked: false });
        expect(g.lines.map(l => l.text)).toEqual(['Post something free or for swap', 'Ask a community to let you in']);
    });

    it('the new-account limits in one sentence, from the node\'s own numbers: 3 days / 3 posts / 10 chats, or 7 days / 2 / 3 by 12 words', () => {
        const ordinary = { onProbation: true, rules: 'ordinary' as const, limits: { posts: { limit: 3 }, photos: { limit: 5 }, new_dm_recipients: { limit: 10 } }, endsWhen: { hours: 72, keptPosts: 3 } };
        const words = { onProbation: true, rules: 'words' as const, limits: { posts: { limit: 2 }, photos: { limit: 4 }, new_dm_recipients: { limit: 3 } }, endsWhen: { hours: 168, keptPosts: 3 } };
        expect(probationSentence(ordinary)).toBe('For your first 3 days: 3 posts and 10 new chats a day.');
        expect(probationSentence(words)).toBe('For your first 7 days: 2 posts and 3 new chats a day.');
        expect(probationSentence({ ...ordinary, endsWhen: { hours: 36, keptPosts: 3 }, limits: { ...ordinary.limits, posts: { limit: 1 }, new_dm_recipients: { limit: 1 } } }))
            .toBe('For your first 36 hours: 1 post and 1 new chat a day.');
        expect(probationSentence(null)).toBeNull();
        expect(probationSentence({ ...ordinary, onProbation: false })).toBeNull();
        expect(probationSentence({ onProbation: true } as never)).toBeNull();
        expect(probationSentence({ ...ordinary, endsWhen: { hours: 'x' } } as never)).toBeNull();
        // On the card: under the lines, and the card stays while the limits apply even with the post made.
        const posted = member(1, { me: { ...member(1).me!, probation: words }, cards: { steps: steps({ firstPost: true }), find: find(), community: { name: 'G', members: 9 } } });
        expect(firstSteps(posted, { interests: ['food'], knocked: true })).toEqual({ lines: [{ id: 'post', text: 'Post something free or for swap', done: true }], note: 'For your first 7 days: 2 posts and 3 new chats a day.', show: true });
        expect(cardsToDraw(posted, null, ctx({ interests: ['food'], knocked: true, now: NOW }))).toContain('steps');
        // The post made, the limits over: nothing to say, though a community is near (the ask never holds the card open).
        const done = member(20, { cards: { steps: steps({ firstPost: true }), find: find(), community: { name: 'G', members: 9 } } });
        expect(firstSteps(done, { interests: ['food'], knocked: false }).show).toBe(false);
        expect(cardsToDraw(done, null, ctx({ interests: ['food'], now: NOW }))).not.toContain('steps');
        // A local community's First steps never says the limits (unchanged from H2).
        expect(firstSteps(answer({ me: { ...answer().me!, probation: words }, cards: { steps: steps() } }), { interests: [] }).note).toBeNull();
    });

    it('Who joined on the global node: a count by area, never a name or a face, whatever an answer holds', () => {
        const withNames = { count7d: 14, radiusKm: 50, names: [{ callsign: 'Ana', avatarUrl: '/api/avatars/a' }, { callsign: 'Kofi', avatarUrl: null }] };
        expect(joinedNames(withNames, 'global')).toEqual([]);
        expect(joinedLine(withNames, 'global')).toBe('14 people within 50 km joined this week.');
        expect(joinedLine({ count7d: 3, radiusKm: null }, 'global')).toBe('3 people joined this week.');
        // A local community keeps its names and faces (H2).
        expect(joinedNames(withNames, 'local')).toEqual(withNames.names);
        expect(joinedLine(withNames, 'local')).toBe('Ana, Kofi and 12 more joined this week.');
        expect(joinedLine(withNames)).toBe('Ana, Kofi and 12 more joined this week.');
    });

    it('"Near you": the nearest first, those with no distance after; starred categories first, each part nearest first', () => {
        const items = [
            { id: 'far', category: 'goods', distanceKm: 18 },
            { id: 'none', category: 'food', distanceKm: null },
            { id: 'near', category: 'tools', distanceKm: 0.4 },
            { id: 'mid', category: 'food', distanceKm: 5 },
            { id: 'mid2', category: 'goods', distanceKm: 5 },
        ];
        expect(marketInOrder(items, [], 'global').map(i => i.id)).toEqual(['near', 'mid', 'mid2', 'far', 'none']);
        expect(marketInOrder(items, ['food'], 'global').map(i => i.id)).toEqual(['mid', 'none', 'near', 'mid2', 'far']);
        // Never fewer: interests reorder, they never filter.
        expect(marketInOrder(items, ['arts'], 'global')).toHaveLength(5);
        // A local community: what's new, as the node sent it, starred first (H2), never by distance.
        expect(marketInOrder(items, [], 'local').map(i => i.id)).toEqual(['far', 'none', 'near', 'mid', 'mid2']);
        expect(marketInOrder(items, ['food'], 'local').map(i => i.id)).toEqual(starredFirst(items, i => i.category, ['food']).map(i => i.id));
    });
});
