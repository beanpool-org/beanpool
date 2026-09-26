import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// db.ts pulls in device modules at import time; stub them at the boundary (same set as apply-delta.test.ts).
vi.mock('expo-sqlite', () => ({ openDatabaseAsync: vi.fn() }));
vi.mock('@react-native-async-storage/async-storage', () => ({
    default: {
        getItem: vi.fn(async (k: string) => (k === 'beanpool_anchor_url' ? 'https://test.beanpool.org' : null)),
        setItem: vi.fn(async () => {}),
        removeItem: vi.fn(async () => {}),
        getAllKeys: vi.fn(async () => []),
    },
}));
vi.mock('expo-crypto', () => ({ randomUUID: () => 'test-uuid' }));
vi.mock('expo-file-system/legacy', () => ({ cacheDirectory: '/tmp/cache/' }));
vi.mock('../identity', () => ({
    loadIdentity: vi.fn(async () => ({ publicKey: 'me-pub', privateKey: 'me-priv', callsign: 'Me' })),
}));
vi.mock('../nodes', () => ({ getDatabaseFilenameForNode: vi.fn(), addSavedNode: vi.fn() }));
vi.mock('../canonical-profile', () => ({ getCanonicalProfile: vi.fn(), saveCanonicalProfile: vi.fn() }));
vi.mock('../crypto', async (orig) => ({
    ...(await orig<any>()),
    buildSignedHeaders: vi.fn(async () => ({})),
}));

import { redeemInvite, REDEEM_NO_ANSWER } from '../db';

const fetchMock = vi.fn();

function reply(status: number, body: any) {
    return {
        ok: status >= 200 && status < 300,
        status,
        json: async () => (typeof body === 'string' ? JSON.parse(body) : body),
        text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
    };
}

beforeEach(() => {
    fetchMock.mockReset();
    (globalThis as any).fetch = fetchMock;
});

describe('redeemInvite only reports success the node confirmed', () => {
    // `nodeHasPhoto` is the node's own answer about the picture it holds for the joiner, read
    // off the `member` row these replies carry; with no member and no photo in them it is
    // false. What it is FOR is pinned in avatar-value.test.ts — here it is just part of the
    // shape, still asserted exactly rather than loosened to a partial match.
    it('resolves when the node says success', async () => {
        fetchMock.mockResolvedValueOnce(reply(200, { success: true, alreadyMember: false }));
        await expect(redeemInvite('ABCD1234', 'Me')).resolves.toEqual({ success: true, alreadyMember: false, nodeHasPhoto: false });
    });

    it('passes alreadyMember through', async () => {
        fetchMock.mockResolvedValueOnce(reply(200, { success: true, alreadyMember: true }));
        await expect(redeemInvite('ABCD1234', 'Me')).resolves.toEqual({ success: true, alreadyMember: true, nodeHasPhoto: false });
    });

    it("rejects a 200 carrying success:false, with the node's reason", async () => {
        fetchMock.mockResolvedValueOnce(reply(200, { success: false, error: 'Invite already used' }));
        await expect(redeemInvite('ABCD1234', 'Me')).rejects.toThrow('Invite already used');
    });

    it('rejects a 200 whose body is not JSON (captive portal, proxy page)', async () => {
        fetchMock.mockResolvedValueOnce(reply(200, '<html>Sign in to Wi-Fi</html>'));
        await expect(redeemInvite('ABCD1234', 'Me')).rejects.toThrow(/did not confirm/);
    });

    it("still rejects a non-2xx with the node's error", async () => {
        fetchMock.mockResolvedValueOnce(reply(400, { error: 'Invalid invite code' }));
        await expect(redeemInvite('ABCD1234', 'Me')).rejects.toThrow('Invalid invite code');
    });
});

/**
 * The join wizard's Next closes its step's ways off while it waits (utils/invite-next.ts `runNext`), so its redeem is
 * bounded: a node that never answers can't keep the member on that step.
 */
describe('redeemInvite with timeoutMs', () => {
    /** A request that is never answered, and ends only when it is asked to stop, as fetch does. */
    function silentNode() {
        fetchMock.mockImplementationOnce((_url: string, init: { signal: AbortSignal }) => new Promise((_resolve, reject) => {
            init.signal.addEventListener('abort', () => reject(new Error('Aborted')));
        }));
    }

    afterEach(() => { vi.useRealTimers(); });

    it('stops a redeem with no answer by then, and says so', async () => {
        vi.useFakeTimers();
        silentNode();
        const redeeming = redeemInvite('ABCD1234', 'Me', undefined, { timeoutMs: 30_000 });
        const settled = expect(redeeming).rejects.toThrow(REDEEM_NO_ANSWER);
        await vi.advanceTimersByTimeAsync(30_000);
        await settled;
        expect((fetchMock.mock.calls[0][1] as { signal: AbortSignal }).signal.aborted).toBe(true);
    });

    it('an answer in time is the answer, as before', async () => {
        fetchMock.mockResolvedValueOnce(reply(200, { success: true, alreadyMember: true }));
        await expect(redeemInvite('ABCD1234', 'Me', undefined, { timeoutMs: 30_000 }))
            .resolves.toEqual({ success: true, alreadyMember: true, nodeHasPhoto: false });
    });

    it("a network failure is the network's own error, not the timeout's", async () => {
        fetchMock.mockRejectedValueOnce(new Error('Network request failed'));
        await expect(redeemInvite('ABCD1234', 'Me', undefined, { timeoutMs: 30_000 })).rejects.toThrow('Network request failed');
    });

    it('without it, nothing stops the request (every other caller, unchanged)', async () => {
        vi.useFakeTimers();
        silentNode();
        let settled = false;
        redeemInvite('ABCD1234', 'Me').then(() => { settled = true; }, () => { settled = true; });
        await vi.advanceTimersByTimeAsync(10 * 60_000);
        expect(settled).toBe(false);
        expect((fetchMock.mock.calls[0][1] as { signal: AbortSignal }).signal.aborted).toBe(false);
    });
});
