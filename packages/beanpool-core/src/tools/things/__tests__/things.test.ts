import { afterEach, describe, expect, it } from 'vitest';
import { pluralKey, setLanguage } from '../../../words.js';
import { toolDocBytes, toolFixtureProblems, toolManifestProblems } from '../../check.js';
import { toolLineText } from '../../line.js';
import {
    THINGS_DOC_BYTES,
    THINGS_DOC_VERSION,
    THINGS_LEND_TERMS_CHARS,
    THINGS_NAME_CHARS,
    THINGS_OWNER_NOTE_CHARS,
    THINGS_REPLACEMENT_VALUE_CHARS,
    emptyThingsDoc,
    isLentTo,
    isLiveThing,
    isThing,
    readThingsDoc,
    type Thing,
    type ThingsDoc,
} from '../doc.js';
import { FIXTURES } from '../fixtures.js';
import {
    LEND_MAX_DAYS_MAX,
    LENDABLE_PRICE_TYPES,
    dealQuantityUnit,
    isLendablePriceType,
    isLoanOverdue,
    isValidLendMaxDays,
    isValidLendTerms,
    isValidOwnerNote,
    isValidReplacementValue,
    lendBackAroundOf,
    loanDays,
    loanDaysRemaining,
    loanTotalBeans,
} from '../loans.js';
import {
    THINGS,
    countsOf,
    loansDue,
    thingsCounts,
    thingsHomeLines,
} from '../manifest.js';

/** A document of this build's version: every item in it is a Thing (only a newer version keeps an UnreadThing). */
function ownThings(doc: ThingsDoc): Thing[] {
    expect(doc.things.every(isThing)).toBe(true);
    return doc.things.filter(isThing);
}

describe('Tool shed (things) manifest and fixtures (generic checks)', () => {
    it('manifest passes all template bounds and rules', () => {
        expect(toolManifestProblems(THINGS)).toEqual([]);
    });

    it('fixtures and pure functions pass all generic fixture checks', () => {
        expect(toolFixtureProblems(THINGS, FIXTURES)).toEqual([]);
    });

    it('the shed is bounded by size alone: 128 KB (131,072 bytes), named in its manifest, past the 64 KB of a tool that names none', () => {
        expect(THINGS_DOC_BYTES).toBe(131_072);
        expect(THINGS.doc.maxBytes).toBe(THINGS_DOC_BYTES);
    });

    it('the full fixture document fills the shed: more than 100 things, under 128 KB, and no room for one more like its biggest', () => {
        const full = FIXTURES.docs.full;
        expect(full.things.length).toBeGreaterThan(100);
        expect(toolDocBytes(full)).toBeLessThanOrEqual(THINGS_DOC_BYTES);
        const biggest = Math.max(...full.things.map((t) => toolDocBytes(t) + 1));
        expect(THINGS_DOC_BYTES - toolDocBytes(full)).toBeLessThan(biggest);
    });
});

