/**
 * The one chat experience's rules (chat parity, 2026-09-23).
 *
 * Every screen asks utils/chat-actions what a bubble says and what tapping it offers, so this is where the
 * DM screen and the group chat are held to the same answers. Before this, each screen carried its own copy
 * of the rules and they drifted — which is the whole reason for the feature.
 */

import { describe, it, expect } from 'vitest';
import {
    MESSAGE_EDIT_WINDOW_MS, DELETED_BY_AUTHOR_TEXT, REMOVED_BY_CONVENOR_TEXT, NOT_AVAILABLE_YET,
    buildChatListItems, canDeleteMessage, canEditMessage, canReactToMessage, canRemoveMessage,
    canReplyToMessage, chatActionErrorMessage, formatDayLabel, hasAnyAction, isAtBottom, isDaySeparator,
    isSystemLine, isTombstone, messageActions, normaliseThreadMessage, pendingAfterRead, reactionSummary,
    shouldFollowNewMessages, showsAuthorName, threadMessageDisplayText, tombstoneText,
    type ChatMessage, type ChatViewer,
} from '../chat-actions';

const ME = 'me-pubkey';
const THEM = 'them-pubkey';
const NOW = Date.parse('2026-09-23T12:00:00.000Z');

function msg(over: Partial<ChatMessage> = {}): ChatMessage {
    return {
        id: 'm1',
        senderId: ME,
        text: 'hello',
        type: 'text',
        rawTimestamp: new Date(NOW - 60_000).toISOString(),
        timestamp: '12:59',
        ...over,
    };
}

function viewer(over: Partial<ChatViewer> = {}): ChatViewer {
    return { kind: 'dm', myPubkey: ME, canPost: true, now: NOW, ...over };
}

describe('who may edit a message', () => {
    it('lets the author edit their own text inside the window, in a DM and in a group chat', () => {
        expect(canEditMessage(msg(), viewer())).toBe(true);
        expect(canEditMessage(msg(), viewer({ kind: 'group' }))).toBe(true);
    });

    it('refuses once the 15-minute window has passed', () => {
        const old = msg({ rawTimestamp: new Date(NOW - MESSAGE_EDIT_WINDOW_MS - 1000).toISOString() });
        expect(canEditMessage(old, viewer())).toBe(false);
        // The boundary itself is still inside the window.
        const exactly = msg({ rawTimestamp: new Date(NOW - MESSAGE_EDIT_WINDOW_MS).toISOString() });
        expect(canEditMessage(exactly, viewer())).toBe(true);
    });

    it('refuses somebody else\'s message, a photo, a system line and a tombstone', () => {
        expect(canEditMessage(msg({ senderId: THEM }), viewer())).toBe(false);
        expect(canEditMessage(msg({ type: 'image' }), viewer())).toBe(false);
        expect(canEditMessage(msg({ systemType: 'ESCROW_FUNDED' }), viewer())).toBe(false);
        expect(canEditMessage(msg({ type: 'removed', metadata: { removed: true, removedBy: ME } }), viewer())).toBe(false);
    });

    it('refuses a message still sending or failed: the node does not know its id yet', () => {
        expect(canEditMessage(msg({ sendState: 'sending' }), viewer())).toBe(false);
        expect(canEditMessage(msg({ sendState: 'failed' }), viewer())).toBe(false);
    });

    it('refuses in an enterprise thread and an event chat, which the node refuses this round', () => {
        expect(canEditMessage(msg(), viewer({ kind: 'enterprise' }))).toBe(false);
        expect(canEditMessage(msg(), viewer({ kind: 'event' }))).toBe(false);
    });

    it('refuses once the member can no longer post there (removed, left, observer, read-only)', () => {
        expect(canEditMessage(msg(), viewer({ kind: 'group', canPost: false }))).toBe(false);
    });
});

