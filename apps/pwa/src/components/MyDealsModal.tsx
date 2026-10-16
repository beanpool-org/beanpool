/**
 * My Deals modal: tabbed overview of in-progress (escrow) and completed deals.
 * Accessible: focus trap, Esc-key dismiss, full keyboard navigation for tabs and photos.
 *
 * In preview (on a node where escrow is off, scratch/global-node/DESIGN-global-showcase-fable.md §1 row 3):
 * fed Example Valley (sampleDeals()), with In Progress / My Posts / History tabs.
 * Every per-state button is a marker action that opens the 🏘️ Local community sheet,
 * and no member deal or balance is read.
 */

import { useState, useEffect, useRef, useMemo, type KeyboardEvent } from 'react';
import type { MarketplacePost, MarketplaceTransaction } from '../lib/api';
import { ImageLightbox } from './ImageLightbox';
import { listPhotoUrl, t } from '@beanpool/core';
import { LocalCommunityAction, LocalCommunityStrip, LocalCommunitySheet, type LocalCommunityWays } from './LocalCommunityMark';
import { StartCommunityScreen } from './StartCommunityScreen';
import { SampleHeader, sampleDeals } from './ShowcasePreviews';

interface Props extends LocalCommunityWays {
    visible: boolean;
    identity: { publicKey: string } | null;
    onClose: () => void;
    posts?: MarketplacePost[];
    transactions?: MarketplaceTransaction[];
    initialTab?: 'active' | 'pending' | 'history';
    onNavigateToPost?: (postId: string, txId?: string) => void;
    onPromptReview?: (tx: { txId: string; targetPubkey: string; targetCallsign: string; targetRole: 'provider' | 'receiver' }) => void;
    preview?: boolean;
}

