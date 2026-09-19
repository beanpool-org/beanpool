import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
    validateGuide, getBundledGuide, loadLocalGuide, refreshGuideFromWebsite, splitBold, findGuidePage,
    searchGuide, relatedPages, manualSections, sectionPages, findGuideVideo, learnVideosFromFeed, youtubeWatchId, beanPoolSettingsEntries, beanPoolSheetEntries,
    GUIDE_CACHE_KEY, GUIDE_SLUGS, GUIDE_URL, type Guide,
} from '../guide';
import { FEEDBACK_LIVE } from '@beanpool/core';

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
    it('no file in the app keeps its own copy of the guide', () => {
        const appDir = path.join(repo, 'apps/native');
        const dirs = ['app', 'utils', 'components'];
        const offenders: string[] = [];
        for (const d of dirs) {
            for (const f of fs.readdirSync(path.join(appDir, d), { recursive: true }).map(String)) {
                if (f.includes('__tests__') || !/\.(ts|tsx|json)$/.test(f)) continue;
                const text = fs.readFileSync(path.join(appDir, d, f), 'utf8');
                if (f.endsWith('.json') ? /"guides"\s*:/.test(text) : (/guide\.json/.test(text) && !/from '@beanpool\/guide\/generated\/guide\.json'/.test(text))) offenders.push(`${d}/${f}`);
            }
        }
        expect(offenders).toEqual([]);
    });

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
        ['another schema', (g: any) => { g.schema = 1; }],
        ['a page in no section', (g: any) => { g.sections[1].slugs = g.sections[1].slugs.slice(1); }],
        ['a page in the wrong section', (g: any) => { g.guides[0].section = g.sections[1].id; }],
        ['a related page that does not exist', (g: any) => { g.guides[0].related = ['no-such-page']; }],
        ['a page related to itself', (g: any) => { g.guides[0].related = [g.guides[0].slug]; }],
        ['a video that is a link', (g: any) => { g.guides[0].video = 'https://evil.example/x'; }],
        ['no version', (g: any) => { delete g.version; }],
        ['fractional version', (g: any) => { g.version = 1.5; }],
        ['no guides', (g: any) => { g.guides = []; }],
        ['bad slug', (g: any) => { g.guides[0].slug = '../etc'; }],
        ['duplicate slug', (g: any) => { g.guides[1].slug = g.guides[0].slug; }],
        ['unknown block type', (g: any) => { g.guides[0].blocks[0] = { type: 'link', text: 'x', href: 'https://evil' }; }],
        ['an image block (operators only)', (g: any) => { g.guides[0].blocks[0] = { type: 'img', src: 'images/x.webp', alt: 'x' }; }],
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
        expect(await refreshGuideFromWebsite(bundled, storage, okFetch(' '.repeat(1100 * 1024) + JSON.stringify(withVersion(bundled, 99))))).toBeNull();
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

describe('the manual', () => {
    const guide = getBundledGuide();

    it('has every part of the app, and every page lists Related pages', () => {
        expect(manualSections(guide).map(s => s.id)).toEqual(['getting-started', 'market', 'map', 'talk', 'pulse', 'commons', 'ledger', 'settings']);
        for (const s of guide.sections) expect(sectionPages(guide, s).length).toBe(s.slugs.length);
        for (const p of guide.guides) expect(relatedPages(guide, p).length, p.slug).toBeGreaterThan(0);
    });

    it('search: every word must match, short words find longer ones, best match first, offline', () => {
        expect(searchGuide(guide, 'gift')[0].page.slug).toBe('gifts');
        expect(searchGuide(guide, 'vot').some(r => r.page.slug === 'decisions')).toBe(true);
        expect(searchGuide(guide, 'block someone')[0].page.slug).toBe('blocking');
        expect(searchGuide(guide, 'zzqqxx')).toEqual([]);
        expect(searchGuide(guide, ' ')).toEqual([]);
        expect(searchGuide(guide, 'a')).toEqual([]);
    });

    it('search: the words members bring from elsewhere find the words the guide uses', () => {
        expect(searchGuide(guide, 'tier').some(r => r.page.slug === 'trust-badges')).toBe(true);
        expect(searchGuide(guide, 'demurrage').some(r => r.page.slug === 'circulation-fee')).toBe(true);
        expect(searchGuide(guide, 'seed phrase').some(r => r.page.slug === 'your-12-words')).toBe(true);
    });

    it('search: accents fold, and words in other scripts are found (a translated guide will need this)', () => {
        const g: Guide = {
            schema: 2, version: 1, hash: 'h',
            sections: [{ id: 'about', title: 'A', summary: 'S', slugs: ['a', 'b'] }],
            guides: [
                { slug: 'a', title: 'Café', summary: 'S', section: 'about', related: ['b'], blocks: [{ type: 'p', text: 'Ψωμί και **καφές**, 12 λέξεις.' }] },
                { slug: 'b', title: 'Other', summary: 'S', section: 'about', related: ['a'], blocks: [{ type: 'p', text: 'nothing here' }] },
            ],
        };
        expect(searchGuide(g, 'cafe').map(r => r.page.slug)).toEqual(['a']);
        expect(searchGuide(g, 'καφές').map(r => r.page.slug)).toEqual(['a']);
        expect(searchGuide(g, 'λέξεις').map(r => r.page.slug)).toEqual(['a']);
    });

    it('search results carry a short snippet without bold markers', () => {
        for (const r of searchGuide(guide, 'beans')) {
            expect(r.snippet.length).toBeLessThanOrEqual(112);
            expect(r.snippet).not.toContain('**');
        }
    });
});

