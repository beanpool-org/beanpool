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
 * - **Never a working invitation.** An example invite's code (`EXAMPLE-1234`) is a shape no node and no app reads as an
 *   invite, a ticket, a pairing or a claim, and carries no address: copied, typed or drawn as a QR, it joins nobody.
 * - **Words to translate.** Every sentence a screen draws is marked with `word()`, so it is translated where it is shown
 *   (`t(sample.what)`); ids, codes and states are not words.
 *
 * Tested once: __tests__/sample-community.test.ts (frozen; no `@`, URL, key or real-looking name; every id prefixed; the
 * numbers agree with each other and with the rules the real screens use).
 */

import { word, type WordKey } from './words.js';

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
    what: WordKey;
    /** Who it was with: never a name. */
    who: WordKey;
    /** Beans: positive in, negative out. */
    amount: number;
    kind: 'trade' | 'deal' | 'gift';
    daysAgo: number;
}

export interface SampleDeal {
    id: string;
    what: WordKey;
    who: WordKey;
    amount: number;
    /** Where it stands for the member: one waits on them, one holds their Beans safely, one is done. */
    status: 'waiting-on-you' | 'held' | 'done';
    /**
     * The deal as a node records it (a marketplace transaction's status): `requested`, a neighbour offered to do the
     * member's Need and the member's Approve & Commit is next (My Deals: "Action Required"); `pending`, the Beans are
     * held until the job is done ("Held in Trust"); `completed`.
     */
    state: 'requested' | 'pending' | 'completed';
    /** The member's side: `bought`, their Beans pay; `sold`, their help earned. */
    side: 'bought' | 'sold';
    daysAgo: number;
}

/** One listing, as the Market and an enterprise's page draw it. */
export interface SampleListing {
    id: string;
    title: WordKey;
    type: 'offer' | 'need';
    /** Beans. */
    price: number;
}

export interface SampleEnterprise {
    id: string;
    name: WordKey;
    what: WordKey;
    keepers: number;
    /** This season's takings less its spending, in Beans: the P&L's net. */
    season: number;
    /** What it holds, in Beans. */
    balance: number;
    /** How far below zero it may go: its credit line, in Beans. */
    creditLine: number;
    liveOffers: number;
    /** What it has earned above its costs: what a keeper's wage may come out of. */
    earnedSurplus: number;
    /** The most it may hold: above this, Beans go back to the Commons. */
    capitalCeiling: number;
    /** Income & Spend over the last 30 days. */
    pnl: { days: number; cameIn: number; wentOut: number; net: number };
    /** Its live offers. */
    listings: readonly SampleListing[];
    /** Active, and its keepers may pause it or wind it up (both open the sheet in a preview). */
    lifecycle: { status: 'active'; mayPause: boolean; mayWindUp: boolean };
}

/** A crowdfund project, for the Projects chip. */
export interface SampleProject {
    id: string;
    title: WordKey;
    what: WordKey;
    /** Beans. */
    goal: number;
    pledged: number;
    backers: number;
    daysToGo: number;
}

export interface SampleDecision {
    id: string;
    question: WordKey;
    /** Beans the Decision would pay from the Commons pool. */
    fromPool: number;
    closesInDays: number;
    votesFor: number;
    votesAgainst: number;
    /** What it touches (the Decide card's tags): the Commons pool, by a grant. */
    touches: 'pool';
    effect: 'grant_enterprise';
    /** Whom the grant goes to: the sample project. */
    subject: string;
    /** One member, one vote. */
    franchise: '1m1v';
    /** Members who may vote and were active in the last 30 days: the turnout base. */
    electorate: number;
    /** Share of the electorate that must vote. */
    quorumRatio: number;
    /** Votes needed: the share of the electorate, at least 3 (the node's rule). */
    quorumRequired: number;
    /** Share of the votes cast that must be Yes. */
    thresholdRequired: number;
}

export interface SampleInvite {
    id: string;
    /** The code as the Invites card draws it: obviously an example, and a shape no node or app reads as an invite. */
    code: string;
    /** Who it is for, as the member wrote it. */
    intendedFor: WordKey;
    status: 'pending' | 'used';
    daysAgo: number;
    /** Who joined with it (a member in the invite tree), when used. */
    usedBy?: string;
    usedDaysAgo?: number;
}

export interface SampleTreeMember {
    id: string;
    who: WordKey;
    joinedDaysAgo: number;
    invited: readonly SampleTreeMember[];
}

