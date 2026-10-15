/**
 * A repeating event's "Next dates" on its detail page (DESIGN-event-times §4, §8): the dates the node sends on a by-id read
 * (`eventNextDates`, the current one first, cancelled ones marked), as a wrapped list. For the host, beside each: "Cancel
 * this date" (POST skip) or, for a cancelled one, "Bring it back" (DELETE), and "Change this date only", which cancels the
 * date and opens Copy to a new date with the line "Moved from the regular Friday". Cancelling the current date moves the
 * event on at once, and the page says so the way the node tells those going: "Fri 16 Oct is cancelled. Next: Fri 23 Oct".
 */

import { useState } from 'react';
import { repeatRefusalText, seriesCancelledLine, seriesDateLabel, t } from '@beanpool/core';
import { setEventDateCancelled, type MarketplacePost } from '../lib/api';

interface Props {
    post: MarketplacePost;
    isHost: boolean;
    /** The event as the node answered it after a change. */
    onChanged?: (post: MarketplacePost) => void;
    /** "Change this date only": after the date is cancelled, open the copy form with the moved-from line. */
    onChangeThisDateOnly?: (post: MarketplacePost, date: string) => void;
}

const LINK = 'inline-flex items-center min-h-[44px] bg-transparent border-0 p-0 text-sm font-bold underline cursor-pointer disabled:opacity-60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-500 rounded-sm';

export function EventNextDates({ post, isHost, onChanged, onChangeThisDateOnly }: Props) {
    const dates = post.eventNextDates ?? [];
    const [busy, setBusy] = useState<string | null>(null);
    const [line, setLine] = useState<string | null>(null);
    const [problem, setProblem] = useState<string | null>(null);
    if (!post.eventRepeat || dates.length === 0) return null;
    const current = post.eventStartLocal?.slice(0, 10) ?? null;

    const change = async (date: string, cancel: boolean, thenMove = false) => {
        if (busy) return;
        setBusy(date);
        setProblem(null);
        setLine(null);
        try {
            const res = await setEventDateCancelled(post.id, date, cancel);
            if (cancel && date === current) setLine(seriesCancelledLine(date, res.post?.eventStartLocal ?? null));
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
                            {d.cancelled && <span className="whitespace-nowrap text-xs font-bold uppercase text-red-700 dark:text-red-300">{t('Cancelled')}</span>}
                            {isHost && !d.cancelled && (
                                <>
                                    <button type="button" data-testid="event-date-cancel" disabled={!!busy}
                                        aria-label={t('Cancel {date}', { date: label })}
                                        onClick={() => { if (window.confirm(t('Cancel {date}? Everyone going that day is told.', { date: label }))) void change(d.date, true); }}
                                        className={`${LINK} text-red-700 dark:text-red-300`}>
                                        {t('Cancel this date')}
                                    </button>
                                    {onChangeThisDateOnly && (
                                        <button type="button" data-testid="event-date-move" disabled={!!busy}
                                            aria-label={t('Change {date} only', { date: label })}
                                            onClick={() => { if (window.confirm(t('Cancel {date} and make a one-off on another date?', { date: label }))) void change(d.date, true, true); }}
                                            className={`${LINK} text-violet-800 dark:text-violet-200`}>
                                            {t('Change this date only')}
                                        </button>
                                    )}
                                </>
                            )}
                            {isHost && d.cancelled && (
                                <button type="button" data-testid="event-date-restore" disabled={!!busy}
                                    aria-label={t('Bring back {date}', { date: label })}
                                    onClick={() => void change(d.date, false)}
                                    className={`${LINK} text-violet-800 dark:text-violet-200`}>
                                    {t('Bring it back')}
                                </button>
                            )}
                        </li>
                    );
                })}
            </ul>
            {problem && <p role="alert" data-testid="event-next-dates-problem" className="m-0 text-xs font-semibold text-red-600 dark:text-red-300 break-words">{problem}</p>}
        </section>
    );
}
