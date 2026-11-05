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
 * line, entry → role) instead of stopping it, the same left and held. Only an owner lowers an owner's budget.
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
 * VOUCHES_PER_PERSON (3) vouchers' vouches count for one person (rule 2). Never from a profile for a member below zero now,
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
    isVouchPreset, isBudgetLevel, isMemberGiftSetting, word, wordsFor,
} from '@beanpool/core';
import { getMember, isVisitorKey } from '@beanpool/engine';
import { db } from '../db/db.js';
import { getNodeRole, assertPlainTablesWritable } from '../config/node-role.js';
import { assertBeansOn, getProfileSwitches } from '../config/node-profile.js';
import { isNodeOwner, isNodeAdmin, heldPrivilegedRole, NODE_ROLE_ACTS } from './node-roles.js';
import { keepNotice } from './kept-notices.js';

// A refusal with values in it, in English as a template literal wrote it, marked for the way out (member-words.ts).
const { t: tr } = wordsFor('en');

export const VOUCHER_BUDGET_KEY = 'voucher_budget';
export const MEMBER_GIFT_KEY = 'member_gift';
/** The actor of the boot's grants to owners and admins who never had a budget. */
export const VOUCHERS_MIGRATION_ACTOR = 'migration:vouchers';
/** The actor of the first owner's grant, made by the community's claim code. */
export const CLAIM_ACTOR = 'node:claim';

/** An invite lives 30 days (engine/invites.ts redeemInvite): a hold on a code older than that is back in the budget. */
const INVITE_LIFE_MS = 30 * 24 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

export class VoucherError extends Error {
    constructor(readonly status: number, readonly code: string, message: string) {
        super(message);
        this.name = 'VoucherError';
    }
}

export const VOUCHER_WORDS = {
    notAVoucher: word('You aren’t a voucher here, so you can’t vouch for anyone. An owner or the credit committee makes vouchers.'),
    badAmount: word('A vouch is 25, 50, 75 or 100 Beans.'),
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
    voucherEnded: word('The vouch on this invite ended before you joined; you start with no credit line'),
    frozen: word('Your credit line is frozen, so you can’t vouch from your budget until an admin unfreezes it.'),
    noticeTitle: word('Your budget to vouch from'),
    noticeStopped: word('Your budget to vouch from was stopped. The credit lines you gave stay with the people you gave them to.'),
} as const;

const notEnough = (left: number, amount: number) => tr('You have {left} Beans of budget left, so you can’t vouch {amount}. Pick a smaller vouch, or ask an owner for more.', { left, amount });
const alreadyVouched = (name: string) => tr('You’ve already vouched for @{name}.', { name });
const threeVouches = (name: string) => tr('@{name} has three vouches.', { name });
const belowZero = (name: string) => tr('@{name} is below zero: a credit-line gift or a Decision can help.', { name });
const noVouchYet = (name: string) => tr('You haven’t vouched for @{name} yet, so there is no vouch to raise.', { name });
const overMax = (name: string, total: number) => tr('Your vouch for @{name} can come to {max} Beans at most, and it is {total} now.', { name, max: VOUCH_MAX, total });
const alreadyVoucher = (name: string) => tr('@{name} is a voucher already.', { name });
const notVoucher = (name: string) => tr('@{name} isn’t a voucher.', { name });
const roleVoucher = (name: string) => tr('@{name} vouches as an owner or admin while they hold that role, so their budget can’t be stopped. You can lower it instead.', { name });
const ownerVoucher = (name: string) => tr('@{name} vouches as an owner while they hold that role, so their budget can’t be stopped, and only another owner can lower it.', { name });
const ownerBudget = (name: string) => tr('@{name} is an owner: only another owner can lower their budget.', { name });
const belowHeld = (name: string, held: number) => tr('@{name} has {held} Beans held on invites not used yet, so their budget can’t go below that.', { name, held });
const overCeiling = () => tr('A voucher has at most {max} Beans in hand, left and held together.', { max: VOUCHER_BUDGET_MAX });
const openDebt = (amount: number) => tr('The person on this entry left owing the Commons {amount} Beans, and that debt is still open. Settle it first: they pay it back, work it off, or the community forgives it.', { amount });
const raisePaused = (name: string) => tr('@{name}’s account is paused, so their budget can’t be raised while it lasts. You can still lower it.', { name });
const raiseFrozen = (name: string) => tr('@{name}’s credit line is frozen, so their budget can’t be raised until an admin unfreezes it. You can still lower it.', { name });
const noticeMade = (level: number) => tr('You’re a voucher now: you have a budget of {level} Beans to vouch for people, up to {max} each.', { level, max: VOUCH_MAX });
const noticeRaised = (level: number, left: number) => tr('Your budget to vouch from was raised to {level} Beans. You have {left} of it left to vouch with.', { level, left });
const noticeLowered = (level: number, left: number) => tr('Your budget to vouch from was lowered to {level} Beans. You have {left} of it left to vouch with.', { level, left });

