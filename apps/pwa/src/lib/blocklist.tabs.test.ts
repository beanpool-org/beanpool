/**
 * A node that takes time to answer: the web app never shows a block as gone while the community still holds it, not even
 * for a moment (review of #1239, comments 4114620284 and 4114620334), and an older answer never takes over a newer one
 * (#1269's review).
 *
 * lib/api is replaced by a stand-in node: a request reaches it after `there` ms, it acts then, and its answer comes back
 * `back` ms later; while the socket is up it rings the member's doorbell after each change it takes. Each test opens the
 * page's code afresh, as a page load does.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const node = vi.hoisted(() => ({
    /** ME's list, on the node. */
    list: [] as string[],
    max: 500,
    /**
     * ms a request takes to reach the node, and its answer to come back, unless `there`/`back` say otherwise for its kind:
     * read, add, remove, clear.
     */
    hop: 50,
    there: {} as Record<string, number>,
    back: {} as Record<string, number>,
    /** Per kind, the next call's `back` wait pops from here first, before falling back to `back`/`hop`. */
    backQueue: {} as Record<string, number[]>,
    /** Per kind, the next call's `there` wait pops from here first, before falling back to `there`/`hop`. */
    thereQueue: {} as Record<string, number[]>,
    /** The socket: the doorbell rings this long after each change the node takes; null while the socket is down. */
    ringAfter: 10 as number | null,
    /** Every request the browser sent, in order: its kind and keys. */
    sent: [] as string[],
}));

vi.mock('./api', async () => {
    const { ringBlocklistDoorbell } = await import('./blocklist-doorbell');
    const wait = (ms: number) => new Promise(r => setTimeout(r, ms));
    const answer = () => ({
        blocked: node.list.map(k => ({ publicKey: k, blockedAt: '2026-09-27T00:00:00.000Z' })),
        max: node.max,
    });
    const ring = (changed: boolean) => {
        if (changed && node.ringAfter !== null) setTimeout(ringBlocklistDoorbell, node.ringAfter);
    };
    async function request<T>(kind: string, keys: string | string[] | null, act: () => T): Promise<T> {
        node.sent.push([kind, ...(keys === null ? [] : [String(keys)])].join(' '));
        const going = node.thereQueue[kind];
        await wait(going && going.length > 0 ? going.shift()! : (node.there[kind] ?? node.hop));
        const res = act();
        const queued = node.backQueue[kind];
        await wait(queued && queued.length > 0 ? queued.shift()! : (node.back[kind] ?? node.hop));
        return res;
    }
    return {
        reportAbuse: vi.fn(async () => ({ success: true })),
        getBlockList: vi.fn(() => request('read', null, answer)),
        addToBlockList: vi.fn((key: string | string[]) => request('add', key, () => {
            const fresh = (Array.isArray(key) ? key : [key]).filter(k => !node.list.includes(k));
            node.list = [...node.list, ...fresh];
            ring(fresh.length > 0);
            return { ...answer(), added: fresh };
        })),
        removeFromBlockList: vi.fn((key: string) => request('remove', key, () => {
            const removed = node.list.includes(key);
            node.list = node.list.filter(k => k !== key);
            ring(removed);
            return { ...answer(), removed };
        })),
        clearBlockList: vi.fn(() => request('clear', null, () => {
            const removed = node.list.length;
            node.list = [];
            ring(removed > 0);
            return { ...answer(), removed };
        })),
    };
});

// Each test opens its own copy of lib/blocklist, but all of them share one @beanpool/core, the words lib/blocklist draws its
// sentences from (#2237); nothing in this file changes the language, and no tab's list depends on core. openTab's
// vi.resetModules() leaves a mocked module as it is, so this pass-through, the real core, is evaluated once for the file.
// Evaluated anew for every tab, core took 11-32 ms a time at idle: 95% of each sweep test below (1.3-2.4 s, against 80 ms
// with one core), and past the 30 s limit on a busy CI runner (20 Oct). A module lib/blocklist imports later that is slow
// to evaluate wants the same.
vi.mock('@beanpool/core', async importOriginal => await importOriginal());

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

/**
 * Watches what tabs show: after everything that happens (each timer: a request reaching the node, an answer coming back, a
 * ring, the browser's word of a change), and each time any tab tells its screens. `keys` must be shown by every tab
 * watched, and `unblocked` by none; each time one isn't, or is, it is written down.
 */
