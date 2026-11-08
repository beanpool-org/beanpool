/**
 * People → Invites for owners and admins: add the person to the names list, and make them a voucher, as the invite is made
 * (DESIGN-invites-and-names-list-amend3-fable.md §1–§2, slice A2; Marty, 8 Nov: Q1 allow both, Q2 phone first, Q3 keep).
 * The screen is components/InviteNamesBoxes.tsx; what it decides is here, so the tests can fail on it.
 *
 * The name is sealed on this phone under the list's key, exactly as the list's own editor adds an entry (core saveNamesEntry):
 * the node and the invite link never hold it. Then the invite is made bound to that entry (POST /api/names/entries/:id/invite)
 * with what was chosen: a vouch preset and, for the credit committee, a voucher budget. Nothing lands until that person joins.
 *
 * None of this decides what the node decides: who is on the committee is its answer to GET /api/names/vouchers, and a level or
 * a vouch it refuses is said in its own words. A ticket the phone signs never carries a level or a vouch: with no answer from
 * the node, a ticket is made only when neither was chosen (bound to the entry, as "Invite this person" does).
 */
import { offersNamesList, sameName, t, namesInviteBody, type NamesInviteBody } from '@beanpool/core';
import type { NamesOpened, OpenedEntry } from './names-list';

/** Who gets the two boxes: an owner or an admin of a local community (core offersNamesList), never a member or a moderator. */
export function offersNamesBoxes(role: string | null | undefined, profile: 'local' | 'global' | null | undefined): boolean {
    return offersNamesList(role, profile);
}

/** Why "Make them a voucher" is greyed, or null when it can be ticked. */
export type VoucherBoxWhy = 'needs_signal' | 'not_heard' | 'committee_only' | 'needs_names' | null;

/**
 * "Make them a voucher": only with a connection (a ticket never carries a level), only for the credit committee (owners and
 * committee admins: the node answers GET /api/names/vouchers only to them; `committee` undefined while its answer isn't heard,
 * which is never read as a no), and only with the names box ticked (amend2 §2: a voucher made with an invite comes with a
 * names-list entry). No connection is said first: offline, the committee's answer can't be heard either.
 */
export function voucherBoxWhy(o: { committee: boolean | undefined; online: boolean; namesTicked: boolean }): VoucherBoxWhy {
    if (!o.online) return 'needs_signal';
    if (o.committee === undefined) return 'not_heard';
    if (!o.committee) return 'committee_only';
    if (!o.namesTicked) return 'needs_names';
    return null;
}

/** The sentence under a greyed "Make them a voucher"; none while the node's answer isn't heard (nothing true to say yet). */
export function voucherBoxWords(why: VoucherBoxWhy): string | null {
    if (why === 'committee_only') return t('Only an owner or an admin on the credit committee makes vouchers and sets their budgets.');
    if (why === 'needs_signal') return t('Needs a connection. You can make them a voucher from the list once they’ve joined.');
    if (why === 'needs_names') return t('Tick “Add them to the names list” first: a voucher made with an invite comes with their entry.');
    return null;
}

/** An entry already on the list whose name, as this phone opened it, is the one typed (case, accents and spacing set aside). */
export interface SameNameOnList { entryId: string; name: string; by: string; member: string | null }

/**
 * The duplicate-name warning (design §1): today nothing checks. This phone opened the whole list, so it looks here; the node
 * never sees the name. `by`: "@callsign" of the admin who added it.
 */
export function sameNameOnList(typed: string, entries: readonly OpenedEntry[], opened: Pick<NamesOpened, 'list' | 'state'> | null): SameNameOnList | null {
    if (!typed.trim()) return null;
    const hit = entries.find((e) => !!e.text && sameName(e.text.name, typed));
    if (!hit || !hit.text) return null;
    const row = opened?.list?.entries.find((e) => e.id === hit.id);
    const maker = row?.createdBy ?? '';
    const callsign = opened?.state.admins.find((a) => a.pubkey === maker)?.callsign ?? opened?.state.callsigns?.[maker] ?? '';
    return { entryId: hit.id, name: hit.text.name, by: callsign ? `@${callsign}` : t('an admin'), member: hit.confirmation?.callsign ?? (hit.confirmation ? '' : null) };
}

/** The warning's words: not joined yet (and the way to invite that entry instead), or joined already. */
export function sameNameWords(s: SameNameOnList): string {
    if (s.member === null) return t('{name} is on the list already (added by {by}, not joined yet). Invite that entry instead?', { name: s.name, by: s.by });
    return s.member
        ? t('{name} is on the list already (added by {by}, confirmed as @{member}).', { name: s.name, by: s.by, member: s.member })
        : t('{name} is on the list already (added by {by}, and a member is confirmed against it).', { name: s.name, by: s.by });
}

type Answer<T> = { ok: true; value: T } | { ok: false; status: number; message: string };

/** What came of Generate with the names box ticked. */
export type NamesInviteResult =
    | { kind: 'made'; code: string; offline: boolean; entryId: string }
    /** The entry couldn't be written: nothing was made. */
    | { kind: 'entry_not_saved'; message: string }
    /** The entry stands (new, or the one already on the list), but no invite was made: the list's Invite this person still can. */
    | { kind: 'invite_not_made'; entryId: string; entryIsNew: boolean; message: string };

/**
 * Adds the entry (unless `existingEntryId`: "Invite that entry instead"), then makes the invite bound to it with what was
 * chosen. With no answer at all (status 0) an offline ticket bound to the entry is made, but only when no vouch and no level
 * were chosen: a ticket never carries either. Never a false success: a refusal is said in the node's words.
 */
export async function inviteWithNamesEntry(
    steps: {
        saveEntry: () => Promise<Answer<{ id: string }>>;
        invite: (entryId: string, body: { vouchAmount?: number; voucherLevel?: number }) => Promise<Answer<{ invite: { code: string } }>>;
        offlineTicket: (entryId: string) => Promise<string>;
    },
    choice: NamesInviteBody,
    existingEntryId?: string | null,
): Promise<NamesInviteResult> {
    let entryId = existingEntryId ?? null;
    const entryIsNew = !entryId;
    if (!entryId) {
        const saved = await steps.saveEntry();
        if (!saved.ok) return { kind: 'entry_not_saved', message: saved.message };
        entryId = saved.value.id;
    }
    const body = namesInviteBody(choice);
    const made = await steps.invite(entryId, body);
    if (made.ok) return { kind: 'made', code: made.value.invite.code, offline: false, entryId };
    if (made.status !== 0) return { kind: 'invite_not_made', entryId, entryIsNew, message: made.message };
    if (body.voucherLevel !== undefined || body.vouchAmount !== undefined) {
        return { kind: 'invite_not_made', entryId, entryIsNew, message: t('A vouch or a voucher budget needs a connection: an offline ticket never carries one. Try again when you’re connected.') };
    }
    try {
        return { kind: 'made', code: await steps.offlineTicket(entryId), offline: true, entryId };
    } catch (e) {
        return { kind: 'invite_not_made', entryId, entryIsNew, message: e instanceof Error && e.message ? e.message : t('The ticket could not be made.') };
    }
}

/** What an admin reads when the entry stands but the invite wasn't made (design §2: the entry stays; invite from the list). */
export function inviteNotMadeWords(r: Extract<NamesInviteResult, { kind: 'invite_not_made' }>): string {
    return r.entryIsNew
        ? t('The name is on the names list, but the invite wasn’t made: {why} Their entry stays: open the names list and use Invite this person on it.', { why: r.message })
        : r.message;
}
