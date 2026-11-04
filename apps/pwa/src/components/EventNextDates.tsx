/**
 * A repeating event's "Next dates" on its detail page (DESIGN-event-times §4, §8): the dates the node sends on a by-id read
 * (`eventNextDates`, cancelled ones marked), as a wrapped list. For the host, beside each: "Cancel this date" (POST skip) or,
 * for a cancelled one, "Bring it back" (DELETE), and "Change this date only", which cancels the date and opens Copy to a new
 * date with the line "Moved from the regular Friday". Cancelling the current date moves the event on at once, and the page
 * says so the way the node tells those going: "Fri 16 Oct is cancelled. Next: Fri 23 Oct". The node lists a cancelled date
 * the event has passed first, until it has ended, so its "Bring it back" is there after a reload and on every device (the
 * node then moves the event back to it and tells those going "Fri 16 Oct is back on"; the deciding review of #1993, N2, and
 * its confirmation 2, NB2); the page drops it at its end. Each control's name starts with the words it shows, so a
 * voice-control user who says "tap Cancel this date" reaches it (WCAG 2.5.3).
 *
 * `compact` (the event page, DESIGN-detail-pages-frame-fable.md §1.6, as the phone's page has it since #2880): the heading, the
 * first date and "and 5 more" as one 48 px button that opens the list, where the host's controls are.
 *
 * `repeatCaption` (the event page, DESIGN-web-dates-stop-fable.md §1–2): the repeat rule is the door to the dates, in the
 * caption's slot under the when. Compact, one 48 px button "↻ Every third Saturday · Next dates" (no date, no "and 5 more");
 * opened, or with one date, the caption is the list's visible heading and "Next dates" its name; with no dates from the node
 * (an older node, a list read), the caption alone. So the page draws the caption once, in one place, whatever the node sent.
 */

import { useEffect, useRef, useState } from 'react';
import { repeatRefusalText, seriesBackOnLine, seriesCancelledLine, seriesDateLabel, seriesDatesShown, seriesPassedDateEndMs, t, tn } from '@beanpool/core';
import { setEventDateCancelled, type MarketplacePost } from '../lib/api';
import { PAGE_INK } from './market-card-shell';

interface Props {
    post: MarketplacePost;
    isHost: boolean;
    /** The event as the node answered it after a change. */
    onChanged?: (post: MarketplacePost) => void;
    /** "Change this date only": after the date is cancelled, open the copy form with the moved-from line. */
    onChangeThisDateOnly?: (post: MarketplacePost, date: string) => void;
    /**
     * The event page's form: the first date and "and 5 more", one button that opens the whole list. Six dates in full sit
     * between the title and Going and push the answer down by about 60 px at 320 px and 130% text.
     */
    compact?: boolean;
    /**
     * The repeat rule's caption (eventRepeatCaption), from the event page, which then leaves it out of the when: the rule
     * opens the dates, and heads them once open. Without it the component draws as it always has, for any other caller.
     */
    repeatCaption?: string;
}

/** The longest a timer may wait (setTimeout's limit); a later end is checked again then. */
const MAX_WAIT_MS = 2_147_483_647;

/** The repeat caption's own type, as the when draws it on the card (EventWhen): text-sm, bold, snug, in the event ink. */
const CAPTION = `min-w-0 break-words text-sm font-bold leading-snug ${PAGE_INK.event}`;

const LINK = 'inline-flex items-center min-h-[44px] bg-transparent border-0 p-0 text-sm font-bold underline cursor-pointer disabled:opacity-60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-500 rounded-sm';

