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
    calls: [] as string[],
}));

vi.mock('./api', () => {
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
            fail();
            const ks = Array.isArray(keys) ? keys : [keys];
            const fresh = ks.filter(k => !node.list.includes(k));
            if (node.list.length + fresh.length > node.max) throw Object.assign(new Error('You can block up to 500 people. Unblock someone to block another.'), { status: 409, code: 'block_limit' });
            node.list.push(...fresh);
            return { ...answer(), added: fresh };
        }),
        removeFromBlockList: vi.fn(async (key: string) => {
            node.calls.push(`remove ${key}`);
            fail();
            const removed = node.list.includes(key);
            node.list = node.list.filter(k => k !== key);
            return { ...answer(), removed };
        }),
        clearBlockList: vi.fn(async () => {
            node.calls.push('clear');
            fail();
            const removed = node.list.length;
            node.list = [];
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

describe('the block list the community keeps for the account', () => {
    beforeEach(() => {
        localStorage.clear();
        resetBlocklistForTests();
        node.list = [];
        node.max = 500;
        node.down = false;
        node.refuse = null;
        node.calls = [];
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

    it('past the node\'s limit, the newest the list has room for move up, and the local keys still go', async () => {
        node.max = 3;
        node.list = [K4];
        localStorage.setItem(BLOCKLIST_STORAGE_KEY, JSON.stringify([K1, K2, K3]));
        startBlocklist(ME);
        await vi.waitFor(() => expect(localStorage.getItem(BLOCKLIST_STORAGE_KEY)).toBeNull());
        expect(api.addToBlockList).toHaveBeenCalledWith([K2, K3]);
        expect(getBlockedUsers()).toEqual([K4, K2, K3]);
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
});
