// Ledger conservation audit, wash/Sybil metrics, and replica consistency checks.
//
// Extracted from apps/server/src/state-engine.ts so both the node server
// and the fleet manager can run identical audits against database states.
//
// Pure reads/computations (parameterized on better-sqlite3 Database handle)
// with self-contained SQLite configuration storage.

import type Database from 'better-sqlite3';
import { getMemberTrustProfile } from './trust.js';

type Db = Database.Database;

export interface AuditSyncPayload {
    members?: any[];
    accounts?: { balance: number | string }[];
    transactions?: any[];
    posts?: any[];
    marketplaceTransactions?: any[];
    messages?: any[];
    commonsBalance?: number;
    generatedAt?: string;
}

export interface ReplicaConsistency {
    checkedAt: string;
    snapshotGeneratedAt: string | null;
    tables: { name: string; primary: number; backup: number; match: boolean }[];
    sumBalances: { primary: number; backup: number; match: boolean };
    commons: { primary: number; backup: number; match: boolean } | null;
    ok: boolean;
}

/**
 * Runs the database-level ledger conservation check.
 * Checks system-wide sum of balances against the established baseline, and
 * flags stranded escrows (escrow accounts with balance > 0.01 for settled transactions).
 */
export function runConservationCheck(db: Db): { sumBalances: number; baseline: number; drift: number; strandedEscrows: number; ok: boolean } {
    const sumBalances = (db.prepare(`SELECT COALESCE(SUM(balance), 0) as s FROM accounts`).get() as any).s as number;

    const baselineRow = db.prepare(`SELECT value FROM node_config WHERE key='ledger_audit_baseline'`).get() as any;
    let baseline = baselineRow ? Number(baselineRow.value) : NaN;
    if (!Number.isFinite(baseline)) {
        baseline = sumBalances;
        db.prepare(`INSERT OR REPLACE INTO node_config (key, value) VALUES ('ledger_audit_baseline', ?)`).run(String(sumBalances));
        console.log(`📐 [LedgerAudit] Baseline established: sum(balances) = ${sumBalances.toFixed(4)}`);
    }
    const drift = sumBalances - baseline;

    const strandedEscrows = (db.prepare(`
        SELECT COUNT(*) as c FROM accounts
        WHERE public_key LIKE 'escrow_%' AND ABS(balance) > 0.01
          AND SUBSTR(public_key, 8) NOT IN (SELECT id FROM marketplace_transactions WHERE status IN ('pending', 'requested'))
    `).get() as any).c as number;

    const ok = Math.abs(drift) < 0.01 && strandedEscrows === 0;
    if (!ok) {
        console.warn(`⚠️ [LedgerAudit] FAILED — sum=${sumBalances.toFixed(4)}, drift=${drift.toFixed(4)} from baseline, stranded escrows=${strandedEscrows}`);
    } else {
        console.log(`✅ [LedgerAudit] OK — sum(balances)=${sumBalances.toFixed(4)}, drift=${drift.toFixed(4)}`);
    }
    return { sumBalances, baseline, drift, strandedEscrows, ok };
}

/**
 * Computes metrics for wash trading, Sybil rings, and delinquency.
 * This is a pure computation function that returns the metrics dictionary
 * without persisting it to the DB (persistence is handled by the server runtime).
 */
