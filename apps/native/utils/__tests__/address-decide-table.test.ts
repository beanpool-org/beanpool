/**
 * The one exhaustive table of slice S4 (scratch/fable-design/DESIGN-several-addresses-fable.md §3.4; decided by Marty 16
 * Nov): (state of the address in use) × (main) × (others) × (take-over count) → action (keep / follow / switch / drop /
 * refuse), where it goes, and the line Home shows. Every combination is checked against the design's rows, written out
 * below in the design's order, and the design's own rows are checked by name.
 *
 * And the round's table (PR #3236 round 2, the invariant): (proof age: fresh / stale past the wait / never) × (answer:
 * proves, proves another community, 421, 429, 503, timeout, unparsed, offline) × (address role: in use, main, other) ×
 * (the member switched mid-round: yes / no) → stay / follow / switch, and whether the address is refused for a day. Each
 * row runs a whole round (utils/address-verify.ts) against stand-in servers signing with real keys, as
 * address-verify.test.ts does: the phone moves only on a fresh proof or the member's own act; a transient answer never
 * counts as answering as something else and never starts a day's refusal; the member's switch always wins.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mem = vi.hoisted(() => new Map<string, string>());
vi.mock('@react-native-async-storage/async-storage', () => ({
    default: {
        getItem: vi.fn(async (k: string) => mem.get(k) ?? null),
        setItem: vi.fn(async (k: string, v: string) => { mem.set(k, v); }),
        removeItem: vi.fn(async (k: string) => { mem.delete(k); }),
    },
}));

import { ed25519 } from '@noble/curves/ed25519.js';
import { hexToBytes } from '@noble/hashes/utils.js';
import { createRequire } from 'node:module';
import {
    ADDRESS_LIST_PATH, ADDRESS_PROOF_PATH, signAddressList, signAddressProof, type AddressListFields,
} from '@beanpool/core';
import { decideAddress, PROOF_FRESH_MS, type AddressAnswer, type AddressSituation } from '../address-decide';
import { forgetAddressChecks, verifyAddressInUse, type VerifyDeps } from '../address-verify';
import { resetCommunityIndexForTests, type CommunityRecord } from '../community-index';
import { loadCommunityRecords, parseCommunityRecords, resetCommunityRecordsForTests } from '../community-record';
import { COMMUNITY_RECORDS_STORE_KEY, SAVED_NODES_STORE_KEY } from '../storage-keys';

const USING = 'riverside.example';
const MAIN = 'coop.example.org';
const OTHER = 'ourtown.example.net';
const HELD = 2;
const NOW = Date.UTC(2026, 10, 16, 3);

const IN_USE = ['proved', 'silent', 'silent-due', 'other-key', 'older', 'off-list'] as const;
const MAIN_STATES = ['is-in-use', 'proved-new', 'proved-seen', 'proved-before', 'proved-stale', 'silent', 'other-key', 'older'] as const;
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
    if (main !== 'is-in-use' && main !== 'proved-before' && main !== 'proved-stale') {
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
        // A main proved before this round, at the count held then: inside the wait (fresh), or past it (stale).
        proved: main === 'proved-before' ? { [MAIN]: { epoch: HELD, at: NOW - 2 * 60_000 } }
            : main === 'proved-stale' ? { [MAIN]: { epoch: HELD, at: NOW - PROOF_FRESH_MS } } : {},
        answers,
        silentDue: inUse === 'silent-due',
        now: NOW,
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
    // A proof from before this round counts only inside the wait (fresh), never past it (the phone moves only on a fresh proof).
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
        using: USING, main: MAIN, listed: [MAIN, OTHER, USING], mainSeen: null, epoch: HELD, proved: {}, answers: {}, silentDue: false, now: NOW, ...over,
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
        expect(decideAddress(base({ using: OTHER, proved: { [MAIN]: { epoch: HELD, at: NOW - 60_000 } }, answers: { [OTHER]: ok(HELD + 1) } })))
            .toMatchObject({ action: 'keep', epoch: HELD + 1 });
    });
    it('a proof from before this round: inside the wait it is enough, past it or from a clock now behind it never is', () => {
        const at = (ago: number) => ({ [MAIN]: { epoch: HELD, at: NOW - ago } });
        expect(decideAddress(base({ mainSeen: MAIN, proved: at(PROOF_FRESH_MS - 1), answers: { [USING]: ok() } }))).toMatchObject({ action: 'follow', to: MAIN });
        expect(decideAddress(base({ mainSeen: MAIN, proved: at(PROOF_FRESH_MS), answers: { [USING]: ok() } }))).toMatchObject({ action: 'keep', to: null });
        expect(decideAddress(base({ mainSeen: MAIN, proved: at(-60_000), answers: { [USING]: ok() } }))).toMatchObject({ action: 'keep', to: null });
        // Its last ask got no answer (address-verify carries that in as silent): the fresh proof does not count either.
        expect(decideAddress(base({ mainSeen: MAIN, proved: at(60_000), answers: { [USING]: ok(), [MAIN]: { kind: 'silent' } } })))
            .toMatchObject({ action: 'keep', to: null });
        // And no switch rests on one: the address in use silent past the card's time, the main proved long ago, stays.
        expect(decideAddress(base({ proved: at(2 * 60 * 60_000), answers: { [USING]: { kind: 'silent' } }, silentDue: true })))
            .toMatchObject({ action: 'keep', to: null });
    });
});

// ─── The round's table ───────────────────────────────────────────────────────────────────────────────────────────────

const V = createRequire(import.meta.url)('@beanpool/core/vectors/address-list.json');
const KEY = { seed: hexToBytes(V.keys.community.seedHex), peerId: V.keys.community.peerId as string };
const OTHER_KEY = { seed: hexToBytes(V.keys.other.seedHex), peerId: V.keys.other.peerId as string };
const CID = V.communityIds.community as string;
const ANCHOR = 'beanpool_anchor_url';
const ELSEWHERE = 'https://elsewhere.example';
const T = Date.UTC(2026, 10, 16, 4);

const AGES = ['fresh', 'stale', 'never'] as const;
const ANSWERS = ['proves', 'proves-other-community', '421', '429', '503', 'timeout', 'unparsed', 'offline'] as const;
const ROLES = ['in-use', 'main', 'other'] as const;
type Age = typeof AGES[number];
type Answer = typeof ANSWERS[number];
type Role = typeof ROLES[number];

/** The list before the round (main: the address in use) and the one the servers that prove sign in it (main: MAIN). */
const before = (): AddressListFields => ({ peerId: KEY.peerId, communityId: CID, epoch: 2, seq: 14, main: USING, addresses: [USING, MAIN, OTHER], spares: [] });
const during = (): AddressListFields => ({ ...before(), seq: 15, main: MAIN });

