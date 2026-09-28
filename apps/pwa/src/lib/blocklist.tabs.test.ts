/**
 * Two tabs of this build on one browser, and a node that takes time to answer: the web app never shows a block as gone
 * while the community still holds it, not even for a moment (review of #1239, comments 4114620284 and 4114620334).
 *
 * Each tab is its own copy of lib/blocklist, on the one localStorage. The browser tells the tabs of a change to it a little
 * later, and only when something changed, as a browser does (here the tab that wrote hears it too, which a browser spares
 * it: that only costs it a read). lib/api is replaced by a stand-in node: a request reaches it after `there` ms, it acts
 * then, and its answer comes back `back` ms later; while the socket is up it rings the member's doorbell after each change
 * it takes, and every tab hears the ring. Each request acts on the list of the account the browser was signed in as when
 * it was sent.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const node = vi.hoisted(() => ({
    /** ME's list, on the node. */
    list: [] as string[],
    max: 500,
    /**
     * ms a request takes to reach the node, and its answer to come back, unless `there`/`back` say otherwise for its kind:
     * read, move (a list of keys, the one-time move), add, remove, clear.
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
    /** How many of the next lists of keys (the one-time move) are lost on the way, as in a network blip. */
    dropListAdds: 0,
    /** Every request the browser sent, in order: its kind and keys, and the account it was sent as when not ME. */
    sent: [] as string[],
    /** The account the browser is signed in as: 'me' (whose list is `list`) or another, whose list is in `others`. */
    signedIn: 'me',
    others: {} as Record<string, string[]>,
    /** When each of ME's blocks was made, as the node stamps it (blockedAt): a key blocked again is a new block, stamped anew. */
    stamps: {} as Record<string, string>,
    stamped: 0,
    /** Runs as each request reaches the node, before it acts: true loses the request there, as a network blip does. */
    arrive: null as null | ((kind: string, keys: string | string[] | null) => boolean),
}));

