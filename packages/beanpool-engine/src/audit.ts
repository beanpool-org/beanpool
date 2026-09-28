// Ledger conservation audit, wash/Sybil metrics, and replica consistency checks.
//
// Extracted from apps/server/src/state-engine.ts so both the node server
// and the fleet manager can run identical audits against database states.
//
// Pure reads/computations (parameterized on better-sqlite3 Database handle)
// with self-contained SQLite configuration storage.

import type Database from 'better-sqlite3';
import crypto from 'node:crypto';
import { getMemberTrustProfile } from './trust.js';

type Db = Database.Database;

export interface AuditSyncPayload {
    members?: any[];
    accounts?: { publicKey?: string; balance: number | string | null }[];
    transactions?: any[];
    posts?: any[];
    marketplaceTransactions?: any[];
    messages?: any[];
    conversationParticipants?: any[];
    creatorChannels?: any[];
    pulseItems?: any[];
    eventRsvps?: any[];
    groups?: any[];
    groupMembers?: any[];
    placeWatches?: any[];
    joinRequests?: any[];
    directoryCache?: any[];
    moderationNotices?: any[];
    memberBlocks?: any[];
    invalidatedKeys?: any[];
    treasuryOperators?: unknown[];
    enterprisePledges?: unknown[];
    plainTables?: Record<string, unknown[]>;
    commonsBalance?: number;
    generatedAt?: string;
}

export interface ReplicaConsistency {
    checkedAt: string;
    snapshotGeneratedAt: string | null;
    tables: { name: string; primary: number; backup: number; match: boolean }[];
    sumBalances: { primary: number; backup: number; match: boolean };
    commons: { primary: number; backup: number; match: boolean } | null;
    /**
     * Every account against the copy's, not only their sum: a ledger with every balance at 0, or two balances swapped,
     * sums the same. `compared` accounts in either; `differing`, those whose balance differs or that only one side holds
     * (the first few in `examples`, by key); `unreadable`, the copy's entries with no key, a key SQLite would store as
     * another string (isWellFormedKey) or no number for a balance. Null when the copy carries no account set, or names
     * no account: an empty set, or one whose every entry has no key it can store.
     */
    ledger: { compared: number; differing: number; unreadable: number; examples: string[]; match: boolean } | null;
    /**
     * Set by the standby's whole-copy check (apps/server services/backup-puller.ts checkWholeCopy), not here: the values of
     * the copy's members rows its own table's rules refuse (a goal below 0 from a main server whose column has no CHECK),
     * which its import left out (`<member key>.<column>`, the first few in `examples`). Any makes the copy not exact.
     */
    valuesLeftOut?: { count: number; examples: string[] } | null;
    /**
     * Set by the same check: the rows and values of the copy's plain tables (apps/server engine/plain-tables.ts) this
     * standby's tables refuse, which its import left out (`<table>:<key>` or `<table>:<key>.<column>`), and the tables
     * they are in. Any makes the copy not exact, and asks for no force-resync.
     */
    plainTablesLeftOut?: { count: number; tables: string[]; examples: string[] } | null;
    ok: boolean;
}

/**
 * True when SQLite gives this key back as the same string. A JS string holding half of a surrogate pair isn't
 * well-formed UTF-16, and is stored as U+FFFD in its place: a row under another key. (String.prototype.isWellFormed,
 * which this build's target predates: in a `u` pattern a pair is one code point, so only an unpaired half matches.)
 */
export function isWellFormedKey(key: string): boolean {
    return !/\p{Surrogate}/u.test(key);
}

/**
 * The sum of some balances, with each addition's rounding carried (Kahan-Babuska-Neumaier, as SQLite's SUM since 3.43). A
 * running sum of doubles loses any value smaller than half a step of the running total: +1e20, 1000, -1e20 sums to 0.
 * A sum that overflows is ±Infinity, as SQLite's is: the carried rounding is then Infinity - Infinity, NaN, and SQLite
 * leaves out a carry that isn't finite (sumFinalize).
 */
export function compensatedSum(values: Iterable<number>): number {
    let sum = 0;
    let carried = 0;
    for (const v of values) {
        const t = sum + v;
        carried += Math.abs(sum) >= Math.abs(v) ? (sum - t) + v : (v - t) + sum;
        sum = t;
    }
    return Number.isFinite(carried) ? sum + carried : sum;
}

/** A ledger as a few figures and a fingerprint, to tell whether two servers hold the same one (summariseLedger). */
export interface LedgerSummary {
    /** Accounts holding Beans, to the cent. */
    accounts: number;
    /** What they hold between them, to the cent: the size of the ledger whatever its sum. */
    holdings: number;
    /** Their sum. */
    sum: number;
    /** A hash of each of those accounts' key and balance to the cent. */
    digest: string;
}

