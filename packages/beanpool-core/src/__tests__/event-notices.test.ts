/**
 * What the node will still tell a member of an event they answered (src/event-notices.ts, slices N2b and N5b), in core so the
 * phone and the web read one rule. The phone's own table (apps/native/utils/__tests__/event-notices-coming.test.ts) runs it
 * through the phone's re-export over the phone's shapes; this one holds it for both shapes the apps hand it: the web's post
 * (camelCase: eventStartAt, eventState, status, active as a flag) and the phone's cached row (snake_case).
 *
 * Table: answer x when x the event's state x shape -> exactly the reminders still to come, the day before, and changes; each
 * row red without the guard it names.
 */
import { describe, expect, it } from 'vitest';
import { eventNoticesComing, eventStillOn, remindersToCome, type EventReminderChoiceRead } from '../event-notices.js';
import { notifyEventLineWords } from '../notify-ask.js';

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const NOW = Date.UTC(2026, 10, 22, 2, 0);
const at = (ms: number) => new Date(NOW + ms).toISOString();

const WHEN = {
    'a week and 2 h away': 7 * DAY + 2 * HOUR,
    '25 h away': 25 * HOUR,
    '23 h away': 23 * HOUR,
    'started an hour ago': -HOUR,
    'ended (no end: two hours)': -3 * HOUR,
} as const;

/** The event's own state, in the web's spelling and the phone's. `on` carries the node's defaults. */
const STATE: Record<string, { web: Record<string, unknown>; phone: Record<string, unknown>; on: boolean; pins: string }> = {
    on: { web: { status: 'active', active: true, eventState: 'scheduled' }, phone: { status: 'active', active: 1, event_state: 'scheduled' }, on: true, pins: 'none' },
    'moved by its host': { web: { status: 'active', eventState: 'updated' }, phone: { event_state: 'updated' }, on: true, pins: "'updated' is still on" },
    'cancelled by its host': { web: { status: 'active', eventState: 'cancelled' }, phone: { event_state: 'cancelled' }, on: false, pins: 'event_state cancelled' },
    removed: { web: { status: 'cancelled', active: false }, phone: { status: 'cancelled', active: 0 }, on: false, pins: "status 'cancelled'" },
    paused: { web: { status: 'paused' }, phone: { status: 'paused' }, on: false, pins: "status not 'active'" },
    'not active': { web: { active: false }, phone: { active: 0 }, on: false, pins: 'active false or 0' },
    'hidden by reports': { web: { hiddenByReportsAt: at(-DAY) }, phone: { hidden_by_reports_at: at(-DAY) }, on: false, pins: 'hidden by reports' },
    'held by a moderator': { web: { removedByModeratorAt: at(-DAY) }, phone: { removed_by_moderator_at: at(-DAY) }, on: false, pins: 'removed by a moderator' },
};

const choice = (over: Partial<EventReminderChoiceRead> = {}): EventReminderChoiceRead => ({ offsets: null, defaults: [1440], marketplaceOn: true, known: true, ...over });

function event(shape: 'web' | 'phone', when: number, state: Record<string, unknown>) {
    return shape === 'web' ? { id: 'ev', eventStartAt: at(when), ...state } : { id: 'ev', event_start_at: at(when), ...state };
}

describe('eventNoticesComing: answer x when x state x shape (both apps hand it their own shape)', () => {
    for (const shape of ['web', 'phone'] as const) {
        for (const [stateName, s] of Object.entries(STATE)) {
            for (const [whenName, when] of Object.entries(WHEN)) {
                for (const answer of ['going', 'interested'] as const) {
                    const ended = when <= -2 * HOUR;
                    const live = s.on && !ended;
                    const dayBefore = live && when - DAY >= 0;
                    it(`${shape}: ${answer}, ${whenName}, ${stateName} -> ${live ? `${dayBefore ? 'the day before' : 'no reminder'}${answer === 'going' ? ', changes' : ''}` : 'nothing'} (pins: ${s.pins})`, () => {
                        const got = eventNoticesComing({ answer, event: event(shape, when, s[shape]), choice: choice(), nowMs: NOW });
                        expect(got).toEqual({ reminders: dayBefore ? [1440] : [], dayBefore, changes: live && answer === 'going' });
                        // The named line says only that: no words where nothing is coming.
                        const words = notifyEventLineWords(got);
                        if (!live || (!dayBefore && answer === 'interested')) expect(words).toBeNull();
                        else expect(words?.line).toBe(dayBefore ? (answer === 'going' ? 'Get a reminder the day before, and hear if it changes.' : 'Get a reminder the day before.') : 'Hear if it changes.');
                    });
                }
            }
        }
    }

    it('nothing with no answer, before the choice is read, or with the Marketplace switch off', () => {
        const ev = event('web', 3 * DAY, STATE.on.web);
        expect(eventNoticesComing({ answer: null, event: ev, choice: choice(), nowMs: NOW }).changes).toBe(false);
        expect(eventNoticesComing({ answer: 'going', event: ev, choice: choice({ known: false }), nowMs: NOW })).toEqual({ reminders: [], dayBefore: false, changes: false });
        expect(eventNoticesComing({ answer: 'going', event: ev, choice: choice({ marketplaceOn: false }), nowMs: NOW })).toEqual({ reminders: [], dayBefore: false, changes: false });
    });
});

describe('remindersToCome: the node\'s own offsets, still ahead, largest first', () => {
    const start = at(3 * DAY);
    it('the event\'s own choice over the default; none ticked is none; offsets the node refuses are dropped', () => {
        expect(remindersToCome(start, null, [1440, 60], NOW)).toEqual([1440, 60]);
        expect(remindersToCome(start, [10080, 120, 30], [1440], NOW)).toEqual([120, 30]);
        expect(remindersToCome(start, [], [1440], NOW)).toEqual([]);
        expect(remindersToCome(start, [45, 1440, 1440], [1440], NOW)).toEqual([1440]);
        expect(remindersToCome('not a date', null, [1440], NOW)).toEqual([]);
        expect(remindersToCome(null, null, [1440], NOW)).toEqual([]);
    });
    it('a moment exactly now is still to come; a minute behind is not', () => {
        expect(remindersToCome(at(DAY), null, [1440], NOW)).toEqual([1440]);
        expect(remindersToCome(at(DAY - MIN), null, [1440], NOW)).toEqual([]);
    });
});

describe('eventStillOn: an end in either spelling', () => {
    it('an end given ends it then; with none, two hours after the start', () => {
        expect(eventStillOn({ eventStartAt: at(-5 * HOUR), eventEndAt: at(HOUR) }, NOW)).toBe(true);
        expect(eventStillOn({ event_start_at: at(-5 * HOUR), event_end_at: at(-MIN) }, NOW)).toBe(false);
        expect(eventStillOn({ eventStartAt: at(-HOUR - 59 * MIN) }, NOW)).toBe(true);
        expect(eventStillOn({ eventStartAt: at(-2 * HOUR) }, NOW)).toBe(false);
        expect(eventStillOn(null, NOW)).toBe(false);
    });
});
