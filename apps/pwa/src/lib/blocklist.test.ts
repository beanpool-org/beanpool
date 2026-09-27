/**
 * The block list the community keeps for the account (Marty's card web-blocklist-where, 2026-09-27): read from the node
 * after sign-in, moved up once from a list an older build kept in this browser, changed only when the node takes the
 * change, and never kept in the browser beyond the page's memory.
 *
 * lib/api is replaced by a stand-in node holding one account's list, which can be unreachable or refuse.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const node = vi.hoisted(() => ({
    list: [] as string[],
    max: 500,
    /** Every request fails as a dropped connection does (a fetch that throws, no status). */
    down: false,
    /** Every change is refused with this status and words, as the node answers one. */
    refuse: null as null | { status: number; error: string; code?: string },
    /** Keys the node has no row for: a list of keys (the one-time move) skips them and counts them. */
    unknown: [] as string[],
    calls: [] as string[],
    /** Runs as each add reaches the node, before it is taken: to look at the browser then, or to fail that one add. */
    onAdd: null as null | ((keys: string | string[]) => void),
    /** Rings the member's doorbell after each change it takes, as the real node does (routes/blocks.ts), so the next read really happens. */
    rings: false,
}));

vi.mock('./api', async () => {
    const { ringBlocklistDoorbell } = await import('./blocklist-doorbell');
    const ring = (changed: boolean) => { if (node.rings && changed) ringBlocklistDoorbell(); };
    const answer = () => ({ blocked: node.list.map(k => ({ publicKey: k, blockedAt: '2026-09-27T00:00:00.000Z' })), max: node.max });
    const fail = () => {
        if (node.down) throw new TypeError('Failed to fetch');
        if (node.refuse) throw Object.assign(new Error(node.refuse.error), { status: node.refuse.status, code: node.refuse.code });
    };
    return {
        reportAbuse: vi.fn(async () => ({ success: true })),
        getBlockList: vi.fn(async () => {
            node.calls.push('read');
            if (node.down) throw new TypeError('Failed to fetch');
            return answer();
        }),
        addToBlockList: vi.fn(async (keys: string | string[]) => {
            node.calls.push(`add ${JSON.stringify(keys)}`);
            node.onAdd?.(keys);
            fail();
            const ks = Array.isArray(keys) ? keys.filter(k => !node.unknown.includes(k)) : [keys];
            const fresh = ks.filter(k => !node.list.includes(k));
            if (node.list.length + fresh.length > node.max) throw Object.assign(new Error('You can block up to 500 people. Unblock someone to block another.'), { status: 409, code: 'block_limit' });
            node.list.push(...fresh);
            ring(fresh.length > 0);
            return { ...answer(), added: fresh, ...(Array.isArray(keys) ? { skipped: keys.length - ks.length } : {}) };
        }),
        removeFromBlockList: vi.fn(async (key: string) => {
            node.calls.push(`remove ${key}`);
            fail();
            const removed = node.list.includes(key);
            node.list = node.list.filter(k => k !== key);
            ring(removed);
            return { ...answer(), removed };
        }),
        clearBlockList: vi.fn(async () => {
            node.calls.push('clear');
            fail();
            const removed = node.list.length;
            node.list = [];
            ring(removed > 0);
            return { ...answer(), removed };
        }),
    };
});

import {
    getBlockedUsers,
    isUserBlocked,
    blockUser,
    unblockUser,
    clearBlocklist,
    startBlocklist,
    loadBlocklist,
    getBlocklistStatus,
    getBlocklistFullNote,
    getPendingReports,
    onBlocklistUpdated,
    retryPendingReports,
    resetBlocklistForTests,
    BlocklistError,
    BLOCKLIST_STORAGE_KEY,
    LEGACY_BLOCKLIST_KEY,
    PENDING_REPORTS_KEY,
} from './blocklist';
import { ringBlocklistDoorbell } from './blocklist-doorbell';
import * as api from './api';

