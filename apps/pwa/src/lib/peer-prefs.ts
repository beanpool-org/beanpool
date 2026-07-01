/**
 * Peer Node Preferences — shared between MarketplacePage and MapPage
 *
 * Stores which peer nodes are "enabled" (toggled on) in localStorage.
 * Home node is always included; peers can be independently toggled.
 */

const STORAGE_KEY = 'beanpool_enabled_peers';

export function loadEnabledPeers(): Set<string> {
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (raw) return new Set(JSON.parse(raw));
    } catch { /* corrupt data */ }
    return new Set();
}

export function saveEnabledPeers(peers: Set<string>): void {
    localStorage.setItem(STORAGE_KEY, JSON.stringify([...peers]));
}

export function togglePeer(current: Set<string>, peerUrl: string): Set<string> {
    const next = new Set(current);
    if (next.has(peerUrl)) {
        next.delete(peerUrl);
    } else {
        next.add(peerUrl);
    }
    saveEnabledPeers(next);
    return next;
}
