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
    HOME_DRAWN, HOME_DOORBELL_SETTLE_MS, beansLines, canRemoveCard, cardCaption, cardLabelName, cardName, cardRowName, cardOrder, cardsToAsk, cardsToDraw, communityLines,
    DECIDE_HREF, POLLS_HREF, canTailor, cardOnNode, createDoorbellDebounce, decideLines, decideOnNode, dealsLine, dismissSafety, effectiveInterests, enterpriseLine, eventDay, formatBeans, groupLine,
    invitesForReader, welcomeFacts, FIND_PINNED_DAYS, askPinned, canMoveCard, findPinned, firstSteps, globalStepLines, isFindCard, joinedNames, marketInOrder,
    pinnedCards, probationSentence,
    joinedLine, localNeeds, marketForward, mergeNeeds, moveCard, pickLayout, readHomeAnswer, readHomeLayout,
    askedFacts, addCard, listOf, needsLineA11y, pickerGroups, removeCard, resetLayout, safetyWord, sentence, starredFirst, stepLines, voteLabelHere,
    MARK_SENT_MAX, layoutPrint, ownMarkedSave, readMarkSent, rememberMarkSent, sameList, searchCardFor, skyOf,
    homeCrowdFor, isHomeDoorbellFor,
    type HomeAnswer, type HomeCards, type HomeLayout,
} from '../home-cards';
import { crowdBellDelayMs } from '@beanpool/core';
import { arrangeCards, cardLine } from '../home-cards';
import { dismissedOneWayBack, oneWayBackPlace, withAccountDismissal, ONE_WAY_BACK_WEEK_MS, type OneWayBack } from '../one-way-back';
import { NEAR_COMMUNITY_KM, HOME_DEFAULT_LIST, HOME_STARTER_SET, TIPS_ALL_SEEN, HOME_V1_CARD_IDS, defaultCards, defaultHomeLayout, homeCardType, normalizeCategory, skyToday, starterCards, translateV1 } from '@beanpool/core';
import { mayInviteHere } from '../invite-entries';
import { marketFilterFromLink } from '../market-filters';
import { randomUUID } from 'node:crypto';
import { ed25519 } from '@noble/curves/ed25519.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { checkDmThread, sealDmLine, sealGroupLine, type HomeChatCard, type HomeChatLine, type HomeChatSettings } from '@beanpool/core';
import { CHAT_CARD_WORDS, chatCardFor, chatCardTarget, chatCardView, chatChoices, chatPickList, chatsOnHome, filterChatChoices } from '../home-chat';
import { openHomeChat, type HomeChatOpenDeps } from '../home-chat-open';
import { changeCardSettings } from '../home-cards';

const ME = 'a'.repeat(64);
// A fixed local afternoon, so "tonight" and "tomorrow" are stable wherever the suite runs.
const NOW = new Date(2026, 9, 2, 14, 0, 0).getTime();
/** The starter set as a saved Home: what a member has after Skip, or Done with nothing picked (DESIGN-getting-started §1). */
const STARTER = { v: 2 as const, cards: starterCards(), dismissed: {}, updatedAt: null };
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
const ctx = (over: Partial<Parameters<typeof cardsToDraw>[2]> = {}) => ({ interests: [] as string[], tuneOpen: false, safetyUp: false, now: NOW, ...over });
/** A layout as a member who edited with a version-1 app left it (their order, hidden cards left out), read through core's translateV1. */
const layout = (over: { order?: string[]; hidden?: string[]; dismissed?: Record<string, string>; updatedAt?: string | null } = {}): HomeLayout =>
    translateV1({ order: over.order ?? [], hidden: over.hidden ?? [], dismissed: over.dismissed ?? {}, updatedAt: over.updatedAt === undefined ? iso(NOW) : over.updatedAt });
/** Every card of version 1 on Home, in its default order: the show-when rules below are each card's, whatever the default list. */
const EVERY = layout();
/** The ids drawn, top down. */
const draw = (...args: Parameters<typeof cardsToDraw>) => cardsToDraw(...args).map(c => c.id);
const ids = (l: { id: string }[]) => l.map(c => c.id);
/** Cards on screen, one of a kind each, as the "…" menu's neighbours. */
const inst = (...list: string[]) => list.map(id => ({ id, type: id }));

const market = (n: number, cats: string[] = []): HomeCards['market'] => ({
    items: Array.from({ length: n }, (_, i) => ({ id: `p${i}`, type: i % 2 ? 'need' : 'offer', title: `Listing ${i}`, category: cats[i] ?? 'goods', price_c: (10 + i) * 100, photoUrl: null })),
    total14d: n, more: false,
});
const events: HomeCards['events'] = { items: [{ id: 'e1', title: 'Seed swap', startsAt: iso(NOW + 24 * H), endsAt: null, place: 'Town Hall', rsvp: null }], radiusKm: null };
const steps = (over: Partial<NonNullable<HomeCards['steps']>> = {}): NonNullable<HomeCards['steps']> => ({
    joinedAt: iso(NOW - 2 * 24 * H), firstOffer: false, firstPost: false, photo: false, interests: false, invited: false, area: false, knocked: null, saidHello: false, watch: false, sawLedger: false, ...over,
});
/** Find your community's body as the global node sends it (routes/global-directory.ts landingCardFor): one community 12 km away. */
const find = (over: Partial<NonNullable<HomeCards['find']>> = {}): NonNullable<HomeCards['find']> => ({
    point: 'area',
    communities: [{ key: 'byron', name: 'Byron Shire BeanPool', url: 'https://byron.example.org', lat: -28.6, lng: 153.6, radiusKm: 20, memberCount: 40, contactEmail: null, contactPhone: null, distanceKm: 12 }],
    communityCount: 38, nearbyPosts: { radiusKm: 25, count: 9, more: false }, watches: [], knock: null, directoryFetchedAt: iso(NOW - H), ...over,
});

describe('the catalogue and the newcomer\'s Home (CARD-FRAME §2.2, §3)', () => {
    it('one catalogue, core\'s: every type this build draws is in the registry; a newcomer starts with the default list, Welcome first, and the starter set is that list less Welcome', () => {
        for (const t of HOME_DRAWN) expect(homeCardType(t)).toBeDefined();
        // DESIGN-home-default-fable.md §2.2: the sixteen (the Pulse after Coming up, DESIGN-pulse-home-fable.md §3.5), between the fixed two.
        expect(ids(cardOrder(null))).toEqual(['needs', ...HOME_DEFAULT_LIST, 'community']);
        // "Asked near you" comes after the Market (cold-start N1); this build draws it since N2.
        expect(ids(cardOrder(STARTER))).toEqual(['needs', 'safety', 'market', 'steps', 'interests', 'events', 'pulse', 'beans', 'asked', 'deals', 'groups', 'decide', 'notices', 'joined', 'tips', 'sky', 'community']);
        expect(HOME_DEFAULT_LIST.every(id => HOME_DRAWN.has(id as never))).toBe(true);
        expect(HOME_DRAWN.has('asked')).toBe(true);
    });

    it('this build draws every type of version 1 and the saved search; Find your community came to Home in H4', () => {
        expect([...HOME_DRAWN]).toEqual(expect.arrayContaining([...HOME_V1_CARD_IDS, 'search']));
        expect(HOME_DRAWN.has('find')).toBe(true);
    });

    it('`needs` and `community` can\'t be removed or moved; everything else can', () => {
        expect(canRemoveCard('needs')).toBe(false);
        expect(canRemoveCard('community')).toBe(false);
        for (const id of HOME_V1_CARD_IDS.filter(i => i !== 'needs' && i !== 'community')) expect(canRemoveCard(id)).toBe(true);
    });
});

describe('what each person sees, top down (§3.2)', () => {
    it('Tips (TIPS-DESIGN §1): right after First steps for a new member with a tip to show; never a visitor, never asked of the node', () => {
        const a = answer({ cards: { steps: steps(), events, community: { name: 'Mullumbimby', members: 81, tradesThisMonth: 23 } } });
        expect(draw(a, EVERY, ctx({ tipsUp: true }))).toEqual(['steps', 'tips', 'interests', 'events', 'community']);
        expect(draw(a, EVERY, ctx({ tipsUp: false }))).toEqual(['steps', 'interests', 'events', 'community']);
        expect(draw({ ...a, me: null }, EVERY, ctx({ tipsUp: true }))).not.toContain('tips');
        expect(draw({ ...a, me: { ...a.me!, standing: 'suspended' } }, EVERY, ctx({ tipsUp: true }))).toContain('tips');
        expect(draw(a, layout({ hidden: ['tips'] }), ctx({ tipsUp: true }))).not.toContain('tips');
        expect(cardsToAsk(null)).not.toContain('tips');
        expect(cardsToAsk(layout({ hidden: ['tips'] }))).toEqual(cardsToAsk(EVERY));
        expect(cardName('tips')).toBe('Tips');
    });

    it('(b) a new local member: steps · interests · events · market · joined · pulse · beans · community', () => {
        const a = answer({
            cards: {
                steps: steps(), events, market: market(3), joined: { count7d: 5, radiusKm: null, names: [{ callsign: 'Ana', avatarUrl: null }, { callsign: 'Kofi', avatarUrl: null }] },
                pulse: { items: [{ id: 'q1', title: 'How our LETS started', thumbnailUrl: null, platform: 'youtube', callsign: 'River Folk Studio', category: 'education', url: null }] },
                beans: { balance_c: 0, room_c: 0, tier: 'Newcomer', activated: false, frozen: false },
                community: { name: 'Mullumbimby', members: 81, tradesThisMonth: 23 },
            },
        });
        expect(draw(a, EVERY, ctx())).toEqual(['steps', 'interests', 'events', 'market', 'joined', 'pulse', 'beans', 'community']);
    });

    it('(b) the same member a month in: needs when something waits, the invite card after their first Offer; steps and interests gone', () => {
        const a = answer({
            me: { ...answer().me!, interests: ['food'], firstOffer: true },
            cards: {
                needs: { items: [{ kind: 'deal', count: 1, accent: true, label: 'A deal is waiting for you: Sourdough', target: { to: 'deal', postId: 'p1', txId: 't1' } }] },
                events, market: market(4), joined: { count7d: 2, radiusKm: null, names: [{ callsign: 'Ana', avatarUrl: null }] },
                pulse: { items: [{ id: 'q1', title: 'x', thumbnailUrl: null, platform: 'youtube', callsign: 'y', category: 'food', url: null }] },
                beans: { balance_c: 1200, room_c: 21200, tier: 'Resident', activated: true, frozen: false },
                community: { name: 'Mullumbimby', members: 81, tradesThisMonth: 23 },
            },
        });
        expect(draw(a, EVERY, ctx({ interests: ['food'] }))).toEqual(['needs', 'events', 'market', 'joined', 'pulse', 'beans', 'invite', 'community']);
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
                beans: { balance_c: -3500, room_c: 16500, tier: 'Resident', activated: true, frozen: false },
                community: { name: 'Mullumbimby', members: 81, tradesThisMonth: 23 },
            },
        });
        expect(draw(a, EVERY, ctx({ interests: ['food'] }))).toEqual(['needs', 'deals', 'events', 'market', 'decide', 'groups', 'pulse', 'beans', 'invite', 'community']);
        // Where invites are off there is no invite card.
        expect(draw({ ...a, features: { ...a.features, invites: false } }, EVERY, ctx({ interests: ['food'] }))).not.toContain('invite');
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
        expect(draw(a, EVERY, ctx({ interests: ['tools'] }))).toEqual(['deals', 'enterprise', 'events', 'market', 'community']);
    });

    it('(b) the operator of a brand-new node, alone: steps · market (examples, when the node asks) · community', () => {
        const a = answer({
            features: { beans: true, escrow: true, invites: true, exampleListings: true },
            cards: { steps: steps(), market: { items: [], total14d: 0, more: false, examples: true }, community: { name: 'Newtown', members: 1, tradesThisMonth: 0 } },
        });
        // `interests` too: nothing starred yet (the card is the design's empty state for that, §3.2 day one).
        expect(draw(a, EVERY, ctx())).toEqual(['steps', 'interests', 'market', 'community']);
        expect(communityLines(a.cards.community, 'local', true).line).toBe("1 member. You're first. Invite someone.");
        // A local node that doesn't ask for examples: no market card at all when nothing is listed.
        expect(draw(answer({ cards: { market: undefined, community: a.cards.community } }), EVERY, ctx({ interests: ['food'] }))).toEqual(['community']);
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
        expect(draw(a, EVERY, ctx({ safetyUp: true, now: NOW }))).toEqual(['safety', 'find', 'steps', 'interests', 'events', 'market', 'joined', 'community']);
        expect(draw(a, EVERY, ctx({ safetyUp: false, interests: ['food'], now: NOW }))).toEqual(['find', 'steps', 'events', 'market', 'joined', 'community']);
        expect(joinedLine(a.cards.joined!, 'global')).toBe('14 people within 50 km joined this week.');
        expect(communityLines(a.cards.community, 'global', false)).toEqual({ title: 'The global community', line: '2,310 members · 38 communities listed.' });
    });

    it('a suspended member\'s answer (no community cards) still draws their own and the community card', () => {
        const a = answer({
            me: { ...answer().me!, standing: 'suspended', interests: ['food'] },
            cards: { beans: { balance_c: 400, room_c: 0, tier: 'Newcomer', activated: true, frozen: true }, community: { name: 'M', members: 3 } },
        });
        expect(draw(a, EVERY, ctx({ interests: ['food'] }))).toEqual(['beans', 'community']);
    });

    it('a card with nothing to say takes no space, and an empty Market card isn\'t drawn without examples', () => {
        const a = answer({ me: { ...answer().me!, interests: ['food'] }, cards: { market: { items: [], total14d: 0, more: false }, community: { name: 'M', members: 9 } } });
        expect(draw(a, EVERY, ctx({ interests: ['food'] }))).toEqual(['community']);
    });

    it('First steps shows while any line is undone, and goes once all are done', () => {
        const a = (s: HomeCards['steps']) => answer({ me: { ...answer().me!, interests: ['food'] }, cards: { steps: s, community: { name: 'M', members: 9 } } });
        expect(draw(a(steps({ firstOffer: true, photo: true, interests: true, invited: true })), EVERY, ctx({ interests: ['food'] }))).toEqual(['community']);
        expect(draw(a(steps({ firstOffer: true, photo: false, interests: true, invited: true })), EVERY, ctx({ interests: ['food'] }))).toEqual(['steps', 'community']);
        // The invite line only after the first Offer, and none where invites are off (null).
        expect(stepLines(steps({ firstOffer: false }), false).map(l => l.id)).toEqual(['offer', 'photo', 'interests']);
        expect(stepLines(steps({ firstOffer: true }), false).map(l => l.id)).toEqual(['offer', 'photo', 'interests', 'invite']);
        expect(stepLines(steps({ firstOffer: true, invited: null }), false).map(l => l.id)).toEqual(['offer', 'photo', 'interests']);
        // Starred on the phone a moment ago counts before the node says so.
        expect(stepLines(steps(), true).find(l => l.id === 'interests')!.done).toBe(true);
    });

    it('the interests card: while nothing is starred, or opened from "Tune"', () => {
        const a = answer({ cards: { community: { name: 'M', members: 9 } } });
        expect(draw(a, EVERY, ctx())).toContain('interests');
        expect(draw(a, EVERY, ctx({ interests: ['food'] }))).not.toContain('interests');
        expect(draw(a, EVERY, ctx({ interests: ['food'], tuneOpen: true }))).toContain('interests');
        // A visitor's answer (no `me`) has no interests card.
        expect(draw({ ...a, me: null }, EVERY, ctx())).not.toContain('interests');
    });

    it('Needs you counts the phone\'s own lines too (an unread message the answer doesn\'t carry yet)', () => {
        const a = answer({ me: { ...answer().me!, interests: ['food'] } });
        expect(draw(a, EVERY, ctx({ interests: ['food'], needs: 1 }))[0]).toBe('needs');
        expect(draw(a, EVERY, ctx({ interests: ['food'], needs: 0 }))).not.toContain('needs');
    });
});

