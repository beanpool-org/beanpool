import { describe, it, expect, vi } from 'vitest';
import { performSync, syncLandedOnThisCopy } from '../../services/pillar-sync';

// The Market asks, as it mounts, whether a sync has landed on the copy this phone holds now (app/(tabs)/market.tsx): the
// boot sync can end before it listens, and it then reads what that cycle wrote rather than asking the node for a whole
// sync more (review of PR #2127). Never for a copy cleared since (copyGeneration), nor another community's. The real
// performSync, against a stubbed node whose posts read lands or fails.

const store = new Map<string, string>();
const copy = vi.hoisted(() => ({ generation: 0 }));
vi.mock('@react-native-async-storage/async-storage', () => ({
    default: {
        getItem: vi.fn(async (k: string) => store.get(k) ?? null),
        setItem: vi.fn(async (k: string, v: string) => { store.set(k, String(v)); }),
        removeItem: vi.fn(async (k: string) => { store.delete(k); }),
    },
}));
vi.mock('../db', async () => {
    const { getDatabaseFilenameForNode } = await import('../nodes');
    const AsyncStorage = (await import('@react-native-async-storage/async-storage')).default;
    return {
        applyDelta: vi.fn().mockResolvedValue(undefined),
        communityCachesRenamed: vi.fn().mockResolvedValue(true),
        copyGenerationNow: vi.fn(() => copy.generation),
        copyForRead: vi.fn(async () => {
            const anchorUrl = await AsyncStorage.getItem('beanpool_anchor_url');
            return { dbName: anchorUrl ? getDatabaseFilenameForNode(anchorUrl) : undefined, generation: copy.generation };
        }),
        newCopyGeneration: vi.fn(() => { copy.generation++; }),
        fetchFriendsFromServer: vi.fn().mockResolvedValue([]),
        getDb: vi.fn().mockResolvedValue({ getFirstAsync: vi.fn().mockResolvedValue({ count: 0 }) }),
    };
});
vi.mock('../nodes', () => ({ getDatabaseFilenameForNode: vi.fn((url: string) => `beanpool_${new URL(url).hostname}.db`) }));
vi.mock('../identity', () => ({ loadIdentity: vi.fn(async () => ({ publicKey: 'my-key', privateKey: 'my-secret' })) }));
vi.mock('expo-constants', () => ({ default: { experienceUrl: undefined, expoConfig: undefined } }));

const MULLUM = 'https://mullum.example';
const OTHER = 'https://castlemaine.example';
let postsLand = true;
globalThis.fetch = vi.fn(async (url: string) => {
    if (String(url).includes('/api/marketplace/posts')) {
        return postsLand ? ({ ok: true, status: 200, headers: new Headers(), text: async () => '[]' } as any) : ({ ok: false, status: 503, headers: new Headers(), json: async () => ({}) } as any);
    }
    return { ok: false, status: 404, headers: new Headers(), json: async () => ({}), text: async () => '' } as any;
}) as any;

describe('syncLandedOnThisCopy', () => {
    it('true once a cycle lands on this copy; false for a copy cleared since, another community, or a failed cycle', async () => {
        const local = { profile: 'local', features: {}, checkedAt: new Date().toISOString() };
        store.set('beanpool_node_profiles', JSON.stringify({ [MULLUM]: local, [OTHER]: local }));
        store.set('beanpool_anchor_url', MULLUM);
        expect(await syncLandedOnThisCopy()).toBe(false);

        expect((await performSync()).success).toBe(true);
        expect(await syncLandedOnThisCopy()).toBe(true);

        // Force Resync, Wipe & Restart, a community's caches removed: a new copy, which no cycle has filled.
        copy.generation++;
        expect(await syncLandedOnThisCopy()).toBe(false);
        postsLand = false;
        expect((await performSync()).success).toBe(false);
        expect(await syncLandedOnThisCopy()).toBe(false);

        postsLand = true;
        expect((await performSync()).success).toBe(true);
        expect(await syncLandedOnThisCopy()).toBe(true);
        // Switched to another community: its copy is not the one that cycle wrote.
        store.set('beanpool_anchor_url', OTHER);
        expect(await syncLandedOnThisCopy()).toBe(false);
        store.set('beanpool_anchor_url', MULLUM);
        expect(await syncLandedOnThisCopy()).toBe(true);
    });
});
