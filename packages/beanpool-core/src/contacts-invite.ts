/**
 * Invite from a contact (scratch/fable-design/DESIGN-private-contacts-fable.md §3.8, §3.9, slice C5): the words and rules both
 * apps share. The invite is the community's ordinary one, made with no note: the server is told who made it and nothing of
 * whom it is for. Which contact a code was for is kept only inside the locked list (`Contact.invite`), and People → Invites →
 * Pending names the code from that list on the device ({@link contactInviteNames}).
 *
 * The sheet hands the message to the member's own apps: the share sheet, the phone's text app (the number, stripped to digits
 * and `+`, goes into that link and nowhere else), an email, or the clipboard. BeanPool sends nothing itself. There is no
 * "invite everyone" (design Q4).
 *
 * When the code is used, the row asks "Is this Dee?" ({@link contactInviteAsk}): a link can be forwarded, so a contact is
 * linked to a member only by the member's own Yes. No forgets the invite, so it isn't asked again.
 */
import { formatDate, t } from './words.js';
import { INVITE_LIFE_MS } from './invite-rows.js';
import type { Contact } from './contacts-list.js';

/** An invite as `GET /api/invite/mine/:publicKey` tells its maker: what these rules read of it. */
export interface MyInviteSeen {
    code: string;
    createdAt?: string;
    usedBy?: string | null;
    usedByCallsign?: string | null;
}

/** Whether an address is the community in use (each app compares addresses its own way). */
export type IsHere = (community: string) => boolean;

/** The sheet's title: "Invite Dee to Riverside". */
export function contactInviteTitle(name: string, community: string): string {
    return t('Invite {name} to {community}', { name, community });
}

/** The sheet's two lines: one invite for one person, and that what the list holds of them is not sent. */
export function contactInviteLines(contact: Pick<Contact, 'name' | 'phones' | 'emails'>): [string, string] {
    const name = contact.name;
    const kept = contact.phones.length > 0
        ? t("{name}'s name and number are not sent to the server.", { name })
        : contact.emails.length > 0
            ? t("{name}'s name and email are not sent to the server.", { name })
            : t("{name}'s name is not sent to the server.", { name });
    return [t('One invite, for one person. It works once, for 30 days.'), kept];
}

/** The row's line once an invite went: "invited 12 Nov". Null with none. */
export function contactInvitedLine(contact: Pick<Contact, 'invite'>): string | null {
    const at = contact.invite ? new Date(contact.invite.at) : null;
    if (!at || !Number.isFinite(at.getTime())) return null;
    return t('invited {date}', { date: formatDate(at, 'day-month') });
}

/**
 * A text-message link to the phone's own text app: the number stripped to digits and a leading `+` (design §7), the message
 * as the body (iPhone reads it after `&`, Android after `?`). Null for a number with no digits.
 */
export function contactSmsLink(phone: string, text: string, os: 'ios' | 'android' | string): string | null {
    const digits = phone.replace(/[^\d]/g, '');
    if (!digits) return null;
    const number = (phone.trim().startsWith('+') ? '+' : '') + digits;
    return `sms:${number}${os === 'ios' ? '&' : '?'}body=${encodeURIComponent(text)}`;
}

