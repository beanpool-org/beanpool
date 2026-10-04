/**
 * The Community health panel and the consent at joining (community modes slice 6; scratch/global-node/
 * DESIGN-community-modes-fable.md §4.4, §7.1, §7.5; Marty's answers 4 and 5).
 *
 * Every owner and admin reads the community's totals, which are public by rule (privacy defaults, 28 September): Beans
 * in circulation, the sum of credit, the sum of debt, how many are in debit, the Commons pot and this month's trades.
 *
 * Only in a known community (the confirmation dial on) and only for a CONFIRMED member who CONSENTED at joining: the
 * exceptions. A member past the debt line (default 50% of their floor), or in debit with no sale for N days (default 60).
 * The owner sets both; each change is a line in the known floor's log. The answer carries keys and entry ids only: the
 * names are sealed on the admins' phones, which overlay them. Every opening of the exceptions is a line in
 * health_access_log, which every owner and admin reads (the watchers are watched). No export of balances, ever.
 *
 * The consent: the join screen shows the text this file writes from the two settings, and the member's app records it
 * (when, which text). A member who joined before it existed is in no exception until they consent in their app.
 */
import crypto from 'node:crypto';
import { db, deletePlainRows } from '../db/db.js';
import { confirmationDialOn, isConfirmed } from '@beanpool/engine';
import { getBalance, getCommonsBalance, getMember, isVisitorKey } from '../state-engine.js';
import { listDebts } from './names-debts.js';
import { getNodeProfile } from '../config/node-profile.js';
import { assertPlainTablesWritable } from '../config/node-role.js';

export const DEBT_LINE_PCT_KEY = 'health_debt_line_pct';
export const QUIET_DAYS_KEY = 'health_quiet_days';
export const DEBT_LINE_PCT_DEFAULT = 50;
export const QUIET_DAYS_DEFAULT = 60;
/**
 * The consent's wording; a new wording is a new version, and the member's record says which one they saw. Wording 2
 * (review r4176931267) names what every admin sees of trades, unlogged, whatever the member agrees to: a trade not yet
 * finished or one an admin settled (/api/local/admin/disputes), each member's trade counts and total (/admin/data
 * memberStats), and the fraud alerts that name members (getCommunityHealth flags). Wording 1 said "They can't see your
 * trades", so a member who agreed to it is asked again. Wording 3 (fix round 4) names the rest of what an admin sees:
 * memberStats' posts and messages counts, the ring alert (names, no Beans), the inactivity alert, the one-to-one chat
 * only, and that whoever runs the server holds the whole database with its backups, snapshots and standby copies.
 * Wording 4 (review r4177156495) says what the two named-with-Beans alerts fire on: a pair who buy from each other back
 * and forth, about evenly, past the volume cap (wash_trading, which shows the total and how evenly it went), and members
 * who send the member who invited them Beans past a limit in a window (sybil_funnel); not "trade mostly with one member".
 * Wording 5 (queue item 29, Marty 4 Oct: "Keep disputes, log every look, totals only in member stats"): every admin
 * look at the disputes and at an alert that names a member is logged (health_access_log), the owner and the admins
 * read that log, and memberStats carries no member's trades, only the community's totals (tradeTotals). Fix round 1
 * (reviews r4177560405, r4177560417; wording 5 unreleased, so no bump): every member, admins included, sees each
 * member's trust profile (POST /api/trust/profile: finished and cancelled trades, the share finished, how many
 * different members, the trades with the viewer, Trust Points), unlogged, as Marty decided on 2026-09-29; and the
 * stranded escrows list (an escrow left stuck by a removal on an older node) is a logged look of its own
 * (stranded_escrows_read).
 */
export const CONSENT_WORDING_VERSION = 5;

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

