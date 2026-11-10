/**
 * The Community health panel and the rule on what the admins can see (community modes slice 6; scratch/global-node/
 * DESIGN-community-modes-fable.md §4.4, §7.1; scratch/fable-design/DESIGN-balance-rule-fable.md; Marty's answers 4 and 5,
 * and Q-A to Q-F on 2 November).
 *
 * Every owner and admin reads the community's totals, which are public by rule (privacy defaults, 28 September): Beans
 * in circulation, the sum of credit, the sum of debt, how many are in debit, the Commons pot and this month's trades.
 *
 * Only in a known community (the confirmation dial on): the exceptions. A CONFIRMED member past the debt line (default 50%
 * of their floor), or in debit with no sale for N days (default 60); and a member who stepped back from being confirmed
 * owing past their ordinary line, until they are back within it. The owner sets both lines; each change is a line in the
 * known floor's log. The answer carries keys and entry ids only: the names are sealed on the admins' phones, which overlay
 * them. Every opening of the exceptions is a line in health_access_log, which every owner and admin reads (the watchers
 * are watched): that log is the rule's safeguard. No export of balances, ever.
 *
 * It is a rule of being confirmed, not a consent: the oversight belongs to the known floor, and a member who wants neither
 * steps back (engine/names-list.ts stepBack). Nobody is listed on a basis they weren't told about, so:
 *  - the rule starts at once, when a node first runs it (config/balance-rule.ts) or the dial goes on, with no notice: the
 *    rule sentence on the join screen and the rules page is the telling. A node whose stamp this can't read lists nobody
 *    ({@link ruleStarted});
 *  - a tightened line waits 14 days and a loosened one applies at once ({@link effectiveLines});
 *  - a member is listed for debt past their ordinary line only if they stepped back owing it, as the step-back says.
 */
import crypto from 'node:crypto';
import { db } from '../db/db.js';
import { confirmationDialOn, isConfirmed, knownFloor } from '@beanpool/engine';
import { getBalance, getCommonsBalance, getMember, isVisitorKey } from '../state-engine.js';
import { listDebts } from './names-debts.js';
import { firstTradeFunnel } from './time-to-first-trade.js';
import { needsThisMonth } from './needs-this-month.js';
import { stepBack } from './names-list.js';
import { getNodeProfile } from '../config/node-profile.js';
import { assertPlainTablesWritable } from '../config/node-role.js';
import { BALANCE_RULE_FROM_KEY, LINE_NOTICE_MS, readRuleInstant } from '../config/balance-rule.js';

export const DEBT_LINE_PCT_KEY = 'health_debt_line_pct';
export const QUIET_DAYS_KEY = 'health_quiet_days';
export const DEBT_LINE_PCT_DEFAULT = 50;
export const QUIET_DAYS_DEFAULT = 60;

export class HealthError extends Error {
    constructor(readonly status: number, readonly code: string, message: string) {
        super(message);
        this.name = 'HealthError';
    }
}

function configNumber(key: string, fallback: number, min: number, max: number): number {
    const row = db.prepare('SELECT value FROM node_config WHERE key = ?').get(key) as { value: string } | undefined;
    if (!row || !/^\d{1,4}$/.test(row.value)) return fallback;
    const n = Number(row.value);
    return n >= min && n <= max ? n : fallback;
}

export function healthSettings() {
    return {
        debtLinePct: configNumber(DEBT_LINE_PCT_KEY, DEBT_LINE_PCT_DEFAULT, 1, 100),
        quietDays: configNumber(QUIET_DAYS_KEY, QUIET_DAYS_DEFAULT, 7, 3650),
        debtLinePctDefault: DEBT_LINE_PCT_DEFAULT,
        quietDaysDefault: QUIET_DAYS_DEFAULT,
    };
}

/** Whether exceptions can exist here at all: a node with Beans and the confirmation dial on. */
export function isKnownCommunity(): boolean {
    return getNodeProfile() !== 'global' && confirmationDialOn(db);
}

/**
 * Whether the rule has started here: it has once the stamp (the first boot's moment) can be read, and not before. There is
 * no start notice: a stamp from the days of a 14-day one holds a time in the future, and is read as started now. A stamp
 * this can't read (none, or not the exact form the boot writes) is false, and then nobody is listed on the rule (fails
 * closed). Turning the dial on is the rule arriving too, at once.
 */
