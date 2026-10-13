/**
 * The page's one shared info read keeps the node's members-on-demand answer (review of #1861 fix round, F3): a browser
 * whose only good read was the app's boot read, before any People, Chat, Market, Ledger or Commons screen, still asks
 * on a later start that can't reach /api/community/info, never reads the directory whole.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';

const node = vi.hoisted(() => ({ read: (async () => ({})) as () => Promise<unknown> }));
vi.mock('./api', () => ({
    getCommunityInfo: vi.fn(() => node.read()),
    getNodeApiUrl: vi.fn(() => 'https://global.example.test'),
    getMemberCards: vi.fn(async () => []),
}));
vi.mock('./identity', () => ({ loadInviteSent: vi.fn(async () => null), loadPendingJoin: vi.fn(async () => null) }));
vi.mock('./web-join', () => ({ captureAuthReturn: vi.fn(() => null) }));

import { communityInfoOnce, resetCommunityInfoOnce } from './visitor-lobby-gate';
import { useMembersOnDemand, MEMBERS_ON_DEMAND_SEEN_PREFIX } from './members-on-demand';

const KEY = MEMBERS_ON_DEMAND_SEEN_PREFIX + 'https://global.example.test';
const switchNow = async () => {
    const { result, unmount } = renderHook(() => useMembersOnDemand());
    await waitFor(() => expect(result.current).not.toBeNull());
    const on = result.current;
    unmount();
    return on;
};

describe("the boot read keeps the node's members-on-demand answer (F3)", () => {
    beforeEach(() => { localStorage.clear(); resetCommunityInfoOnce(); });
    afterEach(() => { localStorage.clear(); vi.restoreAllMocks(); });

    it('a good boot read alone is enough: a later start that cannot ask still asks, never reads whole', async () => {
        node.read = async () => ({ features: { membersOnDemand: true } });
        await communityInfoOnce();
        expect(localStorage.getItem(KEY)).toBe('1');
        // A new page load, offline.
        resetCommunityInfoOnce();
        node.read = async () => { throw new TypeError('Failed to fetch'); };
        expect(await switchNow()).toBe(true);
    });

    it("a node without the switch is kept as one, and a failed read keeps nothing", async () => {
        node.read = async () => ({ features: {} });
        await communityInfoOnce();
        expect(localStorage.getItem(KEY)).toBe('0');
        localStorage.clear();
        resetCommunityInfoOnce();
        node.read = async () => { throw new TypeError('Failed to fetch'); };
        await expect(communityInfoOnce()).rejects.toThrow('Failed to fetch');
        expect(localStorage.getItem(KEY)).toBeNull();
    });

    it("a store that can't be written never breaks the read", async () => {
        vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('blocked'); });
        node.read = async () => ({ profile: 'global', features: { membersOnDemand: true } });
        await expect(communityInfoOnce()).resolves.toEqual({ profile: 'global', features: { membersOnDemand: true } });
    });
});
