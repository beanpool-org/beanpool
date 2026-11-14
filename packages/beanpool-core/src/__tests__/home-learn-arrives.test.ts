/**
 * Learn something local on Home (scratch/fable-design/DESIGN-local-knowledge-amend-fable.md §3.6, slice K7; Marty and Damo
 * took every pick on 11 Nov 2026): the `learn` type in the catalogue, its place in the default list, and the rule for a
 * card that arrives on a Home its member already arranged (pick 2): drawn once, after the member's own cards, while the
 * saved list neither holds it nor carries the stamp `new:learn`; Remove, a move, Keep on Home or Add a card writes the
 * stamp in that same save; nothing is written by itself.
 */
import { describe, expect, it } from 'vitest';
import {
    HOME_CARD_TYPES, HOME_DEFAULT_LIST, HOME_FRAME_LIMITS, HOME_V1_CARD_IDS, KNOWLEDGE_PLACE_LINE, LEARN_HOME_WORDS, addCard, arrivedStamp,
    arrivingCards, cardsToAsk, checkHomeLayout, endTourLayout, homeCardHue, homeCardType, homeCardsWithArrivals, keepArrivedCard, moveCard,
    readHomeLayout, removeCard, resetHomeLayout, type HomeLayoutV2, type HomeNodeFacts,
} from '../index.js';

const AT = '2026-11-14T09:00:00.000Z';
const NOW = Date.parse(AT);
const LATER = NOW + 60_000;
const one = (type: string) => ({ id: type, type });
const ids = (cards: { id: string }[]) => cards.map((c) => c.id);
/** A Home its member arranged before Learn something local existed: no `learn`, no stamp. */
const arranged = (cards = [one('market'), one('beans'), one('groups')], dismissed: Record<string, string> = {}): HomeLayoutV2 =>
    ({ v: 2, cards, dismissed, updatedAt: AT });
const STAMP = 'new:learn';

describe('K7: the learn type', () => {
    it('is one of a kind, Around you, sage, asked of the node, arriving; named as the design names it; never in version 1', () => {
        const learn = homeCardType('learn')!;
        expect(learn).toMatchObject({ id: 'learn', hue: 'sage', group: 'around', asks: 'node', arrives: true });
        expect(learn.name).toBe(LEARN_HOME_WORDS.name);
        expect(learn.name).toBe('Learn something local');
        expect(learn.line).toBe(KNOWLEDGE_PLACE_LINE);
        expect(learn.multiple).toBeUndefined();
        expect(learn.fixed).toBeUndefined();
        expect(HOME_V1_CARD_IDS).not.toContain('learn');
        expect(homeCardHue({ type: 'learn' })).toBe('sage');
        // The one type that arrives (the mark was K0's; the rule is this slice's).
        expect(HOME_CARD_TYPES.filter((t) => t.arrives).map((t) => t.id)).toEqual(['learn']);
    });

    it('is on where Learn is on, previewed where the node shows previews, and nowhere else (a server before Learn says nothing: off)', () => {
        const learn = homeCardType('learn')!;
        const local: HomeNodeFacts = { profile: 'local', features: { knowledge: true } };
        expect(learn.onNode(local)).toBe(true);
        expect(learn.onNode({ profile: 'local', features: {} })).toBe(false);
        expect(learn.onNode({ profile: 'local', features: { knowledge: false } })).toBe(false);
        expect(learn.onNode({ profile: 'global', features: {} })).toBe(false);
        // The global community with previews on: the apps draw Example Valley's samples (§2.9).
        expect(learn.onNode({ profile: 'global', features: { showcase: true } })).toBe(true);
    });

    it('is not in the default list yet (it joins after Asked near you with the slice that draws it on both apps); a Reset Home still has it arriving', () => {
        // Each app holds that it draws every card of the default list, so the card joins it when both apps draw it.
        expect(HOME_DEFAULT_LIST).not.toContain('learn');
        const reset = resetHomeLayout(arranged(), NOW);
        expect(ids(reset.cards)).not.toContain('learn');
        expect(arrivingCards(reset)).toEqual([one('learn')]);
        // Reset after the member put it away: the stamp is kept, so it stays away.
        expect(arrivingCards(resetHomeLayout(arranged(undefined, { [STAMP]: AT }), NOW))).toEqual([]);
    });
});

