// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';

(globalThis as any).__DEV__ = false;
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

// Learn's screens (DESIGN-local-knowledge-fable.md as amended §A3): the front, one topic, a search, the preview on the worldwide
// community, the page, the Market's one line, and the post route's hook. The phone's copy, the node and the router are faked at
// their edges; the screens, the row card and the words are the real ones.

const h = vi.hoisted(() => ({
    mode: 'live' as 'live' | 'preview' | 'hidden' | undefined,
    params: {} as Record<string, string>,
    pages: [] as any[],
    pagesFails: false,
    identity: { publicKey: 'me'.padEnd(64, '0') } as { publicKey: string } | null,
    nodeSearch: null as null | ((path: string) => Promise<any>),
    nodeCalls: [] as string[],
    listeners: {} as Record<string, Array<() => void>>,
    opened: [] as string[],
}));
const router = vi.hoisted(() => ({ push: vi.fn(), back: vi.fn(), replace: vi.fn(), navigate: vi.fn(), canGoBack: vi.fn(() => true) }));

vi.mock('expo-router', () => ({ useRouter: () => router, useLocalSearchParams: () => h.params, router }));
vi.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }) }));
vi.mock('react-native', async () => {
    const { createElement: el, Children } = await import('react');
    const flat = (style: unknown): Record<string, any> => Object.assign({}, ...[style].flat(4).filter((x) => x && typeof x === 'object'));
    const host = (tag: string) => function Host(props: Record<string, any>) {
        const { children, onPress, accessibilityLabel, accessibilityRole, testID, disabled, accessibilityState } = props;
        const attrs: Record<string, unknown> = {};
        if (onPress && !disabled) attrs.onClick = () => onPress({ stopPropagation() {} });
        if (accessibilityLabel) attrs['aria-label'] = accessibilityLabel;
        if (accessibilityRole) attrs['data-role'] = accessibilityRole;
        if (accessibilityState?.selected) attrs['aria-selected'] = 'true';
        if (testID) attrs['data-testid'] = testID;
        const s = flat(typeof props.style === 'function' ? props.style({ pressed: false }) : props.style);
        if (typeof s.minHeight === 'number') attrs['data-min-height'] = String(s.minHeight);
        return el(tag, attrs, children);
    };
    return {
        View: host('div'), Text: host('span'), Pressable: host('button'), ScrollView: host('div'), ActivityIndicator: host('i'),
        Modal: ({ visible, children }: any) => (visible ? el('div', { 'data-testid': 'modal' }, children) : null),
        TextInput: ({ value, onChangeText, testID, placeholder }: any) =>
            el('input', { value, placeholder, 'data-testid': testID, onChange: (e: any) => onChangeText(e.target.value) }),
        StyleSheet: { create: (s: unknown) => s, flatten: (s: unknown) => flat(s), hairlineWidth: 1 },
        DeviceEventEmitter: {
            addListener: (event: string, fn: () => void) => {
                (h.listeners[event] = h.listeners[event] || []).push(fn);
                return { remove: () => { h.listeners[event] = (h.listeners[event] || []).filter((l) => l !== fn); } };
            },
        },
        Linking: { openURL: vi.fn(async (url: string) => { h.opened.push(url); }) },
        Alert: { alert: vi.fn() },
        Children,
    };
});
vi.mock('../../app/ThemeContext', async () => {
    const { lightColors } = await import('../../constants/colors');
    return { useTheme: () => ({ theme: 'light', colors: lightColors }), useStyles: (make: any) => make({ theme: 'light', colors: lightColors }) };
});
vi.mock('../../app/IdentityContext', () => ({ useIdentity: () => ({ identity: h.identity }) }));
vi.mock('../use-learn-mode', () => ({ useLearnMode: () => h.mode }));
vi.mock('../db', () => ({
    getKnowledgePosts: vi.fn(async () => { if (h.pagesFails) throw new Error('unreadable'); return h.pages; }),
    getKnowledgePost: vi.fn(async (id: string) => h.pages.find((p) => p.id === id) ?? null),
    signedGet: vi.fn(async (path: string) => { h.nodeCalls.push(path); if (!h.nodeSearch) throw new Error('offline'); return h.nodeSearch(path); }),
    reportAbuse: vi.fn(async () => ({})),
    getMemberRatings: vi.fn(async () => ({ average: null, count: 0 })),
}));
vi.mock('../../components/showcase/LocalCommunityMark', () => ({
    ExampleHeader: ({ text }: any) => createElement('div', { 'data-testid': 'example-header' }, text),
    SHEET_ROUTES: { start: '/start-community', nearYou: '/find-community' },
    markTone: () => ({ fg: '#000', bg: '#fff', border: '#000' }),
}));
vi.mock('../../components/ListPhoto', () => ({ ListPhoto: ({ photo, fallback }: any) => createElement('div', { 'data-photo': photo ?? '' }, fallback) }));
vi.mock('../../components/AuthorCard', () => ({
    AuthorCard: ({ callsign, label }: any) => createElement('div', { 'data-testid': 'author-card' }, `${label}: ${callsign}`),
    useMemberRating: () => ({ average: null, count: 0 }),
}));
vi.mock('../../components/PhotoCarousel', () => ({ PhotoCarousel: ({ photos }: any) => createElement('div', { 'data-testid': 'photos' }, String(photos.length)) }));
vi.mock('../../components/ReportReasonBox', () => ({ ReportReasonBox: () => createElement('div', { 'data-testid': 'report-box' }) }));
vi.mock('../../components/chat/ChatPhoto', () => ({ ChatPhotoViewer: () => null }));
vi.mock('../../components/signed-request-lines', () => ({ signedRequestWords: (m: string) => m }));
vi.mock('expo-modules-core', () => ({ requireNativeModule: vi.fn(() => ({})), requireOptionalNativeModule: vi.fn(() => null), EventEmitter: vi.fn(() => ({})), NativeModulesProxy: {} }));

