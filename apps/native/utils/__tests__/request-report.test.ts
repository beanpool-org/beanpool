/** Which line Report on a request hands over, and what it reads as (utils/request-report.ts). */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../db', () => ({ reportDmLine: vi.fn() }));
vi.mock('../blocklist', () => ({ blockUser: vi.fn(), isUserBlocked: vi.fn() }));

import { reportDmLine } from '../db';
import { blockUser, isUserBlocked } from '../blocklist';
import { ReportedNotBlockedError, reportRequestAndBlock, requestLineIn, wordsOfLine } from '../request-report';

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

    // The deciding review of #2705: a delete leaves the request waiting, and the node refuses a tombstone (400 disclosure_form).
    it('is never a tombstone: an older line of theirs if there is one, else null', () => {
        const older = line('a', 'bo', '2026-11-01T09:00:00.000Z');
        const deleted = line('b', 'bo', '2026-11-01T14:00:00.000Z', { type: 'removed' });
        const removed = line('c', 'bo', '2026-11-01T15:00:00.000Z', { metadata: { removed: true } });
        expect(requestLineIn([older, deleted, removed], ME)?.id).toBe('a');
        expect(requestLineIn([deleted], ME)).toBeNull();
    });
});

describe('reportRequestAndBlock', () => {
    const LINE = { id: 'l1', text: 'Buy my crypto' };
    beforeEach(() => {
        vi.mocked(reportDmLine).mockReset();
        vi.mocked(blockUser).mockReset().mockResolvedValue(true);
        vi.mocked(isUserBlocked).mockReset().mockResolvedValue(false);
    });
    const refusal = (status: number) => Object.assign(new Error('refused'), { status });

    it('reports the line, then blocks', async () => {
        await expect(reportRequestAndBlock('c1', LINE, 'bo', 'Harassment')).resolves.toBe('reported');
        expect(reportDmLine).toHaveBeenCalledWith('c1', 'l1', 'Buy my crypto', 'Harassment');
        expect(blockUser).toHaveBeenCalledWith('bo');
    });

    it('with no line left, blocks with no report', async () => {
        await expect(reportRequestAndBlock('c1', null, 'bo', 'Harassment')).resolves.toBe('no_line');
        expect(reportDmLine).not.toHaveBeenCalled();
        expect(blockUser).toHaveBeenCalledWith('bo');
    });

    it('a refusal by the node never costs the block: what this phone still holds may be a line the node has no more', async () => {
        for (const [status, outcome] of [[404, 'refused'], [400, 'refused'], [429, 'over_limit']] as const) {
            vi.mocked(blockUser).mockClear();
            vi.mocked(reportDmLine).mockRejectedValueOnce(refusal(status));
            await expect(reportRequestAndBlock('c1', LINE, 'bo', 'Harassment')).resolves.toBe(outcome);
            expect(blockUser).toHaveBeenCalledWith('bo');
        }
    });

    it('no answer from the node blocks nobody: the sheet stays for a second try', async () => {
        vi.mocked(reportDmLine).mockRejectedValueOnce(new Error('Network request failed'));
        await expect(reportRequestAndBlock('c1', LINE, 'bo', 'Harassment')).rejects.toThrow('Network request failed');
        expect(blockUser).not.toHaveBeenCalled();
    });

    it('a block that did not happen says "Reported" only when the report went', async () => {
        vi.mocked(blockUser).mockResolvedValue(false);
        await expect(reportRequestAndBlock('c1', LINE, 'bo', 'Harassment')).rejects.toBeInstanceOf(ReportedNotBlockedError);
        await expect(reportRequestAndBlock('c1', null, 'bo', 'Harassment')).rejects.not.toBeInstanceOf(ReportedNotBlockedError);
        vi.mocked(reportDmLine).mockRejectedValueOnce(refusal(429));
        await expect(reportRequestAndBlock('c1', LINE, 'bo', 'Harassment')).rejects.not.toBeInstanceOf(ReportedNotBlockedError);
    });
});

describe('wordsOfLine', () => {
    it('is what it reads as here, and never the words standing in for a line that did not open', () => {
        expect(wordsOfLine({ text: 'Hello' })).toBe('Hello');
        expect(wordsOfLine({ text: 'This message could not be verified', unattributed: true })).toBe('');
        expect(wordsOfLine({ text: null })).toBe('');
    });
});
