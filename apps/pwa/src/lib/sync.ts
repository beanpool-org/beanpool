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
const RECONNECT_INTERVAL = 5000;

let ws: WebSocket | null = null;
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
    try {
        ws = new WebSocket(wsUrl);
    } catch {
        currentState = { ...currentState, connected: false };
        notify();
        scheduleReconnect(originalUrl);
        return;
    }

    ws.onopen = () => {
        currentState = { ...currentState, connected: true };
        notify();
    };

    ws.onmessage = (event) => {
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

    ws.onclose = () => {
        currentState = { ...currentState, connected: false };
        notify();
        scheduleReconnect(originalUrl);
    };

    ws.onerror = () => {
        ws?.close();
    };
}

/**
 * Connect to the BeanPool node's WebSocket state feed.
 */
export function connectToAnchor(url?: string): void {
    const baseWsUrl = url ?? getNodeWsUrl('/ws');

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
        });
}

function scheduleReconnect(url: string): void {
    setTimeout(() => connectToAnchor(url), RECONNECT_INTERVAL);
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
