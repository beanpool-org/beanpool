/**
 * The one exhaustive table of slice S4 (scratch/fable-design/DESIGN-several-addresses-fable.md §3.4; decided by Marty 16
 * Nov): (state of the address in use) × (main) × (others) × (take-over count) → action (keep / follow / switch / drop /
 * refuse), where it goes, and the line Home shows. Every combination is checked against the design's rows, written out
 * below in the design's order, and the design's own rows are checked by name.
 */
import { describe, it, expect } from 'vitest';
import { decideAddress, type AddressAnswer, type AddressSituation } from '../address-decide';

const USING = 'riverside.example';
const MAIN = 'coop.example.org';
const OTHER = 'ourtown.example.net';
const HELD = 2;

const IN_USE = ['proved', 'silent', 'silent-due', 'other-key', 'older', 'off-list'] as const;
const MAIN_STATES = ['is-in-use', 'proved-new', 'proved-seen', 'proved-before', 'silent', 'other-key', 'older'] as const;
const OTHERS = ['none', 'proved', 'silent', 'other-key'] as const;
const COUNTS = ['same', 'higher-all', 'higher-elsewhere'] as const;
type InUse = typeof IN_USE[number];
type MainState = typeof MAIN_STATES[number];
type Others = typeof OTHERS[number];
type Count = typeof COUNTS[number];

/** The situation one row describes. `higher-all`: every proof this round names HELD + 1; `higher-elsewhere`: all but the address in use's. */
function situation(inUse: InUse, main: MainState, others: Others, count: Count): AddressSituation {
    const at = (address: string) => (count === 'same' || (count === 'higher-elsewhere' && address === USING) ? HELD : HELD + 1);
    const proved = (address: string): AddressAnswer => ({ kind: 'proved', epoch: at(address), seq: 9 });
    const answers: Record<string, AddressAnswer> = {};
    const mainAddress = main === 'is-in-use' ? USING : MAIN;
    answers[USING] = inUse === 'silent' || inUse === 'silent-due' ? { kind: 'silent' }
        : inUse === 'other-key' ? { kind: 'other-key', why: 'other-key' }
        : inUse === 'older' ? { kind: 'proved', epoch: HELD - 1, seq: 9 }
        : proved(USING);
    if (main !== 'is-in-use' && main !== 'proved-before') {
        answers[MAIN] = main === 'silent' ? { kind: 'silent' } : main === 'other-key' ? { kind: 'other-key', why: 'other-address' }
            : main === 'older' ? { kind: 'proved', epoch: HELD - 1, seq: 9 } : proved(MAIN);
    }
    if (others !== 'none') {
        answers[OTHER] = others === 'silent' ? { kind: 'silent' } : others === 'other-key' ? { kind: 'other-key', why: 'bad-signature' } : proved(OTHER);
    }
    const listed = [MAIN, OTHER, ...(inUse === 'off-list' ? [] : [USING])].filter((a, i, all) => all.indexOf(a) === i);
    return {
        using: USING,
        main: mainAddress === USING && inUse === 'off-list' ? MAIN : mainAddress,
        listed,
        mainSeen: main === 'proved-seen' ? MAIN : main === 'proved-new' ? 'old-main.example' : MAIN,
        epoch: HELD,
        // A main proved before this round, at the count held then.
        proved: main === 'proved-before' ? { [MAIN]: { epoch: HELD } } : {},
        answers,
        silentDue: inUse === 'silent-due',
    };
}

interface Expect { action: string; to: string | null; line: string | null }

/**
 * The design's rows (§3.4, §3.5, §7), in its words, as a reader would apply them. `good(x)`: x is on the list, proved
 * this round at the highest count shown, or proved before at a count no lower and not silent or refused now.
 */
