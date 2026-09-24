import AsyncStorage from '@react-native-async-storage/async-storage';
import { AppState, AppStateStatus, DeviceEventEmitter, NativeEventSubscription } from 'react-native';
import { livePostChange, reconnectDelayMs, reconnectSyncDelayMs, type LivePostChange } from '@beanpool/core';
import { requestSync, applyLivePostChange } from './pillar-sync';
import { loadIdentity } from '../utils/identity';
import { buildSignedWsParams } from '../utils/crypto';
import { shouldBlockCleartextNodeUrl } from '../utils/node-url';

class WebSocketSyncClient {
    private ws: WebSocket | null = null;
    private currentUrl: string | null = null;
    private reconnectTimeoutId: ReturnType<typeof setTimeout> | null = null;
    private pingIntervalId: ReturnType<typeof setInterval> | null = null;
    /** Retries since the socket last opened; sizes the full-jitter window (@beanpool/core reconnectDelayMs). */
    private reconnectAttempt = 0;
    /** True while the connection being made is a retry after a drop, not a start or a foreground. */
    private isRetry = false;
    private reconnectSyncTimeoutId: ReturnType<typeof setTimeout> | null = null;
    /** The member this socket signed in as, so a pushed change about their own listing takes the full sync. */
    private memberPubkey: string | null = null;
    /** Pushed listing changes are written one at a time, in the order the node sent them. */
    private liveQueue: Promise<void> = Promise.resolve();
    private dataUpdatedTimeoutId: ReturnType<typeof setTimeout> | null = null;
    /** The window a burst of pushed changes shares one screen re-read in — the one requestSync coalesces in. */
    public static readonly DATA_UPDATED_COALESCE_MS = 150;
    private isStarted = false;
    private isConnecting = false; // Fixes the AsyncStorage race condition
    private appStateSubscription: NativeEventSubscription | null = null;

    public static readonly PING_INTERVAL_MS = 30_000;
    /**
     * Pong watchdog timeout (75s = 2.5x ping interval).
     * Allows 2 consecutive missed pings plus a 15-second grace period for mobile RTT/retransmission.
     * Tighter (e.g. 30-45s) risks false disconnects on temporary packet loss / cell handover;
     * looser (>90s) leaves clients sitting on stale data too long.
     */
    public static readonly PONG_TIMEOUT_MS = 75_000;

    private lastPongAt: number | null = null;
    private watchdogArmed = false;
    private watchdogTimeoutId: ReturnType<typeof setTimeout> | null = null;

    public start() {
        if (this.isStarted) return;
        this.isStarted = true;
        this.setupAppStateListener();
        this.connect();
    }

    public stop() {
        this.isStarted = false;
        this.disconnect();
        this.clearAppStateListener();
    }

    private setupAppStateListener() {
        this.clearAppStateListener();
        this.appStateSubscription = AppState.addEventListener('change', this.handleAppStateChange);
    }

    private clearAppStateListener() {
        if (this.appStateSubscription) {
            this.appStateSubscription.remove();
            this.appStateSubscription = null;
        }
    }

    private handleAppStateChange = (nextAppState: AppStateStatus) => {
        if (nextAppState === 'active') {
            console.log('[WS Sync] App foregrounded. Reconnecting WebSocket...');
            // One person bringing the app to the front: reconnect and sync at once, and start any later
            // backoff from the first window again.
            this.reconnectAttempt = 0;
            this.isRetry = false;
            this.connect();
        } else {
            console.log('[WS Sync] App backgrounded. Closing WebSocket...');
            this.disconnect();
        }
    };