vi.mock('./api', async () => {
    const { ringBlocklistDoorbell } = await import('./blocklist-doorbell');
    const wait = (ms: number) => new Promise(r => setTimeout(r, ms));
    const listOf = (as: string) => (as === 'me' ? node.list : (node.others[as] ?? []));
    const keep = (as: string, list: string[]) => { if (as === 'me') node.list = list; else node.others[as] = list; };
    const answer = (as: string) => ({
        blocked: listOf(as).map(k => ({ publicKey: k, blockedAt: (as === 'me' && node.stamps[k]) || '2026-09-27T00:00:00.000Z' })),
        max: node.max,
    });
    const ring = (changed: boolean) => {
        if (changed && node.ringAfter !== null) setTimeout(ringBlocklistDoorbell, node.ringAfter);
    };
    async function request<T>(kind: string, keys: string | string[] | null, act: (as: string) => T): Promise<T> {
        const as = node.signedIn;
        node.sent.push([kind, ...(keys === null ? [] : [String(keys)]), ...(as === 'me' ? [] : [`as ${as}`])].join(' '));
        const going = node.thereQueue[kind];
        await wait(going && going.length > 0 ? going.shift()! : (node.there[kind] ?? node.hop));
        if (node.arrive?.(kind, keys)) throw new TypeError('Failed to fetch');
        const res = act(as);
        const queued = node.backQueue[kind];
        await wait(queued && queued.length > 0 ? queued.shift()! : (node.back[kind] ?? node.hop));
        return res;
    }
    return {
        reportAbuse: vi.fn(async () => ({ success: true })),
        getBlockList: vi.fn(() => request('read', null, answer)),
        addToBlockList: vi.fn((keys: string | string[]) => request(Array.isArray(keys) ? 'move' : 'add', keys, as => {
            if (Array.isArray(keys) && node.dropListAdds > 0) {
                node.dropListAdds--;
                throw new TypeError('Failed to fetch');
            }
            const list = listOf(as);
            const fresh = (Array.isArray(keys) ? keys : [keys]).filter(k => !list.includes(k));
            keep(as, [...list, ...fresh]);
            if (as === 'me') for (const k of fresh) node.stamps[k] = new Date(Date.UTC(2026, 8, 27) + ++node.stamped).toISOString();
            ring(fresh.length > 0);
            return { ...answer(as), added: fresh };
        })),
        removeFromBlockList: vi.fn((key: string) => request('remove', key, as => {
            const removed = listOf(as).includes(key);
            keep(as, listOf(as).filter(k => k !== key));
            if (as === 'me') delete node.stamps[key];
            ring(removed);
            return { ...answer(as), removed };
        })),
        clearBlockList: vi.fn(() => request('clear', null, as => {
            const removed = listOf(as).length;
            keep(as, []);
            if (as === 'me') node.stamps = {};
            ring(removed > 0);
            return { ...answer(as), removed };
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
/**
 * From now on each change to localStorage (setupTests' stand-in for it) reaches the tabs as the browser's `storage` event.
 * Returns the stop.
 */
function browserTellsTabs(): () => void {
    const setItem = localStorage.setItem;
    const removeItem = localStorage.removeItem;
    const set = vi.spyOn(localStorage, 'setItem').mockImplementation((key: string, value: string) => {
        const was = localStorage.getItem(key);
        setItem(key, value);
        tellTabs(key, was, localStorage.getItem(key));
    });
    const remove = vi.spyOn(localStorage, 'removeItem').mockImplementation((key: string) => {
        const was = localStorage.getItem(key);
        removeItem(key);
        tellTabs(key, was, null);
    });
    return () => { set.mockRestore(); remove.mockRestore(); };
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
        /** Moves the clock on until nothing is left to happen, or `ms` have passed. */
        async run(ms: number) {
            const end = Date.now() + ms;
            while (vi.getTimerCount() > 0 && Date.now() < end) {
                await vi.advanceTimersToNextTimerAsync();
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
        node.backQueue = {};
        node.thereQueue = {};
        node.ringAfter = 10;
        node.dropListAdds = 0;
        node.sent = [];
        node.signedIn = 'me';
        node.others = {};
        node.stamps = {};
        node.stamped = 0;
        node.arrive = null;
        storageAfter = 0;
        // The module says each lost move and refused change on the console; the sweep below makes hundreds.
        vi.spyOn(console, 'warn').mockImplementation(() => {});
    });

    afterEach(() => {
        stops.splice(0).forEach(stop => stop());
        vi.restoreAllMocks();
        vi.useRealTimers();
    });

    /** Tab B loads with K1 and K2 waiting in the browser (its move was lost on the way once); tab A then loads. */
    async function twoTabsWithBlocksWaiting(after: number) {
        localStorage.clear();
        localStorage.setItem(BLOCKLIST_STORAGE_KEY, JSON.stringify([K1, K2]));
        node.list = [];
        node.dropListAdds = 1;
        storageAfter = after;
        const B = await openTab();
        const A = await openTab();
        vi.useFakeTimers();
        stops.push(browserTellsTabs());
        stops.push(B.startBlocklist(ME));
        await vi.advanceTimersByTimeAsync(300);
        expect(B.getBlocklistStatus()).toEqual({ loaded: true, error: null });
        expect(B.getBlockedUsers()).toEqual([K1, K2]);
        expect(JSON.parse(localStorage.getItem(BLOCKLIST_STORAGE_KEY)!)).toEqual([K1, K2]);
        expect(node.list).toEqual([]);
        return { A, B };
    }

    it.each([50, 120])('a tab holding blocks from before never shows them unblocked while another tab moves them up (reads answered in %i ms)', async readBack => {
        // Tab A moves K1 and K2 up. Tab B's own read is put at every point of that, and the browser's word of A's change
        // comes at once, a little later, or later still. With reads slower than the move, B's read can be answered by the
        // node before A's move reaches it and land after A has taken the list off the browser.
        const runs: string[] = [];
        for (const after of [0, 7, 30, 60]) {
            for (let bReadsAt = 0; bReadsAt <= 300; bReadsAt += 5) {
                node.back = { read: readBack };
                const { A, B } = await twoTabsWithBlocksWaiting(after);
                const w = watch(() => [K1, K2]);
                w.add('B', B);
                stops.push(A.startBlocklist(ME));
                w.add('A', A);
                setTimeout(() => { B.loadBlocklist().catch(() => { /* said through getBlocklistStatus */ }); }, bReadsAt);
                await w.run(5000);

                const where = `word of the change after ${after} ms, B reading at ${bReadsAt} ms`;
                runs.push(...w.gaps.map(g => `${where}: ${g}`));
                expect([...node.list].sort(), where).toEqual([K1, K2].sort());
                expect(localStorage.getItem(BLOCKLIST_STORAGE_KEY), where).toBeNull();
                expect([...B.getBlockedUsers()].sort(), where).toEqual([K1, K2].sort());
                expect([...A.getBlockedUsers()].sort(), where).toEqual([K1, K2].sort());
                w.stop();
                stops.splice(0).forEach(stop => stop());
                vi.useRealTimers();
            }
        }
        expect(runs).toEqual([]);
    });

    it.each(['unblock', 'Unblock All'])('the member\'s %s in one tab, of a block another tab is moving up, shows at once', async how => {
        // A's move reaches the node; B's member unblocks K1 before A takes the list off the browser, and the browser's
        // word that A did reaches B while B's unblock is on its way. The node takes the unblock after the move.
        const { A, B } = await twoTabsWithBlocksWaiting(0);
        stops.push(A.startBlocklist(ME));
        await vi.advanceTimersByTimeAsync(170);
        expect(node.list).toEqual([K1, K2]);
        expect(localStorage.getItem(BLOCKLIST_STORAGE_KEY)).not.toBeNull();
        const unblocking = how === 'unblock' ? B.unblockUser(K1) : B.clearBlocklist();
        let done = false;
        void unblocking.then(() => { done = true; });
        const start = Date.now();
        const shownAgain: number[] = [];
        const check = () => { if (done && B.isUserBlocked(K1) && shownAgain.length < 3) shownAgain.push(Date.now() - start); };
        window.addEventListener(BLOCKLIST_UPDATED_EVENT, check);
        for (let t = 0; t < 600; t++) {
            await vi.advanceTimersByTimeAsync(1);
            check();
        }
        window.removeEventListener(BLOCKLIST_UPDATED_EVENT, check);
        await unblocking;
        expect(shownAgain).toEqual([]);
        expect(node.list).toEqual(how === 'unblock' ? [K2] : []);
        expect(B.getBlockedUsers()).toEqual(how === 'unblock' ? [K2] : []);
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

        it('a block made while the one-time move is on its way: the blocks the move took up stay shown when the read drops its answer', async () => {
            node.ringAfter = ringAfter;
            localStorage.setItem(BLOCKLIST_STORAGE_KEY, JSON.stringify([K1, K2]));
            const T = await openTab();
            vi.useFakeTimers();
            // The move's list reaches the node after the block does, and the block's answer (without K1 and K2) comes
            // back first; the read then drops the move's answer, so K1 and K2 are on neither list this page holds.
            node.there = { read: 1, move: 30, add: 1 };
            node.back = { read: 1, move: 1, add: 1 };
            const w = watch(() => [K1, K2]);
            stops.push(T.startBlocklist(ME));
            w.add('T', T);
            let blocking: Promise<boolean> | null = null;
            setTimeout(() => { blocking = T.blockUser(K7); }, 5);
            await w.run(1000);
            w.stop();
            await expect(blocking).resolves.toBe(true);
            expect(w.gaps).toEqual([]);
            expect([...node.list].sort()).toEqual([K1, K2, K7].sort());
            expect([...T.getBlockedUsers()].sort()).toEqual([K1, K2, K7].sort());
            expect(localStorage.getItem(BLOCKLIST_STORAGE_KEY)).toBeNull();
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

    it('a key this page last saw on the node joins leaving too, so it is never shown unblocked while the node holds it (review 4115106774)', async () => {
        // The node holds K1, both tabs show it, the socket is down. C unblocks K1 without A hearing; A's read reaches
        // the node right after (so its answer has no K1) but is slow to land. Meanwhile an older-build tab writes
        // [K1] straight into storage, and C -- hearing that -- moves K1 back up and clears the browser's list before
        // A's stale read lands. A must never show K1 unblocked while the node still holds it.
        node.ringAfter = null;
        node.list = [K1];
        const A = await openTab();
        const C = await openTab();
        vi.useFakeTimers();
        stops.push(browserTellsTabs());
        stops.push(A.startBlocklist(ME));
        stops.push(C.startBlocklist(ME));
        await vi.advanceTimersByTimeAsync(100);
        expect(A.getBlockedUsers()).toEqual([K1]);
        expect(C.getBlockedUsers()).toEqual([K1]);

        const unblocking = C.unblockUser(K1);
        await vi.advanceTimersByTimeAsync(100);
        await unblocking;
        expect(node.list).toEqual([]);
        expect(A.getBlockedUsers()).toEqual([K1]); // A hasn't heard yet

        const w = watch(() => [K1]);
        w.add('A', A);

        // A's read: queued to reach the node at once (no K1) but take 200ms to land. C's storage-triggered read and
        // its move are queued fast, well inside that 200ms.
        node.there = { read: 0, move: 0 };
        node.backQueue.read = [200, 10];
        node.back = { move: 10 };
        A.loadBlocklist().catch(() => { /* said through getBlocklistStatus */ });
        localStorage.setItem(BLOCKLIST_STORAGE_KEY, JSON.stringify([K1]));

        await w.run(1000);
        w.stop();
        expect(w.gaps).toEqual([]);
        expect(node.list).toEqual([K1]);
        expect(A.getBlockedUsers()).toEqual([K1]);
        expect(C.getBlockedUsers()).toEqual([K1]);
    });

    // ── the one-time move never undoes an unblock the member made in this tab, and never sends one they didn't make ──
    // (director's call f8, 2026-09-28: a key's absence from the browser's list never means the member unblocked it)

    /** The removes and Unblock Alls the browser sent. */
    const unblocksSent = () => node.sent.filter(c => /^(remove|clear)\b/.test(c));

    /**
     * One tab loads with K1 and K2 kept in this browser by a build from before, and moves them up: its list of keys is sent at
     * 2 ms, reaches the node at 32 ms and answers at 232 ms. What the member does here reaches the node in 1 ms and answers
     * 1 ms later. Returns at 10 ms, with the list on its way.
     */
    async function oneTabMoving(): Promise<Tab> {
        localStorage.setItem(BLOCKLIST_STORAGE_KEY, JSON.stringify([K1, K2]));
        node.there = { read: 1, move: 30, add: 1, remove: 1, clear: 1 };
        node.back = { read: 1, move: 200, add: 1, remove: 1, clear: 1 };
        const T = await openTab();
        vi.useFakeTimers();
        stops.push(T.startBlocklist(ME));
        await vi.advanceTimersByTimeAsync(10);
        expect(node.sent).toEqual(['read', `move ${K1},${K2}`]);
        expect(node.list).toEqual([]);
        return T;
    }

    /** The member unblocks K1 here, or presses Unblock All, at 10 ms: it reaches the node at 11 ms, before the move's list. */
    async function unblockHere(T: Tab, how: 'unblock' | 'Unblock All'): Promise<void> {
        const unblocking = how === 'unblock' ? T.unblockUser(K1) : T.clearBlocklist();
        await vi.advanceTimersByTimeAsync(5);
        await unblocking;
        expect(node.list).toEqual([]);
        expect(T.getBlockedUsers()).toEqual(how === 'unblock' ? [K2] : []);
    }

    it('an unblock made here while the move\'s list is on its way stands, though it reached the node before that list', async () => {
        const T = await oneTabMoving();
        await unblockHere(T, 'unblock');
        const w = watch(() => [K2], () => [K1]);
        w.add('T', T);
        await w.run(3000);
        w.stop();
        expect(w.gaps).toEqual([]);
        // The list reached the node after the member's remove and blocked K1 again; once it answered, the page took K1 off
        // again, and only K1.
        expect(node.list).toEqual([K2]);
        expect(T.getBlockedUsers()).toEqual([K2]);
        expect(localStorage.getItem(BLOCKLIST_STORAGE_KEY)).toBeNull();
        expect(unblocksSent()).toEqual([`remove ${K1}`, `remove ${K1}`]);
    });

    it('Unblock All pressed here while the move\'s list is on its way stands, though it reached the node before that list', async () => {
        const T = await oneTabMoving();
        await unblockHere(T, 'Unblock All');
        const w = watch(() => [], () => [K1, K2]);
        w.add('T', T);
        await w.run(3000);
        w.stop();
        expect(w.gaps).toEqual([]);
        expect(node.list).toEqual([]);
        expect(T.getBlockedUsers()).toEqual([]);
        expect(localStorage.getItem(BLOCKLIST_STORAGE_KEY)).toBeNull();
        // The keys that list blocked again go one by one: Unblock All isn't sent again, which would take off a block made
        // since, here or on another device.
        expect(unblocksSent()).toEqual(['clear', `remove ${K1}`, `remove ${K2}`]);
    });

    it.each([
        ['unblock', 'K1', K1, [K1, K2], [`remove ${K1}`]],
        ['Unblock All', 'K2', K2, [K2], ['clear', `remove ${K1}`]],
    ] as const)('the member\'s last word here stands: after an %s while the move\'s list is on its way, blocking %s again keeps them blocked', async (how, _name, again, ends, unblocks) => {
        const T = await oneTabMoving();
        await unblockHere(T, how);
        // The list reaches the node at 32 ms and blocks K1 and K2 again; the member blocks `again` here at 100 ms, before
        // it answers.
        await vi.advanceTimersByTimeAsync(85);
        expect([...node.list].sort()).toEqual([K1, K2].sort());
        const blocking = T.blockUser(again);
        await vi.advanceTimersByTimeAsync(5);
        await expect(blocking).resolves.toBe(true);
        // (After Unblock All, the block's answer holds K1, which the move's list blocked again: the page shows it until the
        // node has taken K1 off again, as it shows every block the node holds.)
        const w = watch(() => [...ends]);
        w.add('T', T);
        await w.run(3000);
        w.stop();
        expect(w.gaps).toEqual([]);
        expect([...node.list].sort()).toEqual([...ends].sort());
        expect([...T.getBlockedUsers()].sort()).toEqual([...ends].sort());
        expect(unblocksSent()).toEqual(unblocks);
    });

    it.each([
        ['unblock', 'K1', K1, [K1, K2], [`remove ${K1}`]],
        ['Unblock All', 'K2', K2, [K2], ['clear', `remove ${K1}`]],
    ] as const)('the member\'s last word here stands when their %s answers after the move\'s list: blocking %s again in between keeps them blocked', async (how, _name, again, ends, unblocks) => {
        const T = await oneTabMoving();
        // The list answers at 82 ms; the member's remove (or Unblock All) reaches the node at 11 ms, before the list, but
        // its answer comes back only at 211 ms. At 90 ms, between the two answers, the member blocks `again` here (review
        // of #1269, 4117304623).
        node.back = { ...node.back, move: 50, remove: 200, clear: 200 };
        const unblocking = how === 'unblock' ? T.unblockUser(K1) : T.clearBlocklist();
        await vi.advanceTimersByTimeAsync(80);
        expect([...node.list].sort()).toEqual([K1, K2].sort());
        const blocking = T.blockUser(again);
        await vi.advanceTimersByTimeAsync(5);
        await expect(blocking).resolves.toBe(true);
        await vi.advanceTimersByTimeAsync(3000);
        await expect(unblocking).resolves.toBe(how === 'unblock' ? true : undefined);
        expect([...node.list].sort()).toEqual([...ends].sort());
        expect([...T.getBlockedUsers()].sort()).toEqual([...ends].sort());
        expect(unblocksSent()).toEqual(unblocks);
    });

    it('an unblock made here again after the move\'s list answered is the member\'s own remove: none other is sent for it', async () => {
        const T = await oneTabMoving();
        // As above, but at 90 ms the member unblocks K1 here again, which reaches the node after the list and takes K1 off.
        node.back = { ...node.back, move: 50, remove: 200 };
        const first = T.unblockUser(K1);
        await vi.advanceTimersByTimeAsync(80);
        expect([...node.list].sort()).toEqual([K1, K2].sort());
        const again = T.unblockUser(K1);
        await vi.advanceTimersByTimeAsync(3000);
        await expect(first).resolves.toBe(true);
        await expect(again).resolves.toBe(true);
        expect(node.list).toEqual([K2]);
        expect(T.getBlockedUsers()).toEqual([K2]);
        expect(unblocksSent()).toEqual([`remove ${K1}`, `remove ${K1}`]);
    });

    it('a key the move\'s list found blocked already is not taken off again: a block made on another device after the member\'s unblock here stands', async () => {
        const T = await oneTabMoving();
        const blockElsewhere = (at: string) => { node.list = [...node.list.filter(k => k !== K1), K1]; node.stamps[K1] = at; };
        // At 20 ms the member blocks K1 on another device, so the move's list finds it there at 32 ms and adds only K2.
        // At 100 ms they unblock K1 here, and at 150 ms block K1 on the other device again: that block is their last word.
        setTimeout(() => blockElsewhere('2026-09-28T09:00:00.020Z'), 10);
        let unblocking: Promise<boolean> | null = null;
        setTimeout(() => { unblocking = T.unblockUser(K1); }, 90);
        setTimeout(() => blockElsewhere('2026-09-28T09:00:00.150Z'), 140);
        await vi.advanceTimersByTimeAsync(3000);
        await expect(unblocking).resolves.toBe(true);
        expect(node.list).toEqual([K2, K1]);
        expect(node.stamps[K1]).toBe('2026-09-28T09:00:00.150Z');
        expect(T.getBlockedUsers()).toEqual([K2, K1]);
        expect(unblocksSent()).toEqual([`remove ${K1}`]);
    });

    it('an unblock made here before the move\'s list goes, still unanswered when it does: that list doesn\'t send them', async () => {
        localStorage.setItem(BLOCKLIST_STORAGE_KEY, JSON.stringify([K1, K2]));
        // The member's remove reaches the node at 2 ms, as the read answers, and its own answer takes 100 ms: the move's
        // list goes meanwhile.
        node.there = { read: 1, move: 30, remove: 1 };
        node.back = { read: 1, move: 200, remove: 100 };
        const T = await openTab();
        vi.useFakeTimers();
        stops.push(T.startBlocklist(ME));
        await vi.advanceTimersByTimeAsync(1);
        const unblocking = T.unblockUser(K1);
        const w = watch(() => [K2]);
        w.add('T', T);
        await w.run(3000);
        w.stop();
        await expect(unblocking).resolves.toBe(true);
        expect(w.gaps).toEqual([]);
        expect(node.sent.filter(c => c.startsWith('move') || c.startsWith('add'))).toEqual([`move ${K2}`]);
        expect(node.list).toEqual([K2]);
        expect(T.getBlockedUsers()).toEqual([K2]);
        expect(localStorage.getItem(BLOCKLIST_STORAGE_KEY)).toBeNull();
        expect(unblocksSent()).toEqual([`remove ${K1}`]);
    });

    it.each([0, 10, 100, 240])('another tab loading at %i ms while one moves the list up: no unblock is sent, and the node keeps every block', async bAt => {
        localStorage.setItem(BLOCKLIST_STORAGE_KEY, JSON.stringify([K1, K2]));
        node.there = { read: 1, move: 30 };
        node.back = { read: 1, move: 200 };
        const A = await openTab();
        const B = await openTab();
        vi.useFakeTimers();
        stops.push(browserTellsTabs());
        stops.push(A.startBlocklist(ME));
        setTimeout(() => { stops.push(B.startBlocklist(ME)); }, bAt);
        const w = watch(() => [K1, K2]);
        w.add('A', A);
        w.add('B', B);
        await w.run(5000);
        w.stop();
        expect(w.gaps).toEqual([]);
        expect([...node.list].sort()).toEqual([K1, K2].sort());
        expect(unblocksSent()).toEqual([]);
        expect(localStorage.getItem(BLOCKLIST_STORAGE_KEY)).toBeNull();
    });

    it('a page reloaded while its move is on its way: no unblock is sent, and the node keeps every block', async () => {
        localStorage.setItem(BLOCKLIST_STORAGE_KEY, JSON.stringify([K1, K2]));
        node.there = { read: 1, move: 30 };
        node.back = { read: 1, move: 200 };
        const before = await openTab();
        const after = await openTab();
        vi.useFakeTimers();
        stops.push(browserTellsTabs());
        const stopBefore = before.startBlocklist(ME);
        await vi.advanceTimersByTimeAsync(10);
        expect(node.sent).toEqual(['read', `move ${K1},${K2}`]);
        // The page reloads: its list of keys was sent and still reaches the node; the page that loads knows nothing of it.
        stopBefore();
        stops.push(after.startBlocklist(ME));
        const w = watch(() => [K1, K2]);
        w.add('after', after);
        await w.run(5000);
        w.stop();
        expect(w.gaps).toEqual([]);
        expect([...node.list].sort()).toEqual([K1, K2].sort());
        expect(unblocksSent()).toEqual([]);
        expect(localStorage.getItem(BLOCKLIST_STORAGE_KEY)).toBeNull();
    });

    it('another account signing in on this page while the move is on its way: nothing is taken off its list for the one before', async () => {
        const OTHER = 'f6'.repeat(32);
        const T = await oneTabMoving();
        await unblockHere(T, 'unblock');
        // Before the move's list answers, another account signs in here. It has blocked K1 and K8 itself.
        node.signedIn = 'other';
        node.others.other = [K1, K8];
        stops.splice(0).forEach(stop => stop());
        stops.push(T.startBlocklist(OTHER));
        await vi.advanceTimersByTimeAsync(3000);
        expect(node.others.other).toEqual([K1, K8]);
        expect(T.getBlockedUsers()).toEqual([K1, K8]);
        expect(node.sent.filter(c => c.endsWith('as other') && !c.startsWith('read'))).toEqual([]);
        expect(unblocksSent()).toEqual([`remove ${K1}`]);
        // What ME's move sent is ME's: K2 stays blocked for ME. (K1 is blocked again there too: the page left ME's account
        // before it could take it off, which errs toward blocked; ME sees it and can lift it.)
        expect(node.list).toContain(K2);
    });

    // #1269 review 4117583339: blockUser waits for a take-off-again of that key already on its way, or the block reaches the
    // node first as a no-op (the move still holds the key) and the remove then takes it off.
    it.each(['unblock', 'Unblock All'] as const)('a block made here while the take-off-again of that key is on its way stands (%s)', async (how) => {
        const T = await oneTabMoving();
        await unblockHere(T, how);
        node.there = { ...node.there, remove: 60 }; // the take-off-again goes at 232 ms and lands at ~292 ms
        await vi.advanceTimersByTimeAsync(225);
        const blocking = T.blockUser(K1); // ~240 ms, while that remove is on its way
        await vi.advanceTimersByTimeAsync(3000);
        await expect(blocking).resolves.toBe(true);
        expect(node.list).toContain(K1);
        expect(T.getBlockedUsers()).toContain(K1);
    });

    describe('a take-off-again that doesn\'t reach the node', () => {
        /** Each remove from here on is lost on the way, until `lossy` is false: the connection comes and goes. */
        let lossy = true;
        let tries = 0;

        /** The member unblocks K1 while the list is on its way; every take-off-again of K1 is then lost until the connection is back. */
        async function takeOffAgainLost(): Promise<Tab> {
            const T = await oneTabMoving();
            await unblockHere(T, 'unblock');
            lossy = true;
            node.arrive = kind => kind === 'remove' && lossy;
            await vi.advanceTimersByTimeAsync(1000);
            // K1 is blocked again on the node, and the page shows what the node holds.
            expect(node.list).toEqual([K1, K2]);
            expect(T.getBlockedUsers()).toEqual([K1, K2]);
            tries = node.sent.filter(c => c === `remove ${K1}`).length;
            expect(tries).toBeGreaterThanOrEqual(2);
            lossy = false;
            return T;
        }

        it('stays owed in this page, and the next read sends it again', async () => {
            const T = await takeOffAgainLost();
            T.loadBlocklist().catch(() => { /* said through getBlocklistStatus */ });
            await vi.advanceTimersByTimeAsync(1000);
            expect(node.list).toEqual([K2]);
            expect(T.getBlockedUsers()).toEqual([K2]);
            expect(node.sent.filter(c => c === `remove ${K1}`)).toHaveLength(tries + 1);
            expect(unblocksSent().every(c => c === `remove ${K1}`)).toBe(true);
        });

        it('is let go once K1 is blocked again on another device: that block is a new one, and stays', async () => {
            const T = await takeOffAgainLost();
            // On another device the member lifts the block the move made again, and then blocks K1 anew.
            node.list = [...node.list.filter(k => k !== K1), K1];
            node.stamps[K1] = '2026-09-28T09:00:00.000Z';
            T.loadBlocklist().catch(() => { /* said through getBlocklistStatus */ });
            await vi.advanceTimersByTimeAsync(1000);
            expect(node.list).toEqual([K2, K1]);
            expect(T.getBlockedUsers()).toEqual([K2, K1]);
            expect(node.sent.filter(c => c === `remove ${K1}`)).toHaveLength(tries);
        });

        it('is let go once the member blocks K1 again here', async () => {
            const T = await takeOffAgainLost();
            const blocking = T.blockUser(K1);
            await vi.advanceTimersByTimeAsync(5);
            await expect(blocking).resolves.toBe(true);
            T.loadBlocklist().catch(() => { /* said through getBlocklistStatus */ });
            await vi.advanceTimersByTimeAsync(1000);
            expect(node.list).toEqual([K1, K2]);
            expect(T.getBlockedUsers()).toEqual([K1, K2]);
            expect(node.sent.filter(c => c === `remove ${K1}`)).toHaveLength(tries);
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
});
