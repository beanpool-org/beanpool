import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { AppState, DeviceEventEmitter } from 'react-native';
import { requestSync } from '../../services/pillar-sync';
import { WebSocketSyncClient } from '../../services/ws-client';

vi.mock('@react-native-async-storage/async-storage', () => ({
    default: {
        getItem: vi.fn(),
        setItem: vi.fn(),
        removeItem: vi.fn(),
    },
}));

const mockAppStateListeners: ((state: string) => void)[] = [];
vi.mock('react-native', () => ({
    AppState: {
        currentState: 'active',
        addEventListener: vi.fn((event: string, cb: (state: string) => void) => {
            mockAppStateListeners.push(cb);
            return {
                remove: vi.fn(() => {
                    const idx = mockAppStateListeners.indexOf(cb);
                    if (idx >= 0) mockAppStateListeners.splice(idx, 1);
                }),
            };
        }),
    },
    DeviceEventEmitter: {
        emit: vi.fn(),
    },
}));

vi.mock('../../services/pillar-sync', () => ({
    requestSync: vi.fn(),
}));

vi.mock('../identity', () => ({
    loadIdentity: vi.fn().mockResolvedValue(null),
}));

vi.mock('../crypto', () => ({
    buildSignedWsParams: vi.fn().mockResolvedValue(''),
}));

vi.mock('../node-url', () => ({
    shouldBlockCleartextNodeUrl: vi.fn().mockReturnValue(false),
}));

describe('Native WebSocket Pong Watchdog (WebSocketSyncClient)', () => {
    let wsInstance: any = null;
    let client: WebSocketSyncClient;

    beforeEach(() => {
        vi.useFakeTimers();
        vi.clearAllMocks();
        mockAppStateListeners.length = 0;
        (AppState as any).currentState = 'active';

        vi.mocked(AsyncStorage.getItem).mockImplementation(async (key: string) => {
            if (key === 'beanpool_anchor_url') return 'https://testnode.beanpool.org';
            return null;
        });

        wsInstance = null;
        class MockWebSocket {
            static OPEN = 1;
            static CLOSED = 3;
            readyState = MockWebSocket.OPEN;
            onopen: any = null;
            onmessage: any = null;
            onclose: any = null;
            onerror: any = null;
            send = vi.fn();
            close = vi.fn().mockImplementation(() => {
                this.readyState = MockWebSocket.CLOSED;
                if (this.onclose) this.onclose({ code: 1006, reason: 'Watchdog timeout' });
            });

            constructor(public url: string) {
                // eslint-disable-next-line @typescript-eslint/no-this-alias
                wsInstance = this;
                setTimeout(() => {
                    if (this.onopen) this.onopen();
                }, 0);
            }
        }
        (global as any).WebSocket = MockWebSocket;

        client = new WebSocketSyncClient();
    });

    afterEach(() => {
        client.stop();
        vi.useRealTimers();
    });

    async function startAndConnect(): Promise<any> {
        client.start();
        // Allow connect() async storage read and socket instantiation
        await vi.advanceTimersByTimeAsync(10);
        return wsInstance;
    }

    it('sends opt-in ping with { type: "ping", wantPong: true } on open and interval', async () => {
        const socket = await startAndConnect();
        expect(socket).not.toBeNull();

        // Initial ping sent on connect
        expect(socket.send).toHaveBeenCalledWith(JSON.stringify({ type: 'ping', wantPong: true }));

        // Advance 30s
        await vi.advanceTimersByTimeAsync(WebSocketSyncClient.PING_INTERVAL_MS);
        expect(socket.send).toHaveBeenCalledTimes(2);
        expect(socket.send).toHaveBeenLastCalledWith(JSON.stringify({ type: 'ping', wantPong: true }));
    });

    it('a server that never pongs never arms the watchdog', async () => {
        const socket = await startAndConnect();

        // Server sends snapshot
        socket.onmessage({
            data: JSON.stringify({ type: 'state_snapshot', memberCount: 1, postCount: 0 })
        });

        expect(client.getWatchdogArmedForTest()).toBe(false);

        // Advance through multiple intervals past 75s (e.g. 150s)
        await vi.advanceTimersByTimeAsync(150_000);

        // Watchdog was never armed against un-upgraded node, so socket remains OPEN
        expect(client.getWatchdogArmedForTest()).toBe(false);
        expect(socket.close).not.toHaveBeenCalled();
    });

    it('a pong keeps the socket alive', async () => {
        const socket = await startAndConnect();

        // First pong arms watchdog
        socket.onmessage({ data: JSON.stringify({ type: 'pong' }) });
        expect(client.getWatchdogArmedForTest()).toBe(true);

        // Advance through 5 cycles of 30s with returning pongs
        for (let i = 0; i < 5; i++) {
            await vi.advanceTimersByTimeAsync(30_000);
            socket.onmessage({ data: JSON.stringify({ type: 'pong' }) });
            expect(socket.close).not.toHaveBeenCalled();
        }

        expect(socket.close).not.toHaveBeenCalled();
    });

    it('silence past the timeout closes and reconnects', async () => {
        const socket = await startAndConnect();

        // First pong arms watchdog
        socket.onmessage({ data: JSON.stringify({ type: 'pong' }) });
        expect(client.getWatchdogArmedForTest()).toBe(true);

        // Advance 30s (ping sent, dropped)
        await vi.advanceTimersByTimeAsync(30_000);
        expect(socket.close).not.toHaveBeenCalled();

        // Advance another 30s (ping sent, dropped)
        await vi.advanceTimersByTimeAsync(30_000);
        expect(socket.close).not.toHaveBeenCalled();

        // Advance 15s to hit 75s watchdog timeout
        await vi.advanceTimersByTimeAsync(15_000);

        // Watchdog timeout fired and closed dead socket
        expect(socket.close).toHaveBeenCalledTimes(1);
    });

    it('pong does not trigger a sync or emit ws_activity', async () => {
        const socket = await startAndConnect();
        vi.mocked(requestSync).mockClear();
        vi.mocked(DeviceEventEmitter.emit).mockClear();

        // Server responds with pong
        socket.onmessage({ data: JSON.stringify({ type: 'pong' }) });
        await vi.advanceTimersByTimeAsync(50);

        // Excluded from doorbell
        expect(requestSync).not.toHaveBeenCalled();
        expect(DeviceEventEmitter.emit).not.toHaveBeenCalled();

        // Contrast with real broadcast event
        socket.onmessage({ data: JSON.stringify({ type: 'new_post', id: 'post_1' }) });
        expect(DeviceEventEmitter.emit).toHaveBeenCalledWith('ws_activity', { type: 'new_post', id: 'post_1' });
        expect(requestSync).toHaveBeenCalled();
    });

    it('backgrounding the app disconnects and clears watchdog', async () => {
        const socket = await startAndConnect();
        socket.onmessage({ data: JSON.stringify({ type: 'pong' }) });
        expect(client.getWatchdogArmedForTest()).toBe(true);

        // Background the app
        (AppState as any).currentState = 'background';
        mockAppStateListeners.forEach(listener => listener('background'));

        // Socket was disconnected cleanly
        expect(socket.close).toHaveBeenCalled();
        expect(client.getWatchdogArmedForTest()).toBe(false);

        // Advancing time does not trigger any stale watchdog errors
        await vi.advanceTimersByTimeAsync(100_000);
    });
});
