/**
 * Settings → Diagnostics' compare asked the node for the member's own ledger (GET /api/ledger/transactions?publicKey=<me>)
 * on the worldwide community, where Beans are Example Valley's (review of #2035, "For Marty": settings.tsx:808). In
 * preview: never asked, and the compare keeps the node's own count. A local community: asked, as before. BeanID's
 * verified member, whose own set turns Beans live: asked.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

vi.mock('@react-native-async-storage/async-storage', () => ({
    default: { getItem: vi.fn(async () => null), setItem: vi.fn(async () => {}), removeItem: vi.fn(async () => {}) },
}));

import { remoteOwnTransactionCount } from '../diagnostics-own-count';
import { readerFeaturesHeld, readerFeaturesKey } from '../reads-own';

const URL = 'https://node.example';
const ME = 'a'.repeat(64);
const WORLDWIDE = { profile: 'global', features: { beans: false, escrow: false, enterprises: false, decisions: false, invites: false, showcase: true }, transactionCount: 9 };
const LOCAL = { profile: 'local', features: {}, transactionCount: 9 };

let fetchSpy: ReturnType<typeof vi.fn>;
beforeEach(() => {
    readerFeaturesHeld.clear();
    fetchSpy = vi.fn(async () => ({ ok: true, json: async () => [{ id: 't1' }, { id: 't2' }] }));
    vi.stubGlobal('fetch', fetchSpy);
});
afterEach(() => { vi.unstubAllGlobals(); readerFeaturesHeld.clear(); });

const ownReads = () => fetchSpy.mock.calls.map((c) => String(c[0])).filter((u) => u.includes('/api/ledger/transactions'));

describe("Diagnostics' compare: the member's own ledger on the node", () => {
    it('global (Beans in preview): not asked, and no count of theirs', async () => {
        expect(await remoteOwnTransactionCount(URL, WORLDWIDE, ME)).toBeNull();
        expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('local: asked once, for the member, and their count comes back, as before', async () => {
        expect(await remoteOwnTransactionCount(URL, LOCAL, ME)).toBe(2);
        expect(ownReads()).toHaveLength(1);
        expect(ownReads()[0]).toContain(`${URL}/api/ledger/transactions?publicKey=${ME}&limit=200`);
    });

    it("an info answer that says nothing of features reads as a local one: asked, as before", async () => {
        expect(await remoteOwnTransactionCount(URL, { transactionCount: 9 }, ME)).toBe(2);
        expect(ownReads()).toHaveLength(1);
    });

    it("global, BeanID's verified member (their own set turns Beans live): asked", async () => {
        readerFeaturesHeld.set(readerFeaturesKey(URL, ME), { features: { beans: true }, at: Date.now(), freshMs: 60_000 });
        expect(await remoteOwnTransactionCount(URL, WORLDWIDE, ME)).toBe(2);
        expect(ownReads()).toHaveLength(1);
    });

    it('no key on this phone: nothing asked', async () => {
        expect(await remoteOwnTransactionCount(URL, LOCAL, null)).toBeNull();
        expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('a read that fails leaves the node\'s own count (null), never a throw', async () => {
        fetchSpy.mockRejectedValueOnce(new TypeError('Network request failed'));
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        expect(await remoteOwnTransactionCount(URL, LOCAL, ME)).toBeNull();
        warn.mockRestore();
    });

    it('Settings → Diagnostics asks through this guard alone: no read of its own of the member\'s ledger', () => {
        const src = readFileSync(join(__dirname, '../../app/(tabs)/settings.tsx'), 'utf8');
        expect(src).toContain('remoteOwnTransactionCount(cleanUrl, data, identity?.publicKey)');
        expect(src).not.toContain('/api/ledger/transactions');
    });
});
