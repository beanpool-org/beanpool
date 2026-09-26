/**
 * Sync Library — WebSocket connection to the BeanPool Node
 *
 * Maintains a persistent connection to the Node's state feed.
 * Stores latest state in localStorage for offline read-only access.
 */

import { livePostChange, reconnectDelayMs, reconnectSyncDelayMs } from '@beanpool/core';
import { loadIdentity } from './identity';
import { buildSignedWsParams, getNodeWsUrl } from './api';
import { routeLivePostChange } from './live-posts';
import { createVisitorDoorbells } from './visitor-doorbells';
import {
    requestSync,
    registerSyncActivityListener,
    setOnSyncCompletedCallback,
    getSyncCursor,
    saveSyncCursor,
    clearSyncCursor,
    computeUpdatedAfter,
    SYNC_CURSOR_KEY,
} from './sync-coordinator';

export {
    requestSync,
    getSyncCursor,
    saveSyncCursor,
    clearSyncCursor,
    computeUpdatedAfter,
    SYNC_CURSOR_KEY,
};

export interface SyncState {
    connected: boolean;
    lastSyncTime: number | null;   // Unix timestamp
    merkleRoot: string | null;
    accountCount: number;
}

type SyncCallback = (state: SyncState) => void;

const STORAGE_KEY = 'beanpool-sync-state';

let ws: WebSocket | null = null;
let reconnectTimeoutId: ReturnType<typeof setTimeout> | null = null;
/** Armed on open; resets the backoff only if the socket is still up 10s later. */
let stabilityTimeoutId: ReturnType<typeof setTimeout> | null = null;
let pingIntervalId: ReturnType<typeof setInterval> | null = null;
/** Retries since the socket last proved stable; sizes the full-jitter window (@beanpool/core reconnectDelayMs). */
let reconnectAttempt = 0;
/** True while the connection being made is a retry after a drop, not a start or the tab coming back. */
let isRetry = false;
let reconnectSyncTimeoutId: ReturnType<typeof setTimeout> | null = null;
/** The member this socket signed in as, so a pushed change about their own listing takes the full refresh. */
let memberPubkey: string | null = null;
/**
 * True while the socket was opened with no identity at all: a visitor's (the global lobby, G9b). It gets only bare
 * doorbells, each one a read of the whole guest list, so they go through `visitorDoorbells` instead of straight into
 * the coordinator. A member's socket never does.
 */
let visitorSocket = false;
const visitorDoorbells = createVisitorDoorbells({ read: () => requestSync() });
let isConnecting = false;
/** Bumped by reconnectToAnchor: a connect still reading the identity from before it opens nothing. */
let connectGeneration = 0;
let currentUrl: string | null = null;

export const HEARTBEAT_INTERVAL_MS = 30_000;
/**
 * Pong watchdog timeout (75s = 2.5x ping interval).
 * Allows 2 consecutive missed pings plus a 15-second grace period for mobile RTT/retransmission.
 * Tighter (e.g. 30-45s) risks false disconnects on temporary packet loss / cell handover;
 * looser (>90s) leaves clients sitting on stale data too long.
 */
export const PONG_TIMEOUT_MS = 75_000;

let lastPongAt: number | null = null;
let watchdogArmed = false;
let watchdogTimeoutId: ReturnType<typeof setTimeout> | null = null;

function sendPing(socket: WebSocket): void {
    if (ws === socket && socket.readyState === WebSocket.OPEN) {
        try {
            socket.send(JSON.stringify({ type: 'ping', wantPong: true }));
        } catch (err) {
            console.warn('[WS Sync] Failed to send heartbeat', err);
        }
    }
}

function handlePong(socket: WebSocket): void {
    if (ws !== socket) return;
    lastPongAt = Date.now();
    // Trap 2: Only arms after seeing at least one pong on this connection
    watchdogArmed = true;
    resetWatchdogTimer(socket);
}