describe('Learn videos (extra, never required)', () => {
    const page = { ...findGuidePage(getBundledGuide(), 'gifts')! };
    const curated = (title: string, url: string) => ({ title, url, source: 'curated' });

    it('no videos, no link', () => {
        expect(findGuideVideo(page, [])).toBeNull();
    });

    it('matches a curated video titled like the page, ignoring case and punctuation', () => {
        const v = curated('SENDING a gift!', 'https://www.youtube.com/watch?v=abcdefghijk');
        expect(findGuideVideo(page, [curated('Other', 'https://www.youtube.com/watch?v=zzzzzzzzzzz'), v])).toBe(v);
    });

    it('matches the YouTube id the page names, from the link', () => {
        const v = curated('Anything', 'https://www.youtube.com/watch?v=tgsN2LiUVa0');
        expect(findGuideVideo({ ...page, video: 'tgsN2LiUVa0' }, [v])).toBe(v);
        expect(findGuideVideo({ ...page, video: 'tgsN2LiUVa0' }, [{ ...v, url: 'https://youtu.be/tgsN2LiUVa0' }])).not.toBeNull();
        expect(findGuideVideo({ ...page, video: 'tgsN2LiUVa0' }, [{ ...v, url: 'https://www.youtube.com/watch?v=otherid1234' }])).toBeNull();
    });

    it('never links anything that is not http(s)', () => {
        expect(findGuideVideo(page, [curated('Sending a gift', 'javascript:alert(1)')])).toBeNull();
    });

    // Review round 1 (B1): any member can put items in the Learn lane, and an RSS channel picks any title and link.
    it('a member-sourced item with the exact page title never links, on any page', () => {
        const g = getBundledGuide();
        for (const slug of ['your-12-words', 'recovery', 'joining', 'gifts']) {
            const p = findGuidePage(g, slug)!;
            expect(p).toBeTruthy();
            const url = 'https://www.youtube.com/watch?v=AAAAAAAAAAA';
            for (const source of ['autolist', 'manual', 'member', '', undefined, null]) {
                expect(findGuideVideo(p, [{ title: p.title, url, source }])).toBeNull();
            }
            expect(findGuideVideo(p, [{ title: p.title, url }])).toBeNull();
            expect(findGuideVideo(p, [curated(p.title, url)])).not.toBeNull();
        }
    });

    it('a member item naming the id a page asks for does not link either', () => {
        const v = { title: 'x', url: 'https://www.youtube.com/watch?v=tgsN2LiUVa0', source: 'autolist' };
        expect(findGuideVideo({ ...page, video: 'tgsN2LiUVa0' }, [v])).toBeNull();
    });

    it('a curated item whose link is not a YouTube watch or youtu.be link does not link', () => {
        for (const url of [
            'https://evil.example/x',
            'https://evil.example/watch?v=abcdefghijk',
            'https://youtube.com.evil.example/watch?v=abcdefghijk',
            'https://evil.example/?next=https://www.youtube.com/watch?v=abcdefghijk',
            'https://www.youtube.com.evil.example/watch?v=abcdefghijk',
            'https://user@evil.example/watch?v=abcdefghijk',
            'https://www.youtube.com@evil.example/watch?v=abcdefghijk',
            'http://www.youtube.com/watch?v=abcdefghijk',
            'https://www.youtube.com/redirect?q=https://evil.example&v=abcdefghijk',
            'https://www.youtube.com/watch?v=short',
            'https://youtu.be/abcdefghijk/extra',
            'https://notyoutu.be/abcdefghijk',
        ]) {
            expect(findGuideVideo(page, [curated('Sending a gift', url)])).toBeNull();
        }
    });

    it('youtubeWatchId reads only real watch and youtu.be links', () => {
        expect(youtubeWatchId('https://www.youtube.com/watch?v=tgsN2LiUVa0')).toBe('tgsN2LiUVa0');
        expect(youtubeWatchId('https://youtube.com/watch?v=tgsN2LiUVa0&t=30')).toBe('tgsN2LiUVa0');
        expect(youtubeWatchId('https://m.youtube.com/watch?v=tgsN2LiUVa0')).toBe('tgsN2LiUVa0');
        expect(youtubeWatchId('https://youtu.be/tgsN2LiUVa0?si=abc')).toBe('tgsN2LiUVa0');
        expect(youtubeWatchId('not a url')).toBeNull();
        expect(youtubeWatchId('https://evil.example/youtu.be/tgsN2LiUVa0')).toBeNull();
    });

    it('the feed mapping the app uses keeps source, so a member item from the feed never links', () => {
        const title = findGuidePage(getBundledGuide(), 'your-12-words')!.title;
        const feed = [
            { id: 'a', category: 'learn', title, url: 'https://www.youtube.com/watch?v=AAAAAAAAAAA', source: 'autolist' },
            { id: 'b', category: 'learn', title: 'your 12 WORDS!!', url: 'https://evil.example/x', source: 'autolist' },
            { id: 'c', category: 'music', title, url: 'https://www.youtube.com/watch?v=BBBBBBBBBBB', source: 'curated' },
        ];
        const videos = learnVideosFromFeed(feed);
        expect(videos.map(v => v.source)).toEqual(['autolist', 'autolist']);
        const p = findGuidePage(getBundledGuide(), 'your-12-words')!;
        expect(findGuideVideo(p, videos)).toBeNull();
        const official = learnVideosFromFeed([{ ...feed[0], source: 'curated' }]);
        expect(findGuideVideo(p, official)?.url).toBe('https://www.youtube.com/watch?v=AAAAAAAAAAA');
        expect(learnVideosFromFeed(undefined)).toEqual([]);
    });
});