/**
 * A ledger's figures and fingerprint. Two ledgers with the same digest hold the same Beans in the same accounts, to the
 * cent. An account holding under half a cent counts as holding none, so an empty escrow account a server deletes, or dust
 * its sweep moves to the Commons, changes nothing here. A balance that isn't a number counts as none.
 */
export function summariseLedger(rows: Iterable<{ publicKey: string; balance: unknown }>): LedgerSummary {
    const held: string[] = [];
    const balances: number[] = [];
    let holdings = 0;
    for (const r of rows) {
        const b = typeof r.balance === 'number' && Number.isFinite(r.balance) ? r.balance : 0;
        balances.push(b);
        const cents = Math.round(b * 100);
        if (cents === 0) continue;
        holdings += Math.abs(cents);
        held.push(`${r.publicKey}:${cents}`);
    }
    held.sort();
    return {
        accounts: held.length,
        holdings: holdings / 100,
        sum: Math.round(compensatedSum(balances) * 10000) / 10000,
        digest: crypto.createHash('sha256').update(held.join('\n')).digest('hex'),
    };
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

/** A member's preferences as the copy carries them (`preferences`, an object), or undefined. */
function preferencesOf(member: unknown): Record<string, unknown> | undefined {
    const prefs = (member as { preferences?: unknown } | null)?.preferences;
    return isPreferenceMap(prefs) ? prefs : undefined;
}

/** A copy whose members carry their preferences: every one does, from a main server that sends them. */
function membersCarryPreferences(members: unknown): boolean {
    return Array.isArray(members) && members.some((m) => preferencesOf(m) !== undefined);
}

function isPreferenceMap(v: unknown): v is Record<string, unknown> {
    return !!v && typeof v === 'object' && !Array.isArray(v);
}

/** The preference rows the copy's members name, one per key. */
function preferenceCount(members: readonly unknown[]): number {
    let n = 0;
    for (const m of members) n += Object.keys(preferencesOf(m) ?? {}).length;
    return n;
}

/**
 * Replica-fidelity check (backup side).
 * Compares the primary's sync payload statistics against local DB rows.
 */
export function getReplicaConsistency(db: Db, payload: AuditSyncPayload, localCommonsBalance: number): ReplicaConsistency {
    // Guarded: a replica whose schema predates a table must report a mismatch on that one row,
    // not throw and abandon the whole consistency report.
    const count = (t: string) => {
        try { return Number((db.prepare(`SELECT COUNT(*) AS c FROM ${t}`).get() as any).c) || 0; }
        catch { return 0; }
    };
    const round2 = (n: number) => Math.round(n * 100) / 100;

    const tableDefs: [string, number][] = [
        ['members', payload.members?.length ?? 0],
        ['accounts', payload.accounts?.length ?? 0],
        ['transactions', payload.transactions?.length ?? 0],
        ['posts', payload.posts?.length ?? 0],
        ['marketplace_transactions', payload.marketplaceTransactions?.length ?? 0],
        ['messages', payload.messages?.length ?? 0],
        // Chat membership. The event scrub deletes a chat's participants along with its messages
        // (docs/events-on-the-map.md §2.2), and a replica that applied one tombstone but not the other
        // would hold the guest list of a chat whose messages are gone — the audit has to be able to say so.
        ['conversation_participants', payload.conversationParticipants?.length ?? 0],
        // Replicated since the Pulse's first phase, but absent here — so a channel-replication
        // failure showed a matching hash and ok:true, and only surfaced at failover.
        ['creator_channels', payload.creatorChannels?.length ?? 0],
        ['pulse_items', payload.pulseItems?.length ?? 0],
        ['event_rsvps', payload.eventRsvps?.length ?? 0],
        // Commons groups (#823). Membership rows include removed ones — a removal the replica lost would
        // let the person back into an open group after failover.
        ['groups', payload.groups?.length ?? 0],
        ['group_members', payload.groupMembers?.length ?? 0],
        // The global node's place watches and directory mirror (G5). A watch the replica lost is a member never told
        // when a community starts near them after a take-over; a community it lost is a watcher told twice.
        ['place_watches', payload.placeWatches?.length ?? 0],
        ['directory_cache', payload.directoryCache?.length ?? 0],
        // Requests to join (G6). A knock the replica lost is a stranger nobody answers after a take-over; an answer it
        // lost is a decline forgotten, or an approved applicant told about an invite the new server doesn't have.
        ['join_requests', payload.joinRequests?.length ?? 0],
        // Moderation notices kept for their member. A notice the replica lost is a web member never told, after a
        // take-over, that their post was hidden or removed or their posting paused.
        ['moderation_notices', payload.moderationNotices?.length ?? 0],
        // Each member's block list. A block the replica lost is someone shown again, after a take-over, to the member who
        // blocked them. Only when the copy carries them: a main server that predates them sends none, and its standby
        // keeps its own.
        ...(Array.isArray(payload.memberBlocks) ? [['member_blocks', payload.memberBlocks.length] as [string, number]] : []),
        // The keys the main server replaced. A key the replica lost is a lost phone's key let back in after a take-over.
        // Only when the copy carries them: a main server that predates them sends none, and its standby keeps its own.
        ...(Array.isArray(payload.invalidatedKeys) ? [['invalidated_keys', payload.invalidatedKeys.length] as [string, number]] : []),
        // Who keeps each enterprise, and the keepers' pledges, which make its credit floor (design G2c). A pledge the replica
        // holds and the main server doesn't is an enterprise that could run deeper into debt after a take-over than its
        // keepers ever backed. Only when the copy carries them: a main server that predates them sends neither.
        ...(Array.isArray(payload.treasuryOperators) ? [['treasury_operators', payload.treasuryOperators.length] as [string, number]] : []),
        ...(Array.isArray(payload.enterprisePledges) ? [['enterprise_pledges', payload.enterprisePledges.length] as [string, number]] : []),
        // Each member's preferences, which travel with their row (design G2b): holiday, notification opt-outs. Only when the
        // copy carries them.
        ...(membersCarryPreferences(payload.members) ? [['member_preferences', preferenceCount(payload.members ?? [])] as [string, number]] : []),
        // The plain tables (in-flight money and governance, sync.ts exportPlainTables), each one the copy carries: a row
        // the import refused or couldn't write shows here, and so does one it left behind. Only by a name that is a plain
        // identifier; a table this database doesn't have counts 0.
        ...Object.entries(payload.plainTables ?? {})
            .filter(([t, rows]) => Array.isArray(rows) && /^[A-Za-z_][A-Za-z0-9_]*$/.test(t))
            .map(([t, rows]) => [t, rows.length] as [string, number]),
    ];
    const tables = tableDefs.map(([name, primary]) => {
        const backup = count(name);
        return { name, primary, backup, match: primary === backup };
    });

    const primarySum = round2(compensatedSum((payload.accounts ?? []).map((a) => (Number.isFinite(Number(a?.balance)) ? Number(a?.balance) : 0))));
    const backupSum = round2(Number((db.prepare(`SELECT COALESCE(SUM(balance), 0) AS s FROM accounts`).get() as any).s) || 0);
    const sumBalances = { primary: primarySum, backup: backupSum, match: Math.abs(primarySum - backupSum) < 0.01 };

    let commons: ReplicaConsistency['commons'] = null;
    if (typeof payload.commonsBalance === 'number') {
        const primaryC = round2(payload.commonsBalance);
        const backupC = round2(localCommonsBalance);
        commons = { primary: primaryC, backup: backupC, match: Math.abs(primaryC - backupC) < 0.01 };
    }

    // Every account (G0). The importer writes the copy's rows as they are and deletes the ones it doesn't carry, so after
    // a whole copy the two are equal, balance for balance; any difference is this standby's ledger not being its main
    // server's. Exact: both are the same doubles, the import writes the one it was sent.
    // A copy that names no account carries no ledger, as the importer reads it (apps/server engine/sync.ts): one with an
    // empty set, or with no entry whose key this server can store.
    let ledger: ReplicaConsistency['ledger'] = null;
    const theirs = new Map<string, number | null>();
    let unreadable = 0;
    for (const a of Array.isArray(payload.accounts) ? payload.accounts : []) {
        // A key SQLite would store as another string is one the importer never writes: unreadable, like an entry
        // with no key, so it asks for no force-resync (a force-resync would read it the same way).
        if (typeof a?.publicKey !== 'string' || !a.publicKey || !isWellFormedKey(a.publicKey)) { unreadable++; continue; }
        const b = typeof a.balance === 'number' && Number.isFinite(a.balance) ? a.balance : null;
        if (b === null) unreadable++;
        theirs.set(a.publicKey, b);
    }
    if (theirs.size > 0) {
        const ours = new Map((db.prepare('SELECT public_key, balance FROM accounts').all() as { public_key: string; balance: number | null }[])
            .map((r) => [r.public_key, r.balance]));
        const differ: string[] = [];
        for (const [pk, b] of theirs) {
            if (b === null) continue; // counted as unreadable: there is no balance of theirs to hold
            const mine = ours.get(pk);
            if (mine === undefined || mine === null || mine !== b) differ.push(pk);
        }
        for (const pk of ours.keys()) if (!theirs.has(pk)) differ.push(pk);
        differ.sort();
        ledger = {
            compared: new Set([...theirs.keys(), ...ours.keys()]).size,
            differing: differ.length,
            unreadable,
            examples: differ.slice(0, 5).map((pk) => pk.slice(0, 16)),
            match: differ.length === 0 && unreadable === 0,
        };
    }

    const ok = tables.every(t => t.match) && sumBalances.match && (commons ? commons.match : true) && (ledger ? ledger.match : true);
    return {
        checkedAt: new Date().toISOString(),
        snapshotGeneratedAt: payload.generatedAt ?? null,
        tables, sumBalances, commons, ledger, ok,
    };
}
