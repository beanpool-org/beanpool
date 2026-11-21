/**
 * What the node will still send a member for an event they answered (utils/event-extras.ts eventNoticesComing, the node's own
 * rule: apps/server/src/engine/event-reminders.ts dueEventReminders, apps/server/src/engine/posts.ts notifyEventChange), and
 * the named line's words from it (@beanpool/core notifyEventLineWords). The event page says only this (slice N2b fix round,
 * the deciding review on #3339): the reminder the day before only while its moment is ahead by the member's own choice, a
 * change only to Going, nothing with their Marketplace switch off or before the choice is read.
 *
 * The table: answer x when the event is x the member's choice -> exactly the reminders still to come and the words, each row
 * red without its line. The sweep: every combination against the invariants (never a reminder named that won't come, never
 * a change promised to Interested).
 */
import { describe, expect, it } from 'vitest';
import { notifyEventLineWords } from '@beanpool/core';
import { eventNoticesComing, remindersToCome, type EventReminderChoiceRead } from '../event-extras';

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const NOW = Date.UTC(2026, 10, 21, 2, 0);
const at = (ms: number) => new Date(NOW + ms).toISOString();

/** When the event starts, and whether it has ended (an event with no end runs two hours). */
const WHEN = {
    'a week away': { startAt: at(7 * DAY + 2 * HOUR), ended: false },
    '25 h away': { startAt: at(25 * HOUR), ended: false },
    'exactly a day away': { startAt: at(DAY), ended: false },
    'a day less a minute away': { startAt: at(DAY - MIN), ended: false },
    '23 h away': { startAt: at(23 * HOUR), ended: false },
    '1 h away': { startAt: at(HOUR), ended: false },
    'started an hour ago': { startAt: at(-HOUR), ended: false },
    'ended': { startAt: at(-5 * HOUR), ended: true },
} as const;
type When = keyof typeof WHEN;

const read = (c: Partial<EventReminderChoiceRead>): EventReminderChoiceRead => ({ offsets: null, defaults: [1440], marketplaceOn: true, known: true, ...c });
const CHOICES = {
    'the default (the day before)': read({}),
    'their default: a week and a day before': read({ defaults: [10080, 1440] }),
    'their default: 2 hours before': read({ defaults: [120] }),
    'their default: none': read({ defaults: [] }),
    "this event's own: none": read({ offsets: [] }),
    "this event's own: a day and an hour before": read({ offsets: [1440, 60] }),
    'the Marketplace switch off': read({ marketplaceOn: false }),
    'not read yet (offline)': read({ known: false }),
} as const;
type Choice = keyof typeof CHOICES;

const FULL = 'Get a reminder the day before, and hear if it changes.';
const REMIND = 'Get a reminder the day before.';
const CHANGE = 'Hear if it changes.';
const DONE: Record<string, string> = {
    [FULL]: "You'll get a reminder the day before, and hear if it changes.",
    [REMIND]: "You'll get a reminder the day before.",
    [CHANGE]: "You'll hear if it changes.",
};

