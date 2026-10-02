// This node's role in the one-directional backup topology: the main server, or a standby that copies it.
//
// A leaf module (it reads local-config.json, the take-over journal's state and the environment, nothing else), so the
// database's boot (db.ts) can ask it without an import cycle. engine/sync.ts re-exports it, where the rest of the server
// imports it from.

import fs from 'node:fs';
import path from 'node:path';
import { getLocalConfig } from './local-config.js';

export type NodeRole = 'primary' | 'backup';
let nodeRole: NodeRole | null = null;

/**
 * local-config.json's `nodeRole` wins over NODE_ROLE in the environment (sealed-keys.md §5.4 step 4). Only a
 * take-over writes it, so a promoted standby needs no .env edit, and a later redeploy with the standby's old .env
 * (NODE_ROLE=backup) cannot demote it. Read once, on first use; setNodeRole replaces it for this process. A take-over
 * rolled back at boot (services/takeover.ts) reads it again, after putting the standby's own `nodeRole` back. A take-over
 * whose fate this start has still to decide (takeoverMayRollBack) makes this a standby, whatever the config says.
 */
export function resolveNodeRole(): NodeRole {
    // A take-over being rolled back, or one stopped before its restart, which the next start may roll back (services/
    // takeover.ts): neither has made this server the main one, though its `role` step may have written `nodeRole: primary`
    // already. A standby from the database's boot on, until it is decided: a database that booted as the main server's
    // writes what a roll-back would leave behind (the photo URLs' shape, the recovery seal's clear, the schema passes) and
    // arms the main server's timers.
    if (takeoverMayRollBack()) return 'backup';
    return roleFromSettings();
}

/** The role local-config.json's `nodeRole`, then NODE_ROLE, give: what this server runs as once no take-over is undecided. */
export function roleFromSettings(): NodeRole {
    try {
        const configured = getLocalConfig().nodeRole;
        if (configured === 'primary' || configured === 'backup') return configured;
    } catch { /* no readable config: the environment decides */ }
    return process.env.NODE_ROLE === 'backup' ? 'backup' : 'primary';
}

/**
 * The take-over steps before its restart (services/takeover.ts PRE_RESTART), in order. Until every one is recorded, a start
 * may roll the take-over back; once they are, it only goes on.
 */
export const TAKEOVER_STEPS_BEFORE_RESTART = [
    'undo-copy', 'identity-files', 'admin-settings', 'roles', 'public-address', 'profile', 'open-door', 'community-settings', 'role', 'pull-config',
] as const;

/**
 * The take-over journal's head, as services/takeover.ts reads it (readJournal): version 1, a string id, an object of steps.
 * Anything else (`{}`, `[]`, no steps, another version) is no journal to the take-over code, which never resumes or rolls it
 * back, so it decides nothing here either.
 */
export interface TakeoverJournalHead { v: 1; id: string; state?: unknown; rolledBack?: unknown; steps: Record<string, unknown> }

export function isTakeoverJournal(j: unknown): j is TakeoverJournalHead {
    if (!j || typeof j !== 'object' || Array.isArray(j)) return false;
    const o = j as Record<string, unknown>;
    return o.v === 1 && typeof o.id === 'string' && !!o.steps && typeof o.steps === 'object' && !Array.isArray(o.steps);
}

function readTakeoverJournal(): TakeoverJournalHead | null {
    try {
        const dataDir = process.env.BEANPOOL_DATA_DIR || path.join(process.cwd(), 'data');
        const j = JSON.parse(fs.readFileSync(path.join(dataDir, 'takeover-journal.json'), 'utf-8')) as unknown;
        return isTakeoverJournal(j) ? j : null;
    } catch {
        return null;
    }
}

/**
 * Whether a start may still roll back the take-over this journal records, exactly when services/takeover.ts would resume
 * or roll it back at a start: one being rolled back ('rolling-back'), or one under way (neither complete nor rolled back)
 * that has not recorded its restart and lacks a step before it. Its start resumes it, and rolls it back if that step fails
 * or its opened keys are gone. One that recorded its restart ran every step its own build had before it (a journal from a
 * build without a later step lacks that step for good) and only goes on, on a main server.
 */
export function journalMayRollBack(j: TakeoverJournalHead): boolean {
    if (j.state === 'rolling-back') return true;
    if (j.state === 'complete' || (j.state === 'failed' && !!j.rolledBack)) return false;
    if (j.steps.restart) return false;
    return TAKEOVER_STEPS_BEFORE_RESTART.some((s) => !j.steps[s]);
}

/** journalMayRollBack for data/takeover-journal.json as it is on disk; false when there is none the take-over code reads. */
export function takeoverMayRollBack(): boolean {
    const j = readTakeoverJournal();
    return !!j && journalMayRollBack(j);
}