/** Each address's answer to a proof (and its list), as the row sets it. */
type Behaviour = Answer | 'silent';
let behave: Record<string, Behaviour>;
let fieldsNow: AddressListFields;
let onAsk: (() => void) | null;

const get: VerifyDeps['get'] = async (url) => {
    const u = new URL(url);
    onAsk?.();
    const b = behave[u.host] ?? 'timeout';
    if (b === 'offline') throw new TypeError('Network request failed');
    if (b === 'timeout' || b === 'silent') return null;
    if (b === '429') return { status: 429, body: { error: 'Too many requests from this address; try again shortly.' } };
    if (b === '503') return { status: 503, body: null, unparsed: true };
    if (b === 'unparsed') return { status: 200, body: null, unparsed: true };
    if (b === '421') return { status: 421, body: { error: 'not listed', code: 'not_listed' } };
    if (u.pathname === ADDRESS_LIST_PATH) return { status: 200, body: await signAddressList(fieldsNow, (m) => ed25519.sign(m, KEY.seed)) };
    if (u.pathname !== ADDRESS_PROOF_PATH) return { status: 404, body: null };
    const key = b === 'proves-other-community' ? OTHER_KEY : KEY;
    const list = b === 'proves-other-community'
        ? { v: 1 as const, ...fieldsNow, peerId: OTHER_KEY.peerId, communityId: V.communityIds.other as string }
        : { v: 1 as const, ...fieldsNow };
    const proof = await signAddressProof({ list, for: u.searchParams.get('for')!, nonce: u.searchParams.get('nonce')!, ts: 1 }, (m) => ed25519.sign(m, key.seed));
    return { status: 200, body: proof };
};

let n = 0;
let clock = T;
const moves: Array<[string, string]> = [];
const deps = (): VerifyDeps => ({
    get,
    nonce: () => (++n).toString(16).padStart(32, '0'),
    now: () => clock,
    anchor: async () => mem.get(ANCHOR) ?? null,
    inHall: async () => false,
    moveTo: async (from, to) => { moves.push([from, to]); mem.set(ANCHOR, to); },
    followRow: async () => {},
    forgetDuplicate: async () => {},
});
const records = (): CommunityRecord[] => parseCommunityRecords(mem.get(COMMUNITY_RECORDS_STORE_KEY) ?? null);
const origin = (a: string) => `https://${a}`;

/** The tested address for each role. */
const TESTED: Record<Role, string> = { 'in-use': USING, main: MAIN, other: OTHER };
const TRANSIENT: readonly Answer[] = ['429', '503', 'timeout', 'unparsed', 'offline'];
const SAYS_SO: readonly Answer[] = ['proves-other-community', '421'];

interface Outcome { move: 'stay' | 'follow' | 'switch'; refused: boolean }