describe('who may delete a message for everyone', () => {
    it('lets the author delete their own at any time — no window', () => {
        const ancient = msg({ rawTimestamp: new Date(NOW - 400 * 24 * 3600_000).toISOString() });
        expect(canDeleteMessage(ancient, viewer())).toBe(true);
        expect(canDeleteMessage(ancient, viewer({ kind: 'group' }))).toBe(true);
    });

    it('refuses somebody else\'s message, a system line, an already-deleted one and an in-flight send', () => {
        expect(canDeleteMessage(msg({ senderId: THEM }), viewer())).toBe(false);
        expect(canDeleteMessage(msg({ type: 'system' }), viewer())).toBe(false);
        expect(canDeleteMessage(msg({ metadata: { removed: true } }), viewer())).toBe(false);
        expect(canDeleteMessage(msg({ sendState: 'sending' }), viewer())).toBe(false);
    });

    it('refuses in an enterprise thread and an event chat', () => {
        expect(canDeleteMessage(msg(), viewer({ kind: 'enterprise' }))).toBe(false);
        expect(canDeleteMessage(msg(), viewer({ kind: 'event' }))).toBe(false);
    });

    it('lets the author delete a photo, which they cannot edit', () => {
        expect(canDeleteMessage(msg({ type: 'image' }), viewer())).toBe(true);
        expect(canEditMessage(msg({ type: 'image' }), viewer())).toBe(false);
    });
});

describe('who may remove somebody else\'s message', () => {
    const convenor = viewer({ kind: 'group', isModerator: true });

    it('lets a convenor remove another member\'s message', () => {
        expect(canRemoveMessage(msg({ senderId: THEM }), convenor)).toBe(true);
    });

    it('offers a convenor Delete, not Remove, on their own message', () => {
        const mine = msg({ senderId: ME });
        expect(canRemoveMessage(mine, convenor)).toBe(false);
        expect(canDeleteMessage(mine, convenor)).toBe(true);
    });

    it('keeps an event host\'s power over every message, their own included — they have no delete there', () => {
        const host = viewer({ kind: 'event', isModerator: true });
        expect(canRemoveMessage(msg({ senderId: THEM }), host)).toBe(true);
        expect(canRemoveMessage(msg({ senderId: ME }), host)).toBe(true);
        expect(canDeleteMessage(msg({ senderId: ME }), host)).toBe(false);
    });

    it('refuses an ordinary member, a system line, a tombstone, and every DM', () => {
        expect(canRemoveMessage(msg({ senderId: THEM }), viewer({ kind: 'group' }))).toBe(false);
        expect(canRemoveMessage(msg({ senderId: THEM, type: 'system' }), convenor)).toBe(false);
        expect(canRemoveMessage(msg({ senderId: THEM, type: 'removed' }), convenor)).toBe(false);
        expect(canRemoveMessage(msg({ senderId: THEM }), viewer({ isModerator: true }))).toBe(false);
    });
});

describe('who may react and reply', () => {
    it('lets anyone who may post react, on their own message and on someone else\'s', () => {
        expect(canReactToMessage(msg(), viewer({ kind: 'group' }))).toBe(true);
        expect(canReactToMessage(msg({ senderId: THEM }), viewer({ kind: 'group' }))).toBe(true);
    });

    it('refuses an observer, a read-only chat, a system line, a tombstone and an in-flight send', () => {
        expect(canReactToMessage(msg(), viewer({ kind: 'group', canPost: false }))).toBe(false);
        expect(canReactToMessage(msg({ type: 'system' }), viewer())).toBe(false);
        expect(canReactToMessage(msg({ type: 'removed' }), viewer())).toBe(false);
        expect(canReactToMessage(msg({ sendState: 'sending' }), viewer())).toBe(false);
    });

    it('refuses in an enterprise thread and an event chat', () => {
        expect(canReactToMessage(msg(), viewer({ kind: 'enterprise' }))).toBe(false);
        expect(canReplyToMessage(msg(), viewer({ kind: 'event' }))).toBe(false);
    });

    it('will not quote a failed send, whose id the node has never seen', () => {
        expect(canReplyToMessage(msg({ sendState: 'failed' }), viewer())).toBe(false);
        expect(canReplyToMessage(msg({ sendState: 'sending' }), viewer())).toBe(true);
    });
});

describe('the whole action bar', () => {
    it('gives a group convenor Reply, React and Remove on a member\'s message, and nothing else', () => {
        const a = messageActions(msg({ senderId: THEM }), viewer({ kind: 'group', isModerator: true }));
        expect(a).toEqual({ reply: true, react: true, edit: false, delete: false, remove: true });
    });

    it('gives an enterprise thread nothing at all', () => {
        const a = messageActions(msg(), viewer({ kind: 'enterprise' }));
        expect(hasAnyAction(a)).toBe(false);
    });

    it('gives a tombstone nothing at all, for anyone', () => {
        const dead = msg({ type: 'removed', metadata: { removed: true, removedBy: ME } });
        expect(hasAnyAction(messageActions(dead, viewer({ kind: 'group', isModerator: true })))).toBe(false);
    });
});

