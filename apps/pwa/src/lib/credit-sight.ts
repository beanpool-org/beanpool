/**
 * Credit on the People list, the web's half (scratch/fable-design/DESIGN-credit-list-fable.md with its amendments 1 and 2;
 * slice C5). The node decides who gives credit and what each giver reads (apps/server routes/credit-sight.ts, every route
 * signed with the member's own key); this file only asks, and keeps what it is told IN MEMORY, for as long as the screen is
 * open. Nothing here reaches localStorage, IndexedDB or a cache (amendment §5.1): a balance on a screen is a look, and a
 * look that outlived the screen would be a balance on a device.
 *
 * The sentences are core's (creditLineSentence, balanceSentence, riskReasonSentence): an app never composes a reason from
 * its figures (amendment 2 §8), so the web and the phone cannot say two things about one person.
 */
import { request, getMyVouching, type MyVouching } from './api';
import { readInviteRole, type InviteRole } from './node-invites';
import { formatDate, word } from '@beanpool/core';
import type { CreditRisk, CreditSight } from '@beanpool/core';

// ── What the node sends ──────────────────────────────────────────────────────────────────────────────────────────

/** A live voucher's budget on a row (engine/vouchers.ts voucherBudgetLine): owners and the credit committee read it, nobody else. */
export interface VoucherBudgetLine {
    noLimit: boolean;
    left_c: number | null;
    held_c: number | null;
    level_c: number | null;
    setLevel_c: number | null;
    runningLow: boolean;
    nothingLeft: boolean;
    askedAt: string | null;
}

/** A voucher's answer about one person: what every giver reads, and what a member reads about themselves. */
export interface CreditPerson {
    memberPubkey: string;
    callsign: string;
    status: 'active' | 'paused';
    own: boolean;
    line_c: number;
    usable_c: number;
    liveOffers: number | null;
    balance_c: number;
    owed_c: number;
    over_c: number;
    paused: boolean;
    canGive: boolean;
    risk: CreditRisk;
    youVouched_c?: number;
    /** An owner's or admin's answer only: what the line is made of, who stands behind it, the freeze. */
    parts?: { known_c: number; room_c: number; earned_c: number; granted_c: number; cap_c: number };
    standsBehind?: {
        confirmedBy: { memberPubkey: string; callsign: string; at: string } | null;
        vouchedBy: { memberPubkey: string; callsign: string; amount_c: number }[];
    };
    frozen?: { credit: boolean; known: boolean };
    voucherBudget?: VoucherBudgetLine;
}

export interface CreditPage { sight: CreditSight; told: string; people: CreditPerson[]; next: string | null }
export interface CreditCardAnswer { sight: CreditSight; told: string; person: CreditPerson }

/** One row of the Vouchers chip (engine/vouchers.ts vouchersChip): the voucher's numbers, their branch health and the top-up offer. */
export interface VoucherChipRow {
    memberPubkey: string;
    callsign: string;
    noLimit?: boolean;
    left: number;
    held: number;
    heldInvites: number;
    vouched: number;
    peopleVouched: number;
    level: number;
    belowZero: number;
    writtenOff: number;
    setLevel_c: number | null;
    runningLow: boolean;
    nothingLeft: boolean;
    askedAt: string | null;
    topUpTo_c: number | null;
    topUpBlocked: 'no_limit' | 'own' | 'paused' | 'frozen' | 'at_most' | null;
}

export interface VouchersChipAnswer { sight: CreditSight; filter: 'vouchers'; vouchers: VoucherChipRow[]; next: null }

export interface LookGroup { actorPubkey: string; callsign: string; day: string; sight: string; people: number }
export interface LookLine { actorPubkey: string; actorCallsign: string; subjectPubkey: string; subjectCallsign: string; surface: string; sight: string; day: string; at: string }

/** A voucher's own Ask for more state (GET /api/vouchers/me `ask`), from the node, never worked out here. */
export type AskState = NonNullable<MyVouching['ask']>

export type CreditFilter = 'all' | 'no_credit' | 'has_offers' | 'mine' | 'vouchers';
/** The chips, in order (the Vouchers chip only where the node answers the committee). */
export const CREDIT_CHIPS: readonly CreditFilter[] = ['all', 'no_credit', 'has_offers', 'mine', 'vouchers'];