import LearnScreen from '../../app/learn';
import { KnowledgeDetail, KnowledgeMissing, hostOf, openableSource } from '../../components/learn/KnowledgeDetail';
import { MarketLearnLine } from '../../components/learn/MarketLearnLine';
import { useKnowledgePage } from '../../components/learn/useKnowledgePage';

let root: Root;
let host: HTMLElement;
beforeEach(() => {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    Object.assign(h, { mode: 'live', params: {}, pages: [], pagesFails: false, identity: { publicKey: 'me'.padEnd(64, '0') }, nodeSearch: null, nodeCalls: [], listeners: {}, opened: [] });
    vi.clearAllMocks();
});
afterEach(() => {
    act(() => root.unmount());
    host.remove();
    vi.useRealTimers();
});

const settle = async () => { await act(async () => { await new Promise((r) => setImmediate(r)); }); };
const show = async (element: any) => { act(() => root.render(element)); await settle(); };
const q = (id: string) => host.querySelector(`[data-testid="${id}"]`) as HTMLElement | null;
const all = (prefix: string) => Array.from(host.querySelectorAll(`[data-testid^="${prefix}"]`)) as HTMLElement[];
const click = (el: Element | null) => { expect(el).toBeTruthy(); act(() => { (el as HTMLElement).click(); }); };
const type = (id: string, text: string) => {
    const input = q(id) as HTMLInputElement;
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    act(() => { set.call(input, text); input.dispatchEvent(new Event('input', { bubbles: true })); });
};
const text = () => host.textContent ?? '';
const titles = () => all('learn-row-').map((r) => r.querySelector('span:nth-of-type(2)')?.textContent);

const NOW = Date.now();
const daysAgo = (d: number) => new Date(NOW - d * 86_400_000).toISOString();
let n = 0;
function page(over: Record<string, any> = {}, knowledge: Record<string, any> = {}) {
    n += 1;
    return {
        id: `k${n}`, type: 'knowledge', title: `Page ${n}`, description: `First line ${n}\nMore.`, category: 'good-to-know', status: 'active', active: 1,
        authorPublicKey: 'b'.repeat(64), authorCallsign: 'Bea', createdAt: daysAgo(30), updatedAt: daysAgo(30),
        knowledge: { sources: [], place: null, lang: 'en', checkedAt: daysAgo(10), outdatedAt: null, outdatedNote: null, helped: 0, gathered: false, ...knowledge },
        ...over,
    };
}

