/**
 * Connector Manager — Independent Peer Connections
 *
 * Each node admin manually configures which peers to trust and connect to.
 * No automatic discovery, no bootstrap lists, no central coordination.
 *
 * Trust Levels:
 *   - mirror: Full state replication (backup/disaster recovery)
 *   - peer:   Cross-community federation (CORS + API access, no sync)
 *   - blocked: Deny API access from this node
 *
 * Connectors are stored in data/connectors.json and persist across restarts.
 */

import fs from 'node:fs';
import path from 'node:path';
import { multiaddr } from '@multiformats/multiaddr';
import type { Libp2p } from 'libp2p';
import { sendHandshake } from './handshake.js';
import { db } from './db/db.js';
import { logger } from './logger.js';

const DATA_DIR = process.env.BEANPOOL_DATA_DIR || path.join(process.cwd(), 'data');
// Experimental peer‑connector toggle – defaults to off for production safety
export const ENABLE_PEER_CONNECTORS = process.env.ENABLE_PEER_CONNECTORS === 'true';
const CONNECTORS_PATH = path.join(DATA_DIR, 'connectors.json');
const HANDSHAKE_INTERVAL_MS = 10_000; // 10 seconds
const RETRY_INTERVAL_MS = 30_000;     // 30 seconds
const MAX_RETRY_DELAY_MS = 5 * 60_000; // 5 minutes max backoff
const TOMBSTONE_RETENTION_DAYS = 30;

export type TrustLevel = 'mirror' | 'peer' | 'blocked';

export interface ConnectorConfig {
    address: string;         // multiaddr or hostname:port (e.g. "us.beanpool.org:4001")
    trustLevel: TrustLevel;
    enabled: boolean;
    callsign?: string;       // friendly name for the UI
    publicUrl?: string;      // HTTPS URL for federation API (e.g. "https://mullum2.beanpool.org")
    addedAt: number;
}

export interface ConnectorStatus extends ConnectorConfig {
    connected: boolean;
    mutualTrust: boolean;        // true = both sides trust each other
    remoteTrustLevel: TrustLevel | null;  // what trust level the OTHER node has for us
    remoteActive: boolean | null;         // true if the remote node's connector is enabled (Active dialer)
    latencyMs: number | null;
    lastVerified: number | null;
    peerId: string | null;
    error: string | null;
}

interface StatusEntry {
    connected: boolean;
    mutualTrust: boolean;
    remoteTrustLevel: TrustLevel | null;
    remoteActive: boolean | null;
    latencyMs: number | null;
    lastVerified: number | null;
    peerId: string | null;
    error: string | null;
}

let connectors: ConnectorConfig[] = [];
const statuses = new Map<string, StatusEntry>();
const retryState = new Map<string, { count: number; nextRetry: number }>();
let p2pNode: Libp2p | null = null;
let handshakeTimer: ReturnType<typeof setInterval> | null = null;
let retryTimer: ReturnType<typeof setInterval> | null = null;

/**
 * Resolve address to a libp2p multiaddr.
 * Accepts: "hostname:port" or full multiaddr string
 */
function resolveMultiaddr(address: string): string {
    if (address.startsWith('/')) {
        return address; // already a multiaddr
    }
    // hostname:port → /dns4/hostname/tcp/port
    const [host, port] = address.split(':');
    return `/dns4/${host}/tcp/${port || '4001'}`;
}

/** Migrate legacy trust levels to new federation model */
function migrateConnector(c: any): ConnectorConfig {
    // Migrate trust levels
    const trustMap: Record<string, TrustLevel> = {
        full_sync: 'mirror',
        credit_verification: 'peer',
        read_only: 'peer',
    };
    if (trustMap[c.trustLevel]) {
        logger.info('P2P', `[Connectors] Migrated ${c.callsign || c.address}: ${c.trustLevel} → ${trustMap[c.trustLevel]}`);
        c.trustLevel = trustMap[c.trustLevel];
    }

    // Fix known typos
    if (c.address && c.address.includes(',')) {
        const fixed = c.address.replace(/,/g, '.');
        logger.info('P2P', `[Connectors] Fixed typo: ${c.address} → ${fixed}`);
        c.address = fixed;
    }

    // Auto-derive publicUrl if missing
    if (!c.publicUrl && c.address) {
        const [host, port] = c.address.split(':');
        c.publicUrl = port && port !== '4001'
            ? `https://${host}:${port}`
            : `https://${host}`;
    }

    return c as ConnectorConfig;
}

