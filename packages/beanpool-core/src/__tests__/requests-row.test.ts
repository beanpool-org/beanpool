/**
 * The "Message requests" row's count and red dot (dm-requests.ts requestsRowCount, requestsUnseen, requestsSeenNext;
 * Marty, 19 Nov 2026): the count is every kind waiting behind the row, and the dot goes once the list has been opened
 * since the newest arrived, kind by kind, each against its own clock.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import {
    requestsRowCount, requestsNewest, requestsUnseen, requestsSeenNext, parseRequestsSeen, requestsPillText,
    type RequestsSeen, type RequestsWaiting,
} from '../dm-requests.js';

const req = (at: string) => ({ request: { at } });
const none: RequestsWaiting = { here: null, onGlobal: 0, outside: [], guestInvites: [] };

describe('the Message requests row', () => {
    it('counts every kind waiting behind it: the node total (more than it lists), global, outside and guest invitations', () => {
        expect(requestsRowCount(none)).toBe(0);
        const w: RequestsWaiting = {
            here: { count: 120, conversations: [req('2026-11-19T10:00:00Z')] },
            onGlobal: 2,
            outside: [{ updatedAt: 5 }],
            guestInvites: [{ updatedAt: 7 }, { updatedAt: 8 }],
        };
        expect(requestsRowCount(w)).toBe(125);
        expect(requestsRowCount({ ...none, here: { count: -3, conversations: [] }, onGlobal: Number.NaN })).toBe(0);
        // Global not known yet (not asked, or no answer with nothing heard before): none counted from there.
        expect(requestsRowCount({ ...w, onGlobal: null })).toBe(123);
        expect(requestsRowCount({ ...w, onGlobal: undefined })).toBe(123);
    });

    it('has no dot with nothing waiting, and a dot for anything waiting before the list was ever opened here', () => {
        expect(requestsUnseen(none, null)).toBe(false);
        expect(requestsUnseen({ ...none, onGlobal: 1 }, null)).toBe(true);
        expect(requestsUnseen({ ...none, here: { count: 1, conversations: [req('2026-11-19T10:00:00Z')] } }, null)).toBe(true);
    });

    it('loses the dot once the list is opened, and gets it back for a newer request of any kind', () => {
        const w: RequestsWaiting = { here: { count: 1, conversations: [req('2026-11-19T10:00:00Z')] }, onGlobal: 1, outside: [{ updatedAt: 90 }], guestInvites: [{ updatedAt: 50 }] };
        const seen = requestsSeenNext(w, null, true)!;
        expect(seen).toEqual(requestsNewest(w));
        expect(requestsUnseen(w, seen)).toBe(false);
        // Opening again with nothing new writes nothing.
        expect(requestsSeenNext(w, seen, true)).toBeNull();
        // A newer request here (the node's clock), a newer outside line, a newer invitation, one more on global: each shows.
        expect(requestsUnseen({ ...w, here: { count: 2, conversations: [req('2026-11-19T11:00:00Z'), req('2026-11-19T10:00:00Z')] } }, seen)).toBe(true);
        expect(requestsUnseen({ ...w, outside: [...w.outside, { updatedAt: 91 }] }, seen)).toBe(true);
        expect(requestsUnseen({ ...w, guestInvites: [{ updatedAt: 51 }] }, seen)).toBe(true);
        expect(requestsUnseen({ ...w, onGlobal: 2 }, seen)).toBe(true);
        // One answered (fewer waiting, nothing newer): no dot.
        expect(requestsUnseen({ ...w, outside: [] }, seen)).toBe(false);
    });

    it('never moves a time back when opened, and the global count follows a fall even unopened', () => {
        const seen = { here: Date.parse('2026-11-19T12:00:00Z'), outside: 100, guest: 50, global: 3 };
        const fewer: RequestsWaiting = { here: { count: 1, conversations: [req('2026-11-19T10:00:00Z')] }, onGlobal: 1, outside: [], guestInvites: [] };
        expect(requestsSeenNext(fewer, seen, true)).toEqual({ ...seen, global: 1 });
        // Answered on global itself (3 → 1): the mark follows, so the next one there (→ 2) shows the dot.
        const followed = requestsSeenNext(fewer, seen, false)!;
        expect(followed.global).toBe(1);
        expect(requestsUnseen({ ...fewer, onGlobal: 2 }, followed)).toBe(true);
        expect(requestsSeenNext({ ...fewer, onGlobal: 3 }, seen, false)).toBeNull();
    });

    it('reads a kept mark, and none from anything else', () => {
        expect(parseRequestsSeen(JSON.stringify({ here: 1, outside: 2, guest: 3, global: 4 }))).toEqual({ here: 1, outside: 2, guest: 3, global: 4 });
        for (const raw of [null, undefined, '', 'nope', '[]', '{"here":1}', JSON.stringify({ here: -1, outside: 0, guest: 0, global: 0 })]) {
            expect(parseRequestsSeen(raw)).toBeNull();
        }
    });

    it('shows 99+ past 99', () => {
        expect(requestsPillText(2)).toBe('2');
        expect(requestsPillText(99)).toBe('99');
        expect(requestsPillText(100)).toBe('99+');
    });
});

/**
 * The rule for every kind the mark keeps (RequestsSeen: here, global, outside, guest invitations), against each way it was
 * found broken or could be (PR #3298 review): a read not made yet or failed, a late arrival, a clock that is out, a real
 * fall, and an opened list. A new request always lights the dot; a seen one never does on a reload.
 */
