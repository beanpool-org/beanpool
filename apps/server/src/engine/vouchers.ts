/**
 * Vouchers (scratch/fable-design/DESIGN-invites-and-names-list-amend2-fable.md §2 to §6, Marty's decisions of 5 Nov in §9 to
 * §11): who may vouch, the budget each holds as an append-only allocation ledger, the vouch on an invite and from a
 * member's profile, and the credit line (room) a vouch gives.
 *
 * ## Who is a voucher (`vouchers`)
 * - An owner, by role (`source` 'role'): from the day the role is granted (node-roles.ts grantNodeRole, a role a suspension
 *   held aside and gave back) and, for every owner who never had a budget, at boot (actor `migration:vouchers`). The
 *   budget ends with the role.
 * - An admin only when an owner makes them one (Marty, 10 Nov; DESIGN-invites-vouching-review-fable.md §3 ask 1, slice
 *   I5): from the vouchers block's sheet, with no names-list entry (`source` 'role', actor the owner: the role is the
 *   owner's vouch for them), or from their confirmed entry. Being made admin gives no budget. An admin's budget, whatever
 *   its source, is an owner's to make and to stop (Stop vouching from the card); it ends with the role as a role budget
 *   does. A budget an admin held before this rule stays until an owner stops it: nothing here stops it for them.
 * - A member whose confirmed names-list entry an owner or a credit-committee admin made one (`entry`). It ends on Stop
 *   vouching, a revoked confirmation, or with the account. Making a role voucher one from their entry allocates nothing
 *   and only moves the source to the entry, so losing the role later changes nothing.
 * Being on the list makes nobody a voucher; a moderator isn't one. One budget per member.
 *
 * An owner vouches by the role whatever their budget's source (amend2 §2(b)): while they hold the role, Stop vouching
 * refuses their budget. A revoked entry or a step-back moves an owner's or admin's entry budget back to the role (a
 * `voucher_source` line, entry → role) instead of stopping it, the same left and held. Nobody sets an owner's budget: an
 * owner vouches with no limit (Marty, 9 Nov; OWNER_VOUCH_ACTOR), and what the role gave them waits, whole, for a step down
 * to admin, where it is an admin's budget like any other: an owner may stop it.
 * The credit-committee flag is an admin's: any role change that leaves them no admin (made owner included) clears it, logged.
 *
 * ## The budget (`voucher_allocations`, never updated or deleted)
 * Lines: `grant` +level (an appointment), `top_up` +n and `lower` −n (an owner or committee admin setting the level), `hold`
 * −preset (an invite made with a vouch, ref its code; a profile vouch, ref its room_gifts id), `return` +preset (a held code
 * expired, deleted, or its budget stopped first), `stop` −what is left.
 *   - left: the sum of every line.
 *   - held: the holds whose code is unused, in date and not returned.
 *   - vouched: the vouches that landed (room_gifts of kind 'vouch' from this voucher).
 * No total is stored anywhere. A level is what the voucher has in hand, left + held, and every writer checks in its own
 * transaction that it is never above VOUCHER_BUDGET_MAX (2,000). Setting a level writes the difference: `top_up` to raise,
 * `lower` to lower, never below what is held, and never touching room already given. A hold whose code lapsed counts as
 * back in what is left from that moment, before its `return` line is written (the hourly prune, or the voucher's next
 * budget write), so no read or check waits for the prune.
 *
 * Freezes (the design §5.2, kept by amendment 1 §5.2): while a voucher's credit line or known floor is frozen, nothing
 * more comes out of their budget (no vouch, and a held code's vouch goes back to the budget at the redeem) and it is never
 * raised; it may be lowered or stopped, and room already given stays given. Each change the committee makes to a budget
 * (made, set to a level, stopped) is a notice to its voucher (§10.2), kept and pushed as the other notices are.
 *
 * ## The vouch
 * A preset (core VOUCH_PRESETS), never another amount. One voucher's vouches for one person: a first vouch, then raises,
 * VOUCH_MAX (100) in all, each raise a further hold and room_gifts row on the same pair (§9 rule 1). At most
 * VOUCHES_PER_PERSON (3) vouchers' vouches count for one person (rule 2), 300 in all.
 * An owner (Marty, 9 Nov) vouches with no budget limit, from OWNER_VOUCH_PRESETS (200 and 500 too, nobody else's), up to
 * 500 for one person; their hold is recorded (OWNER_VOUCH_ACTOR) and never drawn from a budget. A person an owner vouched for
 * may hold 500 in all, and the three-vouchers rule never refuses an owner's vouch. Never from a profile for a member below zero now,
 * read from the stored balance (rule 3), nor for a member whose credit line or known floor an admin froze (Marty's Q5 of
 * 12 Nov, DESIGN-credit-list-fable.md §6: a vouch then bought nothing until an unfreeze, or gave back part of a line the
 * freeze took away), refused with the sentence a credit-line gift to them gets. A vouch on an invite lands at the redeem,
 * in its transaction (the joiner is new, so it is their first, and it is that voucher's one vouch for them); an offline
 * ticket never carries one.
 *
 * ## Ledger rules (memory ledger-transaction-rules)
 * Nothing here is a Bean: no `accounts` row, no transfer, no conservingTransaction. Every writer is a plain db.transaction
 * on a main server with Beans on. The departure hook runs inside the departure's own conservingTransaction and never
 * throws (a savepoint, caught): the Commons' row stays the record of truth, the stamps the committee's view of it.
 */
import crypto from 'node:crypto';
import {
    VOUCH_MAX, VOUCHES_PER_PERSON, VOUCHER_BUDGET_MAX, VOUCHER_BUDGET_DEFAULT, MEMBER_GIFT_DEFAULT, VOUCH_PRESETS,
    isVouchPreset, isOwnerVouchPreset, isBudgetLevel, isMemberGiftSetting, vouchPresetsFor, vouchMaxFor, personVouchMax, word, wordsFor, formatHundredths,
    runningLow, nothingLeft, topUpTarget,
} from '@beanpool/core';
import { getMember, isVisitorKey } from '@beanpool/engine';
import { db } from '../db/db.js';
import { AMOUNT_C_REQUIRED, AMOUNT_C_REQUIRED_TEXT, carriesOldMoneyKey } from '../money-body.js';
import { getNodeRole, assertPlainTablesWritable } from '../config/node-role.js';
import { assertBeansOn, getProfileSwitches, getNodeProfile } from '../config/node-profile.js';
import { isNodeOwner, isNodeAdmin, heldPrivilegedRole, NODE_ROLE_ACTS } from './node-roles.js';
import { keepNotice, keptNoticeDetails, markKeptNoticesSeen, type KeptNoticePushOptions } from './kept-notices.js';
import { markPushNoticesSeenWhere } from './push-notices.js';
import { ownCoreLockRow } from '../config/core-settings.js';

// A refusal with values in it, in English as a template literal wrote it, marked for the way out (member-words.ts).
const { t: tr, tn: trn } = wordsFor('en');

export const VOUCHER_BUDGET_KEY = 'voucher_budget';
export const MEMBER_GIFT_KEY = 'member_gift';
/** The actor of the boot's grants to owners and admins who never had a budget. */
export const VOUCHERS_MIGRATION_ACTOR = 'migration:vouchers';
/** The actor of the first owner's grant, made by the community's claim code. */
export const CLAIM_ACTOR = 'node:claim';
/**
 * The actor of a `hold` an owner made (Marty, 9 Nov: owners vouch with no budget limit). The line records the vouch as any
 * hold does (whose budget: member_pubkey; on whom: ref, the room_gifts id or the invite code; how much: amount), and no budget
 * sum counts it, nor its `return`: an owner's vouch never draws a budget down, so the budget an owner holds by the role is
 * whole if they step down to admin. The other holds' actor is the voucher's own key, which member_pubkey already says.
 */
export const OWNER_VOUCH_ACTOR = 'role:owner';

/** An invite lives 30 days (engine/invites.ts redeemInvite): a hold on a code older than that is back in the budget. */
const INVITE_LIFE_MS = 30 * 24 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

export class VoucherError extends Error {
    constructor(readonly status: number, readonly code: string, message: string, readonly extra?: Record<string, unknown>) {
        super(message);
        this.name = 'VoucherError';
    }
}

export const VOUCHER_WORDS = {
    notAVoucher: word('You aren’t a voucher here, so you can’t vouch for anyone. An owner or the credit committee makes vouchers.'),
    badAmount: word('A vouch is 25, 50, 75 or 100 Beans.'),
    badOwnerAmount: word('An owner’s vouch is 25, 50, 75, 100, 200 or 500 Beans.'),
    ownerAmountOnly: word('Only an owner can vouch 200 or 500 Beans.'),
    ownVouch: word('You can’t vouch for yourself.'),
    vouchOrRaise: word('Send either an amount to vouch or a total to raise to, not both.'),
    notMember: word('Only an active member of this community can be vouched for.'),
    committeeOnly: word('Only an owner or an admin on the credit committee makes vouchers and sets their budgets.'),
    ownBudget: word('Another owner or credit committee admin makes you a voucher or sets your budget.'),
    notConfirmed: word('Only a confirmed person on the names list can be made a voucher.'),
    awaitingSecond: word('This confirmation waits for a second admin. Make them a voucher once it is confirmed.'),
    badLevel: word('A budget is 100 to 2,000 Beans, in steps of 100.'),
    notAdmin: word('Only an admin can be put on the credit committee. Every owner is on it already.'),
    adminOwnerOnly: word('Only an owner makes an admin a voucher or stops an admin’s budget.'),
    notAdminToMake: word('Only an admin can be made a voucher without a names-list entry. Anyone else needs a confirmed name on the names list.'),
    ownerOnly: word('Only an owner changes this.'),
    badGift: word('A member’s credit-line gift is 0 (off) to 100 Beans.'),
    giftInCoreSettings: word('Members giving part of their credit line is a core setting: an owner changes it in Settings, Core settings, which asks for their proof once the core settings are locked. Nothing in this request was saved.'),
    voucherEnded: word('The vouch on this invite ended before you joined; you start with no credit line'),
    frozen: word('Your credit line is frozen, so you can’t vouch from your budget until an admin unfreezes it.'),
    noticeTitle: word('Your budget to vouch from'),
    noticeStopped: word('Your budget to vouch from was stopped. The credit lines you gave stay with the people you gave them to.'),
    askTitle: word('A voucher asks for more'),
    askOwner: word('You vouch as an owner, with no limit, so there is no budget to ask for.'),
    askFrozen: word('Your credit line is frozen, so your budget can’t be raised until an admin unfreezes it.'),
    askPaused: word('Your account is paused, so your budget can’t be raised while it lasts.'),
    askNoBody: word('Ask for more takes no words and no amount: an owner or the credit committee picks the level.'),
} as const;

/** A figure (whole hundredths) in these English words. */
const B = (c: number) => formatHundredths(c, 'en');
const notEnough = (left: number, amount: number) => tr('You have {left} Beans of budget left, so you can’t vouch {amount}. Pick a smaller vouch, or ask an owner for more.', { left: B(left), amount: B(amount) });
const alreadyVouched = (name: string) => tr('You’ve already vouched for @{name}.', { name });
const threeVouches = (name: string) => tr('@{name} has three vouches.', { name });
const belowZero = (name: string) => tr('@{name} is below zero: a credit-line gift or a Decision can help.', { name });
/**
 * A member whose credit line can't grow now: ONE sentence for a credit-line gift to a paused or frozen member
 * (engine/credit-gift.ts) and a vouch for a frozen one (Q5), so the two refusals never drift apart.
 */
export const cantBeGivenCredit = (name: string) => tr('@{name} can’t be given part of a credit line right now.', { name });
const noVouchYet = (name: string) => tr('You haven’t vouched for @{name} yet, so there is no vouch to raise.', { name });
const raiseNotAbove = (name: string, total: number) => tr('You’ve vouched {total} Beans for @{name} already. Pick a higher total to raise it to.', { name, total: B(total) });
const overPerson = (name: string, total: number, max: number) => tr('@{name} has {total} Beans of vouches already, and one person’s vouches come to {max} at most.', { name, total: B(total), max: B(max) });
const alreadyVoucher = (name: string) => tr('@{name} is a voucher already.', { name });
const notVoucher = (name: string) => tr('@{name} isn’t a voucher.', { name });
const ownerVoucher = (name: string) => tr('@{name} vouches as an owner while they hold that role, with no limit, so there is no budget to stop or set.', { name });
const ownerNoLimit = (name: string) => tr('@{name} is an owner: owners vouch with no limit, so there is no budget to set.', { name });
const belowHeld = (name: string, held: number) => tr('@{name} has {held} Beans held on invites not used yet, so their budget can’t go below that.', { name, held: B(held) });
const overCeiling = () => tr('A voucher has at most {max} Beans in hand, left and held together.', { max: B(VOUCHER_BUDGET_MAX) });
const openDebt = (amount: number) => tr('The person on this entry left owing the Commons {amount} Beans, and that debt is still open. Settle it first: they pay it back, work it off, or the community forgives it.', { amount: B(amount) });
const raisePaused = (name: string) => tr('@{name}’s account is paused, so their budget can’t be raised while it lasts. You can still lower it.', { name });
const raiseFrozen = (name: string) => tr('@{name}’s credit line is frozen, so their budget can’t be raised until an admin unfreezes it. You can still lower it.', { name });
const noticeMade = (level: number) => tr('You’re a voucher now: you have a budget of {level} Beans to vouch for people, up to {max} each.', { level: B(level), max: B(VOUCH_MAX) });
const noticeRaised = (level: number, left: number) => tr('Your budget to vouch from was raised to {level} Beans. You have {left} of it left to vouch with.', { level: B(level), left: B(left) });
/** A day as the refusal says it, "12 Nov" (UTC); the apps get the moment itself beside it and say it in their own language. */
const dayOf = (iso: string) => new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' });
const askedThisWeek = (asked: string, again: string) => tr('You asked on {asked}. You can ask again on {again}.', { asked: dayOf(asked), again: dayOf(again) });
const askAsks = (name: string) => tr('@{name} asks for a bigger budget to vouch from.', { name });
const askLeft = (left: number, level: number) => tr('They have {left} of {level} Beans left.', { left: B(left), level: B(level) });
const askBranch = (vouched: number, people: number, below: number, writtenOff: number, pct: number, inside: number) => trn(people,
    'Vouched {vouched} to {n} person: {below} below zero, written off {writtenOff} ({pct}%), {inside} trading only inside their own circle.',
    'Vouched {vouched} to {n} people: {below} below zero, written off {writtenOff} ({pct}%), {inside} trading only inside their own circle.',
    { vouched: B(vouched), below, writtenOff: B(writtenOff), pct, inside });
