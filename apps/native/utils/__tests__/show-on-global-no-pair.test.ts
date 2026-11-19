/**
 * The phone with no pair for a copy (utils/show-on-global.ts): a delete there still asks after the listing's ids, on a local
 * community only, and the daily look for copies made elsewhere runs only on a phone that holds the global community as a
 * member. What the keeper does with what it finds is core's (packages/beanpool-core show-on-global.test.ts).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.hoisted(() => { (globalThis as any).__DEV__ = false; });

const store = vi.hoisted(() => new Map<string, string>());
const net = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), del: vi.fn() }));
const here = vi.hoisted(() => ({ anchor: 'https://home.test' as string | null, profile: 'local' as string | null, saved: [] as { url: string }[], guests: [] as string[] }));
vi.mock('@react-native-async-storage/async-storage', () => ({
    default: {
        getItem: async (k: string) => store.get(k) ?? null,
        setItem: async (k: string, v: string) => { store.set(k, v); },
    },
}));
vi.mock('../node-post', () => ({ anchorUrl: async () => here.anchor, signedGet: net.get, signedPost: net.post, signedDelete: net.del }));
vi.mock('../node-profile', () => ({ fetchNodeProfile: async () => null, getCachedNodeProfile: async () => (here.profile ? { profile: here.profile } : null) }));
vi.mock('../nodes', () => ({ getSavedNodes: async () => here.saved, isGuestNode: async (url: string) => here.guests.includes(url) }));
vi.mock('../crypto', () => ({ memberSigner: () => async () => new Uint8Array(64) }));
vi.mock('../events', () => ({ isEventEnded: () => false }));
vi.mock('../global-node-url', () => ({ GLOBAL_NODE_URL: 'https://global.test' }));

const me = { publicKey: 'ab'.repeat(32), privateKey: 'cd'.repeat(32) } as never;
const gone = { id: 'home-1', type: 'offer', lat: -28.6, lng: 153.5, audienceScope: 'public', authorPublicKey: 'ab'.repeat(32) } as const;
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const asked = (origin: string) => net.get.mock.calls.filter(([url]) => url === origin).map(([, path]) => String(path));

async function fresh() {
    vi.resetModules();
    return import('../show-on-global');
}

beforeEach(() => {
    store.clear();
    Object.assign(here, { anchor: 'https://home.test', profile: 'local', saved: [], guests: [] });
    net.get.mockReset().mockImplementation(async (url: string) => json(url === 'https://home.test' ? [{ ...gone, title: 'Tomatoes', status: 'active', active: true }] : []));
    net.post.mockReset().mockImplementation(async () => json({ success: true }));
    net.del.mockReset();
});

describe('a delete on a phone that holds no pair', () => {
    it('on a local community: global is asked after the listing\'s ids, whether or not this phone holds global', async () => {
        const { stopShowingGone } = await fresh();
        expect(await stopShowingGone(gone as never, me)).toBe(true);
        expect(asked('https://global.test')).toHaveLength(1);
        expect(asked('https://global.test')[0]).toMatch(/^\/api\/marketplace\/posts\?ids=/);
    });

    it('on the global community itself, or one whose profile the phone has no copy of: nobody is asked', async () => {
        for (const profile of ['global', null]) {
            here.profile = profile;
            const { stopShowingGone } = await fresh();
            expect(await stopShowingGone(gone as never, me)).toBe(true);
        }
        expect(net.get).not.toHaveBeenCalled();
        expect(net.post).not.toHaveBeenCalled();
    });
});

describe('the look for copies made elsewhere', () => {
    it('on a phone that holds global as a member: its own listings here, then its posts there', async () => {
        here.saved = [{ url: 'https://home.test' }, { url: 'https://global.test' }];
        const { tendCopies } = await fresh();
        await tendCopies(me);
        expect(asked('https://home.test').filter((p) => p.includes('author='))).toHaveLength(1);
        expect(asked('https://global.test').filter((p) => p.includes('author='))).toHaveLength(1);
    });

    it('on a phone that holds global only as a guest\'s look, or not at all, or away from a local community: nobody is asked', async () => {
        here.saved = [{ url: 'https://global.test' }];
        here.guests = ['https://global.test'];
        await (await fresh()).tendCopies(me);
        here.guests = [];
        here.saved = [{ url: 'https://home.test' }];
        await (await fresh()).tendCopies(me);
        here.saved = [{ url: 'https://global.test' }];
        here.profile = 'global';
        await (await fresh()).tendCopies(me);
        expect(net.get).not.toHaveBeenCalled();
    });
});
