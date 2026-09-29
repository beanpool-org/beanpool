/**
 * The money limits (W-money, design scratch/global-node/DESIGN-replica-flood-bounds-opus.md §7 row 5): how many payments,
 * new people paid, marketplace requests and pledge changes one account makes in any 24 hours. The numbers are in
 * config/writer-limits.ts (MONEY_LIMITS): a member's own, and ten times those for an enterprise or project.
 *
 * Why: until these, the gateway's day budget (5,000 signed writes a key) was the only bound on money, so one account, or a
 * stolen phone, could spray Beans across hundreds of people or add thousands of ledger rows in a day.
 *
 * WHOSE COUNT. The account whose Beans or deal it is: a member's own key, or the enterprise (its treasury) a keeper acts
 * for, which the route names in its path and which is counted only once the signer is known to keep it
 * (routes/money-limits-gate.ts). Never the keeper who signs for an enterprise, and never a key the body names. An
 * enterprise or project is a treasury (members.is_treasury = 1): a crowdfund project a member starts is an enterprise with
 * a bounded life (state-engine createProject), and an older `projects` row that is not one acts through no route of its
 * own (its creator acts, as themselves), so there is no third kind of account to count.
 *
 * WHERE THE COUNT LIVES: money_acts (schema.sql 11d), this server's own table, one row per act, deleted once a day old.
 *   - Not the ledger's rows: they say where Beans went, not whose act moved them. A ceiling sweep, a keeper's deferred wage,
 *     a Decision's grant and an escrow funded when a seller approves a request all write rows from an account its holder
 *     did not act on, so counting them would spend an account's day on moves it never made.
 *   - Not memory: a restart would forgive the day.
 *   So a row is written in the same synchronous step as the check (admitMoneyActs: no await between them, so two requests
 *   can't both take the last one), and taken back when the act didn't happen. A purchase from another community is counted
 *   from its own settlements row instead, written by the settlement engine as it escrows the buyer's Beans: that row is the
 *   payment, whatever the other community answers (engine: federation-settlement-exchange.ts beginOutboundSettlement).
 *
 * NEW PEOPLE. A payment to someone this account has never completed a payment to before: no ledger row from it to them (a
 * send, a wage, a gift), no completed trade it bought from them, no settled purchase from them. Each such person counts
 * once in the day however often they are paid. The Commons and an escrow are nobody.
 *
 * Over a limit: MoneyLimitError, answered 429 with a stable code, plain words, and `resetsAt` (with Retry-After) for when
 * the day's oldest act that counts leaves it. Receiving is never limited. On a main server only: a standby refuses members'
 * money writes before any of this (routes/standby-ledger-gate.ts), and nothing here is copied to one.
 */
import { isSyntheticAccount } from '@beanpool/core';
import { db } from '../db/db.js';
import { MONEY_LIMITS } from '../config/writer-limits.js';

const DAY_MS = 24 * 60 * 60 * 1000;

export type MoneyLimitCode = 'money_payments_day' | 'money_new_recipients_day' | 'money_requests_day' | 'money_pledges_day';
export type MoneyActKind = 'payment' | 'request' | 'pledge';

export interface MoneyAct {
    kind: MoneyActKind;
    /** A payment's recipient when it goes to someone (a member, a visitor or an enterprise). Not the Commons or an escrow. */
    recipient?: string | null;
}

export class MoneyLimitError extends Error {
    readonly status = 429;
    constructor(readonly code: MoneyLimitCode, message: string, readonly resetsAt: string) {
        super(message);
        this.name = 'MoneyLimitError';
    }
}

const iso = (ms: number) => new Date(ms).toISOString();
const fmt = (n: number) => n.toLocaleString('en');

/** "in about 5 hours", from now to the moment a limit lets up. */
function inAbout(atMs: number, now: number): string {
    const mins = Math.max(1, Math.ceil((atMs - now) / 60_000));
    if (mins < 60) return mins === 1 ? 'in about a minute' : `in about ${mins} minutes`;
    const hours = Math.round(mins / 60);
    return hours === 1 ? 'in about an hour' : `in about ${hours} hours`;
}

interface Account { enterprise: boolean; name: string }
function accountOf(account: string): Account {
    const row = db.prepare('SELECT is_treasury, callsign FROM members WHERE public_key = ?').get(account) as { is_treasury: number | null; callsign: string | null } | undefined;
    return { enterprise: row?.is_treasury === 1, name: row?.callsign?.trim() || 'This enterprise' };
}

interface Limits { payments: number; newRecipients: number; requests: number; pledges: number | null }
function limitsFor(a: Account): Limits {
    const m = MONEY_LIMITS;
    return a.enterprise
        // Pledges are a member's act (a keeper's backing, a member's crowdfund pledge): an enterprise makes none.
        ? { payments: m.enterprisePaymentsPerDay, newRecipients: m.enterpriseNewRecipientsPerDay, requests: m.enterpriseMarketRequestsPerDay, pledges: null }
        : { payments: m.paymentsPerDay, newRecipients: m.newRecipientsPerDay, requests: m.marketRequestsPerDay, pledges: m.pledgesPerDay };
}

