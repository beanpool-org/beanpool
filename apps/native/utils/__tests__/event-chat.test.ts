import { describe, it, expect } from 'vitest';
import {
    decodeEventChatText, trimEventChatDraft, canOpenEventChat, eventChatEntryLabel,
    eventChatReadOnlyReason, EVENT_CHAT_MESSAGE_MAX, EVENT_CHAT_NOTICE, EVENT_CHAT_REMOVED_TEXT,
} from '../events';

// The phone's event-chat logic (docs/events-on-the-map.md §2.2, §3, slice 4). The screen needs a device;
// what it decides — who is offered the chat, what a message says, when the composer goes — does not.

const b64 = (s: string) => Buffer.from(s, 'utf8').toString('base64');
const HOUR = 60 * 60 * 1000;

describe('event chat: message text', () => {
    it('reads the node-readable plaintext-v1 a message is stored as', () => {
        expect(decodeEventChatText(b64('Bringing a thermos'), 'text')).toBe('Bringing a thermos');
        expect(decodeEventChatText(b64('Bring gloves — and a hat'), 'text')).toBe('Bring gloves — and a hat');
        expect(decodeEventChatText(b64('see you 🎉'), 'text')).toBe('see you 🎉');
    });

    it('shows a removed message as removed, whatever the row still holds', () => {
        expect(decodeEventChatText(b64('the original text'), 'removed')).toBe(EVENT_CHAT_REMOVED_TEXT);
        expect(EVENT_CHAT_REMOVED_TEXT).toBe('removed by the host');
    });

    it('never throws on something it cannot decode', () => {
        expect(() => decodeEventChatText('!!!not base64!!!', 'text')).not.toThrow();
        expect(typeof decodeEventChatText('!!!not base64!!!', 'text')).toBe('string');
        expect(decodeEventChatText('', 'text')).toBe('');
    });

    it('decodes a padded message without a stray character on the end', () => {
        for (const text of ['a', 'ab', 'abc', 'abcd', 'Bring gloves']) {
            expect(decodeEventChatText(b64(text), 'text')).toBe(text);
        }
    });

    it('trims the draft and holds it to the 2000 characters the node accepts', () => {
        expect(trimEventChatDraft('  See you there  ')).toBe('See you there');
        expect(trimEventChatDraft('x'.repeat(2500)).length).toBe(EVENT_CHAT_MESSAGE_MAX);
        expect(EVENT_CHAT_MESSAGE_MAX).toBe(2000);
    });
});

describe('event chat: who is offered it', () => {
    const event = { id: 'ev-1', type: 'event', goingCount: 7, interestedCount: 3 };

    it('offers it to someone marked Going', () => {
        expect(canOpenEventChat({ ...event, myRsvp: 'going' })).toBe(true);
    });

    it('offers it to a host, whose RSVP list only a host is sent', () => {
        expect(canOpenEventChat({ ...event, myRsvp: null, eventRsvps: [] })).toBe(true);
    });

    it('does not offer it to Interested, to no RSVP, or for a post that is not an event', () => {
        expect(canOpenEventChat({ ...event, myRsvp: 'interested' })).toBe(false);
        expect(canOpenEventChat({ ...event, myRsvp: null })).toBe(false);
        expect(canOpenEventChat({ ...event, type: 'offer', myRsvp: 'going' })).toBe(false);
        expect(canOpenEventChat(null)).toBe(false);
    });

    it('labels the entry with the going count when there is one', () => {
        expect(eventChatEntryLabel({ ...event, goingCount: 7 })).toBe('Open event chat (7)');
        expect(eventChatEntryLabel({ ...event, event_going_count: 0, goingCount: undefined })).toBe('Open event chat (0)');
        expect(eventChatEntryLabel({ id: 'ev-1' })).toBe('Open event chat');
    });
});

describe('event chat: when it is read-only', () => {
    const start = new Date(Date.now() + 2 * HOUR).toISOString();
    const open = { type: 'event', status: 'active', eventStartAt: start, eventEndAt: new Date(Date.now() + 4 * HOUR).toISOString(), eventState: 'scheduled' };

    it('stays open while the event is still to come', () => {
        expect(eventChatReadOnlyReason(open)).toBeNull();
    });

    it('closes when the event has ended', () => {
        const ended = { ...open, eventStartAt: new Date(Date.now() - 4 * HOUR).toISOString(), eventEndAt: new Date(Date.now() - HOUR).toISOString() };
        expect(eventChatReadOnlyReason(ended)).toBe('This event has ended. The chat is read-only.');
    });

    it('closes when the event was cancelled, and says which', () => {
        expect(eventChatReadOnlyReason({ ...open, eventState: 'cancelled' }))
            .toBe('This event was cancelled. The chat is read-only.');
        // Cancelled wins over ended: it is the more useful thing to be told.
        const both = { ...open, eventState: 'cancelled', eventEndAt: new Date(Date.now() - HOUR).toISOString() };
        expect(eventChatReadOnlyReason(both)).toBe('This event was cancelled. The chat is read-only.');
    });
});

describe('event chat: the notice', () => {
    it('says in one line that the node can read this chat (decision 25)', () => {
        expect(EVENT_CHAT_NOTICE).toBe("Visible to the host, everyone going, and this node's operator.");
    });
});