function loadConnectors(): void {
    try {
        if (fs.existsSync(CONNECTORS_PATH)) {
            const raw = JSON.parse(fs.readFileSync(CONNECTORS_PATH, 'utf-8'));
            const needsMigration = raw.some((c: any) =>
                ['full_sync', 'credit_verification', 'read_only'].includes(c.trustLevel) ||
                !c.publicUrl ||
                (c.address && c.address.includes(','))
            );
            connectors = raw.map(migrateConnector);
            logger.info('P2P', `[Connectors] Loaded ${connectors.length} connector(s) from disk.`);
            if (needsMigration) {
                saveConnectors();
                logger.info('P2P', `[Connectors] ✅ Migration complete — saved updated connectors.json`);
            }
        }
    } catch (e) {
        logger.warn('P2P', '[Connectors] Failed to load connectors:', e);
        connectors = [];
    }
}

function saveConnectors(): void {
    try {
        if (!fs.existsSync(DATA_DIR)) {
            fs.mkdirSync(DATA_DIR, { recursive: true });
        }
        fs.writeFileSync(CONNECTORS_PATH, JSON.stringify(connectors, null, 2));
    } catch (e) {
        console.error('[Connectors] Failed to save connectors:', e);
    }
}

function newStatus(): StatusEntry {
    return {
        connected: false,
        mutualTrust: false,
        remoteTrustLevel: null,
        remoteActive: null,
        latencyMs: null,
        lastVerified: null,
        peerId: null,
        error: null,
    };
}

export function initConnectorManager(node: Libp2p): void {
    p2pNode = node;
    loadConnectors();

    // Track connection/disconnection events
    node.addEventListener('peer:connect', (evt) => {
        const peerId = evt.detail.toString();

        // Initialize status for this peer ID if we have a connector
        for (const connector of connectors) {
            let matches = false;
            if (connector.address) {
                const match = connector.address.match(/\/p2p\/([^/]+)/);
                if (match && match[1] === peerId) {
                    matches = true;
                }
            }
            const status = statuses.get(connector.address);
            if (status?.peerId === peerId) {
                matches = true;
            }

            if (matches) {
                let status = statuses.get(connector.address);
                if (!status) {
                    status = newStatus();
                    statuses.set(connector.address, status);
                }
                status.peerId = peerId;
                status.connected = true;
                status.error = null;
                retryState.delete(connector.address);
            }
        }

        for (const [addr, status] of statuses.entries()) {
            if (status.peerId === peerId) {
                status.connected = true;
                status.error = null;
                // Reset retry state on successful connection
                retryState.delete(addr);
            }
        }
    });

    node.addEventListener('peer:disconnect', (evt) => {
        const peerId = evt.detail.toString();
        for (const [addr, status] of statuses.entries()) {
            if (status.peerId === peerId) {
                status.connected = false;
                status.mutualTrust = false;
                status.remoteActive = null;
                status.latencyMs = null;
            }
        }
    });

    // Start periodic handshake for trust verification (federation peers use the
    // handshake for mutual-trust establishment and RTT measurement).
    handshakeTimer = setInterval(handshakeConnectedPeers, HANDSHAKE_INTERVAL_MS);

    // Daily-ish tombstone GC: drop tombstones older than retention, but never
    // delete a tombstone that any peer's cursor hasn't yet advanced past.
    pruneTombstones();
    setInterval(pruneTombstones, 24 * 60 * 60 * 1000);

    // Auto‑connect enabled connectors on boot
    if (connectors.some(c => c.enabled)) {
        logger.info('P2P', `[Connectors] 🔄 Auto-connecting ${connectors.filter(c => c.enabled).length} enabled connector(s) in 5s...`);
        setTimeout(() => {
            connectAll().catch(e => logger.warn('P2P', '[Connectors] Auto-connect error:', e));
        }, 5000);
    }

    // Start retry loop for failed connections
    startRetryLoop();
}

/**
 * Send handshake to all connected peers to verify mutual trust and measure RTT.
 */