const askVoucherAge = (days: number) => trn(days, 'A voucher for {n} day.', 'A voucher for {n} days.');
const askConfirmedAge = (days: number) => trn(days, 'Confirmed for {n} day.', 'Confirmed for {n} days.');
const askNotConfirmed = () => tr('Not confirmed on the names list.');
const noticeLowered = (level: number, left: number) => tr('Your budget to vouch from was lowered to {level} Beans. You have {left} of it left to vouch with.', { level: B(level), left: B(left) });

const now = () => new Date().toISOString();
const newId = () => crypto.randomBytes(16).toString('hex');
const callsignOf = (pk: string | null | undefined): string => (pk ? getMember(db, pk)?.callsign ?? '' : '');

// ── The settings ─────────────────────────────────────────────────────────────────────────────────────────────────

function configRow(key: string): string | null {
    return (db.prepare('SELECT value FROM node_config WHERE key = ?').get(key) as { value: string | null } | undefined)?.value ?? null;
}

/** The voucher_budget row as the setting it is: 100 to 2,000 in 100s; no row, or one that isn't a setting, the default (1,000). */
export function voucherBudgetFromRow(raw: string | null): number {
    const n = raw === null ? NaN : Number(raw);
    return isBudgetLevel(n) ? n : VOUCHER_BUDGET_DEFAULT;
}

/** What a voucher's appointment is prefilled with: the owner's setting, 100 to 2,000 in 100s (no row: 1,000). */
export function voucherBudgetSetting(): number {
    return voucherBudgetFromRow(configRow(VOUCHER_BUDGET_KEY));
}

/** The member_gift row as the setting it is: 0 (off) to 100; no row, or one that isn't a setting, the default (100). */
export function memberGiftFromRow(raw: string | null): number {
    const n = raw === null ? NaN : Number(raw);
    return isMemberGiftSetting(n) ? n : MEMBER_GIFT_DEFAULT;
}

/** The most of their credit line a member may give at once (slice G1): the owner's setting, 0 (off) to 100. */
export function memberGiftSetting(): number {
    return memberGiftFromRow(configRow(MEMBER_GIFT_KEY));
}

/**
 * Writes the voucher_budget setting (the default removes the row) and its `budget_setting` line in the known floor's log,
 * inside the caller's transaction.
 */
