/**
 * The Home card rules (lib/home-cards.ts; DESIGN-home-dashboard-fable.md §3, §4, §12 H3 "the shared vitest cases"):
 * the catalogue, what each person in §3.2 sees (drawn on the card frame, `shownFrame`), interests ordering, and the words
 * the cards say. The member's list itself (add, remove, move, reset, which copy wins, what is asked) is
 * lib/home-layout.ts, proved in home-layout.test.ts.
 */
import { describe, expect, it } from 'vitest';
import {
    HOME_CARD_IDS, beansLines, closesWords, communityFacts, communityLine, decideLine, findBody, joinedLine, probationSentence, searchCardFor, shownFrame,
    starredFirst, stepLines, stepsSaySomething, toggleInterest, type HomeAnswer, type HomeCards, type HomeMe, type ShownOptions,
} from './home-cards';
import { cardsToAsk, type HomeLayoutV2 } from './home-layout';

const NOW = Date.parse('2026-10-02T09:00:00.000Z');
const daysAgo = (n: number) => new Date(NOW - n * 86_400_000).toISOString();

const me = (over: Partial<HomeMe> = {}): HomeMe => ({
    joinedAt: daysAgo(1), isKeeper: false, probation: null, interests: [], area: null, firstOffer: false, standing: 'member', ...over,
});
const LOCAL_FEATURES = { beans: true, escrow: true, enterprises: true, invites: true, decisions: true, guestListingsOnly: false };
const GLOBAL_FEATURES = { beans: false, escrow: false, enterprises: false, invites: false, decisions: false, guestListingsOnly: true, exampleListings: true };

function answer(cards: HomeCards, over: Partial<HomeAnswer> = {}): HomeAnswer {
    return { generatedAt: new Date(NOW).toISOString(), profile: 'local', features: LOCAL_FEATURES, me: me(), layout: null, cards, ...over };
}

const find = { point: 'request' as const, communities: [{ key: 'k', name: 'Byron Shire BeanPool', url: 'https://byron.example', memberCount: 40, distanceKm: 12 }], communityCount: 38, nearbyPosts: { radiusKm: 25, count: 9, more: false }, watches: [], knock: null, directoryFetchedAt: null };
const steps = { joinedAt: daysAgo(1), firstOffer: false, firstPost: false, photo: false, interests: false, invited: false, area: false, knocked: null };
const market = { items: [{ id: 'p1', type: 'offer' as const, title: 'Sourdough', category: 'food', photoUrl: null }], total14d: 1, more: false };
const events = { items: [{ id: 'e1', title: 'Seed swap', startsAt: daysAgo(-1), endsAt: null, place: 'Town Hall', rsvp: null }], radiusKm: null };
const community = { name: 'Mullumbimby', members: 81, tradesThisMonth: 23 };
const pulse = { items: [{ id: 'u1', title: 'How our LETS started', thumbnailUrl: null, platform: 'youtube', callsign: 'River Folk', category: 'education', url: null }] };
const beans = { balance: 0, room: 0, tier: 'Newcomer', activated: false, frozen: false };

/** A list holding every card in the catalogue's order, as version 1 drew by default; `without` leaves some out. */
const every = (...without: string[]): HomeLayoutV2 => ({
    v: 2, cards: HOME_CARD_IDS.filter(id => id !== 'needs' && id !== 'community' && !without.includes(id)).map(id => ({ id, type: id })), dismissed: {}, updatedAt: null,
});
const shown = (a: HomeAnswer, opts: ShownOptions, layout: HomeLayoutV2 = every()) => shownFrame(a, layout, opts).map(c => c.type);

describe('the catalogue and the default order (§3.1)', () => {
    it('is the 18 ids in the design order (the 17 and Tips after First steps), community last', () => {
        expect(HOME_CARD_IDS).toEqual(['needs', 'safety', 'find', 'steps', 'tips', 'interests', 'deals', 'enterprise', 'events', 'market', 'decide', 'groups', 'joined', 'pulse', 'beans', 'notices', 'invite', 'community']);
    });
});

