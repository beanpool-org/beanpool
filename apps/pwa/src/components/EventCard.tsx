/**
 * EventCard / EventDetail — an event in the Market feed, the map preview and the post view
 * (docs/events-on-the-map.md §3).
 *
 * The card leads with the date and time in the largest text, then the title, the place and distance, the two
 * counts, and Going / Interested with the viewer's own status on the filled button. The host name is on the
 * detail, not the card. Built for 320px at 130% text: every row truncates, the buttons never shrink, and every
 * target is at least 48px tall.
 *
 * Who is the host is the node's call, not the client's: the RSVP list (`eventRsvps`) is sent to the author, a
 * keeper of an enterprise author, or a convenor of the group, and to nobody else — so its presence is what
 * shows the host controls here.
 */

import { useEffect, useState } from 'react';
import { getMarketplacePosts, rsvpEvent, removeMarketplacePost, type EventRsvpStatus, type MarketplacePost } from '../lib/api';
import type { BeanPoolIdentity } from '../lib/identity';
import {
    CLIENT_POST_TYPES, EVENT_CHAT_ENTRY_LABEL, eventEditBlockedReason, eventWhenParts, formatDistance, formatEventWhen,
    isEventHostView, isEventOpen,
} from '../lib/events';

interface RsvpState {
    livePost: MarketplacePost;
    setLivePost: (post: MarketplacePost) => void;
    busy: EventRsvpStatus | 'none' | null;
    error: string | null;
    canRsvp: boolean;
    tap: (status: EventRsvpStatus) => void;
}

function useEventRsvp(post: MarketplacePost, identity: BeanPoolIdentity | null | undefined, onChange?: (post: MarketplacePost) => void): RsvpState {
    const [livePost, setLivePost] = useState(post);
    const [busy, setBusy] = useState<EventRsvpStatus | 'none' | null>(null);
    const [error, setError] = useState<string | null>(null);
    useEffect(() => { setLivePost(post); }, [post]);

    const canRsvp = !!identity && isEventOpen(livePost);

    const tap = async (status: EventRsvpStatus) => {
        if (!identity) {
            setError('Join this community to RSVP.');
            return;
        }
        if (!isEventOpen(livePost)) return;
        // Tapping the status you already have takes it back: "not going" is no RSVP at all.
        const next = livePost.myRsvp === status ? null : status;
        setBusy(next ?? 'none');
        setError(null);
        try {
            const res = await rsvpEvent(livePost.id, next);
            if (res?.post) {
                setLivePost(res.post);
                onChange?.(res.post);
            }
        } catch (e: any) {
            setError(e?.message || 'Could not save your RSVP.');
        } finally {
            setBusy(null);
        }
    };

    return { livePost, setLivePost, busy, error, canRsvp, tap };
}

function StateBadge({ post }: { post: MarketplacePost }) {
    const ended = !isEventOpen(post) && post.eventState !== 'cancelled' && post.status !== 'cancelled';
    const label = post.eventState === 'cancelled' || post.status === 'cancelled'
        ? 'CANCELLED'
        : ended ? 'ENDED' : post.eventState === 'updated' ? 'UPDATED' : null;
    if (!label) return null;
    const tone = label === 'UPDATED'
        ? 'bg-amber-100 text-amber-800 border-amber-300 dark:bg-amber-950/50 dark:text-amber-200 dark:border-amber-800'
        : 'bg-red-100 text-red-700 border-red-300 dark:bg-red-950/50 dark:text-red-300 dark:border-red-800';
    return (
        <span data-testid="event-state-badge" className={`flex-shrink-0 text-[11px] font-black tracking-wide px-2 py-0.5 rounded-md border ${tone}`}>
            {label}
        </span>
    );
}

/**
 * Going / Interested — for everyone except a host. A host is running the event, so the buttons would only
 * add the host to their own guest list; the host sees a plain line in their place.
 */
function RsvpButtons({ rsvp }: { rsvp: RsvpState }) {
    const { livePost, busy, canRsvp, tap } = rsvp;
    if (isEventHostView(livePost)) {
        return (
            <p data-testid="event-hosting" className="m-0 text-sm font-bold text-violet-800 dark:text-violet-200">
                You're hosting this event
            </p>
        );
    }
    const btn = (status: EventRsvpStatus, label: string) => {
        const mine = livePost.myRsvp === status;
        return (
            <button
                type="button"
                aria-pressed={mine}
                disabled={!canRsvp || busy !== null}
                onClick={(e) => { e.stopPropagation(); tap(status); }}
                className={`flex-1 min-w-0 min-h-[48px] px-1.5 py-1 rounded-xl border text-sm font-extrabold leading-tight break-words transition-colors disabled:opacity-60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-500 focus-visible:ring-offset-1 ${
                    mine
                        ? 'bg-violet-700 border-violet-700 text-white dark:bg-violet-500 dark:border-violet-500'
                        : 'bg-white border-violet-300 text-violet-800 hover:bg-violet-50 dark:bg-nature-900 dark:border-violet-800 dark:text-violet-200'
                }`}
            >
                {busy === status ? 'Saving…' : mine ? `${label} ✓` : label}
            </button>
        );
    };
    return (
        <div className="flex gap-2">
            {btn('going', 'Going')}
            {btn('interested', 'Interested')}
        </div>
    );
}