    private async connect() {
        // Guard against execution if stopped, backgrounded, or already resolving a connection
        if (!this.isStarted || AppState.currentState !== 'active' || this.isConnecting) return;
        if (this.ws) return; 

        this.isConnecting = true;

        try {
            const anchorUrl = await AsyncStorage.getItem('beanpool_anchor_url');
            
            // Re-verify guards after async storage I/O completes
            if (!this.isStarted || AppState.currentState !== 'active') {
                this.isConnecting = false;
                return;
            }

            if (!anchorUrl) {
                console.log('[WS Sync] No active anchor URL found. Cannot connect.');
                this.isConnecting = false;
                return;
            }

            let identity = null;
            try {
                identity = await loadIdentity();
            } catch (err) {
                console.warn('[WS Sync] Failed to load identity', err);
            }

            this.currentUrl = anchorUrl;
            this.memberPubkey = identity?.publicKey ?? null;
            let wsUrl = anchorUrl.replace(/^http/, 'ws');
            if (!wsUrl.endsWith('/ws')) {
                wsUrl = wsUrl.replace(/\/$/, '') + '/ws';
            }
            const params: string[] = [];
            if (identity && identity.callsign) {
                params.push(`callsign=${encodeURIComponent(identity.callsign)}`);
            }
            // WS connect auth (SRV-4): a member-signed socket gets the full feed; an
            // unsigned one gets only public doorbells (and is refused under
            // ENFORCE_WS_AUTH=true). Sent by every build since v1.1.56.
            if (identity && identity.privateKey && identity.publicKey) {
                try {
                    params.push(await buildSignedWsParams('/ws', identity.privateKey, identity.publicKey));
                } catch (err) {
                    console.warn('[WS Sync] Failed to sign WS connect', err);
                }
            }
            if (params.length) {
                wsUrl += `?${params.join('&')}`;
            }

            // NAT-4: never open a cleartext (ws://) feed to a PUBLIC node — it would
            // be MITM-exposed. LAN/private hosts stay cleartext (sync still works).
            if (shouldBlockCleartextNodeUrl(wsUrl)) {
                console.warn('[WS Sync] Refusing cleartext WebSocket to a public host (NAT-4); use wss/https.');
                this.isConnecting = false;
                return;
            }

            // Re-checked AFTER the awaits above. Loading the identity and signing the WS params
            // are async, so the app can be backgrounded midway: handleAppStateChange calls
            // disconnect(), then this continues and opens a socket anyway. onopen would then skip
            // startHeartbeat() because the app is backgrounded, and on returning to foreground
            // connect() early-returns on `this.ws` already being set — leaving a live socket that
            // never pings and never arms the watchdog, which is the opposite of this PR's point.
            if (!this.isStarted || AppState.currentState !== 'active') {
                console.log('[WS Sync] Backgrounded during connection setup — abandoning connect');
                return;
            }

            console.log(`[WS Sync] Connecting to: ${wsUrl.split('?')[0]}`);

            // Scope the instance locally to capture it safely in closures
            const socket = new WebSocket(wsUrl);
            this.ws = socket;

            socket.onopen = () => {
                if (this.ws !== socket) return; // Stale socket guard
                console.log(`[WS Sync] ✅ Connected to WebSocket: ${wsUrl.split('?')[0]}`);
                this.reconnectAttempt = 0;
                this.watchdogArmed = false;
                this.lastPongAt = null;
                if (this.watchdogTimeoutId) {
                    clearTimeout(this.watchdogTimeoutId);
                    this.watchdogTimeoutId = null;
                }
                // The catch-up sync for whatever was missed while the socket was down. After a drop it waits a
                // random 0–3 s: a node or edge restart drops every phone at once, and their retries are spread,
                // but not so far that their syncs would not still land together. A start or a foreground syncs
                // at once.
                if (this.isRetry) {
                    this.isRetry = false;
                    if (this.reconnectSyncTimeoutId) clearTimeout(this.reconnectSyncTimeoutId);
                    this.reconnectSyncTimeoutId = setTimeout(() => {
                        this.reconnectSyncTimeoutId = null;
                        requestSync();
                    }, reconnectSyncDelayMs());
                } else {
                    requestSync();
                }

                // Start 30s heartbeat keep-alive with opt-in pong
                this.startHeartbeat(socket);
            };

            socket.onmessage = (event) => {
                if (this.ws !== socket) return;
                try {
                    const data = JSON.parse(event.data);

                    // Trap 1: Exclude pong from the doorbell so watchdog's own keepalive
                    // does not drive a sync every 30s.
                    if (data.type === 'pong') {
                        this.handlePong(socket);
                        return;
                    }

                    console.log(`[WS Sync] 📥 Received broadcast message type: ${data.type}`);

                    if (data.type !== 'state_snapshot') {
                        // A public offer or need the node sent whole: write it into the cache instead of
                        // sending this phone back to the node for everything (see applyLivePostChange).
                        const change = livePostChange(data);
                        if (change) this.applyLive(data, change);
                        else this.ringDoorbell(data);
                    }
                } catch (err) {
                    console.warn('[WS Sync] Failed to parse WebSocket message', err);
                }
            };

            socket.onclose = (e) => {
                if (this.ws === socket) {
                    console.log(`[WS Sync] WebSocket closed: code=${e.code}, reason=${e.reason}`);
                    this.ws = null;
                    this.stopHeartbeat();
                    this.watchdogArmed = false;
                    this.lastPongAt = null;
                    this.scheduleReconnect();
                }
            };

            socket.onerror = (e) => {
                if (this.ws !== socket) return;
                console.warn('[WS Sync] WebSocket error occurred', e);
            };

        } catch (error) {
            console.error('[WS Sync] Critical error during connection setup:', error);
            this.scheduleReconnect();
        } finally {
            this.isConnecting = false;
        }
    }

    /**
     * The doorbell: something changed that this phone must fetch. Any open screen (e.g. the active chat) gets
     * `ws_activity` for an immediate targeted refresh; the full reconciliation runs as the correctness backstop.
     */
    private ringDoorbell(data: any) {
        DeviceEventEmitter.emit('ws_activity', data);
        // new_message is chat-plane traffic — the open chat's targeted
        // sync and the unread-badge listener both react to ws_activity.
        // Running a full pillar sync per received message hammered the
        // node and kept applyDelta churning the sync lock.
        if (data.type !== 'new_message') requestSync();
    }

