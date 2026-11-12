/**
 * Telling a member when their credit changes (Marty, 12 Nov 2026: "we need to let people know when they have been given
 * credit"). A vouch and a credit-line gift already tell the member they are for (engine/vouchers.ts, engine/credit-gift.ts);
 * these are the other two credit events, told the same way, to the member alone:
 *
 *   - **A confirmation on the names list takes effect** (engine/names-list.ts confirmMember with no second admin needed,
 *     secondConfirmation when the second admin seconds; never the first half of a two-admin confirmation, which gives
 *     nothing yet): who confirmed them and the known grant it gives (the community's known floor, or their exception,
 *     capped), and "Your credit opens when you post an Offer." while they have no live offer (the spending gate's own count,
 *     state-engine.ts liveOfferCount). A work-off confirmation says the work-off instead. Its revocation tells them too.
 *   - **An admin's exception to their known floor** (config/known-floor.ts setKnownFloorException): raised, lowered, set,
 *     frozen, unfrozen, or back to the community's: the new figure and who changed it. A lowering or a freeze says plainly
 *     that nothing spent is taken back (a spend-freeze, never a clawback). Only for a confirmed member with the dial on:
 *     for anyone else an exception changes nothing they can spend, and nothing is said.
 *
 * Never a balance (balances are private): the figure is the member's own known grant. Nobody is told about their own act
 * (an only admin confirming themselves). The community-wide known floor and cap (an owner's change for everyone) tell
 * nobody here. Each notice is kept inside the change's own transaction (keepNotice never throws) and told live and as a
 * push of kind community.notice once it has committed (engine/vouchers.ts tellVoucherNotice), as the voucher notices are.
 */
import { word, wordsFor, formatHundredths } from '@beanpool/core';
import { getMember, memberKnownGrant, confirmationDialOn, isConfirmed } from '@beanpool/engine';
import { db } from '../db/db.js';
import { keepNotice } from './kept-notices.js';
import { liveOfferCount } from '../state-engine.js';
import type { VoucherNotice } from './vouchers.js';

// A sentence with values in it, in English as a template literal wrote it, marked for the words layer (member-words.ts).
const { t: tr } = wordsFor('en');

export const CREDIT_NOTICE_WORDS = {
    title: word('Your credit here'),
    noOffer: word('Your credit opens when you post an Offer.'),
    notTakenBack: word('Beans you already spent are not taken back. If you owe more than your credit now allows, your spending pauses until you are back within it.'),
} as const;

const B = (c: number) => formatHundredths(c, 'en');
const confirmed = (name: string) => tr('@{name} confirmed you on the names list.', { name });
const workOff = (name: string) => tr('@{name} confirmed you on the names list to work off the debt still open on your entry. Until it is paid, your known floor is 0 Beans and every Bean you receive above 0 goes to the Commons.', { name });
const revoked = (name: string) => tr('@{name} revoked your confirmation on the names list, so it gives you no credit now.', { name });
const spendUpTo = (amount: number) => tr('You can now spend up to {amount} Beans.', { amount: B(amount) });
const raised = (name: string, amount: number) => tr('@{name} raised your known floor to {amount} Beans.', { name, amount: B(amount) });
const lowered = (name: string, amount: number) => tr('@{name} lowered your known floor to {amount} Beans.', { name, amount: B(amount) });
const setTo = (name: string, amount: number) => tr('@{name} set your known floor to {amount} Beans.', { name, amount: B(amount) });
const backToCommunity = (name: string, amount: number) => tr('@{name} set your known floor back to this community’s, {amount} Beans.', { name, amount: B(amount) });
const froze = (name: string) => tr('@{name} froze your known floor, so it gives you no credit for now.', { name });
const unfroze = (name: string) => tr('@{name} unfroze your known floor.', { name });

const callsignOf = (pk: string) => getMember(db, pk)?.callsign ?? '';

export type CreditNoticeKind = 'credit_confirmed' | 'credit_confirmation_revoked' | 'credit_known_floor';

/** Inside the change's transaction: the member's kept copy, and what to tell once it has committed. */
function keep(to: string, kind: CreditNoticeKind, by: string, parts: string[], extra: Record<string, unknown>): VoucherNotice {
    const title = CREDIT_NOTICE_WORDS.title;
    const body = parts.join(' ');
    const data = { kind, by, ...extra };
    return { to, title, body, data, id: keepNotice(to, title, body, data) };
}

/**
 * A confirmation that has just taken effect (inside its transaction, after the row and any work-off floor are written):
 * the member's notice, or undefined for an admin's own. `workOffConfirmation`: it confirms them to work off a debt.
 */
export function confirmationNotice(member: string, by: string, workOffConfirmation: boolean): VoucherNotice | undefined {
    if (member === by) return undefined;
    const name = callsignOf(by);
    if (workOffConfirmation) return keep(member, 'credit_confirmed', by, [workOff(name)], { workOff: true, amount: 0 });
    const grant = memberKnownGrant(db, member);
    const parts = [confirmed(name)];
    if (grant > 0) {
        parts.push(spendUpTo(grant));
        if (liveOfferCount(member) < 1) parts.push(CREDIT_NOTICE_WORDS.noOffer);
    }
    return keep(member, 'credit_confirmed', by, parts, { amount: grant });
}

/** A live confirmation just revoked by an admin (inside the revoke's transaction): the member's notice, or none for their own. */
export function revocationNotice(member: string, by: string): VoucherNotice | undefined {
    if (member === by) return undefined;
    return keep(member, 'credit_confirmation_revoked', by, [revoked(callsignOf(by)), CREDIT_NOTICE_WORDS.notTakenBack], { amount: 0 });
}

export type ExceptionChange = 'amount' | 'frozen' | 'unfrozen' | 'cleared';

/** The member's known grant now, for an exception's before and after (0 unless the dial is on and they are confirmed). */
export function knownGrantNow(member: string): number {
    return memberKnownGrant(db, member);
}

/**
 * An admin's exception that changed the row (inside its transaction, after the write): the member's notice, or undefined
 * when it changes nothing they can spend (the dial off, or the member not confirmed). `before`: their known grant before
 * the write (knownGrantNow).
 */
export function exceptionNotice(member: string, by: string, change: ExceptionChange, before: number): VoucherNotice | undefined {
    if (member === by || !confirmationDialOn(db) || !isConfirmed(db, member)) return undefined;
    const name = callsignOf(by);
    const after = memberKnownGrant(db, member);
    const parts: string[] = [];
    if (change === 'frozen') parts.push(froze(name));
    else if (change === 'unfrozen') parts.push(unfroze(name));
    else if (change === 'cleared') parts.push(backToCommunity(name, after));
    else parts.push(after > before ? raised(name, after) : after < before ? lowered(name, after) : setTo(name, after));
    if (after < before || change === 'frozen') parts.push(CREDIT_NOTICE_WORDS.notTakenBack);
    else if (after > 0) {
        parts.push(spendUpTo(after));
        if (liveOfferCount(member) < 1) parts.push(CREDIT_NOTICE_WORDS.noOffer);
    }
    return keep(member, 'credit_known_floor', by, parts, { change, amount: after });
}
