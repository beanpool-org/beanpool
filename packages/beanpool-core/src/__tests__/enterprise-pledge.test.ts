/**
 * When a project stops taking pledges (#2500, its deciding review): once its end date is over, the moment its deadline
 * badge says "Expired". Both apps store a deadline as the chosen day, the web as UTC midnight at its start and the phone
 * at the time of day its picker opened, and the node takes today's date (apps/server/src/routes/project-deadline.ts). So
 * a deadline an hour ago is the project's last day: its badge says "Ends today", and it takes pledges.
 */
import { describe, expect, it } from 'vitest';
import { deadlineDaysRemaining, isPastDeadline, takesPledges } from '../enterprise-pledge.js';

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const NOW = Date.parse('2026-10-26T09:30:00.000Z');
/** The deadline whose instant was `ms` before NOW (after it, for a negative `ms`). */
const ago = (ms: number) => new Date(NOW - ms).toISOString();

/** The badge's number as both apps' five getDaysRemaining copies worked it out before core had it. */
const badgeDays = (deadline: string, now: number) => Math.ceil((new Date(deadline).getTime() - now) / (1000 * 60 * 60 * 24));

describe('isPastDeadline: past once its end date is over', () => {
    it('no deadline, or one that names no time, never passes', () => {
        for (const deadline of [null, undefined, '', 'not a date']) expect(isPastDeadline(deadline, NOW)).toBe(false);
    });

    it("open ahead of the deadline, at it, an hour after it and 23 h 59 m after it: the project's end date", () => {
        expect(isPastDeadline(ago(-DAY), NOW)).toBe(false);
        expect(isPastDeadline(ago(0), NOW)).toBe(false);
        expect(isPastDeadline(ago(HOUR), NOW)).toBe(false);
        expect(isPastDeadline(ago(DAY - MINUTE), NOW)).toBe(false);
        expect(isPastDeadline(ago(DAY - 1), NOW)).toBe(false);
    });

    it("closed from 24 h after the deadline's instant", () => {
        expect(isPastDeadline(ago(DAY), NOW)).toBe(true);
        expect(isPastDeadline(ago(DAY + HOUR), NOW)).toBe(true);
        expect(isPastDeadline(ago(30 * DAY), NOW)).toBe(true);
    });

    it("a project made with today's date in the web's date field takes pledges until that UTC day is over", () => {
        const webToday = new Date('2026-10-26').toISOString();
        expect(webToday).toBe('2026-10-26T00:00:00.000Z');
        expect(isPastDeadline(webToday, Date.parse('2026-10-26T00:00:00.000Z'))).toBe(false);
        expect(isPastDeadline(webToday, Date.parse('2026-10-26T00:44:00.000Z'))).toBe(false);
        expect(isPastDeadline(webToday, Date.parse('2026-10-26T23:59:59.999Z'))).toBe(false);
        expect(isPastDeadline(webToday, Date.parse('2026-10-27T00:00:00.000Z'))).toBe(true);
    });

    it('the web card asks the same: an active project short of its goal takes pledges through its end date', () => {
        const project = { goalAmount: 20, currentAmount: 5, status: 'active', lifecycle: 'bounded' };
        expect(takesPledges({ ...project, deadlineAt: ago(HOUR) }, NOW)).toBe(true);
        expect(takesPledges({ ...project, deadlineAt: ago(DAY - MINUTE) }, NOW)).toBe(true);
        expect(takesPledges({ ...project, deadlineAt: ago(DAY) }, NOW)).toBe(false);
    });
});

describe("deadlineDaysRemaining: the deadline badge's number", () => {
    it('counts a part day as a whole one: 0 is "Ends today" and below 0 "Expired"', () => {
        expect(deadlineDaysRemaining(ago(-5 * DAY + HOUR), NOW)).toBe(5);
        expect(deadlineDaysRemaining(ago(-1), NOW)).toBe(1);
        expect(deadlineDaysRemaining(ago(0), NOW)).toBe(0);
        // A part day behind is -0 (Math.ceil): the badges' `days === 0` reads it as today.
        expect(deadlineDaysRemaining(ago(HOUR), NOW) === 0).toBe(true);
        expect(deadlineDaysRemaining(ago(DAY - 1), NOW) === 0).toBe(true);
        expect(deadlineDaysRemaining(ago(DAY), NOW)).toBe(-1);
        expect(deadlineDaysRemaining(ago(DAY + HOUR), NOW)).toBe(-1);
        expect(deadlineDaysRemaining(ago(2 * DAY + 1), NOW)).toBe(-2);
    });

    it('is NaN for a deadline that names no time, as the badges always worked it out', () => {
        expect(deadlineDaysRemaining('not a date', NOW)).toBeNaN();
    });
});

describe('The badge and the gate: one rule', () => {
    // Every quarter hour from three days ahead to three days behind, and either side of each day's edge to the millisecond.
    const offsets: number[] = [];
    for (let q = -3 * 96; q <= 3 * 96; q++) offsets.push(q * 15 * MINUTE);
    for (let d = -3; d <= 3; d++) offsets.push(d * DAY - 1, d * DAY, d * DAY + 1);

    it('the badge says Expired exactly when isPastDeadline, and its number is the one the badges always showed', () => {
        for (const offset of offsets) {
            const deadline = ago(offset);
            const days = deadlineDaysRemaining(deadline, NOW);
            expect(days, deadline).toBe(badgeDays(deadline, NOW));
            expect(isPastDeadline(deadline, NOW), deadline).toBe(days < 0);
            expect(isPastDeadline(deadline, NOW), deadline).toBe(offset >= DAY);
        }
    });
});
