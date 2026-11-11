/**
 * Home's card frame on the web (lib/home-layout.ts; CARD-FRAME-DESIGN-fable.md §1, §2, slice F3): the picker, adding,
 * removing, moving and resetting, which copy wins (the standby tie and the empty-v1 "unknown" rule), the one-time
 * "fewer cards" line, what is asked, and a newer app's card kept byte for byte. The phone's cases
 * (apps/native utils/__tests__/home-cards.test.ts), held to the same rules here.
 */
import { describe, expect, it } from 'vitest';
import { HOME_FRAME_LIMITS, starterCards, translateV1 } from '@beanpool/core';
/** The starter set as a saved Home (DESIGN-getting-started-fable.md §1): the list a newcomer's Home was before Getting started, and what Skip or Done leaves. */
const starterLayout = () => ({ v: 2 as const, cards: starterCards(), dismissed: {}, updatedAt: null as string | null });
import {
    FIND_PINNED_DAYS, HOME_COLUMN_GAP, HOME_COLUMN_MIN, HOME_PACK_FLIP_MS, HOME_PACK_MAX_FLIPS, HOME_PACK_ROW_GAP, HOME_PACK_ROW_HEIGHT, SEARCH_OFFLINE_LINE, addCard, addedLine, askPinned, cardLabelName, cardOrder, cardRowName, cardsToAsk, changeCardSettings,
    columnsFor, fewerCardsNews, gridWidth, layoutPrint,
    moveCard, moveCardTo, packHome, pickLayout, pickerGroups, pinnedCards, placeLifted, placedBoxes, readLayout, removeCard, removedLine,
    resetLayout, sameList, searchEmptyLine, searchFirstLine, settleHeights, type HomeLayoutV2, type PackHeight, type PackableCard,
} from './home-layout';
import { arrangeCards, cardLine, reorderAmong, reorderIds } from './home-layout';

const NOW = Date.UTC(2026, 9, 2, 4, 0, 0);
const H = 3_600_000;
const iso = (at: number) => new Date(at).toISOString();
const LOCAL = { profile: 'local', features: { beans: true, escrow: true, enterprises: true, invites: true, decisions: true } };
const GLOBAL = { profile: 'global', features: { beans: false, escrow: false, enterprises: false, invites: false, decisions: false } };
const ids = (l: { cards: { id: string }[] } | null) => l?.cards.map(c => c.id);
const NEWER = { id: 'sky-aaaa', type: 'skyline', settings: { place: { lat: -28.5, lng: 153.5 }, odd: [1, 'two'] } };

describe('the picker (§1.2)', () => {
    it('three groups in order, only this node\'s types, "On Home" for a one-of-a-kind there, "2 of 5 on Home" for an instance type', () => {
        const layout: HomeLayoutV2 = { ...starterLayout(), cards: [...starterCards(), { id: 'search-aaaa', type: 'search', settings: { q: 'eggs' } }, { id: 'search-bbbb', type: 'search', settings: { q: 'jam' } }] };
        const { groups, full } = pickerGroups(LOCAL, layout, 'admin');
        expect(full).toBe(false);
        expect(groups.map(g => g.name)).toEqual(['For you', 'Around you', 'Getting started']);
        const rows = groups.flatMap(g => g.rows);
        expect(rows.find(r => r.type === 'market')).toMatchObject({ state: 'on-home', count: null });
        expect(rows.find(r => r.type === 'beans')).toMatchObject({ name: 'Your Beans', state: 'add' });
        expect(rows.find(r => r.type === 'search')).toMatchObject({ state: 'add', count: '2 of 5 on Home', hasSettings: true });
        // Never the fixed two, never Find your community on a local node.
        expect(rows.map(r => r.type)).not.toContain('needs');
        expect(rows.map(r => r.type)).not.toContain('community');
        expect(rows.map(r => r.type)).not.toContain('find');
        for (const r of rows) expect(`${r.name} ${r.line}`).not.toMatch(/lock|earn|tier|Ʀ/i);
    });

    it('the worldwide community lists no Beans, deals, enterprise, Decide or Grow your community; "Near you" for the Market; a plain member where only admins invite gets no invite row', () => {
        const types = pickerGroups(GLOBAL, null, null).groups.flatMap(g => g.rows.map(r => r.type));
        for (const t of ['beans', 'deals', 'enterprise', 'decide', 'invite']) expect(types).not.toContain(t);
        expect(pickerGroups(GLOBAL, null, null).groups.flatMap(g => g.rows).find(r => r.type === 'market')!.name).toBe('Near you');
        const adminsOnly = { ...LOCAL, features: { ...LOCAL.features, door: 'admins' } };
        expect(pickerGroups(adminsOnly, null, null).groups.flatMap(g => g.rows.map(r => r.type))).not.toContain('invite');
        expect(pickerGroups(adminsOnly, null, 'owner').groups.flatMap(g => g.rows.map(r => r.type))).toContain('invite');
    });

    it('a full Home (24 cards): every Add goes; five saved searches: that row is full', () => {
        const cards = Array.from({ length: HOME_FRAME_LIMITS.cards }, (_, i) => ({ id: `x-${i}`, type: `x${i}` }));
        const full = pickerGroups(LOCAL, { ...starterLayout(), cards }, 'admin');
        expect(full.full).toBe(true);
        expect(full.groups.flatMap(g => g.rows).every(r => r.state !== 'add')).toBe(true);
        const five = Array.from({ length: 5 }, (_, i) => ({ id: `search-${i}aaa`, type: 'search', settings: { q: `w${i}` } }));
        const row = pickerGroups(LOCAL, { ...starterLayout(), cards: five }, 'admin').groups.flatMap(g => g.rows).find(r => r.type === 'search')!;
        expect(row).toMatchObject({ state: 'full', count: '5 of 5 on Home' });
    });
});

