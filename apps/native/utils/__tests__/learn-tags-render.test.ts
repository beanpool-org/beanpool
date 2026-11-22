// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement, useEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';

(globalThis as any).__DEV__ = false;
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

// Learn's tags on the phone (16 Nov 2026; the node is #3219). One table over each place the phone writes tags (a suggestion, a
// fix, an owner's or admin's edit) and each state of them (none, some, taken off, only the tags changed): what the form opens on
// and what it sends. To check (Approve, "Edit first") is the web's alone for now, held in apps/pwa/src/pages/LearnPage.tags.test.tsx.
// Then a page shows its tags and a tap opens Learn on a search for one, and the phone's own search finds a page by a tag offline.
// The node, the router, the role, the copy and the Tags field are faked at their edges (learn-keep-render.test.ts's harness).

const ME = 'me'.padEnd(64, '0');
const h = vi.hoisted(() => ({
    mode: 'live' as 'live' | 'preview' | 'hidden' | undefined,
    params: {} as Record<string, string>,
    checks: false,
    identity: null as null | { publicKey: string; privateKey: string },
    pages: [] as any[],
    byId: null as null | Record<string, unknown>,
    sent: [] as Array<{ method: string; path: string; body: any }>,
    refuse: null as null | { status?: number; message: string; code?: string },
    // Who listens for a sync (useKnowledgePage): a test fires `sync_data_updated` as the phone's sync does when it lands.
    listeners: [] as Array<{ event: string; fn: () => void }>,
    picker: null as null | Record<string, any>,
}));
const router = vi.hoisted(() => ({ push: vi.fn(), back: vi.fn(), replace: vi.fn(), navigate: vi.fn(), canGoBack: vi.fn(() => true) }));