function watch(keys: () => string[], unblocked: () => string[] = () => []) {
    const start = Date.now();
    const tabs: [string, Tab][] = [];
    /** The first few times a tab showed a watched key unblocked, or an unblocked key blocked. */
    const gaps: string[] = [];
    const check = () => {
        for (const [label, tab] of tabs) {
            const shown = tab.getBlockedUsers();
            const missing = keys().filter(k => !shown.includes(k));
            if (missing.length > 0 && gaps.length < 3) gaps.push(`at ${Date.now() - start} ms tab ${label} shows ${missing.map(name).join(', ')} unblocked`);
            const back = unblocked().filter(k => shown.includes(k));
            if (back.length > 0 && gaps.length < 3) gaps.push(`at ${Date.now() - start} ms tab ${label} shows ${back.map(name).join(', ')} blocked`);
        }
    };
    window.addEventListener(BLOCKLIST_UPDATED_EVENT, check);
    return {
        gaps,
        add: (label: string, tab: Tab) => { tabs.push([label, tab]); check(); },
        /** Moves the clock on until nothing is left to happen, or `ms` have passed, or the test has run out of time. */
        async run(ms: number, signal?: AbortSignal) {
            const end = Date.now() + ms;
            while (vi.getTimerCount() > 0 && Date.now() < end) {
                signal?.throwIfAborted();
                await vi.advanceTimersToNextTimerAsync();
                check();
            }
        },
        stop: () => window.removeEventListener(BLOCKLIST_UPDATED_EVENT, check),
    };
}

