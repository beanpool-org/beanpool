/**
 * Shared Offer/Need form controls reused by Web Create (pages/MapPage.tsx) and Web Edit
 * (pages/MarketplacePage.tsx): Repeatable, Cash also needed (with Need/Offer wording + nudge),
 * and Federation Reach ("Where does this travel?").
 *
 * One component per control so create and edit always carry identical copy, validation rules,
 * dark-mode tokens, and 320 px × 1.3 font wrapping.
 */
import { t, word } from '@beanpool/core';
import type { PostReach, ReachablePeer } from '../lib/api';
import { Sentence } from './Sentence';

/** Shared read-only reason lines for fields the node keeps fixed on edit. */
export const EDIT_LOCK_LINES = {
    typeFixed: word('Listing type stays as posted. To switch between Offer and Need, create a new post.'),
    priceFrozen: word('This post has a deal in progress, so its price can’t change until that deal is finished. To change the price, cancel or decline the deal first.'),
    lendableRepeatable: word('Lendable offers stay active for repeat loans.'),
    audiencePublicFixed: word('For this community. Who can see it stays as it is.'),
} as const;

export function RepeatableField({
    checked,
    onChange,
    disabled = false,
    lockNote,
    testId = 'listing-repeatable',
}: {
    checked: boolean;
    onChange: (next: boolean) => void;
    disabled?: boolean;
    lockNote?: string;
    testId?: string;
}) {
    return (
        <div className="mb-1">
            <label
                data-testid={testId}
                className={`flex items-start gap-3 text-sm font-medium text-nature-700 dark:text-nature-300 py-2 px-1 min-h-[44px] ${disabled ? 'opacity-70 cursor-not-allowed' : 'cursor-pointer'}`}
            >
                <input
                    type="checkbox"
                    checked={checked}
                    disabled={disabled}
                    onChange={e => onChange(e.target.checked)}
                    className="mt-0.5 w-5 h-5 shrink-0 rounded border-nature-300 text-bp-commit-fill focus:ring-bp-commit-fill shadow-sm accent-bp-commit-fill cursor-pointer disabled:cursor-not-allowed"
                />
                <span className="min-w-0 break-words leading-snug">
                    {t('🔁 Repeatable — keep listing active for ongoing bookings')}
                </span>
            </label>
            {lockNote && (
                <p className="m-0 ml-8 text-xs text-nature-600 dark:text-nature-400 leading-snug break-words">
                    {lockNote}
                </p>
            )}
        </div>
    );
}

/**
 * #108 Cash-also-needed toggle + Need/Offer-aware nudge.
 * No amount field by design: the app can escrow Beans, not cash, and a figure would imply it
 * settles money it never touches. On a Need the poster is the one who pays (Marty, 14 Nov 2026).
 */
export function CashAlsoNeededField({
    checked,
    onChange,
    type,
    testId = 'listing-cash-also-needed',
}: {
    checked: boolean;
    onChange: (next: boolean) => void;
    type: 'offer' | 'need';
    testId?: string;
}) {
    return (
        <div className="mb-2">
            <label
                data-testid={testId}
                className="flex items-start gap-3 text-sm font-medium text-nature-700 dark:text-nature-300 cursor-pointer py-2 px-1 min-h-[44px]"
            >
                <input
                    type="checkbox"
                    checked={checked}
                    onChange={e => onChange(e.target.checked)}
                    className="mt-0.5 w-5 h-5 shrink-0 rounded border-nature-300 text-amber-600 focus:ring-amber-500 shadow-sm accent-amber-600 cursor-pointer transition-all"
                />
                <span className="min-w-0 break-words leading-snug">
                    {type === 'need'
                        ? t("💸 I'll pay cash too — for fuel or materials")
                        : t('💸 Cash also needed — for fuel or materials')}
                </span>
            </label>
            {checked && (
                <p
                    data-testid={`${testId}-nudge`}
                    className="text-[13px] leading-snug text-amber-800 dark:text-amber-300 bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-800 rounded-xl px-3 py-2 mb-1 break-words"
                >
                    {type === 'need'
                        ? t('Cash covers fuel or materials the helper buys — at cost, not their time or tools.')
                        : (
                            <Sentence
                                text={t('Cash is for fuel and consumables you paid for — {notTools}. At cost, no markup. Agree the details in chat; the app never handles the money.')}
                                parts={{ notTools: <strong>{t('not your time, not your tools')}</strong> }}
                            />
                        )}
                </p>
            )}
        </div>
    );
}

