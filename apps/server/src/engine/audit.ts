// Stateful server-side wrappers for audit, conservation guard, and persistence.
//
// These wrap the pure-read queries from @beanpool/engine and connect them to
// node singletons (db, ledger, and in-memory globals like COMMONS_BALANCE).
//
// Stated in apps/server/src/engine/audit.ts to decouple routes and state-engine.ts.

import { db } from '../db/db.js';
import { getNodeRole, assertLedgerWritable } from '../config/node-role.js';
import { COMMONS_BALANCE } from '@beanpool/core';
import { ledger } from './ledger.js';
import {
    runConservationCheck,
    BROKEN_BALANCE_SQL,
    computeWashSybilMetrics,
    getReplicaConsistency as engineGetReplicaConsistency,
    summariseLedger,
    type LedgerSummary,
    type ReplicaConsistency,
    type AuditSyncPayload
} from '@beanpool/engine';
import { mainLedgerAtLastCopy, type MainLedgerRecord } from './sync.js';
import { PLAIN_TABLES } from './replication-manifest.js';
import { noteAsReadBy, WITHHELD_NOTE_COLUMN, WITHHELD_NOTE_JOIN } from './withheld-notes.js';

export type { ReplicaConsistency, AuditSyncPayload };


/**
 * Persist the in-memory COMMONS_BALANCE to SQLite so it survives restarts.
 *
 * Persists the EXACT value. It used to round to 2dp, which quietly broke conservation across a restart
 * (review finding), and the failure is concrete rather than theoretical:
 *
 *   a 1.5% fee on a 5-bean cross-node trade is 0.075 → persisted as 0.08 → the node restarts and loads
 *   0.08 → boot recovery reverses that trade and refunds 0.075 → 0.005 is left minted in the Commons,
 *   from nothing.
 *
 * The 2dp figure is a PRESENTATION choice and every reader already applies it (`getCommonsBalance`,
 * `getCommunityInfo`, `getBalance().commonsBalance`, the audit export). Rounding at the storage layer as
 * well meant the stored number was lossy for no benefit — and demurrage brackets produce fractional
 * amounts constantly, so this was accumulating drift long before settlement existed.
 *
 * Wider precision here is safe for sync and backup: the column is REAL, and importers compare balances
 * rather than string forms.
 *
 * Throws on a standby (config/node-role.ts), as persistDecayEvents does: every caller is a move a standby refuses first,
 * or the flush below, which returns before it, so reaching either there is a path that missed the rule.
 *
 * Throws, too, when the pot in memory is not a finite number, and writes nothing (decide N1 on #1379, 2026-10-02). The
 * column is NOT NULL, but this write is an INSERT OR REPLACE, and SQLite's REPLACE puts the column DEFAULT (0) in place
 * of the NULL that better-sqlite3 binds for NaN: the pot would be stored as 0 with no error. Every primitive that moves
 * the pot already refuses a non-finite amount, so this is the last line, not the first. Inside a conservingTransaction
 * the throw rolls the move back; the timer and the audit log it.
 */
export function persistCommonsBalance(): void {
    assertLedgerWritable();
    assertCommonsPotFinite();
    db.prepare("INSERT OR REPLACE INTO accounts (public_key, balance, last_demurrage_epoch) VALUES ('COMMONS_POOL', ?, 0)").run(COMMONS_BALANCE);
}

/**
 * What a member, a moderator or an admin reads when a step that would move Beans meets a Commons pot that is not a finite
 * number (#1465 review, NB-2). While the pot is unknown NO Beans move at all, because every move's conservingTransaction
 * flushes the pot first and that flush refuses it: deals, refunds, removals, account deletions, sends, grants. The
 * internal words ("The Commons pot in memory is not a finite number (NaN)…") reached members as the route's error; they
 * go to the log instead, at most once a minute, for the operator.
 */
export const COMMONS_POT_PAUSED = 'Payments are paused on this community while its admins fix a problem with its accounts. Nothing has moved.';

/** Thrown with COMMONS_POT_PAUSED as its message; `code` lets a route answer 503 rather than 500. */
export class CommonsPotUnknownError extends Error {
    readonly code = 'COMMONS_POT_UNKNOWN';
    /** `detail` is appended to the pause words, to say which of a batch is held. */
    constructor(detail?: string) {
        super(detail ? `${COMMONS_POT_PAUSED} ${detail}` : COMMONS_POT_PAUSED);
        this.name = 'CommonsPotUnknownError';
    }
}

/**
 * For a route's own catch: answers a CommonsPotUnknownError with 503 in its plain words and returns true, or returns
 * false for anything else. A route that catches everything itself never reaches the server's middleware for it, and its
 * general words ("please try again") sent people into retries that can't work until the row is mended (#1465 re-review).
 */