/** [answer, when, choice, the reminders still to come, the line (null: none, and none offered)] */
const TABLE: Array<['going' | 'interested' | null, When, Choice, number[], string | null]> = [
    // The day-before default, by when the event is.
    ['going', 'a week away', 'the default (the day before)', [1440], FULL],
    ['going', '25 h away', 'the default (the day before)', [1440], FULL],
    ['going', 'exactly a day away', 'the default (the day before)', [1440], FULL],
    ['going', 'a day less a minute away', 'the default (the day before)', [], CHANGE],
    ['going', '23 h away', 'the default (the day before)', [], CHANGE],
    ['going', '1 h away', 'the default (the day before)', [], CHANGE],
    ['going', 'started an hour ago', 'the default (the day before)', [], CHANGE],
    ['going', 'ended', 'the default (the day before)', [], null],
    ['interested', 'a week away', 'the default (the day before)', [1440], REMIND],
    ['interested', '25 h away', 'the default (the day before)', [1440], REMIND],
    ['interested', 'exactly a day away', 'the default (the day before)', [1440], REMIND],
    ['interested', 'a day less a minute away', 'the default (the day before)', [], null],
    ['interested', '23 h away', 'the default (the day before)', [], null],
    ['interested', '1 h away', 'the default (the day before)', [], null],
    ['interested', 'started an hour ago', 'the default (the day before)', [], null],
    ['interested', 'ended', 'the default (the day before)', [], null],
    [null, 'a week away', 'the default (the day before)', [], null],
    [null, '23 h away', 'the default (the day before)', [], null],
    // The member's own choice, changed from the default.
    ['going', 'a week away', 'their default: a week and a day before', [10080, 1440], FULL],
    ['interested', '25 h away', 'their default: a week and a day before', [1440], REMIND],
    ['going', 'a week away', 'their default: 2 hours before', [120], CHANGE],
    ['interested', 'a week away', 'their default: 2 hours before', [120], null],
    ['going', 'a week away', 'their default: none', [], CHANGE],
    ['interested', 'a week away', 'their default: none', [], null],
    ['going', 'a week away', "this event's own: none", [], CHANGE],
    ['interested', 'a week away', "this event's own: none", [], null],
    ['going', '25 h away', "this event's own: a day and an hour before", [1440, 60], FULL],
    ['going', '23 h away', "this event's own: a day and an hour before", [60], CHANGE],
    ['interested', '23 h away', "this event's own: a day and an hour before", [60], null],
    ['interested', '1 h away', "this event's own: a day and an hour before", [60], null],
    ['going', 'started an hour ago', "this event's own: a day and an hour before", [], CHANGE],
    // Nothing reaches the phone, or nothing is known yet.
    ['going', 'a week away', 'the Marketplace switch off', [], null],
    ['interested', 'a week away', 'the Marketplace switch off', [], null],
    ['going', 'a week away', 'not read yet (offline)', [], null],
    ['interested', 'a week away', 'not read yet (offline)', [], null],
];

describe('what the node will still send, and the line that says so: the table', () => {
    it.each(TABLE)('%s × %s × %s: reminders %j, line %j', (answer, when, choice, reminders, line) => {
        const coming = eventNoticesComing({ answer, ...WHEN[when], choice: CHOICES[choice], nowMs: NOW });
        expect(coming.reminders).toEqual(reminders);
        expect(coming.dayBefore).toBe(reminders.includes(1440));
        const words = notifyEventLineWords(coming);
        expect(words?.line ?? null).toBe(line);
        if (line) expect(words).toEqual({ line, done: DONE[line], button: 'Tell me' });
    });
});

describe('the sweep: every answer x when x choice', () => {
    for (const answer of ['going', 'interested', null] as const) {
        for (const when of Object.keys(WHEN) as When[]) {
            for (const choice of Object.keys(CHOICES) as Choice[]) {
                it(`${answer} × ${when} × ${choice}`, () => {
                    const c = CHOICES[choice];
                    const { startAt, ended } = WHEN[when];
                    const coming = eventNoticesComing({ answer, startAt, ended, choice: c, nowMs: NOW });
                    const sent = c.known && c.marketplaceOn && !!answer && !ended;
                    // Every reminder named comes: in the choice that applies, its moment not behind us.
                    for (const minutes of coming.reminders) {
                        expect(c.offsets ?? c.defaults).toContain(minutes);
                        expect(Date.parse(startAt) - minutes * MIN).toBeGreaterThanOrEqual(NOW);
                    }
                    // And every one that comes is named.
                    const due = sent ? (c.offsets ?? c.defaults).filter((m) => Date.parse(startAt) - m * MIN >= NOW) : [];
                    expect([...coming.reminders].sort()).toEqual([...due].sort());
                    // A change is told to Going alone.
                    expect(coming.changes).toBe(sent && answer === 'going');
                    const words = notifyEventLineWords(coming);
                    const said = words ? `${words.line} ${words.done}` : '';
                    if (!coming.dayBefore) expect(said).not.toMatch(/reminder/);
                    if (!coming.changes) expect(said).not.toMatch(/changes/);
                    if (!sent) expect(words).toBeNull();
                });
            }
        }
    }
});

describe('remindersToCome', () => {
    it("reads the event's own choice before the member's default, and none is none", () => {
        expect(remindersToCome(at(3 * DAY), [120], [1440], NOW)).toEqual([120]);
        expect(remindersToCome(at(3 * DAY), null, [1440], NOW)).toEqual([1440]);
        expect(remindersToCome(at(3 * DAY), [], [1440], NOW)).toEqual([]);
    });
    it('a start that is no date: nothing promised', () => {
        expect(remindersToCome(undefined, null, [1440], NOW)).toEqual([]);
        expect(remindersToCome('soon', null, [1440], NOW)).toEqual([]);
    });
});
