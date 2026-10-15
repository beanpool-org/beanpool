/**
 * The three things an event page offers once it is in your diary: Share, Add to calendar, and Remind me.
 *
 * Share and Add to calendar need no node at all — the link is built from the community's own address and
 * the .ics from the event in hand — so they are there whatever the node's age. Remind me DOES need the new
 * routes, and a node that does not have them answers 404; the row then removes itself without a word,
 * because a member on an older community should see an event page that simply has no reminders, not an
 * error about a feature they never asked for.
 */

import { useCallback, useEffect, useState } from 'react';
import {
    getMyEvents, getNodeApiUrl, getNotificationPreferences, isRouteMissing, setEventReminder, type MarketplacePost,
} from '../lib/api';
import type { BeanPoolIdentity } from '../lib/identity';
import {
    DEFAULT_REMINDER_OFFSETS, REMINDER_OFFSETS, REMINDER_PREF_KEY, buildIcs, buildShareText, eventLink,
    formatReminderChoice, icsFileName, normaliseReminderOffsets, parseReminderOffsets, reminderOffsetLabel,
    type ShareableEvent,
} from '../lib/event-extras';
import { formatEventWhen } from '../lib/events';

/** The community's own address: the node the web app is talking to, or wherever it is being served from. */
export function nodeOrigin(): string {
    return getNodeApiUrl() || (typeof window !== 'undefined' ? window.location.origin : '');
}

export function shareableEvent(post: MarketplacePost): ShareableEvent {
    return {
        id: post.id,
        title: post.title,
        startAt: post.eventStartAt || '',
        endAt: post.eventEndAt || null,
        placeName: post.eventPlaceName || null,
        description: post.description || null,
    };
}

const BUTTON =
    'min-h-[48px] px-3 rounded-xl border border-violet-300 dark:border-violet-800 text-sm font-bold text-violet-800 '
    + 'dark:text-violet-200 bg-transparent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-500 '
    + 'focus-visible:ring-offset-1';

/**
 * Share and Add to calendar.
 *
 * Share hands the text to the browser's own share sheet where there is one (a phone, mostly); where there
 * is not, it copies the link and says so, which is the same job done by the only means a desktop browser
 * has. Add to calendar builds the .ics here and downloads it: no node, no account, and the same file the
 * phone app shares.
 */