describe('the layout (§4)', () => {
    const full = answer({
        me: { ...answer().me!, interests: ['food'] },
        cards: { events, market: market(2), beans: { balance_c: 100, room_c: 100, tier: 'Resident', activated: true, frozen: false }, community: { name: 'M', members: 9 } },
    });

    it('a card not in the list is never drawn, nor asked for; `needs` and `community` are always there and can\'t be removed', () => {
        const l = layout({ hidden: ['market', 'beans'] });
        expect(draw(full, l, ctx({ interests: ['food'] }))).toEqual(['events', 'community']);
        expect(cardsToAsk(l)).not.toContain('market');
        expect(cardsToAsk(l)).not.toContain('beans');
        expect(removeCard(null, 'needs', NOW)).toBeNull();
        expect(removeCard(null, 'community', NOW)).toBeNull();
        // A version-1 layout reads as the member's order with the hidden cards left out, and never lists the fixed two.
        expect(ids(readHomeLayout({ v: 1, hidden: ['needs', 'community', 'pulse'] })!.cards)).toEqual(HOME_V1_CARD_IDS.filter(id => !['needs', 'community', 'pulse'].includes(id)));
    });

    it('cards= is catalogue order then id, the same each time; no data-less cards; a move doesn\'t change it', () => {
        // A never-saved Home asks for every default card the node builds (DESIGN-home-default-fable.md §2.2).
        expect(cardsToAsk(null)).toEqual(['needs', 'safety', 'steps', 'deals', 'events', 'market', 'asked', 'decide', 'groups', 'joined', 'pulse', 'beans', 'notices', 'community']);
        expect(cardsToAsk(EVERY)).toEqual(['needs', 'safety', 'find', 'steps', 'deals', 'enterprise', 'events', 'market', 'decide', 'groups', 'joined', 'pulse', 'beans', 'notices', 'community']);
        expect(cardsToAsk(layout({ order: ['beans', 'market'] }))).toEqual(cardsToAsk(EVERY));
    });

    it('cards= never depends on what the last answer said of the node: a community that changed still gets First steps', () => {
        // Measured on the emulator: built from a cached global answer, the list left out `steps`, and the community's
        // First steps never came. The list is the layout's (and a pin's) alone; whether a card is drawn is cardsToDraw's.
        // (Since review of #1699 finding 5 an answer in hand leaves out only a type the node doesn't show: the next test.)
        expect(cardsToAsk.length).toBe(1);
        expect(cardsToAsk(null)).toContain('steps');
        // A local answer that names a First steps card with every line done draws none; the global one draws its own lines.
        const done = steps({ firstOffer: true, firstPost: true, photo: true, interests: true, invited: true });
        expect(draw(answer({ cards: { steps: done, community: { name: 'L', members: 9 } } }), EVERY, ctx({ interests: ['food'] }))).not.toContain('steps');
        const global = answer({ profile: 'global', cards: { steps: steps(), community: { name: 'G', members: 9 } } });
        expect(draw(global, EVERY, ctx({ interests: ['food'] }))).toContain('steps');
    });

    it('a card\'s name for the screen reader: a saved search by its words, quoted and bounded at 24 characters; any other by its type (review of #1699, finding 4)', () => {
        expect(cardLabelName({ type: 'search', settings: { q: '  duck   eggs ', kind: 'any' } })).toBe('"duck eggs"');
        expect(cardLabelName({ type: 'search', settings: { q: 'x'.repeat(24), kind: 'any' } })).toBe(`"${'x'.repeat(24)}"`);
        expect(cardLabelName({ type: 'search', settings: { q: 'x'.repeat(25), kind: 'any' } })).toBe(`"${'x'.repeat(24)}…"`);
        expect(cardLabelName({ type: 'search', settings: { q: '', kind: 'any' } })).toBe('A saved search');
        expect(cardLabelName({ type: 'search' })).toBe('A saved search');
        // Two searches with the same words and another kind sound different (review of #1716): Both says no kind.
        expect(cardLabelName({ type: 'search', settings: { q: 'eggs', kind: 'offer' } })).toBe('"eggs" (Offers)');
        expect(cardLabelName({ type: 'search', settings: { q: 'eggs', kind: 'need' } })).toBe('"eggs" (Needs)');
        expect(cardLabelName({ type: 'search', settings: { q: 'x'.repeat(25), kind: 'need' } })).toBe(`"${'x'.repeat(24)}…" (Needs)`);
        expect(cardRowName({ type: 'search', settings: { q: 'eggs', kind: 'offer' } })).toBe('Offers · eggs');
        expect(cardRowName({ type: 'search', settings: { q: 'eggs', kind: 'need' } })).toBe('Needs · eggs');
        expect(cardRowName({ type: 'search', settings: { q: 'eggs', kind: 'any' } })).toBe('eggs');
        expect(cardRowName({ type: 'search', settings: { kind: 'need' } })).toBe('A saved search');
        expect(cardLabelName({ type: 'market' }, 'global')).toBe('Near you');
        expect(cardLabelName({ type: 'pulse' })).toBe('The Pulse');
    });

    it('with an answer in hand, cards= leaves out a type this node doesn\'t show: the global node builds no Beans, deals, enterprise or Decide (review of #1699, finding 5)', () => {
        const global = answer({ profile: 'global', features: { beans: false, escrow: false, enterprises: false, invites: false, decisions: false, wordsDoor: true } });
        const asked = cardsToAsk(EVERY, ['find'], global);
        for (const off of ['beans', 'deals', 'enterprise', 'decide']) expect(asked).not.toContain(off);
        expect(asked).toEqual(['needs', 'safety', 'find', 'steps', 'events', 'market', 'groups', 'joined', 'pulse', 'notices', 'community']);
        // A local community with a feature switched off: that one alone.
        expect(cardsToAsk(EVERY, [], answer({ features: { beans: true, escrow: false, invites: true, exampleListings: false, decisions: true } }))).toEqual(
            cardsToAsk(EVERY).filter(id => id !== 'deals'));
        // Every type the list names on a local community that has them all on, as with no answer: the same address, so a
        // return is a 304 (Find your community is asked as before; the node builds it only where its directory is).
        expect(cardsToAsk(EVERY, [], answer())).toEqual(cardsToAsk(EVERY));
        // A saved search is asked by its id wherever it's on.
        const withSearch = { ...EVERY, cards: [{ id: 'search-k2x7', type: 'search', settings: { q: 'eggs', kind: 'any' } }, ...EVERY.cards] };
        expect(cardsToAsk(withSearch, [], global)).toContain('search-k2x7');
        // The 12-words door shut: "Your way back in" only when the node sent one.
        const shut = { ...global, features: { ...global.features, wordsDoor: false } };
        expect(cardsToAsk(EVERY, [], shut)).not.toContain('safety');
        expect(cardsToAsk(EVERY, [], { ...shut, cards: { safety: { words: true, signInLinked: false } } })).toContain('safety');
    });

    it('remove, add back, and the date moves on each edit', () => {
        const gone = removeCard(EVERY, 'pulse', NOW)!;
        expect(ids(gone.cards)).not.toContain('pulse');
        expect(gone.updatedAt).toBe(iso(NOW));
        expect(removeCard(gone, 'pulse', NOW + 1)).toBeNull();
        const back = addCard(gone, 'pulse', NOW + 1000);
        if (!back.ok) throw new Error('not added');
        expect(ids(back.layout.cards)[0]).toBe('pulse');
        expect(back.layout.updatedAt).toBe(iso(NOW + 1000));
        expect(addCard(back.layout, 'pulse', NOW)).toEqual({ ok: false, refused: 'on-home' });
    });

    it('move up and down past the card next to it on screen, keeping every other card\'s place', () => {
        const onScreen = inst('needs', 'events', 'market', 'beans', 'community');
        const up = moveCard(EVERY, 'beans', 'up', onScreen, NOW)!;
        const order = ids(cardOrder(up));
        expect(order.indexOf('beans')).toBeLessThan(order.indexOf('market'));
        expect(draw(full, up, ctx({ interests: ['food'] }))).toEqual(['events', 'beans', 'market', 'community']);
        // Not past `needs` or `community`, and not off the ends.
        expect(moveCard(EVERY, 'events', 'up', onScreen, NOW)).toBeNull();
        expect(moveCard(up, 'market', 'down', inst('needs', 'events', 'beans', 'market', 'community'), NOW)).toBeNull();
        expect(moveCard(EVERY, 'needs', 'down', onScreen, NOW)).toBeNull();
        // `needs` stays first and `community` last whatever a layout says.
        expect(ids(cardOrder(layout({ order: ['community', 'beans', 'needs'] })))[0]).toBe('needs');
        expect(ids(cardOrder(layout({ order: ['community', 'beans', 'needs'] }))).at(-1)).toBe('community');
    });

    it('reset: the default list less Welcome (DESIGN-home-default-fable.md §3); the safety card\'s dismissal (a schedule, not a choice) is kept', () => {
        const l = layout({ order: ['beans'], hidden: ['pulse'], dismissed: { safety: iso(NOW - H) } });
        const r = resetLayout(l, NOW);
        expect(r).toEqual({ v: 2, cards: starterCards(), dismissed: { safety: iso(NOW - H) }, updatedAt: iso(NOW) });
        // The whole starter set, "Asked near you" too: this build draws every card in it (a type it did not draw would be kept in the
        // layout and left out of what is drawn, as any type newer than the build is).
        expect(HOME_STARTER_SET.every(id => HOME_DRAWN.has(id as never))).toBe(true);
        expect(ids(cardOrder(r))).toEqual(['needs', ...HOME_STARTER_SET, 'community']);
        expect(defaultCards()).toEqual(HOME_DEFAULT_LIST.map(id => ({ id, type: id })));
    });

    it('reset keeps the columns chosen on the web, byte for byte: the phone carries them, never reads them (W0)', () => {
        const view = { columns: 2 as const, later: { kept: true } };
        const l: HomeLayout = { v: 2, cards: [{ id: 'beans', type: 'beans' }], dismissed: {}, updatedAt: iso(NOW - H), view };
        const r = resetLayout(l, NOW);
        expect(r.cards).toEqual(starterCards());
        expect(JSON.stringify(r.view)).toBe(JSON.stringify(view));
        expect(resetLayout({ ...l, view: undefined }, NOW)).not.toHaveProperty('view');
        expect(dismissSafety(l, NOW).view).toBe(view);
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

    it('a card of a type this build doesn\'t know (a newer app\'s) is kept through every edit, byte for byte, never drawn, never asked (§2.3)', () => {
        const future = { id: 'zzz-k7mq', type: 'zzz-future', settings: { a: 1, words: 'kept' } };
        const l = readHomeLayout({ v: 2, cards: [{ id: 'beans', type: 'beans' }, future, { id: 'pulse', type: 'pulse' }], dismissed: {}, updatedAt: iso(NOW) })!;
        expect(l.cards[1]).toEqual(future);
        expect(draw(full, l, ctx({ interests: ['food'] }))).not.toContain('zzz-k7mq');
        expect(cardsToAsk(l)).not.toContain('zzz-k7mq');
        const moved = moveCard(l, 'pulse', 'up', inst('needs', 'beans', 'pulse', 'community'), NOW)!;
        expect(moved.cards).toContainEqual(future);
        const added = addCard(moved, 'events', NOW);
        expect(added.ok && added.layout.cards).toContainEqual(future);
        expect(removeCard(moved, 'beans', NOW)!.cards).toContainEqual(future);
        expect(resetLayout(moved, NOW).cards).toContainEqual(future);
        expect(dismissSafety(moved, NOW).cards).toContainEqual(future);
        expect(readHomeLayout('nope')).toBeNull();
        expect(readHomeLayout({ v: 3 })).toBeNull();
    });

    it('an answer is read tolerantly: an unknown card stays unknown, a non-answer is null', () => {
        expect(readHomeAnswer(null)).toBeNull();
        expect(readHomeAnswer({ profile: 'local' })).toBeNull();
        const a = readHomeAnswer({
            profile: 'local', cards: { widget: { x: 1 }, community: { name: 'M', members: 2 } }, me: { interests: ['food', 3] },
            layout: { v: 2, cards: [{ id: 'widget', type: 'widget' }], dismissed: {}, updatedAt: null },
        })!;
        expect(a.me!.interests).toEqual(['food']);
        expect(a.layout!.cards).toEqual([{ id: 'widget', type: 'widget' }]);
        expect(a.layoutV1).toBeUndefined();
        expect(draw(a, a.layout, ctx({ interests: ['food'] }))).toEqual(['community']);
    });
});

describe('the frame: the picker, adding, and the members who were here before (CARD-FRAME §1, §2.6, F2)', () => {
    const LOCAL_NODE = { profile: 'local', features: { beans: true, escrow: true, enterprises: true, invites: true, decisions: true } };
    const GLOBAL_NODE = { profile: 'global', features: { beans: false, escrow: false, enterprises: false, invites: false, decisions: false, wordsDoor: true } };
    const types = (g: ReturnType<typeof pickerGroups>) => g.groups.flatMap(x => x.rows.map(r => r.type));
    const row = (g: ReturnType<typeof pickerGroups>, type: string) => g.groups.flatMap(x => x.rows).find(r => r.type === type);

    it('the picker: three groups in order, only this node\'s types, "On Home" for a one-of-a-kind already there, counts for an instance type', () => {
        const g = pickerGroups(LOCAL_NODE, STARTER, 'admin');
        expect(g.groups.map(x => x.name)).toEqual(['For you', 'Around you', 'Getting started']);
        // Getting started is in the picker under its group, for whoever wants it (DESIGN-getting-started §1).
        expect(row(g, 'start')).toMatchObject({ state: 'add' });
        expect(row(pickerGroups(LOCAL_NODE, null, 'admin'), 'start')!.state).toBe('on-home');
        expect(types(g)).not.toContain('needs');
        expect(types(g)).not.toContain('community');
        expect(types(g)).not.toContain('find');
        expect(types(g)).toEqual(expect.arrayContaining(['beans', 'deals', 'enterprise', 'decide', 'invite', 'search']));
        // Your Beans is in the default list (DESIGN-home-default-fable.md §2.2), and The Pulse since DESIGN-pulse-home-fable.md §3.5;
        // Your enterprise is one it leaves out.
        expect(row(g, 'beans')).toMatchObject({ state: 'on-home', count: null, name: 'Your Beans' });
        expect(row(g, 'pulse')).toMatchObject({ state: 'on-home', count: null, name: 'The Pulse' });
        expect(row(g, 'enterprise')).toMatchObject({ state: 'add', count: null, name: 'Your enterprise' });
        expect(row(g, 'market')!.state).toBe('on-home');
        expect(row(g, 'search')).toMatchObject({ state: 'add', count: null, hasSettings: true });
        const two = { v: 2 as const, cards: [...defaultCards(), { id: 'search-aaaa', type: 'search' }, { id: 'search-bbbb', type: 'search' }], dismissed: {}, updatedAt: iso(NOW) };
        expect(row(pickerGroups(LOCAL_NODE, two, 'admin'), 'search')).toMatchObject({ state: 'add', count: '2 of 5 on Home' });
        const five = { ...two, cards: [...defaultCards(), ...'abcde'.split('').map(c => ({ id: `search-${c}aaa`, type: 'search' }))] };
        expect(row(pickerGroups(LOCAL_NODE, five, 'admin'), 'search')).toMatchObject({ state: 'full', count: '5 of 5 on Home' });
        // Where only admins invite, a plain member isn't offered Grow your community: never shown as locked, just not there.
        expect(types(pickerGroups({ ...LOCAL_NODE, features: { ...LOCAL_NODE.features, door: 'admins' } }, null, null))).not.toContain('invite');
        // A type's state line, from the screen ("All tips seen").
        expect(row(pickerGroups(LOCAL_NODE, null, 'admin', [], { tips: TIPS_ALL_SEEN }), 'tips')!.status).toBe('All tips seen');
    });

    it('the worldwide community\'s picker lists no Beans, deals, enterprise, Decide or Grow your community; Find your community only after its pin', () => {
        const g = pickerGroups(GLOBAL_NODE, null, null, ['find']);
        for (const t of ['beans', 'deals', 'enterprise', 'decide', 'invite', 'find']) expect(types(g)).not.toContain(t);
        expect(row(g, 'market')!.name).toBe('Near you');
        expect(types(pickerGroups(GLOBAL_NODE, null, null, []))).toContain('find');
    });

    it('a full Home (24 cards): every Add goes', () => {
        const full24 = { v: 2 as const, cards: Array.from({ length: 24 }, (_, i) => ({ id: `zzz-${i}`, type: 'zzz' })), dismissed: {}, updatedAt: iso(NOW) };
        const g = pickerGroups(LOCAL_NODE, full24, 'admin');
        expect(g.full).toBe(true);
        expect(g.groups.flatMap(x => x.rows).every(r => r.state !== 'add')).toBe(true);
        expect(addCard(full24, 'beans', NOW)).toEqual({ ok: false, refused: 'home-full' });
    });

    it('Add puts the card first, under a pinned Find your community; a saved search keeps its settings; the sixth is refused', () => {
        const pinnedFirst = { v: 2 as const, cards: [{ id: 'find', type: 'find' }, ...defaultCards()], dismissed: {}, updatedAt: iso(NOW) };
        // Your enterprise: a card the default list leaves out (DESIGN-home-default-fable.md §2.2; the Pulse is in it since
        // DESIGN-pulse-home-fable.md §3.5).
        const a = addCard(pinnedFirst, 'enterprise', NOW, { pinned: ['find'] });
        if (!a.ok) throw new Error('not added');
        expect(ids(a.layout.cards).slice(0, 2)).toEqual(['find', 'enterprise']);
        expect(a.id).toBe('enterprise');
        const s1 = addCard(null, 'search', NOW, { settings: { q: 'eggs', kind: 'any', km: 5 } });
        if (!s1.ok) throw new Error('not added');
        expect(s1.id).toMatch(/^search-[a-z2-7]{4}$/);
        expect(s1.layout.cards[0]).toEqual({ id: s1.id, type: 'search', settings: { q: 'eggs', kind: 'any', km: 5 } });
        let l = s1.layout;
        for (let i = 0; i < 4; i++) { const r = addCard(l, 'search', NOW); if (r.ok) l = r.layout; }
        expect(addCard(l, 'search', NOW)).toEqual({ ok: false, refused: 'type-full' });
        // Never a type this build can't draw.
        expect(addCard(null, 'zzz-future', NOW)).toEqual({ ok: false, refused: 'unknown' });
    });

    it('a member who edited with a version-1 app: their order, hidden cards left out; nothing is written until they edit (translateV1)', () => {
        const a = readHomeAnswer({ ...answer(), layout: { v: 1, order: ['market', 'beans'], hidden: ['events'], dismissed: {}, updatedAt: iso(NOW - H) } })!;
        expect(ids(a.layout!.cards).slice(0, 2)).toEqual(['market', 'beans']);
        expect(ids(a.layout!.cards)).not.toContain('events');
        expect(a.layoutV1).toEqual({ empty: false });
        // The account's copy alone: drawn, not sent.
        expect(pickLayout(a.layout, null, a.layoutV1)).toEqual({ layout: a.layout, push: false });
    });

    it('a not-yet-updated standby answers a v2 row as an empty v1 layout dated like it: the phone\'s own v2 copy wins, on a tie and after (review of #1697, note b)', () => {
        const phone = { v: 2 as const, cards: [{ id: 'search-k7mq', type: 'search', settings: { q: 'eggs', kind: 'any' } }, ...defaultCards()], dismissed: {}, updatedAt: iso(NOW) };
        const standby = readHomeAnswer({ ...answer(), layout: { v: 1, order: [], hidden: [], updatedAt: iso(NOW) } })!;
        expect(standby.layoutV1).toEqual({ empty: true });
        expect(pickLayout(standby.layout, phone, standby.layoutV1)).toEqual({ layout: phone, push: false });
        const later = readHomeAnswer({ ...answer(), layout: { v: 1, order: [], hidden: [], updatedAt: iso(NOW + H) } })!;
        expect(pickLayout(later.layout, phone, later.layoutV1)).toEqual({ layout: phone, push: false });
        // A version-1 edit that names something, made after (an older app on another device), is the member's own: it wins.
        const edited = readHomeAnswer({ ...answer(), layout: { v: 1, order: ['beans'], hidden: ['pulse'], updatedAt: iso(NOW + H) } })!;
        expect(pickLayout(edited.layout, phone, edited.layoutV1).layout).toBe(edited.layout);
        // On a tie it doesn't.
        const tie = readHomeAnswer({ ...answer(), layout: { v: 1, order: ['beans'], hidden: ['pulse'], updatedAt: iso(NOW) } })!;
        expect(pickLayout(tie.layout, phone, tie.layoutV1)).toEqual({ layout: phone, push: false });
    });

    it('no copy on the phone and an empty version-1 account list: unknown, so the newcomer\'s list; an edit made then loses to the account\'s real list dated at or after it (review of #1699, finding 2)', () => {
        const at = iso(NOW - 2 * H);
        const standby = readHomeAnswer({ ...answer(), layout: { v: 1, order: [], hidden: [], dismissed: { safety: at }, updatedAt: at } })!;
        // Not every version-1 card: the newcomer's list, with the account's dismissal; nothing sent.
        expect(pickLayout(standby.layout, null, standby.layoutV1)).toEqual({ layout: { ...defaultHomeLayout(), cards: starterCards(), dismissed: { safety: at } }, push: false });
        // The member edits there: the phone's list, marked as made over that list (its date). It is sent, and the standby
        // refuses it (once per landing), so it stays the phone's.
        const edit = { v: 2 as const, cards: starterCards().filter(c => c.type !== 'events'), dismissed: {}, updatedAt: iso(NOW) };
        expect(pickLayout(standby.layout, edit, standby.layoutV1, at)).toEqual({ layout: edit, push: true });
        // The primary is back with the real list, dated like the empty one or later: it wins, and nothing is sent.
        const real = { v: 2 as const, cards: [{ id: 'pulse', type: 'pulse' }, { id: 'search-k2x7', type: 'search', settings: { q: 'eggs', kind: 'any' } }, { id: 'market', type: 'market' }], dismissed: {}, updatedAt: at };
        expect(pickLayout(real, edit, undefined, at)).toEqual({ layout: real, push: false });
        expect(pickLayout({ ...real, updatedAt: iso(NOW - H) }, edit, undefined, at).layout!.updatedAt).toBe(iso(NOW - H));
        // Never the reverse: without the mark the phone's newer edit would win and be sent.
        expect(pickLayout(real, edit)).toEqual({ layout: edit, push: true });
        // A version-2 list older than the empty one isn't the account's list it stood for: the phone's newer edit wins.
        expect(pickLayout({ ...real, updatedAt: iso(NOW - 3 * H) }, edit, undefined, at)).toEqual({ layout: edit, push: true });
        // The empty list had no date: any version-2 answer is the account's.
        expect(pickLayout(real, edit, undefined, '')).toEqual({ layout: real, push: false });
        // A version-1 list that names cards is the member's, as before.
        const v1 = readHomeAnswer({ ...answer(), layout: { v: 1, order: ['beans'], hidden: [], updatedAt: at } })!;
        expect(pickLayout(v1.layout, null, v1.layoutV1)).toEqual({ layout: v1.layout, push: false });
    });

    it('a stored list with 24 `market` or 7 `search` instances draws one Market and five searches, and never crashes (review of #1697, note c)', () => {
        const markets = Array.from({ length: 24 }, (_, i) => ({ id: i === 0 ? 'market' : `market-${i}`, type: 'market' }));
        const crowd = { v: 2 as const, cards: markets, dismissed: {}, updatedAt: iso(NOW) };
        const a = answer({ cards: { market: market(2), community: { name: 'M', members: 9 } } });
        expect(draw(a, crowd, ctx({ interests: ['food'] }))).toEqual(['market', 'community']);
        const searches = { ...crowd, cards: Array.from({ length: 7 }, (_, i) => ({ id: `search-${i}aaa`, type: 'search', settings: { q: `w${i}` } })) };
        expect(draw(a, searches, ctx({ interests: ['food'] })).filter(id => id.startsWith('search-'))).toHaveLength(5);
        // A fixed type in the list is drawn once, in its own place.
        const fixed = { ...crowd, cards: [{ id: 'community', type: 'community' }, { id: 'needs', type: 'needs' }, { id: 'market', type: 'market' }] };
        expect(draw(a, fixed, ctx({ interests: ['food'] }))).toEqual(['market', 'community']);
    });

    it('the picker\'s words are fixed and say nothing locked, earned or tiered, and Beans by name', () => {
        const g = pickerGroups(LOCAL_NODE, null, 'admin');
        for (const r of g.groups.flatMap(x => x.rows)) {
            expect(`${r.name} ${r.line}`).not.toMatch(/lock|earn|tier|Ʀ/i);
        }
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

    it("a short standing deal's live line on the phone: the node's deal line still shows, its copy of that standing deal doesn't (U2)", () => {
        const sd = {
            id: 'sd-m1', postId: 'p-storage', postTitle: 'Vehicle Storage', status: 'completed', buyerPublicKey: 'payer', buyerCallsign: 'Marty',
            sellerPublicKey: ME, sellerCallsign: 'Rob', standingId: 'sd-1', periodNo: 1, standingPhase: 'short' as const, standingBeans_c: 5000,
            standingUnit: 'month' as const, standingStartsAt: '2026-08-19T08:00:00.000Z', standingShortSince: iso(NOW - 3 * 24 * H),
        };
        const nodeCopy = { kind: 'deal' as const, count: 1, accent: false, label: "Marty's 50 Beans for Vehicle Storage: 3 days overdue", target: { to: 'deal' as const, postId: 'p-storage', txId: 'sd-m1' } };
        const merged = mergeNeeds([...node, nodeCopy], localNeeds(ME, NOW, [sd], []), NOW);
        const deals = merged.filter(e => e.kind === 'deal');
        expect(deals.map(e => e.label)).toEqual([
            expect.stringMatching(/^Marty's 50 Beans for Vehicle Storage: 3 days overdue · we try until .+ · you can stop it now$/),
            'A deal is waiting for you: Sourdough',
        ]);
        expect(deals[0]).toMatchObject({ accent: false, standingId: 'sd-1' });
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
        // The node's figures are whole hundredths of a Bean (balance_c, room_c): −3500 is −35 Beans.
        expect(beansLines({ balance_c: 0, room_c: 0, tier: 'Newcomer', activated: false, frozen: false }))
            .toEqual({ main: '0 Beans · nothing to repay', sub: 'Your credit opens with a first trade.' });
        expect(beansLines({ balance_c: -3500, room_c: 16500, tier: 'Resident', activated: true, frozen: false }))
            .toEqual({ main: '−35 Beans · room to spend 165', sub: 'Resident' });
        expect(beansLines({ balance_c: -21000, room_c: 0, tier: 'Resident', activated: true, frozen: true }).sub).toBe('Spending is paused for now. You can still receive and sell.');
        for (const b of [beansLines({ balance_c: 300, room_c: 300, tier: 'Elder', activated: true, frozen: false })]) {
            expect(`${b.main} ${b.sub}`).not.toMatch(/unlock|Ʀ|locked/i);
        }
        // core formatHundredths: two decimals unless whole ("12.50", never "12.5"), English grouping, the true minus.
        expect(formatBeans(1250)).toBe('12.50');
        expect(formatBeans(123400)).toBe('1,234');
        expect(formatBeans(-25)).toBe('−0.25');
        // Not whole hundredths (a float, a string, none): "—", never a number.
        expect(formatBeans(12.5)).toBe('—');
        expect(formatBeans(Number.NaN)).toBe('—');
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

    it('the card for the one you keep: "Your project" for a project, "Your enterprise" otherwise (group decisions §3.1)', () => {
        const ent = (lifecycle?: 'ongoing' | 'bounded') => ({ profile: 'local', cards: { enterprise: { id: 'e', name: 'Hall roof', requests: 0, others: 0, lifecycle } } }) as Pick<HomeAnswer, 'profile' | 'cards'>;
        expect(cardCaption('enterprise', ent('bounded'))).toBe('Your project');
        expect(cardCaption('enterprise', ent('ongoing'))).toBe('Your enterprise');
        expect(cardCaption('enterprise', ent())).toBe('Your enterprise');
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
        expect(ids(l.cards)).not.toContain('pulse');
    });

    it('the community\'s word from Home\'s answer: only when it asked for the card and answered as the account\'s own', () => {
        const words = answer({ cards: { safety: { words: true, signInLinked: false }, community: { name: 'G', members: 9 } } });
        expect(safetyWord(words, ['safety', 'community'])).toEqual({ words: true, joinedAt: NOW - 2 * 24 * H });
        expect(safetyWord(answer(), ['safety', 'community'])).toEqual({ words: false, joinedAt: NOW - 2 * 24 * H });
        expect(safetyWord(words, ['community'])).toBeNull();
        expect(safetyWord({ ...words, me: null }, ['safety'])).toBeNull();
    });

    // DESIGN-home-default-fable.md §2.5 (slice D2): who the reminder is for is what the account has (`me.wayBack`, the node's
    // D1), and "Add a sign-in" only where the node takes one from them (`cards.safety`, review of #3110 round 2).
    it('the word by me.wayBack: words for every member with no sign-in here (door only with the node\'s card), covered for none, kept from First steps', () => {
        const base = answer();
        const invited = { ...base, me: { ...base.me!, wayBack: 'words' as const }, cards: { ...base.cards, steps: { ...base.cards.steps!, words: false } } };
        expect(safetyWord(invited, ['safety'])).toEqual({ words: true, joinedAt: NOW - 2 * 24 * H, door: false, kept: false });
        const door = { ...invited, cards: { ...invited.cards, safety: { words: true as const, signInLinked: false as const } } };
        expect(safetyWord(door, ['safety'])).toMatchObject({ words: true, door: true });
        const kept = { ...invited, cards: { ...invited.cards, steps: { ...invited.cards.steps!, words: true } } };
        expect(safetyWord(kept, ['safety'])).toMatchObject({ words: true, kept: true });
        expect(safetyWord({ ...invited, me: { ...invited.me, wayBack: 'covered' as const } }, ['safety'])).toEqual({ words: false, joinedAt: NOW - 2 * 24 * H });
    });

    it('an invite-only community (no 12-words door) whose node says me.wayBack: Your way back in is asked and may be drawn; a node before D1 keeps core\'s rule', () => {
        const base = answer();
        const inviteOnly = { ...base, features: { ...base.features, wordsDoor: false } };
        expect(cardOnNode('safety', inviteOnly)).toBe(false);
        const d1 = { ...inviteOnly, me: { ...inviteOnly.me!, wayBack: 'words' as const } };
        expect(cardOnNode('safety', d1)).toBe(true);
        expect(cardsToAsk(defaultHomeLayout(), [], d1)).toContain('safety');
        expect(cardsToAsk(defaultHomeLayout(), [], inviteOnly)).not.toContain('safety');
        expect(cardOnNode('safety', { ...inviteOnly, me: { ...inviteOnly.me!, wayBack: 'covered' as const } })).toBe(true);
    });

    // Review of #3114, round 2: core's catalogue gate takes the answer's `me` (home-frame.ts `HomeNodeFacts.me`), and the
    // phone hands it over wherever it reads that gate: the picker, Arrange and the drawn cards (slice D2b).
    it('on an invite-only community (features.wordsDoor false) the picker, Arrange and the drawn cards read core\'s gate with the answer\'s me', () => {
        const base = answer();
        const inviteOnly = { ...base, features: { ...base.features, wordsDoor: false } };
        const words = { ...inviteOnly, me: { ...inviteOnly.me!, wayBack: 'words' as const } };
        // Core's own gate, given `me`, is what the phone says for every type (a covered member's ask is the phone's own: below).
        for (const a of [inviteOnly, words, { ...inviteOnly, me: null }, { ...words, profile: 'global' }]) {
            for (const entry of HOME_DRAWN) {
                const core = homeCardType(entry)!.onNode({ profile: a.profile, features: a.features, cards: a.cards as Record<string, unknown>, me: a.me });
                expect(cardOnNode(entry, a), `${entry} ${a.me?.wayBack ?? 'no wayBack'} ${a.profile}`).toBe(core);
            }
        }
        expect(homeCardType('safety')!.onNode({ profile: 'local', features: { wordsDoor: false }, me: { wayBack: 'words' } })).toBe(true);
        // Add a card offers it to a member whose list doesn't have it; not without `me.wayBack`.
        const less = removeCard(defaultHomeLayout(), 'safety', NOW) ?? defaultHomeLayout();
        expect(listOf(less).map(c => c.type)).not.toContain('safety');
        const offered = (a: HomeAnswer) => pickerGroups(a, less, null).groups.flatMap(g => g.rows.map(r => r.type));
        expect(offered(words)).toContain('safety');
        expect(offered(inviteOnly)).not.toContain('safety');
        // Arrange lists it among the cards that could show, and it is asked and drawn when its schedule says.
        expect(ids(arrangeCards(EVERY.cards, [], type => cardOnNode(type, words)))).toContain('safety');
        expect(ids(arrangeCards(EVERY.cards, [], type => cardOnNode(type, inviteOnly)))).not.toContain('safety');
        expect(cardsToAsk(EVERY, [], words)).toContain('safety');
        expect(draw(words, EVERY, ctx({ safetyUp: true }))).toContain('safety');
        expect(draw(inviteOnly, EVERY, ctx({ safetyUp: true }))).not.toContain('safety');
        // A covered member is still asked for it: the phone's card is mounted from the list and only Home's word ("covered",
        // words false) marks its record linked and puts it away (OneWayBackCard, utils/one-way-back.ts oneWayBackFromNode).
        const covered = { ...inviteOnly, me: { ...inviteOnly.me!, wayBack: 'covered' as const } };
        expect(cardsToAsk(EVERY, [], covered)).toContain('safety');
        expect(safetyWord(covered, ['safety'])).toEqual({ words: false, joinedAt: NOW - 2 * 24 * H });
    });

    // Review of #3114, round 2, finding 2: the account's say-so (`me.wordsKept`, sent on every answer of the member's own)
    // outlives First steps, whose `steps` the node stops sending once every line is done or its days are up.
    it('a kept say-so on the account (me.wordsKept) ends the card with no First steps sent: day 15 on global, every line done on a local community', () => {
        const base = answer({ features: { ...answer().features, wordsDoor: false } });
        const day15 = { ...base, profile: 'global', me: { ...base.me!, joinedAt: iso(NOW - 15 * 24 * H), wayBack: 'words' as const, wordsKept: true } };
        expect(day15.cards.steps).toBeUndefined();
        expect(safetyWord(day15, ['safety'])).toEqual({ words: true, joinedAt: NOW - 15 * 24 * H, door: false, kept: true });
        expect(safetyWord({ ...day15, me: { ...day15.me, wordsKept: false } }, ['safety'])).toMatchObject({ words: true, kept: false });
        expect(safetyWord({ ...day15, me: { ...day15.me, wordsKept: undefined } }, ['safety'])).toMatchObject({ words: true, kept: false });
        const allDone = { ...base, me: { ...base.me!, wayBack: 'words' as const, wordsKept: true } };
        expect(safetyWord(allDone, ['safety'])).toMatchObject({ words: true, kept: true });
        // Only `true` says so: anything else off the network is not a say-so.
        expect(safetyWord({ ...allDone, me: { ...allDone.me, wordsKept: 'yes' as never } }, ['safety'])).toMatchObject({ kept: false });
        // The 12-words door's own member too (the node's card, "Add a sign-in" offered).
        const door = { ...day15, cards: { ...day15.cards, safety: { words: true as const, signInLinked: false as const } } };
        expect(safetyWord(door, ['safety'])).toMatchObject({ words: true, door: true, kept: true });
        // It comes through the phone's reading of the answer, and a covered account has no reminder whatever it said.
        const read = readHomeAnswer(JSON.parse(JSON.stringify(day15)))!;
        expect(read.me?.wordsKept).toBe(true);
        expect(safetyWord(read, ['safety'])).toMatchObject({ kept: true });
        expect(safetyWord({ ...day15, me: { ...day15.me, wayBack: 'covered' as const } }, ['safety'])).toEqual({ words: false, joinedAt: NOW - 15 * 24 * H });
    });

    it('a kept say-so on the account (me.wordsKept) ticks First steps\' "Keep your 12 words safe", so the card ends when it was the last line', () => {
        const lastLine = steps({ firstOffer: true, photo: true, interests: true, invited: true, firstNeed: true, words: false });
        const me = { ...answer().me!, wayBack: 'words' as const };
        const notSaid = answer({ me: { ...me, wordsKept: false }, cards: { steps: lastLine } });
        expect(firstSteps(notSaid, { interests: [], now: NOW }).left.map(l => l.id)).toEqual(['words']);
        expect(firstSteps(notSaid, { interests: [], now: NOW }).show).toBe(true);
        const said = answer({ me: { ...me, wordsKept: true }, cards: { steps: lastLine } });
        expect(firstSteps(said, { interests: [], now: NOW }).lines.find(l => l.id === 'words')?.done).toBe(true);
        expect(firstSteps(said, { interests: [], now: NOW }).left).toEqual([]);
        expect(firstSteps(said, { interests: [], now: NOW }).show).toBe(false);
        // A line still open elsewhere keeps the card; the words line alone is ticked, and the count says so.
        const open = answer({ me: { ...me, wordsKept: true }, cards: { steps: steps({ words: false }) } });
        expect(firstSteps(open, { interests: [], now: NOW }).left.map(l => l.id)).not.toContain('words');
        expect(firstSteps(open, { interests: [], now: NOW }).show).toBe(true);
        // The global first week's last line too.
        const global = answer({ profile: 'global', me: { ...me, wordsKept: true }, cards: { steps: steps({ words: false }) } });
        expect(firstSteps(global, { interests: [], now: NOW }).lines.find(l => l.id === 'words')?.done).toBe(true);
        // A covered account has no such line (`steps.words` null), whatever it said.
        const covered = answer({ me: { ...me, wayBack: 'covered' as const, wordsKept: true }, cards: { steps: steps({ words: null }) } });
        expect(firstSteps(covered, { interests: [], now: NOW }).lines.some(l => l.id === 'words')).toBe(false);
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

    // Capacity rehearsal 7 Nov (scratch/global-node/REPORT-global-load-rehearsal-2026-11-07.md §8 fix 2): the bell that reaches
    // every phone near a listing waits this device's own random 3 to 15 s, not the same 3 s on all of them.
    describe('a crowd\'s bell: a random turn of 3 to 15 s, per device', () => {
        const ME = 'm'.repeat(64);
        const OTHER = 'o'.repeat(64);
        const listing = (author: string, extra: Record<string, unknown> = {}) => ({
            type: 'new_post', post: { id: 'post-1', type: 'event', authorPublicKey: author, updatedAt: '2026-10-28T06:00:00.000Z', audienceScope: 'public', ...extra },
        });
        const device = (random: () => number, run = vi.fn()) => {
            const crowd = { is: (d: unknown) => homeCrowdFor(() => ME).is(d), delayMs: () => crowdBellDelayMs(random) };
            return { run, bell: createDoorbellDebounce(run, HOME_DOORBELL_SETTLE_MS, undefined, d => isHomeDoorbellFor(d, ME), crowd) };
        };
        const fake = (fn: () => void) => { vi.useFakeTimers(); try { fn(); } finally { vi.useRealTimers(); } };

        it('is read once, at this device\'s own draw: not before 3 s, and no later than 15 s', () => fake(() => {
            for (const [draw, ms] of [[0, 3_000], [0.25, 6_000], [0.5, 9_000], [0.9999999, 15_000]] as const) {
                const { run, bell } = device(() => draw);
                bell.ring(listing(OTHER));
                vi.advanceTimersByTime(ms - 1);
                expect(run).not.toHaveBeenCalled();
                vi.advanceTimersByTime(1);
                expect(run).toHaveBeenCalledTimes(1);
                vi.advanceTimersByTime(60_000);
                expect(run).toHaveBeenCalledTimes(1);
            }
        }));

        it('two devices that draw differently read at different moments (the spread), and the same listing rings them both', () => fake(() => {
            const a = device(() => 0.1);
            const b = device(() => 0.9);
            a.bell.ring(listing(OTHER));
            b.bell.ring(listing(OTHER));
            vi.advanceTimersByTime(4_500);
            expect(a.run).toHaveBeenCalledTimes(1);
            expect(b.run).not.toHaveBeenCalled();
            vi.advanceTimersByTime(10_000);
            expect(b.run).toHaveBeenCalledTimes(1);
        }));

        it('each burst draws again: a bell after the read has its own turn', () => fake(() => {
            const draws = [0, 0.5];
            const { run, bell } = device(() => draws.shift() ?? 0.5);
            bell.ring(listing(OTHER));
            vi.advanceTimersByTime(3_000);
            expect(run).toHaveBeenCalledTimes(1);
            bell.ring(listing(OTHER, { id: 'post-2' }));
            vi.advanceTimersByTime(8_999);
            expect(run).toHaveBeenCalledTimes(1);
            vi.advanceTimersByTime(1);
            expect(run).toHaveBeenCalledTimes(2);
        }));

        it('is not pushed back by more bells: a run of them cannot hold the read off, and still costs one read', () => fake(() => {
            const { run, bell } = device(() => 0.5);              // 9 s
            for (let i = 0; i < 8; i++) { bell.ring(listing(OTHER, { id: `post-${i}` })); vi.advanceTimersByTime(1_000); }
            expect(run).not.toHaveBeenCalled();                   // 8 s in
            vi.advanceTimersByTime(1_000);
            expect(run).toHaveBeenCalledTimes(1);                 // 9 s: the first bell's turn
            vi.advanceTimersByTime(30_000);
            expect(run).toHaveBeenCalledTimes(1);
        }));

        it('a bell about the member themself still waits 3 s after the last, and a crowd\'s turn does not delay it', () => fake(() => {
            const { run, bell } = device(() => 0.9);              // 13.8 s
            bell.ring(listing(OTHER));
            bell.ring(listing(ME));                               // their own listing: a person, not a crowd
            vi.advanceTimersByTime(2_000);
            bell.ring({ type: 'transaction_completed' });         // pushes it back, as before
            vi.advanceTimersByTime(2_999);
            expect(run).not.toHaveBeenCalled();
            vi.advanceTimersByTime(1);
            expect(run).toHaveBeenCalledTimes(1);
            vi.advanceTimersByTime(30_000);                       // that read covered the crowd's too
            expect(run).toHaveBeenCalledTimes(1);
        }));

        it('a crowd\'s read covers a bell about the member that rang just before it', () => fake(() => {
            const { run, bell } = device(() => 0);                // 3 s
            bell.ring({ type: 'transaction_completed' });         // due at 3 s
            vi.advanceTimersByTime(1_000);
            bell.ring(listing(OTHER));                            // due at 4 s
            vi.advanceTimersByTime(2_000);
            expect(run).toHaveBeenCalledTimes(1);                 // 3 s: the member's own
            vi.advanceTimersByTime(30_000);
            expect(run).toHaveBeenCalledTimes(1);
        }));

        it('cancel drops a crowd\'s read too, and the bells Home does not care about set nothing', () => fake(() => {
            const { run, bell } = device(() => 0);
            bell.ring(listing(OTHER));
            bell.cancel();
            bell.ring({ type: 'new_message' });
            bell.ring({ type: 'pong' });
            vi.advanceTimersByTime(60_000);
            expect(run).not.toHaveBeenCalled();
        }));

        it('Home\'s own crowd rule asks for the member\'s key as it is now, and draws from 3 s to 15 s', () => {
            let key: string | null = ME;
            const crowd = homeCrowdFor(() => key);
            expect(crowd.is(listing(OTHER))).toBe(true);
            key = OTHER;                                          // another account on the phone: the listing is theirs
            expect(crowd.is(listing(OTHER))).toBe(false);
            for (let i = 0; i < 500; i++) {
                const d = crowd.delayMs();
                expect(d).toBeGreaterThanOrEqual(3_000);
                expect(d).toBeLessThanOrEqual(15_000);
            }
        });
    });
});

describe('what a node can show, and where the Decide card leads (PR #1483 review 4165383429, 4165384151)', () => {
    const LOCAL = { profile: 'local', features: { beans: true, escrow: true, enterprises: true, invites: true, decisions: true } };
    const GLOBAL = { profile: 'global', features: { beans: false, escrow: false, enterprises: false, invites: false, decisions: false } };

    it('the money cards and the invite card only where the node has them; Find your community only on the global node, First steps on both', () => {
        const on = (n: typeof LOCAL) => HOME_V1_CARD_IDS.filter(id => cardOnNode(id, n));
        expect(on(LOCAL)).toEqual(HOME_V1_CARD_IDS.filter(id => id !== 'find'));
        // Core's one rule (CARD-FRAME §1.2): no Beans, deals, enterprise, Decide or invites on the worldwide community.
        expect(on(GLOBAL)).toEqual(['needs', 'safety', 'find', 'steps', 'tips', 'interests', 'events', 'market', 'groups', 'joined', 'pulse', 'notices', 'community']);
        // A node that says nothing has everything, as every node before the switches.
        expect(on({ profile: 'local', features: { invites: true } } as typeof LOCAL)).toEqual(on(LOCAL));
    });

    it('Home never draws a card its node can\'t show, whatever the answer holds', () => {
        const a = answer({
            profile: 'global', features: GLOBAL.features,
            cards: {
                beans: { balance_c: 500, room_c: 0, tier: 'Newcomer', activated: true, frozen: false },
                deals: { open: 1, waiting: 1, waitingOnMe: null },
                enterprise: { id: 'x', name: 'T', requests: 1, others: 0 },
                decide: { open: 2, soonestClosesAt: null, polls: 0, pollsMore: false },
                community: { name: 'BeanPool', members: 2, communities: 1 },
            },
        });
        expect(draw(a, EVERY, ctx({ interests: ['food'] }))).toEqual(['community']);
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
        // A node with Beans off but Decisions on: Commons tab stays, Decision row reaches Decide.
        expect(decideLines(card, { beans: false, decisions: true }, NOW).map(l => l.id)).toEqual(['decisions', 'polls']);
        expect(decideLines(card, { beans: false }, NOW).map(l => l.id)).toEqual(['decisions', 'polls']);
        expect(decideOnNode({ beans: false, decisions: true })).toBe(true);
        expect(decideOnNode({ beans: false })).toBe(true);
        // A node with Beans off and Decisions off: no Decisions line.
        expect(decideLines(card, { beans: false, decisions: false }, NOW).map(l => l.id)).toEqual(['polls']);
        expect(decideOnNode({ beans: false, decisions: false })).toBe(false);
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
            expect(draw(known(), EVERY, ctx({ interests: ['food'], role })), String(role)).toEqual(['community']);
            expect(cardOnNode('invite', known(), role), String(role)).toBe(false);
        }
        // The node sends `invited: false` there whatever the door (routes/home-answer.ts): the phone leaves the line out.
        expect(stepLines(known().cards.steps!, true, false).map(l => l.id)).toEqual(['offer', 'photo', 'interests']);
        // With a photo still to add, First steps stays for that, and still has no invite line to press.
        const photoLeft = known({ cards: { ...known().cards, steps: steps({ firstOffer: true, photo: false, interests: true, invited: false }) } });
        expect(draw(photoLeft, EVERY, ctx({ interests: ['food'], role: null }))).toEqual(['steps', 'community']);
    });

    it('an owner or admin there: the card and the step, as before', () => {
        for (const role of ['owner', 'admin'] as const) {
            expect(draw(known(), EVERY, ctx({ interests: ['food'], role }))).toEqual(['steps', 'invite', 'community']);
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
            expect(draw(a, EVERY, ctx({ interests: ['food'] }))).toEqual(['steps', 'invite', 'community']);
        }
        // Invites off (the node then sends `invited: null`): neither, whatever the role.
        const off = known({ features: { ...known().features, invites: false }, cards: { ...known().cards, steps: steps({ firstOffer: true, photo: true, interests: true, invited: null }) } });
        expect(draw(off, EVERY, ctx({ interests: ['food'], role: 'owner' }))).toEqual(['community']);
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
        expect(draw(a, hidesFind, ctx({ interests: ['food'], now: NOW }))).toEqual(['find', 'market', 'events', 'community']);
        expect(draw(a, EVERY, ctx({ interests: ['food'], now: NOW }))[0]).toBe('find');
        expect(canRemoveCard('find', pins)).toBe(false);
        expect(canMoveCard('find', pins)).toBe(false);
        expect(removeCard(EVERY, 'find', NOW, pins)).toBeNull();
        expect(ids(cardOrder(hidesFind, pins))).toContain('find');
        expect(moveCard(EVERY, 'find', 'down', inst('find', 'events', 'market'), NOW, pins)).toBeNull();
        // Nothing moves up past it: the card under it has no movable card above it on screen.
        expect(moveCard(null, 'events', 'up', inst('needs', 'find', 'events', 'market', 'community'), NOW, pins)).toBeNull();
        // Asked for even where the layout hides it, so the node builds it.
        expect(cardsToAsk(hidesFind, pins)).toContain('find');
        // The last moment of day 30 is still pinned; a join date the node didn't send counts as pinned (the node's rule).
        expect(findPinned(member(FIND_PINNED_DAYS - 0.001), NOW)).toBe(true);
        expect(findPinned(member(null), NOW)).toBe(true);
    });

    it('after 30 days it is a card like any other: hidden from its "…", moved, and not asked for once hidden', () => {
        const a = member(FIND_PINNED_DAYS + 1);
        expect(findPinned(a, NOW)).toBe(false);
        const pins = pinnedCards(a, NOW);
        expect(pins).toEqual([]);
        expect(canRemoveCard('find', pins)).toBe(true);
        const hidden = removeCard(EVERY, 'find', NOW, pins)!;
        expect(ids(hidden.cards)).not.toContain('find');
        expect(draw(a, hidden, ctx({ interests: ['food'], now: NOW }))).toEqual(['events', 'market', 'community']);
        expect(cardsToAsk(hidden, pins)).not.toContain('find');
        expect(draw(a, EVERY, ctx({ interests: ['food'], now: NOW }))).toEqual(['find', 'events', 'market', 'community']);
        // It moves now.
        const down = moveCard(EVERY, 'find', 'down', inst('needs', 'find', 'events', 'market', 'community'), NOW, pins)!;
        expect(draw(a, down, ctx({ interests: ['food'], now: NOW }))).toEqual(['events', 'find', 'market', 'community']);
    });

    it('a newcomer with no wait keeps Find as before L1: pinned, drawn first and asked for from the starter list, on day 3 and on the last day (Lounge L1, review of #2573)', () => {
        for (const days of [3, FIND_PINNED_DAYS - 0.001, null]) {
            const a = member(days);
            expect(pinnedCards(a, NOW)).toEqual(['find']);
            // The starter list and the newcomer's list hold no `find`: the pin is the only thing that draws and asks for it.
            expect(draw(a, STARTER, ctx({ interests: ['food'], now: NOW }))[0]).toBe('find');
            expect(draw(a, null, ctx({ interests: ['food'], now: NOW }))).toContain('find');
            expect(cardsToAsk(STARTER, askPinned(a, NOW), a)).toContain('find');
            expect(cardsToAsk(null, askPinned(a, NOW), a)).toContain('find');
        }
        expect(findPinned(member(3), NOW, { hasOpenKnock: false, hasOpenWatch: false, knocks: [] })).toBe(true);
    });

    it('a wait keeps Find past day 30: an open knock or a watch pins it, draws it and has it asked for, from a list that does not hold it (Lounge L1, review of #2573)', () => {
        const gone = member(FIND_PINNED_DAYS + 10);
        // No wait: past the pin it is a card like any other, so a list without it neither draws nor asks for it.
        expect(pinnedCards(gone, NOW)).toEqual([]);
        expect(draw(gone, STARTER, ctx({ interests: ['food'], now: NOW }))).not.toContain('find');
        expect(cardsToAsk(STARTER, askPinned(gone, NOW), gone)).not.toContain('find');

        // A knock open on day 40: pinned from the knock the phone remembers, and asked for with that same context.
        const knocks = [{ url: 'https://byron.example.org', sentAt: iso(NOW - 5 * H) }];
        expect(pinnedCards(gone, NOW, { knocks })).toEqual(['find']);
        expect(askPinned(gone, NOW, { knocks })).toEqual(['find']);
        // The real path the screen takes: the layout lacks `find`, so `cards=` carries it only when the knock is passed on.
        expect(cardsToAsk(STARTER, askPinned(gone, NOW), gone)).not.toContain('find');
        expect(cardsToAsk(STARTER, askPinned(gone, NOW, { knocks }), gone)).toContain('find');
        expect(cardsToAsk(null, askPinned(gone, NOW, { hasOpenKnock: true }), gone)).toContain('find');
        expect(draw(gone, STARTER, ctx({ interests: ['food'], now: NOW, knocks }))[0]).toBe('find');

        // A watch the answer carries pins it without a knock.
        const watching = member(FIND_PINNED_DAYS + 10, { cards: { find: find({ watches: [{ point: 'area', radiusKm: 25 }] }), market: market(2), events, community: { name: 'BeanPool', members: 2310, communities: 38 } } });
        expect(pinnedCards(watching, NOW)).toEqual(['find']);
        expect(cardsToAsk(STARTER, askPinned(watching, NOW), watching)).toContain('find');

        // A cancelled knock, or one past the days it can be answered, is no wait.
        expect(pinnedCards(gone, NOW, { knocks: [{ ...knocks[0], cancelledAt: iso(NOW - 2 * H) }] })).toEqual([]);
        expect(pinnedCards(gone, NOW, { knocks: [{ url: knocks[0].url, sentAt: iso(NOW - 62 * 24 * H) }] })).toEqual([]);
        // A local node never pins it.
        expect(pinnedCards({ ...gone, profile: 'local' }, NOW, { knocks })).toEqual([]);
    });

    it('pinned: under Needs you, and under "Your way back in" while that one leads; after the pin it is the picker\'s, like any card', () => {
        const pins: ['find'] = ['find'];
        expect(ids(cardOrder(STARTER, pins)).slice(0, 4)).toEqual(['needs', 'safety', 'find', 'market']);
        // A newcomer's Home: the pin under Needs you, then the default list, Welcome first (DESIGN-home-default-fable.md §2.9).
        expect(ids(cardOrder(null, pins))).toEqual(['needs', 'find', ...HOME_DEFAULT_LIST, 'community']);
        expect(ids(cardOrder(layout({ order: ['market', 'events'] }), pins)).slice(0, 4)).toEqual(['needs', 'find', 'market', 'events']);
        expect(ids(cardOrder(layout({ order: ['safety', 'market', 'find'] }), pins)).slice(0, 4)).toEqual(['needs', 'safety', 'find', 'market']);
        expect(ids(cardOrder(STARTER, pins)).at(-1)).toBe('community');
        // A move made during the pin moves the two cards and nothing else.
        const moved = moveCard(STARTER, 'market', 'up', inst('find', 'events', 'market'), NOW, pins)!;
        // First steps and What are you into? are in the starter set but not among the cards this test draws (inst(...) above):
        // they stay where they were, between the two (the default list, DESIGN-home-default-fable.md §2.2).
        expect(ids(moved.cards)).toEqual(['safety', 'events', 'steps', 'interests', 'market', 'pulse', 'beans', 'asked', 'deals', 'groups', 'decide', 'notices', 'joined', 'tips', 'sky']);
        // The newcomer's list doesn't hold `find`: once the pin ends, the picker brings it back (CARD-FRAME §1.2, §3).
        expect(ids(cardOrder(moved))).not.toContain('find');
        expect(ids(cardOrder(EVERY))).toContain('find');
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
        expect(draw(local, EVERY, ctx({ interests: ['food'], now: NOW }))).toEqual(['community']);
        // A body that isn't one is no card.
        expect(isFindCard({ communities: 'nope' })).toBe(false);
        expect(draw(member(3, { cards: { find: { anything: true } as never, community: { name: 'G', members: 9 } } }), EVERY, ctx({ interests: ['food'], now: NOW }))).toEqual(['community']);
    });

    it('The first week global words: seven real steps (§3.2, L3)', () => {
        expect(globalStepLines(steps()).map(l => l.id)).toEqual([
            'name', 'area', 'photo', 'sawLedger', 'post', 'saidHello', 'watch',
        ]);
        expect(globalStepLines(steps())).toEqual([
            { id: 'name', text: 'Choose a name', done: true },
            { id: 'area', text: 'Say roughly where you are', done: false },
            { id: 'photo', text: 'Add a picture (a preset counts)', done: false },
            { id: 'sawLedger', text: 'Look at an example Ledger', done: false },
            { id: 'post', text: 'Post something free or for swap', done: false },
            { id: 'saidHello', text: 'Say hello to someone near you', done: false },
            { id: 'watch', text: "Tell me when a community starts here, or say you'd help start one", done: false },
        ]);
        expect(globalStepLines(steps({ area: true, photo: true, sawLedger: true, firstPost: true, saidHello: true, watch: true })).every(l => l.done)).toBe(true);
        const g = firstSteps(member(3, { cards: { steps: steps(), find: find(), community: { name: 'G', members: 9 } } }), { interests: [], knocked: false });
        expect(g.lines.map(l => l.text)).toEqual([
            'Choose a name',
            'Say roughly where you are',
            'Add a picture (a preset counts)',
            'Look at an example Ledger',
            'Post something free or for swap',
            'Say hello to someone near you',
            "Tell me when a community starts here, or say you'd help start one",
        ]);
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
        // On the card: under the lines, and the card stays while young and lines are undone.
        const posted = member(1, { me: { ...member(1).me!, probation: words }, cards: { steps: steps({ firstPost: true }), find: find(), community: { name: 'G', members: 9 } } });
        const lines = globalStepLines(steps({ firstPost: true }));
        // Only what is left is drawn, with "n of m done" (DESIGN-home-default-fable.md §2.4, slice D2).
        expect(firstSteps(posted, { interests: ['food'], knocked: true, now: NOW })).toEqual({
            lines, left: lines.filter(l => !l.done), count: `${lines.filter(l => l.done).length} of ${lines.length} done`,
            note: 'For your first 7 days: 2 posts and 3 new chats a day.', show: true,
        });
        expect(draw(posted, EVERY, ctx({ interests: ['food'], knocked: true, now: NOW }))).toContain('steps');
        // The steps all done: card ends after 14 days or all done (§3.2, L3).
        const allDoneSteps = steps({ area: true, photo: true, sawLedger: true, firstPost: true, saidHello: true, watch: true });
        const done = member(1, { cards: { steps: allDoneSteps, find: find(), community: { name: 'G', members: 9 } } });
        expect(firstSteps(done, { interests: ['food'], knocked: false, now: NOW }).show).toBe(false);
        expect(draw(done, EVERY, ctx({ interests: ['food'], now: NOW }))).not.toContain('steps');
        // A local community's First steps never says the limits (unchanged from H2).
        expect(firstSteps(answer({ me: { ...answer().me!, probation: words }, cards: { steps: steps() } }), { interests: [] }).note).toBeNull();
    });

    it('The first week card ends after 14 days or all done on global (§3.2, L3)', () => {
        const undone = (days: number) => member(days, { cards: { steps: steps({ firstPost: false, joinedAt: iso(NOW - days * DAY) }), find: find(), community: { name: 'G', members: 9 } } });
        const allDone = (days: number) => member(days, {
            cards: {
                steps: steps({
                    joinedAt: iso(NOW - days * DAY),
                    area: true,
                    photo: true,
                    sawLedger: true,
                    firstPost: true,
                    saidHello: true,
                    watch: true,
                }),
                find: find(),
                community: { name: 'G', members: 9 },
            },
        });
        // Day 3, undone: card shows
        expect(firstSteps(undone(3), { interests: ['food'], knocked: true, now: NOW }).show).toBe(true);
        expect(draw(undone(3), EVERY, ctx({ interests: ['food'], knocked: true, now: NOW }))).toContain('steps');

        // Day 3, all done: card ends immediately even though young
        expect(firstSteps(allDone(3), { interests: ['food'], knocked: true, now: NOW }).show).toBe(false);
        expect(draw(allDone(3), EVERY, ctx({ interests: ['food'], knocked: true, now: NOW }))).not.toContain('steps');

        // Day 13.9, undone: card shows
        expect(firstSteps(undone(13.9), { interests: ['food'], knocked: true, now: NOW }).show).toBe(true);

        // Day 14 on, undone: card ends because 14 days have passed
        expect(firstSteps(undone(14), { interests: ['food'], knocked: true, now: NOW }).show).toBe(false);
        expect(draw(undone(14), EVERY, ctx({ interests: ['food'], knocked: true, now: NOW }))).not.toContain('steps');

        // A join date the node didn't send is not young: card ends
        expect(firstSteps(member(null, { cards: { steps: steps({ firstPost: false, joinedAt: null }) } }), { interests: ['food'], knocked: true, now: NOW }).show).toBe(false);
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

    it('a live pin leads whatever the distance and the stars say (Home slice 4); the rest keep their order', () => {
        const items = [
            { id: 'near', category: 'tools', distanceKm: 0.4 },
            { id: 'mid', category: 'food', distanceKm: 5 },
            { id: 'far-pin', category: 'goods', distanceKm: 900, pinned: true },
            { id: 'pin-2', category: 'arts', distanceKm: null, pinned: true },
        ];
        expect(marketInOrder(items, ['food'], 'global').map(i => i.id)).toEqual(['far-pin', 'pin-2', 'mid', 'near']);
        expect(marketInOrder(items, ['food'], 'local').map(i => i.id)).toEqual(['far-pin', 'pin-2', 'mid', 'near']);
        // Nothing pinned: the order is exactly what it was.
        expect(marketInOrder(items.map(({ pinned: _p, ...i }) => i), ['food'], 'local').map(i => i.id)).toEqual(['mid', 'near', 'far-pin', 'pin-2']);
    });
});

describe('the phone\'s own marked save, read back (review of #1701 confirmation, finding 2; review of #1715, finding 1; the web app\'s home-layout.test.ts)', () => {
    const sent: HomeLayout = {
        v: 2, updatedAt: iso(NOW),
        cards: [{ id: 'beans', type: 'beans' }, { id: 'search-aaaa', type: 'search', settings: { q: 'eggs', kind: 'any' } }],
        dismissed: { safety: iso(NOW - 2 * H) },
    };
    // As the node answers it: its keys in another order, its date held to the node's now.
    const answered = (at: number): HomeLayout => ({
        updatedAt: iso(at), dismissed: { safety: iso(NOW - 2 * H) }, v: 2,
        cards: [{ type: 'beans', id: 'beans' }, { settings: { kind: 'any', q: 'eggs' }, type: 'search', id: 'search-aaaa' }],
    });

    it('a list prints alike whatever its keys\' order and its date, and differently for another list', () => {
        expect(layoutPrint(sent)).toMatch(/^[0-9a-f]{16}$/);
        expect(layoutPrint(answered(NOW - 5_000))).toBe(layoutPrint(sent));
        expect(sameList(sent, answered(NOW + H))).toBe(true);
        expect(sameList(sent, { ...sent, cards: [...sent.cards].reverse() })).toBe(false);
        expect(sameList(sent, { ...sent, dismissed: {} })).toBe(false);
        expect(sameList(sent, { ...sent, cards: [sent.cards[0], { ...sent.cards[1], settings: { q: 'jam', kind: 'any' } }] })).toBe(false);
    });

    it('the columns the member chose on the web are in the print, as the web app prints them; a Home that never chose prints as before (W0)', () => {
        // The web app's home-layout.test.ts list, pinned before W0 there: the phone prints it alike, and every kept mark still matches.
        const before: HomeLayout = {
            v: 2, updatedAt: null, dismissed: { safety: '2026-10-02T02:00:00.000Z' },
            cards: [{ id: 'beans', type: 'beans' }, { id: 'search-aaaa', type: 'search', settings: { q: 'eggs', kind: 'any' } }],
        };
        expect(layoutPrint(before)).toBe('3be262bd5e15eebf');
        const two: HomeLayout = { ...sent, view: { columns: 2 } };
        expect(sameList(sent, two)).toBe(false);
        expect(sameList(two, { ...two, view: { columns: 1 } })).toBe(false);
        expect(sameList(two, { ...answered(NOW - 5_000), view: { columns: 2 } })).toBe(true);
    });

    it('the same list dated as sent or earlier is the phone\'s; dated later, another list, or a version-1 answer is not', () => {
        const marks = rememberMarkSent([], sent);
        expect(marks).toEqual([{ at: iso(NOW), print: layoutPrint(sent) }]);
        expect(ownMarkedSave(answered(NOW), undefined, marks)).toBe(true);
        expect(ownMarkedSave(answered(NOW - 200), undefined, marks)).toBe(true);
        expect(ownMarkedSave(answered(NOW - H), undefined, marks)).toBe(true);
        expect(ownMarkedSave(answered(NOW + 1), undefined, marks)).toBe(false);
        expect(ownMarkedSave({ ...answered(NOW - 200), dismissed: {} }, undefined, marks)).toBe(false);
        expect(ownMarkedSave(answered(NOW - 200), { empty: false }, marks)).toBe(false);
        expect(ownMarkedSave(answered(NOW - 200), undefined, [])).toBe(false);
    });

    it('an entry an older build kept (a date alone) still loads and matches by its date only; at most the latest eight', () => {
        const old = readMarkSent([iso(NOW), 7, 'x'.repeat(41), { at: iso(NOW - H), print: 'not-a-print' }, null]);
        expect(old).toEqual([{ at: iso(NOW) }, { at: iso(NOW - H) }]);
        expect(ownMarkedSave(answered(NOW), undefined, old)).toBe(true);
        expect(ownMarkedSave(answered(NOW - 200), undefined, old)).toBe(false);
        expect(ownMarkedSave(answered(NOW - 200), undefined, readMarkSent(JSON.parse(JSON.stringify(rememberMarkSent(old, sent)))))).toBe(true);
        let marks = rememberMarkSent([], sent);
        for (let i = 1; i <= 10; i++) marks = rememberMarkSent(marks, { ...sent, updatedAt: iso(NOW + i) });
        expect(marks).toHaveLength(MARK_SENT_MAX);
        expect(marks[0].at).toBe(iso(NOW + 3));
        expect(readMarkSent('nope')).toEqual([]);
    });
});

describe("a saved search's kept answer is only for the search the card holds now (review of #1716, finding 2; the web app's lib/home-cards.test.ts)", () => {
    const inst = { id: 'search-k2x7', settings: { q: 'eggs', kind: 'any', km: 5 } };
    const body = { q: 'eggs', kind: 'any', category: null, km: 5, more: true, items: [{ id: 'p1', type: 'offer', title: 'Fresh eggs', category: 'food', photoUrl: null }] };
    const withCard = (c: unknown) => ({ cards: { 'search-k2x7': c } } as unknown as HomeAnswer);

    it('the same words, kind, category and distance: the rows', () => {
        expect(searchCardFor(withCard(body), inst)).toEqual(body);
        const tools = { ...body, kind: 'need', category: 'tools', km: 10 };
        expect(searchCardFor(withCard(tools), { ...inst, settings: { q: 'eggs', kind: 'need', category: 'tools', km: 10 } })).toEqual(tools);
    });

    it('another kind, category or distance: no body, so the card says it shows when the community answers', () => {
        expect(searchCardFor(withCard({ ...body, kind: 'offer' }), inst)).toBeNull();
        expect(searchCardFor(withCard({ ...body, category: 'food' }), inst)).toBeNull();
        expect(searchCardFor(withCard({ ...body, km: 25 }), inst)).toBeNull();
        expect(searchCardFor(withCard(body), { ...inst, settings: { q: 'eggs', kind: 'need', km: 5 } })).toBeNull();
        expect(searchCardFor(withCard(body), { ...inst, settings: { q: 'eggs', kind: 'any' } })).toBeNull();
    });

    it('km null (the node had no point and ignored the distance) answers whatever distance is kept', () => {
        expect(searchCardFor(withCard({ ...body, km: null }), { ...inst, settings: { q: 'eggs', kind: 'any', km: 25 } })).toEqual({ ...body, km: null });
    });
});

describe('sun and moon (CARD-FRAME §4, §5.2 item 22)', () => {
    const MULLUM = { lat: -28.55, lng: 153.5 };
    const AREA = { lat: -37.07, lng: 144.22 };
    const PHONE = { lat: 64.15, lng: -21.94 };
    const sky = (settings?: Record<string, unknown>): HomeLayout => ({ v: 2, cards: [{ id: 'sky', type: 'sky', ...(settings ? { settings } : {}) }], dismissed: {}, updatedAt: iso(NOW) });
    const placed = (community: typeof MULLUM | null, area: typeof MULLUM | null) => answer({
        me: { ...answer().me!, area },
        cards: { community: { name: 'Mullumbimby', members: 81, ...(community ? { place: community } : {}) } },
    });

    it("works from the community's place, else the member's area, else the phone's; 'me' puts the member's first", () => {
        expect(skyOf(placed(MULLUM, AREA), {}, PHONE, NOW)!.place).toEqual(MULLUM);
        expect(skyOf(placed(null, AREA), {}, PHONE, NOW)!.place).toEqual(AREA);
        expect(skyOf(placed(null, null), {}, PHONE, NOW)!.place).toEqual(PHONE);
        expect(skyOf(placed(null, null), {}, null, NOW)).toBeNull();
        expect(skyOf(placed(MULLUM, AREA), { settings: { place: 'me' } }, PHONE, NOW)!.place).toEqual(AREA);
        expect(skyOf(placed(MULLUM, null), { settings: { place: 'me' } }, PHONE, NOW)!.place).toEqual(PHONE);
        expect(skyOf(placed(MULLUM, AREA), { settings: { place: 'mars' } }, null, NOW)!.place).toEqual(MULLUM);
        expect(skyOf(placed(MULLUM, null), {}, null, NOW)!.text).toBe(skyToday(MULLUM, NOW).text);
    });

    it('is drawn only where a place is known, and never asked of the node', () => {
        expect(draw(placed(MULLUM, null), sky(), ctx())).toContain('sky');
        expect(draw(placed(null, AREA), sky(), ctx())).toContain('sky');
        expect(draw(placed(null, null), sky(), ctx({ place: PHONE }))).toContain('sky');
        expect(draw(placed(null, null), sky(), ctx())).not.toContain('sky');
        expect(cardsToAsk(sky(), [], placed(MULLUM, null))).not.toContain('sky');
    });

    it('the picker offers it under Around you on a local community and the worldwide one, with its settings sheet', () => {
        for (const node of [{ profile: 'local', features: {} }, { profile: 'global', features: { beans: false, escrow: false, enterprises: false, invites: false, decisions: false } }]) {
            const g = pickerGroups(node, { v: 2, cards: [], dismissed: {}, updatedAt: iso(NOW) }, null);
            const around = g.groups.find(x => x.id === 'around')!;
            expect(around.rows.find(r => r.type === 'sky'), node.profile).toMatchObject({ name: 'Sun and moon', line: 'Sunrise, sunset and the moon tonight.', state: 'add', hasSettings: true });
            // In the default list (DESIGN-home-default-fable.md §2.2): on a newcomer's Home already.
            expect(pickerGroups(node, null, null).groups.flatMap(x => x.rows).find(r => r.type === 'sky')!.state, node.profile).toBe('on-home');
            expect(pickerGroups(node, sky(), null).groups.flatMap(x => x.rows).find(r => r.type === 'sky')!.state).toBe('on-home');
        }
        expect(HOME_DRAWN.has('sky')).toBe(true);
    });
});

describe('the cards Arrange folds (DESIGN-home-layout-fable.md §3.2)', () => {
    const order = [{ id: 'needs', type: 'needs' }, { id: 'market', type: 'market' }, { id: 'sky', type: 'sky' }, { id: 'chat', type: 'chat' }, { id: 'community', type: 'community' }];
    const onNode = (type: string) => type !== 'chat';

    it('what is drawn, and every other card on the list this node can show, in the list\'s order', () => {
        expect(arrangeCards(order, [{ id: 'market' }, { id: 'community' }], onNode).map(c => c.id)).toEqual(['market', 'sky', 'community']);
    });

    it('a fixed card or a pin only while it is drawn', () => {
        expect(arrangeCards(order, [{ id: 'needs' }, { id: 'community' }], onNode).map(c => c.id)).toEqual(['needs', 'market', 'sky', 'community']);
        expect(arrangeCards([{ id: 'find', type: 'find' }, ...order], [], () => true, ['find']).map(c => c.id)).toEqual(['market', 'sky', 'chat']);
    });

    it("a folded card's line is the catalogue's; a type nobody knows has none", () => {
        expect(cardLine('events')).toBe('Events coming up soon.');
        expect(cardLine('future-card')).toBe('');
    });
});

// ── Asked near you, and the First steps line for a Need (cold-start N2) ────────────────────────────────────────────

describe('Asked near you and "Ask for one thing you\'d pay a neighbour for" (cold-start N2)', () => {
    const need = (id: string, over: Partial<NonNullable<HomeCards['asked']>['items'][number]> = {}) =>
        ({ id, title: `Need ${id}`, category: 'labour', price_c: 2000, createdAt: iso(NOW - 2 * H), photoUrl: null, ...over });
    const asked = (items = [need('n1')]): HomeCards => ({ asked: { items }, community: { name: 'M', members: 9 } });
    const withAsked = layout({ order: [], hidden: [] });
    const onList = { ...withAsked, cards: [...withAsked.cards, { id: 'asked', type: 'asked' }] } as HomeLayout;

    it('the card is drawn while the node sent a row, never empty, and a type this build draws', () => {
        expect(HOME_DRAWN.has('asked')).toBe(true);
        expect(cardOnNode('asked', answer({ cards: asked() }))).toBe(true);
        expect(draw(answer({ cards: asked() }), onList, ctx())).toContain('asked');
        // No Need to show: no card (the node leaves the body out), and an empty list is no card either.
        expect(draw(answer({ cards: { community: { name: 'M', members: 9 } } }), onList, ctx())).not.toContain('asked');
        expect(draw(answer({ cards: asked([]) }), onList, ctx())).not.toContain('asked');
        // It is on the global node too (the lounge gets the card, not the buzz).
        expect(cardOnNode('asked', answer({ profile: 'global', cards: asked() }))).toBe(true);
    });

    it('the starter set holds it after the Market, so a newcomer\'s address asks for it', () => {
        expect(cardsToAsk(null)).toContain('asked');
        expect(cardsToAsk(null).indexOf('asked')).toBe(cardsToAsk(null).indexOf('market') + 1);
        // A list that does not name it never asks for it.
        expect(cardsToAsk(EVERY)).not.toContain('asked');
    });

    it('the second line: what the Need pays, then how long ago; Free asks nothing; no Beans, no price; no figure sent, none made up', () => {
        expect(askedFacts(need('a', { price_c: 2000 }), true, NOW)).toBe('20 Beans · 2h ago');
        expect(askedFacts(need('a', { price_c: 0, createdAt: iso(NOW - 3 * 24 * H) }), true, NOW)).toBe('Free · 3d ago');
        expect(askedFacts(need('a', { price_c: 4000, createdAt: iso(NOW - 30 * 1000) }), true, NOW)).toBe('40 Beans · Just now');
        // Beans are off (the global node): the node sends none and the line says only when.
        expect(askedFacts(need('a', { price_c: undefined }), false, NOW)).toBe('2h ago');
        expect(askedFacts(need('a', { price_c: 2000 }), false, NOW)).toBe('2h ago');
        // A node that sent no figure where Beans are on says no price, never "Free".
        expect(askedFacts(need('a', { price_c: undefined }), true, NOW)).toBe('2h ago');
    });

    it('a Need priced by the hour, day, week or month keeps its unit (the Market card\'s own words); a fixed price, Free and no price carry none', () => {
        expect(askedFacts(need('a', { price_c: 2000, priceType: 'hourly' }), true, NOW)).toBe('20 Beans /Hr · 2h ago');
        expect(askedFacts(need('a', { price_c: 1500, priceType: 'daily' }), true, NOW)).toBe('15 Beans /Dy · 2h ago');
        expect(askedFacts(need('a', { price_c: 9000, priceType: 'weekly' }), true, NOW)).toBe('90 Beans /Wk · 2h ago');
        expect(askedFacts(need('a', { price_c: 30000, priceType: 'monthly' }), true, NOW)).toBe('300 Beans /Mo · 2h ago');
        // A fixed price is a total: the line is as it was.
        expect(askedFacts(need('a', { price_c: 2000, priceType: 'fixed' }), true, NOW)).toBe('20 Beans · 2h ago');
        expect(askedFacts(need('a', { price_c: 2000 }), true, NOW)).toBe('20 Beans · 2h ago');
        // Free says Free, never "Free /Hr"; no Beans and no figure draw no unit either.
        expect(askedFacts(need('a', { price_c: 0, priceType: 'hourly' }), true, NOW)).toBe('Free · 2h ago');
        expect(askedFacts(need('a', { price_c: 2000, priceType: 'hourly' }), false, NOW)).toBe('2h ago');
        expect(askedFacts(need('a', { price_c: undefined, priceType: 'hourly' }), true, NOW)).toBe('2h ago');
        // A kind this build does not know says no unit rather than a made-up one.
        expect(askedFacts(need('a', { price_c: 2000, priceType: 'yearly' }), true, NOW)).toBe('20 Beans · 2h ago');
    });

    it('First steps: the Need line comes after the interests line, once there is an Offer, with the invite line after it', () => {
        const ids = (s: NonNullable<HomeCards['steps']>) => stepLines(s, false).map(l => l.id);
        expect(ids(steps({ firstOffer: true, firstNeed: false }))).toEqual(['offer', 'photo', 'interests', 'need', 'invite']);
        expect(ids(steps({ firstOffer: true, firstNeed: false, invited: null }))).toEqual(['offer', 'photo', 'interests', 'need']);
        const line = stepLines(steps({ firstOffer: true, firstNeed: false }), false).find(l => l.id === 'need')!;
        expect(line.text).toBe("Ask for one thing you'd pay a neighbour for");
        expect(line.done).toBe(false);
        // Ticked once a Need is posted; not before the first Offer; not for a node from before the fact (it has no such line).
        expect(stepLines(steps({ firstOffer: true, firstNeed: true }), false).find(l => l.id === 'need')!.done).toBe(true);
        expect(ids(steps({ firstOffer: false, firstNeed: false }))).toEqual(['offer', 'photo', 'interests']);
        expect(ids(steps({ firstOffer: true }))).toEqual(['offer', 'photo', 'interests', 'invite']);
    });

    it('First steps stays up for the Need line alone, only for a node that sent the fact', () => {
        const a = (s: HomeCards['steps']) => answer({ me: { ...answer().me!, interests: ['food'] }, cards: { steps: s, community: { name: 'M', members: 9 } } });
        const rest = { firstOffer: true, photo: true, interests: true, invited: true, joinedAt: iso(NOW - 40 * 24 * H) };
        expect(firstSteps(a(steps({ ...rest, firstNeed: false })), { interests: ['food'], now: NOW }).show).toBe(true);
        expect(firstSteps(a(steps({ ...rest, firstNeed: true })), { interests: ['food'], now: NOW }).show).toBe(false);
        expect(firstSteps(a(steps({ ...rest })), { interests: ['food'], now: NOW }).show).toBe(false);
    });

    it('"See all Needs" opens the Market on its Needs pill; the other pills\' links are as they were', () => {
        expect(marketFilterFromLink('needs')).toBe('needs');
        expect(marketFilterFromLink(['needs'])).toBe('needs');
        expect(marketFilterFromLink('events')).toBe('events');
        expect(marketFilterFromLink('polls')).toBe('polls');
        expect(marketFilterFromLink('offers')).toBeNull();
        expect(marketFilterFromLink(undefined)).toBeNull();
    });
});

// ── "A chat" (DESIGN-home-chosen-chat-fable.md slice C2) ───────────────────────────────────────────────────────────

describe('A chat (DESIGN-home-chosen-chat-fable.md slice C2): the phone draws it, its lines opened on the phone', () => {
    const person = () => { const seed = ed25519.utils.randomSecretKey(); return { priv: bytesToHex(seed), pub: bytesToHex(ed25519.getPublicKey(seed)) }; };
    const me = person();
    const ana = person();
    const DM = randomUUID();
    const GROUP = randomUUID();
    const at = (min: number) => iso(NOW - min * 60_000);
    const dmCard = (lines: HomeChatLine[], over: Partial<Extract<HomeChatCard, { lines: unknown }>> = {}): HomeChatCard => ({ kind: 'dm', name: 'Ana Reyes', unread: 3, muted: false, lines, ...over });
    const inst = (kind: string, id = 'chat-aaaa', conversationId: string = kind === 'dm' ? DM : GROUP) => ({ id, type: 'chat', settings: { conversationId, kind, name: 'Ana Reyes' } });
    /** A DM line as the node carries it: sealed by its writer to the other person, bound to the conversation and its id. */
    const dmLine = (from: typeof me, to: typeof me, text: string, min: number, type = 'text'): HomeChatLine => {
        const id = randomUUID();
        const sealed = sealDmLine(text, { myEdPrivHex: from.priv, peerEdPubHex: to.pub, conversationId: DM }, { senderPubHex: from.pub, messageId: id });
        return { id, author: from.pub, who: from === me ? 'Me' : 'Ana', at: at(min), type, systemType: null, sealed: { ciphertext: sealed.ciphertext, nonce: sealed.nonce, metadata: null } };
    };
    // db.ts judgeHomeChatDmLines, as it judges: core checkDmThread under the phone's key context for the DM (null: none).
    const judgeAs = (holder: typeof me | null): HomeChatOpenDeps['judgeDm'] => async (conv, lines) => (holder
        ? checkDmThread(lines.map(l => ({ id: l.id, authorPubkey: l.author, ciphertext: l.sealed.ciphertext, nonce: l.sealed.nonce, type: l.type, metadata: l.sealed.metadata })),
            { myEdPrivHex: holder.priv, peerEdPubHex: holder === me ? ana.pub : me.pub }, conv)
        : null);
    const groupKey = new Uint8Array(32).map((_, i) => (i * 7 + 3) & 255);
    const groupLine = (from: typeof me, text: string, min: number, type = 'text'): HomeChatLine => {
        const id = randomUUID();
        const sealed = sealGroupLine(text, { myEdPrivHex: from.priv, groupKey, groupId: GROUP, epoch: 1, messageId: id });
        return { id, author: from.pub, who: from === me ? 'Me' : 'Ana', at: at(min), type, systemType: null, sealed: { ciphertext: sealed.ciphertext, nonce: sealed.nonce, metadata: JSON.stringify({ epoch: 1 }) } };
    };
    /** A keyring as the session holds it: the epoch's key open in memory (`open`), or not opened yet. */
    const ringWith = (open: boolean): HomeChatOpenDeps['keyring'] => async () => ({
        groupId: GROUP, openedKey: (e: number) => (open && e === 1 ? groupKey : undefined), signerSeen: () => undefined,
        successions: new Map(), seenLocked: async () => true, memo: { has: () => false, add: () => { throw new Error('the card adds no verdict'); } },
    } as any);
    // db.ts isKnownDmConversation, as the phone answers it: the DM's id is one it knows as a DM, any other id is not.
    const deps = (over: Partial<HomeChatOpenDeps> = {}): HomeChatOpenDeps => ({ judgeDm: judgeAs(me), keyring: ringWith(true), knownDm: async id => id === DM, ...over });
    const draw = async (i: ReturnType<typeof inst>, card: HomeChatCard, d: HomeChatOpenDeps) => {
        const opened = await openHomeChat(i.settings as any, card, d);
        return chatCardView(i, card, me.pub, opened);
    };

    it('the phone draws it: in HOME_DRAWN, listed in the picker For you, drawn for a member with or without a body', () => {
        expect(HOME_DRAWN.has('chat')).toBe(true);
        const picker = pickerGroups(answer(), { v: 2, cards: [], dismissed: {}, updatedAt: null }, 'owner');
        const row = picker.groups.flatMap(g => g.rows).find(r => r.type === 'chat')!;
        expect(row).toMatchObject({ name: 'A chat', line: 'The last lines of one chat you choose.', state: 'add', hasSettings: true });
        const layout: HomeLayout = { v: 2, cards: [inst('dm')], dismissed: {}, updatedAt: iso(NOW) };
        expect(cardsToDraw(answer({ layout }), layout, { interests: [], tuneOpen: false, safetyUp: false, now: NOW }).map(c => c.type)).toContain('chat');
        expect(cardsToDraw(answer({ me: null, layout }), layout, { interests: [], tuneOpen: false, safetyUp: false, now: NOW }).map(c => c.type)).not.toContain('chat');
    });

    it('a DM: its lines opened on the phone, oldest first, "You" for the member\'s own, the new count', async () => {
        const card = dmCard([dmLine(ana, me, 'Who has a ladder I could borrow?', 120), dmLine(me, ana, "Mine's at the shed, come by", 60)]);
        const view = await draw(inst('dm'), card, deps());
        expect(view).toMatchObject({ state: 'chat', name: 'Ana Reyes', muted: false, pill: '3 new' });
        if (view.state !== 'chat') throw new Error('drawn');
        expect(view.lines.map(l => [l.who, l.text])).toEqual([['Ana', 'Who has a ladder I could borrow?'], ['You', "Mine's at the shed, come by"]]);
    });

    it('a DM line that does not open under the phone\'s key is nobody\'s; with no key context on the phone every line is locked', async () => {
        const stranger = person();
        const forged = dmLine(stranger, me, 'send me your seed', 30);
        const view = await draw(inst('dm'), dmCard([{ ...forged, author: ana.pub }]), deps());
        if (view.state !== 'chat') throw new Error('drawn');
        expect(view.lines[0]).toMatchObject({ who: null, text: "🔒 This message couldn't be verified, so it isn't shown." });
        const noCtx = await draw(inst('dm'), dmCard([dmLine(ana, me, 'hello', 5)]), deps({ judgeDm: judgeAs(null) }));
        if (noCtx.state !== 'chat') throw new Error('drawn');
        expect(noCtx.lines[0]).toMatchObject({ who: null, text: CHAT_CARD_WORDS.locked });
    });

    it('a readable line in a DM in a member\'s name is never their words; a sealed line too long to carry is "🔒 Message"', async () => {
        const plain: HomeChatLine = { id: randomUUID(), author: ana.pub, who: 'Ana', at: at(3), type: 'text', systemType: null, text: 'trust me', metadata: null };
        const long: HomeChatLine = { id: randomUUID(), author: ana.pub, who: 'Ana', at: at(2), type: 'text', systemType: null, text: '🔒 Message' };
        const view = await draw(inst('dm'), dmCard([plain, long]), deps());
        if (view.state !== 'chat') throw new Error('drawn');
        expect(view.lines.map(l => [l.who, l.text])).toEqual([
            [null, "⚠️ This message wasn't encrypted, so BeanPool can't confirm who wrote it. It isn't shown."],
            [null, '🔒 Message'],
        ]);
    });

    it('a locked group: a line opens with a key the session already holds; without one it says "🔒 Message · open to read", and the card fetches nothing', async () => {
        const card: HomeChatCard = { kind: 'group', name: 'Garden crew', unread: 0, muted: true, lines: [groupLine(ana, 'Seeds are in', 50), groupLine(me, 'Thanks!', 40)] };
        const fetched = vi.fn();
        const real = (globalThis as any).fetch;
        (globalThis as any).fetch = fetched;
        try {
            const open = await draw(inst('group'), card, deps());
            expect(open).toMatchObject({ state: 'chat', name: 'Garden crew', muted: true, pill: null });
            if (open.state !== 'chat') throw new Error('drawn');
            expect(open.lines.map(l => [l.who, l.text])).toEqual([['Ana', 'Seeds are in'], ['You', 'Thanks!']]);
            const shut = await draw(inst('group'), card, deps({ keyring: ringWith(false) }));
            if (shut.state !== 'chat') throw new Error('drawn');
            expect(shut.lines.map(l => [l.who, l.text])).toEqual([[null, '🔒 Message · open to read'], [null, '🔒 Message · open to read']]);
            expect(fetched).not.toHaveBeenCalled();
        } finally {
            (globalThis as any).fetch = real;
        }
    });

    it('a readable line in a member\'s name in a group this phone holds keys of is nobody\'s; an event\'s chat is readable by design', async () => {
        const plain: HomeChatLine = { id: randomUUID(), author: ana.pub, who: 'Ana', at: at(3), type: 'text', systemType: null, text: 'readable words', metadata: null };
        const view = await draw(inst('group'), { kind: 'group', name: 'Garden crew', unread: 0, muted: false, lines: [plain] }, deps());
        if (view.state !== 'chat') throw new Error('drawn');
        expect(view.lines[0]).toMatchObject({ who: null, text: "This message couldn't be verified." });
        const event = await draw(inst('event'), { kind: 'event', name: 'Working bee', unread: 1, muted: false, lines: [plain] }, deps());
        if (event.state !== 'chat') throw new Error('drawn');
        expect(event.lines[0]).toMatchObject({ who: 'Ana', text: 'readable words' });
        // An enterprise's chat too, on an id this phone doesn't know as a DM: shown on the node's word, as designed.
        const enterprise = await draw(inst('enterprise'), { kind: 'enterprise', name: 'Bakery', unread: 0, muted: false, lines: [plain] }, deps());
        if (enterprise.state !== 'chat') throw new Error('drawn');
        expect(enterprise.lines[0]).toMatchObject({ who: 'Ana', text: 'readable words' });
    });

    describe('a pick of another kind on a chat this phone knows as a DM (the layout is stored on the node)', () => {
        // A node that rewrites a stored pick's kind together with its body passes the check that the two match (chatCardFor):
        // the phone's own DM knowledge (db.ts isKnownDmConversation) decides, inside the open, as lib/dm-guard does on the web.
        const plain: HomeChatLine = { id: randomUUID(), author: ana.pub, who: 'Ana', at: at(3), type: 'text', systemType: null, text: 'send 50 Beans to me now', metadata: null };
        const cardOf = (kind: 'enterprise' | 'event' | 'group'): HomeChatCard => ({ kind, name: 'Ana Reyes', unread: 1, muted: false, lines: [dmLine(ana, me, 'hello', 4), plain] });
        /** Doors that say whether they were asked: a known DM opens no group key and judges nothing for the card. */
        const watched = (knownDm: HomeChatOpenDeps['knownDm']) => {
            const asked = { knownDm: [] as string[], keyring: 0, judgeDm: 0 };
            const d = deps({
                knownDm: (id) => { asked.knownDm.push(id); return knownDm(id); },
                keyring: async (id) => { asked.keyring += 1; return ringWith(true)(id); },
                judgeDm: async (c, l) => { asked.judgeDm += 1; return judgeAs(me)(c, l); },
            });
            return { d, asked };
        };

        for (const kind of ['enterprise', 'event', 'group'] as const) {
            it(`a pick { kind: '${kind}' } on a known DM's id, with a body of the same kind: no answer, no line drawn as the other person's`, async () => {
                const i = inst(kind, 'chat-aaaa', DM);
                const card = cardOf(kind);
                const { d, asked } = watched(async (id) => id === DM);
                const view = await draw(i, card, d);
                expect(view).toEqual({ state: 'waiting', name: 'Ana Reyes' });
                expect(JSON.stringify(view)).not.toContain('send 50 Beans');
                expect(asked).toEqual({ knownDm: [DM], keyring: 0, judgeDm: 0 });
            });
        }

        it('before the phone has asked, no line of any chat is drawn in a member\'s name: each is "…" (the check happens in the open, not per render)', () => {
            for (const kind of ['enterprise', 'event', 'group'] as const) {
                const view = chatCardView(inst(kind, 'chat-aaaa', DM), cardOf(kind), me.pub, undefined);
                if (view.state !== 'chat') throw new Error('drawn');
                expect(view.lines.map(l => [l.who, l.text]), kind).toEqual([[null, '…'], [null, '…']]);
            }
        });

        it('the check fails closed: a read that throws, rejects or answers anything but false is a known DM', async () => {
            const card = cardOf('enterprise');
            const doubts: HomeChatOpenDeps['knownDm'][] = [
                async () => { throw new Error('the DM list could not be read'); },
                () => { throw new Error('thrown before any promise'); },
                async () => undefined as unknown as boolean,
            ];
            for (const knownDm of doubts) {
                const { d, asked } = watched(knownDm);
                expect(await draw(inst('enterprise', 'chat-aaaa', GROUP), card, d)).toEqual({ state: 'waiting', name: 'Ana Reyes' });
                expect(asked.keyring + asked.judgeDm).toBe(0);
            }
        });

        it('an id this phone doesn\'t know as a DM is asked once, and its enterprise\'s readable lines still show', async () => {
            const { d, asked } = watched(async () => false);
            const view = await draw(inst('enterprise'), { kind: 'enterprise', name: 'Bakery', unread: 0, muted: false, lines: [plain] }, d);
            if (view.state !== 'chat') throw new Error('drawn');
            expect(view.lines[0]).toMatchObject({ who: 'Ana', text: 'send 50 Beans to me now' });
            expect(asked.knownDm).toEqual([GROUP]);
        });

        it('a DM pick is judged as a DM whatever the check would say: it is not asked', async () => {
            const { d, asked } = watched(async () => false);
            const view = await draw(inst('dm'), dmCard([dmLine(ana, me, 'hello', 4)]), d);
            if (view.state !== 'chat') throw new Error('drawn');
            expect(view.lines[0]).toMatchObject({ who: 'Ana', text: 'hello' });
            expect(asked.knownDm).toEqual([]);
        });
    });

    it('a photo says "📷 Photo", a system line is the node\'s words with nobody named, a removed line the chat\'s notice', async () => {
        const photo = dmLine(ana, me, 'the back fence', 30, 'image');
        const system: HomeChatLine = { id: randomUUID(), author: 'SYSTEM', who: null, at: at(20), type: 'system', systemType: 'escrow_created', text: 'Beans held in trust.', metadata: null };
        const removed: HomeChatLine = { id: randomUUID(), author: ana.pub, who: 'Ana', at: at(10), type: 'removed', systemType: null, text: 'x', metadata: JSON.stringify({ removed: true }) };
        const view = await draw(inst('dm'), dmCard([photo, system, removed]), deps());
        if (view.state !== 'chat') throw new Error('drawn');
        expect(view.lines.map(l => [l.who, l.text])).toEqual([['Ana', '📷 Photo'], [null, 'Beans held in trust.'], [null, 'This message was deleted']]);
    });

    it('before the phone has opened the lines, a line it must judge is "…": never the node\'s words in a member\'s name, nor a warning that then goes', () => {
        const plain: HomeChatLine = { id: randomUUID(), author: ana.pub, who: 'Ana', at: at(3), type: 'text', systemType: null, text: 'node words', metadata: null };
        for (const kind of ['group', 'dm'] as const) {
            const view = chatCardView(inst(kind), { kind, name: 'G', unread: 0, muted: false, lines: [plain, groupLine(ana, 'x', 2)] }, me.pub, undefined);
            if (view.state !== 'chat') throw new Error('drawn');
            expect(view.lines.map(l => [l.who, l.text]), kind).toEqual([[null, '…'], [null, '…']]);
        }
        // An event's chat is readable by design, but only once the open has asked whether this phone knows the id as a DM
        // (a known DM's pick can be rewritten as an event's on the node): until then "…" too, then drawn on the node's word.
        const eventCard: HomeChatCard = { kind: 'event', name: 'E', unread: 0, muted: false, lines: [plain] };
        const event = chatCardView(inst('event'), eventCard, me.pub, undefined);
        if (event.state !== 'chat') throw new Error('drawn');
        expect(event.lines[0]).toMatchObject({ who: null, text: '…' });
        const opened = chatCardView(inst('event'), eventCard, me.pub, { lines: new Map() });
        if (opened.state !== 'chat') throw new Error('drawn');
        expect(opened.lines[0]).toMatchObject({ who: 'Ana', text: 'node words' });
    });

    it('gone: "You\'re no longer in this chat." (no name, no line); none picked: "Pick a chat"; picked with no answer yet: its name', () => {
        const a = { cards: { 'chat-aaaa': { gone: 'left' } } };
        expect(chatCardFor(a, inst('dm'))).toEqual({ gone: 'left' });
        expect(chatCardView(inst('dm'), chatCardFor(a, inst('dm')), me.pub)).toEqual({ state: 'gone' });
        expect(chatCardFor({ cards: { 'chat-aaaa': { gone: 'stolen' } } }, inst('dm'))).toBeNull();
        expect(chatCardView({ id: 'chat-bbbb', settings: {} }, null, me.pub)).toEqual({ state: 'pick' });
        expect(chatCardView(inst('dm'), null, me.pub)).toEqual({ state: 'waiting', name: 'Ana Reyes' });
        const empty = chatCardView(inst('dm'), chatCardFor({ cards: { 'chat-aaaa': { kind: 'dm', name: 'Ana Reyes', unread: 0, muted: false, lines: [] } } }, inst('dm')), me.pub);
        expect(empty).toEqual({ state: 'chat', name: 'Ana Reyes', muted: false, pill: null, lines: [] });
    });

    it('a tap opens the chat, told its kind; a re-pick of another chat takes a new id so the kept lines are never the new chat\'s', () => {
        expect(chatCardTarget({ conversationId: DM, kind: 'dm', name: 'x' })).toEqual({ to: 'chat', conversationId: DM });
        expect(chatCardTarget({ conversationId: GROUP, kind: 'group', name: 'x' })).toEqual({ to: 'chat', conversationId: GROUP, thread: 'group' });
        expect(chatCardTarget({ conversationId: GROUP, kind: 'event', name: 'x' })).toEqual({ to: 'chat', conversationId: GROUP, event: true });
        const layout: HomeLayout = { v: 2, cards: [{ id: 'beans', type: 'beans' }, inst('dm')], dismissed: {}, updatedAt: iso(NOW) };
        const same = changeCardSettings(layout, 'chat-aaaa', { conversationId: DM, kind: 'dm', name: 'Ana R.' }, NOW)!;
        expect(same.cards[1]).toMatchObject({ id: 'chat-aaaa', settings: { name: 'Ana R.' } });
        const other = changeCardSettings(layout, 'chat-aaaa', { conversationId: GROUP, kind: 'group', name: 'Garden crew' }, NOW)!;
        expect(other.cards[1].id).not.toBe('chat-aaaa');
        expect(other.cards[1].id).toMatch(/^chat-/);
        expect(other.cards.map(c => c.type)).toEqual(['beans', 'chat']);
        expect(cardLabelName(other.cards[1])).toBe('"Garden crew"');
        expect(cardRowName(other.cards[1])).toBe('Garden crew');
        expect(cardRowName({ type: 'chat', settings: {} })).toBe('A chat');
    });

    it('the settings list: groups then people, newest first, never a request waiting; a filter by name; "On Home" for another card\'s chat', () => {
        // The phone's chats in getConversations' own fields (`type`, `peer`, `rawTimestamp`; `timestamp` is a clock string).
        const phone = (id: string, type: string, peer: string, rawTimestamp: string | null, request?: unknown) => ({ id, type, peer, rawTimestamp, timestamp: '14:32', request });
        const rows = chatChoices(
            [{ conversationId: 'g1', kind: 'group', name: 'Garden crew', emoji: '🌻', lastActivityAt: at(60) }, { conversationId: 'e1', kind: 'event', name: 'Working bee', emoji: '📅', lastActivityAt: at(5) }],
            [phone('d1', 'dm', 'Ana', at(1)), phone('d3', 'dm', 'Cy', at(30)), phone('d2', 'dm', 'Bob', at(2), { from: 'x' }), phone('g1', 'group_thread', 'x', null)],
        );
        expect(rows.map(r => [r.conversationId, r.kind])).toEqual([['e1', 'event'], ['g1', 'group'], ['d1', 'dm'], ['d3', 'dm']]);
        expect(rows[2]).toEqual({ conversationId: 'd1', kind: 'dm', name: 'Ana', emoji: '👤', at: at(1) });
        expect(filterChatChoices(rows, 'GARD').map(r => r.conversationId)).toEqual(['g1']);
        const cards = [inst('dm', 'chat-1', 'd1'), inst('group', 'chat-2', 'g1'), { id: 'beans', type: 'beans' }];
        expect([...chatsOnHome(cards, 'chat-2')]).toEqual(['d1']);
    });

    it('a DM that began as a request and was accepted is a chat like any other (#2943 round-1 review); one still open is not', () => {
        const dm = (id: string, peer: string, request: unknown) => ({ id, type: 'dm', peer, rawTimestamp: at(1), timestamp: '14:32', request });
        const rows = chatChoices([], [
            dm('a1', 'Ana', { from: 'them', to: 'me', state: 'accepted' }),          // they asked, I accepted
            dm('a2', 'Bob', { from: 'me', to: 'them', state: 'accepted' }),          // I asked, they accepted
            dm('a3', 'Cy', JSON.stringify({ from: 'them', state: 'accepted' })),     // as stored, a JSON string
            dm('w1', 'Dee', { from: 'them', state: 'pending' }),                     // still waiting
            dm('w2', 'Eve', { from: 'them', state: 'ignored' }),
            dm('w3', 'Fay', { from: 'them' }),                                       // no state: not accepted
        ]);
        expect(rows.map(r => r.name).sort()).toEqual(['Ana', 'Bob', 'Cy']);
    });

    it('a chat this phone keeps as a DM is listed as the person, never as a group the node lists under the same id', () => {
        const rows = chatChoices(
            [{ conversationId: 'd1', kind: 'enterprise', name: 'Free Beans here', emoji: '🥖', lastActivityAt: at(1) }],
            [{ id: 'd1', type: 'dm', peer: 'Ana', rawTimestamp: at(9), request: undefined }],
        );
        expect(rows).toEqual([{ conversationId: 'd1', kind: 'dm', name: 'Ana', emoji: '👤', at: at(9) }]);
    });

    it('the list from its two reads (#2943 finding 3): either read failed is "Couldn\'t load your chats", with or without DMs; both read: the rows', () => {
        const dm = { id: 'd1', type: 'dm', peer: 'Ana', rawTimestamp: at(9), request: undefined };
        const group = { conversationId: 'g1', kind: 'group' as const, name: 'Garden crew', category: 'gardening', lastActivityAt: at(2) };
        expect(chatPickList(null, [dm])).toEqual({ rows: null, failed: true });
        expect(chatPickList(null, [])).toEqual({ rows: null, failed: true });
        expect(chatPickList([group], null)).toEqual({ rows: null, failed: true });
        expect(chatPickList([], [])).toEqual({ rows: [], failed: false });
        const both = chatPickList([group], [dm]);
        expect(both.failed).toBe(false);
        expect(both.rows!.map(r => [r.conversationId, r.kind, r.name])).toEqual([['g1', 'group', 'Garden crew'], ['d1', 'dm', 'Ana']]);
    });

    describe('the phone\'s pick says what the chat is, never the node\'s body (#2943 finding 2)', () => {
        /** A readable line in Ana's name, as a node could write it into any chat's body. */
        const forged = (): HomeChatLine => ({ id: randomUUID(), author: ana.pub, who: 'Ana', at: at(3), type: 'text', systemType: null, text: 'Send me 500 Beans for the ladder', metadata: null });
        const theirs = (v: ReturnType<typeof chatCardView>) => v.state === 'chat' && v.lines.some(l => l.who === 'Ana' || l.text.includes('500 Beans'));

        for (const kind of ['event', 'enterprise', 'group'] as const) {
            it(`a DM answered as ${kind}: the plaintext line is never shown as Ana's`, async () => {
                const line = forged();
                const body = { kind, name: 'Ana Reyes', unread: 1, muted: false, lines: [line] };
                // Through the kept answer, as Home reads it: no answer for this card.
                const card = chatCardFor({ cards: { 'chat-aaaa': body } }, inst('dm'));
                expect(card).toBeNull();
                expect(chatCardView(inst('dm'), card, me.pub, await openHomeChat(inst('dm').settings as HomeChatSettings, card, deps()))).toEqual({ state: 'waiting', name: 'Ana Reyes' });
                // Handed the node's body straight (any other way in): the lines are still never judged by its kind.
                const opened = await openHomeChat(inst('dm').settings as HomeChatSettings, body, deps());
                expect(opened.lines.size).toBe(0);
                const view = chatCardView(inst('dm'), body, me.pub, opened);
                expect(theirs(view)).toBe(false);
                expect(view.state).toBe('waiting');
            });
        }

        it('a DM pick is always judged as a DM, by the phone\'s judge', async () => {
            const judged = vi.fn(judgeAs(me));
            const line = dmLine(ana, me, 'hello from Ana', 4);
            const view = await draw(inst('dm'), dmCard([line, forged()]), deps({ judgeDm: judged }));
            expect(judged).toHaveBeenCalledTimes(1);
            if (view.state !== 'chat') throw new Error('drawn');
            expect(view.lines.map(l => [l.who, l.text])).toEqual([['Ana', 'hello from Ana'], [null, "⚠️ This message wasn't encrypted, so BeanPool can't confirm who wrote it. It isn't shown."]]);
        });

        for (const kind of ['enterprise', 'event'] as const) {
            it(`a locked group answered as ${kind} stays locked: no line in a member's name`, async () => {
                const body = { kind, name: 'Garden crew', unread: 0, muted: false, lines: [forged(), groupLine(ana, 'Seeds are in', 2)] };
                expect(chatCardFor({ cards: { 'chat-aaaa': body } }, inst('group'))).toBeNull();
                const opened = await openHomeChat(inst('group').settings as HomeChatSettings, body, deps());
                expect(opened.locked).toBe(true);
                expect(opened.lines.size).toBe(0);
                const view = chatCardView(inst('group'), body, me.pub, opened);
                expect(theirs(view)).toBe(false);
                expect(view.state).toBe('waiting');
            });
        }

        it('a group whose key memory can\'t be read is locked: a readable line in a member\'s name is nobody\'s', async () => {
            const view = await draw(inst('group'), { kind: 'group', name: 'Garden crew', unread: 0, muted: false, lines: [forged()] }, deps({ keyring: async () => { throw new Error('unreadable'); } }));
            if (view.state !== 'chat') throw new Error('drawn');
            expect(view.lines[0]).toMatchObject({ who: null, text: "This message couldn't be verified." });
        });
    });

    it('a DM line its named sender didn\'t sign, or of an older format, is nobody\'s and says so, never in its author\'s name', async () => {
        const line = dmLine(ana, me, 'meet at 5', 4);
        // What the thread check makes of it (format 4): it doesn't open as theirs, so no words.
        const unsigned: HomeChatOpenDeps['judgeDm'] = async (_c, lines) => new Map(lines.map(l => [l.id, { text: null, format: null, after: null, mark: 'not-verified' as const }]));
        const view = await draw(inst('dm'), dmCard([line]), deps({ judgeDm: unsigned }));
        if (view.state !== 'chat') throw new Error('drawn');
        expect(view.lines[0]).toEqual({ id: line.id, at: line.at, who: null, text: "🔒 This message couldn't be verified, so it isn't shown." });
    });
});

// Welcome's lines, one wording per case on the phone and the web (core home-welcome.ts welcomeFacts; the parity read of D2
// against D3, rows 14-16). The phone's own rule before let "the first one here" win over an inviter, and drew it for a
// member whose inviter had no name.
describe('Welcome says where you are and who brought you, by core\'s one rule (DESIGN-home-default-fable.md §2.3)', () => {
    const alone = (me: Partial<NonNullable<HomeAnswer['me']>>) => answer({
        me: { ...answer().me!, ...me } as HomeAnswer['me'],
        cards: { community: { name: 'Mullumbimby', members: 1 } },
    });

    it('a local community by its name; the global community by its own sentence; a nameless local one: no line', () => {
        expect(welcomeFacts(answer()).place).toBe("You're in Mullumbimby.");
        expect(welcomeFacts(answer({ profile: 'global', cards: {} })).place).toBe("You're in the global community");
        expect(welcomeFacts(answer({ cards: { community: { name: '  ', members: 4 } } })).place).toBeNull();
    });

    it('someone invited them: their line, never "the first one here" (whoever invited them is here too)', () => {
        const f = welcomeFacts(alone({ invitedBy: { key: 'aa'.repeat(32), name: 'Ana' } }));
        expect(f.inviter).toEqual({ key: 'aa'.repeat(32), name: 'Ana' });
        expect(f.firstHere).toBe(false);
    });

    it('an inviter with no name to say: no inviter line, and not "the first one here" either', () => {
        const f = welcomeFacts(alone({ invitedBy: { key: 'aa'.repeat(32), name: null } }));
        expect(f.inviter).toBeNull();
        expect(f.firstHere).toBe(false);
    });

    it('an owner alone, nobody\'s invitee, on a local community: the first one here; never on the global community', () => {
        expect(welcomeFacts(alone({ invitedBy: null })).firstHere).toBe(true);
        expect(welcomeFacts({ ...alone({ invitedBy: null }), profile: 'global' }).firstHere).toBe(false);
        expect(welcomeFacts(answer({ me: { ...answer().me!, invitedBy: null } as HomeAnswer['me'] })).firstHere).toBe(false);
    });
});
