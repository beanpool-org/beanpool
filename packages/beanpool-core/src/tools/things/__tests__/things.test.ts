import { describe, expect, it } from 'vitest';
import { toolDocBytes, toolFixtureProblems, toolManifestProblems } from '../../check.js';
import {
    THINGS_DOC_VERSION,
    THINGS_LEND_TERMS_CHARS,
    THINGS_MAX_ITEMS,
    THINGS_NAME_CHARS,
    THINGS_OWNER_NOTE_CHARS,
    THINGS_REPLACEMENT_VALUE_CHARS,
    emptyThingsDoc,
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

describe('Tool shed (things) manifest and fixtures (generic checks)', () => {
    it('manifest passes all template bounds and rules', () => {
        expect(toolManifestProblems(THINGS)).toEqual([]);
    });

    it('fixtures and pure functions pass all generic fixture checks', () => {
        expect(toolFixtureProblems(THINGS, FIXTURES)).toEqual([]);
    });

    it('the 100-thing full fixture document is strictly under 64 KB (65,536 bytes)', () => {
        expect(FIXTURES.docs.full.things.length).toBe(THINGS_MAX_ITEMS);
        const bytes = toolDocBytes(FIXTURES.docs.full);
        expect(bytes).toBeLessThanOrEqual(65_536);
        expect(bytes).toBeGreaterThan(10_000);
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
        expect(read.things[0].id).toBe('3');
        expect(read.things[0].name).toBe('Ladder');
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
        const item = read.things[0];
        expect(item.name.length).toBe(THINGS_NAME_CHARS);
        expect(item.replacementValue?.length).toBe(THINGS_REPLACEMENT_VALUE_CHARS);
        expect(item.lendTerms?.length).toBe(THINGS_LEND_TERMS_CHARS);
        expect(item.ownerNote?.length).toBe(THINGS_OWNER_NOTE_CHARS);
        expect(item.lentTo?.name.length).toBe(THINGS_NAME_CHARS);
    });

    it('truncates things array to 100 items on v1 documents', () => {
        const things: Thing[] = Array.from({ length: 115 }, (_, i) => ({
            id: `t-${i}`,
            name: `Thing ${i}`,
            createdAt: '2026-10-01T00:00:00.000Z',
            updatedAt: '2026-10-01T00:00:00.000Z',
        }));
        const read = readThingsDoc({ v: 1, things });
        expect(read.things.length).toBe(THINGS_MAX_ITEMS);
        expect(read.things[0].id).toBe('t-0');
        expect(read.things[99].id).toBe('t-99');
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
        expect(lines[0].values).toEqual({ things: 2, out: 1 });
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
        expect(lines[0].values).toEqual({ things: 2 });
    });

    it('is pure: gives same output twice', () => {
        const doc = FIXTURES.docs.small;
        expect(thingsHomeLines(doc, NOW)).toEqual(thingsHomeLines(doc, NOW));
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

        expect(loanDaysRemaining(threeDaysAhead, NOW)).toBe(3);
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