describe("Learn's front", () => {
    it('groups the pages by topic in the fixed order, three rows a topic, and a count on each', async () => {
        h.pages = [
            page({ title: 'Bus times', category: 'getting-around' }),
            ...Array.from({ length: 5 }, (_, i) => page({ title: `Service ${i}`, category: 'local-services' })),
            page({ title: 'Flood line', category: 'emergencies' }),
        ];
        await show(createElement(LearnScreen));
        const blocks = all('learn-block-').map((b) => b.getAttribute('data-testid'));
        expect(blocks).toEqual(['learn-block-emergencies', 'learn-block-local-services', 'learn-block-getting-around']);
        expect(q('learn-block-local-services')!.querySelectorAll('[data-testid^="learn-row-"]')).toHaveLength(3);
        expect(text()).toContain('🚨 Emergencies 1');
        expect(text()).toContain('🚰 Local services 5');
        expect(text()).toContain('See all 5 ›');
        expect(q('learn-see-all-emergencies')).toBeNull();
        expect(text()).toContain('Things worth knowing about your community.');
        expect(text()).toContain('Local knowledge is written by members. Check the source before you rely on it.');
    });

    it('a row draws the topic, the title, its first line and when it was checked, and opens the page on a tap', async () => {
        h.pages = [page({ id: 'tip', title: 'How recycling works at the tip', description: 'Sort it at home.\nGlass in the blue bin.', category: 'local-services', knowledge: { helped: 12, checkedAt: '2026-11-03T00:00:00.000Z' } })];
        await show(createElement(LearnScreen));
        const row = q('learn-row-tip')!;
        expect(row.textContent).toContain('LOCAL SERVICES');
        expect(row.textContent).toContain('How recycling works at the tip');
        expect(row.textContent).toContain('Sort it at home.');
        expect(row.textContent).not.toContain('Glass in the blue bin');
        expect(row.textContent).toContain('Checked Nov 2026');
        expect(row.textContent).toContain('Helped 12');
        expect(row.getAttribute('aria-label')).toBe('Local knowledge: How recycling works at the tip, checked Nov 2026');
        click(row);
        expect(router.push).toHaveBeenCalledWith({ pathname: '/post/[id]', params: { id: 'tip', kind: 'knowledge' } });
    });

    it('marks a pinned page and a page that may be out of date, and says when it was last checked over a year ago', async () => {
        h.pages = [
            page({ id: 'p', title: 'Pinned', category: 'emergencies', pinnedUntil: new Date(NOW + 86_400_000).toISOString() }),
            page({ id: 'o', title: 'Stale', category: 'emergencies' }, { outdatedAt: daysAgo(2), checkedAt: daysAgo(500) }),
        ];
        await show(createElement(LearnScreen));
        expect(q('learn-pinned')!.textContent).toContain('📌 PINNED');
        expect(q('learn-row-o')!.textContent).toContain('MAY BE OUT OF DATE');
        expect(q('learn-row-o')!.textContent).toContain('Checked over a year ago');
    });

    it('with nothing yet says so, and with a pinned page lists it under PINNED first', async () => {
        await show(createElement(LearnScreen));
        expect(q('learn-empty')!.textContent).toBe('Nothing here yet. Know something locals should know?');
    });

    it('"See all" shows that topic alone, every page; All topics goes back; the other topic chips show only their own', async () => {
        h.pages = [...Array.from({ length: 5 }, (_, i) => page({ title: `Service ${i}`, category: 'local-services' })), page({ title: 'Flood line', category: 'emergencies' })];
        await show(createElement(LearnScreen));
        click(q('learn-see-all-local-services'));
        expect(q('learn-topic')).toBeTruthy();
        expect(all('learn-row-')).toHaveLength(5);
        expect(q('learn-block-emergencies')).toBeNull();
        click(q('learn-topic-emergencies'));
        expect(all('learn-row-')).toHaveLength(1);
        click(q('learn-topic-all'));
        expect(q('learn-topic')).toBeNull();
        expect(all('learn-block-')).toHaveLength(2);
    });

    it('opens on the topic or the search it was asked for', async () => {
        h.pages = [page({ title: 'Recycling at the tip', category: 'local-services' }), page({ title: 'Bus times', category: 'getting-around' })];
        h.params = { topic: 'getting-around' };
        await show(createElement(LearnScreen));
        expect(q('learn-topic')).toBeTruthy();
        expect(text()).toContain('Bus times');
        expect(text()).not.toContain('Recycling at the tip');
        act(() => root.unmount());
        root = createRoot(host);
        h.params = { q: 'recycling' };
        await show(createElement(LearnScreen));
        expect((q('learn-search') as HTMLInputElement).value).toBe('recycling');
        expect(all('learn-row-')).toHaveLength(1);
    });

    it('Back goes where the member came from', async () => {
        await show(createElement(LearnScreen));
        click(q('learn-back'));
        expect(router.back).toHaveBeenCalled();
    });

    it('is built from the copy when the copy reads again after a sync', async () => {
        await show(createElement(LearnScreen));
        expect(q('learn-empty')).toBeTruthy();
        h.pages = [page({ title: 'Fresh page', category: 'emergencies' })];
        await act(async () => { (h.listeners.sync_data_updated || []).forEach((fn) => fn()); await new Promise((r) => setImmediate(r)); });
        expect(text()).toContain('Fresh page');
    });

    it('draws no price, no distance, no deal and no Market chips', async () => {
        h.pages = [page({ title: 'Flood line', category: 'emergencies' })];
        await show(createElement(LearnScreen));
        for (const word of ['Offers', 'Needs', 'Events', 'Polls', 'Distance', 'Trust', 'Beans', 'Accept', 'Request']) expect(text()).not.toContain(word);
    });

    it("keeps every control 44 dp or more, and the Back row large enough, at 320 dp", async () => {
        h.pages = [page({ title: 'Flood line', category: 'emergencies' })];
        await show(createElement(LearnScreen));
        for (const id of ['learn-back', 'learn-topic-all']) {
            const small = Number((q(id)!.getAttribute('data-min-height') ?? '99')) < 40;
            expect(small, id).toBe(false);
        }
    });
});