export interface SampleCommunity {
    id: string;
    name: WordKey;
    /** The Ledger header: "Example Valley · an example member". */
    member: WordKey;
    balance: number;
    /** The credit line's floor: the lowest the balance may go. */
    floor: number;
    /** Room left to spend: the balance down to the floor. */
    roomToSpend: number;
    /** Beans held safely in the member's deals (the Wallet's In Escrow): the held deal's. */
    inEscrow: number;
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
    /** Voice credits on a pool vote: the value traded, as the node counts them (the Commons stat row). */
    voiceCredits: number;
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
    projects: readonly SampleProject[];
    decisions: readonly SampleDecision[];
    /** The member's invitations: one waiting, one used. */
    invites: readonly SampleInvite[];
    /** Who came in through whom: the member, and the two they brought in. */
    inviteTree: SampleTreeMember;
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

const NEIGHBOUR = word('a neighbour');
const BAKERY = word('the Example Valley Bakery');

/**
 * Example Valley, frozen (design §2: balance 85, room to spend 285 down to −200, level 2 of 4 with 200 trust, six rows).
 *
 * No circulation fee row: the fee is charged only above the fee-free ceiling, and a member at 85 Beans never pays it, so
 * a fee row beside 85 would teach the wrong rule. The design's balance stays (every screen's 85 · room 285 · level 2
 * agrees with it); the row is a sixth trade instead.
 */
export const SAMPLE_COMMUNITY: SampleCommunity = deepFreeze({
    id: 'sample-community-example-valley',
    name: word('Example Valley'),
    member: word('an example member'),
    balance: 85,
    floor: -200,
    roomToSpend: 285,
    inEscrow: 20,
    liveOffers: 1,
    level: 2,
    levels: 4,
    trust: 200,
    valueTraded: 582,
    voiceCredits: 582,
    partners: 5,
    rating: 4.8,
    reviews: 5,
    beansPerHour: 40,
    transactions: [
        { id: 'sample-tx-bread', what: word('A loaf of bread'), who: NEIGHBOUR, amount: 12, kind: 'trade', daysAgo: 1 },
        { id: 'sample-tx-gardening', what: word('An hour of gardening'), who: NEIGHBOUR, amount: -40, kind: 'trade', daysAgo: 3 },
        { id: 'sample-tx-mending', what: word('Mending a jacket'), who: NEIGHBOUR, amount: 30, kind: 'deal', daysAgo: 5 },
        { id: 'sample-tx-jam', what: word('Two jars of jam'), who: NEIGHBOUR, amount: 8, kind: 'trade', daysAgo: 7 },
        { id: 'sample-tx-gift', what: word('A thank-you gift'), who: NEIGHBOUR, amount: 5, kind: 'gift', daysAgo: 9 },
        { id: 'sample-tx-seedlings', what: word('A tray of seedlings'), who: BAKERY, amount: -18, kind: 'trade', daysAgo: 12 },
    ],
    deals: [
        { id: 'sample-deal-shelves', what: word('Putting up two shelves'), who: NEIGHBOUR, amount: 40, status: 'waiting-on-you', state: 'requested', side: 'bought', daysAgo: 2 },
        { id: 'sample-deal-bike', what: word('Fixing a bike puncture'), who: NEIGHBOUR, amount: 20, status: 'held', state: 'pending', side: 'bought', daysAgo: 1 },
        { id: 'sample-deal-mending', what: word('Mending a jacket'), who: NEIGHBOUR, amount: 30, status: 'done', state: 'completed', side: 'sold', daysAgo: 5 },
    ],
    enterprises: [
        {
            id: 'sample-enterprise-bakery',
            name: word('Example Valley Bakery'),
            what: word('Bread and seedlings from a shared kitchen'),
            keepers: 3,
            season: 120,
            balance: 160,
            creditLine: 200,
            liveOffers: 1,
            earnedSurplus: 90,
            capitalCeiling: 500,
            pnl: { days: 30, cameIn: 180, wentOut: 60, net: 120 },
            listings: [
                { id: 'sample-listing-sourdough', title: word('Sourdough loaves, baked twice a week'), type: 'offer', price: 12 },
            ],
            lifecycle: { status: 'active', mayPause: true, mayWindUp: true },
        },
    ],
    projects: [
        {
            id: 'sample-project-compost-bay',
            title: word('A compost bay by the community garden'),
            what: word('Timber and a roof for three compost bins'),
            goal: 120,
            pledged: 80,
            backers: 6,
            daysToGo: 12,
        },
    ],
    decisions: [
        {
            id: 'sample-decision-compost-bay',
            question: word('Build a compost bay by the community garden'),
            fromPool: 40,
            closesInDays: 3,
            votesFor: 12,
            votesAgainst: 2,
            touches: 'pool',
            effect: 'grant_enterprise',
            subject: 'sample-project-compost-bay',
            franchise: '1m1v',
            electorate: 20,
            quorumRatio: 0.3,
            quorumRequired: 6,
            thresholdRequired: 0.6,
        },
    ],
    invites: [
        { id: 'sample-invite-waiting', code: 'EXAMPLE-1234', intendedFor: NEIGHBOUR, status: 'pending', daysAgo: 2 },
        { id: 'sample-invite-used', code: 'EXAMPLE-5678', intendedFor: NEIGHBOUR, status: 'used', daysAgo: 10, usedBy: 'sample-member-second', usedDaysAgo: 6 },
    ],
    inviteTree: {
        id: 'sample-member-example',
        who: word('an example member'),
        joinedDaysAgo: 90,
        invited: [
            { id: 'sample-member-first', who: NEIGHBOUR, joinedDaysAgo: 40, invited: [] },
            { id: 'sample-member-second', who: NEIGHBOUR, joinedDaysAgo: 6, invited: [] },
        ],
    },
    pool: 640,
});