async function handshakeConnectedPeers(): Promise<void> {
    if (!p2pNode) return;

    for (const connector of connectors) {
        if (!connector.enabled) continue;

        const status = statuses.get(connector.address);
        if (!status?.connected || !status.peerId) continue;

        try {
            const { peerIdFromString } = await import('@libp2p/peer-id');
            const peerId = peerIdFromString(status.peerId);

            const result = await sendHandshake(p2pNode, peerId);

            status.mutualTrust = result.mutualTrust;
            status.remoteTrustLevel = result.remoteTrustLevel;
            status.remoteActive = result.remoteActive;
            status.latencyMs = result.latencyMs;
            status.lastVerified = Date.now();
            status.error = null;
        } catch (e: any) {
            status.connected = false;
            status.mutualTrust = false;
            status.remoteTrustLevel = null;
            status.latencyMs = null;
            status.error = `Handshake failed: ${e.message}`;

            const msg = (e.message || '').toLowerCase();
            const isTransient = msg.includes('closed') || msg.includes('reset') || msg.includes('timeout');

            if (isTransient) {
                logger.info('P2P', `[Connectors] Handshake failed with ${connector.callsign || connector.address}: ${e.message} (normal connection lifecycle refresh)`);
            } else {
                logger.warn('P2P', `[Connectors] Handshake failed with ${connector.callsign || connector.address}: ${e.message}`);
            }

            if (status.peerId) {
                try {
                    const { peerIdFromString } = await import('@libp2p/peer-id');
                    await p2pNode.hangUp(peerIdFromString(status.peerId));
                } catch {}
            }

            if (isTransient) {
                // Schedule instant reconnection to minimize sync downtime
                setTimeout(() => {
                    if (connector.enabled) {
                        const currentStatus = statuses.get(connector.address);
                        if (!currentStatus?.connected) {
                            logger.info('P2P', `[Connectors] 🔄 Attempting immediate reconnection to ${connector.callsign || connector.address} after stream close...`);
                            connectToAddress(connector.address).catch(() => {});
                        }
                    }
                }, 1000);
            }
        }
    }
}

/**
 * Drop tombstones older than the retention window. Conservative: only delete
 * tombstones whose deletedAt is BEFORE the oldest peer cursor (so we never
 * lose a tombstone a peer might still need on its next pull).
 */
function pruneTombstones(): void {
    const retentionThreshold = new Date(Date.now() - TOMBSTONE_RETENTION_DAYS * 24 * 60 * 60 * 1000).toISOString();
    const oldestCursor = db.prepare(`SELECT MIN(last_synced_at) AS oldest FROM sync_cursors`).get() as { oldest: string | null } | undefined;
    // If any peer has a cursor older than the retention threshold, keep the
    // tombstone alive for that peer; otherwise prune by the retention threshold.
    const cutoff = oldestCursor?.oldest && oldestCursor.oldest < retentionThreshold
        ? oldestCursor.oldest
        : retentionThreshold;
    const res = db.prepare(`DELETE FROM tombstones WHERE deleted_at < ?`).run(cutoff);
    if (res.changes > 0) {
        logger.info('P2P', `[Sync] Pruned ${res.changes} tombstone(s) older than ${cutoff}`);
    }
}

/**
 * Retry loop — periodically attempts to reconnect failed/disconnected connectors.
 * Uses exponential backoff: 30s → 60s → 120s → 300s max.
 */
function startRetryLoop(): void {
    retryTimer = setInterval(async () => {
        if (!p2pNode) return;

        for (const connector of connectors) {
            if (!connector.enabled) continue;

            const status = statuses.get(connector.address);
            if (status?.connected) continue; // Already connected

            // Check backoff
            const retry = retryState.get(connector.address) || { count: 0, nextRetry: 0 };
            if (Date.now() < retry.nextRetry) continue; // Not time yet

            logger.info('P2P', `[Connectors] 🔄 Retry #${retry.count + 1} → ${connector.callsign || connector.address}`);
            const success = await connectToAddress(connector.address);

            if (success) {
                retryState.delete(connector.address);
                logger.info('P2P', `[Connectors] ✅ Reconnected to ${connector.callsign || connector.address}`);
            } else {
                // Exponential backoff
                retry.count++;
                const delay = Math.min(RETRY_INTERVAL_MS * Math.pow(2, retry.count - 1), MAX_RETRY_DELAY_MS);
                retry.nextRetry = Date.now() + delay;
                retryState.set(connector.address, retry);
                logger.info('P2P', `[Connectors] ⏳ Next retry for ${connector.callsign || connector.address} in ${Math.round(delay / 1000)}s`);
            }
        }
    }, RETRY_INTERVAL_MS);
}

