/**
 * A listing as a visitor to the global lobby sees it (design G9a §7): the listing, never the person. No author row,
 * no face, no tier badge, no profile link, and nothing to write with; the one action is Join. The node has already
 * taken the person out of what it sent (`guestPost()`), so these draw only the listing's own fields, and never ask
 * for an author's profile, ratings or anything else about who posted it.
 */

import { useEffect, useRef, type ReactNode } from 'react';
import { MARKETPLACE_CATEGORIES_BY_ID, POST_TYPE_COLORS } from '../lib/marketplace';
import type { MarketplacePost } from '../lib/api';
import { formatEventWhen } from '../lib/events';
import { VISITOR_WORDS, visitorDistanceText, visitorKmText, visitorPriceText } from '../lib/visitor-lobby';
import { PollCard } from './PollCard';
import { CategoryTile } from './CategoryTile';
import { copyCardLine, copyFromLine, eventCopyOf, listPhotoUrl, t } from '@beanpool/core';
import { EventCopyDoor } from './EventCopyDoor';
import { REPORT_WORDS, VISITOR_REPORT_URL } from '../lib/reportReasons';

function typeLabel(post: MarketplacePost): string {
    return post.type === 'offer' ? t('Offer', undefined, 'listing type') : post.type === 'need' ? t('Need', undefined, 'listing type')
        : post.type === 'event' ? t('Event', undefined, 'listing type') : t('Poll', undefined, 'listing type');
}

/** The detail sheet's one button: who is behind the listing is what joining shows. */
export function joinToSeeLabel(post: MarketplacePost): string {
    switch (post.type) {
        case 'need': return t("Join to see who's asking");
        case 'event': {
            // A member's copy names no host, whoever joins: where it is from stands in their place.
            const copy = eventCopyOf(post);
            return copy ? (copy.from ? copyCardLine(copy.from) : '') : t("Join to see who's hosting");
        }
        case 'poll': return t('Join to vote');
        default: return t("Join to see who's offering");
    }
}

interface CardProps {
    post: MarketplacePost;
    /** Whether the node trades in Beans; without them the card says the terms are free, a swap, or ask. */
    beans: boolean;
    /** From the point the visitor shared (the Distance sheet), when they have; otherwise no distance at all. */
    distanceKm: number | null;
    onOpen: () => void;
}

/**
 * A card's name for a screen reader: what the card shows, in words, as short sentences. The visible title comes first
 * (WCAG 2.5.3, so "open Sourdough loaves" by voice finds it), then the type, the terms, the category (its words, not
 * its emoji) and the distance when there is one. A name that was the title alone left out everything else on the card.
 */
export function visitorCardName(post: MarketplacePost, beans: boolean, distanceKm: number | null): string {
    const cat = MARKETPLACE_CATEGORIES_BY_ID.get(post.category);
    const parts = [post.title.trim(), typeLabel(post), visitorPriceText(post, beans), cat ? t(cat.label) : post.category];
    if (distanceKm != null) parts.push(visitorDistanceText(distanceKm));
    return parts.filter(Boolean).map((p) => (/[.!?]$/.test(p) ? p : `${p}.`)).join(' ');
}

