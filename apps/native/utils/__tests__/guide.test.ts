import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
    validateGuide, getBundledGuide, loadLocalGuide, refreshGuideFromWebsite, splitBold, findGuidePage,
    GUIDE_CACHE_KEY, GUIDE_SLUGS, GUIDE_URL, type Guide,
} from '../guide';

const repo = path.resolve(__dirname, '../../../..');
const read = (rel: string) => fs.readFileSync(path.join(repo, rel), 'utf8');

function memoryStorage(initial: Record<string, string> = {}) {
    const data = { ...initial };
    return {
        data,
        async getItem(k: string) { return k in data ? data[k] : null; },
        async setItem(k: string, v: string) { data[k] = v; },
    };
}

const withVersion = (g: Guide, version: number, text = 'Changed.'): Guide => ({
    ...g, version, guides: g.guides.map((p, i) => (i === 0 ? { ...p, blocks: [{ type: 'p', text }] } : p)),
});

const okFetch = (body: string) => async () => ({ ok: true, text: async () => body });

describe('one source: the bundled guide is the website guide', () => {
    it('the app bundles exactly the bytes the website serves', () => {
        const bundled = read('packages/beanpool-guide/generated/guide.json');
        const website = read('apps/website/guide/guide.json');
        expect(website).toBe(bundled);
        expect(getBundledGuide()).toEqual(validateGuide(JSON.parse(website)));
    });

    it('the bundled guide is valid and has every guide the sheet links to', () => {
        const g = getBundledGuide();
        for (const slug of Object.values(GUIDE_SLUGS)) expect(findGuidePage(g, slug), slug).not.toBeNull();
    });
});

describe('validateGuide', () => {
    const good = () => JSON.parse(JSON.stringify(getBundledGuide()));

    it('accepts the real guide', () => {
        expect(validateGuide(good())).not.toBeNull();
    });

    it.each([
        ['another schema', (g: any) => { g.schema = 2; }],
        ['no version', (g: any) => { delete g.version; }],
        ['fractional version', (g: any) => { g.version = 1.5; }],
        ['no guides', (g: any) => { g.guides = []; }],
        ['bad slug', (g: any) => { g.guides[0].slug = '../etc'; }],
        ['duplicate slug', (g: any) => { g.guides[1].slug = g.guides[0].slug; }],
        ['unknown block type', (g: any) => { g.guides[0].blocks[0] = { type: 'link', text: 'x', href: 'https://evil' }; }],
        ['empty paragraph', (g: any) => { g.guides[0].blocks[0] = { type: 'p', text: '' }; }],
        ['huge paragraph', (g: any) => { g.guides[0].blocks[0] = { type: 'p', text: 'x'.repeat(5000) }; }],
        ['non-string bullet', (g: any) => { g.guides[0].blocks[0] = { type: 'ul', items: [42] }; }],
        ['title too long', (g: any) => { g.guides[0].title = 'x'.repeat(200); }],
    ])('refuses %s', (_name, mutate) => {
        const g = good();
        mutate(g);
        expect(validateGuide(g)).toBeNull();
    });

    it('refuses things that are not objects', () => {
        for (const v of [null, undefined, 'x', 3, []]) expect(validateGuide(v)).toBeNull();
    });
});

describe('loadLocalGuide (offline, never the network)', () => {
    const bundled = getBundledGuide();

    it('no cache: the bundled copy', async () => {
        expect(await loadLocalGuide(memoryStorage(), bundled)).toEqual({ guide: bundled, source: 'bundled' });
    });

    it('a newer cached copy wins', async () => {
        const newer = withVersion(bundled, bundled.version + 1);
        const r = await loadLocalGuide(memoryStorage({ [GUIDE_CACHE_KEY]: JSON.stringify(newer) }), bundled);
        expect(r.source).toBe('cached');
        expect(r.guide.version).toBe(bundled.version + 1);
    });

    it('an older or equal cached copy loses to the bundled one (the app was updated since)', async () => {
        const same = withVersion(bundled, bundled.version);
        const r = await loadLocalGuide(memoryStorage({ [GUIDE_CACHE_KEY]: JSON.stringify(same) }), bundled);
        expect(r.source).toBe('bundled');
    });

    it('a corrupt cache or a failing storage falls back to the bundled copy', async () => {
        expect((await loadLocalGuide(memoryStorage({ [GUIDE_CACHE_KEY]: '{not json' }), bundled)).source).toBe('bundled');
        const broken = { getItem: async () => { throw new Error('disk'); }, setItem: async () => {} };
        expect((await loadLocalGuide(broken, bundled)).source).toBe('bundled');
    });
});

describe('refreshGuideFromWebsite', () => {
    const bundled = getBundledGuide();

    it('fetches the website copy and keeps a newer valid one', async () => {
        const newer = withVersion(bundled, bundled.version + 1);
        const storage = memoryStorage();
        let asked = '';
        const got = await refreshGuideFromWebsite(bundled, storage, async (url) => { asked = url; return { ok: true, text: async () => JSON.stringify(newer) }; });
        expect(asked).toBe(GUIDE_URL);
        expect(got?.version).toBe(bundled.version + 1);
        expect(JSON.parse(storage.data[GUIDE_CACHE_KEY]).version).toBe(bundled.version + 1);
    });

    it('ignores a copy that is not newer, and caches nothing', async () => {
        const storage = memoryStorage();
        expect(await refreshGuideFromWebsite(bundled, storage, okFetch(JSON.stringify(bundled)))).toBeNull();
        expect(storage.data[GUIDE_CACHE_KEY]).toBeUndefined();
    });

    it('offline, an error page, bad JSON, an invalid or oversized file: keep what we have', async () => {
        const storage = memoryStorage();
        const bad = { ...withVersion(bundled, 99), schema: 7 };
        expect(await refreshGuideFromWebsite(bundled, storage, async () => { throw new Error('offline'); })).toBeNull();
        expect(await refreshGuideFromWebsite(bundled, storage, async () => ({ ok: false, text: async () => 'Not found' }))).toBeNull();
        expect(await refreshGuideFromWebsite(bundled, storage, okFetch('<html>'))).toBeNull();
        expect(await refreshGuideFromWebsite(bundled, storage, okFetch(JSON.stringify(bad)))).toBeNull();
        expect(await refreshGuideFromWebsite(bundled, storage, okFetch(' '.repeat(600 * 1024) + JSON.stringify(withVersion(bundled, 99))))).toBeNull();
        expect(storage.data[GUIDE_CACHE_KEY]).toBeUndefined();
    });

    it('gives up on a network that never answers', async () => {
        const hanging = (_url: string, init?: { signal?: AbortSignal }) => new Promise<never>((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
        });
        expect(await refreshGuideFromWebsite(bundled, memoryStorage(), hanging, 20)).toBeNull();
    });

    it('a cache that cannot be written still returns the newer copy', async () => {
        const newer = withVersion(bundled, bundled.version + 1);
        const storage = { getItem: async () => null, setItem: async () => { throw new Error('full'); } };
        expect((await refreshGuideFromWebsite(bundled, storage, okFetch(JSON.stringify(newer))))?.version).toBe(bundled.version + 1);
    });
});

describe('splitBold', () => {
    it('splits **bold** runs and drops empty pieces', () => {
        expect(splitBold('a **b** c')).toEqual([{ text: 'a ', bold: false }, { text: 'b', bold: true }, { text: ' c', bold: false }]);
        expect(splitBold('**all**')).toEqual([{ text: 'all', bold: true }]);
        expect(splitBold('plain')).toEqual([{ text: 'plain', bold: false }]);
    });
});
