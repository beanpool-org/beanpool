/**
 * MarketplaceCard — FB Marketplace-style image-dominant tile
 *
 * Designed for a 2-column CSS grid:
 *  - Square photo (1:1 aspect ratio) fills the top
 *  - Price + title below in compact text
 *  - Category emoji badge overlaid on the image
 *  - Remote node badge if from a peer
 *  - Elder treatment (gold border/shadow) for high-energy users
 */

import { MARKETPLACE_CATEGORIES, POST_TYPE_COLORS, type MarketplacePost } from '../lib/marketplace';
import { PostAuthorTrust, isElder } from './PostAuthorTrust';

interface Props {
    post: MarketplacePost;
    authorRating?: { average: number; count: number };
    authorEnergy?: number;
    authorAvatarUrl?: string | null;
    remoteNode?: string;
    onTrade?: (post: MarketplacePost) => void;
    viewMode?: 'grid' | 'list' | 'compact';
    onOpenProfile?: (pubkey: string) => void;
}

export function MarketplaceCard({ post, authorRating, authorEnergy = 0, authorAvatarUrl, remoteNode, viewMode = 'grid', onOpenProfile }: Props) {
    const categoryConfig = MARKETPLACE_CATEGORIES.find((c) => c.id === post.category);
    const typeColor = POST_TYPE_COLORS[post.type];
    const emoji = categoryConfig?.emoji ?? '📦';

    const nodeBadge = remoteNode
        ? remoteNode.replace(/^https?:\/\//, '').replace(/\.beanpool\.org.*$/, '').replace(/:\d+$/, '')
        : null;

    const hasPhoto = post.photos && post.photos.length > 0;

    const isGrid = viewMode === 'grid';

    // Paused Offers show only to their author (server viewer-aware) — mark them so they're
    // distinguishable in "My Posts" from live listings.
    const isPaused = (post as any).status === 'paused';
    const pausedPill = isPaused ? (
        <span className="text-[9px] font-black uppercase tracking-wider px-2 py-0.5 rounded-md bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300 border border-amber-300/50">⏸ Paused</span>
    ) : null;

    const elderCard = isElder(authorEnergy);
    const elderStyleGrid = elderCard ? 'border-l-4 border-l-amber-400 shadow-[0_4px_15px_rgba(251,191,36,0.15)]' : '';
    const elderStyleList = elderCard ? 'border-l-4 border-l-amber-400 shadow-[0_4px_15px_rgba(251,191,36,0.1)]' : '';

    if (viewMode === 'compact') {
        // Super Condensed row layout (doubles listings shown)
        return (
            <div
                className={`bg-white dark:bg-nature-950 border border-nature-200 dark:border-nature-800 rounded-xl px-4 py-2.5 shadow-sm cursor-pointer transition-all duration-300 hover:shadow-md flex flex-row items-center justify-between w-full relative overflow-hidden ${elderStyleList}`}
            >
                <div className="flex items-center gap-3 min-w-0 flex-1">
                    {/* Compact Category Emoji */}
                    <span className="text-xl flex-shrink-0">{emoji}</span>
                    
                    {/* Title and Author */}
                    <div className="flex-1 min-w-0">
                        <h3 className="font-extrabold text-sm text-nature-950 dark:text-white truncate">
                            {post.title}
                        </h3>
                        <span className="text-[10px] text-nature-500 truncate flex items-center gap-1 flex-wrap">
                            by {post.authorCallsign || 'Anonymous'} {elderCard && '⛰️'}
                            {post.authorFoundingNeeded && (
                                <span className="text-[8px] font-black tracking-wider px-1.5 py-0.5 rounded bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-300 border border-emerald-300/30 shrink-0">
                                    🌱 FOUNDING
                                </span>
                            )}
                        </span>
                    </div>
                </div>

                <div className="flex items-center gap-4 ml-3 flex-shrink-0">
                    {/* Compact Price */}
                    <span className="font-black text-sm text-nature-950 dark:text-white flex items-center">
                        {post.credits !== undefined ? post.credits : '?'}
                        <img src="/assets/bean.png" className="mx-0.5" style={{ width: '12px', height: '12px', flexShrink: 0 }} alt="B" />
                        <span className="text-[9px] text-nature-500 font-normal">
                            {{ fixed: '', hourly: '/hr', daily: '/day', weekly: '/wk', monthly: '/mo' }[post.priceType] || ''}
                        </span>
                    </span>

                    {/* Needs / Offers pill */}
                    <span className={`text-[8px] font-black uppercase tracking-wider px-2 py-0.5 rounded ${
                        post.type === 'offer' ? 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-400'
                        : 'bg-orange-100 text-orange-850 dark:bg-orange-900/40 dark:text-orange-400'
                    }`}>
                        {post.type}
                    </span>
                </div>
            </div>
        );
    }

    if (!isGrid) {
        // Horizontal List View
        return (
            <div 
                className={`bg-white dark:bg-nature-900 border border-nature-200 dark:border-nature-800 rounded-xl p-4 shadow-sm cursor-pointer transition-all duration-300 hover:shadow-md flex flex-row gap-4 h-full w-full relative overflow-hidden ${elderStyleList}`}
            >
                {/* Left Thumbnail */}
                <div className="w-16 h-16 rounded-xl overflow-hidden shadow-inner flex-shrink-0 relative">
                    {hasPhoto ? (
                        <img src={post.photos![0]} alt={post.title} className="w-full h-full object-cover" />
                    ) : (
                        <div className="w-full h-full bg-oat-50 dark:bg-nature-800 flex justify-center items-center">
                            <span className="text-2xl opacity-40">{emoji}</span>
                        </div>
                    )}
                </div>
                
                {/* Right Content */}
                <div className="flex-1 flex flex-col justify-center min-w-0">
                    <div className="flex justify-between items-center mb-1">
                        <div className="flex gap-2 items-center">
                            <span className={`text-[9px] font-black uppercase tracking-wider px-2 py-0.5 rounded-md ${
                                post.type === 'offer' ? 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-400'
                                : 'bg-orange-105 text-orange-800 dark:bg-orange-900/40 dark:text-orange-400'
                            }`}>
                                {post.type}
                            </span>
                            {pausedPill}
                            {categoryConfig && (
                                <span className="text-[10px] font-black text-nature-500 dark:text-nature-450 flex items-center gap-1">
                                    <span>{categoryConfig.emoji}</span>
                                    <span>{categoryConfig.label}</span>
                                </span>
                            )}
                            {post.repeatable && (
                                <span className={`text-[9px] font-black tracking-wider px-2 py-0.5 rounded-md bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-400`}>
                                    ↻ RECURRING
                                </span>
                            )}
                            {post.authorFoundingNeeded && (
                                <span className="text-[9px] font-black tracking-wider px-2 py-0.5 rounded-md bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-300 border border-emerald-300/50">
                                    🌱 FOUNDING TRADE
                                </span>
                            )}
                        </div>
                        
                        {/* Compact Price Header */}
                        <div className="flex items-center">
                            <span className="font-bold text-base text-nature-950 dark:text-white" style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', flexWrap: 'nowrap' }}>
                                {post.credits !== undefined ? post.credits : '?'}
                                <img src="/assets/bean.png" className="mx-0.5" style={{ width: '14px', height: '14px', flexShrink: 0 }} alt="B" />
                                <span className="text-[10px] text-nature-500 ml-0.5">
                                    {{ fixed: '', hourly: '/hr', daily: '/day', weekly: '/wk', monthly: '/mo' }[post.priceType] || ''}
                                </span>
                            </span>
                        </div>
                    </div>

                    <h3 className="font-bold text-md text-nature-950 dark:text-white truncate mb-1">
                        {post.title}
                    </h3>

                    <PostAuthorTrust
                        callsign={post.authorCallsign || 'Anonymous'}
                        energyCycled={authorEnergy}
                        rating={authorRating}
                        avatarUrl={authorAvatarUrl}
                        publicKey={post.authorPublicKey}
                        mode="full"
                        onOpenProfile={onOpenProfile}
                    />
                </div>
                
                {/* Node Overlays - Top Right floating if remote */}
                {nodeBadge && (
                    <div className="absolute top-2 right-2 font-bold bg-indigo-500/90 text-white backdrop-blur-sm rounded-lg shadow-sm text-[0.6rem] px-1.5 py-0.5">
                        🌐 {nodeBadge}
                    </div>
                )}
            </div>
        );
    }

    // Grid View Return (Condensed tiles)
    return (
        <div
            className={`bg-white dark:bg-nature-950 overflow-hidden cursor-pointer transition-all duration-300 shadow-md hover:shadow-xl dark:shadow-2xl dark:shadow-black/40 border border-nature-100/50 dark:border-nature-800 flex flex-col h-full rounded-xl p-3 ${elderStyleGrid}`}
        >
            {/* Top Handle: Author + Title + Rating */}
            <div className={`flex justify-between items-start mb-2`}>
                <div className={`flex flex-col overflow-hidden`}>
                    <PostAuthorTrust
                        callsign={post.authorCallsign || 'Anonymous'}
                        energyCycled={authorEnergy}
                        rating={authorRating}
                        avatarUrl={authorAvatarUrl}
                        publicKey={post.authorPublicKey}
                        mode="compact"
                        className="mb-1"
                        onOpenProfile={onOpenProfile}
                    />
                    <span className={`font-bold text-nature-950 dark:text-white truncate text-xs mt-0.5`}>
                        {post.title}
                    </span>
                    {pausedPill && <div className="mt-1">{pausedPill}</div>}
                </div>

                <div className={`flex items-center shrink-0 bg-oat-50 dark:bg-nature-900 rounded-lg gap-0.5 px-1.5 py-0.5`}>
                    <span className={'text-xs my-0.5'}>{emoji}</span>
                </div>
            </div>

            {/* Image Area */}
            {hasPhoto ? (
                <div className={`relative w-full rounded-xl overflow-hidden shadow-sm h-[110px] mb-3`}>
                    <img src={post.photos![0]} alt={post.title} className="w-full h-full object-cover" />

                    {/* Status Overlays */}
                    <div className={`absolute left-2 flex flex-col gap-1 items-start top-1.5`}>
                        {post.status === 'pending' && (
                            <span className={`font-bold bg-amber-400 text-amber-950 rounded-lg shadow-sm text-[0.6rem] px-1.5 py-0.5`}>
                                ⏳ PENDING
                            </span>
                        )}
                        {nodeBadge && (
                            <span className={`font-bold bg-indigo-500/90 text-white backdrop-blur-sm rounded-lg shadow-sm text-[0.6rem] px-1.5 py-0.5`}>
                                🌐 {nodeBadge}
                            </span>
                        )}
                        {post.authorFoundingNeeded && (
                            <span className={`font-bold bg-emerald-500/90 text-white backdrop-blur-sm rounded-lg shadow-sm text-[0.6rem] px-1.5 py-0.5`}>
                                🌱 FOUNDING TRADE
                            </span>
                        )}
                    </div>

                    {/* Price Overlay */}
                    <div className={`absolute right-2 bg-nature-900/90 backdrop-blur-md text-white font-bold tracking-tight shadow-md bottom-2 px-2.5 py-1 rounded-lg text-sm`}>
                        <span style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', flexWrap: 'nowrap' }}>
                            <span>{post.credits !== undefined ? post.credits : '?'}</span>
                            <span className="text-[10px] font-normal opacity-80 pl-0.5 flex items-center" style={{ flexShrink: 0 }}>
                                <img src="/assets/bean.png" style={{ width: '12px', height: '12px', marginLeft: '2px', marginRight: '2px', flexShrink: 0 }} alt="B" />
                                {{ fixed: '', hourly: '/hr', daily: '/day', weekly: '/wk', monthly: '/mo' }[post.priceType] || ''}
                            </span>
                        </span>
                    </div>

                    {/* Recurring Overlay */}
                    {post.repeatable && (
                        <div className={`absolute left-2 bg-terra-500/90 backdrop-blur-md text-white font-bold tracking-tight shadow-md bottom-2 px-2 py-1 rounded-lg text-[10px]`}>
                            ↻ RECURRING
                        </div>
                    )}
                </div>
            ) : (
                <div className={`relative w-full rounded-xl bg-oat-50 dark:bg-nature-900 flex items-center justify-center shadow-inner h-[80px] mb-3`}>
                    <span className={`text-3xl opacity-20`}>{emoji}</span>
                    
                    {/* Status Overlays */}
                    <div className={`absolute left-2 flex flex-col gap-1 items-start top-1.5`}>
                        {post.status === 'pending' && (
                            <span className={`font-bold bg-amber-400 text-amber-950 rounded-lg shadow-sm text-[0.6rem] px-1.5 py-0.5`}>
                                ⏳ PENDING
                            </span>
                        )}
                        {nodeBadge && (
                            <span className={`font-bold bg-indigo-500/90 text-white backdrop-blur-sm rounded-lg shadow-sm text-[0.6rem] px-1.5 py-0.5`}>
                                🌐 {nodeBadge}
                            </span>
                        )}
                        {post.authorFoundingNeeded && (
                            <span className={`font-bold bg-emerald-500/90 text-white backdrop-blur-sm rounded-lg shadow-sm text-[0.6rem] px-1.5 py-0.5`}>
                                🌱 FOUNDING TRADE
                            </span>
                        )}
                    </div>

                    <div className={`absolute right-2 bg-nature-900/90 backdrop-blur-md text-white font-bold tracking-tight shadow-md bottom-2 px-2.5 py-1 rounded-lg text-sm`}>
                        <span style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', flexWrap: 'nowrap' }}>
                            <span>{post.credits !== undefined ? post.credits : '?'}</span>
                            <span className="text-[10px] font-normal opacity-80 pl-0.5 flex items-center" style={{ flexShrink: 0 }}>
                                <img src="/assets/bean.png" style={{ width: '12px', height: '12px', marginLeft: '2px', marginRight: '2px', flexShrink: 0 }} alt="B" />
                                {{ fixed: '', hourly: '/hr', daily: '/day', weekly: '/wk', monthly: '/mo' }[post.priceType] || ''}
                            </span>
                        </span>
                    </div>

                    {/* Recurring Overlay */}
                    {post.repeatable && (
                        <div className={`absolute left-2 bg-terra-500/90 backdrop-blur-md text-white font-bold tracking-tight shadow-md bottom-2 px-2 py-1 rounded-lg text-[10px]`}>
                            ↻ RECURRING
                        </div>
                    )}
                </div>
            )}

            {/* Body Text */}
            <p className={`text-nature-600 dark:text-nature-400 leading-relaxed px-1 flex-1 text-[11px] line-clamp-1 mb-3`}>
                {post.description || "No description provided."}
            </p>

            {/* Action Button */}
            <div
                className={`w-full rounded-full font-bold tracking-widest text-center transition-colors shadow-sm py-2 text-[10px] mt-auto ${post.type === 'offer'
                        ? 'bg-terra-500 text-white hover:bg-terra-600'
                        : 'bg-nature-700 text-white dark:bg-nature-800 hover:bg-nature-800'
                    }`}
            >
                VIEW
            </div>
        </div>
    );
}