describe('adding, removing, moving, resetting (§1.3)', () => {
    it('Add puts the card first, under a pinned Find your community; a saved search keeps its settings; a sixth is refused', () => {
        const added = addCard(null, 'beans', NOW);
        expect(added.ok && added.layout.cards[0]).toEqual({ id: 'beans', type: 'beans' });
        expect(added.ok && added.layout.updatedAt).toBe(iso(NOW));
        const pinnedFirst: HomeLayoutV2 = { ...starterLayout(), cards: [{ id: 'find', type: 'find' }, ...starterCards()] };
        const under = addCard(pinnedFirst, 'pulse', NOW, { pinned: ['find'] });
        expect(under.ok && ids(under.layout)!.slice(0, 2)).toEqual(['find', 'pulse']);
        const search = addCard(null, 'search', NOW, { settings: { q: '  eggs  ', km: 5 }, random: () => 0 });
        expect(search.ok && search.layout.cards[0]).toEqual({ id: 'search-aaaa', type: 'search', settings: { q: 'eggs', kind: 'any', km: 5 } });
        expect(addCard(added.ok ? added.layout : null, 'beans', NOW)).toEqual({ ok: false, refused: 'on-home' });
        let l: HomeLayoutV2 | null = null;
        for (let i = 0; i < 5; i++) { const r = addCard(l, 'search', NOW, { settings: { q: `w${i}` } }); if (r.ok) l = r.layout; }
        expect(addCard(l, 'search', NOW)).toEqual({ ok: false, refused: 'type-full' });
        // A type this build can't draw is refused, never added blind.
        expect(addCard(null, 'skyline', NOW)).toEqual({ ok: false, refused: 'unknown' });
    });

    it('an edit\'s date is after its base, even on a browser whose clock runs slow', () => {
        const base: HomeLayoutV2 = { ...starterLayout(), updatedAt: iso(NOW + H) };
        const r = addCard(base, 'beans', NOW);
        expect(r.ok && Date.parse(r.layout.updatedAt!)).toBe(NOW + H + 1);
        expect(removeCard(base, 'tips', NOW)!.updatedAt).toBe(iso(NOW + H + 1));
    });

    it('remove: the instance goes with its dismissal; never `needs`, `community` or a pinned `find`', () => {
        const l: HomeLayoutV2 = { ...starterLayout(), dismissed: { safety: iso(NOW - H) } };
        const gone = removeCard(l, 'safety', NOW)!;
        expect(ids(gone)).not.toContain('safety');
        expect(gone.dismissed).toEqual({});
        expect(removeCard(l, 'community', NOW)).toBeNull();
        expect(removeCard({ ...l, cards: [{ id: 'find', type: 'find' }, ...l.cards] }, 'find', NOW, ['find'])).toBeNull();
        expect(removedLine(cardLabelName({ type: 'search', settings: { q: 'eggs' } }))).toBe('"eggs" removed. Add a card brings it back.');
        expect(addedLine(cardLabelName({ type: 'beans' }))).toBe('Your Beans added to Home');
    });

    it('move up and down past the card next to it on screen, keeping every other card\'s place', () => {
        const l: HomeLayoutV2 = { ...starterLayout(), cards: ['steps', 'tips', 'market', 'events', 'notices'].map(id => ({ id, type: id })) };
        // On screen: tips isn't drawn (no tip to show), so market moves up past steps.
        const shown = cardOrder(l).filter(c => c.id !== 'tips');
        expect(ids(moveCard(l, 'market', 'up', shown, NOW))).toEqual(['market', 'tips', 'steps', 'events', 'notices']);
        expect(ids(moveCard(l, 'events', 'down', shown, NOW))).toEqual(['steps', 'tips', 'market', 'notices', 'events']);
        expect(moveCard(l, 'steps', 'up', shown, NOW)).toBeNull();
        expect(moveCard(l, 'notices', 'down', shown, NOW)).toBeNull();
    });

    it('a drop (L3): the card goes to its place among the movable ones, the others keep their slots, and the shape is an arrow\'s', () => {
        const l: HomeLayoutV2 = { ...starterLayout(), cards: ['steps', 'tips', 'market', 'events', 'notices'].map(id => ({ id, type: id })) };
        // On screen: tips isn't drawn, so it keeps its slot whatever moves around it.
        const shown = cardOrder(l).filter(c => c.id !== 'tips');
        expect(ids(moveCardTo(l, 'notices', 0, shown, NOW)!)).toEqual(['notices', 'tips', 'steps', 'market', 'events']);
        expect(ids(moveCardTo(l, 'steps', 3, shown, NOW)!)).toEqual(['market', 'tips', 'events', 'notices', 'steps']);
        // One place is what an arrow does, with the same keys saved.
        const arrow = moveCard(l, 'events', 'up', shown, NOW)!;
        const drop = moveCardTo(l, 'events', 1, shown, NOW)!;
        expect(drop).toEqual(arrow);
        expect(Object.keys(drop)).toEqual(Object.keys(l));
        // Where it already stands, or a card that is not there: nothing to save.
        expect(moveCardTo(l, 'market', 1, shown, NOW)).toBeNull();
        expect(moveCardTo(l, 'nothing', 0, shown, NOW)).toBeNull();
    });

    it('a drag\'s preview never moves a card that stays here, and never lets one be passed', () => {
        const cards = [{ id: 'needs', type: 'needs' }, { id: 'find', type: 'find' }, { id: 'a', type: 'market' }, { id: 'b', type: 'events' }, { id: 'c', type: 'notices' }, { id: 'community', type: 'community' }];
        const live = (id: string, to: number) => reorderAmong(cards, id, to, ['find']).map(c => c.id);
        expect(live('c', 0)).toEqual(['needs', 'find', 'c', 'a', 'b', 'community']);
        expect(live('a', 99)).toEqual(['needs', 'find', 'b', 'c', 'a', 'community']);
        // The fixed two and a pin are no card to lift: asking changes nothing.
        expect(live('needs', 2)).toEqual(cards.map(c => c.id));
        expect(live('find', 0)).toEqual(cards.map(c => c.id));
        expect(live('community', 0)).toEqual(cards.map(c => c.id));
    });

    it('reorderIds (Arrange in place, A1): the preview moves among exactly the cards named, and reorderAmong is that with the types that can move', () => {
        const cards = [{ id: 'needs', type: 'needs' }, { id: 'a', type: 'market' }, { id: 'idle', type: 'decide' }, { id: 'b', type: 'events' }, { id: 'c', type: 'notices' }, { id: 'community', type: 'community' }];
        // `idle` is on the list but not drawn, so it is no slot of the drag: `to` counts among a, b and c, and its place never changes.
        const among = ['a', 'b', 'c'];
        const live = (id: string, to: number) => reorderIds(cards, among, id, to).map(c => c.id);
        expect(live('c', 0)).toEqual(['needs', 'c', 'idle', 'a', 'b', 'community']);
        expect(live('a', 2)).toEqual(['needs', 'b', 'idle', 'c', 'a', 'community']);
        // A card that is not among them (the one with nothing to show, a fixed card) is no card to lift.
        expect(live('idle', 0)).toEqual(cards.map(c => c.id));
        expect(live('needs', 1)).toEqual(cards.map(c => c.id));
        // Every card the types allow to move is the same call: what reorderAmong has always done.
        for (const id of ['a', 'idle', 'b', 'c']) {
            for (const to of [0, 1, 2, 3]) {
                expect(reorderAmong(cards, id, to).map(c => c.id), `${id} to ${to}`).toEqual(reorderIds(cards, ['a', 'idle', 'b', 'c'], id, to).map(c => c.id));
            }
        }
    });

    it('reset: the newcomer\'s list; a schedule\'s dismissal and a newer app\'s card are kept', () => {
        const l: HomeLayoutV2 = { v: 2, cards: [{ id: 'beans', type: 'beans' }, NEWER], dismissed: { safety: iso(NOW - H) }, updatedAt: iso(NOW - H) };
        const r = resetLayout(l, NOW);
        expect(r.cards).toEqual([...starterCards(), NEWER]);
        expect(r.dismissed).toEqual({ safety: iso(NOW - H) });
        expect(ids(resetLayout(null, NOW))).toEqual(starterCards().map(c => c.id));
    });

    it('the columns a member chose stay through every edit and through Reset: columns are no card (W0)', () => {
        const view = { columns: 2 as const, later: { kept: true } };
        const raw = JSON.parse(JSON.stringify({ v: 2, cards: [{ id: 'market', type: 'market' }, NEWER, { id: 'tips', type: 'tips' }], dismissed: {}, updatedAt: iso(NOW - H), view }));
        let l = readLayout(raw)!;
        expect(l.view).toEqual(view);
        const add = addCard(l, 'beans', NOW);
        l = add.ok ? add.layout : l;
        expect(l.view).toEqual(view);
        l = moveCard(l, 'tips', 'up', cardOrder(l), NOW)!;
        expect(l.view).toEqual(view);
        l = removeCard(l, 'market', NOW)!;
        expect(l.view).toEqual(view);
        const search = addCard(l, 'search', NOW, { settings: { q: 'eggs' }, random: () => 0 });
        if (!search.ok) throw new Error('the saved search was refused');
        l = changeCardSettings(search.layout, 'search-aaaa', { q: 'jam' }, NOW)!;
        expect(l.view).toEqual(view);
        const reset = resetLayout(l, NOW + 1);
        expect(JSON.stringify(reset.view)).toBe(JSON.stringify(view));
        expect(reset.cards).toEqual([...starterCards(), NEWER]);
        expect(resetLayout({ ...starterLayout(), cards: [] }, NOW)).not.toHaveProperty('view');
    });

    it('a card of a type this build doesn\'t know is kept through every edit, byte for byte, never drawn, never asked', () => {
        const raw = JSON.parse(JSON.stringify({ v: 2, cards: [{ id: 'market', type: 'market' }, NEWER, { id: 'tips', type: 'tips' }], dismissed: {}, updatedAt: iso(NOW - H) }));
        let l = readLayout(raw)!;
        const add = addCard(l, 'beans', NOW);
        l = add.ok ? add.layout : l;
        l = moveCard(l, 'tips', 'up', cardOrder(l), NOW)!;
        l = removeCard(l, 'market', NOW)!;
        const search = addCard(l, 'search', NOW, { settings: { q: 'eggs' }, random: () => 0 });
        if (!search.ok) throw new Error('the saved search was refused');
        l = changeCardSettings(search.layout, 'search-aaaa', { q: 'jam' }, NOW)!;
        l = resetLayout(l, NOW);
        expect(l.cards.at(-1)).toBe(l.cards.find(c => c.id === NEWER.id));
        expect(JSON.stringify(l.cards.find(c => c.id === NEWER.id))).toBe(JSON.stringify(NEWER));
        expect(cardOrder(l).map(c => c.id)).not.toContain(NEWER.id);
        expect(cardsToAsk(l)).not.toContain(NEWER.id);
    });

    it('Settings… → Save changes a saved search\'s words in place', () => {
        const added = addCard(null, 'search', NOW, { settings: { q: 'eggs' }, random: () => 0 });
        if (!added.ok) throw new Error('the saved search was refused');
        const moved = moveCard(added.layout, 'search-aaaa', 'down', cardOrder(added.layout), NOW)!;
        const saved = changeCardSettings(moved, 'search-aaaa', { q: 'jam', kind: 'offer' }, NOW)!;
        expect(ids(saved)).toEqual(ids(moved));
        expect(saved.cards.find(c => c.id === 'search-aaaa')!.settings).toEqual({ q: 'jam', kind: 'offer' });
        expect(changeCardSettings(saved, 'tips', { q: 'x' }, NOW)).toBeNull();
    });

    it('a chat card picked again for another chat takes a new id in the same place (the phone\'s rule); the same chat keeps its id', () => {
        const added = addCard(null, 'chat', NOW, { settings: { conversationId: 'conv-1', kind: 'dm', name: 'Ben' }, random: () => 0 });
        if (!added.ok) throw new Error('the chat card was refused');
        const before = ids(added.layout) ?? [];
        const at = before.indexOf('chat-aaaa');
        const renamed = changeCardSettings(added.layout, 'chat-aaaa', { conversationId: 'conv-1', kind: 'dm', name: 'Benjamin' }, NOW)!;
        expect(ids(renamed)).toEqual(before);
        const repicked = changeCardSettings(added.layout, 'chat-aaaa', { conversationId: 'g-7', kind: 'group', name: 'Garden crew' }, NOW)!;
        const after = ids(repicked) ?? [];
        expect(after[at]).toMatch(/^chat-[a-z2-7]{4}$/);
        expect(after[at]).not.toBe('chat-aaaa');
        expect(after.filter((_, i) => i !== at)).toEqual(before.filter((_, i) => i !== at));
        expect(repicked.cards[at].settings).toEqual({ conversationId: 'g-7', kind: 'group', name: 'Garden crew' });
    });
});