describe('readThingsDoc (tolerant parsing, bounds, migration)', () => {
    it('unreadable or non-object values return emptyThingsDoc()', () => {
        const empty = emptyThingsDoc();
        expect(readThingsDoc(undefined)).toEqual(empty);
        expect(readThingsDoc(null)).toEqual(empty);
        expect(readThingsDoc(42)).toEqual(empty);
        expect(readThingsDoc('not json')).toEqual(empty);
        expect(readThingsDoc([])).toEqual(empty);
        expect(readThingsDoc({})).toEqual(empty);
        expect(readThingsDoc({ v: 0 })).toEqual(empty);
        expect(readThingsDoc({ v: -1 })).toEqual(empty);
        expect(readThingsDoc({ v: 1.5 })).toEqual(empty);
        expect(readThingsDoc({ v: '1' })).toEqual(empty);
    });

    it('reads valid v1 document with empty things', () => {
        expect(readThingsDoc({ v: 1, things: [] })).toEqual({ v: 1, things: [] });
    });

    it('skips invalid items in things array', () => {
        const raw = {
            v: 1,
            things: [
                null,
                undefined,
                123,
                'invalid',
                {},
                { id: '1' }, // missing name
                { name: 'Drill' }, // missing id
                { id: 1, name: 'Drill' }, // non-string id
                { id: '2', name: 2 }, // non-string name
                { id: '3', name: 'Ladder' }, // valid
            ],
        };
        const read = readThingsDoc(raw);
        expect(read.things.length).toBe(1);
        expect(ownThings(read)[0].id).toBe('3');
        expect(ownThings(read)[0].name).toBe('Ladder');
    });

    it('clamps string fields to bounds on v1 documents', () => {
        const longItem = {
            id: 'long-1',
            name: 'N'.repeat(120),
            replacementValue: 'R'.repeat(60),
            lendTerms: 'T'.repeat(400),
            ownerNote: 'O'.repeat(700),
            lentTo: {
                name: 'B'.repeat(100),
                since: '2026-10-01T00:00:00.000Z',
                backAround: '2026-10-10T00:00:00.000Z',
            },
        };
        const read = readThingsDoc({ v: 1, things: [longItem] });
        const item = ownThings(read)[0];
        expect(item.name.length).toBe(THINGS_NAME_CHARS);
        expect(item.replacementValue?.length).toBe(THINGS_REPLACEMENT_VALUE_CHARS);
        expect(item.lendTerms?.length).toBe(THINGS_LEND_TERMS_CHARS);
        expect(item.ownerNote?.length).toBe(THINGS_OWNER_NOTE_CHARS);
        expect(item.lentTo?.name.length).toBe(THINGS_NAME_CHARS);
    });

    it('keeps every thing of a v1 document, past 100: the shed is bounded by size, never by a count (Marty, 23 Oct)', () => {
        const things: Thing[] = Array.from({ length: 115 }, (_, i) => ({
            id: `t-${i}`,
            name: `Thing ${i}`,
            createdAt: '2026-10-01T00:00:00.000Z',
            updatedAt: '2026-10-01T00:00:00.000Z',
        }));
        const read = readThingsDoc({ v: 1, things });
        expect(read.things.length).toBe(115);
        expect(ownThings(read)[0].id).toBe('t-0');
        expect(ownThings(read)[114].id).toBe('t-114');
        expect(thingsCounts(read).things).toBe(115);
    });

    it("an earlier build's gone things (#2373's tombstones) are dropped on read: nothing reads one; the live ones keep their places", () => {
        const at = '2026-10-01T00:00:00.000Z';
        const gone = Array.from({ length: 110 }, (_, i) => ({ id: `g-${i}`, name: `Gone ${i}`, gone: true, createdAt: at, updatedAt: at }));
        const live = Array.from({ length: 10 }, (_, i) => ({ id: `l-${i}`, name: `Live ${i}`, createdAt: at, updatedAt: at }));
        const read = readThingsDoc({ v: 1, things: [...gone.slice(0, 55), ...live, ...gone.slice(55)] });
        expect(read.things.length).toBe(10);
        expect(ownThings(read).map((t) => t.id)).toEqual(live.map((t) => t.id));
        expect(thingsCounts(read)).toEqual({ things: 10, listed: 0, out: 0, shelf: 10 });
        expect(readThingsDoc(read)).toEqual(read);
        // A gone that isn't true is no tombstone: the thing is kept, and live.
        expect(ownThings(readThingsDoc({ v: 1, things: [{ ...live[0], gone: false }] })).map((t) => [t.id, isLiveThing(t)])).toEqual([['l-0', true]]);
    });

    it('a 101st live thing is kept, each in its place, and the gone things around them are not', () => {
        const at = '2026-10-01T00:00:00.000Z';
        const thing = (id: string, gone = false) => ({ id, name: id, ...(gone ? { gone: true } : {}), createdAt: at, updatedAt: at });
        const live = Array.from({ length: 105 }, (_, i) => thing(`l-${i}`));
        const raw = [thing('g-a', true), ...live.slice(0, 50), thing('g-m', true), ...live.slice(50), thing('g-b', true)];
        const read = readThingsDoc({ v: 1, things: raw });
        const ids = ownThings(read).map((t) => t.id);
        expect(ids).toEqual(live.map((t) => t.id));
        expect(ids).toContain('l-100');
        expect(thingsCounts(read).things).toBe(105);
        expect(readThingsDoc(read)).toEqual(read);
    });

    it('isLiveThing is a thing this build reads that is not gone', () => {
        expect(isLiveThing({ id: 'a', name: 'x' })).toBe(true);
        expect(isLiveThing({ id: 'a', name: 'x', gone: false })).toBe(true);
        expect(isLiveThing({ id: 'a', name: 'x', gone: true })).toBe(false);
        expect(isLiveThing({ id: 7, name: 'x' })).toBe(false);
        expect(isLiveThing(null)).toBe(false);
    });

    it('preserves unknown fields on v1 document and items', () => {
        const raw = {
            v: 1,
            customDocProp: 'custom-doc',
            things: [
                {
                    id: 't-1',
                    name: 'Saw',
                    customItemProp: 42,
                    createdAt: '2026-10-01T00:00:00.000Z',
                    updatedAt: '2026-10-01T00:00:00.000Z',
                },
            ],
        };
        const read = readThingsDoc(raw) as Record<string, unknown>;
        expect(read.customDocProp).toBe('custom-doc');
        const item = (read.things as Record<string, unknown>[])[0];
        expect(item.customItemProp).toBe(42);
    });

    it('strips invalid known fields on v1 items while preserving genuine unknown extension fields', () => {
        const raw = {
            v: 1,
            things: [
                {
                    id: 't-1',
                    name: 'Hammer',
                    category: 12345, // invalid type
                    condition: 999, // invalid type
                    lendMaxDays: 9999, // out of bounds
                    replacementValue: 50, // invalid type
                    lendTerms: ['no abuse'], // invalid type
                    ownerNote: false, // invalid type
                    photo: 42, // invalid type
                    postId: null, // invalid type
                    gone: 'yes', // invalid boolean
                    lentTo: 'not-an-object', // invalid lentTo
                    createdAt: '2026-10-01T00:00:00.000Z',
                    updatedAt: '2026-10-01T00:00:00.000Z',
                    genuineExtensionProp: 'preserved',
                },
                {
                    id: 't-2',
                    name: 'Drill',
                    lentTo: {
                        name: 'Alice',
                        since: '2026-10-01T00:00:00.000Z',
                        backAround: 12345, // invalid backAround type
                        extraLentProp: 'kept',
                    },
                    createdAt: '2026-10-01T00:00:00.000Z',
                    updatedAt: '2026-10-01T00:00:00.000Z',
                },
            ],
        };
        const read = readThingsDoc(raw);
        const item1 = ownThings(read)[0];
        expect(item1.id).toBe('t-1');
        expect(item1.name).toBe('Hammer');
        expect(item1.category).toBeUndefined();
        expect(item1.condition).toBeUndefined();
        expect(item1.lendMaxDays).toBeUndefined();
        expect(item1.replacementValue).toBeUndefined();
        expect(item1.lendTerms).toBeUndefined();
        expect(item1.ownerNote).toBeUndefined();
        expect(item1.photo).toBeUndefined();
        expect(item1.postId).toBeUndefined();
        expect(item1.gone).toBeUndefined();
        expect(item1.lentTo).toBeUndefined();
        expect(item1.genuineExtensionProp).toBe('preserved');

        const item2 = ownThings(read)[1];
        expect(item2.id).toBe('t-2');
        expect(item2.lentTo).toBeDefined();
        expect(item2.lentTo?.name).toBe('Alice');
        expect(item2.lentTo?.since).toBe('2026-10-01T00:00:00.000Z');
        expect(item2.lentTo?.backAround).toBeUndefined();
        expect(item2.lentTo?.extraLentProp).toBe('kept');
    });

    it('handles newer version (v > 1) by keeping it whole without truncation or field dropping', () => {
        const things: Thing[] = Array.from({ length: 105 }, (_, i) => ({
            id: `t-${i}`,
            name: 'X'.repeat(120),
            createdAt: '2026-10-01T00:00:00.000Z',
            updatedAt: '2026-10-01T00:00:00.000Z',
            futureField: `future-${i}`,
        }));
        const raw = {
            v: 2,
            newerRootField: { kept: true },
            things,
        };
        const read = readThingsDoc(raw) as Record<string, unknown>;
        expect(read.v).toBe(2);
        expect(read.newerRootField).toEqual({ kept: true });
        const readThings = read.things as Thing[];
        expect(readThings.length).toBe(105);
        expect(readThings[0].name.length).toBe(120);
        expect(readThings[0].futureField).toBe('future-0');
    });

    it('a newer version keeps the items this build cannot read, as they were and in their places', () => {
        const raw = {
            v: 2,
            things: [
                { id: 7, name: 'n' }, // numeric id
                { id: 'b', title: 'renamed' }, // name moved to title
                { id: 'c', name: 'ok', extra: 1, createdAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-01T00:00:00.000Z' },
                null,
                'text',
            ],
        };
        const read = readThingsDoc(raw);
        expect(read.things.length).toBe(5);
        expect(read.things[0]).toEqual({ id: 7, name: 'n' });
        expect(read.things[1]).toEqual({ id: 'b', title: 'renamed' });
        expect(read.things[2]).toEqual(raw.things[2]);
        expect(read.things[3]).toBeNull();
        expect(read.things[4]).toBe('text');
        expect(read.things.map(isThing)).toEqual([false, false, true, false, false]);

        // Written back (stored as JSON) and read again: nothing lost, nothing moved.
        const written = JSON.parse(JSON.stringify(read));
        expect(written.things).toEqual(raw.things);
        expect(readThingsDoc(written)).toEqual(read);
    });

    it('the current version still drops what it cannot read', () => {
        const read = readThingsDoc({ v: 1, things: [{ id: 7, name: 'n' }, { id: 'b', title: 'renamed' }, null, { id: 'c', name: 'ok' }] });
        expect(read.things.length).toBe(1);
        expect(ownThings(read)[0].id).toBe('c');
    });

    it('idempotency: reading twice is identical to reading once', () => {
        const raw = {
            v: 1,
            things: [
                {
                    id: 't-1',
                    name: 'Trowel',
                    replacementValue: '30 Beans',
                    createdAt: '2026-10-01T00:00:00.000Z',
                    updatedAt: '2026-10-01T00:00:00.000Z',
                },
            ],
        };
        const once = readThingsDoc(raw);
        const twice = readThingsDoc(once);
        expect(twice).toEqual(once);
    });
});

describe('thingsCounts / countsOf (state partitioning and invariant)', () => {
    it('returns all zeros for empty document', () => {
        expect(thingsCounts(emptyThingsDoc())).toEqual({
            things: 0,
            listed: 0,
            out: 0,
            shelf: 0,
        });
        expect(countsOf(emptyThingsDoc())).toEqual({
            things: 0,
            listed: 0,
            out: 0,
            shelf: 0,
        });
    });

    it('correctly partitions things into listed, out, and shelf, ignoring gone items', () => {
        const doc: ThingsDoc = {
            v: 1,
            things: [
                // on shelf: no postId, no lentTo
                { id: '1', name: 'Drill', createdAt: '', updatedAt: '' },
                { id: '2', name: 'Saw', createdAt: '', updatedAt: '' },
                // listed in shop: postId present, no lentTo
                { id: '3', name: 'Ladder', postId: 'post-ladder', createdAt: '', updatedAt: '' },
                // out on loan: lentTo present
                { id: '4', name: 'Tent', lentTo: { name: 'Bob', since: '2026-10-01' }, createdAt: '', updatedAt: '' },
                // listed AND lent: out takes precedence because it is currently lent out
                { id: '5', name: 'Trailer', postId: 'post-trailer', lentTo: { name: 'Carol', since: '2026-10-02' }, createdAt: '', updatedAt: '' },
                // gone: should be excluded from all counts
                { id: '6', name: 'Broken rake', gone: true, createdAt: '', updatedAt: '' },
                { id: '7', name: 'Lost mower', postId: 'post-mower', gone: true, createdAt: '', updatedAt: '' },
            ],
        };
        const counts = thingsCounts(doc);
        expect(counts.things).toBe(5);
        expect(counts.shelf).toBe(2);
        expect(counts.listed).toBe(1);
        expect(counts.out).toBe(2);
        // Invariant: things === listed + out + shelf
        expect(counts.things).toBe(counts.listed + counts.out + counts.shelf);
    });
});

describe('unread items of a newer version are in no count, line or reminder', () => {
    const NOW = Date.parse('2026-10-20T09:00:00.000Z');
    const newer = readThingsDoc({
        v: 2,
        things: [
            null,
            'text',
            { id: 7, name: 'n', lentTo: { name: 'Ann', since: '2026-10-01', backAround: new Date(NOW + 86_400_000).toISOString() } },
            { id: 'b', title: 'renamed', postId: 'post-b' },
            { id: 'c', name: 'Ladder', lentTo: { name: 'Bob', since: '2026-10-01', backAround: new Date(NOW + 2 * 86_400_000).toISOString() } },
            { id: 'd', name: 'Saw' },
        ],
    });

    it('counts only the things this build reads', () => {
        expect(newer.things.length).toBe(6);
        expect(thingsCounts(newer)).toEqual({ things: 2, listed: 0, out: 1, shelf: 1 });
    });

    it('Home lines and reminders read past them without throwing', () => {
        const lines = thingsHomeLines(newer, NOW);
        expect(lines.length).toBe(1);
        expect([lines[0].n, lines[0].values]).toEqual([2, { out: 1 }]);
        expect(lines[0].screen).toBe('loans');
        const dues = loansDue(newer, NOW);
        expect(dues.map((d) => d.values?.name)).toEqual(['Ladder']);
    });
});

describe('a newer version\'s lentTo this build cannot read is not out', () => {
    const NOW = Date.parse('2026-10-20T09:00:00.000Z');
    const soon = new Date(NOW + 86_400_000).toISOString();

    it('counts it by its postId, as if it were not lent, and keeps it as it was', () => {
        const at = { createdAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-01T00:00:00.000Z' };
        const raw = {
            v: 2,
            things: [
                { id: 'a', name: 'x', lentTo: 'Al', ...at },
                { id: 'b', name: 'y', lentTo: [], ...at },
                { id: 'c', name: 'z', lentTo: { name: 'Bo' }, postId: 'post-c', ...at },
                { id: 'd', name: 'w', lentTo: { name: 'Cy', since: '2026-10-01', backAround: 5 }, ...at },
                { id: 'e', name: 'v', postId: 7, ...at },
            ],
        };
        const read = readThingsDoc(raw);
        expect(JSON.parse(JSON.stringify(read)).things).toEqual(raw.things);
        expect(thingsCounts(read)).toEqual({ things: 5, listed: 1, out: 1, shelf: 3 });
        expect([thingsHomeLines(read, NOW)[0].n, thingsHomeLines(read, NOW)[0].values]).toEqual([5, { out: 1 }]);
        expect(loansDue(read, NOW)).toEqual([]);
    });

    it('the stored newer-version fixture has none out', () => {
        const stored = FIXTURES.stored.find((s) => s.name.startsWith('a newer version'))!;
        expect(thingsCounts(readThingsDoc(stored.raw))).toEqual({ things: 3, listed: 1, out: 0, shelf: 2 });
    });

    it('isLentTo reads an object with a string name and since', () => {
        expect(isLentTo({ name: 'Al', since: '2026-10-01' })).toBe(true);
        expect(isLentTo({ name: 'Al', since: '2026-10-01', backAround: soon })).toBe(true);
        expect(isLentTo({ name: 'Al' })).toBe(false);
        expect(isLentTo('Al')).toBe(false);
        expect(isLentTo([])).toBe(false);
        expect(isLentTo(null)).toBe(false);
    });
});

describe('thingsHomeLines (Home card lines)', () => {
    const NOW = Date.parse('2026-10-20T09:00:00.000Z');

    it('returns empty array when document has no active things', () => {
        expect(thingsHomeLines(emptyThingsDoc(), NOW)).toEqual([]);
        expect(thingsHomeLines({ v: 1, things: [{ id: '1', name: 'Old', gone: true, createdAt: '', updatedAt: '' }] }, NOW)).toEqual([]);
    });

    it('points to loans when items are out', () => {
        const doc: ThingsDoc = {
            v: 1,
            things: [
                { id: '1', name: 'Drill', createdAt: '', updatedAt: '' },
                { id: '2', name: 'Ladder', lentTo: { name: 'Alice', since: '2026-10-01' }, createdAt: '', updatedAt: '' },
            ],
        };
        const lines = thingsHomeLines(doc, NOW);
        expect(lines.length).toBeLessThanOrEqual(2);
        expect(lines[0].screen).toBe('loans');
        expect([lines[0].n, lines[0].values]).toEqual([2, { out: 1 }]);
    });

    it('points to main when things are all in shed', () => {
        const doc: ThingsDoc = {
            v: 1,
            things: [
                { id: '1', name: 'Drill', createdAt: '', updatedAt: '' },
                { id: '2', name: 'Ladder', postId: 'post-1', createdAt: '', updatedAt: '' },
            ],
        };
        const lines = thingsHomeLines(doc, NOW);
        expect(lines.length).toBeLessThanOrEqual(2);
        expect(lines[0].screen).toBe('main');
        expect([lines[0].n, lines[0].values]).toEqual([2, undefined]);
    });

    it('is pure: gives same output twice', () => {
        const doc = FIXTURES.docs.small;
        expect(thingsHomeLines(doc, NOW)).toEqual(thingsHomeLines(doc, NOW));
    });
});

describe('the count sentences read "1 thing" and "5 things", and carry every form a language needs', () => {
    const NOW = Date.parse('2026-10-20T09:00:00.000Z');
    const at = { createdAt: '', updatedAt: '' };
    const shed = (n: number, out: number): ThingsDoc => ({
        v: 1,
        things: Array.from({ length: n }, (_, i) => ({
            id: `t${i}`, name: `Thing ${i}`, ...at, ...(i < out ? { lentTo: { name: 'Al', since: '2026-10-01' } } : {}),
        })),
    });
    const drawn = (doc: ThingsDoc) => [...thingsHomeLines(doc, NOW).map(toolLineText), toolLineText(THINGS.row(doc, NOW)!)];
    afterEach(() => setLanguage('en'));

    it('in English, one thing is singular and more are plural, in the Home lines and the Tools row', () => {
        expect(drawn(shed(1, 1))).toEqual(['1 thing · 1 out', '1 thing · 0 in your shop · 1 out']);
        expect(drawn(shed(1, 0))).toEqual(['1 thing · in your shed', '1 thing · 0 in your shop · 0 out']);
        expect(drawn(shed(5, 1))).toEqual(['5 things · 1 out', '5 things · 0 in your shop · 1 out']);
        expect(drawn(shed(5, 0))).toEqual(['5 things · all in your shed', '5 things · 0 in your shop · 0 out']);
    });

    it('each is a wordn() pair whose count is the live things, so tn() picks the form (Russian: one, few, many)', () => {
        const pair = (l: { key: unknown }) => l.key as { one: string; other: string };
        const keys = [...thingsHomeLines(shed(2, 1), NOW), ...thingsHomeLines(shed(2, 0), NOW), THINGS.row(shed(2, 1), NOW)!].map(pair);
        expect(keys.map((k) => `${k.one}|${k.other}`)).toEqual([
            '{n} thing · {out} out|{n} things · {out} out',
            '{n} thing · in your shed|{n} things · all in your shed',
            '{n} thing · {listed} in your shop · {out} out|{n} things · {listed} in your shop · {out} out',
        ]);
        setLanguage('ru', [{
            [pluralKey(keys[0].one, keys[0].other)]: { one: '{n} вещь · {out} у других', few: '{n} вещи · {out} у других', many: '{n} вещей · {out} у других', other: '{n} вещи · {out} у других' },
        }]);
        expect([1, 3, 5, 21].map((n) => toolLineText(thingsHomeLines(shed(n, 1), NOW)[0]))).toEqual([
            '1 вещь · 1 у других', '3 вещи · 1 у других', '5 вещей · 1 у других', '21 вещь · 1 у других',
        ]);
    });
});

describe('loansDue (reminders due)', () => {
    const NOW = Date.parse('2026-10-20T09:00:00.000Z');

    it('returns reminders for upcoming due dates sorted ascending', () => {
        const doc: ThingsDoc = {
            v: 1,
            things: [
                {
                    id: '1',
                    name: 'Ladder',
                    lentTo: {
                        name: 'Alice',
                        since: '2026-10-01T00:00:00.000Z',
                        backAround: new Date(NOW + 2 * 86_400_000).toISOString(), // in 2 days
                    },
                    createdAt: '',
                    updatedAt: '',
                },
                {
                    id: '2',
                    name: 'Mower',
                    lentTo: {
                        name: 'Bob',
                        since: '2026-10-01T00:00:00.000Z',
                        backAround: new Date(NOW + 1 * 86_400_000).toISOString(), // in 1 day (sooner)
                    },
                    createdAt: '',
                    updatedAt: '',
                },
                {
                    id: '3',
                    name: 'Saw',
                    lentTo: {
                        name: 'Carol',
                        since: '2026-10-01T00:00:00.000Z',
                        backAround: new Date(NOW - 1 * 86_400_000).toISOString(), // in the past (overdue: not upcoming)
                    },
                    createdAt: '',
                    updatedAt: '',
                },
                {
                    id: '4',
                    name: 'Tent',
                    lentTo: { name: 'Dave', since: '2026-10-01T00:00:00.000Z' }, // no backAround
                    createdAt: '',
                    updatedAt: '',
                },
                {
                    id: '5',
                    name: 'Drill',
                    gone: true,
                    lentTo: {
                        name: 'Eve',
                        since: '2026-10-01T00:00:00.000Z',
                        backAround: new Date(NOW + 3 * 86_400_000).toISOString(),
                    },
                    createdAt: '',
                    updatedAt: '',
                },
            ],
        };

        const dues = loansDue(doc, NOW);
        expect(dues.length).toBe(2);
        expect(dues[0].values?.name).toBe('Mower');
        expect(dues[0].reminder).toBe('back');
        expect(dues[0].screen).toBe('loans');
        expect(dues[1].values?.name).toBe('Ladder');
    });

    it('caps return count at 10', () => {
        const things: Thing[] = Array.from({ length: 15 }, (_, i) => ({
            id: `t-${i}`,
            name: `Tool ${i}`,
            lentTo: {
                name: `Borrower ${i}`,
                since: new Date(NOW - 86_400_000).toISOString(),
                backAround: new Date(NOW + (i + 1) * 86_400_000).toISOString(),
            },
            createdAt: '',
            updatedAt: '',
        }));
        const dues = loansDue({ v: 1, things }, NOW);
        expect(dues.length).toBe(10);
    });

    it('is pure: gives same output twice', () => {
        expect(loansDue(FIXTURES.docs.full, NOW)).toEqual(loansDue(FIXTURES.docs.full, NOW));
    });
});

describe('Loans maths and validations (against S3 lendable Offers semantics)', () => {
    const NOW = Date.parse('2026-10-20T09:00:00.000Z');

    it('loanTotalBeans computes correct Beans fee for price types', () => {
        // Free loans
        expect(loanTotalBeans(0, 'fixed', 7)).toBe(0);
        expect(loanTotalBeans(0, 'daily', 3)).toBe(0);
        expect(loanTotalBeans(-5, 'daily', 3)).toBe(0);

        // Fixed price (one fee regardless of loan days)
        expect(loanTotalBeans(50, 'fixed', 7)).toBe(50);
        expect(loanTotalBeans(50, 'fixed', 1)).toBe(50);
        expect(loanTotalBeans(50, 'fixed', 365)).toBe(50);
        expect(loanTotalBeans(50, null, 7)).toBe(50); // default is fixed

        // Daily price: credits * days
        expect(loanTotalBeans(10, 'daily', 3)).toBe(30);
        expect(loanTotalBeans(10, 'daily', 1)).toBe(10);
        expect(loanTotalBeans(10, 'daily', 0)).toBe(0);
        expect(loanTotalBeans(10, 'daily', -1)).toBe(0);
        expect(loanTotalBeans(10, 'daily', 'three')).toBe(0);

        // Weekly price: credits * weeks
        expect(loanTotalBeans(25, 'weekly', 2)).toBe(50);
        expect(loanTotalBeans(25, 'weekly', 1)).toBe(25);
        expect(loanTotalBeans(25, 'weekly', 0)).toBe(0);
    });

    it('loanTotalBeans quotes what the node charges for a price with cents, never rounded to whole Beans', () => {
        // escrow.ts draws post.credits * hours (or post.credits on one fee) with no rounding.
        expect(loanTotalBeans(2.5, 'daily', 3)).toBe(2.5 * 3);
        expect(loanTotalBeans(1.5, 'fixed', 1)).toBe(1.5);
        expect(loanTotalBeans(0.4, 'fixed', 1)).toBe(0.4); // a loan that costs 0.4 Beans is not free
        expect(loanTotalBeans(0.4, 'fixed', 1)).toBeGreaterThan(0);
        expect(loanTotalBeans(0.75, 'weekly', 2)).toBe(0.75 * 2);
        expect(loanTotalBeans(10, 'daily', 1.5)).toBe(10 * 1.5);
    });

    it('isLoanOverdue detects whether backAround date is in the past', () => {
        const future = new Date(NOW + 86_400_000).toISOString();
        const past = new Date(NOW - 86_400_000).toISOString();
        const exact = new Date(NOW).toISOString();

        expect(isLoanOverdue(future, NOW)).toBe(false);
        expect(isLoanOverdue(past, NOW)).toBe(true);
        expect(isLoanOverdue(exact, NOW)).toBe(false);

        // Null/invalid
        expect(isLoanOverdue(null, NOW)).toBe(false);
        expect(isLoanOverdue(undefined, NOW)).toBe(false);
        expect(isLoanOverdue('invalid date', NOW)).toBe(false);
    });

    it('loanDaysRemaining calculates days remaining until backAround', () => {
        const DAY = 24 * 60 * 60 * 1000;
        const threeDaysAhead = new Date(NOW + 3 * DAY).toISOString();
        const twoDaysPast = new Date(NOW - 2 * DAY).toISOString();
        const dueInTwoHours = new Date(NOW + 2 * 3600_000).toISOString();
        const dueIn25Hours = new Date(NOW + 25 * 3600_000).toISOString();
        const overdueByTwoHours = new Date(NOW - 2 * 3600_000).toISOString();
        const overdueBy25Hours = new Date(NOW - 25 * 3600_000).toISOString();

        expect(loanDaysRemaining(threeDaysAhead, NOW)).toBe(3);
        expect(loanDaysRemaining(dueIn25Hours, NOW)).toBe(1);
        expect(loanDaysRemaining(dueInTwoHours, NOW)).toBe(0); // 0 if due today (<24h)
        expect(loanDaysRemaining(overdueByTwoHours, NOW)).toBe(-1); // negative integer if overdue (<0, never -0)
        expect(loanDaysRemaining(overdueBy25Hours, NOW)).toBe(-2);
        expect(loanDaysRemaining(twoDaysPast, NOW)).toBe(-2);
        expect(loanDaysRemaining(null, NOW)).toBeNull();
        expect(loanDaysRemaining('invalid', NOW)).toBeNull();
    });

    it('validates lendMaxDays between 1 and 365', () => {
        expect(isValidLendMaxDays(1)).toBe(true);
        expect(isValidLendMaxDays(14)).toBe(true);
        expect(isValidLendMaxDays(365)).toBe(true);
        expect(isValidLendMaxDays(LEND_MAX_DAYS_MAX)).toBe(true);

        expect(isValidLendMaxDays(0)).toBe(false);
        expect(isValidLendMaxDays(-1)).toBe(false);
        expect(isValidLendMaxDays(366)).toBe(false);
        expect(isValidLendMaxDays(14.5)).toBe(false);
        expect(isValidLendMaxDays('14')).toBe(false);
        expect(isValidLendMaxDays(null)).toBe(false);
        expect(isValidLendMaxDays(undefined)).toBe(false);
    });

    it('validates replacementValue up to 40 characters', () => {
        expect(isValidReplacementValue('100 Beans')).toBe(true);
        expect(isValidReplacementValue('x'.repeat(40))).toBe(true);
        expect(isValidReplacementValue('')).toBe(true);

        expect(isValidReplacementValue('x'.repeat(41))).toBe(false);
        expect(isValidReplacementValue(100)).toBe(false);
        expect(isValidReplacementValue(null)).toBe(false);
    });

    it('validates lendTerms up to 300 characters', () => {
        expect(isValidLendTerms('Return clean.')).toBe(true);
        expect(isValidLendTerms('x'.repeat(300))).toBe(true);

        expect(isValidLendTerms('x'.repeat(301))).toBe(false);
        expect(isValidLendTerms(null)).toBe(false);
    });

    it('validates ownerNote up to 500 characters', () => {
        expect(isValidOwnerNote('Stored in back shed.')).toBe(true);
        expect(isValidOwnerNote('x'.repeat(500))).toBe(true);

        expect(isValidOwnerNote('x'.repeat(501))).toBe(false);
        expect(isValidOwnerNote(null)).toBe(false);
    });

    it('the validators count characters as readThingsDoc does: code points, so an emoji is one', () => {
        const emoji = '😀'; // outside the BMP: .length 2, one code point
        expect(isValidReplacementValue(emoji.repeat(THINGS_REPLACEMENT_VALUE_CHARS))).toBe(true);
        expect(isValidReplacementValue(emoji.repeat(THINGS_REPLACEMENT_VALUE_CHARS + 1))).toBe(false);
        expect(isValidLendTerms(emoji.repeat(THINGS_LEND_TERMS_CHARS))).toBe(true);
        expect(isValidLendTerms(emoji.repeat(THINGS_LEND_TERMS_CHARS + 1))).toBe(false);
        expect(isValidOwnerNote(emoji.repeat(THINGS_OWNER_NOTE_CHARS))).toBe(true);
        expect(isValidOwnerNote(emoji.repeat(THINGS_OWNER_NOTE_CHARS + 1))).toBe(false);

        // What a validator accepts, the document keeps whole, and what it refuses, the document cuts.
        const atBound = {
            id: 'e-1',
            name: 'Emoji',
            replacementValue: emoji.repeat(THINGS_REPLACEMENT_VALUE_CHARS),
            lendTerms: emoji.repeat(THINGS_LEND_TERMS_CHARS),
            ownerNote: emoji.repeat(THINGS_OWNER_NOTE_CHARS),
            createdAt: '2026-10-01T00:00:00.000Z',
            updatedAt: '2026-10-01T00:00:00.000Z',
        };
        const kept = ownThings(readThingsDoc({ v: 1, things: [atBound] }))[0];
        expect(kept.replacementValue).toBe(atBound.replacementValue);
        expect(kept.lendTerms).toBe(atBound.lendTerms);
        expect(kept.ownerNote).toBe(atBound.ownerNote);
        const over = { ...atBound, replacementValue: emoji.repeat(THINGS_REPLACEMENT_VALUE_CHARS + 1) };
        const cut = ownThings(readThingsDoc({ v: 1, things: [over] }))[0];
        expect(isValidReplacementValue(over.replacementValue)).toBe(false);
        expect(cut.replacementValue).toBe(atBound.replacementValue);
        expect(isValidReplacementValue(cut.replacementValue)).toBe(true);
    });

    it('re-exports and integrates with core S3 lending semantics', () => {
        expect(LENDABLE_PRICE_TYPES).toEqual(['fixed', 'daily', 'weekly']);
        expect(isLendablePriceType('fixed')).toBe(true);
        expect(isLendablePriceType('daily')).toBe(true);
        expect(isLendablePriceType('weekly')).toBe(true);
        expect(isLendablePriceType('monthly')).toBe(false);

        expect(loanDays('fixed', 5)).toBe(5);
        expect(loanDays('daily', 3)).toBe(3);
        expect(loanDays('weekly', 2)).toBe(14);
        expect(loanDays('hourly', 4)).toBeNull();

        expect(dealQuantityUnit('daily')).toBe('day');
        expect(dealQuantityUnit('weekly')).toBe('week');
        expect(dealQuantityUnit('fixed', true)).toBe('day');
        expect(dealQuantityUnit('fixed', false)).toBeNull();

        const from = '2026-10-20T00:00:00.000Z';
        expect(lendBackAroundOf(from, 'daily', 3)).toBe('2026-10-23T00:00:00.000Z');
        expect(lendBackAroundOf(from, 'weekly', 1)).toBe('2026-10-27T00:00:00.000Z');
    });
});

describe('Mutation testing on loans maths and size bounds', () => {
    const NOW = Date.parse('2026-10-20T09:00:00.000Z');
    const DAY = 24 * 60 * 60 * 1000;

    describe('loanTotalBeans mutations', () => {
        it('mutant: fixed price multiplying by units instead of flat fee is caught', () => {
            const mutantFixed = (credits: number, units: number) => credits * units;
            const credits = 50;
            const units = 7;
            expect(loanTotalBeans(credits, 'fixed', units)).toBe(credits);
            expect(mutantFixed(credits, units)).not.toBe(loanTotalBeans(credits, 'fixed', units));
        });

        it('mutant: free loans (0 credits) charging units or flat fee is caught', () => {
            const mutantFree = (credits: number, units: number) => (credits === 0 ? units : credits);
            expect(loanTotalBeans(0, 'daily', 5)).toBe(0);
            expect(mutantFree(0, 5)).not.toBe(loanTotalBeans(0, 'daily', 5));
        });

        it('mutant: daily loan using addition instead of multiplication is caught', () => {
            const mutantDaily = (credits: number, units: number) => credits + units;
            expect(loanTotalBeans(10, 'daily', 3)).toBe(30);
            expect(mutantDaily(10, 3)).not.toBe(loanTotalBeans(10, 'daily', 3));
        });

        it('mutant: weekly price multiplying by 7 (days) instead of units is caught', () => {
            const mutantWeekly = (credits: number, units: number) => credits * units * 7;
            expect(loanTotalBeans(20, 'weekly', 2)).toBe(40);
            expect(mutantWeekly(20, 2)).not.toBe(loanTotalBeans(20, 'weekly', 2));
        });

        it('mutant: negative credits producing negative fees is caught', () => {
            expect(loanTotalBeans(-10, 'daily', 3)).toBe(0);
            expect(loanTotalBeans(-5, 'fixed', 1)).toBe(0);
        });
    });

    describe('isLoanOverdue mutations', () => {
        it('mutant: exact moment now considered overdue (< vs <=) is caught', () => {
            const exactNow = new Date(NOW).toISOString();
            expect(isLoanOverdue(exactNow, NOW)).toBe(false);
            const mutantAtOrBefore = (atStr: string, n: number) => Date.parse(atStr) <= n;
            expect(mutantAtOrBefore(exactNow, NOW)).not.toBe(isLoanOverdue(exactNow, NOW));
        });

        it('mutant: inverted condition (future considered overdue) is caught', () => {
            const future = new Date(NOW + 1000).toISOString();
            expect(isLoanOverdue(future, NOW)).toBe(false);
            const mutantInverted = (atStr: string, n: number) => Date.parse(atStr) > n;
            expect(mutantInverted(future, NOW)).not.toBe(isLoanOverdue(future, NOW));
        });

        it('mutant: invalid date strings or NaN failing silently as overdue is caught', () => {
            expect(isLoanOverdue('invalid-date', NOW)).toBe(false);
            expect(isLoanOverdue('', NOW)).toBe(false);
        });
    });

    describe('loanDaysRemaining mutations', () => {
        it('mutant: using Math.ceil incorrectly returns 1 for loans due today and -0 for overdue <24h', () => {
            const dueIn2Hours = new Date(NOW + 2 * 3600_000).toISOString();
            expect(loanDaysRemaining(dueIn2Hours, NOW)).toBe(0); // Math.ceil would give 1
            const overdueBy2Hours = new Date(NOW - 2 * 3600_000).toISOString();
            const days = loanDaysRemaining(overdueBy2Hours, NOW);
            expect(days).toBe(-1); // Math.ceil would give -0
            expect(days! < 0).toBe(true);
            expect(Object.is(days, -0)).toBe(false);
        });

        it('mutant: using Math.round instead of Math.floor is caught', () => {
            const dueIn18Hours = new Date(NOW + 18 * 3600_000).toISOString();
            expect(loanDaysRemaining(dueIn18Hours, NOW)).toBe(0); // due today, but Math.round would give 1
            const mutantRound = (atStr: string, n: number) => Math.round((Date.parse(atStr) - n) / DAY);
            expect(mutantRound(dueIn18Hours, NOW)).not.toBe(loanDaysRemaining(dueIn18Hours, NOW));
        });

        it('mutant: exact day boundaries', () => {
            const exact2DaysAhead = new Date(NOW + 2 * DAY).toISOString();
            expect(loanDaysRemaining(exact2DaysAhead, NOW)).toBe(2);
            const exact2DaysPast = new Date(NOW - 2 * DAY).toISOString();
            expect(loanDaysRemaining(exact2DaysPast, NOW)).toBe(-2);
        });
    });

    describe('size bound mutations', () => {
        it('mutant: a count put back on the things of a v1 document (100, or any other) is caught', () => {
            const many = (n: number): Thing[] => Array.from({ length: n }, (_, i) => ({
                id: `t-${i}`,
                name: `Item ${i}`,
                createdAt: '',
                updatedAt: '',
            }));
            for (const n of [100, 101, 500]) {
                const read = readThingsDoc({ v: 1, things: many(n) });
                expect(read.things.length).toBe(n);
                expect(ownThings(read).some((t) => t.id === `t-${n - 1}`)).toBe(true);
            }
        });

        it('mutant: off-by-one on character limits (80, 40, 300, 500) is caught', () => {
            const itemAtLimits: Thing = {
                id: '1',
                name: 'a'.repeat(80),
                replacementValue: 'b'.repeat(40),
                lendTerms: 'c'.repeat(300),
                ownerNote: 'd'.repeat(500),
                createdAt: '',
                updatedAt: '',
            };
            const readAtLimits = ownThings(readThingsDoc({ v: 1, things: [itemAtLimits] }))[0];
            expect(readAtLimits.name.length).toBe(80);
            expect(readAtLimits.replacementValue?.length).toBe(40);
            expect(readAtLimits.lendTerms?.length).toBe(300);
            expect(readAtLimits.ownerNote?.length).toBe(500);

            const itemOverLimits: Thing = {
                id: '2',
                name: 'a'.repeat(81),
                replacementValue: 'b'.repeat(41),
                lendTerms: 'c'.repeat(301),
                ownerNote: 'd'.repeat(501),
                createdAt: '',
                updatedAt: '',
            };
            const readOverLimits = ownThings(readThingsDoc({ v: 1, things: [itemOverLimits] }))[0];
            expect(readOverLimits.name.length).toBe(80);
            expect(readOverLimits.replacementValue?.length).toBe(40);
            expect(readOverLimits.lendTerms?.length).toBe(300);
            expect(readOverLimits.ownerNote?.length).toBe(500);
        });

        it('mutant: document size exceeding 131,072 bytes is detected and refused by toolFixtureProblems', () => {
            const oversizedDoc: ThingsDoc = {
                v: 1,
                things: [
                    {
                        id: 'giant',
                        name: 'Big item',
                        bigPayload: 'x'.repeat(140_000),
                        createdAt: '',
                        updatedAt: '',
                    },
                ],
            };
            const bytes = toolDocBytes(oversizedDoc);
            expect(bytes).toBeGreaterThan(131_072);

            const mutantFixtures = {
                ...FIXTURES,
                docs: {
                    ...FIXTURES.docs,
                    full: oversizedDoc,
                },
            };
            const problems = toolFixtureProblems(THINGS, mutantFixtures);
            expect(problems.some((p) => p.includes('over its 131072'))).toBe(true);
        });
    });
});
