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