/** The consent text, in the app's plain default, from this community's two settings. Its version: wording + settings. */
export function consentTerms() {
    const { debtLinePct, quietDays } = healthSettings();
    const text = `In this community, the admins can see your balance if it goes past ${debtLinePct}% of your credit line `
        + `or if you stay in debit for ${quietDays} days without a sale. That's how a LETS has always worked. `
        + `Every look at your balance is logged, and you can take this back at any time in Settings. `
        + `Whatever you choose, any admin can see some of your trades: a trade that isn't `
        + `finished yet or that an admin settled (who with, the listing, the price, and your one-to-one chat with them, which `
        + `they can't read if it is private), so a stuck trade can be settled; a trade whose Beans were left stuck when a member was removed on an older server (the trade's status, the listing, the price, its dates, the Beans left stuck, how many payments went through it, and the last one's amount and note); a fraud `
        + `alert that names you if you and one member buy from each other back and forth, about evenly, past a limit, with `
        + `the Beans in total and how evenly they went each way; one that names you, with the Beans in total and how many of `
        + `the members you invited have traded with no one but you, if members you invited send you Beans past a limit within `
        + `a set number of days, or if you are one of those members; one that names you, with how much of the group's trading `
        + `is with each other but no Beans, if you are in a group of members, at least half of them new, who trade mostly `
        + `with each other; and an alert that names you if no Beans have moved in or out of your account for a set number `
        + `of days. Every look at one of those trades is logged, with who looked, when, and at which trades; a look at the alerts `
        + `that name you is logged the first time each admin opens them, and again at that admin's first look after 24 hours, `
        + `and the looks in between add no line. The owner and the admins can see that log. The member stats the admins see show how many posts you have up and messages `
        + `you have sent, and of trades only the whole community's totals, not yours. Every member, admins included, sees your trust profile: how many trades you have finished and how many they cancelled, the share they finished, how many Bean payments you have sent to or received from members plus the trades you have finished, with how many different members you have paid, been paid by or traded with, how many payments and trades you have done with the member looking, and your Trust Points. That isn't logged, because every member can see it. `
        + `Nothing else of your trades. Whoever runs this community's server holds its whole database, your balance `
        + `and trades included, and its backups, snapshots and standby copies.`;
    return { known: isKnownCommunity(), debtLinePct, quietDays, version: `${CONSENT_WORDING_VERSION}:${debtLinePct}:${quietDays}`, text };
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

/** The community's totals: public by rule. Members and enterprises; the Commons pot on its own line. */
export function communityTotals(now = new Date()) {
    const t = db.prepare(`SELECT
            COALESCE(SUM(CASE WHEN a.balance > 0 THEN a.balance ELSE 0 END), 0) AS credit,
            COALESCE(SUM(CASE WHEN a.balance < 0 THEN -a.balance ELSE 0 END), 0) AS debt,
            COALESCE(SUM(CASE WHEN a.balance < 0 THEN 1 ELSE 0 END), 0) AS in_debit,
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
    };
}

/** What the panel opens with: the totals, the settings, and whether this community has exceptions at all. */
export function healthSummary() {
    return { totals: communityTotals(), settings: healthSettings(), known: isKnownCommunity(), consent: consentTerms() };
}

function consentOf(pubkey: string): { consented_at: string; version: string } | undefined {
    return db.prepare('SELECT consented_at, version FROM known_consents WHERE member_pubkey = ?').get(pubkey) as { consented_at: string; version: string } | undefined;
}

export interface HealthException {
    memberPubkey: string; entryId: string; balance: number; floor: number; reasons: Array<'past_debt_line' | 'quiet_in_debit'>;
}

/**
 * The exceptions: only in a known community, only confirmed members who consented. Keys and entry ids, never a name.
 * Each call is an opening, and writes its line first: the read is not answered unless the line is written.
 */
export function openExceptions(actor: string, now = Date.now()) {
    if (!isKnownCommunity()) throw new HealthError(409, 'not_known', 'Only a community that confirms its members (a known community) has exceptions.');
    assertPlainTablesWritable();
    db.prepare("INSERT INTO health_access_log (id, actor_pubkey, action) VALUES (?, ?, 'exceptions_opened')").run(crypto.randomBytes(16).toString('hex'), actor);
    const { debtLinePct, quietDays } = healthSettings();
    const rows = db.prepare(`SELECT c.member_pubkey, c.entry_id, c.confirmed_at, k.version FROM confirmations c
        JOIN known_consents k ON k.member_pubkey = c.member_pubkey
        JOIN members m ON m.public_key = c.member_pubkey AND m.status = 'active'
        WHERE c.revoked_at IS NULL AND (c.needs_second = 0 OR c.seconded_at IS NOT NULL)`).all() as
        Array<{ member_pubkey: string; entry_id: string; confirmed_at: string; version: string }>;
    const lastSale = db.prepare("SELECT MAX(completed_at) AS at FROM marketplace_transactions WHERE seller_pubkey = ? AND status = 'completed'");
    const exceptions: HealthException[] = [];
    for (const r of rows) {
        if (!isConfirmed(db, r.member_pubkey) || isVisitorKey(r.member_pubkey)) continue;
        const b = getBalance(r.member_pubkey);
        if (!(b.balance < 0)) continue;
        const floor = Math.abs(b.floor);
        // A member is seen only within what they agreed to AND what the community says now: the less intrusive of the
        // two lines. An owner who tightens the lines reaches a member only once they consent to the new text.
        const [agreedWording, agreedPct, agreedDays] = r.version.split(':').map(Number);
        // A consent counts only for the wording it was given to: a member who agreed to another text (say, one that let
        // the admins see less) is in no exception until they agree to today's.
        if (agreedWording !== CONSENT_WORDING_VERSION) continue;
        const pct = Math.max(debtLinePct, Number.isInteger(agreedPct) ? agreedPct : 100);
        const days = Math.max(quietDays, Number.isInteger(agreedDays) ? agreedDays : 3650);
        const quietSince = new Date(now - days * 86_400_000).toISOString();
        const reasons: HealthException['reasons'] = [];
        if (-b.balance > (floor * pct) / 100) reasons.push('past_debt_line');
        const saleAt = (lastSale.get(r.member_pubkey) as { at: string | null }).at;
        // Quiet: no sale since the window opened, and confirmed before it opened (a new member has had no chance yet).
        if ((!saleAt || saleAt < quietSince) && r.confirmed_at < quietSince) reasons.push('quiet_in_debit');
        // Only which line was crossed: never a trade fact (when the last sale was), which the member did not agree to show.
        if (reasons.length) exceptions.push({ memberPubkey: r.member_pubkey, entryId: r.entry_id, balance: b.balance, floor, reasons });
    }
    const departed = listDebts().filter(d => d.status === 'open')
        .map(d => ({ id: d.id, entryId: d.entry_id, amount: d.amount, reason: d.reason, removedAt: d.removed_at, repaid: d.repaid, repaying: !!d.repaying_pubkey }));
    return { settings: { debtLinePct, quietDays }, exceptions, departed };
}

/**
 * An admin's look at one member's balance outside that member's consent: while removing them (the offboarding preview,
 * and the balance the removal settled). Written before the answer: a look that can't be logged isn't answered.
 */
export function logBalanceLook(actor: string, subject: string, action: 'offboard_preview' | 'offboard_settled'): void {
    assertPlainTablesWritable();
    db.prepare('INSERT INTO health_access_log (id, actor_pubkey, action, subject_pubkey) VALUES (?, ?, ?, ?)')
        .run(crypto.randomBytes(16).toString('hex'), actor, action, subject);
}

/**
 * An admin's look at trades in the disputes view (queue item 29, Marty 4 Oct: "Keep disputes, log every look"): the
 * list, or one dispute; or at the escrows a member's removal left stuck on an older node (a line of its own). One line
 * naming the trade ids shown. Written before the answer: a look that can't be logged isn't answered.
 */
export function logDisputesLook(actor: string, action: TradeLookAction, tradeIds: string[]): void {
    assertPlainTablesWritable();
    db.prepare('INSERT INTO health_access_log (id, actor_pubkey, action, detail) VALUES (?, ?, ?, ?)')
        .run(crypto.randomBytes(16).toString('hex'), actor, action, JSON.stringify(tradeIds));
}

/**
 * An admin's look at the fraud alerts that name members: one line per member named (`subject_pubkey`, which a re-key
 * moves), at most one per admin and member in 24 hours, so reading the alerts again doesn't flood the log; a read that
 * names someone new logs that one (review r4177560410). An answer that names no one writes none. Written before the
 * answer, all lines or none.
 */
export function logAlertsLook(actor: string, flags: ReadonlyArray<{ members: string[] }>): void {
    const named = [...new Set(flags.flatMap(f => Array.isArray(f.members) ? f.members : []).filter(m => typeof m === 'string' && m))];
    if (!named.length) return;
    assertPlainTablesWritable();
    const since = new Date(Date.now() - ALERTS_LOOK_WINDOW_MS).toISOString();
    const seen = db.prepare("SELECT 1 FROM health_access_log WHERE actor_pubkey = ? AND action = 'alerts_read' AND subject_pubkey = ? AND at > ? LIMIT 1");
    const insert = db.prepare("INSERT INTO health_access_log (id, actor_pubkey, action, subject_pubkey) VALUES (?, ?, 'alerts_read', ?)");
    db.transaction(() => {
        for (const m of named) if (!seen.get(actor, m, since)) insert.run(crypto.randomBytes(16).toString('hex'), actor, m);
    })();
}

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
 * when: every owner and admin reads it. `kind` picks the list: the balance looks, or the looks at trades and alerts,
 * each its own newest `limit`.
 */
export function readHealthAccessLog(limit = 100, kind: 'balance' | 'trades' = 'balance') {
    const where = kind === 'balance' ? `action IN ${BALANCE_LOOKS}` : `action NOT IN ${BALANCE_LOOKS}`;
    return (db.prepare(`SELECT id, actor_pubkey, action, subject_pubkey, detail, at FROM health_access_log WHERE ${where} ORDER BY at DESC, rowid DESC LIMIT ?`).all(Math.max(1, Math.min(500, limit))) as any[])
        .map(r => ({
            id: r.id, actor: r.actor_pubkey, actorCallsign: getMember(r.actor_pubkey)?.callsign ?? null, action: r.action,
            subject: r.subject_pubkey ?? null, subjectCallsign: r.subject_pubkey ? getMember(r.subject_pubkey)?.callsign ?? null : null,
            tradeIds: tradeIdsOf(r.detail), at: r.at,
        }));
}

/** A member's own consent: what the app shows and records. `version` must be the text the app showed. */
export function recordConsent(pubkey: string, body: { version?: unknown }) {
    const m = getMember(pubkey);
    if (!m || m.status !== 'active' || m.isTreasury || isVisitorKey(pubkey)) throw new HealthError(403, 'not_member', 'Not an active member of this community.');
    const terms = consentTerms();
    if (!terms.known) throw new HealthError(409, 'not_known', 'This community does not confirm its members, so there is nothing to agree to.');
    if (body.version !== terms.version) throw new HealthError(409, 'stale_text', 'The community changed what admins can see. Read it again.');
    assertPlainTablesWritable();
    db.transaction(() => {
        db.prepare(`INSERT INTO known_consents (member_pubkey, version, consented_at) VALUES (?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
            ON CONFLICT(member_pubkey) DO UPDATE SET version = excluded.version, consented_at = excluded.consented_at`).run(pubkey, terms.version);
        logConsent(pubkey, 'agreed', terms.version);
    })();
    return myConsent(pubkey);
}

/**
 * A member withdraws their consent (GDPR Art. 7(3)): at any time, with one signed request, whatever the community's
 * settings. Their row goes, so they are in no exception from the next opening; the consent history keeps that they
 * withdrew. Withdrawing with nothing to withdraw changes nothing.
 */
export function withdrawConsent(pubkey: string) {
    assertPlainTablesWritable();
    db.transaction(() => {
        const c = consentOf(pubkey);
        if (!c) return;
        // With its tombstone: a delta carries a delete only so, and a standby that kept the row would put them back in
        // the exceptions on a take-over (review r4176631105; test-standby-known-consents).
        deletePlainRows('known_consents', 'member_pubkey = ?', pubkey);
        logConsent(pubkey, 'withdrawn', c.version);
    })();
    return myConsent(pubkey);
}

function logConsent(pubkey: string, action: 'agreed' | 'withdrawn', version: string): void {
    db.prepare('INSERT INTO known_consent_log (id, member_pubkey, action, version) VALUES (?, ?, ?, ?)')
        .run(crypto.randomBytes(16).toString('hex'), pubkey, action, version);
}

/** A member's own view: the terms, and whether (and to which version) they consented. */
export function myConsent(pubkey: string) {
    const c = consentOf(pubkey);
    const terms = consentTerms();
    // When they last withdrew, while they have no consent now: Settings says so, and offers the text again.
    const withdrawn = c ? undefined : db.prepare("SELECT at FROM known_consent_log WHERE member_pubkey = ? AND action = 'withdrawn' ORDER BY at DESC, rowid DESC LIMIT 1")
        .get(pubkey) as { at: string } | undefined;
    return { ...terms, confirmed: isConfirmed(db, pubkey), consentedAt: c?.consented_at ?? null, consentedVersion: c?.version ?? null,
        withdrawnAt: withdrawn?.at ?? null };
}
