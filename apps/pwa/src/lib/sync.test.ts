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
    reconnectToAnchor,
    onSyncActivity,
    onSyncChange,
    onSocketOpen,
    resetSyncForTest,
    getWatchdogArmedForTest,
    PONG_TIMEOUT_MS,
    HEARTBEAT_INTERVAL_MS,
} from './sync';
import { resetCoordinatorForTest, SYNC_CURSOR_KEY } from './sync-coordinator';
import { onLivePostChange, registerLivePostTie, resetLivePostsForTest } from './live-posts';
import { loadIdentity } from './identity';

describe('PWA WebSocket Pong Watchdog', () => {
    let wsInstance: any = null;

    beforeEach(() => {
        vi.useFakeTimers();
        localStorage.clear();
        resetCoordinatorForTest();
        resetSyncForTest();
        resetLivePostsForTest();
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

    // The next socket opens as a member's. With no identity (this file's default) it is a visitor's, whose doorbells
    // wait their turn (lib/visitor-doorbells): a test of what a member's doorbell does says it is a member's.
    const MEMBER = { publicKey: 'e'.repeat(64), privateKey: '00', callsign: 'Me', createdAt: '' } as any;
    const asMember = () => vi.mocked(loadIdentity).mockResolvedValueOnce(MEMBER);

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

    it('onSocketOpen fires on every open, the first and each reconnect, and not after unsubscribing', async () => {
        // What SystemAlerts reads the kept moderation notices on: anything sent while the socket was down never arrived.
        const opened = vi.fn();
        const unsubscribe = onSocketOpen(opened);
        connectToAnchor('ws://localhost:9000/ws');
        const first = await waitForWs();
        first.readyState = 1;
        first.onopen();
        expect(opened).toHaveBeenCalledTimes(1);

        wsInstance = null;
        first.onclose({ code: 1006, reason: 'dropped' });
        await vi.advanceTimersByTimeAsync(30_000);
        const second = await waitForWs();
        second.readyState = 1;
        second.onopen();
        expect(opened).toHaveBeenCalledTimes(2);

        unsubscribe();
        wsInstance = null;
        second.onclose({ code: 1006, reason: 'dropped again' });
        await vi.advanceTimersByTimeAsync(30_000);
        const third = await waitForWs();
        third.readyState = 1;
        third.onopen();
        expect(opened).toHaveBeenCalledTimes(2);
    });

    it('a listener on the socket opening that throws breaks nothing', async () => {
        onSocketOpen(() => { throw new Error('a listener fails'); });
        const after = vi.fn();
        onSocketOpen(after);
        connectToAnchor('ws://localhost:9000/ws');
        const socket = await waitForWs();
        socket.readyState = 1;
        expect(() => socket.onopen()).not.toThrow();
        expect(after).toHaveBeenCalledTimes(1);
        expect(socket.send).toHaveBeenCalledWith(JSON.stringify({ type: 'ping', wantPong: true }));
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
        asMember();
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

    // A member who is not a party to a trade gets its board-changing steps as a bare { type } (the server
    // scopes the payload to the two parties). The views re-fetch on the doorbell exactly as on the full event.
    it.each(['post_accepted', 'transaction_completed', 'transaction_cancelled', 'dispute_resolved'])(
        'a bare %s doorbell (no payload) still refreshes the views', async (type) => {
            asMember();
            const activityListener = vi.fn();
            onSyncActivity(activityListener);

            connectToAnchor('ws://localhost:9000/ws');
            const socket = await waitForWs();
            socket.readyState = 1;
            socket.onopen();
            await vi.advanceTimersByTimeAsync(150);
            activityListener.mockClear();

            socket.onmessage({ data: JSON.stringify({ type }) });
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

    // ── Live updates: apply the change the node already sent, instead of re-fetching everything ──────────

    const ME = 'e'.repeat(64);
    const publicOffer = (extra: Record<string, unknown> = {}) => ({
        id: 'post-1', type: 'offer', category: 'food', title: 'Spare lemons', description: 'A bag', credits: 5,
        authorPublicKey: 'a'.repeat(64), authorCallsign: 'Ann', createdAt: '2026-09-24T01:00:00.000Z',
        updatedAt: '2026-09-24T01:00:00.000Z', active: true, status: 'active', audienceScope: 'public', ...extra,
    });

    async function openSocket(): Promise<any> {
        connectToAnchor('ws://localhost:9000/ws');
        const socket = await waitForWs();
        socket.readyState = 1;
        socket.onopen();
        await vi.advanceTimersByTimeAsync(150); // the opening sync
        return socket;
    }

    it('a new_post carrying a public offer goes to the views, runs no sync, and leaves the cursor alone', async () => {
        const activityListener = vi.fn();
        onSyncActivity(activityListener);
        const view = vi.fn();
        onLivePostChange(view);
        const socket = await openSocket();
        activityListener.mockClear();
        const cursor = localStorage.getItem(SYNC_CURSOR_KEY);

        const post = publicOffer();
        socket.onmessage({ data: JSON.stringify({ type: 'new_post', post }) });
        await vi.advanceTimersByTimeAsync(2500);

        expect(view).toHaveBeenCalledWith({ kind: 'upsert', post, created: true });
        expect(activityListener).not.toHaveBeenCalled();
        expect(localStorage.getItem(SYNC_CURSOR_KEY)).toBe(cursor);
    });

    it('post_updated and a public post_removed take the same path', async () => {
        const activityListener = vi.fn();
        onSyncActivity(activityListener);
        const view = vi.fn();
        onLivePostChange(view);
        const socket = await openSocket();
        activityListener.mockClear();

        const post = publicOffer({ title: 'Lemons and limes', updatedAt: '2026-09-24T02:00:00.000Z' });
        socket.onmessage({ data: JSON.stringify({ type: 'post_updated', post }) });
        socket.onmessage({ data: JSON.stringify({ type: 'post_removed', id: 'post-1', audienceScope: 'public' }) });
        await vi.advanceTimersByTimeAsync(2500);

        expect(view.mock.calls.map(([c]) => c)).toEqual([{ kind: 'upsert', post, created: false }, { kind: 'remove', id: 'post-1' }]);
        expect(activityListener).not.toHaveBeenCalled();
    });

    it('my own listing still runs the full sync — one person, and their gates and deals need it', async () => {
        vi.mocked(loadIdentity).mockResolvedValueOnce({ publicKey: ME, privateKey: '00', callsign: 'Me', createdAt: '' } as any);
        const activityListener = vi.fn();
        onSyncActivity(activityListener);
        const view = vi.fn();
        onLivePostChange(view);
        const socket = await openSocket();
        activityListener.mockClear();

        socket.onmessage({ data: JSON.stringify({ type: 'new_post', post: publicOffer({ authorPublicKey: ME }) }) });
        await vi.advanceTimersByTimeAsync(200);

        expect(view).not.toHaveBeenCalled();
        expect(activityListener).toHaveBeenCalledTimes(1);
    });

    it('a change a page is tied to (an open deal, a chat about it) still runs the full sync', async () => {
        asMember();
        const activityListener = vi.fn();
        onSyncActivity(activityListener);
        registerLivePostTie(() => true);
        const socket = await openSocket();
        activityListener.mockClear();

        socket.onmessage({ data: JSON.stringify({ type: 'post_removed', id: 'post-1', audienceScope: 'public' }) });
        await vi.advanceTimersByTimeAsync(200);
        expect(activityListener).toHaveBeenCalledTimes(1);
    });

    it.each([
        ['a group listing', { type: 'new_post', post: publicOffer({ audienceScope: 'group', targetGroupId: 'g1' }) }],
        ['an event', { type: 'post_updated', post: publicOffer({ type: 'event' }) }],
        ['a poll vote', { type: 'post_updated', post: publicOffer({ type: 'poll' }) }],
        ['a pause (id only)', { type: 'post_updated', id: 'post-1' }],
        ['a removal that does not say its audience (older node)', { type: 'post_removed', id: 'post-1' }],
        ['a group removal', { type: 'post_removed', id: 'post-1', audienceScope: 'group' }],
    ])('%s still refreshes the views, and is never handed to them as a change', async (_name, event) => {
        asMember();
        const activityListener = vi.fn();
        onSyncActivity(activityListener);
        const view = vi.fn();
        onLivePostChange(view);
        const socket = await openSocket();
        activityListener.mockClear();

        socket.onmessage({ data: JSON.stringify(event) });
        await vi.advanceTimersByTimeAsync(200);
        expect(view).not.toHaveBeenCalled();
        expect(activityListener).toHaveBeenCalledTimes(1);
    });

    // ── Reconnect: full jitter, so a restarted edge does not get every tab back in the same second ───────

    async function waitForNewSocket(previous: any, limitMs: number): Promise<number> {
        let waited = 0;
        while (wsInstance === previous && waited < limitMs) {
            await vi.advanceTimersByTimeAsync(100);
            waited += 100;
        }
        return waited;
    }

    it('the first retry after a drop can wait the whole 0–5 s window', async () => {
        const socket = await openSocket();
        vi.spyOn(Math, 'random').mockReturnValue(0.999);
        socket.close();
        const waited = await waitForNewSocket(socket, 60_000);
        expect(waited).toBeGreaterThan(4500);
        expect(waited).toBeLessThanOrEqual(5100);
    });

    it('and can also come back at once', async () => {
        const socket = await openSocket();
        vi.spyOn(Math, 'random').mockReturnValue(0);
        socket.close();
        expect(await waitForNewSocket(socket, 60_000)).toBeLessThanOrEqual(100);
    });

    it('a node that stays down is retried with a growing window, never more than 30 s apart', async () => {
        await openSocket();
        vi.spyOn(Math, 'random').mockReturnValue(0.999);
        const gaps: number[] = [];
        for (let i = 0; i < 8; i++) {
            const current = wsInstance;
            current.close(); // this attempt failed
            gaps.push(await waitForNewSocket(current, 120_000));
        }
        expect(gaps[0]).toBeLessThanOrEqual(5100);
        expect(Math.max(...gaps)).toBeLessThanOrEqual(30_100);
        expect(gaps[gaps.length - 1]).toBeGreaterThan(29_000);
    });

    it('the catch-up sync after a reconnect waits a random 0–3 s', async () => {
        const activityListener = vi.fn();
        onSyncActivity(activityListener);
        const socket = await openSocket();
        vi.spyOn(Math, 'random').mockReturnValue(0.999);
        socket.close();
        await waitForNewSocket(socket, 60_000);
        activityListener.mockClear();

        wsInstance.readyState = 1;
        wsInstance.onopen();
        await vi.advanceTimersByTimeAsync(500);
        expect(activityListener).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(3000);
        expect(activityListener).toHaveBeenCalledTimes(1);
    });

    it('a tab coming back to the front reconnects at once and syncs at once — one person, not a crowd', async () => {
        const activityListener = vi.fn();
        onSyncActivity(activityListener);
        const socket = await openSocket();
        vi.spyOn(Math, 'random').mockReturnValue(0.999);
        socket.close(); // a retry is now ~5 s away
        await vi.advanceTimersByTimeAsync(100);
        expect(wsInstance).toBe(socket);

        Object.defineProperty(document, 'hidden', { value: true, configurable: true });
        Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
        document.dispatchEvent(new Event('visibilitychange'));
        Object.defineProperty(document, 'hidden', { value: false, configurable: true });
        Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
        document.dispatchEvent(new Event('visibilitychange'));
        expect(await waitForNewSocket(socket, 60_000)).toBeLessThanOrEqual(100);

        activityListener.mockClear();
        wsInstance.readyState = 1;
        wsInstance.onopen();
        await vi.advanceTimersByTimeAsync(200);
        expect(activityListener).toHaveBeenCalledTimes(1);
    });

    it('a visitor who joins while the key-less socket is still being opened ends up on a signed one, never the key-less one', async () => {
        // The lobby's socket (G9b) is part way open: its identity read, which found no key, has not come back yet.
        let visitorRead!: (ident: null) => void;
        vi.mocked(loadIdentity)
            .mockImplementationOnce(() => new Promise((resolve) => { visitorRead = resolve; }))
            .mockResolvedValueOnce({ publicKey: ME, privateKey: '00', callsign: 'Rowan', createdAt: '' } as any);
        const opened: any[] = [];
        const Base = (globalThis as any).WebSocket;
        (globalThis as any).WebSocket = class extends Base {
            constructor(url: string) { super(url); opened.push(this); }
        };
        connectToAnchor('ws://localhost:9000/ws');
        await vi.advanceTimersByTimeAsync(10);
        expect(opened).toHaveLength(0);

        // The visitor has joined: the socket opens again, signed by the key stored now.
        reconnectToAnchor();
        await vi.advanceTimersByTimeAsync(10);
        // The key-less read comes back late: it opens nothing.
        visitorRead(null);
        await vi.advanceTimersByTimeAsync(10);

        expect(opened.map(s => s.url)).toEqual(['ws://localhost:9000/ws?callsign=Rowan']);
    });

    it('reopening for a member who has just joined starts afresh: at once, and syncing at once', async () => {
        const activityListener = vi.fn();
        onSyncActivity(activityListener);
        const first = await openSocket();
        // The key-less socket has dropped twice and waits out a long retry.
        vi.spyOn(Math, 'random').mockReturnValue(0.999);
        first.close();
        await vi.advanceTimersByTimeAsync(30_000);
        expect(wsInstance).not.toBe(first);
        wsInstance.close();
        const dropped = wsInstance;

        reconnectToAnchor();
        await vi.advanceTimersByTimeAsync(10);
        expect(wsInstance).not.toBe(dropped);
        activityListener.mockClear();
        wsInstance.readyState = 1;
        wsInstance.onopen();
        await vi.advanceTimersByTimeAsync(200);
        // Not the retry's 0–3 s spread: the member's lists load now.
        expect(activityListener).toHaveBeenCalledTimes(1);
    });

    // ── A visitor's socket (no key, the global lobby): bare doorbells, paced ───────────────────────────────
    // A key-less socket gets only `{ type }` doorbells, and each has the whole guest list read again. Rung straight into
    // the coordinator, every visitor's tab read within ~150 ms of every public change (lib/visitor-doorbells).

    function setHidden(hidden: boolean): void {
        Object.defineProperty(document, 'hidden', { value: hidden, configurable: true });
        Object.defineProperty(document, 'visibilityState', { value: hidden ? 'hidden' : 'visible', configurable: true });
        document.dispatchEvent(new Event('visibilitychange'));
    }

    async function fiftyDoorbellsInTwoSeconds(socket: any): Promise<void> {
        for (let i = 0; i < 50; i++) {
            socket.onmessage({ data: JSON.stringify({ type: ['new_post', 'post_updated', 'post_removed', 'state_synced'][i % 4] }) });
            await vi.advanceTimersByTimeAsync(40);
        }
    }

    it('a visitor: fifty doorbells in two seconds are one list read, 5–15 s after the first, and no more', async () => {
        const read = vi.fn();
        onSyncActivity(read);
        const socket = await openSocket();
        read.mockClear();

        await fiftyDoorbellsInTwoSeconds(socket);
        expect(read).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(5_000 - 2_000 - 1);
        expect(read).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(10_000 + 150 + 1);
        expect(read).toHaveBeenCalledTimes(1);
        await vi.advanceTimersByTimeAsync(120_000);
        expect(read).toHaveBeenCalledTimes(1);
    });

    it.each([
        [0, 5_000 + 150],
        [0.5, 10_000 + 150],
        [0.9999, 14_999 + 150],
    ])('a visitor: the read waits the 5 s window plus the tab\'s own 0–10 s (random %s → %s ms, the coordinator\'s 150 ms included)', async (r, at) => {
        const read = vi.fn();
        onSyncActivity(read);
        const socket = await openSocket();
        read.mockClear();
        vi.spyOn(Math, 'random').mockReturnValue(r);

        socket.onmessage({ data: JSON.stringify({ type: 'new_post' }) });
        await vi.advanceTimersByTimeAsync(at - 1);
        expect(read).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(1);
        expect(read).toHaveBeenCalledTimes(1);
    });

    it('a visitor tab in the background reads nothing; back in front, it reads once', async () => {
        const read = vi.fn();
        onSyncActivity(read);
        const socket = await openSocket();
        read.mockClear();

        setHidden(true);
        for (let i = 0; i < 20; i++) {
            socket.onmessage({ data: JSON.stringify({ type: 'post_updated' }) });
            await vi.advanceTimersByTimeAsync(3_000);
        }
        await vi.advanceTimersByTimeAsync(300_000);
        expect(read).not.toHaveBeenCalled();

        setHidden(false);
        await vi.advanceTimersByTimeAsync(1_500 + 150);
        expect(read).toHaveBeenCalledTimes(1);
        await vi.advanceTimersByTimeAsync(120_000);
        expect(read).toHaveBeenCalledTimes(1);
    });

    it('a visitor: a doorbell while the list is being read has it read once more after, paced again, never alongside', async () => {
        const pending: Array<() => void> = [];
        const read = vi.fn(() => new Promise<void>((resolve) => { pending.push(resolve); }));
        onSyncActivity(read);
        const socket = await openSocket();
        pending.shift()?.(); // the opening sync
        await vi.advanceTimersByTimeAsync(5_000);
        read.mockClear();
        vi.spyOn(Math, 'random').mockReturnValue(0);

        socket.onmessage({ data: JSON.stringify({ type: 'new_post' }) });
        await vi.advanceTimersByTimeAsync(5_000 + 150 - 1);
        expect(read).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(1);
        expect(read).toHaveBeenCalledTimes(1);

        // Doorbells while that read is under way, which stays under way a long while.
        socket.onmessage({ data: JSON.stringify({ type: 'post_updated' }) });
        socket.onmessage({ data: JSON.stringify({ type: 'state_synced' }) });
        await vi.advanceTimersByTimeAsync(60_000);
        expect(read).toHaveBeenCalledTimes(1);

        pending.shift()?.();
        await vi.advanceTimersByTimeAsync(5_000 + 150 - 1);
        expect(read).toHaveBeenCalledTimes(1);
        await vi.advanceTimersByTimeAsync(1);
        expect(read).toHaveBeenCalledTimes(2);

        pending.shift()?.();
        await vi.advanceTimersByTimeAsync(120_000);
        expect(read).toHaveBeenCalledTimes(2);
    });

    it('a member\'s doorbells are not paced: the views refresh within the coordinator\'s 150 ms, as before', async () => {
        vi.mocked(loadIdentity).mockResolvedValueOnce(MEMBER);
        const read = vi.fn();
        onSyncActivity(read);
        const socket = await openSocket();
        read.mockClear();

        socket.onmessage({ data: JSON.stringify({ type: 'new_post' }) });
        await vi.advanceTimersByTimeAsync(150);
        expect(read).toHaveBeenCalledTimes(1);
    });

    it('a visitor who joins is a member from the signed socket on: a doorbell the lobby held reads nothing later, and the member\'s are not paced', async () => {
        vi.mocked(loadIdentity)
            .mockResolvedValueOnce(null)
            .mockResolvedValueOnce(MEMBER);
        const read = vi.fn();
        onSyncActivity(read);
        const lobby = await openSocket();
        read.mockClear();
        lobby.onmessage({ data: JSON.stringify({ type: 'new_post' }) });
        await vi.advanceTimersByTimeAsync(1_000);

        reconnectToAnchor();
        await waitForNewSocket(lobby, 1_000);
        const signed = wsInstance;
        expect(signed).not.toBe(lobby);
        expect(signed.url).toBe('ws://localhost:9000/ws?callsign=Me');
        signed.readyState = 1;
        signed.onopen();
        await vi.advanceTimersByTimeAsync(150);
        expect(read).toHaveBeenCalledTimes(1); // the member's opening sync

        signed.onmessage({ data: JSON.stringify({ type: 'new_post' }) });
        await vi.advanceTimersByTimeAsync(150);
        expect(read).toHaveBeenCalledTimes(2);
        await vi.advanceTimersByTimeAsync(60_000);
        expect(read).toHaveBeenCalledTimes(2);
    });
});