export function ruleStarted(): boolean {
    const row = db.prepare('SELECT value FROM node_config WHERE key = ?').get(BALANCE_RULE_FROM_KEY) as { value: string } | undefined;
    return readRuleInstant(row?.value) !== null;
}

/**
 * The two lines the list reads now: each the loosest of its current value and every value it left in the last 14 days
 * (the known floor's log), so a tightened line waits and a loosened one applies at once. `…From`: when the line as the
 * owner set it applies, while it waits.
 */
export function effectiveLines(now = Date.now()) {
    const { debtLinePct, quietDays } = healthSettings();
    const rows = db.prepare("SELECT action, old_value, at FROM known_floor_log WHERE action IN ('health_debt_line', 'health_quiet_days') AND at > ?")
        .all(new Date(now - LINE_NOTICE_MS).toISOString()) as Array<{ action: string; old_value: string | null; at: string }>;
    const line = (action: string, current: number) => {
        const waiting = rows.filter(r => r.action === action && Number(r.old_value) > current);
        return {
            value: Math.max(current, ...waiting.map(r => Number(r.old_value))),
            from: waiting.length ? new Date(Math.max(...waiting.map(r => Date.parse(r.at))) + LINE_NOTICE_MS).toISOString() : null,
        };
    };
    const pct = line('health_debt_line', debtLinePct);
    const days = line('health_quiet_days', quietDays);
    return { debtLinePct: pct.value, quietDays: days.value, debtLineFrom: pct.from, quietDaysFrom: days.from };
}

/** The rule as the panel and the exceptions state it: whether it has started, and the lines the list reads now. */
function ruleNow(now = Date.now()) {
    return { started: ruleStarted(), ...effectiveLines(now) };
}

/**
 * A known community's rule in its own numbers, for the join screen, before joining: numbers and dates only. The sentences
 * are core's, drawn in the reader's language. The lines are as the owner set them, with when each applies while it waits.
 */
export function knownRule(now = Date.now()) {
    if (!isKnownCommunity()) return { known: false as const };
    const { debtLinePct, quietDays } = healthSettings();
    const { debtLineFrom, quietDaysFrom } = ruleNow(now);
    return { known: true as const, knownFloor: knownFloor(db), debtLinePct, quietDays, debtLineFrom, quietDaysFrom };
}

/**
 * A member's own standing under the rule: confirmed, in a known community, and since when (the second admin's agreement
 * where one was needed). `confirmedAt` is a new value on each new confirmation, which is how an app knows to tell them.
 */
export function confirmationOf(pubkey: string): { confirmed: boolean; confirmedAt: string | null } {
    if (!isKnownCommunity()) return { confirmed: false, confirmedAt: null };
    const row = db.prepare(`SELECT confirmed_at, seconded_at FROM confirmations
        WHERE member_pubkey = ? AND revoked_at IS NULL AND (needs_second = 0 OR seconded_at IS NOT NULL)`).get(pubkey) as { confirmed_at: string; seconded_at: string | null } | undefined;
    return { confirmed: !!row, confirmedAt: row ? row.seconded_at ?? row.confirmed_at : null };
}

/** A member's step-back, reading their balance against the line they hold once the known grant has gone. */
export function stepBackFromConfirmed(member: string) {
    return stepBack(member, () => {
        const b = getBalance(member);
        return b.balance_c < b.floor;
    });
}

function logChange(actor: string, action: string, oldValue: number, newValue: number): void {
    db.prepare('INSERT INTO known_floor_log (id, actor_pubkey, action, member_pubkey, old_value, new_value) VALUES (?, ?, ?, NULL, ?, ?)')
        .run(crypto.randomBytes(16).toString('hex'), actor, action, String(oldValue), String(newValue));
}

