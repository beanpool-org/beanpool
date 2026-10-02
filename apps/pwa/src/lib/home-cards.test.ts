/**
 * The Home card rules (lib/home-cards.ts; DESIGN-home-dashboard-fable.md §3, §4, §12 H3 "the shared vitest cases"):
 * the default order, what each person in §3.2 sees, the layout's merge and moves, interests ordering, unknown ids, and
 * the words the cards say.
 */
import { describe, expect, it } from 'vitest';
import {
    HOME_CARD_IDS, askedCards, beansLines, canTailor, closesWords, communityLine, decideLine, editableCards, effectiveOrder,
    findBody, findPinned, hideCard, joinedLine, moveCard, newerLayout, normalizeLayout, probationSentence, resetLayout,
    shownCards, showCard, starredFirst, toggleInterest, type HomeAnswer, type HomeCards, type HomeMe,
} from './home-cards';

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

describe('the catalogue and the default order (§3.1)', () => {
    it('is the 17 ids in the design order, community last', () => {
        expect(HOME_CARD_IDS).toEqual(['needs', 'safety', 'find', 'steps', 'interests', 'deals', 'enterprise', 'events', 'market', 'decide', 'groups', 'joined', 'pulse', 'beans', 'notices', 'invite', 'community']);
        expect(effectiveOrder(null)).toEqual([...HOME_CARD_IDS]);
    });

    it('a member\'s order first, the rest in the default order, community last whatever was stored', () => {
        const l = normalizeLayout({ v: 1, order: ['community', 'pulse', 'events'], hidden: [], dismissed: {}, updatedAt: daysAgo(0) })!;
        const order = effectiveOrder(l);
        expect(order.slice(0, 2)).toEqual(['pulse', 'events']);
        expect(order[order.length - 1]).toBe('community');
        expect(new Set(order).size).toBe(17);
    });
});

describe('what each person sees, top down (§3.2)', () => {
    it('(a) a new global member, a community 12 km away: find first, no money cards, no invite', () => {
        const a = answer({ find, steps, market, events, joined: { count7d: 14, radiusKm: 50 }, pulse, community: { name: null, members: 2310, communities: 38 } },
            { profile: 'global', features: GLOBAL_FEATURES, me: me({ firstOffer: true }) });
        expect(shownCards(a, null, { now: NOW })).toEqual(['find', 'steps', 'interests', 'events', 'market', 'joined', 'pulse', 'community']);
    });

    it('(a) a new global member by 12 words with nothing near: the safety card leads, examples in the Market card', () => {
        const a = answer({ safety: { words: true, signInLinked: false }, find: { ...find, communities: [] }, steps, market: { items: [], total14d: 0, more: false, examples: true }, community: { name: null, members: 4, communities: 0 } },
            { profile: 'global', features: GLOBAL_FEATURES });
        expect(shownCards(a, null, { now: NOW })).toEqual(['safety', 'find', 'steps', 'interests', 'market', 'community']);
    });

    it('(b) a new local member: steps, interests, then the community\'s cards and their own Beans', () => {
        const a = answer({ steps, events, market, joined: { count7d: 5, radiusKm: null, names: [{ callsign: 'Ana', avatarUrl: null }] }, pulse, beans, community });
        expect(shownCards(a, null, { now: NOW })).toEqual(['steps', 'interests', 'events', 'market', 'joined', 'pulse', 'beans', 'community']);
    });

    it('(b) an active trader: what waits first; no steps or interests once set; Invite after the first Offer', () => {
        const a = answer({
            needs: { items: [{ kind: 'deal', count: 1, accent: true, label: 'A deal is waiting for you: Sourdough', target: { to: 'deal', postId: 'p1', txId: 't1' } }] },
            deals: { open: 2, waiting: 1, waitingOnMe: { txId: 't1', postId: 'p1', title: 'Sourdough' } },
            events, market, decide: { open: 1, soonestClosesAt: daysAgo(-2), polls: 2, pollsMore: false },
            groups: { items: [{ id: 'g', kind: 'group', name: 'Garden Group', unread: 4, muted: false }], total: 1 }, pulse,
            beans: { balance: -35, room: 165, tier: 'Resident', activated: true, frozen: false }, community,
        }, { me: me({ joinedAt: daysAgo(90), interests: ['food'], firstOffer: true }) });
        expect(shownCards(a, null, { now: NOW })).toEqual(['needs', 'deals', 'events', 'market', 'decide', 'groups', 'pulse', 'beans', 'invite', 'community']);
    });

    it('(b) an enterprise keeper gets the enterprise card after deals', () => {
        const a = answer({ deals: { open: 1, waiting: 0, waitingOnMe: null }, enterprise: { id: 'x', name: 'Mullum Ceramics', requests: 3, others: 0 }, events, community },
            { me: me({ joinedAt: daysAgo(200), interests: ['arts'], isKeeper: true }) });
        expect(shownCards(a, null, { now: NOW })).toEqual(['deals', 'enterprise', 'events', 'community']);
    });

    it('(b) the operator of a brand-new node, alone: First steps and the community, nothing padded', () => {
        const a = answer({ steps, community: { name: 'New Town', members: 1, tradesThisMonth: 0 } });
        expect(shownCards(a, null, { now: NOW })).toEqual(['steps', 'interests', 'community']);
    });

    it('(c) a visitor in the global lobby: only the visitors\' cards, even if more were sent', () => {
        const a = answer({ find, market, events, pulse, joined: { count7d: 3, radiusKm: 50 }, community: { name: null, members: 2310, communities: 38 } },
            { profile: 'global', features: GLOBAL_FEATURES, welcome: true, me: null });
        expect(shownCards(a, null, { now: NOW })).toEqual(['find', 'events', 'market', 'community']);
    });

    it('a suspended member is never asked to tune or invite', () => {
        const a = answer({ community }, { me: me({ standing: 'suspended', firstOffer: true }) });
        expect(shownCards(a, null, { now: NOW })).toEqual(['community']);
    });

    it('a card the answer leaves out takes no space; the interests card follows the page\'s own interests and Tune', () => {
        const a = answer({ market, community });
        expect(shownCards(a, null, { now: NOW, interests: ['food'] })).toEqual(['market', 'community']);
        expect(shownCards(a, null, { now: NOW, interests: ['food'], interestsOpen: true })).toEqual(['interests', 'market', 'community']);
    });
});