export function answerPotPaused(ctx: { status: number; body: unknown }, e: unknown): boolean {
    if (!(e instanceof CommonsPotUnknownError)) return false;
    ctx.status = 503;
    ctx.body = { error: e.message, code: e.code };
    return true;
}

let potRefusalLoggedAt = 0;

function assertCommonsPotFinite(): void {
    if (!Number.isFinite(COMMONS_BALANCE)) {
        if (Date.now() - potRefusalLoggedAt >= 60_000) {
            potRefusalLoggedAt = Date.now();
            console.error(`🛑 [Ledger] The Commons pot in memory is not a finite number (${String(COMMONS_BALANCE)}), so it was not written, `
                + 'and no Beans move until its COMMONS_POOL row is mended (operator manual, "A balance that isn\'t a number").');
        }
        throw new CommonsPotUnknownError();
    }
}

/**
 * Persist demurrage decay events as ledger transaction rows. Throws on a standby, before the queue is drained
 * (persistCommonsBalance says why).
 */
export function persistDecayEvents(): void {
    assertLedgerWritable();
    const events = ledger.drainDecayEvents();
    if (events.length === 0) return;

    const insertTxn = db.prepare(`INSERT OR IGNORE INTO transactions (id, from_pubkey, to_pubkey, amount, tax_fee, memo, timestamp) VALUES (?, ?, 'COMMONS_POOL', ?, 0, ?, ?)`);
    const updateAcc = db.prepare(`UPDATE accounts SET balance=?, last_demurrage_epoch=?, last_updated_at=? WHERE public_key=?`);

    db.transaction(() => {
        for (const ev of events) {
            const id = `demurrage_${ev.accountId.slice(0, 16)}_${ev.toEpoch - ev.epochsPassed}_${ev.toEpoch}`;
            insertTxn.run(id, ev.accountId, Math.round(ev.amount * 10000) / 10000, `Circulation fee (demurrage, ${ev.epochsPassed}d)`, ev.timestamp);
            const acc = ledger.getAccount(ev.accountId);
            updateAcc.run(acc.balance, acc.lastDemurrageEpoch, new Date().toISOString(), ev.accountId);
        }
    })();
}

/**
 * Flush the demurrage PAIR — the account debits and the matching Commons credit — in ONE commit.
 *
 * Demurrage is a transfer, not a deduction: `applyDecay` debits the account and does
 * `COMMONS_BALANCE += decayed` together, and the two halves are persisted by different functions.
 * `persistDecayEvents()` writes the debits (its own `db.transaction`) and `persistCommonsBalance()`
 * writes the credit (a bare `INSERT OR REPLACE`, i.e. its own autocommit). Called one after the other
 * they are TWO commits, and a crash in the gap leaves the debits durable with the credit gone — boot then
 * restores the pot from the stale `COMMONS_POOL` row (`initStateEngine`) and the beans are destroyed.
 * Measured on a 5,000-bean account 60 days stale: 208.5825 Beans missing from the rows (review finding).
 *
 * So every caller that flushes the pair on its own goes through here instead. Callers that already hold a
 * `conservingTransaction` write both halves inside it and do NOT need this — there the surrounding
 * transaction is what makes them one commit, and this is a harmless savepoint if used anyway.
 *
 * A STANDBY WRITES NOTHING HERE. Its accounts and trades are its main server's rows, and its import is their only writer
 * (design §4.1). A decay it flushed was a trade the main server never made: over another window than the main server's
 * (a read here between two there), it was a second row for the same days, kept through every copy, because the import
 * never deletes a trade a copy doesn't name. The decay stays in memory, where a read here still sees it, until the next
 * copy that lands puts memory back to the rows (engine/sync.ts), and the promoted server's boot does the same. So the
 * timer and the ledger audit write nothing on a standby.
 *
 * Nothing on a standby may lean on this flush for the half of a move it didn't write: `payFromCommons` left its Commons
 * debit to it, and `conservingTransaction`'s failure path put back a pot holding decay no row had (review 4117546944).
 * So every Bean move refuses on a standby before it starts (config/node-role.ts assertLedgerWritable), and this returns
 * quietly only for the timer and the audit, which move nothing of their own.
 */
export function persistDecayAndCommons(): void {
    if (getNodeRole() === 'backup') return;
    // Before the decay queue is drained: a refusal inside the transaction would roll its rows back after they had left
    // the queue, and they would never be written.
    assertCommonsPotFinite();
    db.transaction(() => {
        persistDecayEvents();
        persistCommonsBalance();
    })();
}

