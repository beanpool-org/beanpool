import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { AppState, DeviceEventEmitter } from 'react-native';
import { requestSync, applyLivePostChange } from '../../services/pillar-sync';
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
    applyLivePostChange: vi.fn().mockResolvedValue(true),
}));

const ME = 'e'.repeat(64);
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
    // False stands in for a node that is down: new sockets never open.
    let autoOpen = true;

    beforeEach(() => {
        vi.useFakeTimers();
        vi.clearAllMocks();
        mockAppStateListeners.length = 0;
        (AppState as any).currentState = 'active';
        autoOpen = true;

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
                if (!autoOpen) return;
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
        if (vi.isMockFunction(Math.random)) vi.mocked(Math.random).mockRestore();
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

    // A member who is not a party to a trade gets its board-changing steps as a bare { type } (the server
    // scopes the payload to the two parties). Every ws_activity listener acts on the type alone, so the
    // doorbell refreshes exactly as the full event did.
    it.each(['post_accepted', 'transaction_completed', 'transaction_cancelled', 'dispute_resolved'])(
        'a bare %s doorbell (no payload) still syncs and nudges the open screens', async (type) => {
            const socket = await startAndConnect();
            vi.mocked(requestSync).mockClear();
            vi.mocked(DeviceEventEmitter.emit).mockClear();

            socket.onmessage({ data: JSON.stringify({ type }) });
            expect(DeviceEventEmitter.emit).toHaveBeenCalledWith('ws_activity', { type });
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

    // ── Live updates: apply the change the node already sent, instead of re-fetching everything ──────────

    const publicOffer = (extra: Record<string, unknown> = {}) => ({
        id: 'post-1', type: 'offer', category: 'food', title: 'Spare lemons', description: 'A bag', credits: 5,
        authorPublicKey: 'a'.repeat(64), authorCallsign: 'Ann', createdAt: '2026-09-24T01:00:00.000Z',
        updatedAt: '2026-09-24T01:00:00.000Z', active: true, status: 'active', audienceScope: 'public', ...extra,
    });

    it('a new_post carrying a public offer is written locally and does NOT run the catch-up sync', async () => {
        const { loadIdentity } = await import('../identity');
        vi.mocked(loadIdentity).mockResolvedValueOnce({ publicKey: ME, privateKey: 'aa', callsign: 'Me' } as any);
        const socket = await startAndConnect();
        vi.mocked(requestSync).mockClear();
        vi.mocked(DeviceEventEmitter.emit).mockClear();

        const post = publicOffer();
        socket.onmessage({ data: JSON.stringify({ type: 'new_post', post }) });
        await vi.advanceTimersByTimeAsync(WebSocketSyncClient.DATA_UPDATED_COALESCE_MS + 10);

        expect(applyLivePostChange).toHaveBeenCalledWith(
            { kind: 'upsert', post, created: true },
            { anchorUrl: 'https://testnode.beanpool.org', selfPubkey: ME },
        );
        expect(requestSync).not.toHaveBeenCalled();
        // The chat and unread listeners on ws_activity each go to the network; a listing change is not theirs.
        expect(DeviceEventEmitter.emit).not.toHaveBeenCalledWith('ws_activity', expect.anything());
        // The market, map and post screens re-read the cache on the same signal a sync that changed posts sends.
        expect(DeviceEventEmitter.emit).toHaveBeenCalledWith('sync_data_updated');
    });

    it('a burst of pushed changes makes the screens re-read once, not once per change', async () => {
        const socket = await startAndConnect();
        vi.mocked(DeviceEventEmitter.emit).mockClear();

        for (let i = 0; i < 5; i++) {
            socket.onmessage({ data: JSON.stringify({ type: 'new_post', post: publicOffer({ id: `post-${i}` }) }) });
        }
        await vi.advanceTimersByTimeAsync(WebSocketSyncClient.DATA_UPDATED_COALESCE_MS + 10);

        expect(applyLivePostChange).toHaveBeenCalledTimes(5);
        const rereads = vi.mocked(DeviceEventEmitter.emit).mock.calls.filter(([e]) => e === 'sync_data_updated');
        expect(rereads).toHaveLength(1);
    });

    it('post_updated and a public post_removed take the same path', async () => {
        const socket = await startAndConnect();
        vi.mocked(requestSync).mockClear();

        const post = publicOffer({ title: 'Lemons and limes', updatedAt: '2026-09-24T02:00:00.000Z' });
        socket.onmessage({ data: JSON.stringify({ type: 'post_updated', post }) });
        socket.onmessage({ data: JSON.stringify({ type: 'post_removed', id: 'post-1', audienceScope: 'public' }) });
        await vi.advanceTimersByTimeAsync(10);

        const changes = vi.mocked(applyLivePostChange).mock.calls.map(([c]) => c);
        expect(changes).toEqual([{ kind: 'upsert', post, created: false }, { kind: 'remove', id: 'post-1' }]);
        expect(requestSync).not.toHaveBeenCalled();
    });

    it('pushed changes are applied one at a time, in the order they arrived', async () => {
        const socket = await startAndConnect();
        const order: string[] = [];
        let releaseFirst!: () => void;
        vi.mocked(applyLivePostChange)
            .mockImplementationOnce(async (c: any) => { order.push(`start ${c.post.title}`); await new Promise<void>(r => { releaseFirst = r; }); order.push(`end ${c.post.title}`); return true; })
            .mockImplementationOnce(async (c: any) => { order.push(`start ${c.post.title}`); order.push(`end ${c.post.title}`); return true; });

        socket.onmessage({ data: JSON.stringify({ type: 'post_updated', post: publicOffer({ title: 'v2', updatedAt: '2026-09-24T02:00:00.000Z' }) }) });
        socket.onmessage({ data: JSON.stringify({ type: 'post_updated', post: publicOffer({ title: 'v3', updatedAt: '2026-09-24T03:00:00.000Z' }) }) });
        await vi.advanceTimersByTimeAsync(10);
        expect(order).toEqual(['start v2']);
        releaseFirst();
        await vi.advanceTimersByTimeAsync(10);
        expect(order).toEqual(['start v2', 'end v2', 'start v3', 'end v3']);
    });

    it('when the change touches this member (their post, their deal), it falls back to the doorbell exactly as before', async () => {
        const socket = await startAndConnect();
        vi.mocked(requestSync).mockClear();
        vi.mocked(DeviceEventEmitter.emit).mockClear();
        vi.mocked(applyLivePostChange).mockResolvedValueOnce(false);

        const event = { type: 'new_post', post: publicOffer() };
        socket.onmessage({ data: JSON.stringify(event) });
        await vi.advanceTimersByTimeAsync(10);

        expect(DeviceEventEmitter.emit).toHaveBeenCalledWith('ws_activity', event);
        expect(requestSync).toHaveBeenCalledTimes(1);
    });

    it('a failed local write falls back to the doorbell', async () => {
        const socket = await startAndConnect();
        vi.mocked(requestSync).mockClear();
        vi.mocked(applyLivePostChange).mockRejectedValueOnce(new Error('database is closing'));

        socket.onmessage({ data: JSON.stringify({ type: 'new_post', post: publicOffer() }) });
        await vi.advanceTimersByTimeAsync(10);
        expect(requestSync).toHaveBeenCalledTimes(1);
    });

    it.each([
        ['a transaction_completed doorbell', { type: 'transaction_completed' }],
        ['a group listing', { type: 'new_post', post: publicOffer({ audienceScope: 'group', targetGroupId: 'g1' }) }],
        ['an event', { type: 'post_updated', post: publicOffer({ type: 'event' }) }],
        ['a poll vote', { type: 'post_updated', post: publicOffer({ type: 'poll' }) }],
        ['a pause (id only)', { type: 'post_updated', id: 'post-1' }],
        ['a removal that does not say its audience (older node)', { type: 'post_removed', id: 'post-1' }],
        ['a group removal', { type: 'post_removed', id: 'post-1', audienceScope: 'group' }],
    ])('%s still runs the catch-up sync and is never written from the payload', async (_name, event) => {
        const socket = await startAndConnect();
        vi.mocked(requestSync).mockClear();
        vi.mocked(applyLivePostChange).mockClear();
        vi.mocked(DeviceEventEmitter.emit).mockClear();

        socket.onmessage({ data: JSON.stringify(event) });
        await vi.advanceTimersByTimeAsync(10);

        expect(applyLivePostChange).not.toHaveBeenCalled();
        expect(DeviceEventEmitter.emit).toHaveBeenCalledWith('ws_activity', event);
        expect(requestSync).toHaveBeenCalledTimes(1);
    });

    // ── Reconnect: full jitter, so a restarted edge does not get every phone back in the same second ─────

    async function dropAndCountReconnect(random: number): Promise<number> {
        const first = await startAndConnect();
        vi.spyOn(Math, 'random').mockReturnValue(random);
        first.close(); // onclose → scheduleReconnect
        let waited = 0;
        while (wsInstance === first && waited < 60_000) {
            await vi.advanceTimersByTimeAsync(100);
            waited += 100;
        }
        return waited;
    }

    it('the first retry after a drop can wait the whole 0–5 s window', async () => {
        const waited = await dropAndCountReconnect(0.999);
        expect(waited).toBeGreaterThan(4500);
        expect(waited).toBeLessThanOrEqual(5100);
    });

    it('and can also come back at once', async () => {
        const waited = await dropAndCountReconnect(0);
        expect(waited).toBeLessThanOrEqual(100);
    });

    it('a server that keeps refusing is retried with a growing window, never more than 30 s apart', async () => {
        await startAndConnect();
        vi.spyOn(Math, 'random').mockReturnValue(0.999);
        autoOpen = false; // the node is down: no retry's socket ever opens
        const gaps: number[] = [];
        for (let i = 0; i < 8; i++) {
            const current = wsInstance;
            current.close();
            let waited = 0;
            while (wsInstance === current && waited < 120_000) {
                await vi.advanceTimersByTimeAsync(100);
                waited += 100;
            }
            gaps.push(waited);
        }
        expect(gaps[0]).toBeLessThanOrEqual(5100);
        expect(Math.max(...gaps)).toBeLessThanOrEqual(30_100);
        expect(gaps[gaps.length - 1]).toBeGreaterThan(29_000);
    });

    it('the catch-up sync after a reconnect waits a random 0–3 s', async () => {
        await dropAndCountReconnect(0.999);
        vi.mocked(requestSync).mockClear();
        // The retry's socket opens on the next tick; its sync is spread, not immediate.
        await vi.advanceTimersByTimeAsync(10);
        expect(requestSync).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(3000);
        expect(requestSync).toHaveBeenCalledTimes(1);
    });

    it('bringing the app to the front reconnects at once and syncs at once — one person, not a crowd', async () => {
        const first = await startAndConnect();
        vi.spyOn(Math, 'random').mockReturnValue(0.999);
        first.close(); // a retry is now ~5 s away
        await vi.advanceTimersByTimeAsync(100);
        expect(wsInstance).toBe(first);

        (AppState as any).currentState = 'background';
        mockAppStateListeners.forEach(l => l('background'));
        (AppState as any).currentState = 'active';
        vi.mocked(requestSync).mockClear();
        mockAppStateListeners.forEach(l => l('active'));
        await vi.advanceTimersByTimeAsync(10);

        expect(wsInstance).not.toBe(first);
        expect(requestSync).toHaveBeenCalledTimes(1);
    });
});