function resetWatchdogTimer(socket: WebSocket): void {
    if (watchdogTimeoutId) {
        clearTimeout(watchdogTimeoutId);
        watchdogTimeoutId = null;
    }
    if (!watchdogArmed) return;
    if (typeof document !== 'undefined' && (document.hidden || document.visibilityState === 'hidden')) return;

    watchdogTimeoutId = setTimeout(() => {
        if (ws === socket && socket.readyState === WebSocket.OPEN) {
            console.warn('[WS Sync] Watchdog timeout: no pong received within limit. Closing dead socket.');
            try { socket.close(); } catch {}
        }
    }, PONG_TIMEOUT_MS);
}

function stopHeartbeat(): void {
    if (pingIntervalId) {
        clearInterval(pingIntervalId);
        pingIntervalId = null;
    }
    if (watchdogTimeoutId) {
        clearTimeout(watchdogTimeoutId);
        watchdogTimeoutId = null;
    }
}

function startHeartbeat(socket: WebSocket): void {
    stopHeartbeat();
    if (typeof document !== 'undefined' && (document.hidden || document.visibilityState === 'hidden')) return;

    sendPing(socket);
    pingIntervalId = setInterval(() => {
        sendPing(socket);
    }, HEARTBEAT_INTERVAL_MS);

    if (watchdogArmed) {
        resetWatchdogTimer(socket);
    }
}

let listeners: SyncCallback[] = [];
let announcementListeners: ((a: any) => void)[] = [];
let socketOpenListeners: (() => void)[] = [];
let currentState: SyncState = loadCachedState();

function updateLastSyncTime(time: number): void {
    currentState = {
        ...currentState,
        lastSyncTime: time,
    };
    cacheState(currentState);
    notify();
}

// Keep SyncStatus and UI updated whenever coordinator completes a sync run
setOnSyncCompletedCallback(updateLastSyncTime);

function loadCachedState(): SyncState {
    try {
        const cached = localStorage.getItem(STORAGE_KEY);
        if (cached) return JSON.parse(cached);
    } catch { /* ignore */ }
    return { connected: false, lastSyncTime: null, merkleRoot: null, accountCount: 0 };
}

function cacheState(state: SyncState): void {
    try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    } catch { /* ignore */ }
}

function notify(): void {
    listeners.forEach((cb) => cb(currentState));
}