vi.mock('expo-router', () => ({
    useRouter: () => router, useLocalSearchParams: () => h.params, router,
    useFocusEffect: (fn: () => void | (() => void)) => { useEffect(() => fn(), [fn]); },
}));
vi.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }) }));
vi.mock('react-native-keyboard-controller', () => ({ KeyboardAwareScrollView: ({ children }: any) => createElement('div', null, children) }));
vi.mock('expo-image', () => ({ Image: () => null }));
vi.mock('react-native', async () => {
    const { createElement: el } = await import('react');
    const host = (tag: string) => function Host(props: Record<string, any>) {
        const { children, onPress, accessibilityLabel, testID, disabled, accessibilityState } = props;
        const attrs: Record<string, unknown> = {};
        if (onPress && !disabled) attrs.onClick = () => onPress({ stopPropagation() {} });
        if (disabled) attrs['data-disabled'] = 'true';
        if (accessibilityLabel) attrs['aria-label'] = accessibilityLabel;
        if (accessibilityState?.selected) attrs['aria-selected'] = 'true';
        if (testID) attrs['data-testid'] = testID;
        return el(tag, attrs, children);
    };
    return {
        View: host('div'), Text: host('span'), Pressable: host('button'), ScrollView: host('div'), ActivityIndicator: host('i'),
        TextInput: ({ value, onChangeText, testID, placeholder }: any) => el('input', { value, placeholder, 'data-testid': testID, onChange: (e: any) => onChangeText(e.target.value) }),
        StyleSheet: { create: (s: unknown) => s, flatten: (s: unknown) => s, hairlineWidth: 1 },
        DeviceEventEmitter: {
            addListener: (event: string, fn: () => void) => {
                const l = { event, fn };
                h.listeners.push(l);
                return { remove: () => { h.listeners = h.listeners.filter((x) => x !== l); } };
            },
            emit: vi.fn(),
        },
        Keyboard: { dismiss: vi.fn() },
        Linking: { openURL: vi.fn(async () => {}) },
        Alert: { alert: vi.fn() },
    };
});
vi.mock('../../app/ThemeContext', async () => {
    const { lightColors } = await import('../../constants/colors');
    return { useTheme: () => ({ theme: 'light', colors: lightColors }), useStyles: (make: any) => make({ theme: 'light', colors: lightColors }) };
});
vi.mock('../../app/IdentityContext', () => ({ useIdentity: () => ({ identity: h.identity }) }));
vi.mock('../use-learn-mode', () => ({ useLearnMode: () => h.mode }));
vi.mock('../../components/learn/useLearnWriter', () => ({
    useLearnWriter: (live: boolean) => (live ? { checks: h.checks, waiting: 0 } : { checks: false, waiting: 0 }),
    readMyDrafts: vi.fn(async () => null),
    forgetLearnRole: vi.fn(async () => {}),
}));
vi.mock('../post-photo', () => ({ askForPostPhoto: vi.fn() }));
// The form's Edit draws a page's pictures against the node's address (learn-keep.ts pagePhotoUri): read from the phone's store on a device.
vi.mock('../node-post', () => ({ anchorUrl: vi.fn(async () => 'https://node.test') }));
vi.mock('../db', () => ({
    getKnowledgePost: vi.fn(async (id: string) => h.pages.find((p) => p.id === id) ?? null),
    signedGet: vi.fn(async () => {
        if (!h.byId) throw new Error('offline');
        return { ok: true, json: async () => [h.byId] };
    }),
    signedRequestWithMethod: vi.fn(async (method: string, path: string, body: any) => {
        h.sent.push({ method, path, body });
        const r = h.refuse;
        if (r) throw Object.assign(new Error(r.message), r.status === undefined ? {} : { status: r.status, code: r.code });
        const p = h.pages[0];
        if (path.endsWith('/helped')) return { helped: (p.knowledge.helped ?? 0) + (body.on ? 1 : -1), helpedByMe: body.on };
        if (path.endsWith('/checked')) return { post: { ...p, knowledge: { ...p.knowledge, checkedAt: '2026-11-16T00:00:00.000Z', outdatedAt: null, outdatedNote: null } } };
        if (path.endsWith('/outdated')) return { post: { ...p, knowledge: { ...p.knowledge, outdatedAt: '2026-11-16T00:00:00.000Z', outdatedNote: body.note || null } } };
        if (path.endsWith('/outdated/clear')) return { post: { ...p, knowledge: { ...p.knowledge, outdatedAt: null, outdatedNote: null } } };
        if (path.endsWith('/edit')) return { post: { ...p, title: body.title } };
        if (path === '/api/knowledge/drafts') return { draft: { id: 'fix-1', kind: 'fix', fixOf: p.id } };
        return {};
    }),
    reportAbuse: vi.fn(async () => ({})),
}));
vi.mock('../../components/AuthorCard', () => ({
    AuthorCard: ({ callsign, label }: any) => createElement('div', { 'data-testid': 'author-card' }, `${label}: ${callsign}`),
    useMemberRating: () => ({ average: null, count: 0 }),
}));
vi.mock('../../components/PhotoCarousel', () => ({ PhotoCarousel: () => null }));
vi.mock('../../components/ReportReasonBox', () => ({ ReportReasonBox: () => null }));
vi.mock('../../components/chat/ChatPhoto', () => ({ ChatPhotoViewer: () => null }));
vi.mock('../../components/signed-request-lines', () => ({ signedRequestWords: (m: string) => m }));
vi.mock('expo-modules-core', () => ({ requireNativeModule: vi.fn(() => ({})), requireOptionalNativeModule: vi.fn(() => null), EventEmitter: vi.fn(() => ({})), NativeModulesProxy: {} }));

// The form's Tags field is the Market's picker, faked here at its props (its free-only sheet is held for real in
// tag-picker-sheet-render.test.ts): each tag as a chip whose tap takes it off, as the real one draws them.
vi.mock('../../components/TagPicker', async () => {
    const { createElement: el } = await import('react');
    return {
        TagPicker: (props: Record<string, any>) => {
            h.picker = props;
            return el('div', { 'data-testid': props.testID }, ...(props.freeTags ?? []).map((tag: string) =>
                el('button', { key: tag, 'aria-label': `Remove #${tag}`, onClick: () => props.onFreeTagsChange(props.freeTags.filter((x: string) => x !== tag)) }, `#${tag}`)));
        },
    };
});

import { learnSearch } from '../learn-copy';
import { KnowledgeDetail } from '../../components/learn/KnowledgeDetail';
import NewKnowledgeScreen from '../../app/learn/new';