/**
 * Server wrapper for the ledger conservation audit.
 * Persists decay events and commons balance first, then executes the conservation check.
 *
 * A Commons pot in memory that is not a finite number (its `COMMONS_POOL` row ±9e999, restored at boot, or NaN, the
 * unknown pot a row holding text or NULL gives at boot: state-engine.ts initStateEngine, #1445 confirmation NB-1) can't be
 * written (persistCommonsBalance refuses it), and the flush used to throw here before anything was counted: a
 * take-over's audit then never recorded and the take-over stalled at `restarting`, and the operator's audit answered
 * 500 (#1445 re-review, BLOCKING 1). Now the flush is skipped, nothing is written, and the pot is counted as a balance
 * that is not a number (its row already is, by BROKEN_BALANCE_SQL, when the row itself is broken). Never throws for it.
 */
export function runLedgerAudit(): { sumBalances: number; baseline: number; drift: number; strandedEscrows: number; badBalances: number; ok: boolean } {
    if (!Number.isFinite(COMMONS_BALANCE)) {
        console.error(`⚠️ [LedgerAudit] The Commons pot in memory is not a finite number (${String(COMMONS_BALANCE)}): nothing was written, `
            + 'and the pot is counted as a balance that is not a number.');
        const r = runConservationCheck(db);
        return { ...r, badBalances: r.badBalances + (commonsRowIsBroken() ? 0 : 1), ok: false };
    }
    // ONE commit for the pair — the audit runs at boot and on a timer, and a flush that tore here would
    // destroy exactly what the audit exists to detect.
    persistDecayAndCommons();
    return runConservationCheck(db);
}

function commonsRowIsBroken(): boolean {
    return !!db.prepare(`SELECT 1 FROM accounts WHERE public_key = 'COMMONS_POOL' AND (${BROKEN_BALANCE_SQL})`).get();
}

/** One account whose balance is not a finite number, as an operator needs it to mend the row. */
export interface BrokenBalance {
    /** The `accounts.public_key`: a member's key, an enterprise's, `COMMONS_POOL`, `escrow_<deal id>`, … */
    account: string;
    /** The member's or enterprise's name, when the account is one. */
    callsign: string | null;
    /** What it holds, in words: "Infinity", "-Infinity", "NULL", "text 'abc'", or "in memory: NaN" for the pot. */
    holds: string;
}

/**
 * The accounts whose balance is not a finite number, at most `limit` of them (#1445 re-review, NON-BLOCKING 3): the
 * conservation check gives only a count, and on a node whose `accounts.balance` is already NOT NULL nothing else names
 * them. The Commons pot is listed too when the row is fine but the pot in memory isn't.
 */
export function listBrokenBalances(limit = 50): { total: number; accounts: BrokenBalance[] } {
    const rows = db.prepare(`
        SELECT a.public_key AS account, m.callsign AS callsign, a.balance AS balance, typeof(a.balance) AS t
        FROM accounts a LEFT JOIN members m ON m.public_key = a.public_key
        WHERE ${BROKEN_BALANCE_SQL.replace(/\bbalance\b/g, 'a.balance')}
        ORDER BY a.public_key`).all() as { account: string; callsign: string | null; balance: unknown; t: string }[];
    const accounts: BrokenBalance[] = rows.map((r) => ({
        account: r.account,
        callsign: r.callsign ?? (r.account === 'COMMONS_POOL' ? 'the Commons pot' : null),
        holds: r.t === 'null' ? 'NULL' : r.t === 'text' ? `text ${JSON.stringify(String(r.balance)).replace(/^"|"$/g, "'")}` : String(r.balance),
    }));
    if (!Number.isFinite(COMMONS_BALANCE) && !rows.some((r) => r.account === 'COMMONS_POOL')) {
        accounts.unshift({ account: 'COMMONS_POOL', callsign: 'the Commons pot', holds: `in memory: ${String(COMMONS_BALANCE)}` });
    }
    return { total: accounts.length, accounts: accounts.slice(0, limit) };
}

/** What an operator does about them, in the words the audit, the rebaseline and the operator manual use. */
export const BROKEN_BALANCE_REPAIR = 'Stop the server, set each one\'s balance in state.db to what its transactions say, start it again, '
    + 'then set a new baseline for any difference left.';

/**
 * Computes and persists wash trading/Sybil metrics to the system_metrics table.
 */