describe('two tabs, and a node that takes time to answer', () => {
    const stops: (() => void)[] = [];
    /** The runs a sweep below is making: the next test starts only once they have stopped. */
    let sweeping: Promise<void> = Promise.resolve();

    beforeEach(() => {
        localStorage.clear();
        node.list = [];
        node.max = 500;
        node.hop = 50;
        node.there = {};
        node.back = {};
        node.backQueue = {};
        node.thereQueue = {};
        node.ringAfter = 10;
        node.sent = [];
        // The module says each lost move and refused change on the console; the sweep below makes hundreds.
        vi.spyOn(console, 'warn').mockImplementation(() => {});
    });

    afterEach(async () => {
        await sweeping.catch(() => { /* its test has failed already */ });
        stops.splice(0).forEach(stop => stop());
        vi.restoreAllMocks();
        vi.useRealTimers();
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

    // ── an answer older than one the page has taken never takes a block off the screens (#1269's review 5861163950) ──

    /** One tab has read the node's list, `list`, with the socket up or down. The requests it sent so far are forgotten. */
    async function oneTabRead(list: string[], ringAfter: number | null): Promise<Tab> {
        node.list = [...list];
        node.ringAfter = ringAfter;
        const T = await openTab();
        vi.useFakeTimers();
        stops.push(T.startBlocklist(ME));
        await vi.advanceTimersByTimeAsync(500);
        expect(T.getBlockedUsers()).toEqual(list);
        node.sent = [];
        return T;
    }

    const unblockK1OrAll = (T: Tab, how: 'unblock of K1' | 'Unblock All'): Promise<unknown> =>
        how === 'Unblock All' ? T.clearBlocklist() : T.unblockUser(K1);

    describe.each([
        ['up', 10],
        ['down', null],
    ] as const)('the socket %s', (_, ringAfter) => {
        it.each(['Unblock All', 'unblock of K1'] as const)('an %s answered slowly, with a block of K2 made and answered in between: K2 is shown blocked throughout', async how => {
            const T = await oneTabRead([K1], ringAfter);
            // The member's unblock reaches the node at 1 ms, and its answer (nobody blocked) comes back only at 201 ms. At
            // 10 ms they block K2, which reaches the node at 11 ms and answers at 12 ms: K2 and not K1, the newer answer.
            node.there = { remove: 1, clear: 1, add: 1 };
            node.back = { remove: 200, clear: 200, add: 1 };
            const unblocking = unblockK1OrAll(T, how);
            await vi.advanceTimersByTimeAsync(10);
            expect(node.list).toEqual([]);
            const blocking = T.blockUser(K2);
            await vi.advanceTimersByTimeAsync(5);
            await expect(blocking).resolves.toBe(true);
            expect(T.getBlockedUsers()).toEqual([K2]);
            const w = watch(() => [K2], () => [K1]);
            w.add('T', T);
            await w.run(3000);
            w.stop();
            await expect(unblocking).resolves.toBe(how === 'Unblock All' ? undefined : true);
            expect(w.gaps).toEqual([]);
            expect(node.list).toEqual([K2]);
            expect(T.getBlockedUsers()).toEqual([K2]);
        });

        it('a block whose request reaches the node after a later one\'s shows once it answers, though that later answer came back first', async () => {
            const T = await oneTabRead([], ringAfter);
            // The block of K1 is slow on its way and reaches the node at 100 ms. The block of K2, made at 10 ms, reaches it at
            // 11 ms and answers at 12 ms without K1. K1's answer was asked for first, but it is the node's newest.
            node.thereQueue = { add: [100, 1] };
            node.back = { add: 1 };
            const first = T.blockUser(K1);
            await vi.advanceTimersByTimeAsync(10);
            const second = T.blockUser(K2);
            await vi.advanceTimersByTimeAsync(5);
            await expect(second).resolves.toBe(true);
            expect(T.getBlockedUsers()).toEqual([K2]);
            let firstDone = false;
            let shownThen: string[] = [];
            void first.then(() => { firstDone = true; shownThen = [...T.getBlockedUsers()]; });
            const w = watch(() => (firstDone ? [K1, K2] : [K2]));
            w.add('T', T);
            await w.run(3000);
            w.stop();
            await expect(first).resolves.toBe(true);
            expect([...shownThen].sort()).toEqual([K1, K2].sort());
            expect(w.gaps).toEqual([]);
            expect(node.list).toEqual([K2, K1]);
            expect([...T.getBlockedUsers()].sort()).toEqual([K1, K2].sort());
        });

        it('a block whose answer came back first stays shown when a later request that crossed it on the way answers without it', async () => {
            const T = await oneTabRead([], ringAfter);
            // The block of K1 reaches the node at 50 ms and answers at 51 ms, K1 and K2. The block of K2, made at 10 ms,
            // reached the node first, at 11 ms, and its answer (K2 alone) comes back only at 111 ms: asked for later, but older.
            // (`there` waits are taken in the order the requests are sent, `back` waits in the order they reach the node.)
            node.thereQueue = { add: [50, 1] };
            node.backQueue = { add: [100, 1] };
            const first = T.blockUser(K1);
            await vi.advanceTimersByTimeAsync(10);
            const second = T.blockUser(K2);
            await vi.advanceTimersByTimeAsync(45);
            await expect(first).resolves.toBe(true);
            expect([...T.getBlockedUsers()].sort()).toEqual([K1, K2].sort());
            const w = watch(() => [K1, K2]);
            w.add('T', T);
            await w.run(3000);
            w.stop();
            await expect(second).resolves.toBe(true);
            expect(w.gaps).toEqual([]);
            expect(node.list).toEqual([K2, K1]);
            expect([...T.getBlockedUsers()].sort()).toEqual([K1, K2].sort());
        });
    });

    it('an unblock of K1 on its way with a block of K2 answers last: K1 is not shown again, and no read is needed', async () => {
        const T = await oneTabRead([K1], null);
        // The block of K2 answers at 21 ms, K1 and K2. The unblock of K1, made at 5 ms, was on its way with it; it reaches the
        // node after the block and answers at 56 ms, K2 alone: without K1 because of itself.
        node.there = { add: 1, remove: 1 };
        node.back = { add: 20, remove: 50 };
        let blocked = false;
        let done = false;
        const blocking = T.blockUser(K2).then(r => { blocked = true; return r; });
        await vi.advanceTimersByTimeAsync(5);
        const unblocking = T.unblockUser(K1).then(r => { done = true; return r; });
        const w = watch(() => (blocked ? [K2] : []), () => (done ? [K1] : []));
        w.add('T', T);
        await w.run(3000);
        w.stop();
        await expect(blocking).resolves.toBe(true);
        await expect(unblocking).resolves.toBe(true);
        expect(w.gaps).toEqual([]);
        expect(node.list).toEqual([K2]);
        expect(T.getBlockedUsers()).toEqual([K2]);
        expect(node.sent).toEqual([`add ${K2}`, `remove ${K1}`]);
    });

    it('Unblock All pressed while a block of K2 is on its way, and answered after it: one more read, and the page shows what the node holds', async () => {
        const T = await oneTabRead([K1], null);
        // The block of K2 reaches the node at 1 ms and answers at 21 ms, K1 and K2. Unblock All, pressed at 5 ms while K2 isn't
        // shown yet, reaches it at 6 ms and answers at 56 ms: nobody. The two were on their way together, so K2 stays shown
        // until a read asked after both says the node doesn't hold it.
        node.there = { add: 1, clear: 1, read: 1 };
        node.back = { add: 20, clear: 50, read: 1 };
        const blocking = T.blockUser(K2);
        await vi.advanceTimersByTimeAsync(5);
        const clearing = T.clearBlocklist();
        await vi.advanceTimersByTimeAsync(3000);
        await expect(blocking).resolves.toBe(true);
        await clearing;
        expect(node.list).toEqual([]);
        expect(T.getBlockedUsers()).toEqual([]);
        expect(node.sent).toEqual([`add ${K2}`, 'clear', 'read']);
    });

    it.each(['Unblock All', 'unblock of K1'] as const)('an %s asked after a block of K2 is the newer answer, and applies as it comes back last', async how => {
        const T = await oneTabRead([K1], null);
        // The block goes first and answers at 2 ms; the member's unblock goes at 10 ms, and its answer comes back at 211 ms.
        node.there = { remove: 1, clear: 1, add: 1 };
        node.back = { remove: 200, clear: 200, add: 1 };
        const blocking = T.blockUser(K2);
        await vi.advanceTimersByTimeAsync(10);
        await expect(blocking).resolves.toBe(true);
        expect(T.getBlockedUsers()).toEqual([K1, K2]);
        const ends = how === 'Unblock All' ? [] : [K2];
        let shownThen: string[] | null = null;
        const unblocking = unblockK1OrAll(T, how).then(() => { shownThen = [...T.getBlockedUsers()]; });
        await vi.advanceTimersByTimeAsync(3000);
        await unblocking;
        expect(shownThen).toEqual(ends);
        expect(node.list).toEqual(ends);
        expect(T.getBlockedUsers()).toEqual(ends);
        // Taken as it came back: no read was needed for it.
        expect(node.sent).toEqual([`add ${K2}`, how === 'Unblock All' ? 'clear' : `remove ${K1}`]);
    });

    it('an Unblock All that reaches the node after a later block: once both answer, one more read shows what the node holds', async () => {
        const T = await oneTabRead([K1], null);
        // Unblock All is slow on its way and reaches the node at 100 ms, after the block of K2 made at 10 ms (there at 11 ms,
        // answered at 12 ms, K1 and K2). Its answer, nobody blocked, was asked for first but is the node's newest.
        node.thereQueue = { clear: [100] };
        node.there = { add: 1, read: 1 };
        node.back = { clear: 1, add: 1, read: 1 };
        const clearing = T.clearBlocklist();
        await vi.advanceTimersByTimeAsync(10);
        const blocking = T.blockUser(K2);
        await vi.advanceTimersByTimeAsync(5);
        await expect(blocking).resolves.toBe(true);
        expect([...T.getBlockedUsers()].sort()).toEqual([K1, K2].sort());
        await vi.advanceTimersByTimeAsync(3000);
        await clearing;
        expect(node.list).toEqual([]);
        expect(T.getBlockedUsers()).toEqual([]);
        expect(node.sent).toEqual(['clear', `add ${K2}`, 'read']);
    });

    // #1278 review 4119489106: a double Block (the chat header's button has no busy guard), then an unblock here, and the
    // second block reaches the node last: the node holds K1 again, so the page shows it, after one read.
    it.each(['unblock of K1', 'Unblock All'] as const)('a second block of K1 that reaches the node after the %s shows, with the socket down', async (how) => {
        const T = await oneTabRead([], null);
        node.thereQueue = { add: [1, 100] };
        node.there = { remove: 1, clear: 1, read: 1 };
        node.back = { add: 1, remove: 1, clear: 1, read: 1 };
        const first = T.blockUser(K1);
        const second = T.blockUser(K1);
        await vi.advanceTimersByTimeAsync(5);
        await expect(first).resolves.toBe(true);
        expect(T.getBlockedUsers()).toEqual([K1]);
        const lifting = unblockK1OrAll(T, how);
        await vi.advanceTimersByTimeAsync(5);
        await lifting;
        expect(T.getBlockedUsers()).toEqual([]);
        await vi.advanceTimersByTimeAsync(3000);
        await second;
        expect(node.list).toEqual([K1]);
        expect(T.getBlockedUsers()).toEqual([K1]);
    });

    it('an older answer never shows again a block the member lifted here since: an unblock of K1 answered slowly, then Unblock All', async () => {
        const T = await oneTabRead([K1, K2], null);
        // The unblock of K1 reaches the node at 1 ms, and its answer (K2 blocked) comes back at 201 ms. At 10 ms the member
        // presses Unblock All, which K2 is shown in, and it answers at 12 ms: nobody blocked.
        node.there = { remove: 1, clear: 1 };
        node.back = { remove: 200, clear: 1 };
        const unblocking = T.unblockUser(K1);
        await vi.advanceTimersByTimeAsync(10);
        const clearing = T.clearBlocklist();
        await vi.advanceTimersByTimeAsync(5);
        await clearing;
        expect(T.getBlockedUsers()).toEqual([]);
        const w = watch(() => [], () => [K1, K2]);
        w.add('T', T);
        await w.run(3000);
        w.stop();
        await expect(unblocking).resolves.toBe(true);
        expect(w.gaps).toEqual([]);
        expect(node.list).toEqual([]);
        expect(T.getBlockedUsers()).toEqual([]);
    });

    it('an older answer never shows again a block the member lifted here since: a block of K7 answered slowly, then an unblock of K1', async () => {
        const T = await oneTabRead([K1, K2], null);
        // The block of K7 reaches the node at 1 ms, and its answer (K1, K2 and K7) comes back at 201 ms. At 10 ms the member
        // unblocks K1, which answers at 12 ms: K2 and K7.
        node.there = { add: 1, remove: 1 };
        node.back = { add: 200, remove: 1 };
        const blocking = T.blockUser(K7);
        await vi.advanceTimersByTimeAsync(10);
        const unblocking = T.unblockUser(K1);
        await vi.advanceTimersByTimeAsync(5);
        await expect(unblocking).resolves.toBe(true);
        expect(T.getBlockedUsers()).toEqual([K2, K7]);
        const w = watch(() => [K2, K7], () => [K1]);
        w.add('T', T);
        await w.run(3000);
        w.stop();
        await expect(blocking).resolves.toBe(true);
        expect(w.gaps).toEqual([]);
        expect(node.list).toEqual([K2, K7]);
        expect(T.getBlockedUsers()).toEqual([K2, K7]);
    });

    it('an older answer never shows again a block the member lifted here since: K1 unblocked, blocked and unblocked again here, around a block of K7 answered slowly', async () => {
        const T = await oneTabRead([K1, K2], null);
        node.there = { add: 1, remove: 1 };
        node.back = { add: 1, remove: 1 };
        const first = T.unblockUser(K1);
        await vi.advanceTimersByTimeAsync(5);
        await expect(first).resolves.toBe(true);
        const again = T.blockUser(K1);
        await vi.advanceTimersByTimeAsync(5);
        await expect(again).resolves.toBe(true);
        expect(T.getBlockedUsers()).toEqual([K2, K1]);
        // The block of K7 reaches the node at 1 ms, and its answer (K2, K1 and K7) comes back at 201 ms. At 10 ms the member
        // unblocks K1 here again, which answers at 12 ms: K2 and K7. Their last unblock is after that answer was asked for.
        node.backQueue = { add: [200] };
        const blocking = T.blockUser(K7);
        await vi.advanceTimersByTimeAsync(10);
        const unblocking = T.unblockUser(K1);
        await vi.advanceTimersByTimeAsync(5);
        await expect(unblocking).resolves.toBe(true);
        expect(T.getBlockedUsers()).toEqual([K2, K7]);
        const w = watch(() => [K2, K7], () => [K1]);
        w.add('T', T);
        await w.run(3000);
        w.stop();
        await expect(blocking).resolves.toBe(true);
        expect(w.gaps).toEqual([]);
        expect(node.list).toEqual([K2, K7]);
        expect(T.getBlockedUsers()).toEqual([K2, K7]);
    });

    it('a block of K1 made here again after the member unblocked them here shows once it answers, though a later block crossed it on the way', async () => {
        const T = await oneTabRead([K1], null);
        node.there = { remove: 1 };
        node.back = { remove: 1 };
        const unblocking = T.unblockUser(K1);
        await vi.advanceTimersByTimeAsync(5);
        await expect(unblocking).resolves.toBe(true);
        expect(T.getBlockedUsers()).toEqual([]);
        // The member blocks K1 again here: slow on its way, it reaches the node at 100 ms. The block of K2, made 10 ms later,
        // reaches it first and answers without K1. The answer about K1 was asked for after the unblock: that block stands.
        node.thereQueue = { add: [100, 1] };
        node.back = { add: 1 };
        const first = T.blockUser(K1);
        await vi.advanceTimersByTimeAsync(10);
        const second = T.blockUser(K2);
        await vi.advanceTimersByTimeAsync(5);
        await expect(second).resolves.toBe(true);
        expect(T.getBlockedUsers()).toEqual([K2]);
        let firstDone = false;
        let shownThen: string[] = [];
        void first.then(() => { firstDone = true; shownThen = [...T.getBlockedUsers()]; });
        const w = watch(() => (firstDone ? [K1, K2] : [K2]));
        w.add('T', T);
        await w.run(3000);
        w.stop();
        await expect(first).resolves.toBe(true);
        expect([...shownThen].sort()).toEqual([K1, K2].sort());
        expect(w.gaps).toEqual([]);
        expect(node.list).toEqual([K2, K1]);
        expect([...T.getBlockedUsers()].sort()).toEqual([K1, K2].sort());
    });
});