function establishConnection(wsUrl: string, originalUrl: string): void {
    if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
        isConnecting = false;
        return;
    }

    let socket: WebSocket;
    try {
        socket = new WebSocket(wsUrl);
        ws = socket;
    } catch {
        isConnecting = false;
        currentState = { ...currentState, connected: false };
        notify();
        scheduleReconnect(originalUrl);
        return;
    }

    socket.onopen = () => {
        if (ws !== socket) return;
        // Backoff resets only once the connection has PROVEN stable, not the instant it opens.
        // A socket that flaps — opening and dropping within milliseconds against a node that is
        // up but unhealthy — used to reset the delay to 1s on every handshake, so the
        // exponential backoff never engaged. That was merely wasteful before; now that opening
        // also triggers a sync, a flapping socket would drive a sync roughly once a second.
        if (stabilityTimeoutId) clearTimeout(stabilityTimeoutId);
        stabilityTimeoutId = setTimeout(() => {
            stabilityTimeoutId = null;
            if (ws === socket && socket.readyState === WebSocket.OPEN) {
                reconnectAttempt = 0;
            }
        }, 10_000);
        if (reconnectTimeoutId) {
            clearTimeout(reconnectTimeoutId);
            reconnectTimeoutId = null;
        }
        watchdogArmed = false;
        lastPongAt = null;
        if (watchdogTimeoutId) {
            clearTimeout(watchdogTimeoutId);
            watchdogTimeoutId = null;
        }

        currentState = { ...currentState, connected: true };
        notify();
        // What was kept while the socket was down (the moderation notices the web app reads, SystemAlerts).
        socketOpenListeners.forEach(cb => { try { cb(); } catch { /* a listener's failure is its own */ } });

        // The catch-up sync for whatever was missed while the socket was down. After a drop it waits a random
        // 0–3 s on top of the retry's own spread: a node or edge restart drops every tab at once, and their syncs
        // must not all land in the same second either. A first connect or the tab coming back syncs at once.
        const syncNow = () => requestSync().catch(err => {
            console.warn('[WS Sync] Reconnect sync error:', err);
        });
        if (isRetry) {
            isRetry = false;
            if (reconnectSyncTimeoutId) clearTimeout(reconnectSyncTimeoutId);
            reconnectSyncTimeoutId = setTimeout(() => {
                reconnectSyncTimeoutId = null;
                syncNow();
            }, reconnectSyncDelayMs());
        } else {
            syncNow();
        }

        // Start 30s heartbeat keep-alive with opt-in pong
        startHeartbeat(socket);
    };

    socket.onmessage = (event) => {
        if (ws !== socket) return;
        try {
            const data = JSON.parse(event.data);

            // Trap 1: Exclude pong from the doorbell so watchdog's own keepalive
            // does not drive a sync every 30s.
            if (data.type === 'pong') {
                handlePong(socket);
                return;
            }
            
            if (data.type === 'system_announcement') {
                announcementListeners.forEach(cb => cb(data));
                return;
            }

            currentState = {
                connected: true,
                lastSyncTime: Date.now(),
                merkleRoot: data.merkleRoot ?? currentState.merkleRoot,
                accountCount: data.accountCount ?? currentState.accountCount,
            };
            cacheState(currentState);
            notify();

            // Doorbell: non-snapshot broadcasts signal data changed. Routed through the
            // coordinator rather than firing every listener directly, so bursts coalesce
            // (150ms debounce), only one run is ever in flight, and a request arriving
            // mid-run queues exactly one trailing run.
            //
            // `new_message` is deliberately NOT excluded, which departs from native. Native
            // skips requestSync() on new_message because THERE performSync is a heavy
            // multi-endpoint delta pull, and running one per received message hammered the
            // node and churned the sync lock. The PWA coordinator is not that: its work is
            // firing the registered listeners, which on a new message are exactly the right
            // things to run — loadConversations, and the open chat's loadMessages.
            // Excluding it would kill the fast path MessagesPage documents at its
            // onSyncActivity subscription: the open conversation would stop updating on
            // arrival and fall back to its poll tick, which Stage 5 relaxes to a backstop.
            //
            // A public offer or need the node sent whole is not a doorbell: the views that hold
            // listings write it into their lists (lib/live-posts), and nothing is fetched. One that
            // involves this member, or a view is tied to, rings the doorbell as before.
            //
            // A visitor's doorbell waits its turn (lib/visitor-doorbells): a thousand lobbies must not all read the
            // guest list in the same moment, nor each once per change.
            if (data.type !== 'state_snapshot') {
                const change = livePostChange(data);
                if (change && routeLivePostChange(change, memberPubkey)) return;
                if (visitorSocket) {
                    visitorDoorbells.ring();
                    return;
                }
                requestSync().catch(err => {
                    console.warn('[WS Sync] Broadcast sync error:', err);
                });
            }
        } catch { /* ignore malformed messages */ }
    };

    socket.onclose = () => {
        if (ws === socket) {
            ws = null;
            stopHeartbeat();
            watchdogArmed = false;
            lastPongAt = null;
            // Dropped before it proved stable, so the backoff must keep growing.
            if (stabilityTimeoutId) {
                clearTimeout(stabilityTimeoutId);
                stabilityTimeoutId = null;
            }
            currentState = { ...currentState, connected: false };
            notify();
            scheduleReconnect(originalUrl);
        }
    };

    socket.onerror = () => {
        if (ws !== socket) return;
        socket.close();
    };
}