describe('a search', () => {
    const pages = () => [
        page({ id: 'a', title: 'Recycling at the tip', category: 'local-services' }),
        page({ id: 'b', title: 'Opening hours', description: 'Bring recycling sorted.', category: 'good-to-know' }),
        page({ id: 'c', title: 'Bus times', category: 'getting-around' }),
    ];

    it('shows one flat list, best match first, from the copy at once', async () => {
        h.pages = pages();
        await show(createElement(LearnScreen));
        type('learn-search', 'recycling');
        expect(all('learn-row-').map((r) => r.getAttribute('data-testid'))).toEqual(['learn-row-a', 'learn-row-b']);
        expect(q('learn-block-local-services')).toBeNull();
    });

    it("then takes the node's own answer when it comes (its full text search), asked with the words and nothing else", async () => {
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
        h.pages = pages();
        h.nodeSearch = async () => ({ ok: true, json: async () => ({ total: 1, rows: [{ id: 'c', title: 'From the node', line: '', topic: 'getting-around', photo: null, checkedAt: daysAgo(1), helped: 0, pinned: false, outdated: false }] }) });
        await show(createElement(LearnScreen));
        type('learn-search', 'recycling');
        await act(async () => { await vi.advanceTimersByTimeAsync(400); });
        expect(h.nodeCalls).toEqual(['/api/knowledge/front?q=recycling']);
        expect(text()).toContain('From the node');
        expect(q('learn-offline')).toBeNull();
    });

    it("falls back to the copy and says it couldn't reach the community when the node can't be asked", async () => {
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
        h.pages = pages();
        await show(createElement(LearnScreen));
        type('learn-search', 'recycling');
        await act(async () => { await vi.advanceTimersByTimeAsync(400); });
        expect(q('learn-offline')!.textContent).toBe("Couldn't reach your community; showing what we had.");
        expect(all('learn-row-')).toHaveLength(2);
    });

    it('with no match says so and offers the Market, which opens with the same words', async () => {
        h.pages = pages();
        await show(createElement(LearnScreen));
        type('learn-search', 'zebra');
        expect(text()).toContain('Nothing in Learn for "zebra".');
        click(q('learn-search-market'));
        expect(router.navigate).toHaveBeenCalledWith({ pathname: '/(tabs)/market', params: { q: 'zebra' } });
    });

    it('clearing the box goes back to the front', async () => {
        h.pages = pages();
        await show(createElement(LearnScreen));
        type('learn-search', 'recycling');
        click(q('learn-search-clear'));
        expect(q('learn-results')).toBeNull();
        expect(all('learn-block-').length).toBeGreaterThan(0);
    });
});