/**
 * The date, the time and the CANCELLED / UPDATED badge on the first line, never cut off and never overlapping:
 * each is a whole piece, and at 320px with large text the next piece moves down a line instead of being
 * truncated, because the time is the one thing on the card nobody can do without.
 */
function EventWhen({ post, className, testId }: { post: MarketplacePost; className: string; testId?: string }) {
    const parts = eventWhenParts(post);
    return (
        <span className="flex flex-wrap items-center gap-x-2 gap-y-1 min-w-0 w-full">
            <span data-testid={testId} aria-label={formatEventWhen(post)} className={`contents ${className}`}>
                {parts && (
                    <>
                        <span className={`whitespace-nowrap ${className}`}>{parts.first}{parts.sep === ' · ' ? ' ·' : ' –'}</span>
                        <span className={`whitespace-nowrap ${className}`}>{parts.second}</span>
                    </>
                )}
            </span>
            <StateBadge post={post} />
        </span>
    );
}

function countsLine(post: MarketplacePost): string {
    return `${post.goingCount ?? 0} going · ${post.interestedCount ?? 0} interested`;
}

interface EventCardProps {
    post: MarketplacePost;
    identity?: BeanPoolIdentity | null;
    /** Kilometres from the viewer, when the page knows where they are. */
    distanceKm?: number | null;
    onOpen?: () => void;
    onRsvpChange?: (post: MarketplacePost) => void;
}

export function EventCard({ post, identity, distanceKm, onOpen, onRsvpChange }: EventCardProps) {
    const rsvp = useEventRsvp(post, identity, onRsvpChange);
    const p = rsvp.livePost;
    const place = [p.eventPlaceName, distanceKm != null ? formatDistance(distanceKm) : ''].filter(Boolean).join(' · ');

    return (
        <div data-testid="event-card" className="w-full min-w-0 bg-white dark:bg-nature-950 border-2 border-violet-200 dark:border-violet-900/60 rounded-2xl p-3 shadow-sm flex flex-col gap-2 overflow-hidden">
            <button
                type="button"
                onClick={onOpen}
                disabled={!onOpen}
                aria-label={`Open event: ${p.title}`}
                className="w-full min-w-0 text-left bg-transparent border-0 p-0 flex flex-col gap-1 cursor-pointer disabled:cursor-default focus:outline-none focus-visible:ring-2 focus-visible:ring-violet-400 rounded-lg"
            >
                <EventWhen post={p} testId="event-when" className="text-lg font-black text-violet-800 dark:text-violet-200 leading-tight" />
                <span className="block w-full truncate text-base font-extrabold text-nature-950 dark:text-white leading-snug">
                    {p.title}
                </span>
                {place && (
                    <span className="block w-full truncate text-sm font-semibold text-nature-600 dark:text-nature-300">
                        <span aria-hidden="true">📍 </span>{place}
                    </span>
                )}
                <span className="block w-full truncate text-sm font-semibold text-nature-600 dark:text-nature-300">
                    <span aria-hidden="true">👥 </span>{countsLine(p)}
                </span>
            </button>
            <RsvpButtons rsvp={rsvp} />
            {rsvp.error && (
                <p role="alert" className="m-0 text-xs text-red-600 dark:text-red-400">{rsvp.error}</p>
            )}
        </div>
    );
}

interface EventDetailProps {
    post: MarketplacePost;
    identity?: BeanPoolIdentity | null;
    distanceKm?: number | null;
    onShowOnMap?: (post: MarketplacePost) => void;
    onOpenProfile?: (pubkey: string) => void;
    onChange?: (post: MarketplacePost) => void;
    /** After a cancel, with the event as it reads now (CANCELLED), or null when it could not be re-read. */
    onCancelled?: (post: MarketplacePost | null) => void;
    /**
     * Host only: open the create form in edit mode, filled from this event (events round 2, decision 29).
     * The node refuses edits to an ended or cancelled event, so the page says why instead of offering it.
     */
    onEdit?: (post: MarketplacePost) => void;
    /** Opens the event's chat — the host and everyone Going (docs/events-on-the-map.md §3). */
    onOpenChat?: (post: MarketplacePost) => void;
    /**
     * Host only: open the create form filled from this event with the dates blank (§3, slice 5). This is the
     * whole of repeats in v1 — there are no repeat rules (§5).
     */
    onCopyToNewDate?: (post: MarketplacePost) => void;
}

