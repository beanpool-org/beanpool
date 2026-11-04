/**
 * EventCard / EventDetail — an event in the Market feed, the map preview and the post view
 * (docs/events-on-the-map.md §3).
 *
 * The card leads with a row of chips (EVENT, PINNED, CANCELLED / UPDATED), then the date and time in the largest
 * text, then the title, the place and distance, and one status line: the viewer's own answer ("Going ✓"), else the
 * counts once anyone has answered. Going / Interested live on the event's page (Marty, 4 Nov 2026: cards open,
 * pages act); the one card that still carries the two buttons is the map's preview, which asks for them with
 * `rsvpOnCard`. The host name is on the detail, not the card. Built for 320px at 130% text: every row truncates or
 * wraps by whole pieces, and the card is one tap target.
 *
 * An event with a photo shows it above (grid) or beside (list) those lines, the same size and crop the offer
 * cards around it use — the host put it there, and a feed of pictures with one blank tile among them reads as
 * the event being the lesser thing.
 *
 * Who is the host is the node's call, not the client's: the RSVP list (`eventRsvps`) is sent to the author, a
 * keeper of an enterprise author, or a convenor of the group, and to nobody else — so its presence is what
 * shows the host controls here.
 */

import { useEffect, useState } from 'react';
import { copyCardLine, copyFromLine, eventCopyOf, pinLive, t, upperCase, word, placeShownRoughly, PLACE_WORDS, type WordKey } from '@beanpool/core';
import { getMarketplacePosts, rsvpEvent, removeMarketplacePost, letInToEvent, type EventRsvpStatus, type MarketplacePost } from '../lib/api';
import type { BeanPoolIdentity } from '../lib/identity';
import {
    CLIENT_POST_TYPES, eventEditBlockedReason, eventRepeatCaption, eventWhenParts, formatDistance, formatEventWhen,
    isEventHostView, isEventOpen,
    eventLetInState, eventLetInLine, eventWaitingCount, eventWaitingLine, letEveryoneInQuestion, eventChatWaitingText, letInButtonLabel,
} from '../lib/events';
import { EventReminder, EventShareAndCalendar } from './EventExtras';
import { EventNextDates } from './EventNextDates';
import { EventCopyDoor } from './EventCopyDoor';
import { ShowOnGlobalHostRow } from './ShowOnGlobalRow';
import { visitorDistanceText } from '../lib/visitor-lobby';
import { useCommunityInfo } from '../lib/features';
import { AuthorCard, useMemberRatings } from './AuthorCard';
import { CategoryTile } from './CategoryTile';
import { PostTagChips } from './PostTagChips';
import { ListPhoto } from './ListPhoto';
import { ImageLightbox } from './ImageLightbox';
import { ReportModal } from './ReportModal';
import {
    BOX_LABEL, CARD_INK, EVENT_ANSWER, LIST_PHOTO, LIST_PHOTO_FILL, LIST_TEXT, LIST_TYPE, PAGE_ANSWER_TYPE, PAGE_BOX, PAGE_BUTTON,
    PAGE_INK, PAGE_TYPE, POP_UP_CLOSE_ROOM, chip, listCard,
} from './market-card-shell';

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

    const canRsvp = !!identity && (isEventOpen(livePost) || livePost.myRsvp !== null);

    const tap = async (status: EventRsvpStatus) => {
        if (!identity) {
            setError(t('Join this community to RSVP.'));
            return;
        }
        // Tapping the status you already have takes it back: "not going" is no RSVP at all.
        const next = livePost.myRsvp === status ? null : status;
        if (!isEventOpen(livePost) && next !== null) return;
        setBusy(next ?? 'none');
        setError(null);
        try {
            const res = await rsvpEvent(livePost.id, next);
            if (res?.post) {
                setLivePost(res.post);
                onChange?.(res.post);
            } else if (res?.success) {
                const updated: MarketplacePost = {
                    ...livePost,
                    myRsvp: null,
                    goingCount: livePost.myRsvp === 'going'
                        ? Math.max(0, (livePost.goingCount ?? 1) - 1)
                        : livePost.goingCount,
                    interestedCount: livePost.myRsvp === 'interested'
                        ? Math.max(0, (livePost.interestedCount ?? 1) - 1)
                        : livePost.interestedCount,
                };
                setLivePost(updated);
                onChange?.(updated);
            }
        } catch (e: any) {
            setError(e?.message || t('Could not save your RSVP.'));
        } finally {
            setBusy(null);
        }
    };

    return { livePost, setLivePost, busy, error, canRsvp, tap };
}

type EventStateKind = 'cancelled' | 'ended' | 'updated';

/** Which state badge an event wears, if any: cancelled, ended (over and not cancelled), or updated. */
function eventStateOf(post: MarketplacePost): EventStateKind | null {
    const ended = !isEventOpen(post) && post.eventState !== 'cancelled' && post.status !== 'cancelled';
    return post.eventState === 'cancelled' || post.status === 'cancelled'
        ? 'cancelled'
        : ended ? 'ended' : post.eventState === 'updated' ? 'updated' : null;
}

/**
 * Every chip on an event is the same small pill: 10px, extra bold, one line, never squeezed by its neighbour. The list
 * card draws the style box's chip (market-card-shell.ts, `box`); the grid card and the page keep this one until their
 * own slices move them onto the box.
 */
const CHIP = 'flex-shrink-0 whitespace-nowrap text-[10px] font-extrabold tracking-wide px-2 py-0.5 rounded-md border border-transparent';

function StateBadge({ post, box = false }: { post: MarketplacePost; box?: boolean }) {
    const state = eventStateOf(post);
    if (!state) return null;
    // Core's colour tokens, light and dark: UPDATED is the event violet; CANCELLED and ENDED are the danger chip.
    const tone = state === 'updated'
        ? 'bg-bp-tile-event-tint text-bp-tile-event-ink'
        : 'bg-bp-chip-danger-tint text-bp-chip-danger-ink';
    return (
        <span data-testid="event-state-badge" className={box ? chip(state === 'updated' ? 'event' : 'danger') : `${CHIP} ${tone}`}>
            {state === 'cancelled' ? t('CANCELLED', undefined, 'event') : state === 'ended' ? t('ENDED', undefined, 'event') : t('UPDATED', undefined, 'event')}
        </span>
    );
}