describe('which copy wins, and the members who were here before (§2.6)', () => {
    it('a member who edited with a version-1 app: their order, hidden cards left out (core\'s translateV1, still read, never written)', () => {
        const v1 = { v: 1, order: ['beans', 'market'], hidden: ['pulse'], dismissed: {}, updatedAt: iso(NOW - H) };
        expect(readLayout(v1)).toEqual(translateV1(v1));
        expect(ids(readLayout(v1))!.slice(0, 3)).toEqual(['beans', 'market', 'safety']);
        expect(ids(readLayout(v1))).not.toContain('pulse');
    });

    it('the newer copy wins by updatedAt; this browser\'s newer copy is sent', () => {
        const a: HomeLayoutV2 = { ...starterLayout(), updatedAt: iso(NOW) };
        const b: HomeLayoutV2 = { ...starterLayout(), cards: [], updatedAt: iso(NOW + H) };
        expect(pickLayout(a, b)).toEqual({ layout: b, push: true });
        expect(pickLayout(b, a)).toEqual({ layout: b, push: false });
        expect(pickLayout(null, a)).toEqual({ layout: a, push: true });
        expect(pickLayout(a, null)).toEqual({ layout: a, push: false });
        // A tie: the account's stands, and nothing is sent.
        expect(pickLayout(a, { ...a })).toEqual({ layout: a, push: false });
    });

    it('the one-time "fewer cards" line: a member who never edited and joined over a week ago; never a newcomer, never one who edited', () => {
        const old = { joinedAt: iso(NOW - 30 * 24 * H) };
        expect(fewerCardsNews(null, null, old, NOW)).toBe(true);
        expect(fewerCardsNews(null, null, { joinedAt: iso(NOW - 2 * 24 * H) }, NOW)).toBe(false);
        expect(fewerCardsNews(starterLayout(), null, old, NOW)).toBe(false);
        expect(fewerCardsNews(null, starterLayout(), old, NOW)).toBe(false);
        expect(fewerCardsNews(null, null, null, NOW)).toBe(false);
    });
});

