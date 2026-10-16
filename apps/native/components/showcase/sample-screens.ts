/**
 * Example Valley (@beanpool/core SAMPLE_COMMUNITY) in the shapes the member's own screens read, so a screen in preview
 * is the member's own screen fed the sample (scratch/global-node/DESIGN-global-showcase-fable.md §4, "one component"):
 * the Ledger's `getBalance` and `getTransactions` answers, and My Deals' posts and transactions. Pure: no node, no storage,
 * no React.
 *
 * Every id keeps the fixture's `sample-` prefix, which the server refuses on any write (apps/server/src/sample-id-guard.ts).
 */
import { SAMPLE_COMMUNITY, TIER_LEVELS, sampleRowNote, t } from '@beanpool/core';
import type { TreasurySummary, EnterpriseLedgerResponse } from '../../utils/db';

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
  * Example Valley's enterprise (the Bakery) and project (the Compost Bay) in the shape projects.tsx reads,
  * so the Commons enterprise list shows the real enterprise card fed the sample.
  */
export function sampleEnterprises(): TreasurySummary[] {
    const c = SAMPLE_COMMUNITY;
    const e = c.enterprises[0];
    const p = c.projects[0];
    const now = Date.now();

    const enterprise: TreasurySummary = {
        publicKey: e.id,
        name: e.name,
        callsign: e.name,
        avatar: null,
        avatarUrl: null,
        balance: e.balance,
        creditLine: e.creditLine,
        liveOffers: e.liveOffers,
        earnedSurplus: e.earnedSurplus,
        workingCapitalCeiling: e.capitalCeiling,
        purpose: e.what,
        goalAmount: 0,
        currentAmount: null,
        deadlineAt: null,
        lifecycle: 'ongoing',
        status: e.lifecycle.status,
        paused: false,
        keepers: [
            { pubkey: 'sample-keeper-1', callsign: t('a neighbour'), role: 'lead' },
            { pubkey: 'sample-keeper-2', callsign: t('a neighbour'), role: 'keeper' },
            { pubkey: 'sample-keeper-3', callsign: t('a neighbour'), role: 'keeper' },
        ],
    };

    const project: TreasurySummary = {
        publicKey: p.id,
        name: p.title,
        callsign: p.title,
        avatar: null,
        avatarUrl: null,
        balance: p.pledged,
        creditLine: 0,
        liveOffers: 0,
        earnedSurplus: 0,
        workingCapitalCeiling: null,
        purpose: p.what,
        goalAmount: p.goal,
        currentAmount: p.pledged,
        deadlineAt: new Date(now + p.daysToGo * DAY_MS).toISOString(),
        lifecycle: 'bounded',
        status: 'active',
        paused: false,
        keepers: [
            { pubkey: 'sample-keeper-1', callsign: t('a neighbour'), role: 'lead' },
        ],
    };

    return [enterprise, project];
}

/**
  * Full enterprise detail for treasury-detail.tsx in preview mode.
  */
