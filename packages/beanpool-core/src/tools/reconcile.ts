/**
 * The one sync rule for every tool's document (scratch/tools/DESIGN-tool-template-fable.md §1.6), the hosts' on open:
 * the device's copy against the node's private copy (member_tool_state), last writer wins. Pure: the host does the GET,
 * the PUT and the writes; this only says which.
 *
 * The device keeps, beside the body, `updatedAt` (its last write) and `syncedAt` (the node copy's updatedAt this body was
 * last reconciled with; after a take or a put the host sets both to the node's updatedAt). So the device has changed
 * since the last sync when its updatedAt is not its syncedAt, and the node has when its updatedAt is not the device's
 * syncedAt; neither needs two clocks to agree. Only when both changed are the two times compared: the later wins (a time
 * that isn't one counts as the earliest), and a tie goes to the node's, the copy every device shares.
 */

/** The device's copy, or null when this device has never kept one (first open). */
export interface ToolLocalCopy {
    body: string;
    updatedAt: string;
    syncedAt: string | null;
}

/** What the node answered for the tool's copy. */
export type ToolRemoteCopy =
    | { kind: 'copy'; body: string; updatedAt: string }
    /** The node keeps copies and has none of this tool's yet. */
    | { kind: 'none' }
    /** A 404 from a node older than the store: this device only, and the backup line says so. */
    | { kind: 'older-node' }
    /** No answer: try again on the next open. */
    | { kind: 'offline' };

export type ToolSyncWhy = 'first-open' | 'device-newer' | 'node-newer' | 'equal' | 'no-copy' | 'older-node' | 'offline';

export type ToolSyncStep =
    /** Write the node's copy on the device (read() it first, as any stored value); updatedAt and syncedAt become its updatedAt. */
    | { do: 'take'; body: string; updatedAt: string; why: ToolSyncWhy }
    /** PUT the device's copy; updatedAt and syncedAt become the node's answer. */
    | { do: 'put'; why: ToolSyncWhy }
    | { do: 'nothing'; why: ToolSyncWhy }
    /** Keep the device's copy and say it is on this phone only (an older node). */
    | { do: 'device-only'; why: ToolSyncWhy }
    /** Keep the device's copy; reconcile again on the next open. */
    | { do: 'later'; why: ToolSyncWhy };

const when = (iso: string): number => {
    const at = Date.parse(iso);
    return Number.isFinite(at) ? at : Number.NEGATIVE_INFINITY;
};

/** What to do with a tool's document on open, given the device's copy and the node's answer. */
export function reconcile(local: ToolLocalCopy | null, remote: ToolRemoteCopy): ToolSyncStep {
    if (remote.kind === 'offline') return { do: 'later', why: 'offline' };
    if (remote.kind === 'older-node') return { do: 'device-only', why: 'older-node' };
    if (local === null) {
        return remote.kind === 'copy'
            ? { do: 'take', body: remote.body, updatedAt: remote.updatedAt, why: 'first-open' }
            : { do: 'nothing', why: 'first-open' };
    }
    if (remote.kind === 'none') return { do: 'put', why: 'no-copy' };
    const deviceChanged = local.updatedAt !== local.syncedAt;
    const nodeChanged = remote.updatedAt !== local.syncedAt;
    if (!deviceChanged && !nodeChanged) return { do: 'nothing', why: 'equal' };
    if (deviceChanged && (!nodeChanged || when(local.updatedAt) > when(remote.updatedAt))) return { do: 'put', why: 'device-newer' };
    return { do: 'take', body: remote.body, updatedAt: remote.updatedAt, why: 'node-newer' };
}