/** An email link to the member's own mail app, or null for anything that isn't one plain address. */
export function contactMailtoLink(email: string, subject: string, text: string): string | null {
    const to = email.trim();
    if (!/^[^\s@?&#/:;,<>"'%]+@[^\s@?&#/:;,<>"'%]+$/.test(to)) return null;
    return `mailto:${to}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(text)}`;
}

/** The contact with the invite just made kept on it: its code, the community it is for, and when. */
export function withContactInvite(contact: Contact, code: string, community: string, now: Date = new Date()): Contact {
    return { ...contact, invite: { code, community, at: now.toISOString() } };
}

/** The contact with its invite forgotten (the member said No: someone else used it). */
export function forgetContactInvite(contact: Contact): Contact {
    return { ...contact, invite: null };
}

/** Each code made from the list for this community, lower-cased, to the contact's name: what Pending shows on this device. */
export function contactInviteNames(contacts: readonly Contact[], here: IsHere): Map<string, string> {
    const names = new Map<string, string>();
    for (const c of contacts) if (c.invite && here(c.invite.community)) names.set(c.invite.code.toLowerCase(), c.name);
    return names;
}

/** Who used a contact's invite, as the community told its maker. */
export interface ContactInviteUsed {
    code: string;
    key: string;
    callsign: string;
}

const sameCode = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/**
 * "Someone joined with the invite you sent Dee: @dee_w. Is this Dee?": asked when this community says the contact's code was
 * used, and that member isn't linked to the contact yet. Null otherwise.
 */
export function contactInviteAsk(contact: Contact, mine: readonly MyInviteSeen[], here: IsHere): ContactInviteUsed | null {
    const inv = contact.invite;
    if (!inv || !here(inv.community)) return null;
    const seen = mine.find((m) => sameCode(m.code, inv.code));
    const key = typeof seen?.usedBy === 'string' ? seen.usedBy.toLowerCase() : '';
    if (!/^[0-9a-f]{64}$/.test(key) || contact.links.some((l) => l.key === key)) return null;
    return { code: inv.code, key, callsign: typeof seen?.usedByCallsign === 'string' ? seen.usedByCallsign : '' };
}

/** The question's words. */
export function contactInviteAskWords(name: string, community: string, callsign: string): { question: string; yes: string; no: string } {
    return {
        question: callsign
            ? t('Someone joined {community} with the invite you sent {name}: @{callsign}. Is this {name}?', { community, name, callsign })
            : t('Someone joined {community} with the invite you sent {name}. Is this {name}?', { community, name }),
        yes: t("Yes, that's {name}", { name }),
        no: t('No'),
    };
}

/** Said after No. */
export function contactInviteNoWords(): string {
    return t("Then someone else used it. If that's a problem, tell an admin.");
}

/** Yes: the contact linked to the member who joined with it, in the invite's community, made by an invite the member confirmed. */
export function linkContactToInvite(contact: Contact, used: ContactInviteUsed, now: Date = new Date()): Contact {
    const community = contact.invite?.community ?? '';
    return { ...contact, links: [...contact.links, { key: used.key, community, callsign: used.callsign, how: 'invite', at: now.toISOString() }] };
}

/**
 * The code of the contact's invite still out in this community (unused, within its 30 days, and among the member's own the
 * community listed), for "Also cancel the invite I sent". Null otherwise: nothing to cancel.
 */
export function contactInviteOut(contact: Pick<Contact, 'invite'>, mine: readonly MyInviteSeen[], here: IsHere, now: number = Date.now()): string | null {
    const inv = contact.invite;
    if (!inv || !here(inv.community) || Date.parse(inv.at) + INVITE_LIFE_MS <= now) return null;
    const seen = mine.find((m) => sameCode(m.code, inv.code));
    return seen && !seen.usedBy ? inv.code : null;
}

/** The tick on Remove from contacts. */
export const contactInviteCancelWords = {
    tick: (): string => t('Also cancel the invite I sent'),
};

/** The words where this member can't make an invite here, the ask's added line, and the sheet's buttons. */
export const contactInviteWords = {
    invite: (): string => t('Invite', undefined, 'button: invite a contact'),
    again: (): string => t('Invite again'),
    share: (): string => t('Share…'),
    text: (): string => t('Text message'),
    email: (): string => t('Email', undefined, 'button: send by email'),
    copy: (): string => t('Copy'),
    copied: (): string => t('Copied. Paste it in your own message.'),
    askAdmin: (name: string): string => t('Ask an admin to invite {name}', { name }),
    askLine: (): string => t('The admins will see the first name you type here.'),
    emailSubject: (): string => t('Join me on BeanPool'),
};
