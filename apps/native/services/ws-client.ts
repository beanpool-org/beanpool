import AsyncStorage from '@react-native-async-storage/async-storage';
import { AppState, AppStateStatus, DeviceEventEmitter } from 'react-native';
import { requestSync } from './pillar-sync';
import { loadIdentity } from '../utils/identity';
import { buildSignedWsParams } from '../utils/crypto';
import { shouldBlockCleartextNodeUrl } from '../utils/node-url';

class WebSocketSyncClient {
    private ws: WebSocket | null = null;
    private currentUrl: string | null = null;
    private reconnectTimeoutId: any = null;
    private pingIntervalId: any = null;
    private reconnectDelay = 1000;
    private isStarted = false;
    private isConnecting = false; // Fixes the AsyncStorage race condition
    private appStateSubscription: any = null;

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
            let wsUrl = anchorUrl.replace(/^http/, 'ws');
            if (!wsUrl.endsWith('/ws')) {
                wsUrl = wsUrl.replace(/\/$/, '') + '/ws';
            }
            const params: string[] = [];
            if (identity && identity.callsign) {
                params.push(`callsign=${encodeURIComponent(identity.callsign)}`);
            }
            // Forward-compatible WS connect auth (SRV-4): additive signed params,
            // ignored by nodes that don't yet enforce WS auth. Lets the
            // unauthenticated /ws state feed be closed later without another release.
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

            console.log(`[WS Sync] Connecting to: ${wsUrl}`);

            // Scope the instance locally to capture it safely in closures
            const socket = new WebSocket(wsUrl);
            this.ws = socket;

            socket.onopen = () => {
                if (this.ws !== socket) return; // Stale socket guard
                console.log(`[WS Sync] ✅ Connected to WebSocket: ${wsUrl}`);
                this.reconnectDelay = 1000; 
                requestSync();

                // Start 30s heartbeat keep-alive to prevent reverse proxy/Cloudflare idle timeout drops
                if (this.pingIntervalId) clearInterval(this.pingIntervalId);
                this.pingIntervalId = setInterval(() => {
                    if (this.ws === socket && socket.readyState === WebSocket.OPEN) {
                        try {
                            socket.send(JSON.stringify({ type: 'ping' }));
                        } catch (err) {
                            console.warn('[WS Sync] Failed to send heartbeat', err);
                        }
                    }
                }, 30000);
            };

            socket.onmessage = (event) => {
                if (this.ws !== socket) return;
                try {
                    const data = JSON.parse(event.data);
                    console.log(`[WS Sync] 📥 Received broadcast message type: ${data.type}`);
                    
                    if (data.type !== 'state_snapshot') {
                        // Fast path: let any open screen (e.g. the active chat)
                        // do an immediate targeted refresh. The full reconciliation
                        // below still runs as the correctness backstop.
                        DeviceEventEmitter.emit('ws_activity', data);
                        requestSync();
                    }
                } catch (err) {
                    console.warn('[WS Sync] Failed to parse WebSocket message', err);
                }
            };

            socket.onclose = (e) => {
                if (this.ws === socket) {
                    console.log(`[WS Sync] WebSocket closed: code=${e.code}, reason=${e.reason}`);
                    this.ws = null;
                    if (this.pingIntervalId) {
                        clearInterval(this.pingIntervalId);
                        this.pingIntervalId = null;
                    }
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

    private disconnect() {
        if (this.reconnectTimeoutId) {
            clearTimeout(this.reconnectTimeoutId);
            this.reconnectTimeoutId = null;
        }

        if (this.pingIntervalId) {
            clearInterval(this.pingIntervalId);
            this.pingIntervalId = null;
        }
        
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

    private scheduleReconnect() {
        if (!this.isStarted || AppState.currentState !== 'active') return;
        if (this.reconnectTimeoutId) return;

        const jitter = Math.random() * 1000;
        const delay = this.reconnectDelay + jitter;
        console.log(`[WS Sync] Scheduling reconnect in ${(delay / 1000).toFixed(1)}s`);

        this.reconnectTimeoutId = setTimeout(() => {
            this.reconnectTimeoutId = null;
            this.reconnectDelay = Math.min(this.reconnectDelay * 2, 30000);
            this.connect();
        }, delay);
    }
}

const clientInstance = new WebSocketSyncClient();
export function startWebSocketSync() { clientInstance.start(); }
export function stopWebSocketSync() { clientInstance.stop(); }
