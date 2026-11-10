/**
 * MarketplaceCard — FB Marketplace-style image-dominant tile
 *
 * Designed for a 2-column CSS grid:
 *  - 4:3 photo (4:3 landscape aspect ratio) fills the top
 *  - Price + title below in compact text
 *  - Category emoji badge overlaid on the image
 *  - Remote node badge if from a peer
 *  - Elder treatment (gold border/shadow) for high-energy users
 */

import { type CSSProperties, type ReactNode } from 'react';
import { MARKETPLACE_CATEGORIES_BY_ID, POST_TYPE_COLORS, formatNodeName, typeWords, type MarketplacePost } from '../lib/marketplace';
import { PostAuthorTrust, isElder } from './PostAuthorTrust';
import { copyPriceLine, eventCopyOf, formatNumber, freePriceWords, listingChipWords, pinLive, t, upperCase, type ListingChip, formatHundredths } from '@beanpool/core';
import { Sentence } from './Sentence';
import { CategoryTile } from './CategoryTile';
import { styleUntilDrawn, useListPhotoSteps } from '../lib/use-list-photo-steps';
import { CARD_INK, COMPACT_END, COMPACT_LEAD, COMPACT_PICTURE, COMPACT_ROW, COMPACT_TEXT, COMPACT_TITLE, GRID_PHOTO, GRID_ROW, GRID_SCRIM_PILL, GRID_TEXT, GRID_TITLE, LIST_BEAN_PX, LIST_PHOTO, LIST_PHOTO_FILL, LIST_TEXT, LIST_TYPE, POP_UP_CLOSE_ROOM, chip, gridChip, gridTile, listCard } from './market-card-shell';

/** The grid's 4:3 frame anchors upright photos towards the top third (market-card-43). */
const GRID_CROP: CSSProperties = { objectPosition: '50% 33%' };

/** The unit after a price ("/hr"), as the web card always wrote it; nothing for a fixed price. */
function priceUnit(priceType: string | undefined): string {
    if (priceType === 'hourly') return t('/hr', undefined, 'price per hour');
    if (priceType === 'daily') return t('/day', undefined, 'price per day');
    if (priceType === 'weekly') return t('/wk', undefined, 'price per week');
    if (priceType === 'monthly') return t('/mo', undefined, 'price per month');
    return '';
}

/** The price on a card: the language's decimal mark, English as before; "?" when the listing has none. */
function priceAmount(price_c: number | null | undefined): string {
    if (price_c === undefined) return '?';
    return typeof price_c === 'number' ? formatHundredths(price_c) : String(price_c ?? '');
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
    isOwnPost?: boolean;
    /** How far the listing is (km), as the node measured it from the point the Market read from; none, no distance. */
    distanceKm?: number | null;
    /**
     * Beans live in a local community for this reader (preview or read-only, lib/features `marked`): no price, no
     * founding-trade chip, no tier badge or Elder look. There every price reads 0 and every author is a Newcomer with
     * a founding trade to make, which can't happen on that node (DESIGN-global-showcase-fable.md §1–§2).
     */
    beansMarked?: boolean;
    /**
     * A deal of the reader's own on this listing, held in trust or asked for (@beanpool/core listingChips): only for the
     * people the deal belongs to, never a stranger, so a card never says who traded (DESIGN-deals-fable §3.3).
     */
    dealChip?: ListingChip | null;
    /**
     * The map's pop-up (DESIGN-card-style-box-fable.md §2, slice M1): the list card with the pop-up's ✕ in its top end
     * corner, which the map draws beside the card's tap target. The first row keeps room for it, and the community a
     * listing comes from is a chip in that row instead of a badge in the corner the ✕ takes. List view only.
     */
    popUp?: boolean;
}