describe('hide, move, reset (§4.1)', () => {
    const a = answer({ needs: { items: [] }, steps, events, market, pulse, beans, community });

    it('hides a card, and Edit home brings it back', () => {
        const hidden = hideCard(null, 'pulse', NOW);
        expect(hidden.hidden).toEqual(['pulse']);
        expect(hidden.updatedAt).toBe(new Date(NOW).toISOString());
        expect(shownCards(a, hidden, { now: NOW })).not.toContain('pulse');
        expect(editableCards(a, hidden, NOW).hidden).toEqual(['pulse']);
        expect(shownCards(a, showCard(hidden, 'pulse', NOW + 1), { now: NOW })).toContain('pulse');
    });

    it('needs and community can never be hidden, from a menu or from a stored layout', () => {
        expect(hideCard(null, 'needs', NOW).hidden).toEqual([]);
        expect(hideCard(null, 'community', NOW).hidden).toEqual([]);
        const stored = normalizeLayout({ v: 1, order: [], hidden: ['needs', 'community', 'beans'], updatedAt: daysAgo(0) })!;
        expect(stored.hidden).toEqual(['beans']);
        expect(canTailor('needs', a, NOW)).toBe(false);
        expect(canTailor('community', a, NOW)).toBe(false);
        expect(canTailor('safety', a, NOW)).toBe(false);
    });

    it('find is pinned for the first 30 days on the global node, then hideable; never pinned on a local node', () => {
        const young = answer({ find, community }, { profile: 'global', features: GLOBAL_FEATURES, me: me({ joinedAt: daysAgo(29) }) });
        const old = answer({ find, community }, { profile: 'global', features: GLOBAL_FEATURES, me: me({ joinedAt: daysAgo(31), interests: ['food'] }) });
        expect(findPinned(young, NOW)).toBe(true);
        expect(findPinned(old, NOW)).toBe(false);
        expect(findPinned(answer({}), NOW)).toBe(false);
        const l = hideCard(null, 'find', NOW);
        expect(shownCards(young, l, { now: NOW, interests: ['food'] })).toEqual(['find', 'community']);
        expect(shownCards(old, l, { now: NOW })).toEqual(['community']);
    });

    it('moves a card one place among the movable cards, never across needs or community, and writes the whole order', () => {
        const among = ['steps', 'events', 'market', 'pulse', 'beans'] as const;
        const up = moveCard(null, 'market', 'up', [...among], NOW);
        expect(shownCards(a, up, { now: NOW, interests: ['food'] })).toEqual(['needs', 'steps', 'market', 'events', 'pulse', 'beans', 'community']);
        expect(up.order).not.toContain('community');
        expect(moveCard(up, 'steps', 'up', ['steps', 'market'], NOW).order).toEqual(up.order);
        expect(moveCard(up, 'beans', 'down', [...among], NOW).order).toEqual(up.order);
    });

    it('reset puts the default back and keeps a dismissal', () => {
        const l = normalizeLayout({ v: 1, order: ['beans'], hidden: ['pulse'], dismissed: { safety: daysAgo(2) }, updatedAt: daysAgo(1) });
        const r = resetLayout(l, NOW);
        expect(r).toEqual({ v: 1, order: [], hidden: [], dismissed: { safety: daysAgo(2) }, updatedAt: new Date(NOW).toISOString() });
    });

    it('Edit home lists only cards this node can show', () => {
        const g = answer({ find, community }, { profile: 'global', features: GLOBAL_FEATURES, me: me({ joinedAt: daysAgo(60) }) });
        const ids = editableCards(g, null, NOW).shown;
        expect(ids).toContain('find');
        expect(ids).not.toContain('beans');
        expect(ids).not.toContain('deals');
        expect(ids).not.toContain('invite');
        expect(ids).not.toContain('needs');
        expect(editableCards(a, null, NOW).shown).not.toContain('find');
    });
});