/**
 * The chips above an event's date, in this order: EVENT (the card only: the page is plainly an event), 📌 PINNED,
 * then CANCELLED / ENDED / UPDATED. They sit in a row of their own so a pin or a badge can never squeeze the date,
 * which keeps its whole line (Marty's Byron screenshot, 4 Nov 2026: the date wrapped to two lines on a pinned card).
 * No chip, no row.
 */
function EventChips({ post, withType = false, box = false, endRoom = false }: {
    post: MarketplacePost; withType?: boolean; box?: boolean;
    /** The map's pop-up: room at the row's end for the pop-up's ✕. */
    endRoom?: boolean;
}) {
    const pinned = pinLive(post as any);
    if (!withType && !pinned && !eventStateOf(post)) return null;
    return (
        <span data-testid="event-chips" className={`flex flex-wrap items-center gap-1 min-w-0 w-full${endRoom ? ` ${POP_UP_CLOSE_ROOM}` : ''}`}>
            {withType && (
                <span data-testid="event-type-chip" className={box ? chip('event') : `${CHIP} bg-bp-tile-event-tint text-bp-tile-event-ink`}>
                    {upperCase(t('EVENT', undefined, 'event category tile label'))}
                </span>
            )}
            {pinned && (
                <span data-testid="event-pinned-chip" className={box ? chip('pinned') : `${CHIP} bg-bp-chip-accent-tint text-bp-chip-accent-ink shadow-xs`}>
                    {t('📌 PINNED')}
                </span>
            )}
            <StateBadge post={post} box={box} />
        </span>
    );
}

/**
 * Going / Interested — for everyone except a host. A host is running the event, so the buttons would only
 * add the host to their own guest list; the host sees a plain line in their place.
 *
 * A label is never broken inside a word: "Intereste / d" across two lines (Marty, 2026-09-24, the 5-column
 * desktop Market grid) is what `min-w-0` plus `break-words` buys — the button shrinks below its own label and
 * then the word is cut at whatever character fits. So each button sizes to its text (`basis-auto` + `min-w-fit`
 * + `whitespace-nowrap`, and it only ever *grows* to share the row), and the row is `flex-wrap`: when the card
 * is too narrow for both side by side — a narrow desktop column, or 320px at 130% text — Interested drops to a
 * full-width row of its own. Never a smaller font and never a truncated label: this is the word people tap.
 */
function RsvpButtons({ rsvp, page = false }: { rsvp: RsvpState; page?: boolean }) {
    const { livePost, busy, canRsvp, tap } = rsvp;
    // The page's buttons are the page's 15/700 (market-card-shell.ts PAGE_ANSWER_TYPE); the map's preview card keeps its own.
    const type = page ? PAGE_ANSWER_TYPE : 'text-sm font-extrabold leading-tight';
    if (isEventHostView(livePost)) {
        return (
            <p data-testid="event-hosting" className={`m-0 ${page ? PAGE_ANSWER_TYPE : 'text-sm font-bold'} ${PAGE_INK.event}`}>
                {t("You're hosting this event")}
            </p>
        );
    }
    const open = isEventOpen(livePost);
    const btn = (status: EventRsvpStatus, label: string) => {
        const mine = livePost.myRsvp === status;
        const disabled = !canRsvp || (!open && !mine) || busy !== null;
        return (
            <button
                type="button"
                aria-pressed={mine}
                disabled={disabled}
                onClick={(e) => { e.stopPropagation(); tap(status); }}
                aria-busy={busy === status}
                // Core's event roles, light and dark (market-card-shell.ts EVENT_ANSWER): the chosen one on the event fill with white
                // words, the other in the event ink's outline on the card ground.
                className={`relative grow basis-auto shrink-0 min-w-fit min-h-[48px] px-2 py-1 rounded-xl border-[1.5px] ${type} whitespace-nowrap transition-colors disabled:opacity-60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-bp-ink-event focus-visible:ring-offset-1 ${
                    mine ? EVENT_ANSWER.chosen : EVENT_ANSWER.open
                }`}
            >
                {/*
                  * While the save is in flight the label stays in the layout, hidden under a spinner, instead of
                  * being swapped for one. Each button is now as wide as its own label, so a different busy label
                  * ("Saving…" is shorter than "Interested" and longer than "Going") would resize the button on
                  * tap and could flip the row between stacked and side by side under the finger, then back when
                  * the save lands. A spinner fits inside the narrowest label, so the width never moves.
                  */}
                <span className={busy === status ? 'invisible' : undefined}>{mine ? t('{label} ✓', { label }) : label}</span>
                {busy === status && (
                    <>
                        <span className="absolute inset-0 flex items-center justify-center" aria-hidden="true">
                            <span className="w-4 h-4 border-2 border-current border-t-transparent rounded-full animate-spin" />
                        </span>
                        <span className="sr-only">{t(', saving…')}</span>
                    </>
                )}
            </button>
        );
    };
    return (
        <div data-testid="event-rsvp-row" className="flex flex-wrap gap-2">
            {btn('going', t('Going'))}
            {btn('interested', t('Interested'))}
        </div>
    );
}

/**
 * The date and the time on the first line, never cut off and never overlapping: each is a whole piece, and at
 * 320px with large text the next piece moves down a line instead of being truncated, because the time is the one
 * thing on the card nobody can do without. The pin and the state badge are not here: they are the chip row above
 * (EventChips), so nothing shares the date's line.
 *
 * Under it, only when the viewer's clock differs from the place's, the second time (DESIGN-event-times §4): "Lagos time ·
 * 15:50 your time", its two halves whole in the same way. The detail adds an online event's host line.
 */
