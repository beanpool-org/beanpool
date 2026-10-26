import { describe, it, expect } from 'vitest';
import { deadlineDaysRemaining } from '@beanpool/core';
import { pledgeClosedLine, isPastDeadline, pledgeReturnLine } from './enterprise-pledge';

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const CLOSED = "This project's deadline has passed: it takes no more pledges.";

describe('pledgeClosedLine: the node takes a pledge only while an enterprise is active', () => {
    it('is null for an active enterprise, or one whose status is not known', () => {
        expect(pledgeClosedLine('active')).toBeNull();
        expect(pledgeClosedLine(undefined)).toBeNull();
        expect(pledgeClosedLine(null)).toBeNull();
        expect(pledgeClosedLine('')).toBeNull();
    });

    it('says a funded enterprise has reached its goal', () => {
        expect(pledgeClosedLine('funded')).toBe('This enterprise has reached its goal, so it isn’t taking more pledges.');
    });

    it('says one winding up is winding up, and any other state closed', () => {
        expect(pledgeClosedLine('winding_up')).toBe('This enterprise is winding up, so it isn’t taking pledges.');
        for (const s of ['completed', 'suspended', 'disabled', 'pruned']) {
            expect(pledgeClosedLine(s)).toBe('This enterprise has closed, so it isn’t taking pledges.');
        }
    });

    it('says "project" for a project (group decisions pick 8)', () => {
        expect(pledgeClosedLine('funded', 'bounded')).toBe('This project has reached its goal, so it isn’t taking more pledges.');
        expect(pledgeClosedLine('winding_up', 'bounded')).toBe('This project is winding up, so it isn’t taking pledges.');
        expect(pledgeClosedLine('completed', 'bounded')).toBe('This project has closed, so it isn’t taking pledges.');
        expect(pledgeClosedLine('completed', 'ongoing')).toBe('This enterprise has closed, so it isn’t taking pledges.');
    });

    it('says a project whose deadline has passed is no longer taking pledges', () => {
        const past = new Date(Date.now() - 2 * 86400000).toISOString();
        expect(pledgeClosedLine('active', 'bounded', past)).toBe("This project's deadline has passed: it takes no more pledges.");
        expect(pledgeClosedLine(undefined, 'bounded', past)).toBe("This project's deadline has passed: it takes no more pledges.");

        // An hour after the deadline's instant is still its end date: the badge says "Ends today", and pledges are open.
        const oneHourAgo = new Date(Date.now() - 3600 * 1000).toISOString();
        expect(isPastDeadline(oneHourAgo)).toBe(false);
        expect(pledgeClosedLine('active', 'bounded', oneHourAgo)).toBeNull();
    });

    it("stays open all through its end date: 23 h 59 m after the deadline's instant open, 24 h after closed", () => {
        const now = Date.now();
        const ago = (ms: number) => new Date(now - ms).toISOString();
        expect(isPastDeadline(ago(DAY - MINUTE), now)).toBe(false);
        expect(pledgeClosedLine('active', 'bounded', ago(DAY - MINUTE), now)).toBeNull();
        expect(isPastDeadline(ago(DAY), now)).toBe(true);
        expect(pledgeClosedLine('active', 'bounded', ago(DAY), now)).toBe(CLOSED);
    });

    it('closes exactly when the deadline badge says Expired (its number below 0), never before', () => {
        const now = Date.parse('2026-10-26T09:30:00.000Z');
        for (let minutes = -3 * 24 * 60; minutes <= 3 * 24 * 60; minutes += 7) {
            const deadline = new Date(now - minutes * MINUTE).toISOString();
            const expired = deadlineDaysRemaining(deadline, now) < 0;
            expect(isPastDeadline(deadline, now), deadline).toBe(expired);
            expect(pledgeClosedLine('active', 'bounded', deadline, now), deadline).toBe(expired ? CLOSED : null);
        }
    });
});

