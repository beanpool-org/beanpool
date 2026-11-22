// @vitest-environment jsdom
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement, useEffect, type ReactElement, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { type SQLInputValue } from 'node:sqlite';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

(globalThis as any).__DEV__ = false;
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

// Learn's pictures draw on a phone (review of #3355: the node gives a page's pictures as paths, "/api/marketplace/posts/<id>/photos/
// <n>?v=…&k=…", and the phone handed them to expo-image as given, so a page's carousel was blank and a row fell back to its topic's
// tile). What is real here: the phone's copy (db.ts over node:sqlite, pages written raw by the sync's own writer, as phones hold
// them now), Learn, the page and its route's hook, its Edit, the row card, the Pulse's tab and its Learn card, Home's card, the carousel,
// the list photo. What stands in: React Native's hosts, expo-image (as a phone's loader: a whole address loads, a bare path never
// does, and every address asked is noted), the router, the creator's Pulse card and the viewer (which say the address they were handed).
// The last part is the class: every place × (the community in use, another one) → the address asked (review of #3355 at 84e1d902).

const VALLEY = 'https://valley.example.org';
const RIDGE = 'https://ridge.example.org';
const ME = 'me'.padEnd(64, '0');

const h = vi.hoisted(() => ({
    dir: '',
    anchor: 'https://valley.example.org' as string | null,
    /** The address changes under a read: after this many more reads of it, it is the next one (a switch landing). */
    switchAfter: null as null | { reads: number; to: string },
    store: new Map<string, string>(),
    theme: 'light' as 'light' | 'dark',
    params: {} as Record<string, string>,
    /** What the node answers a request (null: not reached); a Response as it is, anything else as JSON. */
    node: null as null | ((path: string, method: string) => unknown),
    listeners: [] as Array<{ event: string; fn: (x?: unknown) => void }>,
    checks: false,
    /** Every address the loader was handed, in order, once per picture mounted or changed. */
    asked: [] as string[],
    /** The Pulse's list: its rows off the screen (not mounted, as a virtualised list has them), its refresh and its next page. */
    rowsOff: false,
    list: {} as { refresh?: () => unknown; more?: () => unknown },
}));
const router = vi.hoisted(() => ({ push: vi.fn(), back: vi.fn(), replace: vi.fn(), navigate: vi.fn(), canGoBack: vi.fn(() => true) }));

