// This node's role in the one-directional backup topology: the main server, or a standby that copies it.
//
// A leaf module (it reads local-config.json and the environment, nothing else), so the database's boot (db.ts) can ask
// it without an import cycle. engine/sync.ts re-exports it, where the rest of the server imports it from.

import { getLocalConfig } from './local-config.js';

export type NodeRole = 'primary' | 'backup';
let nodeRole: NodeRole | null = null;

/**
 * local-config.json's `nodeRole` wins over NODE_ROLE in the environment (sealed-keys.md §5.4 step 4). Only a
 * take-over writes it, so a promoted standby needs no .env edit, and a later redeploy with the standby's old .env
 * (NODE_ROLE=backup) cannot demote it. Read once, on first use; setNodeRole replaces it for this process.
 */
function resolveNodeRole(): NodeRole {
    try {
        const configured = getLocalConfig().nodeRole;
        if (configured === 'primary' || configured === 'backup') return configured;
    } catch { /* no readable config: the environment decides */ }
    return process.env.NODE_ROLE === 'backup' ? 'backup' : 'primary';
}

export function getNodeRole(): NodeRole {
    return (nodeRole ??= resolveNodeRole());
}

export function setNodeRole(role: NodeRole): void {
    nodeRole = role;
    console.log(`[Topology] NODE_ROLE set to '${role}'`);
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
 * A standby writes no row of the plain tables (engine/replication-manifest.ts PLAIN_TABLES, design G3): keepers' wages owed,
 * Decisions and their ballots, a role a Decision holds aside, keeper requests and changes, succession and convenor votes,
 * invites, re-key codes, recovery releases and links with other communities. Their rows are its main server's, verbatim,
 * and its import alone writes them (design §4.1), as with the ledger (assertLedgerWritable); one of its own would be
 * deleted by the next whole copy, or outlive a take-over. So every writer of them throws this first, before anything is
 * written, and the routes that write them answer the same 409 `standby` before their handler runs
 * (routes/standby-ledger-gate.ts). The timers that write them run on a main server only (state-engine.ts initStateEngine).
 */
export function assertPlainTablesWritable(): void {
    if (getNodeRole() === 'backup') throw new StandbyLedgerError(STANDBY_WRITE_MESSAGE);
}
