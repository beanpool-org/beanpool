import { describe, it, expect } from 'vitest';
import { chatMovedAt, chatTimeMs, movedAtWithSend, newestChatsFirst, sentHere, sentHereSettled } from '../chat-list-order';

const at = (hhmm: string) => Date.parse(`2026-11-16T${hhmm}:00Z`);

describe('chat list order (16 Nov 2026): newest line first, the sender included', () => {
    it('reads a server ISO time and a device store milliseconds alike; none, or nonsense, is 0', () => {
        expect(chatTimeMs('2026-11-16T09:00:00Z')).toBe(at('09:00'));
        expect(chatTimeMs(at('09:00'))).toBe(at('09:00'));
        for (const none of [null, undefined, '', 'not a time', Number.NaN]) expect(chatTimeMs(none)).toBe(0);
    });

    it('a chat moves by its newest line, else by when it was made', () => {
        expect(chatMovedAt('2026-11-16T09:30:00Z', '2026-11-01T00:00:00Z')).toBe(at('09:30'));
        expect(chatMovedAt(null, '2026-11-16T08:00:00Z')).toBe(at('08:00'));
        expect(chatMovedAt(undefined, undefined)).toBe(0);
    });

    it('newest first; ties keep their place; the list given is never sorted itself', () => {
        const list = [{ id: 'old', t: at('08:00') }, { id: 'tieA', t: at('09:00') }, { id: 'new', t: at('10:00') }, { id: 'tieB', t: at('09:00') }];
        const copy = [...list];
        expect(newestChatsFirst(list, (c) => c.t).map((c) => c.id)).toEqual(['new', 'tieA', 'tieB', 'old']);
        expect(list).toEqual(copy);
    });

    it('a line sent here takes the top at once, even on a clock behind the community', () => {
        const listed = [at('10:00'), at('09:00'), at('08:00')];
        // The clock reads 09:30 although a chat's line came at 10:00: the send still goes above it.
        const sent = sentHere(at('08:00'), listed, at('09:30'), 1);
        expect(sent.at).toBeGreaterThan(at('10:00'));
        expect(movedAtWithSend(at('08:00'), sent)).toBe(sent.at);
        // A clock ahead: the send's own time.
        expect(sentHere(at('08:00'), listed, at('11:00'), 1).at).toBe(at('11:00'));
        // No send: the list's own time.
        expect(movedAtWithSend(at('08:00'), undefined)).toBe(at('08:00'));
    });

    it('a send counts until a list asked for after it shows a newer line in the chat', () => {
        const sent = sentHere(at('08:00'), [at('10:00')], at('10:05'), 3);
        // Asked for before the send (mark 3 or less), even showing a newer line: not settled.
        expect(sentHereSettled(sent, at('10:05'), 3)).toBe(false);
        // Asked for after, still without the line (it hadn't got there yet): not settled.
        expect(sentHereSettled(sent, at('08:00'), 4)).toBe(false);
        // Asked for after, with the line: settled; the list's time counts from here.
        expect(sentHereSettled(sent, at('10:05'), 4)).toBe(true);
    });
});