describe('a new request always lights the dot; a seen one never does on a reload', () => {
    afterEach(() => { vi.useRealTimers(); });

    const T = Date.parse('2026-11-19T10:00:00Z');
    const MIN = 60_000;
    const DAY = 24 * 60 * MIN;
    const W = (p: Partial<RequestsWaiting>): RequestsWaiting => ({ here: null, onGlobal: null, outside: [], guestInvites: [], ...p });
    /** The node's requests, each by the node's own time (`request.at`: when the node took it). */
    const here = (...ats: number[]) => W({ here: { count: ats.length, conversations: ats.map((a) => ({ request: { at: new Date(a).toISOString() } })) } });
    const global = (n: number | null | undefined) => W({ onGlobal: n });
    /** An outside request as the device keeps it: `lastAt` its sender's signed time, `updatedAt` this device's when written here. */
    const line = (sender: number, written: number) => ({ id: `o-${written}`, state: 'request', lastAt: sender, updatedAt: written });
    const outside = (...ls: Array<ReturnType<typeof line>>) => W({ outside: ls });
    /** An invitation as the device keeps it: `updatedAt` this device's when written here (the host's clock never enters). */
    const invite = (written: number) => ({ id: `g-${written}`, state: 'invited', updatedAt: written });
    const guest = (...is: Array<ReturnType<typeof invite>>) => W({ guestInvites: is });

    // One render, as both apps' hooks do it (apps/native/utils/requests-seen.ts, apps/pwa/src/lib/requests-seen.ts): the mark
    // moves to what requestsSeenNext gives, when it gives one, and the dot is read against the mark as it then is. A reload
    // is the next step: the kept mark read again, whatever the device holds before its reads come back.
    type Step = [waiting: RequestsWaiting, opened: boolean, dot: boolean];
    const OPEN = true;
    const SHUT = false;
    const A = line(T + 60 * MIN, T + 65 * MIN);   // written 11:00 by its sender, here 11:05
    const B = line(T, T + 120 * MIN);             // written 10:00 by a sender offline, held, here at 12:00

    const rows: Array<[kind: string, what: string, steps: Step[]]> = [
        ['here', 'opened, then reloads', [[here(T), SHUT, true], [here(T), OPEN, false], [here(T), SHUT, false], [here(T), SHUT, false]]],
        ['here', 'a reload before the list is read, or with its read failed', [
            [here(T), OPEN, false], [W({ here: undefined, onGlobal: 0 }), SHUT, false], [W({ here: null, guestInvites: [invite(T - DAY)] }), OPEN, false],
            [here(T), SHUT, false], [here(T + MIN, T), SHUT, true]]],
        ['here', 'a request the node takes after the list was opened: its time is the node\'s, whatever the sender\'s', [
            [here(T), OPEN, false], [here(T + 1, T), SHUT, true]]],
        ['here', 'a real fall (one answered), then a new one', [
            [here(T, T - MIN), OPEN, false], [here(T - MIN), SHUT, false], [here(T - MIN), SHUT, false], [here(T + MIN, T - MIN), SHUT, true]]],

        ['global', 'opened, then reloads', [[global(2), SHUT, true], [global(2), OPEN, false], [global(2), SHUT, false], [global(2), SHUT, false]]],
        ['global', 'a reload before global answers (null or undefined), then the same count', [
            [global(2), OPEN, false], [global(null), SHUT, false], [global(2), SHUT, false], [global(undefined), SHUT, false], [global(2), SHUT, false]]],
        ['global', 'an ask that failed with nothing heard (not known), while the list shows too', [
            [global(2), OPEN, false], [global(null), OPEN, false], [global(2), SHUT, false]]],
        ['global', 'one more there: no time to be late or out, only the count', [[global(2), OPEN, false], [global(3), SHUT, true]]],
        ['global', 'a real fall (answered on global) is followed, so the next one there shows', [
            [global(3), OPEN, false], [global(1), SHUT, false], [global(null), SHUT, false], [global(1), SHUT, false], [global(2), SHUT, true]]],

        ['outside', 'opened, then reloads', [[outside(A), SHUT, true], [outside(A), OPEN, false], [outside(A), SHUT, false], [outside(A), SHUT, false]]],
        ['outside', 'a reload before this device\'s list is read', [[outside(A), OPEN, false], [W({}), SHUT, false], [outside(A), SHUT, false]]],
        ['outside', 'a late delivery (its sender\'s time older than the mark, written here after it)', [[outside(A), OPEN, false], [outside(A, B), SHUT, true]]],
        ['outside', 'a sender whose clock is a day ahead does not hide the next ones', [
            [outside(line(T + DAY, T)), OPEN, false], [outside(line(T + DAY, T), line(T + MIN, T + 5 * MIN)), SHUT, true]]],
        ['outside', 'a sender whose clock is a day behind still shows', [[outside(A), OPEN, false], [outside(A, line(T - DAY, T + 70 * MIN)), SHUT, true]]],
        ['outside', 'a real fall (one answered), then a new one', [
            [outside(A, B), OPEN, false], [outside(A), SHUT, false], [outside(A, line(T, T + 200 * MIN)), SHUT, true]]],

        ['guest', 'opened, then reloads', [[guest(invite(T)), SHUT, true], [guest(invite(T)), OPEN, false], [guest(invite(T)), SHUT, false]]],
        ['guest', 'a reload before this device\'s list is read', [[guest(invite(T)), OPEN, false], [W({}), SHUT, false], [guest(invite(T)), SHUT, false]]],
        ['guest', 'an invitation held at the member\'s server, written here after the list was opened', [
            [guest(invite(T)), OPEN, false], [guest(invite(T), invite(T + DAY)), SHUT, true]]],
        ['guest', 'a real fall (one declined), then a new one', [
            [guest(invite(T), invite(T + MIN)), OPEN, false], [guest(invite(T)), SHUT, false], [guest(invite(T), invite(T + 2 * MIN)), SHUT, true]]],
    ];

    // This device's own clock never enters: the same steps give the same dots with it a day out either way.
    for (const [kind, what, steps] of rows) {
        for (const off of [0, DAY, -DAY]) {
            it(`${kind}: ${what} (this device's clock ${off === 0 ? 'right' : off > 0 ? 'a day ahead' : 'a day behind'})`, () => {
                vi.useFakeTimers();
                vi.setSystemTime(T + off);
                let mark: RequestsSeen | null = null;
                const dots = steps.map(([w, opened]) => {
                    mark = requestsSeenNext(w, mark, opened) ?? mark;
                    return requestsUnseen(w, mark);
                });
                expect(dots).toEqual(steps.map(([, , dot]) => dot));
            });
        }
    }

    it('the reviewer\'s two cases, as found', () => {
        // 1. Seen 2 waiting on global; the next start reads the mark before global answers; global then says 2: no dot.
        const seen = requestsSeenNext(global(2), null, OPEN)!;
        expect(requestsSeenNext(global(null), seen, SHUT)).toBeNull();
        expect(requestsUnseen(global(2), seen)).toBe(false);
        // 2. A opened at 11:10; B, written 10:00 and delivered 12:00, lights the dot.
        const mark = requestsSeenNext(outside(A), null, OPEN)!;
        expect(mark.outside).toBe(A.updatedAt);
        expect(requestsUnseen(outside(A, B), mark)).toBe(true);
    });

    it('global gives a count alone: one answered there and one new between two reads leave it the same, so no dot (no times to tell)', () => {
        const seen = requestsSeenNext(global(2), null, OPEN)!;
        expect(requestsUnseen(global(2), seen)).toBe(false);
    });
});