describe('what each person sees, top down (§3.2)', () => {
    it('(a) a new global member, a community 12 km away: find first, no money cards, no invite', () => {
        const a = answer({ find, steps, market, events, joined: { count7d: 14, radiusKm: 50 }, pulse, community: { name: null, members: 2310, communities: 38 } },
            { profile: 'global', features: GLOBAL_FEATURES, me: me({ firstOffer: true }) });
        expect(shown(a, { now: NOW })).toEqual(['find', 'steps', 'interests', 'events', 'market', 'joined', 'pulse', 'community']);
    });

    it('(a) a new global member by 12 words with nothing near: the safety card leads, examples in the Market card', () => {
        const a = answer({ safety: { words: true, signInLinked: false }, find: { ...find, communities: [] }, steps, market: { items: [], total14d: 0, more: false, examples: true }, community: { name: null, members: 4, communities: 0 } },
            { profile: 'global', features: GLOBAL_FEATURES });
        expect(shown(a, { now: NOW })).toEqual(['safety', 'find', 'steps', 'interests', 'market', 'community']);
    });

    it('(b) a new local member: steps, interests, then the community\'s cards and their own Beans', () => {
        const a = answer({ steps, events, market, joined: { count7d: 5, radiusKm: null, names: [{ callsign: 'Ana', avatarUrl: null }] }, pulse, beans, community });
        expect(shown(a, { now: NOW })).toEqual(['steps', 'interests', 'events', 'market', 'joined', 'pulse', 'beans', 'community']);
    });

    it('(b) an active trader: what waits first; no steps or interests once set; Invite after the first Offer', () => {
        const a = answer({
            needs: { items: [{ kind: 'deal', count: 1, accent: true, label: 'A deal is waiting for you: Sourdough', target: { to: 'deal', postId: 'p1', txId: 't1' } }] },
            deals: { open: 2, waiting: 1, waitingOnMe: { txId: 't1', postId: 'p1', title: 'Sourdough' } },
            events, market, decide: { open: 1, soonestClosesAt: daysAgo(-2), polls: 2, pollsMore: false },
            groups: { items: [{ id: 'g', kind: 'group', name: 'Garden Group', unread: 4, muted: false }], total: 1 }, pulse,
            beans: { balance: -35, room: 165, tier: 'Resident', activated: true, frozen: false }, community,
        }, { me: me({ joinedAt: daysAgo(90), interests: ['food'], firstOffer: true }) });
        expect(shown(a, { now: NOW })).toEqual(['needs', 'deals', 'events', 'market', 'decide', 'groups', 'pulse', 'beans', 'invite', 'community']);
    });

    it('(b) an enterprise keeper gets the enterprise card after deals', () => {
        const a = answer({ deals: { open: 1, waiting: 0, waitingOnMe: null }, enterprise: { id: 'x', name: 'Mullum Ceramics', requests: 3, others: 0 }, events, community },
            { me: me({ joinedAt: daysAgo(200), interests: ['arts'], isKeeper: true }) });
        expect(shown(a, { now: NOW })).toEqual(['deals', 'enterprise', 'events', 'community']);
    });

    it('(b) the operator of a brand-new node, alone: First steps and the community, nothing padded', () => {
        const a = answer({ steps, community: { name: 'New Town', members: 1, tradesThisMonth: 0 } });
        expect(shown(a, { now: NOW })).toEqual(['steps', 'interests', 'community']);
    });

    it('(c) a visitor in the global lobby: only the visitors\' cards, even if more were sent', () => {
        const a = answer({ find, market, events, pulse, joined: { count7d: 3, radiusKm: 50 }, community: { name: null, members: 2310, communities: 38 } },
            { profile: 'global', features: GLOBAL_FEATURES, welcome: true, me: null });
        expect(shown(a, { now: NOW })).toEqual(['find', 'events', 'market', 'community']);
    });

    it('a suspended member is never asked to tune or invite', () => {
        const a = answer({ community }, { me: me({ standing: 'suspended', firstOffer: true }) });
        expect(shown(a, { now: NOW })).toEqual(['community']);
    });

    it('a card the answer leaves out takes no space; the interests card follows the page\'s own interests and Tune', () => {
        const a = answer({ market, community });
        expect(shown(a, { now: NOW, interests: ['food'] })).toEqual(['market', 'community']);
        expect(shown(a, { now: NOW, interests: ['food'], interestsOpen: true })).toEqual(['interests', 'market', 'community']);
    });

    it('Tips is never asked of the node (no data: the address and its tag are what they were), and shows only for a member with a tip', () => {
        const a = answer({ community });
        expect(cardsToAsk(every())).not.toContain('tips');
        expect(cardsToAsk(every())).toEqual(cardsToAsk(every('tips')));
        expect(shown(a, { now: NOW, tipsUp: true })).toContain('tips');
        expect(shown(a, { now: NOW })).not.toContain('tips');
        expect(shown(a, { now: NOW, tipsUp: true }, every('tips'))).not.toContain('tips');
        expect(shown({ ...a, me: null }, { now: NOW, tipsUp: true })).not.toContain('tips');
    });
});