export function EventShareAndCalendar({ post }: { post: MarketplacePost }) {
    const [note, setNote] = useState<string | null>(null);
    const event = shareableEvent(post);
    const link = eventLink(nodeOrigin(), post.id);
    const when = formatEventWhen(post);

    const say = (text: string) => {
        setNote(text);
        setTimeout(() => setNote(n => (n === text ? null : n)), 2500);
    };

    const share = async () => {
        const text = buildShareText(event, when, link);
        const nav = navigator as Navigator & { share?: (data: ShareData) => Promise<void> };
        if (typeof nav.share === 'function') {
            try {
                await nav.share({ title: post.title, text, url: link });
                return;
            } catch (e) {
                // Somebody who changed their mind is not an error, and must not be told anything.
                if ((e as Error)?.name === 'AbortError') return;
            }
        }
        try {
            await navigator.clipboard.writeText(text);
            say('Link copied.');
        } catch {
            const el = document.createElement('textarea');
            el.value = text;
            document.body.appendChild(el);
            el.select();
            try { document.execCommand('copy'); say('Link copied.'); } catch { say('Could not copy the link.'); }
            document.body.removeChild(el);
        }
    };

    const addToCalendar = () => {
        const blob = new Blob([buildIcs(event, link)], { type: 'text/calendar;charset=utf-8' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = icsFileName(event);
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        setTimeout(() => URL.revokeObjectURL(url), 1000);
        say('Calendar file saved.');
    };

    return (
        <div className="flex flex-col gap-2">
            <div className="flex flex-wrap gap-2">
                <button type="button" data-testid="event-share" onClick={share} className={`flex-1 min-w-[8rem] ${BUTTON}`}>
                    <span aria-hidden="true">🔗 </span>Share
                </button>
                <button type="button" data-testid="event-add-to-calendar" onClick={addToCalendar} className={`flex-1 min-w-[8rem] ${BUTTON}`}>
                    <span aria-hidden="true">📅 </span>Add to calendar
                </button>
            </div>
            {note && <p role="status" data-testid="event-share-note" className="m-0 text-xs text-nature-600 dark:text-nature-400">{note}</p>}
        </div>
    );
}

interface ReminderProps {
    post: MarketplacePost;
    identity?: BeanPoolIdentity | null;
    /** Shown only to someone with an RSVP; the host gets no RSVP buttons, so they get no reminders either. */
    myRsvp: 'going' | 'interested' | null | undefined;
}

/**
 * "Remind me": the choice that applies to this event, and a way to change it or hand it back to the
 * member's default.
 *
 * What this event is set to comes from `/api/events/mine`, because that is the one place the contract puts
 * it; the member's default comes from their preferences, so the line can say which it is. A 404 from
 * either takes the whole block away — that is an older node, and there is nothing here to offer on one.
 * A member who has just tapped Going may not be in the list yet; they read as "my default", which is
 * exactly what the node will do for them until they choose otherwise.
 */
export function EventReminder({ post, identity, myRsvp }: ReminderProps) {
    const [supported, setSupported] = useState(true);
    const [defaults, setDefaults] = useState<number[]>(DEFAULT_REMINDER_OFFSETS);
    const [offsets, setOffsets] = useState<number[] | null>(null);
    const [open, setOpen] = useState(false);
    const [draft, setDraft] = useState<number[]>([]);
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const loadMine = useCallback(async () => {
        try {
            const mine = await getMyEvents();
            const row = mine.find(r => r.postId === post.id);
            setOffsets(row ? parseReminderOffsets(row.reminderOffsets) : null);
        } catch (e) {
            if (isRouteMissing(e)) setSupported(false);
            // Anything else (offline, a node having a bad minute) leaves the line reading "your default",
            // which is what the node would in fact do.
        }
    }, [post.id]);

    useEffect(() => {
        if (!myRsvp) return;
        let cancelled = false;
        (async () => { if (!cancelled) await loadMine(); })();
        return () => { cancelled = true; };
    }, [loadMine, myRsvp]);

    useEffect(() => {
        if (!identity?.publicKey || !myRsvp) return;
        let cancelled = false;
        getNotificationPreferences(identity.publicKey)
            .then(prefs => {
                if (!cancelled) setDefaults(parseReminderOffsets(prefs?.[REMINDER_PREF_KEY]) ?? DEFAULT_REMINDER_OFFSETS);
            })
            .catch(() => { /* keep the documented default; it is right for everyone who has not changed it */ });
        return () => { cancelled = true; };
    }, [identity?.publicKey, myRsvp]);

    if (!supported || !myRsvp) return null;

    const openPicker = () => {
        setDraft(offsets ?? defaults);
        setError(null);
        setOpen(true);
    };

    const save = async (next: number[] | null) => {
        setSaving(true);
        setError(null);
        try {
            const cleaned = next === null ? null : normaliseReminderOffsets(next);
            await setEventReminder(post.id, cleaned);
            setOffsets(cleaned);
            setOpen(false);
        } catch (e) {
            if (isRouteMissing(e)) {
                setSupported(false);
                return;
            }
            setError((e as Error)?.message || 'Could not save your reminder.');
        } finally {
            setSaving(false);
        }
    };

    return (
        <div data-testid="event-reminder" className="flex flex-col gap-2 p-3 rounded-xl border border-nature-200 dark:border-nature-800">
            <div className="flex flex-wrap items-center justify-between gap-2 min-w-0">
                <p className="m-0 min-w-0 text-sm font-semibold text-nature-800 dark:text-nature-200">
                    <span aria-hidden="true">⏰ </span>Remind me:{' '}
                    <span data-testid="event-reminder-current" className="font-bold">{formatReminderChoice(offsets, defaults)}</span>
                </p>
                <button
                    type="button"
                    data-testid="event-reminder-change"
                    onClick={() => (open ? setOpen(false) : openPicker())}
                    aria-expanded={open}
                    className={BUTTON}
                >
                    {open ? 'Close' : 'Change'}
                </button>
            </div>

            {open && (
                <div className="flex flex-col gap-2">
                    <fieldset className="m-0 p-0 border-0 flex flex-col gap-1">
                        <legend className="text-xs font-black uppercase tracking-wide text-nature-500 dark:text-nature-400 mb-1">
                            Tell me before it starts
                        </legend>
                        {REMINDER_OFFSETS.map(minutes => (
                            <label key={minutes} className="flex items-center gap-2 min-h-[48px] text-sm font-semibold text-nature-800 dark:text-nature-200 cursor-pointer">
                                <input
                                    type="checkbox"
                                    className="w-5 h-5 accent-violet-700"
                                    checked={draft.includes(minutes)}
                                    onChange={e => setDraft(d => (e.target.checked ? [...d, minutes] : d.filter(m => m !== minutes)))}
                                />
                                {reminderOffsetLabel(minutes)} before
                            </label>
                        ))}
                    </fieldset>
                    <p className="m-0 text-xs text-nature-500 dark:text-nature-400">
                        With none ticked you get no reminder for this event.
                    </p>
                    <div className="flex flex-wrap gap-2">
                        <button
                            type="button"
                            data-testid="event-reminder-save"
                            disabled={saving}
                            onClick={() => save(draft)}
                            className="flex-1 min-w-[8rem] min-h-[48px] px-3 rounded-xl border border-violet-700 text-sm font-bold text-white bg-violet-700 dark:bg-violet-600 disabled:opacity-60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-500 focus-visible:ring-offset-1"
                        >
                            {saving ? 'Saving…' : 'Save for this event'}
                        </button>
                        {offsets !== null && (
                            <button
                                type="button"
                                data-testid="event-reminder-reset"
                                disabled={saving}
                                onClick={() => save(null)}
                                className={`flex-1 min-w-[8rem] disabled:opacity-60 ${BUTTON}`}
                            >
                                Use my default
                            </button>
                        )}
                    </div>
                    {error && <p role="alert" className="m-0 text-xs text-red-600 dark:text-red-400">{error}</p>}
                </div>
            )}
        </div>
    );
}