vi.mock('expo-sqlite', async () => {
    const { DatabaseSync: Sqlite } = await import('node:sqlite');
    const { join } = await import('node:path');
    const params = (p: unknown) => (p === undefined ? [] : Array.isArray(p) ? p : [p]) as SQLInputValue[];
    return {
        get defaultDatabaseDirectory() { return `file://${h.dir}`; },
        openDatabaseAsync: vi.fn(async (name: string) => {
            const sql = new Sqlite(join(h.dir, name));
            const exec = async (q: string) => { sql.exec(q); };
            return {
                databasePath: name,
                execAsync: exec,
                getFirstAsync: async (q: string, p?: unknown) => (sql.prepare(q).get(...params(p)) as unknown) ?? null,
                getAllAsync: async (q: string, p?: unknown) => sql.prepare(q).all(...params(p)) as unknown[],
                runAsync: async (q: string, p?: unknown) => {
                    const r = sql.prepare(q).run(...params(p));
                    return { changes: Number(r.changes), lastInsertRowId: Number(r.lastInsertRowid) };
                },
                withTransactionAsync: async (task: () => Promise<void>) => {
                    await exec('BEGIN');
                    try { await task(); await exec('COMMIT'); } catch (e) { await exec('ROLLBACK'); throw e; }
                },
                closeAsync: async () => { sql.close(); },
            };
        }),
    };
});
vi.mock('@react-native-async-storage/async-storage', () => ({
    default: {
        getItem: vi.fn(async (k: string) => {
            if (k !== 'beanpool_anchor_url') return h.store.get(k) ?? null;
            if (h.switchAfter && h.switchAfter.reads-- <= 0) { h.anchor = h.switchAfter.to; h.switchAfter = null; }
            return h.anchor;
        }),
        setItem: vi.fn(async (k: string, v: string) => { h.store.set(k, String(v)); }),
        removeItem: vi.fn(async (k: string) => { h.store.delete(k); }),
        getAllKeys: vi.fn(async () => [...h.store.keys()]),
        multiRemove: vi.fn(async (keys: string[]) => { for (const k of keys) h.store.delete(k); }),
    },
}));
vi.mock('expo-crypto', () => ({ randomUUID: () => 'test-uuid', getRandomBytes: (n: number) => new Uint8Array(n) }));
vi.mock('expo-file-system/legacy', () => ({
    cacheDirectory: '/tmp/cache/',
    getInfoAsync: vi.fn(async (uri: string) => ({ exists: fs.existsSync(uri.replace(/^file:\/\//, '')) })),
    makeDirectoryAsync: vi.fn().mockResolvedValue(undefined),
    writeAsStringAsync: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('expo-constants', () => ({ default: { expoConfig: undefined } }));
vi.mock('expo-modules-core', () => ({ requireNativeModule: vi.fn(() => ({})), requireOptionalNativeModule: vi.fn(() => null), EventEmitter: vi.fn(() => ({})), NativeModulesProxy: {} }));
vi.mock('../identity', () => ({ loadIdentity: vi.fn(async () => ({ publicKey: ME, privateKey: '11'.repeat(32), callsign: 'Me' })) }));
vi.mock('../nodes', async (real) => ({
    ...(await real<typeof import('../nodes')>()),
    getDatabaseFilenameForNode: vi.fn((url: string | null) => (url ? `beanpool_${new URL(url).hostname}.db` : 'beanpool_none.db')),
    addSavedNode: vi.fn(async () => {}),
}));
vi.mock('../canonical-profile', () => ({ getCanonicalProfile: vi.fn(async () => null), saveCanonicalProfile: vi.fn(async () => {}) }));

vi.mock('expo-router', () => ({
    useRouter: () => router, useLocalSearchParams: () => h.params, router,
    useFocusEffect: (fn: () => void | (() => void)) => { useEffect(() => fn(), [fn]); },
}));
vi.mock('@expo/vector-icons', () => ({ MaterialCommunityIcons: () => createElement('i') }));
vi.mock('react-native-safe-area-context', () => ({
    useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }), SafeAreaView: ({ children }: any) => createElement('div', null, children),
}));
vi.mock('react-native-keyboard-controller', () => ({ KeyboardAwareScrollView: ({ children }: any) => createElement('div', null, children) }));
// expo-image as a phone has it: a whole address (http, https, data:) loads; anything else, a bare path above all, never does.
vi.mock('expo-image', async () => {
    const { createElement: el, useEffect: effect } = await import('react');
    const flat = (s: unknown): Record<string, unknown> => Object.assign({}, ...[s].flat(4).filter((x) => x && typeof x === 'object'));
    return {
        Image: ({ source, style, accessibilityLabel, onLoad, onError, testID }: any) => {
            const uri: string | undefined = source?.uri;
            effect(() => {
                if (!uri) return;
                h.asked.push(uri);
                if (/^(https?:\/\/|data:)/.test(uri)) onLoad?.(); else onError?.();
            }, [uri]);
            return el('img', { 'data-src': uri, 'aria-label': accessibilityLabel, 'data-testid': testID, 'data-style': JSON.stringify(flat(style)) });
        },
    };
});
// An Android 8 phone (API 26), the oldest the app runs on, 320 dp wide with its text at 1.3x.
vi.mock('react-native', async () => {
    const { createElement: el, useEffect: effect, Fragment } = await import('react');
    const FlatList = ({ data, renderItem, keyExtractor, refreshControl, onEndReached }: Record<string, any>) => {
        h.list = { refresh: refreshControl?.props?.onRefresh, more: onEndReached };
        return el('div', null, h.rowsOff ? null : (data ?? []).map((item: any, index: number) => el(Fragment, { key: keyExtractor(item, index) }, renderItem({ item, index }))));
    };
    const flat = (s: unknown): Record<string, any> => Object.assign({}, ...[s].flat(4).filter((x) => x && typeof x === 'object'));
    const host = (tag: string) => function Host(props: Record<string, any>) {
        const { children, onPress, onLayout, accessibilityLabel, accessibilityRole, testID, disabled, numberOfLines } = props;
        effect(() => { onLayout?.({ nativeEvent: { layout: { x: 0, y: 0, width: 288, height: 220 } } }); }, []);
        const attrs: Record<string, unknown> = {
            'data-style': JSON.stringify(flat(typeof props.style === 'function' ? props.style({ pressed: false }) : props.style)),
        };
        if (tag === 'div' && props.contentContainerStyle) attrs['data-style'] = JSON.stringify(flat(props.contentContainerStyle));
        if (onPress && !disabled) attrs.onClick = () => onPress({ stopPropagation() {} });
        if (accessibilityLabel) attrs['aria-label'] = accessibilityLabel;
        if (accessibilityRole) attrs['data-role'] = accessibilityRole;
        if (testID) attrs['data-testid'] = testID;
        if (numberOfLines) attrs['data-lines'] = String(numberOfLines);
        return el(tag, attrs, children);
    };
    return {
        Platform: { OS: 'android', Version: 26, select: (o: Record<string, unknown>) => o.android ?? o.default },
        useWindowDimensions: () => ({ width: 320, height: 569, fontScale: 1.3, scale: 2 }),
        View: host('div'), Text: host('span'), Pressable: host('button'), ScrollView: host('div'), ActivityIndicator: host('i'),
        FlatList, Animated: { FlatList }, RefreshControl: () => null,
        TextInput: ({ value, onChangeText, testID, placeholder }: any) => el('input', { value, placeholder, 'data-testid': testID, onChange: (e: any) => onChangeText(e.target.value) }),
        StyleSheet: { create: (s: unknown) => s, flatten: (s: unknown) => flat(s), hairlineWidth: 1, absoluteFill: {} },
        DeviceEventEmitter: {
            addListener: (event: string, fn: (x?: unknown) => void) => {
                const l = { event, fn };
                h.listeners.push(l);
                return { remove: () => { h.listeners = h.listeners.filter((x) => x !== l); } };
            },
            // Only the Edit's hand-back goes round: a sync's nudge would read the copy again, and no row here waits on one.
            emit: vi.fn((event: string, x?: unknown) => { if (event === 'learn_page_read') for (const l of h.listeners.filter((y) => y.event === event)) l.fn(x); }),
        },
        Keyboard: { dismiss: vi.fn() },
        Linking: { openURL: vi.fn(async () => {}) },
        Alert: { alert: vi.fn() },
        AppState: { addEventListener: () => ({ remove() {} }), currentState: 'active' },
    };
});
vi.mock('../../app/ThemeContext', async () => {
    const { lightColors, darkColors } = await import('../../constants/colors');
    const look = () => ({ theme: h.theme, colors: h.theme === 'dark' ? darkColors : lightColors });
    return { useTheme: () => look(), useStyles: (make: any) => make(look()) };
});
vi.mock('../../app/IdentityContext', () => ({ useIdentity: () => ({ identity: { publicKey: ME, privateKey: '11'.repeat(32) } }) }));
vi.mock('../use-learn-mode', () => ({ useLearnMode: () => 'live' }));
vi.mock('../../components/learn/useLearnWriter', () => ({
    useLearnWriter: () => ({ checks: h.checks, waiting: 0 }), readMyDrafts: vi.fn(async () => null), forgetLearnRole: vi.fn(async () => {}),
}));
vi.mock('../post-photo', () => ({ askForPostPhoto: vi.fn() }));
vi.mock('../../components/TagPicker', () => ({ TagPicker: () => null }));
vi.mock('../../components/AuthorCard', () => ({ AuthorCard: () => null, useMemberRating: () => ({ average: null, count: 0 }) }));
vi.mock('../../components/PostTagChips', () => ({ PostTagChips: () => null }));
vi.mock('../../components/ReportReasonBox', () => ({ ReportReasonBox: () => null }));
vi.mock('../../components/forum/ForumLinks', () => ({ ForumLinkedTopics: () => null }));
vi.mock('../../components/showcase/LocalCommunityMark', () => ({ ExampleHeader: () => null, SHEET_ROUTES: {}, markTone: () => ({ fg: '#000', bg: '#fff', border: '#000' }) }));
vi.mock('../../components/learn/LearnPreviewSheet', () => ({ LearnPreviewSheet: () => null }));
vi.mock('../../components/chat/ChatPhoto', () => ({ ChatPhotoViewer: ({ uri }: any) => createElement('div', { 'data-testid': 'viewer', 'data-uri': uri }) }));
vi.mock('../../components/signed-request-lines', () => ({ signedRequestWords: (m: string) => m }));
// The Pulse tab's own furniture, none of it a picture; the creator's card says the thumbnail it would draw (PulseFeedCard's own line).
vi.mock('expo-haptics', () => ({ impactAsync: async () => {}, notificationAsync: async () => {}, selectionAsync: async () => {}, ImpactFeedbackStyle: {}, NotificationFeedbackType: {} }));
vi.mock('../use-node-profile', () => ({ useNodeProfile: () => ({ profile: 'local', features: {} }) }));
vi.mock('../../components/QuickReturn', () => ({ useQuickReturn: () => ({ show: () => {}, listProps: {}, listInset: 0 }), QuickReturnBlock: ({ title, children }: any) => createElement('div', null, title, children) }));
vi.mock('../../components/PageTitle', () => ({ PageTitle: () => null, useTabRetapScrollTop: () => {} }));
vi.mock('../../components/PulseFeedCard', async () => {
    const { resolvePulseThumbnailUrl } = await import('../pulse');
    return {
        PulseFeedCard: ({ item, nodeUrl }: any) => {
            const thumb = resolvePulseThumbnailUrl(nodeUrl, item);
            useEffect(() => { if (thumb) h.asked.push(thumb); }, [thumb]);
            return createElement('div', { 'data-testid': `pulse-item-${item.id}`, 'data-thumb': thumb });
        },
    };
});

import {
    applyDelta, closeDB, getConversations, getDb, getHeldConversations, getKnowledgePost, getKnowledgePosts, getMarketplaceTransactions, getMemberPosts,
    getMyPosts, getPost, getPosts, initDB, refreshPostForPhoto,
} from '../db';
import LearnScreen from '../../app/learn';
import NewKnowledgeScreen from '../../app/learn/new';
import { KnowledgeDetail } from '../../components/learn/KnowledgeDetail';
import { KnowledgeRowCard } from '../../components/learn/KnowledgeRowCard';
import { LEARN_PAGE_READ } from '../../components/learn/learn-keep';
import { useKnowledgePage } from '../../components/learn/useKnowledgePage';
import { rowOnCommunity } from '../photo-address';
import { MarketLearnLine, MARKET_LEARN_LINE_DELAY_MS } from '../../components/learn/MarketLearnLine';
import { PulseKnowledgeCard } from '../../components/PulseKnowledgeCard';
import PulseScreen from '../../app/(tabs)/pulse';
import { LearnBody } from '../../components/home/LearnBody';
import { readElsewhere } from '../market-fill';
import { setCachedAnchorUrl } from '../node-post';
import { readShopListingsForReader } from '../shopfront';
import { syncedCursorKeyOf } from '../../services/pillar-sync';
import { layOut } from './yoga-dom-layout';

globalThis.fetch = vi.fn(async (url: any, init?: { method?: string }) => {
    const at = new URL(String(url));
    if (!h.node || at.origin !== h.anchor) throw new TypeError('offline');
    const answer = h.node(at.pathname + at.search, init?.method ?? 'GET');
    return answer instanceof Response ? answer : new Response(JSON.stringify(answer), { status: 200, headers: { 'Content-Type': 'application/json' } });
}) as unknown as typeof fetch;

const tmp = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'bp-learn-pictures-'));
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));
let phones = 0;
let root: Root;
let host: HTMLElement;
beforeEach(() => {
    h.dir = path.join(tmp, `phone-${++phones}`);
    fs.mkdirSync(h.dir, { recursive: true });
    h.store.clear();
    Object.assign(h, { anchor: VALLEY, switchAfter: null, theme: 'light', params: {}, node: null, listeners: [], checks: false, asked: [], rowsOff: false, list: {} });
    vi.clearAllMocks();
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
});
afterEach(async () => {
    act(() => root.unmount());
    host.remove();
    h.switchAfter = null;
    await closeDB();
});

const settle = async () => { for (let i = 0; i < 12; i++) await act(async () => { await new Promise((r) => setImmediate(r)); }); };
const show = async (element: ReactNode) => { act(() => root.render(element as any)); await settle(); };
const q = (id: string) => host.querySelector(`[data-testid="${id}"]`) as HTMLElement | null;
const drawnFrom = (within: ParentNode = host) => Array.from(within.querySelectorAll('img')).map((i) => i.getAttribute('data-src'));
const click = async (el: Element | null) => { expect(el).toBeTruthy(); await act(async () => { (el as HTMLElement).click(); }); await settle(); };

/** A picture's address as the node gives it (apps/server: a path, its version and its key). */
const given = (n: number, v = 1) => `/api/marketplace/posts/tip/photos/${n}?v=${v}&k=Yqpu8qmgAGQ${n}`;
const small = (address: string) => `${address}&size=thumb2`;
/** A page as the node sends it: its pictures as paths. */
const pageRow = (over: Record<string, unknown> = {}) => ({
    id: 'tip', type: 'knowledge', category: 'local-services', title: 'How recycling works at the tip', description: 'Sort it first.\nThen the bins.',
    photos: [given(0), given(1)], authorPublicKey: 'b'.repeat(64), authorCallsign: 'Bea', status: 'active', active: 1,
    createdAt: '2026-11-02T00:00:00.000Z', updatedAt: '2026-11-02T00:00:00.000Z',
    knowledge: { sources: [], place: null, lang: 'en', checkedAt: '2026-11-03T00:00:00.000Z', outdatedAt: null, outdatedNote: null, helped: 4, gathered: false },
    ...over,
});
/** A page the sync wrote on this phone, kept as the node sent it (its paths bare), as the phones out there hold them now. */
const keep = async (row: Record<string, unknown> = pageRow()) => {
    await initDB();
    expect(await applyDelta({ posts: [row] })).toBe(true);
    const kept = await (await getDb()).getFirstAsync<{ post: string }>('SELECT post FROM knowledge_posts WHERE id = ?', [row.id as string]);
    expect(JSON.parse(kept!.post).photos).toEqual(row.photos);
};
/** The route's own page (app/post/[id].tsx PostRoute): the hook, then the page. */
function Route({ id, asked = true }: { id: string; asked?: boolean }) {
    const { page } = useKnowledgePage(id, asked);
    return page ? createElement(KnowledgeDetail, { page }) : null;
}

describe('a page already kept raw on the phone', () => {
    it('its pictures are drawn from the community\'s own address, and the viewer opens the same whole address', async () => {
        await keep();
        await show(createElement(Route, { id: 'tip' }));
        expect(drawnFrom()).toEqual([`${VALLEY}${given(0)}`, `${VALLEY}${given(1)}`]);
        await click(host.querySelector('button[aria-label="Photo 2 of 2"]'));
        expect(q('viewer')!.getAttribute('data-uri')).toBe(`${VALLEY}${given(1)}`);
    });

    it('its row in Learn draws the picture\'s small copy from the community\'s own address, not the topic\'s tile', async () => {
        await keep();
        await show(createElement(LearnScreen));
        const row = q('learn-row-tip')!;
        expect(drawnFrom(row)).toEqual([small(`${VALLEY}${given(0)}`)]);
        expect(row.querySelector('[data-testid="topic-tile"]')).toBeNull();
    });

    it('the copy still holds it as the node sent it: the address is put in front as it is read, so nothing is rewritten', async () => {
        await keep();
        expect((await getKnowledgePost('tip')).photos).toEqual([`${VALLEY}${given(0)}`, `${VALLEY}${given(1)}`]);
        expect((await getKnowledgePosts()).map((p) => p.photos)).toEqual([[`${VALLEY}${given(0)}`, `${VALLEY}${given(1)}`]]);
        const kept = await (await getDb()).getFirstAsync<{ post: string }>("SELECT post FROM knowledge_posts WHERE id = 'tip'");
        expect(JSON.parse(kept!.post).photos).toEqual([given(0), given(1)]);
    });

    it('an address that is whole already, and a data: picture, are drawn as they are', async () => {
        const photos = ['https://pictures.example.org/tip.jpg', 'data:image/jpeg;base64,AAAA', given(2)];
        await keep(pageRow({ photos }));
        await show(createElement(Route, { id: 'tip' }));
        expect(drawnFrom()).toEqual([photos[0], photos[1], `${VALLEY}${given(2)}`]);
    });

    it.each([
        ['no photos at all', undefined], ['null', null], ['an empty list', []], ['entries that are no address', ['', '  ', null, 7]],
    ])('%s: no picture, the row its topic\'s tile, and the page still reads', async (_name, photos) => {
        await initDB();
        await applyDelta({ posts: [pageRow({ photos: photos as any })] });
        await show(createElement(Route, { id: 'tip' }));
        expect(drawnFrom()).toEqual([]);
        expect(host.textContent).toContain('How recycling works at the tip');
        await show(createElement(LearnScreen, { key: 'learn' }));
        expect(drawnFrom()).toEqual([]);
        expect(q('learn-row-tip')!.querySelector('[data-testid="topic-tile"]')).not.toBeNull();
    });
});

describe('a community this phone holds beside the one in use', () => {
    const both = async () => {
        await keep();
        h.anchor = RIDGE;
        await keep(pageRow({ title: 'The tip over the ridge' }));
    };

    it('each community\'s page draws from its own address, before and after a switch', async () => {
        await both();
        expect((await getKnowledgePost('tip')).photos).toEqual([`${RIDGE}${given(0)}`, `${RIDGE}${given(1)}`]);
        h.anchor = VALLEY;
        expect((await getKnowledgePost('tip')).photos).toEqual([`${VALLEY}${given(0)}`, `${VALLEY}${given(1)}`]);
        await show(createElement(LearnScreen));
        expect(drawnFrom(q('learn-row-tip')!)).toEqual([small(`${VALLEY}${given(0)}`)]);
    });

    it('a page open as the phone switches keeps the address of the community it came from', async () => {
        await both();
        h.anchor = VALLEY;
        await show(createElement(Route, { id: 'tip' }));
        h.anchor = RIDGE;
        // The screen draws again (a tap, a look) with no read of the copy in between.
        await click(host.querySelector('button[aria-label="Photo 1 of 2"]'));
        expect(drawnFrom()).toEqual([`${VALLEY}${given(0)}`, `${VALLEY}${given(1)}`]);
        expect(q('viewer')!.getAttribute('data-uri')).toBe(`${VALLEY}${given(0)}`);
    });

    // A switch landing between any two reads of the address: the page and its address are always the same community's.
    it.each([0, 1, 2, 3])('a switch landing after %i reads of the address: never one community\'s picture on the other\'s address', async (reads) => {
        await both();
        h.anchor = VALLEY;
        await getDb();
        for (const read of [() => getKnowledgePost('tip'), async () => (await getKnowledgePosts())[0]]) {
            h.anchor = VALLEY;
            await getDb();
            h.switchAfter = { reads, to: RIDGE };
            const page = await read();
            h.switchAfter = null;
            const of = page.title === 'The tip over the ridge' ? RIDGE : VALLEY;
            expect(page.photos, `${page.title}`).toEqual([`${of}${given(0)}`, `${of}${given(1)}`]);
        }
    });
});

describe('a page or row the node just answered (no copy of it on the phone)', () => {
    it('a page read from the node by its link', async () => {
        await initDB();
        h.node = (p) => (p.startsWith('/api/marketplace/posts?type=knowledge&id=tip') ? [pageRow()] : {});
        await show(createElement(Route, { id: 'tip' }));
        expect(drawnFrom()).toEqual([`${VALLEY}${given(0)}`, `${VALLEY}${given(1)}`]);
    });

    it('the page an Edit hands back (a picture taken off, the rest renumbered)', async () => {
        await keep();
        await show(createElement(Route, { id: 'tip' }));
        const after = pageRow({ photos: [given(0, 2)], updatedAt: '2026-11-22T00:00:00.000Z', nodeUrl: VALLEY });
        await act(async () => { for (const l of h.listeners.filter((x) => x.event === LEARN_PAGE_READ)) l.fn(after); });
        await settle();
        expect(drawnFrom()).toEqual([`${VALLEY}${given(0, 2)}`]);
    });

    it('Edit lists the same pictures as the page draws, from the same addresses', async () => {
        await keep();
        await show(createElement(Route, { id: 'tip' }));
        const onPage = drawnFrom();
        h.checks = true;
        h.params = { edit: 'tip' };
        h.node = () => [pageRow()];
        await show(createElement(NewKnowledgeScreen, { key: 'edit' }));
        expect(drawnFrom(q('learn-new-page-photos')!)).toEqual(onPage);
        expect(onPage).toHaveLength(2);
    });

    it('a row of a search', async () => {
        await initDB();
        h.params = { q: 'tip' };
        h.node = (p) => (p.startsWith('/api/knowledge/front?q=') ? { total: 1, rows: [{ id: 'tip', title: 'The tip', line: 'Sort it first.', topic: 'local-services', photo: given(0), checkedAt: '2026-11-03T00:00:00.000Z', helped: 0, pinned: false, outdated: false }] } : {});
        await show(createElement(LearnScreen));
        await act(async () => { await new Promise((r) => setTimeout(r, 400)); });
        await settle();
        expect(drawnFrom(q('learn-row-tip')!)).toEqual([small(`${VALLEY}${given(0)}`)]);
    });

    const ROW = { id: 'tip', title: 'The tip', line: 'Sort it first.', topic: 'local-services', photo: given(0), checkedAt: '2026-11-03T00:00:00.000Z', helped: 0, pinned: false, outdated: false };
    it('a row on Home\'s "Learn something local"', async () => {
        const { lightColors } = await import('../../constants/colors');
        await show(createElement(LearnBody, { lines: { rows: [ROW], toCheck: 0, first: false } as any, nodeUrl: VALLEY, community: 'Valley', colors: lightColors as any, onOpen: () => {}, onSeeAll: () => {} }));
        expect(drawnFrom()).toEqual([small(`${VALLEY}${given(0)}`)]);
    });

    it.each([1, 2])('the Pulse\'s card of %i page(s)', async (count) => {
        const posts = Array.from({ length: count }, (_, i) => ({ id: `p${i}`, title: `Page ${i}`, line: 'One line.', topic: 'local-services', photo: given(i), by: 'Bea', gathered: false }));
        await show(createElement(PulseKnowledgeCard, { nodeUrl: VALLEY, item: { id: 'k-day', source: 'knowledge', publishedAt: '2026-11-21T00:00:00.000Z', knowledge: { count, posts } } as any }));
        expect(drawnFrom()).toEqual(posts.map((p) => small(`${VALLEY}${p.photo}`)));
    });
});

describe('with no community\'s address to ask', () => {
    it('a path is drawn as no picture: the row shows its topic\'s tile, and nothing is asked of a bare path', async () => {
        h.anchor = null;
        await show(createElement(KnowledgeRowCard, { row: { id: 'tip', title: 'The tip', line: '', topic: 'local-services', photo: given(0), checkedAt: '', helped: 0, pinned: false, outdated: false }, onPress: () => {} }));
        expect(drawnFrom()).toEqual([]);
        expect(q('topic-tile')).not.toBeNull();
        await show(createElement(KnowledgeDetail, { key: 'page', page: pageRow() as any }));
        expect(drawnFrom()).toEqual([]);
        expect(host.textContent).toContain('How recycling works at the tip');
        await show(createElement(PulseKnowledgeCard, { key: 'card', nodeUrl: null, item: { id: 'k-day', source: 'knowledge', publishedAt: '2026-11-21T00:00:00.000Z', knowledge: { count: 1, posts: [{ id: 'tip', title: 'The tip', line: '', topic: 'local-services', photo: given(0), by: null, gathered: false }] } } as any }));
        expect(drawnFrom()).toEqual([]);
        expect(q('topic-tile')).not.toBeNull();
    });

    it('a row or card whose photo is no address at all (a number, an object) draws its tile, and the list still reads', async () => {
        await show(createElement(KnowledgeRowCard, { row: { id: 'tip', title: 'The tip', line: '', topic: 'local-services', photo: 7 as any, checkedAt: '', helped: 0, pinned: false, outdated: false }, onPress: () => {} }));
        expect(drawnFrom()).toEqual([]);
        expect(host.textContent).toContain('The tip');
        expect(rowOnCommunity(VALLEY, { photo: { url: 'x' } as any })).toEqual({ photo: { url: 'x' } });
        expect(rowOnCommunity(VALLEY, { photo: null })).toEqual({ photo: null });
    });
});

describe('an answer shown on an open page (review of #3355 at 84e1d902)', () => {
    const LATER = '2026-11-22T00:00:00.000Z';
    /** Notes every picture taken out of the page from now on, however briefly; the count of them when asked. */
    const watchPictures = () => {
        let gone = 0;
        const note = (records: MutationRecord[]) => {
            for (const r of records) r.removedNodes.forEach((n) => { if (n instanceof HTMLElement && (n.matches('img') || n.querySelector('img'))) gone++; });
        };
        const seen = new MutationObserver(note);
        seen.observe(host, { childList: true, subtree: true });
        return () => { note(seen.takeRecords()); seen.disconnect(); return gone; };
    };
    const outdated = (on: boolean) => ({ ...pageRow().knowledge, outdatedAt: on ? '2026-11-20T00:00:00.000Z' : null, outdatedNote: null });
    const handBack = async (p: Record<string, unknown>) => {
        await act(async () => { for (const l of h.listeners.filter((x) => x.event === LEARN_PAGE_READ)) l.fn(p); });
        await settle();
    };

    // The community's address can't be read again once the answer is in: a page that waits for it to draw shows no picture at all.
    it.each<[string, Record<string, unknown>, () => Promise<void>]>([
        ['"Still right"', {}, async () => click(q('knowledge-still-right'))],
        ['"Mark as out of date"', {}, async () => { await click(q('knowledge-mark')); await click(q('knowledge-mark-send')); }],
        ['"Clear the mark"', { knowledge: outdated(true) }, async () => click(q('knowledge-clear'))],
    ])('%s: the same carousel, the same pictures, never fewer', async (_name, over, tap) => {
        h.checks = true;
        await keep(pageRow(over));
        await show(createElement(Route, { id: 'tip' }));
        const before = Array.from(host.querySelectorAll('img'));
        expect(before).toHaveLength(2);
        const answered: string[] = [];
        h.node = (p, method) => {
            if (method !== 'POST') return {};
            answered.push(p);
            h.switchAfter = { reads: 0, to: null as any };
            return { post: pageRow({ updatedAt: LATER, title: 'How the tip works now', knowledge: outdated(p.endsWith('/outdated')) }) };
        };
        const gone = watchPictures();
        await tap();
        expect(answered).toHaveLength(1);
        expect(host.textContent).toContain('How the tip works now');
        const after = Array.from(host.querySelectorAll('img'));
        expect(after).toHaveLength(2);
        after.forEach((img, i) => expect(img).toBe(before[i]));
        expect(drawnFrom()).toEqual([`${VALLEY}${given(0)}`, `${VALLEY}${given(1)}`]);
        expect(gone()).toBe(0);
    });

    it('the page an Edit hands back: the same carousel, with the pictures it kept', async () => {
        await keep();
        await show(createElement(Route, { id: 'tip' }));
        const before = Array.from(host.querySelectorAll('img'));
        const carousel = before[0].closest('button')!.parentElement!.parentElement!;
        const gone = watchPictures();
        await handBack(pageRow({ photos: [given(0, 2)], updatedAt: LATER, nodeUrl: VALLEY }));
        const after = Array.from(host.querySelectorAll('img'));
        expect(drawnFrom()).toEqual([`${VALLEY}${given(0, 2)}`]);
        expect(after[0]).toBe(before[0]);
        expect(host.contains(carousel)).toBe(true);
        // The one it took off, and nothing else.
        expect(gone()).toBe(1);
    });

    it('a page read before the answer already shown gives way to it; a newer one, or one as new, takes its place', async () => {
        await keep();
        await show(createElement(Route, { id: 'tip' }));
        await handBack(pageRow({ title: 'Saved last', updatedAt: LATER, nodeUrl: VALLEY }));
        await handBack(pageRow({ title: 'Read before it', updatedAt: '2026-11-21T00:00:00.000Z', nodeUrl: VALLEY }));
        expect(host.textContent).toContain('Saved last');
        await handBack(pageRow({ title: 'As new', updatedAt: LATER, nodeUrl: VALLEY }));
        expect(host.textContent).toContain('As new');
        await handBack(pageRow({ title: 'Newer', updatedAt: '2026-11-23T00:00:00.000Z', nodeUrl: VALLEY }));
        expect(host.textContent).toContain('Newer');
    });
});

describe.each(['light', 'dark'] as const)('on an API 26 phone at 320 dp and 1.3x text (%s)', (theme) => {
    it('a page\'s picture is drawn the width of the page, above its sources, and nothing runs past the edge', async () => {
        h.theme = theme;
        await keep(pageRow({ photos: [given(0)] }));
        await show(createElement(Route, { id: 'tip' }));
        const img = host.querySelector('img')!;
        expect(img.getAttribute('data-src')).toBe(`${VALLEY}${given(0)}`);
        const layout = layOut(host.firstElementChild!, { width: 320, height: 4000 }, { fontScale: 1.3 });
        // 320 dp less the page's 16 a side: the carousel's own width, as it measured it, and its 220 height.
        expect([layout.width(img), layout.height(img)]).toEqual([288, 220]);
        const frame = img.closest('button')!;
        expect(frame.getAttribute('aria-label')).toBe('Photo 1 of 1');
        expect([layout.width(frame), layout.height(frame)]).toEqual([288, 220]);
    });

    it('a row draws its picture 64 dp square in place of the tile, and its words keep the rest of the row', async () => {
        h.theme = theme;
        await keep();
        await show(createElement(LearnScreen));
        const row = q('learn-row-tip')!;
        const img = row.querySelector('img')!;
        // Drawn: shown in its own place, not held out of the layout unseen until it loads (ListPhoto).
        const style = JSON.parse(img.getAttribute('data-style')!);
        expect([style.opacity, style.position]).toEqual([undefined, undefined]);
        const layout = layOut(row, { width: 320 - 16 * 2, height: 2000 }, { fontScale: 1.3 });
        expect([layout.width(img), layout.height(img)]).toEqual([64, 64]);
        const words = row.lastElementChild!;
        expect(layout.box(words).left + layout.box(words).width).toBeLessThanOrEqual(288);
        expect(layout.width(words)).toBeGreaterThan(150);
        expect(layout.height(row)).toBeGreaterThanOrEqual(88);
    });
});

// ── The class: every place × (the community in use, another one) → the address asked ──────────────────────────────────────────

/** Two communities whose pictures can't be mistaken: the post in the path and its key name the one they are. */
const NAME: Record<string, string> = { [VALLEY]: 'valley', [RIDGE]: 'ridge' };
const other = (from: string) => (from === VALLEY ? RIDGE : VALLEY);
const pictureOf = (from: string, n = 0, v = 1, what = 'page') => `/api/marketplace/posts/${NAME[from]}${what}/photos/${n}?v=${v}&k=KEY_${NAME[from]}`;
/** Whether an address asked is the picture's own community's: one community's path, key and host. */
const ownAddress = (address: string) => [VALLEY, RIDGE].some((c) => address.startsWith(`${c}/`) && address.includes(`/${NAME[c]}`) && !address.includes(NAME[other(c)]));
const pageOf = (from: string, over: Record<string, unknown> = {}) => pageRow({ id: `${NAME[from]}page`, title: `The tip in the ${NAME[from]}`, photos: [pictureOf(from, 0), pictureOf(from, 1)], ...over });
const listingOf = (from: string, over: Record<string, unknown> = {}) => ({
    id: `${NAME[from]}listing`, type: 'offer', category: 'tools', title: `A ladder in the ${NAME[from]}`, description: 'Three metres.', price_c: 500,
    priceType: 'fixed', authorPublicKey: ME, authorCallsign: 'Me', status: 'active', active: 1, createdAt: '2026-11-02T00:00:00.000Z',
    updatedAt: '2026-11-02T00:00:00.000Z', photos: [pictureOf(from, 0, 1, 'listing')], ...over,
});
const PEER = 'b'.repeat(64);
/** A community's copy on the phone: a page, a listing of mine, a chat about it and a deal on it, every picture by path. */
const hold = async (from: string) => {
    h.anchor = from;
    await initDB();
    expect(await applyDelta({ posts: [pageOf(from), listingOf(from)] })).toBe(true);
    const copy = await getDb();
    const listing = `${NAME[from]}listing`;
    const photo = pictureOf(from, 0, 1, 'listing');
    await copy.runAsync('UPDATE posts SET carried_banner = ? WHERE id = ?', [pictureOf(from, 9, 1, 'banner'), listing]);
    await copy.runAsync("INSERT INTO members (public_key, callsign) VALUES (?, 'Kai')", [PEER]);
    await copy.runAsync("INSERT INTO conversations (id, type, post_id, post_title, post_photo) VALUES (?, 'dm', ?, 'A ladder', ?)", [`${NAME[from]}chat`, listing, JSON.stringify([photo])]);
    for (const key of [ME, PEER]) await copy.runAsync('INSERT INTO conversation_participants (conversation_id, public_key) VALUES (?, ?)', [`${NAME[from]}chat`, key]);
    await copy.runAsync("INSERT INTO marketplace_transactions (id, post_id, buyer_pubkey, seller_pubkey, status, cover_image) VALUES (?, ?, ?, ?, 'pending', ?)", [`${NAME[from]}deal`, listing, PEER, ME, photo]);
};
const feedOf = (from: string, over: Record<string, unknown> = {}) => ({
    nextCursor: null,
    items: [
        { id: 'know_2026-11-22', source: 'knowledge', platform: 'beanpool', category: 'knowledge', publishedAt: '2026-11-22T00:00:00.000Z', knowledge: { count: 1, posts: [{ id: `${NAME[from]}page`, title: `The tip in the ${NAME[from]}`, topic: 'local-services', line: 'Sort it first.', photo: pictureOf(from), by: null, gathered: false }] } },
        { id: `${NAME[from]}item`, source: 'autolist', platform: 'youtube', category: 'food', ownerPubkey: PEER, callsign: 'Kai', url: null, title: 'Bread', thumbnailUrl: 'https://img.example/x.jpg', publishedAt: '2026-11-21T00:00:00.000Z', isVerified: true },
    ],
    ...over,
});
/** What a feed's two cards ask: the Learn card's picture, and the creator's card's preview. */
const cardsOf = (from: string) => [small(`${from}${pictureOf(from)}`), `${from}/api/pulse/items/${NAME[from]}item/thumbnail`];
const draw = async (element: ReactElement) => { await show(element); };
const listed = (rows: any[], from: string) => rows.filter((r) => [`${NAME[from]}listing`, `${NAME[from]}chat`, `${NAME[from]}deal`].includes(r.id));

interface Place {
    place: string;
    /** Draws (or reads) the place's item, which came from `from`; `move` takes the phone to the other community, at the worst moment for it. */
    asks: (from: string, move: () => void) => Promise<string[]>;
    /** The addresses asked, whichever community the phone is on by then. */
    on: (from: string) => string[];
}
/** What was asked, whichever picture mounted first: each address once, in one order. */
const once = (asked: string[]) => [...new Set(asked)].sort();
const both = (from: string, v = 1) => [`${from}${pictureOf(from, 0, v)}`, `${from}${pictureOf(from, 1, v)}`];
const photoOfListing = (from: string) => `${from}${pictureOf(from, 0, 1, 'listing')}`;
const editing = (from: string) => { h.checks = true; h.params = { edit: `${NAME[from]}page` }; };
const byId = (p: string) => p.startsWith('/api/marketplace/posts?type=knowledge&id=');

/** Every place on the phone that puts an address in front of a Learn or listing picture's path, and what its item came in. */
const PLACES: Place[] = [
    {
        place: 'the Learn page, from the copy (then the phone moves, and it draws again)',
        asks: async (from, move) => {
            await keep(pageOf(from));
            await draw(createElement(Route, { id: `${NAME[from]}page` }));
            move();
            await click(host.querySelector('button[aria-label="Photo 1 of 2"]'));
            expect(q('viewer')!.getAttribute('data-uri')).toBe(`${from}${pictureOf(from)}`);
            return h.asked;
        },
        on: both,
    },
    {
        place: 'the Learn page, read from the node by its link (the phone moves while it answers)',
        asks: async (from, move) => {
            await initDB();
            h.node = (p) => { if (byId(p)) { move(); return [pageOf(from)]; } return {}; };
            await draw(createElement(Route, { id: `${NAME[from]}page` }));
            return h.asked;
        },
        on: both,
    },
    {
        place: "the Learn page, an action's answer (the phone moves while it is out)",
        asks: async (from, move) => {
            h.checks = true;
            await keep(pageOf(from));
            await draw(createElement(Route, { id: `${NAME[from]}page` }));
            h.asked.length = 0;
            h.node = (p) => { if (!p.endsWith('/checked')) return {}; move(); return { post: pageOf(from, { photos: [pictureOf(from, 0, 2), pictureOf(from, 1, 2)], updatedAt: '2026-11-22T00:00:00.000Z' }) }; };
            await click(q('knowledge-still-right'));
            return h.asked;
        },
        on: (from) => both(from, 2),
    },
    {
        place: "the Learn page and its Edit's list, the page an Edit saved (the phone moves while the save is out)",
        asks: async (from, move) => {
            editing(from);
            await keep(pageOf(from));
            h.node = (p, method) => {
                if (byId(p)) return [pageOf(from)];
                if (method !== 'POST') return {};
                move();
                return { post: pageOf(from, { photos: [pictureOf(from, 0, 2)], updatedAt: '2026-11-22T00:00:00.000Z' }) };
            };
            await draw(createElement('div', null, createElement(Route, { id: `${NAME[from]}page` }), createElement(NewKnowledgeScreen)));
            await click(q('learn-new-photo-toggle-1'));
            await click(q('learn-new-send'));
            return h.asked;
        },
        on: (from) => [...both(from), `${from}${pictureOf(from, 0, 2)}`],
    },
    {
        place: 'the Learn page, read again after "This page\'s photos changed" (the phone moves while it answers)',
        asks: async (from, move) => {
            editing(from);
            await keep(pageOf(from));
            let refused = false;
            h.node = (p, method) => {
                if (method === 'POST') { refused = true; return new Response(JSON.stringify({ error: "This page's photos changed. Open it again.", code: 'photos_changed' }), { status: 409 }); }
                if (!byId(p)) return {};
                if (!refused) return [pageOf(from)];
                move();
                return [pageOf(from, { photos: [pictureOf(from, 0, 5)], updatedAt: '2026-11-22T00:00:00.000Z' })];
            };
            await draw(createElement('div', null, createElement(Route, { id: `${NAME[from]}page` }), createElement(NewKnowledgeScreen)));
            await click(q('learn-new-photo-toggle-1'));
            await click(q('learn-new-send'));
            return h.asked;
        },
        on: (from) => [...both(from), `${from}${pictureOf(from, 0, 5)}`],
    },
    {
        place: "the Edit's list (the phone moves while the page is read for it)",
        asks: async (from, move) => {
            editing(from);
            await initDB();
            h.node = (p) => { if (byId(p)) { move(); return [pageOf(from)]; } return {}; };
            await draw(createElement(NewKnowledgeScreen));
            return h.asked;
        },
        on: both,
    },
    {
        place: "a Learn row, from the copy (the phone moves, then the topic's rows mount)",
        asks: async (from, move) => {
            await keep(pageOf(from));
            await draw(createElement(LearnScreen));
            h.asked.length = 0;
            move();
            await click(q('learn-topic-local-services'));
            return h.asked;
        },
        on: (from) => [small(`${from}${pictureOf(from)}`)],
    },
    {
        place: 'a Learn row of a search (the phone moves while it answers)',
        asks: async (from, move) => {
            await initDB();
            h.params = { q: 'tip' };
            h.node = (p) => {
                if (!p.startsWith('/api/knowledge/front?q=')) return {};
                move();
                return { total: 1, rows: [{ id: `${NAME[from]}page`, title: 'The tip', line: 'Sort it.', topic: 'local-services', photo: pictureOf(from), checkedAt: '2026-11-03T00:00:00.000Z', helped: 0, pinned: false, outdated: false }] };
            };
            await draw(createElement(LearnScreen));
            await act(async () => { await new Promise((r) => setTimeout(r, 400)); });
            await settle();
            return h.asked;
        },
        on: (from) => [small(`${from}${pictureOf(from)}`)],
    },
    {
        place: "a Learn row on Home, the answer's own address with it (the phone moves, then the card mounts)",
        asks: async (from, move) => {
            const { lightColors } = await import('../../constants/colors');
            move();
            const rows = [{ id: `${NAME[from]}page`, title: 'The tip', line: 'Sort it.', topic: 'local-services', photo: pictureOf(from), checkedAt: '', helped: 0, pinned: false, outdated: false }];
            await draw(createElement(LearnBody, { lines: { rows, toCheck: 0, first: false } as any, nodeUrl: from, community: 'Here', colors: lightColors as any, onOpen: () => {}, onSeeAll: () => {} }));
            return h.asked;
        },
        on: (from) => [small(`${from}${pictureOf(from)}`)],
    },
    {
        place: "the Pulse's cards, a feed the tab still holds (the phone moves, then its cards mount)",
        asks: async (from, move) => {
            h.node = (p) => (p.startsWith('/api/pulse/feed') ? feedOf(from) : {});
            h.rowsOff = true;
            await draw(createElement(PulseScreen));
            expect(h.asked).toEqual([]);
            move();
            h.rowsOff = false;
            await draw(createElement(PulseScreen));
            return h.asked;
        },
        on: (from) => cardsOf(from),
    },
    {
        place: "the Pulse's cards, a feed on its way (the phone moves while it answers)",
        asks: async (from, move) => {
            h.node = (p) => { if (!p.startsWith('/api/pulse/feed')) return {}; move(); return feedOf(from); };
            await draw(createElement(PulseScreen));
            return h.asked;
        },
        on: (from) => cardsOf(from),
    },
    {
        place: "the Market's Learn line (it draws no picture)",
        asks: async (from, move) => {
            await keep(pageOf(from));
            await draw(createElement(MarketLearnLine, { words: 'tip' }));
            move();
            await act(async () => { await new Promise((r) => setTimeout(r, MARKET_LEARN_LINE_DELAY_MS + 50)); });
            await settle();
            return h.asked;
        },
        on: () => [],
    },
    {
        place: "the Market's newest from elsewhere, read from the node (the phone moves while it answers)",
        asks: async (from, move) => {
            h.node = () => { move(); return [listingOf(from, { authorBannerUrl: pictureOf(from, 9, 1, 'banner') })]; };
            const [row] = (await readElsewhere('all', 'all'))!;
            return [...row.photos, row.authorBannerUrl];
        },
        on: (from) => [photoOfListing(from), `${from}${pictureOf(from, 9, 1, 'banner')}`],
    },
    {
        place: "a shopfront's listings, read from the node (the phone moves while it answers)",
        asks: async (from, move) => {
            h.node = () => { move(); return [listingOf(from)]; };
            return (await readShopListingsForReader('shop-1'))!.map((l) => l.photo!);
        },
        on: (from) => [photoOfListing(from)],
    },
    {
        place: "a chat's listing photo: the community in use's own list, or a held community's (its file beside the one in use)",
        asks: async (from, move) => {
            await hold(from);
            h.store.set(syncedCursorKeyOf(`beanpool_${new URL(from).hostname}.db`), '1');
            move();
            await getDb();
            const rows = h.anchor === from ? await getConversations(ME) : (await getHeldConversations(ME, from))!;
            return rows.map((r: any) => r.postPhoto);
        },
        on: (from) => [photoOfListing(from)],
    },
];

describe.each(PLACES.map((p) => [p.place, p] as const))('%s', (_place, { asks, on }) => {
    it.each([VALLEY, RIDGE])('from %s, the community in use: asked of it', async (from) => {
        h.anchor = from;
        expect(once(await asks(from, () => {}))).toEqual(once(on(from)));
    });

    it.each([VALLEY, RIDGE])('from %s, and the phone moves to the other: still asked of the one it came from, and nothing of it of the other', async (from) => {
        h.anchor = from;
        // As the phone's move does: the address changes, and the next read of it anywhere on the phone has the new one to hand.
        const asked = once(await asks(from, () => { h.anchor = other(from); setCachedAnchorUrl(h.anchor); }));
        expect(asked).toEqual(once(on(from)));
        expect(asked.filter((a) => !ownAddress(a) && !a.includes('/api/pulse/items/'))).toEqual([]);
        expect(asked.filter((a) => a.startsWith(other(from)))).toEqual([]);
    });
});

describe("the Pulse's tab, with two communities' items in it", () => {
    it.each([VALLEY, RIDGE])('a feed read again after the phone moved from %s: the day\'s card, which keeps its place and its id, asks the new one', async (from) => {
        h.anchor = from;
        h.node = (p) => (p.startsWith('/api/pulse/feed') ? feedOf(h.anchor!) : {});
        await draw(createElement(PulseScreen));
        expect(once(h.asked)).toEqual(once(cardsOf(from)));
        h.asked.length = 0;
        const to = other(from);
        h.anchor = to;
        await act(async () => { await h.list.refresh!(); });
        await settle();
        expect(once(h.asked)).toEqual(once(cardsOf(to)));
    });

    it.each([VALLEY, RIDGE])('a refresh on its way after the phone moved from %s: the cards still on screen ask nothing new until it answers', async (from) => {
        h.anchor = from;
        h.node = (p) => (p.startsWith('/api/pulse/feed') ? feedOf(h.anchor!) : {});
        await draw(createElement(PulseScreen));
        h.asked.length = 0;
        h.anchor = other(from);
        const answers = globalThis.fetch;
        let answer: () => void = () => {};
        globalThis.fetch = vi.fn(() => new Promise<Response>((done) => { answer = () => done(new Response(JSON.stringify(feedOf(other(from))), { status: 200 })); })) as any;
        try {
            await act(async () => { void h.list.refresh!(); });
            await settle();
            expect(h.asked).toEqual([]);
            await act(async () => { answer(); });
            await settle();
        } finally {
            globalThis.fetch = answers;
        }
        expect(h.asked.every((a) => a.startsWith(other(from)))).toBe(true);
        expect(h.asked).toHaveLength(2);
    });

    it.each([VALLEY, RIDGE])('a later page read after the phone moved from %s: each card asks the community its own page came from', async (from) => {
        h.anchor = from;
        const later = other(from);
        h.node = (p) => {
            if (!p.startsWith('/api/pulse/feed')) return {};
            if (!p.includes('cursor=')) return feedOf(from, { nextCursor: 'more' });
            return feedOf(later, { items: feedOf(later).items.map((i) => (i.source === 'knowledge' ? { ...i, id: 'know_2026-11-20' } : i)) });
        };
        await draw(createElement(PulseScreen));
        h.anchor = later;
        await act(async () => { await h.list.more!(); });
        await settle();
        expect(once(h.asked)).toEqual(once([...cardsOf(from), ...cardsOf(later)]));
    });

    it('a feed that names an address itself is not believed: the one asked is what its pictures are asked of', async () => {
        h.node = (p) => (p.startsWith('/api/pulse/feed') ? { ...feedOf(VALLEY), nodeUrl: RIDGE, items: feedOf(VALLEY).items.map((i) => ({ ...i, nodeUrl: RIDGE })) } : {});
        await draw(createElement(PulseScreen));
        expect(once(h.asked)).toEqual(once(cardsOf(VALLEY)));
    });

    it('so is a page: one that names an address itself is drawn from the one asked', async () => {
        await initDB();
        h.node = (p) => (byId(p) ? [pageOf(VALLEY, { nodeUrl: RIDGE })] : {});
        await draw(createElement(Route, { id: 'valleypage' }));
        expect(h.asked).toEqual(both(VALLEY));
    });
});

// A listing's picture from the copy: the read takes the copy and its address together, so a switch landing between any two reads of the
// address never puts one community's photo, and its key, on the other's.
describe.each<[string, (from: string) => Promise<unknown[]>]>([
    ['getPosts, its photo', async (from) => listed(await getPosts(), from).map((r) => r.photos[0])],
    ["getPosts, its enterprise's banner", async (from) => listed(await getPosts(), from).map((r) => r.authorBannerUrl)],
    ['getMyPosts', async (from) => listed(await getMyPosts(ME), from).map((r) => r.photos[0])],
    ['getPost', async (from) => [(await getPost(`${NAME[from]}listing`))?.photos?.[0]]],
    ['getMemberPosts', async (from) => listed(await getMemberPosts(ME), from).map((r) => r.photos[0])],
    ['getConversations', async (from) => listed(await getConversations(ME), from).map((r) => r.postPhoto)],
    ['getMarketplaceTransactions', async (from) => listed(await getMarketplaceTransactions(ME), from).map((r) => r.coverImage)],
])('a listing from the copy: %s', (_read, read) => {
    const addressesOf = async () => [...await read(VALLEY), ...await read(RIDGE)].filter((a): a is string => typeof a === 'string');

    it.each([VALLEY, RIDGE])('from %s, the community in use: asked of it', async (from) => {
        await hold(other(from));
        await hold(from);
        const asked = (await read(from)) as string[];
        expect(asked).toHaveLength(1);
        expect(asked[0].startsWith(`${from}/api/marketplace/posts/${NAME[from]}`)).toBe(true);
        expect(ownAddress(asked[0])).toBe(true);
    });

    it.each([0, 1, 2, 3])('a switch landing after %i reads of the address, both ways round: each photo on its own community', async (reads) => {
        await hold(VALLEY);
        await hold(RIDGE);
        for (const from of [VALLEY, RIDGE]) {
            for (const whose of [VALLEY, RIDGE]) {
                h.anchor = from;
                await getDb();
                h.switchAfter = { reads, to: other(from) };
                const asked = (await read(whose)).filter((a): a is string => typeof a === 'string');
                h.switchAfter = null;
                expect(asked.filter((a) => !ownAddress(a))).toEqual([]);
            }
        }
        // And the reads do find them: the rows above are not empty for nothing.
        h.anchor = VALLEY;
        expect(await addressesOf()).toHaveLength(1);
    });
});

it('a listing whose photo will not load is read again on its own community however its address is spelled, never for another\'s photo', async () => {
    await hold(VALLEY);
    const asks: string[] = [];
    const answers = globalThis.fetch;
    // No answer it can use (not a list): only whether it was asked, and of whom.
    globalThis.fetch = vi.fn(async (url: any) => { asks.push(String(url)); return new Response('{}', { status: 200 }); }) as any;
    try {
        for (const anchor of [VALLEY, `${VALLEY}/`]) {
            h.anchor = anchor;
            const [row] = listed(await getPosts(), VALLEY);
            asks.length = 0;
            await refreshPostForPhoto('valleylisting', row.photos[0]);
            expect(asks, anchor).toHaveLength(1);
            expect(asks[0].startsWith(VALLEY), anchor).toBe(true);
            asks.length = 0;
            await refreshPostForPhoto('valleylisting', photoOfListing(RIDGE));
            expect(asks, anchor).toEqual([]);
        }
    } finally {
        globalThis.fetch = answers;
    }
});