function expected(inUse: InUse, main: MainState, others: Others, count: Count): Expect {
    // The highest count any address showed this round (the data of the row, not a rule).
    const shown = Object.values(situation(inUse, main, others, count).answers).map((a) => (a.kind === 'proved' ? a.epoch : 0));
    const top = Math.max(HELD, ...shown);
    const inUseAt = count === 'higher-all' ? HELD + 1 : HELD;
    // "Any address shows a higher take-over count: never again uses an address that answers lower."
    const inUseBad = inUse === 'other-key' || inUse === 'older' || ((inUse === 'proved' || inUse === 'off-list') && inUseAt < top);
    const mainIsOther = main !== 'is-in-use' || inUse === 'off-list';
    const mainGood = mainIsOther && (main === 'proved-new' || main === 'proved-seen' || (main === 'proved-before' && HELD >= top));
    const otherGood = others === 'proved';
    const somewhere = mainGood ? MAIN : otherGood ? OTHER : null;
    const dropped = inUseBad || main === 'other-key' || main === 'older' || others === 'other-key';
    const keep = (): Expect => ({ action: dropped ? 'drop' : 'keep', to: null, line: null });
    // "The address in use answers as something else: stops at once; goes to main, else to another proved address; one line;
    // or §3.5's banner when there is none."
    if (inUseBad) return somewhere ? { action: 'switch', to: somewhere, line: 'left' } : { action: 'refuse', to: null, line: null };
    // "The address in use is no longer on the list: goes to main; the same one line."
    if (inUse === 'off-list') return mainGood ? { action: 'follow', to: MAIN, line: 'followed' } : keep();
    // "The address in use gives no answer for 5 minutes of tries, or at app open: [Marty 16 Nov] switches by itself, with a line."
    if (inUse === 'silent') return keep();
    if (inUse === 'silent-due') return somewhere ? { action: 'switch', to: somewhere, line: 'not-answering' } : keep();
    // "The list names a new main, and it proves: uses it from the next request; one line." / "On a second address, and main
    // proves again: goes back to main; nothing." / "A new main that gives no answer yet: stays." / "A new main that answers
    // with another key: stays; marks it refused."
    if (mainGood) return { action: 'follow', to: MAIN, line: main === 'proved-seen' || main === 'proved-before' ? null : 'followed' };
    return keep();
}

describe('S4: the table, (address in use) × (main) × (others) × (take-over count) → action', () => {
    const rows: string[] = [];
    for (const inUse of IN_USE) for (const main of MAIN_STATES) for (const others of OTHERS) for (const count of COUNTS) {
        rows.push(`${inUse} | ${main} | ${others} | ${count}`);
    }

    it(`has every row (${IN_USE.length} × ${MAIN_STATES.length} × ${OTHERS.length} × ${COUNTS.length} = ${rows.length})`, () => {
        expect(rows).toHaveLength(IN_USE.length * MAIN_STATES.length * OTHERS.length * COUNTS.length);
    });

    it('every row does what the design says', () => {
        const wrong: string[] = [];
        for (const inUse of IN_USE) for (const main of MAIN_STATES) for (const others of OTHERS) for (const count of COUNTS) {
            const got = decideAddress(situation(inUse, main, others, count));
            const want = expected(inUse, main, others, count);
            if (got.action !== want.action || got.to !== want.to || got.line !== want.line) {
                wrong.push(`${inUse} | ${main} | ${others} | ${count}: got ${got.action} ${got.to} ${got.line}, want ${want.action} ${want.to} ${want.line}`);
            }
            // Never lower: the count kept is the highest shown.
            if (got.epoch < HELD) wrong.push(`${inUse} | ${main} | ${others} | ${count}: the count went down to ${got.epoch}`);
            // Never to an address that is not proved, never to one dropped this round.
            if (got.to && (got.drop.includes(got.to) || (!got.proved.includes(got.to) && got.to !== MAIN))) {
                wrong.push(`${inUse} | ${main} | ${others} | ${count}: went to ${got.to}, which did not prove`);
            }
        }
        expect(wrong).toEqual([]);
    });

    it('every action of the five occurs in the table', () => {
        const seen = new Set<string>();
        for (const inUse of IN_USE) for (const main of MAIN_STATES) for (const others of OTHERS) for (const count of COUNTS) {
            seen.add(decideAddress(situation(inUse, main, others, count)).action);
        }
        expect([...seen].sort()).toEqual(['drop', 'follow', 'keep', 'refuse', 'switch']);
    });
});