export function MyDealsModal({
    visible,
    identity,
    onClose,
    posts = [],
    transactions = [],
    initialTab = 'pending',
    onNavigateToPost,
    onPromptReview,
    preview = false,
    onNearYou,
    onGuide,
}: Props) {
    const [dealsTab, setDealsTab] = useState<'active' | 'pending' | 'history'>(initialTab);
    const [historyFilter, setHistoryFilter] = useState<'all' | 'buying' | 'selling'>('all');
    const [lightboxState, setLightboxState] = useState<{
        isOpen: boolean;
        photos: string[];
        initialIndex: number;
        title?: string;
        triggerElement?: HTMLElement | null;
    } | null>(null);

    const [sheetShown, setSheetShown] = useState<'sheet' | 'start' | null>(null);
    const openMark = () => setSheetShown('sheet');
    const closeMark = () => setSheetShown(null);

    const sample = useMemo(() => (preview ? sampleDeals() : null), [preview]);
    const effectiveIdentity = preview ? sample?.identity ?? null : identity;
    const effectivePosts = preview ? sample?.posts ?? [] : posts;
    const effectiveTransactions = preview ? sample?.transactions ?? [] : transactions;

    const modalRef = useRef<HTMLDivElement>(null);
    const closeBtnRef = useRef<HTMLButtonElement>(null);
    const lightboxOpenRef = useRef(false);
    lightboxOpenRef.current = !!lightboxState?.isOpen;

    const openLightbox = (photos: string[], title?: string, triggerElement?: HTMLElement | null) =>
        setLightboxState({ isOpen: true, photos, initialIndex: 0, title, triggerElement });

    // Both deal cards are themselves keyboard-activatable and call preventDefault() on
    // Enter/Space, which suppresses the synthetic click on any nested button. So a photo
    // button has to handle the key itself AND stop the event reaching the card — otherwise
    // a keyboard user asking to enlarge the photo gets navigated away to the post instead.
    const photoKeyDown = (photos: string[], title?: string) => (e: KeyboardEvent) => {
        if (e.key === 'Enter' || e.key === ' ') {
            e.stopPropagation();
            e.preventDefault();
            openLightbox(photos, title, e.currentTarget as HTMLElement);
        }
    };

    // Accessibility: Focus trap & Escape key handling for MyDealsModal
    useEffect(() => {
        if (!visible) return;

        // Capture previous active element to restore when deals modal closes
        const prevActive = document.activeElement as HTMLElement | null;

        // Focus close button initially
        const focusTimer = setTimeout(() => {
            closeBtnRef.current?.focus();
        }, 30);

        const handleKeyDown = (e: globalThis.KeyboardEvent) => {
            // If the lightbox or marker sheet is open, its own trap and Escape listener take precedence
            if (lightboxOpenRef.current || sheetShown) return;

            if (e.key === 'Escape') {
                e.preventDefault();
                e.stopPropagation();
                onClose();
                return;
            }

            if (e.key === 'Tab') {
                const container = modalRef.current;
                if (!container) return;

                const focusable = container.querySelectorAll<HTMLElement>(
                    'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
                );
                if (focusable.length === 0) return;

                const first = focusable[0];
                const last = focusable[focusable.length - 1];

                // If focus managed to escape behind the overlay, bring it back
                if (!container.contains(document.activeElement)) {
                    e.preventDefault();
                    first.focus();
                    return;
                }

                if (e.shiftKey) {
                    if (document.activeElement === first) {
                        e.preventDefault();
                        last.focus();
                    }
                } else {
                    if (document.activeElement === last) {
                        e.preventDefault();
                        first.focus();
                    }
                }
            }
        };

        window.addEventListener('keydown', handleKeyDown);

        return () => {
            clearTimeout(focusTimer);
            window.removeEventListener('keydown', handleKeyDown);
            if (prevActive && typeof prevActive.focus === 'function') {
                prevActive.focus();
            }
        };
    }, [visible, onClose, sheetShown]);

    useEffect(() => {
        if (initialTab) setDealsTab(initialTab);
    }, [initialTab, visible]);

    // ── Data derivation hooks (placed unconditionally before early return) ──
    const activeTxsByPostId = useMemo(() => {
        const map = new Map<string, MarketplaceTransaction[]>();
        for (const t of effectiveTransactions) {
            if (t.status === 'pending' || t.status === 'requested') {
                const list = map.get(t.postId);
                if (list) {
                    list.push(t);
                } else {
                    map.set(t.postId, [t]);
                }
            }
        }
        return map;
    }, [effectiveTransactions]);

    const pendingTxPostIds = useMemo(() => {
        const set = new Set<string>();
        for (const t of effectiveTransactions) {
            if (t.status === 'pending' || t.status === 'requested') {
                set.add(t.postId);
            }
        }
        return set;
    }, [effectiveTransactions]);

    const myPendingTxPostIds = useMemo(() => {
        const set = new Set<string>();
        if (!effectiveIdentity) return set;
        for (const t of effectiveTransactions) {
            if ((t.status === 'pending' || t.status === 'requested') && (t.buyerPublicKey === effectiveIdentity.publicKey || t.sellerPublicKey === effectiveIdentity.publicKey)) {
                set.add(t.postId);
            }
        }
        return set;
    }, [effectiveTransactions, effectiveIdentity]);

    if (!visible || !effectiveIdentity) return null;

    const myPosts = effectivePosts.filter(p =>
        p.authorPublicKey === effectiveIdentity.publicKey ||
        p.acceptedBy === effectiveIdentity.publicKey ||
        myPendingTxPostIds.has(p.id)
    ).sort((a, b) => {
        if (a.status === 'pending' && b.status !== 'pending') return -1;
        if (b.status === 'pending' && a.status !== 'pending') return 1;
        if (a.status === 'active' && b.status !== 'active') return -1;
        if (b.status === 'active' && a.status !== 'active') return 1;
        return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
    });

    const pendingCount = effectiveTransactions.filter(t => t.status === 'pending' || t.status === 'requested').length;

    const getData = (): any[] => {
        if (dealsTab === 'active') return myPosts.filter(p => p.status === 'active' || (preview && p.authorPublicKey === effectiveIdentity.publicKey));
        if (dealsTab === 'pending') {
            return effectiveTransactions.filter(t => t.status === 'pending' || t.status === 'requested');
        }
        // History
        let txs = effectiveTransactions.filter(t => t.status === 'completed' || t.status === 'cancelled' || t.status === 'rejected');
        if (historyFilter === 'buying') txs = txs.filter(t => t.buyerPublicKey === effectiveIdentity.publicKey);
        if (historyFilter === 'selling') txs = txs.filter(t => t.sellerPublicKey === effectiveIdentity.publicKey);
        return txs;
    };

    const listData = getData();

    return (
        <>
            <div className="fixed inset-0 z-[100] flex items-end justify-center sm:items-center bg-black/40 backdrop-blur-sm animate-in fade-in duration-200" role="dialog" aria-modal="true" aria-labelledby="my-deals-title" onClick={onClose}>
                <div
                    ref={modalRef}
                    className="bg-white dark:bg-nature-950 w-full sm:w-[90vw] sm:max-w-2xl rounded-t-3xl sm:rounded-3xl shadow-2xl flex flex-col h-[85vh] sm:h-[80vh] animate-in slide-in-from-bottom-full sm:slide-in-from-bottom-10 duration-300"
                    onClick={e => e.stopPropagation()}
                >
                    {/* Handle bar (mobile) */}
                    <div className="w-10 h-1 rounded-full bg-nature-300 dark:bg-nature-700 mx-auto mt-3 sm:hidden" />

                    {/* Header */}
                    <div className="flex justify-between items-center px-6 py-4 border-b border-nature-100 dark:border-nature-800 shrink-0">
                        <h3 id="my-deals-title" className="text-xl font-black text-nature-900 dark:text-white">{t('My Deals')}</h3>
                        <button
                            ref={closeBtnRef}
                            onClick={onClose}
                            aria-label={t('Close My Deals')}
                            className="w-8 h-8 rounded-full bg-nature-100 dark:bg-nature-800 flex items-center justify-center text-nature-500 dark:text-nature-200 hover:bg-nature-200 dark:hover:bg-nature-700 transition-colors font-bold focus-visible:ring-2 focus-visible:ring-nature-500"
                        >
                            ✕
                        </button>
                    </div>

                {/* Tab bar */}
                <div className="px-4 pt-4 pb-3 border-b border-nature-100 dark:border-nature-800 shrink-0 bg-nature-50/50 dark:bg-nature-900/20">
                    <div className="flex bg-nature-100 dark:bg-nature-800 rounded-xl p-1 shadow-inner">
                        {[
                            { id: 'pending' as const, label: t('In Progress'), badge: pendingCount },
                            { id: 'active' as const, label: t('My Posts') },
                            { id: 'history' as const, label: t('History') },
                        ].map(tab => (
                            <button
                                key={tab.id}
                                onClick={() => setDealsTab(tab.id)}
                                className={`flex-1 flex gap-2 justify-center items-center py-2 text-sm font-bold rounded-lg transition-all ${
                                    dealsTab === tab.id
                                        ? 'bg-white dark:bg-nature-900 text-nature-900 dark:text-white shadow-sm'
                                        : 'text-nature-500 hover:text-nature-700 dark:text-nature-300 dark:hover:text-nature-300'
                                }`}
                            >
                                <span>{tab.label}</span>
                                {tab.badge && tab.badge > 0 ? (
                                    <span className="bg-bp-danger-fill text-bp-danger-on text-[10px] font-black px-1.5 py-0.5 rounded-full shadow-sm">
                                        {tab.badge}
                                    </span>
                                ) : null}
                            </button>
                        ))}
                    </div>

                    {/* History sub-filter */}
                    {dealsTab === 'history' && (
                        <div className="flex justify-center gap-2 mt-3">
                            {[{ id: 'all' as const, label: t('All') }, { id: 'buying' as const, label: t('Received') }, { id: 'selling' as const, label: t('Given') }].map(f => (
                                <button
                                    key={f.id}
                                    onClick={() => setHistoryFilter(f.id)}
                                    className={`px-3 py-1 text-xs font-bold rounded-full border transition-colors ${
                                        historyFilter === f.id
                                            ? 'bg-nature-800 dark:bg-nature-200 text-white dark:text-nature-900 border-nature-900 dark:border-nature-100'
                                            : 'bg-white dark:bg-nature-900 text-nature-600 dark:text-nature-400 border-nature-200 dark:border-nature-700 hover:bg-oat-50 dark:hover:bg-nature-800 dark:hover:text-nature-300'
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
                    {preview && (
                        <div data-testid="deals-preview-head" className="mb-4">
                            <LocalCommunityStrip
                                feature="escrow"
                                onNearYou={onNearYou ? () => { onClose(); onNearYou(); } : undefined}
                                onGuide={onGuide ? (slug) => { onClose(); onGuide(slug); } : undefined}
                            />
                            <SampleHeader />
                        </div>
                    )}
                    {listData.length === 0 ? (
                        <div className="flex flex-col items-center justify-center py-16 text-center">
                            <span className="text-5xl text-nature-400 dark:text-nature-600 mb-4">{dealsTab === 'history' ? '📜' : dealsTab === 'pending' ? '🤝' : '📋'}</span>
                            <h4 className="font-bold text-lg text-nature-900 dark:text-white mb-2">
                                {dealsTab === 'history' ? t('No history yet') : dealsTab === 'pending' ? t('No deals in progress') : t('No active posts')}
                            </h4>
                            <p className="text-nature-500 dark:text-nature-400 text-sm mb-6 max-w-xs">
                                {dealsTab === 'active'
                                    ? t('Post an offer or need to get started on the marketplace!')
                                    : dealsTab === 'pending'
                                    ? t('Accepted deals will appear here while they are held in trust.')
                                    : t('Completed or cancelled deals will show up here.')}
                            </p>
                            {dealsTab === 'active' && (
                                <button
                                    onClick={() => { onClose(); window.scrollTo({ top: 0, behavior: 'smooth' }); }}
                                    className="px-6 py-2.5 rounded-xl bg-bp-commit-fill hover:bg-bp-commit-hover text-bp-commit-on font-bold text-sm shadow-md transition-colors"
                                >
                                    {t('+ Create a Post')}
                                </button>
                            )}
                        </div>
                    ) : (
                        <div className="flex flex-col gap-3">
                            {listData.map((item: any) => {
                                // Transaction view (History + Pending)
                                if (dealsTab === 'history' || dealsTab === 'pending') {
                                    const isBuyer = item.buyerPublicKey === effectiveIdentity.publicKey;
                                    const isCompleted = item.status === 'completed';
                                    const isPending = item.status === 'pending';
                                    const isRequested = item.status === 'requested';
                                    const needsReview = isCompleted && ((isBuyer && !item.ratedByBuyer) || (!isBuyer && !item.ratedBySeller));
                                    const partnerCallsign = isBuyer ? item.sellerCallsign : item.buyerCallsign;

                                    return (
                                        <div
                                            key={item.id}
                                            data-testid={preview ? `sample-deal-${item.id}` : `deal-card-${item.id}`}
                                            role={preview || isPending || isRequested ? 'button' : undefined}
                                            tabIndex={preview || isPending || isRequested ? 0 : undefined}
                                            aria-label={preview ? `${item.postTitle}` : (isPending || isRequested ? `View deal: ${item.postTitle}` : undefined)}
                                            onKeyDown={(e) => {
                                                if (e.key === 'Enter' || e.key === ' ') {
                                                    e.preventDefault();
                                                    if (preview) {
                                                        openMark();
                                                    } else if ((isPending || isRequested) && onNavigateToPost) {
                                                        onClose();
                                                        onNavigateToPost(item.postId, item.id);
                                                    }
                                                }
                                            }}
                                            onClick={() => {
                                                if (preview) {
                                                    openMark();
                                                } else if ((isPending || isRequested) && onNavigateToPost) {
                                                    onClose();
                                                    onNavigateToPost(item.postId, item.id);
                                                }
                                            }}
                                            className={`bg-white dark:bg-nature-900 border rounded-2xl p-4 shadow-sm relative overflow-hidden transition-all ${
                                                preview ? 'cursor-pointer hover:shadow-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500 ' + (isRequested ? 'border-nature-300 dark:border-nature-700 bg-nature-50/50 dark:bg-nature-950/30' : isPending ? 'border-emerald-200 dark:border-emerald-800 bg-emerald-50/10 dark:bg-emerald-950/20' : 'border-nature-200 dark:border-nature-800')
                                                : isPending || isRequested ? 'border-emerald-200 dark:border-emerald-800 bg-emerald-50/10 dark:bg-emerald-950/20 cursor-pointer hover:border-emerald-400 hover:shadow-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500'
                                                : isCompleted ? 'border-nature-200 dark:border-nature-800'
                                                : 'border-nature-200/50 dark:border-nature-800/50 opacity-60 grayscale-[50%]'
                                            }`}
                                        >
                                            <div className="flex gap-3 mb-2">
                                                {item.coverImage ? (
                                                    <button
                                                        type="button"
                                                        onClick={(e) => {
                                                            e.stopPropagation();
                                                            openLightbox([item.coverImage!], item.postTitle, e.currentTarget);
                                                        }}
                                                        onKeyDown={photoKeyDown([item.coverImage!], item.postTitle)}
                                                        aria-label={`View enlarged photo: ${item.postTitle}`}
                                                        className="w-14 h-14 rounded-xl overflow-hidden border border-nature-100 dark:border-nature-800 shrink-0 cursor-zoom-in focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500"
                                                    >
                                                        <img src={listPhotoUrl(item.coverImage)} alt="Cover" className="w-full h-full object-cover" />
                                                    </button>
                                                ) : (
                                                    <div className="w-14 h-14 rounded-xl bg-nature-100 dark:bg-nature-800 flex items-center justify-center shrink-0">
                                                        <span className="text-xl text-nature-400 dark:text-nature-500">{isBuyer ? '🛒' : '🏷️'}</span>
                                                    </div>
                                                )}
                                                <div className="flex-1 min-w-0">
                                                    <div className="flex justify-between items-start mb-1">
                                                        <div className="flex items-center gap-2">
                                                            <span className={`text-[9px] font-black uppercase tracking-wider px-2 py-0.5 rounded-md ${
                                                                isCompleted ? 'bg-bp-chip-ok-tint text-bp-chip-ok-ink'
                                                                : isRequested ? 'bg-bp-chip-warn-tint text-bp-chip-warn-ink'
                                                                : isPending ? 'bg-bp-chip-ok-tint text-bp-chip-ok-ink'
                                                                : 'bg-nature-200 text-nature-700 dark:bg-nature-800 dark:text-nature-300'
                                                            }`}>
                                                                {isRequested ? t('Action Required') : isPending ? t('Held in trust') : item.status}
                                                            </span>
                                                            <span className="text-[10px] text-nature-400 font-bold">
                                                                {new Date(item.createdAt).toLocaleDateString()}
                                                            </span>
                                                        </div>
                                                        <div className="flex items-center">
                                                            <span className={`font-black text-sm ${isBuyer ? 'text-bp-ink-danger' : 'text-emerald-500 dark:text-emerald-400'}`}>
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

                                            {/* Per-state detail and action in preview */}
                                            {preview && isRequested && (
                                                <div className="mt-3" data-testid="sample-deal-line">
                                                    <p className="mb-2 text-sm text-nature-600 dark:text-nature-300">{t('A neighbour offered to do this. Approve to hold the Beans safely.')}</p>
                                                    <LocalCommunityAction
                                                        feature="escrow"
                                                        label={t('Approve and hold in trust')}
                                                        className="w-full text-xs"
                                                        onNearYou={onNearYou ? () => { onClose(); onNearYou(); } : undefined}
                                                        onGuide={onGuide ? (slug) => { onClose(); onGuide(slug); } : undefined}
                                                    />
                                                </div>
                                            )}

                                            {preview && isPending && (
                                                <div className="mt-3" data-testid="sample-deal-line">
                                                    <p className="mb-2 text-sm text-nature-600 dark:text-nature-300">{t('Held in trust until the job is done.')}</p>
                                                    <LocalCommunityAction
                                                        feature="escrow"
                                                        label={t('Approve and release')}
                                                        className="w-full text-xs"
                                                        onNearYou={onNearYou ? () => { onClose(); onNearYou(); } : undefined}
                                                        onGuide={onGuide ? (slug) => { onClose(); onGuide(slug); } : undefined}
                                                    />
                                                </div>
                                            )}

                                            {/* Bottom row (History / local reviews) */}
                                            {(dealsTab === 'history' || (!preview && needsReview)) && (
                                                <div className="flex justify-between items-end mt-2">
                                                    <p className="text-[11px] text-nature-500 dark:text-nature-400 font-medium">
                                                        {isBuyer ? t('Bought from {who}', { who: partnerCallsign }) : t('Sold to {who}', { who: partnerCallsign })}
                                                    </p>
                                                    {preview && isCompleted ? (
                                                        <div data-testid="sample-deal-line">
                                                            <LocalCommunityAction
                                                                feature="escrow"
                                                                label={t('Leave Review')}
                                                                className="text-xs py-1.5 px-3"
                                                                onNearYou={onNearYou ? () => { onClose(); onNearYou(); } : undefined}
                                                                onGuide={onGuide ? (slug) => { onClose(); onGuide(slug); } : undefined}
                                                            />
                                                        </div>
                                                    ) : needsReview && onPromptReview ? (
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
                                                            className="px-3 py-1.5 bg-bp-chip-warn-tint hover:bg-bp-chip-warn-tint/80 text-bp-chip-warn-ink text-xs font-bold rounded-lg border border-bp-chip-warn-ink/20 transition-colors shadow-sm"
                                                        >
                                                            {t('Leave Review')}
                                                        </button>
                                                    ) : null}
                                                </div>
                                            )}
                                        </div>
                                    );
                                }

                                // Active Posts View
                                const coverImage = item.photos && item.photos.length > 0 ? item.photos[0] : null;
                                const relatedTx = activeTxsByPostId.get(item.id)?.[0];
                                let displayStatusText = t('Active');
                                let isActionRequired = false;
                                if (item.status === 'pending' || relatedTx?.status === 'pending') {
                                    displayStatusText = t('Held in trust');
                                } else if (relatedTx?.status === 'requested') {
                                    if (item.authorPublicKey === effectiveIdentity?.publicKey) {
                                        displayStatusText = t('Action Required');
                                        isActionRequired = true;
                                    } else {
                                        displayStatusText = t('Awaiting Approval');
                                    }
                                }

                                return (
                                    <div
                                        key={item.id}
                                        data-testid={preview ? `sample-deal-${item.id}` : `deal-card-${item.id}`}
                                        role="button"
                                        tabIndex={0}
                                        aria-label={`View post: ${item.title}`}
                                        onKeyDown={(e) => {
                                            if (e.key === 'Enter' || e.key === ' ') {
                                                e.preventDefault();
                                                if (preview) {
                                                    openMark();
                                                } else if (onNavigateToPost) {
                                                    onClose();
                                                    onNavigateToPost(item.id);
                                                }
                                            }
                                        }}
                                        onClick={() => {
                                            if (preview) {
                                                openMark();
                                            } else if (onNavigateToPost) {
                                                onClose();
                                                onNavigateToPost(item.id);
                                            }
                                        }}
                                        className={`bg-white dark:bg-nature-900 border rounded-2xl p-4 shadow-sm cursor-pointer hover:shadow-md transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 ${
                                            isActionRequired
                                                ? 'border-nature-300 dark:border-nature-700 bg-nature-50/50 dark:bg-nature-950/30'
                                                : item.status === 'pending' || relatedTx?.status === 'pending'
                                                ? 'bg-emerald-50/10 dark:bg-emerald-950/20 border-emerald-200 dark:border-emerald-800'
                                                : 'border-nature-200 dark:border-nature-800'
                                        }`}
                                    >
                                        <div className="flex gap-4">
                                            {coverImage ? (
                                                <button
                                                    type="button"
                                                    onClick={(e) => {
                                                        e.stopPropagation();
                                                        openLightbox(item.photos || [coverImage], item.title, e.currentTarget);
                                                    }}
                                                    onKeyDown={photoKeyDown(item.photos || [coverImage], item.title)}
                                                    aria-label={`View enlarged photo: ${item.title}`}
                                                    className="w-14 h-14 rounded-xl overflow-hidden border border-nature-100 dark:border-nature-800 shrink-0 cursor-zoom-in focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500"
                                                >
                                                    <img src={listPhotoUrl(coverImage)} alt="Cover" className="w-full h-full object-cover" />
                                                </button>
                                            ) : (
                                                <div className="w-14 h-14 rounded-xl bg-nature-100 dark:bg-nature-800 flex items-center justify-center shrink-0">
                                                    <span className="text-xl text-nature-400 dark:text-nature-500">📦</span>
                                                </div>
                                            )}
                                            <div className="flex-1 min-w-0 flex flex-col justify-center">
                                                <div className="flex justify-between items-start mb-1">
                                                    <span className={`text-[9px] font-black uppercase tracking-wider px-2 py-0.5 rounded-md ${
                                                        item.type === 'offer' ? 'bg-bp-chip-ok-tint text-bp-chip-ok-ink'
                                                        : 'bg-bp-chip-need-tint text-bp-chip-need-ink'
                                                    }`}>
                                                        {item.type}
                                                    </span>
                                                    <div className="flex items-center">
                                                        <span className="font-black text-sm text-indigo-500 dark:text-indigo-300">
                                                            {item.credits ?? '?'}
                                                        </span>
                                                        <img src="/assets/bean.png" className="w-3.5 h-3.5 ml-1" alt="B" />
                                                    </div>
                                                </div>
                                                <h4 className="font-bold text-nature-950 dark:text-white text-[15px] truncate mb-1">
                                                    {item.title}
                                                </h4>
                                                <p className={`text-[11px] font-bold uppercase tracking-wide ${isActionRequired ? 'text-bp-ink-warning' : 'text-nature-500 dark:text-nature-400'}`}>
                                                    {isActionRequired ? `⚠️ ${displayStatusText}` : (item.status === 'pending' || relatedTx?.status === 'pending') ? `🤝 ${displayStatusText}` : `🟢 ${displayStatusText}`}
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
            {lightboxState?.isOpen && (
                <ImageLightbox
                    isOpen={lightboxState.isOpen}
                    photos={lightboxState.photos}
                    initialIndex={lightboxState.initialIndex}
                    title={lightboxState.title}
                    triggerElement={lightboxState.triggerElement}
                    onClose={() => setLightboxState(null)}
                />
            )}
            {sheetShown === 'sheet' && (
                <LocalCommunitySheet
                    feature="escrow"
                    onClose={closeMark}
                    onStart={() => setSheetShown('start')}
                    onNearYou={onNearYou ? () => { onClose(); onNearYou(); } : undefined}
                    onGuide={onGuide ? (slug) => { onClose(); onGuide(slug); } : undefined}
                />
            )}
            {sheetShown === 'start' && (
                <StartCommunityScreen
                    onClose={closeMark}
                    onNearYou={onNearYou ? () => { onClose(); onNearYou(); } : undefined}
                />
            )}
        </>
    );
}
