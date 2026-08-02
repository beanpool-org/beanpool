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
    /**
     * #104 — how many beans of credit this node will extend to this peer before it stops honouring
     * their members' purchases. Bounds how NEGATIVE our `bridge_<peer>` account may go
     * (docs/federation-economics.md Rule 5).
     *
     * DELIBERATELY HAS NO DEFAULT. `undefined` means "not set", and settlement with this peer stays
     * refused until an operator chooses a number. A default that suits a 200-member town quietly
     * overexposes a 15-member one, and small communities are both the most vulnerable to being drained
     * and the least able to absorb a bad balance — so the failure mode of a too-generous default lands
     * hardest exactly where it does most damage.
     *
     * Note the useful consequence: the safe state is also the CURRENT state. With no cap configured,
     * settlement is refused — which is what the #102 kill switch already does. So this inherits
     * fail-closed rather than introducing it.
     *
     * Never negotiated over the wire: each node enforces its own, on its own books, from its own
     * config. A compromised peer must not be able to raise the limit that constrains it.
     */
    creditCap?: number;
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

/**
 * The HTTPS origin a peer's federation API is reachable at, derived from its connector address.
 *
 * Both call sites used to do `address.split(':')`, which is right for `host:port` and WRONG for a multiaddr:
 * a multiaddr contains no colon, so the whole string became the "host" and every multiaddr connector was
 * assigned `https:///ip4/1.2.3.4/tcp/4001/p2p/12D3Koo…`. Nothing complained, because the only test applied to
 * it anywhere is non-emptiness — so that string silently became the buyer's recorded home node on a cross-node
 * purchase (`resolvedHomeNode`) and an entry in the CORS allowlist (`getPeerOrigins`). A multiaddr is the
 * normal way a connector is added, so this was the normal case, not an edge one.
 *
 * Returns undefined when no hostname can be read, so an operator can supply the real URL rather than have a
 * fabricated one stored. The p2p port is never carried over: 4001 is the libp2p listener, not the HTTPS API.
 */
function derivePublicUrl(address: string): string | undefined {
    if (!address) return undefined;

    if (address.startsWith('/')) {
        const parts = address.split('/').filter(Boolean);
        const hostIdx = parts.findIndex(p => ['ip4', 'ip6', 'dns', 'dns4', 'dns6'].includes(p));
        if (hostIdx < 0) return undefined;
        const host = parts[hostIdx + 1];
        if (!host) return undefined;
        // An IPv6 literal MUST be bracketed in a URL (RFC 3986). Unbracketed, `new URL('https://2001:db8::1')`
        // throws — which would make the /api/local/connectors validator reject a legitimate peer, and put an
        // unparseable origin into the CORS allowlist (review finding).
        const bracketed = parts[hostIdx] === 'ip6' && !host.startsWith('[') ? `[${host}]` : host;
        return `https://${bracketed}`;
    }

    // A bracketed IPv6 host:port — `[::1]:8443`. Splitting on ':' would shred the address, so the host is
    // everything up to the closing bracket and only what follows it can be a port.
    if (address.startsWith('[')) {
        const close = address.indexOf(']');
        if (close === -1) return undefined;
        const host = address.slice(0, close + 1);
        const rest = address.slice(close + 1);
        const port = rest.startsWith(':') ? rest.slice(1) : undefined;
        return port && port !== '4001' ? `https://${host}:${port}` : `https://${host}`;
    }

    const [host, port] = address.split(':');
    if (!host) return undefined;
    return port && port !== '4001' ? `https://${host}:${port}` : `https://${host}`;
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

    // Auto-derive publicUrl if missing. Also REPAIRS the malformed values the old `split(':')` derivation
    // wrote for every multiaddr connector — `https:///ip4/…` is not a URL anyone can dial, so leaving it in
    // place would keep feeding a bogus home node into cross-node purchases.
    // Anything that is not a usable string is treated as ABSENT and re-derived. connectors.json is
    // operator-editable, so a truthy non-string (`true`, an object) is reachable: it would make `!c.publicUrl`
    // false and then throw `c.publicUrl.startsWith is not a function` during startup, taking the node down on
    // boot (review finding).
    //
    // Narrowing first, rather than just guarding the startsWith, because merely not throwing would LEAVE the
    // junk value in place — and it goes on to be recorded as a visiting buyer's home node and pushed into the
    // CORS allowlist. Not crashing is not the same as being correct.
    const current = typeof c.publicUrl === 'string' ? c.publicUrl : undefined;
    if (c.address && (!current || current.startsWith('https:///'))) {
        c.publicUrl = derivePublicUrl(c.address);
    }

    return c as ConnectorConfig;
}

