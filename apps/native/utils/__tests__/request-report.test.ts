/** Which line Report on a request hands over, and what it reads as (utils/request-report.ts). */
import { describe, expect, it, vi } from 'vitest';

vi.mock('../db', () => ({ reportDmLine: vi.fn() }));
vi.mock('../blocklist', () => ({ blockUser: vi.fn(), isUserBlocked: vi.fn() }));

import { requestLineIn, wordsOfLine } from '../request-report';

const ME = 'me-key';
const line = (id: string, senderId: string, rawTimestamp: string, o: object = {}) => ({ id, senderId, rawTimestamp, timestamp: 'shown', ...o });

describe('requestLineIn', () => {
    it('is the other person\'s newest line by the node\'s time, in any order, whatever the bubble\'s clock face says', () => {
        const older = { ...line('a', 'bo', '2026-11-01T09:00:00.000Z'), timestamp: '9:00 pm' };
        const newer = { ...line('b', 'bo', '2026-11-01T14:00:00.000Z'), timestamp: '2:00 pm' };
        expect(requestLineIn([older, newer], ME)?.id).toBe('b');
        expect(requestLineIn([newer, older], ME)?.id).toBe('b');
    });

    it('is never my own line or the node\'s notice, and null with no line of theirs', () => {
        const mine = line('m', ME, '2026-11-01T15:00:00.000Z');
        const notice = line('n', 'SYSTEM', '2026-11-01T16:00:00.000Z');
        const system = line('s', 'bo', '2026-11-01T17:00:00.000Z', { type: 'system' });
        expect(requestLineIn([line('b', 'bo', '2026-11-01T14:00:00.000Z'), mine, notice, system], ME)?.id).toBe('b');
        expect(requestLineIn([mine, notice], ME)).toBeNull();
    });
});

describe('wordsOfLine', () => {
    it('is what it reads as here, and never the words standing in for a line that did not open', () => {
        expect(wordsOfLine({ text: 'Hello' })).toBe('Hello');
        expect(wordsOfLine({ text: 'This message could not be verified', unattributed: true })).toBe('');
        expect(wordsOfLine({ text: null })).toBe('');
    });
});