export function computeWashSybilMetrics(db: Db): { totalNegative: number; accountsNearFloor: number; delinquentCount: number; cohortAnomalies: number } {
    // 1. Total negative balance
    const totalNegativeRow = db.prepare(`SELECT ABS(SUM(balance)) as s FROM accounts WHERE balance < 0`).get() as any;
    const totalNegative = totalNegativeRow ? (totalNegativeRow.s || 0) : 0;

    // 2. Count of accounts near floor & Delinquent accounts
    let accountsNearFloor = 0;
    let delinquentCount = 0;

    try {
        const activeMembers = db.prepare("SELECT public_key FROM members WHERE status = 'active'").all() as { public_key: string }[];
        for (const member of activeMembers) {
            const { floor } = getMemberTrustProfile(db, member.public_key);
            if (floor < 0) {
                const balRow = db.prepare("SELECT balance FROM accounts WHERE public_key = ?").get(member.public_key) as any;
                const bal = balRow ? balRow.balance : 0;
                if (bal < 0) {
                    // Near floor: balance within 10 beans of floor
                    if (bal - floor <= 10) {
                        accountsNearFloor++;
                    }
                    // Delinquent: balance <= floor * 0.8 AND no transaction in 7 days
                    if (bal <= floor * 0.8) {
                        const txRow = db.prepare(`
                            SELECT 1 FROM transactions 
                            WHERE (from_pubkey = ? OR to_pubkey = ?) 
                              AND timestamp > datetime('now', '-7 days')
                            LIMIT 1
                        `).get(member.public_key, member.public_key);
                        if (!txRow) {
                            delinquentCount++;
                        }
                    }
                }
            }
        }
    } catch (e) {
        console.error('[MetricsAudit] Failed to compute near-floor/delinquent stats:', e);
    }

    // 3. Cohort Velocity Report
    let cohortAnomalies = 0;
    try {
        const cohorts = db.prepare(`
            SELECT strftime('%Y-%W', joined_at) as cohort_week, GROUP_CONCAT(public_key) as keys
            FROM members
            WHERE joined_at IS NOT NULL AND status = 'active' AND invited_by IS NOT 'genesis'
            GROUP BY cohort_week
        `).all() as { cohort_week: string; keys: string }[];

        for (const c of cohorts) {
            const keys = c.keys.split(',');
            if (keys.length === 0) continue;

            let fastGrowingCount = 0;
            for (const key of keys) {
                const { floor } = getMemberTrustProfile(db, key);
                if (floor <= -600) {
                    const memberRow = db.prepare("SELECT joined_at FROM members WHERE public_key = ?").get(key) as any;
                    if (memberRow?.joined_at) {
                        const joined = new Date(memberRow.joined_at);
                        const ageDays = (Date.now() - joined.getTime()) / (1000 * 60 * 60 * 24);
                        if (ageDays < 14) {
                            fastGrowingCount++;
                        }
                    }
                }
            }

            const ratio = fastGrowingCount / keys.length;
            if (keys.length >= 2 && ratio >= 0.5) {
                cohortAnomalies++;
            }
        }
    } catch (e) {
        console.error('[MetricsAudit] Failed to compute cohort velocity anomalies:', e);
    }

    return { totalNegative, accountsNearFloor, delinquentCount, cohortAnomalies };
}

/**
 * Replica-fidelity check (backup side).
 * Compares the primary's sync payload statistics against local DB rows.
 */
export function getReplicaConsistency(db: Db, payload: AuditSyncPayload, localCommonsBalance: number): ReplicaConsistency {
    const count = (t: string) => Number((db.prepare(`SELECT COUNT(*) AS c FROM ${t}`).get() as any).c) || 0;
    const round2 = (n: number) => Math.round(n * 100) / 100;

    const tableDefs: [string, number][] = [
        ['members', payload.members?.length ?? 0],
        ['accounts', payload.accounts?.length ?? 0],
        ['transactions', payload.transactions?.length ?? 0],
        ['posts', payload.posts?.length ?? 0],
        ['marketplace_transactions', payload.marketplaceTransactions?.length ?? 0],
        ['messages', payload.messages?.length ?? 0],
    ];
    const tables = tableDefs.map(([name, primary]) => {
        const backup = count(name);
        return { name, primary, backup, match: primary === backup };
    });

    const primarySum = round2((payload.accounts ?? []).reduce((s: number, a: any) => s + (Number(a.balance) || 0), 0));
    const backupSum = round2(Number((db.prepare(`SELECT COALESCE(SUM(balance), 0) AS s FROM accounts`).get() as any).s) || 0);
    const sumBalances = { primary: primarySum, backup: backupSum, match: Math.abs(primarySum - backupSum) < 0.01 };

    let commons: ReplicaConsistency['commons'] = null;
    if (typeof payload.commonsBalance === 'number') {
        const primaryC = round2(payload.commonsBalance);
        const backupC = round2(localCommonsBalance);
        commons = { primary: primaryC, backup: backupC, match: Math.abs(primaryC - backupC) < 0.01 };
    }

    const ok = tables.every(t => t.match) && sumBalances.match && (commons ? commons.match : true);
    return {
        checkedAt: new Date().toISOString(),
        snapshotGeneratedAt: payload.generatedAt ?? null,
        tables, sumBalances, commons, ok,
    };
}
