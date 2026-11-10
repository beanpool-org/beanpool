/**
 * Vouchers (scratch/fable-design/DESIGN-invites-and-names-list-amend2-fable.md §2 to §6, Marty's decisions of 5 Nov in §9 to
 * §11): who may vouch, the budget each holds as an append-only allocation ledger, the vouch on an invite and from a
 * member's profile, and the credit line (room) a vouch gives.
 *
 * ## Who is a voucher (`vouchers`)
 * - An owner or admin, by role (`source` 'role'): from the day the role is granted (node-roles.ts grantNodeRole, a role a
 *   suspension held aside and gave back) and, for every owner and admin who never had a budget, at boot (actor
 *   `migration:vouchers`: Byron's owners and admins vouch on day one). The budget ends with the role.
 * - A member whose confirmed names-list entry an owner or a credit-committee admin made one (`entry`). It ends on Stop
 *   vouching, a revoked confirmation, or with the account. Making a role voucher one from their entry allocates nothing
 *   and only moves the source to the entry, so losing the role later changes nothing.
 * Being on the list makes nobody a voucher; a moderator isn't one. One budget per member.
 *
 * An owner or admin vouches by the role whatever their budget's source (amend2 §2(b)): while they hold the role, Stop
 * vouching refuses their budget, and a revoked entry or a step-back moves its source back to the role (a `voucher_source`
 * line, entry → role) instead of stopping it, the same left and held. Nobody sets an owner's budget: an owner vouches with
 * no limit (Marty, 9 Nov; OWNER_VOUCH_ACTOR), and what the role gave them waits, whole, for a step down to admin.
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
 * read from the stored balance (rule 3). A vouch on an invite lands at the redeem, in its transaction (the joiner is new,
 * so it is their first, and it is that voucher's one vouch for them); an offline ticket never carries one.
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
} from '@beanpool/core';
import { getMember, isVisitorKey } from '@beanpool/engine';
import { db } from '../db/db.js';
import { getNodeRole, assertPlainTablesWritable } from '../config/node-role.js';
import { assertBeansOn, getProfileSwitches, getNodeProfile } from '../config/node-profile.js';
import { isNodeOwner, isNodeAdmin, heldPrivilegedRole, NODE_ROLE_ACTS } from './node-roles.js';
import { keepNotice, keptNoticeDetails, type KeptNoticePushOptions } from './kept-notices.js';
import { ownCoreLockRow } from '../config/core-settings.js';

// A refusal with values in it, in English as a template literal wrote it, marked for the way out (member-words.ts).
const { t: tr } = wordsFor('en');

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
    notMember: word('Only an active member of this community can be vouched for.'),
    committeeOnly: word('Only an owner or an admin on the credit committee makes vouchers and sets their budgets.'),
    ownBudget: word('Another owner or credit committee admin makes you a voucher or sets your budget.'),
    notConfirmed: word('Only a confirmed person on the names list can be made a voucher.'),
    awaitingSecond: word('This confirmation waits for a second admin. Make them a voucher once it is confirmed.'),
    badLevel: word('A budget is 100 to 2,000 Beans, in steps of 100.'),
    notAdmin: word('Only an admin can be put on the credit committee. Every owner is on it already.'),
    ownerOnly: word('Only an owner changes this.'),
    badGift: word('A member’s credit-line gift is 0 (off) to 100 Beans.'),
    giftInCoreSettings: word('Members giving part of their credit line is a core setting: an owner changes it in Settings, Core settings, which asks for their proof once the core settings are locked. Nothing in this request was saved.'),
    voucherEnded: word('The vouch on this invite ended before you joined; you start with no credit line'),
    frozen: word('Your credit line is frozen, so you can’t vouch from your budget until an admin unfreezes it.'),
    noticeTitle: word('Your budget to vouch from'),
    noticeStopped: word('Your budget to vouch from was stopped. The credit lines you gave stay with the people you gave them to.'),
} as const;

/** A figure (whole hundredths) in these English words. */
const B = (c: number) => formatHundredths(c, 'en');
const notEnough = (left: number, amount: number) => tr('You have {left} Beans of budget left, so you can’t vouch {amount}. Pick a smaller vouch, or ask an owner for more.', { left: B(left), amount: B(amount) });
const alreadyVouched = (name: string) => tr('You’ve already vouched for @{name}.', { name });
const threeVouches = (name: string) => tr('@{name} has three vouches.', { name });
const belowZero = (name: string) => tr('@{name} is below zero: a credit-line gift or a Decision can help.', { name });
const noVouchYet = (name: string) => tr('You haven’t vouched for @{name} yet, so there is no vouch to raise.', { name });
const overMax = (name: string, total: number, max: number) => tr('Your vouch for @{name} can come to {max} Beans at most, and it is {total} now.', { name, max: B(max), total: B(total) });
const overPerson = (name: string, total: number, max: number) => tr('@{name} has {total} Beans of vouches already, and one person’s vouches come to {max} at most.', { name, total: B(total), max: B(max) });
const alreadyVoucher = (name: string) => tr('@{name} is a voucher already.', { name });
const notVoucher = (name: string) => tr('@{name} isn’t a voucher.', { name });
const roleVoucher = (name: string) => tr('@{name} vouches as an owner or admin while they hold that role, so their budget can’t be stopped. You can lower it instead.', { name });
const ownerVoucher = (name: string) => tr('@{name} vouches as an owner while they hold that role, with no limit, so there is no budget to stop or set.', { name });
const ownerNoLimit = (name: string) => tr('@{name} is an owner: owners vouch with no limit, so there is no budget to set.', { name });
const belowHeld = (name: string, held: number) => tr('@{name} has {held} Beans held on invites not used yet, so their budget can’t go below that.', { name, held: B(held) });
const overCeiling = () => tr('A voucher has at most {max} Beans in hand, left and held together.', { max: B(VOUCHER_BUDGET_MAX) });
const openDebt = (amount: number) => tr('The person on this entry left owing the Commons {amount} Beans, and that debt is still open. Settle it first: they pay it back, work it off, or the community forgives it.', { amount: B(amount) });
const raisePaused = (name: string) => tr('@{name}’s account is paused, so their budget can’t be raised while it lasts. You can still lower it.', { name });
const raiseFrozen = (name: string) => tr('@{name}’s credit line is frozen, so their budget can’t be raised until an admin unfreezes it. You can still lower it.', { name });
const noticeMade = (level: number) => tr('You’re a voucher now: you have a budget of {level} Beans to vouch for people, up to {max} each.', { level: B(level), max: B(VOUCH_MAX) });
const noticeRaised = (level: number, left: number) => tr('Your budget to vouch from was raised to {level} Beans. You have {left} of it left to vouch with.', { level: B(level), left: B(left) });
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
 * stays given (the design §5.2 "Freezes", which amendment 1 §5.2 keeps for vouchers; §5.6 step 3 for a top-up).
 */
