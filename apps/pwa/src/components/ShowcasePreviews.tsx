/**
 * The preview mode of the Ledger, the Commons' enterprises and Decide, and My Deals (scratch/global-node/
 * DESIGN-global-showcase-fable.md §1 rows 3, 5, 6; §2): the member's screen drawn from Example Valley, the sample
 * community in @beanpool/core, under the 🏘️ Local community strip. The ONLY web file that imports the sample.
 *
 * - **Nothing here talks to the node.** No fetch, no write: the sample is bundled, and every action that would move
 *   Beans, vote or pledge is a marker action that opens the sheet. The explainers stay live (CommonsInfoModal).
 * - **The Ledger and My Deals are the real screens.** LedgerPage draws itself from `sampleLedger()` and MyDealsModal
 *   from `sampleDeals()` in preview, as the phone does; the Commons preview is drawn here.
 * - **Obviously a sample.** The Example chip and dashed cards; nobody is named ("a neighbour").
 * - **Levels are merit badges**, never shown as locked; currency is Beans.
 */

import { useState } from 'react';
import { SAMPLE_COMMUNITY, LOCAL_COMMUNITY_STRIP, TIER_LEVELS, sampleRowNote, t, tn, type SampleDeal } from '@beanpool/core';
import { LocalCommunityAction, LocalCommunityPill, LocalCommunityStrip, type LocalCommunityWays } from './LocalCommunityMark';
import { CommonsInfoModal } from './CommonsInfoModal';
import type { BalanceInfo, DecisionWithTally, MarketplacePost, MarketplaceTransaction, MyPoolVoting } from '../lib/api';

const S = SAMPLE_COMMUNITY;

const CARD = 'rounded-2xl border-2 border-dashed border-nature-300 dark:border-nature-600 bg-nature-50 dark:bg-nature-950 p-4';

function beans(n: number): string {
    const abs = Math.abs(n);
    const s = Number.isInteger(abs) ? String(abs) : abs.toFixed(1);
    return `${n < 0 ? '−' : n > 0 ? '+' : ''}${s} Beans`;
}

function ago(days: number): string {
    return days === 1 ? t('yesterday') : tn(days, '{n} day ago', '{n} days ago');
}

function ExampleChip() {
    return (
        <span className="inline-flex shrink-0 items-center rounded-full border border-dashed border-nature-400 dark:border-nature-500 px-2 py-0.5 text-[11px] font-black uppercase text-nature-600 dark:text-nature-300">
            Example
        </span>
    );
}

/** "Example Valley · an example member", with the Example chip. */
export function SampleHeader() {
    return (
        <div className="mb-3 flex flex-wrap items-center gap-2" data-testid="sample-header">
            <ExampleChip />
            <span className="min-w-0 text-sm font-bold text-nature-700 dark:text-nature-200">{LOCAL_COMMUNITY_STRIP.header}</span>
        </div>
    );
}

/** One row of the Ledger's Wallet as LedgerPage draws it: in or out, its note, the small line under it, the Beans. */
export interface LedgerRowView {
    id: string;
    sent: boolean;
    note: string;
    when: string;
    amount: number;
}

/**
 * Example Valley's "example member" in the shapes LedgerPage reads, so the Ledger in preview is the member's own screen
 * fed the sample (design §1 row 3): the balance answer (85 Beans, floor −200, one live Offer, level 2 of 4 with the
 * sample's own trust, value traded, partners and rating, the figures the phone's Ledger reads too) and the recent rows,
 * newest first, each with who it was with and when; the held deal's row says its Beans are held in trust, and when.
 */
