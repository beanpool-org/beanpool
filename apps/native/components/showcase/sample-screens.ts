/**
 * Example Valley (@beanpool/core SAMPLE_COMMUNITY) in the shapes the member's own screens read, so a screen in preview
 * is the member's own screen fed the sample (scratch/global-node/DESIGN-global-showcase-fable.md §4, "one component"):
 * the Ledger's `getBalance` and `getTransactions` answers, and My Deals' posts and transactions. Pure: no node, no storage,
 * no React.
 *
 * Every id keeps the fixture's `sample-` prefix, which the server refuses on any write (apps/server/src/sample-id-guard.ts).
 */
import type { DecisionWithTally, MyPoolVoting } from '../../utils/db';
import { SAMPLE_COMMUNITY, TIER_LEVELS, sampleRowNote, t } from '@beanpool/core';

const when = (daysAgo: number) => (daysAgo === 1 ? 'yesterday' : `${daysAgo} days ago`);

/**
 * The Ledger's balance answer for "an example member": 85 Beans, a floor of −200, level 2 of 4 with 200 trust, spend-freeze
 * off. The trust, value traded, partners and rating are the sample's own (one source with the web's Ledger).
 */
export function sampleBalance() {
    const c = SAMPLE_COMMUNITY;
    const tier = TIER_LEVELS[Math.max(0, Math.min(TIER_LEVELS.length - 1, c.level - 1))];
    return {
        balance: c.balance,
        floor: c.floor,
        usableFloor: c.floor,
        liveOffers: c.liveOffers,
        activated: true,
        frozen: false,
        creditFrozen: false,
        knownFrozen: false,
        knownGrant: 0,
        tier: { name: tier.name, emoji: tier.emoji },
        tierCredit: c.trust,
        earnedCredit: c.trust,
        qualifiedValue: c.valueTraded,
        avgRating: c.rating,
        reviewCount: c.reviews,
        commons: c.pool,
        trustStats: { uniquePartners: c.partners },
    };
}

/** The Ledger's transaction rows, newest first: "a neighbour", what it was for (a hold: "Held in trust · …"), and when. */
export function sampleTransactions() {
    return SAMPLE_COMMUNITY.transactions.map(t => ({
        id: t.id,
        type: t.amount < 0 ? 'debit' : 'credit',
        amount: Math.abs(t.amount),
        peer: t.who,
        memo: sampleRowNote(t),
        timestamp: when(t.daysAgo),
    }));
}

/** "An example member" in My Deals: the key the sheet compares deals against. Never a real account's key. */
export const SAMPLE_DEALS_ME = Object.freeze({ publicKey: 'sample-member-example' });
const SAMPLE_NEIGHBOUR = 'sample-member-neighbour';
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * My Deals fed Example Valley, in the shapes MyDealsSheet reads from `getPosts`/`getMyPosts` and
 * `getMarketplaceTransactions`, each deal in the state the fixture names:
 * - waiting on you (`requested`): the member's Need, a neighbour offered to do it, and Approve & Commit is the member's
 *   (In Progress: "Action Required");
 * - held (`pending`): the member asked a neighbour's offer, and the Beans are held until the job is done ("Held in Trust");
 * - done (`completed`): the member SOLD it, so History reads "+ 30", as the Ledger's "Mending a jacket +30" row does.
 */
export function sampleDeals(now: number = Date.now()) {
    const me = SAMPLE_DEALS_ME.publicKey;
    const at = (daysAgo: number) => new Date(now - daysAgo * DAY_MS).toISOString();
    const posts = SAMPLE_COMMUNITY.deals.filter(d => d.state !== 'completed').map(d => d.state === 'requested'
        ? {
            id: `${d.id}-post`, title: d.what, type: 'need', status: 'active', author_pubkey: me, accepted_by: null,
            credits: d.amount, photos: '[]', created_at: at(d.daysAgo),
        }
        : {
            id: `${d.id}-post`, title: d.what, type: 'offer', status: 'pending', author_pubkey: SAMPLE_NEIGHBOUR, accepted_by: me,
            credits: d.amount, photos: '[]', created_at: at(d.daysAgo),
        });
    const transactions = SAMPLE_COMMUNITY.deals.map(d => {
        const bought = d.side === 'bought';
        return {
            id: d.id, postId: `${d.id}-post`, postTitle: d.what, status: d.state,
            buyerPublicKey: bought ? me : SAMPLE_NEIGHBOUR, buyerCallsign: bought ? SAMPLE_COMMUNITY.member : d.who,
            sellerPublicKey: bought ? SAMPLE_NEIGHBOUR : me, sellerCallsign: bought ? d.who : SAMPLE_COMMUNITY.member,
            credits: d.amount, createdAt: at(d.daysAgo), ratedByBuyer: false, ratedBySeller: false,
        };
    });
    return { posts, transactions };
}

/** The Wallet's In Escrow in preview: the Beans the member's held deals hold (the fixture's `inEscrow`). */
export function sampleEscrowTotal(): number {
    return SAMPLE_COMMUNITY.deals.filter(d => d.state === 'pending' && d.side === 'bought').reduce((sum, d) => sum + d.amount, 0);
}

/** The member's header over a preview: "Example Valley · an example member". */
export const SAMPLE_MEMBER_HEADER = `${SAMPLE_COMMUNITY.name} · ${SAMPLE_COMMUNITY.member}`;
export const SAMPLE_MEMBER = SAMPLE_COMMUNITY.member;

/**
 * Example Valley's Decision as the phone's Decide screen reads it (DecisionWithTally): touches pool, grant enterprise,
 * quadratic on trade, turnout 9 of 6, Yes 12 (86%) · No 2 · needs 60%, closing in 3 days.
 */
export function sampleDecisions(): DecisionWithTally[] {
    const c = SAMPLE_COMMUNITY;
    const d = c.decisions[0];
    const now = Date.now();
    const DAY_MS = 24 * 60 * 60 * 1000;
    return [{
        id: d.id,
        authorPubkey: 'sample-member-neighbour',
        title: d.question,
        description: t('{amount} Beans from the pool: {what}.', { amount: String(d.fromPool), what: c.projects[0].what }),
        touches: d.touches,
        effect: d.effect,
        subject: d.subject,
        params: { amount: d.fromPool, subject: d.subject },
        franchise: d.franchise,
        status: 'open',
        opensAt: new Date(now - 4 * DAY_MS).toISOString(),
        closesAt: new Date(now + d.closesInDays * DAY_MS).toISOString(),
        gracePeriodEndsAt: null,
        createdAt: new Date(now - 4 * DAY_MS).toISOString(),
        executedAt: null,
        executionError: null,
        executionReason: null,
        adminHaltedAt: null,
        adminHaltReason: null,
        updatedAt: new Date(now - 4 * DAY_MS).toISOString(),
        tally: {
            decisionId: d.id,
            status: 'open',
            totalVoters: d.totalVoters,
            electorate: d.electorate,
            quorumRatio: d.quorumRatio,
            quorumRequired: d.quorumRequired,
            quorumMet: d.quorumMet,
            yesWeight: d.yesWeight,
            noWeight: d.noWeight,
            totalWeight: d.yesWeight + d.noWeight,
            supportRatio: d.yesWeight / (d.yesWeight + d.noWeight),
            thresholdRequired: d.thresholdRequired,
            passed: d.passed,
        },
        myVote: null,
    }];
}

/** Voice credits for money votes from Example Valley (582 voice credits, completed trades). */
export function samplePoolVoting(): MyPoolVoting {
    return {
        voiceCredits: SAMPLE_COMMUNITY.voiceCredits,
        hasCompletedTrade: true,
    };
}