describe('S4: the design\'s rows by name (§3.4)', () => {
    const base = (over: Partial<AddressSituation>): AddressSituation => ({
        using: USING, main: MAIN, listed: [MAIN, OTHER, USING], mainSeen: null, epoch: HELD, proved: {}, answers: {}, silentDue: false, ...over,
    });
    const ok = (epoch = HELD): AddressAnswer => ({ kind: 'proved', epoch, seq: 14 });

    it('the list names a new main, and it proves: follow, one line', () => {
        expect(decideAddress(base({ answers: { [USING]: ok(), [MAIN]: ok() } }))).toMatchObject({ action: 'follow', to: MAIN, line: 'followed' });
    });
    it('a new main that gives no answer yet: stays, nothing shown', () => {
        expect(decideAddress(base({ answers: { [USING]: ok(), [MAIN]: { kind: 'silent' } } }))).toMatchObject({ action: 'keep', to: null, line: null, drop: [] });
    });
    it('a new main that answers with another key: stays, marks it refused, nothing shown', () => {
        expect(decideAddress(base({ answers: { [USING]: ok(), [MAIN]: { kind: 'other-key', why: 'other-key' } } })))
            .toMatchObject({ action: 'drop', to: null, line: null, drop: [MAIN] });
    });
    it('the address in use is no longer on the list: goes to main, the same line', () => {
        expect(decideAddress(base({ listed: [MAIN, OTHER], answers: { [USING]: ok(), [MAIN]: ok() } })))
            .toMatchObject({ action: 'follow', to: MAIN, line: 'followed' });
    });
    it('the address in use answers as something else: stops at once, goes to main, else another proved address, with a line; none: refuse', () => {
        const bad: AddressAnswer = { kind: 'other-key', why: 'other-key' };
        expect(decideAddress(base({ answers: { [USING]: bad, [MAIN]: ok() } }))).toMatchObject({ action: 'switch', to: MAIN, line: 'left', drop: [USING] });
        expect(decideAddress(base({ answers: { [USING]: bad, [MAIN]: { kind: 'silent' }, [OTHER]: ok() } }))).toMatchObject({ action: 'switch', to: OTHER, line: 'left' });
        expect(decideAddress(base({ answers: { [USING]: bad, [MAIN]: { kind: 'silent' }, [OTHER]: { kind: 'silent' } } }))).toMatchObject({ action: 'refuse', to: null });
    });
    it('the address in use gives no answer: keeps until the 2 Nov card\'s time, then switches by itself with a line (Marty 16 Nov)', () => {
        const silent = { [USING]: { kind: 'silent' } as AddressAnswer, [MAIN]: ok() };
        expect(decideAddress(base({ mainSeen: MAIN, answers: silent }))).toMatchObject({ action: 'keep', to: null });
        expect(decideAddress(base({ mainSeen: MAIN, answers: silent, silentDue: true }))).toMatchObject({ action: 'switch', to: MAIN, line: 'not-answering' });
        expect(decideAddress(base({ answers: { [USING]: { kind: 'silent' } }, silentDue: true }))).toMatchObject({ action: 'keep' });
    });
    it('on a second address, and main proves again: goes back to main, nothing shown', () => {
        expect(decideAddress(base({ using: OTHER, mainSeen: MAIN, answers: { [OTHER]: ok(), [MAIN]: ok() } })))
            .toMatchObject({ action: 'follow', to: MAIN, line: null });
    });
    it('any address shows a higher take-over count: raises what it keeps, never again uses one that answers lower', () => {
        const d = decideAddress(base({ using: MAIN, mainSeen: MAIN, answers: { [MAIN]: ok(), [OTHER]: ok(HELD + 1) } }));
        expect(d).toMatchObject({ action: 'switch', to: OTHER, line: 'left', epoch: HELD + 1, drop: [MAIN] });
        // A proof from before the higher count is not enough: proved again at it first.
        expect(decideAddress(base({ using: OTHER, proved: { [MAIN]: { epoch: HELD } }, answers: { [OTHER]: ok(HELD + 1) } })))
            .toMatchObject({ action: 'keep', epoch: HELD + 1 });
    });
});
