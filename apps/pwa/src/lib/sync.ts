/**
 * Sync Library — WebSocket connection to the BeanPool Node
 *
 * Maintains a persistent connection to the Node's state feed.
 * Stores latest state in localStorage for offline read-only access.
 */

import { loadIdentity } from './identity';
import { buildSignedWsParams, getNodeWsUrl } from './api';
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
let pingIntervalId: ReturnType<typeof setInterval> | null = null;
let reconnectDelay = 1000;
let isConnecting = false;
let currentUrl: string | null = null;

let listeners: SyncCallback[] = [];
let announcementListeners: ((a: any) => void)[] = [];
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
        reconnectDelay = 1000;
        if (reconnectTimeoutId) {
            clearTimeout(reconnectTimeoutId);
            reconnectTimeoutId = null;
        }
        currentState = { ...currentState, connected: true };
        notify();

        // Fix sync-on-reconnect: trigger coordinated sync immediately
        requestSync().catch(err => {
            console.warn('[WS Sync] Reconnect sync error:', err);
        });

        // Start 30s heartbeat keep-alive to prevent reverse proxy/Cloudflare idle timeout drops
        if (pingIntervalId) clearInterval(pingIntervalId);
        pingIntervalId = setInterval(() => {
            if (ws === socket && socket.readyState === WebSocket.OPEN) {
                try {
                    socket.send(JSON.stringify({ type: 'ping' }));
                } catch (err) {
                    console.warn('[WS Sync] Failed to send heartbeat', err);
                }
            }
        }, 30000);
    };

    socket.onmessage = (event) => {
        if (ws !== socket) return;
        try {
            const data = JSON.parse(event.data);
            
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
            if (data.type !== 'state_snapshot') {
                requestSync().catch(err => {
                    console.warn('[WS Sync] Broadcast sync error:', err);
                });
            }
        } catch { /* ignore malformed messages */ }
    };

    socket.onclose = () => {
        if (ws === socket) {
            ws = null;
            if (pingIntervalId) {
                clearInterval(pingIntervalId);
                pingIntervalId = null;
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

    const baseWsUrl = url ?? getNodeWsUrl('/ws');
    currentUrl = baseWsUrl;

    loadIdentity()
        .then(async (ident) => {
            const params: string[] = [];
            if (ident && ident.callsign) {
                params.push(`callsign=${encodeURIComponent(ident.callsign)}`);
            }
            // Forward-compatible WS connect auth (SRV-4): additive signed params,
            // ignored by nodes that don't yet enforce WS auth.
            try {
                const signed = await buildSignedWsParams('/ws');
                if (signed) params.push(signed);
            } catch { /* unsigned fallback */ }
            const wsUrl = params.length ? `${baseWsUrl}?${params.join('&')}` : baseWsUrl;
            establishConnection(wsUrl, baseWsUrl);
        })
        .catch(() => {
            establishConnection(baseWsUrl, baseWsUrl);
        })
        .finally(() => {
            isConnecting = false;
        });
}

function scheduleReconnect(url: string): void {
    if (reconnectTimeoutId) return;

    const jitter = Math.random() * 1000;
    const delay = reconnectDelay + jitter;

    reconnectTimeoutId = setTimeout(() => {
        reconnectTimeoutId = null;
        reconnectDelay = Math.min(reconnectDelay * 2, 30000);
        connectToAnchor(url);
    }, delay);
}

// Page visibility listener — reconnects immediately when tab returns to foreground
if (typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') {
            const isDead = !ws || ws.readyState === WebSocket.CLOSED || ws.readyState === WebSocket.CLOSING;
            if (isDead) {
                if (ws) {
                    try { ws.close(); } catch {}
                    ws = null;
                }
                if (reconnectTimeoutId) {
                    clearTimeout(reconnectTimeoutId);
                    reconnectTimeoutId = null;
                }
                reconnectDelay = 1000;
                connectToAnchor(currentUrl ?? undefined);
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
    if (pingIntervalId) {
        clearInterval(pingIntervalId);
        pingIntervalId = null;
    }
    reconnectDelay = 1000;
    isConnecting = false;
    currentUrl = null;
    listeners = [];
    announcementListeners = [];
    currentState = { connected: false, lastSyncTime: null, merkleRoot: null, accountCount: 0 };
}