describe('interests reorder, they never filter (§4.3)', () => {
    const items = [{ c: 'tools' }, { c: 'food' }, { c: 'garden' }, { c: 'Food' }];

    it('starred categories first, each part in the order it came; nothing dropped', () => {
        expect(starredFirst(items, i => i.c, ['food']).map(i => i.c)).toEqual(['food', 'Food', 'tools', 'garden']);
        expect(starredFirst(items, i => i.c, ['energy'])).toEqual(items);
        expect(starredFirst(items, i => i.c, [])).toEqual(items);
    });

    it('a tap turns a chip on or off, keeping the order they were chosen in', () => {
        expect(toggleInterest(['food'], 'garden')).toEqual(['food', 'garden']);
        expect(toggleInterest(['food', 'garden'], 'food')).toEqual(['garden']);
    });
});

describe('the words (§3.1, §9)', () => {
    it('Beans: their own balance, plain for a new member, the tier as a word only', () => {
        expect(beansLines(beans)).toEqual({ line: '0 Beans · nothing to repay', note: 'Your credit opens with a first trade.' });
        expect(beansLines({ balance: -35, room: 165, tier: 'Resident', activated: true, frozen: false })).toEqual({ line: '-35 Beans · room to spend 165', note: 'Resident' });
        expect(beansLines({ balance: 1, room: 200, tier: 'Resident', activated: true, frozen: false }).line).toBe('1 Bean · room to spend 200');
        expect(beansLines({ balance: 12, room: 0, tier: 'Resident', activated: true, frozen: true }).line).toBe('12 Beans · spending paused');
    });

    it('a vote closing, in the member\'s own time', () => {
        const at = (d: number, h: number) => { const x = new Date(NOW); x.setDate(x.getDate() + d); x.setHours(h, 0, 0, 0); return x.toISOString(); };
        const morning = (() => { const x = new Date(NOW); x.setHours(8, 0, 0, 0); return x.getTime(); })();
        expect(closesWords(at(0, 20), morning)).toBe('closes tonight');
        expect(closesWords(at(0, 12), morning)).toBe('closes today');
        expect(closesWords(at(1, 12), morning)).toBe('closes tomorrow');
        expect(closesWords(at(3, 12), morning)).toMatch(/^closes (Mon|Tue|Wed|Thu|Fri|Sat|Sun)$/);
        expect(closesWords(at(10, 12), morning)).toMatch(/^closes \d{1,2} [A-Z][a-z]{2}$/);
    });

    it('Decide, Who joined and the community, with real numbers only', () => {
        expect(decideLine({ open: 0, soonestClosesAt: null, polls: 2, pollsMore: false })).toBe('2 polls open');
        expect(decideLine({ open: 0, soonestClosesAt: null, polls: 50, pollsMore: true })).toBe('50+ polls open');
        expect(joinedLine({ count7d: 5, radiusKm: null, names: [{ callsign: 'Ana', avatarUrl: null }, { callsign: 'Kofi', avatarUrl: null }] })).toBe('Ana, Kofi and 3 more joined this week.');
        expect(joinedLine({ count7d: 1, radiusKm: null, names: [{ callsign: 'Ana', avatarUrl: null }] })).toBe('Ana joined this week.');
        expect(joinedLine({ count7d: 14, radiusKm: 50 })).toBe('14 people within 50 km joined this week.');
        expect(communityLine(community, 'local')).toBe('81 members · 23 trades this month');
        expect(communityLine({ name: null, members: 2310, communities: 38 }, 'global')).toBe('2,310 members · 38 communities listed');
    });

    it('the find card says what the node found, and nothing it did not', () => {
        expect(findBody(find)).toBe('The community nearest you. Ask to join, and trade with your neighbours there.');
        expect(findBody({ ...find, communities: [...find.communities, { ...find.communities[0], key: 'k2', distanceKm: 39 }] }))
            .toBe('The communities nearest you, closest first. Ask one to let you in, and trade with your neighbours there.');
        expect(communityFacts(find.communities[0])).toBe('12 km away · 40 members');
        expect(communityFacts({ distanceKm: 4.62, memberCount: 1 })).toBe('4.6 km away · 1 member');
        expect(communityFacts({ distanceKm: 0.4, memberCount: null })).toBe('Less than 1 km away');
        expect(findBody({ ...find, communities: [], point: null, communityCount: 1 })).toBe('1 community is listed. Share your area to see the nearest.');
        expect(findBody({ ...find, communities: [] })).toBe('No community is listed near you yet. Start one, or ask to be told when one starts here.');
    });

    it('the new-account limits from the node\'s own numbers: 3 days by sign-in, 7 by 12 words', () => {
        const p = (hours: number, posts: number, chats: number) => ({ onProbation: true, ageEndsAt: null, keptPosts: 0, keptPostsNeeded: 3, endsWhen: { hours, keptPosts: 3 }, limits: { posts: { limit: posts }, photos: { limit: 5 }, new_dm_recipients: { limit: chats } } });
        expect(probationSentence(p(72, 3, 10))).toBe('For your first 3 days: 3 posts and 10 new chats a day.');
        expect(probationSentence(p(168, 2, 3))).toBe('For your first 7 days: 2 posts and 3 new chats a day.');
        expect(probationSentence(null)).toBeNull();
        expect(probationSentence({ ...p(72, 3, 10), onProbation: false })).toBeNull();
    });
});

