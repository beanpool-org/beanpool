/**
 * The Tool shed's screens' rules (shed.ts, slices T1.2 and T1.3): a thing's state and its line, the filters, each change
 * the screens make to the document, the List draft, and the loans view. The phone's and the web's screens draw these;
 * their own tests check the drawing.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { pseudoLocalise, setLanguage } from '../../../words.js';
import { TOOL_LIMITS } from '../../manifest.js';
import type { ToolDealSummary } from '../../host.js';
import { THINGS_MAX_ITEMS, THINGS_NAME_CHARS, readThingsDoc, type Thing, type ThingsDoc } from '../doc.js';
import { FIXTURES } from '../fixtures.js';
import { thingsCounts } from '../manifest.js';
import {
    BACK_AROUND_DAYS, THING_FILTERS, backAroundChip, backAroundIn, findThing, forgetOffer, lendOutside, markBack, offersToLink,
    openDealsByPost, removeThing, saveThing, setListed, shedFits, shedFullLine, shedHasRoom, shedThings, shedTooBigLine,
    takeOutOfShop, thingCategories, thingCategory, thingConditionName, thingInFilter, thingInput, thingInputProblems,
    thingListDraft, thingState, thingStateLine, thingsLoans, type ThingInput,
} from '../shed.js';

afterEach(() => setLanguage('en'));

const NOW = Date.parse('2026-10-20T09:00:00.000Z');
const DAY = 86_400_000;
const iso = (ms: number) => new Date(ms).toISOString();
const thing = (id: string, name: string, extra: Partial<Thing> = {}): Thing => ({ id, name, createdAt: iso(NOW - DAY), updatedAt: iso(NOW - DAY), ...extra });
const doc = (...things: Thing[]): ThingsDoc => ({ v: 1, things });
const deal = (postId: string, status: string, extra: Partial<ToolDealSummary> = {}): ToolDealSummary => ({
    postId, transactionId: `tx-${postId}-${status}`, status, updatedAt: iso(NOW - 2 * DAY), ...extra,
});
const blank = (over: Partial<ThingInput> = {}): ThingInput => ({ ...thingInput(), ...over });

describe('a thing\'s state, its line and the filters', () => {
    it('lent outside beats an Offer; an agreed deal is out, an asked one is asked; a paused Offer is taken out; else the shelf', () => {
        const open = openDealsByPost([deal('p1', 'pending'), deal('p2', 'requested'), deal('p3', 'completed')]);
        expect(thingState(thing('a', 'Drill', { postId: 'p1' }), open)).toBe('out');
        expect(thingState(thing('b', 'Ladder', { postId: 'p2' }), open)).toBe('asked');
        expect(thingState(thing('c', 'Tent', { postId: 'p3' }), open)).toBe('listed');
        expect(thingState(thing('d', 'Saw', { postId: 'p1', lentTo: { name: 'Sam', since: iso(NOW) } }), open)).toBe('lent');
        expect(thingState(thing('e', 'Pram', { pausedPostId: 'p9' }), open)).toBe('taken-out');
        expect(thingState(thing('f', 'Axe'), open)).toBe('shelf');
        // A newer app's lentTo this build can't read is not "lent".
        expect(thingState(thing('g', 'Hoe', { lentTo: 'Al' as never }))).toBe('shelf');
    });

    it('an agreed deal wins over one only asked for on the same Offer, and the later of two alike', () => {
        const open = openDealsByPost([
            deal('p1', 'requested', { updatedAt: iso(NOW) }),
            deal('p1', 'pending', { updatedAt: iso(NOW - 5 * DAY), transactionId: 'agreed' }),
            deal('p2', 'requested', { updatedAt: iso(NOW - 3 * DAY), transactionId: 'older' }),
            deal('p2', 'requested', { updatedAt: iso(NOW - DAY), transactionId: 'later' }),
            deal('p3', 'cancelled'),
        ]);
        expect(open.get('p1')?.transactionId).toBe('agreed');
        expect(open.get('p2')?.transactionId).toBe('later');
        expect(open.has('p3')).toBe(false);
    });

    it('the filters: In your shop is listed or asked for; Out is out or lent; the shelf holds what is taken out too', () => {
        const by = (f: (typeof THING_FILTERS)[number]) => (['shelf', 'taken-out', 'listed', 'asked', 'out', 'lent'] as const).filter((s) => thingInFilter(s, f));
        expect(by('all')).toEqual(['shelf', 'taken-out', 'listed', 'asked', 'out', 'lent']);
        expect(by('shop')).toEqual(['listed', 'asked']);
        expect(by('out')).toEqual(['out', 'lent']);
        expect(by('shelf')).toEqual(['shelf', 'taken-out']);
    });

    it('each line in English, with the dates as the apps write them; overdue says so', () => {
        const open = openDealsByPost([deal('p1', 'pending', { backAround: iso(NOW + 3 * DAY) }), deal('p2', 'pending', { backAround: iso(NOW - DAY) }), deal('p3', 'pending')]);
        const line = (t: Thing) => thingStateLine(t, open, NOW);
        expect(line(thing('a', 'Drill'))).toBe('On your shelf');
        expect(line(thing('a', 'Drill', { pausedPostId: 'p8' }))).toBe('Taken out of your shop');
        expect(line(thing('a', 'Drill', { postId: 'p9' }))).toBe('In your shop');
        expect(thingStateLine(thing('a', 'Drill', { postId: 'p4' }), openDealsByPost([deal('p4', 'requested')]), NOW)).toBe('In your shop · someone asked to borrow it');
        expect(line(thing('a', 'Drill', { postId: 'p1' }))).toBe('Out on a loan · back around 23 Oct');
        expect(line(thing('a', 'Drill', { postId: 'p2' }))).toBe('Out on a loan · was due back 19 Oct');
        expect(line(thing('a', 'Drill', { postId: 'p3' }))).toBe('Out on a loan');
        expect(line(thing('a', 'Drill', { lentTo: { name: 'Sam', since: iso(NOW - 2 * DAY) } }))).toBe('With Sam since 18 Oct');
        expect(line(thing('a', 'Drill', { lentTo: { name: 'Sam', since: iso(NOW - 2 * DAY), backAround: iso(NOW + DAY) } }))).toBe('With Sam · back around 21 Oct');
        expect(line(thing('a', 'Drill', { lentTo: { name: 'Sam', since: iso(NOW - 9 * DAY), backAround: iso(NOW - DAY) } }))).toBe('With Sam · was due back 19 Oct');
        expect(line(thing('a', 'Drill', { lentTo: { name: 'Sam', since: 'not a date' } }))).toBe('With Sam');
    });

    it('through t(): in the pseudo-locale every line is bracketed, the member\'s words inside', () => {
        setLanguage('xx');
        const l = thingStateLine(thing('a', 'Drill', { lentTo: { name: 'Sam', since: iso(NOW - 2 * DAY) } }), new Map(), NOW);
        expect(l.startsWith('[') && l.endsWith(']')).toBe(true);
        expect(l).toContain('Sam');
        expect(thingStateLine(thing('a', 'Drill'), new Map(), NOW)).toBe(pseudoLocalise('On your shelf'));
    });

    it('the list: things the member still has, newest first; a deleted thing and an unreadable item are never shown', () => {
        const d = readThingsDoc({ v: 2, things: [thing('a', 'First'), { odd: true }, thing('b', 'Gone', { gone: true }), thing('c', 'Last')] });
        expect(shedThings(d).map((t) => t.id)).toEqual(['c', 'a']);
        expect(findThing(d, 'a')?.name).toBe('First');
        expect(findThing(d, 'b')).toBeNull();
        expect(findThing(d, null)).toBeNull();
    });
});

describe('categories and conditions', () => {
    it('Tools first, every Market category after it, each named through t(); an unknown id reads as General', () => {
        const cats = thingCategories();
        expect(cats[0]).toMatchObject({ id: 'tools', emoji: '🛠️', name: 'Tools & Hardware' });
        expect(cats).toHaveLength(17);
        expect(new Set(cats.map((c) => c.id)).size).toBe(17);
        expect(thingCategory('garden').name).toBe('Plants & Garden');
        expect(thingCategory('plants_garden').id).toBe('garden');
        expect(thingCategory('something new').id).toBe('general');
        expect(thingCategory(undefined).id).toBe('tools');
    });

    it('three conditions by name; none, or a newer app\'s, is null', () => {
        expect(['good', 'fair', 'needs_care', 'shiny', undefined].map(thingConditionName)).toEqual(['Good', 'Fair', 'Needs care', null, null]);
    });
});

describe('the edit screen: its fields, what stops a save, and saving', () => {
    it('a new thing starts blank, in Tools; a kept one starts with what it has', () => {
        expect(thingInput()).toEqual({ name: '', category: 'tools', condition: '', replacementValue: '', lendTerms: '', lendMaxDays: '', ownerNote: '', photo: null });
        const t = thing('a', 'Drill', { category: 'garden', condition: 'fair', replacementValue: '$80', lendTerms: 'Clean it', lendMaxDays: 7, ownerNote: 'Shed B', photo: 'ref1' });
        expect(thingInput(t)).toEqual({ name: 'Drill', category: 'garden', condition: 'fair', replacementValue: '$80', lendTerms: 'Clean it', lendMaxDays: '7', ownerNote: 'Shed B', photo: 'ref1' });
        expect(thingInput(thing('b', 'Hoe', { condition: 'shiny' })).condition).toBe('');
    });

    it('a name is needed, and a longest loan is 1 to 365 whole days or blank', () => {
        expect(thingInputProblems(blank({ name: '  ' }))).toEqual(['name']);
        expect(thingInputProblems(blank({ name: 'Drill' }))).toEqual([]);
        for (const bad of ['0', '366', '2.5', '-3', 'seven', '1e2']) expect(thingInputProblems(blank({ name: 'Drill', lendMaxDays: bad })), bad).toEqual(['lendMaxDays']);
        for (const ok of ['1', '365', ' 14 ', '']) expect(thingInputProblems(blank({ name: 'Drill', lendMaxDays: ok })), ok).toEqual([]);
    });

    it('a new thing goes at the end of the list (shown first), trimmed and held to its bounds, blank fields left out', () => {
        const d = saveThing(doc(thing('a', 'Ladder')), blank({ name: '  Drill  ', lendMaxDays: ' 7 ', replacementValue: '  ', ownerNote: 'n'.repeat(600) }), { id: null, newId: 'new-1', now: NOW });
        expect(d.things.map((t) => (t as Thing).id)).toEqual(['a', 'new-1']);
        expect(d.things[1]).toEqual({ id: 'new-1', name: 'Drill', category: 'tools', lendMaxDays: 7, ownerNote: 'n'.repeat(500), createdAt: iso(NOW), updatedAt: iso(NOW) });
        // What a save writes reads back the same: the screens never write what readThingsDoc would change.
        expect(readThingsDoc(d)).toEqual(d);
        expect(saveThing(doc(), blank({ name: '🔧'.repeat(90) }), { id: null, newId: 'n', now: NOW }).things[0]).toMatchObject({ name: '🔧'.repeat(THINGS_NAME_CHARS) });
    });

    it('an edit changes only the fields; its Offer, who has it and a newer app\'s fields stay; a cleared field goes', () => {
        const kept = thing('a', 'Drill', { postId: 'p1', lentTo: { name: 'Sam', since: iso(NOW - DAY) }, ownerNote: 'old note', lendTerms: 'old', extra: { keep: 1 } });
        const d = saveThing(doc(kept, thing('b', 'Tent')), { ...thingInput(kept), name: 'Hammer drill', ownerNote: '', category: 'garden' }, { id: 'a', newId: 'unused', now: NOW });
        expect(d.things[0]).toEqual({
            id: 'a', name: 'Hammer drill', category: 'garden', lendTerms: 'old', postId: 'p1', lentTo: { name: 'Sam', since: iso(NOW - DAY) }, extra: { keep: 1 },
            createdAt: iso(NOW - DAY), updatedAt: iso(NOW),
        });
        expect(d.things[1]).toEqual(thing('b', 'Tent'));
    });

    it('an id that is gone saves as a new thing, never over a tombstone', () => {
        const d = saveThing(doc(thing('a', 'Old', { gone: true })), blank({ name: 'New' }), { id: 'a', newId: 'n2', now: NOW });
        expect(d.things.map((t) => (t as Thing).id)).toEqual(['a', 'n2']);
        expect((d.things[0] as Thing).gone).toBe(true);
    });

    it('room: at most 100 things the member still has, a deleted one not counted; the refusals say the bound as core has it', () => {
        const many = (n: number) => Array.from({ length: n }, (_, i) => thing(`t${i}`, `Thing ${i}`));
        expect(shedHasRoom(doc(...many(THINGS_MAX_ITEMS - 1)))).toBe(true);
        expect(shedHasRoom(doc(...many(THINGS_MAX_ITEMS)))).toBe(false);
        expect(shedHasRoom(doc(...many(THINGS_MAX_ITEMS - 1), thing('g', 'Gone', { gone: true })))).toBe(true);
        expect(shedFullLine()).toBe('Your Tool shed holds 100 things. Take one out first.');
        expect(shedTooBigLine()).toBe(`Your Tool shed is full: it keeps up to ${TOOL_LIMITS.docBytes / 1024} KB. Take out something you no longer have, or shorten some notes.`);
        expect(shedFits(FIXTURES.docs.full)).toBe(true);
        expect(shedFits(doc(thing('a', 'x'.repeat(70_000))))).toBe(false);
    });
});

describe('the changes a thing\'s screen makes', () => {
    it('lent outside: the name as written, since now, back around when chosen; back home clears it', () => {
        const d = lendOutside(doc(thing('a', 'Ladder', { postId: 'p1' })), 'a', '  Sam  ', backAroundIn(NOW, 7), NOW);
        expect((d.things[0] as Thing).lentTo).toEqual({ name: 'Sam', since: iso(NOW), backAround: iso(NOW + 7 * DAY) });
        expect(thingsCounts(d)).toMatchObject({ out: 1, listed: 0 });
        expect((lendOutside(doc(thing('a', 'L')), 'a', 'Al', null, NOW).things[0] as Thing).lentTo).toEqual({ name: 'Al', since: iso(NOW) });
        const back = markBack(d, 'a', NOW + DAY);
        expect((back.things[0] as Thing).lentTo).toBeUndefined();
        expect((back.things[0] as Thing).postId).toBe('p1');
        expect(thingsCounts(back)).toMatchObject({ out: 0, listed: 1 });
    });

    it('taken out of the shop keeps the paused Offer apart, so the counts say shelf; listed again puts it back', () => {
        const listed = setListed(doc(thing('a', 'Drill')), 'a', 'p1', NOW);
        expect(thingsCounts(listed)).toMatchObject({ listed: 1, shelf: 0 });
        const out = takeOutOfShop(listed, 'a', NOW + DAY);
        expect(out.things[0]).toMatchObject({ pausedPostId: 'p1', updatedAt: iso(NOW + DAY) });
        expect((out.things[0] as Thing).postId).toBeUndefined();
        expect(thingsCounts(out)).toMatchObject({ listed: 0, shelf: 1 });
        expect(readThingsDoc(out)).toEqual(out);
        const again = setListed(out, 'a', 'p1', NOW + 2 * DAY);
        expect(again.things[0]).toMatchObject({ postId: 'p1' });
        expect((again.things[0] as Thing).pausedPostId).toBeUndefined();
        // Taking out a thing with no Offer changes nothing but the time.
        expect(takeOutOfShop(doc(thing('b', 'Tent')), 'b', NOW).things[0]).toEqual({ ...thing('b', 'Tent'), updatedAt: iso(NOW) });
        expect(forgetOffer(out, 'a', NOW).things[0]).not.toHaveProperty('pausedPostId');
        // This build's own version holds pausedPostId to a string, as it holds postId; a newer version keeps it as it was.
        expect(readThingsDoc({ v: 1, things: [thing('c', 'Hoe', { pausedPostId: 5 as never })] }).things[0]).not.toHaveProperty('pausedPostId');
        expect(readThingsDoc({ v: 2, things: [thing('c', 'Hoe', { pausedPostId: 5 as never })] }).things[0]).toHaveProperty('pausedPostId', 5);
    });

    it('deleted: a tombstone with its id and name, its photo, notes, Offer and borrower gone; never shown or counted', () => {
        const d = removeThing(doc(thing('a', 'Drill', { photo: 'r1', ownerNote: 'serial 123', postId: 'p1', lendTerms: 'x', extra: 1 }), thing('b', 'Tent')), 'a', NOW);
        expect(d.things[0]).toEqual({ id: 'a', name: 'Drill', extra: 1, createdAt: iso(NOW - DAY), updatedAt: iso(NOW), gone: true });
        expect(shedThings(d).map((t) => t.id)).toEqual(['b']);
        expect(thingsCounts(d).things).toBe(1);
    });

    it('a change to an id that is not there, or to a newer app\'s unreadable item, changes nothing', () => {
        const d = readThingsDoc({ v: 2, things: [{ odd: true }, thing('a', 'Drill')] });
        expect(markBack(d, 'nope', NOW)).toEqual(d);
        expect(lendOutside(d, 'nope', 'Sam', null, NOW).things).toEqual(d.things);
    });

    it('the back-around chips: 3, 7, 14 and 30 days, said with the plural the language needs', () => {
        expect(BACK_AROUND_DAYS).toEqual([3, 7, 14, 30]);
        expect(backAroundChip(1)).toBe('In 1 day');
        expect(backAroundChip(14)).toBe('In 14 days');
    });

    it('the Offers to link: the owner\'s, live or paused, not gone, and none another thing is linked to', () => {
        const d = doc(thing('a', 'Drill'), thing('b', 'Ladder', { postId: 'p1' }), thing('c', 'Tent', { pausedPostId: 'p2' }), thing('d', 'Gone', { gone: true, postId: 'p3' }));
        const offers = [{ id: 'p1', title: 'Ladder', status: 'active' }, { id: 'p2', title: 'Tent', status: 'paused' }, { id: 'p3', title: 'Gone', status: 'active' }, { id: 'p4', title: 'Drill', status: 'paused' }, { id: 'p5', title: 'Old', status: 'gone' }];
        expect(offersToLink(d, offers, 'a').map((o) => o.id)).toEqual(['p3', 'p4']);
        // Its own link is offered back to itself.
        expect(offersToLink(d, offers, 'b').map((o) => o.id)).toEqual(['p1', 'p3', 'p4']);
    });
});

describe('the List draft', () => {
    it('a lendable Offer in the shop: name, terms, category and photo; what a host may drop is in the words too', () => {
        const draft = thingListDraft(thing('a', 'Cordless drill', { category: 'tools', lendTerms: 'Clean it. Back within a week.', replacementValue: '$120', lendMaxDays: 7, photo: 'r1', ownerNote: 'serial 123' }));
        expect(draft).toEqual({
            title: 'Cordless drill',
            description: "Clean it. Back within a week.\n\nIf it's lost or broken: $120. That is settled between us; BeanPool doesn't hold or collect it.\n\nLent for up to 7 days at a time.",
            category: 'tools', photos: ['r1'], lendable: true, replacementValue: '$120', lendMaxDays: 7, shop: true,
        });
        // The owner's note never leaves the phone.
        expect(JSON.stringify(draft)).not.toContain('serial');
    });

    it('a bare thing: just its name, no description, Tools, no photo; one day is said as one day', () => {
        expect(thingListDraft(thing('a', 'Tent'))).toEqual({ title: 'Tent', description: '', category: 'tools', photos: [], lendable: true, shop: true });
        expect(thingListDraft(thing('a', 'Tent', { lendMaxDays: 1, category: 'plants_garden' }))).toMatchObject({ description: 'Lent for up to 1 day at a time.', category: 'garden' });
    });
});

describe('the loans view', () => {
    it('lent outside and BeanPool loans and asks: overdue first, then soonest back, then by when they went out', () => {
        const d = doc(
            thing('a', 'Ladder', { lentTo: { name: 'Sam', since: iso(NOW - 10 * DAY), backAround: iso(NOW - DAY) } }),
            thing('b', 'Drill', { postId: 'p1' }),
            thing('c', 'Tent', { postId: 'p2' }),
            thing('d', 'Saw', { lentTo: { name: 'Jo', since: iso(NOW - DAY) } }),
            thing('e', 'Pram', { postId: 'p3' }),
            thing('f', 'Gone', { gone: true, lentTo: { name: 'X', since: iso(NOW) } }),
            thing('g', 'Shelf'),
        );
        const loans = thingsLoans(d, [
            deal('p1', 'pending', { backAround: iso(NOW + 2 * DAY), updatedAt: iso(NOW - 3 * DAY) }),
            deal('p2', 'requested', { updatedAt: iso(NOW - 4 * DAY) }),
            deal('p3', 'completed'),
        ], NOW);
        expect(loans.map((l) => [l.thing.id, l.state, l.overdue])).toEqual([
            ['a', 'lent', true], ['b', 'out', false], ['c', 'asked', false], ['d', 'lent', false],
        ]);
        expect(loans[1]).toMatchObject({ since: iso(NOW - 3 * DAY), backAround: iso(NOW + 2 * DAY) });
        expect(loans[2].backAround).toBeNull();
        expect(thingsLoans(d, null, NOW).map((l) => l.thing.id)).toEqual(['a', 'd']);
    });
});
