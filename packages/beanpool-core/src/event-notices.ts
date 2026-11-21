/**
 * What the node will still tell a member of an event they answered (scratch/fable-design/DESIGN-notify-and-backup-asks-fable-amend2.md
 * §12.3 slices N2b and N5b): one rule for both apps, so an event page on the phone and on the web promises the same, and
 * only what the node will send. The named line under an answer (notify-ask.ts notifyEventLineWords), its offer, and the
 * reminder's true line ("⏰ Reminders need notifications on.") all read it. Moved here from the phone's
 * utils/event-extras.ts, which re-exports it, when the web app began drawing those lines (N5b).
 *
 * Pure: no I/O and no Node built-ins (the barrel is bundled for the phone).
 */

/** Minutes before the start: the only reminder offsets the node accepts (both apps' event-extras REMINDER_OFFSETS). */
const NODE_REMINDER_OFFSETS: ReadonlySet<number> = new Set([10080, 1440, 120, 60, 30]);

/** An event with no end runs this long, as the node defaults it (both apps' EVENT_DEFAULT_DURATION_MS). */
const EVENT_DEFAULT_DURATION_MS = 2 * 60 * 60 * 1000;

/**
 * The reminders the node will still send a member for this event, by its own rule (apps/server/src/engine/event-reminders.ts
 * dueEventReminders): each offset of the choice that applies (this event's own, else the member's default) whose moment, the
 * start less the offset, is not yet behind us. The node never sends one whose moment had passed when the member answered or
 * chose it ("armedAt <= due": the RSVP's updated_at, which every answer, every switch and every reminder change moves to
 * now), so a moment behind us now is never coming. Offsets the node would refuse are dropped; largest first. No start that
 * reads as a date: none.
 */
export function remindersToCome(startAt: string | null | undefined, offsets: readonly number[] | null, defaults: readonly number[], nowMs: number): number[] {
    const startMs = typeof startAt === 'string' ? Date.parse(startAt) : NaN;
    if (!Number.isFinite(startMs)) return [];
    return [...new Set(offsets ?? defaults)]
        .filter((minutes) => NODE_REMINDER_OFFSETS.has(minutes) && startMs - minutes * 60_000 >= nowMs)
        .sort((a, b) => b - a);
}

/** What the page knows of the member's reminder choice and their Marketplace switch (each app's EventExtras useEventReminderChoice). */
export interface EventReminderChoiceRead {
    /** This event's own choice; null: the member's default applies. */
    offsets: number[] | null;
    /** The member's default (Settings → Notifications). */
    defaults: number[];
    /** Their Marketplace notifications switch: reminders and change notices ride that category, and the node drops both while it is off. */
    marketplaceOn: boolean;
    /** Both reads answered: until then nothing is known, so nothing is promised. */
    known: boolean;
}

/** What the node will still tell this member of the event: the reminders still to come, the day before among them, and changes. */
export interface EventNoticesComing {
    reminders: number[];
    dayBefore: boolean;
    changes: boolean;
}

const NOTHING_COMING: EventNoticesComing = { reminders: [], dayBefore: false, changes: false };

/** An event's end, either spelling (the phone's cached row is snake_case, the node's view and the web's post camelCase). */
function eventEndMs(event: any): number {
    const end = event?.event_end_at ?? event?.eventEndAt;
    if (end) return Date.parse(end);
    const start = event?.event_start_at ?? event?.eventStartAt;
    return start ? Date.parse(start) + EVENT_DEFAULT_DURATION_MS : NaN;
}

/**
 * Whether the node still tells anyone anything about this event, read from the event as the app holds it (snake_case or
 * camelCase). Its reminders go only for an event that is `active = 1 AND status = 'active' AND event_state != 'cancelled'
 * AND hidden_by_reports_at IS NULL` (apps/server/src/engine/event-reminders.ts dueEventReminders); its change notices come
 * only from an edit, which the node refuses once the event is cancelled, removed or ended (apps/server/src/engine/posts.ts
 * updatePost), or from the cancellation itself, after which nothing more is sent. So: not cancelled by its host, not removed
 * (status 'cancelled', active 0), not paused or otherwise not active, not hidden by reports or held by a moderator, and not
 * ended. While hidden, a change is not promised either: nothing is said that the node may not send. A field the row doesn't
 * carry reads as the node's default for it (active, status 'active').
 */
export function eventStillOn(event: any, nowMs: number): boolean {
    if (!event) return false;
    if (event.status === 'cancelled' || (event.event_state ?? event.eventState) === 'cancelled') return false;
    if (event.active === 0 || event.active === false) return false;
    if (event.status != null && event.status !== 'active') return false;
    if (event.hiddenByReportsAt || event.hidden_by_reports_at) return false;
    if (event.removedByModeratorAt || event.removed_by_moderator_at) return false;
    const end = eventEndMs(event);
    return !(Number.isFinite(end) && end <= nowMs);
}

/**
 * What the node will still send a member for an event they answered, from now on: the reminders still to come
 * ({@link remindersToCome}); and a change of time or place or a cancellation, told to Going alone and never to Interested
 * (apps/server/src/engine/posts.ts notifyEventChange). Nothing at all for an event the node no longer tells anyone about
 * ({@link eventStillOn}: cancelled, removed, not active, hidden, ended), with no answer, before the choice is read, or with
 * the member's Marketplace switch off (the push dispatcher drops `notify_marketplace` 'false'). It takes the event itself, so
 * every caller reads its state the one way.
 */
export function eventNoticesComing(i: {
    answer: 'going' | 'interested' | null | undefined;
    event: any;
    choice: EventReminderChoiceRead;
    nowMs: number;
}): EventNoticesComing {
    if ((i.answer !== 'going' && i.answer !== 'interested') || !i.choice.known || !i.choice.marketplaceOn) return NOTHING_COMING;
    if (!eventStillOn(i.event, i.nowMs)) return NOTHING_COMING;
    const reminders = remindersToCome(i.event?.event_start_at ?? i.event?.eventStartAt, i.choice.offsets, i.choice.defaults, i.nowMs);
    return { reminders, dayBefore: reminders.includes(1440), changes: i.answer === 'going' };
}