/** One listing in the lobby's list: photo, title, terms, category and, from a shared point, a whole-km distance. */
export function VisitorCard({ post, beans, distanceKm, onOpen }: CardProps) {
    const cat = MARKETPLACE_CATEGORIES_BY_ID.get(post.category);
    const photo = post.photos && post.photos.length > 0 ? post.photos[0] : null;
    const typeColor = POST_TYPE_COLORS[post.type] || '#888';
    return (
        <button
            type="button"
            data-testid="visitor-card"
            onClick={onOpen}
            aria-label={visitorCardName(post, beans, distanceKm)}
            className="self-start w-full min-w-0 text-left bg-white dark:bg-nature-900 border border-nature-200 dark:border-nature-800 rounded-xl p-3 shadow-sm flex flex-row gap-3 cursor-pointer hover:shadow-md transition-shadow focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nature-500"
        >
            <span className="w-20 h-20 rounded-xl overflow-hidden flex-shrink-0 flex items-center justify-center">
                {photo
                    ? <img src={listPhotoUrl(photo)} alt="" className="w-full h-full object-cover" />
                    : <CategoryTile category={post.category} kind={post.type === 'event' ? 'event' : 'listing'} size="thumb" />}
            </span>
            <span className="flex-1 min-w-0 flex flex-col gap-1">
                <span className="font-extrabold text-base leading-snug text-nature-950 dark:text-white break-words">{post.title}</span>
                <span data-testid="visitor-card-terms" className="text-sm font-bold text-nature-700 dark:text-nature-200 break-words">
                    {visitorPriceText(post, beans)}
                </span>
                <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
                    <span className="text-xs font-black uppercase tracking-wide" style={{ color: `var(--post-type-${post.type}, ${typeColor})` }}>{typeLabel(post)}</span>
                    <span data-testid="visitor-card-category" className="text-xs font-bold px-2 py-0.5 rounded-full bg-nature-100 dark:bg-nature-800 text-nature-700 dark:text-nature-200 break-words">
                        {cat ? <><span>{cat.emoji}</span> <span>{t(cat.label)}</span></> : post.category}
                    </span>
                    {distanceKm != null && (
                        <span data-testid="visitor-card-distance" className="text-xs font-semibold text-nature-600 dark:text-nature-300 whitespace-nowrap">
                            {visitorDistanceText(distanceKm)}
                        </span>
                    )}
                </span>
            </span>
        </button>
    );
}

interface DetailProps {
    post: MarketplacePost;
    beans: boolean;
    distanceKm: number | null;
    /** Back to the lobby's Market. Absent (a post shared outside, pages/PeekPage.tsx): no Back, there is no Market to go to. */
    onBack?: () => void;
    onJoin: () => void;
    /** A poll's card says it decides nothing (lib/informal-polls.ts). */
    pollsInformal?: boolean;
    /**
     * In place of the Join button and the report line: a post shared outside its community (pages/PeekPage.tsx), whose
     * way in is that community's own doors, not the lobby's join.
     */
    footer?: ReactNode;
    /** Above the listing, inside the sheet's top (which it scrolls to when it opens): who shared it, for a shared post. */
    header?: ReactNode;
}

/**
 * The visitor's detail sheet: the listing's photos (a row that swipes), its words and category, the rough distance,
 * an event's time with its place held back, and one full-width button to join. No chat, no accept, no profile link.
 */