describe('where Learn is off or not yet known', () => {
    it('shows a spinner until the community’s profile is read, and one line when Learn is not part of this community', async () => {
        h.mode = undefined;
        await show(createElement(LearnScreen));
        expect(q('learn-loading')).toBeTruthy();
        act(() => root.unmount());
        root = createRoot(host);
        h.mode = 'hidden';
        await show(createElement(LearnScreen));
        expect(q('learn-off')!.textContent).toContain('Learn isn’t part of this community.');
        expect(all('learn-row-')).toHaveLength(0);
    });

    it('still reads a copy that will not open as an empty Learn, never a crash', async () => {
        h.pagesFails = true;
        await show(createElement(LearnScreen));
        expect(q('learn-empty')).toBeTruthy();
    });
});

describe("the worldwide community's preview", () => {
    it("draws Example Valley's three pages and every action opens the sheet that leads to a local community", async () => {
        h.mode = 'preview';
        h.pages = [page({ title: 'Must not show' })];
        await show(createElement(LearnScreen));
        expect(q('example-header')!.textContent).toBe('Example Valley');
        expect(all('learn-row-')).toHaveLength(3);
        expect(text()).toContain('Who to call when the creek floods the road');
        expect(text()).not.toContain('Must not show');
        expect(q('modal')).toBeNull();
        click(all('learn-row-')[0]);
        expect(q('learn-preview-sheet')).toBeTruthy();
        expect(text()).toContain('Start a community');
        expect(text()).toContain('Communities near you');
        expect(router.push).not.toHaveBeenCalled();
        expect(h.nodeCalls).toEqual([]);
    });

    it('the search box is a button that opens the same sheet, and no search is sent', async () => {
        h.mode = 'preview';
        await show(createElement(LearnScreen));
        expect(q('learn-search')).toBeNull();
        click(q('learn-search-preview'));
        expect(q('learn-preview-sheet')).toBeTruthy();
        expect(h.nodeCalls).toEqual([]);
    });
});

