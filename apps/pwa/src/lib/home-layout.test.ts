/**
 * Home's card frame on the web (lib/home-layout.ts; CARD-FRAME-DESIGN-fable.md §1, §2, slice F3): the picker, adding,
 * removing, moving and resetting, which copy wins (the standby tie and the empty-v1 "unknown" rule), the one-time
 * "fewer cards" line, what is asked, and a newer app's card kept byte for byte. The phone's cases
 * (apps/native utils/__tests__/home-cards.test.ts), held to the same rules here.
 */
import { describe, expect, it } from 'vitest';
import { HOME_FRAME_LIMITS, defaultCards, defaultHomeLayout, translateV1 } from '@beanpool/core';
import {
    MARK_SENT_MAX, addCard, addedLine, cardLabelName, cardOrder, cardsToAsk, changeCardSettings, fewerCardsNews, layoutPrint, layoutV1Of,
    moveCard, ownMarkedSave, pickLayout, pickerGroups, pinnedCards, readLayout, readMarkSent, rememberMarkSent, removeCard, removedLine,
    resetLayout, sameList, type HomeLayoutV2,
} from './home-layout';

const NOW = Date.UTC(2026, 9, 2, 4, 0, 0);
const H = 3_600_000;
const iso = (at: number) => new Date(at).toISOString();
const LOCAL = { profile: 'local', features: { beans: true, escrow: true, enterprises: true, invites: true, decisions: true } };
const GLOBAL = { profile: 'global', features: { beans: false, escrow: false, enterprises: false, invites: false, decisions: false } };
const ids = (l: { cards: { id: string }[] } | null) => l?.cards.map(c => c.id);
const NEWER = { id: 'sky-aaaa', type: 'skyline', settings: { place: { lat: -28.5, lng: 153.5 }, odd: [1, 'two'] } };

describe('the picker (§1.2)', () => {
    it('three groups in order, only this node\'s types, "On Home" for a one-of-a-kind there, "2 of 5 on Home" for an instance type', () => {
        const layout: HomeLayoutV2 = { ...defaultHomeLayout(), cards: [...defaultCards(), { id: 'search-aaaa', type: 'search', settings: { q: 'eggs' } }, { id: 'search-bbbb', type: 'search', settings: { q: 'jam' } }] };
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
        const full = pickerGroups(LOCAL, { ...defaultHomeLayout(), cards }, 'admin');
        expect(full.full).toBe(true);
        expect(full.groups.flatMap(g => g.rows).every(r => r.state !== 'add')).toBe(true);
        const five = Array.from({ length: 5 }, (_, i) => ({ id: `search-${i}aaa`, type: 'search', settings: { q: `w${i}` } }));
        const row = pickerGroups(LOCAL, { ...defaultHomeLayout(), cards: five }, 'admin').groups.flatMap(g => g.rows).find(r => r.type === 'search')!;
        expect(row).toMatchObject({ state: 'full', count: '5 of 5 on Home' });
    });
});

