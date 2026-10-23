/**
 * The Tool shed's screens' rules (shed.ts, slices T1.2 and T1.3): a thing's state and its line, the filters, each change
 * the screens make to the document, the List draft, and the loans view. The phone's and the web's screens draw these;
 * their own tests check the drawing.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { pseudoLocalise, setLanguage } from '../../../words.js';
import { toolDocBytes } from '../../check.js';
import { TOOL_LIMITS } from '../../manifest.js';
import { TOOL_SHOP_CLOSED, isShopClosedRefusal, type ToolDealSummary } from '../../host.js';
import { THINGS_DOC_BYTES, THINGS_NAME_CHARS, readThingsDoc, type Thing, type ThingsDoc } from '../doc.js';
import { FIXTURES } from '../fixtures.js';
import { thingsCounts } from '../manifest.js';
import {
    BACK_AROUND_DAYS, THING_FILTERS, backAroundChip, backAroundIn, findThing, forgetOffer, lendOutside, linkOffer, markBack, offersToLink,
    openDealsByPost, removeThing, saveThing, setListed, shedFits, shedFullLine, shedRoom, shedRoomLine, shedThings, shopClosedLine,
    takeOutOfShop, thingCategories, thingCategory, thingConditionName, thingInFilter, thingInput, thingInputProblems,
    thingListDraft, thingRowLine, thingState, thingStateLine, thingsLoans, type ThingInput,
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

    it('a row\'s line is short, what matters first, so a 320 dp row that cuts it still shows the date', () => {
        const open = openDealsByPost([deal('p1', 'pending', { backAround: iso(NOW + 3 * DAY) }), deal('p2', 'pending', { backAround: iso(NOW - DAY) }), deal('p3', 'pending'), deal('p4', 'requested')]);
        const row = (t: Thing) => thingRowLine(t, open, NOW);
        expect(row(thing('a', 'Drill'))).toBe('On your shelf');
        expect(row(thing('a', 'Drill', { pausedPostId: 'p8' }))).toBe('Taken out of your shop');
        expect(row(thing('a', 'Drill', { postId: 'p9' }))).toBe('In your shop');
        expect(row(thing('a', 'Drill', { postId: 'p4' }))).toBe('Asked to borrow');
        expect(row(thing('a', 'Drill', { postId: 'p1' }))).toBe('Out · due 23 Oct');
        expect(row(thing('a', 'Drill', { postId: 'p2' }))).toBe('Out · overdue');
        expect(row(thing('a', 'Drill', { postId: 'p3' }))).toBe('Out on a loan');
        expect(row(thing('a', 'Drill', { lentTo: { name: 'Sam', since: iso(NOW - 2 * DAY), backAround: iso(NOW + DAY) } }))).toBe('Due 21 Oct · with Sam');
        expect(row(thing('a', 'Drill', { lentTo: { name: 'Sam', since: iso(NOW - 9 * DAY), backAround: iso(NOW - DAY) } }))).toBe('Overdue · with Sam');
        expect(row(thing('a', 'Drill', { lentTo: { name: 'Sam', since: iso(NOW - 2 * DAY) } }))).toBe('With Sam');
        // Each is shorter than the screen's sentence it stands for.
        for (const t of [thing('a', 'Drill', { postId: 'p4' }), thing('a', 'Drill', { postId: 'p1' }), thing('a', 'Drill', { lentTo: { name: 'Sam', since: iso(NOW), backAround: iso(NOW + DAY) } })]) {
            expect(row(t).length).toBeLessThan(thingStateLine(t, open, NOW).length);
        }
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

    it('room is counted by size alone: a 101st small thing fits; a shed past the bound it is held to does not', () => {
        const many = (n: number) => Array.from({ length: n }, (_, i) => thing(`t${i}`, `Thing ${i}`));
        const next = saveThing(doc(...many(100)), blank({ name: 'Drill' }), { id: null, newId: 'n101', now: NOW });
        expect(shedThings(next)).toHaveLength(101);
        expect(shedFits(next, THINGS_DOC_BYTES)).toBe(true);
        expect(shedFits(FIXTURES.docs.full, THINGS_DOC_BYTES)).toBe(true);
        expect(shedFits(doc(thing('a', 'x'.repeat(140_000))), THINGS_DOC_BYTES)).toBe(false);
        // The bound is the host's (host.doc.maxBytes()): an older node's 64 KB holds less than the shed's own 128 KB.
        expect(shedFits(doc(thing('a', 'x'.repeat(70_000))), THINGS_DOC_BYTES)).toBe(true);
        expect(shedFits(doc(thing('a', 'x'.repeat(70_000))), TOOL_LIMITS.docBytes)).toBe(false);
    });

    it("room: about how many more things fit, in things the size of the member's own on average, or a typical one while there are none", () => {
        const typical = shedRoom(doc(), THINGS_DOC_BYTES);
        // A typical thing is a few hundred bytes: some hundreds fit in 128 KB, and half as many in an older node's 64 KB.
        expect(typical).toBeGreaterThan(300);
        expect(typical).toBeLessThan(700);
        expect(shedRoom(doc(), TOOL_LIMITS.docBytes)).toBeLessThanOrEqual(Math.ceil(typical / 2));
        // Exactly: the bytes left over the average bytes one of the member's things takes (its JSON and its comma), floored.
        const own = [thing('a', 'Drill'), thing('b', 'Ladder', { lendTerms: 'x'.repeat(300) })];
        const each = Math.ceil(own.reduce((s, t) => s + toolDocBytes(t) + 1, 0) / own.length);
        const d = doc(...own);
        expect(shedRoom(d, THINGS_DOC_BYTES)).toBe(Math.floor((THINGS_DOC_BYTES - toolDocBytes(d)) / each));
        // A deleted thing takes its few bytes of the room, and is not what the member's things are like.
        const withGone = doc(...own, thing('g', 'Gone', { gone: true }));
        expect(shedRoom(withGone, THINGS_DOC_BYTES)).toBe(Math.floor((THINGS_DOC_BYTES - toolDocBytes(withGone)) / each));
        // Full, or past the bound (an older node keeps less than the phone already has): none, never below.
        expect(shedRoom(FIXTURES.docs.full, THINGS_DOC_BYTES)).toBeLessThanOrEqual(1);
        expect(shedRoom(FIXTURES.docs.full, TOOL_LIMITS.docBytes)).toBe(0);
    });

    it('the room and full lines say things and words, never bytes', () => {
        expect(shedRoomLine(1)).toBe('Room for about 1 more thing');
        expect(shedRoomLine(240)).toBe('Room for about 240 more things');
        expect(shedFullLine()).toBe('Your Tool shed is full. Delete something you no longer have, or shorten some notes.');
        for (const line of [shedRoomLine(240), shedFullLine()]) expect(line).not.toMatch(/KB|byte/);
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

    it('linked to a live Offer (or one in a deal) it is in the shop; to a paused one, taken out, so Put back resumes it', () => {
        const d = doc(thing('a', 'Drill', { pausedPostId: 'old' }));
        expect(linkOffer(d, 'a', { id: 'p1', status: 'active' }, NOW).things[0]).toMatchObject({ postId: 'p1' });
        expect(linkOffer(d, 'a', { id: 'p1', status: 'active' }, NOW).things[0]).not.toHaveProperty('pausedPostId');
        expect(linkOffer(d, 'a', { id: 'p2', status: 'pending' }, NOW).things[0]).toMatchObject({ postId: 'p2' });
        const paused = linkOffer(doc(thing('a', 'Drill', { postId: 'x' })), 'a', { id: 'p3', status: 'paused' }, NOW);
        expect(paused.things[0]).toMatchObject({ pausedPostId: 'p3' });
        expect(paused.things[0]).not.toHaveProperty('postId');
        expect(thingState(paused.things[0] as Thing)).toBe('taken-out');
    });
});

describe("a shop closed for now (the node's 409 shop_paused)", () => {
    it('is told from no answer by its code, and said in a sentence through t() that promises nothing of the reopen', () => {
        const refused = Object.assign(new Error('This is in a shop that is closed for now. Reopen the shop to put it back up.'), { status: 409, code: 'shop_paused' });
        expect(TOOL_SHOP_CLOSED).toBe('shop_paused');
        expect(isShopClosedRefusal(refused)).toBe(true);
        for (const other of [new TypeError('Network request failed'), Object.assign(new Error('x'), { status: 400 }), { code: 'shop_deals_open' }, null, undefined, 'shop_paused']) {
            expect(isShopClosedRefusal(other)).toBe(false);
        }
        expect(shopClosedLine()).toBe("Your shop is closed for now, so this can't go back in it yet. Reopen your shop first.");
        setLanguage('xx');
        expect(shopClosedLine()).toBe(pseudoLocalise("Your shop is closed for now, so this can't go back in it yet. Reopen your shop first."));
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

    it("a taken-out thing whose Offer is up again (its shop's reopen, the Market's own resume) and in a deal is out or asked for, never \"taken out\" or \"nothing out\"", () => {
        const deals = [
            deal('p1', 'pending', { backAround: iso(NOW + 3 * DAY), updatedAt: iso(NOW - DAY) }),
            deal('p2', 'requested', { updatedAt: iso(NOW - 2 * DAY) }),
            deal('p3', 'completed'),
        ];
        const open = openDealsByPost(deals);
        const drill = thing('a', 'Drill', { pausedPostId: 'p1' });
        const ladder = thing('b', 'Ladder', { pausedPostId: 'p2' });
        const tent = thing('c', 'Tent', { pausedPostId: 'p3' });
        expect([drill, ladder, tent].map((t) => thingState(t, open))).toEqual(['out', 'asked', 'taken-out']);
        expect(thingStateLine(drill, open, NOW)).toBe('Out on a loan · back around 23 Oct');
        expect(thingRowLine(drill, open, NOW)).toBe('Out · due 23 Oct');
        expect(thingRowLine(ladder, open, NOW)).toBe('Asked to borrow');
        expect(thingRowLine(tent, open, NOW)).toBe('Taken out of your shop');
        expect(thingsLoans(doc(drill, ladder, tent), deals, NOW).map((l) => [l.thing.id, l.state, l.backAround, l.since])).toEqual([
            ['a', 'out', iso(NOW + 3 * DAY), iso(NOW - DAY)], ['b', 'asked', null, iso(NOW - 2 * DAY)],
        ]);
    });
});