// ── Words (the phone says the same: the English is the key) ────────────────────────────────────────────────────────

export const CREDIT_LIST_WORDS = {
    showCredit: word('Show credit'),
    offline: word('Connect to your community to see credit lines.'),
    loading: word('Reading credit lines…'),
    nobody: word('Nobody to show here.'),
    unreadable: word('Credit lines could not be read just now. Try again in a moment.'),
    offlineGive: word('Connect to your community to give credit.'),
    tryAgain: word('Try again'),
    chipAll: word('All'),
    chipNoCredit: word('No credit yet'),
    chipHasOffers: word('Has Offers'),
    chipMine: word('My people'),
    chipVouchers: word('Vouchers'),
    giveCredit: word('Give credit'),
    showMore: word('Show more people'),
    door: word('Give credit to people already here ›'),
    yourBudget: word('Your budget: {left} of {level} left'),
    usedAtOnce: word('Credit you give can be used at once.'),
    cantTakeBack: word('Credit you give can’t be taken back.'),
    sheetTitle: word('Give @{name} credit'),
    close: word('Close'),
    belowZero: word('@{name} is below zero: a credit-line gift or a Decision can help.'),
    cantBeGiven: word('@{name} can’t be given part of a credit line right now.'),
    next: word('Next ›'),
    vouched: word('Vouched {amount} Beans for @{name}.'),
    raisedVouch: word('Raised vouch for @{name} to {total} Beans.'),
    lineNow: word('Their credit line is now {line}.'),
    saving: word('Saving...'),
    confirmTitle: word('Confirm @{name} as known'),
    confirmAdds: word('Adds the known floor: {floor} Beans ›'),
    raiseTitle: word('Raise their known floor'),
    raiseAction: word('Raise to {amount}'),
    raiseLess: word('Lower the amount'),
    raiseMore: word('Raise the amount'),
    raised: word('Raised the known floor for @{name} to {amount} Beans.'),
    youVouched: word('You vouched {amount}'),
    capped: word('Capped at {cap}, the most this community allows.'),
    cardTitle: word('Credit'),
    madeOf: word('Made of: {parts}'),
    partKnown: word('known floor {amount}'),
    partVouched: word('vouched {amount}'),
    partEarned: word('earned {amount}'),
    partGranted: word('granted {amount}'),
    confirmedBy: word('Confirmed by @{name}'),
    vouchedBy: word('Vouched by {list}'),
    lookedAtBy: word('Looked at by: {who}'),
    // Vouchers' budgets (amendment §3.5)
    voucherLine: word('Voucher · {left} of {level} left'),
    ownerLine: word('Owner · no limit'),
    runningLow: word('Running low'),
    nothingLeftToVouch: word('Nothing left to vouch with'),
    heldOnInvites: word('{amount} held on invites'),
    belowZeroCount: word('{below} of {people} below zero · written off {amount}'),
    askedOn: word('Asked for more on {day}'),
    topUp: word('Top up to {level}'),
    theirCard: word('Their card ›'),
    atMost: word('At the most a voucher can hold.'),
    voucherFrozen: word('Their credit line is frozen, so their budget can’t be raised.'),
    voucherPaused: word('Their account is paused, so their budget can’t be raised.'),
    toppedUp: word('{name}’s budget is {level} now: {left} left to vouch with.'),
    noVouchers: word('No vouchers here yet.'),
    // Ask for more (amendment §3.6)
    ask: word('Ask for more'),
    asked: word('Asked on {day} · an owner or the credit committee will see it.'),
    askedWeek: word('You asked on {asked}. You can ask again on {again}.'),
    askFrozen: word('Your credit line is frozen, so your budget can’t be raised until an admin unfreezes it.'),
    askPaused: word('Your account is paused, so your budget can’t be raised while it lasts.'),
    // The log of looks (amendment §5.2)
    looksTitle: word('Who looked at credit'),
    cardUnavailable: word('Credit can’t be read right now.'),
    looksIntro: word('Every time an owner, an admin or a voucher looks at someone’s credit, a line is kept for 12 months. Only owners and admins read this.'),
    looksGroup: word('@{name} · {day} · looked at {people} ›'),
    looksNone: word('Nobody has looked at credit yet.'),
    looksPerson: word('@{name} · {day}'),
    looksBack: word('‹ Back'),
    looksMore: word('Show more'),
} as const;

