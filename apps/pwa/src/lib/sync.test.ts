import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('./identity', () => ({
    loadIdentity: vi.fn(async () => null),
}));

vi.mock('./api', async (importOriginal) => {
    const actual = await importOriginal<typeof import('./api')>();
    return {
        ...actual,
        buildSignedWsParams: vi.fn(async () => ''),
    };
});

import {
    connectToAnchor,
    onSyncActivity,
    onSyncChange,
    resetSyncForTest,
    getWatchdogArmedForTest,
    PONG_TIMEOUT_MS,
    HEARTBEAT_INTERVAL_MS,
} from './sync';
import { resetCoordinatorForTest } from './sync-coordinator';

describe('PWA WebSocket Pong Watchdog', () => {
    let wsInstance: any = null;

    beforeEach(() => {
        vi.useFakeTimers();
        localStorage.clear();
        resetCoordinatorForTest();
        resetSyncForTest();
        vi.restoreAllMocks();

        wsInstance = null;
        class MockWebSocket {
            static OPEN = 1;
            static CLOSED = 3;
            readyState = 0; // CONNECTING
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
            }
        }
        (globalThis as any).WebSocket = MockWebSocket;
        if (typeof document !== 'undefined') {
            Object.defineProperty(document, 'hidden', { value: false, configurable: true });
            Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
        }
    });

    afterEach(() => {
        resetSyncForTest();
        vi.useRealTimers();
    });

    async function waitForWs(): Promise<any> {
        for (let i = 0; i < 50; i++) {
            if (wsInstance) return wsInstance;
            await vi.advanceTimersByTimeAsync(10);
        }
        throw new Error('WebSocket was never instantiated');
    }

    it('sends opt-in ping with { type: "ping", wantPong: true } on open and on interval', async () => {
        connectToAnchor('ws://localhost:9000/ws');
        const socket = await waitForWs();

        socket.readyState = 1; // OPEN
        socket.onopen();

        // Immediate ping on open
        expect(socket.send).toHaveBeenCalledWith(JSON.stringify({ type: 'ping', wantPong: true }));

        // Advance one heartbeat interval (30s)
        await vi.advanceTimersByTimeAsync(HEARTBEAT_INTERVAL_MS);
        expect(socket.send).toHaveBeenCalledTimes(2);
        expect(socket.send).toHaveBeenLastCalledWith(JSON.stringify({ type: 'ping', wantPong: true }));
    });

    it('a server that never pongs never arms the watchdog', async () => {
        connectToAnchor('ws://localhost:9000/ws');
        const socket = await waitForWs();
        socket.readyState = 1;
        socket.onopen();

        // Simulate server sending snapshot (standard server behavior on connect)
        socket.onmessage({
            data: JSON.stringify({ type: 'state_snapshot', memberCount: 5, postCount: 2, commonsBalance: 100 })
        });

        expect(getWatchdogArmedForTest()).toBe(false);

        // Advance through multiple ping cycles past PONG_TIMEOUT_MS (e.g. 150s)
        await vi.advanceTimersByTimeAsync(150_000);

        // Watchdog was never armed against un-upgraded node, so socket remains OPEN
        expect(getWatchdogArmedForTest()).toBe(false);
        expect(socket.close).not.toHaveBeenCalled();
    });

    it('a pong keeps the socket alive', async () => {
        connectToAnchor('ws://localhost:9000/ws');
        const socket = await waitForWs();
        socket.readyState = 1;
        socket.onopen();

        // First pong arms the watchdog
        socket.onmessage({ data: JSON.stringify({ type: 'pong' }) });
        expect(getWatchdogArmedForTest()).toBe(true);

        // Advance through several 30s cycles with returning pongs
        for (let cycle = 0; cycle < 5; cycle++) {
            await vi.advanceTimersByTimeAsync(30_000);
            socket.onmessage({ data: JSON.stringify({ type: 'pong' }) });
            expect(socket.close).not.toHaveBeenCalled();
        }

        expect(socket.close).not.toHaveBeenCalled();
    });

    it('silence past the timeout closes and reconnects', async () => {
        connectToAnchor('ws://localhost:9000/ws');
        const socket = await waitForWs();
        socket.readyState = 1;
        socket.onopen();

        // First pong arms watchdog
        socket.onmessage({ data: JSON.stringify({ type: 'pong' }) });
        expect(getWatchdogArmedForTest()).toBe(true);

        // Advance 30s (ping 2 sent, no pong returns)
        await vi.advanceTimersByTimeAsync(30_000);
        expect(socket.close).not.toHaveBeenCalled();

        // Advance another 30s (t=60s: ping 3 sent, no pong returns)
        await vi.advanceTimersByTimeAsync(30_000);
        expect(socket.close).not.toHaveBeenCalled();

        // Advance remaining 15s to hit PONG_TIMEOUT_MS (75s from last pong)
        await vi.advanceTimersByTimeAsync(15_000);

        // Watchdog timeout fired and closed the silently dead socket
        expect(socket.close).toHaveBeenCalledTimes(1);
    });

    it('pong does not trigger a sync or notify activity listeners', async () => {
        const activityListener = vi.fn();
        onSyncActivity(activityListener);

        connectToAnchor('ws://localhost:9000/ws');
        const socket = await waitForWs();
        socket.readyState = 1;
        socket.onopen();

        // Drain initial reconnect sync
        await vi.advanceTimersByTimeAsync(150);
        activityListener.mockClear();

        // Server responds with pong
        socket.onmessage({ data: JSON.stringify({ type: 'pong' }) });
        await vi.advanceTimersByTimeAsync(200);

        // Pong was excluded from the doorbell — zero sync runs triggered
        expect(activityListener).not.toHaveBeenCalled();

        // Contrast with a real state event which DOES trigger doorbell
        socket.onmessage({ data: JSON.stringify({ type: 'new_post', id: 'p1' }) });
        await vi.advanceTimersByTimeAsync(200);
        expect(activityListener).toHaveBeenCalledTimes(1);
    });

    it('a hidden tab does not false-positive on return', async () => {
        connectToAnchor('ws://localhost:9000/ws');
        const socket = await waitForWs();
        socket.readyState = 1;
        socket.onopen();

        // Arm watchdog with pong
        socket.onmessage({ data: JSON.stringify({ type: 'pong' }) });
        expect(getWatchdogArmedForTest()).toBe(true);
        socket.send.mockClear();

        // Tab is hidden
        Object.defineProperty(document, 'hidden', { value: true, configurable: true });
        Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
        document.dispatchEvent(new Event('visibilitychange'));

        // Advance 5 minutes while hidden
        await vi.advanceTimersByTimeAsync(300_000);

        // Ping loop was stopped while hidden, watchdog timer was stopped, socket was NOT closed
        expect(socket.close).not.toHaveBeenCalled();
        expect(socket.send).not.toHaveBeenCalled();

        // Tab returns to visible
        Object.defineProperty(document, 'hidden', { value: false, configurable: true });
        Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
        document.dispatchEvent(new Event('visibilitychange'));

        // Immediate ping sent to verify connection
        expect(socket.send).toHaveBeenCalledWith(JSON.stringify({ type: 'ping', wantPong: true }));

        // Server responds with pong promptly
        socket.onmessage({ data: JSON.stringify({ type: 'pong' }) });

        // Advance 30s
        await vi.advanceTimersByTimeAsync(30_000);

        // No false positive happened!
        expect(socket.close).not.toHaveBeenCalled();
    });

    it('a socket silently dead while hidden is detected on return after timeout', async () => {
        connectToAnchor('ws://localhost:9000/ws');
        const socket = await waitForWs();
        socket.readyState = 1;
        socket.onopen();

        // Arm watchdog with pong
        socket.onmessage({ data: JSON.stringify({ type: 'pong' }) });

        // Tab is hidden for 10 minutes
        Object.defineProperty(document, 'hidden', { value: true, configurable: true });
        Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
        document.dispatchEvent(new Event('visibilitychange'));
        await vi.advanceTimersByTimeAsync(600_000);

        // Tab returns to visible, but network died silently while asleep
        Object.defineProperty(document, 'hidden', { value: false, configurable: true });
        Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
        document.dispatchEvent(new Event('visibilitychange'));

        // Advance 74s (no pong received)
        await vi.advanceTimersByTimeAsync(74_000);
        expect(socket.close).not.toHaveBeenCalled();

        // Advance past 75s timeout
        await vi.advanceTimersByTimeAsync(2_000);

        // Dead socket is closed and reconnected
        expect(socket.close).toHaveBeenCalledTimes(1);
    });
});
