import { describe, expect, it } from 'vitest';
import {
    INVITE_ASK_LIMITS, INVITE_ASK_WORDS, inviteAskAnswerWords, inviteAskNeedsLine, inviteAskNoticeHere, inviteAskReady, offersInviteAsk,
    readInviteAsksMine, readInviteAsksToAnswer,
} from './invite-ask.js';

describe('who is offered the ask', () => {
    const here = { inviteAsks: true, door: 'admins' };
    it('a member who can\'t invite, where only admins do, on a node that takes asks', () => {
        expect(offersInviteAsk(here, false)).toBe(true);
    });
    it('nobody else, and nobody while the node or the role is not heard', () => {
        expect(offersInviteAsk(here, true)).toBe(false);
        expect(offersInviteAsk(here, undefined)).toBe(false);
        expect(offersInviteAsk({ inviteAsks: true, door: 'members' }, false)).toBe(false);
        expect(offersInviteAsk({ door: 'admins' }, false)).toBe(false);
        expect(offersInviteAsk({ inviteAsks: false, door: 'admins' }, false)).toBe(false);
        expect(offersInviteAsk(null, false)).toBe(false);
    });
});

describe('the sheet', () => {
    it('needs both lines, within their limits, counted as characters', () => {
        expect(inviteAskReady('Sam', 'from the bakery')).toBe(true);
        expect(inviteAskReady('  ', 'x')).toBe(false);
        expect(inviteAskReady('Sam', '   ')).toBe(false);
        expect(inviteAskReady('😀'.repeat(INVITE_ASK_LIMITS.firstName), 'x')).toBe(true);
        expect(inviteAskReady('x'.repeat(INVITE_ASK_LIMITS.firstName + 1), 'x')).toBe(false);
        expect(inviteAskReady('Sam', 'x'.repeat(INVITE_ASK_LIMITS.howKnown + 1))).toBe(false);
    });
});

describe('what the node answers', () => {
    const waiting = { id: 'a', firstName: 'Sam', howKnown: 'bakery', askedAt: '2026-11-03T00:00:00.000Z' };
    it('reads a member\'s own, and leaves out what isn\'t one', () => {
        const read = readInviteAsksMine({
            waiting: [waiting, { id: 'b' }, null],
            answers: [
                { id: 'c', outcome: 'invited', state: 'ready', code: 'INV-1', askedAt: 'x', answeredAt: 'y' },
                { id: 'd', outcome: 'no', reason: 'not yet', askedAt: 'x' },
                { id: 'e', outcome: 'maybe', askedAt: 'x' },
            ],
        });
        expect(read?.waiting).toEqual([waiting]);
        expect(read?.answers.map((a) => a.id)).toEqual(['c', 'd']);
        expect(read?.answers[1]).toEqual({ id: 'd', outcome: 'no', reason: 'not yet', askedAt: 'x', answeredAt: 'x' });
        expect(readInviteAsksMine({ waiting: 'x' })).toBeNull();
        expect(readInviteAsksMine(null)).toBeNull();
    });
    it('reads an admin\'s list, naming who asked', () => {
        expect(readInviteAsksToAnswer({ asks: [{ ...waiting, askerPubkey: 'k', askerCallsign: 'Mel' }, waiting] }))
            .toEqual([{ ...waiting, askerPubkey: 'k', askerCallsign: 'Mel' }]);
        expect(readInviteAsksToAnswer({})).toBeNull();
    });
});

describe('the words', () => {
    it('says how an ask ended', () => {
        expect(inviteAskAnswerWords({ outcome: 'no' })).toBe(INVITE_ASK_WORDS.no);
        expect(inviteAskAnswerWords({ outcome: 'invited', state: 'ready' })).toBe(INVITE_ASK_WORDS.invited);
        expect(inviteAskAnswerWords({ outcome: 'invited', state: 'used' })).toBe(INVITE_ASK_WORDS.used);
        expect(inviteAskAnswerWords({ outcome: 'invited', state: 'lapsed' })).toBe(INVITE_ASK_WORDS.lapsed);
    });
    it('counts, and names nobody', () => {
        expect(inviteAskNeedsLine(1)).toBe('1 member asked you to invite someone');
        expect(inviteAskNeedsLine(3)).toBe('3 members asked you to invite someone');
    });
    it('finds a kept notice\'s fixed words again, and leaves any other notice as it came', () => {
        expect(inviteAskNoticeHere(INVITE_ASK_WORDS.noticeBody)).toBe(INVITE_ASK_WORDS.noticeBody);
        expect(inviteAskNoticeHere('Your post was removed')).toBe('Your post was removed');
    });
});