export function sampleTreasuryDetail(pubkey?: string): any {
    const c = SAMPLE_COMMUNITY;
    const isProject = pubkey === c.projects[0].id;
    const now = Date.now();

    if (isProject) {
        const p = c.projects[0];
        return {
            publicKey: p.id,
            id: p.id,
            name: p.title,
            purpose: p.what,
            description: p.what,
            goalAmount: p.goal,
            currentAmount: p.pledged,
            balance: p.pledged,
            creditLine: 0,
            liveOffers: 0,
            earnedSurplus: 0,
            workingCapitalCeiling: null,
            lifecycle: 'bounded',
            status: 'active',
            paused: false,
            deadlineAt: new Date(now + p.daysToGo * DAY_MS).toISOString(),
            backersCount: p.backers,
            keepers: [
                { pubkey: 'sample-keeper-1', publicKey: 'sample-keeper-1', callsign: t('a neighbour'), role: 'lead' },
            ],
            posts: [],
            flow: [],
            pendingBids: [],
            activeDeals: [],
            deferredClaims: [],
        };
    }

    const e = c.enterprises[0];
    return {
        publicKey: e.id,
        id: e.id,
        name: e.name,
        purpose: e.what,
        description: e.what,
        balance: e.balance,
        creditLine: e.creditLine,
        liveOffers: e.liveOffers,
        earnedSurplus: e.earnedSurplus,
        workingCapitalCeiling: e.capitalCeiling,
        goalAmount: 0,
        currentAmount: null,
        deadlineAt: null,
        lifecycle: 'ongoing',
        status: e.lifecycle.status,
        paused: false,
        keepers: [
            { pubkey: 'sample-keeper-1', publicKey: 'sample-keeper-1', callsign: t('a neighbour'), role: 'lead' },
            { pubkey: 'sample-keeper-2', publicKey: 'sample-keeper-2', callsign: t('a neighbour'), role: 'keeper' },
            { pubkey: 'sample-keeper-3', publicKey: 'sample-keeper-3', callsign: t('a neighbour'), role: 'keeper' },
        ],
        posts: e.listings.map(l => ({
            id: l.id,
            title: l.title,
            type: l.type,
            credits: l.price,
            price: l.price,
            description: '',
            repeatable: true,
        })),
        flow: [],
        pendingBids: [],
        activeDeals: [],
        deferredClaims: [],
    };
}

/**
  * Enterprise P&L ledger data for treasury-detail.tsx in preview mode.
  */
export function sampleEnterpriseLedger(pubkey?: string): EnterpriseLedgerResponse {
    const c = SAMPLE_COMMUNITY;
    const isProject = pubkey === c.projects[0].id;
    const now = Date.now();

    if (isProject) {
        const p = c.projects[0];
        return {
            enterprise: {
                publicKey: p.id,
                name: p.title,
                purpose: p.what,
                status: 'active',
                paused: false,
                balance: p.pledged,
            },
            period: { since: null, until: null },
            summary: {
                totalIncome: p.pledged,
                totalSpend: 0,
                netChange: p.pledged,
                startingBalance: 0,
                endingBalance: p.pledged,
                transactionCount: p.backers,
            },
            entries: [
                {
                    id: 'sample-entry-pledges',
                    timestamp: new Date(now - 2 * DAY_MS).toISOString(),
                    direction: 'income',
                    amount: p.pledged,
                    fee: 0,
                    netAmount: p.pledged,
                    counterparty: 'sample-member-neighbour',
                    counterpartyName: t('a neighbour'),
                    memo: t('Backer pledges'),
                    runningBalance: p.pledged,
                    authSigner: null,
                },
            ],
        };
    }

    const e = c.enterprises[0];
    return {
        enterprise: {
            publicKey: e.id,
            name: e.name,
            purpose: e.what,
            status: e.lifecycle.status,
            paused: false,
            balance: e.balance,
        },
        period: { since: null, until: null },
        summary: {
            totalIncome: e.pnl.cameIn,
            totalSpend: e.pnl.wentOut,
            netChange: e.pnl.net,
            startingBalance: e.balance - e.pnl.net,
            endingBalance: e.balance,
            transactionCount: 2,
        },
        entries: [
            {
                id: 'sample-entry-bread',
                timestamp: new Date(now - 3 * DAY_MS).toISOString(),
                direction: 'income',
                amount: e.pnl.cameIn,
                fee: 0,
                netAmount: e.pnl.cameIn,
                counterparty: 'sample-member-neighbour',
                counterpartyName: t('a neighbour'),
                memo: t('Sourdough orders'),
                runningBalance: e.balance,
                authSigner: null,
            },
            {
                id: 'sample-entry-flour',
                timestamp: new Date(now - 10 * DAY_MS).toISOString(),
                direction: 'spend',
                amount: e.pnl.wentOut,
                fee: 0,
                netAmount: -e.pnl.wentOut,
                counterparty: 'sample-member-neighbour',
                counterpartyName: t('a neighbour'),
                memo: t('Organic flour and seeds'),
                runningBalance: e.balance - e.pnl.cameIn,
                authSigner: null,
            },
        ],
    };
}

