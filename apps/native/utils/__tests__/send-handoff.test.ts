/**
 * utils/send-handoff.ts: Send handed over in memory by a tap in the app (Learn's Thank, K8 round 2), taken once, within a
 * minute; and what it opens: the member list's name for the key, or nothing (review of #3243).
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { SEND_REQUEST_MS, handOverSend, sendPrefill, takeSendRequest } from '../send-handoff';

const ADA = 'ada'.padEnd(64, '0');
const ME = 'me'.padEnd(64, '0');
const T0 = 1_800_000_000_000;

beforeEach(() => { takeSendRequest(); });

describe('the hand-over', () => {
    it('is taken once: the second read finds nothing', () => {
        handOverSend({ to: ADA, note: 'Thanks' }, T0);
        expect(takeSendRequest(T0 + 10)).toEqual({ to: ADA, note: 'Thanks' });
        expect(takeSendRequest(T0 + 20)).toBeNull();
    });

    it.each([
        ['taken at once', 0, true],
        ['taken at the minute', SEND_REQUEST_MS, true],
        ['taken just after the minute', SEND_REQUEST_MS + 1, false],
        ['a clock that went back', -1, false],
    ] as const)('%s -> %s', (_, after, kept) => {
        handOverSend({ to: ADA, note: 'n' }, T0);
        expect(takeSendRequest(T0 + after) !== null).toBe(kept);
        // Gone either way: a stale request isn't left for a later visit.
        expect(takeSendRequest(T0 + after)).toBeNull();
    });

    it('a newer tap replaces an older one', () => {
        handOverSend({ to: ADA, note: 'first' }, T0);
        handOverSend({ to: ME, note: 'second' }, T0 + 1);
        expect(takeSendRequest(T0 + 2)).toEqual({ to: ME, note: 'second' });
    });
});

describe('what a request opens (sendPrefill)', () => {
    const LIST = [{ publicKey: ADA, callsign: 'Ada' }, { publicKey: ME, callsign: 'Me' }];
    it.each([
        ['a member the list holds', { to: ADA, note: 'n' }, { to: ADA, name: 'Ada', note: 'n' }],
        ['a key the list does not hold', { to: 'f'.repeat(64), note: 'n' }, null],
        ['the member themselves', { to: ME, note: 'n' }, null],
        ['no key', { to: '', note: 'n' }, null],
        ['no request', null, null],
    ] as const)('%s -> %j', (_, request, opens) => {
        expect(sendPrefill(request, LIST, ME)).toEqual(opens);
    });
});
