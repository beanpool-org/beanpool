/**
 * A listing as a visitor to the global lobby sees it (design G9a §7): the listing, never the person. No author row,
 * no face, no tier badge, no profile link, and nothing to write with; the one action is Join. The node has already
 * taken the person out of what it sent (`guestPost()`), so these draw only the listing's own fields, and never ask
 * for an author's profile, ratings or anything else about who posted it.
 */

import { MARKETPLACE_CATEGORIES_BY_ID, POST_TYPE_COLORS } from '../lib/marketplace';
import type { MarketplacePost } from '../lib/api';
import { formatEventWhen } from '../lib/events';
import { PLACE_AFTER_JOIN, visitorDistanceText, visitorPriceText } from '../lib/visitor-lobby';
import { PollCard } from './PollCard';

function typeLabel(post: MarketplacePost): string {
    return post.type === 'offer' ? 'Offer' : post.type === 'need' ? 'Need' : post.type === 'event' ? 'Event' : 'Poll';
}

/** The detail sheet's one button: who is behind the listing is what joining shows. */
export function joinToSeeLabel(post: MarketplacePost): string {
    switch (post.type) {
        case 'need': return "Join to see who's asking";
        case 'event': return "Join to see who's hosting";
        case 'poll': return 'Join to vote';
        default: return "Join to see who's offering";
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
            aria-label={`Open listing: ${post.title}`}
            className="self-start w-full min-w-0 text-left bg-white dark:bg-nature-900 border border-nature-200 dark:border-nature-800 rounded-xl p-3 shadow-sm flex flex-row gap-3 cursor-pointer hover:shadow-md transition-shadow focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nature-500"
        >
            <span className="w-20 h-20 rounded-xl overflow-hidden flex-shrink-0 bg-nature-100 dark:bg-nature-800 flex items-center justify-center">
                {photo
                    ? <img src={photo} alt="" className="w-full h-full object-cover" />
                    : <span className="text-3xl" aria-hidden="true">{cat?.emoji ?? '📦'}</span>}
            </span>
            <span className="flex-1 min-w-0 flex flex-col gap-1">
                <span className="font-extrabold text-base leading-snug text-nature-950 dark:text-white break-words">{post.title}</span>
                <span data-testid="visitor-card-terms" className="text-sm font-bold text-nature-700 dark:text-nature-200 break-words">
                    {visitorPriceText(post, beans)}
                </span>
                <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
                    <span className="text-xs font-black uppercase tracking-wide" style={{ color: typeColor }}>{typeLabel(post)}</span>
                    <span data-testid="visitor-card-category" className="text-xs font-bold px-2 py-0.5 rounded-full bg-nature-100 dark:bg-nature-800 text-nature-700 dark:text-nature-200 break-words">
                        {cat ? `${cat.emoji} ${cat.label}` : post.category}
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
    onBack: () => void;
    onJoin: () => void;
}

/**
 * The visitor's detail sheet: the listing's photos (a row that swipes), its words and category, the rough distance,
 * an event's time with its place held back, and one full-width button to join. No chat, no accept, no profile link.
 */
export function VisitorPostDetail({ post, beans, distanceKm, onBack, onJoin }: DetailProps) {
    const cat = MARKETPLACE_CATEGORIES_BY_ID.get(post.category);
    const typeColor = POST_TYPE_COLORS[post.type] || '#888';
    const photos = post.photos ?? [];
    return (
        <div data-testid="visitor-detail" className="p-4 max-w-lg mx-auto" style={{ paddingBottom: 'calc(var(--bottom-nav-offset, 0px) + 4rem)' }}>
            <button
                type="button"
                onClick={onBack}
                className="mb-4 min-h-[48px] flex items-center gap-2 text-nature-500 hover:text-nature-700 dark:text-nature-400 font-bold transition-colors cursor-pointer bg-transparent border-0 p-0"
            >
                <span className="text-xl leading-none" aria-hidden="true">←</span> Back to Market
            </button>

            {post.type === 'poll' ? (
                <PollCard post={post} visitor />
            ) : (
                <div className="bg-white dark:bg-nature-950 rounded-2xl border border-nature-200 dark:border-nature-800 shadow-sm overflow-hidden mb-4">
                    <div className="flex flex-wrap items-center gap-2 px-4 py-3 border-b" style={{ backgroundColor: `${typeColor}15`, borderBottomColor: `${typeColor}30` }}>
                        <span className="text-xs font-black uppercase tracking-wider" style={{ color: typeColor }}>{typeLabel(post)}</span>
                        {post.type !== 'event' && (
                            <span className="text-xs font-bold px-2 py-0.5 rounded-full bg-white/70 dark:bg-nature-900 text-nature-700 dark:text-nature-200">
                                {cat ? `${cat.emoji} ${cat.label}` : post.category}
                            </span>
                        )}
                    </div>
                    <div className="p-4">
                        <h2 className="text-xl font-bold text-nature-950 dark:text-white mb-3 leading-tight break-words">{post.title}</h2>

                        {photos.length > 0 && (
                            <div data-testid="visitor-detail-photos" className="flex gap-2 overflow-x-auto mb-4 pb-2 snap-x snap-mandatory" style={{ overscrollBehaviorX: 'contain' }}>
                                {photos.map((photo, i) => (
                                    <img
                                        key={i}
                                        src={photo}
                                        alt={`Photo ${i + 1} of ${photos.length}: ${post.title}`}
                                        className="h-40 w-auto max-w-[85%] rounded-xl object-cover border border-nature-200 dark:border-nature-800 shrink-0 snap-start"
                                    />
                                ))}
                            </div>
                        )}

                        {post.type === 'event' && (
                            <div data-testid="visitor-detail-when" className="mb-3">
                                <p className="m-0 text-lg font-black text-violet-800 dark:text-violet-200">{formatEventWhen(post)}</p>
                                <p className="m-0 mt-1 text-sm font-semibold text-nature-600 dark:text-nature-300">
                                    <span aria-hidden="true">📍 </span>{PLACE_AFTER_JOIN}
                                </p>
                            </div>
                        )}

                        {post.description && (
                            <p className="text-base text-nature-700 dark:text-nature-200 leading-relaxed mb-4 whitespace-pre-wrap break-words">{post.description}</p>
                        )}

                        {post.type !== 'event' && (
                            <p data-testid="visitor-detail-terms" className="m-0 mb-2 text-sm">
                                <span className="font-bold uppercase tracking-wide text-xs text-nature-500 dark:text-nature-400">{beans ? 'Price' : 'In return'}: </span>
                                <span className="font-bold text-nature-900 dark:text-white">{visitorPriceText(post, beans)}</span>
                            </p>
                        )}

                        {distanceKm != null && (
                            <p data-testid="visitor-detail-distance" className="m-0 text-sm font-semibold text-nature-600 dark:text-nature-300">
                                {`About ${visitorDistanceText(distanceKm).replace(/^about /, '')} away · area only`}
                            </p>
                        )}
                    </div>
                </div>
            )}

            <button
                type="button"
                data-testid="visitor-join"
                onClick={onJoin}
                className="w-full min-h-[48px] py-3 px-4 rounded-xl border-0 bg-blue-600 hover:bg-blue-700 text-white font-bold text-base cursor-pointer break-words"
            >
                {joinToSeeLabel(post)}
            </button>
        </div>
    );
}