const page = (freeTags?: string[]) => ({
    id: 'tip', title: 'How recycling works at the tip', description: 'Sort it first.', category: 'local-services', photos: [],
    authorPublicKey: 'ada'.padEnd(64, '0'), authorCallsign: 'Ada', status: 'active', active: true, ...(freeTags ? { freeTags } : {}),
    knowledge: {
        sources: [{ url: 'https://council.example/tip', label: 'Council tip page' }], place: 'Manse Road', lang: null,
        checkedAt: '2026-10-20T00:00:00.000Z', outdatedAt: null, outdatedNote: null, helped: 2, gathered: false,
    },
});

let root: Root;
let host: HTMLElement;
beforeEach(() => {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    Object.assign(h, { mode: 'live', params: {}, checks: false, identity: { publicKey: ME, privateKey: 'p' }, pages: [page()], byId: null, sent: [], refuse: null, listeners: [], picker: null });
    vi.clearAllMocks();
});
afterEach(() => {
    act(() => root.unmount());
    host.remove();
});

const settle = async () => { await act(async () => { await new Promise((r) => setImmediate(r)); }); };
const show = async (element: any) => { act(() => root.render(element)); await settle(); };
const q = (id: string) => host.querySelector(`[data-testid="${id}"]`) as HTMLElement | null;
const click = async (id: string) => { const el = q(id); expect(el, id).toBeTruthy(); await act(async () => { el!.click(); }); await settle(); };
const type = (id: string, text: string) => {
    const input = q(id) as HTMLInputElement;
    expect(input, id).toBeTruthy();
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    act(() => { set.call(input, text); input.dispatchEvent(new Event('input', { bubbles: true })); });
};
/** The chips the form's Tags field holds, as drawn. */
const formTags = () => Array.from(q('learn-new-tags')?.querySelectorAll('button') ?? []).map((b) => b.textContent);
/** What the Market's picker hands back when the member adds a tag (its stored form). */
const addTag = async (tag: string) => { act(() => h.picker!.onFreeTagsChange([...h.picker!.freeTags, tag])); await settle(); };
const takeOff = async (tag: string) => {
    const b = host.querySelector(`[aria-label="Remove #${tag}"]`) as HTMLElement;
    expect(b, tag).toBeTruthy();
    await act(async () => { b.click(); });
    await settle();
};

type Use = 'suggest' | 'fix' | 'edit';
type Tags = 'none' | 'tags' | 'taken off' | 'only tags';
interface Cell { start?: string[]; act: () => Promise<void>; opens: string[]; sent: Record<string, unknown>; absent?: string[] }
const CELLS: Record<Use, Record<Tags, Cell>> = {
    suggest: {
        // A new page sends its tags only when it has some: none is none to the node.
        none: { act: async () => {}, opens: [], sent: {}, absent: ['freeTags'] },
        tags: { act: async () => { await addTag('bulk waste'); await addTag('tip'); }, opens: [], sent: { freeTags: ['bulk waste', 'tip'] } },
        'taken off': { act: async () => { await addTag('bulk waste'); await addTag('tip'); await takeOff('bulk waste'); }, opens: [], sent: { freeTags: ['tip'] } },
        'only tags': { act: async () => { await addTag('lemon'); }, opens: [], sent: { freeTags: ['lemon'] }, absent: ['tags'] },
    },
    fix: {
        none: { act: async () => { type('learn-new-body', 'Sort it first. Closed Mondays.'); }, opens: [], sent: { body: 'Sort it first. Closed Mondays.' }, absent: ['freeTags'] },
        tags: { act: async () => { await addTag('ferry'); }, opens: [], sent: { freeTags: ['ferry'] }, absent: ['title', 'body', 'topic', 'place', 'sources'] },
        'taken off': { start: ['tip', 'bulk waste'], act: async () => { await takeOff('tip'); await takeOff('bulk waste'); }, opens: ['#tip', '#bulk waste'], sent: { freeTags: [] }, absent: ['title', 'body'] },
        'only tags': { start: ['tip'], act: async () => { await takeOff('tip'); await addTag('tip shop'); }, opens: ['#tip'], sent: { freeTags: ['tip shop'] }, absent: ['title', 'body', 'topic', 'place', 'sources'] },
    },
    edit: {
        none: { act: async () => { type('learn-new-title', 'Recycling at the tip'); }, opens: [], sent: { title: 'Recycling at the tip', freeTags: [] } },
        tags: { act: async () => { await addTag('ferry'); }, opens: [], sent: { freeTags: ['ferry'] } },
        'taken off': { start: ['tip'], act: async () => { await takeOff('tip'); }, opens: ['#tip'], sent: { freeTags: [] } },
        'only tags': { start: ['tip'], act: async () => { await addTag('ferry'); }, opens: ['#tip'], sent: { title: 'How recycling works at the tip', freeTags: ['tip', 'ferry'] } },
    },
};
const ROWS = (Object.keys(CELLS) as Use[]).flatMap((use) => (Object.keys(CELLS[use]) as Tags[]).map((tags) => [use, tags] as const));

