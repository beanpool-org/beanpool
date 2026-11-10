/**
 * The block list the community keeps for the account (Marty's card web-blocklist-where, 2026-09-27): read from the node
 * after sign-in, changed only when the node takes the change, and never kept in the browser beyond the page's memory.
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
    /** Keys the node has no row for: a list of keys skips them and counts them. */
    unknown: [] as string[],
    calls: [] as string[],
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
    getPendingReports,
    onBlocklistUpdated,
    retryPendingReports,
    queueReportForRetry,
    resetBlocklistForTests,
    BlocklistError,
} from './blocklist';
import { ringBlocklistDoorbell } from './blocklist-doorbell';
import * as api from './api';
import { backToEnglish, showIn, xx } from '../words-xx.test-support';

const ME = 'a1'.repeat(32);
const [K1, K2, K3, K4] = ['b2', 'c3', 'd4', 'e5'].map(p => p.repeat(32));
/**
 * Everything this browser keeps that is about blocks: each item in localStorage or sessionStorage named for blocks or
 * reports, or holding a member's key, whatever it is named. Read through the Storage interface (length, key, getItem), so
 * it sees what is really kept: on setupTests' stand-in, Object.keys(localStorage) answers only its method names, and every
 * check below that nothing is kept in the browser passed whatever was (#1266's review, 4117165893).
 */
const storedAboutBlocks = () => {
    const found: string[] = [];
    for (const [where, store] of [['localStorage', localStorage], ['sessionStorage', sessionStorage]] as const) {
        for (let i = 0; i < store.length; i++) {
            const key = store.key(i);
            if (key === null) continue;
            if (/block|abuse/i.test(key) || /[0-9a-f]{64}/i.test(store.getItem(key) ?? '')) found.push(`${where} ${key}`);
        }
    }
    return found;
};
const settle = () => new Promise(r => setTimeout(r, 0));
/** Until the stand-in node has heard nothing more for a while: every read a doorbell brought has ended. */
async function quiet(): Promise<void> {
    let seen = -1;
    while (seen !== node.calls.length) {
        seen = node.calls.length;
        for (let i = 0; i < 5; i++) await settle();
    }
}

describe('the block list the community keeps for the account', () => {
    beforeEach(() => {
        localStorage.clear();
        sessionStorage.clear();
        resetBlocklistForTests();
        node.list = [];
        node.max = 500;
        node.down = false;
        node.refuse = null;
        node.unknown = [];
        node.calls = [];
        node.rings = false;
        vi.clearAllMocks();
    });

    it('the check that nothing is kept in the browser sees what is really there', () => {
        expect(storedAboutBlocks()).toEqual([]);
        localStorage.setItem('bp_theme', 'dark');
        sessionStorage.setItem('bp_tab', 'market');
        expect(storedAboutBlocks()).toEqual([]);
        localStorage.setItem('bp_moved_blocks', '[]');
        localStorage.setItem('bp_seen', JSON.stringify([K1]));
        sessionStorage.setItem('bp_marks', JSON.stringify({ [K2]: 1 }));
        expect(storedAboutBlocks()).toEqual(['localStorage bp_moved_blocks', 'localStorage bp_seen', 'sessionStorage bp_marks']);
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

    // Cutover W (D2, D3): a list or a report queue an older build kept in this browser is no longer read, moved or deleted.
    it('a list an older build kept in this browser is not read: nothing is blocked by it and nothing is sent from it', async () => {
        localStorage.setItem('bp_blocked_users', JSON.stringify([K1, K2]));
        localStorage.setItem('beanpool_blocked_users', JSON.stringify([K2, K3]));
        const stop = startBlocklist(ME);
        await vi.waitFor(() => expect(getBlocklistStatus().loaded).toBe(true));
        await quiet();
        expect(getBlockedUsers()).toEqual([]);
        expect(isUserBlocked(K1)).toBe(false);
        expect(node.list).toEqual([]);
        expect(node.calls).toEqual(['read']);
        expect(localStorage.getItem('bp_blocked_users')).toBe(JSON.stringify([K1, K2]));
        stop();
    });

    it('a report queue an older build kept in this browser is not read: nothing is sent from it', async () => {
        localStorage.setItem('bp_pending_abuse_reports', JSON.stringify([{ reporterPubkey: ME, targetPubkey: K1, reason: 'Old', timestamp: Date.now() }]));
        const stop = startBlocklist(ME);
        await vi.waitFor(() => expect(getBlocklistStatus().loaded).toBe(true));
        await retryPendingReports();
        expect(api.reportAbuse).not.toHaveBeenCalled();
        expect(getPendingReports()).toEqual([]);
        stop();
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

    it('in another language, "couldn\u2019t reach your community" is said in it, for a read, a block, an unblock and Unblock All', async () => {
        node.list = [K1];
        startBlocklist(ME);
        await vi.waitFor(() => expect(getBlockedUsers()).toEqual([K1]));
        await showIn('xx');
        try {
            node.down = true;
            const read = await loadBlocklist().catch(e => e);
            expect(read).toBeInstanceOf(BlocklistError);
            expect(read.message).toBe(xx('Couldn’t load your blocked members from your community. Check your connection and try again.'));
            expect(getBlocklistStatus().error).toBe(read.message);
            expect((await blockUser(K2, ME, 'Harassment').catch(e => e)).message)
                .toBe(xx('Couldn’t reach your community, so they are not blocked. Check your connection and try again.'));
            expect((await unblockUser(K1).catch(e => e)).message)
                .toBe(xx('Couldn’t reach your community, so they are still blocked. Check your connection and try again.'));
            expect((await clearBlocklist().catch(e => e)).message)
                .toBe(xx('Couldn’t reach your community, so nobody was unblocked. Check your connection and try again.'));
            // The node's own refusal stays in its words (it sends them in the member's language when it has them).
            node.down = false;
            node.refuse = { status: 409, error: 'You can block up to 500 people. Unblock someone to block another.', code: 'block_limit' };
            expect((await blockUser(K2).catch(e => e)).message).toBe('You can block up to 500 people. Unblock someone to block another.');
        } finally {
            backToEnglish();
        }
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
        expect(storedAboutBlocks()).toEqual([]);

        await retryPendingReports();
        expect(api.reportAbuse).toHaveBeenLastCalledWith(ME, K2, 'Spam', 'post_88');
        expect(getPendingReports()).toEqual([]);
    });

    it('once the account is known, only its own reports go: one queued here for another account is never sent from it', async () => {
        const OTHER = 'f6'.repeat(32);
        queueReportForRetry({ reporterPubkey: OTHER, targetPubkey: K1, reason: 'Theirs', timestamp: Date.now() });
        queueReportForRetry({ reporterPubkey: ME, targetPubkey: K2, reason: 'Mine', timestamp: Date.now() });
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