/**
 * #143 step 4 — per-listing reach chooser ("Where does this travel?").
 * Shown only when this community actually has trading partners (`peerList.length > 0`).
 */
export function ListingReachField({
    reach,
    onReachChange,
    reachPeers,
    onReachPeersChange,
    peerList,
    labelId = 'reach-chooser-label',
    testId = 'listing-reach',
}: {
    reach: PostReach;
    onReachChange: (next: PostReach) => void;
    reachPeers: string[];
    onReachPeersChange: (next: string[]) => void;
    peerList: readonly ReachablePeer[];
    labelId?: string;
    testId?: string;
}) {
    if (peerList.length === 0) return null;

    return (
        <div className="py-2 px-1 mb-2" data-testid={testId}>
            <label id={labelId} className="block text-sm font-medium text-nature-700 dark:text-nature-300 mb-1.5">
                {t('Where does this travel?')}
            </label>
            <div className="flex flex-wrap gap-2" role="group" aria-labelledby={labelId}>
                {([
                    { value: 'local' as const, label: t('🏠 Stays here') },
                    { value: 'peers' as const, label: t('🤝 Chosen') },
                    { value: 'everywhere' as const, label: t('🌏 Everywhere') },
                ]).map(opt => (
                    <button
                        key={opt.value}
                        type="button"
                        data-testid={`${testId}-${opt.value}`}
                        onClick={() => onReachChange(opt.value)}
                        aria-pressed={reach === opt.value}
                        className={`flex-1 min-w-[5.5rem] text-xs font-medium rounded-xl px-2 py-2.5 border transition-all min-h-[44px] ${
                            reach === opt.value
                                ? 'bg-nature-700 dark:bg-nature-600 text-white border-nature-700 dark:border-nature-500 shadow-sm'
                                : 'bg-white dark:bg-nature-800 text-nature-700 dark:text-nature-300 border-nature-300 dark:border-nature-700'
                        }`}
                    >
                        {opt.label}
                    </button>
                ))}
            </div>
            {reach === 'peers' && (
                <div className="mt-2 flex flex-wrap gap-2" role="group" aria-label={t('Communities this listing is aimed at')}>
                    {peerList.map(p => {
                        const on = reachPeers.includes(p.peerId);
                        return (
                            <button
                                key={p.peerId}
                                type="button"
                                onClick={() => onReachPeersChange(on ? reachPeers.filter(x => x !== p.peerId) : [...reachPeers, p.peerId])}
                                aria-pressed={on}
                                className={`text-xs rounded-full px-3 py-2 border transition-all min-h-[44px] ${
                                    on
                                        ? 'bg-nature-700 dark:bg-nature-600 text-white border-nature-700 dark:border-nature-500'
                                        : 'bg-white dark:bg-nature-800 text-nature-700 dark:text-nature-300 border-nature-300 dark:border-nature-700'
                                }`}
                            >
                                {on ? '✓ ' : ''}{p.callsign || t('Peer {id}', { id: p.peerId.slice(-8) })}
                            </button>
                        );
                    })}
                </div>
            )}
            <p className={`text-[13px] leading-snug mt-1.5 break-words ${
                reach === 'peers' && reachPeers.length === 0
                    ? 'text-amber-600 dark:text-amber-400 font-medium'
                    : 'text-nature-500 dark:text-nature-400'
            }`}>
                {reach === 'local'
                    ? t("Stays on this community's board.")
                    : reach === 'everywhere'
                        ? t('Appears on the board of every community you trade with, and they can buy it.')
                        : reachPeers.length > 0
                            ? t('Appears on the board of the communities you ticked.')
                            : t('⚠️ Tick at least one community, or it stays here.')}
            </p>
        </div>
    );
}