export function runWashSybilMetricsAudit(): { totalNegative: number; accountsNearFloor: number; delinquentCount: number; cohortAnomalies: number } {
    console.log('📊 [MetricsAudit] Running Wash Trading & Sybil metrics audit...');
    const metrics = computeWashSybilMetrics(db);

    try {
        db.prepare("INSERT INTO system_metrics (metric_key, metric_value) VALUES (?, ?)").run('total_negative_balance', metrics.totalNegative);
        db.prepare("INSERT INTO system_metrics (metric_key, metric_value) VALUES (?, ?)").run('accounts_near_floor', metrics.accountsNearFloor);
        db.prepare("INSERT INTO system_metrics (metric_key, metric_value) VALUES (?, ?)").run('delinquent_accounts', metrics.delinquentCount);
        db.prepare("INSERT INTO system_metrics (metric_key, metric_value) VALUES (?, ?)").run('cohort_anomalies', metrics.cohortAnomalies);
        console.log(`✅ [MetricsAudit] Metrics saved: negative_bal=${metrics.totalNegative.toFixed(2)}, near_floor=${metrics.accountsNearFloor}, delinquent=${metrics.delinquentCount}, cohort_anomalies=${metrics.cohortAnomalies}`);
    } catch (e) {
        console.error('[MetricsAudit] Failed to persist system metrics:', e);
    }

    return metrics;
}

/**
 * Compare local replica state against the primary's sync payload: a plain table's rows only as far as they travel (the
 * manifest's RowRule, engine/replication-manifest.ts).
 */
export function getReplicaConsistency(payload: AuditSyncPayload): ReplicaConsistency {
    return engineGetReplicaConsistency(db, payload, COMMONS_BALANCE, PLAIN_ROWS);
}

/** Each plain table's condition on the rows that travel, by table. */
const PLAIN_ROWS: Readonly<Record<string, string>> = Object.fromEntries(
    PLAIN_TABLES.flatMap((t) => (t.where ? [[t.table, t.where] as [string, string]] : [])));

/**
 * Failover promotion sanity check run before taking live writes.
 */
export function promotionSanityCheck(): { sumBalances: number; baseline: number; drift: number; strandedEscrows: number; badBalances: number; ok: boolean } {
    console.log('\n════════════════════════════════════════════════════════');
    console.log('🔁 FAILOVER PROMOTION — running ledger conservation sanity check');
    console.log('════════════════════════════════════════════════════════');
    const result = runLedgerAudit();
    if (result.ok) {
        console.log('✅ PROMOTION OK — replicated ledger is conservation-consistent. Safe to take live writes.');
    } else {
        console.error('🛑 PROMOTION WARNING — ledger conservation check FAILED on the replica:');
        console.error(`   sum(balances)=${result.sumBalances.toFixed(4)} drift=${result.drift.toFixed(4)} stranded escrows=${result.strandedEscrows} balances that are not a finite number=${result.badBalances}`);
        console.error('   Investigate before this node accepts transactions — the last snapshot may be incomplete/corrupt.');
    }
    return result;
}

/**
 * This server's ledger against its main server's as it last copied it, while it was a standby (engine/sync.ts
 * `replica_main_ledger`): the same Beans in the same accounts, to the cent. A take-over's audit asks it as well as
 * the conservation check, which says "ok" on any ledger that sums to its baseline, one with every balance at 0 or with
 * no accounts at all among them. `lastCopy` null: this server has no record of copying one (it never copied, or not
 * since this check existed), and then it can't say the ledger is the main server's.
 */
export function ledgerAgainstLastCopy(): { match: boolean; here: LedgerSummary; lastCopy: MainLedgerRecord | null } {
    const here = summariseLedger(db.prepare('SELECT public_key AS publicKey, balance FROM accounts').all() as { publicKey: string; balance: number }[]);
    const lastCopy = mainLedgerAtLastCopy();
    return { match: !!lastCopy && lastCopy.digest === here.digest, here, lastCopy };
}

/**
 * Generates CSV exports of the ledger balances and transaction history for auditing.
 */