describe('a page', () => {
    const full = () => page({
        id: 'full', title: 'How recycling works at the tip', description: 'Sort it at home.\nGlass in the blue bin.', category: 'local-services', photos: ['/p/1.jpg'],
    }, {
        place: 'The tip on Manse Road', checkedAt: '2026-11-03T00:00:00.000Z',
        sources: [{ url: 'https://www.council.example.org/tip?x=1', label: 'Council tip page' }, { url: 'https://example.org/bins', label: '' }],
    });

    it('draws the answer first, the place, the photos, the sources with their hosts, when it was checked, the writer and the standing line', async () => {
        await show(createElement(KnowledgeDetail, { page: full() as any }));
        const body = q('knowledge-page')!.textContent!;
        expect(body).toContain('LOCAL KNOWLEDGE');
        expect(body).toContain('🚰 LOCAL SERVICES');
        expect(body).toContain('How recycling works at the tip');
        expect(body).toContain('Sort it at home.\nGlass in the blue bin.');
        expect(body).toContain('Where: The tip on Manse Road');
        expect(q('photos')!.textContent).toBe('1');
        expect(body).toContain('SOURCES');
        expect(body).toContain('Council tip page');
        expect(body).toContain('www.council.example.org');
        // A source with no label shows its host as its name.
        expect(all('knowledge-source')[1].textContent).toContain('example.org');
        expect(body).toContain('Checked Nov 2026');
        expect(q('author-card')!.textContent).toBe('WRITTEN BY: Bea');
        expect(body).toContain('Local knowledge is written by members. Check the source before you rely on it.');
        // The order the design gives: the body before the photos, the photos before the sources, the sources before Checked.
        const order = ['Sort it at home', 'Where: The tip', 'SOURCES', 'Checked Nov 2026', 'WRITTEN BY', 'Check the source'].map((s) => body.indexOf(s));
        expect(order).toEqual([...order].sort((a, b) => a - b));
    });

    it("a source opens the phone's browser with its own address, and nothing else is a link", async () => {
        const { Linking } = await import('react-native');
        await show(createElement(KnowledgeDetail, { page: full() as any }));
        click(all('knowledge-source')[0]);
        expect(Linking.openURL).toHaveBeenCalledWith('https://www.council.example.org/tip?x=1');
        expect(host.querySelectorAll('a')).toHaveLength(0);
    });

    it('a page marked out of date opens with the amber box, the note and when it was marked', async () => {
        await show(createElement(KnowledgeDetail, { page: page({}, { outdatedAt: '2026-11-08T00:00:00.000Z', outdatedNote: 'The tip is closed on Mondays now' }) as any }));
        const box = q('knowledge-outdated')!;
        expect(box.textContent).toContain('This may be out of date.');
        expect(box.textContent).toContain('The tip is closed on Mondays now');
        expect(box.textContent).toContain('Marked 8 Nov 2026');
    });

    it('a page gathered with the assistant names no writer and says so', async () => {
        await show(createElement(KnowledgeDetail, { page: page({}, { gathered: true }) as any }));
        expect(q('knowledge-gathered')!.textContent).toBe('Gathered with the assistant from the sources above.');
        expect(q('author-card')).toBeNull();
    });

    it("says it was written in another language when it was, and not when it is the reader's", async () => {
        await show(createElement(KnowledgeDetail, { page: page({}, { lang: 'fr' }) as any }));
        expect(text()).toContain('Written in Français');
        act(() => root.unmount());
        root = createRoot(host);
        await show(createElement(KnowledgeDetail, { page: page({}, { lang: 'en' }) as any }));
        expect(text()).not.toContain('Written in');
    });

    it('opens only http and https addresses with no user name or password: any other address the node sent gets no link', async () => {
        const { Linking } = await import('react-native');
        await show(createElement(KnowledgeDetail, {
            page: page({}, {
                sources: [
                    { url: 'javascript:alert(1)', label: 'Script' },
                    { url: 'intent://scan/#Intent;scheme=zxing;end', label: 'Intent' },
                    { url: 'tel:+61400000000', label: 'Phone' },
                    { url: 'https://user:secret@example.org/a', label: 'With a password' },
                    { url: 'ftp://example.org/file', label: 'File server' },
                    { url: 'https://example.org/' + 'a'.repeat(500), label: 'Too long' },
                    { url: 'http://example.org/ok', label: 'Fine' },
                ],
            }) as any,
        }));
        const links = all('knowledge-source');
        expect(links).toHaveLength(1);
        expect(links[0].textContent).toContain('Fine');
        click(links[0]);
        expect(Linking.openURL).toHaveBeenCalledTimes(1);
        expect(Linking.openURL).toHaveBeenCalledWith('http://example.org/ok');
        for (const bad of ['Script', 'Intent', 'Phone', 'With a password', 'File server', 'Too long']) expect(text()).not.toContain(bad);
        expect(openableSource('https://example.org')).toBe(true);
        expect(openableSource(null)).toBe(false);
        expect(openableSource('not a url')).toBe(false);
    });

    it('a page with no source, no place and no photo draws none of those', async () => {
        await show(createElement(KnowledgeDetail, { page: page({}, { sources: [], place: null }) as any }));
        expect(text()).not.toContain('SOURCES');
        expect(text()).not.toContain('Where:');
        expect(q('photos')).toBeNull();
    });

    it('offers Report to a member who is not its writer, and not to the writer; it draws no price, no deal and no pin on a map', async () => {
        await show(createElement(KnowledgeDetail, { page: full() as any }));
        click(q('knowledge-report'));
        expect(q('report-box')).toBeTruthy();
        for (const word of ['Accept', 'Request', 'Beans', 'Offer', 'Need']) expect(text()).not.toContain(word);
        act(() => root.unmount());
        root = createRoot(host);
        h.identity = { publicKey: 'b'.repeat(64) };
        await show(createElement(KnowledgeDetail, { page: full() as any }));
        expect(q('knowledge-report')).toBeNull();
    });

    it('Back leaves the page', async () => {
        await show(createElement(KnowledgeDetail, { page: full() as any }));
        click(q('knowledge-back'));
        expect(router.back).toHaveBeenCalled();
    });

    it('a page that is not there reads one line and Back, after a spinner while it looks', async () => {
        await show(createElement(KnowledgeMissing, { settled: false }));
        expect(q('knowledge-missing')!.textContent).toBe('');
        await show(createElement(KnowledgeMissing, { settled: true }));
        expect(q('knowledge-missing')!.textContent).toContain('This page isn’t in Learn any more.');
    });

    it('shows a source’s host, or the whole text when it is not an address', () => {
        expect(hostOf('https://www.example.org/a/b?c=1')).toBe('www.example.org');
        expect(hostOf('not an address')).toBe('not an address');
    });
});