/** One row, run: the phone on USING (main before the round), the community's key and list kept. */
async function runRow(age: Age, answer: Answer, role: Role, switched: boolean): Promise<Outcome & { anchor: string | null; line: unknown }> {
    mem.clear();
    forgetAddressChecks();
    moves.length = 0;
    onAsk = null;
    const kept = await signAddressList(before(), (m) => ed25519.sign(m, KEY.seed));
    mem.set(ANCHOR, origin(USING));
    mem.set(SAVED_NODES_STORE_KEY, JSON.stringify([{ url: origin(USING), alias: 'Riverside' }]));
    const base: CommunityRecord = { v: 1, id: origin(USING), using: origin(USING), peerId: KEY.peerId, communityId: CID, epoch: 2, list: kept, proved: {}, refused: {} };
    mem.set(COMMUNITY_RECORDS_STORE_KEY, JSON.stringify({ v: 1, records: [base] }));
    resetCommunityRecordsForTests();
    resetCommunityIndexForTests();
    await loadCommunityRecords();

    // The proof age: every address proved at a round 2 minutes before (inside the wait), or 2 hours before (past every
    // wait), in this run; or never.
    if (age !== 'never') {
        clock = T - (age === 'fresh' ? 2 * 60_000 : 2 * 60 * 60_000);
        fieldsNow = before();
        behave = { [USING]: 'proves', [MAIN]: 'proves', [OTHER]: 'proves' };
        await verifyAddressInUse({ atOpen: true }, deps());
        expect(moves).toEqual([]);
    }

    // The round: at an app open (the address in use asked whatever the last ask was), the list now naming MAIN.
    clock = T;
    fieldsNow = during();
    behave = role === 'in-use' ? { [USING]: answer, [MAIN]: 'proves', [OTHER]: 'silent' }
        : role === 'main' ? { [USING]: 'proves', [MAIN]: answer, [OTHER]: 'silent' }
        : { [USING]: 'silent', [MAIN]: 'silent', [OTHER]: answer };
    if (switched) onAsk = () => { onAsk = null; mem.set(ANCHOR, ELSEWHERE); };
    await verifyAddressInUse({ atOpen: true }, deps());

    const r = records().find((x) => x.id === origin(USING))!;
    const refusedAt = r.refused[origin(TESTED[role])]?.at;
    const anchor = mem.get(ANCHOR) ?? null;
    const moved = moves.length > 0;
    const kind = r.line?.kind;
    return {
        move: !moved ? 'stay' : kind === 'left' || kind === 'not-answering' ? 'switch' : 'follow',
        refused: refusedAt === T,
        anchor,
        line: r.line ?? null,
    };
}

/** What the invariant says for a row, in its words. */
function want(age: Age, answer: Answer, role: Role, switched: boolean): Outcome {
    const saysSo = SAYS_SO.includes(answer);
    let o: Outcome;
    if (role === 'in-use') {
        // Proves: the list it names makes MAIN main, freshly proved this round (or inside the wait): follow. Says it is
        // something else: switch to MAIN, refused for a day. Transient at app open: the 2 Nov card's switch, no refusal.
        o = answer === 'proves' ? { move: 'follow', refused: false } : { move: 'switch', refused: saysSo };
    } else if (role === 'main') {
        // Inside the wait MAIN is not asked again: its 2-minute-old proof is fresh, so the phone follows on it. Otherwise only
        // a fresh proof this round moves it; what says so is refused; a transient answer changes nothing.
        o = age === 'fresh' || answer === 'proves' ? { move: 'follow', refused: false } : { move: 'stay', refused: saysSo };
    } else {
        // The address in use and MAIN give no answer at app open: everything is asked; OTHER proving is the one place to go.
        o = answer === 'proves' ? { move: 'switch', refused: false } : { move: 'stay', refused: saysSo };
    }
    // The member's own switch wins: nothing moves; what was learned about the addresses is kept.
    return switched ? { move: 'stay', refused: o.refused } : o;
}

describe('S4 round 2: the round\'s table, (proof age) × (answer) × (address role) × (member switched mid-round)', () => {
    beforeEach(() => { vi.spyOn(console, 'log').mockImplementation(() => {}); vi.spyOn(console, 'warn').mockImplementation(() => {}); });

    it(`every row (${AGES.length} × ${ANSWERS.length} × ${ROLES.length} × 2 = ${AGES.length * ANSWERS.length * ROLES.length * 2}) does what the invariant says`, async () => {
        const wrong: string[] = [];
        let rows = 0;
        for (const age of AGES) for (const answer of ANSWERS) for (const role of ROLES) for (const switched of [false, true]) {
            rows++;
            const name = `${age} | ${answer} | ${role} | ${switched ? 'switched' : 'not switched'}`;
            const got = await runRow(age, answer, role, switched);
            const w = want(age, answer, role, switched);
            if (got.move !== w.move || got.refused !== w.refused) wrong.push(`${name}: got ${got.move}${got.refused ? ' + refused' : ''}, want ${w.move}${w.refused ? ' + refused' : ''}`);
            // A transient answer never starts a day's refusal, of any address.
            if (TRANSIENT.includes(answer)) {
                const refusedNow = Object.entries(records()[0].refused).filter(([, v]) => v.at === T).map(([k]) => k);
                if (refusedNow.length) wrong.push(`${name}: a transient answer refused ${refusedNow.join(', ')}`);
            }
            // The member's switch always wins: the phone stays where the member put it, and no line is left to show.
            if (switched && (got.anchor !== ELSEWHERE || got.line)) wrong.push(`${name}: the anchor ended at ${got.anchor}, line ${JSON.stringify(got.line)}`);
        }
        expect(rows).toBe(AGES.length * ANSWERS.length * ROLES.length * 2);
        expect(wrong).toEqual([]);
    }, 60_000);
});