export function MarketplaceCard({ post, authorRating, authorEnergy = 0, authorAvatarUrl, remoteNode, viewMode = 'grid', isOwnPost, distanceKm, beansMarked = false, dealChip = null, popUp = false }: Props) {
    const categoryConfig = MARKETPLACE_CATEGORIES_BY_ID.get(post.category);
    const isPulse = post.authorCallsign === 'Daily Pulse' || (post as any).author_callsign === 'Daily Pulse';
    const emoji = isPulse ? '🗞️' : (categoryConfig?.emoji ?? '📦');

    const nodeBadge = formatNodeName(
        remoteNode || (post as any)?._remoteNode || (post as any)?.originNode,
        (post as any)?._remoteCallsign
    ) || null;

    const firstPhoto = post.photos && post.photos.length > 0 ? post.photos[0] : null;
    const bannerUrl = post.authorBannerUrl || (post as any)?.author_banner_url || null;
    // A picture that will not load steps down, each step once, and never leaves a broken image or an empty box (review of
    // #2565, finding 8; card-photo-retry, Marty 4 Nov 2026: a card on global missed its photo in the list and showed it when
    // opened): a listing photo's small copy gives way to the photo's own URL, and that to the tile (@beanpool/core
    // nextListPhotoUrl). A banner has no small copy, so it goes straight to the tile: a weak connection, or a URL from before
    // the enterprise changed it. The URL that failed is kept beside its step, not a flag, so a new URL a later read brings
    // starts again from its small copy.
    // card-photo-blank (Marty, 4 Nov 2026): the small copy is asked once more past every cache before the photo's own URL,
    // the tile holds the slot until the picture has fired load, and one that neither loads nor fails in time counts as
    // failed (lib/use-list-photo-steps.ts), so no state leaves an empty box.
    const pictureUrl: string | null = firstPhoto || bannerUrl || null;
    const pictureSteps = useListPhotoSteps(pictureUrl);
    // What is drawn now: null is the tile.
    const displayImage = pictureSteps.shown;
    /** The picture in its box: the tile until it has drawn, the photo after. */
    const cardPicture = (tile: ReactNode, imgStyle?: CSSProperties, imgClass = 'w-full h-full object-cover') => (
        <>
            {pictureSteps.drawn ? null : tile}
            <img
                src={displayImage ?? undefined}
                alt={post.title}
                aria-hidden={pictureSteps.drawn ? undefined : true}
                className={imgClass}
                style={styleUntilDrawn(imgStyle, pictureSteps.drawn)}
                onLoad={pictureSteps.onLoad}
                onError={pictureSteps.onError}
            />
        </>
    );
    // The photo is part of the card: a tap on it opens the listing, as on the phone (Marty's standing rule, small-cards-open-the-item).
    // The enlarge lives on the listing's own page, never on a card (no button, so the card stays one element).
    // A member's copy on the global community: where it is from and its price there, in words, where its author would be.
    const copy = eventCopyOf(post);
    // The price and the founding-trade chip are Beans: neither shows where Beans are marked (`beansMarked`). A copy's `credits`
    // is 0 and no price: its line says what it is at home.
    const showPrice = !isPulse && !beansMarked && !copy;
    // A listing priced at 0 reads "Free" (core listing-price.ts, the one rule both apps read), in the price's own place: no Beans
    // sign and no unit, and a screen reader reads "Free", not "0 B".
    const freePrice = showPrice ? freePriceWords(post.price_c, post.type) : null;
    const foundingChip = !!post.authorFoundingNeeded && !beansMarked;

    // On the photo: at most ONE status chip, by precedence PENDING > YOU.
    // RECURRING is placed under the photo in grid view so overlays fit at 320dp / 1.3x text (market-card-43).
    const statusChip = (() => {
        if (post.status === 'pending') {
            return {
                text: t('⏳ PENDING'),
                className: 'bg-bp-gold-fill text-bp-gold-on',
            };
        }
        if (isOwnPost) {
            return {
                text: t('👤 YOU'),
                className: 'bg-blue-600 text-white',
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
    const dealPill = dealChip ? (
        <span
            data-testid="card-deal-chip"
            className={`text-[9px] font-black uppercase tracking-wider px-2 py-0.5 rounded-md border border-transparent ${dealChip === 'in-trust' ? 'bg-bp-chip-ok-tint text-bp-chip-ok-ink' : 'bg-bp-chip-warn-tint text-bp-chip-warn-ink'}`}
        >
            {listingChipWords(dealChip)}
        </span>
    ) : null;
    const isPinned = pinLive(post as any);
    const pinnedChip = isPinned ? (
        <span
            data-testid="card-pinned-chip"
            className="text-[9px] font-black tracking-wider px-2 py-0.5 rounded-md bg-bp-chip-accent-tint text-bp-chip-accent-ink border border-transparent shadow-xs"
        >
            {t('📌 PINNED')}
        </span>
    ) : null;

    const elderCard = !beansMarked && isElder(authorEnergy);
    const isGroupScope = post.audienceScope === 'group' || !!post.targetGroupId;
    // The group's name is its members' own, shown as written inside the sentence.
    const targetGroupName = post.targetGroupName || t('Group');
    const groupScopeBadge = isGroupScope ? t('🔒 Only {group} can see this', { group: targetGroupName }) : null;
    const authorName = post.authorCallsign || t('Anonymous');
    const copyLine = copy && <p data-testid="listing-copy-line" className="m-0 mt-0.5 text-xs font-semibold text-nature-700 dark:text-nature-300 break-words">{copyPriceLine(copy)}</p>;
    const elderStyleList = isPulse
        ? 'border-2 border-amber-400/80 dark:border-amber-500/70 shadow-[0_4px_20px_rgba(245,158,11,0.15)] bg-amber-50/20 dark:bg-amber-950/20'
        : elderCard ? 'border-l-4 border-l-amber-400 shadow-[0_4px_15px_rgba(251,191,36,0.1)]' : '';

    if (viewMode === 'compact') {
        // The compact row, on the Market's style box (components/market-card-shell.ts COMPACT_*, slice C1): the same row an
        // event's and a poll's are, as it was, with the box's one chip at its end (10/800, from the 8 px pill).
        return (
            <div
                data-testid="listing-compact-row"
                className={`${COMPACT_ROW} ${elderStyleList}`}
            >
                <div className={COMPACT_LEAD}>
                    {/* Compact Category Picture / Tile */}
                    <div className={COMPACT_PICTURE}>
                        {displayImage ? (
                            cardPicture(<CategoryTile category={post.category} kind={isPulse ? 'pulse' : (post.type === 'event' ? 'event' : 'listing')} size="thumb" />)
                        ) : (
                            <CategoryTile category={post.category} kind={isPulse ? 'pulse' : (post.type === 'event' ? 'event' : 'listing')} size="thumb" />
                        )}
                    </div>

                    {/* Title and Author */}
                    <div className={COMPACT_TEXT}>
                        <h3 dir="auto" className={COMPACT_TITLE}>
                            {post.title}
                        </h3>
                        <span className="text-[10px] text-nature-500 flex items-center gap-1 flex-wrap min-w-0 break-words">
                            {/* One sentence per variant, as the phone's byLine: the name is the member's, the Elder mark
                                and the blue "(You)" are parts of it wherever the language puts them. A copy has no name:
                                its line, as on the full card, and as a span since this row is one. */}
                            {copy ? (
                                <span data-testid="listing-copy-line" className="min-w-0 max-w-full text-xs font-semibold text-nature-700 dark:text-nature-300 break-words">{copyPriceLine(copy)}</span>
                            ) : isOwnPost ? (
                                <Sentence
                                    text={elderCard ? t('by {name} ⛰️ {you}', { name: authorName }) : t('by {name} {you}', { name: authorName })}
                                    parts={{ you: <span className="text-blue-600 dark:text-blue-400 font-bold">{t('👤 (You)')}</span> }}
                                />
                            ) : elderCard ? t('by {name} ⛰️', { name: authorName }) : t('by {name}', { name: authorName })}
                            {pinnedChip}
                            {dealPill}
                            {distanceTag}
                            {foundingChip && (
                                <span data-testid="author-founding" className="text-[8px] font-black tracking-wider px-1.5 py-0.5 rounded bg-bp-chip-ok-tint text-bp-chip-ok-ink border border-transparent min-w-0 max-w-full whitespace-normal break-words">
                                    {t('🔑 FOUNDING')}
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
                <div className={COMPACT_END}>
                    {/* Compact Price */}
                    {showPrice && (
                        <span className="font-black text-sm text-nature-950 dark:text-white flex items-center">
                            {freePrice ?? (<>
                                {priceAmount(post.price_c)}
                                <img src="/assets/bean.png" className="mx-0.5" style={{ width: '12px', height: '12px', flexShrink: 0 }} alt={t('B', undefined, 'the Beans sign')} />
                                <span className="text-[9px] text-nature-500 font-normal">
                                    {priceUnit(post.priceType)}
                                </span>
                            </>)}
                        </span>
                    )}

                    {/* Daily Pulse or Needs/Offers: the box's one chip (10/800), its capitals from the words */}
                    {isPulse ? (
                        <span data-testid="compact-type-chip" className={chip('warn')}>
                            {upperCase(t('PULSE'))}
                        </span>
                    ) : (
                        <span data-testid="compact-type-chip" className={chip(post.type === 'offer' ? 'offer' : 'need')}>
                            {upperCase(typeWords(post.type))}
                        </span>
                    )}
                </div>
            </div>
        );
    }

    if (!isGrid) {
        // The list card, on the Market's style box (components/market-card-shell.ts, DESIGN-card-style-box-fable.md §1, W2):
        // the photo flush under the card's left corners and the card's full height, the text beside it with 12 of padding,
        // the chips the one chip in the box's order (type · PINNED · YOU · category · RECURRING · CASH TOO · PAUSED · group ·
        // deal) with the price at the row's end, the title, who, and how far. The card takes the height its lines need.
        const tileKind = isPulse ? 'pulse' : (post.type === 'event' ? 'event' : 'listing');
        return (
            <div
                data-testid="listing-list-card"
                className={`${listCard({ pulse: isPulse, elder: elderCard })} cursor-pointer transition-shadow duration-300 hover:shadow-md`}
            >
                {/* The picture: the first thing in the card, so the card's own corners round it. */}
                <div data-testid="listing-list-photo" className={LIST_PHOTO}>
                    {displayImage ? (
                        cardPicture(<div className={LIST_PHOTO_FILL}><CategoryTile category={post.category} kind={tileKind} size="thumb" /></div>, undefined, `${LIST_PHOTO_FILL} object-cover`)
                    ) : (
                        <div className={LIST_PHOTO_FILL}><CategoryTile category={post.category} kind={tileKind} size="thumb" /></div>
                    )}
                </div>

                <div className={LIST_TEXT}>
                    {/* The chips (the one chip, in the box's order) with the price at the row's far end (§1.2). The price
                        floats, so the chips' first line runs beside it and every line under it has the text's whole width: a
                        chip with no room beside the price moves under it whole ("ANGEBOT" beside "25 /Std." at 320 x 1.3)
                        rather than shrinking, and only a chip wider than the whole width ends in an ellipsis (#2873). The chips
                        and the price keep 4 below them (`mb-1`), which the head's `-mb-1` takes back: rows 4 apart, as before. */}
                    <div data-testid="listing-list-head" className={`flow-root min-w-0 leading-none -mb-1${popUp ? ` ${POP_UP_CLOSE_ROOM}` : ''}`}>
                        {showPrice && (
                            <span data-testid="listing-list-price" className={`float-right rtl:float-left ms-2 mb-1 flex flex-row items-center flex-nowrap ${LIST_TYPE.price} ${CARD_INK.title}`}>
                                {freePrice ?? (<>
                                    {priceAmount(post.price_c)}
                                    <img src="/assets/bean.png" className="mx-0.5" style={{ width: `${LIST_BEAN_PX}px`, height: `${LIST_BEAN_PX}px`, flexShrink: 0 }} alt={t('B', undefined, 'the Beans sign')} />
                                    <span className={`${LIST_TYPE.priceUnit} ${CARD_INK.secondary}`}>
                                        {priceUnit(post.priceType)}
                                    </span>
                                </>)}
                            </span>
                        )}
                        <span data-testid="listing-list-chips" className="[&>span]:me-1 [&>span]:mb-1 [&>span]:align-top">
                            {isPulse ? (
                                <span className={chip('warn')}>{upperCase(t('🗞️ Daily Pulse'))}</span>
                            ) : (
                                <span className={chip(post.type === 'offer' ? 'offer' : 'need')}>{upperCase(typeWords(post.type))}</span>
                            )}
                            {isPinned && (
                                <span data-testid="card-pinned-chip" className={chip('pinned')}>{t('📌 PINNED')}</span>
                            )}
                            {isOwnPost && <span className={chip('info')}>{upperCase(t('👤 You'))}</span>}
                            {categoryConfig && (
                                <span className={chip('quiet')}>{categoryConfig.emoji} <span>{t(categoryConfig.label)}</span></span>
                            )}
                            {post.repeatable && <span className={chip('quiet')}>{t('↻ RECURRING')}</span>}
                            {/* #108: on the card, not just the detail view — the point of the flag is
                                that nobody discovers a cash requirement in paragraph three. */}
                            {post.cashAlsoNeeded && (
                                <span className={chip('warn')} title={t('Cash also needed for fuel or materials — agreed in chat')}>
                                    {t('💸 CASH TOO')}
                                </span>
                            )}
                            {isPaused && <span className={chip('warn')}>{upperCase(t('⏸ Paused'))}</span>}
                            {groupScopeBadge && <span className={chip('quiet', true)}>{groupScopeBadge}</span>}
                            {dealChip && (
                                <span data-testid="card-deal-chip" className={chip(dealChip === 'in-trust' ? 'ok' : 'warn')}>
                                    {upperCase(listingChipWords(dealChip))}
                                </span>
                            )}
                            {popUp && nodeBadge && <span data-testid="card-node-chip" className={chip('quiet')}>🌐 {nodeBadge}</span>}
                        </span>
                    </div>

                    {/* Two lines at most, as the event's when (DESIGN-card-style-box-fable.md §1.3): one line made "A dozen eg…" at 320 x 1.3. */}
                    <h3 dir="auto" data-testid="listing-list-title" className={`m-0 break-words line-clamp-2 ${LIST_TYPE.loud} ${CARD_INK.title}`}>
                        {post.title}
                    </h3>

                    {copyLine || <PostAuthorTrust
                        callsign={authorName}
                        energyCycled={authorEnergy}
                        rating={authorRating}
                        avatarUrl={authorAvatarUrl}
                        publicKey={post.authorPublicKey}
                        mode="full"
                        showTier={!beansMarked}
                        isFounding={!beansMarked && !!post.authorFoundingNeeded}
                    />}

                    {/* How far, as the node measured it (S5): its own line under who, as on the phone; nothing without a number. */}
                    {typeof distanceKm === 'number' && Number.isFinite(distanceKm) && (
                        <span data-testid="card-distance" className={`flex items-center gap-1 min-w-0 truncate ${LIST_TYPE.distance} ${CARD_INK.secondary}`}>
                            <span aria-hidden="true">📍</span>
                            <span className="truncate">{distanceWords(distanceKm)}</span>
                        </span>
                    )}
                </div>

                {/* Node Overlays - Top Right floating if remote (in the pop-up, a chip: the ✕ has this corner) */}
                {nodeBadge && !popUp && (
                    <div className="absolute top-2 right-2 font-bold bg-indigo-500/90 text-white backdrop-blur-sm rounded-lg shadow-sm text-[0.6rem] px-1.5 py-0.5">
                        🌐 {nodeBadge}
                    </div>
                )}
            </div>
        );
    }

    // The grid tile, on the Market's style box (components/market-card-shell.ts; DESIGN-market-grid-sizes-fable.md §2.2, G2).
    // A lattice: the photo 4:3 flush at the top, then a text block of exactly four rows, and the tile fills its cell, so every
    // tile in a row is the same height whatever it holds. On the photo: the type chip top-left, and at its foot the status
    // chip, 📌 PINNED and the price (the phone's foot row). Under it: the title (rows 1 and 2, two reserved), who (row 3), and
    // row 4, one line: how far, then at most one chip by deal › paused › group lock › RECURRING. The Pulse tile: its title, its
    // pill, one line of its news. Nothing is cut from what a member reads: the page a tap opens says it all.
    const tileKind = isPulse ? 'pulse' : (post.type === 'event' ? 'event' : 'listing');
    const rowChip = (() => {
        if (dealChip) {
            return <span data-testid="card-deal-chip" className={gridChip(dealChip === 'in-trust' ? 'ok' : 'warn')}>{upperCase(listingChipWords(dealChip))}</span>;
        }
        if (isPaused) return <span className={gridChip('warn')}>{upperCase(t('⏸ Paused'))}</span>;
        if (groupScopeBadge) return <span className={gridChip('quiet')}>{groupScopeBadge}</span>;
        // RECURRING by the photo's precedence, PENDING > YOU > RECURRING: an own or pending listing's chip says more.
        if (post.repeatable && !isOwnPost && post.status !== 'pending') return <span className={gridChip('quiet')}>{t('↻ RECURRING')}</span>;
        return null;
    })();
    return (
        <div data-testid="listing-grid-tile" className={`${gridTile({ pulse: isPulse, elder: elderCard })} cursor-pointer transition-shadow duration-300 hover:shadow-md`}>
            {/* 4:3 Media Box at Card Top (edge to edge, radius 14) */}
            <div className={GRID_PHOTO}>
                {displayImage ? (
                    cardPicture(<CategoryTile category={post.category} kind={tileKind} size="grid" />, GRID_CROP)
                ) : (
                    <CategoryTile category={post.category} kind={tileKind} size="grid" />
                )}

                {/* Top-leading: the type chip (unless pulse) */}
                {!isPulse && (
                    <div className="absolute top-2 left-2">
                        <span className={chip(post.type === 'offer' ? 'offer' : 'need')}>
                            {upperCase(typeWords(post.type))}
                        </span>
                    </div>
                )}

                {/* Top-trailing: Remote node badge if any */}
                {nodeBadge && (
                    <div className="absolute top-2 right-2 font-bold bg-indigo-500/90 text-white backdrop-blur-sm rounded-lg shadow-sm text-[0.6rem] px-1.5 py-0.5">
                        🌐 {nodeBadge}
                    </div>
                )}

                {/* The foot row: the status chip and 📌 PINNED at the start, the price at the end; it wraps upward when a
                    long language needs it. */}
                <div data-testid="grid-badge-row" className="absolute left-2 right-2 bottom-2 flex flex-wrap items-end gap-1 pointer-events-none">
                    {/* Status chip: at most ONE by precedence PENDING > YOU */}
                    {statusChip && (
                        <div className={`font-bold rounded-lg shadow-sm text-[0.6rem] px-2 py-1 pointer-events-auto ${statusChip.className}`}>
                            {statusChip.text}
                        </div>
                    )}

                    {isPinned && (
                        <span data-testid="card-pinned-chip" className={GRID_SCRIM_PILL}>{t('📌 PINNED')}</span>
                    )}

                    {/* Price pill bottom-trailing */}
                    {showPrice && (
                        <div className="ml-auto bg-nature-900/90 backdrop-blur-md text-white font-bold tracking-tight shadow-md bottom-2 px-2.5 py-1 rounded-lg text-sm pointer-events-auto">
                            <span style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', flexWrap: 'nowrap' }}>
                                {freePrice ? <span>{freePrice}</span> : (<>
                                    <span>{priceAmount(post.price_c)}</span>
                                    <span className="text-[10px] font-normal opacity-80 pl-0.5 flex items-center" style={{ flexShrink: 0 }}>
                                        <img src="/assets/bean.png" style={{ width: '12px', height: '12px', marginLeft: '2px', marginRight: '2px', flexShrink: 0 }} alt={t('B', undefined, 'the Beans sign')} />
                                        {priceUnit(post.priceType)}
                                    </span>
                                </>)}
                            </span>
                        </div>
                    )}
                </div>
            </div>

            {/* The four rows under the photo: a fixed block, the same at every width. */}
            <div data-testid="grid-text-block" className={GRID_TEXT}>
                {/* Rows 1 and 2: the title */}
                <h3 dir="auto" className={`${GRID_TITLE} ${CARD_INK.title}`}>
                    {post.cashAlsoNeeded && <span className="mr-0.5">💸</span>}
                    {post.title}
                </h3>

                {isPulse ? (
                    <>
                        {/* Row 3: the Pulse's pill; row 4: one line of its news */}
                        <div className={GRID_ROW}>
                            <span className={gridChip('warn')}>{upperCase(t('🗞️ Daily Pulse'))}</span>
                        </div>
                        <div className={GRID_ROW}>
                            {post.description && (
                                <p dir="auto" className={`m-0 min-w-0 truncate text-xs ${CARD_INK.secondary}`}>
                                    {post.description}
                                </p>
                            )}
                        </div>
                    </>
                ) : (
                    <>
                        {/* Row 3: who (or, for a member's copy on the global community, its price at home) */}
                        <div className={GRID_ROW}>
                            {copy ? (
                                <p data-testid="listing-copy-line" className="m-0 min-w-0 truncate text-xs font-semibold text-nature-700 dark:text-nature-300">{copyPriceLine(copy)}</p>
                            ) : (
                                <PostAuthorTrust
                                    callsign={authorName}
                                    energyCycled={authorEnergy}
                                    rating={authorRating}
                                    avatarUrl={authorAvatarUrl}
                                    publicKey={post.authorPublicKey}
                                    mode="compact"
                                    showTier={!beansMarked}
                                    isFounding={!beansMarked && !!post.authorFoundingNeeded}
                                    className="min-w-0 flex-1"
                                />
                            )}
                        </div>

                        {/* Row 4: how far, then at most one chip; blank when there is nothing to say */}
                        <div data-testid="grid-row-4" className={GRID_ROW}>
                            {distanceTag}
                            {rowChip}
                        </div>
                    </>
                )}
            </div>
        </div>
    );
}
