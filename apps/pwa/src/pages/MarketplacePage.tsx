/**
 * MarketplacePage — Browse & Post Needs & Offers
 *
 * Fetches real posts from the BeanPool Node API.
 * Users can create new posts and filter by type/category.
 * Tapping a post opens a full detail view.
 */

import { useState, useEffect, useCallback } from 'react';
import { MARKETPLACE_CATEGORIES, POST_TYPE_COLORS, type PostType } from '../lib/marketplace';
import { MarketplaceCard } from '../components/MarketplaceCard';
import { CategoryPickerModal } from '../components/CategoryPickerModal';
import { MyDealsModal } from '../components/MyDealsModal';
import { lazy, Suspense } from 'react';
const RadiusPickerPage = lazy(() => import('../components/RadiusPickerPage').then(m => ({ default: m.RadiusPickerPage })));
import { haversineDistance, loadRadiusSettings, saveRadiusSettings, clearRadiusSettings, type RadiusSettings } from '../lib/geo';
import { loadEnabledPeers, togglePeer } from '../lib/peer-prefs';
import {
    getMarketplacePosts, removeMarketplacePost, updateMarketplacePost, pauseMarketplacePost, resumeMarketplacePost,
    getMemberProfile, createConversationApi, sendTransfer,
    submitRating, getMemberRatings, reportAbuse, getRatingsGiven,
    getNodeInfo, getRemotePosts, sendRemoteTransfer, sendFederationMessage,
    acceptMarketplacePost, completeMarketplaceTransaction, getBalance,
    cancelMarketplaceTransaction, getMyMarketplaceTransactions, getNodeConfig,
    requestMarketplacePost, approveMarketplaceRequest, rejectMarketplaceRequest, cancelMarketplaceRequest,
    getMembers,
    type MarketplacePost, type MemberProfile, type NodeInfo, type MarketplaceTransaction, type NodeConfig,
} from '../lib/api';
import { type BeanPoolIdentity } from '../lib/identity';

import { matchesExpandedSearch } from '../lib/search';

interface Props {
    identity: BeanPoolIdentity | null;
    marketClickCount?: number;
    openPostId?: string | null;
    onPostOpened?: () => void;
    onNavigate?: (tab: string, conversationId?: string) => void;
    onOpenProfile?: (pubkey: string) => void;
}

// Turn a server trade-gate rejection into a friendly message. The covenant / contribution /
// holiday gates carry a stable "PREFIX: <human text>"; strip the prefix for a clean alert.
function explainTradeError(err: unknown): string {
    const raw = err instanceof Error ? err.message : String(err);
    // Offer covenant, banded (Trust Model v3): server sends "FLOOR_LOCKED:live:need:unlockedAt:wouldReach: <sentence>".
    // The sentence is already user-ready with the exact numbers — surface it verbatim.
    if (raw.startsWith('FLOOR_LOCKED')) {
        return `🎣 ${raw.replace(/^FLOOR_LOCKED(:\d+){4}:\s*/, '')}`;
    }
    if (raw.startsWith('COVENANT_REQUIRED')) {
        return '🎣 Post an Offer first — to spend on community credit (take your balance negative) you need at least one active Offer posted, so others can trade with you in return.';
    }
    if (raw.startsWith('CONTRIBUTION_REQUIRED')) {
        return 'List at least one Offer of your own before you can request or accept from others.';
    }
    if (raw.startsWith('HOLIDAY_MODE')) {
        return '🌴 Holiday mode is on — turn it off in Settings before trading.';
    }
    return raw.replace(/^[A-Z_]+:\s*/, '');
}