function loadConnectors(): void {
    try {
        if (fs.existsSync(CONNECTORS_PATH)) {
            const raw = JSON.parse(fs.readFileSync(CONNECTORS_PATH, 'utf-8'));
            // TRUE ONLY WHEN migrateConnector WOULD ACTUALLY CHANGE SOMETHING, so a load converges.
            //
            // The old test included a bare `!c.publicUrl`. That was harmless while derivation always returned
            // a string (even a malformed one), but this PR lets `derivePublicUrl` return undefined for an
            // address carrying no hostname — and for such a connector `!c.publicUrl` stays true forever,
            // rewriting connectors.json on every single boot without ever converging (review finding).
            //
            // Comparing against what the repair would produce covers every case in one test: a missing or
            // malformed value that CAN be derived saves once and is then settled; one that cannot derive saves
            // never. Note this deliberately does not simply drop the missing-publicUrl case, which would stop
            // persisting the repair this PR exists for.
            const needsMigration = raw.some((c: any) => {
                if (['full_sync', 'credit_verification', 'read_only'].includes(c.trustLevel)) return true;
                if (c.address && c.address.includes(',')) return true;
                const current = typeof c.publicUrl === 'string' ? c.publicUrl : undefined;
                if (!current || current.startsWith('https:///')) {
                    return derivePublicUrl(c.address) !== current;
                }
                return false;
            });
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
            // Same resolution rule as materialise()/isPeerTrusted — one place decides what address
            // names a peer, so /ipfs/ and /p2p/ can't be treated differently in different checks.
            if (connector.address && peerIdFromAddress(connector.address) === peerId) {
                matches = true;
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
    // NOTE THE ORDER: derivation happens only on the INSERT path, below. Deriving up here — as this function
    // used to — meant `publicUrl` was never undefined by the time the update branch tested it, so any update
    // that omitted it (changing trust level, toggling enabled) silently overwrote an operator's stated URL with
    // a guess. That was harmless while nothing could set one; it becomes a regression the moment the route can
    // (review finding).
    const existing = connectors.find(c => c.address === address);
    if (existing) {
        existing.trustLevel = trustLevel;
        if (callsign !== undefined) existing.callsign = callsign;
        if (publicUrl !== undefined) {
            existing.publicUrl = publicUrl;
        } else if (typeof existing.publicUrl === 'string' && existing.publicUrl.startsWith('https:///')) {
            // Repair a malformed stored value in passing, so a node that is reconfigured without being
            // restarted converges too. Still never replaces a GOOD value with a guess.
            existing.publicUrl = derivePublicUrl(address);
        }

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

    // A NEW connector may be derived from, because there is nothing to overwrite.
    const connector: ConnectorConfig = {
        address,
        trustLevel,
        enabled: enabled !== undefined ? enabled : true,
        callsign: callsign || undefined,
        publicUrl: publicUrl ?? (address ? derivePublicUrl(address) : undefined),
        addedAt: Date.now(),
    };

    connectors.push(connector);
    saveConnectors();
    logger.info('P2P', `[Connectors] Added connector: ${address} (trust: ${trustLevel}, enabled: ${connector.enabled})`);
    return connector;
}

/**
 * #104 — set (or clear) the credit cap this node extends to a peer.
 *
 * Pass `undefined`/`null` to clear it, which returns the pair to the fail-closed state: settlement with
 * that peer is refused until a number is chosen again. Clearing is therefore a legitimate operator
 * action — the fastest way to stop honouring a peer's purchases without severing the connection or
 * touching discovery, which must stay open in both directions (Rule 6).
 *
 * Rejects a negative cap: the cap bounds how much credit we EXTEND, so a negative figure is
 * meaningless rather than restrictive, and silently coercing it would hide an operator's mistake.
 */
export function setConnectorCreditCap(address: string, cap: number | null | undefined): ConnectorConfig | null {
    const connector = connectors.find(c => c.address === address);
    if (!connector) return null;

    if (cap === null || cap === undefined) {
        delete connector.creditCap;
        saveConnectors();
        logger.info('P2P', `[Connectors] Credit cap CLEARED for ${address} — cross-node settlement with this peer is now refused`);
        return connector;
    }

    if (!Number.isFinite(cap) || cap < 0) throw new Error('Credit cap must be a non-negative number');

    connector.creditCap = cap;
    saveConnectors();
    logger.info('P2P', `[Connectors] Credit cap for ${address} set to ${cap}`);
    return connector;
}

/** The configured credit cap for a peer, or null when unset (settlement refused). */
export function getConnectorCreditCap(address: string): number | null {
    // Tolerant lookup. A connector can be written as hostname:port, a multiaddr, or an HTTPS URL, and a
    // caller may hold any of them. An exact-match miss returns null, which fail-closes and REFUSES a
    // legitimate settlement — safe, but baffling for the operator who set the cap.
    const connector = connectors.find(c =>
        c.address === address || c.publicUrl === address || resolveMultiaddr(c.address) === address);
    return connector?.creditCap ?? null;
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

/**
 * The peer id an operator wrote into a connector address, when the address is a full multiaddr.
 *
 * Accepts `/ipfs/` as well as `/p2p/` — they are aliases for the same component, and `/ipfs/` is what older
 * tooling and copied-from-docs addresses still emit (review finding). Missing it meant a peer configured
 * that way stayed unidentified, so every peer-id-keyed settlement lookup fail-closed against a connector
 * the operator had configured correctly.
 */
/**
 * Exported because a cross-node purchase has to resolve a peer id from a CONFIGURED connector rather than
 * from a live connection (#143). `ConnectorStatus.peerId` is only populated once a peer has actually been
 * dialled, so keying settlement off it would make a purchase fail purely because nothing had connected yet —
 * and the peer id in the configured address is the same one, known without touching the network.
 *
 * It also means the route can never dial a peer that is not in the operator's connector list.
 */
export function peerIdFromAddress(address?: string): string | null {
    // typeof, not just truthiness: connector records are loaded from JSON on disk, so a hand-edited or
    // corrupted file can put a number or object here, and `.matchAll` would throw a TypeError during boot.
    if (!address || typeof address !== 'string') return null;
    const all = [...address.matchAll(/\/(?:p2p|ipfs)\/([^/]+)/g)].map(m => m[1]);
    if (all.length === 0) return null;
    // The LAST component, not the first (review finding). A circuit-relay multiaddr names two peers —
    // `/ip4/…/p2p/<RELAY>/p2p-circuit/p2p/<TARGET>` — and the one we are actually talking to is the target.
    // Taking the first would key this peer's credit cap, trust level and bridge account to the RELAY, so
    // several peers behind one relay would silently share a single credit line.
    return all[all.length - 1] ?? null;
}

/**
 * Merge a connector's config with its live status.
 *
 * `peerId` falls back to the one embedded in the address. `isPeerTrusted()` has always accepted a peer
 * identified either way, but `getConnectors()` used to report `peerId: null` until a live connection
 * populated the statuses map — so a peer added by full multiaddr was trusted by the protocol gate while
 * every peer-id-keyed lookup (#104's per-peer cap, energy balance, ledger label) still saw an unknown
 * node. Those disagreed about the same connector. One resolution rule, used everywhere.
 *
 * The observed id wins over the configured one when both exist: what actually connected is a fact, what
 * was typed is an intention.
 */
function materialise(c: ConnectorConfig): ConnectorStatus {
    const status = statuses.get(c.address) || newStatus();
    return { ...c, ...status, peerId: status.peerId ?? peerIdFromAddress(c.address) };
}

export function getConnectors(): ConnectorStatus[] {
    return connectors.map(materialise);
}

export function getConnectorByAddress(address: string): ConnectorStatus | null {
    const connector = connectors.find(c => c.address === address);
    return connector ? materialise(connector) : null;
}

// ⚡ Bolt: O(1) allocation lookup instead of calling getConnectors().find() which maps the whole array
export function getConnectorByPublicUrl(publicUrl: string): ConnectorStatus | null {
    const connector = connectors.find(c => c.publicUrl === publicUrl);
    return connector ? materialise(connector) : null;
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

        if (c.address && peerIdFromAddress(c.address) === peerId) {
            return { trusted: true, trustLevel: c.trustLevel, enabled: c.enabled };
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
        result.push(materialise(c));
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
        if (connector.address && peerIdFromAddress(connector.address) === peerId) {
            matches = true;
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