/**
 * Connect to the BeanPool node's WebSocket state feed.
 */
export function connectToAnchor(url?: string): void {
    if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;
    if (isConnecting) return;
    isConnecting = true;
    const generation = connectGeneration;

    const baseWsUrl = url ?? getNodeWsUrl('/ws');
    currentUrl = baseWsUrl;

    loadIdentity()
        .then(async (ident) => {
            if (generation !== connectGeneration) return;
            memberPubkey = ident?.publicKey ?? null;
            visitorSocket = !ident;
            const params: string[] = [];
            if (ident && ident.callsign) {
                params.push(`callsign=${encodeURIComponent(ident.callsign)}`);
            }
            // WS connect auth (SRV-4): a member-signed socket gets the full feed; an
            // unsigned one gets only public doorbells (and is refused under ENFORCE_WS_AUTH=true).
            try {
                const signed = await buildSignedWsParams('/ws');
                if (signed) params.push(signed);
            } catch { /* unsigned fallback */ }
            if (generation !== connectGeneration) return;
            const wsUrl = params.length ? `${baseWsUrl}?${params.join('&')}` : baseWsUrl;
            establishConnection(wsUrl, baseWsUrl);
        })
        .catch(() => {
            if (generation !== connectGeneration) return;
            // The identity could not be read, so nobody knows this is a visitor: the doorbells ring as a member's did.
            visitorSocket = false;
            establishConnection(baseWsUrl, baseWsUrl);
        })
        .finally(() => {
            if (generation === connectGeneration) isConnecting = false;
        });
}

/**
 * Close the socket and open it again, signed by the identity stored now. For a page whose visitor has just joined (the
 * global lobby, G9b): its socket opened with no key gets only doorbells, and connectToAnchor keeps a socket that is open.
 * A connect still part way through, which read the identity from before, opens nothing; and the new socket starts as a
 * first connect does, with no backoff or delayed sync carried over from the key-less one's drops.
 */
export function reconnectToAnchor(): void {
    const socket = ws;
    if (socket) {
        ws = null;
        stopHeartbeat();
        if (stabilityTimeoutId) {
            clearTimeout(stabilityTimeoutId);
            stabilityTimeoutId = null;
        }
        try { socket.close(); } catch { /* already closing */ }
    }
    if (reconnectTimeoutId) {
        clearTimeout(reconnectTimeoutId);
        reconnectTimeoutId = null;
    }
    if (reconnectSyncTimeoutId) {
        clearTimeout(reconnectSyncTimeoutId);
        reconnectSyncTimeoutId = null;
    }
    // The member's socket opens with a sync of its own: nothing the lobby held back is read on its behalf later.
    visitorDoorbells.reset();
    connectGeneration++;
    isConnecting = false;
    reconnectAttempt = 0;
    isRetry = false;
    watchdogArmed = false;
    lastPongAt = null;
    connectToAnchor(currentUrl ?? undefined);
}

function scheduleReconnect(url: string): void {
    if (reconnectTimeoutId) return;

    // Full jitter over a window that starts at 5 s and grows to 30 s. When Cloudflare restarts an edge server,
    // every tab on it drops at once; 1 s plus up to 1 s of jitter brought them all back inside two seconds.
    const delay = reconnectDelayMs(reconnectAttempt);

    reconnectTimeoutId = setTimeout(() => {
        reconnectTimeoutId = null;
        reconnectAttempt++;
        isRetry = true;
        connectToAnchor(url);
    }, delay);
}

