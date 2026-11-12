/**
 * Giving from the apps, on the server (scratch/fable-design/DESIGN-credit-list-fable.md §3.3, §6 and its amendment 1 §6,
 * §7 slice C2): an owner or any admin raises a confirmed member's known floor from the credit sheet or the profile card,
 * signed with their own key (POST /api/credit/known-floor, routes/credit-sight.ts). Marty's Q4 of 12 Nov: owners and every
 * admin, raise only, as Settings already lets them.
 *
 * The write is Settings' own: config/known-floor.ts setKnownFloorException, unchanged, with the route's `tell` as its third
 * parameter, so the log line (`exception_raised` above the community's known floor) and the member's notice
 * (engine/credit-notices.ts, kind `credit_known_floor`) are the ones a change in Settings makes. Nothing here builds a
 * notice of its own.
 *
 * What the apps can't do here, so a tap can never cut or undo anyone's credit (lowering, freezing, unfreezing and clearing
 * stay in Settings, where the admin sees the whole line):
 *   - their own known floor (403 `own_floor`), whoever they are;
 *   - a figure at or below what the member holds now, their known grant (409 `not_above`): never a lowering, and a repeated
 *     tap lands once;
 *   - above the community's cap (400 `above_cap`);
 *   - a member who isn't confirmed now (409 `not_confirmed`; a confirmation waiting for its second admin isn't), or with the
 *     confirmation dial off, where a known floor gives nobody anything (409 `dial_off`);
 *   - a member whose credit line or known floor an admin froze (409 `frozen`): the writer's amount would unfreeze it;
 *   - a member working off a debt on the names list (409 `work_off`): the 0 the work-off holds is the names list's, and a
 *     raise over it would take it over.
 * Who: an owner or admin whose role acts now (engine/credit-sight.ts giverSight, from the node's tables at each request); a
 * voucher, a moderator or a member 403 `owners_admins_only`. A standby writes nothing (409 `standby`).
 *
 * The checks and the write are one transaction; the member is told once it has committed.
 *
 * ## Ledger rules (memory ledger-transaction-rules)
 * Nothing here is a Bean: no `accounts` row is read or written, nothing goes through transfer, nothing opens
 * conservingTransaction. The one row written is known_floor_exceptions' (with its log line and the kept notice), by the
 * Settings writer.
 */
import { formatHundredths, isHundredths, word, wordsFor } from '@beanpool/core';
import { confirmationDialOn, isConfirmed, memberKnownGrant, savedCreditCap } from '@beanpool/engine';
import { db } from '../db/db.js';
import { getMember, isVisitorKey } from '../state-engine.js';
import { assertPlainTablesWritable } from '../config/node-role.js';
import { setKnownFloorException } from '../config/known-floor.js';
import { workOffHoldsFloor } from './names-debts.js';
import { giverSight, memberKeyOf } from './credit-sight.js';
import { isFrozen, type TellVoucher, type VoucherNotice } from './vouchers.js';

// A sentence with values in it, in English as a template literal wrote it, marked for the words layer (member-words.ts).
const { t: tr } = wordsFor('en');

export class CreditGiveError extends Error {
    constructor(readonly status: number, readonly code: string, message: string) {
        super(message);
        this.name = 'CreditGiveError';
    }
}

export const CREDIT_GIVE_WORDS = {
    ownersAdminsOnly: word('Only an owner or admin here can raise a member’s known floor.'),
    badBody: word('Name the member and the known floor to raise it to, in Beans to the cent.'),
    notMember: word('Only an active member of this community has a known floor to raise.'),
    ownFloor: word('Another owner or admin raises your own known floor.'),
    dialOff: word('Confirmation on the names list gives no credit in this community, so there is no known floor to raise.'),
} as const;

const B = (c: number) => formatHundredths(c, 'en');
const notConfirmed = (name: string) => tr('@{name} isn’t confirmed on the names list, so they have no known floor to raise.', { name });
const frozenLine = (name: string) => tr('@{name}’s credit line is frozen. An owner or admin unfreezes it in Settings before it can be raised.', { name });
const workingOff = (name: string) => tr('@{name} is working off a debt on the names list, so their known floor stays at 0 Beans until it is paid. An owner or admin can change it in Settings.', { name });
const notAbove = (name: string, now: number) => tr('@{name}’s known floor is {now} Beans already. Pick a higher figure to raise it to.', { name, now: B(now) });
const aboveCap = (cap: number) => tr('A known floor can be at most this community’s cap, {cap} Beans.', { cap: B(cap) });

/** What a raise answers: the member, their known grant before, and after (whole hundredths). Never a balance. */
export interface KnownFloorRaised { memberPubkey: string; was_c: number; knownFloor_c: number }

/**
 * POST /api/credit/known-floor `{ memberPubkey, raiseTo_c }` from `actor`'s own key: every check, then Settings' writer, in
 * one transaction; `tell` once it has committed. Throws CreditGiveError (or the standby's refusal).
 */
export function raiseKnownFloor(actor: string, body: { memberPubkey?: unknown; raiseTo_c?: unknown }, tell?: TellVoucher): KnownFloorRaised {
    assertPlainTablesWritable();
    const sight = giverSight(actor);
    if (sight !== 'owner' && sight !== 'admin') throw new CreditGiveError(403, 'owners_admins_only', CREDIT_GIVE_WORDS.ownersAdminsOnly);
    const member = memberKeyOf(body?.memberPubkey);
    const raiseTo = body?.raiseTo_c;
    if (!member || !isHundredths(raiseTo) || raiseTo <= 0) throw new CreditGiveError(400, 'bad_body', CREDIT_GIVE_WORDS.badBody);
    if (member === actor) throw new CreditGiveError(403, 'own_floor', CREDIT_GIVE_WORDS.ownFloor);
    let notice: VoucherNotice | undefined;
    const out = db.transaction((): KnownFloorRaised => {
        const m = getMember(member);
        if (!m || m.status !== 'active' || m.isTreasury || isVisitorKey(member)) throw new CreditGiveError(404, 'not_member', CREDIT_GIVE_WORDS.notMember);
        if (!confirmationDialOn(db)) throw new CreditGiveError(409, 'dial_off', CREDIT_GIVE_WORDS.dialOff);
        if (!isConfirmed(db, member)) throw new CreditGiveError(409, 'not_confirmed', notConfirmed(m.callsign));
        if (isFrozen(member)) throw new CreditGiveError(409, 'frozen', frozenLine(m.callsign));
        if (workOffHoldsFloor(member)) throw new CreditGiveError(409, 'work_off', workingOff(m.callsign));
        // What they hold now: the known grant the line counts (the exception or the community's floor, within the cap).
        const was = memberKnownGrant(db, member);
        if (raiseTo <= was) throw new CreditGiveError(409, 'not_above', notAbove(m.callsign, was));
        const cap = savedCreditCap(db);
        if (raiseTo > cap) throw new CreditGiveError(400, 'above_cap', aboveCap(cap));
        // Settings' writer, unchanged: the row, its log line, and the member's notice, kept now and told after the commit.
        setKnownFloorException(actor, { memberPubkey: member, amount_c: raiseTo }, (n) => { notice = n; });
        return { memberPubkey: member, was_c: was, knownFloor_c: memberKnownGrant(db, member) };
    })();
    if (notice) tell?.(notice);
    return out;
}