const ME = 'a1'.repeat(32);
const [K1, K2, K3, K4] = ['b2', 'c3', 'd4', 'e5'].map(p => p.repeat(32));
/** Everything this browser keeps that is about blocks. */
const storedAboutBlocks = () => Object.keys(localStorage).filter(k => /block|abuse/i.test(k));
const settle = () => new Promise(r => setTimeout(r, 0));
/** Until the stand-in node has heard nothing more for a while: every read a doorbell brought has ended. */
async function quiet(): Promise<void> {
    let seen = -1;
    while (seen !== node.calls.length) {
        seen = node.calls.length;
        for (let i = 0; i < 5; i++) await settle();
    }
}
/** What a tab still on the build from before does when the member blocks or unblocks there: writes its whole list to both keys. */
const olderBuildWrites = (list: string[]) => {
    localStorage.setItem(BLOCKLIST_STORAGE_KEY, JSON.stringify(list));
    localStorage.setItem(LEGACY_BLOCKLIST_KEY, JSON.stringify(list));
};
const X = 'f8'.repeat(32);

describe('the block list the community keeps for the account', () => {
    beforeEach(() => {
        localStorage.clear();
        resetBlocklistForTests();
        node.list = [];
        node.max = 500;
        node.down = false;
        node.refuse = null;
        node.unknown = [];
        node.calls = [];
        node.onAdd = null;
        node.rings = false;
        vi.clearAllMocks();
    });

    it('after signing in on a fresh browser, the list comes from the node, and nothing about it is kept in the browser', async () => {
        node.list = [K1, K2];
        expect(getBlockedUsers()).toEqual([]);
        const told: string[][] = [];
        const off = onBlocklistUpdated(l => told.push(l));
        const stop = startBlocklist(ME);
        await vi.waitFor(() => expect(getBlockedUsers()).toEqual([K1, K2]));
        expect(isUserBlocked(K1)).toBe(true);
        expect(isUserBlocked(K3)).toBe(false);
        expect(told.at(-1)).toEqual([K1, K2]);
        expect(getBlocklistStatus()).toEqual({ loaded: true, error: null });
        expect(api.addToBlockList).not.toHaveBeenCalled();
        expect(storedAboutBlocks()).toEqual([]);
        stop();
        off();
    });

    it('the node rings (another tab, another device, the socket back): the list is read again', async () => {
        node.list = [K1];
        startBlocklist(ME);
        await vi.waitFor(() => expect(getBlockedUsers()).toEqual([K1]));
        node.list = [K1, K2];
        ringBlocklistDoorbell();
        await vi.waitFor(() => expect(getBlockedUsers()).toEqual([K1, K2]));
        expect(node.calls.filter(c => c === 'read')).toHaveLength(2);
    });

    it('a read that changes nothing tells the screens nothing; one that changes the list, or ends a failed read, does', async () => {
        node.list = [K1];
        startBlocklist(ME);
        await vi.waitFor(() => expect(getBlockedUsers()).toEqual([K1]));
        const told: string[][] = [];
        const off = onBlocklistUpdated(l => told.push(l));
        await loadBlocklist();
        ringBlocklistDoorbell();
        await vi.waitFor(() => expect(node.calls.filter(c => c === 'read')).toHaveLength(3));
        await settle();
        expect(told).toEqual([]);
        node.list = [K1, K2];
        await loadBlocklist();
        expect(told).toEqual([[K1, K2]]);
        node.down = true;
        await expect(loadBlocklist()).rejects.toBeInstanceOf(BlocklistError);
        node.down = false;
        await loadBlocklist();
        expect(told).toHaveLength(3);
        expect(getBlocklistStatus()).toEqual({ loaded: true, error: null });
        off();
    });

    it('the one-time move: a key the node has no row for goes up on its own, as a block made now does, and only then do the local keys go', async () => {
        // K2: an author from a connected community's board, blocked through the Market's peer browse on an older build.
        // Of a list the node takes only the keys it has a row for; a member's blocks are never dropped with nothing said.
        node.unknown = [K2];
        localStorage.setItem(BLOCKLIST_STORAGE_KEY, JSON.stringify([K1, K2, K3]));
        const keptWhenSent: (string | null)[] = [];
        node.onAdd = () => { keptWhenSent.push(localStorage.getItem(BLOCKLIST_STORAGE_KEY)); };
        const told: string[][] = [];
        const off = onBlocklistUpdated(l => told.push(l));
        startBlocklist(ME);
        await vi.waitFor(() => expect(localStorage.getItem(BLOCKLIST_STORAGE_KEY)).toBeNull());
        expect(node.calls).toEqual(['read', `add ${JSON.stringify([K1, K2, K3])}`, `add ${JSON.stringify(K2)}`]);
        // The local list was still there when each add went: it is deleted only once K2 is on the node's list too.
        expect(keptWhenSent).toEqual([JSON.stringify([K1, K2, K3]), JSON.stringify([K1, K2, K3])]);
        expect(node.list).toEqual([K1, K3, K2]);
        expect(getBlockedUsers()).toEqual([K1, K3, K2]);
        expect(told).toEqual([[K1, K2, K3], [K1, K3, K2]]);
        expect(storedAboutBlocks()).toEqual([]);
        off();
    });

    it('a key that could not go up on its own stays in the browser, still hiding them, and the next read sends it', async () => {
        node.unknown = [K2, K3];
        localStorage.setItem(BLOCKLIST_STORAGE_KEY, JSON.stringify([K1, K2, K3]));
        // The connection drops as K2 goes up on its own.
        node.onAdd = keys => { if (keys === K2) throw new TypeError('Failed to fetch'); };
        const told: string[][] = [];
        const off = onBlocklistUpdated(l => told.push(l));
        startBlocklist(ME);
        await vi.waitFor(() => expect(node.calls).toContain(`add ${JSON.stringify(K2)}`));
        await settle();
        // The first that fails stops the rest: K3 waits with it, untried.
        expect(node.calls).toEqual(['read', `add ${JSON.stringify([K1, K2, K3])}`, `add ${JSON.stringify(K2)}`]);
        expect(node.list).toEqual([K1]);
        expect(JSON.parse(localStorage.getItem(BLOCKLIST_STORAGE_KEY)!)).toEqual([K2, K3]);
        expect(isUserBlocked(K2) && isUserBlocked(K3)).toBe(true);
        expect(getBlocklistStatus()).toEqual({ loaded: true, error: null });

        // The next read (the node's doorbell, the socket back, the next page) sends what is left.
        node.onAdd = null;
        await loadBlocklist();
        expect(node.calls.slice(3)).toEqual(['read', `add ${JSON.stringify([K2, K3])}`, `add ${JSON.stringify(K2)}`, `add ${JSON.stringify(K3)}`]);
        expect(localStorage.getItem(BLOCKLIST_STORAGE_KEY)).toBeNull();
        expect(node.list).toEqual([K1, K2, K3]);
        expect(getBlockedUsers()).toEqual([K1, K2, K3]);
        // Nothing on the way showed any of them unblocked.
        expect(told.length).toBeGreaterThan(0);
        expect(told.every(l => [K1, K2, K3].every(k => l.includes(k)))).toBe(true);
        expect(storedAboutBlocks()).toEqual([]);
        off();
    });

    it('a key the full list refuses on its own stays in the browser, still blocked, and goes up once there is room', async () => {
        const K5 = 'f7'.repeat(32);
        node.max = 3;
        node.list = [K4];
        node.unknown = [K2];
        localStorage.setItem(BLOCKLIST_STORAGE_KEY, JSON.stringify([K1, K2]));
        // Meanwhile the member blocks K5 on another device, so the list is full when K2 goes up on its own.
        node.onAdd = keys => { if (Array.isArray(keys)) node.list.push(K5); };
        const told: string[][] = [];
        const off = onBlocklistUpdated(l => told.push(l));
        startBlocklist(ME);
        await vi.waitFor(() => expect(node.calls).toContain(`add ${JSON.stringify(K2)}`));
        await settle();
        expect(node.list).toEqual([K4, K5, K1]);
        expect(JSON.parse(localStorage.getItem(BLOCKLIST_STORAGE_KEY)!)).toEqual([K2]);
        expect(isUserBlocked(K2)).toBe(true);
        expect(getBlocklistStatus()).toEqual({ loaded: true, error: null });

        node.onAdd = null;
        await unblockUser(K5);
        expect(isUserBlocked(K2)).toBe(true);
        await loadBlocklist();
        expect(node.list).toEqual([K4, K1, K2]);
        expect(localStorage.getItem(BLOCKLIST_STORAGE_KEY)).toBeNull();
        expect(getBlockedUsers()).toEqual([K4, K1, K2]);
        expect(told.length).toBeGreaterThan(0);
        expect(told.every(l => l.includes(K2))).toBe(true);
        off();
    });

    it('a key the member unblocks while the move is under way is not blocked again by it', async () => {
        node.unknown = [K2, K3];
        localStorage.setItem(BLOCKLIST_STORAGE_KEY, JSON.stringify([K1, K2, K3]));
        let unblocking: Promise<boolean> | null = null;
        node.onAdd = keys => { if (keys === K2 && !unblocking) unblocking = unblockUser(K3); };
        startBlocklist(ME);
        await vi.waitFor(() => expect(localStorage.getItem(BLOCKLIST_STORAGE_KEY)).toBeNull());
        await unblocking;
        await settle();
        expect(node.calls).not.toContain(`add ${JSON.stringify(K3)}`);
        expect(node.list).toEqual([K1, K2]);
        expect(isUserBlocked(K3)).toBe(false);
    });

    // ── other tabs: the list kept in this browser is read again whenever it is changed, never rewritten from this page's copy ──

    it('a block a tab still on the build from before makes while the move is under way survives it, and goes up too', async () => {
        // A tab opened before the deploy runs the old build until it is reloaded. The member blocks X there while this tab's
        // move is on its way to the node.
        localStorage.setItem(BLOCKLIST_STORAGE_KEY, JSON.stringify([K1]));
        node.onAdd = keys => { if (Array.isArray(keys) && !keys.includes(X)) olderBuildWrites([K1, X]); };
        startBlocklist(ME);
        await vi.waitFor(() => expect(getBlocklistStatus().loaded).toBe(true));
        await quiet();
        expect(node.list).toEqual([K1, X]);
        expect(node.calls).toEqual(['read', `add ${JSON.stringify([K1])}`, `add ${JSON.stringify([X])}`]);
        expect(isUserBlocked(X)).toBe(true);
        expect(storedAboutBlocks()).toEqual([]);
    });

    it('a block the older build makes while a key fails to go up on its own stays with it, and the next read sends both', async () => {
        node.unknown = [K2];
        localStorage.setItem(BLOCKLIST_STORAGE_KEY, JSON.stringify([K1, K2]));
        // The member blocks X in the older tab, and then the connection drops as K2 goes up on its own.
        node.onAdd = keys => {
            if (keys !== K2) return;
            olderBuildWrites([K1, K2, X]);
            throw new TypeError('Failed to fetch');
        };
        startBlocklist(ME);
        await vi.waitFor(() => expect(getBlocklistStatus().loaded).toBe(true));
        await quiet();
        expect(node.list).toEqual([K1]);
        expect(JSON.parse(localStorage.getItem(BLOCKLIST_STORAGE_KEY)!)).toEqual([K2, X]);
        expect(isUserBlocked(K2) && isUserBlocked(X)).toBe(true);

        node.onAdd = null;
        await loadBlocklist();
        expect(node.list).toEqual([K1, X, K2]);
        expect(getBlockedUsers()).toEqual([K1, X, K2]);
        expect(storedAboutBlocks()).toEqual([]);
    });

    it('another tab\'s unblock of a key still waiting to go up is honoured while the move is under way: it is not sent', async () => {
        node.unknown = [K2, K3];
        localStorage.setItem(BLOCKLIST_STORAGE_KEY, JSON.stringify([K1, K2, K3]));
        // As K2 goes up on its own, the member unblocks K3 in another tab, which takes K3 off the list kept here.
        node.onAdd = keys => { if (keys === K2) localStorage.setItem(BLOCKLIST_STORAGE_KEY, JSON.stringify([K1, K2])); };
        startBlocklist(ME);
        await vi.waitFor(() => expect(getBlocklistStatus().loaded).toBe(true));
        await quiet();
        expect(node.calls).not.toContain(`add ${JSON.stringify(K3)}`);
        expect(node.list).toEqual([K1, K2]);
        expect(isUserBlocked(K3)).toBe(false);
        expect(storedAboutBlocks()).toEqual([]);
    });

    it('another tab\'s unblock of a key still waiting in this browser is honoured by this page\'s next read: it is not sent', async () => {
        node.unknown = [K2];
        localStorage.setItem(BLOCKLIST_STORAGE_KEY, JSON.stringify([K1, K2]));
        node.onAdd = keys => { if (keys === K2) throw new TypeError('Failed to fetch'); };
        startBlocklist(ME);
        await vi.waitFor(() => expect(getBlocklistStatus().loaded).toBe(true));
        await quiet();
        expect(JSON.parse(localStorage.getItem(BLOCKLIST_STORAGE_KEY)!)).toEqual([K2]);
        expect(isUserBlocked(K2)).toBe(true);

        // In another tab the member unblocks K2, which takes it off the list kept here (the last key: the list goes).
        node.onAdd = null;
        localStorage.removeItem(BLOCKLIST_STORAGE_KEY);
        await loadBlocklist();
        expect(node.calls.filter(c => c === `add ${JSON.stringify(K2)}`)).toHaveLength(1);
        expect(node.list).toEqual([K1]);
        expect(isUserBlocked(K2)).toBe(false);
        expect(storedAboutBlocks()).toEqual([]);
    });

    it('when another tab changes the list kept here, this page shows it at once and sends what is new', async () => {
        node.list = [K1];
        startBlocklist(ME);
        await vi.waitFor(() => expect(getBlockedUsers()).toEqual([K1]));
        const told: string[][] = [];
        const off = onBlocklistUpdated(l => told.push(l));
        // After the move, the member blocks X in a tab still on the build from before; the browser tells this page.
        olderBuildWrites([K1, X]);
        window.dispatchEvent(new StorageEvent('storage', { key: BLOCKLIST_STORAGE_KEY }));
        expect(isUserBlocked(X)).toBe(true);
        await quiet();
        expect(node.list).toEqual([K1, X]);
        expect(getBlockedUsers()).toEqual([K1, X]);
        expect(told.every(l => l.includes(X))).toBe(true);
        expect(storedAboutBlocks()).toEqual([]);
        off();
    });

    // ── the node's limit: a block that doesn't fit stays in this browser, still blocked, and the member is told ──

    it('at the limit, with the node ringing after each change, a key the full list refuses stays blocked here, is said, and goes up once there is room', async () => {
        const K5 = 'f7'.repeat(32);
        node.rings = true;
        node.max = 3;
        node.list = [K4];
        node.unknown = [K2];
        localStorage.setItem(BLOCKLIST_STORAGE_KEY, JSON.stringify([K1, K2]));
        // Meanwhile the member blocks K5 on another device (the node rings for that too), so the list is full when K2
        // goes up on its own. The bulk add's own doorbell brings another read at once, with the list still full.
        node.onAdd = keys => { if (Array.isArray(keys) && !node.list.includes(K5)) { node.list.push(K5); ringBlocklistDoorbell(); } };
        const told: string[][] = [];
        const off = onBlocklistUpdated(l => told.push(l));
        startBlocklist(ME);
        await vi.waitFor(() => expect(node.calls).toEqual(['read', `add ${JSON.stringify([K1, K2])}`, `add ${JSON.stringify(K2)}`, 'read']));
        await quiet();
        expect(node.list).toEqual([K4, K5, K1]);
        expect(JSON.parse(localStorage.getItem(BLOCKLIST_STORAGE_KEY)!)).toEqual([K2]);
        expect(isUserBlocked(K2)).toBe(true);
        expect(getBlocklistStatus()).toEqual({ loaded: true, error: null });
        expect(getBlocklistFullNote()).toBe('Your block list is full, so 1 block is kept in this browser only. Unblock someone to make room for it.');

        // The member unblocks K5: the node rings, and the read that follows sends K2 now there is room.
        node.onAdd = null;
        await unblockUser(K5);
        await quiet();
        expect(node.list).toEqual([K4, K1, K2]);
        expect(localStorage.getItem(BLOCKLIST_STORAGE_KEY)).toBeNull();
        expect(getBlockedUsers()).toEqual([K4, K1, K2]);
        expect(getBlocklistFullNote()).toBeNull();
        // Nothing on the way showed K2 unblocked.
        expect(told.length).toBeGreaterThan(0);
        expect(told.every(l => l.includes(K2))).toBe(true);
        off();
    });

    it('a list an older build kept in this browser moves up to the signed-in account once, then the local keys are gone', async () => {
        node.list = [K4];
        localStorage.setItem(BLOCKLIST_STORAGE_KEY, JSON.stringify([K1, K2, 'not-a-key', ME, K4]));
        localStorage.setItem(LEGACY_BLOCKLIST_KEY, JSON.stringify([K2, K3]));
        // Before the move, the old list still hides whom it names.
        expect(getBlockedUsers()).toEqual(expect.arrayContaining([K1, K2, K3]));
        startBlocklist(ME);
        await vi.waitFor(() => expect(localStorage.getItem(BLOCKLIST_STORAGE_KEY)).toBeNull());
        expect(localStorage.getItem(LEGACY_BLOCKLIST_KEY)).toBeNull();
        expect(api.addToBlockList).toHaveBeenCalledTimes(1);
        expect(api.addToBlockList).toHaveBeenCalledWith([K1, K2, K3]);
        expect(node.list).toEqual([K4, K1, K2, K3]);
        expect(getBlockedUsers()).toEqual([K4, K1, K2, K3]);
        expect(storedAboutBlocks()).toEqual([]);
        // Read again: nothing left to move.
        await loadBlocklist();
        expect(api.addToBlockList).toHaveBeenCalledTimes(1);
    });

    it('a move the node did not take leaves the old list in the browser, still hiding them, and the next read moves it', async () => {
        localStorage.setItem(BLOCKLIST_STORAGE_KEY, JSON.stringify([K1, K2]));
        node.refuse = { status: 403, error: 'Only members of this community can do this.', code: 'not_a_member' };
        startBlocklist(ME);
        await vi.waitFor(() => expect(api.addToBlockList).toHaveBeenCalledTimes(1));
        await settle();
        expect(JSON.parse(localStorage.getItem(BLOCKLIST_STORAGE_KEY)!)).toEqual([K1, K2]);
        expect(isUserBlocked(K1) && isUserBlocked(K2)).toBe(true);
        node.refuse = null;
        await loadBlocklist();
        expect(localStorage.getItem(BLOCKLIST_STORAGE_KEY)).toBeNull();
        expect(node.list).toEqual([K1, K2]);
        expect(getBlockedUsers()).toEqual([K1, K2]);
    });

    it('past the node\'s limit, the newest the list has room for move up, and the rest stay in this browser, still blocked, until there is room', async () => {
        // This test used to expect the local keys gone and K1 shown unblocked: a block dropped with nothing said, which
        // Marty's decision ranks worst (director's call f8, fix round 3). K1 now stays here and goes up once there is room.
        node.rings = true;
        node.max = 3;
        node.list = [K4];
        localStorage.setItem(BLOCKLIST_STORAGE_KEY, JSON.stringify([K1, K2, K3]));
        startBlocklist(ME);
        await vi.waitFor(() => expect(api.addToBlockList).toHaveBeenCalled());
        await quiet();
        expect(api.addToBlockList).toHaveBeenCalledWith([K2, K3]);
        expect(api.addToBlockList).toHaveBeenCalledTimes(1);
        expect(node.list).toEqual([K4, K2, K3]);
        expect(JSON.parse(localStorage.getItem(BLOCKLIST_STORAGE_KEY)!)).toEqual([K1]);
        expect(getBlockedUsers()).toEqual([K4, K2, K3, K1]);
        expect(getBlocklistFullNote()).toBe('Your block list is full, so 1 block is kept in this browser only. Unblock someone to make room for it.');

        await unblockUser(K4);
        await quiet();
        expect(node.list).toEqual([K2, K3, K1]);
        expect(localStorage.getItem(BLOCKLIST_STORAGE_KEY)).toBeNull();
        expect(getBlockedUsers()).toEqual([K2, K3, K1]);
        expect(getBlocklistFullNote()).toBeNull();
    });

    it('Unblock All takes off what was waiting in this browser too, and keeps a block another tab made meanwhile', async () => {
        localStorage.setItem(BLOCKLIST_STORAGE_KEY, JSON.stringify([K1, K2]));
        node.down = true;
        startBlocklist(ME);
        await vi.waitFor(() => expect(getBlocklistStatus().error).not.toBeNull());
        node.down = false;
        node.list = [K3];
        // While Unblock All is on its way, the member blocks X in a tab still on the build from before.
        vi.mocked(api.clearBlockList).mockImplementationOnce(async () => {
            olderBuildWrites([K1, K2, X]);
            node.list = [];
            return { blocked: [], max: node.max, removed: 1 };
        });
        await clearBlocklist();
        expect(JSON.parse(localStorage.getItem(BLOCKLIST_STORAGE_KEY)!)).toEqual([X]);
        expect(getBlockedUsers()).toEqual([X]);
        await loadBlocklist();
        expect(node.list).toEqual([X]);
        expect(storedAboutBlocks()).toEqual([]);
    });

    it('Unblock All resets clearedAll flag so subsequent moves do not unexpectedly clear the community list', async () => {
        node.list = [K1];
        startBlocklist(ME);
        await vi.waitFor(() => expect(getBlockedUsers()).toEqual([K1]));
        await clearBlocklist();
        expect(node.list).toEqual([]);

        // New blocks appear in local storage from another tab/build
        localStorage.setItem(BLOCKLIST_STORAGE_KEY, JSON.stringify([K2]));
        vi.clearAllMocks();
        await loadBlocklist();

        expect(api.clearBlockList).not.toHaveBeenCalled();
        expect(api.addToBlockList).toHaveBeenCalledWith([K2]);
        expect(node.list).toEqual([K2]);
    });

    it('a block, an unblock and Unblock All show once the node has taken them, and keep nothing in the browser', async () => {
        startBlocklist(ME);
        await vi.waitFor(() => expect(getBlocklistStatus().loaded).toBe(true));
        const told: string[][] = [];
        const off = onBlocklistUpdated(l => told.push(l));
        await expect(blockUser(K1)).resolves.toBe(true);
        await blockUser(K1);
        await blockUser(K2);
        expect(getBlockedUsers()).toEqual([K1, K2]);
        expect(node.list).toEqual([K1, K2]);
        await expect(unblockUser(K1)).resolves.toBe(true);
        expect(getBlockedUsers()).toEqual([K2]);
        await clearBlocklist();
        expect(getBlockedUsers()).toEqual([]);
        expect(told.map(l => l.length)).toEqual([1, 1, 2, 1, 0]);
        expect(storedAboutBlocks()).toEqual([]);
        off();
    });

    it('a block the node did not take is not shown as done: it throws, in plain words, and nothing changes', async () => {
        node.list = [K2];
        startBlocklist(ME);
        await vi.waitFor(() => expect(getBlockedUsers()).toEqual([K2]));
        const told: string[][] = [];
        const off = onBlocklistUpdated(l => told.push(l));

        node.down = true;
        const offline = await blockUser(K1, ME, 'Harassment').catch(e => e);
        expect(offline).toBeInstanceOf(BlocklistError);
        expect(offline.message).toBe('Couldn’t reach your community, so they are not blocked. Check your connection and try again.');
        expect(isUserBlocked(K1)).toBe(false);
        expect(api.reportAbuse).not.toHaveBeenCalled();

        node.down = false;
        node.refuse = { status: 409, error: 'You can block up to 500 people. Unblock someone to block another.', code: 'block_limit' };
        const refused = await blockUser(K1).catch(e => e);
        expect(refused).toBeInstanceOf(BlocklistError);
        expect(refused.message).toBe('You can block up to 500 people. Unblock someone to block another.');
        expect(refused.code).toBe('block_limit');
        expect(isUserBlocked(K1)).toBe(false);

        expect(told).toEqual([]);
        expect(getBlockedUsers()).toEqual([K2]);
        expect(storedAboutBlocks()).toEqual([]);
        off();
    });

    it('an unblock or Unblock All the node did not take leaves them blocked and says so', async () => {
        node.list = [K1, K2];
        startBlocklist(ME);
        await vi.waitFor(() => expect(getBlockedUsers()).toEqual([K1, K2]));
        node.down = true;
        const u = await unblockUser(K1).catch(e => e);
        expect(u).toBeInstanceOf(BlocklistError);
        expect(u.message).toBe('Couldn’t reach your community, so they are still blocked. Check your connection and try again.');
        const c = await clearBlocklist().catch(e => e);
        expect(c).toBeInstanceOf(BlocklistError);
        expect(c.message).toBe('Couldn’t reach your community, so nobody was unblocked. Check your connection and try again.');
        expect(getBlockedUsers()).toEqual([K1, K2]);
        expect(isUserBlocked(K1)).toBe(true);
    });

    it('a read that failed is said, and the list is not taken to be empty', async () => {
        node.down = true;
        startBlocklist(ME);
        await vi.waitFor(() => expect(getBlocklistStatus().error).not.toBeNull());
        expect(getBlocklistStatus()).toEqual({ loaded: false, error: 'Couldn’t load your blocked members from your community. Check your connection and try again.' });
        await expect(loadBlocklist()).rejects.toBeInstanceOf(BlocklistError);
        node.down = false;
        node.list = [K1];
        await loadBlocklist();
        expect(getBlocklistStatus()).toEqual({ loaded: true, error: null });
        expect(getBlockedUsers()).toEqual([K1]);
    });

    it('unblocking someone the old browser list still names takes them off it too, so the move never blocks them again', async () => {
        localStorage.setItem(BLOCKLIST_STORAGE_KEY, JSON.stringify([K1, K2]));
        node.down = true;
        startBlocklist(ME);
        await vi.waitFor(() => expect(getBlocklistStatus().error).not.toBeNull());
        node.down = false;
        await unblockUser(K1);
        expect(isUserBlocked(K1)).toBe(false);
        await loadBlocklist();
        expect(node.list).toEqual([K2]);
        expect(localStorage.getItem(BLOCKLIST_STORAGE_KEY)).toBeNull();
    });

    it('a block sends a report to the moderators; one that can\'t go waits in memory, never in the browser, and goes on the next try', async () => {
        startBlocklist(ME);
        await vi.waitFor(() => expect(getBlocklistStatus().loaded).toBe(true));
        await blockUser(K1, ME, 'Harassment', 'post_99');
        expect(api.reportAbuse).toHaveBeenCalledWith(ME, K1, 'Harassment', 'post_99');
        // Blocked already: no second report.
        await blockUser(K1, ME, 'Harassment', 'post_99');
        expect(api.reportAbuse).toHaveBeenCalledTimes(1);

        vi.mocked(api.reportAbuse).mockRejectedValueOnce(new Error('Network error'));
        await blockUser(K2, ME, 'Spam', 'post_88');
        expect(isUserBlocked(K2)).toBe(true);
        expect(getPendingReports()).toEqual([expect.objectContaining({ reporterPubkey: ME, targetPubkey: K2, reason: 'Spam', postId: 'post_88' })]);
        expect(localStorage.getItem(PENDING_REPORTS_KEY)).toBeNull();

        await retryPendingReports();
        expect(api.reportAbuse).toHaveBeenLastCalledWith(ME, K2, 'Spam', 'post_88');
        expect(getPendingReports()).toEqual([]);
    });

    it('reports an older build queued in the browser are taken into memory, the key deleted, and sent', async () => {
        localStorage.setItem(PENDING_REPORTS_KEY, JSON.stringify([
            { reporterPubkey: ME, targetPubkey: K1, reason: 'Abuse', timestamp: Date.now() },
            { reporterPubkey: ME, targetPubkey: K2, reason: 'Old', timestamp: Date.now() - 8 * 24 * 60 * 60 * 1000 },
        ]));
        vi.mocked(api.reportAbuse).mockRejectedValueOnce(new Error('offline'));
        await retryPendingReports();
        expect(localStorage.getItem(PENDING_REPORTS_KEY)).toBeNull();
        expect(api.reportAbuse).toHaveBeenCalledTimes(1);
        expect(getPendingReports()).toEqual([expect.objectContaining({ targetPubkey: K1 })]);
        await retryPendingReports();
        expect(api.reportAbuse).toHaveBeenLastCalledWith(ME, K1, 'Abuse', undefined);
        expect(getPendingReports()).toEqual([]);
        expect(storedAboutBlocks()).toEqual([]);
    });

    it('once the account is known, only its own reports go: one queued here for another account is never sent from it', async () => {
        const OTHER = 'f6'.repeat(32);
        localStorage.setItem(PENDING_REPORTS_KEY, JSON.stringify([
            { reporterPubkey: OTHER, targetPubkey: K1, reason: 'Theirs', timestamp: Date.now() },
            { reporterPubkey: ME, targetPubkey: K2, reason: 'Mine', timestamp: Date.now() },
        ]));
        startBlocklist(ME);
        await vi.waitFor(() => expect(getBlocklistStatus().loaded).toBe(true));
        await retryPendingReports();
        await retryPendingReports();
        expect(api.reportAbuse).toHaveBeenCalledTimes(1);
        expect(api.reportAbuse).toHaveBeenCalledWith(ME, K2, 'Mine', undefined);
        expect(api.reportAbuse).not.toHaveBeenCalledWith(OTHER, expect.anything(), expect.anything(), expect.anything());
        expect(storedAboutBlocks()).toEqual([]);
    });
});
