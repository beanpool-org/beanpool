/**
 * MyDealsModal — Bottom sheet for deal management in PWA
 *
 * Web equivalent of Native MyDealsSheet.
 * Replaces the old "Global Feed / My Market" segmented control.
 * Bottom-sheet on mobile, centered modal on desktop.
 *
 * Tabs: Active | In Progress (with badge) | History
 * History sub-filter: All | Received | Given
 */

import type { MarketplacePost } from '../lib/api';

interface MarketplaceTransaction {
    id: string;
    postId: string;
    postTitle: string;
    buyerPublicKey: string;
    buyerCallsign: string;
    sellerPublicKey: string;
    sellerCallsign: string;
    credits: number;
    status: string;
    createdAt: string;
    coverImage?: string;
    ratedByBuyer?: boolean;
    ratedBySeller?: boolean;
}

import { useState, useEffect } from 'react';

interface Props {
    visible: boolean;
    identity: { publicKey: string } | null;
    onClose: () => void;
    posts: MarketplacePost[];
    transactions: MarketplaceTransaction[];
    initialTab?: 'active' | 'pending' | 'history';
    onNavigateToPost?: (postId: string, txId?: string) => void;
    onPromptReview?: (tx: { txId: string; targetPubkey: string; targetCallsign: string; targetRole: 'provider' | 'receiver' }) => void;
}