function isFrozen(pk: string): boolean {
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
 * deleted, given back after a suspension), inside the change's transaction where there is one: an owner or admin with no
 * live budget gets one (the community's setting, actor who granted it); anyone else loses a budget whose source is the
 * role. The place on the credit committee is an admin's (§5.4: the flag clears with the role): any change that leaves them
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
        if (role === 'owner' || role === 'admin') {
            if (!liveVoucher(pk) && getProfileSwitches().beans) startBudget(pk, 'role', null, voucherBudgetSetting(), by);
            return;
        }
        const row = voucherRow(pk);
        if (row && !row.stopped_at && row.source === 'role') {
            const status = (db.prepare('SELECT status FROM members WHERE public_key = ?').get(pk) as { status: string } | undefined)?.status;
            stopBudget(pk, by, status === 'pruned' ? 'departed' : 'role_lost');
        }
    });
}

/**
 * At boot on a main server with Beans on, the catch-all for a role changed outside grantNodeRole (the shell's claim or
 * recover, which write node_roles on their own connection): every owner and admin whose role acts and who has no LIVE
 * budget gets one, actor `migration:vouchers`; and anyone on the credit committee whose acting role is not admin leaves it,
 * with its `committee` line, as vouchingAfterRoleChange does inside the server. On a node from before vouchers, that is
 * every owner and admin, once; later boots find only the shell's, or none. A stopped budget on a current owner or admin
 * always comes from before the role they hold now (nothing in the server stops one while they hold it), so it is granted.
 */