export function saveVoucherBudgetSetting(actor: string, before: number, value: number, at?: string): void {
    if (value === VOUCHER_BUDGET_DEFAULT) db.prepare('DELETE FROM node_config WHERE key = ?').run(VOUCHER_BUDGET_KEY);
    else db.prepare('INSERT INTO node_config (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(VOUCHER_BUDGET_KEY, String(value));
    logLine(actor, 'budget_setting', null, before, value, at);
}

/**
 * Writes the member_gift setting (the default removes the row) and its `gift_setting` line in the known floor's log,
 * inside the caller's transaction. Its one caller is How this community works (Core settings,
 * config/community-shape-write.ts), which stamps the line `at` as its own log's line, so the two read as one change: a
 * Core setting is changed nowhere else (setVoucherSettings refuses it).
 */
export function writeMemberGiftSetting(actor: string, before: number, value: number, at?: string): void {
    if (value === MEMBER_GIFT_DEFAULT) db.prepare('DELETE FROM node_config WHERE key = ?').run(MEMBER_GIFT_KEY);
    else db.prepare('INSERT INTO node_config (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(MEMBER_GIFT_KEY, String(value));
    logLine(actor, 'gift_setting', null, before, value, at);
}

export function voucherSettings() {
    return {
        voucherBudget: voucherBudgetSetting(), memberGift: memberGiftSetting(),
        presets: [...VOUCH_PRESETS], vouchMax: VOUCH_MAX, vouchesPerPerson: VOUCHES_PER_PERSON, budgetMax: VOUCHER_BUDGET_MAX,
        ownerPresets: [...vouchPresetsFor(true)], ownerVouchMax: vouchMaxFor(true), personMax: personVouchMax(false), personMaxWithOwner: personVouchMax(true),
    };
}

// ── The log every owner and admin reads (known_floor_log, config/known-floor.ts) ─────────────────────────────────────

function logLine(actor: string, action: string, member: string | null, oldValue: unknown, newValue: unknown, at: string = now()): void {
    db.prepare('INSERT INTO known_floor_log (id, actor_pubkey, action, member_pubkey, old_value, new_value, at) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(newId(), actor, action, member, oldValue == null ? null : String(oldValue), newValue == null ? null : String(newValue), at);
}

// ── Who ──────────────────────────────────────────────────────────────────────────────────────────────────────────

interface VoucherRow {
    member_pubkey: string; source: 'role' | 'entry'; entry_id: string | null; made_by: string; made_at: string;
    stopped_at: string | null; stopped_by: string | null; stop_reason: string | null;
}

function voucherRow(pk: string): VoucherRow | undefined {
    return db.prepare('SELECT * FROM vouchers WHERE member_pubkey = ?').get(pk) as VoucherRow | undefined;
}

/** A voucher now: a live row, on a member whose account is active here. */
function liveVoucher(pk: string): VoucherRow | undefined {
    const row = voucherRow(pk);
    if (!row || row.stopped_at) return undefined;
    const m = getMember(db, pk);
    return m && m.status === 'active' && !isVisitorKey(db, pk) ? row : undefined;
}

export function isVoucher(pk: string): boolean {
    return !!liveVoucher(pk);
}

/**
 * Their credit line frozen by an admin (members.credit_frozen), or their known floor by an exception
 * (known_floor_exceptions.frozen): nothing more out of their budget while it lasts, no raise of it, and room already given
 * stays given (the design §5.2 "Freezes", which amendment 1 §5.2 keeps for vouchers; §5.6 step 3 for a top-up). Read for
 * the one vouched for too (Q5, {@link vouchFromProfile}), and for a known floor raised from the apps (engine/credit-give.ts).
 */
export function isFrozen(pk: string): boolean {
    return !!db.prepare(`SELECT 1 FROM members m WHERE m.public_key = ? AND (COALESCE(m.credit_frozen, 0) = 1
        OR EXISTS (SELECT 1 FROM known_floor_exceptions e WHERE e.member_pubkey = m.public_key AND e.frozen = 1))`).get(pk);
}

/** An owner, or an admin an owner put on the credit committee, whose role acts: who makes vouchers and sets budgets. */
export function isOnCreditCommittee(pk: string): boolean {
    if (!pk) return false;
    if (isNodeOwner(pk)) return true;
    if (!isNodeAdmin(pk, false)) return false;
    return (db.prepare('SELECT credit_committee FROM members WHERE public_key = ?').get(pk) as { credit_committee: number | null } | undefined)?.credit_committee === 1;
}

/** The role this key holds and acts with ('owner' | 'admin' | 'moderator'), or null. */
function actingRole(pk: string): string | null {
    return (db.prepare(`SELECT nr.role FROM node_roles nr JOIN members m ON m.public_key = nr.member_pubkey
                        WHERE nr.member_pubkey = ? AND ${NODE_ROLE_ACTS}`).get(pk) as { role: string } | undefined)?.role ?? null;
}

// ── The budget ───────────────────────────────────────────────────────────────────────────────────────────────────

export interface Budget {
    /**
     * The sum of every allocation line, and a hold whose code lapsed (unused past its 30 days, or gone) counted back from
     * that moment: its `return` line comes with the hourly prune or the voucher's next budget write, which leaves this
     * the same. Never what a voucher can't use: a vouch checks it, and a read shows it, without waiting for the prune.
     */
    left: number;
    /** On invites not used yet and in date. An owner's holds are in neither `left` nor `held` (OWNER_VOUCH_ACTOR). */
    held: number;
    heldInvites: number;
    /** The vouches that landed. */
    vouched: number;
    peopleVouched: number;
    /** What the voucher has in hand: left + held, never above 2,000. */
    level: number;
}

const OPEN_HOLD = `h.kind = 'hold'
    AND NOT EXISTS (SELECT 1 FROM room_gifts g WHERE g.id = h.ref)
    AND NOT EXISTS (SELECT 1 FROM voucher_allocations r WHERE r.member_pubkey = h.member_pubkey AND r.kind = 'return' AND r.ref = h.ref)`;
/** An open hold whose code lapsed (unused and past its 30 days) or is gone, its `return` not written yet. `?`: the cutoff. */
const LAPSED_HOLD = `${OPEN_HOLD}
    AND NOT EXISTS (SELECT 1 FROM invite_codes ic WHERE ic.code = h.ref AND (ic.used_by IS NOT NULL OR ic.created_at > ?))`;

const lifeCutoff = (at: number) => new Date(at - INVITE_LIFE_MS).toISOString();

/** A line of the budget `a`: every line but an owner's hold (OWNER_VOUCH_ACTOR) and its `return`, which share its ref. */
const BUDGET_LINE = (a: string) => `NOT EXISTS (SELECT 1 FROM voucher_allocations o WHERE o.member_pubkey = ${a}.member_pubkey
    AND o.kind = 'hold' AND o.actor = '${OWNER_VOUCH_ACTOR}' AND o.ref = ${a}.ref)`;

export function budgetOf(pk: string, at = Date.now()): Budget {
    const cutoff = lifeCutoff(at);
    const lines = (db.prepare(`SELECT COALESCE(SUM(a.amount_c), 0) AS n FROM voucher_allocations a WHERE a.member_pubkey = ? AND ${BUDGET_LINE('a')}`).get(pk) as { n: number }).n;
    const lapsed = (db.prepare(`SELECT COALESCE(SUM(-h.amount_c), 0) AS n FROM voucher_allocations h WHERE h.member_pubkey = ? AND h.actor != '${OWNER_VOUCH_ACTOR}' AND ${LAPSED_HOLD}`).get(pk, cutoff) as { n: number }).n;
    const left = lines + lapsed;
    const held = db.prepare(`SELECT COALESCE(SUM(-h.amount_c), 0) AS n, COUNT(*) AS c FROM voucher_allocations h
        JOIN invite_codes ic ON ic.code = h.ref
        WHERE h.member_pubkey = ? AND h.actor != '${OWNER_VOUCH_ACTOR}' AND ${OPEN_HOLD} AND ic.used_by IS NULL AND ic.created_at > ?`).get(pk, cutoff) as { n: number; c: number };
    const vouched = db.prepare(`SELECT COALESCE(SUM(amount_c), 0) AS n, COUNT(DISTINCT to_pubkey) AS c FROM room_gifts
        WHERE from_pubkey = ? AND kind = 'vouch'`).get(pk) as { n: number; c: number };
    return { left, held: held.n, heldInvites: held.c, vouched: vouched.n, peopleVouched: vouched.c, level: left + held.n };
}

function addLine(pk: string, kind: 'grant' | 'top_up' | 'lower' | 'hold' | 'return' | 'stop', amount: number, actor: string, ref: string | null = null, at: string = now()): void {
    db.prepare('INSERT INTO voucher_allocations (id, member_pubkey, kind, amount_c, actor, ref, at) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(newId(), pk, kind, amount, actor, ref, at);
}

/** Inside a writer's transaction: the level after it, refused above the ceiling (the allocation's own transaction, §10). */
function assertUnderCeiling(pk: string): void {
    if (budgetOf(pk).level > VOUCHER_BUDGET_MAX) throw new VoucherError(409, 'over_ceiling', overCeiling());
}

/**
 * A `return` for every hold on a code that lapsed (unused and past its 30 days) or is gone, for one voucher or all: what
 * they held comes back to what is left. A main server's own: the hourly invite prune (engine/writer-bounds.ts) and every
 * budget writer first, in its transaction, so a level is never set over a hold about to come back. Returns how many.
 */
export function returnLapsedHolds(pk: string | null = null, at = Date.now()): number {
    if (getNodeRole() !== 'primary') return 0;
    const lapsed = db.prepare(`SELECT h.member_pubkey AS pk, h.ref AS ref, -h.amount_c AS amount_c FROM voucher_allocations h
        WHERE ${LAPSED_HOLD} AND (? IS NULL OR h.member_pubkey = ?)`)
        .all(lifeCutoff(at), pk, pk) as { pk: string; ref: string; amount_c: number }[];
    db.transaction(() => { for (const l of lapsed) addLine(l.pk, 'return', l.amount_c, 'node', l.ref); })();
    return lapsed.length;
}

/**
 * Ends a budget, inside the caller's transaction: every open hold back (the codes stay valid and carry nothing), one `stop`
 * line for what is left, and the row stopped. Room already given stays given.
 */
function stopBudget(pk: string, actor: string, reason: 'role_lost' | 'stopped' | 'revoked' | 'departed'): void {
    const open = db.prepare(`SELECT h.ref AS ref, -h.amount_c AS amount_c FROM voucher_allocations h WHERE h.member_pubkey = ? AND ${OPEN_HOLD}
          AND NOT EXISTS (SELECT 1 FROM invite_codes ic WHERE ic.code = h.ref AND ic.used_by IS NOT NULL)`).all(pk) as { ref: string; amount_c: number }[];
    for (const o of open) addLine(pk, 'return', o.amount_c, actor, o.ref);
    const { left } = budgetOf(pk);
    if (left > 0) addLine(pk, 'stop', -left, actor);
    db.prepare('UPDATE vouchers SET stopped_at = ?, stopped_by = ?, stop_reason = ? WHERE member_pubkey = ? AND stopped_at IS NULL').run(now(), actor, reason, pk);
    logLine(actor, 'voucher_stopped', pk, left, reason);
}

/** A new budget on a member with no live one, inside the caller's transaction: the row (made again after a stop) and the grant. */
function startBudget(pk: string, source: 'role' | 'entry', entryId: string | null, amount: number, actor: string): void {
    const at = now();
    db.prepare(`INSERT INTO vouchers (member_pubkey, source, entry_id, made_by, made_at) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(member_pubkey) DO UPDATE SET source = excluded.source, entry_id = excluded.entry_id, made_by = excluded.made_by,
            made_at = excluded.made_at, stopped_at = NULL, stopped_by = NULL, stop_reason = NULL`).run(pk, source, entryId, actor, at);
    addLine(pk, 'grant', amount, actor);
    assertUnderCeiling(pk);
    logLine(actor, 'budget_grant', pk, source, amount);
}

/** Runs `fn` in a savepoint and never throws: a hook inside a role change or a departure, which must go on whatever happens here. */
function safely(what: string, fn: () => void): void {
    try {
        db.transaction(fn)();
    } catch (e) {
        console.error(`[Vouchers] ⚠️ Could not ${what}:`, (e as Error)?.message || e);
    }
}

// ── Telling the voucher (§10.2: each change the committee makes to a budget, a notice to its voucher) ──────────────────

/** A notice to a voucher about their budget, kept for them (the web app shows the ones not seen yet when it opens). */
export interface VoucherNotice { to: string; title: string; body: string; id: string | null; data: Record<string, unknown> }
/** How a route tells a writer's notice, once the writer's transaction has committed. */
export type TellVoucher = (notice: VoucherNotice) => void;
export interface VoucherNoticeHooks {
    broadcast: (event: any, recipients?: string[]) => unknown;
    dispatchPushNotification: (targets: string[], actor: string, title: string, body: string, data: Record<string, any>, category: 'marketplace', kind: 'community.notice',
        rehearsal?: boolean, options?: KeptNoticePushOptions) => unknown;
}

/** Inside a committee writer's transaction: the voucher's kept copy (keepNotice never throws; its id null when not kept). */
function keepVoucherNotice(pk: string, change: 'made' | 'raised' | 'lowered' | 'stopped', body: string, level: number): VoucherNotice {
    const title = VOUCHER_WORDS.noticeTitle;
    const data = { kind: 'voucher_budget', change, level };
    return { to: pk, title, body, data, id: keepNotice(pk, title, body, data) };
}

/**
 * After the commit: live to the voucher's own sockets with their kept copy's id, and a push of kind community.notice
 * (its fixed line; the words are in the push's details), as the other kept notices are (engine/unfunded-pledges.ts tell).
 * Never throws: the kept copy is the record.
 */
export function tellVoucherNotice(n: VoucherNotice, hooks: VoucherNoticeHooks): void {
    try {
        hooks.broadcast({ type: 'system_announcement', title: n.title, body: n.body, severity: 'info', ...n.data, ...(n.id ? { noticeId: n.id } : {}) }, [n.to]);
    } catch (e) {
        console.warn('[Vouchers] A live notice failed:', (e as Error)?.message || e);
    }
    try {
        // Its push notice names the kept copy: the alert acknowledged takes the bell's row off, and the other way round.
        hooks.dispatchPushNotification([n.to], 'SYSTEM', n.title, n.body, n.data, 'marketplace', 'community.notice', false, keptNoticeDetails([n]));
    } catch (e) {
        console.warn('[Vouchers] A push failed:', (e as Error)?.message || e);
    }
}

// ── Role vouchers ────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * After a member's node role changed (granted, revoked, demoted, dropped by a suspension, a removal or their account
 * deleted, given back after a suspension), inside the change's transaction where there is one: an owner with no live
 * budget gets one (the community's setting, actor who granted it); an admin keeps what they hold and is given nothing
 * (an owner makes an admin a voucher by hand: Marty, 10 Nov, slice I5), so an owner stepping down to admin keeps the
 * budget the role gave them until an owner stops it; anyone else loses a budget whose source is the role. The place on
 * the credit committee is an admin's (§5.4: the flag clears with the role): any change that leaves them
 * no admin clears it with a `committee` line, a promotion to owner too (an owner is on it by role), so a later demotion
 * back to admin never brings it back unasked. Never throws; nothing on a standby or with Beans off.
 */
export function vouchingAfterRoleChange(pk: string, actor: string | undefined): void {
    if (getNodeRole() !== 'primary') return;
    safely('follow a role change', () => {
        const role = actingRole(pk);
        const by = !actor ? 'SYSTEM' : actor.startsWith('claim:') ? CLAIM_ACTOR : actor;
        if (role !== 'admin') {
            const committee = db.prepare('UPDATE members SET credit_committee = 0 WHERE public_key = ? AND credit_committee = 1').run(pk);
            if (committee.changes > 0) logLine(by, 'committee', pk, 'on', 'off');
        }
        if (role === 'owner') {
            if (!liveVoucher(pk) && getProfileSwitches().beans) startBudget(pk, 'role', null, voucherBudgetSetting(), by);
            return;
        }
        if (role === 'admin') return;
        const row = voucherRow(pk);
        if (row && !row.stopped_at && row.source === 'role') {
            const status = (db.prepare('SELECT status FROM members WHERE public_key = ?').get(pk) as { status: string } | undefined)?.status;
            stopBudget(pk, by, status === 'pruned' ? 'departed' : 'role_lost');
        }
    });
}

/**
 * At boot on a main server with Beans on, the catch-all for a role changed outside grantNodeRole (the shell's claim or
 * recover, which write node_roles on their own connection): every owner whose role acts and who has no LIVE budget gets
 * one, actor `migration:vouchers` (never an admin: an owner makes an admin a voucher by hand, slice I5); and anyone on the
 * credit committee whose acting role is not admin leaves it, with its `committee` line, as vouchingAfterRoleChange does
 * inside the server. A stopped budget on a current owner always comes from before the role they hold now (nothing in the
 * server stops an owner's while they hold it), so it is granted.
 */
export function grantMissingRoleBudgets(): number {
    if (getNodeRole() !== 'primary' || !getProfileSwitches().beans) return 0;
    const keys = (db.prepare(`SELECT nr.member_pubkey AS pk FROM node_roles nr JOIN members m ON m.public_key = nr.member_pubkey
        WHERE nr.role = 'owner' AND ${NODE_ROLE_ACTS} AND NOT EXISTS (SELECT 1 FROM vouchers v WHERE v.member_pubkey = nr.member_pubkey AND v.stopped_at IS NULL)
        ORDER BY nr.granted_at ASC, nr.member_pubkey ASC`).all() as { pk: string }[]).map((r) => r.pk);
    const amount = voucherBudgetSetting();
    const committee = (db.prepare('SELECT public_key AS pk FROM members WHERE credit_committee = 1').all() as { pk: string }[])
        .map((r) => r.pk).filter((pk) => actingRole(pk) !== 'admin');
    db.transaction(() => {
        for (const pk of committee) {
            db.prepare('UPDATE members SET credit_committee = 0 WHERE public_key = ? AND credit_committee = 1').run(pk);
            logLine(VOUCHERS_MIGRATION_ACTOR, 'committee', pk, 'on', 'off');
        }
        for (const pk of keys) startBudget(pk, 'role', null, amount, VOUCHERS_MIGRATION_ACTOR);
    })();
    return keys.length;
}

// ── Writers for the committee (routes/names-list.ts: signed with the member's own key) ──────────────────────────────

/** Every committee writer's guards, before anything is read: a main server, Beans on, an owner or committee admin. */
function assertCommittee(actor: string): void {
    assertPlainTablesWritable();
    assertBeansOn();
    if (!isOnCreditCommittee(actor)) throw new VoucherError(403, 'committee_only', VOUCHER_WORDS.committeeOnly);
}

function memberKey(raw: unknown): string {
    const pk = typeof raw === 'string' ? raw.toLowerCase() : '';
    if (!/^[0-9a-f]{64}$/.test(pk)) throw new VoucherError(400, 'bad_member', "A member's key is 64 hexadecimal characters.");
    return pk;
}

/**
 * An admin's budget is an owner's to make and to stop (Marty, 10 Nov; slice I5): refused for anyone else. An owner's is
 * no one's (they vouch by the role); anyone else's, the committee's.
 */
function assertMayMakeOrStop(actor: string, pk: string): void {
    if (heldPrivilegedRole(pk) === 'admin' && !isNodeOwner(actor)) throw new VoucherError(403, 'owner_only', VOUCHER_WORDS.adminOwnerOnly);
}

/**
 * Make a voucher (POST /api/names/vouchers): `{ entryId, amount_c? }`, the member confirmed against the entry; or
 * `{ memberPubkey, amount_c? }`, an admin with no names-list entry (an owner only: the role is the owner's vouch for them,
 * so the budget's source is the role and it ends with it). A budget of `amount` (100 to 2,000 in 100s; the community's
 * setting when left out; whole hundredths, as every budget is). An admin is made a voucher by an owner only, either way (slice I5). A role voucher made one from
 * their entry gets nothing new: their budget's source moves to the entry, so losing the role later leaves it. Never
 * yourself. A new budget is a notice to its voucher, kept in the transaction and told by `tell` after it.
 */
export function makeVoucher(actor: string, body: { entryId?: unknown; memberPubkey?: unknown; amount_c?: unknown }, tell?: TellVoucher) {
    assertCommittee(actor);
    // The budget is `amount_c`, whole hundredths: an app from before them sends `amount` in Beans, refused rather than read as
    // absent (which would make the voucher with the community's default budget instead of the one asked for).
    if (carriesOldMoneyKey(body, ['amount'])) throw new VoucherError(400, AMOUNT_C_REQUIRED, AMOUNT_C_REQUIRED_TEXT);
    if (body.memberPubkey !== undefined && body.entryId !== undefined) throw new VoucherError(400, 'entry_or_member', 'Send an entry id or an admin’s key, not both.');
    const byRole = body.memberPubkey !== undefined;
    let pk: string;
    let entryId: string | null = null;
    if (byRole) {
        pk = memberKey(body.memberPubkey);
        if (!isNodeOwner(actor)) throw new VoucherError(403, 'owner_only', VOUCHER_WORDS.adminOwnerOnly);
        if (actingRole(pk) !== 'admin') throw new VoucherError(409, 'not_admin', VOUCHER_WORDS.notAdminToMake);
    } else {
        if (typeof body.entryId !== 'string' || !/^[0-9a-f]{32}$/.test(body.entryId)) throw new VoucherError(400, 'bad_entry', 'An entry id is 32 hexadecimal characters.');
        entryId = body.entryId;
        const conf = db.prepare('SELECT member_pubkey, needs_second, seconded_at FROM confirmations WHERE entry_id = ? AND revoked_at IS NULL')
            .get(entryId) as { member_pubkey: string; needs_second: number; seconded_at: string | null } | undefined;
        if (!conf) throw new VoucherError(409, 'not_confirmed', VOUCHER_WORDS.notConfirmed);
        if (conf.needs_second && !conf.seconded_at) throw new VoucherError(409, 'awaiting_second', VOUCHER_WORDS.awaitingSecond);
        const debt = db.prepare("SELECT amount_c FROM names_debts WHERE entry_id = ? AND status = 'open' ORDER BY removed_at DESC LIMIT 1").get(entryId) as { amount_c: number } | undefined;
        if (debt) throw new VoucherError(409, 'open_debt', openDebt(debt.amount_c));
        pk = conf.member_pubkey;
    }
    const m = getMember(db, pk);
    if (!m || m.status !== 'active' || isVisitorKey(db, pk) || m.isTreasury) {
        throw byRole ? new VoucherError(409, 'not_admin', VOUCHER_WORDS.notAdminToMake) : new VoucherError(409, 'not_confirmed', VOUCHER_WORDS.notConfirmed);
    }
    if (pk === actor) throw new VoucherError(403, 'own_budget', VOUCHER_WORDS.ownBudget);
    assertMayMakeOrStop(actor, pk);
    const amount = body.amount_c === undefined ? voucherBudgetSetting() : body.amount_c;
    if (!isBudgetLevel(amount)) throw new VoucherError(400, 'bad_level', VOUCHER_WORDS.badLevel);
    const live = liveVoucher(pk);
    if (live && (byRole || live.source === 'entry')) throw new VoucherError(409, 'already_voucher', alreadyVoucher(m.callsign));
    const notice = db.transaction((): VoucherNotice | undefined => {
        returnLapsedHolds(pk);
        if (live) {
            db.prepare("UPDATE vouchers SET source = 'entry', entry_id = ?, made_by = ?, made_at = ? WHERE member_pubkey = ?").run(entryId, actor, now(), pk);
            logLine(actor, 'voucher_made', pk, 'role', 'entry');
            return undefined;
        }
        logLine(actor, 'voucher_made', pk, null, byRole ? 'role' : 'entry');
        startBudget(pk, byRole ? 'role' : 'entry', entryId, amount, actor);
        return keepVoucherNotice(pk, 'made', noticeMade(amount), amount);
    })();
    if (notice) tell?.(notice);
    return voucherCard(pk);
}

/** A budget that hasn't stopped, whatever the account's state (a paused voucher's too): what the committee stops or sets. */
function openBudgetRow(pk: string): VoucherRow | undefined {
    const row = voucherRow(pk);
    return row && !row.stopped_at ? row : undefined;
}

/**
 * Whether `viewer` may stop `pk`'s budget now (the card's `canStop`, stopVoucher's own rule): an open budget, not their
 * own, the viewer on the committee; never an owner's (they vouch by the role, with no limit: amend2 §2(b)); an admin's by
 * an owner only (slice I5), whatever its source, a budget the role gave them before that rule included.
 */
function mayStop(viewer: string, pk: string): boolean {
    if (!viewer || viewer === pk || !isOnCreditCommittee(viewer) || !openBudgetRow(pk)) return false;
    const held = heldPrivilegedRole(pk);
    return held === 'owner' ? false : held === 'admin' ? isNodeOwner(viewer) : true;
}

/**
 * Stop vouching (DELETE /api/names/vouchers/:member): every open hold back (the codes stay valid and carry nothing), one
 * `stop` line, the row stopped; room already given stays given. An owner's budget is refused (409 `role_voucher`): they
 * vouch by the role. An admin's is an owner's to stop (403 `owner_only` for a committee admin), whatever its source: a
 * budget the role gave an admin before slice I5 stays until an owner stops it here. A member's, the committee's. A notice
 * to them.
 */
export function stopVoucher(actor: string, member: unknown, tell?: TellVoucher, bellSeen?: BellSeen) {
    assertCommittee(actor);
    const pk = memberKey(member);
    const live = openBudgetRow(pk);
    if (!live) throw new VoucherError(404, 'not_voucher', notVoucher(callsignOf(pk)));
    if (heldPrivilegedRole(pk) === 'owner') throw new VoucherError(409, 'role_voucher', ownerVoucher(callsignOf(pk)));
    assertMayMakeOrStop(actor, pk);
    const done = db.transaction(() => {
        stopBudget(pk, actor, 'stopped');
        // Stopped, there is no budget left to raise: an ask they left open leaves the bells with it (slice C3).
        return { notice: keepVoucherNotice(pk, 'stopped', VOUCHER_WORDS.noticeStopped, 0), cleared: clearAskNotices(pk) };
    })();
    tell?.(done.notice);
    tellCleared(done.cleared, bellSeen);
    return voucherCard(pk);
}

/**
 * Set a budget to a level (POST /api/names/vouchers/:member/budget `{ level }`, §10): what the voucher has in hand, left
 * and held together, 100 to 2,000 in 100s. A raise writes `top_up` +n, a lower `lower` −n, never below what is held on
 * unused invites; room already given is never touched. The same level again writes nothing. Never your own. A raise only
 * for a voucher whose account is active and whose credit line isn't frozen (§5.6 step 3); a lower whatever their state.
 * An owner (their role held, or held aside by a suspension) vouches with no limit (Marty, 9 Nov), so nobody sets their
 * budget while they hold the role (409 `no_limit`): what the role gave them waits, whole, for a step down to admin. These routes take a member's own signature and nothing else (no
 * admin session or automation token reaches /api/names), so the signer here is who acts.
 * Each change is a notice to the voucher (§10.2), kept in the transaction and told by `tell` after it.
 * A change answers the voucher's open Ask for more (DESIGN-credit-list-amend-fable.md §3.6, slice C3): its `budget_topup`
 * or `budget_lower` line closes the ask ({@link openAskOf}), and in the same transaction every recipient's copy of it
 * leaves their bell, kept copy and bell row together ({@link clearAskNotices}); `bellSeen` tells their open apps after it.
 */
export function setBudgetLevel(actor: string, member: unknown, body: { level?: unknown }, tell?: TellVoucher, bellSeen?: BellSeen) {
    assertCommittee(actor);
    const pk = memberKey(member);
    if (!openBudgetRow(pk)) throw new VoucherError(404, 'not_voucher', notVoucher(callsignOf(pk)));
    if (pk === actor) throw new VoucherError(403, 'own_budget', VOUCHER_WORDS.ownBudget);
    const level = body.level;
    if (!isBudgetLevel(level)) throw new VoucherError(400, 'bad_level', VOUCHER_WORDS.badLevel);
    if (heldPrivilegedRole(pk) === 'owner') throw new VoucherError(409, 'no_limit', ownerNoLimit(callsignOf(pk)));
    const done = db.transaction((): { notice: VoucherNotice; cleared: ClearedAsk[] } | undefined => {
        returnLapsedHolds(pk);
        const before = budgetOf(pk);
        if (level < before.held) throw new VoucherError(409, 'below_held', belowHeld(callsignOf(pk), before.held));
        const n = level - before.level;
        if (n === 0) return undefined;
        if (n > 0) {
            const m = getMember(db, pk);
            if (!m || m.status !== 'active') throw new VoucherError(409, 'paused', raisePaused(callsignOf(pk)));
            if (isFrozen(pk)) throw new VoucherError(409, 'frozen', raiseFrozen(callsignOf(pk)));
        }
        addLine(pk, n > 0 ? 'top_up' : 'lower', n, actor);
        assertUnderCeiling(pk);
        logLine(actor, n > 0 ? 'budget_topup' : 'budget_lower', pk, before.level, level);
        const { left } = budgetOf(pk);
        const notice = keepVoucherNotice(pk, n > 0 ? 'raised' : 'lowered', n > 0 ? noticeRaised(level, left) : noticeLowered(level, left), level);
        return { notice, cleared: clearAskNotices(pk) };
    })();
    if (done) {
        tell?.(done.notice);
        tellCleared(done.cleared, bellSeen);
    }
    return { ...voucherCard(pk), changed: done !== undefined };
}

/** An owner puts an admin on the credit committee, or takes them off (POST /api/names/committee `{ memberPubkey, on }`). */
export function setCreditCommittee(actor: string, body: { memberPubkey?: unknown; on?: unknown }) {
    assertPlainTablesWritable();
    assertBeansOn();
    if (!isNodeOwner(actor)) throw new VoucherError(403, 'owner_only', VOUCHER_WORDS.ownerOnly);
    const pk = memberKey(body.memberPubkey);
    if (typeof body.on !== 'boolean') throw new VoucherError(400, 'bad_setting', "'on' is true or false.");
    if (actingRole(pk) !== 'admin') throw new VoucherError(409, 'not_admin', VOUCHER_WORDS.notAdmin);
    const on = body.on;
    db.transaction(() => {
        if (db.prepare('UPDATE members SET credit_committee = ? WHERE public_key = ? AND COALESCE(credit_committee, 0) != ?').run(on ? 1 : 0, pk, on ? 1 : 0).changes > 0) {
            logLine(actor, 'committee', pk, on ? 'off' : 'on', on ? 'on' : 'off');
        }
    })();
    return { memberPubkey: pk, committee: isOnCreditCommittee(pk) };
}

/**
 * The owner's voucher budget setting (POST /api/names/vouchers/settings `{ voucherBudget }`), each change a log line.
 * The members' credit-line gift is a Core setting (config/core-settings.ts, slice G1), so it is changed only under How this
 * community works (POST /api/local/admin/community-shape `memberGift`), which asks the owner's fresh proof once the core
 * settings are locked, writes the unlock line and the change in both logs, alerts the owners and tells the members. Sent
 * here, the whole request is refused before anything is written (400 `moved_to_community_shape`), as node/config refuses
 * the settings that moved there: half a save would look like a whole one (round 2 of #2912: this route skipped all four).
 */
export function setVoucherSettings(actor: string, body: { voucherBudget?: unknown; memberGift?: unknown }) {
    assertPlainTablesWritable();
    assertBeansOn();
    if (!isNodeOwner(actor)) throw new VoucherError(403, 'owner_only', VOUCHER_WORDS.ownerOnly);
    if (body.memberGift !== undefined) throw new VoucherError(400, 'moved_to_community_shape', VOUCHER_WORDS.giftInCoreSettings);
    const newBudget = body.voucherBudget;
    if (newBudget !== undefined && !isBudgetLevel(newBudget)) throw new VoucherError(400, 'bad_level', VOUCHER_WORDS.badLevel);
    if (newBudget !== undefined && ownCoreLockRow() !== null) {
        throw new VoucherError(403, 'core_locked', 'Budget per voucher is a core setting locked by the community.');
    }
    const before = voucherSettings();
    // Each write names its key (test-replication-manifest reads every node_config write); the default removes the row.
    db.transaction(() => {
        if (newBudget !== undefined && newBudget !== before.voucherBudget) {
            saveVoucherBudgetSetting(actor, before.voucherBudget, newBudget);
        }
    })();
    return voucherSettings();
}

// ── Ask for more (DESIGN-credit-list-amend-fable.md §3.6, §6; slice C3) ─────────────────────────────────────────────

/** One ask a week: a voucher may ask again this long after their last ask, topped up or not. */
export const ASK_EVERY_DAYS = 7;
/** The log lines that answer an open ask: the budget set again (raised, lowered), made again, or stopped. */
const ASK_ANSWERED_BY = ['budget_topup', 'budget_lower', 'budget_grant', 'voucher_stopped'] as const;
/** The kind of a voucher's ask in the bell: told to every owner and committee admin but the asker, nobody else. */
export const VOUCHER_ASK_KIND = 'voucher_ask';

/** A voucher's newest ask (its `budget_asked` line), whatever came after it. */
function lastAskOf(pk: string): { at: string; rowid: number } | undefined {
    return db.prepare(`SELECT at, rowid FROM known_floor_log WHERE action = 'budget_asked' AND member_pubkey = ? AND actor_pubkey = member_pubkey
        ORDER BY at DESC, rowid DESC LIMIT 1`).get(pk) as { at: string; rowid: number } | undefined;
}

/**
 * When this voucher's ask is open, or null: their newest `budget_asked` line, under {@link ASK_EVERY_DAYS} old, with no
 * later line that answers it (a top-up, a lower, a new grant, a stop). Read from the log, as effectiveLines reads its
 * lines: nothing is kept outside it. An ask nobody answered lapses after the week, and the voucher's button comes back.
 */
export function openAskOf(pk: string, at = Date.now()): string | null {
    const ask = lastAskOf(pk);
    if (!ask || Date.parse(ask.at) <= at - ASK_EVERY_DAYS * DAY_MS) return null;
    const answered = db.prepare(`SELECT 1 FROM known_floor_log WHERE member_pubkey = ? AND action IN (${ASK_ANSWERED_BY.map(() => '?').join(', ')})
        AND (at > ? OR (at = ? AND rowid > ?)) LIMIT 1`).get(pk, ...ASK_ANSWERED_BY, ask.at, ask.at, ask.rowid);
    return answered ? null : ask.at;
}

/**
 * Who hears an ask: every owner whose role acts and every admin an owner put on the credit committee (isOnCreditCommittee),
 * never a plain admin, a moderator, a voucher or a member.
 */
function committeeKeys(): string[] {
    const rows = db.prepare(`SELECT DISTINCT nr.member_pubkey AS pk FROM node_roles nr JOIN members m ON m.public_key = nr.member_pubkey
        WHERE ${NODE_ROLE_ACTS} AND (nr.role = 'owner' OR (nr.role = 'admin' AND m.credit_committee = 1)) ORDER BY nr.member_pubkey`).all() as { pk: string }[];
    return rows.map((r) => r.pk).filter((pk) => isOnCreditCommittee(pk));
}

/** What a voucher's own Ask for more button says (GET /api/vouchers/me `ask`), from the node, never worked out in an app. */
export interface AskState {
    /** The ask open now (the button reads "Asked on …"), or null. */
    askedAt: string | null;
    /** Their last ask inside the week, open or answered, and when they may ask again; nulls when they may ask now. */
    lastAskedAt: string | null;
    askAgainAt: string | null;
    /** Why they can't ask at all now: their account paused, or their credit line frozen. */
    blocked: 'paused' | 'frozen' | null;
}

export function askStateOf(pk: string, at = Date.now()): AskState {
    const last = lastAskOf(pk);
    const recent = last && Date.parse(last.at) > at - ASK_EVERY_DAYS * DAY_MS ? last.at : null;
    const m = getMember(db, pk);
    return {
        askedAt: openAskOf(pk, at),
        lastAskedAt: recent,
        askAgainAt: recent ? new Date(Date.parse(recent) + ASK_EVERY_DAYS * DAY_MS).toISOString() : null,
        blocked: !m || m.status !== 'active' ? 'paused' : isFrozen(pk) ? 'frozen' : null,
    };
}

/**
 * Ask for more (POST /api/vouchers/ask): one tap, no words and no amount (5 Nov §10: every allocation is the giver's pick),
 * from a live voucher who is not an owner (an owner vouches with no limit), whose account is active and credit line not
 * frozen, once in {@link ASK_EVERY_DAYS} days whether or not anyone answered. One plain transaction on a main server with
 * Beans on: one `budget_asked` line in the known floor's log (old: what is left, new: the level last set), and one kept
 * notice for each owner and committee admin but the asker, with what is left, the level, and the five facts of the branch
 * health (5 Nov): below zero, written off and its share, trading only inside their own circle, how long a voucher, how long
 * confirmed. Counts and sums of vouches only, never a balance. Each is told by the route after the commit (`tell`). Nothing
 * here moves a budget: a top-up stays setBudgetLevel's, through POST /api/names/vouchers/:member/budget.
 */
export function askForMore(pk: string, at = Date.now()): { askedAt: string; askAgainAt: string; notices: VoucherNotice[] } {
    assertPlainTablesWritable();
    assertBeansOn();
    const m = getMember(db, pk);
    if (!m || isVisitorKey(db, pk) || m.isTreasury || !openBudgetRow(pk)) throw new VoucherError(403, 'not_a_voucher', VOUCHER_WORDS.notAVoucher);
    if (heldPrivilegedRole(pk) === 'owner') throw new VoucherError(409, 'no_limit', VOUCHER_WORDS.askOwner);
    if (m.status !== 'active') throw new VoucherError(409, 'paused', VOUCHER_WORDS.askPaused);
    if (isFrozen(pk)) throw new VoucherError(409, 'frozen', VOUCHER_WORDS.askFrozen);
    const askedAt = new Date(at).toISOString();
    const askAgainAt = new Date(at + ASK_EVERY_DAYS * DAY_MS).toISOString();
    const notices = db.transaction((): VoucherNotice[] => {
        const last = lastAskOf(pk);
        if (last && Date.parse(last.at) > at - ASK_EVERY_DAYS * DAY_MS) {
            const again = new Date(Date.parse(last.at) + ASK_EVERY_DAYS * DAY_MS).toISOString();
            throw new VoucherError(409, 'asked_this_week', askedThisWeek(last.at, again), { askedAt: last.at, askAgainAt: again });
        }
        const s = voucherSummary(pk);
        const setLevel = Math.max(lastLevelOf(pk), s.level);
        logLine(pk, 'budget_asked', pk, s.left, setLevel, askedAt);
        const title = VOUCHER_WORDS.askTitle;
        const body = askBody(s, setLevel, at);
        const data = { kind: VOUCHER_ASK_KIND, by: pk, screen: 'credit' };
        return committeeKeys().filter((to) => to !== pk).map((to) => ({ to, title, body, data, id: keepNotice(to, title, body, data, at) }));
    })();
    return { askedAt, askAgainAt, notices };
}

/** The facts an ask's words carry: counts and sums of vouches, never a balance. */
export interface AskFacts {
    callsign: string; left: number; level: number; vouched: number; people: number; belowZero: number; writtenOff: number;
    insideOnly: number; voucherDays: number; confirmedDays: number | null;
}

/** The ask's words: who, what is left of the level, and the branch health in counts and sums (amendment §3.6). */
export function askNoticeBody(f: AskFacts): string {
    const pct = f.vouched > 0 ? Math.min(100, Math.round((f.writtenOff * 100) / f.vouched)) : 0;
    return [
        askAsks(f.callsign),
        askLeft(f.left, f.level),
        askBranch(f.vouched, f.people, f.belowZero, f.writtenOff, pct, f.insideOnly),
        askVoucherAge(f.voucherDays),
        f.confirmedDays === null ? askNotConfirmed() : askConfirmedAge(f.confirmedDays),
    ].join(' ');
}

function askBody(s: ReturnType<typeof voucherSummary>, setLevel: number, at: number): string {
    const days = (iso: string | null) => (iso && Number.isFinite(Date.parse(iso)) ? Math.max(0, Math.floor((at - Date.parse(iso)) / DAY_MS)) : null);
    return askNoticeBody({
        callsign: s.callsign, left: s.left, level: setLevel, vouched: s.vouched, people: s.peopleVouched, belowZero: s.belowZero,
        writtenOff: s.writtenOff, insideOnly: s.trading.insideOnly, voucherDays: days(s.madeAt) ?? 0, confirmedDays: days(s.confirmedSince),
    });
}

/** What a budget change took off each recipient's bell: their kept copies' ids and their bell rows' ids. */
interface ClearedAsk { recipient: string; bellIds: string[] }
/** Tells a recipient's open apps which bell rows another member's act took off (state-engine.ts tellBellSeen). */
export type BellSeen = (recipient: string, bellIds: string[]) => void;

/**
 * Inside a budget writer's transaction: every copy of this voucher's ask is marked seen for every recipient, the kept copy
 * and its bell row together (as POST /api/notices/seen does for one member), so the same row leaves every owner's and
 * committee admin's bell once anyone answers. Only `voucher_ask` copies about `pk`; nobody else's notice is touched.
 */
function clearAskNotices(pk: string): ClearedAsk[] {
    const rows = db.prepare(`SELECT id, recipient FROM moderation_notices WHERE json_valid(data) AND json_extract(data, '$.kind') = ?
        AND json_extract(data, '$.by') = ?`).all(VOUCHER_ASK_KIND, pk) as { id: string; recipient: string }[];
    const byRecipient = new Map<string, string[]>();
    for (const r of rows) byRecipient.set(r.recipient, [...(byRecipient.get(r.recipient) ?? []), r.id]);
    const out: ClearedAsk[] = [];
    for (const [recipient, ids] of byRecipient) {
        markKeptNoticesSeen(recipient, ids);
        const bellIds = markPushNoticesSeenWhere(recipient, 'noticeId', ids);
        if (bellIds.length > 0) out.push({ recipient, bellIds });
    }
    return out;
}

/** After the commit: each recipient's open apps hear which rows left their bell. Never throws: the marks are the record. */
function tellCleared(cleared: readonly ClearedAsk[], bellSeen?: BellSeen): void {
    for (const c of cleared) {
        try { bellSeen?.(c.recipient, c.bellIds); } catch (e) { console.warn('[Vouchers] A bell mark was not told:', (e as Error)?.message || e); }
    }
}

// ── The vouch ────────────────────────────────────────────────────────────────────────────────────────────────────

/** The stored balance, never read through the ledger (memory boot-getbalance-before-exemptions): below zero now? */
function belowZeroNow(pk: string): boolean {
    return ((db.prepare('SELECT balance_c FROM accounts WHERE public_key = ?').get(pk) as { balance_c: number } | undefined)?.balance_c ?? 0) < 0;
}

/**
 * What one voucher's vouches for one person come to, how many vouchers' vouches the person has, what every vouch for them
 * comes to (`personTotal`), and whether an owner vouched for them (`ownerVouched`: a vouch whose hold an owner made,
 * OWNER_VOUCH_ACTOR, from a profile or on an invite), which lifts what they may hold in all from 300 to 500.
 */
function pairOf(voucher: string, person: string): { total: number; vouchers: number; personTotal: number; ownerVouched: boolean } {
    const total = (db.prepare(`SELECT COALESCE(SUM(amount_c), 0) AS n FROM room_gifts WHERE kind = 'vouch' AND from_pubkey = ? AND to_pubkey = ?`).get(voucher, person) as { n: number }).n;
    const all = db.prepare(`SELECT COUNT(DISTINCT from_pubkey) AS c, COALESCE(SUM(amount_c), 0) AS n FROM room_gifts WHERE kind = 'vouch' AND to_pubkey = ?`).get(person) as { c: number; n: number };
    const ownerVouched = !!db.prepare(`SELECT 1 FROM room_gifts g WHERE g.kind = 'vouch' AND g.to_pubkey = ? AND EXISTS (SELECT 1 FROM voucher_allocations h
        WHERE h.member_pubkey = g.from_pubkey AND h.kind = 'hold' AND h.actor = ? AND h.ref IN (g.id, g.invite_code)) LIMIT 1`).get(person, OWNER_VOUCH_ACTOR);
    return { total, vouchers: all.c, personTotal: all.n, ownerVouched };
}

/** Inside a vouch's transaction: the vouch's room_gifts row, from the voucher's budget (its hold written by the caller). */
function addVouchRow(voucher: string, person: string, amount: number, inviteCode: string | null): string {
    const id = newId();
    db.prepare(`INSERT INTO room_gifts (id, from_pubkey, to_pubkey, root_pubkey, kind, amount_c, invite_code, at) VALUES (?, ?, ?, ?, 'vouch', ?, ?, ?)`)
        .run(id, voucher, person, voucher, amount, inviteCode, now());
    return id;
}

/**
 * The checks of a vouch from `voucher`, before any write and again inside its transaction: a voucher, a preset, a budget
 * not frozen, at most what is left (a hold whose code lapsed counted back, as budgetOf counts it). Beans on, a main
 * server. An owner whose role acts now (Marty, 9 Nov) picks from the owner presets (200 and 500 too, refused from anyone
 * else) and is never refused for budget: their hold is recorded with OWNER_VOUCH_ACTOR and no budget counts it. Throws
 * VoucherError, or Beans off's own refusal. `owner`: whether this vouch is an owner's. `target`: the number is the total a raise
 * ends at (a preset, as an amount is); the budget is then checked by the caller against the difference it lands.
 */
function assertMayVouch(voucher: string, amount: unknown, target = false): { amount_c: number; owner: boolean } {
    assertPlainTablesWritable();
    assertBeansOn();
    if (!liveVoucher(voucher)) throw new VoucherError(403, 'not_a_voucher', VOUCHER_WORDS.notAVoucher);
    const owner = isNodeOwner(voucher);
    if (owner) {
        if (!isOwnerVouchPreset(amount)) throw new VoucherError(400, 'bad_amount', VOUCHER_WORDS.badOwnerAmount);
    } else if (!isVouchPreset(amount)) {
        if (isOwnerVouchPreset(amount)) throw new VoucherError(403, 'owner_amount', VOUCHER_WORDS.ownerAmountOnly);
        throw new VoucherError(400, 'bad_amount', VOUCHER_WORDS.badAmount);
    }
    const n = amount as number;
    if (isFrozen(voucher)) throw new VoucherError(409, 'frozen', VOUCHER_WORDS.frozen);
    if (!owner && !target) {
        const { left } = budgetOf(voucher);
        if (n > left) throw new VoucherError(409, 'not_enough', notEnough(left, n));
    }
    return { amount_c: n, owner };
}

/** The hold's actor: the voucher's own key, or OWNER_VOUCH_ACTOR for an owner's vouch (recorded, drawn from no budget). */
const holdActor = (voucher: string, owner: boolean) => (owner ? OWNER_VOUCH_ACTOR : voucher);

/**
 * A vouch from a member's profile (POST /api/vouch `{ memberPubkey, vouchAmount }` or `{ memberPubkey, raiseTo }`, §4 Q1 and
 * §9; raise as a target: DESIGN-invites-vouching-review-fable.md §4, slice I6), landing at once: a `hold` with the room_gifts
 * id and the room_gifts row, in one transaction that checks every rule again. `vouchAmount` is the voucher's one vouch for
 * this person (a preset). `raiseTo` is a raise: the total their vouches for this person end at (a preset of theirs, so an
 * owner's 200 or 500 and nobody else's), never an amount to add. The server lands the difference, from the budget; a target at
 * or below what they have vouched already is refused (`raise_not_above`), so a repeated tap lands once. The two together at
 * most 100 (an owner's: 500). Every vouch for one person comes to 300 at most, or 500 once an owner vouched for them or is
 * vouching now (Marty, 9 Nov). The three-vouchers rule never refuses an owner's vouch: theirs may top a person up to 500.
 */
export function vouchFromProfile(voucher: string, body: { memberPubkey?: unknown; vouchAmount?: unknown; raiseTo?: unknown }) {
    const person = memberKey(body.memberPubkey);
    const raise = body.raiseTo !== undefined;
    if (raise && body.vouchAmount !== undefined) throw new VoucherError(400, 'bad_body', VOUCHER_WORDS.vouchOrRaise);
    const asked = raise ? body.raiseTo : body.vouchAmount;
    assertMayVouch(voucher, asked, raise);
    if (person === voucher) throw new VoucherError(403, 'own_vouch', VOUCHER_WORDS.ownVouch);
    const m = getMember(db, person);
    if (!m || m.status !== 'active' || isVisitorKey(db, person) || m.isTreasury) throw new VoucherError(404, 'not_member', VOUCHER_WORDS.notMember);
    let id = '';
    let amount = asked as number;
    db.transaction(() => {
        returnLapsedHolds(voucher);
        const { owner } = assertMayVouch(voucher, asked, raise);
        // Q5: never for a member an admin froze (their whole line, or their known floor), a first vouch or a raise, an
        // owner's too: after the voucher's own rules, so a key that may vouch nothing learns nothing about the member.
        if (isFrozen(person)) throw new VoucherError(409, 'not_receiving', cantBeGivenCredit(m.callsign));
        if (belowZeroNow(person)) throw new VoucherError(409, 'below_zero', belowZero(m.callsign));
        const pair = pairOf(voucher, person);
        if (raise) {
            const target = asked as number;
            if (pair.total === 0) throw new VoucherError(409, 'no_vouch_yet', noVouchYet(m.callsign));
            if (target <= pair.total) throw new VoucherError(409, 'raise_not_above', raiseNotAbove(m.callsign, pair.total), { prior: pair.total });
            amount = target - pair.total;
            if (!owner) {
                const { left } = budgetOf(voucher);
                if (amount > left) throw new VoucherError(409, 'not_enough', notEnough(left, amount));
            }
        } else {
            if (pair.total > 0) throw new VoucherError(409, 'already_vouched', alreadyVouched(m.callsign), { prior: pair.total });
            if (!owner && pair.vouchers >= VOUCHES_PER_PERSON) throw new VoucherError(409, 'three_vouches', threeVouches(m.callsign));
        }
        const personMax = personVouchMax(owner || pair.ownerVouched);
        if (pair.personTotal + amount > personMax) {
            throw new VoucherError(409, 'over_person_max', overPerson(m.callsign, pair.personTotal, personMax), { personTotal: pair.personTotal, personMax });
        }
        id = addVouchRow(voucher, person, amount, null);
        addLine(voucher, 'hold', -amount, holdActor(voucher, owner), id);
    })();
    return { id, memberPubkey: person, amount, total: pairOf(voucher, person).total, budget: budgetOf(voucher) };
}

/**
 * Before an invite with a vouch is made (engine/invites.ts generateInvite): the maker's right to it, and the amount.
 * Throws as a profile vouch does. The hold itself is written with the code, in one transaction ({@link holdForInvite}).
 */
export function checkInviteVouch(maker: string, amount: unknown): number {
    return assertMayVouch(maker, amount).amount_c;
}

/** Inside generateInvite's transaction, with the code's row: the hold, after every check again (an owner's: OWNER_VOUCH_ACTOR). */
export function holdForInvite(maker: string, code: string, amount: number): void {
    returnLapsedHolds(maker);
    const { owner } = assertMayVouch(maker, amount);
    addLine(maker, 'hold', -amount, holdActor(maker, owner), code);
}

/**
 * At the redeem of an invite that carries a vouch, inside the redeem's transaction: the vouch lands on the joiner as a
 * room_gifts row if its hold is still live (no `return`: its maker's budget was not stopped since), and is their maker's one
 * vouch for them (a joiner is new: no vouch yet, never three). Otherwise nothing lands, and the joiner is told. Never a
 * refusal: the joiner joins either way. With Beans switched off since the code was made (before any Bean moved: the ledger
 * keeps them on after), no room lands either, and the hold goes back to its maker. Nor while the maker's credit line or
 * known floor is frozen (nothing more out of a frozen budget): the hold goes back, and once unfrozen the maker may vouch
 * for the joiner from their profile, this pair having no vouch yet. An owner's hold (OWNER_VOUCH_ACTOR) carries one of the
 * owner presets, and lands as it was made, whatever their role at the redeem: it was an owner's vouch when they made it.
 */
export function landInviteVouch(maker: string, code: string, joiner: string, amount: number): { landed: number } | { ended: string } {
    const hold = db.prepare(`SELECT -h.amount_c AS amount_c, h.actor AS actor FROM voucher_allocations h WHERE h.member_pubkey = ? AND h.ref = ? AND ${OPEN_HOLD}`)
        .get(maker, code) as { amount_c: number; actor: string } | undefined;
    const preset = hold?.actor === OWNER_VOUCH_ACTOR ? isOwnerVouchPreset(amount) : isVouchPreset(amount);
    if (!hold || hold.amount_c !== amount || !preset) return { ended: VOUCHER_WORDS.voucherEnded };
    const pair = pairOf(maker, joiner);
    if (!getProfileSwitches().beans || isFrozen(maker) || pair.total > 0 || pair.vouchers >= VOUCHES_PER_PERSON) {
        addLine(maker, 'return', amount, 'node', code);
        return { ended: VOUCHER_WORDS.voucherEnded };
    }
    addVouchRow(maker, joiner, amount, code);
    return { landed: amount };
}

// ── A voucher made by an invite (DESIGN-invites-and-names-list-amend3-fable.md §2, slice A1) ──────────────────────
// An owner or a credit-committee admin makes an invite bound to a names-list entry with a voucher budget (`voucher_level`).
// At creation nothing is allocated (a budget is a member's, and there is no member yet): one `voucher_promised` line. At the
// redeem, once the joiner is confirmed against the entry, in the redeem's own transaction, they are made a voucher with that
// budget as makeVoucher would (`voucher_made`, `budget_grant`, a kept notice); with two admins to confirm, when the second
// admin confirms. Where it can't land, nothing lands and one `voucher_not_made` line says why. Never a refusal: the joiner
// joins either way (onboarding has no hard gates). Nothing here is a Bean: plain tables only.

/** What became of an invite's voucher budget (invite_codes.voucher_outcome; core InviteVoucherOutcome). */
export type InviteVoucherOutcome = 'made' | 'awaiting_second' | 'maker_not_committee' | 'beans_off' | 'not_confirmed' | 'not_made';

/**
 * Before a bound invite with a voucher budget is made (engine/invites.ts generateInvite): an owner or committee admin, Beans
 * on, a main server, and a level of 100 to 2,000 in 100s. Throws VoucherError, or Beans off's own refusal.
 */
export function checkInviteVoucherLevel(maker: string, level: unknown): number {
    assertCommittee(maker);
    if (!isBudgetLevel(level)) throw new VoucherError(400, 'bad_level', VOUCHER_WORDS.badLevel);
    return level;
}

/** Inside generateInvite's transaction, with the code's row: the promise's line (who, which entry, what level). Never the code. */
export function promiseInviteVoucher(maker: string, entryId: string, level: number): void {
    logLine(maker, 'voucher_promised', null, entryId, level);
}

/**
 * An unused invite revoked (engine/invites.ts revokeInvite; invites-vouching I2), inside its transaction, before its row goes.
 * The vouch its code holds comes back to `holder` (the maker, or the admin a seed invite was issued by): one `return` line,
 * actor the revoker, ref the code, beside one `invite_revoked` line in the log stamped the same moment (how the budget's
 * history tells it from a stop). Only while the hold is open: the hourly prune, a budget writer (a lapsed code) or a budget
 * stopped may have returned it already, and nothing comes back twice. Returns what came back (0 if nothing was open). An
 * owner's hold (OWNER_VOUCH_ACTOR) is closed the same way and, as ever, moves no budget.
 */
export function returnHoldOnRevoke(holder: string, code: string, revoker: string): number {
    const hold = db.prepare(`SELECT -h.amount_c AS amount FROM voucher_allocations h WHERE h.member_pubkey = ? AND h.ref = ? AND ${OPEN_HOLD}`)
        .get(holder, code) as { amount: number } | undefined;
    if (!hold) return 0;
    const at = now();
    addLine(holder, 'return', hold.amount, revoker, code, at);
    logLine(revoker, 'invite_revoked', holder, null, hold.amount, at);
    return hold.amount;
}

/** The voucher budget a revoked bound invite promised (invites-vouching I2), in its transaction: one `voucher_promise_ended` line. */
export function endPromiseOnRevoke(revoker: string, entryId: string, level: number): void {
    logLine(revoker, 'voucher_promise_ended', null, entryId, level);
}

/** A `voucher_not_made` line (old: the entry, new: why), never throwing: a redeem goes on whatever happens here. */
function logNotMade(actor: string, joiner: string, entryId: string, why: InviteVoucherOutcome): void {
    try {
        logLine(actor, 'voucher_not_made', joiner, entryId, why);
    } catch (e) {
        console.error('[Vouchers] ⚠️ Could not log a voucher not made:', (e as Error)?.message || e);
    }
}

/**
 * Makes `joiner`, confirmed against `entryId` by `maker`'s invite, a voucher with `level`, in a savepoint inside the
 * caller's transaction. The maker's standing is read now: still an owner or committee admin, with Beans on. Never throws.
 */
function landVoucher(maker: string, entryId: string, joiner: string, level: number): { outcome: InviteVoucherOutcome; notice?: VoucherNotice } {
    let result: { outcome: InviteVoucherOutcome; notice?: VoucherNotice };
    try {
        result = db.transaction((): { outcome: InviteVoucherOutcome; notice?: VoucherNotice } => {
            if (!getProfileSwitches().beans) return { outcome: 'beans_off' };
            if (!isOnCreditCommittee(maker)) return { outcome: 'maker_not_committee' };
            const m = getMember(db, joiner);
            if (!isBudgetLevel(level) || joiner === maker || !m || m.status !== 'active' || isVisitorKey(db, joiner) || m.isTreasury || liveVoucher(joiner)) {
                return { outcome: 'not_made' };
            }
            logLine(maker, 'voucher_made', joiner, null, 'entry');
            startBudget(joiner, 'entry', entryId, level, maker);
            return { outcome: 'made', notice: keepVoucherNotice(joiner, 'made', noticeMade(level), level) };
        })();
    } catch (e) {
        console.error('[Vouchers] ⚠️ Could not make an invite\'s joiner a voucher:', (e as Error)?.message || e);
        result = { outcome: 'not_made' };
    }
    if (result.outcome !== 'made') logNotMade(maker, joiner, entryId, result.outcome);
    return result;
}

/**
 * At the redeem of a bound invite with a voucher budget, inside the redeem's transaction, after the confirmation
 * (engine/names-list.ts confirmByInvite, whose outcome is `bound`): confirmed, the joiner is made a voucher now; waiting
 * for a second admin, the promise waits (secondConfirmation lands it); not confirmed, no voucher. Never throws.
 */
export function landInviteVoucher(maker: string, entryId: string, joiner: string, level: number, bound: string | null): { outcome: InviteVoucherOutcome; notice?: VoucherNotice } {
    if (bound === 'awaiting_second') return { outcome: 'awaiting_second' };
    if (bound !== 'confirmed') {
        logNotMade(maker, joiner, entryId, 'not_confirmed');
        return { outcome: 'not_confirmed' };
    }
    return landVoucher(maker, entryId, joiner, level);
}

/**
 * Inside secondConfirmation's transaction: the voucher budget an invite promised this member, waiting for the second admin,
 * lands now (the maker's committee standing read now), and the invite says what became of it. The notice, if one was kept,
 * for the route to tell once it has committed. Never a refusal: where the voucher can't land, the confirmation stands and the
 * invite says why. A write that fails (the outcome's, say) fails the whole confirmation, as any write in it would, so a voucher
 * never lands with its invite still saying it waits.
 */
export function landAwaitingInviteVoucher(member: string, entryId: string): VoucherNotice | undefined {
    const inv = db.prepare(`SELECT code, created_by, voucher_level_c FROM invite_codes WHERE used_by = ? AND names_entry_id = ?
        AND voucher_outcome = 'awaiting_second' AND voucher_level_c IS NOT NULL ORDER BY used_at DESC LIMIT 1`).get(member, entryId) as
        { code: string; created_by: string; voucher_level_c: number } | undefined;
    if (!inv) return undefined;
    const r = landVoucher(inv.created_by, entryId, member, inv.voucher_level_c);
    db.prepare('UPDATE invite_codes SET voucher_outcome = ? WHERE code = ?').run(r.outcome, inv.code);
    return r.notice;
}

/**
 * A confirmation revoked before the second admin confirmed it (engine/names-list.ts), in its transaction: the voucher budget
 * an invite promised this member is not made, and the invite says so (one `voucher_not_made` line by whoever revoked it).
 */
export function endInviteVoucherPromise(member: string, actor: string): void {
    const waiting = db.prepare(`SELECT code, names_entry_id FROM invite_codes WHERE used_by = ? AND voucher_outcome = 'awaiting_second'`).all(member) as
        { code: string; names_entry_id: string }[];
    for (const w of waiting) {
        db.prepare("UPDATE invite_codes SET voucher_outcome = 'not_confirmed' WHERE code = ?").run(w.code);
        logNotMade(actor, member, w.names_entry_id, 'not_confirmed');
    }
}

// ── Ends ─────────────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * A confirmation revoked by an admin or stepped back from (engine/names-list.ts), in its transaction: a list budget stops.
 * An owner or admin whose role acts keeps it, as the role would have given them one (amend2 §2(b)): its source goes back
 * to the role, nothing else moves (the same left and held, no line in the budget), one `voucher_source` line in the log.
 */
export function vouchingAfterRevoke(pk: string, actor: string): void {
    if (getNodeRole() !== 'primary') return;
    const row = voucherRow(pk);
    if (!row || row.stopped_at || row.source !== 'entry') return;
    const role = actingRole(pk);
    if (role === 'owner' || role === 'admin') {
        db.prepare("UPDATE vouchers SET source = 'role', entry_id = NULL WHERE member_pubkey = ? AND stopped_at IS NULL").run(pk);
        logLine(actor, 'voucher_source', pk, 'entry', 'role');
        return;
    }
    stopBudget(pk, actor, 'revoked');
}

/**
 * A member leaving (adminPruneUser, purgeMemberSelf), inside the departure's conservingTransaction, with the balance they had
 * before the Commons settled it: any budget stops, and each piece of room they held is stamped with the part of their debt
 * it covered, oldest first, so a voucher's card sums what was written off. Never throws: the Commons' row is the record.
 */
export function vouchingOnDeparture(pk: string, actor: string, balance: number): void {
    if (getNodeRole() !== 'primary') return;
    safely('stamp a departure on the vouchers', () => {
        const row = voucherRow(pk);
        if (row && !row.stopped_at) stopBudget(pk, actor, 'departed');
        // In cents, as Beans are kept: the debt the Commons paid, shared over the pieces they still held, oldest first.
        let debtCents = balance < 0 ? Math.round(-balance * 100) : 0;
        const pieces = db.prepare(`SELECT g.id, g.amount_c - COALESCE((SELECT SUM(p.amount_c) FROM room_gifts p WHERE p.source_gift_id = g.id), 0) AS open
            FROM room_gifts g WHERE g.to_pubkey = ? AND g.written_off_c IS NULL ORDER BY g.at ASC, g.id ASC`).all(pk) as { id: string; open: number }[];
        const stamp = db.prepare('UPDATE room_gifts SET written_off_c = ?, written_off_at = ? WHERE id = ?');
        const at = now();
        for (const p of pieces) {
            const shareCents = Math.max(0, Math.min(debtCents, Math.round(p.open * 100)));
            stamp.run(shareCents / 100, at, p.id);
            debtCents -= shareCents;
        }
    });
}

// ── Reading ──────────────────────────────────────────────────────────────────────────────────────────────────────

/** Where a person's completed trades reach: past the voucher's own (`others`), only inside it (`inside`), or none yet. */
export type TradingMark = 'others' | 'inside' | 'none';

/**
 * The card's Trading line (amend2 §5 "Trading: 2 with others · 1 inside only"; amendment 1 §5.5 "trades with others" or
 * "only with people Jane brought in"), for each person this voucher vouched for: their completed marketplace deals (a
 * completed trade, as everywhere: marketplace_transactions 'completed'), and whether any is with someone outside the
 * voucher and the people holding room rooted at the voucher (everyone they vouched for, and whoever was passed some on).
 * A mark per person and nothing of whom they traded with: the design's signal for a ring of fakes trading among
 * themselves. One read per voucher.
 */
function tradingOf(pk: string): Map<string, TradingMark> {
    const rows = db.prepare(`
        WITH people(pk) AS (SELECT DISTINCT to_pubkey FROM room_gifts WHERE kind = 'vouch' AND from_pubkey = @v),
             inside(pk) AS (SELECT @v UNION SELECT to_pubkey FROM room_gifts WHERE root_pubkey = @v),
             deals(person, other) AS (
                 SELECT buyer_pubkey, seller_pubkey FROM marketplace_transactions WHERE status = 'completed' AND buyer_pubkey IN (SELECT pk FROM people)
                 UNION ALL
                 SELECT seller_pubkey, buyer_pubkey FROM marketplace_transactions WHERE status = 'completed' AND seller_pubkey IN (SELECT pk FROM people))
        SELECT p.pk AS pk, COUNT(d.other) AS deals, COALESCE(SUM(d.other IS NOT NULL AND d.other NOT IN (SELECT pk FROM inside)), 0) AS outside
        FROM people p LEFT JOIN deals d ON d.person = p.pk GROUP BY p.pk`).all({ v: pk }) as { pk: string; deals: number; outside: number }[];
    return new Map(rows.map((r) => [r.pk, r.outside > 0 ? 'others' : r.deals > 0 ? 'inside' : 'none']));
}

/**
 * The card's Passed on line (amend2 §5 "Passed on: 50 of their 350 to 1 person · 0 of it below zero"; slice G1,
 * engine/credit-gift.ts): of the room rooted at this voucher, what sits now with the members it was passed on to as a
 * gift (each gift piece's open part: its amount less what was split from it again), how many members hold it, and how
 * much of it is held by someone below zero now. "Of their 350" is the card's `vouched`: a gift only splits a vouch, so
 * this is never more. A ring passing the same 100 round (A → B → C → A) reads "passed on 100 … held by 1 person" (§5);
 * a piece whose holder left was stamped written off and counts in the written-off line, not here. No balance figure:
 * "below zero" marks the room, never by how much.
 */
function passedOnOf(pk: string): { amount_c: number; people: number; belowZero: number } {
    const pieces = (db.prepare(`SELECT g.to_pubkey AS holder,
            g.amount_c - COALESCE((SELECT SUM(c.amount_c) FROM room_gifts c WHERE c.source_gift_id = g.id), 0) AS open
        FROM room_gifts g WHERE g.kind = 'gift' AND g.root_pubkey = ? AND g.written_off_c IS NULL`).all(pk) as { holder: string; open: number }[])
        .filter((p) => p.open > 0);
    const holders = new Set(pieces.map((p) => p.holder));
    const below = new Set([...holders].filter((h) => belowZeroNow(h)));
    return {
        amount_c: pieces.reduce((s, p) => s + p.open, 0),
        people: holders.size,
        belowZero: pieces.filter((p) => below.has(p.holder)).reduce((s, p) => s + p.open, 0),
    };
}

/** What this voucher's vouches that landed since `sinceMs` add up to, in hundredths (room_gifts of kind 'vouch'): the card's last-30-days figure. */
function vouchedSince(pk: string, sinceMs: number): number {
    return (db.prepare("SELECT COALESCE(SUM(amount_c), 0) AS n FROM room_gifts WHERE kind = 'vouch' AND from_pubkey = ? AND at > ?")
        .get(pk, new Date(sinceMs).toISOString()) as { n: number }).n;
}

/** One voucher's numbers (the vouchers block's row, the card's head). No balance figure: "below zero" is a count. */
export function voucherSummary(pk: string) {
    const row = voucherRow(pk);
    const b = budgetOf(pk);
    const people = db.prepare(`SELECT DISTINCT to_pubkey AS pk FROM room_gifts WHERE kind = 'vouch' AND from_pubkey = ?`).all(pk) as { pk: string }[];
    const below = people.filter((p) => belowZeroNow(p.pk)).length;
    const writtenOff = (db.prepare('SELECT COALESCE(SUM(written_off_c), 0) AS n FROM room_gifts WHERE root_pubkey = ?').get(pk) as { n: number }).n;
    const sent = (db.prepare('SELECT COUNT(*) AS n FROM invite_codes WHERE created_by = ? AND vouch_amount_c IS NOT NULL').get(pk) as { n: number }).n;
    const marks = [...tradingOf(pk).values()];
    return {
        // The card's headline: "Vouched 350 to 4 people · 100 in the last 30 days · …". A sum of vouch amounts, never a balance.
        vouchedLast30Days: vouchedSince(pk, Date.now() - 30 * DAY_MS),
        memberPubkey: pk, callsign: callsignOf(pk), source: row?.source ?? null, entryId: row?.entry_id ?? null,
        madeBy: row?.made_by ?? null, madeByCallsign: callsignOf(row?.made_by), madeAt: row?.made_at ?? null,
        stoppedAt: row?.stopped_at ?? null, stopReason: row?.stop_reason ?? null,
        // An owner vouches with no limit (Marty, 9 Nov): the apps read "No limit" for them, never left or level.
        noLimit: isNodeOwner(pk),
        ...b, belowZero: below, writtenOff, passedOn: passedOnOf(pk), invitesWithVouch: sent,
        trading: { withOthers: marks.filter((m) => m === 'others').length, insideOnly: marks.filter((m) => m === 'inside').length },
        // Two of the branch health's five facts (amendment §6, slice C3): how long they are confirmed on the names list (the
        // live confirmation, seconded where two admins confirm; null when not), and since when they are a member here.
        confirmedSince: confirmedSinceOf(pk), memberSince: getMember(db, pk)?.joinedAt ?? null,
    };
}

/** When their live confirmation took effect (the second admin's, where one was needed), or null. */
function confirmedSinceOf(pk: string): string | null {
    const row = db.prepare(`SELECT COALESCE(seconded_at, confirmed_at) AS at FROM confirmations WHERE member_pubkey = ? AND revoked_at IS NULL
        AND (needs_second = 0 OR seconded_at IS NOT NULL) ORDER BY confirmed_at DESC LIMIT 1`).get(pk) as { at: string | null } | undefined;
    return row?.at ?? null;
}

/**
 * The level last set for this voucher: the newest `budget_grant`, `budget_topup` or `budget_lower` line's new level for
 * them; the community's setting when there is none (the log was emptied at the 1.4.0 step, amendment F13).
 */
function lastLevelOf(pk: string): number {
    const row = db.prepare(`SELECT new_value FROM known_floor_log WHERE member_pubkey = ? AND action IN ('budget_grant', 'budget_topup', 'budget_lower')
        ORDER BY at DESC, rowid DESC LIMIT 1`).get(pk) as { new_value: string | null } | undefined;
    const n = row?.new_value == null ? NaN : Number(row.new_value);
    return isBudgetLevel(n) ? n : voucherBudgetSetting();
}

/** Why a row offers no Top up: an owner (no limit), the viewer's own, a paused account, a frozen line, or the ceiling. */
export type TopUpBlocked = 'no_limit' | 'own' | 'paused' | 'frozen' | 'at_most';

/**
 * A voucher's budget as the committee's rows read it (amendment §3.5; slice C3), for owners and committee admins only:
 *   runningLow    under 100 left (core runningLow); nothingLeft under 25 (core nothingLeft); never for an owner
 *   askedAt       their open Ask for more ({@link openAskOf}), or null
 *   topUpTo_c     the one level "Top up to" offers (core topUpTarget: the level last set when they have less in hand, else
 *                 the next of 500 · 1,000 · 1,500 · 2,000), or null with `topUpBlocked` saying why
 * The tap is today's route and writer (POST /api/names/vouchers/:member/budget `{ level }`, setBudgetLevel): nothing here
 * writes, and no app works out a level.
 */
export interface BudgetSight {
    /** The level they were last set to, never below what they hold now: the "of 1,000" in "150 of 1,000 left". */
    setLevel_c: number | null;
    runningLow: boolean;
    nothingLeft: boolean;
    askedAt: string | null;
    topUpTo_c: number | null;
    topUpBlocked: TopUpBlocked | null;
}

export function budgetSightOf(viewer: string, pk: string, b: { left: number; level: number; noLimit: boolean }, at = Date.now()): BudgetSight {
    if (b.noLimit) return { setLevel_c: null, runningLow: false, nothingLeft: false, askedAt: null, topUpTo_c: null, topUpBlocked: 'no_limit' };
    const m = getMember(db, pk);
    const lastLevel = lastLevelOf(pk);
    const target = topUpTarget(b.level, lastLevel);
    const blocked: TopUpBlocked | null = viewer === pk ? 'own' : !m || m.status !== 'active' ? 'paused' : isFrozen(pk) ? 'frozen' : target === null ? 'at_most' : null;
    return {
        setLevel_c: Math.max(lastLevel, b.level), runningLow: runningLow(b.left), nothingLeft: nothingLeft(b.left), askedAt: openAskOf(pk, at),
        topUpTo_c: blocked ? null : target, topUpBlocked: blocked,
    };
}

/**
 * A voucher budget promised on an invite nobody has used yet (invites-vouching I4, DESIGN §3 ask 5(b)): it lands when the
 * invited person joins and is confirmed, so until then they are "waiting to join". By entry id: the name is sealed in the
 * names list, which this server never reads, so the committee's phone opens it. Never the code (a live code in another
 * admin's hands could be self-redeemed; names-list.ts readBoundInvites says the same), and never a balance. `level` and
 * `vouchAmount` are whole hundredths, as every voucher budget figure is.
 */
export interface WaitingVoucher {
    entryId: string; level: number; vouchAmount: number | null;
    madeBy: string; madeByCallsign: string; madeAt: string; expiresAt: string;
}

/** Every unused, in-date invite bound to an entry that promises a voucher budget, newest first, one per entry. */
export function waitingToJoin(at = Date.now()): WaitingVoucher[] {
    const rows = db.prepare(`SELECT names_entry_id AS entryId, voucher_level_c AS level, vouch_amount_c AS vouchAmount, created_by AS madeBy, created_at AS madeAt
        FROM invite_codes WHERE used_by IS NULL AND voucher_level_c IS NOT NULL AND names_entry_id IS NOT NULL AND created_at > ?
        ORDER BY created_at DESC, code ASC`).all(lifeCutoff(at)) as { entryId: string; level: number; vouchAmount: number | null; madeBy: string; madeAt: string }[];
    const seen = new Set<string>();
    const out: WaitingVoucher[] = [];
    for (const r of rows) {
        if (seen.has(r.entryId)) continue;
        seen.add(r.entryId);
        out.push({ ...r, madeByCallsign: callsignOf(r.madeBy), expiresAt: new Date(Date.parse(r.madeAt) + INVITE_LIFE_MS).toISOString() });
    }
    return out;
}

/** Someone "+ Make someone a voucher" offers (slice I5): who, and the entry they are confirmed against when it is that section. */
export interface VoucherCandidate { memberPubkey: string; callsign: string; entryId?: string }

/**
 * Whom "+ Make someone a voucher" offers `viewer` (slice I5, DESIGN-invites-vouching-review-fable.md §3 ask 1), and nobody
 * else: `admins`, every admin whose role acts, with no live budget (an owner's to make, so empty for a committee admin,
 * and `adminsOffered` says which: true for an owner, whose empty `admins` means every admin is a voucher already);
 * `confirmed`, every member confirmed on the names list (seconded where two admins confirm) whom makeVoucher's entry path
 * takes: active, no live budget, no open debt on the entry, never an owner or admin (an admin is in `admins`, and an owner
 * vouches by the role). Never the viewer. By callsign: the names are sealed in the list, so the phone opens them by entry id.
 */
function voucherCandidates(viewer: string): { admins: VoucherCandidate[]; confirmed: VoucherCandidate[]; adminsOffered: boolean } {
    const noBudget = (col: string) => `NOT EXISTS (SELECT 1 FROM vouchers v WHERE v.member_pubkey = ${col} AND v.stopped_at IS NULL)`;
    const adminsOffered = isNodeOwner(viewer);
    const admins = adminsOffered
        ? db.prepare(`SELECT nr.member_pubkey AS memberPubkey, m.callsign AS callsign FROM node_roles nr JOIN members m ON m.public_key = nr.member_pubkey
            WHERE nr.role = 'admin' AND ${NODE_ROLE_ACTS} AND nr.member_pubkey != ? AND ${noBudget('nr.member_pubkey')}
            ORDER BY m.callsign COLLATE NOCASE ASC, nr.member_pubkey ASC`).all(viewer) as VoucherCandidate[]
        : [];
    const confirmed = (db.prepare(`SELECT c.member_pubkey AS memberPubkey, m.callsign AS callsign, c.entry_id AS entryId FROM confirmations c
            JOIN members m ON m.public_key = c.member_pubkey
            WHERE c.revoked_at IS NULL AND (c.needs_second = 0 OR c.seconded_at IS NOT NULL) AND m.status = 'active' AND m.is_visitor = 0
              AND c.member_pubkey != ? AND ${noBudget('c.member_pubkey')}
              AND NOT EXISTS (SELECT 1 FROM node_roles nr WHERE nr.member_pubkey = c.member_pubkey AND nr.role IN ('owner', 'admin'))
              AND NOT EXISTS (SELECT 1 FROM names_debts d WHERE d.entry_id = c.entry_id AND d.status = 'open')
            ORDER BY m.callsign COLLATE NOCASE ASC, c.member_pubkey ASC`).all(viewer) as VoucherCandidate[])
        .filter((c) => !getMember(db, c.memberPubkey)?.isTreasury);
    return { admins, confirmed, adminsOffered };
}

/**
 * Every live voucher by callsign, each with their numbers and the committee's budget sight (slice C3: running low, an open
 * ask, the top-up offer). The committee's alone: the vouchers block (routes/names-list.ts) and the Vouchers chip
 * (routes/credit-sight.ts) both refuse anyone else first.
 */
function voucherRows(viewer: string) {
    const keys = db.prepare(`SELECT v.member_pubkey AS pk FROM vouchers v JOIN members m ON m.public_key = v.member_pubkey
        WHERE v.stopped_at IS NULL AND m.status = 'active' AND m.is_visitor = 0 ORDER BY m.callsign COLLATE NOCASE ASC, v.member_pubkey ASC`).all() as { pk: string }[];
    return keys.map((k) => { const v = voucherSummary(k.pk); return { ...v, ...budgetSightOf(viewer, k.pk, v) }; });
}

/**
 * The vouchers block (GET /api/names/vouchers, owners and committee admins): every live voucher with their numbers, owners
 * first (they vouch by role, with no limit: "Owners · no limit") and then by callsign, `waiting`: the promised budgets of
 * invites not used yet, and `candidates`: whom "+ Make someone a voucher" offers this viewer (voucherCandidates). The
 * names list orders entries by the names its admins' phones open, which this server never reads: each row carries its
 * entry id, and the phone puts the block in the list's own order.
 */
export function vouchersBlock(viewer: string) {
    const vouchers = voucherRows(viewer);
    return {
        vouchers: [...vouchers.filter((v) => v.noLimit), ...vouchers.filter((v) => !v.noLimit)],
        waiting: waitingToJoin(),
        candidates: voucherCandidates(viewer),
        settings: voucherSettings(),
    };
}

/**
 * The Vouchers chip (GET /api/credit/people?filter=vouchers; amendment §3.5, slice C3), for owners and committee admins only
 * (the route refuses anyone else before this is read): every live voucher, each with their numbers, their branch health and
 * the committee's budget sight; asked first (the oldest ask first), then running low, then least left; owners last, by
 * callsign ("Owner · no limit"). No look is recorded: a row shows a budget and counts, never anyone's balance.
 */
export function vouchersChip(viewer: string) {
    const rows = voucherRows(viewer);
    const byName = (a: { callsign: string; memberPubkey: string }, b: { callsign: string; memberPubkey: string }) =>
        a.callsign.localeCompare(b.callsign, 'en', { sensitivity: 'base' }) || a.memberPubkey.localeCompare(b.memberPubkey);
    const others = rows.filter((v) => !v.noLimit).sort((a, b) =>
        (a.askedAt ? 0 : 1) - (b.askedAt ? 0 : 1)
        || (a.askedAt && b.askedAt ? a.askedAt.localeCompare(b.askedAt) : 0)
        || (a.runningLow ? 0 : 1) - (b.runningLow ? 0 : 1)
        || a.left - b.left
        || byName(a, b));
    return [...others, ...rows.filter((v) => v.noLimit).sort(byName)];
}

/**
 * A voucher's budget in one line, on their row in every other chip (amendment §3.5, "Voucher · 150 of 1,000 left ! Running
 * low"), for owners and committee admins only (engine/credit-sight.ts asks it for no one else). Null: not a live voucher.
 */
export function voucherBudgetLine(pk: string, at = Date.now()) {
    if (!liveVoucher(pk)) return null;
    const noLimit = isNodeOwner(pk);
    if (noLimit) return { noLimit, left_c: null, held_c: null, level_c: null, setLevel_c: null, runningLow: false, nothingLeft: false, askedAt: null };
    const b = budgetOf(pk, at);
    return {
        noLimit, left_c: b.left, held_c: b.held, level_c: b.level, setLevel_c: Math.max(lastLevelOf(pk), b.level),
        runningLow: runningLow(b.left), nothingLeft: nothingLeft(b.left), askedAt: openAskOf(pk, at),
    };
}

/**
 * The button a profile shows an owner or admin, following the person's state (invites-vouching I4, DESIGN §3 ask 2):
 *   add       not on the names list (no live confirmation): "Add to the names list", the one-step add-and-confirm form
 *   make      confirmed, and the viewer is on the credit committee (an owner, for an admin: slice I5): "Make a voucher"
 *   voucher   a voucher now: "Voucher · 400 left ›" (an owner: no limit), opening the card
 * A plain admin (off the committee) gets Add and the voucher card but never Make; a confirmation still waiting for its
 * second admin offers nothing. Null for anyone who is not an owner or admin, for their own profile, where a community keeps
 * no names list (the worldwide one), for an account that can't be a voucher, and wherever Beans are off: a voucher is a budget of
 * Beans (every voucher writer calls assertBeansOn), so that community has no voucher, no Make and no card to open, and its
 * names-list step is offered no more than the web offers it (the web reads this only where Beans are live). A left-over figure
 * is a budget, not a balance.
 */
export type ProfileVoucherButton =
    | { state: 'add' }
    | { state: 'make' }
    | { state: 'voucher'; left: number; noLimit: boolean };

export function profileVoucherButton(viewer: string | null | undefined, target: string): ProfileVoucherButton | null {
    if (!viewer || viewer === target || !isNodeAdmin(viewer)) return null;
    if (getNodeProfile() === 'global' || !getProfileSwitches().beans) return null;
    const m = getMember(db, target);
    if (!m || m.status !== 'active' || isVisitorKey(db, target) || m.isTreasury) return null;
    if (liveVoucher(target)) return { state: 'voucher', left: budgetOf(target).left, noLimit: isNodeOwner(target) };
    const conf = db.prepare('SELECT needs_second, seconded_at FROM confirmations WHERE member_pubkey = ? AND revoked_at IS NULL')
        .get(target) as { needs_second: number; seconded_at: string | null } | undefined;
    if (!conf) return { state: 'add' };
    if (conf.needs_second && !conf.seconded_at) return null;
    // An admin is made a voucher by an owner only (slice I5): a committee admin gets no Make for another admin.
    if (heldPrivilegedRole(target) === 'admin' && !isNodeOwner(viewer)) return null;
    return isOnCreditCommittee(viewer) ? { state: 'make' } : null;
}

/** One line of a Budget history: what moved, by whose hand, and for what, never which invite code. */
export interface HistoryLine {
    kind: string; amount_c: number; actor: string; actorCallsign: string | null; at: string;
    /** A hold or a return: an invite's vouch, or one from a member's profile. Absent on a grant, a level or a stop. */
    for?: 'invite' | 'profile';
    /** An invite's: when it was made (its hold's moment, written with the code). */
    inviteMadeAt?: string | null;
    /** An invite's hold: still held, landed on someone (`vouched`), or back in the budget (expired, stopped or not landed). */
    outcome?: 'held' | 'vouched' | 'back';
    /** A return: the invite lapsed unused (`expired`), the budget stopped first, or the vouch didn't land at the redeem. */
    why?: 'expired' | 'stopped' | 'not_landed' | 'revoked';
    /** Who the vouch went to: a profile vouch's person, an invite's joiner once it landed. Someone the card's people name. */
    person?: { memberPubkey: string; callsign: string } | null;
}

/**
 * Budget history: every allocation line, newest first, each naming who made it. A hold's or a return's `ref` is its invite
 * code (or a profile vouch's room_gifts id), and an unused code is a bearer key to join that lands its vouch from this
 * budget: it stays here. Each line says what it was for instead (amend2 §3: "−100 held for an invite · +100 back, invite
 * expired"), from what the server knows of the code, and nothing of the code itself, nor any piece of it.
 */
function historyOf(pk: string, limit = 200): HistoryLine[] {
    const cutoff = lifeCutoff(Date.now());
    const rows = db.prepare('SELECT kind, amount_c, actor, ref, at FROM voucher_allocations WHERE member_pubkey = ? ORDER BY at DESC, rowid DESC LIMIT ?').all(pk, limit) as
        { kind: string; amount_c: number; actor: string; ref: string | null; at: string }[];
    const giftTo = db.prepare("SELECT to_pubkey AS pk FROM room_gifts WHERE id = ? AND from_pubkey = ? AND kind = 'vouch'");
    const landedOn = db.prepare("SELECT to_pubkey AS pk FROM room_gifts WHERE invite_code = ? AND from_pubkey = ? AND kind = 'vouch' LIMIT 1");
    const holdAt = db.prepare("SELECT at FROM voucher_allocations WHERE member_pubkey = ? AND kind = 'hold' AND ref = ? ORDER BY rowid LIMIT 1");
    const returned = db.prepare("SELECT 1 FROM voucher_allocations WHERE member_pubkey = ? AND kind = 'return' AND ref = ?");
    const revokedAt = db.prepare("SELECT 1 FROM known_floor_log WHERE action = 'invite_revoked' AND member_pubkey = ? AND at = ?");
    const codeRow = db.prepare('SELECT used_by, created_at FROM invite_codes WHERE code = ?');
    const personOf = (who: string) => ({ memberPubkey: who, callsign: callsignOf(who) });
    return rows.map((r): HistoryLine => {
        const line: HistoryLine = { kind: r.kind, amount_c: r.amount_c, actor: r.actor, actorCallsign: callsignOf(r.actor) || null, at: r.at };
        if (!r.ref || (r.kind !== 'hold' && r.kind !== 'return')) return line;
        const gift = r.kind === 'hold' ? giftTo.get(r.ref, pk) as { pk: string } | undefined : undefined;
        if (gift) return { ...line, for: 'profile', person: personOf(gift.pk) };
        const code = codeRow.get(r.ref) as { used_by: string | null; created_at: string } | undefined;
        if (r.kind === 'return') {
            // The node writes a return when a code lapses (the prune, a writer first) or its vouch can't land at the redeem;
            // anyone else's is an invite revoked (its `invite_revoked` log line stamped the same moment) or a budget stopped
            // with the code still out.
            const why = r.actor !== 'node' ? (revokedAt.get(pk, r.at) ? 'revoked' : 'stopped') : code?.used_by ? 'not_landed' : 'expired';
            return { ...line, for: 'invite', inviteMadeAt: (holdAt.get(pk, r.ref) as { at: string } | undefined)?.at ?? null, why };
        }
        const to = (landedOn.get(r.ref, pk) as { pk: string } | undefined)?.pk;
        const back = !!returned.get(pk, r.ref) || !code || (!code.used_by && code.created_at <= cutoff);
        return { ...line, for: 'invite', inviteMadeAt: r.at, outcome: to ? 'vouched' : back ? 'back' : 'held', person: to ? personOf(to) : null };
    });
}

/**
 * The people one voucher vouched for, one level, newest first: how much (`amount_c`, whole hundredths), raised or not, below zero now (a mark, no figure),
 * and where their completed trades reach (`trading`, tradingOf).
 */
function peopleOf(pk: string) {
    const trading = tradingOf(pk);
    return (db.prepare(`SELECT to_pubkey AS pk, SUM(amount_c) AS amount_c, COUNT(*) AS pieces, MIN(at) AS first_at, MAX(invite_code IS NOT NULL) AS by_invite,
            SUM(COALESCE(written_off_c, 0)) AS written_off_c FROM room_gifts WHERE kind = 'vouch' AND from_pubkey = ? GROUP BY to_pubkey ORDER BY first_at DESC`).all(pk) as
        { pk: string; amount_c: number; pieces: number; first_at: string; by_invite: number; written_off_c: number }[])
        .map((r) => {
            const m = getMember(db, r.pk);
            return {
                memberPubkey: r.pk, callsign: m?.callsign ?? '', joinedAt: m?.joinedAt ?? null, amount_c: r.amount_c, raised: r.pieces > 1,
                byInvite: r.by_invite === 1, belowZero: m?.status === 'active' && belowZeroNow(r.pk), left: m?.status !== 'active', writtenOff: r.written_off_c,
                vouchesForMe: pairOf(r.pk, pk).total > 0, trading: trading.get(r.pk) ?? 'none',
            };
        });
}

/** A voucher's card (GET /api/names/vouchers/:member), with its history and the people they vouched for. */
export function voucherCard(pk: string) {
    return { ...voucherSummary(pk), history: historyOf(pk), people: peopleOf(pk) };
}

/**
 * The card for an owner or admin (owners and admins read it: §3, §5), a look logged in the known floor's log, which every
 * owner and admin reads, once per viewer and voucher a day. `canChange`: whether this viewer sets budgets; `canStop`: whether
 * they may stop this one now (never an owner's; an admin's by an owner only).
 */
export function readVoucherCard(viewer: string, member: unknown) {
    const pk = memberKey(member);
    const row = voucherRow(pk);
    if (!row) throw new VoucherError(404, 'not_voucher', notVoucher(callsignOf(pk)));
    assertPlainTablesWritable();
    const since = new Date(Date.now() - DAY_MS).toISOString();
    if (!db.prepare("SELECT 1 FROM known_floor_log WHERE actor_pubkey = ? AND action = 'voucher_looked' AND member_pubkey = ? AND at > ?").get(viewer, pk, since)) {
        logLine(viewer, 'voucher_looked', pk, null, null);
    }
    return { ...voucherCard(pk), canChange: isOnCreditCommittee(viewer) && viewer !== pk, canStop: mayStop(viewer, pk) };
}

/**
 * GET /api/vouchers/me: whether the signer is a voucher now, their numbers and history, the presets they pick from (any
 * member). An owner (Marty, 9 Nov): `noLimit`, the six owner presets, and 500 for one person; the apps show "No limit".
 */
export function myVouching(pk: string) {
    const live = !!liveVoucher(pk);
    const owner = live && isNodeOwner(pk);
    return {
        voucher: live,
        ...(live ? { budget: budgetOf(pk), source: voucherRow(pk)!.source, history: historyOf(pk, 50) } : {}),
        noLimit: owner, presets: [...vouchPresetsFor(owner)], vouchMax: vouchMaxFor(owner), budgetMax: VOUCHER_BUDGET_MAX,
        // Their own Ask for more button (slice C3): whether an ask is open, when they may ask again, or why they can't. An
        // owner vouches with no limit and has nothing to ask for: null, as for a member who is no voucher.
        ask: live && !owner ? askStateOf(pk) : null,
        // The vouches people gave the signer, as their Ledger shows them (§6 `vouchedBy`).
        vouchedBy: (db.prepare(`SELECT from_pubkey AS pk, SUM(amount_c) AS amount_c, MIN(at) AS at FROM room_gifts WHERE kind = 'vouch' AND to_pubkey = ?
            GROUP BY from_pubkey ORDER BY MIN(at) ASC`).all(pk) as { pk: string; amount_c: number; at: string }[])
            .map((r) => ({ memberPubkey: r.pk, callsign: callsignOf(r.pk), amount_c: r.amount_c, at: r.at })),
    };
}
