// Stateful server-side wrappers for audit, conservation guard, and persistence.
//
// These wrap the pure-read queries from @beanpool/engine and connect them to
// node singletons (db, ledger, and in-memory globals like COMMONS_BALANCE).
//
// Stated in apps/server/src/engine/audit.ts to decouple routes and state-engine.ts.

import { db } from '../db/db.js';
import { COMMONS_BALANCE, LedgerManager } from '@beanpool/core';
import {
    runConservationCheck,
    computeWashSybilMetrics,
    getReplicaConsistency as engineGetReplicaConsistency,
    type ReplicaConsistency,
    type AuditSyncPayload
} from '@beanpool/engine';

export type { ReplicaConsistency, AuditSyncPayload };


/**
 * Persist the in-memory COMMONS_BALANCE to SQLite so it survives restarts.
 */
export function persistCommonsBalance(): void {
    const rounded = Math.round(COMMONS_BALANCE * 100) / 100;
    db.prepare("INSERT OR REPLACE INTO accounts (public_key, balance, last_demurrage_epoch) VALUES ('COMMONS_POOL', ?, 0)").run(rounded);
}

/**
 * Persist demurrage decay events as ledger transaction rows.
 */
export function persistDecayEvents(ledger: LedgerManager): void {
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
 * Server wrapper for the ledger conservation audit.
 * Persists decay events and commons balance first, then executes the conservation check.
 */
export function runLedgerAudit(ledger: LedgerManager): { sumBalances: number; baseline: number; drift: number; strandedEscrows: number; ok: boolean } {
    persistDecayEvents(ledger);
    persistCommonsBalance();
    return runConservationCheck(db);
}

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
 * Compare local replica state against the primary's sync payload.
 */
export function getReplicaConsistency(payload: AuditSyncPayload): ReplicaConsistency {
    return engineGetReplicaConsistency(db, payload, COMMONS_BALANCE);
}

/**
 * Failover promotion sanity check run before taking live writes.
 */
export function promotionSanityCheck(ledger: LedgerManager): { sumBalances: number; baseline: number; drift: number; strandedEscrows: number; ok: boolean } {
    console.log('\n════════════════════════════════════════════════════════');
    console.log('🔁 FAILOVER PROMOTION — running ledger conservation sanity check');
    console.log('════════════════════════════════════════════════════════');
    const result = runLedgerAudit(ledger);
    if (result.ok) {
        console.log('✅ PROMOTION OK — replicated ledger is conservation-consistent. Safe to take live writes.');
    } else {
        console.error('🛑 PROMOTION WARNING — ledger conservation check FAILED on the replica:');
        console.error(`   sum(balances)=${result.sumBalances.toFixed(4)} drift=${result.drift.toFixed(4)} stranded escrows=${result.strandedEscrows}`);
        console.error('   Investigate before this node accepts transactions — the last snapshot may be incomplete/corrupt.');
    }
    return result;
}

/**
 * Generates CSV exports of the ledger balances and transaction history for auditing.
 */
export function exportLedgerAudit(): { balancesCsv: string; transactionsCsv: string } {
    const members = db.prepare("SELECT public_key as publicKey, callsign FROM members").all() as { publicKey: string; callsign: string }[];
    
    const projectsRow = db.prepare("SELECT value FROM node_config WHERE key='commons_projects'").get() as any;
    const allProjects = projectsRow ? JSON.parse(projectsRow.value) : [];
    const projects = allProjects.filter((p: any) => p.status !== 'rejected');

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