describe('what a deleted message says', () => {
    it('reads as the author\'s own delete when removedBy is the author', () => {
        expect(tombstoneText({ senderId: ME, metadata: { removed: true, removedBy: ME } })).toBe(DELETED_BY_AUTHOR_TEXT);
    });

    it('reads as a convenor\'s removal when anybody else did it', () => {
        expect(tombstoneText({ senderId: ME, metadata: { removed: true, removedBy: 'convenor-key' } })).toBe(REMOVED_BY_CONVENOR_TEXT);
    });

    it('is a tombstone by type or by metadata, whichever the node sent', () => {
        expect(isTombstone({ type: 'removed' })).toBe(true);
        expect(isTombstone({ type: 'text', metadata: { removed: true } })).toBe(true);
        expect(isTombstone({ type: 'text', metadata: { reactions: [] } })).toBe(false);
    });

    it('ignores the node\'s own marker text, which cannot tell the two apart', () => {
        const base64 = (t: string) => Buffer.from(t, 'utf8').toString('base64');
        const decode = (c: string, type: string) => (type === 'removed' ? 'removed by the host' : Buffer.from(c, 'base64').toString('utf8'));
        const words = threadMessageDisplayText(
            { type: 'removed', authorPubkey: ME, ciphertext: base64('removed by a convenor'), metadata: { removed: true, removedBy: ME } },
            decode,
        );
        expect(words).toBe(DELETED_BY_AUTHOR_TEXT);
    });
});

describe('system lines', () => {
    it('knows one by its type, its author or its systemType', () => {
        expect(isSystemLine({ type: 'system' })).toBe(true);
        expect(isSystemLine({ senderId: 'SYSTEM' })).toBe(true);
        expect(isSystemLine({ type: 'text', systemType: 'ESCROW_RELEASED' })).toBe(true);
        expect(isSystemLine({ type: 'text', systemType: null })).toBe(false);
    });
});

describe('day labels', () => {
    // Local dates, not UTC: the label is a calendar day where the member is standing, and a Z timestamp
    // lands on a different one in half the world.
    const now = new Date(2026, 8, 23, 12, 0, 0);
    it('says Today, Yesterday, then the date', () => {
        expect(formatDayLabel(new Date(2026, 8, 23, 1, 0, 0), now)).toBe('Today');
        expect(formatDayLabel(new Date(2026, 8, 22, 23, 0, 0), now)).toBe('Yesterday');
        expect(formatDayLabel(new Date(2026, 8, 1, 10, 0, 0), now)).toMatch(/Sep/);
    });

    it('is still Yesterday across a month boundary', () => {
        expect(formatDayLabel(new Date(2026, 7, 31, 20, 0, 0), new Date(2026, 8, 1, 9, 0, 0))).toBe('Yesterday');
    });
});

describe('the rows an inverted list draws', () => {
    const now = new Date('2026-09-23T12:00:00Z');
    const a = msg({ id: 'a', rawTimestamp: '2026-09-22T09:00:00Z' });
    const b = msg({ id: 'b', rawTimestamp: '2026-09-22T10:00:00Z' });
    const c = msg({ id: 'c', rawTimestamp: '2026-09-23T09:00:00Z' });

    it('puts one pill per calendar day and reverses the whole thread', () => {
        const items = buildChatListItems([a, b, c], now);
        expect(items.map(i => i.id)).toEqual(['c', 'day-' + new Date('2026-09-23T09:00:00Z').toDateString(), 'b', 'a', 'day-' + new Date('2026-09-22T09:00:00Z').toDateString()]);
        expect(items.filter(isDaySeparator)).toHaveLength(2);
    });

    it('keeps a message with an unreadable timestamp, without a pill for it', () => {
        const items = buildChatListItems([msg({ id: 'x', rawTimestamp: 'not-a-date' })], now);
        expect(items.map(i => i.id)).toEqual(['x']);
    });
});

