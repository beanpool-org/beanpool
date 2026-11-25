/**
 * The three things an event page offers once it is in your diary: Share, Add to calendar, and Remind me.
 *
 * Share and Add to calendar need no node at all — the link is built from the community's own address and
 * the .ics from the event in hand — so they are there whatever the node's age. Remind me DOES need the new
 * routes, and a node that does not have them answers 404; the row then removes itself without a word,
 * because a member on an older community should see an event page that simply has no reminders, not an
 * error about a feature they never asked for.
 */

import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { NOTIFY_TRUE_WORDS, eventNoticesComing, notifyRemindersOff, notifyTurnOn, t, type EventReminderChoiceRead } from '@beanpool/core';
import {
    getMyEvents, getNodeApiUrl, getNotificationPreferences, setEventReminder, type MarketplacePost,
} from '../lib/api';
import type { BeanPoolIdentity } from '../lib/identity';
import {
    DEFAULT_REMINDER_OFFSETS, REMINDER_OFFSETS, REMINDER_PREF_KEY, buildIcs, buildShareText, eventLink,
    formatReminderChoice, googleCalendarUrl, icsFileName, normaliseReminderOffsets, parseReminderOffsets,
    reminderOffsetLabel, type ShareableEvent,
} from '../lib/event-extras';
import { eventShareWhen } from '../lib/events';
import { useLanguage } from '../lib/useLanguage';
import { TELL_ME_WORDS, readNotifyAsk, turnOnAsk, webPushFailureMessage } from '../lib/web-push';
import { noteBrowserChanged, useNotifyBrowser } from './NotifyLine';
import { WEB_PUSH_ROW_WORDS } from './WebPushRow';
import { Sentence } from './Sentence';
import { useShare } from './SharePost';
import { MenuChoices, useInFlowMenu } from './ShareMenu';
import { PAGE_BOX, PAGE_BUTTON, PAGE_INK } from './market-card-shell';

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
        whenText: post.eventStartLocal && post.eventTz ? eventShareWhen(post) : null,
        tz: post.eventTz || null,
        online: post.eventOnline === true,
    };
}

/**
 * The quiet row's button: the neutral outline (DESIGN-detail-pages-fable.md §2.2, slice DW1). Each one is as wide as its own
 * words and only grows to share the row, so "📅 Add to calendar" drops to a row of its own before it is cut (320 px, 130%).
 */
const QUIET_ITEM = `grow basis-auto break-words ${PAGE_BUTTON.quiet}`;

/**
 * Share and Add to calendar: the event page's quiet row (DESIGN-detail-pages-fable.md §2.1 row 8). `lead` is the page's own
 * first item in the same row (the event's chat, for the host and anyone Going), so the row is one row of neutral buttons.
 *
 * Share is ONE button (DESIGN-detail-pages-fable.md §2.5, slice DW2) that opens a menu of the ways this member has here,
 * each with its sentence (components/SharePost.tsx useShare). Share with members hands the event's text to the browser's
 * own share sheet where there is one (a phone, mostly); where there is not, it copies the link and says so, which is the
 * same job done by the only means a desktop browser has. Add to calendar opens a choice between a calendar file (.ics)
 * for any calendar app, and Google Calendar. The calendar file builds the .ics here and downloads it: no node, no account,
 * and the same file the phone app shares. Google Calendar opens Google's template URL in a new tab.
 */