export function grantMissingRoleBudgets(): number {
    if (getNodeRole() !== 'primary' || !getProfileSwitches().beans) return 0;
    const keys = (db.prepare(`SELECT nr.member_pubkey AS pk FROM node_roles nr JOIN members m ON m.public_key = nr.member_pubkey
        WHERE nr.role IN ('owner', 'admin') AND ${NODE_ROLE_ACTS} AND NOT EXISTS (SELECT 1 FROM vouchers v WHERE v.member_pubkey = nr.member_pubkey AND v.stopped_at IS NULL)
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
 * Make a voucher (POST /api/names/vouchers `{ entryId, amount? }`): the member confirmed against the entry, with a budget of
 * `amount` (100 to 2,000 in 100s; the community's setting when left out). A role voucher made one from their entry gets
 * nothing new: their budget's source moves to the entry, so losing the role later leaves it. Never yourself. A new budget
 * is a notice to its voucher, kept in the transaction and told by `tell` after it.
 */
export function makeVoucher(actor: string, body: { entryId?: unknown; amount_c?: unknown }, tell?: TellVoucher) {
    assertCommittee(actor);
    if (typeof body.entryId !== 'string' || !/^[0-9a-f]{32}$/.test(body.entryId)) throw new VoucherError(400, 'bad_entry', 'An entry id is 32 hexadecimal characters.');
    const conf = db.prepare('SELECT member_pubkey, needs_second, seconded_at FROM confirmations WHERE entry_id = ? AND revoked_at IS NULL')
        .get(body.entryId) as { member_pubkey: string; needs_second: number; seconded_at: string | null } | undefined;
    if (!conf) throw new VoucherError(409, 'not_confirmed', VOUCHER_WORDS.notConfirmed);
    if (conf.needs_second && !conf.seconded_at) throw new VoucherError(409, 'awaiting_second', VOUCHER_WORDS.awaitingSecond);
    const debt = db.prepare("SELECT amount_c FROM names_debts WHERE entry_id = ? AND status = 'open' ORDER BY removed_at DESC LIMIT 1").get(body.entryId) as { amount_c: number } | undefined;
    if (debt) throw new VoucherError(409, 'open_debt', openDebt(debt.amount_c));
    const pk = conf.member_pubkey;
    const m = getMember(db, pk);
    if (!m || m.status !== 'active' || isVisitorKey(db, pk) || m.isTreasury) throw new VoucherError(409, 'not_confirmed', VOUCHER_WORDS.notConfirmed);
    if (pk === actor) throw new VoucherError(403, 'own_budget', VOUCHER_WORDS.ownBudget);
    const amount = body.amount_c === undefined ? voucherBudgetSetting() : body.amount_c;
    if (!isBudgetLevel(amount)) throw new VoucherError(400, 'bad_level', VOUCHER_WORDS.badLevel);
    const live = liveVoucher(pk);
    if (live?.source === 'entry') throw new VoucherError(409, 'already_voucher', alreadyVoucher(m.callsign));
    const notice = db.transaction((): VoucherNotice | undefined => {
        returnLapsedHolds(pk);
        if (live) {
            db.prepare("UPDATE vouchers SET source = 'entry', entry_id = ?, made_by = ?, made_at = ? WHERE member_pubkey = ?").run(body.entryId, actor, now(), pk);
            logLine(actor, 'voucher_made', pk, 'role', 'entry');
            return undefined;
        }
        logLine(actor, 'voucher_made', pk, null, 'entry');
        startBudget(pk, 'entry', body.entryId as string, amount, actor);
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
 * Stop vouching (DELETE /api/names/vouchers/:member): a list budget only. A role budget ends with the role, and an owner
 * or admin (their role held, or held aside by a suspension) vouches by it whatever the budget's source, so theirs is
 * refused too: one made a voucher from their entry keeps vouching while they hold the role (amend2 §2(b)). A notice to them.
 */
export function stopVoucher(actor: string, member: unknown, tell?: TellVoucher) {
    assertCommittee(actor);
    const pk = memberKey(member);
    const live = openBudgetRow(pk);
    if (!live) throw new VoucherError(404, 'not_voucher', notVoucher(callsignOf(pk)));
    const held = heldPrivilegedRole(pk);
    if (live.source === 'role' || held) {
        throw new VoucherError(409, 'role_voucher', held === 'owner' ? ownerVoucher(callsignOf(pk)) : roleVoucher(callsignOf(pk)));
    }
    const notice = db.transaction(() => {
        stopBudget(pk, actor, 'stopped');
        return keepVoucherNotice(pk, 'stopped', VOUCHER_WORDS.noticeStopped, 0);
    })();
    tell?.(notice);
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
 */
export function setBudgetLevel(actor: string, member: unknown, body: { level?: unknown }, tell?: TellVoucher) {
    assertCommittee(actor);
    const pk = memberKey(member);
    if (!openBudgetRow(pk)) throw new VoucherError(404, 'not_voucher', notVoucher(callsignOf(pk)));
    if (pk === actor) throw new VoucherError(403, 'own_budget', VOUCHER_WORDS.ownBudget);
    const level = body.level;
    if (!isBudgetLevel(level)) throw new VoucherError(400, 'bad_level', VOUCHER_WORDS.badLevel);
    if (heldPrivilegedRole(pk) === 'owner') throw new VoucherError(409, 'no_limit', ownerNoLimit(callsignOf(pk)));
    const notice = db.transaction((): VoucherNotice | undefined => {
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
        return keepVoucherNotice(pk, n > 0 ? 'raised' : 'lowered', n > 0 ? noticeRaised(level, left) : noticeLowered(level, left), level);
    })();
    if (notice) tell?.(notice);
    return { ...voucherCard(pk), changed: notice !== undefined };
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
 * VoucherError, or Beans off's own refusal. `owner`: whether this vouch is an owner's.
 */
function assertMayVouch(voucher: string, amount: unknown): { amount_c: number; owner: boolean } {
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
    if (!owner) {
        const { left } = budgetOf(voucher);
        if (n > left) throw new VoucherError(409, 'not_enough', notEnough(left, n));
    }
    return { amount_c: n, owner };
}

/** The hold's actor: the voucher's own key, or OWNER_VOUCH_ACTOR for an owner's vouch (recorded, drawn from no budget). */
const holdActor = (voucher: string, owner: boolean) => (owner ? OWNER_VOUCH_ACTOR : voucher);

/**
 * A vouch from a member's profile (POST /api/vouch `{ memberPubkey, vouchAmount, raise? }`, §4 Q1 and §9), landing at once:
 * a `hold` with the room_gifts id and the room_gifts row, in one transaction that checks every rule again. Without `raise`,
 * the voucher's one vouch for this person; with it, a further vouch on top of theirs, the two together at most 100 (an
 * owner's: 500). Every vouch for one person comes to 300 at most, or 500 once an owner vouched for them or is vouching now
 * (Marty, 9 Nov). The three-vouchers rule never refuses an owner's vouch: theirs may top a person up to 500.
 */
export function vouchFromProfile(voucher: string, body: { memberPubkey?: unknown; vouchAmount?: unknown; raise?: unknown }) {
    const person = memberKey(body.memberPubkey);
    assertMayVouch(voucher, body.vouchAmount);
    const amount = body.vouchAmount as number;
    if (body.raise !== undefined && typeof body.raise !== 'boolean') throw new VoucherError(400, 'bad_raise', "'raise' is true or false.");
    const raise = body.raise === true;
    if (person === voucher) throw new VoucherError(403, 'own_vouch', VOUCHER_WORDS.ownVouch);
    const m = getMember(db, person);
    if (!m || m.status !== 'active' || isVisitorKey(db, person) || m.isTreasury) throw new VoucherError(404, 'not_member', VOUCHER_WORDS.notMember);
    let id = '';
    db.transaction(() => {
        returnLapsedHolds(voucher);
        const { owner } = assertMayVouch(voucher, amount);
        if (belowZeroNow(person)) throw new VoucherError(409, 'below_zero', belowZero(m.callsign));
        const pair = pairOf(voucher, person);
        const pairMax = vouchMaxFor(owner);
        if (raise) {
            if (pair.total === 0) throw new VoucherError(409, 'no_vouch_yet', noVouchYet(m.callsign));
            if (pair.total + amount > pairMax) throw new VoucherError(409, 'over_max', overMax(m.callsign, pair.total, pairMax), { prior: pair.total });
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

/**
 * The vouchers block (GET /api/names/vouchers, owners and committee admins): every live voucher with their numbers, owners
 * first (they vouch by role, with no limit: "Owners · no limit") and then by callsign, and `waiting`: the promised budgets
 * of invites not used yet. The names list orders entries by the names its admins' phones open, which this server never
 * reads: each row carries its entry id, and the phone puts the block in the list's own order.
 */
export function vouchersBlock() {
    const keys = db.prepare(`SELECT v.member_pubkey AS pk FROM vouchers v JOIN members m ON m.public_key = v.member_pubkey
        WHERE v.stopped_at IS NULL AND m.status = 'active' AND m.is_visitor = 0 ORDER BY m.callsign COLLATE NOCASE ASC, v.member_pubkey ASC`).all() as { pk: string }[];
    const vouchers = keys.map((k) => voucherSummary(k.pk));
    return {
        vouchers: [...vouchers.filter((v) => v.noLimit), ...vouchers.filter((v) => !v.noLimit)],
        waiting: waitingToJoin(),
        settings: voucherSettings(),
    };
}

/**
 * The button a profile shows an owner or admin, following the person's state (invites-vouching I4, DESIGN §3 ask 2):
 *   add       not on the names list (no live confirmation): "Add to the names list", the one-step add-and-confirm form
 *   make      confirmed, and the viewer is on the credit committee: "Make a voucher"
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
 * The people one voucher vouched for, one level, newest first: how much, raised or not, below zero now (a mark, no figure),
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
                memberPubkey: r.pk, callsign: m?.callsign ?? '', joinedAt: m?.joinedAt ?? null, amount: r.amount_c, raised: r.pieces > 1,
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
 * owner and admin reads, once per viewer and voucher a day. `canChange`: whether this viewer makes, stops and sets budgets.
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
    return { ...voucherCard(pk), canChange: isOnCreditCommittee(viewer) && viewer !== pk };
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
        // The vouches people gave the signer, as their Ledger shows them (§6 `vouchedBy`).
        vouchedBy: (db.prepare(`SELECT from_pubkey AS pk, SUM(amount_c) AS amount_c, MIN(at) AS at FROM room_gifts WHERE kind = 'vouch' AND to_pubkey = ?
            GROUP BY from_pubkey ORDER BY MIN(at) ASC`).all(pk) as { pk: string; amount_c: number; at: string }[])
            .map((r) => ({ memberPubkey: r.pk, callsign: callsignOf(r.pk), amount_c: r.amount_c, at: r.at })),
    };
}