export function VisitorPostDetail({ post, beans, distanceKm, onBack, onJoin, pollsInformal = false, footer, header }: DetailProps) {
    const cat = MARKETPLACE_CATEGORIES_BY_ID.get(post.category);
    const typeColor = POST_TYPE_COLORS[post.type] || '#888';
    const photos = post.photos ?? [];
    // Opened from a card far down the list, the sheet starts at its own top, not at the list's scroll.
    const top = useRef<HTMLDivElement>(null);
    useEffect(() => { top.current?.scrollIntoView?.({ block: 'start' }); }, [post.id]);
    const copy = eventCopyOf(post);
    return (
        <div ref={top} data-testid="visitor-detail" className="p-4 max-w-lg mx-auto" style={{ paddingBottom: 'calc(var(--bottom-nav-offset, 0px) + 4rem)' }}>
            {onBack && (
                <button
                    type="button"
                    onClick={onBack}
                    className="mb-4 min-h-[48px] flex items-center gap-2 text-nature-500 hover:text-nature-700 dark:text-nature-400 dark:hover:text-nature-200 font-bold transition-colors cursor-pointer bg-transparent border-0 p-0"
                >
                    <span className="text-xl leading-none" aria-hidden="true">←</span> {t('Back to Market')}
                </button>
            )}
            {header}

            {post.type === 'poll' ? (
                <PollCard post={post} visitor informal={pollsInformal} />
            ) : (
                <div className="bg-white dark:bg-nature-950 rounded-2xl border border-nature-200 dark:border-nature-800 shadow-sm overflow-hidden mb-4">
                    <div className="flex flex-wrap items-center gap-2 px-4 py-3 border-b" style={{ backgroundColor: `${typeColor}15`, borderBottomColor: `${typeColor}30` }}>
                        <span className="text-xs font-black uppercase tracking-wider" style={{ color: typeColor }}>{typeLabel(post)}</span>
                        {post.type !== 'event' && (
                            <span className="text-xs font-bold px-2 py-0.5 rounded-full bg-white/70 dark:bg-nature-900 text-nature-700 dark:text-nature-200">
                                {cat ? <><span>{cat.emoji}</span> <span>{t(cat.label)}</span></> : post.category}
                            </span>
                        )}
                    </div>
                    <div className="p-4">
                        {photos.length === 0 && (
                            <div className="w-full aspect-[3/1] rounded-xl overflow-hidden mb-3">
                                <CategoryTile category={post.category} kind={post.type === 'event' ? 'event' : 'listing'} size="banner" />
                            </div>
                        )}
                        <h2 className="text-xl font-bold text-nature-950 dark:text-white mb-3 leading-tight break-words">{post.title}</h2>

                        {photos.length > 0 && (
                            <div data-testid="visitor-detail-photos" className="flex gap-2 overflow-x-auto mb-4 pb-2 snap-x snap-mandatory" style={{ overscrollBehaviorX: 'contain' }}>
                                {photos.map((photo, i) => (
                                    <img
                                        key={i}
                                        src={photo}
                                        alt={t('Photo {current} of {total}: {title}', { current: i + 1, total: photos.length, title: post.title })}
                                        className="h-40 w-auto max-w-[85%] rounded-xl object-cover border border-nature-200 dark:border-nature-800 shrink-0 snap-start"
                                    />
                                ))}
                            </div>
                        )}

                        {post.type === 'event' && (
                            <div data-testid="visitor-detail-when" className="mb-3">
                                <p className="m-0 text-lg font-black text-violet-800 dark:text-violet-200">{formatEventWhen(post)}</p>
                                {/* An online event has no place to hold back (the node sends visitors eventOnline): it says so, as its card does. */}
                                <p data-testid="visitor-detail-place" className="m-0 mt-1 text-sm font-semibold text-nature-600 dark:text-nature-300">
                                    {post.eventOnline
                                        ? <><span aria-hidden="true">🌐 </span>{t('Online')}</>
                                        : copy
                                            ? (copy.from ? copyFromLine(copy.from) : null)
                                            : <><span aria-hidden="true">📍 </span>{t(VISITOR_WORDS.placeAfterJoin)}</>}
                                </p>
                            </div>
                        )}

                        {post.description && (
                            <p className="text-base text-nature-700 dark:text-nature-200 leading-relaxed mb-4 whitespace-pre-wrap break-words">{post.description}</p>
                        )}

                        {post.type !== 'event' && (
                            <p data-testid="visitor-detail-terms" className="m-0 mb-2 text-sm">
                                <span className="font-bold uppercase tracking-wide text-xs text-nature-500 dark:text-nature-400">{beans ? t('Price:') : t('In return:')}</span>{' '}
                                <span className="font-bold text-nature-900 dark:text-white">{visitorPriceText(post, beans)}</span>
                            </p>
                        )}

                        {distanceKm != null && (
                            <p data-testid="visitor-detail-distance" className="m-0 text-sm font-semibold text-nature-600 dark:text-nature-300">
                                {t('About {distance} away · area only', { distance: visitorKmText(distanceKm) })}
                            </p>
                        )}
                    </div>
                </div>
            )}

            {footer ?? (
                <>
                    {copy ? <EventCopyDoor copy={copy} /> : (
                        <button
                            type="button"
                            data-testid="visitor-join"
                            onClick={onJoin}
                            className="w-full min-h-[48px] py-3 px-4 rounded-xl border-0 bg-blue-600 hover:bg-blue-700 text-white font-bold text-base cursor-pointer break-words"
                        >
                            {joinToSeeLabel(post)}
                        </button>
                    )}
                    {/* A visitor can't report from here (a report is a member's, signed): where they can (rehearsal 14 Oct N3). */}
                    <p data-testid="visitor-report" className="m-0 mt-3 text-sm text-nature-700 dark:text-nature-300 break-words">
                        <span>{t(REPORT_WORDS.visitorLine)}</span>{' '}
                        <a href={VISITOR_REPORT_URL} target="_blank" rel="noopener noreferrer" className="font-semibold underline text-bp-ink-accent">
                            {t(REPORT_WORDS.visitorLink)}
                        </a>
                    </p>
                </>
            )}
        </div>
    );
}
