/**
 * Example Valley (@beanpool/core SAMPLE_COMMUNITY) in the shapes the member's own screens read, so a screen in preview
 * is the member's own screen fed the sample (scratch/global-node/DESIGN-global-showcase-fable.md §4, "one component"):
 * the Ledger's `getBalance` and `getTransactions` answers, and My Deals' posts and transactions. Pure: no node, no storage,
 * no React.
 *
 * Every id keeps the fixture's `sample-` prefix, which the server refuses on any write (apps/server/src/sample-id-guard.ts).
 */
import { SAMPLE_COMMUNITY, TIER_LEVELS } from '@beanpool/core';

const when = (daysAgo: number) => (daysAgo === 1 ? 'yesterday' : `${daysAgo} days ago`);

/** The Ledger's balance answer for "an example member": 85 Beans, a floor of −200 (level 2 of 4), spend-freeze off. */
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
        tierCredit: tier.minCredit,
        earnedCredit: tier.minCredit,
        qualifiedValue: c.transactions.reduce((sum, t) => sum + (t.kind === 'fee' ? 0 : Math.abs(t.amount)), 0),
        avgRating: 0,
        reviewCount: 0,
        commons: c.pool,
        trustStats: { uniquePartners: new Set(c.transactions.filter(t => t.kind !== 'fee').map(t => t.who)).size },
    };
}

/** The Ledger's transaction rows, newest first: "a neighbour", what it was for, and when. */
export function sampleTransactions() {
    return SAMPLE_COMMUNITY.transactions.map(t => ({
        id: t.id,
        type: t.amount < 0 ? 'debit' : 'credit',
        amount: Math.abs(t.amount),
        peer: t.who,
        memo: t.what,
        timestamp: when(t.daysAgo),
    }));
}

/** "An example member" in My Deals: the key the sheet compares deals against. Never a real account's key. */
export const SAMPLE_DEALS_ME = Object.freeze({ publicKey: 'sample-member-example' });
const SAMPLE_NEIGHBOUR = 'sample-member-neighbour';
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * My Deals fed Example Valley: the deal waiting on you (Beans held safely, In Progress) and the one done (History, with
 * Review). In the shapes MyDealsSheet reads from `getPosts`/`getMyPosts` and `getMarketplaceTransactions`.
 */
export function sampleDeals(now: number = Date.now()) {
    const me = SAMPLE_DEALS_ME.publicKey;
    const at = (daysAgo: number) => new Date(now - daysAgo * DAY_MS).toISOString();
    const posts = SAMPLE_COMMUNITY.deals.filter(d => d.status === 'waiting-on-you').map(d => ({
        id: `${d.id}-post`, title: d.what, type: 'need', status: 'pending', author_pubkey: me, accepted_by: SAMPLE_NEIGHBOUR,
        credits: d.amount, photos: '[]', created_at: at(d.daysAgo),
    }));
    const transactions = SAMPLE_COMMUNITY.deals.map(d => ({
        id: d.id, postId: `${d.id}-post`, postTitle: d.what, status: d.status === 'done' ? 'completed' : 'pending',
        buyerPublicKey: me, buyerCallsign: SAMPLE_COMMUNITY.member, sellerPublicKey: SAMPLE_NEIGHBOUR, sellerCallsign: d.who,
        credits: d.amount, createdAt: at(d.daysAgo), ratedByBuyer: false, ratedBySeller: false,
    }));
    return { posts, transactions };
}

/** The member's header over a preview: "Example Valley · an example member". */
export const SAMPLE_MEMBER_HEADER = `${SAMPLE_COMMUNITY.name} · ${SAMPLE_COMMUNITY.member}`;
export const SAMPLE_MEMBER = SAMPLE_COMMUNITY.member;