const now = () => new Date().toISOString();
const newId = () => crypto.randomBytes(16).toString('hex');
const callsignOf = (pk: string | null | undefined): string => (pk ? getMember(db, pk)?.callsign ?? '' : '');

// ── The settings ─────────────────────────────────────────────────────────────────────────────────────────────────

function configRow(key: string): string | null {
    return (db.prepare('SELECT value FROM node_config WHERE key = ?').get(key) as { value: string | null } | undefined)?.value ?? null;
}

/** What a voucher's appointment is prefilled with: the owner's setting, 100 to 2,000 in 100s (no row: 1,000). */
export function voucherBudgetSetting(): number {
    const n = Number(configRow(VOUCHER_BUDGET_KEY));
    return isBudgetLevel(n) ? n : VOUCHER_BUDGET_DEFAULT;
}

/** The most of their credit line a member may give at once (slice G1): the owner's setting, 0 (off) to 100. */
export function memberGiftSetting(): number {
    const raw = configRow(MEMBER_GIFT_KEY);
    const n = raw === null ? NaN : Number(raw);
    return isMemberGiftSetting(n) ? n : MEMBER_GIFT_DEFAULT;
}

export function voucherSettings() {
    return {
        voucherBudget: voucherBudgetSetting(), memberGift: memberGiftSetting(),
        presets: [...VOUCH_PRESETS], vouchMax: VOUCH_MAX, vouchesPerPerson: VOUCHES_PER_PERSON, budgetMax: VOUCHER_BUDGET_MAX,
    };
}

// ── The log every owner and admin reads (known_floor_log, config/known-floor.ts) ─────────────────────────────────────

