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

import { MARKETPLACE_CATEGORIES_BY_ID, POST_TYPE_COLORS, formatNodeName, type MarketplacePost } from '../lib/marketplace';
import { PostAuthorTrust, isElder } from './PostAuthorTrust';
import { formatNumber, listPhotoUrl, t } from '@beanpool/core';
import { Sentence } from './Sentence';
import { CategoryTile } from './CategoryTile';

/** A listing's type on its badge (the badge's `uppercase` class puts it in capitals); a type this build doesn't know, as written. */
function typeWords(type: string): string {
    return type === 'offer' ? t('offer', undefined, 'post type') : type === 'need' ? t('need', undefined, 'post type') : String(type ?? '');
}

/** The unit after a price ("/hr"), as the web card always wrote it; nothing for a fixed price. */
function priceUnit(priceType: string | undefined): string {
    if (priceType === 'hourly') return t('/hr', undefined, 'price per hour');
    if (priceType === 'daily') return t('/day', undefined, 'price per day');
    if (priceType === 'weekly') return t('/wk', undefined, 'price per week');
    if (priceType === 'monthly') return t('/mo', undefined, 'price per month');
    return '';
}

/** The price on a card: the language's decimal mark, English as before; "?" when the listing has none. */
function priceAmount(credits: number | null | undefined): string {
    if (credits === undefined) return '?';
    return typeof credits === 'number' ? formatNumber(credits) : String(credits ?? '');
}

/**
 * "2.4 km" / "800 m", in the member's language, with the phone's words (utils/events.ts formatDistance): the same
 * numbers lib/events.ts formatDistance writes, which is still English for the screens that share it.
 */
function distanceWords(km: number): string {
    if (km < 1) return t('{distance} m', { distance: Math.max(10, Math.round((km * 1000) / 10) * 10) });
    if (km < 10) return t('{distance} km', { distance: formatNumber(km, 1) });
    return t('{distance} km', { distance: Math.round(km) });
}

interface Props {
    post: MarketplacePost;
    authorRating?: { average: number; count: number };
    authorEnergy?: number;
    authorAvatarUrl?: string | null;
    remoteNode?: string;
    onTrade?: (post: MarketplacePost) => void;
    viewMode?: 'grid' | 'list' | 'compact';
    onOpenProfile?: (pubkey: string) => void;
    isOwnPost?: boolean;
    onPhotoClick?: (photos: string[], initialIndex: number, e: React.MouseEvent) => void;
    /** How far the listing is (km), as the node measured it from the point the Market read from; none, no distance. */
    distanceKm?: number | null;
    /**
     * Beans live in a local community for this reader (preview or read-only, lib/features `marked`): no price, no
     * founding-trade chip, no tier badge or Elder look. There every price reads 0 and every author is a Newcomer with
     * a founding trade to make, which can't happen on that node (DESIGN-global-showcase-fable.md §1–§2).
     */
    beansMarked?: boolean;
}