export async function connectAll(): Promise<void> {
    for (const connector of connectors) {
        if (connector.enabled) {
            await connectToAddress(connector.address);
        }
    }
}

export async function connectToAddress(address: string): Promise<boolean> {
    if (!p2pNode) return false;

    const status = statuses.get(address) || newStatus();
    statuses.set(address, status);

    try {
        const ma = multiaddr(resolveMultiaddr(address));
        const conn = await p2pNode.dial(ma);
        status.connected = true;
        status.peerId = conn.remotePeer.toString();
        status.lastVerified = Date.now();
        status.error = null;
        logger.info('P2P', `[Connectors] ✅ Connected to ${address} (PeerId: ${status.peerId})`);

        // Immediately run handshake to check mutual trust
        try {
            const result = await sendHandshake(p2pNode, conn.remotePeer);
            status.mutualTrust = result.mutualTrust;
            status.remoteTrustLevel = result.remoteTrustLevel;
            status.remoteActive = result.remoteActive;
            status.latencyMs = result.latencyMs;
            logger.info('P2P', `[Connectors] 🤝 Handshake with ${address}: mutual=${result.mutualTrust} latency=${result.latencyMs}ms`);
        } catch (e: any) {
            logger.warn('P2P', `[Connectors] ⚠️  Handshake failed with ${address} — peer may not support protocol yet`);
            logger.warn('P2P', `    ${e.stack || e.message || e}`);
            status.mutualTrust = false;
        }

        return true;
    } catch (e: any) {
        status.connected = false;
        status.error = e.message || 'Connection failed';
        logger.error('P2P', `[Connectors] ❌ Failed to connect to ${address}: ${status.error}`);
        return false;
    }
}

export async function disconnectFromAddress(address: string): Promise<void> {
    if (!p2pNode) return;

    const status = statuses.get(address);
    if (status?.peerId) {
        try {
            const { peerIdFromString } = await import('@libp2p/peer-id');
            const peerId = peerIdFromString(status.peerId);
            await p2pNode.hangUp(peerId);
        } catch (e) {
            // Ignore — peer may already be disconnected
        }
    }

    if (status) {
        status.connected = false;
        status.mutualTrust = false;
        status.remoteActive = null;
        status.latencyMs = null;
        status.error = null;
    }
    logger.info('P2P', `[Connectors] Disconnected from ${address}`);
}

export function addConnector(address: string, trustLevel: TrustLevel, callsign?: string, publicUrl?: string, enabled?: boolean): ConnectorConfig {
    // Auto-derive publicUrl if not provided
    if (!publicUrl && address) {
        const [host, port] = address.split(':');
        publicUrl = port && port !== '4001'
            ? `https://${host}:${port}`
            : `https://${host}`;
    }

    // Prevent duplicates
    const existing = connectors.find(c => c.address === address);
    if (existing) {
        existing.trustLevel = trustLevel;
        if (callsign !== undefined) existing.callsign = callsign;
        if (publicUrl !== undefined) existing.publicUrl = publicUrl;
        
        // If it was enabled and is now disabled (made passive), automatically disconnect
        if (enabled === false && existing.enabled !== false) {
            disconnectFromAddress(address).catch(err => {
                logger.warn('P2P', `[Connectors] Auto-disconnect failed on disable: ${err.message}`);
            });
        }
        
        if (enabled !== undefined) existing.enabled = enabled;
        saveConnectors();
        return existing;
    }

    const connector: ConnectorConfig = {
        address,
        trustLevel,
        enabled: enabled !== undefined ? enabled : true,
        callsign: callsign || undefined,
        publicUrl,
        addedAt: Date.now(),
    };

    connectors.push(connector);
    saveConnectors();
    logger.info('P2P', `[Connectors] Added connector: ${address} (trust: ${trustLevel}, enabled: ${connector.enabled})`);
    return connector;
}

export function removeConnector(address: string): boolean {
    const idx = connectors.findIndex(c => c.address === address);
    if (idx === -1) return false;

    connectors.splice(idx, 1);
    statuses.delete(address);
    saveConnectors();
    logger.info('P2P', `[Connectors] Removed connector: ${address}`);
    return true;
}