export function exportLedgerAudit(): { balancesCsv: string; transactionsCsv: string } {
    const members = db.prepare("SELECT public_key as publicKey, callsign FROM members").all() as { publicKey: string; callsign: string }[];
    
    const projectsRow = db.prepare("SELECT value FROM node_config WHERE key='commons_projects'").get() as any;
    let allProjects: any[] = [];
    if (projectsRow?.value) {
        try {
            allProjects = JSON.parse(projectsRow.value);
            if (!Array.isArray(allProjects)) allProjects = [];
        } catch {
            allProjects = [];
        }
    }
    const projects = allProjects.filter((p: any) => p?.status !== 'rejected');

    const commonsBalance = Math.round(COMMONS_BALANCE * 100) / 100;
    const membersByPubKey = new Map(members.map(m => [m.publicKey, m]));

    const accountRows = db.prepare("SELECT public_key, balance FROM accounts").all() as { public_key: string; balance: number }[];
    const balanceMap = new Map(accountRows.map(r => [r.public_key, r.balance]));

    let balancesCsv = 'Account,Callsign,Balance_Type,Balance\n';
    balancesCsv += `commons,Community Pool,System,${commonsBalance}\n`;
    
    for (const m of members) {
        const rawBal = balanceMap.get(m.publicKey) ?? 0;
        const bal = Math.round(rawBal * 100) / 100;
        balancesCsv += `${m.publicKey},${m.callsign},Member,${bal}\n`;
    }
    
    for (const p of projects) {
        if (p.status === 'funded') {
            balancesCsv += `project_${p.id},Project: ${p.title.replace(/,/g, '')},Project_Funded,${p.requestedAmount}\n`;
        }
    }
    
    const pendingTxs = db.prepare("SELECT * FROM marketplace_transactions WHERE status='pending'").all() as any[];
    for (const tx of pendingTxs) {
        const buyer = membersByPubKey.get(tx.buyer_pubkey);
        balancesCsv += `escrow_${tx.id},Escrow (Payer: ${buyer?.callsign || 'Unknown'}),Pending_Trade,${tx.credits}\n`;
    }
    
    let transactionsCsv = 'Timestamp,Transaction_ID,From_Account,To_Account,Amount,Memo\n';
    const txHistory = db.prepare("SELECT * FROM transactions ORDER BY timestamp ASC").all() as any[];
    for (const tx of txHistory) {
         const memoSafe = (tx.memo || '').replace(/,/g, ';').replace(/\n/g, ' ').replace(/\r/g, '');
         transactionsCsv += `${tx.timestamp},${tx.id},${tx.from_pubkey},${tx.to_pubkey},${tx.amount},${memoSafe}\n`;
    }
    
    return { balancesCsv, transactionsCsv };
}

/**
 * The ledger export a member downloads from the app (GET /api/ledger/export): the same two files as the node's audit
 * above, holding only what is theirs. Balances and trades are private (Marty, 2026-09-28): a member sees their own
 * balance and history and nobody else's, so the files carry the Community Pool (a community total, public), their own
 * balance, the Beans they hold in their own pending trades, and every transaction they are a party to. The full audit
 * above stays with the operator, who holds the database.
 */
export function exportLedgerFor(publicKey: string): { balancesCsv: string; transactionsCsv: string } {
    const member = db.prepare("SELECT callsign FROM members WHERE public_key = ?").get(publicKey) as { callsign: string } | undefined;
    const account = db.prepare("SELECT balance FROM accounts WHERE public_key = ?").get(publicKey) as { balance: number } | undefined;

    let balancesCsv = 'Account,Callsign,Balance_Type,Balance\n';
    balancesCsv += `commons,Community Pool,System,${Math.round(COMMONS_BALANCE * 100) / 100}\n`;
    balancesCsv += `${publicKey},${(member?.callsign || '').replace(/,/g, '')},Member,${Math.round((account?.balance ?? 0) * 100) / 100}\n`;
    const pendingTxs = db.prepare("SELECT id, credits FROM marketplace_transactions WHERE status='pending' AND buyer_pubkey = ?").all(publicKey) as { id: string; credits: number }[];
    for (const tx of pendingTxs) {
        balancesCsv += `escrow_${tx.id},Escrow (Payer: ${(member?.callsign || 'you').replace(/,/g, '')}),Pending_Trade,${tx.credits}\n`;
    }

    let transactionsCsv = 'Timestamp,Transaction_ID,From_Account,To_Account,Amount,Memo\n';
    // Each note as this member reads it: their own withheld note as they wrote it, BLOCKED_BEANS_NOTE in place of one kept
    // from them (engine/withheld-notes.ts).
    const txHistory = db.prepare(`SELECT t.*, ${WITHHELD_NOTE_COLUMN} FROM transactions t ${WITHHELD_NOTE_JOIN}
                                  WHERE t.from_pubkey = ? OR t.to_pubkey = ? ORDER BY t.timestamp ASC`).all(publicKey, publicKey) as any[];
    for (const tx of txHistory) {
        const memoSafe = noteAsReadBy(tx, publicKey).replace(/,/g, ';').replace(/\n/g, ' ').replace(/\r/g, '');
        transactionsCsv += `${tx.timestamp},${tx.id},${tx.from_pubkey},${tx.to_pubkey},${tx.amount},${memoSafe}\n`;
    }

    return { balancesCsv, transactionsCsv };
}