export function MyDealsModal({ visible, identity, onClose, posts, transactions, initialTab = 'pending', onNavigateToPost, onPromptReview }: Props) {
    const [dealsTab, setDealsTab] = useState<'active' | 'pending' | 'history'>(initialTab);
    const [historyFilter, setHistoryFilter] = useState<'all' | 'buying' | 'selling'>('all');

    useEffect(() => {
        if (initialTab) setDealsTab(initialTab);
    }, [initialTab, visible]);

    if (!visible || !identity) return null;

    // ── Data derivation ──
    const myPosts = posts.filter(p =>
        p.authorPublicKey === identity.publicKey ||
        p.acceptedBy === identity.publicKey ||
        transactions.some(t => t.postId === p.id && t.status === 'pending' && (t.buyerPublicKey === identity.publicKey || t.sellerPublicKey === identity.publicKey))
    ).sort((a, b) => {
        if (a.status === 'pending' && b.status !== 'pending') return -1;
        if (b.status === 'pending' && a.status !== 'pending') return 1;
        if (a.status === 'active' && b.status !== 'active') return -1;
        if (b.status === 'active' && a.status !== 'active') return 1;
        return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
    });

    const pendingDeals = posts.filter(p => {
        if (p.status === 'pending' && (p.authorPublicKey === identity.publicKey || p.acceptedBy === identity.publicKey)) return true;
        return transactions.some(t => t.postId === p.id && t.status === 'pending');
    });

    const pendingCount = pendingDeals.length + transactions.filter(t => t.status === 'pending').length;

    const getData = (): any[] => {
        if (dealsTab === 'active') return myPosts.filter(p => p.status === 'active');
        if (dealsTab === 'pending') {
            // Combine pending posts and pending transactions
            return transactions.filter(t => t.status === 'pending');
        }
        // History
        let txs = transactions.filter(t => t.status === 'completed' || t.status === 'cancelled' || t.status === 'rejected');
        if (historyFilter === 'buying') txs = txs.filter(t => t.buyerPublicKey === identity.publicKey);
        if (historyFilter === 'selling') txs = txs.filter(t => t.sellerPublicKey === identity.publicKey);
        return txs;
    };

    const listData = getData();

    return (
        <div className="fixed inset-0 z-[100] flex items-end justify-center sm:items-center bg-black/40 backdrop-blur-sm animate-in fade-in duration-200" onClick={onClose}>
            <div
                className="bg-white dark:bg-nature-950 w-full sm:w-[90vw] sm:max-w-2xl rounded-t-3xl sm:rounded-3xl shadow-2xl flex flex-col h-[85vh] sm:h-[80vh] animate-in slide-in-from-bottom-full sm:slide-in-from-bottom-10 duration-300"
                onClick={e => e.stopPropagation()}
            >
                {/* Handle bar (mobile) */}
                <div className="w-10 h-1 rounded-full bg-nature-300 dark:bg-nature-700 mx-auto mt-3 sm:hidden" />

                {/* Header */}
                <div className="flex justify-between items-center px-6 py-4 border-b border-nature-100 dark:border-nature-800 shrink-0">
                    <h3 className="text-xl font-black text-nature-900 dark:text-white">My Deals</h3>
                    <button
                        onClick={onClose}
                        aria-label="Close My Deals"
                        className="w-8 h-8 rounded-full bg-nature-100 dark:bg-nature-800 flex items-center justify-center text-nature-500 hover:bg-nature-200 dark:hover:bg-nature-700 transition-colors font-bold focus-visible:ring-2 focus-visible:ring-nature-500"
                    >
                        ✕
                    </button>
                </div>

                {/* Tab bar */}
                <div className="px-4 pt-4 pb-3 border-b border-nature-100 dark:border-nature-800 shrink-0 bg-nature-50/50 dark:bg-nature-900/20">
                    <div className="flex bg-nature-100 dark:bg-nature-800 rounded-xl p-1 shadow-inner">
                        {[
                            { id: 'pending' as const, label: 'In Progress', badge: pendingCount },
                            { id: 'active' as const, label: 'My Posts' },
                            { id: 'history' as const, label: 'History' },
                        ].map(tab => (
                            <button
                                key={tab.id}
                                onClick={() => setDealsTab(tab.id)}
                                className={`flex-1 flex gap-2 justify-center items-center py-2 text-sm font-bold rounded-lg transition-all ${
                                    dealsTab === tab.id
                                        ? 'bg-white dark:bg-nature-900 text-nature-900 dark:text-white shadow-sm'
                                        : 'text-nature-500 hover:text-nature-700 dark:text-nature-400 dark:hover:text-nature-300'
                                }`}
                            >
                                <span>{tab.label}</span>
                                {tab.badge && tab.badge > 0 ? (
                                    <span className="bg-red-500 text-white text-[10px] font-black px-1.5 py-0.5 rounded-full shadow-sm">
                                        {tab.badge}
                                    </span>
                                ) : null}
                            </button>
                        ))}
                    </div>

                    {/* History sub-filter */}
                    {dealsTab === 'history' && (
                        <div className="flex justify-center gap-2 mt-3">
                            {[{ id: 'all' as const, label: 'All' }, { id: 'buying' as const, label: 'Received' }, { id: 'selling' as const, label: 'Given' }].map(f => (
                                <button
                                    key={f.id}
                                    onClick={() => setHistoryFilter(f.id)}
                                    className={`px-3 py-1 text-xs font-bold rounded-full border transition-colors ${
                                        historyFilter === f.id
                                            ? 'bg-nature-800 dark:bg-nature-200 text-white dark:text-nature-900 border-nature-900 dark:border-nature-100'
                                            : 'bg-white dark:bg-nature-900 text-nature-600 dark:text-nature-400 border-nature-200 dark:border-nature-700 hover:bg-oat-50'
                                    }`}
                                >
                                    {f.label}
                                </button>
                            ))}
                        </div>
                    )}
                </div>

                {/* List */}
                <div className="flex-1 overflow-y-auto p-4 bg-oat-50/30 dark:bg-nature-950">
                    {listData.length === 0 ? (
                        <div className="flex flex-col items-center justify-center py-16 text-center">
                            <span className="text-5xl opacity-30 mb-4">{dealsTab === 'history' ? '📜' : dealsTab === 'pending' ? '🤝' : '📋'}</span>
                            <h4 className="font-bold text-lg text-nature-900 dark:text-white mb-2">
                                {dealsTab === 'history' ? 'No history yet' : dealsTab === 'pending' ? 'No deals in progress' : 'No active posts'}
                            </h4>
                            <p className="text-nature-500 dark:text-nature-400 text-sm mb-6 max-w-xs">
                                {dealsTab === 'active'
                                    ? 'Post an offer or need to get started on the marketplace!'
                                    : dealsTab === 'pending'
                                    ? 'Accepted deals will appear here while they are held in trust.'
                                    : 'Completed or cancelled deals will show up here.'}
                            </p>
                            {dealsTab === 'active' && (
                                <button
                                    onClick={() => { onClose(); window.scrollTo({ top: 0, behavior: 'smooth' }); }}
                                    className="px-6 py-2.5 rounded-xl bg-indigo-600 text-white font-bold text-sm shadow-md hover:bg-indigo-700 transition-colors"
                                >
                                    + Create a Post
                                </button>
                            )}
                        </div>
                    ) : (
                        <div className="flex flex-col gap-3">
                            {listData.map((item: any) => {
                                // Transaction view (History + Pending)
                                if (dealsTab === 'history' || dealsTab === 'pending') {
                                    const isBuyer = item.buyerPublicKey === identity.publicKey;
                                    const isCompleted = item.status === 'completed';
                                    const isPending = item.status === 'pending';
                                    const needsReview = isCompleted && ((isBuyer && !item.ratedByBuyer) || (!isBuyer && !item.ratedBySeller));
                                    const partnerCallsign = isBuyer ? item.sellerCallsign : item.buyerCallsign;

                                    return (
                                        <div
                                            key={item.id}
                                            onClick={() => {
                                                if (isPending && onNavigateToPost) {
                                                    onClose();
                                                    onNavigateToPost(item.postId, item.id);
                                                }
                                            }}
                                            className={`bg-white dark:bg-nature-900 border rounded-2xl p-4 shadow-sm relative overflow-hidden transition-all ${
                                                isPending ? 'border-emerald-200 dark:border-emerald-800 bg-emerald-50/10 dark:bg-emerald-950/20 cursor-pointer hover:border-emerald-400 hover:shadow-md'
                                                : isCompleted ? 'border-nature-200 dark:border-nature-800'
                                                : 'border-nature-200/50 dark:border-nature-800/50 opacity-60 grayscale-[50%]'
                                            }`}
                                        >
                                            <div className="flex gap-3 mb-2">
                                                {item.coverImage ? (
                                                    <img src={item.coverImage} alt="Cover" className="w-14 h-14 rounded-xl object-cover border border-nature-100 dark:border-nature-800 shrink-0" />
                                                ) : (
                                                    <div className="w-14 h-14 rounded-xl bg-nature-100 dark:bg-nature-800 flex items-center justify-center shrink-0">
                                                        <span className="text-xl opacity-50">{isBuyer ? '🛒' : '🏷️'}</span>
                                                    </div>
                                                )}
                                                <div className="flex-1 min-w-0">
                                                    <div className="flex justify-between items-start mb-1">
                                                        <div className="flex items-center gap-2">
                                                            <span className={`text-[9px] font-black uppercase tracking-wider px-2 py-0.5 rounded-md ${
                                                                isCompleted ? 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-400'
                                                                : isPending ? 'bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-400'
                                                                : 'bg-nature-200 text-nature-700 dark:bg-nature-800 dark:text-nature-400'
                                                            }`}>
                                                                {item.status}
                                                            </span>
                                                            <span className="text-[10px] text-nature-400 font-bold">
                                                                {new Date(item.createdAt).toLocaleDateString()}
                                                            </span>
                                                        </div>
                                                        <div className="flex items-center">
                                                            <span className={`font-black text-sm ${isBuyer ? 'text-red-500' : 'text-emerald-500'}`}>
                                                                {isBuyer ? '- ' : '+ '}{item.credits}
                                                            </span>
                                                            <img src="/assets/bean.png" className="w-3.5 h-3.5 ml-1" alt="B" />
                                                        </div>
                                                    </div>
                                                    <h4 className="font-bold text-nature-950 dark:text-white text-[15px] truncate">
                                                        {item.postTitle}
                                                    </h4>
                                                </div>
                                            </div>
                                            <div className="flex justify-between items-end">
                                                <p className="text-[11px] text-nature-500 font-medium">
                                                    {isBuyer ? 'Bought from ' : 'Sold to '}
                                                    <span className="text-nature-800 dark:text-nature-300 font-bold">{partnerCallsign}</span>
                                                </p>
                                                {needsReview && onPromptReview && (
                                                    <button
                                                        onClick={(e) => {
                                                            e.stopPropagation();
                                                            onPromptReview({
                                                                txId: item.id,
                                                                targetPubkey: isBuyer ? item.sellerPublicKey : item.buyerPublicKey,
                                                                targetCallsign: partnerCallsign,
                                                                targetRole: isBuyer ? 'provider' : 'receiver',
                                                            });
                                                        }}
                                                        className="px-3 py-1.5 bg-amber-100 hover:bg-amber-200 dark:bg-amber-900/40 text-amber-800 dark:text-amber-500 text-xs font-bold rounded-lg border border-amber-300 dark:border-amber-800 transition-colors shadow-sm"
                                                    >
                                                        Leave Review
                                                    </button>
                                                )}
                                            </div>
                                        </div>
                                    );
                                }

                                // Active Posts View
                                const coverImage = item.photos && item.photos.length > 0 ? item.photos[0] : null;
                                return (
                                    <div
                                        key={item.id}
                                        onClick={() => {
                                            if (onNavigateToPost) {
                                                onClose();
                                                onNavigateToPost(item.id);
                                            }
                                        }}
                                        className={`bg-white dark:bg-nature-900 border border-nature-200 dark:border-nature-800 rounded-2xl p-4 shadow-sm cursor-pointer hover:shadow-md transition-all ${
                                            item.status === 'pending' ? 'bg-emerald-50/10 dark:bg-emerald-950/20 border-emerald-200 dark:border-emerald-800' : ''
                                        }`}
                                    >
                                        <div className="flex gap-4">
                                            {coverImage ? (
                                                <img src={coverImage} alt="Cover" className="w-14 h-14 rounded-xl object-cover border border-nature-100 dark:border-nature-800 shrink-0" />
                                            ) : (
                                                <div className="w-14 h-14 rounded-xl bg-nature-100 dark:bg-nature-800 flex items-center justify-center shrink-0">
                                                    <span className="text-xl opacity-50">📦</span>
                                                </div>
                                            )}
                                            <div className="flex-1 min-w-0 flex flex-col justify-center">
                                                <div className="flex justify-between items-start mb-1">
                                                    <span className={`text-[9px] font-black uppercase tracking-wider px-2 py-0.5 rounded-md ${
                                                        item.type === 'offer' ? 'bg-terra-100 text-terra-800 dark:bg-terra-900/40 dark:text-terra-400'
                                                        : 'bg-nature-200 text-nature-700 dark:bg-nature-800 dark:text-nature-400'
                                                    }`}>
                                                        {item.type}
                                                    </span>
                                                    <div className="flex items-center">
                                                        <span className="font-black text-sm text-indigo-500">
                                                            {item.credits ?? '?'}
                                                        </span>
                                                        <img src="/assets/bean.png" className="w-3.5 h-3.5 ml-1" alt="B" />
                                                    </div>
                                                </div>
                                                <h4 className="font-bold text-nature-950 dark:text-white text-[15px] truncate mb-1">
                                                    {item.title}
                                                </h4>
                                                <p className="text-[11px] text-nature-500 font-bold uppercase tracking-wide">
                                                    {item.status === 'pending' ? '🤝 Held in Trust' : '🟢 Active'}
                                                </p>
                                            </div>
                                        </div>
                                    </div>
                                );
                            })}
                        </div>
                    )}
                </div>
            </div>
        </div>
    );
}