export function getNodeRole(): NodeRole {
    return (nodeRole ??= resolveNodeRole());
}

/** Called after the role changes in this process, with the new role. */
const roleListeners = new Set<(role: NodeRole) => void>();

/**
 * Run `fn` each time setNodeRole changes this process's role (a take-over finished at boot promotes a standby; a config
 * that says standby demotes a main server). A listener that throws is logged and the rest still run. Returns the
 * unsubscribe. The snapshot scheduler starts or stops on it (services/snapshot-scheduler.ts).
 */
export function onNodeRoleChange(fn: (role: NodeRole) => void): () => void {
    roleListeners.add(fn);
    return () => { roleListeners.delete(fn); };
}

export function setNodeRole(role: NodeRole): void {
    const was = nodeRole;
    nodeRole = role;
    console.log(`[Topology] NODE_ROLE set to '${role}'`);
    if (was === role) return;
    for (const fn of roleListeners) {
        try { fn(role); } catch (e) { console.warn('[Topology] A role-change listener failed:', (e as Error)?.message || e); }
    }
}

/** The code a standby's refusal carries, as the escrow write-off's does (engine/escrow-write-off.ts). */
export const STANDBY_CODE = 'standby';
export const STANDBY_LEDGER_MESSAGE = 'This server is a standby copy of the community, not its main server. Beans move only on the main server, '
    + 'and this copy picks the change up with its next sync.';

/** A Bean move asked of a standby: 409 `standby`, the escrow write-off's status and code. */
export class StandbyLedgerError extends Error {
    readonly code = STANDBY_CODE;
    readonly status = 409;
    readonly statusCode = 409;
    constructor(message: string = STANDBY_LEDGER_MESSAGE) {
        super(message);
        this.name = 'StandbyLedgerError';
    }
}

/**
 * A standby makes no Bean move of its own (director, 2026-09-28): its ledger is its main server's rows, verbatim, and its
 * import is their only writer (design §4.1). Members use the main server. So every path that would write a balance or a
 * trade here throws StandbyLedgerError first, before anything is written: the ledger primitives (state-engine.ts
 * transfer, moveToCommons, payFromCommons, settleDemurrage, and conservingTransaction before it opens, which covers
 * every composed move: trades and escrow steps, settlements, prunes, a member's own delete, Decisions, wind-ups), every
 * step of a trade (state-engine.ts requestPost to resolveEscrowDispute), the raw writers of the pot and of demurrage
 * (engine/audit.ts), and the crowdfund pledge and refunds (db.ts). The routes that move Beans or step a trade answer the
 * same refusal before their handler runs (routes/standby-ledger-gate.ts).
 *
 * Not refused: a zero-balance row that comes with a member's or an enterprise's own row (a join, a visitor, a treasury, a
 * project, a bridge). It moves no Bean and records no trade, and the next copy, which carries the main server's account
 * set exactly, drops it.
 */
export function assertLedgerWritable(): void {
    if (getNodeRole() === 'backup') throw new StandbyLedgerError();
}

export const STANDBY_WRITE_MESSAGE = 'This server is a standby copy of the community, not its main server. This is changed on the main server, '
    + 'and this copy picks the change up with its next sync.';

/**
 * A standby writes no row of the plain tables (engine/replication-manifest.ts PLAIN_TABLES, design G3, G4): keepers' wages
 * owed, Decisions and their ballots, a role a Decision holds aside, keeper requests and changes, succession and convenor
 * votes, invites, re-key codes, recovery releases and links with other communities; members' phones and their leave
 * statements, chat mutes, enterprise thread read marks, event reminders sent, the activity list and the pricing guide
 * with its reports. Their rows are its main server's, verbatim,
 * and its import alone writes them (design §4.1), as with the ledger (assertLedgerWritable); one of its own would be
 * deleted by the next whole copy, or outlive a take-over. So every writer of them throws this first, before anything is
 * written, and the routes that write them answer the same 409 `standby` before their handler runs
 * (routes/standby-ledger-gate.ts). The timers that write them run on a main server only (state-engine.ts initStateEngine).
 * A write a standby's read or a listing it takes would make on the side (an activity line, a keeper's first read mark)
 * writes nothing there instead (standbyWritesNothing).
 */
export function assertPlainTablesWritable(): void {
    if (getNodeRole() === 'backup') throw new StandbyLedgerError(STANDBY_WRITE_MESSAGE);
}

/**
 * For a write a standby makes on the side of something it still does (a read that marks a thread read the first time, a
 * listing's line in the activity list): true on a standby, where the plain tables are its main server's alone, and the
 * caller writes nothing (assertPlainTablesWritable is for a write that is the request itself).
 */
export function standbyWritesNothing(): boolean {
    return getNodeRole() === 'backup';
}
