/**
 * The sync reads nothing of the member's own where its feature is in preview (global previews audit, "Across all
 * five", P3): on the worldwide community it asked for the member's balance, ledger and deals every cycle, while its
 * Ledger and My Deals are Example Valley's. In preview: never asked (utils/reads-own.ts). A local community: asked,
 * as before. performSync for real, its fetch recorded; the phone's database is a stand-in.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const store = vi.hoisted(() => ({ map: new Map<string, string>() }));
vi.mock('@react-native-async-storage/async-storage', () => ({
    default: {
        getItem: vi.fn(async (k: string) => store.map.get(k) ?? null),
        setItem: vi.fn(async (k: string, v: string) => { store.map.set(k, v); }),
        removeItem: vi.fn(async (k: string) => { store.map.delete(k); }),
    },
}));
vi.mock('../db', () => ({
    applyDelta: vi.fn().mockResolvedValue(undefined),
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
import { readerFeaturesHeld, readerFeaturesKey } from '../reads-own';

const NODE = 'https://node.example';
const WORLDWIDE = { beans: false, escrow: false, enterprises: false, decisions: false, invites: false, showcase: true };
const LOCAL = { beans: true, escrow: true, enterprises: true, decisions: true, invites: true, showcase: false };
function rememberProfile(profile: 'global' | 'local', features: Record<string, boolean>) {
    store.map.set('beanpool_node_profiles', JSON.stringify({ [NODE]: { profile, features, checkedAt: new Date().toISOString() } }));
}
/** The member's own reads the audit measured: balance, ledger, deals. */
const OWN = [`/api/ledger/balance/${ME}`, '/api/ledger/transactions', '/api/marketplace/transactions'];

const asked: string[] = [];
const originalFetch = global.fetch;
beforeEach(() => {
    store.map.clear();
    store.map.set('beanpool_anchor_url', NODE);
    asked.length = 0;
    readerFeaturesHeld.clear();
    global.fetch = vi.fn(async (url: string) => {
        const path = new URL(String(url)).pathname;
        asked.push(path);
        // An empty community: lists empty, everything else an empty answer.
        const body = /\/api\/(marketplace\/posts|members)$/.test(path) ? '[]' : '{}';
        return { ok: true, status: 200, headers: new Headers(), json: async () => JSON.parse(body), text: async () => body };
    }) as any;
});
afterEach(() => { global.fetch = originalFetch; });

const ownAsked = () => OWN.filter(p => asked.includes(p));

describe("pillar-sync: the member's own balance, ledger and deals", () => {
    it('a local community: all three asked, as before', async () => {
        rememberProfile('local', LOCAL);
        await performSync();
        expect(asked).toContain('/api/marketplace/posts');
        expect(ownAsked()).toEqual(OWN);
    });

    it('the worldwide community (Beans and deals in preview): none asked', async () => {
        rememberProfile('global', WORLDWIDE);
        await performSync();
        expect(asked.length).toBeGreaterThan(0);
        expect(ownAsked()).toEqual([]);
    });

    it('the worldwide community, a member for whom Beans and deals are live there (their own set): all three asked', async () => {
        rememberProfile('global', WORLDWIDE);
        readerFeaturesHeld.set(readerFeaturesKey(NODE, ME), { features: { beans: true, escrow: true }, at: Date.now(), freshMs: 3_600_000 });
        await performSync();
        expect(ownAsked()).toEqual(OWN);
    });
});