export function getConnectors(): ConnectorStatus[] {
    return connectors.map(c => {
        const status = statuses.get(c.address) || newStatus();
        return { ...c, ...status };
    });
}

export function getConnectorByAddress(address: string): ConnectorStatus | null {
    const connector = connectors.find(c => c.address === address);
    if (!connector) return null;

    const status = statuses.get(connector.address) || newStatus();
    return { ...connector, ...status };
}

// ⚡ Bolt: O(1) allocation lookup instead of calling getConnectors().find() which maps the whole array
export function getConnectorByPublicUrl(publicUrl: string): ConnectorStatus | null {
    const connector = connectors.find(c => c.publicUrl === publicUrl);
    if (!connector) return null;

    const status = statuses.get(connector.address) || newStatus();
    return { ...connector, ...status };
}

/**
 * Check if a remote peer (by PeerId string) is trusted by this node.
 * Used by the handshake handler to respond to trust queries.
 */
export function isPeerTrusted(peerId: string): { trusted: boolean; trustLevel: TrustLevel | null; enabled: boolean } {
    // ⚡ Bolt: Iterate raw array instead of calling getConnectors().find() which allocates all objects
    for (const c of connectors) {
        if (c.trustLevel === 'blocked') continue;

        const status = statuses.get(c.address);
        if (status?.peerId === peerId) {
            return { trusted: true, trustLevel: c.trustLevel, enabled: c.enabled };
        }

        if (c.address) {
            const match = c.address.match(/\/p2p\/([^/]+)/);
            if (match && match[1] === peerId) {
                return { trusted: true, trustLevel: c.trustLevel, enabled: c.enabled };
            }
        }
    }

    return { trusted: false, trustLevel: null, enabled: false };
}

/** Get connectors filtered by trust level */
export function getConnectorsByLevel(level: TrustLevel): ConnectorStatus[] {
    // ⚡ Bolt: iterate the raw connectors array and only materialize a ConnectorStatus
    // for matches, instead of getConnectors() which allocates one for every connector.
    const result: ConnectorStatus[] = [];
    for (const c of connectors) {
        if (c.trustLevel !== level) continue;
        result.push({ ...c, ...(statuses.get(c.address) || newStatus()) });
    }
    return result;
}

/** Get CORS-allowed origins from peer connectors (for federation CORS middleware) */
export function getPeerOrigins(): string[] {
    // When experimental peer connectors are disabled, expose no origins
    if (!ENABLE_PEER_CONNECTORS) return [];
    // ⚡ Bolt: read publicUrl straight off the raw connectors. This runs on every CORS
    // check and needs no status merge, so avoid getConnectors()'s per-connector alloc.
    const origins: string[] = [];
    for (const c of connectors) {
        if (c.trustLevel === 'peer' && c.publicUrl) origins.push(c.publicUrl);
    }
    return origins;
}

/** Get the active libp2p node instance for dialing federation streams */
export function getP2pNode(): Libp2p | null {
    return p2pNode;
}

/**
 * Update the handshake status of an inbound trusted peer connection.
 */
export function updateInboundHandshakeStatus(
    peerId: string,
    initiatorTrusted: boolean,
    initiatorTrustLevel: TrustLevel | null,
    initiatorActive: boolean
): void {
    for (const connector of connectors) {
        let matches = false;
        if (connector.address) {
            const match = connector.address.match(/\/p2p\/([^/]+)/);
            if (match && match[1] === peerId) {
                matches = true;
            }
        }
        const status = statuses.get(connector.address);
        if (status?.peerId === peerId) {
            matches = true;
        }

        if (matches) {
            let status = statuses.get(connector.address);
            if (!status) {
                status = newStatus();
                statuses.set(connector.address, status);
            }
            status.peerId = peerId;
            status.connected = true;
            status.error = null;
            
            // Mutual trust is true if both we trust them and they trust us
            const ourTrust = isPeerTrusted(peerId);
            status.mutualTrust = ourTrust.trusted && initiatorTrusted;
            status.remoteTrustLevel = initiatorTrustLevel;
            status.remoteActive = initiatorActive;
            status.lastVerified = Date.now();
            
            // Clear retry state
            retryState.delete(connector.address);
            
            logger.info('P2P', `[Connectors] Inbound handshake verified for ${connector.callsign || connector.address}: mutual=${status.mutualTrust}`);
            return;
        }
    }
}
