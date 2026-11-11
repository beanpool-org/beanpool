/**
 * "Invited, not joined yet" on a group's page, for the phone and the web app (Rob via Marty, 11 Nov 2026: "Invitations
 * should show whether they have been used"). The node decides who may read what (GET /api/groups/:id/invitations,
 * apps/server engine/group-invitations.ts): a convenor gets every pending invitation and who made it, any other member
 * the ones they made, and a declined one goes to the member who made it alone. This file is the shape of that answer and
 * the sentences both apps say it in, so the two screens read the same and the words are drafted once.
 */

import { t, timeAgo } from './words.js';

export interface InvitedPerson {
    memberPubkey: string;
    callsign?: string;
    avatarUrl?: string;
}

export interface PendingInvitation extends InvitedPerson {
    /** When the invitation was made. */
    invitedAt: string | null;
    /** Who made it: in a convenor's view only. */
    invitedBy?: { pubkey: string; callsign?: string };
}

export interface DeclinedInvitation extends InvitedPerson {
    invitedAt: string | null;
    declinedAt: string;
}

export interface GroupInvitations {
    /** 'convenor': every pending invitation. 'sender': the viewer's own. */
    view: 'convenor' | 'sender';
    /** Newest first; the node sends at most a page of them. */
    pending: PendingInvitation[];
    /** All of them, which may be more than `pending` holds. */
    pendingTotal: number;
    /** The viewer's own declined invitations, newest first. */
    declined: DeclinedInvitation[];
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const text = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined);

function person(raw: unknown): InvitedPerson | null {
    if (!isObject(raw) || typeof raw.memberPubkey !== 'string' || !raw.memberPubkey) return null;
    return { memberPubkey: raw.memberPubkey, callsign: text(raw.callsign), avatarUrl: text(raw.avatarUrl) };
}

/**
 * The node's answer as a screen uses it, or null for anything that is not one: a node from before this list answers 404,
 * a refusal answers an error. A screen draws nothing for null, and never guesses a list.
 */
export function readGroupInvitations(raw: unknown): GroupInvitations | null {
    if (!isObject(raw) || (raw.view !== 'convenor' && raw.view !== 'sender') || !Array.isArray(raw.pending) || !Array.isArray(raw.declined)) return null;
    const pending: PendingInvitation[] = [];
    for (const r of raw.pending) {
        const p = person(r);
        if (!p) continue;
        const by = isObject((r as Record<string, unknown>).invitedBy) ? (r as { invitedBy: Record<string, unknown> }).invitedBy : null;
        pending.push({
            ...p,
            invitedAt: text((r as Record<string, unknown>).invitedAt) ?? null,
            ...(by && typeof by.pubkey === 'string' && by.pubkey ? { invitedBy: { pubkey: by.pubkey, callsign: text(by.callsign) } } : {}),
        });
    }
    const declined: DeclinedInvitation[] = [];
    for (const r of raw.declined) {
        const p = person(r);
        const at = text((r as Record<string, unknown> | null)?.declinedAt);
        if (!p || !at) continue;
        declined.push({ ...p, invitedAt: text((r as Record<string, unknown>).invitedAt) ?? null, declinedAt: at });
    }
    const total = typeof raw.pendingTotal === 'number' && Number.isFinite(raw.pendingTotal) ? Math.max(raw.pendingTotal, pending.length) : pending.length;
    return { view: raw.view, pending, pendingTotal: total, declined };
}

/** Whether there is anything to draw: with nothing pending and nothing declined the section is not on the page at all. */
export function hasInvitationsToShow(inv: GroupInvitations | null): inv is GroupInvitations {
    return !!inv && (inv.pending.length > 0 || inv.declined.length > 0);
}

/** The name a row shows: the callsign, or the start of the key for someone with none. */
export function invitedName(p: InvitedPerson): string {
    return p.callsign || p.memberPubkey.slice(0, 10);
}

/** "3 days ago", or null when the date is not one. */
function agoOf(iso: string | null | undefined, nowMs: number): string | null {
    const at = iso ? Date.parse(iso) : NaN;
    return Number.isFinite(at) ? timeAgo(Math.max(0, nowMs - at)) : null;
}

/** The section's title. */
export function invitedListTitle(total: number): string {
    return t('Invited, not joined yet ({n})', { n: total });
}

/** What a pending row says under the name: when, and for a convenor who made it ("by you" for their own). */
export function pendingInvitationLine(p: PendingInvitation, viewerPubkey: string | undefined, nowMs: number = Date.now()): string {
    const when = agoOf(p.invitedAt, nowMs);
    const by = p.invitedBy;
    if (by && viewerPubkey && by.pubkey === viewerPubkey) return when ? t('Invited {when} by you', { when }) : t('Invited by you');
    if (by?.callsign) return when ? t('Invited {when} by {name}', { when, name: by.callsign }) : t('Invited by {name}', { name: by.callsign });
    return when ? t('Invited {when}', { when }) : t('Invited');
}

/** The "and 12 more" under a list the node cut short. Empty when it did not. */
export function moreInvitationsLine(inv: GroupInvitations): string {
    const more = inv.pendingTotal - inv.pending.length;
    return more > 0 ? t('and {n} more', { n: more }) : '';
}

/** The declined block's title, and the line that says who can read it. */
export function declinedListTitle(): string {
    return t('Declined invitations you sent');
}
export function declinedListNote(): string {
    return t('Nobody else in the group sees these.');
}

/** What a declined row says under the name. */
export function declinedInvitationLine(d: DeclinedInvitation, nowMs: number = Date.now()): string {
    const when = agoOf(d.declinedAt, nowMs);
    return when ? t('Declined {when}', { when }) : t('Declined');
}

/** Withdrawing a pending invitation: the button, its label, and the question asked first. */
export function withdrawWords(p: InvitedPerson): { button: string; label: string; title: string; question: string; failed: string } {
    const name = invitedName(p);
    return {
        button: t('Withdraw'),
        label: t('Withdraw the invitation to {name}', { name }),
        title: t('Withdraw the invitation?'),
        question: t('The invitation to {name} is taken back. You can invite them again.', { name }),
        failed: t('Could not withdraw the invitation'),
    };
}
