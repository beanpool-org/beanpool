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
 */

import { useEffect, useState } from 'react';
import { repeatRefusalText, seriesBackOnLine, seriesCancelledLine, seriesDateLabel, seriesDatesShown, seriesPassedDateEndMs, t } from '@beanpool/core';
import { setEventDateCancelled, type MarketplacePost } from '../lib/api';

interface Props {
    post: MarketplacePost;
    isHost: boolean;
    /** The event as the node answered it after a change. */
    onChanged?: (post: MarketplacePost) => void;
    /** "Change this date only": after the date is cancelled, open the copy form with the moved-from line. */
    onChangeThisDateOnly?: (post: MarketplacePost, date: string) => void;
}

/** The longest a timer may wait (setTimeout's limit); a later end is checked again then. */
const MAX_WAIT_MS = 2_147_483_647;

const LINK = 'inline-flex items-center min-h-[44px] bg-transparent border-0 p-0 text-sm font-bold underline cursor-pointer disabled:opacity-60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-500 rounded-sm';

export function EventNextDates({ post, isHost, onChanged, onChangeThisDateOnly }: Props) {
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
    if (!post.eventRepeat || dates.length === 0) return null;

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

    return (
        <section data-testid="event-next-dates" className="min-w-0 flex flex-col gap-1">
            <h4 className="m-0 text-xs font-bold text-nature-600 dark:text-nature-300 uppercase tracking-wider">{t('Next dates')}</h4>
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