describe('adding, removing, moving, resetting (§1.3)', () => {
    it('Add puts the card first, under a pinned Find your community; a saved search keeps its settings; a sixth is refused', () => {
        const added = addCard(null, 'beans', NOW);
        expect(added.ok && added.layout.cards[0]).toEqual({ id: 'beans', type: 'beans' });
        expect(added.ok && added.layout.updatedAt).toBe(iso(NOW));
        const pinnedFirst: HomeLayoutV2 = { ...defaultHomeLayout(), cards: [{ id: 'find', type: 'find' }, ...defaultCards()] };
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
        const base: HomeLayoutV2 = { ...defaultHomeLayout(), updatedAt: iso(NOW + H) };
        const r = addCard(base, 'beans', NOW);
        expect(r.ok && Date.parse(r.layout.updatedAt!)).toBe(NOW + H + 1);
        expect(removeCard(base, 'tips', NOW)!.updatedAt).toBe(iso(NOW + H + 1));
    });

    it('remove: the instance goes with its dismissal; never `needs`, `community` or a pinned `find`', () => {
        const l: HomeLayoutV2 = { ...defaultHomeLayout(), dismissed: { safety: iso(NOW - H) } };
        const gone = removeCard(l, 'safety', NOW)!;
        expect(ids(gone)).not.toContain('safety');
        expect(gone.dismissed).toEqual({});
        expect(removeCard(l, 'community', NOW)).toBeNull();
        expect(removeCard({ ...l, cards: [{ id: 'find', type: 'find' }, ...l.cards] }, 'find', NOW, ['find'])).toBeNull();
        expect(removedLine(cardLabelName({ type: 'search', settings: { q: 'eggs' } }))).toBe('"eggs" removed. Add a card brings it back.');
        expect(addedLine(cardLabelName({ type: 'beans' }))).toBe('Your Beans added to Home');
    });

    it('move up and down past the card next to it on screen, keeping every other card\'s place', () => {
        const l: HomeLayoutV2 = { ...defaultHomeLayout(), cards: ['steps', 'tips', 'market', 'events', 'notices'].map(id => ({ id, type: id })) };
        // On screen: tips isn't drawn (no tip to show), so market moves up past steps.
        const shown = cardOrder(l).filter(c => c.id !== 'tips');
        expect(ids(moveCard(l, 'market', 'up', shown, NOW))).toEqual(['market', 'tips', 'steps', 'events', 'notices']);
        expect(ids(moveCard(l, 'events', 'down', shown, NOW))).toEqual(['steps', 'tips', 'market', 'notices', 'events']);
        expect(moveCard(l, 'steps', 'up', shown, NOW)).toBeNull();
        expect(moveCard(l, 'notices', 'down', shown, NOW)).toBeNull();
    });

    it('reset: the newcomer\'s list; a schedule\'s dismissal and a newer app\'s card are kept', () => {
        const l: HomeLayoutV2 = { v: 2, cards: [{ id: 'beans', type: 'beans' }, NEWER], dismissed: { safety: iso(NOW - H) }, updatedAt: iso(NOW - H) };
        const r = resetLayout(l, NOW);
        expect(r.cards).toEqual([...defaultCards(), NEWER]);
        expect(r.dismissed).toEqual({ safety: iso(NOW - H) });
        expect(ids(resetLayout(null, NOW))).toEqual(defaultCards().map(c => c.id));
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
});

describe('which copy wins, and the members who were here before (§2.6)', () => {
    it('a member who edited with a version-1 app: their order, hidden cards left out (translateV1); a v1 mark says whether it named anything', () => {
        const v1 = { v: 1, order: ['beans', 'market'], hidden: ['pulse'], dismissed: {}, updatedAt: iso(NOW - H) };
        expect(readLayout(v1)).toEqual(translateV1(v1));
        expect(ids(readLayout(v1))!.slice(0, 3)).toEqual(['beans', 'market', 'safety']);
        expect(ids(readLayout(v1))).not.toContain('pulse');
        expect(layoutV1Of(v1)).toEqual({ empty: false });
        expect(layoutV1Of({ v: 1, order: [], hidden: [], updatedAt: null })).toEqual({ empty: true });
        expect(layoutV1Of({ v: 2, cards: [] })).toBeUndefined();
    });

    it('the newer copy wins by updatedAt; this browser\'s newer copy is sent', () => {
        const a: HomeLayoutV2 = { ...defaultHomeLayout(), updatedAt: iso(NOW) };
        const b: HomeLayoutV2 = { ...defaultHomeLayout(), cards: [], updatedAt: iso(NOW + H) };
        expect(pickLayout(a, b)).toEqual({ layout: b, push: true });
        expect(pickLayout(b, a)).toEqual({ layout: b, push: false });
        expect(pickLayout(null, a)).toEqual({ layout: a, push: true });
        expect(pickLayout(a, null)).toEqual({ layout: a, push: false });
    });

    it('a not-yet-updated standby answers a v2 row as an empty v1 layout dated like it: this browser\'s v2 copy wins, on a tie and after (review of #1697, note b)', () => {
        const local: HomeLayoutV2 = { v: 2, cards: [{ id: 'search-k7mq', type: 'search', settings: { q: 'eggs', kind: 'any' } }, ...defaultCards()], dismissed: {}, updatedAt: iso(NOW) };
        const emptyV1 = { v: 1, order: [], hidden: [], updatedAt: iso(NOW) };
        expect(pickLayout(readLayout(emptyV1), local, layoutV1Of(emptyV1))).toEqual({ layout: local, push: false });
        const later = { ...emptyV1, updatedAt: iso(NOW + H) };
        expect(pickLayout(readLayout(later), local, layoutV1Of(later))).toEqual({ layout: local, push: false });
        const edited = { v: 1, order: ['beans'], hidden: ['pulse'], updatedAt: iso(NOW + H) };
        expect(pickLayout(readLayout(edited), local, layoutV1Of(edited)).layout).toEqual(readLayout(edited));
        const tie = { ...edited, updatedAt: iso(NOW) };
        expect(pickLayout(readLayout(tie), local, layoutV1Of(tie))).toEqual({ layout: local, push: false });
    });

    it('no copy here and an empty v1 account list: unknown, so the newcomer\'s list; an edit made then loses to the account\'s real list dated at or after it (review of #1699, finding 2)', () => {
        const at = iso(NOW - 2 * H);
        const standby = { v: 1, order: [], hidden: [], dismissed: { safety: at }, updatedAt: at };
        expect(pickLayout(readLayout(standby), null, layoutV1Of(standby))).toEqual({ layout: { ...defaultHomeLayout(), dismissed: { safety: at } }, push: false });
        const edit: HomeLayoutV2 = { v: 2, cards: defaultCards().filter(c => c.type !== 'events'), dismissed: {}, updatedAt: iso(NOW) };
        expect(pickLayout(readLayout(standby), edit, layoutV1Of(standby), at)).toEqual({ layout: edit, push: true });
        const real: HomeLayoutV2 = { v: 2, cards: [{ id: 'pulse', type: 'pulse' }, { id: 'market', type: 'market' }], dismissed: {}, updatedAt: at };
        // The real list returns: it wins and the placeholder edit is never sent.
        expect(pickLayout(real, edit, undefined, at)).toEqual({ layout: real, push: false });
        expect(pickLayout(real, edit)).toEqual({ layout: edit, push: true });
        expect(pickLayout({ ...real, updatedAt: iso(NOW - 3 * H) }, edit, undefined, at)).toEqual({ layout: edit, push: true });
        expect(pickLayout(real, edit, undefined, '')).toEqual({ layout: real, push: false });
    });

    it('the one-time "fewer cards" line: a member who never edited and joined over a week ago; never a newcomer, never one who edited', () => {
        const old = { joinedAt: iso(NOW - 30 * 24 * H) };
        expect(fewerCardsNews(null, null, old, NOW)).toBe(true);
        expect(fewerCardsNews(null, null, { joinedAt: iso(NOW - 2 * 24 * H) }, NOW)).toBe(false);
        expect(fewerCardsNews(defaultHomeLayout(), null, old, NOW)).toBe(false);
        expect(fewerCardsNews(null, defaultHomeLayout(), old, NOW)).toBe(false);
        expect(fewerCardsNews(null, null, null, NOW)).toBe(false);
    });
});

describe('what is drawn and asked', () => {
    it('a stored list with 24 `market` or 7 `search` instances draws one Market and five searches (review of #1697, note c)', () => {
        const markets = Array.from({ length: 24 }, (_, i) => ({ id: i === 0 ? 'market' : `market-${i}`, type: 'market' }));
        expect(cardOrder({ ...defaultHomeLayout(), cards: markets }).map(c => c.id)).toEqual(['needs', 'market', 'community']);
        const searches = Array.from({ length: 7 }, (_, i) => ({ id: `search-${i}aaa`, type: 'search', settings: { q: `w${i}` } }));
        expect(cardOrder({ ...defaultHomeLayout(), cards: searches }).filter(c => c.type === 'search')).toHaveLength(5);
        const fixed = [{ id: 'community', type: 'community' }, { id: 'needs', type: 'needs' }, { id: 'market', type: 'market' }];
        expect(cardOrder({ ...defaultHomeLayout(), cards: fixed }).map(c => c.id)).toEqual(['needs', 'market', 'community']);
    });

    it('a pinned Find your community stands under Needs you, and under "Your way back in" while that one leads', () => {
        const answer = { profile: 'global', me: { joinedAt: iso(NOW - 2 * 24 * H) } };
        expect(pinnedCards(answer, NOW)).toEqual(['find']);
        expect(cardOrder(null, ['find']).map(c => c.id).slice(0, 3)).toEqual(['needs', 'safety', 'find']);
        expect(pinnedCards({ profile: 'local', me: null }, NOW)).toEqual([]);
    });

    it('cards= is catalogue order then id, the same after a move; with an answer in hand the global node is asked no Beans, deals, enterprise or Decide (review of #1699, finding 5)', () => {
        const l: HomeLayoutV2 = { ...defaultHomeLayout(), cards: ['beans', 'deals', 'decide', 'enterprise', 'market', 'tips'].map(id => ({ id, type: id })) };
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

    it('the same list dated as sent or earlier is this browser\'s; dated later, another list, or a version-1 answer is not', () => {
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

    it('an entry an older build kept (a date alone) still loads and matches by its date only', () => {
        const old = readMarkSent([iso(NOW), 7, 'x'.repeat(41), { at: iso(NOW - H), print: 'not-a-print' }, null]);
        expect(old).toEqual([{ at: iso(NOW) }, { at: iso(NOW - H) }]);
        expect(ownMarkedSave(answered(NOW), undefined, old)).toBe(true);
        expect(ownMarkedSave(answered(NOW - 200), undefined, old)).toBe(false);
        const kept = readMarkSent(JSON.parse(JSON.stringify(rememberMarkSent(old, sent))));
        expect(ownMarkedSave(answered(NOW - 200), undefined, kept)).toBe(true);
        expect(readMarkSent('nope')).toEqual([]);
    });

    it('at most the latest eight, and a date sent again keeps its latest list', () => {
        let marks = rememberMarkSent([], sent);
        for (let i = 1; i <= 10; i++) marks = rememberMarkSent(marks, { ...sent, updatedAt: iso(NOW + i) });
        expect(marks).toHaveLength(MARK_SENT_MAX);
        expect(marks[0].at).toBe(iso(NOW + 3));
        const again = rememberMarkSent(marks, { ...sent, cards: [sent.cards[0]], updatedAt: iso(NOW + 10) });
        expect(again).toHaveLength(MARK_SENT_MAX);
        expect(again.at(-1)).toEqual({ at: iso(NOW + 10), print: layoutPrint({ ...sent, cards: [sent.cards[0]] }) });
        expect(rememberMarkSent(marks, { ...sent, updatedAt: null })).toEqual(marks);
    });
});
