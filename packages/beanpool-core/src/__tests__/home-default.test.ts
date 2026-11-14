/**
 * The default Home for a new member (scratch/fable-design/DESIGN-home-default-fable.md, slice D0; Marty's picks of 13 Nov
 * 2026): the default list of §2.2 from the first second, Welcome on top; ending the tour removes Welcome and adds nothing;
 * the tour's last step is one sentence and its chips are gone; First steps' two new lines, its count and its 30 days; Reset
 * keeps the member's own cards after the defaults.
 */
import { describe, expect, it } from 'vitest';
import * as core from '../index.js';
import {
    HOME_DEFAULT_LIST, HOME_FRAME_LIMITS, HOME_STARTER_SET, WELCOME_DAYS, cardsToAsk, defaultCards, defaultHomeLayout, endTourLayout,
    isOwnCard, resetHomeLayout, starterCards, welcomeDrawn, type HomeLayoutV2,
} from '../home-frame.js';
import { TOUR_STEP_MAX_CHARS, TOUR_WORDS, newcomerCards, tourRecord, tourSteps } from '../tour.js';
import {
    FIRST_STEPS_DAYS, FIRST_STEPS_LINE_IDS, FIRST_STEPS_WORDS, FIRST_WEEK_DAYS, firstStepsCount, firstStepsLeft, firstStepsOver,
} from '../first-steps.js';
import { toolHomeCardTypes } from '../tools/index.js';

const AT = '2026-11-13T05:00:00.000Z';
const NOW = Date.parse(AT);
const DAY = 86_400_000;
const ids = (cards: { id: string }[]) => cards.map((c) => c.id);
const lay = (cards: HomeLayoutV2['cards'], updatedAt: string | null = AT): HomeLayoutV2 => ({ v: 2, cards, dismissed: {}, updatedAt });
const one = (type: string) => ({ id: type, type });

describe('D0: the default list (§2.2)', () => {
    it("a newcomer's list is the seventeen, Welcome first, the Pulse after Coming up (DESIGN-pulse-home-fable.md §3.5, P0), Learn something local after Asked near you (DESIGN-local-knowledge-amend-fable.md §3.6, K7)", () => {
        const sixteen = ['start', 'safety', 'market', 'steps', 'interests', 'events', 'pulse', 'beans', 'asked', 'learn', 'deals', 'groups', 'decide', 'notices', 'joined', 'tips', 'sky'];
        expect(HOME_DEFAULT_LIST).toEqual(sixteen);
        // The same list on the worldwide community and on a local one: the card is there on both (§3.8).
        for (const p of ['local', 'global'] as const) expect(ids(defaultCards(p))).toEqual(sixteen);
        expect(defaultHomeLayout()).toEqual({ v: 2, cards: sixteen.map(one), dismissed: {}, updatedAt: null });
        // Each is a card the catalogue knows, one of a kind, and the list leaves seven places for the member's own.
        for (const id of sixteen) expect(core.homeCardType(id), id).toMatchObject({ id });
        expect(HOME_FRAME_LIMITS.cards - sixteen.length).toBe(7);
        // Learn something local sits right after Asked near you (§3.6 "Starter set").
        expect(sixteen.indexOf('learn')).toBe(sixteen.indexOf('asked') + 1);
        // The Pulse sits right after Coming up, before Your Beans (§3.5: position 7).
        expect(sixteen.indexOf('pulse')).toBe(sixteen.indexOf('events') + 1);
        // Left out on purpose (§2.2): Your enterprise, Your shop and tools, Grow your community, the member's own.
        for (const out of ['enterprise', 'shop', 'invite', 'search', 'chat', 'tools', 'find', 'needs', 'community']) expect(sixteen).not.toContain(out);
    });

    it('the starter set is the list less Welcome, in the same order', () => {
        expect(HOME_STARTER_SET).toEqual(HOME_DEFAULT_LIST.slice(1));
        expect(ids(starterCards())).toEqual(HOME_DEFAULT_LIST.slice(1));
    });

    it('a never-saved Home asks the node for every default card it builds, so the cards are there from the first second', () => {
        // Learn something local is in the list (slice K7), asked in its catalogue place.
        expect(cardsToAsk(null)).toEqual(['needs', 'safety', 'steps', 'deals', 'events', 'market', 'asked', 'learn', 'decide', 'groups', 'joined', 'pulse', 'beans', 'notices', 'community']);
    });

    it('with no saved layout: the default list while the tour has not ended, the list less Welcome after', () => {
        expect(ids(newcomerCards(null))).toEqual([...HOME_DEFAULT_LIST]);
        expect(ids(newcomerCards(tourRecord('open', NOW)))).toEqual([...HOME_DEFAULT_LIST]);
        expect(ids(newcomerCards(tourRecord('done', NOW)))).toEqual([...HOME_STARTER_SET]);
        expect(ids(newcomerCards(tourRecord('skipped', NOW)))).toEqual([...HOME_STARTER_SET]);
    });

    it('Welcome is drawn until the tour is done or Not now, seven days after joining at most', () => {
        expect(WELCOME_DAYS).toBe(7);
        expect(welcomeDrawn(false, AT, NOW)).toBe(true);
        expect(welcomeDrawn(false, new Date(NOW - 7 * DAY + 1).toISOString(), NOW)).toBe(true);
        expect(welcomeDrawn(false, new Date(NOW - 7 * DAY).toISOString(), NOW)).toBe(false);
        expect(welcomeDrawn(true, AT, NOW)).toBe(false);
        // No join date heard: the tour alone decides, the card is never hidden for a missing fact.
        expect(welcomeDrawn(false, null, NOW)).toBe(true);
        expect(welcomeDrawn(false, 'not a date', NOW)).toBe(true);
    });
});