// A project that ends short of its goal gives its backers their Beans back a week after its end date, unless the end date
// moves before then (Marty, board, 27 Oct 2026). The page says so plainly, and once they have gone back, that they went back.
describe('pledgeReturnLine: what the project page says happens to the Beans if the goal is not reached', () => {
    // 10:00 UTC is the same calendar day on every clock from UTC-10 to UTC+13, so these read the same wherever they run.
    const NOW = Date.parse('2026-11-20T10:00:00.000Z');
    const project = { goalAmount: 100, currentAmount: 45, status: 'active' };

    it('before its end date is over: if the goal isn’t reached by then, everyone’s Beans go back a week after it', () => {
        expect(pledgeReturnLine({ ...project, deadlineAt: '2026-11-30T10:00:00.000Z' }, NOW))
            .toBe('If the goal isn’t reached by 30 Nov 2026, everyone’s Beans go back on 7 Dec 2026.');
        // On its end date it still takes pledges, and says the same.
        expect(pledgeReturnLine({ ...project, deadlineAt: '2026-11-20T10:00:00.000Z' }, NOW + 5 * HOUR))
            .toBe('If the goal isn’t reached by 20 Nov 2026, everyone’s Beans go back on 27 Nov 2026.');
        // And to a project nobody has backed yet: it is what a backer is promised.
        expect(pledgeReturnLine({ ...project, currentAmount: 0, deadlineAt: '2026-11-30T10:00:00.000Z' }, NOW))
            .toBe('If the goal isn’t reached by 30 Nov 2026, everyone’s Beans go back on 7 Dec 2026.');
    });

    it('in the week after its end date: they go back on the day, unless the end date moves before then', () => {
        expect(pledgeReturnLine({ ...project, deadlineAt: '2026-11-17T10:00:00.000Z' }, NOW))
            .toBe('The goal wasn’t reached by 17 Nov 2026. Everyone’s Beans go back on 24 Nov 2026, unless the end date moves before then.');
    });

    it('from the day they are due until the node has returned them: they are going back', () => {
        expect(pledgeReturnLine({ ...project, deadlineAt: '2026-11-13T10:00:00.000Z' }, NOW))
            .toBe('The goal wasn’t reached by 13 Nov 2026, so everyone’s Beans are going back.');
    });

    it('once the node has returned them: they went back, on the day it did', () => {
        expect(pledgeReturnLine({ ...project, currentAmount: 0, deadlineAt: '2026-11-10T10:00:00.000Z', pledgesReturnedAt: '2026-11-17T10:00:30.000Z' }, NOW))
            .toBe('The goal wasn’t reached by 10 Nov 2026, so everyone’s Beans went back on 17 Nov 2026.');
    });

    it('says nothing once its end date is over with nothing pledged: nothing is held to go back', () => {
        expect(pledgeReturnLine({ ...project, currentAmount: 0, deadlineAt: '2026-11-17T10:00:00.000Z' }, NOW)).toBeNull();
        expect(pledgeReturnLine({ ...project, currentAmount: 0, deadlineAt: '2026-11-01T10:00:00.000Z' }, NOW)).toBeNull();
    });

    it('says nothing for a project that reached its goal, an enterprise with no goal, or a project with no end date', () => {
        const ahead = '2026-11-30T10:00:00.000Z';
        expect(pledgeReturnLine({ ...project, currentAmount: 100, deadlineAt: ahead }, NOW)).toBeNull();
        expect(pledgeReturnLine({ ...project, status: 'funded', deadlineAt: ahead }, NOW)).toBeNull();
        expect(pledgeReturnLine({ ...project, status: 'completed', deadlineAt: ahead }, NOW)).toBeNull();
        expect(pledgeReturnLine({ ...project, goalAmount: null, deadlineAt: ahead }, NOW)).toBeNull();
        expect(pledgeReturnLine({ ...project, goalAmount: 0, deadlineAt: ahead }, NOW)).toBeNull();
        for (const deadlineAt of [null, undefined, '', 'not a date']) expect(pledgeReturnLine({ ...project, deadlineAt }, NOW), String(deadlineAt)).toBeNull();
    });

    it('moves on exactly when pledges stop (the badge says Expired) and when the return falls due (core isPledgeReturnDue)', () => {
        const deadline = '2026-11-10T10:00:00.000Z';
        const at = Date.parse(deadline);
        expect(pledgeReturnLine({ ...project, deadlineAt: deadline }, at + DAY - 1)).toMatch(/^If the goal isn’t reached by /);
        expect(pledgeReturnLine({ ...project, deadlineAt: deadline }, at + DAY)).toMatch(/unless the end date moves before then\.$/);
        expect(pledgeReturnLine({ ...project, deadlineAt: deadline }, at + 7 * DAY - 1)).toMatch(/unless the end date moves before then\.$/);
        expect(pledgeReturnLine({ ...project, deadlineAt: deadline }, at + 7 * DAY)).toMatch(/so everyone’s Beans are going back\.$/);
    });
});