describe('the layout from anywhere: unknown ids, merge (§4.1, §4.2)', () => {
    it('drops unknown and repeated ids, never refuses', () => {
        expect(normalizeLayout({ v: 1, order: ['weather', 'pulse', 'pulse', 7], hidden: ['news', 'beans'], dismissed: { safety: daysAgo(1), widget: daysAgo(1) }, updatedAt: daysAgo(0) }))
            .toEqual({ v: 1, order: ['pulse'], hidden: ['beans'], dismissed: { safety: daysAgo(1) }, updatedAt: daysAgo(0) });
    });

    it('is no layout at all when it is not a version-1 layout', () => {
        expect(normalizeLayout(null)).toBeNull();
        expect(normalizeLayout([])).toBeNull();
        expect(normalizeLayout('x')).toBeNull();
        expect(normalizeLayout({ v: 2, order: [] })).toBeNull();
        expect(normalizeLayout({ order: 'pulse', updatedAt: 'not a date' })).toEqual({ v: 1, order: [], hidden: [], dismissed: {}, updatedAt: null });
    });

    it('the last write wins by updatedAt; a dated layout beats an undated one; ties keep the first', () => {
        const older = normalizeLayout({ hidden: ['pulse'], updatedAt: daysAgo(2) });
        const newer = normalizeLayout({ hidden: ['beans'], updatedAt: daysAgo(1) });
        const undated = normalizeLayout({ hidden: ['events'] });
        expect(newerLayout(older, newer)).toBe(newer);
        expect(newerLayout(newer, older)).toBe(newer);
        expect(newerLayout(undated, older)).toBe(older);
        expect(newerLayout(null, older)).toBe(older);
        expect(newerLayout(older, null)).toBe(older);
        const twin = normalizeLayout({ hidden: ['joined'], updatedAt: daysAgo(2) });
        expect(newerLayout(older, twin)).toBe(older);
    });

    it('asks the node for every data card the layout shows, none it hides, and leaves the choice to the node with no layout', () => {
        const a = answer({ community });
        expect(askedCards(null, a, NOW)).toBeUndefined();
        const asked = askedCards(hideCard(null, 'pulse', NOW), a, NOW)!;
        expect(asked).not.toContain('pulse');
        expect(asked).not.toContain('interests');
        expect(asked).not.toContain('invite');
        expect(asked).toContain('needs');
        expect(asked).toContain('community');
    });

    it('a pinned find is always asked for, and so is a hidden one before any answer says whether it is pinned', () => {
        const hidden = hideCard(null, 'find', NOW);
        const young = answer({ community }, { profile: 'global', me: me({ joinedAt: daysAgo(3) }) });
        const old = answer({ community }, { profile: 'global', me: me({ joinedAt: daysAgo(40) }) });
        expect(askedCards(hidden, young, NOW)).toContain('find');
        expect(askedCards(hidden, old, NOW)).not.toContain('find');
        expect(askedCards(hidden, null, NOW)).toContain('find');
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
        expect(findBody(find)).toBe('Byron Shire BeanPool is 12 km away. Ask to join, and trade with your neighbours there.');
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
