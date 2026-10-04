/**
 * An invite bound to a names-list entry (community modes slice 3, design §4.1 ways 1–3). An admin taps "Invite this
 * person" on an entry: the node makes an invite bound to the entry's id (never the name), and redeeming it confirms
 * the joiner against the entry, by this admin. With no signal (a hall), the phone makes an offline ticket instead, the
 * entry's id signed inside it. The node never strands the joiner over the binding: where it can't confirm (the entry
 * was confirmed since, or deleted; the maker is no longer an admin), the joiner is a member unconfirmed, and the admins
 * see why.
 */

/** What the node did with a binding when the invite was used (server engine/names-list.ts InviteBindOutcome). */
export type InviteBindOutcome = 'confirmed' | 'awaiting_second' | 'entry_taken' | 'already_confirmed' | 'entry_gone' | 'maker_not_admin';

/** As the node lists it: never the code, which the maker's phone shows once, when it is made. */
export interface BoundInvite {
    entryId: string; createdBy: string; createdAt: string; usedBy: string | null; usedAt: string | null;
    outcome: InviteBindOutcome | null;
}

export const BIND_OUTCOME_WORDS: Record<InviteBindOutcome, string> = {
    confirmed: 'joined and was confirmed',
    awaiting_second: 'joined; the confirmation waits for a second admin',
    entry_taken: 'joined, not confirmed: someone else was confirmed against this entry first',
    already_confirmed: 'joined, not confirmed: they were confirmed against another entry already',
    entry_gone: 'joined, not confirmed: the entry was deleted',
    maker_not_admin: 'joined, not confirmed: whoever made the invite can no longer confirm against this entry',
};

/** One line for a bound invite on its entry: waiting, or what happened when it was used. `nameOf` gives "@callsign". */
export function boundInviteLine(inv: Pick<BoundInvite, 'usedBy' | 'outcome'>, nameOf: (pubkey: string) => string): string {
    if (!inv.usedBy) return 'Invite made, not used yet';
    return `${nameOf(inv.usedBy)} ${inv.outcome ? BIND_OUTCOME_WORDS[inv.outcome] : 'joined'}`;
}

/** The bound invites for one entry, newest first (the node lists them newest first). */
export function invitesForEntry(invites: readonly BoundInvite[], entryId: string): BoundInvite[] {
    return invites.filter((i) => i.entryId === entryId);
}

type Online = { ok: true; value: { invite: { code: string } } } | { ok: false; status: number; message: string };

/**
 * Invite this person: the node's bound invite when it answers; with no signal (no answer at all: status 0), an offline
 * ticket bound to the entry. A refusal (an entry confirmed already, no key, a limit) is said, and no ticket is made: a
 * ticket would be refused or would not confirm for the same reason.
 */
export async function inviteThisPerson(
    online: () => Promise<Online>, offlineTicket: () => Promise<string>,
): Promise<{ ok: true; code: string; offline: boolean } | { ok: false; message: string }> {
    const r = await online();
    if (r.ok) return { ok: true, code: r.value.invite.code, offline: false };
    if (r.status !== 0) return { ok: false, message: r.message };
    try {
        return { ok: true, code: await offlineTicket(), offline: true };
    } catch (e) {
        return { ok: false, message: e instanceof Error ? e.message : 'The ticket could not be made.' };
    }
}

/** The link an invite's QR code holds, and the message its Share sends (as the People tab's invite). */
export function inviteLink(anchorUrl: string, code: string): string {
    return `${anchorUrl}/?invite=${code}`;
}