const WORDS: Record<MoneyLimitCode, (a: Account, limit: number, when: string) => string> = {
    money_payments_day: (a, n, when) => a.enterprise
        ? `${a.name} can make ${fmt(n)} payments in any 24 hours. It can pay again ${when}. Receiving Beans is never limited.`
        : `You can make ${fmt(n)} payments in any 24 hours. You can pay again ${when}. Receiving Beans is never limited.`,
    money_new_recipients_day: (a, n, when) => a.enterprise
        ? `${a.name} can pay ${fmt(n)} people it has never paid before in any 24 hours. It can pay someone new again ${when}. Paying people it has paid before still works.`
        : `You can pay ${fmt(n)} people you have never paid before in any 24 hours. You can pay someone new again ${when}. Paying people you have paid before still works.`,
    money_requests_day: (a, n, when) => a.enterprise
        ? `${a.name} can approve ${fmt(n)} deals in any 24 hours. It can again ${when}.`
        : `You can ask for, accept or approve ${fmt(n)} deals in any 24 hours. You can again ${when}.`,
    money_pledges_day: (_a, n, when) => `You can make or change ${fmt(n)} pledges in any 24 hours. You can again ${when}.`,
};

/** Is this a payment to someone (who can be new), rather than to the Commons, an escrow or oneself? */
const isSomeone = (recipient: string | null | undefined, account: string): recipient is string =>
    typeof recipient === 'string' && recipient.length > 0 && recipient !== account && !isSyntheticAccount(recipient);

/** When each of `account`'s acts of `kind` in the day was made. */
function actTimes(account: string, kind: MoneyActKind, since: string): string[] {
    return (db.prepare('SELECT made_at AS t FROM money_acts WHERE account = ? AND kind = ? AND made_at > ?').all(account, kind, since) as { t: string }[])
        .map((r) => r.t);
}

/** The purchases from another community `account` started in the day: each escrowed its Beans before it asked. */
function purchasesToday(account: string, since: string): { t: string; seller: string | null }[] {
    return db.prepare(`SELECT created_at AS t, seller_pubkey AS seller FROM settlements
                        WHERE direction = 'outbound' AND buyer_pubkey = ? AND created_at > ?`).all(account, since) as { t: string; seller: string | null }[];
}

/**
 * Has `account` ever completed a payment to `recipient` (before `before`, when given): a ledger row from it to them, a
 * trade it bought from them and completed, or a settled purchase from them.
 */
export function hasPaid(account: string, recipient: string, before?: string): boolean {
    // The cut-off is a clause only when there is one: these are DATETIME columns (numeric affinity), so a stand-in bound
    // like '9999' would be compared as the number 9999, which every ISO text sorts after.
    const cut = (column: string) => (before === undefined ? '' : ` AND ${column} < ?`);
    const args = (...xs: string[]) => (before === undefined ? xs : [...xs, before]);
    return !!db.prepare(`SELECT 1 FROM transactions WHERE from_pubkey = ? AND to_pubkey = ?${cut('timestamp')} LIMIT 1`).get(...args(account, recipient))
        || !!db.prepare(`SELECT 1 FROM marketplace_transactions WHERE buyer_pubkey = ? AND seller_pubkey = ? AND status = 'completed'${cut('COALESCE(completed_at, created_at)')} LIMIT 1`)
            .get(...args(account, recipient))
        || !!db.prepare(`SELECT 1 FROM settlements WHERE direction = 'outbound' AND buyer_pubkey = ? AND seller_pubkey = ? AND state = 'settled'${cut('updated_at')} LIMIT 1`)
            .get(...args(account, recipient));
}

/**
 * The people `account` paid in the day who were new to it, each with the last time a payment to them counted: those its
 * money_acts rows marked new when they were made, and the sellers of the day's purchases it had paid nothing before the
 * day began.
 */
function newPeopleToday(account: string, since: string): Map<string, string> {
    const people = new Map<string, string>();
    const rows = db.prepare(`SELECT recipient, MAX(made_at) AS t FROM money_acts
                              WHERE account = ? AND kind = 'payment' AND new_recipient = 1 AND made_at > ? GROUP BY recipient`)
        .all(account, since) as { recipient: string; t: string }[];
    for (const r of rows) people.set(r.recipient, r.t);
    for (const p of purchasesToday(account, since)) {
        if (!isSomeone(p.seller, account)) continue;
        const seen = people.get(p.seller);
        if (seen !== undefined) { if (p.t > seen) people.set(p.seller, p.t); continue; }
        if (!hasPaid(account, p.seller, since)) people.set(p.seller, p.t);
    }
    return people;
}