export function sampleLedger(): { member: string; balance: BalanceInfo; rows: LedgerRowView[] } {
    const c = SAMPLE_COMMUNITY;
    const tier = TIER_LEVELS[Math.max(0, Math.min(TIER_LEVELS.length - 1, c.level - 1))];
    return {
        member: c.member,
        balance: {
            balance: c.balance,
            floor: c.floor,
            usableFloor: c.floor,
            liveOffers: c.liveOffers,
            activated: true,
            frozen: false,
            knownGrant: 0,
            tier: { name: tier.name, emoji: tier.emoji },
            tierCredit: c.trust,
            earnedCredit: c.trust,
            qualifiedValue: c.valueTraded,
            avgRating: c.rating,
            reviewCount: c.reviews,
            commonsBalance: c.pool,
            callsign: c.member,
            trustStats: { tradeCount: c.transactions.filter(x => x.kind === 'trade' || x.kind === 'deal').length, uniquePartners: c.partners, ageDays: 0 },
        },
        rows: c.transactions.map(x => ({
            id: x.id,
            sent: x.amount < 0,
            note: sampleRowNote(x),
            when: x.kind === 'hold' ? ago(x.daysAgo)
                : x.amount < 0
                ? t('to {who} · {when}', { who: x.who, when: ago(x.daysAgo) })
                : t('from {who} · {when}', { who: x.who, when: ago(x.daysAgo) }),
            amount: Math.abs(x.amount),
        })),
    };
}

/**
 * Example Valley's Decision as the real Decide screen reads it (DecisionWithTally): touches pool, grant enterprise,
 * quadratic on trade, turnout 9 of 6, Yes 12 (86%) · No 2 · needs 60%, closing in 3 days.
 */