export function EventShareAndCalendar({ post, lead }: { post: MarketplacePost; lead?: ReactNode }) {
    const [note, setNote] = useState<string | null>(null);
    const calendar = useInFlowMenu();
    const event = shareableEvent(post);
    const link = eventLink(nodeOrigin(), post.id);
    // A shared time is read outside the app, by someone whose zone nobody knows: it names its zone.
    const when = eventShareWhen(post);

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
            say(t('Link copied.'));
        } catch {
            const el = document.createElement('textarea');
            el.value = text;
            document.body.appendChild(el);
            el.select();
            try { document.execCommand('copy'); say(t('Link copied.')); } catch { say(t('Could not copy the link.')); }
            document.body.removeChild(el);
        }
    };

    // Share with members hands over the event's own words (what, when, where, the link), not just its title.
    const shareMenu = useShare(post, {
        kind: 'event',
        triggerClassName: QUIET_ITEM,
        triggerTestId: 'event-share',
        membersLineTestId: 'event-share-members-note',
        shareWithMembers: share,
    });

    const downloadIcs = () => {
        calendar.close();
        const blob = new Blob([buildIcs(event, link)], { type: 'text/calendar;charset=utf-8' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = icsFileName(event);
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        setTimeout(() => URL.revokeObjectURL(url), 1000);
        say(t('Calendar file saved.'));
    };

    const openGoogleCalendar = () => {
        calendar.close();
        window.open(googleCalendarUrl(event, link), '_blank', 'noopener,noreferrer');
    };

    return (
        <div className="flex flex-col gap-2">
            <div data-testid="event-quiet-row" className="flex flex-wrap gap-2">
                {lead}
                {shareMenu.trigger}
                <div className="grow basis-auto flex">
                    <button
                        ref={calendar.buttonRef}
                        type="button"
                        data-testid="event-add-to-calendar"
                        onClick={calendar.toggle}
                        aria-expanded={calendar.open}
                        aria-haspopup="menu"
                        className={`w-full break-words ${PAGE_BUTTON.quiet}`}
                    >
                        <span aria-hidden="true">📅 </span>{t('Add to calendar')}
                    </button>
                </div>
            </div>
            {/* In the page's flow, under the row it opened from (the calendar's menu was built so, and is keyboard-handled). */}
            {shareMenu.menu}
            {calendar.open && (
                <MenuChoices
                    menu={calendar}
                    label={t('Add to calendar')}
                    choices={[
                        { key: 'ics', testId: 'event-add-calendar-file', label: t('Calendar file (.ics)'), line: t('For any calendar app'), onSelect: downloadIcs },
                        { key: 'google', testId: 'event-add-google-calendar', label: t('Google Calendar'), onSelect: openGoogleCalendar },
                    ]}
                />
            )}
            {note && <p role="status" data-testid="event-share-note" className={`m-0 text-xs ${PAGE_INK.secondary}`}>{note}</p>}
            {/* What a way of sharing leaves under the row: a link to copy by hand, the invite panel, the ask's answer. */}
            {shareMenu.after}
        </div>
    );
}

/** What the page holds of the member's reminder choice for this event (useEventReminderChoice). */
export interface EventReminderChoice extends EventReminderChoiceRead {
    /** This event's own choice saved (null: back to the default). */
    setOffsets: (next: number[] | null) => void;
}

const CHOICE_UNREAD: EventReminderChoiceRead = { offsets: null, defaults: DEFAULT_REMINDER_OFFSETS, marketplaceOn: true, known: false };

/**
 * The member's reminder choice for an event they answered (the phone's EventExtras useEventReminderChoice): what this event
 * is set to comes from `/api/events/mine`, because that is the one place the contract puts it; the member's default and
 * their Marketplace switch from their preferences. A member who has just tapped Going may not be in the list yet; they read
 * as "my default", which is exactly what the node will do for them until they choose otherwise.
 *
 * Held by the event page (components/EventCard.tsx EventDetail), which draws both the reminder box and the named line under
 * the answer: each says only what the node will send by this choice (core eventNoticesComing), and a choice changed in the
 * box changes both. Read again whenever the member answers after having none. `known` only once both reads have answered:
 * offline, nothing is promised.
 */
export function useEventReminderChoice(postId: string, publicKey: string | null | undefined, answered: boolean): EventReminderChoice {
    const [choice, setChoice] = useState<EventReminderChoiceRead>(CHOICE_UNREAD);
    useEffect(() => {
        if (!answered) {
            // No answer: no choice of its own; the next answer starts again from the member's default.
            setChoice(c => (!c.known && c.offsets === null ? c : CHOICE_UNREAD));
            return;
        }
        let cancelled = false;
        (async () => {
            let mineRead = false;
            let offsets: number[] | null = null;
            try {
                const mine = await getMyEvents();
                const row = mine.find(r => r.postId === postId);
                offsets = row ? parseReminderOffsets(row.reminderOffsets) : null;
                mineRead = true;
            } catch {
                // Offline, or a node having a bad minute: leaves the line reading "your default", which is what the node
                // would in fact do; but nothing is promised from it.
            }
            if (cancelled) return;
            if (mineRead) setChoice(c => ({ ...c, offsets }));
            if (!publicKey) return;
            try {
                const prefs = await getNotificationPreferences(publicKey);
                if (cancelled) return;
                setChoice(c => ({
                    ...c,
                    defaults: parseReminderOffsets(prefs?.[REMINDER_PREF_KEY]) ?? DEFAULT_REMINDER_OFFSETS,
                    // Settings' reading of the switch (pages/SettingsPage.tsx): on unless it says false, as text or a flag.
                    marketplaceOn: String(prefs?.notify_marketplace) !== 'false',
                    known: mineRead,
                }));
            } catch {
                // Keep the documented default; it is right for everyone who has not changed it. Unknown, so nothing is promised.
            }
        })();
        return () => { cancelled = true; };
    }, [answered, postId, publicKey]);
    const setOffsets = useCallback((next: number[] | null) => setChoice(c => ({ ...c, offsets: next })), []);
    return { ...choice, setOffsets };
}

interface ReminderProps {
    post: MarketplacePost;
    identity?: BeanPoolIdentity | null;
    /** Shown only to someone with an RSVP; the host gets no RSVP buttons, so they get no reminders either. */
    myRsvp: 'going' | 'interested' | null | undefined;
    /** The member's choice for this event, held by the page (useEventReminderChoice); read here when no page holds it. */
    choice?: EventReminderChoice;
}

/**
 * "Remind me": the choice that applies to this event, and a way to change it or hand it back to the
 * member's default (read by useEventReminderChoice, held by the page).
 *
 * While this browser can't tell the member (core notifyRemindersOff, read for the browser: web push reaches it and this
 * account's notifications are not on here) and a reminder is still to come for them (core eventNoticesComing, the node's own
 * rule: an event still on, a moment still ahead, their Marketplace switch on), the line is the true one instead
 * (DESIGN-notify-and-backup-asks-fable-amend2.md §6, slice N5b, the phone's N2b): "⏰ Reminders need notifications on."
 * [Turn on]. Not a soft ask but the state of something they asked for, so it shows every time, after a "Later" and after the
 * browser's "no" alike. Its Turn on brings the browser's own prompt inside the tap (lib/web-push.ts turnOnFromAsk), or,
 * where the browser blocks the site, says where only the browser can undo that. Never drawn where no reminder is coming, or
 * where web push can't reach this browser: there turning notifications on would bring nothing, so the box is Remind me as
 * it was, with its Change.
 */
export function EventReminder({ post, identity, myRsvp, choice: given }: ReminderProps) {
    const own = useEventReminderChoice(post.id, identity?.publicKey, !given && !!myRsvp);
    const choice = given ?? own;
    const { offsets, defaults, setOffsets } = choice;
    const [open, setOpen] = useState(false);
    const [draft, setDraft] = useState<number[]>([]);
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState<string | null>(null);
    // A reminder still to come by the node's own rule: only then can turning notifications on bring one.
    const reminderComing = eventNoticesComing({ answer: myRsvp, event: post, choice, nowMs: Date.now() }).reminders.length > 0;
    // The browser's own answer, read only while the true line could be drawn.
    const browser = useNotifyBrowser(identity?.publicKey, !!myRsvp && reminderComing);
    const remindersOff = reminderComing && notifyRemindersOff(browser);
    const [lang] = useLanguage();
    const [turningOn, setTurningOn] = useState(false);
    const [said, setSaid] = useState<{ text: string; failed: boolean } | null>(null);
    const turnOn = () => {
        if (!identity || !browser || turningOn) return;
        setSaid(null);
        // The browser blocks this site: only its own settings undo that, so nothing is asked; the line says where.
        if (notifyTurnOn(browser, readNotifyAsk(identity.publicKey)) === 'settings') {
            setSaid({ text: t(TELL_ME_WORDS.blocked), failed: false });
            return;
        }
        setTurningOn(true);
        // The browser's prompt is the first thing this tap waits on; its answer kept as a named line's Tell me keeps it.
        void turnOnAsk(identity, lang, 'line').then(r => {
            setTurningOn(false);
            if (r.result === 'blocked') setSaid({ text: t(TELL_ME_WORDS.blocked), failed: false });
            else if (r.result === 'failed') setSaid({ text: webPushFailureMessage(r.failure), failed: true });
            noteBrowserChanged();
        });
    };

    if (!myRsvp) return null;

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
            setError((e as Error)?.message || t('Could not save your reminder.'));
        } finally {
            setSaving(false);
        }
    };

    if (remindersOff) {
        return (
            <div data-testid="event-reminder" className={`flex flex-col gap-2 ${PAGE_BOX}`}>
                <div data-testid="event-reminders-off" className="flex flex-wrap items-center justify-between gap-2 min-w-0">
                    <p dir="auto" className={`m-0 min-w-0 text-sm font-semibold break-words ${PAGE_INK.body}`}>{t(NOTIFY_TRUE_WORDS.reminders)}</p>
                    <button type="button" data-testid="event-reminders-turn-on" onClick={turnOn} disabled={turningOn} aria-busy={turningOn}
                        className={`break-words disabled:opacity-60 disabled:cursor-wait ${PAGE_BUTTON.quiet}`}>
                        {t(WEB_PUSH_ROW_WORDS.turnOn)}
                    </button>
                </div>
                {said && (
                    <p
                        role={said.failed ? 'alert' : 'status'}
                        dir="auto"
                        data-testid="event-reminders-said"
                        className={`m-0 text-xs break-words ${said.failed ? 'text-bp-ink-danger' : PAGE_INK.secondary}`}
                    >
                        {said.text}
                    </p>
                )}
            </div>
        );
    }

    return (
        <div data-testid="event-reminder" className={`flex flex-col gap-2 ${PAGE_BOX}`}>
            <div className="flex flex-wrap items-center justify-between gap-2 min-w-0">
                <p className={`m-0 min-w-0 text-sm font-semibold ${PAGE_INK.body}`}>
                    <span aria-hidden="true">⏰ </span>
                    <Sentence
                        text={t('Remind me: {choice}')}
                        parts={{ choice: <span data-testid="event-reminder-current" className="font-bold">{formatReminderChoice(offsets, defaults)}</span> }}
                    />
                </p>
                <button
                    type="button"
                    data-testid="event-reminder-change"
                    onClick={() => (open ? setOpen(false) : openPicker())}
                    aria-expanded={open}
                    className={PAGE_BUTTON.quiet}
                >
                    {open ? t('Close') : t('Change')}
                </button>
            </div>

            {open && (
                <div className="flex flex-col gap-2">
                    <fieldset className="m-0 p-0 border-0 flex flex-col gap-1">
                        <legend className="text-xs font-black uppercase tracking-wide text-nature-500 dark:text-nature-400 mb-1">
                            {t('Tell me before it starts')}
                        </legend>
                        {REMINDER_OFFSETS.map(minutes => (
                            <label key={minutes} className="flex items-center gap-2 min-h-[48px] text-sm font-semibold text-nature-800 dark:text-nature-200 cursor-pointer">
                                <input
                                    type="checkbox"
                                    className="w-5 h-5 accent-bp-event-fill"
                                    checked={draft.includes(minutes)}
                                    onChange={e => setDraft(d => (e.target.checked ? [...d, minutes] : d.filter(m => m !== minutes)))}
                                />
                                {t('{offset} before', { offset: reminderOffsetLabel(minutes) })}
                            </label>
                        ))}
                    </fieldset>
                    <p className="m-0 text-xs text-nature-500 dark:text-nature-400">
                        {t('With none ticked you get no reminder for this event.')}
                    </p>
                    <div className="flex flex-wrap gap-2">
                        <button
                            type="button"
                            data-testid="event-reminder-save"
                            disabled={saving}
                            onClick={() => save(draft)}
                            className={`flex-1 min-w-[8rem] ${PAGE_BUTTON.eventFill}`}
                        >
                            {saving ? t('Saving…') : t('Save for this event')}
                        </button>
                        {offsets !== null && (
                            <button
                                type="button"
                                data-testid="event-reminder-reset"
                                disabled={saving}
                                onClick={() => save(null)}
                                className={`flex-1 min-w-[8rem] ${PAGE_BUTTON.quiet}`}
                            >
                                {t('Use my default')}
                            </button>
                        )}
                    </div>
                    {error && <p role="alert" className="m-0 text-xs text-red-600 dark:text-red-400">{error}</p>}
                </div>
            )}
        </div>
    );
}