// Each write names its key (test-replication-manifest reads every node_config write); the default removes the row.
function setDebtLine(pct: number): void {
    if (pct === DEBT_LINE_PCT_DEFAULT) db.prepare("DELETE FROM node_config WHERE key = 'health_debt_line_pct'").run();
    else db.prepare("INSERT INTO node_config (key, value) VALUES ('health_debt_line_pct', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(String(pct));
}
function setQuietDays(days: number): void {
    if (days === QUIET_DAYS_DEFAULT) db.prepare("DELETE FROM node_config WHERE key = 'health_quiet_days'").run();
    else db.prepare("INSERT INTO node_config (key, value) VALUES ('health_quiet_days', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(String(days));
}

/** The owner's change to the debt line or the quiet days; checked whole first; each change a line in the known floor's log. */
export function setHealthSettings(actor: string, body: { debtLinePct?: unknown; quietDays?: unknown }) {
    const before = healthSettings();
    const whole = (v: unknown) => Number.isInteger(v) ? v as number : NaN;
    const pct = body.debtLinePct === undefined ? before.debtLinePct : whole(body.debtLinePct);
    if (!(pct >= 1 && pct <= 100)) throw new HealthError(400, 'bad_debt_line', 'The debt line is a whole percentage of the credit line, from 1 to 100.');
    const days = body.quietDays === undefined ? before.quietDays : whole(body.quietDays);
    if (!(days >= 7 && days <= 3650)) throw new HealthError(400, 'bad_quiet_days', 'The days without a sale are a whole number from 7 to 3,650.');
    db.transaction(() => {
        if (pct !== before.debtLinePct) { setDebtLine(pct); logChange(actor, 'health_debt_line', before.debtLinePct, pct); }
        if (days !== before.quietDays) { setQuietDays(days); logChange(actor, 'health_quiet_days', before.quietDays, days); }
    })();
    return healthSettings();
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/**
 * The community's totals: public by rule. Members and enterprises; the Commons pot on its own line. `newMembers` and `needs`
 * are not public, and go only where this does, to owners and admins: how far new members get (engine/time-to-first-trade.ts)
 * and how many Needs were asked this month and answered within a week (engine/needs-this-month.ts).
 */
export function communityTotals(now = new Date()) {
    const t = db.prepare(`SELECT
            COALESCE(SUM(CASE WHEN a.balance_c > 0 THEN a.balance_c ELSE 0 END), 0) AS credit,
            COALESCE(SUM(CASE WHEN a.balance_c < 0 THEN -a.balance_c ELSE 0 END), 0) AS debt,
            COALESCE(SUM(CASE WHEN a.balance_c < 0 THEN 1 ELSE 0 END), 0) AS in_debit,
            COUNT(*) AS accounts
        FROM accounts a JOIN members m ON m.public_key = a.public_key WHERE m.status = 'active'`).get() as
        { credit: number; debt: number; in_debit: number; accounts: number };
    const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
    const trades = db.prepare("SELECT COUNT(*) AS n FROM marketplace_transactions WHERE status = 'completed' AND completed_at >= ?")
        .get(monthStart) as { n: number };
    const commons = getCommonsBalance();
    return {
        beansInCirculation: round2(t.credit + Math.max(0, commons)),
        sumOfCredit: round2(t.credit),
        sumOfDebt: round2(t.debt),
        membersInDebit: t.in_debit,
        accounts: t.accounts,
        commonsPot: commons,
        tradesThisMonth: trades.n,
        monthStart,
        newMembers: firstTradeFunnel(now),
        needs: needsThisMonth(now),
    };
}

/** What the panel opens with: the totals, the settings, whether this community has exceptions at all, and the rule's dates. */
export function healthSummary() {
    return { totals: communityTotals(), settings: healthSettings(), known: isKnownCommunity(), rule: ruleNow() };
}

export interface HealthException {
    memberPubkey: string; entryId: string; balance_c: number; floor: number; reasons: Array<'past_debt_line' | 'quiet_in_debit' | 'stepped_back_owing'>;
}

/**
 * The exceptions: only in a known community, and only members the rule reaches. Keys and entry ids, never a name. Each
 * call is an opening, and writes its line first: the read is not answered unless the line is written.
 */
export function openExceptions(actor: string, now = Date.now()) {
    if (!isKnownCommunity()) throw new HealthError(409, 'not_known', 'Only a community that confirms its members (a known community) has exceptions.');
    assertPlainTablesWritable();
    db.prepare("INSERT INTO health_access_log (id, actor_pubkey, action) VALUES (?, ?, 'exceptions_opened')").run(crypto.randomBytes(16).toString('hex'), actor);
    const rule = ruleNow(now);
    const { debtLinePct, quietDays } = rule;
    // Told: the rule sentence on the join screen and the rules page, once the rule has started. No readable stamp, nobody: a
    // member is never listed on a basis they weren't told about.
    const told = rule.started;
    const rows = db.prepare(`SELECT c.member_pubkey, c.entry_id, c.confirmed_at FROM confirmations c
        JOIN members m ON m.public_key = c.member_pubkey AND m.status = 'active'
        WHERE c.revoked_at IS NULL AND (c.needs_second = 0 OR c.seconded_at IS NOT NULL)`).all() as
        Array<{ member_pubkey: string; entry_id: string; confirmed_at: string }>;
    const lastSale = db.prepare("SELECT MAX(completed_at) AS at FROM marketplace_transactions WHERE seller_pubkey = ? AND status = 'completed'");
    const quietSince = new Date(now - quietDays * 86_400_000).toISOString();
    const exceptions: HealthException[] = [];
    for (const r of rows) {
        if (!told || !isConfirmed(db, r.member_pubkey) || isVisitorKey(r.member_pubkey)) continue;
        const b = getBalance(r.member_pubkey);
        if (!(b.balance_c < 0)) continue;
        const floor = Math.abs(b.floor);
        const reasons: HealthException['reasons'] = [];
        if (-b.balance_c > (floor * debtLinePct) / 100) reasons.push('past_debt_line');
        const saleAt = (lastSale.get(r.member_pubkey) as { at: string | null }).at;
        // Quiet: no sale since the window opened, and confirmed before it opened (a new member has had no chance yet).
        if ((!saleAt || saleAt < quietSince) && r.confirmed_at < quietSince) reasons.push('quiet_in_debit');
        // Only which line was crossed: never a trade fact (when the last sale was), which the rule doesn't show.
        if (reasons.length) exceptions.push({ memberPubkey: r.member_pubkey, entryId: r.entry_id, balance: b.balance_c, floor, reasons });
    }
    // Who stepped back owing past their ordinary line, until they are back within it. Their step-back, not a later
    // confirmation that never went live: one an admin got seconded takes them back into the list above.
    const steppedBack = db.prepare(`SELECT c.id, c.member_pubkey, c.entry_id, c.confirmed_at FROM confirmations c
        JOIN members m ON m.public_key = c.member_pubkey AND m.status = 'active'
        WHERE c.stepped_back_owing = 1 AND NOT EXISTS (SELECT 1 FROM confirmations later
            WHERE later.member_pubkey = c.member_pubkey AND later.confirmed_at > c.confirmed_at AND (later.needs_second = 0 OR later.seconded_at IS NOT NULL))`).all() as
        Array<{ id: string; member_pubkey: string; entry_id: string; confirmed_at: string }>;
    for (const r of steppedBack) {
        if (isVisitorKey(r.member_pubkey)) continue;
        const b = getBalance(r.member_pubkey);
        // Back within it, they are off the list for good: a line that falls later is no reason to see them again.
        if (b.balance_c >= b.floor) { db.prepare('UPDATE confirmations SET stepped_back_owing = 0 WHERE id = ?').run(r.id); continue; }
        if (told) exceptions.push({ memberPubkey: r.member_pubkey, entryId: r.entry_id, balance: b.balance_c, floor: Math.abs(b.floor), reasons: ['stepped_back_owing'] });
    }
    const departed = listDebts().filter(d => d.status === 'open')
        .map(d => ({ id: d.id, entryId: d.entry_id, amount: d.amount, reason: d.reason, removedAt: d.removed_at, repaid: d.repaid, repaying: !!d.repaying_pubkey }));
    return { settings: { debtLinePct, quietDays }, rule, exceptions, departed };
}

/**
 * An admin's look at one member's balance outside the rule's lines: while removing them (the offboarding preview, and
 * the balance the removal settled). Written before the answer: a look that can't be logged isn't answered.
 */
export function logBalanceLook(actor: string, subject: string, action: 'offboard_preview' | 'offboard_settled', token: LookToken | null = null): void {
    assertPlainTablesWritable();
    db.prepare('INSERT INTO health_access_log (id, actor_pubkey, action, subject_pubkey, token_id, token_name) VALUES (?, ?, ?, ?, ?, ?)')
        .run(crypto.randomBytes(16).toString('hex'), actor, action, subject, token?.id ?? null, token ? token.name : null);
}

/** The automation token behind a look (admin-auth lookTokenOf): its id and name, never its secret. */
export type LookToken = { id: string; name: string };

/**
 * An admin's look at trades in the disputes view (queue item 29, Marty 4 Oct: "Keep disputes, log every look"): the
 * list, or one dispute; or at the escrows a member's removal left stuck on an older node (a line of its own). One line
 * naming the trade ids shown. Written before the answer: a look that can't be logged isn't answered.
 */
export function logDisputesLook(actor: string, action: TradeLookAction, tradeIds: string[], token: LookToken | null = null): void {
    assertPlainTablesWritable();
    db.prepare('INSERT INTO health_access_log (id, actor_pubkey, action, detail, token_id, token_name) VALUES (?, ?, ?, ?, ?, ?)')
        .run(crypto.randomBytes(16).toString('hex'), actor, action, JSON.stringify(tradeIds), token?.id ?? null, token ? token.name : null);
}

/**
 * An admin's look at the fraud alerts that name members: one line per member named (`subject_pubkey`, which a re-key
 * moves), at most one per admin and member in 24 hours, so reading the alerts again doesn't flood the log; a read that
 * names someone new logs that one (review r4177560410). A token's looks count apart from its maker's own, so a script's
 * look still shows after its maker's. An answer that names no one writes none. Written before the answer, all lines or none.
 */
export function logAlertsLook(actor: string, flags: ReadonlyArray<{ members: string[] }>, token: LookToken | null = null): void {
    const named = [...new Set(flags.flatMap(f => Array.isArray(f.members) ? f.members : []).filter(m => typeof m === 'string' && m))];
    if (!named.length) return;
    assertPlainTablesWritable();
    const since = new Date(Date.now() - ALERTS_LOOK_WINDOW_MS).toISOString();
    const seen = db.prepare(ALERTS_SEEN_SQL);
    const insert = db.prepare("INSERT INTO health_access_log (id, actor_pubkey, action, subject_pubkey, token_id, token_name) VALUES (?, ?, 'alerts_read', ?, ?, ?)");
    const tokenId = token?.id ?? null;
    db.transaction(() => {
        for (const m of named) if (!seen.get(actor, tokenId, m, since)) insert.run(crypto.randomBytes(16).toString('hex'), actor, m, tokenId, token ? token.name : null);
    })();
}

/**
 * The question logAlertsLook asks once per named member: has this admin (or this token) looked at them in the window?
 * Exported so a test can ask the database how it answers it: idx_health_access_log_look (schema.sql) serves it.
 */
export const ALERTS_SEEN_SQL = "SELECT 1 FROM health_access_log WHERE actor_pubkey = ? AND token_id IS ? AND action = 'alerts_read' AND subject_pubkey = ? AND at > ? LIMIT 1";

export type TradeLookAction = 'disputes_listed' | 'dispute_opened' | 'stranded_escrows_read';

const ALERTS_LOOK_WINDOW_MS = 24 * 60 * 60 * 1000;

/** The looks at a member's balance (#1599) and the looks at trades and alerts: two lists, so one can't bury the other. */
const BALANCE_LOOKS = "('exceptions_opened', 'offboard_preview', 'offboard_settled')";

function tradeIdsOf(detail: string | null): string[] | null {
    if (!detail) return null;
    try { const v = JSON.parse(detail); return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : null; } catch { return null; }
}

/**
 * Who opened the exceptions, looked at a member's balance, at the disputes or at the alerts; whose, which trades, and
 * when, and the automation token when a script looked (`token`, its id and name): every owner and admin reads it. `kind` picks the list: the balance looks, or the looks at trades and alerts,
 * each its own newest `limit`.
 */
export function readHealthAccessLog(limit = 100, kind: 'balance' | 'trades' = 'balance') {
    const where = kind === 'balance' ? `action IN ${BALANCE_LOOKS}` : `action NOT IN ${BALANCE_LOOKS}`;
    return (db.prepare(`SELECT id, actor_pubkey, action, subject_pubkey, detail, token_id, token_name, at FROM health_access_log WHERE ${where} ORDER BY at DESC, rowid DESC LIMIT ?`).all(Math.max(1, Math.min(500, limit))) as any[])
        .map(r => ({
            id: r.id, actor: r.actor_pubkey, actorCallsign: getMember(r.actor_pubkey)?.callsign ?? null, action: r.action,
            subject: r.subject_pubkey ?? null, subjectCallsign: r.subject_pubkey ? getMember(r.subject_pubkey)?.callsign ?? null : null,
            tradeIds: tradeIdsOf(r.detail), token: r.token_id ? { id: r.token_id, name: r.token_name ?? '' } : null, at: r.at,
        }));
}
