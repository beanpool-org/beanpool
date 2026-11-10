/**
 * The Vouchers block and the profile button, one set of words for the phone and the web (scratch/fable-design/
 * DESIGN-invites-vouching-review-fable.md §3 asks 1, 2, 4 and 5(b), slice I4; Marty, 10 Nov 2026: owners are vouchers by role
 * with no limit and sit first, rows say only what matters, a promised budget waits visibly, and a profile leads to the names
 * list first and the voucher second).
 *
 *   Owners · no limit        one line, then a row per owner: "@Marty · 2 vouched ›" (a card with their people and history,
 *                            no budget controls)
 *   @Rob · 400 left ›        every other voucher
 *   Waiting to join          "Dee Dee · waiting to join · budget 1,000 ›": an invite not used yet that promises a budget.
 *                            The name is sealed in the names list, so the phone opens it; the web says "Name on the phone".
 *   the card's headline      "Vouched 350 to 4 people · 100 in the last 30 days · 1 below zero · written off 0"
 *   the profile's button     Add to the names list → Make a voucher → Voucher · 400 left ›
 *
 * Nothing here reads the node: the callers pass what GET /api/names/vouchers and the trust profile said. No balance figure
 * anywhere: a budget left is not a balance, "below zero" is a count, and a vouch is a gift of credit line, not a Bean.
 */
import { t, tn, formatCount } from './words.js';

/** A promised voucher budget on an invite not used yet (GET /api/names/vouchers `waiting`). */
export interface WaitingVoucherRow {
    entryId: string;
    level: number;
    vouchAmount: number | null;
    madeBy: string;
    madeByCallsign: string;
    madeAt: string;
    expiresAt: string;
}

/** The two sections of the block: owners (no limit), pinned first, and every other voucher, in the node's order. */
export function vouchersBlockSections<T extends { noLimit?: boolean }>(vouchers: readonly T[]): { owners: T[]; others: T[] } {
    return { owners: vouchers.filter((v) => v.noLimit === true), others: vouchers.filter((v) => v.noLimit !== true) };
}

/** The line over the owners: "Owners · no limit". */
export const ownersHeading = (): string => t('Owners · no limit');

/** The link in the invite panel that opens the names list at an entry's own "Invite this person" (owners and admins; the phone's). */
export const inviteFromNamesListWords = (): string => t('Invite someone from the names list ›');

/** The heading over the invites that promise a budget: "Waiting to join". */
export const waitingHeading = (): string => t('Waiting to join');

/** An owner's row: "@Marty · 2 vouched ›". No budget words: an owner has none. */
export function ownerRowWords(callsign: string, peopleVouched: number): string {
    const name = callsign ? `@${callsign}` : t('a voucher');
    return t('{name} · {count} vouched ›', { name, count: formatCount(peopleVouched) });
}

/** Any other voucher's row: "@Rob · 400 left ›". */
export function voucherRowWords(callsign: string, left: number): string {
    const name = callsign ? `@${callsign}` : t('a voucher');
    return t('{name} · {left} left ›', { name, left: formatCount(left) });
}

/**
 * A waiting row: "Dee Dee · waiting to join · budget 1,000 ›". `name` is the name opened from the names list on a phone
 * that holds its key; without it the row says the name is on the phone (the web, or a phone that can't open the list).
 */
export function waitingRowWords(w: Pick<WaitingVoucherRow, 'level'>, name: string | null | undefined): string {
    const who = name?.trim() || t('Name on the phone');
    return t('{who} · waiting to join · budget {level} ›', { who, level: formatCount(w.level) });
}

// ── "+ Make someone a voucher" (slice I5, DESIGN §3 ask 1; Marty, 10 Nov: admins are vouchers only when an owner makes them one) ──
// A sheet with two sections, Admins (anyone with the role, no names-list entry needed: an owner's to make) and Confirmed on
// the names list, then a budget stepper prefilled with the community's default. Both apps, the same words.

export const makeVoucherSheetTitle = (): string => t('Make someone a voucher');
export const makeVoucherAdminsHeading = (): string => t('Admins · no names-list entry needed');
export const makeVoucherConfirmedHeading = (): string => t('Confirmed on the names list');
export const makeVoucherNobody = (): string => t('Nobody to offer: every admin and everyone confirmed on the names list is a voucher already.');

/** A row: "Dee Dee · @dee" where the phone opened the name from the names list, else "@dee". */
export function voucherCandidateWords(callsign: string, name?: string | null): string {
    const handle = callsign ? `@${callsign}` : t('a member');
    const n = name?.trim();
    return n ? t('{name} · {callsign}', { name: n, callsign: handle }) : handle;
}

/** The stepper's line: "Budget: 1,000 Beans". */
export const makeVoucherBudgetWords = (amount: number): string => t('Budget: {amount} Beans', { amount: formatCount(amount) });

/** The button: "Make @dee a voucher". */
export const makeVoucherButtonWords = (who: string): string => t('Make {who} a voucher', { who });

/** After it is done: "@dee is a voucher now, with a budget of 1,000 Beans." */
export const madeVoucherWords = (who: string, amount: number): string =>
    t('{who} is a voucher now, with a budget of {amount} Beans.', { who, amount: formatCount(amount) });

/** The numbers a voucher's card puts first (engine/vouchers.ts voucherSummary). */
export interface VoucherHeadlineSource {
    vouched: number;
    peopleVouched: number;
    vouchedLast30Days?: number;
    belowZero: number;
    writtenOff: number;
}

/** The card's headline: "Vouched 350 to 4 people · 100 in the last 30 days · 1 below zero · written off 0". */
export function voucherCardHeadline(c: VoucherHeadlineSource): string {
    return tn(
        c.peopleVouched,
        'Vouched {amount} to {n} person · {recent} in the last 30 days · {belowZero} below zero · written off {writtenOff}',
        'Vouched {amount} to {n} people · {recent} in the last 30 days · {belowZero} below zero · written off {writtenOff}',
        {
            amount: formatCount(c.vouched),
            recent: formatCount(c.vouchedLast30Days ?? 0),
            belowZero: formatCount(c.belowZero),
            writtenOff: formatCount(c.writtenOff),
        },
    );
}

/**
 * What the trust profile says to an owner or admin about someone else (state-engine.ts, engine/vouchers.ts
 * profileVoucherButton): `add` (not on the names list), `make` (confirmed, and the viewer may make vouchers), `voucher`.
 */
export type ProfileVoucherButton =
    | { state: 'add' }
    | { state: 'make' }
    | { state: 'voucher'; left: number; noLimit: boolean };

/** The button's words, following the person's state. */
export function profileVoucherButtonWords(b: ProfileVoucherButton): string {
    if (b.state === 'add') return t('Add to the names list');
    if (b.state === 'make') return t('Make a voucher');
    return b.noLimit ? t('Voucher · No limit ›') : t('Voucher · {left} left ›', { left: formatCount(b.left) });
}

/** Whether a value from the node is a button state this version knows (an older or newer node may say something else). */
export function isProfileVoucherButton(v: unknown): v is ProfileVoucherButton {
    if (!v || typeof v !== 'object') return false;
    const b = v as Record<string, unknown>;
    if (b.state === 'add' || b.state === 'make') return true;
    return b.state === 'voucher' && typeof b.left === 'number' && typeof b.noLimit === 'boolean';
}
