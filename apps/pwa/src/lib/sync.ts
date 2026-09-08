/**
 * Sync Library — WebSocket connection to the BeanPool Node
 *
 * Maintains a persistent connection to the Node's state feed.
 * Stores latest state in localStorage for offline read-only access.
 */

import { loadIdentity } from './identity';
import { buildSignedWsParams, getNodeWsUrl } from './api';

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
let activityListeners: (() => void)[] = [];
let currentState: SyncState = loadCachedState();

function loadCachedState(): SyncState {
    try {
        const cached = localStorage.getItem(STORAGE_KEY);
        if (cached) return JSON.parse(cached);
    } catch { /* ignore */ }
    return { connected: false, lastSyncTime: null, merkleRoot: null, accountCount: 0 };
}

function cacheState(state: SyncState): void {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
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

            // Doorbell: any non-snapshot broadcast means something changed.
            // Let open screens (e.g. the active chat) refresh immediately
            // instead of waiting for their polling interval.
            if (data.type !== 'state_snapshot') {
                activityListeners.forEach(cb => cb());
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
            if (!ws || ws.readyState === WebSocket.CLOSED) {
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
 * Subscribe to WebSocket "activity" — fires on every non-snapshot broadcast,
 * signalling that data changed and an open view should refresh now.
 */
export function onSyncActivity(cb: () => void): () => void {
    activityListeners.push(cb);
    return () => {
        activityListeners = activityListeners.filter(l => l !== cb);
    };
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
