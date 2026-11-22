// @vitest-environment jsdom
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement, useEffect, type ReactNode } from 'react';
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
// them now), Learn, the page and its route's hook, the row card, the Pulse's and Home's cards, the carousel, the list photo. What
// stands in: React Native's hosts, expo-image (as a phone's loader: a whole address loads, a bare path never does), the router
// and the viewer (which says the address it was handed).

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
    /** What the node answers a signed GET (null: not reached). */
    node: null as null | ((path: string) => unknown),
    listeners: [] as Array<{ event: string; fn: (x?: unknown) => void }>,
    checks: false,
}));
const router = vi.hoisted(() => ({ push: vi.fn(), back: vi.fn(), replace: vi.fn(), navigate: vi.fn(), canGoBack: vi.fn(() => true) }));

vi.mock('expo-sqlite', async () => {
    const { DatabaseSync: Sqlite } = await import('node:sqlite');
    const { join } = await import('node:path');
    const params = (p: unknown) => (p === undefined ? [] : Array.isArray(p) ? p : [p]) as SQLInputValue[];
    return {
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
    getInfoAsync: vi.fn().mockResolvedValue({ exists: false }),
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
vi.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }) }));
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
                if (/^(https?:\/\/|data:)/.test(uri)) onLoad?.(); else onError?.();
            }, [uri]);
            return el('img', { 'data-src': uri, 'aria-label': accessibilityLabel, 'data-testid': testID, 'data-style': JSON.stringify(flat(style)) });
        },
    };
});
// An Android 8 phone (API 26), the oldest the app runs on, 320 dp wide with its text at 1.3x.
vi.mock('react-native', async () => {
    const { createElement: el, useEffect: effect } = await import('react');
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
        TextInput: ({ value, onChangeText, testID, placeholder }: any) => el('input', { value, placeholder, 'data-testid': testID, onChange: (e: any) => onChangeText(e.target.value) }),
        StyleSheet: { create: (s: unknown) => s, flatten: (s: unknown) => flat(s), hairlineWidth: 1, absoluteFill: {} },
        DeviceEventEmitter: {
            addListener: (event: string, fn: (x?: unknown) => void) => {
                const l = { event, fn };
                h.listeners.push(l);
                return { remove: () => { h.listeners = h.listeners.filter((x) => x !== l); } };
            },
            emit: vi.fn(),
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

import { applyDelta, closeDB, getDb, getKnowledgePost, getKnowledgePosts, initDB } from '../db';
import LearnScreen from '../../app/learn';
import NewKnowledgeScreen from '../../app/learn/new';
import { KnowledgeDetail } from '../../components/learn/KnowledgeDetail';
import { KnowledgeRowCard } from '../../components/learn/KnowledgeRowCard';
import { LEARN_PAGE_READ } from '../../components/learn/learn-keep';
import { useKnowledgePage } from '../../components/learn/useKnowledgePage';
import { PulseKnowledgeCard } from '../../components/PulseKnowledgeCard';
import { LearnBody } from '../../components/home/LearnBody';
import { layOut } from './yoga-dom-layout';

globalThis.fetch = vi.fn(async (url: any) => {
    const at = new URL(String(url));
    if (!h.node || at.origin !== h.anchor) throw new TypeError('offline');
    return new Response(JSON.stringify(h.node(at.pathname + at.search)), { status: 200, headers: { 'Content-Type': 'application/json' } });
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
    Object.assign(h, { anchor: VALLEY, switchAfter: null, theme: 'light', params: {}, node: null, listeners: [], checks: false });
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
        const after = pageRow({ photos: [given(0, 2)], updatedAt: '2026-11-22T00:00:00.000Z' });
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
        await show(createElement(LearnBody, { lines: { rows: [ROW], toCheck: 0, first: false } as any, community: 'Valley', colors: lightColors as any, onOpen: () => {}, onSeeAll: () => {} }));
        expect(drawnFrom()).toEqual([small(`${VALLEY}${given(0)}`)]);
    });

    it.each([1, 2])('the Pulse\'s card of %i page(s)', async (count) => {
        const posts = Array.from({ length: count }, (_, i) => ({ id: `p${i}`, title: `Page ${i}`, line: 'One line.', topic: 'local-services', photo: given(i), by: 'Bea', gathered: false }));
        await show(createElement(PulseKnowledgeCard, { item: { id: 'k-day', source: 'knowledge', publishedAt: '2026-11-21T00:00:00.000Z', knowledge: { count, posts } } as any }));
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