function logLine(actor: string, action: string, member: string | null, oldValue: unknown, newValue: unknown): void {
    db.prepare('INSERT INTO known_floor_log (id, actor_pubkey, action, member_pubkey, old_value, new_value) VALUES (?, ?, ?, ?, ?, ?)')
        .run(newId(), actor, action, member, oldValue == null ? null : String(oldValue), newValue == null ? null : String(newValue));
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
    /** On invites not used yet and in date. */
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

export function budgetOf(pk: string, at = Date.now()): Budget {
    const cutoff = lifeCutoff(at);
    const lines = (db.prepare('SELECT COALESCE(SUM(amount), 0) AS n FROM voucher_allocations WHERE member_pubkey = ?').get(pk) as { n: number }).n;
    const lapsed = (db.prepare(`SELECT COALESCE(SUM(-h.amount), 0) AS n FROM voucher_allocations h WHERE h.member_pubkey = ? AND ${LAPSED_HOLD}`).get(pk, cutoff) as { n: number }).n;
    const left = lines + lapsed;
    const held = db.prepare(`SELECT COALESCE(SUM(-h.amount), 0) AS n, COUNT(*) AS c FROM voucher_allocations h
        JOIN invite_codes ic ON ic.code = h.ref
        WHERE h.member_pubkey = ? AND ${OPEN_HOLD} AND ic.used_by IS NULL AND ic.created_at > ?`).get(pk, cutoff) as { n: number; c: number };
    const vouched = db.prepare(`SELECT COALESCE(SUM(amount), 0) AS n, COUNT(DISTINCT to_pubkey) AS c FROM room_gifts
        WHERE from_pubkey = ? AND kind = 'vouch'`).get(pk) as { n: number; c: number };
    return { left, held: held.n, heldInvites: held.c, vouched: vouched.n, peopleVouched: vouched.c, level: left + held.n };
}

function addLine(pk: string, kind: 'grant' | 'top_up' | 'lower' | 'hold' | 'return' | 'stop', amount: number, actor: string, ref: string | null = null): void {
    db.prepare('INSERT INTO voucher_allocations (id, member_pubkey, kind, amount, actor, ref, at) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(newId(), pk, kind, amount, actor, ref, now());
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
    const lapsed = db.prepare(`SELECT h.member_pubkey AS pk, h.ref AS ref, -h.amount AS amount FROM voucher_allocations h
        WHERE ${LAPSED_HOLD} AND (? IS NULL OR h.member_pubkey = ?)`)
        .all(lifeCutoff(at), pk, pk) as { pk: string; ref: string; amount: number }[];
    db.transaction(() => { for (const l of lapsed) addLine(l.pk, 'return', l.amount, 'node', l.ref); })();
    return lapsed.length;
}

/**
 * Ends a budget, inside the caller's transaction: every open hold back (the codes stay valid and carry nothing), one `stop`
 * line for what is left, and the row stopped. Room already given stays given.
 */
function stopBudget(pk: string, actor: string, reason: 'role_lost' | 'stopped' | 'revoked' | 'departed'): void {
    const open = db.prepare(`SELECT h.ref AS ref, -h.amount AS amount FROM voucher_allocations h WHERE h.member_pubkey = ? AND ${OPEN_HOLD}
          AND NOT EXISTS (SELECT 1 FROM invite_codes ic WHERE ic.code = h.ref AND ic.used_by IS NOT NULL)`).all(pk) as { ref: string; amount: number }[];
    for (const o of open) addLine(pk, 'return', o.amount, actor, o.ref);
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
    dispatchPushNotification: (targets: string[], actor: string, title: string, body: string, data: Record<string, any>, category: 'marketplace', kind: 'community.notice') => unknown;
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
        hooks.dispatchPushNotification([n.to], 'SYSTEM', n.title, n.body, n.data, 'marketplace', 'community.notice');
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
 * At boot on a main server with Beans on: every owner and admin whose role acts and who never had a budget gets one, actor
 * `migration:vouchers`. On a node from before vouchers, that is every owner and admin, once; later boots find only one
 * made outside grantNodeRole (the shell's claim or recover), or none. A budget someone stopped is never granted again here.
 */
export function grantMissingRoleBudgets(): number {
    if (getNodeRole() !== 'primary' || !getProfileSwitches().beans) return 0;
    const keys = (db.prepare(`SELECT nr.member_pubkey AS pk FROM node_roles nr JOIN members m ON m.public_key = nr.member_pubkey
        WHERE nr.role IN ('owner', 'admin') AND ${NODE_ROLE_ACTS} AND NOT EXISTS (SELECT 1 FROM vouchers v WHERE v.member_pubkey = nr.member_pubkey)
        ORDER BY nr.granted_at ASC, nr.member_pubkey ASC`).all() as { pk: string }[]).map((r) => r.pk);
    const amount = voucherBudgetSetting();
    db.transaction(() => { for (const pk of keys) startBudget(pk, 'role', null, amount, VOUCHERS_MIGRATION_ACTOR); })();
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
export function makeVoucher(actor: string, body: { entryId?: unknown; amount?: unknown }, tell?: TellVoucher) {
    assertCommittee(actor);
    if (typeof body.entryId !== 'string' || !/^[0-9a-f]{32}$/.test(body.entryId)) throw new VoucherError(400, 'bad_entry', 'An entry id is 32 hexadecimal characters.');
    const conf = db.prepare('SELECT member_pubkey, needs_second, seconded_at FROM confirmations WHERE entry_id = ? AND revoked_at IS NULL')
        .get(body.entryId) as { member_pubkey: string; needs_second: number; seconded_at: string | null } | undefined;
    if (!conf) throw new VoucherError(409, 'not_confirmed', VOUCHER_WORDS.notConfirmed);
    if (conf.needs_second && !conf.seconded_at) throw new VoucherError(409, 'awaiting_second', VOUCHER_WORDS.awaitingSecond);
    const debt = db.prepare("SELECT amount FROM names_debts WHERE entry_id = ? AND status = 'open' ORDER BY removed_at DESC LIMIT 1").get(body.entryId) as { amount: number } | undefined;
    if (debt) throw new VoucherError(409, 'open_debt', openDebt(debt.amount));
    const pk = conf.member_pubkey;
    const m = getMember(db, pk);
    if (!m || m.status !== 'active' || isVisitorKey(db, pk) || m.isTreasury) throw new VoucherError(409, 'not_confirmed', VOUCHER_WORDS.notConfirmed);
    if (pk === actor) throw new VoucherError(403, 'own_budget', VOUCHER_WORDS.ownBudget);
    const amount = body.amount === undefined ? voucherBudgetSetting() : body.amount;
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
        throw new VoucherError(409, 'role_voucher', held === 'owner' && !isNodeOwner(actor) ? ownerVoucher(callsignOf(pk)) : roleVoucher(callsignOf(pk)));
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
 * An owner's budget (their role held, or held aside by a suspension) is lowered only by another owner: a committee admin
 * may raise it, never take from it (403 `owner_only`). These routes take a member's own signature and nothing else (no
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
    const notice = db.transaction((): VoucherNotice | undefined => {
        returnLapsedHolds(pk);
        const before = budgetOf(pk);
        if (level < before.held) throw new VoucherError(409, 'below_held', belowHeld(callsignOf(pk), before.held));
        const n = level - before.level;
        if (n === 0) return undefined;
        if (n < 0 && heldPrivilegedRole(pk) === 'owner' && !isNodeOwner(actor)) throw new VoucherError(403, 'owner_only', ownerBudget(callsignOf(pk)));
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

/** The owner's two settings (POST /api/names/vouchers/settings `{ voucherBudget?, memberGift? }`), each change a log line. */
export function setVoucherSettings(actor: string, body: { voucherBudget?: unknown; memberGift?: unknown }) {
    assertPlainTablesWritable();
    assertBeansOn();
    if (!isNodeOwner(actor)) throw new VoucherError(403, 'owner_only', VOUCHER_WORDS.ownerOnly);
    if (body.voucherBudget !== undefined && !isBudgetLevel(body.voucherBudget)) throw new VoucherError(400, 'bad_level', VOUCHER_WORDS.badLevel);
    if (body.memberGift !== undefined && !isMemberGiftSetting(body.memberGift)) throw new VoucherError(400, 'bad_gift', VOUCHER_WORDS.badGift);
    const before = voucherSettings();
    // Each write names its key (test-replication-manifest reads every node_config write); the default removes the row.
    db.transaction(() => {
        if (body.voucherBudget !== undefined && body.voucherBudget !== before.voucherBudget) {
            if (body.voucherBudget === VOUCHER_BUDGET_DEFAULT) db.prepare('DELETE FROM node_config WHERE key = ?').run(VOUCHER_BUDGET_KEY);
            else db.prepare('INSERT INTO node_config (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(VOUCHER_BUDGET_KEY, String(body.voucherBudget));
            logLine(actor, 'budget_setting', null, before.voucherBudget, body.voucherBudget);
        }
        if (body.memberGift !== undefined && body.memberGift !== before.memberGift) {
            if (body.memberGift === MEMBER_GIFT_DEFAULT) db.prepare('DELETE FROM node_config WHERE key = ?').run(MEMBER_GIFT_KEY);
            else db.prepare('INSERT INTO node_config (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(MEMBER_GIFT_KEY, String(body.memberGift));
            logLine(actor, 'gift_setting', null, before.memberGift, body.memberGift);
        }
    })();
    return voucherSettings();
}

// ── The vouch ────────────────────────────────────────────────────────────────────────────────────────────────────

/** The stored balance, never read through the ledger (memory boot-getbalance-before-exemptions): below zero now? */
function belowZeroNow(pk: string): boolean {
    return ((db.prepare('SELECT balance FROM accounts WHERE public_key = ?').get(pk) as { balance: number } | undefined)?.balance ?? 0) < 0;
}

/** What one voucher's vouches for one person come to, and how many vouchers' vouches the person has. */
function pairOf(voucher: string, person: string): { total: number; vouchers: number } {
    const total = (db.prepare(`SELECT COALESCE(SUM(amount), 0) AS n FROM room_gifts WHERE kind = 'vouch' AND from_pubkey = ? AND to_pubkey = ?`).get(voucher, person) as { n: number }).n;
    const vouchers = (db.prepare(`SELECT COUNT(DISTINCT from_pubkey) AS n FROM room_gifts WHERE kind = 'vouch' AND to_pubkey = ?`).get(person) as { n: number }).n;
    return { total, vouchers };
}

/** Inside a vouch's transaction: the vouch's room_gifts row, from the voucher's budget (its hold written by the caller). */
function addVouchRow(voucher: string, person: string, amount: number, inviteCode: string | null): string {
    const id = newId();
    db.prepare(`INSERT INTO room_gifts (id, from_pubkey, to_pubkey, root_pubkey, kind, amount, invite_code, at) VALUES (?, ?, ?, ?, 'vouch', ?, ?, ?)`)
        .run(id, voucher, person, voucher, amount, inviteCode, now());
    return id;
}

/**
 * The checks of a vouch from `voucher`, before any write and again inside its transaction: a voucher, a preset, a budget
 * not frozen, at most what is left (a hold whose code lapsed counted back, as budgetOf counts it). Beans on, a main
 * server. Throws VoucherError, or Beans off's own refusal.
 */
function assertMayVouch(voucher: string, amount: unknown): number {
    assertPlainTablesWritable();
    assertBeansOn();
    if (!liveVoucher(voucher)) throw new VoucherError(403, 'not_a_voucher', VOUCHER_WORDS.notAVoucher);
    if (!isVouchPreset(amount)) throw new VoucherError(400, 'bad_amount', VOUCHER_WORDS.badAmount);
    if (isFrozen(voucher)) throw new VoucherError(409, 'frozen', VOUCHER_WORDS.frozen);
    const { left } = budgetOf(voucher);
    if (amount > left) throw new VoucherError(409, 'not_enough', notEnough(left, amount));
    return amount;
}

/**
 * A vouch from a member's profile (POST /api/vouch `{ memberPubkey, vouchAmount, raise? }`, §4 Q1 and §9), landing at once:
 * a `hold` with the room_gifts id and the room_gifts row, in one transaction that checks every rule again. Without `raise`,
 * the voucher's one vouch for this person; with it, a further vouch on top of theirs, the two together at most 100.
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
        assertMayVouch(voucher, amount);
        if (belowZeroNow(person)) throw new VoucherError(409, 'below_zero', belowZero(m.callsign));
        const pair = pairOf(voucher, person);
        if (raise) {
            if (pair.total === 0) throw new VoucherError(409, 'no_vouch_yet', noVouchYet(m.callsign));
            if (pair.total + amount > VOUCH_MAX) throw new VoucherError(409, 'over_max', overMax(m.callsign, pair.total));
        } else {
            if (pair.total > 0) throw new VoucherError(409, 'already_vouched', alreadyVouched(m.callsign));
            if (pair.vouchers >= VOUCHES_PER_PERSON) throw new VoucherError(409, 'three_vouches', threeVouches(m.callsign));
        }
        id = addVouchRow(voucher, person, amount, null);
        addLine(voucher, 'hold', -amount, voucher, id);
    })();
    return { id, memberPubkey: person, amount, total: pairOf(voucher, person).total, budget: budgetOf(voucher) };
}

/**
 * Before an invite with a vouch is made (engine/invites.ts generateInvite): the maker's right to it, and the amount.
 * Throws as a profile vouch does. The hold itself is written with the code, in one transaction ({@link holdForInvite}).
 */
export function checkInviteVouch(maker: string, amount: unknown): number {
    return assertMayVouch(maker, amount);
}

/** Inside generateInvite's transaction, with the code's row: the hold, after every check again. */
export function holdForInvite(maker: string, code: string, amount: number): void {
    returnLapsedHolds(maker);
    assertMayVouch(maker, amount);
    addLine(maker, 'hold', -amount, maker, code);
}

/**
 * At the redeem of an invite that carries a vouch, inside the redeem's transaction: the vouch lands on the joiner as a
 * room_gifts row if its hold is still live (no `return`: its maker's budget was not stopped since), and is their maker's one
 * vouch for them (a joiner is new: no vouch yet, never three). Otherwise nothing lands, and the joiner is told. Never a
 * refusal: the joiner joins either way. With Beans switched off since the code was made (before any Bean moved: the ledger
 * keeps them on after), no room lands either, and the hold goes back to its maker. Nor while the maker's credit line or
 * known floor is frozen (nothing more out of a frozen budget): the hold goes back, and once unfrozen the maker may vouch
 * for the joiner from their profile, this pair having no vouch yet.
 */
export function landInviteVouch(maker: string, code: string, joiner: string, amount: number): { landed: number } | { ended: string } {
    const hold = db.prepare(`SELECT -h.amount AS amount FROM voucher_allocations h WHERE h.member_pubkey = ? AND h.ref = ? AND ${OPEN_HOLD}`)
        .get(maker, code) as { amount: number } | undefined;
    if (!hold || hold.amount !== amount || !isVouchPreset(amount)) return { ended: VOUCHER_WORDS.voucherEnded };
    const pair = pairOf(maker, joiner);
    if (!getProfileSwitches().beans || isFrozen(maker) || pair.total > 0 || pair.vouchers >= VOUCHES_PER_PERSON) {
        addLine(maker, 'return', amount, 'node', code);
        return { ended: VOUCHER_WORDS.voucherEnded };
    }
    addVouchRow(maker, joiner, amount, code);
    return { landed: amount };
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
        const pieces = db.prepare(`SELECT g.id, g.amount - COALESCE((SELECT SUM(p.amount) FROM room_gifts p WHERE p.source_gift_id = g.id), 0) AS open
            FROM room_gifts g WHERE g.to_pubkey = ? AND g.written_off IS NULL ORDER BY g.at ASC, g.id ASC`).all(pk) as { id: string; open: number }[];
        const stamp = db.prepare('UPDATE room_gifts SET written_off = ?, written_off_at = ? WHERE id = ?');
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

/** One voucher's numbers (the vouchers block's row, the card's head). No balance figure: "below zero" is a count. */
export function voucherSummary(pk: string) {
    const row = voucherRow(pk);
    const b = budgetOf(pk);
    const people = db.prepare(`SELECT DISTINCT to_pubkey AS pk FROM room_gifts WHERE kind = 'vouch' AND from_pubkey = ?`).all(pk) as { pk: string }[];
    const below = people.filter((p) => belowZeroNow(p.pk)).length;
    const writtenOff = (db.prepare('SELECT COALESCE(SUM(written_off), 0) AS n FROM room_gifts WHERE root_pubkey = ?').get(pk) as { n: number }).n;
    const passed = db.prepare(`SELECT COALESCE(SUM(amount), 0) AS n, COUNT(DISTINCT to_pubkey) AS c FROM room_gifts WHERE kind = 'gift' AND root_pubkey = ?`).get(pk) as { n: number; c: number };
    const sent = (db.prepare('SELECT COUNT(*) AS n FROM invite_codes WHERE created_by = ? AND vouch_amount IS NOT NULL').get(pk) as { n: number }).n;
    const marks = [...tradingOf(pk).values()];
    return {
        memberPubkey: pk, callsign: callsignOf(pk), source: row?.source ?? null, entryId: row?.entry_id ?? null,
        madeBy: row?.made_by ?? null, madeByCallsign: callsignOf(row?.made_by), madeAt: row?.made_at ?? null,
        stoppedAt: row?.stopped_at ?? null, stopReason: row?.stop_reason ?? null,
        ...b, belowZero: below, writtenOff, passedOn: { amount: passed.n, people: passed.c }, invitesWithVouch: sent,
        trading: { withOthers: marks.filter((m) => m === 'others').length, insideOnly: marks.filter((m) => m === 'inside').length },
    };
}

/**
 * The vouchers block (GET /api/names/vouchers, owners and committee admins): every live voucher with their numbers, by
 * callsign. The names list orders entries by the names its admins' phones open, which this server never reads: each row
 * carries its entry id, and the phone puts the block in the list's own order.
 */
export function vouchersBlock() {
    const keys = db.prepare(`SELECT v.member_pubkey AS pk FROM vouchers v JOIN members m ON m.public_key = v.member_pubkey
        WHERE v.stopped_at IS NULL AND m.status = 'active' AND m.is_visitor = 0 ORDER BY m.callsign COLLATE NOCASE ASC, v.member_pubkey ASC`).all() as { pk: string }[];
    return { vouchers: keys.map((k) => voucherSummary(k.pk)), settings: voucherSettings() };
}

/** One line of a Budget history: what moved, by whose hand, and for what, never which invite code. */
export interface HistoryLine {
    kind: string; amount: number; actor: string; actorCallsign: string | null; at: string;
    /** A hold or a return: an invite's vouch, or one from a member's profile. Absent on a grant, a level or a stop. */
    for?: 'invite' | 'profile';
    /** An invite's: when it was made (its hold's moment, written with the code). */
    inviteMadeAt?: string | null;
    /** An invite's hold: still held, landed on someone (`vouched`), or back in the budget (expired, stopped or not landed). */
    outcome?: 'held' | 'vouched' | 'back';
    /** A return: the invite lapsed unused (`expired`), the budget stopped first, or the vouch didn't land at the redeem. */
    why?: 'expired' | 'stopped' | 'not_landed';
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
    const rows = db.prepare('SELECT kind, amount, actor, ref, at FROM voucher_allocations WHERE member_pubkey = ? ORDER BY at DESC, rowid DESC LIMIT ?').all(pk, limit) as
        { kind: string; amount: number; actor: string; ref: string | null; at: string }[];
    const giftTo = db.prepare("SELECT to_pubkey AS pk FROM room_gifts WHERE id = ? AND from_pubkey = ? AND kind = 'vouch'");
    const landedOn = db.prepare("SELECT to_pubkey AS pk FROM room_gifts WHERE invite_code = ? AND from_pubkey = ? AND kind = 'vouch' LIMIT 1");
    const holdAt = db.prepare("SELECT at FROM voucher_allocations WHERE member_pubkey = ? AND kind = 'hold' AND ref = ? ORDER BY rowid LIMIT 1");
    const returned = db.prepare("SELECT 1 FROM voucher_allocations WHERE member_pubkey = ? AND kind = 'return' AND ref = ?");
    const codeRow = db.prepare('SELECT used_by, created_at FROM invite_codes WHERE code = ?');
    const personOf = (who: string) => ({ memberPubkey: who, callsign: callsignOf(who) });
    return rows.map((r): HistoryLine => {
        const line: HistoryLine = { kind: r.kind, amount: r.amount, actor: r.actor, actorCallsign: callsignOf(r.actor) || null, at: r.at };
        if (!r.ref || (r.kind !== 'hold' && r.kind !== 'return')) return line;
        const gift = r.kind === 'hold' ? giftTo.get(r.ref, pk) as { pk: string } | undefined : undefined;
        if (gift) return { ...line, for: 'profile', person: personOf(gift.pk) };
        const code = codeRow.get(r.ref) as { used_by: string | null; created_at: string } | undefined;
        if (r.kind === 'return') {
            // The node writes a return when a code lapses (the prune, a writer first) or its vouch can't land at the redeem;
            // anyone else's is a budget stopped with the code still out.
            const why = r.actor !== 'node' ? 'stopped' : code?.used_by ? 'not_landed' : 'expired';
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
    return (db.prepare(`SELECT to_pubkey AS pk, SUM(amount) AS amount, COUNT(*) AS pieces, MIN(at) AS first_at, MAX(invite_code IS NOT NULL) AS by_invite,
            SUM(COALESCE(written_off, 0)) AS written_off FROM room_gifts WHERE kind = 'vouch' AND from_pubkey = ? GROUP BY to_pubkey ORDER BY first_at DESC`).all(pk) as
        { pk: string; amount: number; pieces: number; first_at: string; by_invite: number; written_off: number }[])
        .map((r) => {
            const m = getMember(db, r.pk);
            return {
                memberPubkey: r.pk, callsign: m?.callsign ?? '', joinedAt: m?.joinedAt ?? null, amount: r.amount, raised: r.pieces > 1,
                byInvite: r.by_invite === 1, belowZero: m?.status === 'active' && belowZeroNow(r.pk), left: m?.status !== 'active', writtenOff: r.written_off,
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

/** GET /api/vouchers/me: whether the signer is a voucher now, their numbers and history, the presets (any member). */
export function myVouching(pk: string) {
    const live = !!liveVoucher(pk);
    return {
        voucher: live,
        ...(live ? { budget: budgetOf(pk), source: voucherRow(pk)!.source, history: historyOf(pk, 50) } : {}),
        presets: [...VOUCH_PRESETS], vouchMax: VOUCH_MAX, budgetMax: VOUCHER_BUDGET_MAX,
        // The vouches people gave the signer, as their Ledger shows them (§6 `vouchedBy`).
        vouchedBy: (db.prepare(`SELECT from_pubkey AS pk, SUM(amount) AS amount, MIN(at) AS at FROM room_gifts WHERE kind = 'vouch' AND to_pubkey = ?
            GROUP BY from_pubkey ORDER BY MIN(at) ASC`).all(pk) as { pk: string; amount: number; at: string }[])
            .map((r) => ({ memberPubkey: r.pk, callsign: callsignOf(r.pk), amount: r.amount, at: r.at })),
    };
}
