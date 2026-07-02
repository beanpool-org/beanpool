import { useState, useEffect } from 'react';
import {
    getMemberProfile, getMemberRatings, getMarketplacePosts, getBalance, getRatingsGiven, getFriends,
    submitRating, vouchMemberApi, type MemberProfile, type Rating, type MarketplacePost, type BalanceInfo
} from '../lib/api';
import { type BeanPoolIdentity } from '../lib/identity';
import { resolveAvatarUrl } from '../lib/avatar';

interface Props {
    identity: BeanPoolIdentity;
    pubkey: string;
    onBack: () => void;
    onMessage: (pubkey: string) => void;
    onNavigatePost: (postId: string) => void;
    onEditProfile?: () => void;
    onNavigateTab?: (tab: string, subView?: string) => void;
}

export function PublicProfilePage({ identity, pubkey, onBack, onMessage, onNavigatePost, onEditProfile, onNavigateTab }: Props) {
    const [profile, setProfile] = useState<MemberProfile | null>(null);
    const [ratings, setRatings] = useState<Rating[]>([]);
    const [stats, setStats] = useState<any>(null);
    const [activePosts, setActivePosts] = useState<MarketplacePost[]>([]);
    const [loading, setLoading] = useState(true);

    const [balanceInfo, setBalanceInfo] = useState<BalanceInfo | null>(null);
    const [viewerBalance, setViewerBalance] = useState<BalanceInfo | null>(null);
    const [vouching, setVouching] = useState(false);
    const [given, setGiven] = useState<Rating[]>([]);
    const [friendsCount, setFriendsCount] = useState(0);
    const [guardianCount, setGuardianCount] = useState(0);
    const [activeTab, setActiveTab] = useState<'listings' | 'reviews' | 'given'>('listings');
    const [editingReview, setEditingReview] = useState<Rating | null>(null);
    const [reviewStars, setReviewStars] = useState(5);
    const [reviewComment, setReviewComment] = useState('');
    const [submittingReview, setSubmittingReview] = useState(false);

    const isSelf = pubkey === identity.publicKey;

    useEffect(() => {
        setLoading(true);
        Promise.all([
            getMemberProfile(pubkey, identity.publicKey).catch(() => null),
            getMemberRatings(pubkey).catch(() => null),
            getMarketplacePosts({ author: pubkey }).catch(() => []),
            isSelf ? getBalance(pubkey).catch(() => null) : Promise.resolve(null),
            isSelf ? getRatingsGiven(pubkey).catch(() => ({ ratings: [] })) : Promise.resolve({ ratings: [] }),
            isSelf ? getFriends(pubkey).catch(() => []) : Promise.resolve([]),
            // Viewer's own balance (when viewing someone else) — drives the Elder vouch button.
            isSelf ? Promise.resolve(null) : getBalance(identity.publicKey).catch(() => null),
        ]).then(([prof, rat, posts, bal, givenRatings, friends, viewerBal]) => {
            if (prof) setProfile(prof);
            if (viewerBal) setViewerBalance(viewerBal as BalanceInfo);
            if (rat) {
                setStats({ average: rat.average, count: rat.count, asProvider: rat.asProvider, asReceiver: rat.asReceiver });
                setRatings(rat.ratings || []);
            }
            if (posts) {
                setActivePosts(posts.filter(p => p.status === 'active'));
            }
            if (bal) setBalanceInfo(bal);
            if (givenRatings) setGiven(givenRatings.ratings || []);
            if (Array.isArray(friends)) {
                setFriendsCount(friends.length);
                setGuardianCount(friends.filter((f: any) => f.isGuardian).length);
            }
            setLoading(false);
        });
    }, [pubkey, identity.publicKey, isSelf]);

    const renderStars = (avg: number) => {
        const rounded = Math.round(avg || 0);
        return '★'.repeat(rounded) + '☆'.repeat(5 - rounded);
    };

    // Vouch: an appointed voucher (admin-granted can_vouch capability) can vouch for anyone.
    // Gated on the viewer's server-provided canVouch — NOT their tier. A vouch hands out the
    // chosen level's credit floor, lifting the newcomer's no-overdraft gate.
    const viewerCanVouch = !!(isSelf ? balanceInfo : viewerBalance)?.canVouch;
    const canVouch = !isSelf && viewerCanVouch && !profile?.elderVouchedBy;

    const handleVouch = async (level: 1 | 2 | 3) => {
        if (vouching) return;
        setVouching(true);
        try {
            await vouchMemberApi(pubkey, level);
            const fresh = await getMemberProfile(pubkey, identity.publicKey).catch(() => null);
            if (fresh) setProfile(fresh);
        } catch (e) {
            alert(e instanceof Error ? e.message : 'Could not vouch for this member');
        } finally {
            setVouching(false);
        }
    };

    const initial = profile?.callsign?.charAt(0).toUpperCase() || '?';
    const avatarResolved = resolveAvatarUrl(profile?.avatar);

    return (
        <div className="fixed inset-0 bg-nature-100 dark:bg-black z-50 overflow-y-auto animate-in slide-in-from-bottom-4 duration-300">
            {/* Header */}
            <div className="sticky top-0 bg-nature-100/90 dark:bg-black/90 backdrop-blur-md border-b border-nature-200 dark:border-nature-800 p-4 flex items-center justify-between z-10">
                <button onClick={onBack} className="text-nature-500 dark:text-nature-400 font-bold hover:text-nature-900 dark:hover:text-white transition-colors bg-transparent border-none cursor-pointer flex items-center gap-1">
                    <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
                    </svg>
                    Back
                </button>
                <div className="font-bold text-nature-900 dark:text-white text-lg">{isSelf ? 'My Profile' : 'Trust Profile'}</div>
                {isSelf ? (
                    <button 
                        onClick={onEditProfile}
                        className="flex items-center gap-1 px-3 py-1 rounded-lg border border-emerald-300 dark:border-emerald-800 bg-emerald-50 dark:bg-emerald-950/20 text-emerald-600 dark:text-emerald-400 font-extrabold text-sm cursor-pointer hover:bg-emerald-100/50"
                    >
                        ✏️ Edit
                    </button>
                ) : (
                    <div className="w-[60px]"></div>
                )}
            </div>

            <div className="max-w-[480px] mx-auto pb-20">
                {/* Banner Profile */}
                <div className="flex flex-col items-center p-8 border-b border-nature-200 dark:border-nature-800">
                    <div className="w-24 h-24 rounded-full mb-4 border-4 border-nature-200 dark:border-nature-800 overflow-hidden bg-oat-100 dark:bg-nature-900 flex items-center justify-center shadow-lg">
                        {avatarResolved ? (
                            <img src={avatarResolved} alt="avatar" className="w-full h-full object-cover" />
                        ) : (
                            <span className="text-4xl font-bold text-nature-400 dark:text-nature-500">{initial}</span>
                        )}
                    </div>
                    
                    <div className="text-2xl font-black text-nature-900 dark:text-white flex items-center gap-2">
                        {profile?.callsign || 'Loading...'}
                        <span className="text-emerald-500">✓</span>
                    </div>
                    
                    <div className="text-xs text-nature-400 dark:text-nature-500 font-mono bg-nature-200/50 dark:bg-nature-900 px-2 py-1 rounded mt-1">
                        {pubkey.slice(0, 16)}...
                    </div>

                    {profile?.joinedAt && (
                        <div className="text-xs text-nature-500 dark:text-nature-400 font-semibold mt-2">
                            📅 Joined {new Date(profile.joinedAt).toLocaleDateString(undefined, { month: 'long', year: 'numeric' })}
                        </div>
                    )}

                    {profile?.elderVouchedBy && (
                        <div className="mt-2 inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-amber-100 dark:bg-amber-950/30 border border-amber-300 dark:border-amber-800 text-amber-700 dark:text-amber-300 text-xs font-bold">
                            🤝 Vouched by {profile.elderVouchedByCallsign || 'a sponsor'}
                        </div>
                    )}

                    {profile?.bio && (
                        <div className="mt-4 text-sm text-nature-600 dark:text-nature-300 italic text-center max-w-sm">
                            "{profile.bio}"
                        </div>
                    )}

                    {!isSelf && (
                        <button 
                            onClick={() => onMessage(pubkey)}
                            className="mt-6 bg-emerald-600 hover:bg-emerald-500 text-white border-none rounded-xl px-6 py-2.5 font-bold cursor-pointer shadow-sm transition-transform active:scale-95 flex items-center gap-2"
                        >
                            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" />
                            </svg>
                            Send Message
                        </button>
                    )}

                    {canVouch && (
                        <div className="mt-3 w-full max-w-sm">
                            <div className="text-xs font-semibold text-nature-500 dark:text-nature-400 text-center mb-1.5">🤝 Vouch — extend a credit line (no beans leave your wallet)</div>
                            <div className="flex gap-2 justify-center">
                                {([[1, 'Light', '−25'], [2, 'Standard', '−50'], [3, 'Deep', '−100']] as const).map(([lvl, label, amt]) => (
                                    <button
                                        key={lvl}
                                        onClick={() => handleVouch(lvl)}
                                        disabled={vouching}
                                        className="flex-1 bg-amber-500 hover:bg-amber-400 disabled:opacity-60 text-white border-none rounded-xl px-3 py-2 font-bold cursor-pointer shadow-sm transition-transform active:scale-95 flex flex-col items-center leading-tight"
                                    >
                                        <span className="text-[13px]">{label}</span>
                                        <span className="text-[11px] opacity-90 font-mono">{amt}</span>
                                    </button>
                                ))}
                            </div>
                            {vouching && <div className="text-xs text-center text-nature-400 mt-1">Vouching…</div>}
                        </div>
                    )}
                </div>

                {/* Trust summary card (self only) — links to Ledger */}
                {isSelf && balanceInfo && (
                    <div 
                        onClick={() => onNavigateTab && onNavigateTab('ledger')}
                        className="flex items-center justify-between bg-white dark:bg-nature-900 border border-nature-200 dark:border-nature-800 rounded-2xl mx-4 mt-4 p-4 shadow-sm cursor-pointer hover:shadow-md transition-all duration-200"
                    >
                        <div className="flex items-center gap-3">
                            <span className="text-3xl select-none">{balanceInfo.tier?.emoji || '🌱'}</span>
                            <div className="min-w-0">
                                <h4 className="font-extrabold text-nature-950 dark:text-white text-base truncate">{balanceInfo.tier?.name || 'Member'}</h4>
                                <p className="text-xs text-nature-450 dark:text-nature-500 mt-0.5">{Math.round(balanceInfo.earnedCredit || 0)} trust points</p>
                            </div>
                        </div>
                        <div className="flex items-center gap-1.5">
                            <div className="text-right">
                                <span className="font-black text-emerald-600 dark:text-emerald-400 text-[15px]">{balanceInfo.balance >= 0 ? '+' : ''}{balanceInfo.balance.toFixed(1)}</span>
                                <p className="text-[10px] font-bold text-nature-400 uppercase tracking-wider">Beans</p>
                            </div>
                            <svg className="w-5 h-5 text-nature-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                            </svg>
                        </div>
                    </div>
                )}

                {/* Quick stats (self) — tappable through to relevant screens */}
                {isSelf && (
                    <div className="flex bg-white dark:bg-nature-900 mx-4 mt-3 rounded-2xl border border-nature-200 dark:border-nature-800 py-3.5 items-center shadow-sm">
                        <button 
                            onClick={() => onNavigateTab && onNavigateTab('people', 'friends')}
                            className="flex-1 flex flex-col items-center border-none bg-transparent cursor-pointer hover:opacity-85"
                        >
                            <span className="text-xl font-black text-nature-950 dark:text-white">{friendsCount}</span>
                            <span className="text-[10px] font-bold text-nature-400 uppercase mt-0.5">Friends</span>
                        </button>
                        <div className="w-[1px] h-8 bg-nature-200 dark:bg-nature-800" />
                        <div className="flex-1 flex flex-col items-center">
                            <span className="text-xl font-black text-nature-950 dark:text-white">
                                {balanceInfo?.trustStats?.tradeCount ?? 0}
                            </span>
                            <span className="text-[10px] font-bold text-nature-400 uppercase mt-0.5">Trades</span>
                        </div>
                        <div className="w-[1px] h-8 bg-nature-200 dark:bg-nature-800" />
                        <button 
                            onClick={() => onNavigateTab && onNavigateTab('people', 'guardians')}
                            className="flex-1 flex flex-col items-center border-none bg-transparent cursor-pointer hover:opacity-85"
                        >
                            <span className={`text-xl font-black ${
                                guardianCount >= 3 ? 'text-emerald-500' : guardianCount === 0 ? 'text-red-500' : 'text-nature-950 dark:text-white'
                            }`}>
                                {guardianCount}/5
                            </span>
                            <span className="text-[10px] font-bold text-nature-400 uppercase mt-0.5 flex items-center gap-0.5">
                                Guardians{guardianCount >= 3 ? ' ✓' : ''}
                            </span>
                        </button>
                    </div>
                )}

                {loading ? (
                    <div className="flex justify-center p-12">
                        <div className="w-8 h-8 rounded-full border-4 border-nature-200 dark:border-nature-800 border-t-emerald-500 animate-spin"></div>
                    </div>
                ) : (
                    <>
                        {/* Stats grid */}
                        {stats && stats.count > 0 && (
                            <div className="grid grid-cols-3 gap-3 p-4">
                                <div className="bg-white dark:bg-nature-900 border border-nature-200 dark:border-nature-800 rounded-xl p-3 flex flex-col items-center justify-center shadow-sm">
                                    <div className="text-amber-500 text-sm mb-1">{renderStars(stats.average)}</div>
                                    <div className="text-xl font-black text-nature-900 dark:text-white">{stats.average.toFixed(1)}</div>
                                    <div className="text-[10px] font-bold text-nature-400 dark:text-nature-500 uppercase mt-1">Overall</div>
                                </div>
                                <div className="bg-emerald-50 dark:bg-emerald-900/10 border border-emerald-100 dark:border-emerald-900/30 rounded-xl p-3 flex flex-col items-center justify-center shadow-sm">
                                    <div className="text-sm mb-1">📤</div>
                                    <div className="text-xl font-black text-emerald-600 dark:text-emerald-400">{stats.asProvider?.average.toFixed(1) || '-'}</div>
                                    <div className="text-[10px] font-bold text-emerald-600 dark:text-emerald-500 uppercase mt-1">As Provider</div>
                                </div>
                                <div className="bg-indigo-50 dark:bg-indigo-900/10 border border-indigo-100 dark:border-indigo-900/30 rounded-xl p-3 flex flex-col items-center justify-center shadow-sm">
                                    <div className="text-sm mb-1">📥</div>
                                    <div className="text-xl font-black text-indigo-600 dark:text-indigo-400">{stats.asReceiver?.average.toFixed(1) || '-'}</div>
                                    <div className="text-[10px] font-bold text-indigo-600 dark:text-indigo-500 uppercase mt-1">As Payer</div>
                                </div>
                            </div>
                        )}

                        {/* Tabs */}
                        <div className="flex bg-white dark:bg-nature-900 border-b border-nature-200 dark:border-nature-800 mt-4 px-4">
                            <button
                                className={`flex-1 py-3 text-center border-b-2 font-bold text-sm bg-transparent cursor-pointer transition-all ${
                                    activeTab === 'listings'
                                        ? 'border-emerald-500 text-emerald-600 dark:text-emerald-400 font-extrabold'
                                        : 'border-transparent text-nature-400 dark:text-nature-500 hover:text-nature-600'
                                }`}
                                onClick={() => setActiveTab('listings')}
                            >
                                Listings {activePosts.length > 0 ? `(${activePosts.length})` : ''}
                            </button>
                            <button
                                className={`flex-1 py-3 text-center border-b-2 font-bold text-sm bg-transparent cursor-pointer transition-all ${
                                    activeTab === 'reviews'
                                        ? 'border-emerald-500 text-emerald-600 dark:text-emerald-400 font-extrabold'
                                        : 'border-transparent text-nature-400 dark:text-nature-500 hover:text-nature-600'
                                }`}
                                onClick={() => setActiveTab('reviews')}
                            >
                                {isSelf ? 'Received' : 'Reviews'} {ratings.length > 0 ? `(${ratings.length})` : ''}
                            </button>
                            {isSelf && (
                                <button
                                    className={`flex-1 py-3 text-center border-b-2 font-bold text-sm bg-transparent cursor-pointer transition-all ${
                                        activeTab === 'given'
                                            ? 'border-emerald-500 text-emerald-600 dark:text-emerald-400 font-extrabold'
                                            : 'border-transparent text-nature-400 dark:text-nature-500 hover:text-nature-600'
                                    }`}
                                    onClick={() => setActiveTab('given')}
                                >
                                    Given {given.length > 0 ? `(${given.length})` : ''}
                                </button>
                            )}
                        </div>

                        {/* Tab Content */}
                        <div className="p-4">
                            {activeTab === 'listings' && (
                                <>
                                    {activePosts.length === 0 ? (
                                        <div className="bg-white dark:bg-nature-900 border border-nature-200 dark:border-nature-800 rounded-xl p-8 text-center shadow-sm">
                                            <div className="text-4xl opacity-50 mb-2">🛒</div>
                                            <div className="font-bold text-nature-500 dark:text-nature-400">No active listings.</div>
                                        </div>
                                    ) : (
                                        <div className="flex flex-col gap-3">
                                            {activePosts.map((p, i) => {
                                                let coverImage: string | null = null;
                                                if (p.photos) {
                                                    try { 
                                                        const arr = Array.isArray(p.photos) ? p.photos : JSON.parse(p.photos); 
                                                        if (arr.length > 0) coverImage = arr[0]; 
                                                    } catch {}
                                                }

                                                return (
                                                    <button 
                                                        key={p.id || i}
                                                        onClick={() => { onBack(); onNavigatePost(p.id); }}
                                                        className="bg-white dark:bg-nature-900 border border-nature-200 dark:border-nature-800 rounded-xl p-3 text-left cursor-pointer hover:-translate-y-0.5 transition-transform shadow-sm"
                                                    >
                                                        <div className="flex gap-3">
                                                            {coverImage ? (
                                                                <img src={coverImage} alt="cover" className="w-14 h-14 rounded-lg object-cover bg-nature-100 dark:bg-nature-800" />
                                                            ) : (
                                                                <div className="w-14 h-14 rounded-lg bg-nature-100 dark:bg-nature-800 flex items-center justify-center text-2xl opacity-50">
                                                                    📦
                                                                </div>
                                                            )}
                                                            <div className="flex-1 min-w-0 flex flex-col justify-center">
                                                                <div className="flex justify-between items-start mb-1">
                                                                    <div className={`text-[10px] font-bold px-1.5 py-0.5 rounded ${
                                                                        p.type === 'offer' 
                                                                            ? 'bg-emerald-100 dark:bg-emerald-900/30 text-emerald-700 dark:text-emerald-400'
                                                                            : 'bg-amber-100 dark:bg-amber-900/30 text-amber-700 dark:text-amber-400'
                                                                    }`}>
                                                                        {p.type?.toUpperCase()}
                                                                    </div>
                                                                    <div className="flex items-center gap-1">
                                                                        <span className="font-black text-sm text-indigo-600 dark:text-indigo-400">{p.credits ?? '?'}</span>
                                                                        <span className="text-[10px]">🫘</span>
                                                                    </div>
                                                                </div>
                                                                <div className="font-bold text-nature-900 dark:text-white text-sm truncate">{p.title}</div>
                                                                <div className="text-xs text-nature-400 font-medium mt-0.5">Active</div>
                                                            </div>
                                                        </div>
                                                    </button>
                                                );
                                            })}
                                        </div>
                                    )}
                                </>
                            )}

                            {activeTab === 'reviews' && (
                                <>
                                    {ratings.length === 0 ? (
                                        <div className="bg-white dark:bg-nature-900 border border-nature-200 dark:border-nature-800 rounded-xl p-8 text-center shadow-sm">
                                            <div className="text-4xl opacity-50 mb-2">🌱</div>
                                            <div className="font-bold text-nature-500 dark:text-nature-400">No reviews yet.</div>
                                        </div>
                                    ) : (
                                        <div className="flex flex-col gap-3">
                                            {ratings.map((r, i) => (
                                                <div key={i} className="bg-white dark:bg-nature-900 border border-nature-200 dark:border-nature-800 rounded-xl p-4 shadow-sm">
                                                    <div className="flex justify-between items-start mb-2">
                                                        <div className="flex items-center gap-2">
                                                            <div className="text-amber-500 text-xs">{renderStars(r.stars)}</div>
                                                            <div className={`text-[9px] font-bold uppercase px-1.5 py-0.5 rounded ${
                                                                r.role === 'provider'
                                                                    ? 'bg-emerald-50 dark:bg-emerald-900/20 text-emerald-600 dark:text-emerald-400'
                                                                    : 'bg-indigo-50 dark:bg-indigo-900/20 text-indigo-600 dark:text-indigo-400'
                                                            }`}>
                                                                {r.role === 'provider' ? 'Provided Service' : 'Paid for Service'}
                                                            </div>
                                                        </div>
                                                        <div className="text-[10px] font-bold text-nature-400 uppercase">
                                                            {new Date(r.createdAt || Date.now()).toLocaleDateString(undefined, { month: 'short', year: 'numeric' })}
                                                        </div>
                                                    </div>
                                                    {r.comment ? (
                                                        <div className="text-sm text-nature-600 dark:text-nature-300 italic bg-nature-50 dark:bg-nature-800/50 p-3 rounded-lg">
                                                            "{r.comment}"
                                                        </div>
                                                    ) : (
                                                        <div className="text-xs text-nature-400 italic">No comment provided.</div>
                                                    )}
                                                </div>
                                            ))}
                                        </div>
                                    )}
                                </>
                            )}

                            {isSelf && activeTab === 'given' && (
                                <>
                                    {given.length === 0 ? (
                                        <div className="bg-white dark:bg-nature-900 border border-nature-200 dark:border-nature-800 rounded-xl p-8 text-center shadow-sm">
                                            <div className="text-4xl opacity-50 mb-2">✍️</div>
                                            <div className="font-bold text-nature-500 dark:text-nature-400">You haven't reviewed anyone yet.</div>
                                        </div>
                                    ) : (
                                        <div className="flex flex-col gap-3">
                                            {given.map((r, i) => (
                                                <div key={r.id || i} className="bg-white dark:bg-nature-900 border border-nature-200 dark:border-nature-800 rounded-xl p-4 shadow-sm">
                                                    <div className="flex justify-between items-start mb-2">
                                                        <div className="flex items-center gap-3 min-w-0 flex-1">
                                                            {r.target_avatar ? (
                                                                <img src={resolveAvatarUrl(r.target_avatar)!} alt="avatar" className="w-7 h-7 rounded-full object-cover border" />
                                                            ) : (
                                                                <div className="w-7 h-7 rounded-full flex items-center justify-center font-bold text-xs bg-oat-105 border">
                                                                    {r.target_callsign?.charAt(0).toUpperCase() || '?'}
                                                                </div>
                                                            )}
                                                            <div className="font-bold text-[14px] text-nature-900 dark:text-white truncate">{r.target_callsign || 'Anonymous'}</div>
                                                        </div>
                                                        <div className="text-[10px] font-bold text-nature-400 uppercase">
                                                            {new Date(r.createdAt || Date.now()).toLocaleDateString(undefined, { month: 'short', year: 'numeric' })}
                                                        </div>
                                                    </div>
                                                    <div className="text-amber-500 text-xs mb-2">{renderStars(r.stars)}</div>
                                                    {r.comment ? (
                                                        <div className="text-sm text-nature-600 dark:text-nature-300 italic bg-nature-50 dark:bg-nature-800/50 p-3 rounded-lg">
                                                            "{r.comment}"
                                                        </div>
                                                    ) : (
                                                        <div className="text-xs text-nature-400 italic">No comment provided.</div>
                                                    )}

                                                    {/* Edit review button */}
                                                    {r.transactionId && (
                                                        <div className="flex justify-end mt-3 border-t border-nature-100 dark:border-nature-800 pt-2">
                                                            <button
                                                                onClick={() => {
                                                                    setEditingReview(r);
                                                                    setReviewStars(r.stars);
                                                                    setReviewComment(r.comment || '');
                                                                }}
                                                                className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border border-nature-200 dark:border-nature-800 bg-nature-50 hover:bg-nature-100 dark:bg-nature-950 dark:hover:bg-nature-900 text-nature-600 dark:text-nature-400 font-bold text-xs cursor-pointer transition-colors"
                                                            >
                                                                ✏️ Edit Review
                                                            </button>
                                                        </div>
                                                    )}
                                                </div>
                                            ))}
                                        </div>
                                    )}
                                </>
                            )}
                        </div>
                    </>
                )}
            </div>

            {/* Edit Review Modal */}
            {editingReview && (
                <div className="fixed inset-0 z-[100] flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm animate-in fade-in duration-200">
                    <div className="w-full max-w-sm bg-white dark:bg-nature-900 rounded-3xl shadow-2xl border border-nature-200 dark:border-nature-800 overflow-hidden animate-in slide-in-from-bottom-4 zoom-in-95 duration-300">
                        <div className="p-6 text-center">
                            <div className="text-4xl mb-4">✍️</div>
                            <h3 className="text-xl font-black text-nature-900 dark:text-white mb-2">Edit Your Review</h3>
                            <p className="text-nature-600 dark:text-nature-400 text-sm mb-6">
                                Update your rating for <strong>{editingReview.target_callsign || 'Partner'}</strong>
                            </p>

                            <div className="flex justify-center gap-2 mb-4 drop-shadow-sm">
                                {[1, 2, 3, 4, 5].map(star => (
                                    <button
                                        key={star}
                                        onClick={() => setReviewStars(star)}
                                        aria-label={`Rate ${star} star${star === 1 ? '' : 's'}`}
                                        className="text-4xl hover:scale-110 transition-transform bg-transparent border-none cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-500 rounded-lg"
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
                                    onClick={() => setEditingReview(null)}
                                    className="flex-1 py-3 text-nature-600 dark:text-nature-400 text-sm font-bold bg-nature-100 hover:bg-nature-200 dark:bg-nature-800 dark:hover:bg-nature-700 rounded-xl transition-colors border-none cursor-pointer"
                                >
                                    Cancel
                                </button>
                                <button
                                    disabled={submittingReview}
                                    onClick={async () => {
                                        setSubmittingReview(true);
                                        try {
                                            const txId = editingReview.transactionId;
                                            const targetPubkey = editingReview.targetPubkey;
                                            if (!txId || !targetPubkey) throw new Error('Missing transaction or user details');

                                            await submitRating(
                                                identity.publicKey,
                                                targetPubkey,
                                                reviewStars,
                                                reviewComment,
                                                txId
                                            );
                                            setEditingReview(null);
                                            // Refresh given list
                                            const res = await getRatingsGiven(pubkey).catch(() => ({ ratings: [] }));
                                            setGiven(res.ratings || []);
                                        } catch (e: any) {
                                            alert(e.message || 'Failed to update review');
                                        } finally {
                                            setSubmittingReview(false);
                                        }
                                    }}
                                    className={`flex-[1.5] py-3 text-white text-sm font-bold rounded-xl shadow-[0_4px_15px_rgb(203,83,38,0.4)] border-none cursor-pointer transition-all ${
                                        submittingReview ? 'bg-terra-400 opacity-75 cursor-not-allowed' : 'bg-gradient-to-r from-terra-500 to-amber-500 hover:-translate-y-0.5'
                                    }`}
                                >
                                    {submittingReview ? 'Updating...' : 'Update Rating'}
                                </button>
                            </div>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
}