describe('whose name shows above a bubble', () => {
    const v = { kind: 'group' as const, myPubkey: ME };
    it('never in a DM', () => {
        expect(showsAuthorName(msg({ senderId: THEM }), null, { kind: 'dm', myPubkey: ME })).toBe(false);
    });
    it('never on my own message', () => {
        expect(showsAuthorName(msg({ senderId: ME }), null, v)).toBe(false);
    });
    it('on the first of a run by someone else, not the rest', () => {
        const first = msg({ id: '1', senderId: THEM });
        const second = msg({ id: '2', senderId: THEM });
        expect(showsAuthorName(first, null, v)).toBe(true);
        expect(showsAuthorName(second, first, v)).toBe(false);
    });
    it('again after a system line interrupts the run', () => {
        const sys = msg({ id: 's', senderId: 'SYSTEM', type: 'system' });
        expect(showsAuthorName(msg({ senderId: THEM }), sys, v)).toBe(true);
    });
});

describe('reaction badges', () => {
    it('counts each emoji, keeps the order it was first used, and finds mine', () => {
        const s = reactionSummary({ reactions: [
            { emoji: '👍', author: THEM },
            { emoji: '❤️', author: 'c' },
            { emoji: '👍', author: ME },
        ] }, ME);
        expect(s.emojis).toEqual(['👍', '❤️']);
        expect(s.counts).toEqual({ '👍': 2, '❤️': 1 });
        expect(s.total).toBe(3);
        expect(s.mine).toBe('👍');
    });

    it('is empty for a message with no metadata, and ignores a malformed entry', () => {
        expect(reactionSummary(undefined).total).toBe(0);
        expect(reactionSummary({ reactions: [{ author: THEM }] }).total).toBe(0);
    });
});

describe('following the newest message', () => {
    it('always follows my own send, an image or a resend', () => {
        expect(shouldFollowNewMessages({ grew: true, isBackgroundPoll: false, atBottom: false })).toBe(true);
    });

    it('follows a message that arrives on the poll while the newest one is in view', () => {
        // This is Damo\'s report: the group chat never followed, so the keyboard hid the new message.
        expect(shouldFollowNewMessages({ grew: true, isBackgroundPoll: true, atBottom: true })).toBe(true);
    });

    it('does not yank someone who has scrolled up to read history', () => {
        expect(shouldFollowNewMessages({ grew: true, isBackgroundPoll: true, atBottom: false })).toBe(false);
    });

    it('does nothing when the thread did not grow (an edit, a reaction, a poll tick)', () => {
        expect(shouldFollowNewMessages({ grew: false, isBackgroundPoll: false, atBottom: true })).toBe(false);
    });

    it('counts a resting inverted list as being at the bottom', () => {
        expect(isAtBottom(0)).toBe(true);
        expect(isAtBottom(12)).toBe(true);
        expect(isAtBottom(900)).toBe(false);
    });
});

describe('what an older node\'s refusal reads as', () => {
    it('says so plainly when the route is not in the node\'s build at all', () => {
        // Koa's bare 404: plain text, no JSON `error` field, so nothing answered.
        expect(chatActionErrorMessage({ status: 404, message: 'Not Found', nodeAnswered: false }))
            .toBe(NOT_AVAILABLE_YET);
        expect(chatActionErrorMessage({ status: 404, message: 'Cannot POST /api/messages/delete' }))
            .toBe(NOT_AVAILABLE_YET);
        expect(chatActionErrorMessage({ status: 501, message: 'Not Implemented', nodeAnswered: true }))
            .toBe(NOT_AVAILABLE_YET);
    });

    it('says so plainly for the two refusals an old node words for itself', () => {
        // origin/main apps/server/src/engine/group-thread.ts:40-41.
        expect(chatActionErrorMessage({ status: 403, message: 'Messages in a group chat cannot be edited', nodeAnswered: true }))
            .toBe(NOT_AVAILABLE_YET);
        expect(chatActionErrorMessage({ status: 403, message: 'Reactions are not part of a group chat yet', nodeAnswered: true }))
            .toBe(NOT_AVAILABLE_YET);
    });

    it('shows an up-to-date node\'s own words for a refusal it really means', () => {
        // Every one of these is a 403/404 from a node that HAS the verb. Sending the member to their server
        // operator over any of them is the bug this covers.
        expect(chatActionErrorMessage({ status: 403, message: 'A removed message cannot be edited', nodeAnswered: true }))
            .toBe('A removed message cannot be edited');
        expect(chatActionErrorMessage({ status: 404, message: 'Message not found', nodeAnswered: true }))
            .toBe('Message not found');
        expect(chatActionErrorMessage({ status: 403, message: 'You are not in this group chat', nodeAnswered: true }))
            .toBe('You are not in this group chat');
        expect(chatActionErrorMessage({ status: 403, message: 'You are not a participant in this conversation', nodeAnswered: true }))
            .toBe('You are not a participant in this conversation');
    });

    it('keeps the node\'s own words for a real refusal', () => {
        expect(chatActionErrorMessage({ status: 400, message: 'Message is too long (maximum 2000 characters)', nodeAnswered: true }))
            .toBe('Message is too long (maximum 2000 characters)');
    });

    it('falls back to a plain line when there is no message at all', () => {
        expect(chatActionErrorMessage({ status: null, message: '' })).toMatch(/signal/);
        expect(chatActionErrorMessage(undefined)).toMatch(/signal/);
    });
});

