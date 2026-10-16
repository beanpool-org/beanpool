/**
 * Example Valley: the sample community a switched-off feature is previewed from (scratch/global-node/
 * DESIGN-global-showcase-fable.md §2, Marty's picks 1 and 5, 13 Oct 2026). One file for both apps, bundled, so a preview
 * needs no connection and no API.
 *
 * - **Obviously a sample.** The community is Example Valley; no person has a name. The member whose ledger it is reads
 *   "an example member", and every counterparty is "a neighbour", "the Commons" or "the Example Valley Bakery".
 * - **Frozen.** Every object and array here is frozen, so no screen can change a number by accident, and the numbers
 *   are the same on every phone. Times are relative (days ago, days to go), so the sample never looks stale.
 * - **Never written anywhere.** Every id starts with `sample-` (SAMPLE_ID_PREFIX). The server refuses any write that
 *   carries one with 400 `sample_id` (apps/server/src/sample-id-guard.ts), so no number from here can reach a ledger or
 *   any API write, whatever a screen's bug.
 *
 * Tested once: __tests__/sample-community.test.ts (frozen; no `@`, URL, key or real-looking name; every id prefixed).
 */

/** Every id in the sample starts with this, and the server refuses a write that carries one. */
export const SAMPLE_ID_PREFIX = 'sample-';

/** The shape of a sample id: the prefix, then lower-case words joined by hyphens (`sample-tx-bread`). */
const SAMPLE_ID_SHAPE = /^sample-[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** True for a string shaped like a sample id: what the server's guard refuses. */
export function isSampleId(value: unknown): value is string {
    return typeof value === 'string' && SAMPLE_ID_SHAPE.test(value);
}

export interface SampleTransaction {
    id: string;
    /** What it was for, as a row shows it. */
    what: string;
    /** Who it was with: never a name. */
    who: string;
    /** Beans: positive in, negative out. */
    amount: number;
    kind: 'trade' | 'deal' | 'fee' | 'gift';
    daysAgo: number;
}

export interface SampleDeal {
    id: string;
    what: string;
    who: string;
    amount: number;
    /** One waits on the member (to approve the finished work), one is done. */
    status: 'waiting-on-you' | 'done';
    daysAgo: number;
}

export interface SampleEnterprise {
    id: string;
    name: string;
    what: string;
    keepers: number;
    /** This season's takings less its spending, in Beans. */
    season: number;
}

export interface SampleDecision {
    id: string;
    question: string;
    /** Beans the Decision would pay from the Commons pool. */
    fromPool: number;
    closesInDays: number;
    votesFor: number;
    votesAgainst: number;
}

export interface SampleCommunity {
    id: string;
    name: string;
    /** The Ledger header: "Example Valley · an example member". */
    member: string;
    balance: number;
    /** The credit line's floor: the lowest the balance may go. */
    floor: number;
    /** Room left to spend: the balance down to the floor. */
    roomToSpend: number;
    liveOffers: number;
    level: number;
    levels: number;
    /**
     * The trust behind the level, as a Levels card shows it ("Level 2 of 4 · 200 trust"): the credit that backs the floor
     * (CREDIT_BASE_FLOOR − floor), all of it earned by trading here, so it sits in level 2's band of TIER_LEVELS.
     */
    trust: number;
    /** The value traded that earned it (earnedCreditFromValue(valueTraded) === trust): "What builds your trust". */
    valueTraded: number;
    /** Different people traded with: at least the value traded over the per-partner cap. */
    partners: number;
    /** The average of the reviews left after trades, out of 5, and how many there are. */
    rating: number;
    reviews: number;
    /** "About 40 Beans an hour", the rough guide a Pricing Guide would give. */
    beansPerHour: number;
    /** The latest rows only, not the whole history: they don't sum to the balance, so a screen shows them as recent. */
    transactions: readonly SampleTransaction[];
    deals: readonly SampleDeal[];
    enterprises: readonly SampleEnterprise[];
    decisions: readonly SampleDecision[];
    /** The Commons pool, in Beans. */
    pool: number;
}

/** Freezes an object and everything under it. */
function deepFreeze<T>(value: T): T {
    if (value && typeof value === 'object' && !Object.isFrozen(value)) {
        Object.freeze(value);
        for (const v of Object.values(value as Record<string, unknown>)) deepFreeze(v);
    }
    return value;
}

/** Example Valley, frozen (design §2: balance 85, room to spend 285 down to −200, level 2 of 4 with 200 trust, six rows, two deals). */
export const SAMPLE_COMMUNITY: SampleCommunity = deepFreeze({
    id: 'sample-community-example-valley',
    name: 'Example Valley',
    member: 'an example member',
    balance: 85,
    floor: -200,
    roomToSpend: 285,
    liveOffers: 1,
    level: 2,
    levels: 4,
    trust: 200,
    valueTraded: 582,
    partners: 5,
    rating: 4.8,
    reviews: 5,
    beansPerHour: 40,
    transactions: [
        { id: 'sample-tx-bread', what: 'A loaf of bread', who: 'a neighbour', amount: 12, kind: 'trade', daysAgo: 1 },
        { id: 'sample-tx-gardening', what: 'An hour of gardening', who: 'a neighbour', amount: -40, kind: 'trade', daysAgo: 3 },
        { id: 'sample-tx-mending', what: 'Mending a jacket', who: 'a neighbour', amount: 30, kind: 'deal', daysAgo: 5 },
        { id: 'sample-tx-circulation-fee', what: 'Circulation fee', who: 'the Commons', amount: -0.9, kind: 'fee', daysAgo: 7 },
        { id: 'sample-tx-gift', what: 'A thank-you gift', who: 'a neighbour', amount: 5, kind: 'gift', daysAgo: 9 },
        { id: 'sample-tx-seedlings', what: 'A tray of seedlings', who: 'the Example Valley Bakery', amount: -18, kind: 'trade', daysAgo: 12 },
    ],
    deals: [
        { id: 'sample-deal-shelves', what: 'Putting up two shelves', who: 'a neighbour', amount: 40, status: 'waiting-on-you', daysAgo: 2 },
        { id: 'sample-deal-mending', what: 'Mending a jacket', who: 'a neighbour', amount: 30, status: 'done', daysAgo: 5 },
    ],
    enterprises: [
        { id: 'sample-enterprise-bakery', name: 'Example Valley Bakery', what: 'Bread and seedlings from a shared kitchen', keepers: 3, season: 120 },
    ],
    decisions: [
        { id: 'sample-decision-compost-bay', question: 'Build a compost bay by the community garden', fromPool: 40, closesInDays: 3, votesFor: 12, votesAgainst: 2 },
    ],
    pool: 640,
});