export function EventDetail({ post, identity, distanceKm, onShowOnMap, onOpenProfile, onChange, onCancelled, onEdit, onOpenChat, onCopyToNewDate }: EventDetailProps) {
    const rsvp = useEventRsvp(post, identity, onChange);
    const p = rsvp.livePost;
    const [cancelling, setCancelling] = useState(false);
    const [cancelError, setCancelError] = useState<string | null>(null);
    const isHost = isEventHostView(p);
    const open = isEventOpen(p);
    const editBlocked = eventEditBlockedReason(p);
    const going = (p.eventRsvps ?? []).filter(r => r.status === 'going');
    const interested = (p.eventRsvps ?? []).filter(r => r.status === 'interested');
    const hostName = p.authorCallsign || p.authorPublicKey.slice(0, 8);

    const handleCancel = async () => {
        if (!window.confirm('Cancel this event? Everyone will see it as cancelled.')) return;
        setCancelling(true);
        setCancelError(null);
        try {
            await removeMarketplacePost(p.id, p.authorPublicKey);
            // Stay on the page: the host re-reads the event (the node still serves a cancelled one to its host
            // by id) and sees it marked CANCELLED, rather than being dropped back on a feed it has left.
            let after: MarketplacePost | null = null;
            try {
                after = (await getMarketplacePosts({ id: p.id, types: CLIENT_POST_TYPES }))[0] ?? null;
            } catch { /* offline: fall back to marking it locally */ }
            const next = after ?? { ...p, status: 'cancelled', eventState: 'cancelled' as const };
            rsvp.setLivePost(next);
            onCancelled?.(after);
        } catch (e: any) {
            setCancelError(e?.message || 'Could not cancel the event.');
        } finally {
            setCancelling(false);
        }
    };

    return (
        <div data-testid="event-detail" className="w-full min-w-0 bg-white dark:bg-nature-950 border-2 border-violet-200 dark:border-violet-900/60 rounded-2xl overflow-hidden">
            {p.photos && p.photos.length > 0 && (
                <img src={p.photos[0]} alt={p.title} className="w-full max-h-56 object-cover bg-nature-100 dark:bg-nature-900" />
            )}
            <div className="p-4 flex flex-col gap-3">
                <h2 className="m-0 min-w-0">
                    <EventWhen post={p} className="text-xl font-black text-violet-800 dark:text-violet-200 leading-tight" />
                </h2>
                <h3 className="m-0 text-lg font-extrabold text-nature-950 dark:text-white leading-snug break-words">{p.title}</h3>

                {(p.eventPlaceName || p.lat != null) && (
                    <div className="flex flex-col items-start gap-1 min-w-0">
                        <span className="w-full min-w-0 break-words text-sm font-semibold text-nature-700 dark:text-nature-300">
                            <span aria-hidden="true">📍 </span>{[p.eventPlaceName, distanceKm != null ? formatDistance(distanceKm) : ''].filter(Boolean).join(' · ') || 'On the map'}
                        </span>
                        {onShowOnMap && p.lat != null && p.lng != null && (
                            <button
                                type="button"
                                onClick={() => onShowOnMap(p)}
                                className="flex-shrink-0 min-h-[48px] px-3 rounded-xl border border-violet-300 dark:border-violet-800 text-sm font-bold text-violet-800 dark:text-violet-200 bg-transparent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-500 focus-visible:ring-offset-1"
                            >
                                Show on map
                            </button>
                        )}
                    </div>
                )}

                {p.description && (
                    <p className="m-0 text-sm text-nature-700 dark:text-nature-300 whitespace-pre-wrap break-words">{p.description}</p>
                )}

                <p className="m-0 text-sm text-nature-600 dark:text-nature-400 min-w-0">
                    Hosted by{' '}
                    <button
                        type="button"
                        onClick={() => onOpenProfile?.(p.authorPublicKey)}
                        className="inline-flex items-center min-h-[48px] max-w-full bg-transparent border-0 p-0 font-bold text-left text-nature-900 dark:text-white underline decoration-dotted cursor-pointer break-words focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-500 focus-visible:ring-offset-1 rounded-sm"
                    >
                        {hostName}
                    </button>
                    {p.audienceScope === 'group' && p.targetGroupName ? <> · for {p.targetGroupName} only</> : null}
                </p>

                <p className="m-0 text-sm font-semibold text-nature-700 dark:text-nature-300">
                    <span aria-hidden="true">👥 </span>{countsLine(p)}
                </p>
                <RsvpButtons rsvp={rsvp} />
                {rsvp.error && <p role="alert" className="m-0 text-xs text-red-600 dark:text-red-400">{rsvp.error}</p>}

                {onOpenChat && (isHost || p.myRsvp === 'going') && (
                    <button
                        type="button"
                        data-testid="event-open-chat"
                        onClick={() => onOpenChat(p)}
                        className="min-h-[48px] w-full px-3 rounded-xl border border-violet-300 dark:border-violet-800 text-sm font-bold text-violet-800 dark:text-violet-200 bg-violet-50 dark:bg-violet-950/40 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-500 focus-visible:ring-offset-1"
                    >
                        💬 {EVENT_CHAT_ENTRY_LABEL}
                    </button>
                )}

                {p.eventPrivateNote ? (
                    <div data-testid="event-private-note" className="p-3 rounded-xl bg-violet-50 dark:bg-violet-950/40 border border-violet-200 dark:border-violet-800">
                        <p className="m-0 mb-1 text-xs font-black uppercase tracking-wide text-violet-800 dark:text-violet-300">Note for people who are going</p>
                        <p className="m-0 text-sm text-nature-900 dark:text-nature-100 whitespace-pre-wrap break-words">{p.eventPrivateNote}</p>
                    </div>
                ) : !isHost && open ? (
                    <p className="m-0 text-xs text-nature-500 dark:text-nature-400">
                        If the host left a note (a gate code, parking, what to bring), it shows here once you tap Going.
                    </p>
                ) : null}

                {isHost && (
                    <div data-testid="event-host-panel" className="flex flex-col gap-2 pt-2 border-t border-nature-100 dark:border-nature-800">
                        <p className="m-0 text-xs font-black uppercase tracking-wide text-nature-500 dark:text-nature-400">Who's going</p>
                        {going.length === 0 && interested.length === 0 ? (
                            <p className="m-0 text-sm text-nature-500 dark:text-nature-400">Nobody yet.</p>
                        ) : (
                            <ul className="m-0 p-0 list-none flex flex-col gap-1">
                                {[...going, ...interested].map(r => (
                                    <li key={r.memberPubkey} className="flex items-center justify-between gap-2 min-w-0 text-sm">
                                        <span className="flex-1 min-w-0 truncate font-semibold text-nature-900 dark:text-white">
                                            {r.memberCallsign || r.memberPubkey.slice(0, 8)}
                                        </span>
                                        <span className="flex-shrink-0 text-xs font-bold text-nature-500 dark:text-nature-400">
                                            {r.status === 'going' ? 'Going' : 'Interested'}
                                        </span>
                                    </li>
                                ))}
                            </ul>
                        )}
                        {onEdit && !editBlocked && (
                            <button
                                type="button"
                                data-testid="event-edit"
                                onClick={() => onEdit(p)}
                                className="min-h-[48px] px-3 rounded-xl border border-violet-700 dark:border-violet-400 text-sm font-bold text-white bg-violet-700 dark:bg-violet-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-500 focus-visible:ring-offset-1"
                            >
                                Edit event
                            </button>
                        )}
                        {onEdit && editBlocked && (
                            <p data-testid="event-edit-blocked" className="m-0 text-sm text-nature-600 dark:text-nature-400">{editBlocked}</p>
                        )}
                        {onCopyToNewDate && (
                            <button
                                type="button"
                                data-testid="event-copy-to-new-date"
                                onClick={() => onCopyToNewDate(p)}
                                className="min-h-[48px] px-3 rounded-xl border border-violet-300 dark:border-violet-800 text-sm font-bold text-violet-800 dark:text-violet-200 bg-transparent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-500 focus-visible:ring-offset-1"
                            >
                                Copy to a new date
                            </button>
                        )}
                        {open && (
                            <button
                                type="button"
                                onClick={handleCancel}
                                disabled={cancelling}
                                className="min-h-[48px] px-3 rounded-xl border border-red-300 dark:border-red-900 text-sm font-bold text-red-700 dark:text-red-300 bg-transparent disabled:opacity-60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-500 focus-visible:ring-offset-1"
                            >
                                {cancelling ? 'Cancelling…' : 'Cancel event'}
                            </button>
                        )}
                        {cancelError && <p role="alert" className="m-0 text-xs text-red-600 dark:text-red-400">{cancelError}</p>}
                    </div>
                )}
            </div>
        </div>
    );
}