describe('K7: a card that arrives on an arranged Home', () => {
    it('is drawn once, after the member\'s own cards, while the list neither holds it nor carries its stamp', () => {
        const home = arranged();
        expect(arrivingCards(home)).toEqual([one('learn')]);
        expect(ids(homeCardsWithArrivals(home))).toEqual(['market', 'beans', 'groups', 'learn']);
        // Drawn once: one instance, never a second with the list.
        expect(homeCardsWithArrivals(home).filter((c) => c.type === 'learn')).toHaveLength(1);
        // Never for a list that holds it, wherever it stands in it.
        const holds = arranged([one('learn'), one('market')]);
        expect(arrivingCards(holds)).toEqual([]);
        expect(ids(homeCardsWithArrivals(holds))).toEqual(['learn', 'market']);
        // Never once its stamp is there, whatever the list says.
        expect(arrivingCards(arranged(undefined, { [STAMP]: AT }))).toEqual([]);
        // A Home never saved is the default list: the card arrives after it too, until the list holds it (then never).
        expect(arrivingCards(null)).toEqual([one('learn')]);
        expect(ids(homeCardsWithArrivals(null))).toEqual([...HOME_DEFAULT_LIST, 'learn']);
        const keptOnDefault = keepArrivedCard(null, 'learn', LATER);
        expect(ids(keptOnDefault.cards)).toEqual([...HOME_DEFAULT_LIST, 'learn']);
        expect(keptOnDefault.dismissed).toEqual({ [STAMP]: new Date(LATER).toISOString() });
        // A full Home has no room to keep it, so it does not arrive (Keep on Home must be able to keep it).
        const full = arranged(Array.from({ length: HOME_FRAME_LIMITS.cards }, (_, i) => ({ id: `search-a${String(i).padStart(3, '0')}`, type: 'search' })));
        expect(arrivingCards(full)).toEqual([]);
    });

    it('is asked of the node while it arrives, and not once it is stamped', () => {
        expect(cardsToAsk(arranged())).toEqual(['needs', 'market', 'learn', 'groups', 'beans', 'community']);
        expect(cardsToAsk(arranged(undefined, { [STAMP]: AT }))).toEqual(['needs', 'market', 'groups', 'beans', 'community']);
    });

    it('Remove writes the stamp and nothing else: the list as it was, and it never arrives again', () => {
        const home = arranged();
        const removed = removeCard(home, 'learn', LATER);
        expect(removed.cards).toEqual(home.cards);
        expect(removed.dismissed).toEqual({ [STAMP]: new Date(LATER).toISOString() });
        expect(removed.updatedAt).toBe(new Date(LATER).toISOString());
        expect(arrivingCards(removed)).toEqual([]);
        // The node takes the save, stamp and all.
        expect(checkHomeLayout(removed)).toMatchObject({ ok: true, layout: { dismissed: { [STAMP]: new Date(LATER).toISOString() } } });
        // A card that is neither in the list nor arriving is still left alone.
        expect(removeCard(removed, 'learn', LATER + 1)).toBe(removed);
        expect(removeCard(home, 'deals', LATER)).toBe(home);
    });

    it('Keep on Home puts it in the list where it was drawn (last) and writes the stamp, in one save', () => {
        const kept = keepArrivedCard(arranged(), 'learn', LATER);
        expect(ids(kept.cards)).toEqual(['market', 'beans', 'groups', 'learn']);
        expect(kept.dismissed[STAMP]).toBe(new Date(LATER).toISOString());
        expect(kept.updatedAt).toBe(new Date(LATER).toISOString());
        expect(arrivingCards(kept)).toEqual([]);
        // Kept already, or not arriving: unchanged.
        expect(keepArrivedCard(kept, 'learn', LATER + 1)).toBe(kept);
        const other = arranged();
        expect(keepArrivedCard(other, 'beans', LATER)).toBe(other);
        // Taken off later, it stays off: Remove keeps the stamp, and drops only the card's own dismissal.
        const off = removeCard(kept, 'learn', LATER + 5);
        expect(ids(off.cards)).toEqual(['market', 'beans', 'groups']);
        expect(off.dismissed[STAMP]).toBe(new Date(LATER + 5).toISOString());
        expect(arrivingCards(off)).toEqual([]);
    });

    it('a move keeps it first (last in the list, stamped), then moves it', () => {
        const up = moveCard(arranged(), 'learn', -1, LATER);
        expect(ids(up.cards)).toEqual(['market', 'beans', 'learn', 'groups']);
        expect(up.dismissed[STAMP]).toBe(new Date(LATER).toISOString());
        expect(arrivingCards(up)).toEqual([]);
        // Down from the last place: it cannot go further, and the move still keeps it, stamp and all.
        const down = moveCard(arranged(), 'learn', 1, LATER);
        expect(ids(down.cards)).toEqual(['market', 'beans', 'groups', 'learn']);
        expect(down.dismissed[STAMP]).toBe(new Date(LATER).toISOString());
    });

    it('Add a card writes the stamp too, so taking it off later never brings it back as arriving', () => {
        const added = addCard(arranged(), 'learn', { now: LATER });
        expect(added.ok).toBe(true);
        if (!added.ok) return;
        expect(ids(added.layout.cards)).toEqual(['learn', 'market', 'beans', 'groups']);
        expect(added.layout.dismissed[STAMP]).toBe(new Date(LATER).toISOString());
        const off = removeCard(added.layout, 'learn', LATER + 1);
        expect(arrivingCards(off)).toEqual([]);
        // Any other type's add writes no stamp.
        const beans = addCard(arranged([one('market')]), 'beans', { now: LATER });
        expect(beans.ok && beans.layout.dismissed).toEqual({});
    });

    it('nothing is written by itself: reading, drawing and asking leave the saved Home exactly as it was', () => {
        const home = arranged();
        const before = JSON.stringify(home);
        arrivingCards(home);
        homeCardsWithArrivals(home);
        cardsToAsk(home);
        expect(JSON.stringify(home)).toBe(before);
        // Read back from the node or the account, it carries no stamp and no learn until the member acts.
        const read = readHomeLayout(JSON.parse(before))!;
        expect(read.dismissed).toEqual({});
        expect(ids(read.cards)).toEqual(['market', 'beans', 'groups']);
        // Another type's edit writes no stamp either: a move of the Market, the safety card's own dismissal.
        expect(moveCard(home, 'beans', -1, LATER).dismissed).toEqual({});
        expect(removeCard(home, 'market', LATER).dismissed).toEqual({});
    });

    it('the stamp outlives Reset and the end of the tour, and rides through the tolerant read', () => {
        const stamped = arranged(undefined, { [STAMP]: AT, safety: AT });
        expect(resetHomeLayout(stamped, LATER).dismissed).toEqual({ [STAMP]: AT, safety: AT });
        expect(endTourLayout(stamped, { now: LATER }).dismissed).toEqual({ [STAMP]: AT, safety: AT });
        expect(readHomeLayout(stamped)!.dismissed).toEqual({ [STAMP]: AT, safety: AT });
        expect(arrivedStamp('learn')).toBe(STAMP);
        expect(STAMP.length).toBeLessThanOrEqual(HOME_FRAME_LIMITS.idChars);
    });
});