// Page visibility listener — reconnects immediately when tab returns to foreground,
// and pauses heartbeat / watchdog while hidden so a hidden tab is not kept awake.
if (typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', () => {
        const isHidden = document.hidden || document.visibilityState === 'hidden';
        if (isHidden) {
            stopHeartbeat();
            visitorDoorbells.hidden();
        } else {
            const isDead = !ws || ws.readyState === WebSocket.CLOSED || ws.readyState === WebSocket.CLOSING;
            if (isDead) {
                if (ws) {
                    try { ws.close(); } catch {}
                    ws = null;
                }
                // Unlinking `ws` above means the old socket's onclose never runs its cleanup, so
                // the armed flag would survive onto the REPLACEMENT connection and let the
                // watchdog fire before that connection has ever produced a pong — the exact
                // invariant the arm-on-first-pong rule exists to hold. Reset it here too.
                watchdogArmed = false;
                lastPongAt = null;
                stopHeartbeat();
                if (reconnectTimeoutId) {
                    clearTimeout(reconnectTimeoutId);
                    reconnectTimeoutId = null;
                }
                // One person coming back to the tab: reconnect and sync at once, and start any later
                // backoff from the first window again.
                reconnectAttempt = 0;
                isRetry = false;
                // That sync reads after every doorbell a visitor's tab held while hidden: they need no read of their own.
                visitorDoorbells.reset();
                connectToAnchor(currentUrl ?? undefined);
            } else if (ws) {
                visitorDoorbells.visible();
                startHeartbeat(ws);
            }
        }
    });
}

/**
 * Subscribe to sync state changes.
 */
export function onSyncChange(cb: SyncCallback): () => void {
    listeners.push(cb);
    cb(currentState); // Immediate callback with current state
    return () => {
        listeners = listeners.filter((l) => l !== cb);
    };
}

/**
 * Get the current sync state (for non-reactive reads).
 */
export function getSyncState(): SyncState {
    return currentState;
}

/**
 * Subscribe to WebSocket "activity" — routed through the sync coordinator.
 * Fires during coordinated sync runs (e.g. on reconnect and on non-chat broadcasts)
 * to let open views refresh in a debounced, single-flight manner.
 */
export function onSyncActivity(cb: () => void | Promise<void>): () => void {
    return registerSyncActivityListener(cb);
}

/**
 * Subscribe to system announcements globally.
 */
export function onSystemAnnouncement(cb: (a: any) => void): () => void {
    announcementListeners.push(cb);
    return () => {
        announcementListeners = announcementListeners.filter(l => l !== cb);
    };
}

/**
 * Subscribe to the socket opening: a first connect, a retry after a drop, or the tab coming back. A live event sent
 * while the socket was down never arrives, so this is when to read what was kept for this member.
 */
export function onSocketOpen(cb: () => void): () => void {
    socketOpenListeners.push(cb);
    return () => {
        socketOpenListeners = socketOpenListeners.filter(l => l !== cb);
    };
}

/**
 * Reset sync module state for isolated unit testing.
 */
export function resetSyncForTest(): void {
    if (ws) {
        try { ws.close(); } catch {}
        ws = null;
    }
    if (reconnectTimeoutId) {
        clearTimeout(reconnectTimeoutId);
        reconnectTimeoutId = null;
    }
    stopHeartbeat();
    if (stabilityTimeoutId) {
        clearTimeout(stabilityTimeoutId);
        stabilityTimeoutId = null;
    }
    if (reconnectSyncTimeoutId) {
        clearTimeout(reconnectSyncTimeoutId);
        reconnectSyncTimeoutId = null;
    }
    watchdogArmed = false;
    lastPongAt = null;
    reconnectAttempt = 0;
    isRetry = false;
    memberPubkey = null;
    visitorSocket = false;
    visitorDoorbells.reset();
    isConnecting = false;
    currentUrl = null;
    listeners = [];
    announcementListeners = [];
    socketOpenListeners = [];
    currentState = { connected: false, lastSyncTime: null, merkleRoot: null, accountCount: 0 };
}

export function getWatchdogArmedForTest(): boolean {
    return watchdogArmed;
}

export function getLastPongAtForTest(): number | null {
    return lastPongAt;
}