export function EventNextDates({ post, isHost, onChanged, onChangeThisDateOnly, compact = false, repeatCaption }: Props) {
    // Compact, the rest waits for a tap; once opened it stays open, so the host's line and controls stay where they acted.
    const [open, setOpen] = useState(!compact);
    // Opened by a tap: the button it replaces is gone, so the reader is taken to the list it opened rather than the page's top.
    const listRef = useRef<HTMLElement>(null);
    const [tapped, setTapped] = useState(false);
    useEffect(() => { if (tapped) listRef.current?.focus(); }, [tapped]);
    const [busy, setBusy] = useState<string | null>(null);
    const [line, setLine] = useState<string | null>(null);
    const [problem, setProblem] = useState<string | null>(null);
    const current = post.eventStartLocal?.slice(0, 10) ?? null;
    // A cancelled date the event has passed goes from the list at its end: the node no longer takes it back then.
    const [tick, setTick] = useState(0);
    const passedEnd = seriesPassedDateEndMs(post.eventNextDates, current, Date.now());
    useEffect(() => {
        if (passedEnd == null) return;
        const id = setTimeout(() => setTick(n => n + 1), Math.min(MAX_WAIT_MS, passedEnd - Date.now() + 50));
        return () => clearTimeout(id);
    }, [passedEnd, tick]);
    const dates = seriesDatesShown(post.eventNextDates, current, Date.now());
    if (!post.eventRepeat) return null;
    const caption = repeatCaption ? <><span aria-hidden="true">↻ </span>{repeatCaption}</> : null;
    // No dates from the node (an older node, a list read): the rule alone, where it always is, so the slot is never empty.
    if (dates.length === 0) return caption ? <p data-testid="event-repeat-caption" className={`m-0 w-full ${CAPTION}`}>{caption}</p> : null;

    const change = async (date: string, cancel: boolean, thenMove = false) => {
        if (busy) return;
        setBusy(date);
        setProblem(null);
        setLine(null);
        try {
            const res = await setEventDateCancelled(post.id, date, cancel);
            if (cancel && date === current) setLine(seriesCancelledLine(date, res.post?.eventStartLocal ?? null));
            else if (!cancel && current && date < current) setLine(seriesBackOnLine(date));
            if (res.post) onChanged?.(res.post);
            if (thenMove) onChangeThisDateOnly?.(res.post ?? post, date);
        } catch (e: any) {
            setProblem(repeatRefusalText(e?.message) || t('Could not change that date.'));
        } finally {
            setBusy(null);
        }
    };

    // Compact, with the rule: "↻ Every third Saturday · Next dates", one button, the rule in its own type and the link's
    // words after it; it wraps whole (two lines at 320 px and 130% text, one at 100%). Its name is the words it shows (WCAG
    // 2.5.3), the ↻ left out; the spaces between the parts are for that name, a flex row draws none.
    if (!open && dates.length > 1 && caption) {
        return (
            <button
                type="button"
                data-testid="event-next-dates-open"
                aria-expanded={false}
                onClick={() => { setOpen(true); setTapped(true); }}
                className="w-full min-w-0 min-h-[48px] flex flex-wrap items-center content-center gap-x-1.5 gap-y-0 text-left bg-transparent border-0 p-0 cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-bp-ink-event rounded"
            >
                <span data-testid="event-repeat-caption" className={CAPTION}>{caption}</span>{' '}
                <span className={`text-sm font-bold ${PAGE_INK.secondary}`}>·</span>{' '}
                <span className="whitespace-nowrap text-sm font-bold underline underline-offset-2 text-bp-ink-event">{t('Next dates')}</span>
            </button>
        );
    }

    // Compact: the heading, the first date and how many more, one button that opens the list. One date has no more to open.
    if (!open && dates.length > 1) {
        const first = dates[0];
        return (
            <button
                type="button"
                data-testid="event-next-dates-open"
                aria-expanded={false}
                onClick={() => { setOpen(true); setTapped(true); }}
                className="w-full min-w-0 min-h-[48px] flex flex-col justify-center gap-0.5 text-left bg-transparent border-0 p-0 cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-bp-ink-event rounded"
            >
                <span className="text-xs font-bold text-nature-700 dark:text-nature-300 uppercase tracking-wider">{t('Next dates')}</span>
                <span className="min-w-0 flex flex-wrap items-center gap-x-3 gap-y-0">
                    <span className={`whitespace-nowrap text-sm font-bold ${first.cancelled ? 'line-through text-nature-700 dark:text-nature-300' : 'text-nature-900 dark:text-nature-100'}`}>{seriesDateLabel(first.date)}</span>
                    {first.cancelled && <span className="whitespace-nowrap text-xs font-bold uppercase text-bp-ink-danger">{t('Cancelled')}</span>}
                    <span className="whitespace-nowrap text-sm font-bold underline underline-offset-2 text-bp-ink-event">{tn(dates.length - 1, 'and {n} more', 'and {n} more')}</span>
                </span>
            </button>
        );
    }

    return (
        <section ref={listRef} tabIndex={-1} data-testid="event-next-dates" aria-label={caption ? t('Next dates') : undefined} className="min-w-0 flex flex-col gap-1 focus:outline-none">
            {/* With the rule, the rule heads the list (it opened it), and "Next dates" is the section's name. */}
            {caption
                ? <h4 data-testid="event-repeat-caption" className={`m-0 ${CAPTION}`}>{caption}</h4>
                : <h4 className="m-0 text-xs font-bold text-nature-700 dark:text-nature-300 uppercase tracking-wider">{t('Next dates')}</h4>}
            {line && <p data-testid="event-date-cancelled-line" role="status" className="m-0 text-sm font-bold text-nature-800 dark:text-nature-100 break-words">{line}</p>}
            <ul className={`m-0 p-0 list-none ${isHost ? 'flex flex-col gap-1' : 'flex flex-wrap gap-x-3 gap-y-1'}`}>
                {dates.map(d => {
                    const label = seriesDateLabel(d.date);
                    return (
                        <li key={d.date} data-testid="event-next-date" className="min-w-0 flex flex-wrap items-center gap-x-3 gap-y-0">
                            <span className={`whitespace-nowrap text-sm font-bold ${d.cancelled ? 'line-through text-nature-700 dark:text-nature-300' : 'text-nature-900 dark:text-nature-100'}`}>{label}</span>
                            {d.cancelled && <span className="whitespace-nowrap text-xs font-bold uppercase text-bp-ink-danger">{t('Cancelled')}</span>}
                            {isHost && !d.cancelled && (
                                <>
                                    <button type="button" data-testid="event-date-cancel" disabled={!!busy}
                                        aria-label={t('Cancel this date: {date}', { date: label })}
                                        onClick={() => { if (window.confirm(t('Cancel {date}? Everyone going that day is told.', { date: label }))) void change(d.date, true); }}
                                        className={`${LINK} text-bp-ink-danger`}>
                                        {t('Cancel this date')}
                                    </button>
                                    {onChangeThisDateOnly && (
                                        <button type="button" data-testid="event-date-move" disabled={!!busy}
                                            aria-label={t('Change this date only: {date}', { date: label })}
                                            onClick={() => { if (window.confirm(t('Cancel {date} and make a one-off on another date?', { date: label }))) void change(d.date, true, true); }}
                                            className={`${LINK} text-violet-800 dark:text-violet-200`}>
                                            {t('Change this date only')}
                                        </button>
                                    )}
                                </>
                            )}
                            {isHost && d.cancelled && (
                                <button type="button" data-testid="event-date-restore" disabled={!!busy}
                                    aria-label={t('Bring it back: {date}', { date: label })}
                                    onClick={() => void change(d.date, false)}
                                    className={`${LINK} text-violet-800 dark:text-violet-200`}>
                                    {t('Bring it back')}
                                </button>
                            )}
                        </li>
                    );
                })}
            </ul>
            {problem && <p role="alert" data-testid="event-next-dates-problem" className="m-0 text-xs font-semibold text-bp-ink-danger break-words">{problem}</p>}
        </section>
    );
}
