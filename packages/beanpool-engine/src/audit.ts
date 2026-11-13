// Ledger conservation audit, wash/Sybil metrics, and replica consistency checks.
//
// Extracted from apps/server/src/state-engine.ts so both the node server
// and the fleet manager can run identical audits against database states.
//
// Pure reads/computations (parameterized on better-sqlite3 Database handle)
// with self-contained SQLite configuration storage.

import type Database from 'better-sqlite3';
import crypto from 'node:crypto';
import { beans, isHundredths, PROTOCOL_CONSTANTS } from '@beanpool/core';
import { getMemberTrustProfile, washTradingAnalysisStepsOnSnapshot, drainSteps, runStepsInSlices } from './trust.js';

type Db = Database.Database;

export interface AuditSyncPayload {
    members?: any[];
    accounts?: { publicKey?: string; balance_c: unknown }[];
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
    /** The Commons pot, whole hundredths. */
    commonsBalance_c?: number;
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

/** A ledger as a few figures and a fingerprint, to tell whether two servers hold the same one (summariseLedger). */
export interface LedgerSummary {
    /** Accounts holding any hundredths. */
    accounts: number;
    /** What they hold between them, whole hundredths: the size of the ledger whatever its sum. */
    holdings: number;
    /** Their sum, whole hundredths, exact. */
    sum: number;
    /** A hash of each of those accounts' key and balance (`key:hundredths`). */
    digest: string;
}

/**
 * A ledger's figures and fingerprint. Two ledgers with the same digest hold the same hundredths in the same accounts,
 * exactly (`${key}:${balance_c}`): an empty escrow account a server deletes changes nothing here. A balance that is not
 * whole hundredths counts as none.
 */
export function summariseLedger(rows: Iterable<{ publicKey: string; balance_c: unknown }>): LedgerSummary {
    const held: string[] = [];
    let holdings = 0;
    let sum = 0;
    for (const r of rows) {
        const c = isHundredths(r.balance_c) ? r.balance_c : 0;
        if (c === 0) continue;
        sum += c;
        holdings += Math.abs(c);
        held.push(`${r.publicKey}:${c}`);
    }
    held.sort();
    return {
        accounts: held.length,
        holdings,
        sum,
        digest: crypto.createHash('sha256').update(held.join('\n')).digest('hex'),
    };
}

/**
 * The escrows an open deal or an open project still holds, as a WHERE clause on the escrow's account key (`keyColumn`):
 * a pending or requested marketplace deal's (escrow_<deal id>), and an open crowdfund's or open bounded enterprise's
 * (escrow_<project id>, holding its pledges until the goal is met: the server's pledgeToProject). None of them is
 * stranded. One clause for the ledger audit and the admin's stranded-escrow list (the server's
 * engine/escrow-write-off.ts), so the count the audit gives is the list the admin sees. `id IS NOT NULL`: one row with a
 * NULL id (SQLite lets a TEXT PRIMARY KEY hold it) would make `NOT IN` NULL for every escrow and hide them all. A bare
 * ledger database (a test's, a copy being checked) may have no projects table.
 */
export function escrowNotHeldOpenSql(db: Db, keyColumn = 'public_key'): string {
    const hasProjects = !!db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'projects'`).get();
    return `SUBSTR(${keyColumn}, 8) NOT IN (SELECT id FROM marketplace_transactions WHERE id IS NOT NULL AND status IN ('pending', 'requested'))`
        + (hasProjects ? ` AND SUBSTR(${keyColumn}, 8) NOT IN (SELECT id FROM projects WHERE id IS NOT NULL AND status = 'ACTIVE')` : '');
}

/**
 * The accounts rows whose balance is not whole hundredths: NULL (better-sqlite3 binds NaN as NULL), text, or a REAL (an
 * INTEGER column keeps a fraction, or ±Infinity, as REAL). SUM skips NULLs and a text row, so none of them moves the total
 * the check below compares: a balance of 0 wiped to NULL reads as no drift at all, which is why each is a failure alone.
 */
export const BROKEN_BALANCE_SQL = `balance_c IS NULL OR typeof(balance_c) != 'integer'`;

/**
 * Runs the database-level ledger conservation check.
 * Checks the system-wide sum of balances against the established baseline, EXACTLY (whole hundredths: drift === 0), and
 * flags stranded escrows (an escrow holding anything, for a settled deal). The baseline is integer text in node_config; a
 * baseline written as anything else (a float from before whole hundredths) is refused, never read: the check fails until
 * an owner sets a new one (routes/admin.ts rebaseline).
 *
 * A balance that is not a finite number (BROKEN_BALANCE_SQL) is a failure on its own (review F1, 2026-10-01): a NaN
 * written as NULL was invisible here, because SUM skips it and NaN compares false against any tolerance. `badBalances`
 * counts them; the baseline is never established from a ledger holding one.
 */
export function runConservationCheck(db: Db): { sumBalances: number; baseline: number; drift: number; strandedEscrows: number; badBalances: number; ok: boolean } {
    const sumBalances = (db.prepare(`SELECT COALESCE(SUM(balance_c), 0) as s FROM accounts`).get() as any).s as number;
    const badBalances = (db.prepare(`SELECT COUNT(*) AS c FROM accounts WHERE ${BROKEN_BALANCE_SQL}`).get() as any).c as number;

    const baselineRow = db.prepare(`SELECT value FROM node_config WHERE key='ledger_audit_baseline'`).get() as { value: unknown } | undefined;
    let baseline: number;
    if (!baselineRow) {
        baseline = sumBalances;
        if (badBalances === 0 && isHundredths(sumBalances)) {
            db.prepare(`INSERT OR REPLACE INTO node_config (key, value) VALUES ('ledger_audit_baseline', ?)`).run(String(sumBalances));
            console.log(`📐 [LedgerAudit] Baseline established: sum(balances) = ${String(sumBalances)} hundredths`);
        }
    } else {
        // Integer text only: a float baseline (from before whole hundredths) is not read as a figure.
        baseline = typeof baselineRow.value === 'string' && /^-?\d{1,16}$/.test(baselineRow.value) ? Number(baselineRow.value) : NaN;
    }
    const drift = sumBalances - baseline;

    // An open deal's, crowdfund's or bounded enterprise's escrow is not stranded (escrowNotHeldOpenSql). A completed deal's,
    // or a funded or closed project's, escrow that still holds Beans is.
    const strandedEscrows = (db.prepare(`
        SELECT COUNT(*) as c FROM accounts
        WHERE public_key LIKE 'escrow_%' AND balance_c != 0
          AND ${escrowNotHeldOpenSql(db)}
    `).get() as any).c as number;

    // Exact: `drift === 0` is false for a NaN drift (a refused baseline), so that fails too.
    const ok = badBalances === 0 && isHundredths(sumBalances) && drift === 0 && strandedEscrows === 0;
    if (!ok) {
        console.warn(`⚠️ [LedgerAudit] FAILED — sum=${String(sumBalances)}, drift=${String(drift)} hundredths from baseline${Number.isNaN(baseline) ? ' (the stored baseline is not whole hundredths: set a new one)' : ''}, stranded escrows=${strandedEscrows}, balances that are not whole hundredths=${badBalances}`);
    } else {
        console.log(`✅ [LedgerAudit] OK — sum(balances)=${String(sumBalances)} hundredths, drift=0`);
    }
    return { sumBalances, baseline, drift, strandedEscrows, badBalances, ok };
}

/**
 * One part of a new member's credit allowance, as the cohort check read it: what gave it and how much (whole hundredths).
 * `counted` is false for what an owner or admin gave on purpose (the known floor, the granted lane, or a vouch or gift
 * from one of them): the check is about allowance that grew by other routes (Marty, 14 Nov 2026).
 *   earned   real trades (from: null)
 *   vouch    a voucher's vouch (from: the voucher)
 *   gift     a member passed on part of their line (from: that member)
 *   known    the known floor an owner or admin set when confirming them (from: null)
 *   granted  credit granted by hand in the granted lane, members.earned_credit_c (from: null)
 */
export interface AllowancePart { kind: 'earned' | 'vouch' | 'gift' | 'known' | 'granted'; from: string | null; amount_c: number; counted: boolean }

/**
 * A new member the cohort check found past the line: their whole allowance, the part of it counted (not given by an owner
 * or admin), how many whole days after joining the check saw it there, and its parts. Hundredths, like every floor.
 */
export interface CohortAllowanceMember { pubkey: string; allowance_c: number; counted_c: number; daysAfterJoining: number; parts: AllowancePart[] }

export interface WashSybilMetrics {
    totalNegative: number; accountsNearFloor: number; delinquentCount: number; cohortAnomalies: number;
    /** The members past the line in the cohorts counted in cohortAnomalies (the flag names them: owners and admins only). */
    cohortMembers: CohortAllowanceMember[];
}

/** Whether this key holds an owner or admin role here (node_roles; none on a database without the table). */
function isOwnerOrAdmin(db: Db, publicKey: string): boolean {
    try {
        return !!db.prepare("SELECT 1 FROM node_roles WHERE member_pubkey = ? AND role IN ('owner', 'admin') LIMIT 1").get(publicKey);
    } catch (e) {
        if (/no such table/i.test((e as Error)?.message ?? '')) return false;
        throw e;
    }
}

/**
 * The parts of a member's allowance from their trust profile, and the part counted: real trades, and the line a voucher or
 * a member who is no owner or admin gave them (room held, less what an owner or admin gave of it; what they passed on comes
 * out of the counted part first). Never more than the whole allowance, which the community's cap and a freeze bound.
 */
export function allowanceParts(db: Db, publicKey: string, profile: { floor: number; earnedCredit: number; grantedCredit: number; knownGrant: number; roomHeld: number; creditFrozen: boolean }): { allowance_c: number; counted_c: number; parts: AllowancePart[] } {
    const allowance_c = Math.max(0, -profile.floor);
    const parts: AllowancePart[] = [];
    if (profile.earnedCredit > 0) parts.push({ kind: 'earned', from: null, amount_c: profile.earnedCredit, counted: true });
    let fromOwnersAdmins = 0;
    if (profile.roomHeld > 0) {
        let rows: { from_pubkey: string; kind: 'vouch' | 'gift'; amount_c: number }[] = [];
        try {
            rows = db.prepare(`SELECT from_pubkey, kind, SUM(amount_c) AS amount_c FROM room_gifts WHERE to_pubkey = ?
                GROUP BY from_pubkey, kind ORDER BY MIN(at) ASC, from_pubkey ASC`).all(publicKey) as typeof rows;
        } catch (e) {
            if (!/no such table/i.test((e as Error)?.message ?? '')) throw e;
        }
        for (const r of rows) {
            const counted = !isOwnerOrAdmin(db, r.from_pubkey);
            if (!counted) fromOwnersAdmins += r.amount_c;
            parts.push({ kind: r.kind, from: r.from_pubkey, amount_c: r.amount_c, counted });
        }
    }
    if (profile.knownGrant > 0) parts.push({ kind: 'known', from: null, amount_c: profile.knownGrant, counted: false });
    if (profile.grantedCredit > 0 && !profile.creditFrozen) parts.push({ kind: 'granted', from: null, amount_c: profile.grantedCredit, counted: false });
    const countedRoom = Math.max(0, profile.roomHeld - fromOwnersAdmins);
    const counted_c = Math.min(allowance_c, profile.earnedCredit + countedRoom);
    return { allowance_c, counted_c, parts };
}

/**
 * Computes metrics for wash trading, Sybil rings, and delinquency.
 * This is a pure computation function that returns the metrics dictionary
 * without persisting it to the DB (persistence is handled by the server runtime).
 *
 * In one go: the event loop waits for all of it. The node's timers use computeWashSybilMetricsInSlices, which gives the
 * same numbers from the same steps.
 */
export function computeWashSybilMetrics(db: Db): WashSybilMetrics {
    return drainSteps(washSybilMetricsSteps(db));
}

/**
 * computeWashSybilMetrics, giving the event loop a turn (setImmediate) whenever a slice of steps has held it for
 * `sliceMs` (default 20): one step is one member's floor, one cohort member, or one cluster of the wash-trading analysis,
 * most well under a millisecond (trust.ts runStepsInSlices). A slice can't split a step, and one is long: the
 * analysis's pair totals and the last 30 days' trades (trust.ts washTradingAnalysisSteps) are read a page a step (#1908),
 * but the cohort query took 45-60 ms at 101,400 trades (#1793's review). So a slice holds the loop up
 * to that long, however small `sliceMs` is. In one go it held a node for 20 s at 20,000 members and 226 s at 100,000
 * (the global load test, 2026-10-11), answering nothing meanwhile. `onYield` is called at each turn given (a test counts them). Rows written between slices are read as they stand
 * when their step comes, but the wash analysis's, which its steps all read from one snapshot (trust.ts
 * washTradingAnalysisStepsOnSnapshot): a trade can't be read twice or not at all. The numbers are the one-go numbers on
 * a database nothing writes to meanwhile.
 */
export async function computeWashSybilMetricsInSlices(
    db: Db, opts: { sliceMs?: number; onYield?: () => void } = {},
): Promise<WashSybilMetrics> {
    return runStepsInSlices(washSybilMetricsSteps(db), opts);
}

/**
 * The metrics, one step at a time (a yield after each step; computeWashSybilMetrics says what a step is).
 *
 * The wash-trading analysis every floor reads is taken ONCE, at the start, and every member's floor read with it. Each
 * floor used to read the one kept for 10 s (trust.ts getWashTradingEnforcement), so a walk over every member made a new
 * analysis, itself a pass over every member's trades, every 10 s of the walk: the walk's time grows with the members, and
 * so does each analysis, which made the whole walk grow with their square (10x the time for 5x the members). And each
 * active member's floor is worked out once, not again for the cohort count.
 */
function* washSybilMetricsSteps(db: Db): Generator<void, WashSybilMetrics> {
    // 1. Total negative balance
    const totalNegativeRow = db.prepare(`SELECT ABS(SUM(balance_c)) as s FROM accounts WHERE balance_c < 0`).get() as any;
    const totalNegative = totalNegativeRow ? (totalNegativeRow.s || 0) : 0;
    yield;

    // 2. Count of accounts near floor & Delinquent accounts
    let accountsNearFloor = 0;
    let delinquentCount = 0;

    const wash = yield* washTradingAnalysisStepsOnSnapshot(db);
    const profiles = new Map<string, ReturnType<typeof getMemberTrustProfile>>();
    const profileOf = (key: string) => {
        let profile = profiles.get(key);
        if (profile === undefined) {
            profile = getMemberTrustProfile(db, key, 0, wash);
            profiles.set(key, profile);
        }
        return profile;
    };
    const floorOf = (key: string): number => profileOf(key).floor;

    try {
        // The active members a page of rows at a time, in rowid order, so no one query holds the loop for long: all
        // 100,000 in one query took up to 377 ms on a cold database (the global load test, 2026-10-11). The counts don't
        // depend on the order.
        const page = db.prepare('SELECT rowid AS r, public_key, status FROM members WHERE rowid > ? ORDER BY rowid LIMIT 2000');
        const activeMembers = function* (): Generator<{ public_key: string }> {
            let after = Number.MIN_SAFE_INTEGER;
            const seen = new Set<string>();
            for (;;) {
                const rows = page.all(after) as { r: number; public_key: string; status: string }[];
                if (rows.length === 0) return;
                // A member rewritten between slices (a new rowid) is still counted once.
                for (const row of rows) if (row.status === 'active' && !seen.has(row.public_key)) { seen.add(row.public_key); yield row; }
                after = rows[rows.length - 1].r;
            }
        };
        for (const member of activeMembers()) {
            yield;
            const floor = floorOf(member.public_key);
            if (floor < 0) {
                const balRow = db.prepare("SELECT balance_c FROM accounts WHERE public_key = ?").get(member.public_key) as any;
                const bal = balRow ? balRow.balance_c : 0;
                if (bal < 0) {
                    // Near floor: balance within 10 Beans of floor (both whole hundredths, so 10 Beans is beans(10))
                    if (bal - floor <= beans(10)) {
                        accountsNearFloor++;
                    }
                    // Delinquent: balance <= floor * 0.8 AND no transaction in 7 days (as 5 × bal <= 4 × floor: integers, exact)
                    if (bal * 5 <= floor * 4) {
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

    // 3. Cohort Velocity Report: a join week where half or more of the new members reached an allowance of 600 Beans (the
    // Resident line) within 14 days of joining, counting only what grew by routes other than an owner's or admin's grant
    // (Marty, 14 Nov 2026: allowances an owner or admin gave on purpose tripped it, and it named nobody). About the
    // allowance, never spending. Who they are is kept (cohortMembers), for the flag the owners and admins read.
    let cohortAnomalies = 0;
    const cohortMembers: CohortAllowanceMember[] = [];
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

            const fastGrowing: CohortAllowanceMember[] = [];
            for (const key of keys) {
                yield;
                // Only the floor's line counts first (cheap, and most members never come near it): the counted part is
                // never more than the whole allowance.
                if (floorOf(key) > PROTOCOL_CONSTANTS.RESIDENT_THRESHOLD) continue;
                const { allowance_c, counted_c, parts } = allowanceParts(db, key, profileOf(key));
                // The counted part at or past the Resident line (600 Beans, in hundredths like every floor).
                if (-counted_c > PROTOCOL_CONSTANTS.RESIDENT_THRESHOLD) continue;
                const memberRow = db.prepare("SELECT joined_at FROM members WHERE public_key = ?").get(key) as any;
                if (memberRow?.joined_at) {
                    const joined = new Date(memberRow.joined_at);
                    const ageDays = (Date.now() - joined.getTime()) / (1000 * 60 * 60 * 24);
                    if (ageDays < 14) {
                        fastGrowing.push({ pubkey: key, allowance_c, counted_c, daysAfterJoining: Math.max(0, Math.floor(ageDays)), parts });
                    }
                }
            }

            const ratio = fastGrowing.length / keys.length;
            if (keys.length >= 2 && ratio >= 0.5) {
                cohortAnomalies++;
                cohortMembers.push(...fastGrowing);
            }
        }
    } catch (e) {
        console.error('[MetricsAudit] Failed to compute cohort velocity anomalies:', e);
    }

    return { totalNegative, accountsNearFloor, delinquentCount, cohortAnomalies, cohortMembers };
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
 * `plainRows`: a plain table's condition on the rows that travel, by table (apps/server engine/replication-manifest.ts
 * RowRule, from the server's own code): the main server sent only those, so only those are counted here.
 */
export function getReplicaConsistency(
    db: Db, payload: AuditSyncPayload, localCommonsBalance: number, plainRows: Readonly<Record<string, string>> = {},
): ReplicaConsistency {
    // Guarded: a replica whose schema predates a table must report a mismatch on that one row,
    // not throw and abandon the whole consistency report.
    const count = (t: string) => {
        const where = Object.hasOwn(plainRows, t) ? ` WHERE (${plainRows[t]})` : '';
        try { return Number((db.prepare(`SELECT COUNT(*) AS c FROM ${t}${where}`).get() as any).c) || 0; }
        catch { return 0; }
    };

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

    // Whole hundredths, exact: a balance that is not one counts as none (the ledger comparison below counts it unreadable).
    const primarySum = (payload.accounts ?? []).reduce((s, a) => s + (isHundredths(a?.balance_c) ? a.balance_c : 0), 0);
    const backupSum = Number((db.prepare(`SELECT COALESCE(SUM(balance_c), 0) AS s FROM accounts`).get() as any).s) || 0;
    const sumBalances = { primary: primarySum, backup: backupSum, match: primarySum === backupSum };

    let commons: ReplicaConsistency['commons'] = null;
    if (isHundredths(payload.commonsBalance_c)) {
        commons = { primary: payload.commonsBalance_c, backup: localCommonsBalance, match: payload.commonsBalance_c === localCommonsBalance };
    }

    // Every account (G0). The importer writes the copy's rows as they are and deletes the ones it doesn't carry, so after
    // a whole copy the two are equal, balance for balance; any difference is this standby's ledger not being its main
    // server's. Exact: both are whole hundredths, the import writes the one it was sent.
    // A copy that names no account carries no ledger, as the importer reads it (apps/server engine/sync.ts): one with an
    // empty set, or with no entry whose key this server can store.
    let ledger: ReplicaConsistency['ledger'] = null;
    const theirs = new Map<string, number | null>();
    let unreadable = 0;
    for (const a of Array.isArray(payload.accounts) ? payload.accounts : []) {
        // A key SQLite would store as another string is one the importer never writes: unreadable, like an entry
        // with no key, so it asks for no force-resync (a force-resync would read it the same way).
        if (typeof a?.publicKey !== 'string' || !a.publicKey || !isWellFormedKey(a.publicKey)) { unreadable++; continue; }
        const b = isHundredths(a.balance_c) ? a.balance_c : null;
        if (b === null) unreadable++;
        theirs.set(a.publicKey, b);
    }
    if (theirs.size > 0) {
        const ours = new Map((db.prepare('SELECT public_key, balance_c FROM accounts').all() as { public_key: string; balance_c: number | null }[])
            .map((r) => [r.public_key, r.balance_c]));
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