describe('Suggest a change follows FEEDBACK_LIVE, in Settings and in the sheet', () => {
    it('the entry lists', () => {
        expect(beanPoolSettingsEntries(false)).toEqual(['help', 'website']);
        expect(beanPoolSettingsEntries(true)).toEqual(['help', 'suggest', 'website']);
        expect(beanPoolSheetEntries(false)).toEqual(['whats-new', 'website']);
        expect(beanPoolSheetEntries(true)).toEqual(['suggest', 'whats-new', 'website']);
    });

    it('both screens build their BeanPool rows from those lists and the flag, and open suggest-change nowhere else', () => {
        const settings = read('apps/native/app/(tabs)/settings.tsx');
        const sheet = read('apps/native/app/beanpool.tsx');
        expect(settings).toContain('beanPoolSettingsEntries(FEEDBACK_LIVE)');
        expect(sheet).toContain('beanPoolSheetEntries(FEEDBACK_LIVE)');
        // Each file opens the suggest-change screen once, inside its `suggest` row.
        for (const src of [settings, sheet]) {
            const opens = src.split("router.push('/suggest-change')").length - 1;
            expect(opens).toBe(1);
            const at = src.indexOf("router.push('/suggest-change')");
            expect(src.lastIndexOf("entry === 'suggest'", at)).toBeGreaterThan(-1);
            expect(at - src.lastIndexOf("entry === 'suggest'", at)).toBeLessThan(800);
        }
        // No other screen in the app opens it.
        const appDir = path.join(repo, 'apps/native/app');
        const others = fs.readdirSync(appDir, { recursive: true }).map(String)
            .filter(f => /\.tsx?$/.test(f) && !['(tabs)/settings.tsx', 'beanpool.tsx', 'suggest-change.tsx', '_layout.tsx'].includes(f))
            .filter(f => fs.readFileSync(path.join(appDir, f), 'utf8').includes('suggest-change'));
        expect(others).toEqual([]);
    });

    it('today the rows follow the flag as it is set', () => {
        expect(beanPoolSettingsEntries(FEEDBACK_LIVE).includes('suggest')).toBe(FEEDBACK_LIVE);
        expect(beanPoolSheetEntries(FEEDBACK_LIVE).includes('suggest')).toBe(FEEDBACK_LIVE);
    });
});