describe('D0: the tour ends on the default list (§2.3)', () => {
    it('ending the tour on the default list leaves the other sixteen', () => {
        const ended = endTourLayout(null, { now: NOW });
        expect(ids(ended.cards)).toEqual([...HOME_DEFAULT_LIST.slice(1)]);
        expect(ended.cards).toHaveLength(16);
        expect(ended.updatedAt).toBe(AT);
        expect(ids(endTourLayout(defaultHomeLayout(), { now: NOW }).cards)).toEqual([...HOME_DEFAULT_LIST.slice(1)]);
    });

    it('adds nothing: a Home with Welcome alone ends empty but for the fixed two; an arranged Home keeps its order less Welcome', () => {
        expect(endTourLayout(lay([one('start')]), { now: NOW }).cards).toEqual([]);
        expect(ids(endTourLayout(lay([one('find'), one('start')]), { now: NOW }).cards)).toEqual(['find']);
        expect(ids(endTourLayout(lay([one('beans'), one('start'), one('market')]), { now: NOW }).cards)).toEqual(['beans', 'market']);
        expect(endTourLayout({ ...lay([one('start'), one('tips')]), dismissed: { start: AT, safety: AT } }, { now: NOW }).dismissed).toEqual({ safety: AT });
    });

    it("the tour's last step is one sentence and the chips are gone", () => {
        expect(TOUR_WORDS.cards).toBe("That's the tour. Home starts with a few cards. Add a card and Arrange are at the bottom.");
        expect(TOUR_WORDS.cards.length).toBeLessThanOrEqual(TOUR_STEP_MAX_CHARS);
        expect('tourChips' in core).toBe(false);
        for (const app of ['phone', 'web'] as const) expect(tourSteps(app, { global: false, beans: true }).at(-1)).toMatchObject({ id: 'cards', words: TOUR_WORDS.cards });
    });
});

