/**
 * The "Message requests" row's count and red dot (dm-requests.ts requestsRowCount, requestsUnseen, requestsSeenNext;
 * Marty, 19 Nov 2026): the count is every kind waiting behind the row, and the dot goes once the list has been opened
 * since the newest arrived, kind by kind, each against its own clock.
 */
import { describe, it, expect } from 'vitest';
import {
    requestsRowCount, requestsNewest, requestsUnseen, requestsSeenNext, parseRequestsSeen, requestsPillText,
    type RequestsWaiting,
} from '../dm-requests.js';

const req = (at: string) => ({ request: { at } });
const none: RequestsWaiting = { here: null, onGlobal: 0, outside: [], guestInvites: [] };

describe('the Message requests row', () => {
    it('counts every kind waiting behind it: the node total (more than it lists), global, outside and guest invitations', () => {
        expect(requestsRowCount(none)).toBe(0);
        const w: RequestsWaiting = {
            here: { count: 120, conversations: [req('2026-11-19T10:00:00Z')] },
            onGlobal: 2,
            outside: [{ lastAt: 5, updatedAt: 5 }],
            guestInvites: [{ updatedAt: 7 }, { updatedAt: 8 }],
        };
        expect(requestsRowCount(w)).toBe(125);
        expect(requestsRowCount({ ...none, here: { count: -3, conversations: [] }, onGlobal: Number.NaN })).toBe(0);
    });

    it('has no dot with nothing waiting, and a dot for anything waiting before the list was ever opened here', () => {
        expect(requestsUnseen(none, null)).toBe(false);
        expect(requestsUnseen({ ...none, onGlobal: 1 }, null)).toBe(true);
        expect(requestsUnseen({ ...none, here: { count: 1, conversations: [req('2026-11-19T10:00:00Z')] } }, null)).toBe(true);
    });

    it('loses the dot once the list is opened, and gets it back for a newer request of any kind', () => {
        const w: RequestsWaiting = { here: { count: 1, conversations: [req('2026-11-19T10:00:00Z')] }, onGlobal: 1, outside: [{ lastAt: 100, updatedAt: 90 }], guestInvites: [{ updatedAt: 50 }] };
        const seen = requestsSeenNext(w, null, true)!;
        expect(seen).toEqual(requestsNewest(w));
        expect(requestsUnseen(w, seen)).toBe(false);
        // Opening again with nothing new writes nothing.
        expect(requestsSeenNext(w, seen, true)).toBeNull();
        // A newer request here (the node's clock), a newer outside line, a newer invitation, one more on global: each shows.
        expect(requestsUnseen({ ...w, here: { count: 2, conversations: [req('2026-11-19T11:00:00Z'), req('2026-11-19T10:00:00Z')] } }, seen)).toBe(true);
        expect(requestsUnseen({ ...w, outside: [...w.outside, { lastAt: 101, updatedAt: 101 }] }, seen)).toBe(true);
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