    /**
     * Write a pushed listing change, then tell the market, map and post screens to re-read the cache — the same
     * signal a sync that changed posts sends, once per burst. No `ws_activity`: its listeners are chats, unread counts and the
     * needs-you row, each of which goes to the node, and a listing that does not involve this member is none of
     * theirs. A change that does involve them, or that fails to write, rings the doorbell exactly as before.
     */
    private applyLive(data: any, change: LivePostChange) {
        const ctx = { anchorUrl: this.currentUrl, selfPubkey: this.memberPubkey };
        this.liveQueue = this.liveQueue.then(async () => {
            let applied = false;
            try {
                applied = await applyLivePostChange(change, ctx);
            } catch (err) {
                console.warn('[WS Sync] Could not write a pushed listing change; syncing instead', err);
            }
            if (applied) this.signalDataUpdated();
            else this.ringDoorbell(data);
        });
    }

    /** One `sync_data_updated` for a burst of pushed changes: the market and map re-query SQLite on each one. */
    private signalDataUpdated() {
        if (this.dataUpdatedTimeoutId) return;
        this.dataUpdatedTimeoutId = setTimeout(() => {
            this.dataUpdatedTimeoutId = null;
            DeviceEventEmitter.emit('sync_data_updated');
        }, WebSocketSyncClient.DATA_UPDATED_COALESCE_MS);
    }

    private disconnect() {
        if (this.reconnectTimeoutId) {
            clearTimeout(this.reconnectTimeoutId);
            this.reconnectTimeoutId = null;
        }
        if (this.reconnectSyncTimeoutId) {
            clearTimeout(this.reconnectSyncTimeoutId);
            this.reconnectSyncTimeoutId = null;
        }
        this.isRetry = false;

        this.stopHeartbeat();
        this.watchdogArmed = false;
        this.lastPongAt = null;
        
        if (this.ws) {
            const socket = this.ws;
            this.ws = null; // Unbind immediately to avoid handling the imminent close event
            
            try {
                // Keep listeners attached briefly during termination 
                // so the native layer cleanly deallocates
                socket.close();
            } catch (err) {
                console.warn('[WS Sync] Error while closing socket natively:', err);
            }
        }
        this.currentUrl = null;
    }

    private sendPing(socket: WebSocket) {
        if (this.ws === socket && socket.readyState === WebSocket.OPEN) {
            try {
                socket.send(JSON.stringify({ type: 'ping', wantPong: true }));
            } catch (err) {
                console.warn('[WS Sync] Failed to send heartbeat', err);
            }
        }
    }

    private handlePong(socket: WebSocket) {
        if (this.ws !== socket) return;
        this.lastPongAt = Date.now();
        // Trap 2: Only arms after seeing at least one pong on this connection
        this.watchdogArmed = true;
        this.resetWatchdogTimer(socket);
    }

    private resetWatchdogTimer(socket: WebSocket) {
        if (this.watchdogTimeoutId) {
            clearTimeout(this.watchdogTimeoutId);
            this.watchdogTimeoutId = null;
        }
        if (!this.watchdogArmed || AppState.currentState !== 'active') return;

        this.watchdogTimeoutId = setTimeout(() => {
            if (this.ws === socket && socket.readyState === WebSocket.OPEN) {
                console.warn('[WS Sync] Watchdog timeout: no pong received within limit. Closing dead socket.');
                try { socket.close(); } catch {}
            }
        }, WebSocketSyncClient.PONG_TIMEOUT_MS);
    }

    private stopHeartbeat() {
        if (this.pingIntervalId) {
            clearInterval(this.pingIntervalId);
            this.pingIntervalId = null;
        }
        if (this.watchdogTimeoutId) {
            clearTimeout(this.watchdogTimeoutId);
            this.watchdogTimeoutId = null;
        }
    }

    private startHeartbeat(socket: WebSocket) {
        this.stopHeartbeat();
        if (AppState.currentState !== 'active') return;

        this.sendPing(socket);
        this.pingIntervalId = setInterval(() => {
            this.sendPing(socket);
        }, WebSocketSyncClient.PING_INTERVAL_MS);

        if (this.watchdogArmed) {
            this.resetWatchdogTimer(socket);
        }
    }

    public getWatchdogArmedForTest(): boolean {
        return this.watchdogArmed;
    }

    public getLastPongAtForTest(): number | null {
        return this.lastPongAt;
    }

    private scheduleReconnect() {
        if (!this.isStarted || AppState.currentState !== 'active') return;
        if (this.reconnectTimeoutId) return;

        // Full jitter over a window that starts at 5 s and grows to 30 s. When Cloudflare restarts an edge server,
        // every phone on it drops at once; 1 s plus up to 1 s of jitter brought them all back inside two seconds.
        const delay = reconnectDelayMs(this.reconnectAttempt);
        console.log(`[WS Sync] Scheduling reconnect in ${(delay / 1000).toFixed(1)}s`);

        this.reconnectTimeoutId = setTimeout(() => {
            this.reconnectTimeoutId = null;
            this.reconnectAttempt++;
            this.isRetry = true;
            this.connect();
        }, delay);
    }
}

const clientInstance = new WebSocketSyncClient();
export function startWebSocketSync() { clientInstance.start(); }
export function stopWebSocketSync() { clientInstance.stop(); }
export { WebSocketSyncClient };
