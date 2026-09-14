import { useState, useEffect, useCallback } from 'react';
import {
    getTreasury, getBalance, treasurySweep,
    treasuryApprove, treasuryReject, treasuryComplete,
    treasuryPostOffer, treasuryPostNeed,
    type BalanceInfo
} from '../lib/api';
import { type BeanPoolIdentity } from '../lib/identity';
import { resolveAvatarUrl } from '../lib/avatar';
import { MARKETPLACE_CATEGORIES } from '../lib/marketplace';

interface Props {
    identity: BeanPoolIdentity | null;
    pubkey: string;
    onBack: () => void;
    onNavigatePost?: (postId: string) => void;
}

export function TreasuryDetailPage({ identity, pubkey, onBack, onNavigatePost }: Props) {
    const [detail, setDetail] = useState<any>(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [isKeeperOfThis, setIsKeeperOfThis] = useState(false);

    // Operator Action States
    const [sweepAmount, setSweepAmount] = useState('');
    const [sweeping, setSweeping] = useState(false);
    const [actionState, setActionState] = useState<{ id: string; type: 'approve' | 'reject' | 'complete' } | null>(null);
    const [actionFeedback, setActionFeedback] = useState<{ type: 'success' | 'error'; message: string } | null>(null);

    // Post Modal State
    const [postModalMode, setPostModalMode] = useState<'offer' | 'need' | null>(null);
    const [postTitle, setPostTitle] = useState('');
    const [postCategory, setPostCategory] = useState('food');
    const [postCredits, setPostCredits] = useState('');
    const [postPriceType, setPostPriceType] = useState('fixed');
    const [postDescription, setPostDescription] = useState('');
    const [postRepeatable, setPostRepeatable] = useState(true);
    const [posting, setPosting] = useState(false);
    const [postError, setPostError] = useState<string | null>(null);

    const load = useCallback(async () => {
        try {
            setLoading(true);
            setError(null);
            const d = await getTreasury(pubkey);
            setDetail(d);

            if (identity?.publicKey) {
                const b: BalanceInfo = await getBalance(identity.publicKey);
                const mine: string[] = Array.isArray(b.keeperOf) ? b.keeperOf : [];
                setIsKeeperOfThis(mine.includes(pubkey));
            } else {
                setIsKeeperOfThis(false);
            }
        } catch (e: any) {
            setError(e.message || 'Could not load community enterprise details');
        } finally {
            setLoading(false);
        }
    }, [pubkey, identity?.publicKey]);

    useEffect(() => {
        load();
    }, [load]);

    // Keyboard ESC listener to close modal or go back
    useEffect(() => {
        const handleKeyDown = (e: KeyboardEvent) => {
            if (e.key === 'Escape') {
                if (postModalMode) {
                    setPostModalMode(null);
                } else {
                    onBack();
                }
            }
        };
        window.addEventListener('keydown', handleKeyDown);
        return () => window.removeEventListener('keydown', handleKeyDown);
    }, [postModalMode, onBack]);

    const handleSweep = async (e: React.FormEvent) => {
        e.preventDefault();
        const amt = Number(sweepAmount);
        const bal = detail?.balance ?? 0;
        if (isNaN(amt) || amt <= 0) {
            setActionFeedback({ type: 'error', message: 'Please enter a positive amount of Beans to sweep.' });
            return;
        }
        if (amt > bal) {
            setActionFeedback({ type: 'error', message: `Cannot sweep more than current surplus (${bal} 🫘).` });
            return;
        }

        try {
            setSweeping(true);
            setActionFeedback(null);
            await treasurySweep(pubkey, amt);
            setSweepAmount('');
            setActionFeedback({ type: 'success', message: `Successfully swept ${amt} 🫘 to the shared Commons pool.` });
            await load();
        } catch (e: any) {
            setActionFeedback({ type: 'error', message: e.message || 'Failed to sweep surplus to the Commons.' });
        } finally {
            setSweeping(false);
        }
    };

    const handleApproveBid = async (txId: string) => {
        try {
            setActionState({ id: txId, type: 'approve' });
            setActionFeedback(null);
            await treasuryApprove(pubkey, txId);
            setActionFeedback({ type: 'success', message: 'Bid approved! Escrow funds locked in trust.' });
            await load();
        } catch (e: any) {
            setActionFeedback({ type: 'error', message: e.message || 'Failed to approve bid.' });
        } finally {
            setActionState(null);
        }
    };

    const handleRejectBid = async (txId: string) => {
        const confirmed = window.confirm('Are you sure you want to decline this request? The member will be notified.');
        if (!confirmed) return;
        try {
            setActionState({ id: txId, type: 'reject' });
            setActionFeedback(null);
            await treasuryReject(pubkey, txId);
            setActionFeedback({ type: 'success', message: 'Bid declined.' });
            await load();
        } catch (e: any) {
            setActionFeedback({ type: 'error', message: e.message || 'Failed to decline bid.' });
        } finally {
            setActionState(null);
        }
    };

    const handleCompleteDeal = async (txId: string, postTitle?: string, credits?: number, priceType?: string, initialHours?: number) => {
        let finalHours: number | undefined;
        if (priceType && priceType !== 'fixed') {
            const input = window.prompt(`Enter hours worked for "${postTitle || 'deal'}":`, initialHours ? String(initialHours) : '1');
            if (input === null) return;
            const parsed = Number(input);
            if (isNaN(parsed) || parsed <= 0) {
                alert('Please enter a valid positive number of hours.');
                return;
            }
            finalHours = parsed;
        } else {
            const confirmed = window.confirm(`Release payment of ${credits ?? ''} 🫘 for "${postTitle || 'deal'}"? This action cannot be reversed.`);
            if (!confirmed) return;
        }
        try {
            setActionState({ id: txId, type: 'complete' });
            setActionFeedback(null);
            await treasuryComplete(pubkey, txId, finalHours);
            setActionFeedback({ type: 'success', message: 'Payment released! Worker has been paid.' });
            await load();
        } catch (e: any) {
            setActionFeedback({ type: 'error', message: e.message || 'Failed to release payment.' });
        } finally {
            setActionState(null);
        }
    };

    const handleCreatePost = async (e: React.FormEvent) => {
        e.preventDefault();
        const creditsNum = Number(postCredits);
        if (!postTitle.trim()) {
            setPostError('Title is required');
            return;
        }
        if (isNaN(creditsNum) || creditsNum <= 0) {
            setPostError('Please enter a valid credit amount');
            return;
        }

        try {
            setPosting(true);
            setPostError(null);
            if (postModalMode === 'offer') {
                await treasuryPostOffer(pubkey, {
                    title: postTitle.trim(),
                    category: postCategory,
                    credits: creditsNum,
                    priceType: postPriceType,
                    description: postDescription.trim() || undefined,
                    repeatable: postRepeatable,
                });
            } else {
                await treasuryPostNeed(pubkey, {
                    title: postTitle.trim(),
                    category: postCategory,
                    credits: creditsNum,
                    priceType: postPriceType,
                    description: postDescription.trim() || undefined,
                });
            }
            setPostModalMode(null);
            setPostTitle('');
            setPostDescription('');
            setPostCredits('');
            setActionFeedback({
                type: 'success',
                message: `${postModalMode === 'offer' ? 'Offer' : 'Need'} posted on behalf of enterprise.`
            });
            await load();
        } catch (e: any) {
            setPostError(e.message || `Failed to post ${postModalMode}.`);
        } finally {
            setPosting(false);
        }
    };

    const formatTimestamp = (ts: any) => {
        try {
            const d = new Date(typeof ts === 'number' ? ts : String(ts));
            if (isNaN(d.getTime())) return '';
            return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) + ', ' +
                d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
        } catch {
            return '';
        }
    };

    const balance = detail?.balance ?? 0;
    const name = detail?.name || 'Community Treasury';
    const avatarUrl = resolveAvatarUrl(detail?.avatar);
    const pendingBids: any[] = detail?.pendingBids || [];
    const activeDeals: any[] = detail?.activeDeals || [];
    const posts: any[] = detail?.posts || [];
    const flow: any[] = detail?.flow || [];
    const keepers: any[] = detail?.keepers || [];

    return (
        <div className="fixed inset-0 bg-nature-100 dark:bg-black z-50 overflow-y-auto animate-in slide-in-from-bottom-4 duration-300">
            {/* Header */}
            <div className="sticky top-0 bg-nature-100/90 dark:bg-black/90 backdrop-blur-md border-b border-nature-200 dark:border-nature-800 p-4 flex items-center justify-between z-10">
                <button
                    onClick={onBack}
                    className="text-nature-600 dark:text-nature-400 font-bold hover:text-nature-900 dark:hover:text-white transition-colors bg-transparent border-none cursor-pointer flex items-center gap-1.5"
                    aria-label="Go back"
                >
                    <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
                    </svg>
                    Back
                </button>
                <div className="font-extrabold text-nature-900 dark:text-white text-base sm:text-lg truncate max-w-[200px] sm:max-w-md">
                    {name}
                </div>
                <div className="w-12" />
            </div>

            <div className="max-w-2xl mx-auto p-4 sm:p-6 space-y-6 pb-24">
                {loading ? (
                    <div className="py-20 text-center text-nature-500 font-medium">Loading treasury details…</div>
                ) : error ? (
                    <div className="p-6 rounded-2xl bg-red-50 dark:bg-red-950/30 border border-red-200 dark:border-red-900 text-red-600 dark:text-red-400 text-center">
                        <p className="font-bold mb-2">Error loading treasury</p>
                        <p className="text-sm">{error}</p>
                        <button
                            onClick={load}
                            className="mt-4 px-4 py-2 bg-red-600 text-white font-bold rounded-xl text-sm"
                        >
                            Retry
                        </button>
                    </div>
                ) : !detail ? (
                    <div className="py-20 text-center text-nature-500">Treasury not found.</div>
                ) : (
                    <>
                        {/* Identity Banner */}
                        <div className="flex items-center gap-4 bg-white dark:bg-nature-900 border border-nature-200 dark:border-nature-800 rounded-2xl p-5 shadow-sm">
                            {avatarUrl ? (
                                <img
                                    src={avatarUrl}
                                    alt={name}
                                    className="w-16 h-16 rounded-full object-cover border-2 border-emerald-500/40"
                                />
                            ) : (
                                <div className="w-16 h-16 rounded-full bg-nature-100 dark:bg-nature-800 flex items-center justify-center text-3xl border border-nature-200 dark:border-nature-700">
                                    🏛️
                                </div>
                            )}
                            <div className="flex-1 min-w-0">
                                <h1 className="text-xl sm:text-2xl font-black text-nature-900 dark:text-white truncate">
                                    {name}
                                </h1>
                                <p className="text-xs sm:text-sm text-nature-500 dark:text-nature-400 mt-0.5">
                                    Community enterprise · run by the Commons
                                </p>
                            </div>
                        </div>

                        {/* Balance Card */}
                        <div className="bg-white dark:bg-nature-900 border border-nature-200 dark:border-nature-800 rounded-2xl p-6 shadow-sm">
                            <div className="text-xs font-bold uppercase tracking-wider text-nature-500 dark:text-nature-400">
                                Enterprise Balance
                            </div>
                            <div className={`text-4xl font-black mt-2 ${balance < 0 ? 'text-amber-500 dark:text-amber-400' : 'text-emerald-600 dark:text-emerald-400'}`}>
                                {balance} 🫘
                            </div>

                            {balance < 0 && (
                                <div
                                    role="alert"
                                    aria-live="polite"
                                    className="mt-3 p-3 rounded-xl bg-amber-50 dark:bg-amber-950/30 border border-amber-300 dark:border-amber-800 text-amber-800 dark:text-amber-300 text-xs font-semibold leading-relaxed"
                                >
                                    ⚠️ In Deficit: This enterprise is currently in deficit ({balance} 🫘). Credit buys inputs and supplies, but keepers can only be paid from profit. Keepers cannot be paid while the enterprise is in deficit.
                                </div>
                            )}

                            <div className="grid grid-cols-2 gap-3 mt-5 pt-5 border-t border-nature-100 dark:border-nature-800">
                                <div className="bg-nature-50 dark:bg-nature-800/50 rounded-xl p-3 border border-nature-200/60 dark:border-nature-700/50">
                                    <div className="text-[11px] font-bold uppercase tracking-wide text-nature-500 dark:text-nature-400">
                                        Credit Line
                                    </div>
                                    <div className="text-lg font-extrabold text-nature-900 dark:text-white mt-1">
                                        {detail.creditLine ?? 0} 🫘
                                    </div>
                                </div>
                                <div className="bg-nature-50 dark:bg-nature-800/50 rounded-xl p-3 border border-nature-200/60 dark:border-nature-700/50">
                                    <div className="text-[11px] font-bold uppercase tracking-wide text-nature-500 dark:text-nature-400">
                                        Live Offers
                                    </div>
                                    <div className="text-lg font-extrabold text-nature-900 dark:text-white mt-1">
                                        {detail.liveOffers ?? 0}
                                    </div>
                                </div>
                                <div className="bg-nature-50 dark:bg-nature-800/50 rounded-xl p-3 border border-nature-200/60 dark:border-nature-700/50">
                                    <div className="text-[11px] font-bold uppercase tracking-wide text-nature-500 dark:text-nature-400">
                                        Earned Surplus
                                    </div>
                                    <div className="text-lg font-extrabold text-nature-900 dark:text-white mt-1">
                                        {detail.earnedSurplus ?? 0} 🫘
                                    </div>
                                </div>
                                <div className="bg-nature-50 dark:bg-nature-800/50 rounded-xl p-3 border border-nature-200/60 dark:border-nature-700/50">
                                    <div className="text-[11px] font-bold uppercase tracking-wide text-nature-500 dark:text-nature-400">
                                        Capital Ceiling
                                    </div>
                                    <div className="text-lg font-extrabold text-nature-900 dark:text-white mt-1">
                                        {detail.workingCapitalCeiling != null ? `${detail.workingCapitalCeiling} 🫘` : 'Uncapped'}
                                    </div>
                                </div>
                            </div>
                        </div>

                        {/* Action feedback alert */}
                        {actionFeedback && (
                            <div className={`p-4 rounded-xl text-sm font-semibold flex items-center justify-between border ${
                                actionFeedback.type === 'success'
                                    ? 'bg-emerald-50 dark:bg-emerald-950/30 text-emerald-800 dark:text-emerald-300 border-emerald-300 dark:border-emerald-800'
                                    : 'bg-red-50 dark:bg-red-950/30 text-red-800 dark:text-red-300 border-red-300 dark:border-red-800'
                            }`}>
                                <span>{actionFeedback.message}</span>
                                <button
                                    onClick={() => setActionFeedback(null)}
                                    className="text-xs opacity-70 hover:opacity-100 font-bold ml-2"
                                >
                                    Dismiss
                                </button>
                            </div>
                        )}

                        {/* Operator Controls Panel */}
                        {isKeeperOfThis && (
                            <div className="bg-emerald-50/40 dark:bg-emerald-950/20 border-2 border-emerald-500/40 rounded-2xl p-5 space-y-5 shadow-sm">
                                <div className="flex items-center gap-2">
                                    <span className="text-lg" aria-hidden="true">🛡️</span>
                                    <div className="text-xs font-black uppercase tracking-widest text-emerald-700 dark:text-emerald-400">
                                        Operator Controls
                                    </div>
                                </div>

                                <div className="grid grid-cols-2 gap-3">
                                    <button
                                        type="button"
                                        onClick={() => {
                                            setPostModalMode('offer');
                                            setPostRepeatable(true);
                                            setPostError(null);
                                        }}
                                        className="py-3 px-4 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-white font-bold text-sm shadow-sm transition-all active:scale-95 flex items-center justify-center gap-2"
                                    >
                                        <span>🏷️</span> Post Offer
                                    </button>
                                    <button
                                        type="button"
                                        onClick={() => {
                                            setPostModalMode('need');
                                            setPostRepeatable(false);
                                            setPostError(null);
                                        }}
                                        className="py-3 px-4 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-white font-bold text-sm shadow-sm transition-all active:scale-95 flex items-center justify-center gap-2"
                                    >
                                        <span>🤝</span> Post Need
                                    </button>
                                </div>

                                {/* Sweep Surplus */}
                                <form onSubmit={handleSweep} className="flex gap-2 items-center pt-2">
                                    <input
                                        type="number"
                                        min="1"
                                        step="1"
                                        placeholder="Sweep surplus…"
                                        value={sweepAmount}
                                        onChange={(e) => setSweepAmount(e.target.value)}
                                        className="flex-1 bg-white dark:bg-nature-900 border border-nature-300 dark:border-nature-700 rounded-xl px-4 py-2.5 text-sm font-bold text-nature-900 dark:text-white placeholder-nature-400 focus:outline-none focus:ring-2 focus:ring-emerald-500"
                                    />
                                    <button
                                        type="submit"
                                        disabled={sweeping || balance <= 0 || !sweepAmount}
                                        className="py-2.5 px-4 rounded-xl border border-emerald-600 dark:border-emerald-500 bg-white dark:bg-nature-900 text-emerald-700 dark:text-emerald-400 font-extrabold text-sm disabled:opacity-40 hover:bg-emerald-50 dark:hover:bg-emerald-950/40 transition-colors shrink-0"
                                    >
                                        {sweeping ? 'Sweeping…' : 'To Commons 🌱'}
                                    </button>
                                </form>

                                {/* Pending Bids on Needs */}
                                {pendingBids.length > 0 && (
                                    <div className="pt-4 border-t border-emerald-500/20 space-y-3">
                                        <div className="text-xs font-black uppercase tracking-wider text-emerald-800 dark:text-emerald-400 flex items-center justify-between">
                                            <span>Pending Bids on Needs</span>
                                            <span className="bg-emerald-200/60 dark:bg-emerald-900/60 text-emerald-900 dark:text-emerald-200 px-2 py-0.5 rounded-full text-[11px]">
                                                {pendingBids.length}
                                            </span>
                                        </div>
                                        <div className="space-y-2">
                                            {pendingBids.map((b) => (
                                                <div
                                                    key={b.id}
                                                    className="bg-white dark:bg-nature-900 border border-nature-200 dark:border-nature-800 rounded-xl p-3.5 space-y-2.5 shadow-sm"
                                                >
                                                    <div className="flex justify-between items-start gap-2">
                                                        <div className="font-bold text-sm text-nature-900 dark:text-white leading-snug">
                                                            {b.post_title}
                                                        </div>
                                                        <span className="text-emerald-600 dark:text-emerald-400 font-black text-sm shrink-0">
                                                            {b.credits} 🫘
                                                        </span>
                                                    </div>
                                                    <div className="text-xs text-nature-500 dark:text-nature-400">
                                                        Bidder: <strong className="text-nature-800 dark:text-nature-200">{b.peer_callsign || 'Member'}</strong>
                                                    </div>
                                                    <div className="flex gap-2 pt-1">
                                                        <button
                                                            type="button"
                                                            disabled={actionState?.id === b.id}
                                                            onClick={() => handleApproveBid(b.id)}
                                                            className="flex-1 min-h-[44px] py-2 px-3 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white font-bold text-xs shadow-sm transition-all disabled:opacity-50 flex items-center justify-center"
                                                        >
                                                            {actionState?.id === b.id && actionState?.type === 'approve' ? 'Approving…' : `Approve Bid (${b.credits} 🫘)`}
                                                        </button>
                                                        <button
                                                            type="button"
                                                            disabled={actionState?.id === b.id}
                                                            onClick={() => handleRejectBid(b.id)}
                                                            className="min-h-[44px] py-2 px-3 rounded-lg border border-red-300 dark:border-red-800/80 bg-red-50 dark:bg-red-950/30 text-red-600 dark:text-red-400 font-bold text-xs hover:bg-red-100 dark:hover:bg-red-900/30 transition-colors disabled:opacity-50 flex items-center justify-center"
                                                        >
                                                            {actionState?.id === b.id && actionState?.type === 'reject' ? 'Declining…' : 'Decline'}
                                                        </button>
                                                    </div>
                                                </div>
                                            ))}
                                        </div>
                                    </div>
                                )}

                                {/* Active Deals */}
                                {activeDeals.length > 0 && (
                                    <div className="pt-4 border-t border-emerald-500/20 space-y-3">
                                        <div className="text-xs font-black uppercase tracking-wider text-emerald-800 dark:text-emerald-400 flex items-center justify-between">
                                            <span>Active Deals</span>
                                            <span className="bg-emerald-200/60 dark:bg-emerald-900/60 text-emerald-900 dark:text-emerald-200 px-2 py-0.5 rounded-full text-[11px]">
                                                {activeDeals.length}
                                            </span>
                                        </div>
                                        <div className="space-y-2">
                                            {activeDeals.map((d) => (
                                                <div
                                                    key={d.id}
                                                    className="bg-white dark:bg-nature-900 border border-nature-200 dark:border-nature-800 rounded-xl p-3.5 space-y-2.5 shadow-sm"
                                                >
                                                    <div className="flex justify-between items-start gap-2">
                                                        <div className="font-bold text-sm text-nature-900 dark:text-white leading-snug">
                                                            {d.post_title}
                                                        </div>
                                                        <span className="text-emerald-600 dark:text-emerald-400 font-black text-sm shrink-0">
                                                            {d.credits} 🫘 in escrow
                                                        </span>
                                                    </div>
                                                    <div className="text-xs text-nature-500 dark:text-nature-400">
                                                        {d.action_required === 'fulfill' ? 'Customer' : 'Worker'}: <strong className="text-nature-800 dark:text-nature-200">{d.peer_callsign || 'Member'}</strong>
                                                    </div>
                                                    <div className="pt-1">
                                                        {d.action_required === 'fulfill' ? (
                                                            <div
                                                                onClick={() => onNavigatePost?.(d.post_id)}
                                                                className="w-full min-h-[44px] py-2.5 px-4 rounded-lg bg-nature-100 dark:bg-nature-800 text-nature-700 dark:text-nature-300 font-bold text-xs text-center flex items-center justify-center cursor-pointer hover:bg-nature-200 dark:hover:bg-nature-700 transition-colors"
                                                            >
                                                                Fulfill Deal · Awaiting Customer Release
                                                            </div>
                                                        ) : (
                                                            <button
                                                                type="button"
                                                                disabled={actionState?.id === d.id}
                                                                onClick={() => handleCompleteDeal(d.id, d.post_title, d.credits, d.price_type, d.hours)}
                                                                className="w-full min-h-[44px] py-2.5 px-4 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white font-extrabold text-xs shadow-sm transition-all disabled:opacity-50 flex items-center justify-center"
                                                            >
                                                                {actionState?.id === d.id && actionState?.type === 'complete' ? 'Releasing…' : `Release Payment (${d.credits} 🫘)`}
                                                            </button>
                                                        )}
                                                    </div>
                                                </div>
                                            ))}
                                        </div>
                                    </div>
                                )}
                            </div>
                        )}

                        {/* Keepers transparency */}
                        {keepers.length > 0 && (
                            <div className="bg-white dark:bg-nature-900 border border-nature-200 dark:border-nature-800 rounded-2xl p-5 shadow-sm space-y-3">
                                <div className="text-xs font-bold uppercase tracking-wider text-nature-500 dark:text-nature-400">
                                    Accountable Keepers ({keepers.length})
                                </div>
                                <div className="flex flex-wrap gap-2">
                                    {keepers.map((k: any) => (
                                        <div
                                            key={k.publicKey}
                                            className="inline-flex items-center gap-2 px-3 py-1.5 rounded-xl bg-nature-50 dark:bg-nature-800 border border-nature-200 dark:border-nature-700 text-xs font-semibold text-nature-800 dark:text-nature-200"
                                        >
                                            <span aria-hidden="true">👤</span>
                                            <span>{k.callsign}</span>
                                        </div>
                                    ))}
                                </div>
                            </div>
                        )}

                        {/* Enterprise Listings */}
                        <div className="bg-white dark:bg-nature-900 border border-nature-200 dark:border-nature-800 rounded-2xl p-5 shadow-sm space-y-3">
                            <div className="text-xs font-bold uppercase tracking-wider text-nature-500 dark:text-nature-400">
                                Enterprise Listings ({posts.length})
                            </div>
                            {posts.length === 0 ? (
                                <p className="text-xs text-nature-400 italic py-2">No listings posted yet.</p>
                            ) : (
                                <div className="divide-y divide-nature-100 dark:divide-nature-800">
                                    {posts.map((post: any) => (
                                        <div
                                            key={post.id}
                                            onClick={() => onNavigatePost?.(post.id)}
                                            className={`py-3 flex items-start justify-between gap-3 ${onNavigatePost ? 'cursor-pointer hover:bg-nature-50 dark:hover:bg-nature-800/40 rounded-lg px-2 -mx-2 transition-colors' : ''}`}
                                        >
                                            <div className="min-w-0 flex-1">
                                                <div className="flex items-center gap-1.5 mb-1">
                                                    <span className={`text-[10px] font-black uppercase px-2 py-0.5 rounded-md ${
                                                        post.type === 'offer'
                                                            ? 'bg-emerald-100 dark:bg-emerald-950/50 text-emerald-800 dark:text-emerald-300'
                                                            : 'bg-nature-100 dark:bg-nature-800 text-nature-700 dark:text-nature-300'
                                                    }`}>
                                                        {post.type}
                                                    </span>
                                                    {post.repeatable && (
                                                        <span className="text-[10px] text-nature-400 font-semibold">🔄 recurring</span>
                                                    )}
                                                </div>
                                                <div className="font-bold text-sm text-nature-900 dark:text-white truncate">
                                                    {post.title}
                                                </div>
                                                {post.description && (
                                                    <p className="text-xs text-nature-500 dark:text-nature-400 line-clamp-1 mt-0.5">
                                                        {post.description}
                                                    </p>
                                                )}
                                            </div>
                                            <div className="text-right shrink-0">
                                                <div className="text-sm font-black text-emerald-600 dark:text-emerald-400">
                                                    {post.credits} 🫘
                                                </div>
                                                {post.price_type && post.price_type !== 'fixed' && (
                                                    <div className="text-[10px] text-nature-400">/{post.price_type}</div>
                                                )}
                                            </div>
                                        </div>
                                    ))}
                                </div>
                            )}
                        </div>

                        {/* Recent Activity Flow */}
                        <div className="bg-white dark:bg-nature-900 border border-nature-200 dark:border-nature-800 rounded-2xl p-5 shadow-sm space-y-3">
                            <div className="text-xs font-bold uppercase tracking-wider text-nature-500 dark:text-nature-400">
                                Recent Activity
                            </div>
                            {flow.length === 0 ? (
                                <p className="text-xs text-nature-400 italic py-2">No recent activity.</p>
                            ) : (
                                <div className="divide-y divide-nature-100 dark:divide-nature-800">
                                    {flow.map((tx: any, idx: number) => {
                                        const isOut = !tx.incoming;
                                        return (
                                            <div key={tx.id || `${tx.timestamp}-${idx}`} className="py-2.5 flex items-center justify-between gap-3 text-xs">
                                                <div className="min-w-0 flex-1">
                                                    <div className="font-semibold text-nature-800 dark:text-nature-200 truncate">
                                                        {tx.memo || 'Transfer'}
                                                    </div>
                                                    <div className="text-[11px] text-nature-400 mt-0.5">
                                                        {formatTimestamp(tx.timestamp)}
                                                    </div>
                                                </div>
                                                <div className={`font-black text-sm shrink-0 ${isOut ? 'text-amber-500' : 'text-emerald-500'}`}>
                                                    {isOut ? '-' : '+'}{tx.amount} 🫘
                                                </div>
                                            </div>
                                        );
                                    })}
                                </div>
                            )}
                        </div>
                    </>
                )}
            </div>

            {/* Post Offer / Need Modal */}
            {postModalMode && (
                <div
                    className="fixed inset-0 bg-black/60 backdrop-blur-sm z-50 flex items-center justify-center p-4"
                    onClick={() => setPostModalMode(null)}
                >
                    <div
                        role="dialog"
                        aria-modal="true"
                        aria-labelledby="post-modal-title"
                        onClick={(e) => e.stopPropagation()}
                        className="bg-white dark:bg-nature-900 border border-nature-200 dark:border-nature-800 rounded-2xl p-6 w-full max-w-md shadow-xl space-y-4 animate-in zoom-in-95 duration-200"
                    >
                        <div className="flex justify-between items-center">
                            <h2 id="post-modal-title" className="text-lg font-black text-nature-900 dark:text-white">
                                {postModalMode === 'offer' ? 'Post Enterprise Offer' : 'Post Enterprise Need'}
                            </h2>
                            <button
                                type="button"
                                aria-label="Close dialog"
                                onClick={() => setPostModalMode(null)}
                                className="text-nature-400 hover:text-nature-600 dark:hover:text-nature-200 text-lg font-bold min-w-[44px] min-h-[44px] flex items-center justify-center -mr-2"
                            >
                                ✕
                            </button>
                        </div>

                        {postError && (
                            <div className="p-3 bg-red-50 dark:bg-red-950/30 border border-red-200 dark:border-red-900 text-red-600 dark:text-red-400 rounded-xl text-xs font-semibold">
                                {postError}
                            </div>
                        )}

                        <form onSubmit={handleCreatePost} className="space-y-4">
                            <div>
                                <label className="block text-xs font-bold text-nature-600 dark:text-nature-400 uppercase tracking-wider mb-1">
                                    Title
                                </label>
                                <input
                                    type="text"
                                    required
                                    placeholder={postModalMode === 'offer' ? 'e.g. Dozen fresh eggs' : 'e.g. Tend the chicken coop'}
                                    value={postTitle}
                                    onChange={(e) => setPostTitle(e.target.value)}
                                    className="w-full bg-nature-50 dark:bg-nature-800 border border-nature-200 dark:border-nature-700 rounded-xl px-3 py-2 text-sm text-nature-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-emerald-500"
                                />
                            </div>

                            <div className="grid grid-cols-2 gap-3">
                                <div>
                                    <label className="block text-xs font-bold text-nature-600 dark:text-nature-400 uppercase tracking-wider mb-1">
                                        Category
                                    </label>
                                    <select
                                        value={postCategory}
                                        onChange={(e) => setPostCategory(e.target.value)}
                                        className="w-full bg-nature-50 dark:bg-nature-800 border border-nature-200 dark:border-nature-700 rounded-xl px-3 py-2 text-sm text-nature-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-emerald-500"
                                    >
                                        {MARKETPLACE_CATEGORIES.map((c) => (
                                            <option key={c.id} value={c.id}>
                                                {c.emoji} {c.label}
                                            </option>
                                        ))}
                                    </select>
                                </div>
                                <div>
                                    <label className="block text-xs font-bold text-nature-600 dark:text-nature-400 uppercase tracking-wider mb-1">
                                        Price Type
                                    </label>
                                    <select
                                        value={postPriceType}
                                        onChange={(e) => setPostPriceType(e.target.value)}
                                        className="w-full bg-nature-50 dark:bg-nature-800 border border-nature-200 dark:border-nature-700 rounded-xl px-3 py-2 text-sm text-nature-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-emerald-500"
                                    >
                                        <option value="fixed">Fixed Total</option>
                                        <option value="hourly">Hourly (/hr)</option>
                                    </select>
                                </div>
                            </div>

                            <div>
                                <label className="block text-xs font-bold text-nature-600 dark:text-nature-400 uppercase tracking-wider mb-1">
                                    Credits (🫘 Beans)
                                </label>
                                <input
                                    type="number"
                                    min="1"
                                    step="1"
                                    required
                                    placeholder="20"
                                    value={postCredits}
                                    onChange={(e) => setPostCredits(e.target.value)}
                                    className="w-full bg-nature-50 dark:bg-nature-800 border border-nature-200 dark:border-nature-700 rounded-xl px-3 py-2 text-sm text-nature-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-emerald-500"
                                />
                            </div>

                            <div>
                                <label className="block text-xs font-bold text-nature-600 dark:text-nature-400 uppercase tracking-wider mb-1">
                                    Description (optional)
                                </label>
                                <textarea
                                    rows={3}
                                    placeholder="Describe the offer or need..."
                                    value={postDescription}
                                    onChange={(e) => setPostDescription(e.target.value)}
                                    className="w-full bg-nature-50 dark:bg-nature-800 border border-nature-200 dark:border-nature-700 rounded-xl px-3 py-2 text-sm text-nature-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-emerald-500"
                                />
                            </div>

                            {postModalMode === 'offer' && (
                                <label className="flex items-center gap-2 cursor-pointer pt-1">
                                    <input
                                        type="checkbox"
                                        checked={postRepeatable}
                                        onChange={(e) => setPostRepeatable(e.target.checked)}
                                        className="w-4 h-4 rounded text-emerald-600 focus:ring-emerald-500 border-nature-300"
                                    />
                                    <span className="text-xs font-semibold text-nature-700 dark:text-nature-300">
                                        Recurring listing (stays active after purchase)
                                    </span>
                                </label>
                            )}

                            <div className="flex gap-3 pt-3">
                                <button
                                    type="button"
                                    onClick={() => setPostModalMode(null)}
                                    className="flex-1 py-2.5 rounded-xl border border-nature-300 dark:border-nature-700 text-nature-700 dark:text-nature-300 font-bold text-sm hover:bg-nature-50 dark:hover:bg-nature-800"
                                >
                                    Cancel
                                </button>
                                <button
                                    type="submit"
                                    disabled={posting}
                                    className="flex-1 py-2.5 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-white font-bold text-sm disabled:opacity-50"
                                >
                                    {posting ? 'Posting…' : 'Publish Listing'}
                                </button>
                            </div>
                        </form>
                    </div>
                </div>
            )}
        </div>
    );
}