/**
 * Throws `code` when `times` (the day's acts that count, ISO) leave no room for `adding` more under `limit`. It lets up
 * when enough of them leave the day: the one whose leaving makes room, 24 hours on.
 */
function assertRoom(a: Account, times: readonly string[], adding: number, limit: number, now: number, code: MoneyLimitCode): void {
    if (times.length + adding <= limit) return;
    const sorted = times.map((t) => Date.parse(t)).filter(Number.isFinite).sort((x, y) => x - y);
    const freeing = sorted[Math.min(sorted.length - 1, Math.max(0, sorted.length + adding - limit - 1))] ?? now;
    const resetsAtMs = Math.max(now + 1_000, freeing + DAY_MS);
    throw new MoneyLimitError(code, WORDS[code](a, limit, inAbout(resetsAtMs, now)), iso(resetsAtMs));
}

interface Verdict { account: string; rows: { kind: MoneyActKind; recipient: string | null; isNew: boolean }[] }

/**
 * May `account` make `acts` now? Throws MoneyLimitError when one of them is over its limit (payments first, then new
 * people, marketplace requests and pledges); otherwise returns the rows that would record them.
 */
function judge(account: string, acts: readonly MoneyAct[], now: number): Verdict {
    const a = accountOf(account);
    const limits = limitsFor(a);
    const since = iso(now - DAY_MS);
    const payments = acts.filter((x) => x.kind === 'payment');
    const rows: Verdict['rows'] = [];
    if (payments.length > 0) {
        const times = [...actTimes(account, 'payment', since), ...purchasesToday(account, since).map((p) => p.t)];
        assertRoom(a, times, payments.length, limits.payments, now, 'money_payments_day');
        const people = newPeopleToday(account, since);
        const fresh = new Set<string>();
        for (const p of payments) {
            // New to this account: it has never completed a payment to them, whether or not they were paid earlier today.
            const isNew = isSomeone(p.recipient, account) && !hasPaid(account, p.recipient);
            if (isNew && !people.has(p.recipient!)) fresh.add(p.recipient!);
            rows.push({ kind: 'payment', recipient: isSomeone(p.recipient, account) ? p.recipient : null, isNew });
        }
        if (fresh.size > 0) assertRoom(a, [...people.values()], fresh.size, limits.newRecipients, now, 'money_new_recipients_day');
    }
    const requests = acts.filter((x) => x.kind === 'request').length;
    if (requests > 0) {
        assertRoom(a, actTimes(account, 'request', since), requests, limits.requests, now, 'money_requests_day');
        for (let i = 0; i < requests; i++) rows.push({ kind: 'request', recipient: null, isNew: false });
    }
    const pledges = acts.filter((x) => x.kind === 'pledge').length;
    if (pledges > 0) {
        if (limits.pledges !== null) assertRoom(a, actTimes(account, 'pledge', since), pledges, limits.pledges, now, 'money_pledges_day');
        for (let i = 0; i < pledges; i++) rows.push({ kind: 'pledge', recipient: null, isNew: false });
    }
    return { account, rows };
}

/** Throws MoneyLimitError when `account` may not make `acts` now; records nothing (the federation routes, whose record is the settlement). */
export function assertMoneyActsAllowed(account: string, acts: readonly MoneyAct[], now = Date.now()): void {
    judge(account, acts, now);
}

export interface MoneyActHold {
    /** Take the acts back: the route refused, so nothing happened. */
    release(): void;
}

/**
 * Check `acts` for `account` and record them in the same step, before the act. Throws MoneyLimitError when one is over
 * its limit, with nothing recorded. The day-old rows go first.
 */
export function admitMoneyActs(account: string, acts: readonly MoneyAct[], now = Date.now()): MoneyActHold {
    db.prepare('DELETE FROM money_acts WHERE made_at <= ?').run(iso(now - DAY_MS));
    const verdict = judge(account, acts, now);
    const insert = db.prepare('INSERT INTO money_acts (account, kind, recipient, new_recipient, made_at) VALUES (?, ?, ?, ?, ?)');
    const at = iso(now);
    const ids = db.transaction(() => verdict.rows.map((r) => Number(insert.run(account, r.kind, r.recipient, r.isNew ? 1 : 0, at).lastInsertRowid)))();
    let released = false;
    return {
        release() {
            if (released) return;
            released = true;
            const del = db.prepare('DELETE FROM money_acts WHERE rowid = ?');
            db.transaction(() => { for (const id of ids) del.run(id); })();
        },
    };
}

/** Did `account` already start the cross-community purchase `key` (a retry: no new payment)? */
export function settlementStartedBy(key: string | null | undefined, account: string): boolean {
    if (typeof key !== 'string' || !key) return false;
    return !!db.prepare(`SELECT 1 FROM settlements WHERE key = ? AND direction = 'outbound' AND buyer_pubkey = ?`).get(key, account);
}