/** A day as "12 Nov", written in the member's language from core's tables (UTC, the node's own day: the log and the ask both count in it). */
export function dayWords(iso: string | null | undefined): string {
    if (!iso) return '';
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? '' : formatDate(d, 'day-month', { utc: true });
}

// ── Reads and writes (all signed with the member's own key by `request`) ────────────────────────────────────────────────

export interface GiverFacts { role: InviteRole; voucher: boolean; myVouching: MyVouching | null }

/**
 * Whether this member may give credit, from the node's own answers about them (never a guess from a copy of a role):
 * the role it reports, and whether they hold a budget. Neither read records a look. The first list read is the last word:
 * the node answers 403 `not_a_giver` the moment the sight has ended, and the switch goes with it.
 */
export async function readGiver(): Promise<GiverFacts> {
    const [role, vouching] = await Promise.all([
        request<{ role?: unknown }>('GET', '/api/node-admin/me').then((b) => readInviteRole(b?.role)).catch(() => null as InviteRole),
        getMyVouching().catch(() => null),
    ]);
    return { role, voucher: vouching?.voucher === true, myVouching: vouching };
}

export const isOwnerOrAdmin = (role: InviteRole): boolean => role === 'owner' || role === 'admin';
export const mayGive = (g: GiverFacts | null): boolean => !!g && (isOwnerOrAdmin(g.role) || g.voucher);

export function getCreditPeople(opts: { filter: Exclude<CreditFilter, 'vouchers'>; q?: string; after?: string | null }): Promise<CreditPage> {
    const qs = new URLSearchParams({ filter: opts.filter });
    if (opts.q && opts.q.trim()) qs.set('q', opts.q.trim());
    if (opts.after) qs.set('after', opts.after);
    return request<CreditPage>('GET', `/api/credit/people?${qs.toString()}`);
}

export function getCreditPerson(memberPubkey: string): Promise<CreditCardAnswer> {
    return request<CreditCardAnswer>('GET', `/api/credit/people/${encodeURIComponent(memberPubkey)}`);
}

/** The committee's chip. 403 `committee_only` is an answer: there is no chip. It records no look. */
export function getVouchersChip(): Promise<VouchersChipAnswer> {
    return request<VouchersChipAnswer>('GET', '/api/credit/people?filter=vouchers');
}

export function getCreditLooks(opts: { limit?: number; offset?: number; actor?: string; day?: string; member?: string } = {}): Promise<{ groups?: LookGroup[]; looks?: LookLine[] }> {
    const qs = new URLSearchParams();
    if (opts.limit) qs.set('limit', String(opts.limit));
    if (opts.offset) qs.set('offset', String(opts.offset));
    if (opts.actor) qs.set('actor', opts.actor);
    if (opts.day) qs.set('day', opts.day);
    if (opts.member) qs.set('member', opts.member);
    const q = qs.toString();
    return request('GET', `/api/credit/looks${q ? `?${q}` : ''}`);
}

/** Raise a confirmed member's known floor: exactly `{ memberPubkey, raiseTo_c }`, whole hundredths. The node refuses a lower figure. */
export function raiseKnownFloor(memberPubkey: string, raiseTo_c: number): Promise<{ memberPubkey: string; was_c: number; knownFloor_c: number }> {
    return request('POST', '/api/credit/known-floor', { memberPubkey, raiseTo_c });
}

/** Ask for more: one tap, no body at all (a body is refused). */
export function askForMore(): Promise<{ askedAt: string; askAgainAt: string }> {
    return request('POST', '/api/vouchers/ask');
}

/** True when a thrown read means the node says this member gives no credit (any more): no switch. */
export function notAGiver(e: unknown): boolean {
    const err = e as { status?: number; code?: string } | null;
    return err?.status === 403 && (err.code === 'not_a_giver' || err.code === 'committee_only');
}

/**
 * The node's own words for a refusal it made, else ours. Only an error with a `status` came from the node (api.ts refusalError,
 * and the busy answer's 429); a request that got no answer at all throws the browser's own message ("Failed to fetch"), which a
 * member never reads.
 */
export function refusalText(e: unknown, fallback: string): string {
    const err = e as { status?: unknown; message?: unknown } | null;
    return typeof err?.status === 'number' && typeof err.message === 'string' && err.message.length > 0 ? err.message : fallback;
}
