/**
 * The preview mode of the Ledger, the Commons' enterprises and Decide, and My Deals (scratch/global-node/
 * DESIGN-global-showcase-fable.md §1 rows 3, 5, 6; §2): the member's screen drawn from Example Valley, the sample
 * community in @beanpool/core, under the 🏘️ Local community strip. The ONLY web file that imports the sample.
 *
 * - **Nothing here talks to the node.** No fetch, no write: the sample is bundled, and every action that would move
 *   Beans, vote or pledge is a marker action that opens the sheet. The explainers stay live (CommonsInfoModal).
 * - **Obviously a sample.** The Example chip and dashed cards; nobody is named ("a neighbour").
 * - **Levels are merit badges**, never shown as locked; currency is Beans.
 */

import { useState } from 'react';
import { SAMPLE_COMMUNITY, LOCAL_COMMUNITY_STRIP, type SampleTransaction } from '@beanpool/core';
import { LocalCommunityAction, LocalCommunityPill, LocalCommunityStrip, type LocalCommunityWays } from './LocalCommunityMark';
import { CommonsInfoModal } from './CommonsInfoModal';

const S = SAMPLE_COMMUNITY;

const CARD = 'rounded-2xl border-2 border-dashed border-nature-300 dark:border-nature-600 bg-nature-50 dark:bg-nature-950 p-4';

function beans(n: number): string {
    const abs = Math.abs(n);
    const s = Number.isInteger(abs) ? String(abs) : abs.toFixed(1);
    return `${n < 0 ? '−' : n > 0 ? '+' : ''}${s} Beans`;
}

function ago(days: number): string {
    return days === 1 ? 'yesterday' : `${days} days ago`;
}

function ExampleChip() {
    return (
        <span className="inline-flex shrink-0 items-center rounded-full border border-dashed border-nature-400 dark:border-nature-500 px-2 py-0.5 text-[11px] font-black uppercase text-nature-600 dark:text-nature-300">
            Example
        </span>
    );
}

/** "Example Valley · an example member", with the Example chip. */
function SampleHeader() {
    return (
        <div className="mb-3 flex flex-wrap items-center gap-2" data-testid="sample-header">
            <ExampleChip />
            <span className="min-w-0 text-sm font-bold text-nature-700 dark:text-nature-200">{LOCAL_COMMUNITY_STRIP.header}</span>
        </div>
    );
}

function TxRow({ t }: { t: SampleTransaction }) {
    return (
        <li className="flex items-center justify-between gap-3 py-2.5">
            <div className="min-w-0">
                <p className="truncate font-semibold text-nature-900 dark:text-nature-50">{t.what}</p>
                <p className="text-xs text-nature-500 dark:text-nature-400">{t.amount >= 0 ? 'from' : 'to'} {t.who} · {ago(t.daysAgo)}</p>
            </div>
            <span className={`shrink-0 font-bold tabular-nums ${t.amount >= 0 ? 'text-emerald-700 dark:text-emerald-400' : 'text-nature-700 dark:text-nature-200'}`}>{beans(t.amount)}</span>
        </li>
    );
}

export function LedgerPreview(ways: LocalCommunityWays) {
    const [commonsInfo, setCommonsInfo] = useState(false);
    return (
        <div className="mx-auto max-w-2xl p-4" data-testid="ledger-preview">
            <LocalCommunityStrip feature="beans" {...ways} />
            <SampleHeader />
            <section className={`${CARD} mb-4`}>
                <p className="text-xs font-bold uppercase tracking-wide text-nature-500 dark:text-nature-400">Balance</p>
                <p className="text-3xl font-black text-nature-900 dark:text-nature-50" data-testid="sample-balance">{S.balance} Beans</p>
                <p className="mt-1 text-sm text-nature-600 dark:text-nature-300">
                    Room to spend: <strong>{S.roomToSpend} Beans</strong>, down to {beans(S.floor).replace('+', '')}. One live Offer keeps the credit line open.
                </p>
                <p className="mt-1 text-sm text-nature-600 dark:text-nature-300">A rough guide here: about {S.beansPerHour} Beans an hour of help.</p>
                <div className="mt-3 flex flex-col gap-2 sm:flex-row">
                    <LocalCommunityAction feature="beans" label="Send Beans" className="w-full" {...ways} />
                    <LocalCommunityAction feature="beans" label="Export" className="w-full" {...ways} />
                </div>
            </section>
            <section className={`${CARD} mb-4`}>
                <p className="text-xs font-bold uppercase tracking-wide text-nature-500 dark:text-nature-400">Level</p>
                <p className="font-bold text-nature-900 dark:text-nature-50">Level {S.level} of {S.levels}</p>
                <p className="text-sm text-nature-600 dark:text-nature-300">Levels are badges for trading with many neighbours. They open nothing and close nothing.</p>
            </section>
            <section className={`${CARD} mb-4`}>
                <div className="mb-1 flex flex-wrap items-center justify-between gap-x-2 gap-y-1">
                    <h3 className="font-bold text-nature-900 dark:text-nature-50">Transactions</h3>
                    <button type="button" onClick={() => setCommonsInfo(true)} className="shrink-0 text-sm font-semibold text-blue-700 dark:text-blue-300" aria-label="How the Commons and the circulation fee work">ⓘ The Commons</button>
                </div>
                <ul className="divide-y divide-nature-200 dark:divide-nature-800" data-testid="sample-transactions">
                    {S.transactions.map((t) => <TxRow key={t.id} t={t} />)}
                </ul>
            </section>
            <CommonsInfoModal isOpen={commonsInfo} onClose={() => setCommonsInfo(false)} commonsBalance={S.pool} />
        </div>
    );
}

export function CommonsPreview(ways: LocalCommunityWays) {
    const [commonsInfo, setCommonsInfo] = useState(false);
    const e = S.enterprises[0];
    const d = S.decisions[0];
    return (
        <div data-testid="commons-preview">
            <LocalCommunityStrip feature="enterprises" {...ways} />
            <SampleHeader />
            <section className={`${CARD} mb-4`}>
                <div className="flex items-center justify-between gap-2">
                    <p className="text-xs font-bold uppercase tracking-wide text-nature-500 dark:text-nature-400">Commons pool</p>
                    <button type="button" onClick={() => setCommonsInfo(true)} className="shrink-0 text-sm font-semibold text-blue-700 dark:text-blue-300" aria-label="How the Commons works">ⓘ</button>
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
            <section className={`${CARD} mb-4`} data-testid="sample-decision">
                <p className="text-xs font-bold uppercase tracking-wide text-nature-500 dark:text-nature-400">Decide · closes in {d.closesInDays} days</p>
                <h3 className="font-bold text-nature-900 dark:text-nature-50">{d.question}</h3>
                <p className="text-sm text-nature-600 dark:text-nature-300">{d.fromPool} Beans from the pool · {d.votesFor} for, {d.votesAgainst} against</p>
                <div className="mt-3">
                    <LocalCommunityAction feature="decisions" label="Vote" className="w-full" {...ways} />
                </div>
            </section>
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
                    <button type="button" onClick={onClose} aria-label="Close" className="rounded-lg px-2 py-1 text-nature-500 dark:text-nature-400 hover:bg-nature-100 dark:hover:bg-nature-800">✕</button>
                </div>
                <DealsPreview {...ways} />
            </div>
        </div>
    );
}