describe('D0: Reset to defaults keeps the member\'s own cards (§3)', () => {
    const search = { id: 'search-abcd', type: 'search', settings: { q: 'eggs', kind: 'any' } };
    const chat = { id: 'chat-wxyz', type: 'chat', settings: { conversationId: 'c1', kind: 'dm', name: 'Ana' } };
    const future = { id: 'zzz-1', type: 'zzz-future', settings: { a: 1 } };

    it('Reset keeps a saved search after the defaults', () => {
        const reset = resetHomeLayout(lay([one('enterprise'), search, one('market'), one('start')]), NOW);
        expect(ids(reset.cards)).toEqual([...HOME_STARTER_SET, 'search-abcd']);
        expect(reset.cards.at(-1)).toEqual(search);
        expect(reset.updatedAt).toBe(AT);
    });

    it('keeps chats, Your tools, tool cards and unknown types too, in the member\'s order; drops catalogue cards not in the defaults; never Welcome', () => {
        const tool = toolHomeCardTypes()[0];
        const cards = [chat, one('enterprise'), { id: 'tools', type: 'tools', settings: { tools: ['garden'] } }, future, search, one('start')];
        if (tool) cards.splice(2, 0, one(tool.id));
        const reset = resetHomeLayout(lay(cards), NOW);
        const own = ['chat-wxyz', ...(tool ? [tool.id] : []), 'tools', 'zzz-1', 'search-abcd'];
        expect(ids(reset.cards)).toEqual([...HOME_STARTER_SET, ...own]);
        expect(ids(reset.cards)).not.toContain('start');
        expect(ids(reset.cards)).not.toContain('enterprise');
        expect(reset.cards.find((c) => c.id === 'zzz-1')).toEqual(future);
    });

    it('keeps the dismissals and the view; at most 24; a never-saved Home resets to the list less Welcome', () => {
        const many = Array.from({ length: 12 }, (_, i) => ({ id: `zzz-${i}`, type: 'zzz' }));
        const l: HomeLayoutV2 = { ...lay(many), dismissed: { safety: AT }, view: { columns: 2 } };
        const reset = resetHomeLayout(l, NOW);
        expect(reset.cards).toHaveLength(HOME_FRAME_LIMITS.cards);
        expect(reset.dismissed).toEqual({ safety: AT });
        expect(reset.view).toEqual({ columns: 2 });
        expect(ids(resetHomeLayout(null, NOW).cards)).toEqual([...HOME_STARTER_SET]);
        expect(resetHomeLayout(null, NOW)).not.toHaveProperty('view');
    });

    it('which cards are the member\'s own', () => {
        expect(isOwnCard({ type: 'search' })).toBe(true);
        expect(isOwnCard({ type: 'chat' })).toBe(true);
        expect(isOwnCard({ type: 'tools' })).toBe(true);
        expect(isOwnCard({ type: 'zzz-future' })).toBe(true);
        for (const t of toolHomeCardTypes()) expect(isOwnCard({ type: t.id })).toBe(true);
        for (const id of [...HOME_DEFAULT_LIST, 'pulse', 'enterprise', 'shop', 'invite', 'find']) expect(isOwnCard({ type: id }), id).toBe(false);
    });
});

describe('D0: First steps shrinks, then leaves (§2.4)', () => {
    it('the line ids: the five there are, then the two new ones last', () => {
        expect(FIRST_STEPS_LINE_IDS).toEqual(['offer', 'photo', 'interests', 'need', 'invite', 'words', 'notify']);
        expect(FIRST_STEPS_WORDS).toEqual({ words: 'Keep your 12 words safe', notify: 'Hear when someone answers you' });
    });

    it('only what is left is drawn, with the count of what is done', () => {
        const lines = [{ id: 'offer', done: true }, { id: 'photo', done: false }, { id: 'interests', done: true }, { id: 'words', done: false }, { id: 'notify', done: false }];
        expect(firstStepsLeft(lines).map((l) => l.id)).toEqual(['photo', 'words', 'notify']);
        expect(firstStepsCount(lines)).toBe('2 of 5 done');
        expect(firstStepsCount([])).toBe('');
    });

    it('30 days on a local community, 14 for global\'s first week; a join date not heard is never over', () => {
        expect(FIRST_STEPS_DAYS).toBe(30);
        expect(FIRST_WEEK_DAYS).toBe(14);
        expect(firstStepsOver(new Date(NOW - 30 * DAY + 1).toISOString(), NOW)).toBe(false);
        expect(firstStepsOver(new Date(NOW - 30 * DAY).toISOString(), NOW)).toBe(true);
        expect(firstStepsOver(new Date(NOW - 31 * DAY).toISOString(), NOW)).toBe(true);
        expect(firstStepsOver(new Date(NOW - 13 * DAY).toISOString(), NOW, 'global')).toBe(false);
        expect(firstStepsOver(new Date(NOW - 14 * DAY).toISOString(), NOW, 'global')).toBe(true);
        expect(firstStepsOver(null, NOW)).toBe(false);
        expect(firstStepsOver('soon', NOW)).toBe(false);
    });
});
