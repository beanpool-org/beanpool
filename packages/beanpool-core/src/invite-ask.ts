/**
 * A member asks an admin to invite someone (Marty, 3 Nov): where only its admins invite, a member who knows someone can
 * ask, and an owner or admin answers. The node decides (apps/server engine/invite-asks.ts); these say what both apps offer
 * and say, the same on each, and how long each line may be.
 */
import { t, tn, word } from './words.js';

export const INVITE_ASK_LIMITS = {
    /** Asks one member may have waiting at once. */
    waiting: 3,
    /** Asks one member may make in any 24 hours, answered or taken back or not. */
    perDay: 3,
    /** Characters (code points) in the first name, the line on how they know them, and an admin's reason. */
    firstName: 30,
    howKnown: 140,
    reason: 100,
    /** An unanswered ask is deleted this many days after it was made. */
    keptDays: 30,
} as const;

export const INVITE_ASK_WORDS = {
    button: word('Ask an admin to invite someone'),
    help: word('An admin reads this and decides. Just a first name and how you know them: no phone number or email.'),
    firstName: word('Their first name'),
    howKnown: word('How you know them'),
    send: word('Send to the admins'),
    mine: word('What you’ve asked'),
    waiting: word('Waiting for an admin'),
    takeBack: word('Take it back'),
    invited: word('An admin made an invite for you to pass on. It works once, for 30 days.'),
    used: word('Someone has joined with this invite.'),
    lapsed: word('This invite lapsed before anyone used it.'),
    no: word('An admin said no.'),
    asked: word('Asked {date}'),
    toAnswer: word('Members asking you to invite someone'),
    toAnswerHelp: word('Send invite makes an ordinary invite, and the code goes to the member who asked, to pass on.'),
    askedBy: word('Asked by {name}'),
    sendInvite: word('Send invite'),
    say: word('No', 'button: refuse a request'),
    reason: word('A short reason (you can leave this out)'),
    sendNo: word('Send'),
    sent: word('Sent. The code is with the member now.'),
    told: word('Done. The member has been told.'),
    // A kept notice (apps/server engine/invite-asks.ts): never the code, the reason or a name.
    noticeTitle: word('Your ask to invite someone'),
    noticeInvited: word('An admin made the invite. Open Invites to pass it on.'),
    noticeNo: word('An admin answered. Open Invites to read it.'),
} as const;

/**
 * Whether a member is offered the ask: the node takes them (features.inviteAsks: a node of a version that does, with
 * invites on, so a phone newer than its node never offers what it refuses), only its admins invite here, and this member
 * can't. Not heard yet, or no answer: not offered. A role, never a tier.
 */
export function offersInviteAsk(features: { inviteAsks?: boolean; door?: unknown } | null | undefined, mayInvite: boolean | null | undefined): boolean {
    return features?.inviteAsks === true && features?.door === 'admins' && mayInvite === false;
}

/** Whether both lines of the sheet are filled and fit (the node decides again). */
export function inviteAskReady(firstName: string, howKnown: string): boolean {
    const name = Array.from(firstName.trim()).length;
    const how = Array.from(howKnown.trim()).length;
    return name >= 1 && name <= INVITE_ASK_LIMITS.firstName && how >= 1 && how <= INVITE_ASK_LIMITS.howKnown;
}

/** What the node answers for one of the member's own asks that is still waiting (GET /api/invite/asks/mine). */
export interface InviteAskWaiting {
    id: string;
    firstName: string;
    howKnown: string;
    askedAt: string;
}

/** How one of the member's asks ended. The request itself is gone: this carries no name and no line of it. */
export interface InviteAskAnswer {
    id: string;
    outcome: 'invited' | 'no';
    askedAt: string;
    answeredAt: string;
    /** `invited`: the code to pass on, while it can still be used; `used` or `lapsed` once it can't. */
    code?: string;
    state?: 'ready' | 'used' | 'lapsed';
    /** `no`: what the admin wrote, if they did. */
    reason?: string;
}

/** One ask as an owner or admin reads it (GET /api/invite/asks). */
export interface InviteAskToAnswer extends InviteAskWaiting {
    askerCallsign: string;
    askerPubkey: string;
}

/** The Needs you line for an owner or admin, in their language. A count, never a name. */
export function inviteAskNeedsLine(count: number): string {
    return tn(count, '{n} member asked you to invite someone', '{n} members asked you to invite someone');
}

/** The line an answer shows, in the member's language. */
export function inviteAskAnswerWords(a: Pick<InviteAskAnswer, 'outcome' | 'state'>): string {
    if (a.outcome === 'no') return t(INVITE_ASK_WORDS.no);
    if (a.state === 'used') return t(INVITE_ASK_WORDS.used);
    if (a.state === 'lapsed') return t(INVITE_ASK_WORDS.lapsed);
    return t(INVITE_ASK_WORDS.invited);
}