export function MarketplacePage({ identity, marketClickCount = 0, openPostId, onPostOpened, onNavigate, onOpenProfile }: Props) {
    const [posts, setPosts] = useState<MarketplacePost[]>([]);
    const [typeFilter, setTypeFilter] = useState<PostType | 'all' | 'for-you'>('all');
    const [foundingOnly, setFoundingOnly] = useState(false); // show only newcomers needing a founding trade
    const [categoryFilter, setCategoryFilter] = useState<string | 'all'>('all');
    const [loading, setLoading] = useState(true);

    const [favCategories, setFavCategories] = useState<string[]>(() => {
        try {
            const val = localStorage.getItem('bp_fav_categories');
            return val ? JSON.parse(val) : [];
        } catch {
            return [];
        }
    });

    const [isCustomizerExpanded, setIsCustomizerExpanded] = useState<boolean>(() => {
        try {
            const val = localStorage.getItem('bp_fav_categories');
            const parsed = val ? JSON.parse(val) : [];
            return parsed.length === 0;
        } catch {
            return true;
        }
    });

    const toggleFavCategory = (catId: string) => {
        const updated = favCategories.includes(catId)
            ? favCategories.filter(c => c !== catId)
            : [...favCategories, catId];
        setFavCategories(updated);
        try {
            localStorage.setItem('bp_fav_categories', JSON.stringify(updated));
        } catch (e) {
            console.error(e);
        }
    };
    const [deleting, setDeleting] = useState<string | null>(null);
    const [toggling, setToggling] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [searchQuery, setSearchQuery] = useState('');

    // Federation — multi-toggle (home always on, peers toggled independently)
    const [peerNodes, setPeerNodes] = useState<{ callsign: string; publicUrl: string }[]>([]);
    const [enabledPeers, setEnabledPeers] = useState<Set<string>>(() => loadEnabledPeers());

    // Radius filter
    const [radiusSettings, setRadiusSettings] = useState<RadiusSettings | null>(() => loadRadiusSettings());
    const [showRadiusPicker, setShowRadiusPicker] = useState(false);
    const [nodeConfig, setNodeConfig] = useState<NodeConfig | null>(null);

    // Fetch config once on mount
    useEffect(() => {
        getNodeConfig().then(setNodeConfig).catch(console.error);
    }, []);

    // Layout configuration
    const [viewMode, setViewMode] = useState<'grid' | 'list' | 'compact'>('list');
    const [showFilters, setShowFilters] = useState(false);
    const [showCategoryPicker, setShowCategoryPicker] = useState(false);
    const [showDealsModal, setShowDealsModal] = useState(false);
    const [dealsInitialTab, setDealsInitialTab] = useState<'active' | 'pending' | 'history'>('pending');

    // Detail view
    const [selectedPost, setSelectedPost] = useState<MarketplacePost | null>(null);
    const [selectedTxId, setSelectedTxId] = useState<string | null>(null);

    // Reset detail view when bottom tab is double-tapped
    useEffect(() => {
        if (marketClickCount > 0) {
            setSelectedPost(null);
            setSelectedTxId(null);
        }
    }, [marketClickCount]);

    // Handle deep-link from Map pins or routes
    useEffect(() => {
        if (openPostId === 'deals_active') {
             setShowDealsModal(true);
             setDealsInitialTab('pending');
             onPostOpened?.();
        } else if (openPostId && posts.length > 0) {
            const found = posts.find(p => p.id === openPostId);
            if (found) {
                setSelectedPost(found);
                // Note: deep-link doesn't set txId yet in MVP, requires manual navigation into Deals
                onPostOpened?.();
            }
        }
    }, [openPostId, posts, onPostOpened]);

    const [authorProfile, setAuthorProfile] = useState<MemberProfile | null>(null);
    const [loadingProfile, setLoadingProfile] = useState(false);
    const [messaging, setMessaging] = useState(false);

    // Ratings
    const [authorAvgRating, setAuthorAvgRating] = useState<{ average: number; count: number; asProvider?: { average: number; count: number }; asReceiver?: { average: number; count: number } }>({ average: 0, count: 0 });
    const [myRating, setMyRating] = useState(0);
    const [ratingComment, setRatingComment] = useState('');
    const [showRatingForm, setShowRatingForm] = useState(false);
    const [submittingRating, setSubmittingRating] = useState(false);
    const [hasExistingRating, setHasExistingRating] = useState(false);

    // Report
    const [showReportForm, setShowReportForm] = useState(false);
    const [reportReason, setReportReason] = useState('');
    const [submittingReport, setSubmittingReport] = useState(false);



    // Accept/Fulfill
    const [accepting, setAccepting] = useState(false);

    // Edit mode
    const [editMode, setEditMode] = useState(false);
    const [editType, setEditType] = useState<'offer' | 'need'>('offer');
    const [editCategory, setEditCategory] = useState('other');
    const [editTitle, setEditTitle] = useState('');
    const [editDescription, setEditDescription] = useState('');
    const [editCredits, setEditCredits] = useState(0);
    const [editPriceType, setEditPriceType] = useState<'fixed' | 'hourly' | 'daily' | 'weekly' | 'monthly'>('fixed');
    const [editRepeatable, setEditRepeatable] = useState(false);
    const [editPhotos, setEditPhotos] = useState<string[]>([]);
    const [saving, setSaving] = useState(false);

    // Accept & Complete Inline Forms
    const [showAcceptConfirm, setShowAcceptConfirm] = useState(false);
    // Contribution-first gate: accepting an Offer requires having listed one.
    const [blockedFromTrading, setBlockedFromTrading] = useState(false);
    const [showContributionRequired, setShowContributionRequired] = useState(false);
    const [acceptHours, setAcceptHours] = useState('1');
    const [showCompleteConfirm, setShowCompleteConfirm] = useState(false);
    const [completeHours, setCompleteHours] = useState('');

    // Requests Dashboard
    const [requests, setRequests] = useState<MarketplaceTransaction[]>([]);

    // Active Deals Segment Toggle
    const [activeTab, setActiveTab] = useState<'feed' | 'deals'>('feed');
    // Global requests waiting for the current user's approval
    const [globalRequests, setGlobalRequests] = useState<MarketplaceTransaction[]>([]);
    const [myTransactions, setMyTransactions] = useState<MarketplaceTransaction[]>([]);

    const myMarketPosts = posts.filter(p => 
        identity && 
        (
            p.authorPublicKey === identity.publicKey || 
            (p as any).acceptedBy === identity.publicKey ||
            myTransactions.some(t => t.postId === p.id && t.status === 'pending' && (t.buyerPublicKey === identity.publicKey || t.sellerPublicKey === identity.publicKey))
        )
    ).sort((a, b) => {
        if (a.status === 'pending' && b.status !== 'pending') return -1;
        if (b.status === 'pending' && a.status !== 'pending') return 1;
        if (a.status === 'active' && b.status !== 'active') return -1;
        if (b.status === 'active' && a.status !== 'active') return 1;
        return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
    });

    const [dealsTab, setDealsTab] = useState<'active' | 'pending' | 'history'>('active');
    const [historyFilter, setHistoryFilter] = useState<'all' | 'buying' | 'selling'>('all');
    const [promptReviewForTx, setPromptReviewForTx] = useState<{ txId: string; targetPubkey: string; targetCallsign: string; targetRole: 'provider' | 'receiver' } | null>(null);
    const [reviewStars, setReviewStars] = useState(5);
    const [reviewComment, setReviewComment] = useState('');
    const [submittingReview, setSubmittingReview] = useState(false);

    const pendingDealsCount = globalRequests.length + myTransactions.filter(t => t.status === 'pending').length;

    // Author ratings cache for tiles
    const [authorRatingsCache, setAuthorRatingsCache] = useState<Record<string, { average: number; count: number }>>({}); 

    // Author avatar cache for tiles
    const [authorAvatarCache, setAuthorAvatarCache] = useState<Record<string, string | null>>({});

    const refresh = useCallback(async () => {
        try {
            const filter: any = {};
            if (typeFilter !== 'all' && typeFilter !== 'for-you') filter.type = typeFilter;
            if (categoryFilter !== 'all') filter.category = categoryFilter;

            // Always fetch home node + global requests
            const [homeData, myTxs] = await Promise.all([
                getMarketplacePosts(filter),
                identity ? getMyMarketplaceTransactions(identity.publicKey).catch(() => []) : Promise.resolve([])
            ]);
            
            setMyTransactions(myTxs);
            setGlobalRequests(myTxs.filter(t => t.buyerPublicKey === identity?.publicKey && t.status === 'requested'));

            let allPosts: MarketplacePost[] = [...homeData];

            // Fetch from all enabled peer nodes in parallel
            if (enabledPeers.size > 0) {
                const peerResults = await Promise.allSettled(
                    [...enabledPeers].map(async (peerUrl) => {
                        const data = await getRemotePosts(peerUrl, filter);
                        return data.map(p => ({ ...p, _remoteNode: peerUrl }));
                    })
                );
                for (const result of peerResults) {
                    if (result.status === 'fulfilled') allPosts = allPosts.concat(result.value);
                }
            }

            setPosts(allPosts);
            setError(null);
        } catch (e: any) {
            setError(e.message || 'Failed to load');
        } finally {
            setLoading(false);
        }
    }, [typeFilter, categoryFilter, enabledPeers, identity]);

    // Fetch peer nodes on mount
    useEffect(() => {
        getNodeInfo('').then(info => {
            const peers = info.peerNodes
                .filter((p): p is { callsign: string; publicUrl: string } => !!p.publicUrl);
            setPeerNodes(peers);
        }).catch(() => {});
    }, []);

    // Track whether the viewer still needs to list an Offer (Gate 1).
    useEffect(() => {
        if (!identity) return;
        let cancelled = false;
        getBalance(identity.publicKey)
            .then(b => { if (!cancelled) setBlockedFromTrading(!!b.isBlockedFromTrading); })
            .catch(() => {});
        return () => { cancelled = true; };
    }, [identity]);

    useEffect(() => {
        refresh();
        const interval = setInterval(refresh, 15_000);
        return () => clearInterval(interval);
    }, [refresh]);

    // Fetch ratings for all unique post authors
    useEffect(() => {
        if (posts.length === 0) return;
        const uniqueAuthors = [...new Set(posts.map(p => p.authorPublicKey))];
        Promise.all(
            uniqueAuthors.map(pk =>
                getMemberRatings(pk)
                    .then(r => [pk, { average: r.average, count: r.count }] as const)
                    .catch(() => [pk, { average: 0, count: 0 }] as const)
            )
        ).then(results => {
            const cache: Record<string, { average: number; count: number }> = {};
            for (const [pk, rating] of results) cache[pk] = rating;
            setAuthorRatingsCache(cache);
        });
    }, [posts]);

    // Fetch avatar cache from members list
    useEffect(() => {
        getMembers()
            .then(members => {
                const cache: Record<string, string | null> = {};
                for (const m of members) {
                    if (m.avatarUrl) cache[m.publicKey] = m.avatarUrl;
                }
                setAuthorAvatarCache(cache);
            })
            .catch(() => {});
    }, []);

    // Load author profile + ratings when detail view opens
    useEffect(() => {
        if (!selectedPost) return;
        setLoadingProfile(true);
        setAuthorProfile(null);
        setAuthorAvgRating({ average: 0, count: 0 });
        setMyRating(0);
        setRatingComment('');
        setShowRatingForm(false);
        setShowReportForm(false);
        setReportReason('');
        getMemberProfile(selectedPost.authorPublicKey, identity?.publicKey)
            .then(p => setAuthorProfile(p))
            .catch(() => setAuthorProfile(null))
            .finally(() => setLoadingProfile(false));
        getMemberRatings(selectedPost.authorPublicKey)
            .then(r => setAuthorAvgRating({ average: r.average, count: r.count, asProvider: r.asProvider, asReceiver: r.asReceiver }))
            .catch(() => {});
        
        setHasExistingRating(false);
        if (identity && selectedPost.pendingTransactionId) {
            getRatingsGiven(identity.publicKey)
                .then(res => {
                    const existing = res.ratings.find(r => r.transactionId === selectedPost.pendingTransactionId);
                    if (existing) {
                        setMyRating(existing.stars);
                        setRatingComment(existing.comment || '');
                        setHasExistingRating(true);
                    }
                })
                .catch(err => console.error('[MarketplacePage] Failed to fetch given ratings:', err));
        }
        
        // Fetch requests if this is a Need
        if (selectedPost.type === 'need') {
            getMyMarketplaceTransactions(identity?.publicKey || '')
                .then(async txs => {
                    const filtered = txs.filter(t => t.postId === selectedPost.id && t.status === 'requested');
                    const enriched = await Promise.all(filtered.map(async req => {
                        try {
                            // For needs, the author is the buyer, so the requester is the seller
                            const r = await getMemberRatings(req.sellerPublicKey);
                            return { ...req, bidderRating: r };
                        } catch(e) { return { ...req, bidderRating: { average: 0, count: 0 } }; }
                    }));
                    setRequests(enriched);
                })
                .catch(() => setRequests([]));
        } else {
            setRequests([]);
        }
    }, [selectedPost?.id, identity?.publicKey]);

    async function handleMessageAuthor() {
        if (!identity || !selectedPost) return;
        setMessaging(true);
        try {
            const remoteNode = (selectedPost as any)._remoteNode;
            if (remoteNode) {
                // Remote post — relay via federation
                const result = await sendFederationMessage(
                    remoteNode,
                    identity.publicKey,
                    identity.callsign || 'Anonymous',
                    selectedPost.authorPublicKey,
                    `Hi! I'm interested in your post: "${selectedPost.title}"`,
                    'plaintext',  // nonce placeholder for unencrypted federation msgs
                );
                if (result.conversationId && onNavigate) {
                    onNavigate('messages', result.conversationId);
                }
            } else {
                // Local post — existing flow
                const result = await createConversationApi(
                    'dm',
                    [identity.publicKey, selectedPost.authorPublicKey],
                    identity.publicKey,
                    undefined,
                    selectedPost.id
                );
                if (onNavigate) onNavigate('messages', result.conversation.id);
            }
        } catch (e: any) {
            setError(e.message || 'Failed to start conversation');
        } finally {
            setMessaging(false);
        }
    }

    const inputStyle: React.CSSProperties = {
        width: '100%', padding: '0.5rem', background: 'var(--bg-secondary)',
        border: '1px solid var(--border-primary)', borderRadius: '8px', color: 'var(--text-primary)',
        fontSize: '0.85rem', marginBottom: '0.5rem', fontFamily: 'inherit',
        boxSizing: 'border-box',
    };

    // =================== DETAIL VIEW ===================
    if (selectedPost) {
        const cat = MARKETPLACE_CATEGORIES.find(c => c.id === selectedPost.category);
        const typeColor = POST_TYPE_COLORS[selectedPost.type];
        const postedDate = new Date(selectedPost.createdAt);
        const ago = getTimeAgo(postedDate);
        const isOwnPost = identity?.publicKey === selectedPost.authorPublicKey;
        
        const activeTx = selectedTxId 
            ? myTransactions.find(t => t.id === selectedTxId)
            : myTransactions.find(t => t.postId === selectedPost.id && t.status === 'pending' && (!isOwnPost ? (t.buyerPublicKey === identity?.publicKey || t.sellerPublicKey === identity?.publicKey) : true));
            
        // --- Escrow Roles ---
        const isAcceptedByMe = activeTx 
            ? (activeTx.buyerPublicKey === identity?.publicKey || activeTx.sellerPublicKey === identity?.publicKey) && !isOwnPost
            : (identity?.publicKey === (selectedPost as any).acceptedBy);
        const isPayer = activeTx
            ? activeTx.buyerPublicKey === identity?.publicKey
            : ((selectedPost.type === 'offer' && isAcceptedByMe) || (selectedPost.type === 'need' && isOwnPost));
        const isPayee = activeTx
            ? activeTx.sellerPublicKey === identity?.publicKey
            : ((selectedPost.type === 'offer' && isOwnPost) || (selectedPost.type === 'need' && isAcceptedByMe));
        const targetPeerCallsign = activeTx 
            ? (isPayer ? activeTx.sellerCallsign || 'Peer' : activeTx.buyerCallsign || 'Peer')
            : (isOwnPost ? ((selectedPost as any).acceptedByCallsign || 'Peer') : selectedPost.authorCallsign);

        return (
            <div className="p-4 max-w-lg mx-auto pb-24">
                {/* Back Button */}
                <button
                    onClick={() => {
                        setSelectedPost(null);
                        setSelectedTxId(null);
                        setEditMode(false);
                        setEditPhotos([]);
                    }}
                    className="mb-4 flex items-center gap-2 text-nature-500 hover:text-nature-700 font-bold transition-colors"
                >
                    <span className="text-xl leading-none">←</span> Back to Market
                </button>
                
                {/* Post card */}
                <div className="bg-white dark:bg-nature-950 rounded-2xl border border-nature-200 dark:border-nature-800 shadow-soft overflow-hidden mb-4">
                    {/* Type + category header */}
                    <div 
                        className="flex justify-between items-center px-4 py-3 border-b"
                        style={{ backgroundColor: `${typeColor}15`, borderBottomColor: `${typeColor}30` }}
                    >
                        <div className="flex items-center gap-2">
                            <span className="text-2xl">{cat?.emoji ?? '🌐'}</span>
                            <span 
                                className="text-xs font-black uppercase tracking-wider"
                                style={{ color: typeColor }}
                            >
                                {selectedPost.type === 'offer' ? '🔵 Offer' : '🟠 Need'} <span className="text-nature-400 font-medium">·</span> {cat?.label ?? selectedPost.category}
                            </span>
                        </div>
                        <span className="text-xs font-semibold text-nature-500">{ago}</span>
                    </div>

                    {/* Content */}
                    <div className="p-5">
                        <h2 className="text-xl font-bold text-nature-950 dark:text-white mb-3 leading-tight">
                            {selectedPost.title}
                        </h2>

                        {selectedPost.description && (
                            <p className="text-base text-nature-600 leading-relaxed mb-5 whitespace-pre-wrap">
                                {selectedPost.description}
                            </p>
                        )}

                        {/* Photos */}
                        {selectedPost.photos && selectedPost.photos.length > 0 && (
                            <div className="flex gap-2 overflow-x-auto mb-5 pb-2 snap-x">
                                {selectedPost.photos.map((photo, i) => (
                                    <img
                                        key={i}
                                        src={photo}
                                        alt={`photo ${i+1}`}
                                        className="h-40 w-auto rounded-xl object-cover border border-nature-200 shrink-0 snap-start shadow-sm"
                                    />
                                ))}
                            </div>
                        )}

                        {/* Credits */}
                        <div className="bg-oat-50 dark:bg-nature-900 rounded-xl p-4 text-center border border-nature-100 dark:border-nature-800 shadow-inner block">
                            <span className="text-xs font-bold text-nature-500 dark:text-nature-400 uppercase tracking-widest block mb-1">
                                {selectedPost.type === 'offer' ? 'Asking Price' : 'Willing to Pay'}
                            </span>
                            <div className="text-3xl font-bold text-nature-900 dark:text-white font-mono tracking-tight" style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', flexWrap: 'nowrap' }}>
                                <span>{selectedPost.credits}</span>
                                <span className="text-xl text-nature-400 font-sans font-medium flex items-center" style={{ flexShrink: 0 }}>
                                    <img src="/assets/bean.png" style={{ width: '20px', height: '20px', marginLeft: '4px', marginRight: '2px', flexShrink: 0 }} alt="B" />
                                    {{ fixed: '', hourly: '/Hr', daily: '/Dy', weekly: '/Wk', monthly: '/Mo' }[selectedPost.priceType] || ''}
                                </span>
                            </div>
                            {selectedPost.credits > 0 && (
                                <p className="text-nature-400 text-xs mt-1 font-mono">
                                    ≈ {(selectedPost.credits / 40).toFixed(1)} hrs
                                </p>
                            )}
                        </div>
                    </div>
                </div>

                {/* Author section */}
                <div className="bg-white dark:bg-nature-950 rounded-2xl border border-nature-200 dark:border-nature-800 p-4 shadow-sm mb-4">
                    <p className="text-[0.65rem] text-nature-400 dark:text-nature-500 font-bold uppercase tracking-widest mb-3">
                        Posted by
                    </p>
                    <button 
                        onClick={() => { if (onOpenProfile) onOpenProfile(selectedPost.authorPublicKey); }}
                        className="flex items-start gap-4 text-left w-full hover:bg-oat-50/50 dark:hover:bg-black/20 p-2 -ml-2 rounded-xl transition-colors"
                    >
                        {/* Avatar */}
                        {loadingProfile ? (
                            <div className="w-14 h-14 rounded-full bg-nature-100 animate-pulse shrink-0" />
                        ) : authorProfile?.avatar ? (
                            <img
                                src={authorProfile.avatar}
                                alt="avatar"
                                className="w-14 h-14 rounded-full object-cover border-2 border-white shadow-sm shrink-0"
                            />
                        ) : (
                            <div className="w-14 h-14 rounded-full bg-terra-100 border-2 border-white shadow-sm flex items-center justify-center text-terra-600 font-bold text-xl shrink-0">
                                {selectedPost.authorCallsign.charAt(0).toUpperCase()}
                            </div>
                        )}
                        <div className="flex-1 min-w-0">
                            <p className="font-bold text-lg text-nature-950 dark:text-white mb-0.5 truncate flex items-center gap-1.5">
                                <span className="text-base text-amber-600">🤝</span> {selectedPost.authorCallsign}
                            </p>
                            {/* Star rating */}
                            <p className="text-amber-500 text-sm mb-1.5 flex items-center flex-wrap gap-1">
                                {'★'.repeat(Math.round(authorAvgRating.average))}{'☆'.repeat(5 - Math.round(authorAvgRating.average))}
                                <span className="text-nature-500 text-xs ml-1 font-medium">
                                    {authorAvgRating.count > 0 ? (
                                        <>
                                            {`${authorAvgRating.average.toFixed(1)} (${authorAvgRating.count})`}
                                            {authorAvgRating.asProvider && authorAvgRating.asProvider.count > 0 && (
                                                <span className="ml-2 text-[0.65rem] bg-amber-50 px-1.5 py-0.5 rounded text-amber-700">
                                                    📤 {authorAvgRating.asProvider.average.toFixed(1)}
                                                </span>
                                            )}
                                            {authorAvgRating.asReceiver && authorAvgRating.asReceiver.count > 0 && (
                                                <span className="ml-1 text-[0.65rem] bg-indigo-50 px-1.5 py-0.5 rounded text-indigo-700">
                                                    📥 {authorAvgRating.asReceiver.average.toFixed(1)}
                                                </span>
                                            )}
                                        </>
                                    ) : 'No ratings yet'}
                                </span>
                            </p>
                            {authorProfile?.bio && (
                                <p className="text-sm text-nature-600 leading-snug mb-0">
                                    {authorProfile.bio}
                                </p>
                            )}
                            {authorProfile?.contact && authorProfile.contact.visibility !== 'hidden' && (
                                <p className="text-xs text-nature-500 mt-2 font-medium bg-oat-50 px-2 py-1 rounded-lg inline-block border border-nature-100">
                                    📧 {authorProfile.contact.value}
                                </p>
                            )}
                        </div>
                    </button>
                </div>

                 {/* Action buttons */}
                 
                 {/* 1. Pending Trust Hold State (Applies to both Payer and Payee) */}
                 {selectedPost.status === 'pending' && (isPayer || isPayee) && (
                     <div className="flex flex-col gap-2 mt-4">
                         {isPayer ? (
                             <>
                                 <p className="text-emerald-600 dark:text-emerald-400 text-sm font-bold text-center mb-1">
                                     ✅ Action Required: Release Credits
                                 </p>
                                 <p className="text-xs text-nature-500 text-center mb-2 px-4 shadow-sm">
                                     You are the Payer. Once {targetPeerCallsign} has fulfilled the terms, release the funds held in trust to complete the transaction.
                                 </p>
                                 
                                 {showCompleteConfirm ? (
                                     <div className="bg-emerald-50 dark:bg-emerald-950/30 border border-emerald-200 dark:border-emerald-800 rounded-xl p-4 shadow-inner mt-2">
                                         <p className="font-bold text-emerald-900 dark:text-emerald-400 mb-2 text-center text-sm">
                                             Finalize Transaction
                                         </p>
                                         
                                         {selectedPost.priceType !== 'fixed' && (
                                             <div className="mb-3">
                                                 <label className="block text-xs font-bold text-emerald-700 dark:text-emerald-500 mb-1 uppercase tracking-wider">
                                                     ACTUAL { { hourly: 'HOURS', daily: 'DAYS', weekly: 'WEEKS', monthly: 'MONTHS' }[selectedPost.priceType] || 'UNITS' } WORKED
                                                 </label>
                                                 <input
                                                     type="number"
                                                     value={completeHours}
                                                     onChange={(e) => setCompleteHours(e.target.value)}
                                                     min="0.5"
                                                     step="0.5"
                                                     placeholder="e.g. 2.5"
                                                     className="w-full bg-white dark:bg-nature-900 border border-emerald-200 dark:border-emerald-800 rounded-lg px-3 py-2 text-nature-900 dark:text-white font-mono text-center focus:ring-2 focus:ring-emerald-400 focus:outline-none"
                                                 />
                                             </div>
                                         )}
                                         
                                         <div className="text-center mb-4 text-xs font-bold text-emerald-800 dark:text-emerald-300 bg-white dark:bg-nature-900 py-2.5 rounded-lg border border-emerald-100 dark:border-emerald-900 shadow-sm">
                                             {(() => {
                                                 const hrs = Number(completeHours) || 0;
                                                 const tot = selectedPost.priceType !== 'fixed' ? selectedPost.credits * hrs : selectedPost.credits;
                                                 return `Transferring ${tot} B to ${targetPeerCallsign}`;
                                             })()}
                                         </div>
                                         
                                         <div className="flex gap-2">
                                             <button
                                                 onClick={() => setShowCompleteConfirm(false)}
                                                 disabled={accepting}
                                                 className="flex-1 py-2.5 rounded-lg border border-emerald-200 dark:border-emerald-800 text-emerald-700 dark:text-emerald-400 font-bold hover:bg-emerald-100 dark:hover:bg-emerald-900/50 transition-colors text-sm"
                                             >
                                                 Cancel
                                             </button>
                                             <button
                                                 onClick={async () => {
                                                     const txToComplete = activeTx?.id || selectedPost.pendingTransactionId;
                                                     if (!identity || !txToComplete) return;
                                                     setAccepting(true);
                                                     try {
                                                         const isVariable = selectedPost.priceType !== 'fixed';
                                                         const finalHours = isVariable ? Number(completeHours) : undefined;
                                                         const txId = txToComplete;
                                                         const targetPubkey = isPayer ? (activeTx?.sellerPublicKey || (selectedPost as any).acceptedBy!) : (activeTx?.buyerPublicKey || selectedPost.authorPublicKey);
                                                         const targetCallsign = targetPeerCallsign;
                                                         const isOffer = selectedPost.type === 'offer';
                                                         const targetIsSeller = targetPubkey === selectedPost.authorPublicKey;
                                                         const targetRole = targetIsSeller ? (isOffer ? 'provider' : 'receiver') : (isOffer ? 'receiver' : 'provider');

                                                         await completeMarketplaceTransaction(txId, identity.publicKey, finalHours);
                                                         
                                                         setSelectedPost(null);
                                                         setSelectedTxId(null);
                                                         setShowCompleteConfirm(false);
                                                         refresh();

                                                         // Trigger Review Modal immediately
                                                         setReviewStars(5);
                                                         setReviewComment('');
                                                         setPromptReviewForTx({ txId, targetPubkey, targetCallsign, targetRole });

                                                     } catch (e: any) {
                                                         setError(e.message || 'Failed to complete transaction');
                                                     } finally {
                                                         setAccepting(false);
                                                     }
                                                 }}
                                                 disabled={accepting || (selectedPost.priceType !== 'fixed' && (!completeHours || Number(completeHours) <= 0))}
                                                 className={`flex-1 py-2.5 rounded-lg font-bold text-white text-sm transition-all shadow-sm ${
                                                     accepting 
                                                         ? 'bg-emerald-400 cursor-not-allowed opacity-60' 
                                                         : 'bg-emerald-600 hover:bg-emerald-700'
                                                 }`}
                                             >
                                                 {accepting ? 'Processing...' : 'Release Credits'}
                                             </button>
                                         </div>
                                     </div>
                                 ) : (
                                     <button
                                         onClick={() => {
                                             setShowCompleteConfirm(true);
                                             if (selectedPost.priceType !== 'fixed' && !completeHours) {
                                                 setCompleteHours('1');
                                             }
                                         }}
                                         disabled={accepting}
                                         className={`w-full py-3.5 rounded-xl font-bold text-white text-[15px] transition-all shadow-md ${
                                             accepting ? 'bg-emerald-400 cursor-not-allowed opacity-60' : 'bg-emerald-500 hover:bg-emerald-600'
                                         }`}
                                     >
                                         {accepting ? 'Processing...' : '✅ Release Credits'}
                                     </button>
                                 )}
                             </>
                         ) : (
                             <>
                                 <p className="text-amber-500 text-sm font-semibold text-center mt-2 mb-2">
                                     ⏳ Pending Release by {targetPeerCallsign}
                                 </p>
                                 <p className="text-xs text-nature-500 text-center mb-2 px-4 shadow-sm">
                                      You are the Payee. Fulfill the terms exactly as agreed, and the Payer will release your credits (you will receive net amount minus 1.5% transaction fee <span className="text-emerald-600 dark:text-emerald-500 font-bold">(100% community owned)</span>).
                                 </p>
                             </>
                         )}
                         
                         <button
                             onClick={async () => {
                                 const txToCancel = activeTx?.id || selectedPost.pendingTransactionId;
                                 if (!identity || !txToCancel) return;
                                 if (!confirm('Cancel this transaction and return the post to the market?')) return;
                                 setAccepting(true);
                                 try {
                                     await cancelMarketplaceTransaction(txToCancel, identity.publicKey);
                                     setSelectedPost(null);
                                     setSelectedTxId(null);
                                     refresh();
                                 } catch (e: any) {
                                     setError(e.message || 'Failed to cancel transaction');
                                 } finally {
                                     setAccepting(false);
                                 }
                             }}
                             disabled={accepting}
                             className={`w-full py-3 mt-2 rounded-xl border font-bold text-sm transition-colors ${
                                 accepting ? 'border-red-200 text-red-300 cursor-not-allowed' : 'border-red-300 text-red-500 hover:bg-red-50'
                             }`}
                         >
                             ❌ Cancel Hold
                         </button>
                     </div>
                 )}

                {/* 1.5 Pending Requests (For Authors of Needs) */}
                {isOwnPost && selectedPost.type === 'need' && selectedPost.status === 'active' && requests.length > 0 && (
                    <div className="mt-4 bg-oat-50 dark:bg-nature-950 border border-amber-200 dark:border-amber-900/50 rounded-xl p-3 shadow-sm">
                        <p className="font-bold text-amber-800 dark:text-amber-500 text-sm mb-2 text-center">
                            ✋ Fulfillment Requests ({requests.length})
                        </p>
                        <div className="flex flex-col gap-2">
                            {requests.map((req: any) => (
                                <div key={req.id} className="bg-white dark:bg-nature-900 border border-nature-200 dark:border-nature-800 rounded-lg p-3 flex flex-col shadow-sm">
                                    <div className="flex flex-col mb-3">
                                        <button 
                                            onClick={() => { if (onOpenProfile) onOpenProfile(req.sellerPublicKey || req.buyerPublicKey); }}
                                            className="font-bold text-nature-900 dark:text-white text-sm text-left hover:text-emerald-600 transition-colors flex items-center gap-1"
                                        >
                                            <span className="text-amber-600">🤝</span> <span className="underline decoration-nature-300 underline-offset-2">{req.sellerCallsign}</span>
                                        </button>
                                        <span className="text-xs text-amber-500 mt-0.5 font-semibold">
                                            {req.bidderRating?.count > 0 ? `★ ${req.bidderRating.average.toFixed(1)} (${req.bidderRating.count} reviews)` : '☆☆☆☆☆ No ratings yet'}
                                        </span>
                                        <span className="text-xs text-nature-500 mt-1">
                                            {req.hours ? `${req.hours} hours estimated` : 'Offered to fulfill'}
                                        </span>
                                    </div>
                                    <div className="flex gap-2">
                                        <button
                                            onClick={async () => {
                                                if (!identity) return;
                                                setAccepting(true);
                                                try {
                                                    await rejectMarketplaceRequest(req.id, identity.publicKey);
                                                    setRequests(prev => prev.filter(r => r.id !== req.id));
                                                } catch (e: any) {
                                                    setError(e.message || 'Failed to reject offer');
                                                } finally {
                                                    setAccepting(false);
                                                }
                                            }}
                                            disabled={accepting}
                                            className="flex-1 py-1.5 rounded-md border border-nature-200 dark:border-nature-700 text-nature-600 dark:text-nature-400 font-bold text-xs hover:bg-red-50 hover:text-red-600 hover:border-red-200 dark:hover:bg-red-900/30 transition-colors"
                                        >
                                            Deny
                                        </button>
                                        <button
                                            onClick={async () => {
                                                if (!identity) return;
                                                setAccepting(true);
                                                try {
                                                    await approveMarketplaceRequest(req.id, identity.publicKey);
                                                    const updated = await getMarketplacePosts({ id: selectedPost.id });
                                                    if (updated.length > 0) setSelectedPost(updated[0]);
                                                    refresh();
                                                } catch (e: any) {
                                                    setError(e.message || 'Failed to approve offer. Check your balance.');
                                                } finally {
                                                    setAccepting(false);
                                                }
                                            }}
                                            disabled={accepting}
                                            className="flex-1 py-1.5 rounded-md bg-emerald-600 hover:bg-emerald-700 text-white font-bold text-xs shadow-sm transition-colors"
                                        >
                                            Approve & Hold in Trust
                                        </button>
                                    </div>
                                </div>
                            ))}
                        </div>
                    </div>
                )}

                {/* 2. Unaccepted Posts Displayed to Browsers */}
                {!isOwnPost && selectedPost.status === 'active' && !isAcceptedByMe && (
                    <div style={{
                        display: 'flex', flexDirection: 'column', gap: '0.5rem',
                        marginTop: '0.75rem',
                    }}>
                        {(() => {
                            const myRequest = requests.find(r => r.sellerPublicKey === identity?.publicKey);
                            if (myRequest) {
                                return (
                                    <div className="bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-800 rounded-xl p-4 shadow-sm text-center">
                                        <span className="text-4xl block mb-2">⏳</span>
                                        <p className="font-bold text-amber-800 dark:text-amber-500 mb-1">
                                            Offer Pending Approval
                                        </p>
                                        <p className="text-xs text-nature-600 dark:text-nature-400 mb-4">
                                            The author is reviewing your offer to fulfill this need.
                                        </p>
                                        <button
                                            onClick={async () => {
                                                if (!identity) return;
                                                setAccepting(true);
                                                try {
                                                    await cancelMarketplaceRequest(myRequest.id, identity.publicKey);
                                                    setRequests(prev => prev.filter(r => r.id !== myRequest.id));
                                                } catch (e: any) {
                                                    setError(e.message || 'Failed to cancel request');
                                                } finally {
                                                    setAccepting(false);
                                                }
                                            }}
                                            disabled={accepting}
                                            className="w-full py-2.5 rounded-lg border border-red-200 text-red-600 font-bold hover:bg-red-50 transition-colors text-sm"
                                        >
                                            {accepting ? 'Canceling...' : 'Cancel Offer'}
                                        </button>
                                    </div>
                                );
                            }

                            return showAcceptConfirm ? (
                            <div className="bg-oat-50 dark:bg-nature-950 border border-nature-200 dark:border-nature-800 rounded-xl p-4 shadow-inner mt-2">
                                <p className="font-bold text-nature-900 dark:text-white mb-2 text-center text-sm">
                                    {selectedPost.type === 'offer' ? 'Accept this Offer?' : 'Offer to Fulfill this Need?'}
                                </p>
                                
                                {selectedPost.priceType !== 'fixed' && (
                                    <div className="mb-3">
                                        <label className="block text-xs font-bold text-nature-600 dark:text-nature-400 mb-1 uppercase tracking-wider">
                                            ESTIMATED { { hourly: 'HOURS', daily: 'DAYS', weekly: 'WEEKS', monthly: 'MONTHS' }[selectedPost.priceType] || 'UNITS' }
                                        </label>
                                        <input
                                            type="number"
                                            value={acceptHours}
                                            onChange={(e) => setAcceptHours(e.target.value)}
                                            min="1"
                                            className="w-full bg-white dark:bg-nature-900 border border-nature-200 dark:border-nature-800 rounded-lg px-3 py-2 text-nature-900 dark:text-white font-mono text-center focus:ring-2 focus:ring-amber-400 focus:outline-none"
                                        />
                                        <p className="text-[10px] text-nature-500 mt-1 text-center">
                                            Credits will be reserved based on this estimate.
                                        </p>
                                    </div>
                                )}
                                
                                <div className="text-center mb-4 text-xs font-medium text-nature-700 dark:text-nature-300 bg-white dark:bg-nature-900 py-3 px-2 rounded-lg border border-nature-100 dark:border-nature-800">
                                    {(() => {
                                        const hrs = Number(acceptHours) || 0;
                                        const tot = selectedPost.priceType !== 'fixed' ? selectedPost.credits * hrs : selectedPost.credits;
                                        if (tot === 0) return 'This is a free listing (0 B). No credits transferred.';
                                        
                                        const duration = selectedPost.priceType !== 'fixed' ? ` (${hrs} ${ { hourly: 'hr', daily: 'd', weekly: 'w', monthly: 'm' }[selectedPost.priceType] })` : '';
                                        
                                        if (selectedPost.type === 'offer') {
                                            const net = Math.round(tot * 0.985 * 100) / 100;
                                            return (
                                                <span>
                                                    By proceeding, you commit {tot} B{duration} to a Trust Wallet. When finalized, the provider will receive {net.toFixed(2)} B (net of 1.5% transaction fee <span className="text-emerald-600 dark:text-emerald-500 font-bold">(100% community owned)</span> to fund the Commons Pool).
                                                </span>
                                            );
                                        } else {
                                            const net = Math.round(tot * 0.985 * 100) / 100;
                                            return (
                                                <span>
                                                    You will receive {net.toFixed(2)} B (after 1.5% transaction fee <span className="text-emerald-600 dark:text-emerald-500 font-bold">(100% community owned)</span> is deducted to fund the Commons Pool) when the job is completed.
                                                </span>
                                            );
                                        }
                                    })()}
                                </div>
                                
                                <div className="flex gap-2">
                                    <button
                                        onClick={() => setShowAcceptConfirm(false)}
                                        disabled={accepting}
                                        className="flex-1 py-2.5 rounded-lg border border-nature-200 dark:border-nature-700 text-nature-600 dark:text-nature-300 font-bold hover:bg-nature-100 dark:hover:bg-nature-800 transition-colors text-sm"
                                    >
                                        Cancel
                                    </button>
                                    <button
                                        onClick={async () => {
                                            if (!identity || !selectedPost) return;
                                            setAccepting(true);
                                            try {
                                                const isVariable = selectedPost.priceType !== 'fixed';
                                                const estimatedHours = isVariable ? Number(acceptHours) : undefined;
                                                const totalCredits = isVariable ? selectedPost.credits * (estimatedHours || 0) : selectedPost.credits;

                                                const remoteNode = (selectedPost as any)._remoteNode;
                                                if (remoteNode) {
                                                    const isOffer = selectedPost.type === 'offer';
                                                    if (totalCredits > 0) {
                                                        const from = isOffer ? identity.publicKey : selectedPost.authorPublicKey;
                                                        const to = isOffer ? selectedPost.authorPublicKey : identity.publicKey;
                                                        const memo = `${isOffer ? 'Accepted' : 'Fulfilled'}: ${selectedPost.title}`;
                                                        await sendRemoteTransfer(remoteNode, from, to, totalCredits, memo);
                                                    }
                                                    handleMessageAuthor();
                                                } else {
                                                    if (selectedPost.type === 'offer') {
                                                        await acceptMarketplacePost(selectedPost.id, identity.publicKey, estimatedHours);
                                                    } else {
                                                        await requestMarketplacePost(selectedPost.id, identity.publicKey, estimatedHours);
                                                    }
                                                    handleMessageAuthor();
                                                    refresh();
                                                }
                                                setShowAcceptConfirm(false);
                                            } catch (err) {
                                                alert(explainTradeError(err));
                                            } finally {
                                                setAccepting(false);
                                            }
                                        }}
                                        disabled={accepting || (selectedPost.priceType !== 'fixed' && (!acceptHours || Number(acceptHours) <= 0))}
                                        className={`flex-1 py-2.5 rounded-lg font-bold text-white text-sm transition-all shadow-sm ${
                                            accepting 
                                                ? 'bg-emerald-400 cursor-not-allowed opacity-60' 
                                                : 'bg-emerald-600 hover:bg-emerald-700'
                                        }`}
                                    >
                                        {accepting ? 'Processing...' : 'Confirm'}
                                    </button>
                                </div>
                            </div>
                        ) : (
                            <button
                                onClick={() => {
                                    // Accepting an Offer extracts value → gated. Fulfilling a Need is a contribution → always allowed.
                                    if (selectedPost.type === 'offer' && blockedFromTrading) {
                                        setShowContributionRequired(true);
                                    } else {
                                        setShowAcceptConfirm(true);
                                    }
                                }}
                                disabled={accepting}
                                className={`w-full py-3.5 rounded-xl font-bold text-white text-[15px] transition-all shadow-md ${
                                    accepting
                                        ? 'bg-nature-400 cursor-not-allowed opacity-60'
                                        : selectedPost.type === 'offer' ? 'bg-emerald-600 hover:bg-emerald-700' : 'bg-terra-600 hover:bg-terra-700'
                                }`}
                            >
                                 {accepting ? 'Processing...' : (selectedPost.type === 'offer' ? '🤝 Accept Offer' : '✋ Offer to Fulfill')}
                            </button>
                        );
                        })()}
                        
                    </div>
                )}
                
                {/* 3. Global Message Button (Visible to Non-Authors) */}
                {!isOwnPost && (
                    <div className="mt-2">
                        <button
                            onClick={handleMessageAuthor}
                            disabled={messaging}
                            className={`w-full py-3.5 mt-1 rounded-xl font-bold text-white text-[15px] transition-all shadow-md ${
                                messaging ? 'bg-nature-500 cursor-not-allowed opacity-60' : 'bg-nature-800 hover:bg-nature-900'
                            }`}
                        >
                            {messaging ? 'Opening chat...' : '💬 Message'}
                        </button>
                        
                        {/* Transaction-gated rating — only show on completed posts where user was a participant */}
                        {identity && selectedPost.status === 'completed' && selectedPost.pendingTransactionId && (
                            identity.publicKey === selectedPost.authorPublicKey || 
                            identity.publicKey === selectedPost.acceptedBy
                        ) && (() => {
                            const targetPubkey = identity.publicKey === selectedPost.authorPublicKey 
                                ? selectedPost.acceptedBy! 
                                : selectedPost.authorPublicKey;
                            const targetName = identity.publicKey === selectedPost.authorPublicKey
                                ? (selectedPost.acceptedByCallsign || 'them')
                                : selectedPost.authorCallsign;
                            // Determine role of target
                            const isOffer = selectedPost.type === 'offer';
                            const targetIsSeller = targetPubkey === selectedPost.authorPublicKey;
                            const targetRole = targetIsSeller 
                                ? (isOffer ? 'Provider' : 'Receiver')
                                : (isOffer ? 'Receiver' : 'Provider');
                            return (
                                <>
                                    <button
                                        onClick={() => setShowRatingForm(!showRatingForm)}
                                        className={`w-full py-3 mt-3 rounded-xl font-bold text-[14px] transition-all border ${
                                            showRatingForm 
                                                ? (hasExistingRating 
                                                    ? 'bg-emerald-100 dark:bg-emerald-900/40 border-emerald-300 dark:border-emerald-800 text-emerald-800 dark:text-emerald-500' 
                                                    : 'bg-amber-100 dark:bg-amber-900/40 border-amber-300 dark:border-amber-800 text-amber-800 dark:text-amber-500') 
                                                : (hasExistingRating 
                                                    ? 'bg-white dark:bg-nature-900 border-emerald-200 dark:border-emerald-800 text-emerald-600 dark:text-emerald-500 hover:bg-emerald-50 dark:hover:bg-nature-800 shadow-sm' 
                                                    : 'bg-white dark:bg-nature-900 border-nature-200 dark:border-nature-800 text-amber-600 dark:text-amber-500 hover:bg-amber-50 dark:hover:bg-nature-800 shadow-sm')
                                        }`}
                                    >
                                        {hasExistingRating ? `⭐ Edit rating for ${targetName} (as ${targetRole})` : `⭐ Rate ${targetName} as ${targetRole}`}
                                    </button>

                                    {showRatingForm && (
                                        <div className="bg-oat-50 dark:bg-nature-950 border border-nature-200 dark:border-nature-800 rounded-xl p-4 mt-2 shadow-inner">
                                            <p className="text-sm text-nature-600 mb-3 text-center">
                                                How was <strong className="text-nature-900">{targetName}</strong> as a <strong className="text-nature-900">{targetRole}</strong>?
                                            </p>
                                            <div className="flex justify-center gap-2 mb-3">
                                                {[1, 2, 3, 4, 5].map(star => (
                                                    <button
                                                        key={star}
                                                        onClick={() => setMyRating(star)}
                                                        className={`text-4xl leading-none transition-transform focus:outline-none ${
                                                            star <= myRating ? 'text-amber-400 scale-110 drop-shadow-sm' : 'text-nature-300 scale-100'
                                                        }`}
                                                    >
                                                        {star <= myRating ? '★' : '☆'}
                                                    </button>
                                                ))}
                                            </div>
                                            <textarea
                                                value={ratingComment}
                                                onChange={(e) => setRatingComment(e.target.value)}
                                                placeholder="Leave a comment (optional)..."
                                                maxLength={200}
                                                className="w-full p-2.5 rounded-lg border border-nature-200 bg-white text-nature-900 text-sm focus:outline-none focus:ring-2 focus:ring-amber-300 resize-none mb-2"
                                                rows={2}
                                            />
                                            <button
                                                onClick={async () => {
                                                    if (!identity || !selectedPost || myRating < 1 || !selectedPost.pendingTransactionId) return;
                                                    setSubmittingRating(true);
                                                    try {
                                                        await submitRating(identity.publicKey, targetPubkey, myRating, ratingComment, selectedPost.pendingTransactionId);
                                                        const fresh = await getMemberRatings(targetPubkey);
                                                        setAuthorAvgRating({ average: fresh.average, count: fresh.count });
                                                        setHasExistingRating(true);
                                                        setShowRatingForm(false);
                                                    } catch (e: any) {
                                                        alert(e.message || 'Failed to submit rating');
                                                    } finally {
                                                        setSubmittingRating(false);
                                                    }
                                                }}
                                                disabled={myRating < 1 || submittingRating}
                                                className={`w-full py-2.5 rounded-lg font-bold text-sm text-white transition-colors ${
                                                    myRating >= 1 
                                                        ? (hasExistingRating ? 'bg-emerald-500 hover:bg-emerald-600 shadow-sm' : 'bg-amber-500 hover:bg-amber-600 shadow-sm') 
                                                        : 'bg-nature-300 cursor-not-allowed'
                                                }`}
                                            >
                                                {submittingRating ? 'Submitting...' : myRating < 1 ? 'Tap stars to rate' : (hasExistingRating ? `Update ${myRating}⭐ Rating` : `Submit ${myRating}⭐ Rating`)}
                                            </button>
                                        </div>
                                    )}
                                </>
                            );
                        })()}

                        <button
                            onClick={() => setShowReportForm(!showReportForm)}
                            className="w-full py-2.5 mt-3 rounded-xl border border-nature-200 bg-transparent text-nature-500 font-semibold text-sm hover:bg-red-50 hover:text-red-600 hover:border-red-200 transition-colors"
                        >
                            🚩 Report
                        </button>

                        {showReportForm && (
                            <div className="bg-red-50 border border-red-100 rounded-xl p-4 mt-2 shadow-inner">
                                <select
                                    value={reportReason}
                                    onChange={(e) => setReportReason(e.target.value)}
                                    className="w-full p-2.5 rounded-lg bg-white border border-red-200 text-nature-900 text-sm focus:outline-none focus:ring-2 focus:ring-red-300 cursor-pointer mb-2"
                                >
                                    <option value="">Select a reason...</option>
                                    <option value="Spam or scam">Spam or scam</option>
                                    <option value="Offensive content">Offensive content</option>
                                    <option value="Misleading post">Misleading post</option>
                                    <option value="Harassment">Harassment</option>
                                    <option value="Other">Other</option>
                                </select>
                                <button
                                    onClick={async () => {
                                        if (!identity || !selectedPost || !reportReason) return;
                                        setSubmittingReport(true);
                                        try {
                                            await reportAbuse(identity.publicKey, selectedPost.authorPublicKey, reportReason, selectedPost.id);
                                            alert('Report submitted. The admin will review it.');
                                            setShowReportForm(false);
                                            setReportReason('');
                                        } catch (e: any) {
                                            alert(e.message || 'Failed to submit report');
                                        } finally {
                                            setSubmittingReport(false);
                                        }
                                    }}
                                    disabled={!reportReason || submittingReport}
                                    className={`w-full py-2.5 rounded-lg font-bold text-sm text-white transition-colors ${
                                        reportReason ? 'bg-red-600 hover:bg-red-700 shadow-sm' : 'bg-nature-300 cursor-not-allowed'
                                    }`}
                                >
                                    {submittingReport ? 'Sending...' : 'Submit Report'}
                                </button>
                            </div>
                        )}
                    </div>
                )}

                {isOwnPost && selectedPost.status !== 'pending' && (
                    <div className="flex flex-col gap-2 mt-4">
                        {!editMode ? (
                            <>
                                {/* Active/Paused toggle (Offers only). A live Offer counts toward your
                                    credit line (offer covenant, v3); pausing it drops it from the feed. */}
                                {selectedPost.type === 'offer' && (
                                    <button
                                        onClick={async () => {
                                            if (!identity || !selectedPost) return;
                                            const isPaused = selectedPost.status === 'paused';
                                            setToggling(true);
                                            try {
                                                if (isPaused) await resumeMarketplacePost(selectedPost.id, identity.publicKey);
                                                else await pauseMarketplacePost(selectedPost.id, identity.publicKey);
                                                setSelectedPost(null);
                                                refresh();
                                            } catch (e: any) {
                                                setError(e.message || 'Failed to update offer');
                                            } finally {
                                                setToggling(false);
                                            }
                                        }}
                                        disabled={toggling}
                                        className={`w-full py-3 rounded-xl border font-bold text-sm transition-colors ${
                                            selectedPost.status === 'paused'
                                                ? 'border-emerald-300 text-emerald-600 hover:bg-emerald-50'
                                                : 'border-amber-300 text-amber-600 hover:bg-amber-50'
                                        }`}
                                    >
                                        {toggling ? 'Updating…' : selectedPost.status === 'paused' ? '▶️ Activate Offer' : '⏸️ Pause Offer'}
                                    </button>
                                )}
                                <button
                                    onClick={() => {
                                        setEditType(selectedPost.type);
                                        setEditCategory(selectedPost.category);
                                        setEditTitle(selectedPost.title);
                                        setEditDescription(selectedPost.description);
                                        setEditCredits(selectedPost.credits);
                                        setEditPriceType(selectedPost.priceType || 'fixed');
                                        setEditRepeatable(!!selectedPost.repeatable);
                                        setEditPhotos(selectedPost.photos || []);
                                        setEditMode(true);
                                    }}
                                    className="w-full py-3.5 rounded-xl bg-terra-500 hover:bg-terra-600 font-bold text-white text-[15px] transition-all shadow-md"
                                >
                                    ✏️ Edit Post
                                </button>
                                <button
                                    onClick={async () => {
                                        if (!identity || !selectedPost) return;
                                        if (!confirm('Delete this post?')) return;
                                        setDeleting(selectedPost.id);
                                        try {
                                            await removeMarketplacePost(selectedPost.id, identity.publicKey);
                                            setSelectedPost(null);
                                            setSelectedTxId(null);
                                            refresh();
                                        } catch (e: any) {
                                            setError(e.message || 'Failed to delete');
                                        } finally {
                                            setDeleting(null);
                                        }
                                    }}
                                    disabled={deleting === selectedPost.id}
                                    className={`w-full py-3 rounded-xl border font-bold text-sm transition-colors mt-2 ${
                                        deleting === selectedPost.id ? 'border-red-200 text-red-300 cursor-not-allowed' : 'border-red-300 text-red-500 hover:bg-red-50'
                                    }`}
                                >
                                    {deleting === selectedPost.id ? 'Deleting...' : '🗑️ Delete Post'}
                                </button>
                            </>
                        ) : (
                            <div className="bg-white dark:bg-nature-950 border border-nature-200 dark:border-nature-800 rounded-2xl p-5 shadow-sm">
                                <h3 className="font-bold text-lg text-nature-950 dark:text-white mb-4 tracking-tight">✏️ Edit Post</h3>

                                {/* Type */}
                                <div className="flex gap-2 mb-4">
                                    {(['offer', 'need'] as const).map(t => (
                                        <button
                                            key={t}
                                            onClick={() => setEditType(t)}
                                            className={`flex-1 py-2.5 rounded-xl border text-sm font-bold capitalize transition-colors ${
                                                editType === t
                                                    ? (t === 'offer' ? 'bg-blue-600 border-blue-600 text-white shadow-sm' : 'bg-orange-600 border-orange-600 text-white shadow-sm')
                                                    : 'bg-white dark:bg-nature-900 border-nature-200 dark:border-nature-800 text-nature-500 dark:text-nature-400 hover:bg-oat-50 dark:hover:bg-nature-800'
                                            }`}
                                        >
                                            {t === 'offer' ? '🔵 Offer' : '🟠 Need'}
                                        </button>
                                    ))}
                                </div>

                                {/* Category */}
                                <select
                                    value={editCategory}
                                    onChange={(e) => setEditCategory(e.target.value)}
                                    className="w-full mb-3 py-3 px-4 rounded-xl border border-nature-200 bg-white text-nature-900 text-[15px] focus:outline-none focus:ring-2 focus:ring-terra-300 shadow-sm appearance-auto cursor-pointer"
                                    style={inputStyle}
                                >
                                    {MARKETPLACE_CATEGORIES.map(cat => (
                                        <option key={cat.id} value={cat.id}>{cat.emoji} {cat.label}</option>
                                    ))}
                                </select>

                                {/* Title */}
                                <input
                                    value={editTitle}
                                    onChange={(e) => setEditTitle(e.target.value)}
                                    placeholder="Title"
                                    className="w-full mb-3 py-3 px-4 rounded-xl border border-nature-200 bg-white text-nature-900 text-[15px] focus:outline-none focus:ring-2 focus:ring-terra-300 shadow-sm"
                                    style={inputStyle}
                                />

                                {/* Description */}
                                <textarea
                                    value={editDescription}
                                    onChange={(e) => setEditDescription(e.target.value)}
                                    placeholder="Description"
                                    className="w-full mb-3 py-3 px-4 rounded-xl border border-nature-200 bg-white text-nature-900 text-[15px] focus:outline-none focus:ring-2 focus:ring-terra-300 shadow-sm min-h-[100px] resize-y"
                                    style={{ ...inputStyle, minHeight: '100px' }}
                                />

                                {/* Credits + Unit */}
                                <div className="flex gap-2 mb-4">
                                    <input
                                        type="number"
                                        value={editCredits}
                                        onChange={(e) => setEditCredits(Number(e.target.value) || 0)}
                                        placeholder="Credits (B)"
                                        className="flex-1 py-3 px-4 rounded-xl border border-nature-200 bg-white text-nature-900 text-[15px] focus:outline-none focus:ring-2 focus:ring-terra-300 shadow-sm min-w-0"
                                        style={{...inputStyle, marginBottom: 0, width: undefined}}
                                    />
                                    <select
                                        value={editPriceType}
                                        onChange={(e) => setEditPriceType(e.target.value as any)}
                                        className="w-28 shrink-0 py-3 px-4 rounded-xl border border-nature-200 bg-white text-nature-900 text-[15px] focus:outline-none focus:ring-2 focus:ring-terra-300 shadow-sm appearance-auto cursor-pointer"
                                        style={{...inputStyle, marginBottom: 0, width: undefined}}
                                    >
                                        <option value="fixed">Total</option>
                                        <option value="hourly">/ Hr</option>
                                        <option value="daily">/ Dy</option>
                                        <option value="weekly">/ Wk</option>
                                        <option value="monthly">/ Mo</option>
                                    </select>
                                </div>

                                {/* Repeatable Toggle */}
                                <div className="mb-4">
                                    <label className="flex items-center gap-3 p-3 rounded-xl border border-nature-200 dark:border-nature-800 bg-nature-50 dark:bg-nature-900/50 cursor-pointer hover:bg-white transition-colors cursor-pointer group">
                                        <div className="relative flex items-center justify-center w-6 h-6 shrink-0">
                                            <input 
                                                type="checkbox" 
                                                checked={editRepeatable} 
                                                onChange={e => setEditRepeatable(e.target.checked)}
                                                className="peer appearance-none w-5 h-5 border-2 border-nature-300 dark:border-nature-700 rounded bg-white dark:bg-nature-900 checked:bg-terra-500 checked:border-terra-500 transition-colors cursor-pointer"
                                            />
                                            <svg className="absolute w-3 h-3 text-white pointer-events-none opacity-0 peer-checked:opacity-100 peer-checked:scale-110 transition-all drop-shadow-sm" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}>
                                                <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                                            </svg>
                                        </div>
                                        <div className="flex flex-col">
                                            <span className="text-[14px] font-bold text-nature-900 dark:text-white group-hover:text-terra-600 transition-colors">Recurring Need / Offer</span>
                                            <span className="text-[11px] text-nature-500 font-medium">Post remains active after completion for repeat business.</span>
                                        </div>
                                    </label>
                                </div>

                                {/* Photos */}
                                <div className="mb-5">
                                    <p className="text-xs font-bold text-nature-400 uppercase tracking-widest mb-2">Photos ({editPhotos.length}/5)</p>
                                    <div className="flex gap-2 flex-wrap">
                                        {editPhotos.map((photo, i) => (
                                            <div key={i} className="relative">
                                                <img src={photo} alt={`photo ${i+1}`} className="w-16 h-16 object-cover rounded-xl border border-nature-200 shadow-sm" />
                                                <button
                                                    onClick={() => setEditPhotos(editPhotos.filter((_, j) => j !== i))}
                                                    aria-label="Remove photo"
                                                    className="absolute -top-1.5 -right-1.5 w-5 h-5 rounded-full bg-red-500 border-none text-white text-[10px] flex items-center justify-center cursor-pointer shadow-sm hover:bg-red-600 transition-colors focus-visible:ring-2 focus-visible:ring-red-500"
                                                >
                                                    ✕
                                                </button>
                                            </div>
                                        ))}
                                        {editPhotos.length < 5 && (
                                            <label className="w-16 h-16 rounded-xl border-2 border-dashed border-nature-300 flex items-center justify-center cursor-pointer text-nature-400 text-2xl hover:bg-nature-50 hover:border-nature-400 transition-colors">
                                                +
                                                <input
                                                    type="file"
                                                    accept="image/*"
                                                    className="hidden"
                                                    onChange={(e) => {
                                                        const file = e.target.files?.[0];
                                                        if (!file) return;
                                                        const reader = new FileReader();
                                                        reader.onload = () => {
                                                            const img = new Image();
                                                            img.onload = () => {
                                                                const canvas = document.createElement('canvas');
                                                                const max = 800;
                                                                let w = img.width, h = img.height;
                                                                if (w > max || h > max) {
                                                                    if (w > h) { h = Math.round(h * max / w); w = max; }
                                                                    else { w = Math.round(w * max / h); h = max; }
                                                                }
                                                                canvas.width = w; canvas.height = h;
                                                                canvas.getContext('2d')!.drawImage(img, 0, 0, w, h);
                                                                setEditPhotos([...editPhotos, canvas.toDataURL('image/jpeg', 0.7)]);
                                                            };
                                                            img.src = reader.result as string;
                                                        };
                                                        reader.readAsDataURL(file);
                                                        e.target.value = '';
                                                    }}
                                                />
                                            </label>
                                        )}
                                    </div>
                                </div>

                                {/* Save/Cancel */}
                                <div className="flex gap-2">
                                    <button
                                        onClick={() => setEditMode(false)}
                                        className="flex-1 py-3 is-bold rounded-xl border border-nature-300 text-nature-600 bg-white hover:bg-nature-50 transition-colors text-[15px] font-bold shadow-sm"
                                    >
                                        Cancel
                                    </button>
                                    <button
                                        onClick={async () => {
                                            if (!identity || !selectedPost || !editTitle.trim()) return;
                                            setSaving(true);
                                            try {
                                                const result = await updateMarketplacePost(selectedPost.id, identity.publicKey, {
                                                    type: editType,
                                                    category: editCategory,
                                                    title: editTitle.trim(),
                                                    description: editDescription.trim(),
                                                    credits: editCredits,
                                                    priceType: editPriceType,
                                                    repeatable: editRepeatable,
                                                    photos: editPhotos,
                                                });
                                                setSelectedPost(result.post);
                                                setEditMode(false);
                                                refresh();
                                            } catch (e: any) {
                                                setError(e.message || 'Failed to save');
                                            } finally {
                                                setSaving(false);
                                            }
                                        }}
                                        disabled={saving || !editTitle.trim()}
                                        className={`flex-1 py-3 rounded-xl font-bold text-white text-[15px] transition-colors shadow-sm ${
                                            saving || !editTitle.trim() ? 'bg-nature-300 cursor-not-allowed' : 'bg-terra-500 hover:bg-terra-600'
                                        }`}
                                    >
                                        {saving ? 'Saving...' : '💾 Save'}
                                    </button>
                                </div>
                            </div>
                        )}
                    </div>
                )}

                {error && (
                    <div className="bg-red-50 border border-red-200 rounded-xl p-3 mt-4 text-red-600 text-sm text-center shadow-sm">
                        {error}
                    </div>
                )}
            </div>
        );
    }

    // =================== LIST VIEW ===================
    return (
        <div className="px-3 pt-2 pb-24 max-w-lg mx-auto">
            {/* Radius Picker Full Screen */}
            {showRadiusPicker && (
                <Suspense fallback={<div className="flex-1 flex items-center justify-center">Loading Location Services...</div>}>
                    <RadiusPickerPage
                        initial={radiusSettings}
                        defaultRadius={nodeConfig?.serviceRadius?.radiusKm}
                        onApply={(settings) => {
                            setRadiusSettings(settings);
                            saveRadiusSettings(settings);
                            setShowRadiusPicker(false);
                        }}
                        onCancel={() => setShowRadiusPicker(false)}
                        onReset={() => {
                            setRadiusSettings(null);
                            clearRadiusSettings();
                            setShowRadiusPicker(false);
                        }}
                    />
                </Suspense>
            )}
            <div className="mb-0.5">
                <div className="flex gap-2 items-center">
                    {/* Search bar */}
                    <div className="flex-1 relative">
                        <span className="absolute left-3.5 top-1/2 -translate-y-1/2 text-sm opacity-40 pointer-events-none text-nature-500 dark:text-nature-400">🔍</span>
                        <input
                            value={searchQuery}
                            onChange={(e) => setSearchQuery(e.target.value)}
                            placeholder="Search marketplace..."
                            className="w-full py-2 pl-10 pr-4 rounded-full border border-nature-200 dark:border-nature-800 bg-white dark:bg-nature-900 text-nature-900 dark:text-white text-[14px] font-medium focus:outline-none focus:ring-2 focus:ring-terra-300 shadow-sm transition-all hover:shadow-md"
                        />
                    </div>

                    {/* Highly Important My Deals Button */}
                    <button
                        onClick={() => setShowDealsModal(true)}
                        className="h-9 px-3 rounded-full border border-amber-300 dark:border-amber-700 bg-amber-100 dark:bg-amber-900/40 text-amber-800 dark:text-amber-400 text-xs font-black whitespace-nowrap shadow-sm transition-all flex items-center gap-1.5 hover:bg-amber-200 dark:hover:bg-amber-900/60 hover:shadow-md cursor-pointer"
                    >
                        🤝 My Deals
                        {pendingDealsCount > 0 && (
                            <span className="bg-red-500 text-white text-[9px] font-black px-1.5 py-0.5 rounded-full shadow-sm">
                                {pendingDealsCount}
                            </span>
                        )}
                    </button>

                    {/* View Mode Toggle */}
                    <button
                        onClick={() => setViewMode(v => v === 'list' ? 'grid' : (v === 'grid' ? 'compact' : 'list'))}
                        className="w-9 h-9 rounded-full flex-shrink-0 border bg-white dark:bg-nature-900 border-nature-200 dark:border-nature-800 text-nature-600 dark:text-nature-400 hover:bg-oat-50 dark:hover:bg-nature-800 transition-colors shadow-sm flex items-center justify-center text-md hover:shadow-md cursor-pointer"
                        title={viewMode === 'list' ? "Switch to Grid View" : (viewMode === 'grid' ? "Switch to Compact View" : "Switch to List View")}
                    >
                        {viewMode === 'list' ? '☰' : (viewMode === 'grid' ? '⊞' : '▤')}
                    </button>
                </div>

                {/* Row 2: Full-Width Type Segmented Control */}
                <div className="w-full bg-nature-100 dark:bg-nature-900/60 rounded-2xl p-0.5 flex gap-0.5 mt-0.5 mb-1 shadow-inner border border-nature-200/50 dark:border-nature-800/40">
                    {(['all', 'for-you', 'offer', 'need'] as const).map((t) => {
                        const isSelected = typeFilter === t;
                        let activeStyles = 'bg-nature-800 dark:bg-white text-white dark:text-nature-900 border border-nature-900/10 shadow-sm scale-[1.01]';
                        if (t === 'offer') activeStyles = 'bg-emerald-600 dark:bg-emerald-500 text-white border border-emerald-700/25 shadow-sm scale-[1.01]';
                        if (t === 'need') activeStyles = 'bg-terra-600 dark:bg-terra-500 text-white border border-terra-700/25 shadow-sm scale-[1.01]';
                        if (t === 'for-you') activeStyles = 'bg-violet-600 dark:bg-violet-500 text-white border border-violet-700/25 shadow-sm scale-[1.01]';

                        return (
                            <button
                                key={t}
                                onClick={() => setTypeFilter(typeFilter === t ? 'all' : t)}
                                className={`flex-1 py-1.5 text-center rounded-xl text-xs font-black transition-all duration-305 flex items-center justify-center gap-1 border-0 cursor-pointer ${
                                    isSelected 
                                        ? activeStyles 
                                        : 'bg-transparent text-nature-500 dark:text-nature-400 hover:text-nature-800 dark:hover:text-nature-200 hover:bg-white/40 dark:hover:bg-nature-800/30'
                                }`}
                            >
                                {t === 'all' ? 'All' : t === 'for-you' ? '★ For You' : t === 'offer' ? '🟢 Offers' : '🟠 Needs'}
                            </button>
                        );
                    })}
                </div>

                {/* Founding-trade filter: surface newcomers whose first trade unlocks their account */}
                <button
                    onClick={() => setFoundingOnly(v => !v)}
                    className={`self-center mt-1 px-3 py-1 rounded-full text-xs font-extrabold border transition-colors cursor-pointer ${
                        foundingOnly
                            ? 'bg-emerald-100 dark:bg-emerald-900/40 text-emerald-800 dark:text-emerald-300 border-emerald-400'
                            : 'bg-white dark:bg-nature-900 text-emerald-700 dark:text-emerald-400 border-emerald-300/50 hover:bg-emerald-50 dark:hover:bg-emerald-900/20'
                    }`}
                >
                    🌱 New members{foundingOnly ? ' ✓' : ''}
                </button>

                {/* Row 3: Symmetrical Filter Dropdowns (50% / 50% split) */}
                <div className="grid grid-cols-2 gap-2 mt-0.5 mb-2.5">
                    {/* Category Dropdown Button */}
                    <button
                        onClick={() => setShowCategoryPicker(true)}
                        className={`w-full py-2 rounded-2xl border text-xs font-black transition-all duration-300 flex items-center justify-center gap-1.5 cursor-pointer hover:shadow-sm ${
                            categoryFilter !== 'all'
                                ? 'bg-indigo-600 border-indigo-700 text-white shadow-soft dark:bg-indigo-500 dark:border-indigo-500'
                                : 'bg-white dark:bg-nature-950 border-nature-200 dark:border-nature-850 text-nature-600 dark:text-nature-350 hover:bg-oat-50 dark:hover:bg-nature-900/60'
                        }`}
                    >
                        {(MARKETPLACE_CATEGORIES.find(c => c.id === categoryFilter)?.emoji) || '🏷️'}
                        <span className="truncate">
                            {categoryFilter !== 'all' ? MARKETPLACE_CATEGORIES.find(c => c.id === categoryFilter)?.label : 'Category'}
                        </span>
                        {categoryFilter !== 'all' ? (
                            <span
                                role="button"
                                tabIndex={0}
                                aria-label="Clear category filter"
                                onClick={(e) => { e.stopPropagation(); setCategoryFilter('all'); }}
                                onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); setCategoryFilter('all'); } }}
                                className="ml-1 bg-white/20 hover:bg-white/30 text-white text-[9px] font-bold px-1.5 py-0.5 rounded-full flex items-center justify-center cursor-pointer transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white"
                            >
                                ✕
                            </span>
                        ) : (
                            <span className="text-[8px] text-nature-450 ml-0.5">▼</span>
                        )}
                    </button>

                    {/* Distance Dropdown Button */}
                    <button
                        onClick={() => setShowRadiusPicker(true)}
                        className={`w-full py-2 rounded-2xl border text-xs font-black transition-all duration-300 flex items-center justify-center gap-1.5 cursor-pointer hover:shadow-sm ${
                            radiusSettings
                                ? 'bg-amber-600 border-amber-700 text-white shadow-soft dark:bg-amber-500 dark:border-amber-500'
                                : 'bg-white dark:bg-nature-950 border-nature-200 dark:border-nature-850 text-nature-600 dark:text-nature-350 hover:bg-oat-50 dark:hover:bg-nature-900/60'
                        }`}
                    >
                        <span>📍</span>
                        <span className="truncate">
                            {radiusSettings ? (radiusSettings.radiusKm < 1 ? `${Math.round(radiusSettings.radiusKm * 1000)}m` : `${radiusSettings.radiusKm}km`) : 'Distance'}
                        </span>
                        {radiusSettings ? (
                            <span
                                role="button"
                                tabIndex={0}
                                aria-label="Clear distance filter"
                                onClick={(e) => { e.stopPropagation(); setRadiusSettings(null); clearRadiusSettings(); }}
                                onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); setRadiusSettings(null); clearRadiusSettings(); } }}
                                className="ml-1 bg-white/20 hover:bg-white/30 text-white text-[9px] font-bold px-1.5 py-0.5 rounded-full flex items-center justify-center cursor-pointer transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white"
                            >
                                ✕
                            </span>
                        ) : (
                            <span className="text-[8px] text-nature-450 ml-0.5">▼</span>
                        )}
                    </button>
                </div>
            </div>

                {/* Connected Communities — multi-toggle (only if peer nodes exist) */}
                {peerNodes.length > 0 && (
                    <div className="flex gap-2 mt-2 overflow-x-auto pb-1 scrollbar-hide">
                        <span className="px-3 py-1.5 rounded-lg border-2 border-emerald-300 bg-emerald-50 text-emerald-700 text-xs font-black uppercase tracking-widest whitespace-nowrap inline-flex items-center shadow-sm">
                            🏠 Internal
                        </span>
                        {peerNodes.map(peer => {
                            const isOn = enabledPeers.has(peer.publicUrl);
                            return (
                                <button
                                    key={peer.publicUrl}
                                    onClick={() => { setEnabledPeers(togglePeer(enabledPeers, peer.publicUrl)); }}
                                    className={`px-3 py-1.5 rounded-lg border-2 text-xs font-bold cursor-pointer whitespace-nowrap transition-all shadow-sm ${
                                        isOn ? 'border-indigo-400 dark:border-indigo-600 bg-indigo-100 dark:bg-indigo-900/40 text-indigo-800 dark:text-indigo-300' : 'border-nature-200 dark:border-nature-800 bg-white/50 dark:bg-nature-950/50 text-nature-500 dark:text-nature-400'
                                    }`}
                                >
                                    {isOn ? '🌐' : '○'} {peer.callsign}
                                </button>
                            );
                        })}
                    </div>
                )}

            {/* Error */}
            {error && (
                <div className="bg-red-50 border border-red-200 rounded-xl p-3 mb-4 text-red-600 text-sm text-center shadow-sm">
                    {error}
                </div>
            )}


            {/* Posts */}
            {loading ? (
                <p className="text-nature-500 text-center py-8">Loading...</p>
            ) : (() => {
                let filtered = posts.filter(p => p.status === 'active' && (!identity || p.authorPublicKey !== identity.publicKey));

                // Text search (synonym-expanded)
                if (searchQuery.trim()) {
                    filtered = filtered.filter(p =>
                        matchesExpandedSearch(searchQuery, p.title, p.description)
                    );
                }

                // Blocked user filtering
                try {
                    const blockedJson = localStorage.getItem('bp_blocked_users');
                    if (blockedJson) {
                        const blocked: string[] = JSON.parse(blockedJson);
                        if (blocked.length > 0) {
                            const blockedSet = new Set(blocked);
                            filtered = filtered.filter(p => !blockedSet.has(p.authorPublicKey));
                        }
                    }
                } catch { /* ignore malformed blocklist */ }

                // Radius filter
                if (radiusSettings) {
                    filtered = filtered.filter(p => {
                        if (p.lat == null || p.lng == null) return false;
                        const dist = haversineDistance(radiusSettings.lat, radiusSettings.lng, p.lat, p.lng);
                        return dist <= radiusSettings.radiusKm;
                    });
                }

                // Local "★ For You" category filter
                if (typeFilter === 'for-you') {
                    filtered = filtered.filter(p => favCategories.includes(p.category));
                }

                // Founding-trade filter: surface newcomers whose first trade unlocks their account
                if (foundingOnly) {
                    filtered = filtered.filter(p => p.authorFoundingNeeded);
                }

                // Compute fresh today count
                const freshTodayCount = posts.filter(post => {
                    if (post.status !== 'active') return false;
                    if (identity && post.authorPublicKey === identity.publicKey) return false;
                    const postTime = new Date(post.createdAt).getTime();
                    const diffDays = Math.floor((Date.now() - postTime) / (24 * 60 * 60 * 1000));
                    return diffDays === 0;
                }).length;

                return (
                    <div className="pb-32">
                        {/* Interests Tag Cloud when in For You mode */}
                        {typeFilter === 'for-you' && (
                            isCustomizerExpanded ? (
                                <div className="mb-4 p-4 rounded-2xl border border-violet-200 dark:border-violet-800 bg-violet-50/50 dark:bg-violet-950/20 backdrop-blur-sm animate-in fade-in duration-300 relative">
                                    <button 
                                        onClick={() => setIsCustomizerExpanded(false)}
                                        className="absolute top-3 right-3 text-[10px] font-black text-violet-700 hover:text-violet-900 dark:text-violet-400 dark:hover:text-violet-300 bg-violet-100 dark:bg-violet-900/60 px-2 py-1 rounded-lg transition-colors cursor-pointer border-0"
                                    >
                                        ✕ HIDE
                                    </button>
                                    <h4 className="text-xs font-black text-violet-800 dark:text-violet-400 uppercase tracking-widest mb-1.5 flex items-center gap-1.5">
                                        <span>★</span> Customize Interests
                                    </h4>
                                    <p className="text-nature-500 dark:text-nature-450 text-xs mb-3">
                                        Select categories to prioritize in your personalized "★ For You" feed.
                                    </p>
                                    <div className="flex flex-wrap gap-1.5">
                                        {MARKETPLACE_CATEGORIES.map(cat => {
                                            const isFav = favCategories.includes(cat.id);
                                            return (
                                                <button
                                                    key={cat.id}
                                                    onClick={() => toggleFavCategory(cat.id)}
                                                    className={`px-3 py-1.5 rounded-full border text-xs font-bold transition-all duration-200 flex items-center gap-1 cursor-pointer hover:scale-105 active:scale-95 shadow-sm ${
                                                        isFav
                                                            ? 'bg-violet-600 border-violet-700 text-white dark:bg-violet-500 dark:border-violet-500'
                                                            : 'bg-white dark:bg-nature-900 border-nature-200 dark:border-nature-800 text-nature-600 dark:text-nature-400'
                                                    }`}
                                                >
                                                    <span>{cat.emoji}</span>
                                                    <span>{cat.label}</span>
                                                    {isFav && <span className="text-[9px]">★</span>}
                                                </button>
                                            );
                                        })}
                                    </div>
                                </div>
                            ) : (
                                <div 
                                    onClick={() => setIsCustomizerExpanded(true)}
                                    className="mb-4 p-3 rounded-2xl border border-violet-200/60 dark:border-violet-850 bg-violet-50/20 dark:bg-violet-950/10 backdrop-blur-sm flex items-center justify-between text-xs font-medium text-violet-850 dark:text-violet-300 hover:bg-violet-50/50 dark:hover:bg-violet-950/25 transition-all cursor-pointer shadow-sm"
                                >
                                    <div className="flex items-center gap-2 overflow-hidden">
                                        <span className="text-violet-600 dark:text-violet-400 font-bold">★</span>
                                        <span className="truncate">
                                            Prioritizing: {favCategories.length > 0 
                                                ? favCategories.map(id => MARKETPLACE_CATEGORIES.find(c => c.id === id)?.emoji || '').join(' ')
                                                : 'None selected yet'}
                                        </span>
                                    </div>
                                    <span className="text-[10px] font-black uppercase tracking-wider text-violet-700 dark:text-violet-400 bg-violet-100/85 dark:bg-violet-900/40 px-2 py-0.5 rounded-lg flex-shrink-0">
                                        ⚙️ Customize
                                    </span>
                                </div>
                            )
                        )}

                        {/* Freshness Social Proof Banner */}
                        {freshTodayCount > 0 && (
                            <div className="mb-4 px-4 py-3 rounded-2xl bg-gradient-to-r from-amber-500/10 via-orange-500/10 to-red-500/10 border border-orange-200/50 dark:border-orange-900/30 flex items-center justify-between shadow-sm animate-pulse-slow">
                                <div className="flex items-center gap-2.5">
                                    <span className="text-lg">🔥</span>
                                    <div className="flex flex-col">
                                        <span className="text-xs font-bold text-orange-950 dark:text-orange-400">
                                            {freshTodayCount} fresh listing{freshTodayCount > 1 ? 's' : ''} posted today!
                                        </span>
                                        <span className="text-[10px] text-orange-600/80 dark:text-orange-450/60 font-medium">
                                            Scroll down to explore what is new in the community.
                                        </span>
                                    </div>
                                </div>
                                <span className="text-[10px] font-bold text-orange-700 bg-orange-100 dark:bg-orange-900/40 dark:text-orange-300 px-2 py-0.5 rounded-full">
                                    LIVE
                                </span>
                            </div>
                        )}

                        {filtered.length === 0 ? (
                            <div className="bg-white dark:bg-nature-950 border border-nature-200 dark:border-nature-800 rounded-3xl p-10 mt-2 text-center shadow-soft">
                                <div className="text-5xl opacity-30 mb-4">
                                    {searchQuery.trim() ? '🔍' : radiusSettings ? '📍' : '🛒'}
                                </div>
                                <h4 className="font-bold text-lg text-nature-900 dark:text-white mb-2">No items found</h4>
                                <p className="text-nature-500 dark:text-nature-400 text-sm">
                                    {searchQuery.trim() ? `No matches for "${searchQuery}".`
                                        : radiusSettings ? 'Expand your radius to see more posts.'
                                        : 'The market is quiet right now. Post an offer!'}
                                </p>
                            </div>
                        ) : (() => {
                            if (viewMode === 'grid') {
                                return (
                                    <div className="grid grid-cols-2 gap-2">
                                        {filtered.map((post) => (
                                            <div
                                                key={post.id}
                                                onClick={() => setSelectedPost(post)}
                                                onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setSelectedPost(post); } }}
                                                role="button"
                                                tabIndex={0}
                                                aria-label={`Open listing: ${post.title}`}
                                                className="h-full cursor-pointer rounded-xl focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nature-500"
                                            >
                                                <MarketplaceCard
                                                    post={post as any}
                                                    authorRating={authorRatingsCache[post.authorPublicKey]}
                                                    authorEnergy={(post as any).authorEnergyCycled || 0}
                                                    authorAvatarUrl={authorAvatarCache[post.authorPublicKey] || null}
                                                    remoteNode={(post as any)._remoteNode}
                                                    viewMode={viewMode}
                                                />
                                            </div>
                                        ))}
                                    </div>
                                );
                            }

                            // Group chronologically for List & Compact modes
                            const today: MarketplacePost[] = [];
                            const yesterday: MarketplacePost[] = [];
                            const thisWeek: MarketplacePost[] = [];
                            const older: MarketplacePost[] = [];

                            const now = Date.now();
                            filtered.forEach(p => {
                                const postTime = new Date(p.createdAt).getTime();
                                const diffDays = Math.floor((now - postTime) / (24 * 60 * 60 * 1000));
                                if (diffDays === 0) {
                                    today.push(p);
                                } else if (diffDays === 1) {
                                    yesterday.push(p);
                                } else if (diffDays < 7) {
                                    thisWeek.push(p);
                                } else {
                                    older.push(p);
                                }
                            });

                            const renderSection = (title: string, items: MarketplacePost[]) => {
                                if (items.length === 0) return null;
                                return (
                                    <div key={title} className="flex flex-col gap-1.5 mb-2">
                                        <div className="flex items-center gap-3 mt-2 mb-1">
                                            <span className="text-xs font-black uppercase tracking-widest text-nature-450 dark:text-nature-500 whitespace-nowrap">
                                                {title}
                                            </span>
                                            <div className="h-[1px] w-full bg-nature-200 dark:bg-nature-800" />
                                        </div>
                                        <div className="flex flex-col gap-1.5">
                                            {items.map(post => (
                                                <div
                                                    key={post.id}
                                                    onClick={() => setSelectedPost(post)}
                                                    onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setSelectedPost(post); } }}
                                                    role="button"
                                                    tabIndex={0}
                                                    aria-label={`Open listing: ${post.title}`}
                                                    className="cursor-pointer rounded-xl focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nature-500"
                                                >
                                                    <MarketplaceCard
                                                        post={post as any}
                                                        authorRating={authorRatingsCache[post.authorPublicKey]}
                                                        authorEnergy={(post as any).authorEnergyCycled || 0}
                                                        authorAvatarUrl={authorAvatarCache[post.authorPublicKey] || null}
                                                        remoteNode={(post as any)._remoteNode}
                                                        viewMode={viewMode}
                                                    />
                                                </div>
                                            ))}
                                        </div>
                                    </div>
                                );
                            };

                            if (typeFilter === 'for-you') {
                                return renderSection('★ Starred For You', filtered);
                            }

                            return (
                                <>
                                    {renderSection('Today', today)}
                                    {renderSection('Yesterday', yesterday)}
                                    {renderSection('This Week', thisWeek)}
                                    {renderSection('Older Listings', older)}
                                </>
                            );
                        })()}
                    </div>
                );
            })()}

            {/* Post-Release Review Modal */}
            {promptReviewForTx && (
                <div className="fixed inset-0 z-[100] flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm animate-in fade-in duration-200">
                    <div className="w-full max-w-sm bg-white dark:bg-nature-900 rounded-3xl shadow-2xl border border-nature-200 dark:border-nature-800 overflow-hidden animate-in slide-in-from-bottom-4 zoom-in-95 duration-300">
                        <div className="p-6 text-center">
                            <div className="text-4xl mb-4">🎉</div>
                            <h3 className="text-xl font-black text-nature-900 dark:text-white mb-2">Deal Complete!</h3>
                            <p className="text-nature-600 dark:text-nature-400 text-sm mb-6">
                                How was your experience with <strong>{promptReviewForTx.targetCallsign}</strong>?
                            </p>

                            <div className="flex justify-center gap-2 mb-4 drop-shadow-sm">
                                {[1, 2, 3, 4, 5].map(star => (
                                    <button
                                        key={star}
                                        onClick={() => setReviewStars(star)}
                                        className="text-4xl hover:scale-110 transition-transform focus:outline-none"
                                    >
                                        <span className={star <= reviewStars ? "text-amber-400" : "text-nature-200 dark:text-nature-700"}>★</span>
                                    </button>
                                ))}
                            </div>

                            <textarea
                                value={reviewComment}
                                onChange={e => setReviewComment(e.target.value)}
                                placeholder="Write a short review (optional)..."
                                className="w-full p-3 bg-nature-50 border border-nature-200 dark:bg-nature-950 dark:border-nature-800 rounded-xl text-sm focus:outline-none focus:border-amber-300 focus:ring-1 focus:ring-amber-300 mb-6 font-medium text-nature-900 dark:text-white resize-none"
                                rows={3}
                            />

                            <div className="flex gap-2">
                                <button
                                    onClick={() => setPromptReviewForTx(null)}
                                    className="flex-1 py-3 text-nature-600 dark:text-nature-400 text-sm font-bold bg-nature-100 hover:bg-nature-200 dark:bg-nature-800 dark:hover:bg-nature-700 rounded-xl transition-colors outline-none"
                                >
                                    Skip for now
                                </button>
                                <button
                                    disabled={submittingReview}
                                    onClick={async () => {
                                        if (!identity) return;
                                        setSubmittingReview(true);
                                        try {
                                            await submitRating(
                                                identity.publicKey, 
                                                promptReviewForTx.targetPubkey, 
                                                reviewStars, 
                                                reviewComment, 
                                                promptReviewForTx.txId
                                            );
                                            setPromptReviewForTx(null);
                                            refresh();
                                        } catch (e: any) {
                                            alert(e.message || 'Failed to submit review');
                                        } finally {
                                            setSubmittingReview(false);
                                        }
                                    }}
                                    className={`flex-[1.5] py-3 text-white text-sm font-bold rounded-xl shadow-[0_4px_15px_rgb(203,83,38,0.4)] transition-all ${
                                        submittingReview ? 'bg-terra-400 opacity-75 cursor-not-allowed' : 'bg-gradient-to-r from-terra-500 to-amber-500 hover:-translate-y-0.5'
                                    }`}
                                >
                                    {submittingReview ? 'Submitting...' : 'Submit Rating'}
                                </button>
                            </div>
                        </div>
                    </div>
                </div>
            )}

            {/* Floating 'Add Offer/Need' Button */}
            {!selectedPost && (
                <button
                    onClick={() => onNavigate?.('map-post')}
                    className="fixed bottom-[90px] right-4 z-50 flex items-center justify-center gap-1.5 px-4 py-3 bg-gradient-to-r from-terra-500 to-terra-600 hover:from-terra-600 hover:to-terra-700 text-white font-bold rounded-full shadow-[0_6px_20px_rgb(203,83,38,0.35)] hover:shadow-[0_8px_25px_rgb(203,83,38,0.45)] transition-all hover:-translate-y-1 group text-sm"
                >
                    <span className="text-lg leading-none block group-hover:rotate-90 transition-transform duration-300">+</span> ADD POST
                </button>
            )}
            {/* Modals */}

            <CategoryPickerModal
                visible={showCategoryPicker}
                selected={categoryFilter}
                onSelect={(catId) => setCategoryFilter(catId)}
                onClose={() => setShowCategoryPicker(false)}
            />

            <MyDealsModal
                visible={showDealsModal}
                identity={identity}
                onClose={() => setShowDealsModal(false)}
                posts={posts}
                transactions={myTransactions}
                initialTab={dealsInitialTab}
                onNavigateToPost={async (postId, txId) => {
                    const found = posts.find(p => p.id === postId);
                    if (found) {
                        setSelectedPost(found);
                        if (txId) setSelectedTxId(txId);
                    }
                }}
                onPromptReview={(review) => {
                    setShowDealsModal(false);
                    setReviewStars(5);
                    setReviewComment('');
                    setPromptReviewForTx(review);
                }}
            />

            {/* Contribution-first gate: blocks accepting an Offer until the member lists one. */}
            {showContributionRequired && (
                <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/50 p-4" onClick={() => setShowContributionRequired(false)}>
                    <div className="bg-white dark:bg-nature-900 rounded-2xl p-6 max-w-sm w-full shadow-xl" onClick={e => e.stopPropagation()}>
                        <div className="text-center text-3xl mb-2">🔒</div>
                        <h3 className="text-center font-extrabold text-nature-900 dark:text-white text-lg mb-2">Contribution Required</h3>
                        <p className="text-sm text-nature-600 dark:text-nature-300 text-center leading-snug mb-5">
                            To accept Offers or post Needs, first list at least one Offer detailing what you can contribute to the community. (Or ask an Elder to vouch for you.)
                        </p>
                        <button
                            onClick={() => { setShowContributionRequired(false); onNavigate?.('map-post'); }}
                            className="w-full py-3 rounded-xl bg-emerald-600 hover:bg-emerald-700 text-white font-bold transition-colors mb-2"
                        >
                            ➕ Create an Offer
                        </button>
                        <button
                            onClick={() => setShowContributionRequired(false)}
                            className="w-full py-2.5 rounded-xl border border-nature-200 dark:border-nature-700 text-nature-600 dark:text-nature-300 font-bold hover:bg-nature-100 dark:hover:bg-nature-800 transition-colors text-sm"
                        >
                            Not now
                        </button>
                    </div>
                </div>
            )}
        </div>
    );
}

function getTimeAgo(date: Date): string {
    const secs = Math.floor((Date.now() - date.getTime()) / 1000);
    if (secs < 60) return 'just now';
    const mins = Math.floor(secs / 60);
    if (mins < 60) return `${mins}m ago`;
    const hours = Math.floor(mins / 60);
    if (hours < 24) return `${hours}h ago`;
    const days = Math.floor(hours / 24);
    return `${days}d ago`;
}