describe('First steps goes when it has nothing to say on the web (§6.1, PR #1479 review)', () => {
    const august = '2026-08-10T00:00:00.000Z';
    const globalMember = (stepsOver: Partial<typeof steps>, findCard = { ...find, communities: [] as typeof find.communities }, meOver: Partial<HomeMe> = {}) =>
        answer({ find: findCard, steps: { ...steps, joinedAt: august, area: false, ...stepsOver }, community },
            { profile: 'global', features: GLOBAL_FEATURES, me: me({ joinedAt: august, interests: ['food'], ...meOver }) });

    it('a global member a month in who has posted: the node still sends it (no area), the web leaves it out', () => {
        const a = globalMember({ firstPost: true });
        expect(a.cards.steps).toBeDefined();
        expect(stepLines(a, ['food'])).toEqual([{ key: 'firstPost', done: true, text: 'Post something free or for swap' }]);
        expect(stepsSaySomething(a, ['food'], NOW)).toBe(false);
        expect(shown(a, { now: NOW })).not.toContain('steps');
    });

    it('"Ask X to let you in" is a suggestion the web can never tick: it keeps no card on its own', () => {
        const a = globalMember({ firstPost: true }, find);
        expect(stepLines(a, ['food']).map(l => l.key)).toEqual(['firstPost', 'ask']);
        expect(shown(a, { now: NOW })).not.toContain('steps');
    });

    it('it stays while a line is undone, the member is new, or the new-account limits apply', () => {
        expect(shown(globalMember({ firstPost: false }), { now: NOW })).toContain('steps');
        expect(shown(globalMember({ firstPost: true, joinedAt: daysAgo(3) }, find, { joinedAt: daysAgo(3) }), { now: NOW })).toContain('steps');
        const limits = { onProbation: true, ageEndsAt: null, keptPosts: 1, keptPostsNeeded: 3, limits: { posts: { limit: 3 }, new_dm_recipients: { limit: 10 } }, endsWhen: { hours: 72, keptPosts: 3 } };
        expect(shown(globalMember({ firstPost: true }, undefined, { probation: limits }), { now: NOW })).toContain('steps');
    });

    it('locally, by the same lines: a chip tapped ticks "Pick a few things you like" at once', () => {
        const a = answer({ steps: { ...steps, joinedAt: august, firstOffer: true, photo: true, interests: false, invited: true }, community },
            { me: me({ joinedAt: august, firstOffer: true }) });
        expect(shown(a, { now: NOW, interests: [] })).toContain('steps');
        expect(shown(a, { now: NOW, interests: ['food'] })).not.toContain('steps');
    });
});

describe("a saved search's body (slice F4): only the node's answer for the words the card holds now", () => {
    const inst = { id: 'search-k7mq', settings: { q: 'eggs', kind: 'any', km: 5 } };
    const body = { q: 'eggs', kind: 'any', category: null, km: 5, more: true, items: [{ id: 'p1', type: 'offer', title: 'Fresh eggs', category: 'food', photoUrl: null }] };
    const withCard = (c: unknown) => ({ cards: { 'search-k7mq': c } } as unknown as HomeAnswer);

    it("reads the node's rows and more for these words", () => {
        expect(searchCardFor(withCard(body), inst)).toEqual(body);
    });

    it('a kept answer for other words, an odd body or none is no body (the card says it shows when the community answers)', () => {
        expect(searchCardFor(withCard({ ...body, q: 'rye' }), inst)).toBeNull();
        expect(searchCardFor(withCard({ q: 'eggs' }), inst)).toBeNull();
        expect(searchCardFor(withCard('eggs'), inst)).toBeNull();
        expect(searchCardFor({ cards: {} } as unknown as HomeAnswer, inst)).toBeNull();
        expect(searchCardFor(null, inst)).toBeNull();
    });

    it('an absent km is none, an absent more is false', () => {
        expect(searchCardFor(withCard({ q: 'eggs', items: [] }), inst)).toEqual({ q: 'eggs', kind: 'any', category: null, km: null, items: [], more: false });
    });
});
