/**
 * Two tabs of this build on one browser, and a node that takes time to answer: the web app never shows a block as gone
 * while the community still holds it, not even for a moment (review of #1239, comments 4114620284 and 4114620334).
 *
 * Each tab is its own copy of lib/blocklist, on the one localStorage. The browser tells the tabs of a change to it a little
 * later, and only when something changed, as a browser does (here the tab that wrote hears it too, which a browser spares
 * it: that only costs it a read). lib/api is replaced by a stand-in node: a request reaches it after `there` ms, it acts
 * then, and its answer comes back `back` ms later; while the socket is up it rings the member's doorbell after each change
 * it takes, and every tab hears the ring.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const node = vi.hoisted(() => ({
    list: [] as string[],
    max: 500,
    /** ms a request takes to reach the node, and its answer to come back, unless `there`/`back` say otherwise for its kind. */
    hop: 50,
    there: {} as Record<string, number>,
    back: {} as Record<string, number>,
    /** The socket: the doorbell rings this long after each change the node takes; null while the socket is down. */
    ringAfter: 10 as number | null,
    /** How many of the next lists of keys (the one-time move) are lost on the way, as in a network blip. */
    dropListAdds: 0,
}));

vi.mock('./api', async () => {
    const { ringBlocklistDoorbell } = await import('./blocklist-doorbell');
    const wait = (ms: number) => new Promise(r => setTimeout(r, ms));
    const answer = () => ({ blocked: node.list.map(k => ({ publicKey: k, blockedAt: '2026-09-27T00:00:00.000Z' })), max: node.max });
    const ring = (changed: boolean) => {
        if (changed && node.ringAfter !== null) setTimeout(ringBlocklistDoorbell, node.ringAfter);
    };
    async function request<T>(kind: string, act: () => T): Promise<T> {
        await wait(node.there[kind] ?? node.hop);
        const res = act();
        await wait(node.back[kind] ?? node.hop);
        return res;
    }
    return {
        reportAbuse: vi.fn(async () => ({ success: true })),
        getBlockList: vi.fn(() => request('read', answer)),
        addToBlockList: vi.fn((keys: string | string[]) => request('add', () => {
            if (Array.isArray(keys) && node.dropListAdds > 0) {
                node.dropListAdds--;
                throw new TypeError('Failed to fetch');
            }
            const fresh = (Array.isArray(keys) ? keys : [keys]).filter(k => !node.list.includes(k));
            node.list.push(...fresh);
            ring(fresh.length > 0);
            return { ...answer(), added: fresh };
        })),
        removeFromBlockList: vi.fn((key: string) => request('remove', () => {
            const removed = node.list.includes(key);
            node.list = node.list.filter(k => k !== key);
            ring(removed);
            return { ...answer(), removed };
        })),
        clearBlockList: vi.fn(() => request('clear', () => {
            const removed = node.list.length;
            node.list = [];
            ring(removed > 0);
            return { ...answer(), removed };
        })),
    };
});

const BLOCKLIST_STORAGE_KEY = 'bp_blocked_users';
const BLOCKLIST_UPDATED_EVENT = 'bp_blocklist_updated';
const ME = 'a1'.repeat(32);
const [K1, K2, K7, K8] = ['b2', 'c3', 'd4', 'e5'].map(p => p.repeat(32));
const name = (k: string) => ({ [K1]: 'K1', [K2]: 'K2', [K7]: 'K7', [K8]: 'K8' })[k] ?? k.slice(0, 4);

type Tab = typeof import('./blocklist');

/** A new tab: its own copy of the module, as a page load gives it. */
async function openTab(): Promise<Tab> {
    vi.resetModules();
    return await import('./blocklist');
}

/** ms before the browser tells the tabs that localStorage changed. */
let storageAfter = 0;
function tellTabs(key: string, was: string | null, now: string | null): void {
    if (was === now) return;
    setTimeout(() => window.dispatchEvent(new StorageEvent('storage', { key, oldValue: was, newValue: now })), storageAfter);
}
/** From now on each change to localStorage (setupTests' stand-in for it) reaches the tabs as the browser's `storage` event. */
function browserTellsTabs(): void {
    const setItem = localStorage.setItem;
    const removeItem = localStorage.removeItem;
    vi.spyOn(localStorage, 'setItem').mockImplementation((key: string, value: string) => {
        const was = localStorage.getItem(key);
        setItem(key, value);
        tellTabs(key, was, localStorage.getItem(key));
    });
    vi.spyOn(localStorage, 'removeItem').mockImplementation((key: string) => {
        const was = localStorage.getItem(key);
        removeItem(key);
        tellTabs(key, was, null);
    });
}

/**
 * Watches what tabs show: after every ms the clock moves, and each time any tab tells its screens. `keys` must be shown by
 * every tab watched; each time one isn't, it is written down.
 */
function watch(keys: () => string[]) {
    const start = Date.now();
    const tabs: [string, Tab][] = [];
    /** The first few times a tab showed a watched key unblocked. */
    const gaps: string[] = [];
    const check = () => {
        for (const [label, tab] of tabs) {
            const shown = tab.getBlockedUsers();
            const missing = keys().filter(k => !shown.includes(k));
            if (missing.length > 0 && gaps.length < 3) gaps.push(`at ${Date.now() - start} ms tab ${label} shows ${missing.map(name).join(', ')} unblocked`);
        }
    };
    window.addEventListener(BLOCKLIST_UPDATED_EVENT, check);
    return {
        gaps,
        add: (label: string, tab: Tab) => { tabs.push([label, tab]); check(); },
        /** Moves the clock `ms` on, a ms at a time, running `at(t)` at each. */
        async run(ms: number, at?: (t: number) => void) {
            for (let t = 0; t < ms; t++) {
                at?.(t);
                await vi.advanceTimersByTimeAsync(1);
                check();
            }
        },
        stop: () => window.removeEventListener(BLOCKLIST_UPDATED_EVENT, check),
    };
}