describe('what is drawn and asked', () => {
    it('a stored list with 24 `market` or 7 `search` instances draws one Market and five searches (review of #1697, note c)', () => {
        const markets = Array.from({ length: 24 }, (_, i) => ({ id: i === 0 ? 'market' : `market-${i}`, type: 'market' }));
        expect(cardOrder({ ...starterLayout(), cards: markets }).map(c => c.id)).toEqual(['needs', 'market', 'community']);
        const searches = Array.from({ length: 7 }, (_, i) => ({ id: `search-${i}aaa`, type: 'search', settings: { q: `w${i}` } }));
        expect(cardOrder({ ...starterLayout(), cards: searches }).filter(c => c.type === 'search')).toHaveLength(5);
        const fixed = [{ id: 'community', type: 'community' }, { id: 'needs', type: 'needs' }, { id: 'market', type: 'market' }];
        expect(cardOrder({ ...starterLayout(), cards: fixed }).map(c => c.id)).toEqual(['needs', 'market', 'community']);
    });

    it('a pinned Find your community stands under Needs you, and under "Your way back in" while that one leads', () => {
        const answer = { profile: 'global', me: { joinedAt: iso(NOW - 2 * 24 * H) } };
        expect(pinnedCards(answer, NOW)).toEqual(['find']);
        expect(cardOrder(starterLayout(), ['find']).map(c => c.id).slice(0, 3)).toEqual(['needs', 'safety', 'find']);
        // A newcomer's Home (Getting started alone): the pin under Needs you, then the card.
        expect(cardOrder(null, ['find']).map(c => c.id)).toEqual(['needs', 'find', 'start', 'community']);
        expect(pinnedCards({ profile: 'local', me: null }, NOW)).toEqual([]);
    });

    it('a newcomer with no wait keeps Find as before L1: pinned, and asked for from the starter list, on day 3 and on the last day (Lounge L1, review of #2573)', () => {
        for (const days of [3, FIND_PINNED_DAYS - 0.001, null]) {
            const a = { profile: 'global', me: { joinedAt: days === null ? null : iso(NOW - days * 24 * H) } };
            expect(pinnedCards(a, NOW)).toEqual(['find']);
            // The starter list holds no `find`: the pin is the only thing that has it asked for.
            expect(cardsToAsk(starterLayout(), askPinned(a, NOW), GLOBAL)).toContain('find');
            expect(cardsToAsk(null, askPinned(a, NOW), GLOBAL)).toContain('find');
        }
    });

    it('a wait keeps Find past day 30, and it is asked for from a list that does not hold it (Lounge L1, review of #2573)', () => {
        const gone = { profile: 'global', me: { joinedAt: iso(NOW - (FIND_PINNED_DAYS + 10) * 24 * H) } };
        expect(pinnedCards(gone, NOW)).toEqual([]);
        expect(cardsToAsk(starterLayout(), askPinned(gone, NOW), GLOBAL)).not.toContain('find');

        // A knock open on day 40: the knock the browser remembers pins it, and is passed on when asking, or `cards=` omits it
        // and the node never builds the card that carries the waiting line.
        const knocks = [{ url: 'https://byron.example.org', sentAt: iso(NOW - 5 * H) }];
        expect(pinnedCards(gone, NOW, { knocks })).toEqual(['find']);
        expect(askPinned(gone, NOW, { knocks })).toEqual(['find']);
        expect(cardsToAsk(starterLayout(), askPinned(gone, NOW), GLOBAL)).not.toContain('find');
        expect(cardsToAsk(starterLayout(), askPinned(gone, NOW, { knocks }), GLOBAL)).toContain('find');
        expect(cardsToAsk(null, askPinned(gone, NOW, { hasOpenKnock: true }), GLOBAL)).toContain('find');

        // A watch the answer carries pins it without a knock.
        const watching = { ...gone, cards: { find: { watches: [{ place: 'byron' }] } } };
        expect(pinnedCards(watching, NOW)).toEqual(['find']);
        expect(cardsToAsk(starterLayout(), askPinned(watching, NOW), GLOBAL)).toContain('find');

        // A cancelled knock, or one past the days it can be answered, is no wait; a local node never pins it.
        expect(pinnedCards(gone, NOW, { knocks: [{ ...knocks[0], cancelledAt: iso(NOW - 2 * H) }] })).toEqual([]);
        expect(pinnedCards(gone, NOW, { knocks: [{ url: knocks[0].url, sentAt: iso(NOW - 62 * 24 * H) }] })).toEqual([]);
        expect(pinnedCards({ ...gone, profile: 'local' }, NOW, { knocks })).toEqual([]);
    });

    it('cards= is catalogue order then id, the same after a move; with an answer in hand the global node is asked no Beans, deals, enterprise or Decide (review of #1699, finding 5)', () => {
        const l: HomeLayoutV2 = { ...starterLayout(), cards: ['beans', 'deals', 'decide', 'enterprise', 'market', 'tips'].map(id => ({ id, type: id })) };
        const asked = cardsToAsk(l);
        expect(asked).toEqual(['needs', 'deals', 'enterprise', 'market', 'decide', 'beans', 'community']);
        expect(cardsToAsk(moveCard(l, 'market', 'up', cardOrder(l), NOW))).toEqual(asked);
        expect(cardsToAsk(l, ['find'], GLOBAL)).toEqual(['needs', 'find', 'market', 'community']);
        expect(cardsToAsk(l, [], LOCAL)).toEqual(asked);
    });
});

