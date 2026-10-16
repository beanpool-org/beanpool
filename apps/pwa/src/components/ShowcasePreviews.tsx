/**
 * The preview mode of the Ledger, the Commons' enterprises and Decide, and My Deals (scratch/global-node/
 * DESIGN-global-showcase-fable.md §1 rows 3, 5, 6; §2): the member's screen drawn from Example Valley, the sample
 * community in @beanpool/core, under the 🏘️ Local community strip. The ONLY web file that imports the sample.
 *
 * - **Nothing here talks to the node.** No fetch, no write: the sample is bundled, and every action that would move
 *   Beans, vote or pledge is a marker action that opens the sheet. The explainers stay live (CommonsInfoModal).
 * - **The Ledger is the real screen.** LedgerPage draws itself from `sampleLedger()` in preview, as the phone's Ledger
 *   does from components/showcase/sample-screens.ts; the Commons and My Deals previews are drawn here.
 * - **Obviously a sample.** The Example chip and dashed cards; nobody is named ("a neighbour").
 * - **Levels are merit badges**, never shown as locked; currency is Beans.
 */

import { useState } from 'react';
import { SAMPLE_COMMUNITY, LOCAL_COMMUNITY_STRIP, TIER_LEVELS, t, tn } from '@beanpool/core';
import { LocalCommunityAction, LocalCommunityPill, LocalCommunityStrip, type LocalCommunityWays } from './LocalCommunityMark';
import { CommonsInfoModal } from './CommonsInfoModal';
import type { BalanceInfo } from '../lib/api';

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
 * newest first, each with who it was with and when.
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
            note: x.what,
            when: x.amount < 0
                ? t('to {who} · {when}', { who: x.who, when: ago(x.daysAgo) })
                : t('from {who} · {when}', { who: x.who, when: ago(x.daysAgo) }),
            amount: Math.abs(x.amount),
        })),
    };
}

/**
 * The Commons in preview: the pool and an enterprise where enterprises are previewed, a Decision where Decisions are,
 * each by its own mode, so a node that turns one on loses only that one's sample (design §4).
 */
export function CommonsPreview({ enterprises = true, decisions = true, ...ways }: { enterprises?: boolean; decisions?: boolean } & LocalCommunityWays) {
    const [commonsInfo, setCommonsInfo] = useState(false);
    const e = S.enterprises[0];
    const d = S.decisions[0];
    if (!enterprises && !decisions) return null;
    return (
        <div data-testid="commons-preview">
            <LocalCommunityStrip feature={enterprises ? 'enterprises' : 'decisions'} {...ways} />
            <SampleHeader />
            {enterprises && (<>
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
            </>)}
            {decisions && (
            <section className={`${CARD} mb-4`} data-testid="sample-decision">
                <p className="text-xs font-bold uppercase tracking-wide text-nature-500 dark:text-nature-400">Decide · closes in {d.closesInDays} days</p>
                <h3 className="font-bold text-nature-900 dark:text-nature-50">{d.question}</h3>
                <p className="text-sm text-nature-600 dark:text-nature-300">{d.fromPool} Beans from the pool · {d.votesFor} for, {d.votesAgainst} against</p>
                <div className="mt-3">
                    <LocalCommunityAction feature="decisions" label="Vote" className="w-full" {...ways} />
                </div>
            </section>
            )}
            <CommonsInfoModal isOpen={commonsInfo} onClose={() => setCommonsInfo(false)} commonsBalance={S.pool} />
        </div>
    );
}

export function DealsPreview(ways: LocalCommunityWays) {
    return (
        <div data-testid="deals-preview">
            <LocalCommunityStrip feature="escrow" {...ways} />
            <SampleHeader />
            <ul className="flex flex-col gap-3">
                {S.deals.map((d) => (
                    <li key={d.id} className={CARD}>
                        <div className="flex items-start justify-between gap-3">
                            <div className="min-w-0">
                                <p className="font-bold text-nature-900 dark:text-nature-50">{d.what}</p>
                                <p className="text-xs text-nature-500 dark:text-nature-400">with {d.who} · {ago(d.daysAgo)}</p>
                            </div>
                            <span className="shrink-0 font-bold tabular-nums text-nature-800 dark:text-nature-100">{d.amount} Beans</span>
                        </div>
                        {d.status === 'waiting-on-you' ? (
                            <div className="mt-3">
                                <p className="mb-2 text-sm text-nature-600 dark:text-nature-300">The work is done: the Beans are held safely until you say so.</p>
                                <LocalCommunityAction feature="escrow" label="Approve and release" className="w-full" {...ways} />
                            </div>
                        ) : (
                            <p className="mt-2 text-sm font-semibold text-emerald-700 dark:text-emerald-400">Done: the Beans were released.</p>
                        )}
                    </li>
                ))}
            </ul>
        </div>
    );
}

/** My Deals in preview, as a dialog over the Market. */
export function DealsPreviewDialog({ onClose, ...ways }: { onClose: () => void } & LocalCommunityWays) {
    return (
        <div className="fixed inset-0 z-[150] flex items-end justify-center bg-black/50 sm:items-center" onClick={onClose}>
            <div role="dialog" aria-modal="true" aria-label="My Deals" onClick={(e) => e.stopPropagation()}
                className="max-h-[90vh] w-full max-w-lg overflow-y-auto rounded-t-2xl sm:rounded-2xl bg-white dark:bg-nature-900 p-4 shadow-xl">
                <div className="mb-3 flex items-center justify-between gap-2">
                    <h2 className="text-lg font-extrabold text-nature-900 dark:text-nature-50">🤝 My Deals</h2>
                    <button type="button" onClick={onClose} aria-label="Close" className="-mr-2 inline-flex min-h-[44px] min-w-[44px] items-center justify-center rounded-lg text-nature-500 dark:text-nature-400 hover:bg-nature-100 dark:hover:bg-nature-800 dark:hover:text-nature-200">✕</button>
                </div>
                <DealsPreview {...ways} />
            </div>
        </div>
    );
}