describe("the Market's one line", () => {
    const withPages = () => { h.pages = [page({ title: 'Recycling at the tip' }), page({ title: 'Tip jar', category: 'local-services' }), page({ title: 'Bus times', category: 'getting-around' })]; };
    const line = async (words: string) => { await show(createElement(MarketLearnLine, { words })); await act(async () => { vi.advanceTimersByTime(300); await Promise.resolve(); await Promise.resolve(); }); };

    beforeEach(() => { vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] }); });

    it('says how many pages Learn has for the words and opens Learn with them', async () => {
        withPages();
        await line('tip');
        const el = q('market-learn-line')!;
        expect(el.textContent).toBe('📖 In Learn: 2 for "tip" ›');
        expect(el.getAttribute('data-min-height')).toBe('44');
        click(el);
        expect(router.push).toHaveBeenCalledWith({ pathname: '/learn', params: { q: 'tip' } });
    });

    it('draws nothing with no words, with no match, where Learn is off or only previewed, or when the copy will not read', async () => {
        withPages();
        await line('');
        expect(q('market-learn-line')).toBeNull();
        await line('zebra');
        expect(q('market-learn-line')).toBeNull();
        h.mode = 'preview';
        await line('tip');
        expect(q('market-learn-line')).toBeNull();
        h.mode = 'hidden';
        await line('tip');
        expect(q('market-learn-line')).toBeNull();
        h.mode = 'live';
        h.pagesFails = true;
        await line('tip');
        expect(q('market-learn-line')).toBeNull();
    });

    it('waits for a pause in the typing before it reads the copy', async () => {
        const { getKnowledgePosts } = await import('../db');
        withPages();
        await show(createElement(MarketLearnLine, { words: 't' }));
        await show(createElement(MarketLearnLine, { words: 'ti' }));
        await show(createElement(MarketLearnLine, { words: 'tip' }));
        expect(getKnowledgePosts).not.toHaveBeenCalled();
        await act(async () => { vi.advanceTimersByTime(300); await Promise.resolve(); await Promise.resolve(); });
        expect(getKnowledgePosts).toHaveBeenCalledTimes(1);
    });

    it('counts again when a sync or a pushed take-down changes the copy under words already typed (review of #3070)', async () => {
        withPages();
        await line('tip');
        expect(q('market-learn-line')!.textContent).toBe('📖 In Learn: 2 for "tip" ›');
        h.pages = h.pages.filter((p) => p.title !== 'Tip jar');
        await act(async () => { (h.listeners.sync_data_updated || []).forEach((fn) => fn()); await Promise.resolve(); await Promise.resolve(); });
        expect(q('market-learn-line')!.textContent).toBe('📖 In Learn: 1 for "tip" ›');
        h.pages = [];
        await act(async () => { (h.listeners.sync_data_updated || []).forEach((fn) => fn()); await Promise.resolve(); await Promise.resolve(); });
        expect(q('market-learn-line')).toBeNull();
    });
});