describe('this browser\'s own marked save, read back (review of #1701 confirmation, finding 2; review of #1715, finding 1)', () => {
    const sent: HomeLayoutV2 = {
        v: 2, updatedAt: iso(NOW),
        cards: [{ id: 'beans', type: 'beans' }, { id: 'search-aaaa', type: 'search', settings: { q: 'eggs', kind: 'any' } }],
        dismissed: { safety: iso(NOW - 2 * H) },
    };
    // As the node answers it: its keys in another order, its date held to the node's now.
    const answered = (at: number): HomeLayoutV2 => ({
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

    it('the columns a member chose are in the print, so a columns change counts as an edit; a Home that never chose prints as before (W0)', () => {
        // Pinned before W0: every mark a browser already keeps still matches its list.
        expect(layoutPrint(sent)).toBe('3be262bd5e15eebf');
        const two = { ...sent, view: { columns: 2 as const } };
        expect(sameList(sent, two)).toBe(false);
        expect(sameList(two, { ...two, view: { columns: 1 } })).toBe(false);
        expect(sameList(two, { ...answered(NOW - 5_000), view: { columns: 2 } })).toBe(true);
        // Read as core reads it: a columns no build knows prints as Auto.
        expect(layoutPrint({ ...sent, view: { columns: 5 } } as never)).toBe(layoutPrint({ ...sent, view: { columns: 'auto' } }));
    });

});

describe("a saved search's words on its card and in Arrange (CARD-FRAME §4, §5.2 item 20; slice F4)", () => {
    it('the first line is the words and the distance, the words alone with no point', () => {
        expect(searchFirstLine('eggs', 5)).toBe('eggs · within 5 km');
        expect(searchFirstLine('  duck   eggs ', 25)).toBe('duck eggs · within 25 km');
        expect(searchFirstLine('eggs', null)).toBe('eggs');
    });

    it("nothing found says so in the search's own words", () => {
        expect(searchEmptyLine('eggs', 5)).toBe('No eggs within 5 km right now');
        expect(searchEmptyLine('eggs', null)).toBe('No eggs right now');
        expect(SEARCH_OFFLINE_LINE).toBe('Shows when your community answers');
    });

    it("Arrange names a search's band by its words (bounded), any other card by its name", () => {
        expect(cardRowName({ type: 'search', settings: { q: 'eggs' } })).toBe('eggs');
        expect(cardRowName({ type: 'search', settings: { q: 'x'.repeat(40) } })).toBe(`${'x'.repeat(24)}…`);
        expect(cardRowName({ type: 'search', settings: {} })).toBe('A saved search');
        expect(cardRowName({ type: 'market' }, 'local')).not.toBe('');
        expect(cardLabelName({ type: 'search', settings: { q: 'eggs' } })).toBe('"eggs"');
        // Two searches with the same words and another kind read differently (review of #1716): Both says no kind.
        expect(cardRowName({ type: 'search', settings: { q: 'eggs', kind: 'offer' } })).toBe('Offers · eggs');
        expect(cardRowName({ type: 'search', settings: { q: 'eggs', kind: 'need' } })).toBe('Needs · eggs');
        expect(cardRowName({ type: 'search', settings: { q: 'eggs', kind: 'any' } })).toBe('eggs');
        expect(cardRowName({ type: 'search', settings: { q: 'x'.repeat(40), kind: 'need' } })).toBe(`Needs · ${'x'.repeat(24)}…`);
        expect(cardRowName({ type: 'search', settings: { kind: 'need' } })).toBe('A saved search');
        expect(cardLabelName({ type: 'search', settings: { q: 'eggs', kind: 'offer' } })).toBe('"eggs" (Offers)');
        expect(cardLabelName({ type: 'search', settings: { q: 'eggs', kind: 'need' } })).toBe('"eggs" (Needs)');
        expect(removedLine(cardLabelName({ type: 'search', settings: { q: 'eggs', kind: 'need' } }))).toBe('"eggs" (Needs) removed. Add a card brings it back.');
    });
});

describe('sun and moon in the picker and the list (CARD-FRAME §4, slice F5)', () => {
    it('is offered under Around you on a local community and the worldwide one, with settings, one of a kind', () => {
        for (const node of [LOCAL, GLOBAL]) {
            const around = pickerGroups(node, null, null).groups.find(g => g.id === 'around')!;
            expect(around.rows.find(r => r.type === 'sky'), node.profile).toMatchObject({ name: 'Sun and moon', line: 'Sunrise, sunset and the moon tonight.', state: 'add', hasSettings: true });
        }
        const added = addCard(null, 'sky', NOW, { settings: { place: 'me' } });
        expect(added.ok && added.layout.cards[0]).toEqual({ id: 'sky', type: 'sky', settings: { place: 'me' } });
        expect(added.ok && pickerGroups(LOCAL, added.layout, null).groups.flatMap(g => g.rows).find(r => r.type === 'sky')!.state).toBe('on-home');
        expect(added.ok && cardsToAsk(added.layout, [], LOCAL)).not.toContain('sky');
    });
});

describe('the columns on a wide screen (DESIGN-home-wide-and-content-fable.md D1, slice W2)', () => {
    it('as many 320–576 px columns as fit the page, up to three: two from 656 px, three from 992 px', () => {
        expect([320, 480, 655, 656, 991, 992, 1312, 2400].map(w => columnsFor(w))).toEqual([1, 1, 1, 2, 2, 3, 3, 3]);
        // Never a column under the phone's floor: two at 656 px are 320 px each with the 16 px gap between them.
        expect(HOME_COLUMN_MIN * 2 + HOME_COLUMN_GAP).toBe(656);
        expect(HOME_COLUMN_MIN * 3 + HOME_COLUMN_GAP * 2).toBe(992);
    });

    it('one column for a page not measured yet, or measured as nothing', () => {
        for (const w of [0, -10, Number.NaN, Number.POSITIVE_INFINITY]) expect(columnsFor(w), String(w)).toBe(1);
    });

    it('fewer columns asked for are kept where more would fit, and never more than fit', () => {
        expect(columnsFor(1312, 2)).toBe(2);
        expect(columnsFor(1312, 1)).toBe(1);
        expect(columnsFor(700, 3)).toBe(2);
    });

    it('the grid is never wider than its columns at 576 px and the gaps between them', () => {
        expect([1, 2, 3].map(gridWidth)).toEqual([576, 1168, 1760]);
    });
});

describe('packing by height on a wide screen (DESIGN-home-layout-fable.md §3.1, slice L1)', () => {
    it('packHome puts card 4 under the shortest of 1–3', () => {
        const cards: PackableCard[] = [
            { id: 'c1', height: 100 }, // span = ceil(116/4) = 29 -> bottoms[0] = 30
            { id: 'c2', height: 40 },  // span = ceil(56/4) = 14  -> bottoms[1] = 15
            { id: 'c3', height: 120 }, // span = ceil(136/4) = 34 -> bottoms[2] = 35
            { id: 'c4', height: 60 },  // shortest is col 2 (15)  -> span = ceil(76/4) = 19 -> bottoms[1] = 34
        ];
        const packed = packHome(cards, 3);
        expect(packed).toEqual([
            { id: 'c1', col: 1, rowStart: 1, rowSpan: 29 },
            { id: 'c2', col: 2, rowStart: 1, rowSpan: 14 },
            { id: 'c3', col: 3, rowStart: 1, rowSpan: 34 },
            { id: 'c4', col: 2, rowStart: 15, rowSpan: 19 },
        ]);
    });

    it('ties to the first column on equal heights', () => {
        const cards: PackableCard[] = [
            { id: 'c1', height: 100 },
            { id: 'c2', height: 100 },
            { id: 'c3', height: 100 },
            { id: 'c4', height: 50 },
        ];
        const packed = packHome(cards, 3);
        expect(packed[3]).toEqual({
            id: 'c4',
            col: 1,
            rowStart: 30,
            rowSpan: Math.ceil((50 + HOME_PACK_ROW_GAP) / HOME_PACK_ROW_HEIGHT),
        });
    });

    it('full rows wait for every column', () => {
        const cards: PackableCard[] = [
            { id: 'c1', height: 100 }, // span 29 -> bottom 30
            { id: 'c2', height: 40 },  // span 14 -> bottom 15
            { id: 'c3', height: 120 }, // span 34 -> bottom 35
            { id: 'c4', height: 50, fullRow: true }, // waits for max(30, 15, 35) = 35; span 17 -> bottoms = [52, 52, 52]
            { id: 'c5', height: 60 },  // starts at 52, ties to col 1
        ];
        const packed = packHome(cards, 3);
        expect(packed[3]).toEqual({
            id: 'c4',
            col: 1,
            rowStart: 35,
            rowSpan: 17,
            fullRow: true,
        });
        expect(packed[4]).toEqual({
            id: 'c5',
            col: 1,
            rowStart: 52,
            rowSpan: 19,
        });
    });

    it('one column gives no placement', () => {
        const cards: PackableCard[] = [
            { id: 'c1', height: 100 },
            { id: 'c2', height: 40 },
            { id: 'c3', height: 50, fullRow: true },
        ];
        expect(packHome(cards, 1)).toEqual([]);
        expect(packHome(cards, 0)).toEqual([]);
        expect(packHome(cards, -1)).toEqual([]);
        expect(packHome([], 3)).toEqual([]);
    });

    it('notes under a full-row first card wait and span all columns, followed by standard cards', () => {
        const cards: PackableCard[] = [
            { id: 'needs', height: 80, fullRow: true },    // span 24 -> bottoms = [25, 25, 25]
            { id: 'note-fewer', height: 40, fullRow: true }, // span 14 -> bottoms = [39, 39, 39]
            { id: 'note-hint', height: 40, fullRow: true },  // span 14 -> bottoms = [53, 53, 53]
            { id: 'tips', height: 100 },                     // span 29 -> col 1, row 53 -> bottom[0] = 82
            { id: 'events', height: 60 },                    // span 19 -> col 2, row 53 -> bottom[1] = 72
            { id: 'market', height: 120 },                   // span 34 -> col 3, row 53 -> bottom[2] = 87
            { id: 'pulse', height: 80 },                     // span 24 -> col 2 (shortest 72) -> bottom[1] = 96
            { id: 'community', height: 100, fullRow: true }, // span 29 -> max(82, 96, 87) = 96 -> bottoms = [125, 125, 125]
        ];
        const packed = packHome(cards, 3);
        expect(packed).toEqual([
            { id: 'needs', col: 1, rowStart: 1, rowSpan: 24, fullRow: true },
            { id: 'note-fewer', col: 1, rowStart: 25, rowSpan: 14, fullRow: true },
            { id: 'note-hint', col: 1, rowStart: 39, rowSpan: 14, fullRow: true },
            { id: 'tips', col: 1, rowStart: 53, rowSpan: 29 },
            { id: 'events', col: 2, rowStart: 53, rowSpan: 19 },
            { id: 'market', col: 3, rowStart: 53, rowSpan: 34 },
            { id: 'pulse', col: 2, rowStart: 72, rowSpan: 24 },
            { id: 'community', col: 1, rowStart: 96, rowSpan: 29, fullRow: true },
        ]);
    });

    it('gaps gone at 2 columns: cards pack under shortest column', () => {
        const cards: PackableCard[] = [
            { id: 'c1', height: 100 }, // span 29 -> col 1, row 1 -> bottom 30
            { id: 'c2', height: 40 },  // span 14 -> col 2, row 1 -> bottom 15
            { id: 'c3', height: 50 },  // span 17 -> col 2 (shortest 15), row 15 -> bottom 32
            { id: 'c4', height: 80 },  // span 24 -> col 1 (shortest 30), row 30 -> bottom 54
        ];
        const packed = packHome(cards, 2);
        expect(packed).toEqual([
            { id: 'c1', col: 1, rowStart: 1, rowSpan: 29 },
            { id: 'c2', col: 2, rowStart: 1, rowSpan: 14 },
            { id: 'c3', col: 2, rowStart: 15, rowSpan: 17 },
            { id: 'c4', col: 1, rowStart: 30, rowSpan: 24 },
        ]);
    });
});

describe('where a held card lands: placeLifted (DESIGN-home-arrange-in-place-fable.md §2.3, slice A2)', () => {
    type Item = PackableCard & { movable?: boolean };
    const stack = (...hs: number[]): Item[] => hs.map((height, i) => ({ id: String.fromCharCode(97 + i), height, movable: true }));
    /** The lifted card's box with it at place `to`. */
    const boxAt = (items: Item[], id: string, to: number, cols: number, colWidth: number, gap: number) =>
        placedBoxes(reorderIds(items, items.filter(i => i.movable).map(i => i.id), id, to), cols, colWidth, gap).get(id)!;
    const inside = (p: { x: number; y: number }, b: { x: number; y: number; width: number; height: number }) => p.x >= b.x && p.x <= b.x + b.width && p.y >= b.y && p.y <= b.y + b.height;
    const away = (p: { x: number; y: number }, b: { x: number; y: number; width: number; height: number }) =>
        Math.hypot(Math.max(b.x - p.x, 0, p.x - b.x - b.width), Math.max(b.y - p.y, 0, p.y - b.y - b.height));

    it('one column: the place whose box holds the pointer, the card under the finger moving down', () => {
        // a b c d, 100 px each with 16 px between: a 0–100, b 116–216, c 232–332, d 348–448.
        const items = stack(100, 100, 100, 100);
        expect(placeLifted(items, 'd', { x: 50, y: 40 }, 1, 300, 16, 3)).toBe(0);
        expect(placeLifted(items, 'd', { x: 50, y: 150 }, 1, 300, 16, 3)).toBe(1);
        expect(placeLifted(items, 'd', { x: 50, y: 300 }, 1, 300, 16, 3)).toBe(2);
        expect(placeLifted(items, 'a', { x: 50, y: 440 }, 1, 300, 16, 0)).toBe(3);
        // Past the last card, or above the first: the nearest place.
        expect(placeLifted(items, 'a', { x: 50, y: 900 }, 1, 300, 16, 0)).toBe(3);
        expect(placeLifted(items, 'd', { x: 50, y: -60 }, 1, 300, 16, 3)).toBe(0);
        // The cards that can't move keep their slots: Needs you on top stays first whatever the pointer says.
        const fixed: Item[] = [{ id: 'needs', height: 80, fullRow: true }, ...stack(100, 100, 100)];
        expect(placeLifted(fixed, 'c', { x: 50, y: 10 }, 1, 300, 16, 2)).toBe(0);
        expect(placeLifted(fixed, 'needs', { x: 50, y: 300 }, 1, 300, 16, 0)).toBe(0);
    });

    it('one column: a lifted card taller than the one under the pointer goes before it, wherever on that card the pointer is', () => {
        // a b c at 100 px, the lifted d at 300 px, last. On Home: a 0–100, b 116–216, c 232–332.
        const items = stack(100, 100, 100, 300);
        for (const y of [120, 160, 210]) expect(placeLifted(items, 'd', { x: 50, y }, 1, 300, 16, 3), `pointer at ${y} on b`).toBe(1);
        for (const y of [240, 330]) expect(placeLifted(items, 'd', { x: 50, y }, 1, 300, 16, 3), `pointer at ${y} on c`).toBe(2);
        // To go after c, point below it.
        expect(placeLifted(items, 'd', { x: 50, y: 420 }, 1, 300, 16, 3)).toBe(3);
    });

    // A busy Home at 1280 px (three columns of 320 px): Needs you, the six Marty has (Sun and moon, Your beans, Your groups,
    // Tips, New in the market, Coming up), First steps, the strip and the tile, and the community card last.
    const BUSY: Item[] = [
        { id: 'needs', height: 84, fullRow: true },
        { id: 'sky', height: 86, movable: true }, { id: 'beans', height: 94, movable: true }, { id: 'groups', height: 172, movable: true },
        { id: 'tips', height: 168, movable: true }, { id: 'market', height: 176, movable: true }, { id: 'events', height: 236, movable: true },
        { id: 'steps', height: 120, movable: true },
        { id: 'arrange-strip', height: 220, fullRow: true }, { id: 'arrange-add', height: 48, fullRow: true },
        { id: 'community', height: 120, fullRow: true },
    ];
    const MOVABLE = BUSY.filter(i => i.movable).map(i => i.id);
    const COL = 320;
    const GAP = HOME_COLUMN_GAP;

    it('three columns: wherever some place puts the card under the pointer, the card goes to one of those places; elsewhere, to the nearest', () => {
        const home = placedBoxes(BUSY, 3, COL, GAP);
        const column = (x: number) => Math.floor(x / (COL + GAP));
        let overCards = 0;
        let hops = 0;
        for (const id of MOVABLE) {
            for (let col = 0; col < 3; col++) {
                for (let y = 0; y <= 700; y += 10) {
                    const p = { x: col * (COL + GAP) + COL / 2, y };
                    const current = MOVABLE.indexOf(id);
                    const to = placeLifted(BUSY, id, p, 3, COL, GAP, current);
                    const boxes = MOVABLE.map((_, k) => boxAt(BUSY, id, k, 3, COL, GAP));
                    const can = boxes.map((b, k) => (inside(p, b) ? k : -1)).filter(k => k >= 0);
                    if (can.length) expect(can, `${id} at column ${col + 1}, ${y} px`).toContain(to);
                    else expect(away(p, boxes[to]), `${id} at column ${col + 1}, ${y} px: the nearest`).toBeCloseTo(Math.min(...boxes.map(b => away(p, b))), 6);
                    // Pointed at another card where Home draws it: does the held card land in the pointer's column?
                    if (MOVABLE.some(o => o !== id && inside(p, home.get(o)!))) {
                        overCards++;
                        if (column(boxes[to].x) !== col) hops++;
                    }
                }
            }
        }
        // Pointed at another card, the held card lands in the pointer's column (design §5's stop: more than 2 drops in 20 a column
        // over). Measured on this fixture: 0 of 642 points; the rest of "as near as the columns allow" is up or down.
        expect(overCards).toBeGreaterThan(200);
        expect(hops / overCards).toBeLessThanOrEqual(0.1);
    });

    it('three columns: a pointer in column 3 puts the card in column 3 when a place lands there, and where none can (under the columns) the nearest box wins', () => {
        // Tips held over column 3, just under Your groups: the place before Coming up lands it there.
        const groups = boxAt(BUSY, 'groups', MOVABLE.indexOf('groups'), 3, COL, GAP);
        expect(groups.x).toBe(2 * (COL + GAP));
        const p = { x: 2 * (COL + GAP) + 40, y: groups.y + groups.height + 30 };
        const to = placeLifted(BUSY, 'tips', p, 3, COL, GAP, MOVABLE.indexOf('tips'));
        expect(boxAt(BUSY, 'tips', to, 3, COL, GAP).x).toBe(2 * (COL + GAP));
        expect(inside(p, boxAt(BUSY, 'tips', to, 3, COL, GAP))).toBe(true);
        // Far under every column, past the community card: nothing lands there, so the place whose box is nearest.
        const deep = { x: 2 * (COL + GAP) + 40, y: 5000 };
        const toDeep = placeLifted(BUSY, 'tips', deep, 3, COL, GAP, MOVABLE.indexOf('tips'));
        const all = MOVABLE.map((_, k) => away(deep, boxAt(BUSY, 'tips', k, 3, COL, GAP)));
        expect(all[toDeep]).toBe(Math.min(...all));
        expect(all.some(d => d === 0)).toBe(false);
    });

    it('the same point twice gives the same place, and a still pointer never flips it back and forth', () => {
        for (const id of MOVABLE) {
            for (const p of [{ x: 100, y: 200 }, { x: 500, y: 260 }, { x: 900, y: 330 }, { x: 500, y: 90 }]) {
                const first = placeLifted(BUSY, id, p, 3, COL, GAP, MOVABLE.indexOf(id));
                const again = placeLifted(BUSY, id, p, 3, COL, GAP, first);
                expect(again, `${id} at ${p.x}, ${p.y}`).toBe(first);
                expect(placeLifted(BUSY, id, p, 3, COL, GAP, again)).toBe(first);
            }
        }
    });

    it('a tie goes to the place nearest the current one, then the smaller', () => {
        // One column, the lifted d 300 px tall: at y 250 its box holds the pointer at places 0, 1 and 2 (0–300, 116–416, 232–532).
        const items = stack(100, 100, 100, 300);
        const p = { x: 50, y: 250 };
        expect([0, 1, 2].every(k => inside(p, boxAt(items, 'd', k, 1, 300, 16)))).toBe(true);
        expect(placeLifted(items, 'd', p, 1, 300, 16, 3)).toBe(2);
        expect(placeLifted(items, 'd', p, 1, 300, 16, 1)).toBe(1);
        expect(placeLifted(items, 'd', p, 1, 300, 16, 0)).toBe(0);
        // Equally near the current place on either side (two zero-height cards make three places one box): the smaller.
        const flat = stack(0, 0, 0, 100);
        expect(placeLifted(flat, 'd', { x: 50, y: 50 }, 1, 300, 0, 1)).toBe(1);
        expect(placeLifted(flat, 'd', { x: 50, y: 50 }, 1, 300, 0, 1.5)).toBe(1);
    });

    it('a card that is not one that moves, or not there, keeps its place', () => {
        expect(placeLifted(BUSY, 'needs', { x: 10, y: 600 }, 3, COL, GAP, 4)).toBe(4);
        expect(placeLifted(BUSY, 'nobody', { x: 10, y: 600 }, 3, COL, GAP, 2)).toBe(2);
    });

    it('placedBoxes: packed cells in px from the first column and the grid top; one column a plain stack', () => {
        const items: Item[] = [{ id: 'n', height: 80, fullRow: true }, { id: 'x', height: 100 }, { id: 'y', height: 40 }];
        const packed = placedBoxes(items, 2, 300, 16);
        expect(packed.get('n')).toEqual({ x: 0, y: 0, width: 616, height: 80 });
        // Needs you spans ceil((80 + 16) / 4) = 24 rows: the next cards start at row 25, 96 px down.
        expect(packed.get('x')).toEqual({ x: 0, y: 96, width: 300, height: 100 });
        expect(packed.get('y')).toEqual({ x: 316, y: 96, width: 300, height: 40 });
        const plain = placedBoxes(items, 1, 300, 12);
        expect(plain.get('x')).toEqual({ x: 0, y: 92, width: 300, height: 100 });
        expect(plain.get('y')).toEqual({ x: 0, y: 204, width: 300, height: 40 });
    });
});

describe('settleHeights: a height that keeps turning back stops moving the cards (PR #2748)', () => {
    const report = (was: Readonly<Record<string, PackHeight>>, height: number, now: number) => settleHeights(was, { tips: height }, now);

    it('a new height lands, in a new object; the old one is left as it was', () => {
        const was = settleHeights({}, { tips: 100 }, 0);
        const frozen = JSON.stringify(was);
        const now = report(was, 140, 1000);
        expect(now.tips.height).toBe(140);
        expect(now).not.toBe(was);
        expect(JSON.stringify(was)).toBe(frozen);
    });

    it('the same height, or none, gives back the same object: React renders nothing', () => {
        const was = settleHeights({}, { tips: 100 }, 0);
        expect(report(was, 100, 1)).toBe(was);
        expect(report(was, 0, 1)).toBe(was);
        expect(settleHeights(was, {}, 1)).toBe(was);
        expect(settleHeights({}, { tips: Number.NaN }, 1)).toEqual({});
    });

    it('turning back quickly and for ever: bounded, and it stands at the taller height', () => {
        let was = settleHeights({}, { tips: 100 }, 0);
        let moves = 0;
        for (let i = 1; i <= 100; i += 1) {
            const next = report(was, i % 2 ? 140 : 100, i * 16);
            if (next.tips.height !== was.tips.height) moves += 1;
            was = next;
        }
        expect(moves).toBeLessThanOrEqual(HOME_PACK_MAX_FLIPS + 2);
        expect(was.tips.height).toBe(140);
        expect(report(was, 100, 101 * 16).tips.height).toBe(140);
    });

    it('three heights going round are bounded the same way', () => {
        let was = settleHeights({}, { tips: 100 }, 0);
        let moves = 0;
        const round = [140, 180, 100];
        for (let i = 0; i < 99; i += 1) {
            const next = report(was, round[i % 3], (i + 1) * 16);
            if (next.tips.height !== was.tips.height) moves += 1;
            was = next;
        }
        expect(moves).toBeLessThanOrEqual(HOME_PACK_MAX_FLIPS * 2 + 2);
        expect(was.tips.height).toBe(180);
    });

    it('growing always lands, even past the limit: a stale short height is an overlap', () => {
        let was = settleHeights({}, { tips: 100 }, 0);
        for (let i = 1; i <= 20; i += 1) was = report(was, i % 2 ? 140 : 100, i * 16);
        expect(report(was, 300, 400).tips.height).toBe(300);
    });

    it('growing lands even on the turn past the limit: after a slow shrink, that turn is a rise', () => {
        let was = settleHeights({}, { tips: 140 }, 0);
        was = report(was, 100, 1000);
        [140, 100, 140, 100, 140].forEach((h, i) => { was = report(was, h, 1016 + i * 16); });
        expect(was.tips.flips).toBeGreaterThan(HOME_PACK_MAX_FLIPS);
        expect(was.tips.height).toBe(140);
    });

    it('a held card lets go once it has been still: the shrink that comes after lands', () => {
        let was = settleHeights({}, { tips: 100 }, 0);
        for (let i = 1; i <= 20; i += 1) was = report(was, i % 2 ? 140 : 100, i * 16);
        const held = was.tips;
        expect(held.height).toBe(140);
        expect(report(was, 100, held.at + HOME_PACK_FLIP_MS - 1).tips.height).toBe(140);
        expect(report(was, 100, held.at + HOME_PACK_FLIP_MS).tips.height).toBe(100);
    });

    it('a person opening and closing a card, however often, is never held', () => {
        let was = settleHeights({}, { tips: 100 }, 0);
        for (let i = 1; i <= 21; i += 1) was = report(was, i % 2 ? 300 : 100, i * HOME_PACK_FLIP_MS);
        expect(was.tips.height).toBe(300);
        expect(report(was, 100, 22 * HOME_PACK_FLIP_MS).tips.height).toBe(100);
    });

    it('a window dragged one way is never held: heights going one way are not turns', () => {
        let was = settleHeights({}, { tips: 400 }, 0);
        for (let i = 1; i <= 100; i += 1) was = report(was, 400 - i, i);
        expect(was.tips.height).toBe(300);
    });

    it('one card going round holds only that card', () => {
        let was = settleHeights({}, { tips: 100, market: 200 }, 0);
        for (let i = 1; i <= 20; i += 1) was = settleHeights(was, { tips: i % 2 ? 140 : 100 }, i * 16);
        const now = settleHeights(was, { tips: 100, market: 150 }, 21 * 16);
        expect(now.tips.height).toBe(140);
        expect(now.market.height).toBe(150);
    });
});

describe('the cards Arrange folds (DESIGN-home-layout-fable.md §3.2)', () => {
    const order = [{ id: 'needs', type: 'needs' }, { id: 'market', type: 'market' }, { id: 'sky', type: 'sky' }, { id: 'chat', type: 'chat' }, { id: 'community', type: 'community' }];
    const onNode = (type: string) => type !== 'chat';

    it('what is drawn, and every other card on the list this node can show, in the list\'s order', () => {
        expect(arrangeCards(order, [{ id: 'market' }, { id: 'community' }], onNode).map(c => c.id)).toEqual(['market', 'sky', 'community']);
    });

    it('a fixed card or a pin only while it is drawn: nothing to show there means no band to say it stays', () => {
        expect(arrangeCards(order, [{ id: 'needs' }, { id: 'community' }], onNode).map(c => c.id)).toEqual(['needs', 'market', 'sky', 'community']);
        const find = { id: 'find', type: 'find' };
        expect(arrangeCards([find, ...order], [], () => true, ['find']).map(c => c.id)).toEqual(['market', 'sky', 'chat']);
    });

    it("a folded card's line is the catalogue's; a type nobody knows has none", () => {
        expect(cardLine('events')).toBe('Events coming up soon.');
        expect(cardLine('future-card')).toBe('');
    });
});