describe('a node-readable chat\'s message, in the shape the components want', () => {
    const decode = (c: string, type: string) => (type === 'removed' ? 'removed by a convenor' : Buffer.from(c, 'base64').toString('utf8'));
    const b64 = (t: string) => Buffer.from(t, 'utf8').toString('base64');

    it('decodes the words, marks my own, and carries the author\'s name', () => {
        const m = normaliseThreadMessage(
            { id: 'g1', authorPubkey: ME, authorCallsign: 'Ana', ciphertext: b64('bring gloves'), type: 'text', timestamp: '2026-09-23T09:05:00Z' },
            decode, ME,
        );
        expect(m.text).toBe('bring gloves');
        expect(m.outgoing).toBe(true);
        expect(m.authorName).toBe('Ana');
        expect(m.rawTimestamp).toBe('2026-09-23T09:05:00Z');
    });

    it('parses metadata the node sent as a string', () => {
        const m = normaliseThreadMessage(
            { id: 'g2', authorPubkey: THEM, ciphertext: b64('hi'), metadata: JSON.stringify({ replyToId: 'g1' }) },
            decode, ME,
        );
        expect(m.metadata.replyToId).toBe('g1');
        expect(m.outgoing).toBe(false);
    });

    it('marks an edited message so the bubble can say "edited"', () => {
        const m = normaliseThreadMessage({ id: 'g3', authorPubkey: ME, ciphertext: b64('fixed'), editedAt: '2026-09-23T09:10:00Z' }, decode, ME);
        expect(m.edited).toBe(true);
    });

    it('says who deleted a tombstone, not what the node\'s marker text says', () => {
        const mine = normaliseThreadMessage(
            { id: 'g4', authorPubkey: ME, type: 'removed', ciphertext: b64('removed by a convenor'), metadata: { removed: true, removedBy: ME } },
            decode, ME,
        );
        expect(mine.text).toBe(DELETED_BY_AUTHOR_TEXT);
        const theirs = normaliseThreadMessage(
            { id: 'g5', authorPubkey: THEM, type: 'removed', ciphertext: b64('removed by a convenor'), metadata: { removed: true, removedBy: 'convenor' } },
            decode, ME,
        );
        expect(theirs.text).toBe(REMOVED_BY_CONVENOR_TEXT);
    });

    it('leaves a system line as it was written', () => {
        const m = normaliseThreadMessage({ id: 's1', authorPubkey: 'SYSTEM', type: 'system', ciphertext: 'Ana joined' }, decode, ME);
        expect(m.text).toBe('Ana joined');
    });
});

describe('which bubbles a read of the node retires', () => {
    const pending = [
        { clientId: 'c1', text: 'first' },
        { clientId: 'c2', text: 'second' },
    ];

    it('retires the bubble the node came back holding', () => {
        const left = pendingAfterRead(pending, [{ id: 'older' }, { id: 'c1' }]);
        expect(left.map(p => p.clientId)).toEqual(['c2']);
    });

    it('matches a node that numbers its messages', () => {
        const left = pendingAfterRead([{ clientId: '77' }], [{ id: 77 }]);
        expect(left).toEqual([]);
    });

    it('keeps every bubble when the read did not happen', () => {
        expect(pendingAfterRead(pending, null)).toEqual(pending);
        expect(pendingAfterRead(pending, undefined)).toEqual(pending);
    });

    it('keeps a bubble the read came back without, rather than taking it off the screen', () => {
        expect(pendingAfterRead(pending, [{ id: 'someone-elses' }])).toEqual(pending);
    });

    it('retires nothing on an empty chat', () => {
        expect(pendingAfterRead(pending, [])).toEqual(pending);
    });
});