export function sampleDecisions(): DecisionWithTally[] {
    const d = S.decisions[0];
    const now = Date.now();
    const DAY_MS = 24 * 60 * 60 * 1000;
    return [{
        id: d.id,
        authorPubkey: 'sample-member-neighbour',
        title: d.question,
        description: t('{amount} Beans from the pool: {what}.', { amount: String(d.fromPool), what: S.projects[0].what }),
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
        voiceCredits: S.voiceCredits,
        hasCompletedTrade: true,
    };
}

/** The Commons pool balance in Beans from Example Valley (640). */
export function sampleCommonsBalance(): number {
    return S.pool;
}

/**
 * The Commons in preview: the pool and an enterprise where enterprises are previewed (the real Decide screen
 * is drawn by DecideSection on the Decide tab).
 */
export function CommonsPreview({ enterprises = true, ...ways }: { enterprises?: boolean } & LocalCommunityWays) {
    const [commonsInfo, setCommonsInfo] = useState(false);
    const e = S.enterprises[0];
    if (!enterprises) return null;
    return (
        <div data-testid="commons-preview">
            <LocalCommunityStrip feature="enterprises" {...ways} />
            <SampleHeader />
            <section className={`${CARD} mb-4`}>
                <div className="flex items-center justify-between gap-2">
                    <p className="text-xs font-bold uppercase tracking-wide text-nature-500 dark:text-nature-400">Commons pool</p>
                    <button type="button" onClick={() => setCommonsInfo(true)} className="-my-2 -mr-2 inline-flex min-h-[44px] min-w-[44px] items-center justify-center shrink-0 text-sm font-semibold text-blue-700 dark:text-blue-300" aria-label="How the Commons works">ⓘ</button>
                </div>
                <p className="text-2xl font-black text-nature-900 dark:text-nature-50">{S.pool} Beans</p>
            </section>
            <section className={`${CARD} mb-4`} data-testid="sample-enterprise">
                <div className="mb-1 flex flex-wrap items-center gap-2">
                    <h3 className="font-bold text-nature-900 dark:text-nature-50">🏛️ {e.name}</h3>
                    <LocalCommunityPill />
                </div>
                <p className="text-sm text-nature-600 dark:text-nature-300">{e.what}</p>
                <p className="mt-1 text-sm text-nature-600 dark:text-nature-300">{e.keepers} keepers · this season {beans(e.season)}</p>
                <div className="mt-3 flex flex-col gap-2 sm:flex-row">
                    <LocalCommunityAction feature="enterprises" label="Pledge" className="w-full" {...ways} />
                    <LocalCommunityAction feature="enterprises" label="Pause" className="w-full" {...ways} />
                </div>
            </section>
            <CommonsInfoModal isOpen={commonsInfo} onClose={() => setCommonsInfo(false)} commonsBalance={S.pool} />
        </div>
    );
}

/** "An example member" in My Deals: the key the modal compares deals against. Never a real account's key. */
export const SAMPLE_DEALS_ME = Object.freeze({ publicKey: 'sample-member-example' });
const SAMPLE_NEIGHBOUR = 'sample-member-neighbour';
const DAY_MS = 24 * 60 * 60 * 1000;

export interface SampleDealsResult {
    identity: { publicKey: string };
    posts: MarketplacePost[];
    transactions: MarketplaceTransaction[];
}

/**
 * My Deals fed Example Valley, in the shapes MyDealsModal reads from `posts` and `transactions`
 * (as the phone's MyDealsSheet already does: sampleDeals()):
 * - waiting on you (`requested`): the member's Need, a neighbour offered to do it, and Approve & Commit is the member's
 *   (In Progress: "Action Required");
 * - held (`pending`): the member asked a neighbour's offer, and the Beans are held until the job is done ("Held in trust");
 * - done (`completed`): the member SOLD it, so History reads "+30" (or "+ 30"), as the Ledger's "Mending a jacket +30" row does.
 */
export function sampleDeals(now: number = Date.now()): SampleDealsResult {
    const me = SAMPLE_DEALS_ME.publicKey;
    const at = (daysAgo: number) => new Date(now - daysAgo * DAY_MS).toISOString();
    const posts: MarketplacePost[] = S.deals.filter(d => d.state !== 'completed').map(d => d.state === 'requested'
        ? {
            id: `${d.id}-post`,
            title: d.what,
            type: 'need',
            status: 'active',
            authorPublicKey: me,
            authorCallsign: S.member,
            acceptedBy: undefined,
            credits: d.amount,
            photos: [],
            createdAt: at(d.daysAgo),
            category: 'services',
            description: '',
            priceType: 'fixed',
            active: true,
            repeatable: false,
        }
        : {
            id: `${d.id}-post`,
            title: d.what,
            type: 'offer',
            status: 'pending',
            authorPublicKey: SAMPLE_NEIGHBOUR,
            authorCallsign: d.who,
            acceptedBy: me,
            credits: d.amount,
            photos: [],
            createdAt: at(d.daysAgo),
            category: 'services',
            description: '',
            priceType: 'fixed',
            active: true,
            repeatable: false,
        });
    const transactions: MarketplaceTransaction[] = S.deals.map(d => {
        const bought = d.side === 'bought';
        return {
            id: d.id,
            postId: `${d.id}-post`,
            postTitle: d.what,
            status: d.state,
            buyerPublicKey: bought ? me : SAMPLE_NEIGHBOUR,
            buyerCallsign: bought ? S.member : d.who,
            sellerPublicKey: bought ? SAMPLE_NEIGHBOUR : me,
            sellerCallsign: bought ? d.who : S.member,
            credits: d.amount,
            createdAt: at(d.daysAgo),
            ratedByBuyer: false,
            ratedBySeller: false,
        };
    });
    return { identity: SAMPLE_DEALS_ME, posts, transactions };
}

/** My Deals' chip in preview, one per sample state: a state added to SampleDeal fails tsc here until it has its own. */
const SAMPLE_DEAL_CHIP: Record<SampleDeal['state'], { label: () => string; tone: string }> = {
    requested: { label: () => t('Action Required'), tone: 'bg-bp-chip-warn-tint text-bp-chip-warn-ink' },
    pending: { label: () => t('Held in trust'), tone: 'bg-bp-chip-ok-tint text-bp-chip-ok-ink' },
    completed: { label: () => t('Completed'), tone: 'bg-bp-chip-ok-tint text-bp-chip-ok-ink' },
};

/** The chip for a sample deal's status, or null for any other: a deal is never drawn as a state it is not in. */
export function sampleDealChip(status: string): { label: string; tone: string } | null {
    const chip = Object.prototype.hasOwnProperty.call(SAMPLE_DEAL_CHIP, status) ? SAMPLE_DEAL_CHIP[status as SampleDeal['state']] : null;
    return chip ? { label: chip.label(), tone: chip.tone } : null;
}
