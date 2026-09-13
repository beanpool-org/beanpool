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
    requestSync,
    getSyncCursor,
    saveSyncCursor,
    clearSyncCursor,
    computeUpdatedAfter,
    setPerformSyncImplForTest,
    resetCoordinatorForTest,
    registerSyncActivityListener,
    SYNC_CURSOR_KEY,
} from './sync-coordinator';
import {
    connectToAnchor,
    onSyncActivity,
    resetSyncForTest,
} from './sync';

describe('PWA Sync Coordinator', () => {
    let wsInstance: any = null;

    beforeEach(() => {
        vi.useFakeTimers();
        localStorage.clear();
        resetCoordinatorForTest();
        resetSyncForTest();
        vi.restoreAllMocks();

        wsInstance = null;
        class MockWebSocket {
            readyState = 0; // CONNECTING
            onopen: any = null;
            onmessage: any = null;
            onclose: any = null;
            onerror: any = null;
            send = vi.fn();
            close = vi.fn();

            constructor(public url: string) {
                // eslint-disable-next-line @typescript-eslint/no-this-alias
                wsInstance = this;
            }
        }
        (globalThis as any).WebSocket = MockWebSocket;
    });

    afterEach(() => {
        resetCoordinatorForTest();
        resetSyncForTest();
        vi.useRealTimers();
    });

    async function waitForWs(): Promise<any> {
        for (let i = 0; i < 20; i++) {
            if (wsInstance) return wsInstance;
            await Promise.resolve();
        }
        throw new Error('WebSocket instance not created in time');
    }

    describe('requestSync concurrency and debouncing', () => {
        it('concurrent calls collapse to one run', async () => {
            const runMock = vi.fn().mockResolvedValue(undefined);
            setPerformSyncImplForTest(runMock);

            // Three concurrent requests within the 150ms debounce window
            const p1 = requestSync();
            await vi.advanceTimersByTimeAsync(50);
            const p2 = requestSync();
            await vi.advanceTimersByTimeAsync(50);
            const p3 = requestSync();

            // At 100ms, debounce timer is still pending; runMock should not have run yet
            expect(runMock).not.toHaveBeenCalled();

            // Advance past the 150ms debounce threshold
            await vi.advanceTimersByTimeAsync(150);

            await Promise.all([p1, p2, p3]);

            // All concurrent calls collapse to exactly one run
            expect(runMock).toHaveBeenCalledTimes(1);
        });

        it('a request arriving mid-run queues exactly one trailing run', async () => {
            let resolveFirstRun!: () => void;
            const firstRunDeferred = new Promise<void>((resolve) => {
                resolveFirstRun = resolve;
            });

            const runMock = vi.fn()
                .mockImplementationOnce(() => firstRunDeferred)
                .mockImplementationOnce(() => Promise.resolve());

            setPerformSyncImplForTest(runMock);

            // Trigger initial sync
            const p1 = requestSync();
            await vi.advanceTimersByTimeAsync(150);
            expect(runMock).toHaveBeenCalledTimes(1);

            // While the first run is in-flight, two new sync requests arrive
            const p2 = requestSync();
            const p3 = requestSync();

            // First run finishes
            resolveFirstRun();
            await p1;

            // Still only the first run executed so far
            expect(runMock).toHaveBeenCalledTimes(1);

            // 2000ms cooldown delay before trailing sync executes
            await vi.advanceTimersByTimeAsync(1000);
            expect(runMock).toHaveBeenCalledTimes(1);

            // Advance through the remaining cooldown (1000ms) + trailing debounce (150ms)
            await vi.advanceTimersByTimeAsync(1000 + 150);

            await Promise.all([p2, p3]);

            // Exactly ONE trailing run executed (total 2 runs), collapsing p2 and p3
            expect(runMock).toHaveBeenCalledTimes(2);

            // Ensure no runaway loops: advance further and assert no more runs
            await vi.advanceTimersByTimeAsync(5000);
            expect(runMock).toHaveBeenCalledTimes(2);
        });

        it('notifies registered sync activity listeners during coordinated sync', async () => {
            const listener1 = vi.fn();
            const listener2 = vi.fn().mockResolvedValue(undefined);

            const unsub1 = registerSyncActivityListener(listener1);
            const unsub2 = onSyncActivity(listener2);

            const p = requestSync();
            await vi.advanceTimersByTimeAsync(150);
            await p;

            expect(listener1).toHaveBeenCalledTimes(1);
            expect(listener2).toHaveBeenCalledTimes(1);

            unsub1();
            unsub2();

            const p2 = requestSync();
            await vi.advanceTimersByTimeAsync(150);
            await p2;

            // Unsubscribed listeners should not be called again
            expect(listener1).toHaveBeenCalledTimes(1);
            expect(listener2).toHaveBeenCalledTimes(1);
        });
    });

    describe('Delta cursor', () => {
        it('the cursor round-trips and survives a localStorage throw', () => {
            const ts = 1700000000000;
            saveSyncCursor(ts);
            expect(getSyncCursor()).toBe(ts);

            clearSyncCursor();
            expect(getSyncCursor()).toBeNull();

            // Test 300s clock drift subtraction
            // 1700000000000 - 300_000 = 1699999700000
            const expectedIso = new Date(1700000000000 - 300_000).toISOString();
            expect(computeUpdatedAfter(ts)).toBe(expectedIso);

            // Fallback to full pull when cursor is null / zero / invalid
            expect(computeUpdatedAfter(null)).toBeNull();
            expect(computeUpdatedAfter(0)).toBeNull();
            expect(computeUpdatedAfter(-100)).toBeNull();
            expect(computeUpdatedAfter(NaN)).toBeNull();

            // Fallback to full pull when local row count is zero
            expect(computeUpdatedAfter(ts, 0)).toBeNull();
            expect(computeUpdatedAfter(ts, 5)).toBe(expectedIso);

            // Survives localStorage throw on read (private browsing, site data blocked)
            vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
                throw new Error('Access denied: private window');
            });
            expect(getSyncCursor()).toBeNull();

            // Survives localStorage throw on write (quota exceeded, blocked)
            vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
                throw new Error('QuotaExceededError');
            });
            expect(() => saveSyncCursor(Date.now())).not.toThrow();

            // Survives localStorage throw on remove
            vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(() => {
                throw new Error('Access denied');
            });
            expect(() => clearSyncCursor()).not.toThrow();
        });

        it('sync coordinator succeeds even when localStorage throws', async () => {
            vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
                throw new Error('SecurityError: Cookies disabled');
            });
            vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
                throw new Error('SecurityError: Cookies disabled');
            });

            const listener = vi.fn();
            registerSyncActivityListener(listener);

            const p = requestSync();
            await vi.advanceTimersByTimeAsync(150);
            await p;

            expect(listener).toHaveBeenCalledTimes(1);
        });
    });

    describe('WebSocket reconnection and scar preservation', () => {
        it('reconnect triggers a sync', async () => {
            const listener = vi.fn();
            onSyncActivity(listener);

            connectToAnchor('ws://localhost:9000/ws');
            const socket = await waitForWs();

            // Simulate socket onopen (reconnection event)
            socket.readyState = 1; // OPEN
            socket.onopen();

            // Debounce window (150ms)
            await vi.advanceTimersByTimeAsync(150);

            // Reconnect triggered the coordinator, which notified the doorbell listeners!
            expect(listener).toHaveBeenCalledTimes(1);
        });

        it('non-snapshot messages trigger coordinated sync', async () => {
            const listener = vi.fn();
            onSyncActivity(listener);

            connectToAnchor('ws://localhost:9000/ws');
            const socket = await waitForWs();
            socket.onopen();

            // Drain reconnect sync
            await vi.advanceTimersByTimeAsync(150);
            listener.mockClear();

            // Receive post_updated broadcast
            socket.onmessage({
                data: JSON.stringify({ type: 'post_updated', id: 'post_123' })
            });

            await vi.advanceTimersByTimeAsync(150);

            expect(listener).toHaveBeenCalledTimes(1);
        });

        // Native skips its requestSync() on new_message because THERE performSync is a heavy
        // multi-endpoint delta pull. The PWA coordinator's work is firing the listeners, which
        // on a new message is precisely what should run — MessagesPage subscribes to
        // onSyncActivity specifically so an open conversation refreshes on arrival instead of
        // waiting for its poll tick. So new_message MUST reach the listeners here.
        it('notifies listeners on new_message, so an open chat refreshes on arrival', async () => {
            const listener = vi.fn();
            onSyncActivity(listener);

            connectToAnchor('ws://localhost:9000/ws');
            const socket = await waitForWs();
            socket.onopen();
            await vi.advanceTimersByTimeAsync(150);
            listener.mockClear();

            socket.onmessage({
                data: JSON.stringify({ type: 'new_message', conversationId: 'conv_123', id: 'msg_1' })
            });

            await vi.advanceTimersByTimeAsync(500);

            expect(listener).toHaveBeenCalledTimes(1);
        });

        it('coalesces a burst of new_message broadcasts into one run', async () => {
            const listener = vi.fn();
            onSyncActivity(listener);

            connectToAnchor('ws://localhost:9000/ws');
            const socket = await waitForWs();
            socket.onopen();
            await vi.advanceTimersByTimeAsync(150);
            listener.mockClear();

            // Ten messages landing together must not mean ten refreshes — this is what the
            // coordinator replaces the old uncoordinated fan-out with.
            for (let i = 0; i < 10; i++) {
                socket.onmessage({
                    data: JSON.stringify({ type: 'new_message', conversationId: 'conv_123', id: `msg_${i}` })
                });
            }

            await vi.advanceTimersByTimeAsync(500);

            expect(listener).toHaveBeenCalledTimes(1);
        });

        it('ignores state_snapshot from triggering sync', async () => {
            const listener = vi.fn();
            onSyncActivity(listener);

            connectToAnchor('ws://localhost:9000/ws');
            const socket = await waitForWs();
            socket.onopen();
            await vi.advanceTimersByTimeAsync(150);
            listener.mockClear();

            // Receive state_snapshot
            socket.onmessage({
                data: JSON.stringify({ type: 'state_snapshot', merkleRoot: 'abc', accountCount: 10 })
            });

            await vi.advanceTimersByTimeAsync(500);

            expect(listener).not.toHaveBeenCalled();
        });
    });
});
