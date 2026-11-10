/**
 * An invite bound to a names-list entry (community modes slice 3, design §4.1 ways 1–3). An admin taps "Invite this
 * person" on an entry: the node makes an invite bound to the entry's id (never the name), and redeeming it confirms
 * the joiner against the entry, by this admin. With no signal (a hall), the phone makes an offline ticket instead, the
 * entry's id signed inside it. The node never strands the joiner over the binding: where it can't confirm (the entry
 * was confirmed since, or deleted; the maker is no longer an admin), the joiner is a member unconfirmed, and the admins
 * see why.
 *
 * Shared by the phone and the web app (DESIGN-names-list-web-fable.md S1: moved out of the phone's
 * apps/native/utils/names-invite.ts, unchanged).
 */

import { inviteAndShareLink } from './invite-and-share.js';
import { formatHundredths } from './hundredths.js';

/** What the node did with a binding when the invite was used (server engine/names-list.ts InviteBindOutcome). */
export type InviteBindOutcome = 'confirmed' | 'awaiting_second' | 'entry_taken' | 'already_confirmed' | 'entry_gone' | 'maker_not_admin' | 'open_debt';

/**
 * What became of the voucher budget a bound invite promised (DESIGN-invites-and-names-list-amend3-fable.md §2; server
 * engine/vouchers.ts InviteVoucherOutcome): made, waiting for the second admin, or why not.
 */
export type InviteVoucherOutcome = 'made' | 'awaiting_second' | 'maker_not_committee' | 'beans_off' | 'not_confirmed' | 'not_made';

/** As the node lists it: never the code, which the maker's phone shows once, when it is made. */
export interface BoundInvite {
    entryId: string; createdBy: string; createdAt: string; usedBy: string | null; usedAt: string | null;
    outcome: InviteBindOutcome | null;
    /** The voucher budget the invite promises (100 to 2,000), or null; absent from a node before amend3. */
    voucherLevel?: number | null;
    /** What became of it once the invite was used, or null. */
    voucherOutcome?: InviteVoucherOutcome | null;
}

export const BIND_OUTCOME_WORDS: Record<InviteBindOutcome, string> = {
    confirmed: 'joined and was confirmed',
    awaiting_second: 'joined; the confirmation waits for a second admin',
    entry_taken: 'joined, not confirmed: someone else was confirmed against this entry first',
    already_confirmed: 'joined, not confirmed: they were confirmed against another entry already',
    entry_gone: 'joined, not confirmed: the entry was deleted',
    maker_not_admin: 'joined, not confirmed: whoever made the invite can no longer confirm against this entry',
    open_debt: 'joined, not confirmed: the entry has a debt that is still open',
};

/** The voucher clause after a used bound invite's line: `{level}` the budget, `{maker}` "@callsign" of whoever made the invite. */
export const VOUCHER_OUTCOME_WORDS: Record<InviteVoucherOutcome, string> = {
    made: 'made a voucher with a budget of {level} Beans',
    awaiting_second: 'made a voucher once a second admin confirms them',
    maker_not_committee: 'not made a voucher: {maker} is no longer on the credit committee',
    beans_off: 'not made a voucher: Beans are switched off in this community',
    not_confirmed: 'not made a voucher',
    not_made: 'not made a voucher: the credit committee can make them one from the list',
};

/**
 * One line for a bound invite on its entry: waiting, or what happened when it was used, with what became of a voucher budget
 * it promised. `nameOf` gives "@callsign".
 */
export function boundInviteLine(
    inv: Pick<BoundInvite, 'usedBy' | 'outcome'> & Partial<Pick<BoundInvite, 'createdBy' | 'voucherLevel' | 'voucherOutcome'>>,
    nameOf: (pubkey: string) => string,
): string {
    if (!inv.usedBy) return 'Invite made, not used yet';
    // An outcome this phone has no words for (a newer node's) reads as plain "joined", and adds no clause: never a throw,
    // never "undefined". Own keys only, so a name like "constructor" is no outcome either.
    const bound = (inv.outcome ? wordsFor(BIND_OUTCOME_WORDS, inv.outcome) : '') || 'joined';
    const line = `${nameOf(inv.usedBy)} ${bound}`;
    const said = inv.voucherOutcome ? wordsFor(VOUCHER_OUTCOME_WORDS, inv.voucherOutcome) : '';
    if (!said) return line;
    const clause = said
        .replace('{level}', formatHundredths(inv.voucherLevel ?? 0))
        .replace('{maker}', inv.createdBy ? nameOf(inv.createdBy) : 'whoever made the invite');
    return `${line}; ${clause}`;
}

/** The words for `key` in `table`, or '' where the table has none of its own. */
function wordsFor(table: Readonly<Record<string, string>>, key: string): string {
    return Object.prototype.hasOwnProperty.call(table, key) ? table[key] ?? '' : '';
}

/**
 * Whether an entry shows its bound invite's line: an entry nobody is confirmed against shows its newest invite, used or
 * not (as before); a confirmed entry, or one waiting for a second admin, shows it only when the invite promised a voucher
 * budget and says what became of it (made, waiting, or why not). Otherwise the confirmation's own line says it all.
 */
export function showsBoundInviteLine(inv: Pick<BoundInvite, 'voucherOutcome'> | null | undefined, confirmed: boolean): boolean {
    if (!inv) return false;
    return !confirmed || !!inv.voucherOutcome;
}

/**
 * What an invite bound to an entry may carry (POST /api/names/entries/:id/invite; DESIGN-invites-and-names-list-amend3-fable.md
 * §2 and Marty's Q1, "allow both"): a vouch preset from the maker's own budget, and, for an owner or a credit-committee admin, a
 * voucher budget (100 to 2,000) the joiner is made a voucher with once confirmed. The node checks both.
 */
export interface NamesInviteBody { vouchAmount?: number | null; voucherLevel?: number | null }

/**
 * The body as sent: only what was chosen, as whole numbers. Nothing chosen is `{}`, today's body. A level rides only here, on an
 * invite bound to an entry: the plain invite (POST /api/invite/generate) and an offline ticket never carry one.
 */
export function namesInviteBody(choice: NamesInviteBody): { vouchAmount?: number; voucherLevel?: number } {
    const out: { vouchAmount?: number; voucherLevel?: number } = {};
    if (typeof choice.vouchAmount === 'number' && Number.isFinite(choice.vouchAmount)) out.vouchAmount = choice.vouchAmount;
    if (typeof choice.voucherLevel === 'number' && Number.isFinite(choice.voucherLevel)) out.voucherLevel = choice.voucherLevel;
    return out;
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

/**
 * The link an invite's QR code holds, and the message its Share sends (as the People tab's invite). With `postId`, the listing
 * the friend lands on once they have joined (invite-and-share, core inviteAndShareLink); without one, as it has always been.
 */
export function inviteLink(anchorUrl: string, code: string, postId?: string | null): string {
    return inviteAndShareLink(anchorUrl, code, postId);
}
