import React, { useState, useEffect } from 'react';
import type { NodeProfile } from '../../lib/profiles';
import {
    fetchEscrowDisputes,
    resolveEscrowDisputeApi,
    formatResolverName,
    type EscrowDisputeItem,
} from '../../lib/node-client';
import { useTimeout } from '../../lib/use-timeout';
import { ModalBackdrop } from '../common/ModalBackdrop';

interface EscrowDisputesPanelProps {
    activeNode: NodeProfile;
    tfaToken?: string;
    onRefresh?: () => void;
}

export function EscrowDisputesPanel({
    activeNode,
    tfaToken,
    onRefresh,
}: EscrowDisputesPanelProps) {
    const [disputes, setDisputes] = useState<EscrowDisputeItem[]>([]);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [minDays, setMinDays] = useState<number>(7);
    const [filterStatus, setFilterStatus] = useState<'pending' | 'resolved' | 'all'>('pending');
    const [page, setPage] = useState<number>(0);
    const [totalCount, setTotalCount] = useState<number>(0);
    // Tab counts as the server reports them; null when the server predates `counts`.
    const [tabCounts, setTabCounts] = useState<{ pending: number; resolved: number; all: number } | null>(null);
    const PAGE_SIZE = 50;

    // Resolution modal state
    const [selectedDispute, setSelectedDispute] = useState<EscrowDisputeItem | null>(null);
    const [selectedAction, setSelectedAction] = useState<'release_to_seller' | 'refund_to_buyer' | 'split' | null>(null);
    const [reason, setReason] = useState<string>('');
    const [resolving, setResolving] = useState(false);
    const autoCloseTimer = useTimeout();
    const [actionFeedback, setActionFeedback] = useState<{ type: 'success' | 'error'; message: string } | null>(null);

    // Collapsible chat context map
    const [expandedChat, setExpandedChat] = useState<Record<string, boolean>>({});

    const loadDisputes = async () => {
        if (!activeNode?.url) return;
        setLoading(true);
        setError(null);
        try {
            const data = await fetchEscrowDisputes(
                activeNode.url,
                minDays,
                activeNode.adminPassword,
                tfaToken,
                { limit: PAGE_SIZE, offset: page * PAGE_SIZE, status: filterStatus }
            );
            const list = data.disputes || [];
            setDisputes(list);
            setTotalCount(typeof data.total === 'number' ? data.total : list.length);
            setTabCounts(data.counts ?? null);
        } catch (err: any) {
            setError(err.message || 'Failed to load escrow disputes');
        } finally {
            setLoading(false);
        }
    };

    useEffect(() => {
        loadDisputes();
    }, [activeNode?.id, activeNode?.url, minDays, filterStatus, page]);

    const isResolved = (d: EscrowDisputeItem) => Boolean(d.resolution || (d as any).disputeResolution);
    const isRealDispute = (d: EscrowDisputeItem) => d.status === 'pending' || isResolved(d);

    const realDisputes = disputes.filter(isRealDispute);
    const filteredDisputes = realDisputes.filter((d) => {
        if (filterStatus === 'pending') return d.status === 'pending';
        if (filterStatus === 'resolved') return isResolved(d);
        return true;
    });

    // Counts come from the server, never from this one filtered page. An older server
    // without `counts` only tells us the open tab's total, so the other tabs show no number.
    const tabCount = (tab: 'pending' | 'resolved' | 'all'): number | null => {
        if (tabCounts) return tabCounts[tab];
        return tab === filterStatus ? totalCount : null;
    };
    const tabLabel = (label: string, tab: 'pending' | 'resolved' | 'all') => {
        const n = tabCount(tab);
        return n === null ? label : `${label} (${n})`;
    };
    const pendingCount = tabCount('pending');
    const displayTotal = totalCount > 0 ? totalCount : filteredDisputes.length;
    const totalPages = Math.ceil(displayTotal / PAGE_SIZE) || 1;

    const toggleChat = (id: string) => {
        setExpandedChat((prev) => ({ ...prev, [id]: !prev[id] }));
    };

    const handleOpenResolveModal = (
        dispute: EscrowDisputeItem,
        action: 'release_to_seller' | 'refund_to_buyer' | 'split'
    ) => {
        setSelectedDispute(dispute);
        setSelectedAction(action);
        setReason('');
        setActionFeedback(null);
    };

    const handleCloseResolveModal = () => {
        if (resolving) return;
        setSelectedDispute(null);
        setSelectedAction(null);
        setReason('');
    };

    useEffect(() => {
        if (!selectedDispute) return;
        const handleKeyDown = (e: KeyboardEvent) => {
            if (e.key === 'Escape' && !resolving) handleCloseResolveModal();
        };
        window.addEventListener('keydown', handleKeyDown);
        return () => window.removeEventListener('keydown', handleKeyDown);
    }, [selectedDispute, resolving]);

    const handleConfirmResolve = async () => {
        if (!selectedDispute || !selectedAction || !activeNode?.url) return;

        setResolving(true);
        setActionFeedback(null);
        try {
            await resolveEscrowDisputeApi(
                activeNode.url,
                selectedDispute.id,
                selectedAction,
                reason.trim() || undefined,
                activeNode.adminPassword,
                tfaToken
            );

            setActionFeedback({
                type: 'success',
                message: `Escrow dispute resolved successfully (${formatActionName(selectedAction)}). Visible records written to both parties.`,
            });

            // Reload list and notify parent
            await loadDisputes();
            if (onRefresh) onRefresh();

            // Auto-close modal after brief delay
            autoCloseTimer.schedule(() => {
                handleCloseResolveModal();
            }, 1200);
        } catch (err: any) {
            setActionFeedback({
                type: 'error',
                message: err.message || 'Failed to resolve escrow dispute',
            });
        } finally {
            setResolving(false);
        }
    };

    const formatActionName = (act: 'release_to_seller' | 'refund_to_buyer' | 'split' | null) => {
        switch (act) {
            case 'release_to_seller':
                return 'Release to Seller';
            case 'refund_to_buyer':
                return 'Refund to Buyer';
            case 'split':
                return 'Split 50 / 50';
            default:
                return '';
        }
    };

    const computeBreakdown = (credits: number, action: 'release_to_seller' | 'refund_to_buyer' | 'split') => {
        const FEE_PERCENT = 0.015;
        if (action === 'release_to_seller') {
            const fee = Math.round(credits * FEE_PERCENT * 100) / 100;
            const sellerPayout = Math.round((credits - fee) * 100) / 100;
            return {
                buyerRefund: 0,
                sellerPayout,
                commonsFee: fee,
            };
        } else if (action === 'refund_to_buyer') {
            return {
                buyerRefund: credits,
                sellerPayout: 0,
                commonsFee: 0,
            };
        } else {
            // split
            const buyerShare = Math.round((credits / 2) * 100) / 100;
            const sellerShare = Math.round((credits - buyerShare) * 100) / 100;
            const fee = Math.round(sellerShare * FEE_PERCENT * 100) / 100;
            const sellerPayout = Math.round((sellerShare - fee) * 100) / 100;
            return {
                buyerRefund: buyerShare,
                sellerPayout,
                commonsFee: fee,
            };
        }
    };

    return (
        <div className="space-y-6 font-sans">
            {/* Header & Governance Transparency Notice */}
            <div className="bg-nature-900/80 border border-nature-800 rounded-3xl p-6 shadow-xl backdrop-blur-md">
                <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-4">
                    <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-2 mb-1">
                            <h2 className="text-xl font-black text-white m-0 tracking-tight flex items-center gap-2">
                                <span>⚖️</span> Escrow Dispute Resolution
                            </h2>
                            {pendingCount !== null && (
                                <span className="px-2.5 py-0.5 rounded-full bg-amber-500/20 border border-amber-500/30 text-amber-300 text-xs font-semibold">
                                    {pendingCount} Pending (&gt;{minDays}d)
                                </span>
                            )}
                        </div>
                        <p className="text-xs text-nature-400 m-0 max-w-2xl mt-1 leading-relaxed">
                            Marketplace deals held in escrow over 7 days with seller or buyer unable to complete.
                            Resolving a dispute is <strong className="text-nature-200">never a quiet admin button</strong>: every action carries the admin's identity (<code className="text-terra-400 bg-nature-950 px-1 py-0.5 rounded">auth_signer</code>), writes an immutable public record to both parties' transaction and activity feeds, posts to the chat, and preserves ledger conservation.
                        </p>
                    </div>

                    {/* Filter controls */}
                    <div className="flex items-center gap-3 flex-wrap">
                        <div className="flex items-center gap-1.5 bg-nature-950 px-2.5 py-1.5 rounded-xl border border-nature-800">
                            <label htmlFor="min-days-select" className="text-xs text-nature-400">Stuck &gt;</label>
                            <select
                                id="min-days-select"
                                value={minDays}
                                onChange={(e) => {
                                    setMinDays(Number(e.target.value));
                                    setPage(0);
                                }}
                                className="bg-transparent text-white text-xs font-semibold focus:outline-none cursor-pointer"
                            >
                                <option value={3} className="bg-nature-900 text-white">3 days</option>
                                <option value={7} className="bg-nature-900 text-white">7 days (standard)</option>
                                <option value={14} className="bg-nature-900 text-white">14 days</option>
                                <option value={30} className="bg-nature-900 text-white">30 days</option>
                                <option value={0} className="bg-nature-900 text-white">All pending</option>
                            </select>
                        </div>

                        <button
                            onClick={loadDisputes}
                            disabled={loading}
                            className="px-3 py-1.5 rounded-xl bg-nature-800 hover:bg-nature-700 text-white text-xs font-semibold transition flex items-center gap-1.5 border border-nature-700 min-h-[48px] lg:min-h-0"
                        >
                            <span className={loading ? 'animate-spin' : ''}>🔄</span>
                            <span>Refresh</span>
                        </button>
                    </div>
                </div>

                {/* Subtabs for Pending vs Resolved */}
                <div className="flex flex-wrap lg:flex-nowrap items-center gap-2 mt-5 pt-4 border-t border-nature-800/80">
                    <button
                        onClick={() => {
                            setFilterStatus('pending');
                            setPage(0);
                        }}
                        className={`px-3 py-1.5 rounded-lg text-xs font-bold transition min-h-[48px] lg:min-h-0 ${
                            filterStatus === 'pending'
                                ? 'bg-amber-500/20 text-amber-300 border border-amber-500/40'
                                : 'text-nature-400 hover:text-white border border-transparent'
                        }`}
                    >
                        {tabLabel('Pending Actions', 'pending')}
                    </button>
                    <button
                        onClick={() => {
                            setFilterStatus('resolved');
                            setPage(0);
                        }}
                        className={`px-3 py-1.5 rounded-lg text-xs font-bold transition min-h-[48px] lg:min-h-0 ${
                            filterStatus === 'resolved'
                                ? 'bg-nature-700 text-white border border-nature-600'
                                : 'text-nature-400 hover:text-white border border-transparent'
                        }`}
                    >
                        {tabLabel('Resolved History', 'resolved')}
                    </button>
                    <button
                        onClick={() => {
                            setFilterStatus('all');
                            setPage(0);
                        }}
                        className={`px-3 py-1.5 rounded-lg text-xs font-bold transition min-h-[48px] lg:min-h-0 ${
                            filterStatus === 'all'
                                ? 'bg-nature-700 text-white border border-nature-600'
                                : 'text-nature-400 hover:text-white border border-transparent'
                        }`}
                    >
                        {tabLabel('All', 'all')}
                    </button>
                </div>
            </div>

            {/* Error banner */}
            {error && (
                <div className="bg-rose-950/80 border border-rose-800 rounded-2xl p-4 text-rose-300 text-xs flex items-center justify-between gap-3">
                    <div className="flex items-center gap-2 min-w-0 break-words">
                        <span>⚠️</span>
                        <span>{error}</span>
                    </div>
                    <button
                        onClick={loadDisputes}
                        className="px-2.5 py-1 bg-rose-900 hover:bg-rose-800 text-white rounded-lg font-semibold"
                    >
                        Retry
                    </button>
                </div>
            )}

            {/* Loading state */}
            {loading && disputes.length === 0 && (
                <div className="bg-nature-900/40 border border-nature-800 rounded-2xl p-12 text-center text-nature-400 text-xs animate-pulse">
                    Loading stalled escrow transactions...
                </div>
            )}

            {/* Empty state */}
            {!loading && filteredDisputes.length === 0 && (
                <div className="bg-nature-900/40 border border-nature-800 rounded-2xl p-12 text-center space-y-3">
                    <div className="text-3xl">✨</div>
                    <h3 className="text-base font-bold text-white m-0">
                        {filterStatus === 'pending'
                            ? 'No Stalled Escrows'
                            : 'No Disputes Found'}
                    </h3>
                    <p className="text-xs text-nature-400 max-w-md mx-auto m-0">
                        {filterStatus === 'pending'
                            ? `There are no transactions stuck in escrow > ${minDays} days. Marketplace exchanges are completing normally.`
                            : `No escrow transactions match the selected filter criteria.`}
                    </p>
                </div>
            )}

            {/* Dispute Cards List */}
            <div className="space-y-4">
                {filteredDisputes.map((dispute) => {
                    const isPending = dispute.status === 'pending';
                    const isChatExpanded = Boolean(expandedChat[dispute.id]);
                    const buyerPubkey = dispute.buyerPubkey || (dispute as any).parties?.buyer?.pubkey || '';
                    const sellerPubkey = dispute.sellerPubkey || (dispute as any).parties?.seller?.pubkey || '';
                    const buyerCallsign = dispute.buyerCallsign || (dispute as any).parties?.buyer?.callsign;
                    const sellerCallsign = dispute.sellerCallsign || (dispute as any).parties?.seller?.callsign;
                    const buyerLabel = buyerCallsign || dispute.buyerName || (buyerPubkey ? `${buyerPubkey.slice(0, 8)}...` : 'Buyer');
                    const sellerLabel = sellerCallsign || dispute.sellerName || (sellerPubkey ? `${sellerPubkey.slice(0, 8)}...` : 'Seller');
                    const postTitle = dispute.post?.title || 'Marketplace Item';
                    const postDesc = dispute.post?.description || '';

                    return (
                        <div
                            key={dispute.id}
                            className={`bg-nature-900/80 border rounded-2xl p-5 shadow-lg space-y-4 transition ${
                                isPending
                                    ? 'border-amber-800/60 hover:border-amber-700/80'
                                    : 'border-nature-800'
                            }`}
                        >
                            {/* Card Header: Amount, Post title, Days stuck */}
                            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 border-b border-nature-800/80 pb-3">
                                <div className="space-y-1">
                                    <div className="flex items-center gap-2 flex-wrap">
                                        <h3 className="text-base font-bold text-white m-0">
                                            {postTitle}
                                        </h3>
                                        <span className="text-xs font-mono font-bold px-2 py-0.5 rounded-full bg-terra-500/20 text-terra-300 border border-terra-500/30">
                                            {dispute.credits.toFixed(2)} BEAN
                                        </span>
                                        {isPending ? (
                                            <span className="text-xs font-semibold px-2 py-0.5 rounded-full bg-amber-500/20 text-amber-300 border border-amber-500/30">
                                                ⏳ {dispute.daysStuck}d in escrow
                                            </span>
                                        ) : (
                                            <span className="text-xs font-semibold px-2 py-0.5 rounded-full bg-emerald-500/20 text-emerald-300 border border-emerald-500/30">
                                                ✅ Resolved: {dispute.resolution ? formatActionName(dispute.resolution) : dispute.status}
                                            </span>
                                        )}
                                    </div>
                                    <p className="text-xs text-nature-400 font-mono m-0">
                                        Transaction ID: <span className="text-nature-300">{dispute.id}</span> • Initiated {new Date(dispute.createdAt).toLocaleDateString()}
                                    </p>
                                </div>

                                {dispute.post?.category && (
                                    <span className="text-xs text-nature-400 bg-nature-950 px-2.5 py-1 rounded-lg border border-nature-800 self-start sm:self-auto">
                                        {dispute.post.category}
                                    </span>
                                )}
                            </div>

                            {/* Parties Grid & Post Description */}
                            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                                <div className="bg-nature-950/60 border border-nature-800/60 rounded-xl p-3 space-y-2">
                                    <div className="text-xs font-bold text-nature-300 flex items-center gap-1.5">
                                        <span>👤</span> Parties in Escrow
                                    </div>
                                    <div className="text-xs space-y-1">
                                        <div className="flex items-center justify-between">
                                            <span className="text-nature-400">Buyer:</span>
                                            <span className="font-semibold text-white">
                                                {buyerLabel} {buyerPubkey ? <span className="text-nature-500 font-mono text-[10px]">({buyerPubkey.slice(0, 6)}...)</span> : null}
                                            </span>
                                        </div>
                                        <div className="flex items-center justify-between">
                                            <span className="text-nature-400">Seller:</span>
                                            <span className="font-semibold text-white">
                                                {sellerLabel} {sellerPubkey ? <span className="text-nature-500 font-mono text-[10px]">({sellerPubkey.slice(0, 6)}...)</span> : null}
                                            </span>
                                        </div>
                                    </div>
                                </div>

                                <div className="bg-nature-950/60 border border-nature-800/60 rounded-xl p-3 space-y-2">
                                    <div className="text-xs font-bold text-nature-300 flex items-center gap-1.5">
                                        <span>📝</span> Post Details
                                    </div>
                                    <p className="text-xs text-nature-300 line-clamp-2 m-0">
                                        {postDesc || 'No listing description provided.'}
                                    </p>
                                </div>
                            </div>

                            {/* Chat Context Box */}
                            <div className="bg-nature-950/40 border border-nature-800/80 rounded-xl overflow-hidden">
                                <button
                                    type="button"
                                    onClick={() => toggleChat(dispute.id)}
                                    aria-expanded={isChatExpanded}
                                    aria-controls={`chat-context-${dispute.id}`}
                                    className="w-full p-3 bg-nature-950/80 flex items-center justify-between hover:bg-nature-950 transition text-left focus:outline-none focus:ring-1 focus:ring-terra-500 rounded-t-xl"
                                >
                                    <div className="flex items-center gap-2 text-xs font-bold text-nature-200">
                                        <span>💬</span>
                                        <span>Direct Chat Context ({dispute.chatContext?.length || 0} messages)</span>
                                    </div>
                                    <span className="text-xs text-nature-400 font-semibold">
                                        {isChatExpanded ? 'Hide Chat ▲' : 'View Chat ▼'}
                                    </span>
                                </button>

                                {isChatExpanded && (
                                    <div id={`chat-context-${dispute.id}`} className="p-3 space-y-2 border-t border-nature-800/80 max-h-60 overflow-y-auto">
                                        {(!dispute.chatContext || dispute.chatContext.length === 0) ? (
                                            <p className="text-xs text-nature-500 italic m-0">
                                                No direct chat messages between buyer and seller found.
                                            </p>
                                        ) : (
                                            dispute.chatContext.map((msg) => {
                                                const isBuyer = Boolean(buyerPubkey && msg.senderPubkey === buyerPubkey);
                                                const isSeller = Boolean(sellerPubkey && msg.senderPubkey === sellerPubkey);
                                                const senderTag = isBuyer ? 'Buyer' : isSeller ? 'Seller' : 'System';
                                                const senderName = msg.senderCallsign || msg.senderName || (msg.senderPubkey ? `${msg.senderPubkey.slice(0, 8)}...` : 'Unknown');

                                                return (
                                                    <div
                                                        key={msg.id}
                                                        className={`p-2.5 rounded-lg text-xs space-y-1 ${
                                                            isBuyer
                                                                ? 'bg-sky-950/30 border border-sky-800/40'
                                                                : isSeller
                                                                ? 'bg-emerald-950/30 border border-emerald-800/40'
                                                                : 'bg-nature-900 border border-nature-800'
                                                        }`}
                                                    >
                                                        <div className="flex items-center justify-between text-[11px]">
                                                            <span className="font-bold text-nature-300">
                                                                {senderName} <span className="text-nature-400 font-normal">({senderTag})</span>
                                                            </span>
                                                            <span className="text-nature-500 font-mono">
                                                                {new Date(msg.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                                                            </span>
                                                        </div>
                                                        <p className="text-nature-200 m-0 break-words whitespace-pre-wrap">
                                                            {msg.content}
                                                        </p>
                                                    </div>
                                                );
                                            })
                                        )}
                                    </div>
                                )}
                            </div>

                            {/* Resolution Details Banner (if already resolved) */}
                            {!isPending && dispute.resolvedAt && (
                                <div className="bg-nature-950 border border-nature-800 rounded-xl p-3 text-xs space-y-1">
                                    <div className="font-bold text-nature-300 flex items-center gap-1.5">
                                        <span>📜</span> Public Provenance Stamp
                                    </div>
                                    <div className="text-nature-400 flex flex-wrap gap-x-4 gap-y-1 text-[11px]">
                                        <span>
                                            Action: <strong className="text-white">{formatActionName(dispute.resolution || null)}</strong>
                                        </span>
                                        <span>
                                            Resolved By: <code className="text-terra-300">{formatResolverName(dispute.resolvedBy)}</code>
                                        </span>
                                        <span>
                                            Timestamp: <span className="text-white">{new Date(dispute.resolvedAt).toLocaleString()}</span>
                                        </span>
                                    </div>
                                </div>
                            )}

                            {/* Action Buttons Bar (if pending) */}
                            {isPending && (
                                <div className="pt-2 border-t border-nature-800/80 space-y-3">
                                    <div className="flex items-center justify-between flex-wrap gap-2">
                                        <div className="text-[11px] text-nature-400 flex items-center gap-1.5">
                                            <span>⚠️</span>
                                            <span>Resolution requires operator arbitration. Each action is publicly stamped with your admin key.</span>
                                        </div>
                                    </div>

                                    <div className="grid grid-cols-1 sm:grid-cols-3 gap-2.5">
                                        {/* Action 1: Release to Seller */}
                                        <button
                                            onClick={() => handleOpenResolveModal(dispute, 'release_to_seller')}
                                            className="px-3 py-2 rounded-xl bg-emerald-950/80 hover:bg-emerald-900 border border-emerald-700/60 text-emerald-200 text-xs font-bold transition flex flex-col items-center justify-center text-center group"
                                        >
                                            <span className="flex items-center gap-1">
                                                <span>✅</span> Release to Seller
                                            </span>
                                            <span className="text-[10px] font-normal text-emerald-400 mt-0.5">
                                                Pay seller ({computeBreakdown(dispute.credits, 'release_to_seller').sellerPayout} BEAN)
                                            </span>
                                        </button>

                                        {/* Action 2: Refund to Buyer */}
                                        <button
                                            onClick={() => handleOpenResolveModal(dispute, 'refund_to_buyer')}
                                            className="px-3 py-2 rounded-xl bg-amber-950/80 hover:bg-amber-900 border border-amber-700/60 text-amber-200 text-xs font-bold transition flex flex-col items-center justify-center text-center group"
                                        >
                                            <span className="flex items-center gap-1">
                                                <span>↩️</span> Refund to Buyer
                                            </span>
                                            <span className="text-[10px] font-normal text-amber-400 mt-0.5">
                                                Full 100% refund ({dispute.credits} BEAN)
                                            </span>
                                        </button>

                                        {/* Action 3: Split 50/50 */}
                                        <button
                                            onClick={() => handleOpenResolveModal(dispute, 'split')}
                                            className="px-3 py-2 rounded-xl bg-sky-950/80 hover:bg-sky-900 border border-sky-700/60 text-sky-200 text-xs font-bold transition flex flex-col items-center justify-center text-center group"
                                        >
                                            <span className="flex items-center gap-1">
                                                <span>⚖️</span> Split 50 / 50
                                            </span>
                                            <span className="text-[10px] font-normal text-sky-400 mt-0.5">
                                                Half to buyer, half to seller
                                            </span>
                                        </button>
                                    </div>
                                </div>
                            )}
                        </div>
                    );
                })}
            </div>

            {/* Pagination Controls */}
            {totalPages > 1 && (
                <div className="flex items-center justify-between gap-3 pt-4 border-t border-nature-800/80">
                    <button
                        onClick={() => setPage((p) => Math.max(0, p - 1))}
                        disabled={page === 0 || loading}
                        className="px-3.5 py-2 rounded-xl bg-nature-800 hover:bg-nature-700 disabled:opacity-40 disabled:hover:bg-nature-800 text-white text-xs font-semibold transition flex items-center gap-1.5 border border-nature-700 min-h-[48px] lg:min-h-0"
                    >
                        <span>◀</span> Previous
                    </button>
                    <span className="text-xs text-nature-400 font-mono">
                        Page {page + 1} of {totalPages} ({displayTotal} total)
                    </span>
                    <button
                        onClick={() => setPage((p) => Math.min(totalPages - 1, p + 1))}
                        disabled={page >= totalPages - 1 || loading}
                        className="px-3.5 py-2 rounded-xl bg-nature-800 hover:bg-nature-700 disabled:opacity-40 disabled:hover:bg-nature-800 text-white text-xs font-semibold transition flex items-center gap-1.5 border border-nature-700 min-h-[48px] lg:min-h-0"
                    >
                        Next <span>▶</span>
                    </button>
                </div>
            )}

            {/* Resolve Confirmation Modal */}
            {selectedDispute && selectedAction && (
                <ModalBackdrop onClose={handleCloseResolveModal} dismissable={!resolving} className="fixed inset-0 overflow-y-auto z-50 bg-black/70 backdrop-blur-sm flex items-center justify-center p-4">
                    <div
                        role="dialog"
                        aria-modal="true"
                        aria-labelledby="resolve-dialog-title"
                        className="m-auto bg-nature-900 border border-nature-700 rounded-3xl max-w-lg w-full p-6 shadow-2xl space-y-5 animate-scale-up font-sans"
                    >
                        {/* Modal Header */}
                        <div className="flex items-start justify-between gap-3 lg:gap-0">
                            <div className="space-y-1 min-w-0 flex-1">
                                <h3 id="resolve-dialog-title" className="text-lg font-black text-white m-0 flex items-center gap-2">
                                    <span>⚖️</span> Confirm Escrow Resolution
                                </h3>
                                <p className="text-xs text-nature-400 m-0">
                                    Dispute ID: <span className="font-mono text-nature-300">{selectedDispute.id}</span>
                                </p>
                            </div>
                            <button
                                aria-label="Close"
                                onClick={handleCloseResolveModal}
                                disabled={resolving}
                                className="shrink-0 text-nature-400 hover:text-white text-lg font-bold p-1 rounded-lg"
                            >
                                ✕
                            </button>
                        </div>

                        {/* Selected Action Banner */}
                        <div className="p-4 rounded-2xl bg-nature-950 border border-nature-800 space-y-3">
                            <div className="flex items-center justify-between">
                                <span className="text-xs text-nature-400 font-bold uppercase tracking-wider">
                                    Arbitration Action
                                </span>
                                <span className="px-2.5 py-1 rounded-full text-xs font-black bg-terra-500/20 text-terra-300 border border-terra-500/30">
                                    {formatActionName(selectedAction)}
                                </span>
                            </div>

                            {/* Credit Breakdown Table */}
                            {(() => {
                                const breakdown = computeBreakdown(selectedDispute.credits, selectedAction);
                                return (
                                    <div className="space-y-1.5 text-xs pt-2 border-t border-nature-800/80">
                                        <div className="flex justify-between text-nature-300">
                                            <span>Buyer ({selectedDispute.buyerCallsign || selectedDispute.buyerName || 'Buyer'}):</span>
                                            <span className="font-mono font-bold text-white">
                                                +{breakdown.buyerRefund.toFixed(2)} BEAN
                                            </span>
                                        </div>
                                        <div className="flex justify-between text-nature-300">
                                            <span>Seller ({selectedDispute.sellerCallsign || selectedDispute.sellerName || 'Seller'}):</span>
                                            <span className="font-mono font-bold text-white">
                                                +{breakdown.sellerPayout.toFixed(2)} BEAN
                                            </span>
                                        </div>
                                        <div className="flex justify-between text-nature-400">
                                            <span>Commons Pool Fee (1.5%):</span>
                                            <span className="font-mono text-nature-300">
                                                +{breakdown.commonsFee.toFixed(2)} BEAN
                                            </span>
                                        </div>
                                        <div className="flex justify-between pt-1 border-t border-nature-800/60 font-bold text-terra-300">
                                            <span>Total Conserved:</span>
                                            <span className="font-mono">
                                                {selectedDispute.credits.toFixed(2)} BEAN
                                            </span>
                                        </div>
                                    </div>
                                );
                            })()}
                        </div>

                        {/* Optional Reason Field */}
                        <div className="space-y-1.5">
                            <label className="text-xs font-bold text-nature-300">
                                Arbitration Reason / Findings (Visible to both parties):
                            </label>
                            <textarea
                                value={reason}
                                onChange={(e) => setReason(e.target.value)}
                                placeholder="e.g. Seller confirmed delivery proof; buyer unresponsive for 10 days."
                                rows={3}
                                className="w-full bg-nature-950 border border-nature-800 rounded-xl p-3 text-xs text-white placeholder-nature-600 focus:outline-none focus:border-terra-500 transition resize-none"
                            />
                        </div>

                        {/* Mandatory Governance Warning */}
                        <div className="bg-amber-950/40 border border-amber-800/60 rounded-xl p-3 text-[11px] text-amber-300/90 leading-relaxed space-y-1">
                            <div className="font-bold text-amber-200 flex items-center gap-1">
                                <span>⚠️</span> Public Record Notice
                            </div>
                            <p className="m-0">
                                This resolution is <strong className="text-amber-100">not a quiet admin override</strong>. Your administrator identity (<code className="font-mono text-white">auth_signer</code>) will be recorded permanently in the transaction ledger, dispatched to the member activity feeds, and broadcast to the trade chat.
                            </p>
                        </div>

                        {/* Action feedback */}
                        {actionFeedback && (
                            <div
                                className={`p-3 rounded-xl text-xs font-semibold ${
                                    actionFeedback.type === 'success'
                                        ? 'bg-emerald-950/80 border border-emerald-800 text-emerald-200'
                                        : 'bg-rose-950/80 border border-rose-800 text-rose-200'
                                }`}
                            >
                                {actionFeedback.message}
                            </div>
                        )}

                        {/* Modal Action Buttons */}
                        <div className="flex items-center justify-end gap-3 pt-2">
                            <button
                                onClick={handleCloseResolveModal}
                                disabled={resolving}
                                className="shrink-0 px-4 py-2 rounded-xl bg-nature-800 hover:bg-nature-700 text-nature-300 text-xs font-bold transition"
                            >
                                Cancel
                            </button>
                            <button
                                onClick={handleConfirmResolve}
                                disabled={resolving}
                                className="px-5 py-2 rounded-xl bg-terra-500 hover:bg-terra-400 text-nature-950 text-xs font-black transition flex items-center gap-2 shadow-lg shadow-terra-500/20"
                            >
                                {resolving && <span className="animate-spin">🔄</span>}
                                <span>Confirm &amp; Record Resolution</span>
                            </button>
                        </div>
                    </div>
                </ModalBackdrop>
            )}
        </div>
    );
}
