/**
 * Slice S5 of scratch/fable-design/DESIGN-onboarding-home-landing-fable.md on the phone's Home rules: the WELCOME TO
 * BEANPOOL! tile stands at the top and is not arrangeable (§4.1), is full for seven days and a band after until Got it or
 * the tour's end (§4.2, §4.3), a newcomer's only (nothing from day 30, §3.3, §4.2), shares the tour record with 1.4.7 ("Not now" there is "Got it" here), and BeanPool's part
 * is drawn for one community per phone (the local mark, utils/welcome-part.ts).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

const mem = vi.hoisted(() => ({ async: new Map<string, string>(), fail: false }));
vi.mock('react-native', () => ({ Platform: { OS: 'android' } }));
vi.mock('@react-native-async-storage/async-storage', () => ({
    default: {
        getItem: vi.fn(async (key: string) => { if (mem.fail) throw new Error('storage'); return mem.async.get(key) ?? null; }),
        setItem: vi.fn(async (key: string, value: string) => { mem.async.set(key, value); }),
        removeItem: vi.fn(async (key: string) => { mem.async.delete(key); }),
    },
}));

import { starterCards, tourRecord } from '@beanpool/core';
import { canMoveCard, cardOrder, cardsToDraw, welcomeShapeFor, welcomeUp, type HomeAnswer, type HomeLayout } from '../home-cards';
import { loadWelcomePart, markWelcomePart, readWelcomePartMark, welcomePartElsewhere } from '../welcome-part';
import { homeAccount } from '../home-account';

const NOW = Date.parse('2026-11-21T03:00:00.000Z');
const DAY = 86_400_000;
const iso = (ms: number) => new Date(ms).toISOString();
const ids = (l: { id: string }[]) => l.map(c => c.id);
const RIVERSIDE = 'https://riverside.example';
const HILLTOP = 'https://hilltop.example';

function answer(over: { joinedDaysAgo?: number; tour?: unknown; profile?: string; me?: null } = {}): HomeAnswer {
    const me = over.me === null ? null : {
        joinedAt: iso(NOW - (over.joinedDaysAgo ?? 0) * DAY), isKeeper: false, probation: null, interests: [], area: null, firstOffer: false,
        standing: 'member', ...(over.tour !== undefined ? { tour: over.tour } : {}),
    };
    return {
        generatedAt: iso(NOW), profile: over.profile ?? 'local',
        features: { beans: true, escrow: true, invites: true, exampleListings: false, decisions: true },
        me, layout: null, cards: { community: { name: 'Riverside', members: 12, tradesThisMonth: 3 } },
    } as unknown as HomeAnswer;
}
const ctx = (over: Record<string, unknown> = {}) => ({ interests: [] as string[], tuneOpen: false, safetyUp: false, now: NOW, ...over });
const layoutOf = (order: string[]): HomeLayout => ({ v: 2, cards: order.map(id => ({ id, type: id })), dismissed: {}, updatedAt: iso(NOW) });

describe('S5: the tile stands at the top of Home and is not arrangeable', () => {
    it('a Home never arranged: Needs you, the tile, Your way back in, First steps, the Market', () => {
        expect(ids(cardOrder(null)).slice(0, 5)).toEqual(['needs', 'start', 'safety', 'steps', 'market']);
    });

    it('an arranged Home that holds it lower: it is drawn at the top anyway, the member\'s order otherwise kept', () => {
        const arranged = layoutOf(['market', 'events', 'start', 'steps']);
        // (A card that arrives on an arranged Home, Learn something local, follows the member's own cards: core arrivingCards.)
        expect(ids(cardOrder(arranged)).slice(0, 5)).toEqual(['needs', 'start', 'market', 'events', 'steps']);
        expect(ids(cardOrder(arranged)).at(-1)).toBe('community');
        // The saved list itself is untouched: nothing is written by drawing it.
        expect(ids(arranged.cards)).toEqual(['market', 'events', 'start', 'steps']);
    });

    it('on the global community a pinned Find your community keeps its place under Needs you, the tile under it', () => {
        expect(ids(cardOrder(layoutOf(['market', 'start']), ['find'])).slice(0, 4)).toEqual(['needs', 'find', 'start', 'market']);
    });

    it('it cannot be moved (it leaves by Got it, the tour\'s end, or the band\'s ×); other cards still can', () => {
        expect(canMoveCard('start')).toBe(false);
        expect(canMoveCard('market')).toBe(true);
        expect(canMoveCard('steps')).toBe(true);
    });
});

describe('S5: full for seven days, then a band to day 30, until Got it or the tour ends', () => {
    it('day 1 full, day 8 and day 29 a band (never gone without a tap inside the newcomer\'s 30 days), day 31 nothing', () => {
        expect(welcomeShapeFor(answer({ joinedDaysAgo: 0 }), { now: NOW })).toBe('full');
        expect(welcomeShapeFor(answer({ joinedDaysAgo: 8 }), { now: NOW })).toBe('band');
        expect(welcomeShapeFor(answer({ joinedDaysAgo: 29 }), { now: NOW })).toBe('band');
        expect(welcomeShapeFor(answer({ joinedDaysAgo: 31 }), { now: NOW })).toBeNull();
        expect(ids(cardsToDraw(answer({ joinedDaysAgo: 8 }), { v: 2, cards: [{ id: 'start', type: 'start' }, ...starterCards()], dismissed: {}, updatedAt: null }, ctx()))).toContain('start');
    });

    it("a member of months who never ended the tour: no welcome on a new app's first Home, and no once-per-phone mark (design §3.3)", () => {
        // Joined in March 2026, never tapped Take the tour or Not now (1.4.7's card left by itself at day 7), no saved Home:
        // the default list holds Welcome, but it is not drawn, so Home's mark (index.tsx, `welcomeDrawnHere`) is never written.
        const veteran = { ...answer(), me: { ...answer().me!, joinedAt: '2026-03-12T09:00:00.000Z' } } as HomeAnswer;
        expect(welcomeShapeFor(veteran, { now: NOW })).toBeNull();
        expect(welcomeUp(veteran, { now: NOW })).toBe(false);
        expect(ids(cardsToDraw(veteran, null, ctx()))).not.toContain('start');
        expect(ids(cardsToDraw(veteran, { v: 2, cards: [{ id: 'start', type: 'start' }, ...starterCards()], dismissed: {}, updatedAt: iso(NOW - 200 * DAY) }, ctx()))).not.toContain('start');
        // Even with Take the tour again open on this phone: the tile is a newcomer's.
        expect(welcomeShapeFor(veteran, { now: NOW, tourOpen: true })).toBeNull();
    });

    it("Home writes the once-per-phone mark only when the tile is drawn here (the drawn list holds Welcome)", () => {
        const src = readFileSync(join(__dirname, '..', '..', 'app', '(tabs)', 'index.tsx'), 'utf8');
        expect(src).toMatch(/const welcomeDrawnHere = drawn\.some\(c => c\.type === 'start'\);/);
        expect(src).toMatch(/if \(!welcomeDrawnHere \|\| [^\n]*\) return;\s*\n\s*void markWelcomePart\(/);
    });

    it("Got it here or 1.4.7's Not now (the same 'skipped' record on the account), and the tour's end: gone on every device", () => {
        for (const tour of [tourRecord('skipped', NOW - DAY), { v: 1, state: 'skipped', at: iso(NOW - 3 * DAY) }, tourRecord('done', NOW)]) {
            for (const days of [0, 8]) {
                expect(welcomeShapeFor(answer({ joinedDaysAgo: days, tour }), { now: NOW }), JSON.stringify(tour)).toBeNull();
                expect(welcomeUp(answer({ joinedDaysAgo: days, tour }), { now: NOW })).toBe(false);
            }
        }
        // Got it on this phone before the account's answer says so.
        expect(welcomeShapeFor(answer(), { now: NOW, tourOver: true })).toBeNull();
        // Take the tour again ('open', or on this phone): back.
        expect(welcomeShapeFor(answer({ tour: tourRecord('open', NOW) }), { now: NOW })).toBe('full');
        expect(welcomeShapeFor(answer({ tour: tourRecord('skipped', NOW) }), { now: NOW, tourOpen: true })).toBe('full');
    });

    it('never a visitor\'s; never where another community on this phone drew BeanPool\'s part first', () => {
        expect(welcomeShapeFor(answer({ me: null }), { now: NOW })).toBeNull();
        expect(welcomeShapeFor(answer(), { now: NOW, welcomeElsewhere: true })).toBeNull();
        const drawn = ids(cardsToDraw(answer(), null, ctx({ welcomeElsewhere: true })));
        expect(drawn).not.toContain('start');
        expect(ids(cardsToDraw(answer(), null, ctx()))).toContain('start');
    });
});

describe("S5: BeanPool's part once per phone (the local mark)", () => {
    it('a stored mark is read tolerantly: anything odd is none, so the tile may show', () => {
        expect(readWelcomePartMark({ v: 1, where: 'riverside.example', at: iso(NOW) })).toEqual({ v: 1, where: 'riverside.example', at: iso(NOW) });
        for (const odd of [null, 'x', [], { v: 2, where: 'a', at: 'b' }, { v: 1, where: '', at: 'b' }, { v: 1, where: 3, at: 'b' }]) {
            expect(readWelcomePartMark(odd), JSON.stringify(odd)).toBeNull();
        }
    });

    it('the first community drawn keeps it (in any spelling of its address); a second community leaves it out', async () => {
        mem.async.clear();
        const whose = homeAccount('ab'.repeat(32));
        expect(await loadWelcomePart(whose.publicKey)).toBeNull();
        expect(welcomePartElsewhere(null, RIVERSIDE)).toBe(false);
        const mark = await markWelcomePart(whose, RIVERSIDE, NOW);
        expect(mark).not.toBeNull();
        expect(welcomePartElsewhere(mark, RIVERSIDE)).toBe(false);
        expect(welcomePartElsewhere(mark, 'HTTPS://Riverside.example/')).toBe(false);
        expect(welcomePartElsewhere(mark, HILLTOP)).toBe(true);
        // Written once: the second community never takes the mark over.
        const again = await markWelcomePart(whose, HILLTOP, NOW + DAY);
        expect(again).toEqual(mark);
        expect(welcomePartElsewhere(await loadWelcomePart(whose.publicKey), HILLTOP)).toBe(true);
        // Another account on the phone has its own (none yet): its first community shows the tile.
        expect(await loadWelcomePart('cd'.repeat(32))).toBeNull();
    });

    it('a phone that cannot read its storage draws the tile (never hidden for a missing fact)', async () => {
        mem.fail = true;
        try {
            expect(await loadWelcomePart('ab'.repeat(32))).toBeNull();
        } finally {
            mem.fail = false;
        }
    });
});
