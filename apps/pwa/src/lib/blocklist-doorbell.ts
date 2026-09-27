/**
 * "Read the block list again": rung by lib/sync when the node's `blocklist_updated` doorbell reaches this member's
 * socket (their list changed in another tab, on another device, or by a re-key) and whenever the socket opens (it may
 * have changed while the socket was down); heard by lib/blocklist. A window event of its own, so neither module imports
 * the other.
 */
export const BLOCKLIST_DOORBELL_EVENT = 'bp_blocklist_doorbell';

export function ringBlocklistDoorbell(): void {
    if (typeof window !== 'undefined') window.dispatchEvent(new Event(BLOCKLIST_DOORBELL_EVENT));
}
