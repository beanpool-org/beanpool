import { describe, it, expect } from 'vitest';
import { deadlineDaysRemaining } from '@beanpool/core';
import { pledgeClosedLine, isPastDeadline } from './enterprise-pledge';

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