describe('the table: (suggest, fix, owner edit) x (no tags, tags, taken off, only the tags changed)', () => {
    it.each(ROWS)('%s, %s: what the form opens on, what is sent', async (use, tags) => {
        const cell = CELLS[use][tags];
        h.pages = [page(cell.start)];
        if (use === 'edit') { h.checks = true; h.byId = { ...page(cell.start), type: 'knowledge' }; }
        h.params = use === 'suggest' ? {} : { [use]: 'tip' };
        await show(createElement(NewKnowledgeScreen));
        // The Market's own Tags field, the member's own tags alone, with Learn's line in place of the Market's two.
        expect(h.picker?.freeOnly).toBe(true);
        expect(h.picker?.hints).toEqual(['Tags help people find this page in Learn. Everyone can see them.']);
        expect(formTags()).toEqual(cell.opens);
        if (use === 'suggest') {
            type('learn-new-title', 'Bulk waste days');
            type('learn-new-body', 'Twice a year.');
            await click('learn-new-topic-local-services');
        }
        if (use === 'fix') type('learn-new-note', 'Changed');
        await cell.act();
        await click('learn-new-send');
        expect(h.sent).toHaveLength(1);
        const path = { suggest: '/api/knowledge/drafts', fix: '/api/knowledge/drafts', edit: '/api/knowledge/posts/tip/edit' }[use];
        expect(h.sent[0].path).toBe(path);
        expect(h.sent[0].body).toMatchObject(cell.sent);
        for (const key of cell.absent ?? []) expect(h.sent[0].body, key).not.toHaveProperty(key);
        expect(h.sent[0].body.tags).toBeUndefined();
    });
});

describe('a page shows its tags; a tap opens Learn on a search for one', () => {
    it('each tag as #word, named for a screen reader as a Learn search, opening Learn with q', async () => {
        h.pages = [page(['bulk waste', 'tip'])];
        await show(createElement(KnowledgeDetail, { page: h.pages[0] }));
        const chips = Array.from(q('detail-tags-row')?.querySelectorAll('button') ?? []);
        expect(chips.map((c) => c.textContent)).toEqual(['#bulk waste', '#tip']);
        expect(chips[0].getAttribute('aria-label')).toBe('Search Learn for #bulk waste');
        await act(async () => { (chips[0] as HTMLElement).click(); });
        // Encoded once more: expo-router's useLocalSearchParams decodes the params again (PostTagChips.tsx:47-48), as the Market's tap does.
        expect(router.push).toHaveBeenCalledWith({ pathname: '/learn', params: { q: encodeURIComponent('bulk waste') } });
    });

    it('a tag holding a percent escape reaches Learn as that tag, not decoded into other words (#3224 review)', async () => {
        h.pages = [page(['a%20b'])];
        await show(createElement(KnowledgeDetail, { page: h.pages[0] }));
        const chip = q('detail-tags-row')?.querySelector('button') as HTMLElement;
        await act(async () => { chip.click(); });
        const sent = (router.push as any).mock.calls.at(-1)[0].params.q as string;
        expect(decodeURIComponent(sent)).toBe('a%20b');
    });

    it('a page with no tags draws no row', async () => {
        await show(createElement(KnowledgeDetail, { page: h.pages[0] }));
        expect(q('detail-tags-row')).toBeNull();
    });

    it("the phone's own search finds a page by a tag, in any case, ranked as the place", () => {
        const pages = [page(['bulk waste']), { ...page(), id: 'other', title: 'Ferry times' }];
        expect(learnSearch(pages as any, 'BULK').rows.map((r) => r.id)).toEqual(['tip']);
        expect(learnSearch(pages as any, 'ferry').rows.map((r) => r.id)).toEqual(['other']);
    });
});