export function MarketplaceCard({ post, authorRating, authorEnergy = 0, authorAvatarUrl, remoteNode, viewMode = 'grid', onOpenProfile, isOwnPost, onPhotoClick, distanceKm, beansMarked = false }: Props) {
    const categoryConfig = MARKETPLACE_CATEGORIES_BY_ID.get(post.category);
    const isPulse = post.authorCallsign === 'Daily Pulse' || (post as any).author_callsign === 'Daily Pulse';
    const emoji = isPulse ? '🗞️' : (categoryConfig?.emoji ?? '📦');

    const nodeBadge = formatNodeName(
        remoteNode || (post as any)?._remoteNode || (post as any)?.originNode,
        (post as any)?._remoteCallsign
    ) || null;

    const hasPhoto = post.photos && post.photos.length > 0;
    // The price and the founding-trade chip are Beans: neither shows where Beans are marked (`beansMarked`).
    const showPrice = !isPulse && !beansMarked;
    const foundingChip = !!post.authorFoundingNeeded && !beansMarked;

    // On the photo: at most ONE status chip, by precedence PENDING > YOU > RECURRING.
    const statusChip = (() => {
        if (post.status === 'pending') {
            return {
                text: t('⏳ PENDING'),
                className: 'bg-amber-400 text-amber-950',
            };
        }
        if (isOwnPost) {
            return {
                text: t('👤 YOU'),
                className: 'bg-blue-600 text-white',
            };
        }
        if (post.repeatable) {
            return {
                text: t('↻ RECURRING'),
                className: 'bg-bp-cta-fill text-bp-cta-on',
            };
        }
        return null;
    })();

    const isGrid = viewMode === 'grid';
    // How far, as the node measured it (S5): one tag for every layout, nothing without a number.
    const distanceTag = typeof distanceKm === 'number' && Number.isFinite(distanceKm) ? (
        <span data-testid="card-distance" className="text-[10px] font-black text-nature-500 dark:text-nature-400 inline-flex items-center gap-1 shrink-0">
            <span aria-hidden="true">📍</span>
            <span>{distanceWords(distanceKm)}</span>
        </span>
    ) : null;

    // Paused Offers show only to their author (server viewer-aware) — mark them so they're
    // distinguishable in "My Posts" from live listings.
    const isPaused = post.status === 'paused';
    const pausedPill = isPaused ? (
        <span className="text-[9px] font-black uppercase tracking-wider px-2 py-0.5 rounded-md bg-bp-chip-warn-tint text-bp-chip-warn-ink border border-transparent">{t('⏸ Paused')}</span>
    ) : null;
    const youPill = isOwnPost ? (
        <span className="text-[9px] font-black uppercase tracking-wider px-2 py-0.5 rounded-md bg-blue-100 text-blue-800 dark:bg-blue-900/40 dark:text-blue-300 border border-blue-300/50">{t('👤 You')}</span>
    ) : null;
    const pulsePill = isPulse ? (
        <span className="text-[9px] font-black uppercase tracking-wider px-2 py-0.5 rounded-md bg-bp-chip-warn-tint text-bp-chip-warn-ink border border-transparent shadow-sm">{t('🗞️ Daily Pulse')}</span>
    ) : null;

    const elderCard = !beansMarked && isElder(authorEnergy);
    const isGroupScope = post.audienceScope === 'group' || !!post.targetGroupId;
    // The group's name is its members' own, shown as written inside the sentence.
    const targetGroupName = post.targetGroupName || t('Group');
    const groupScopeBadge = isGroupScope ? t('🔒 Only {group} can see this', { group: targetGroupName }) : null;
    const authorName = post.authorCallsign || t('Anonymous');
    const elderStyleGrid = isPulse
        ? 'border-2 border-amber-400/80 dark:border-amber-500/70 shadow-[0_4px_20px_rgba(245,158,11,0.18)] bg-gradient-to-b from-amber-50/30 to-transparent dark:from-amber-950/20'
        : elderCard ? 'border-l-4 border-l-amber-400 shadow-[0_4px_15px_rgba(251,191,36,0.15)]' : '';
    const elderStyleList = isPulse
        ? 'border-2 border-amber-400/80 dark:border-amber-500/70 shadow-[0_4px_20px_rgba(245,158,11,0.15)] bg-amber-50/20 dark:bg-amber-950/20'
        : elderCard ? 'border-l-4 border-l-amber-400 shadow-[0_4px_15px_rgba(251,191,36,0.1)]' : '';

    if (viewMode === 'compact') {
        // Super Condensed row layout (doubles listings shown)
        return (
            <div
                className={`bg-white dark:bg-nature-950 border border-nature-200 dark:border-nature-800 rounded-xl px-4 py-2.5 shadow-sm cursor-pointer transition-all duration-300 hover:shadow-md flex flex-row items-center justify-between w-full relative overflow-hidden ${elderStyleList}`}
            >
                <div className="flex items-center gap-3 min-w-0 flex-1">
                    {/* Compact Category Picture / Tile */}
                    <div className="w-8 h-8 rounded-lg overflow-hidden shrink-0">
                        {hasPhoto ? (
                            <img src={listPhotoUrl(post.photos![0])} alt={post.title} className="w-full h-full object-cover" />
                        ) : (
                            <CategoryTile category={post.category} kind={isPulse ? 'pulse' : (post.type === 'event' ? 'event' : 'listing')} size="thumb" />
                        )}
                    </div>
                    
                    {/* Title and Author */}
                    <div className="flex-1 min-w-0">
                        <h3 dir="auto" className="font-extrabold text-sm text-nature-950 dark:text-white truncate">
                            {post.title}
                        </h3>
                        <span className="text-[10px] text-nature-500 flex items-center gap-1 flex-wrap min-w-0 break-words">
                            {/* One sentence per variant, as the phone's byLine: the name is the member's, the Elder mark
                                and the blue "(You)" are parts of it wherever the language puts them. */}
                            {isOwnPost ? (
                                <Sentence
                                    text={elderCard ? t('by {name} ⛰️ {you}', { name: authorName }) : t('by {name} {you}', { name: authorName })}
                                    parts={{ you: <span className="text-blue-600 dark:text-blue-400 font-bold">{t('👤 (You)')}</span> }}
                                />
                            ) : elderCard ? t('by {name} ⛰️', { name: authorName }) : t('by {name}', { name: authorName })}
                            {distanceTag}
                            {foundingChip && (
                                <span data-testid="author-founding" className="text-[8px] font-black tracking-wider px-1.5 py-0.5 rounded bg-bp-chip-ok-tint text-bp-chip-ok-ink border border-transparent min-w-0 max-w-full whitespace-normal break-words">
                                    {t('🌱 FOUNDING')}
                                </span>
                            )}
                            {groupScopeBadge && (
                                <span className="text-[8px] font-black tracking-wider px-1.5 py-0.5 rounded bg-bp-chip-ok-tint text-bp-chip-ok-ink border border-transparent min-w-0 max-w-full whitespace-normal break-words">
                                    {groupScopeBadge}
                                </span>
                            )}
                        </span>
                    </div>
                </div>

                {/* The price and the type pill: side by side while there is room; on a narrow screen (320 px, 1.3x text) or
                    in a longer language the pill drops under the price, so the title keeps its width. */}
                <div className="flex flex-wrap items-center justify-end gap-x-2 gap-y-1 ml-3 max-w-[45%]">
                    {/* Compact Price */}
                    {showPrice && (
                        <span className="font-black text-sm text-nature-950 dark:text-white flex items-center">
                            {priceAmount(post.credits)}
                            <img src="/assets/bean.png" className="mx-0.5" style={{ width: '12px', height: '12px', flexShrink: 0 }} alt={t('B', undefined, 'the Beans sign')} />
                            <span className="text-[9px] text-nature-500 font-normal">
                                {priceUnit(post.priceType)}
                            </span>
                        </span>
                    )}

                    {/* Daily Pulse or Needs/Offers pill */}
                    {isPulse ? (
                        <span className="text-[8px] font-black uppercase tracking-wider px-2 py-0.5 rounded bg-bp-chip-warn-tint text-bp-chip-warn-ink border border-transparent shadow-sm">
                            {t('PULSE')}
                        </span>
                    ) : (
                        <span className={`text-[8px] font-black uppercase tracking-wider px-2 py-0.5 rounded ${
                            post.type === 'offer' ? 'bg-bp-chip-ok-tint text-bp-chip-ok-ink'
                            : 'bg-bp-chip-need-tint text-bp-chip-need-ink'
                        }`}>
                            {typeWords(post.type)}
                        </span>
                    )}
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
                {/* Left Thumbnail (80px) */}
                <div className="w-20 h-20 rounded-xl overflow-hidden shadow-inner flex-shrink-0 relative">
                    {hasPhoto ? (
                        <button
                            type="button"
                            onClick={(e) => {
                                if (onPhotoClick) {
                                    e.stopPropagation();
                                    onPhotoClick(post.photos!, 0, e);
                                }
                            }}
                            onKeyDown={(e) => {
                                if (onPhotoClick && (e.key === 'Enter' || e.key === ' ')) {
                                    e.stopPropagation();
                                    e.preventDefault();
                                    onPhotoClick(post.photos!, 0, e as any);
                                }
                            }}
                            aria-label={t('View enlarged photo: {title}', { title: post.title })}
                            className={`w-full h-full block rounded-xl overflow-hidden ${
                                onPhotoClick ? 'cursor-zoom-in focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nature-500' : ''
                            }`}
                        >
                            <img src={listPhotoUrl(post.photos![0])} alt={post.title} className="w-full h-full object-cover" />
                        </button>
                    ) : (
                        <CategoryTile category={post.category} kind={isPulse ? 'pulse' : (post.type === 'event' ? 'event' : 'listing')} size="thumb" />
                    )}
                </div>
                
                {/* Right Content */}
                <div className="flex-1 flex flex-col justify-center min-w-0">
                    <div className="flex justify-between items-center mb-1">
                        {/* Wraps, so at 320 px / 130% the distance tag drops to a second line rather than past the card edge. */}
                        <div className="flex flex-wrap gap-x-2 gap-y-1 items-center min-w-0">
                            {!isPulse && (
                                <span className={`text-[9px] font-black uppercase tracking-wider px-2 py-0.5 rounded-md ${
                                    post.type === 'offer' ? 'bg-bp-chip-ok-tint text-bp-chip-ok-ink'
                                    : 'bg-bp-chip-need-tint text-bp-chip-need-ink'
                                }`}>
                                    {typeWords(post.type)}
                                </span>
                            )}
                            {pulsePill}
                            {youPill}
                            {pausedPill}
                            {categoryConfig && (
                                <span className="text-[10px] font-black text-nature-500 dark:text-nature-400 flex items-center gap-1">
                                    <span>{categoryConfig.emoji}</span>
                                    <span>{t(categoryConfig.label)}</span>
                                </span>
                            )}
                            {distanceTag}
                            {post.repeatable && (
                                <span className={`text-[9px] font-black tracking-wider px-2 py-0.5 rounded-md bg-bp-chip-warn-tint text-bp-chip-warn-ink`}>
                                    {t('↻ RECURRING')}
                                </span>
                            )}
                            {/* #108: on the card, not just the detail view — the point of the flag is
                                that nobody discovers a cash requirement in paragraph three. */}
                            {post.cashAlsoNeeded && (
                                <span
                                    className="text-[9px] font-black tracking-wider px-2 py-0.5 rounded-md bg-bp-chip-need-tint text-bp-chip-need-ink"
                                    title={t('Cash also needed for fuel or materials — agreed in chat')}
                                >
                                    {t('💸 CASH TOO')}
                                </span>
                            )}
                            {groupScopeBadge && (
                                <span className="text-[9px] font-black tracking-wider px-2 py-0.5 rounded-md bg-bp-chip-ok-tint text-bp-chip-ok-ink border border-transparent">
                                    {groupScopeBadge}
                                </span>
                            )}
                        </div>
                        
                        {/* Compact Price Header */}
                        {showPrice && (
                            <div className="flex items-center">
                                <span className="font-bold text-base text-nature-950 dark:text-white" style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', flexWrap: 'nowrap' }}>
                                    {priceAmount(post.credits)}
                                    <img src="/assets/bean.png" className="mx-0.5" style={{ width: '14px', height: '14px', flexShrink: 0 }} alt={t('B', undefined, 'the Beans sign')} />
                                    <span className="text-[10px] text-nature-500 dark:text-nature-400 ml-0.5">
                                        {priceUnit(post.priceType)}
                                    </span>
                                </span>
                            </div>
                        )}
                    </div>

                    <h3 dir="auto" className="font-bold text-md text-nature-950 dark:text-white truncate mb-1">
                        {post.title}
                    </h3>

                    <PostAuthorTrust
                        callsign={authorName}
                        energyCycled={authorEnergy}
                        rating={authorRating}
                        avatarUrl={authorAvatarUrl}
                        publicKey={post.authorPublicKey}
                        mode="full"
                        showTier={!beansMarked}
                        isFounding={!beansMarked && !!post.authorFoundingNeeded}
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
    // Rebuilt on the phone's layout (market.tsx grid card):
    // Photo (or CategoryTile) square and edge-to-edge at card top, radius 14, no inner padding frame;
    // Type pill top-leading, price pill bottom-trailing; title under the photo (clamped to two lines).
    // No description line and no VIEW button on non-Pulse cards.
    return (
        <div
            className={`bg-white dark:bg-nature-950 overflow-hidden cursor-pointer transition-all duration-300 shadow-sm hover:shadow-md border border-nature-200 dark:border-nature-800 flex flex-col rounded-[14px] ${elderStyleGrid}`}
        >
            {/* Square Media Box at Card Top (edge to edge, radius 14) */}
            <div className="relative w-full aspect-square overflow-hidden">
                {hasPhoto ? (
                    <button
                        type="button"
                        onClick={(e) => {
                            if (onPhotoClick) {
                                e.stopPropagation();
                                onPhotoClick(post.photos!, 0, e);
                            }
                        }}
                        onKeyDown={(e) => {
                            if (onPhotoClick && (e.key === 'Enter' || e.key === ' ')) {
                                e.stopPropagation();
                                e.preventDefault();
                                onPhotoClick(post.photos!, 0, e as any);
                            }
                        }}
                        aria-label={t('View enlarged photo: {title}', { title: post.title })}
                        className={`w-full h-full block overflow-hidden ${
                            onPhotoClick ? 'cursor-zoom-in focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nature-500' : ''
                        }`}
                    >
                        <img src={listPhotoUrl(post.photos![0])} alt={post.title} className="w-full h-full object-cover" />
                    </button>
                ) : (
                    <CategoryTile
                        category={post.category}
                        kind={isPulse ? 'pulse' : (post.type === 'event' ? 'event' : 'listing')}
                        size="grid"
                    />
                )}

                {/* Top-leading: Type pill (unless pulse) */}
                {!isPulse && (
                    <div className="absolute top-2 left-2">
                        <span className={`text-[10px] font-black uppercase tracking-wider px-2 py-0.5 rounded-lg ${
                            post.type === 'offer'
                                ? 'bg-bp-chip-ok-tint text-bp-chip-ok-ink'
                                : 'bg-bp-chip-need-tint text-bp-chip-need-ink'
                        }`}>
                            {typeWords(post.type)}
                        </span>
                    </div>
                )}

                {/* Top-trailing: Remote node badge if any */}
                {nodeBadge && (
                    <div className="absolute top-2 right-2 font-bold bg-indigo-500/90 text-white backdrop-blur-sm rounded-lg shadow-sm text-[0.6rem] px-1.5 py-0.5">
                        🌐 {nodeBadge}
                    </div>
                )}

                {/* Foot of photo: status chip on left, price pill bottom-trailing on right */}
                <div data-testid="grid-badge-row" className="absolute left-2 right-2 bottom-2 flex flex-wrap items-end justify-between gap-1 pointer-events-none">
                    {/* Status chip: at most ONE by precedence PENDING > YOU > RECURRING */}
                    {statusChip ? (
                        <div className={`font-bold rounded-lg shadow-sm text-[0.6rem] px-2 py-1 pointer-events-auto ${statusChip.className}`}>
                            {statusChip.text}
                        </div>
                    ) : <div />}

                    {/* Price pill bottom-trailing */}
                    {showPrice && (
                        <div className="ml-auto bg-nature-900/90 backdrop-blur-md text-white font-bold tracking-tight shadow-md bottom-2 px-2.5 py-1 rounded-lg text-sm pointer-events-auto">
                            <span style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', flexWrap: 'nowrap' }}>
                                <span>{priceAmount(post.credits)}</span>
                                <span className="text-[10px] font-normal opacity-80 pl-0.5 flex items-center" style={{ flexShrink: 0 }}>
                                    <img src="/assets/bean.png" style={{ width: '12px', height: '12px', marginLeft: '2px', marginRight: '2px', flexShrink: 0 }} alt={t('B', undefined, 'the Beans sign')} />
                                    {priceUnit(post.priceType)}
                                </span>
                            </span>
                        </div>
                    )}
                </div>
            </div>

            {/* Content under the photo */}
            <div className="p-3 flex flex-col gap-1 min-w-0 flex-1">
                {/* Two-line title */}
                <h3 dir="auto" className="font-bold text-sm text-nature-950 dark:text-white line-clamp-2 leading-snug">
                    {post.cashAlsoNeeded && <span className="mr-0.5">💸</span>}
                    {post.title}
                </h3>

                {/* Author line with PostAuthorTrust */}
                <PostAuthorTrust
                    callsign={authorName}
                    energyCycled={authorEnergy}
                    rating={authorRating}
                    avatarUrl={authorAvatarUrl}
                    publicKey={post.authorPublicKey}
                    mode="compact"
                    showTier={!beansMarked}
                    isFounding={!beansMarked && !!post.authorFoundingNeeded}
                    onOpenProfile={onOpenProfile}
                />

                {/* Group lock line stays under the author */}
                {groupScopeBadge && (
                    <div className="mt-1">
                        <span className="text-[9px] font-black tracking-wider px-1.5 py-0.5 rounded bg-bp-chip-ok-tint text-bp-chip-ok-ink border border-transparent block break-words">
                            {groupScopeBadge}
                        </span>
                    </div>
                )}

                {/* Distance tag */}
                {distanceTag && <div className="mt-0.5">{distanceTag}</div>}

                {/* Paused pill */}
                {pausedPill && <div className="mt-1">{pausedPill}</div>}

                {/* Daily Pulse keeps its description and button */}
                {isPulse && (
                    <>
                        {pulsePill && <div className="mt-1">{pulsePill}</div>}
                        {post.description && (
                            <p dir="auto" className="text-nature-600 dark:text-nature-400 leading-relaxed text-[11px] line-clamp-1 mt-2 mb-2">
                                {post.description}
                            </p>
                        )}
                        <div className="w-full rounded-full font-bold tracking-widest text-center transition-colors shadow-sm py-2 text-[10px] mt-auto bg-amber-100 text-amber-900 dark:bg-amber-900/60 dark:text-amber-300 border border-amber-400/60 cursor-default">
                            {t('DAILY PULSE')}
                        </div>
                    </>
                )}
            </div>
        </div>
    );
}
}