function EventWhen({ post, className, testId, hostLine = false, repeatLine = true, repeatClassName = CARD_INK.event }: {
    post: MarketplacePost; className: string; testId?: string; hostLine?: boolean;
    /**
     * The ↻ repeat line under the when: on (the card and the list); the event page turns it off and draws the rule itself, as
     * the door to its next dates (EventNextDates' repeatCaption, DESIGN-web-dates-stop-fable.md §1).
     */
    repeatLine?: boolean;
    /** The repeat line's colour: the event token on the card (`CARD_INK.event`) and on the page (`PAGE_INK.event`), the same violet. */
    repeatClassName?: string;
}) {
    const parts = eventWhenParts(post);
    const noteAt = parts?.note ? parts.note.indexOf(' · ') : -1;
    const repeats = eventRepeatCaption(post);
    return (
        <>
            <span className="flex flex-wrap items-center gap-x-2 gap-y-1 min-w-0 w-full">
                <span data-testid={testId} aria-label={formatEventWhen(post)} className={`contents ${className}`}>
                    {parts && (
                        <>
                            <span className={`whitespace-nowrap ${className}`}>{parts.first}{parts.sep === ' · ' ? ' ·' : ' –'}</span>
                            {/* Online, "your time" is a whole piece of its own: "4:50–6:50 your time" in the page's large text is wider
                                than a 320px card. */}
                            {parts.second.endsWith(YOUR_TIME) ? (
                                <>
                                    <span className={`whitespace-nowrap ${className}`}>{parts.second.slice(0, -YOUR_TIME.length)}</span>
                                    <span className={`whitespace-nowrap ${className}`}>{YOUR_TIME.trim()}</span>
                                </>
                            ) : (
                                <span className={`whitespace-nowrap ${className}`}>{parts.second}</span>
                            )}
                        </>
                    )}
                </span>
            </span>
            {parts?.note && (
                // aria-hidden: the line above already reads the whole of it out (formatEventWhen).
                <span data-testid="event-when-note" aria-hidden="true" className="flex flex-wrap gap-x-1 min-w-0 w-full text-sm font-bold text-nature-700 dark:text-nature-300 leading-snug">
                    {noteAt > 0 ? (
                        <>
                            <span className="whitespace-nowrap">{parts.note.slice(0, noteAt)} ·</span>
                            <span className="whitespace-nowrap">{parts.note.slice(noteAt + 3)}</span>
                        </>
                    ) : parts.note}
                </span>
            )}
            {/* A repeating event: still only its next date above, and the rule under it (DESIGN-event-times §4, §8). */}
            {repeatLine && repeats && (
                <span data-testid="event-repeat-caption" className={`block w-full min-w-0 break-words text-sm font-bold leading-snug ${repeatClassName}`}>
                    <span aria-hidden="true">↻ </span>{repeats}
                </span>
            )}
            {hostLine && parts?.hostLine && (
                <span data-testid="event-when-host" className={`block w-full min-w-0 break-words text-sm font-semibold ${PAGE_INK.secondary} leading-snug`}>
                    {parts.hostLine}
                </span>
            )}
        </>
    );
}

const YOUR_TIME = ' your time';

/**
 * Why the host cannot edit, as a member reads it: lib/events.ts's eventEditBlockedReason keeps the English (the map's
 * edit alert shares it), and its two sentences are word() keys here by that English, shown through t(); any other line
 * as written (the phone's chat-actions.ts does the same with its constants).
 */
const EDIT_BLOCKED_WORDS: Readonly<Record<string, WordKey>> = {
    'This event was cancelled, so it can no longer be edited.': word('This event was cancelled, so it can no longer be edited.'),
    'This event has ended, so it can no longer be edited.': word('This event has ended, so it can no longer be edited.'),
};

function editBlockedWords(reason: string | null): string | null {
    if (!reason) return null;
    return Object.prototype.hasOwnProperty.call(EDIT_BLOCKED_WORDS, reason) ? t(EDIT_BLOCKED_WORDS[reason]) : reason;
}

/** A join link the page may open: the node takes http(s) only, and this is the second lock. */
function joinHref(link: string | undefined): string | null {
    return link && /^https?:\/\//i.test(link) ? link : null;
}

/**
 * "3 going · 1 interested", or null when the counts are not known or when nobody has answered yet.
 *
 * "Your events" is built from `/api/events/mine`, which carries no counts — and "0 going" on an event the
 * viewer is going to is not a smaller truth, it is a wrong one. A row that does not know keeps quiet. So does a
 * row where both are zero (Marty, 4 Nov 2026): eight cards of "0 going · 0 interested" read as a dead community,
 * and the event's page shows the counts.
 */
function countsLine(post: MarketplacePost): string | null {
    if (post.goingCount == null && post.interestedCount == null) return null;
    const going = post.goingCount ?? 0;
    const interested = post.interestedCount ?? 0;
    if (going + interested === 0) return null;
    return t('{going} going · {interested} interested', { going, interested });
}

/** The viewer's own answer as the card writes it: "Going ✓" / "Interested ✓", the same words as the selected button on the page. */
function myAnswerLine(post: MarketplacePost): string | null {
    if (post.myRsvp === 'going') return t('{label} ✓', { label: t('Going') });
    if (post.myRsvp === 'interested') return t('{label} ✓', { label: t('Interested') });
    return null;
}

interface EventCardProps {
    post: MarketplacePost;
    identity?: BeanPoolIdentity | null;
    /** Kilometres from the viewer, when the page knows where they are. */
    distanceKm?: number | null;
    /**
     * Which shape the feed is in, so the event's photo takes the same size, crop and rounding the offer cards
     * beside it are using (MarketplaceCard): a banner in the grid, a square thumbnail on the left in the list,
     * and — because the compact offer card carries no photo at all — nothing in compact. Defaults to the grid,
     * which is how the Market opens.
     */
    viewMode?: 'grid' | 'list' | 'compact';
    onOpen?: () => void;
    onRsvpChange?: (post: MarketplacePost) => void;
    /**
     * Going / Interested on the card itself. Off by default: a card in the Market is one tap target that opens the
     * event, shows the viewer's own answer as text ("Going ✓") and leaves answering to the event's page. The web
     * map's preview is a single card, not a list, and the web's only way to answer from the map, so it turns this on.
     */
    rsvpOnCard?: boolean;
    /**
     * A visitor to the global lobby (G9b): no RSVP row, and no typed place (the node sends none to a visitor); a
     * distance only from a point the visitor shared, in whole km, since the node places the event at its area's centre.
     */
    visitor?: boolean;
    /**
     * The map's pop-up (DESIGN-card-style-box-fable.md §2, slice M1): the list card with the pop-up's ✕ in its top end
     * corner, which the map draws beside the card. The chip row keeps room for it. List view only.
     */
    popUp?: boolean;
}

