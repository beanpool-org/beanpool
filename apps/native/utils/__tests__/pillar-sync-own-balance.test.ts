/**
 * The sync keeps the member's own balance as the node sends it: whole hundredths of a Bean, `balance_c`
 * (DESIGN-atomic-beans-fable.md M2). Before M2 the cycle wrote `balance: balData.balance || 0`, a key the node no longer
 * sends, so every cycle put 0 over the member's balance in the phone's copy. An answer with no whole-hundredths figure
 * writes no account row at all (the copy keeps its last figure), never a guessed 0. performSync for real, its fetch
 * answered; the phone's database is a stand-in that records the delta it is handed.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const store = vi.hoisted(() => ({ map: new Map<string, string>() }));
const applied = vi.hoisted(() => ({ deltas: [] as any[] }));
vi.mock('@react-native-async-storage/async-storage', () => ({
    default: {
        getItem: vi.fn(async (k: string) => store.map.get(k) ?? null),
        setItem: vi.fn(async (k: string, v: string) => { store.map.set(k, v); }),
        removeItem: vi.fn(async (k: string) => { store.map.delete(k); }),
    },
}));
vi.mock('../db', () => ({
    applyDelta: vi.fn(async (delta: any) => { applied.deltas.push(delta); }),
    communityCachesRenamed: vi.fn().mockResolvedValue(true),
    copyGenerationNow: vi.fn(() => 0),
    newCopyGeneration: vi.fn(),
    fetchFriendsFromServer: vi.fn().mockResolvedValue([]),
    getDb: vi.fn().mockResolvedValue({ getFirstAsync: vi.fn().mockResolvedValue({ count: 0 }), getAllAsync: vi.fn().mockResolvedValue([]) }),
}));
vi.mock('../nodes', () => ({ getDatabaseFilenameForNode: vi.fn().mockReturnValue('test.db') }));
vi.mock('expo-constants', () => ({ default: { experienceUrl: undefined, expoConfig: undefined } }));
const ME = 'e'.repeat(64);
vi.mock('../identity', () => ({ loadIdentity: vi.fn(async () => ({ publicKey: ME, callsign: 'Me' })) }));

import { performSync } from '../../services/pillar-sync';
import { readerFeaturesHeld } from '../reads-own';

const NODE = 'https://node.example';
const LOCAL = { beans: true, escrow: true, enterprises: true, decisions: true, invites: true, showcase: false };

let balanceAnswer: Record<string, unknown> = {};
const originalFetch = global.fetch;
beforeEach(() => {
    store.map.clear();
    store.map.set('beanpool_anchor_url', NODE);
    store.map.set('beanpool_node_profiles', JSON.stringify({ [NODE]: { profile: 'local', features: LOCAL, checkedAt: new Date().toISOString() } }));
    readerFeaturesHeld.clear();
    applied.deltas.length = 0;
    global.fetch = vi.fn(async (url: string) => {
        const path = new URL(String(url)).pathname;
        const body = path === `/api/ledger/balance/${ME}` ? JSON.stringify(balanceAnswer)
            : /\/api\/(marketplace\/posts|members)$/.test(path) ? '[]' : '{}';
        return { ok: true, status: 200, headers: new Headers(), json: async () => JSON.parse(body), text: async () => body };
    }) as any;
});
afterEach(() => { global.fetch = originalFetch; });

/** Every account row the cycle handed the copy. */
const accountRows = () => applied.deltas.flatMap((d) => (Array.isArray(d?.accounts) ? d.accounts : []));

describe("pillar-sync: the member's own balance, in whole hundredths", () => {
    it.each([
        [1, '0.01'], [100, '1'], [4925, '49.25'], [-982, '−9.82'], [50000, '500'],
    ])('the node says balance_c %i (%s Beans): the copy is handed exactly that', async (balance_c) => {
        balanceAnswer = { balance_c, last_demurrage_epoch: 3 };
        await performSync();
        expect(accountRows()).toEqual([{ public_key: ME, balance_c, last_demurrage_epoch: 3 }]);
    });

    it('an answer without whole hundredths (a node from before them, or a float) hands the copy no account row, never a 0', async () => {
        for (const answer of [{ balance: 49.25 }, { balance_c: 49.25 }, { balance_c: '4925' }, {}]) {
            applied.deltas.length = 0;
            balanceAnswer = answer;
            await performSync();
            expect(accountRows()).toEqual([]);
        }
    });
});