describe('the post route’s hook: which page a route names', () => {
    function Probe({ id, asked }: { id: string; asked: boolean }) {
        const { page: p, settled } = useKnowledgePage(id, asked);
        return createElement('div', { 'data-testid': 'probe' }, `${p ? p.title : 'none'}|${settled ? 'settled' : 'looking'}`);
    }
    const probe = () => q('probe')!.textContent;

    it('finds a page in the copy and asks the node nothing', async () => {
        h.pages = [page({ id: 'held', title: 'Held page' })];
        await show(createElement(Probe, { id: 'held', asked: true }));
        expect(probe()).toBe('Held page|settled');
        expect(h.nodeCalls).toEqual([]);
    });

    it('a route that says it is a page and finds none in the copy asks the node by id, naming the type', async () => {
        const fromNode = page({ id: 'far', title: 'From the node' });
        h.nodeSearch = async () => ({ ok: true, json: async () => [fromNode] });
        await show(createElement(Probe, { id: 'far', asked: true }));
        expect(probe()).toBe('From the node|settled');
        expect(h.nodeCalls).toEqual(['/api/marketplace/posts?type=knowledge&id=far']);
    });

    it('a route with no kind (an ordinary listing, or a pasted link) never asks the node, and settles with no page', async () => {
        await show(createElement(Probe, { id: 'listing-1', asked: false }));
        expect(probe()).toBe('none|settled');
        expect(h.nodeCalls).toEqual([]);
    });

    it('a page the node does not have, or cannot be asked for, settles with no page', async () => {
        await show(createElement(Probe, { id: 'gone', asked: true }));
        expect(probe()).toBe('none|settled');
        h.nodeSearch = async () => ({ ok: true, json: async () => [] });
        act(() => root.unmount());
        root = createRoot(host);
        await show(createElement(Probe, { id: 'gone', asked: true }));
        expect(probe()).toBe('none|settled');
    });

    it('a page that arrives with a sync is found when the copy reads again', async () => {
        await show(createElement(Probe, { id: 'late', asked: false }));
        expect(probe()).toBe('none|settled');
        h.pages = [page({ id: 'late', title: 'Arrived' })];
        await act(async () => { (h.listeners.sync_data_updated || []).forEach((fn) => fn()); await new Promise((r) => setImmediate(r)); });
        expect(probe()).toBe('Arrived|settled');
    });

    // An open page leaves when it leaves (review of #3070, finding 2). `isPage` keeps a route that showed a page a page's route,
    // so PostRoute draws "This page isn't in Learn any more" and not the listing screen.
    function PageProbe({ id, asked }: { id: string; asked: boolean }) {
        const { page: p, settled, isPage } = useKnowledgePage(id, asked);
        return createElement('div', { 'data-testid': 'probe' }, `${p ? p.title : 'none'}|${settled ? 'settled' : 'looking'}|${isPage ? 'page' : 'listing?'}`);
    }
    const syncLands = async () => {
        await act(async () => { (h.listeners.sync_data_updated || []).forEach((fn) => fn()); await new Promise((r) => setImmediate(r)); });
    };

    it('a page from the copy that the copy no longer holds is gone, with or without a kind, and the route stays a page’s', async () => {
        for (const asked of [false, true]) {
            h.pages = [page({ id: 'held', title: 'Held page' })];
            h.nodeSearch = null; // out of reach: the copy's word is enough
            act(() => root.unmount());
            root = createRoot(host);
            await show(createElement(PageProbe, { id: 'held', asked }));
            expect(probe()).toBe('Held page|settled|page');
            h.pages = [];
            await syncLands();
            expect(probe()).toBe('none|settled|page');
        }
    });

    it('a page from the node stays while the node is out of reach, and goes when the node answers without it', async () => {
        const fromNode = page({ id: 'far', title: 'From the node' });
        h.nodeSearch = async () => ({ ok: true, json: async () => [fromNode] });
        await show(createElement(PageProbe, { id: 'far', asked: true }));
        expect(probe()).toBe('From the node|settled|page');
        h.nodeSearch = null;
        await syncLands();
        expect(probe()).toBe('From the node|settled|page');
        h.nodeSearch = async () => ({ ok: false, status: 503, json: async () => ({}) });
        await syncLands();
        expect(probe()).toBe('From the node|settled|page');
        h.nodeSearch = async () => ({ ok: true, json: async () => [] });
        await syncLands();
        expect(probe()).toBe('none|settled|page');
        // Said once: not asked again on every sync after it.
        const asks = h.nodeCalls.length;
        await syncLands();
        expect(h.nodeCalls.length).toBe(asks);
    });

    it('a route with no kind whose id is no page is never a page’s route (the listing screen draws)', async () => {
        await show(createElement(PageProbe, { id: 'listing-1', asked: false }));
        expect(probe()).toBe('none|settled|listing?');
        await syncLands();
        expect(probe()).toBe('none|settled|listing?');
        expect(h.nodeCalls).toEqual([]);
    });
});