export function EventCard({ post, identity, distanceKm, viewMode = 'grid', onOpen, onRsvpChange, rsvpOnCard = false, visitor = false, popUp = false }: EventCardProps) {
    const rsvp = useEventRsvp(post, identity, onRsvpChange);
    const p = rsvp.livePost;
    const copy = eventCopyOf(p);
    // An online event has no place and no distance: "Online" stands where they go (DESIGN-event-times §4).
    const place = p.eventOnline
        ? t('Online')
        : visitor
            ? (distanceKm != null ? visitorDistanceText(distanceKm) : '')
            : [p.eventPlaceName, distanceKm != null ? formatDistance(distanceKm) : ''].filter(Boolean).join(' · ');
    // The host gave the event a photo; the card showed everything but. It is read straight off the post, the way
    // the offer cards and the event page read theirs — there is no second resolver on the web client.
    const firstPhoto = p.photos && p.photos.length > 0 ? p.photos[0] : null;
    // The grid card shows the photo above its lines; the list card is the style box's (below). Compact has no picture
    // yet: its row joins the box in its own slice (C1, DESIGN-card-style-box-fable.md §4).
    const hasPicture = viewMode === 'grid';
    const photo = hasPicture ? firstPhoto : null;

    // The status line (DESIGN-market-event-cards-fable.md §2.2). Without the buttons the card says where the viewer
    // stands as text: a host reads that they are hosting, anyone else who answered reads their answer. A member's copy
    // on the global community has its copy line instead, and nobody there answers. With the buttons (the map's preview)
    // the filled button is the answer and the hosting line stays the buttons' own.
    const isHost = isEventHostView(p);
    const hosting = !rsvpOnCard && !copy && isHost;
    const myAnswer = !rsvpOnCard && !copy && !isHost ? myAnswerLine(p) : null;
    // The counts only once someone has answered; a viewer's own answer stands in their place, as the page has them.
    const counts = !copy && !myAnswer ? countsLine(p) : null;
    const openLabel = t('Open event: {title}', { title: p.title });
    // The label stands in for what is inside the button, so a viewer's own answer rides at its end.
    const label = [openLabel, hosting ? t("You're hosting this event") : null, myAnswer].filter(Boolean).join(', ');
    const copyLine = copy?.from ? copyCardLine(copy.from) : null;

    if (viewMode === 'list') {
        // The list card on the Market's style box (components/market-card-shell.ts; DESIGN-card-style-box-fable.md §1, W2):
        // the same card as an Offer's beside it. The photo, or the event tile until it has drawn (ListPhoto), is flush under
        // the card's left corners and the card's full height; the lines beside it with 12 of padding: the chips, the when
        // (16/900 in the event violet, whole pieces), the title (two lines), the place, and the viewer's mark or the counts.
        // The card takes the height its lines need. A copy's line is one of them, so the photo runs beside it too.
        return (
            <div data-testid="event-card" className={`${listCard()} flex-wrap`}>
                <button
                    type="button"
                    onClick={onOpen}
                    disabled={!onOpen}
                    aria-label={copyLine ? `${label}, ${copyLine}` : label}
                    className="w-full min-w-0 flex flex-row items-stretch text-left bg-transparent border-0 p-0 cursor-pointer disabled:cursor-default focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-nature-500"
                >
                    <span data-testid="event-list-photo" className={LIST_PHOTO}>
                        <ListPhoto
                            photo={firstPhoto}
                            alt={p.title}
                            className={`${LIST_PHOTO_FILL} object-cover`}
                            fallback={<span className={LIST_PHOTO_FILL}><CategoryTile kind="event" size="thumb" /></span>}
                        />
                    </span>
                    <span className={LIST_TEXT}>
                        <EventChips post={p} withType box endRoom={popUp} />
                        <EventWhen post={p} testId="event-when" className={`${LIST_TYPE.loud} ${CARD_INK.event}`} repeatClassName={CARD_INK.event} />
                        <span dir="auto" className={`w-full min-w-0 break-words line-clamp-2 ${LIST_TYPE.second} ${CARD_INK.title}`}>
                            {p.title}
                        </span>
                        {place && (
                            <span className={`block w-full truncate ${LIST_TYPE.place} ${CARD_INK.secondary}`}>
                                <span aria-hidden="true">{p.eventOnline ? '🌐 ' : '📍 '}</span>{place}
                            </span>
                        )}
                        {hosting && (
                            <span data-testid="event-hosting" className={`block w-full break-words ${LIST_TYPE.mark} ${CARD_INK.event}`}>
                                {t("You're hosting this event")}
                            </span>
                        )}
                        {myAnswer && (
                            <span data-testid="event-my-answer" className={`block w-full break-words ${LIST_TYPE.mark} ${CARD_INK.event}`}>
                                {myAnswer}
                            </span>
                        )}
                        {/* The counts wrap rather than cut: "interested" is the longest word on the card in most languages. */}
                        {counts && (
                            <span data-testid="event-counts" className={`block w-full break-words ${LIST_TYPE.mark} ${CARD_INK.secondary}`}>
                                <span aria-hidden="true">👥 </span>{counts}
                            </span>
                        )}
                        {copyLine && (
                            <span data-testid="event-copy-line" className="block w-full break-words text-sm font-semibold text-nature-700 dark:text-nature-300">
                                {copyLine}
                            </span>
                        )}
                    </span>
                </button>
                {/* Only the map's pop-up asks for the buttons (and it is this list card); they keep a row of their own under the card's lines. */}
                {rsvpOnCard && !visitor && !copy && <div className="basis-full px-3 pb-3"><RsvpButtons rsvp={rsvp} /></div>}
                {rsvpOnCard && rsvp.error && (
                    <p role="alert" className="basis-full m-0 px-3 pb-3 text-xs text-red-600 dark:text-red-400">{rsvp.error}</p>
                )}
            </div>
        );
    }

    const lines = (
        <>
            <EventChips post={p} withType />
            <EventWhen post={p} testId="event-when" className={`text-lg font-black leading-tight ${CARD_INK.event}`} repeatClassName={CARD_INK.event} />
            <span dir="auto" className="block w-full truncate text-base font-extrabold text-nature-950 dark:text-white leading-snug">
                {p.title}
            </span>
            {place && (
                <span className="block w-full truncate text-sm font-semibold text-nature-600 dark:text-nature-300">
                    <span aria-hidden="true">{p.eventOnline ? '🌐 ' : '📍 '}</span>{place}
                </span>
            )}
            {hosting && (
                <span data-testid="event-hosting" className="block w-full break-words text-sm font-bold text-bp-tile-event-ink">
                    {t("You're hosting this event")}
                </span>
            )}
            {myAnswer && (
                <span data-testid="event-my-answer" className="block w-full break-words text-sm font-bold text-bp-tile-event-ink">
                    {myAnswer}
                </span>
            )}
            {/* The counts wrap rather than cut: "interested" is the longest word on the card in most languages. */}
            {counts && (
                <span data-testid="event-counts" className="block w-full break-words text-sm font-semibold text-nature-600 dark:text-nature-300">
                    <span aria-hidden="true">👥 </span>{counts}
                </span>
            )}
        </>
    );

    return (
        // The grid tile joins the box in its own slice (W3'); until then its band is core's event tint, not a raw violet class.
        <div data-testid="event-card" className="w-full min-w-0 bg-white dark:bg-nature-950 border-2 border-bp-tile-event-tint rounded-2xl p-3 shadow-sm flex flex-col gap-2 overflow-hidden">
            <button
                type="button"
                onClick={onOpen}
                disabled={!onOpen}
                aria-label={label}
                className="w-full min-w-0 text-left bg-transparent border-0 p-0 flex flex-col gap-1 cursor-pointer disabled:cursor-default focus:outline-none focus-visible:ring-2 focus-visible:ring-bp-ink-event rounded-lg"
            >
                {hasPicture && (
                    photo ? (
                        <img
                            src={photo}
                            alt={p.title}
                            className="object-cover rounded-xl bg-nature-100 dark:bg-nature-900 w-full h-[110px] mb-1"
                        />
                    ) : (
                        <div className="overflow-hidden rounded-xl w-full h-[110px] mb-1">
                            <CategoryTile kind="event" size="grid" />
                        </div>
                    )
                )}
                {lines}
            </button>
            {copyLine && <p data-testid="event-copy-line" className="m-0 text-sm font-semibold text-nature-700 dark:text-nature-300 break-words">{copyLine}</p>}
            {rsvpOnCard && !visitor && !copy && <RsvpButtons rsvp={rsvp} />}
            {rsvpOnCard && rsvp.error && (
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
    /** Opens the Market filtered by a tag this event carries (§4.4). Absent: its tags aren't shown. */
    onOpenTag?: (id: string) => void;
    /** Opens the Market with exactly this typed tag (DESIGN-tags-free-entry-fable.md §4). */
    onOpenFreeTag?: (tag: string) => void;
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
     * Host only: open the create form filled from this event with the dates blank (§3, slice 5): a new event on
     * another date. A repeating event's own dates are its rule's (DESIGN-event-times §8; "Change this date only").
     */
    onCopyToNewDate?: (post: MarketplacePost) => void;
    /** Host only, a repeating event: "Change this date only" cancelled `date`; open the copy form with the moved-from line. */
    onChangeThisDateOnly?: (post: MarketplacePost, date: string) => void;
}

export function EventDetail({ post, identity, distanceKm, onShowOnMap, onOpenProfile, onOpenTag, onOpenFreeTag, onChange, onCancelled, onEdit, onOpenChat, onCopyToNewDate, onChangeThisDateOnly }: EventDetailProps) {
    const rsvp = useEventRsvp(post, identity, onChange);
    const p = rsvp.livePost;
    const [cancelling, setCancelling] = useState(false);
    const [cancelError, setCancelError] = useState<string | null>(null);
    const isHost = isEventHostView(p);
    const open = isEventOpen(p);
    const editBlocked = eventEditBlockedReason(p);
    // A member's copy, on the global community (@beanpool/core eventCopyOf): no author, no Going, no chat. The door instead.
    const copy = eventCopyOf(p);
    const isOwnCopy = !!copy && !!identity && p.authorPublicKey === identity.publicKey;
    const going = (p.eventRsvps ?? []).filter(r => r.status === 'going');
    const interested = (p.eventRsvps ?? []).filter(r => r.status === 'interested');
    const hostName = p.authorCallsign || p.authorPublicKey.slice(0, 8);
    // The host's box (components/AuthorCard.tsx, the box a listing's "Posted by" is): their ratings. A member's copy has no host to show.
    const hostRatings = useMemberRatings(copy ? null : p.authorPublicKey);
    const openMembership = (useCommunityInfo()?.features as { openMembership?: boolean } | undefined)?.openMembership === true;
    // Where the host lets people in (DESIGN-global-member-privacy-fable.md §2.3): before Going, waiting, or let in.
    const letInState = eventLetInState(p, isHost);
    const letInLine = eventLetInLine(letInState);
    const hostLetsIn = !!p.eventHostLetsIn;
    const waiting = hostLetsIn ? eventWaitingCount(p.eventRsvps) : 0;
    const [letting, setLetting] = useState<string | null>(null);
    const [letInError, setLetInError] = useState<string | null>(null);
    // The photo, whole (ImageLightbox), and the report form: each opened from its own button on the page.
    const [lightbox, setLightbox] = useState<{ trigger: HTMLElement | null } | null>(null);
    const [reporting, setReporting] = useState(false);

    const saveLetIn = async (key: string, who: { memberPublicKey: string } | { everyone: true }, on: boolean) => {
        if (letting) return;
        setLetting(key);
        setLetInError(null);
        try {
            const res = await letInToEvent(p.id, who, on);
            if (res?.post) rsvp.setLivePost(res.post);
        } catch (e: any) {
            setLetInError(e?.message || t('Could not reach the node.'));
        } finally {
            setLetting(null);
        }
    };
    const letEveryoneIn = () => {
        if (!window.confirm(letEveryoneInQuestion(waiting))) return;
        void saveLetIn('everyone', { everyone: true }, true);
    };

    const handleCancel = async () => {
        if (!window.confirm(t('Cancel this event? Everyone will see it as cancelled.'))) return;
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
            setCancelError(e?.message || t('Could not cancel the event.'));
        } finally {
            setCancelling(false);
        }
    };

    const photos = (p.photos ?? []).filter(photo => typeof photo === 'string' && photo.trim() !== '');
    const hasPhoto = photos.length > 0;
    const cancelled = p.eventState === 'cancelled' || p.status === 'cancelled';
    const counts = !copy ? countsLine(p) : null;
    const placeLine = [p.eventPlaceName, distanceKm != null ? formatDistance(distanceKm) : ''].filter(Boolean).join(' · ') || t('On the map');
    // 🚩 Report, for anyone signed in who is not running it (the host, a keeper or convenor who sees the guest list) and not
    // its author (a member's own copy on the global community).
    const canReport = !!identity && !isHost && p.authorPublicKey !== identity.publicKey;
    const chatWaiting = !!onOpenChat && !copy && letInState === 'waiting';
    const chatOpen = !!onOpenChat && !copy && (isHost || (p.myRsvp === 'going' && letInState !== 'waiting'));

    // The page is one column, the parts in DESIGN-detail-pages-fable.md §2.1's order as DESIGN-detail-pages-frame-fable.md §1.6
    // amends it, drawn from the style box (components/market-card-shell.ts), as the phone's page is: the chips, the loud lines
    // (the when; how it repeats as the door to the next dates, "↻ Every 3 weeks on Saturday · Next dates", in the caption's
    // slot, DESIGN-web-dates-stop-fable.md §1; the title; the place), the answer, the photo, the quiet row, the boxes, the
    // description, the host, the host's own, Report. The answer comes before the photo so Going is on the first screen at
    // 320 px and 130% text, with a photo or without. No outer card: the column is the page, and its boxes are the card family's. From 768 px a photo takes
    // the left column, spanning the three rows, and the head, the answer and the rest the right, one row each, placed by the
    // grid with the DOM order kept (so Tab reads the chips, the when and Going before the photo), as the listing's page does.
    return (
        <div
            data-testid="event-detail"
            className={`w-full min-w-0 flex flex-col gap-3 ${hasPhoto ? 'md:grid md:grid-cols-2 md:grid-rows-[auto_auto_1fr] md:gap-x-6 md:gap-y-3 md:items-start' : ''}`}
        >
            {/*
              * 1 and 4: the chip row, then the loud lines in the card's order: the when, how it repeats, the title, the place. On
              * the page the rule is the door to the next dates (↻ rule · Next dates) and heads them once open, so the when draws
              * no repeat line of its own here, and a node that sends no dates still gets the rule, in the same place, once.
              */}
            <div data-testid="event-head" className={`flex flex-col gap-2 min-w-0 ${hasPhoto ? 'md:col-start-2 md:row-start-1' : ''}`}>
                <EventChips post={p} withType box />
                <h2 className="m-0 min-w-0 flex flex-col gap-1">
                    <EventWhen post={p} hostLine repeatLine={false} className={`${PAGE_TYPE.when} ${PAGE_INK.event}${cancelled ? ' line-through' : ''}`} />
                </h2>
                <EventNextDates
                    post={p}
                    compact
                    repeatCaption={eventRepeatCaption(p)}
                    isHost={isHost && open}
                    onChanged={(next) => { rsvp.setLivePost(next); onChange?.(next); }}
                    onChangeThisDateOnly={onChangeThisDateOnly}
                />
                <h3 dir="auto" className={`m-0 ${PAGE_TYPE.title} text-nature-950 dark:text-white break-words`}>{p.title}</h3>

                {p.eventOnline && (
                    <div data-testid="event-online" className="flex flex-wrap items-center gap-x-3 min-w-0">
                        <span className={`min-w-0 break-words ${PAGE_TYPE.place} ${PAGE_INK.body}`}>
                            <span aria-hidden="true">🌐 </span>{t('Online')}
                        </span>
                        {joinHref(p.eventLink) ? (
                            <a
                                data-testid="event-join"
                                href={joinHref(p.eventLink)!}
                                target="_blank"
                                rel="noopener noreferrer"
                                className={`inline-flex items-center min-h-[48px] ${PAGE_TYPE.link} ${PAGE_INK.event} focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-bp-ink-event rounded`}
                            >
                                {t('Join')}
                            </a>
                        ) : !isHost && open ? (
                            // Going already: the host has not added one (yet). Never "tap Going" to someone who did. Where the host
                            // lets people in, the link waits for them like the note (eventPrivateOpenTo), and the hint says so.
                            <p data-testid="event-join-hint" className={`m-0 basis-full ${PAGE_TYPE.note} ${PAGE_INK.secondary}`}>
                                {letInLine
                                    ? t('The link to join shows here once the host lets you in.')
                                    : p.myRsvp === 'going' ? t('The host has not added a link to join yet.') : t('The link to join shows here once you tap Going.')}
                            </p>
                        ) : null}
                    </div>
                )}

                {!p.eventOnline && (p.eventPlaceName || p.lat != null) && (
                    <div data-testid="event-place" className="flex flex-wrap items-center gap-x-3 min-w-0">
                        <span className={`min-w-0 break-words ${PAGE_TYPE.place} ${PAGE_INK.body}`}>
                            <span aria-hidden="true">📍 </span>{placeLine}
                        </span>
                        {/* A link, not a button (§2.2), with the whole 48 px row as its target. */}
                        {onShowOnMap && p.lat != null && p.lng != null && (
                            <button
                                type="button"
                                onClick={() => onShowOnMap(p)}
                                className={`shrink-0 inline-flex items-center min-h-[48px] px-0 bg-transparent border-0 cursor-pointer ${PAGE_TYPE.link} ${PAGE_INK.event} focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-bp-ink-event rounded`}
                            >
                                {t('Show on map')}
                            </button>
                        )}
                        {/* Where anyone can join, the spot is the host's to give (DESIGN-global-member-privacy-fable.md §4). */}
                        {!copy && placeShownRoughly(p, identity?.publicKey, openMembership) && (
                            <p data-testid="rough-place-line" className={`m-0 basis-full text-sm ${PAGE_INK.secondary} leading-snug break-words`}>
                                {t(PLACE_WORDS.roughPlace, { name: hostName })}
                            </p>
                        )}
                    </div>
                )}
            </div>

            {/*
              * 7. The answer: Going / Interested, the host's line, or a copy's door; the counts only once someone has answered.
              * Before the photo, its own row in the grid. Its 4 px below makes 16 to the photo on the phone, and keeps today's 16
              * to the quiet row from 768 px, where the row under it is the rest of the page.
              */}
            <div data-testid="event-action" className={`flex flex-col gap-1.5 min-w-0 mb-1 ${hasPhoto ? 'md:col-start-2 md:row-start-2' : ''}`}>
                {copy ? open && !isOwnCopy && <EventCopyDoor copy={copy} /> : <RsvpButtons rsvp={rsvp} page />}
                {counts && (
                    <p data-testid="event-counts" className={`m-0 ${PAGE_TYPE.note} ${PAGE_INK.secondary}`}>
                        <span aria-hidden="true">👥 </span>{counts}
                    </p>
                )}
                {letInLine && open && (
                    <p data-testid="event-let-in-line" className={`m-0 text-sm ${PAGE_INK.body} break-words`}>{letInLine}</p>
                )}
                {rsvp.error && <p role="alert" className="m-0 text-xs text-red-600 dark:text-red-400">{rsvp.error}</p>}
            </div>

            {/*
              * 8. The photo, under the answer: 4:3, the column's width, under the shell's corners; a click shows it whole,
              * uncropped (Marty's pick 2: the same 800 px photo, nothing stored). No photo: the event's tile, 3:1, inside the column.
              * Its 4 px below makes 16 to the quiet row on the phone (DESIGN-detail-pages-frame-fable.md §3); from 768 px the photo
              * spans the three rows of its own column, so none there.
              */}
            {hasPhoto ? (
                <div data-testid="event-photo" className="min-w-0 mb-1 md:mb-0 md:col-start-1 md:row-start-1 md:row-span-3">
                    <button
                        type="button"
                        data-testid="event-photo-open"
                        onClick={(e) => setLightbox({ trigger: e.currentTarget })}
                        aria-label={t('View enlarged photo {n} of {total}: {title}', { n: 1, total: photos.length, title: p.title })}
                        className="block w-full aspect-[4/3] rounded-[14px] overflow-hidden border-0 p-0 bg-nature-100 dark:bg-nature-900 cursor-zoom-in focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-bp-ink-event"
                    >
                        <img src={photos[0]} alt={p.title} className="block w-full h-full object-cover" />
                    </button>
                </div>
            ) : (
                <div data-testid="event-tile-banner" className="w-full aspect-[3/1] mb-1 rounded-[14px] overflow-hidden">
                    <CategoryTile kind="event" size="banner" />
                </div>
            )}
            {lightbox && (
                <ImageLightbox
                    isOpen
                    photos={photos}
                    initialIndex={0}
                    title={p.title}
                    triggerElement={lightbox.trigger}
                    onClose={() => setLightbox(null)}
                />
            )}

            <div data-testid="event-body" className={`flex flex-col gap-4 min-w-0 ${hasPhoto ? 'md:col-start-2 md:row-start-3' : ''}`}>
                {/*
                  * 9. The quiet row: the chat (for the host and anyone Going), Share, Add to calendar, in the neutral outline.
                  * Share and the calendar need no node, so neither depends on its age.
                  */}
                <EventShareAndCalendar
                    post={p}
                    lead={(chatWaiting || chatOpen) ? (
                        chatWaiting ? (
                            <button
                                type="button"
                                disabled
                                data-testid="event-chat-waiting"
                                className={`basis-full text-left break-words ${PAGE_BUTTON.quiet}`}
                            >
                                💬 {eventChatWaitingText()}
                            </button>
                        ) : (
                            <button
                                type="button"
                                data-testid="event-open-chat"
                                onClick={() => onOpenChat!(p)}
                                className={`basis-full text-left break-words ${PAGE_BUTTON.quiet}`}
                            >
                                <span aria-hidden="true">💬</span> {t('Open event chat')}
                            </button>
                        )
                    ) : undefined}
                />

                {/* 10. Remind me, and the note for people who are going: boxes. The host has no RSVP, so no reminder (decision 2). */}
                {!isHost && !copy && <EventReminder post={p} identity={identity} myRsvp={p.myRsvp ?? null} />}
                {p.eventPrivateNote ? (
                    <div data-testid="event-private-note" className={PAGE_BOX}>
                        <p className={BOX_LABEL.event}>{t('Note for people who are going')}</p>
                        <p dir="auto" className={`m-0 text-sm ${PAGE_INK.body} whitespace-pre-wrap break-words`}>{p.eventPrivateNote}</p>
                    </div>
                ) : !isHost && !copy && open && !letInLine ? (
                    <p className={`m-0 ${PAGE_TYPE.note} ${PAGE_INK.secondary}`}>
                        {t('If the host left a note (a gate code, parking, what to bring), it shows here once you tap Going.')}
                    </p>
                ) : null}

                {/* 11. The description and the tags: reading comes after the answer (Marty's pick 1). */}
                {p.description && (
                    <p dir="auto" data-testid="event-description" className={`m-0 ${PAGE_TYPE.description} ${PAGE_INK.body} whitespace-pre-wrap break-words`}>{p.description}</p>
                )}
                {onOpenTag && <PostTagChips tags={p.tags} freeTags={p.freeTags} onPick={onOpenTag} onPickFree={onOpenFreeTag} />}

                {/* 12. The person: a copy names where it comes from; otherwise the host is the box a listing's "Posted by" is. */}
                {copy?.from && <p data-testid="event-copy-from" className={`m-0 text-sm font-semibold ${PAGE_INK.body} break-words`}>{copyFromLine(copy.from)}</p>}
                {!copy && (
                    <div className="flex flex-col gap-1.5 min-w-0">
                        <AuthorCard
                            label={t('Hosted by')}
                            pubkey={p.authorPublicKey}
                            callsign={hostName}
                            avatarUrl={p.authorAvatarUrl}
                            ratings={hostRatings}
                            onOpen={() => onOpenProfile?.(p.authorPublicKey)}
                            testId="event-host-open"
                        />
                        {/* A group-only event says who can see it, just under the host's box. */}
                        {p.audienceScope === 'group' && !!p.targetGroupName && (
                            <p data-testid="event-host-audience" className={`m-0 text-sm ${PAGE_INK.secondary} break-words`}>
                                {t('🔒 Only {group} can see this', { group: p.targetGroupName })}
                            </p>
                        )}
                    </div>
                )}

                {/* 13. The host's own: show it on the global community, and who's going with the host's tools. */}
                {isHost && (
                    <ShowOnGlobalHostRow post={p} identity={identity} enabled={!copy && open && p.eventOnline !== true && (p.audienceScope ?? 'public') === 'public' && p.authorPublicKey === identity?.publicKey} />
                )}
                {isHost && (
                    <div data-testid="event-host-panel" className={`flex flex-col gap-2 ${PAGE_BOX}`}>
                        <p className={`${BOX_LABEL.muted} !mb-0`}>{t("Who's going")}</p>
                        {waiting > 0 && (
                            <p data-testid="event-waiting-count" className={`m-0 text-sm font-bold ${PAGE_INK.body}`}>{eventWaitingLine(waiting)}</p>
                        )}
                        {waiting >= 2 && open && (
                            <button
                                type="button"
                                data-testid="event-let-everyone-in"
                                onClick={letEveryoneIn}
                                disabled={!!letting}
                                className={PAGE_BUTTON.eventOutline}
                            >
                                {t('Let everyone in')}
                            </button>
                        )}
                        {going.length === 0 && interested.length === 0 ? (
                            <p className={`m-0 text-sm ${PAGE_INK.secondary}`}>{t('Nobody yet.')}</p>
                        ) : (
                            <ul className="m-0 p-0 list-none flex flex-col gap-1">
                                {[...going, ...interested].map(r => (
                                    <li key={r.memberPubkey} className="flex items-center justify-between gap-2 min-w-0 text-sm">
                                        <span className="flex-1 min-w-0 truncate font-semibold text-nature-900 dark:text-white">
                                            {r.memberCallsign || r.memberPubkey.slice(0, 8)}
                                        </span>
                                        {hostLetsIn && r.status === 'going' && open ? (
                                            <button
                                                type="button"
                                                data-testid="event-let-in"
                                                onClick={() => saveLetIn(r.memberPubkey, { memberPublicKey: r.memberPubkey }, !r.letInAt)}
                                                disabled={!!letting}
                                                aria-pressed={!!r.letInAt}
                                                aria-label={letInButtonLabel(!!r.letInAt, r.memberCallsign)}
                                                className={`shrink-0 min-w-[88px] ${r.letInAt ? PAGE_BUTTON.eventFill : PAGE_BUTTON.eventOutline}`}
                                            >
                                                {r.letInAt ? t('Let in ✓') : t('Let in')}
                                            </button>
                                        ) : (
                                            <span className={`shrink-0 text-xs font-bold ${PAGE_INK.secondary}`}>
                                                {r.status === 'going' ? t('Going') : t('Interested')}
                                            </span>
                                        )}
                                    </li>
                                ))}
                            </ul>
                        )}
                        {onEdit && !editBlocked && (
                            <button
                                type="button"
                                data-testid="event-edit"
                                onClick={() => onEdit(p)}
                                className={PAGE_BUTTON.eventFill}
                            >
                                {t('Edit event')}
                            </button>
                        )}
                        {onEdit && editBlocked && (
                            <p data-testid="event-edit-blocked" className={`m-0 text-sm ${PAGE_INK.secondary}`}>{editBlockedWords(editBlocked)}</p>
                        )}
                        {onCopyToNewDate && (
                            <button
                                type="button"
                                data-testid="event-copy-to-new-date"
                                onClick={() => onCopyToNewDate(p)}
                                className={PAGE_BUTTON.eventOutline}
                            >
                                {t('Copy to a new date')}
                            </button>
                        )}
                        {open && (
                            <button
                                type="button"
                                onClick={handleCancel}
                                disabled={cancelling}
                                className="min-h-[48px] px-3 rounded-xl border-[1.5px] border-red-300 dark:border-red-900 text-[0.9375rem] font-bold leading-tight text-red-700 dark:text-red-300 bg-transparent disabled:opacity-60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-500 focus-visible:ring-offset-1"
                            >
                                {cancelling ? t('Cancelling…') : t('Cancel event')}
                            </button>
                        )}
                        {cancelError && <p role="alert" className="m-0 text-xs text-red-600 dark:text-red-400">{cancelError}</p>}
                        {letInError && <p role="alert" className="m-0 text-xs text-red-600 dark:text-red-400">{letInError}</p>}
                    </div>
                )}

                {/* 14. Report, last and small, as the listing's page has it: the web's event page had none (DW1). */}
                {canReport && (
                    <>
                        <button
                            type="button"
                            data-testid="event-report"
                            onClick={() => setReporting(true)}
                            className={`self-start inline-flex items-center min-h-[48px] px-0 bg-transparent border-0 cursor-pointer hover:underline ${PAGE_TYPE.report} ${PAGE_INK.danger} focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-500 rounded`}
                        >
                            {t('🚩 Report')}
                        </button>
                        <ReportModal
                            isOpen={reporting}
                            onClose={() => setReporting(false)}
                            reporterPubkey={identity!.publicKey}
                            targetPubkey={p.authorPublicKey}
                            targetName={p.title}
                            targetPostId={p.id}
                        />
                    </>
                )}
            </div>
        </div>
    );
}