describe('two tabs, and a node that takes time to answer', () => {
    const stops: (() => void)[] = [];

    beforeEach(() => {
        localStorage.clear();
        node.list = [];
        node.max = 500;
        node.hop = 50;
        node.there = {};
        node.back = {};
        node.ringAfter = 10;
        node.dropListAdds = 0;
        storageAfter = 0;
    });

    afterEach(() => {
        stops.splice(0).forEach(stop => stop());
        vi.restoreAllMocks();
        vi.useRealTimers();
    });

    it('a tab holding blocks from before never shows them unblocked while another tab moves them up', async () => {
        // Tab B loaded with K1 and K2 waiting in the browser (its move was lost on the way once). Tab A then loads and
        // moves them. Tab B's own read is put at every point of that, and the browser's word of A's change comes at once,
        // a little later, or later still.
        const runs: string[] = [];
        for (const after of [0, 7, 30]) {
            for (let bReadsAt = 0; bReadsAt <= 260; bReadsAt += 20) {
                localStorage.clear();
                localStorage.setItem(BLOCKLIST_STORAGE_KEY, JSON.stringify([K1, K2]));
                node.list = [];
                node.dropListAdds = 1;
                storageAfter = after;
                const B = await openTab();
                const A = await openTab();
                vi.useFakeTimers();
                browserTellsTabs();
                const w = watch(() => [K1, K2]);

                stops.push(B.startBlocklist(ME));
                w.add('B', B);
                await w.run(200);
                expect(B.getBlocklistStatus()).toEqual({ loaded: true, error: null });
                expect(JSON.parse(localStorage.getItem(BLOCKLIST_STORAGE_KEY)!)).toEqual([K1, K2]);
                expect(node.list).toEqual([]);

                stops.push(A.startBlocklist(ME));
                w.add('A', A);
                await w.run(700, t => { if (t === bReadsAt) B.loadBlocklist().catch(() => { /* said through getBlocklistStatus */ }); });
                await w.run(1000);

                const where = `word of the change after ${after} ms, B reading at ${bReadsAt} ms`;
                runs.push(...w.gaps.map(g => `${where}: ${g}`));
                expect([...node.list].sort(), where).toEqual([K1, K2].sort());
                expect(localStorage.getItem(BLOCKLIST_STORAGE_KEY), where).toBeNull();
                expect([...B.getBlockedUsers()].sort(), where).toEqual([K1, K2].sort());
                expect([...A.getBlockedUsers()].sort(), where).toEqual([K1, K2].sort());
                w.stop();
                stops.splice(0).forEach(stop => stop());
                vi.restoreAllMocks();
                vi.useRealTimers();
            }
        }
        expect(runs).toEqual([]);
    });

    describe.each([
        ['up', 10],
        ['down', null],
    ])('the socket %s', (_, ringAfter) => {
        it('a block made while a slow read is on its way stays shown after that read lands', async () => {
            node.ringAfter = ringAfter;
            const T = await openTab();
            vi.useFakeTimers();
            stops.push(T.startBlocklist(ME));
            await vi.advanceTimersByTimeAsync(500);
            expect(T.getBlocklistStatus()).toEqual({ loaded: true, error: null });

            // The node reads the list at once for this read (K7 not in it yet), and its answer takes 60 ms to come back.
            // The block is quick.
            node.there = { read: 1, add: 1 };
            node.back = { read: 60, add: 1 };
            T.loadBlocklist().catch(() => { /* said through getBlocklistStatus */ });
            await vi.advanceTimersByTimeAsync(5);
            const blocking = T.blockUser(K7);
            await vi.advanceTimersByTimeAsync(2);
            await expect(blocking).resolves.toBe(true);
            expect(T.isUserBlocked(K7)).toBe(true);

            const w = watch(() => [K7]);
            w.add('T', T);
            await w.run(400);
            w.stop();
            expect(w.gaps).toEqual([]);
            expect(node.list).toEqual([K7]);
            expect(T.getBlockedUsers()).toEqual([K7]);
        });

        it('an unblock made while a slow read is on its way stays done after that read lands', async () => {
            node.ringAfter = ringAfter;
            node.list = [K8];
            const T = await openTab();
            vi.useFakeTimers();
            stops.push(T.startBlocklist(ME));
            await vi.advanceTimersByTimeAsync(500);
            expect(T.getBlockedUsers()).toEqual([K8]);

            node.there = { read: 1, remove: 1 };
            node.back = { read: 60, remove: 1 };
            T.loadBlocklist().catch(() => { /* said through getBlocklistStatus */ });
            await vi.advanceTimersByTimeAsync(5);
            const unblocking = T.unblockUser(K8);
            await vi.advanceTimersByTimeAsync(2);
            await expect(unblocking).resolves.toBe(true);
            expect(T.isUserBlocked(K8)).toBe(false);

            const start = Date.now();
            const shownAgain: number[] = [];
            const check = () => { if (T.isUserBlocked(K8) && shownAgain.length < 3) shownAgain.push(Date.now() - start); };
            window.addEventListener(BLOCKLIST_UPDATED_EVENT, check);
            for (let t = 0; t < 400; t++) {
                await vi.advanceTimersByTimeAsync(1);
                check();
            }
            window.removeEventListener(BLOCKLIST_UPDATED_EVENT, check);
            expect(shownAgain).toEqual([]);
            expect(node.list).toEqual([]);
            expect(T.getBlockedUsers()).toEqual([]);
        });
    });
});
