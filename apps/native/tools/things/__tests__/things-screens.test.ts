// @vitest-environment jsdom
/**
 * The Tool shed's four screens on the phone (scratch/tools/DESIGN-tool-template-fable.md §3.1, §6 row T1.2), drawn for real
 * through the one host route (app/tool/[id].tsx) with the tool as the registry ships it (tools/index.ts), its document in
 * a real SQLite table and its photos in a real folder, at 320 dp with 1.3× text:
 *
 * - Your things (`main`): newest first, each with its state; the filters; Add and Loans.
 * - A thing (`thing`): its buttons by state. List opens the host's List sheet with the thing's draft (no profile photo
 *   says so); link it to the Offer posted from it; take it out of the shop and put the same Offer back; lend it outside
 *   BeanPool and mark it back; delete it. When the server can't be reached nothing changes, and it says so.
 * - Edit (`edit`): a name is needed; the photo is kept on the phone at 800 px; a 101st thing and a save past 64 KB are
 *   refused in one sentence each, nothing written.
 * - Loans (`loans`): from host.deals() and the document, overdue first.
 *
 * And every screen in the pseudo-locale `xx`, light and dark: every word through t() (no letters outside a bracket but
 * what the member wrote), every fixed word under the 258 dp inside of a card at 1.3× (home-layout-320.test.ts's width
 * model), and every colour a screen draws one of the theme's tokens.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { act, createElement, useEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';

(globalThis as any).__DEV__ = false;
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const SCREEN = 320;
const FONT_SCALE = 1.3;

vi.mock('react-native', () => {
    const roles: Record<string, string> = { header: 'heading', button: 'button', link: 'link', radio: 'radio', radiogroup: 'radiogroup' };
    const flat = (style: unknown): Record<string, any> => Object.assign({}, ...[style].flat(4).filter((x) => x && typeof x === 'object'));
    const el = (tag: string) => function Host(props: Record<string, any>) {
        const { children, onPress, accessibilityLabel, accessibilityRole, testID, placeholder, numberOfLines, value, onChangeText, disabled, onValueChange, source, placeholderTextColor } = props;
        const attrs: Record<string, unknown> = {};
        if (testID) attrs['data-testid'] = testID;
        if (onPress && !disabled) attrs.onClick = (e: { stopPropagation(): void }) => { e.stopPropagation(); onPress({ stopPropagation() {} }); };
        if ((onPress && disabled) || props.accessibilityState?.disabled) attrs['data-disabled'] = 'true';
        if (onValueChange) attrs.onClick = () => onValueChange(!value);
        if (onChangeText) { attrs.onChange = (e: { target: { value: string } }) => onChangeText(e.target.value); attrs.value = value ?? ''; }
        if (accessibilityLabel) attrs['aria-label'] = accessibilityLabel;
        if (accessibilityRole && roles[accessibilityRole]) attrs.role = roles[accessibilityRole];
        if (placeholder) attrs.placeholder = placeholder;
        if (numberOfLines) attrs['data-lines'] = String(numberOfLines);
        if (source?.uri) attrs['data-src'] = source.uri;
        const s = flat(typeof props.style === 'function' ? props.style({ pressed: false }) : props.style);
        if (typeof s.fontSize === 'number') attrs['data-font'] = String(s.fontSize);
        // Every colour drawn, so the test can hold each to the theme's tokens.
        if (typeof s.color === 'string') attrs['data-color'] = s.color;
        if (typeof s.backgroundColor === 'string') attrs['data-bg'] = s.backgroundColor;
        if (typeof s.borderColor === 'string') attrs['data-border'] = s.borderColor;
        if (typeof placeholderTextColor === 'string') attrs['data-placeholder-color'] = placeholderTextColor;
        return createElement(tag, attrs, typeof children === 'function' ? children({ pressed: false }) : children);
    };
    // As the platform's Image: a file that isn't on the phone (a photo taken on another device) fails to load, and says so.
    function Image(props: Record<string, any>) {
        const uri: unknown = props.source?.uri;
        useEffect(() => {
            if (typeof uri === 'string' && uri.startsWith('file://') && !fs.existsSync(decodeURI(uri.slice('file://'.length)))) props.onError?.({ nativeEvent: { error: 'no such file' } });
        }, [uri]);
        return el('img')(props);
    }
    return {
        Platform: { OS: 'android', select: (o: Record<string, unknown>) => o.android ?? o.default },
        View: el('div'), Text: el('span'), Pressable: el('button'), ScrollView: el('div'), TextInput: el('input'), Switch: el('button'), ActivityIndicator: el('div'), Image,
        Modal: ({ visible, children }: { visible: boolean; children?: unknown }) => (visible ? createElement('div', { 'data-modal': 'true' }, children as any) : null),
        StyleSheet: { create: (s: unknown) => s, hairlineWidth: 1, absoluteFill: {}, absoluteFillObject: {}, flatten: (s: unknown) => flat(s) },
        Alert: { alert: () => {} },
        Linking: { openURL: async () => {} },
        AccessibilityInfo: { announceForAccessibility: () => {} },
        useWindowDimensions: () => ({ width: SCREEN, height: 569, scale: 1.5, fontScale: FONT_SCALE }),
        Dimensions: { get: () => ({ width: SCREEN, height: 569, scale: 1.5, fontScale: FONT_SCALE }) },
    };
});
const nav = vi.hoisted(() => ({ params: {} as Record<string, string>, pushed: [] as unknown[], backs: 0 }));
vi.mock('expo-router', async () => {
    const { useEffect: effect, useState: state } = await import('react');
    return {
        router: {
            push: (r: unknown) => { nav.pushed.push(r); }, navigate: (r: unknown) => { nav.pushed.push(r); }, replace: () => {},
            back: () => { nav.backs++; }, canGoBack: () => true, setParams: () => {},
        },
        useFocusEffect: (cb: () => void | (() => void)) => effect(() => cb(), [cb]),
        useLocalSearchParams: () => state(() => ({ ...nav.params }))[0],
    };
});
const store = vi.hoisted(() => ({ map: new Map<string, string>() }));
vi.mock('@react-native-async-storage/async-storage', () => ({
    default: {
        getItem: async (k: string) => store.map.get(k) ?? null,
        setItem: async (k: string, v: string) => { store.map.set(k, v); },
        removeItem: async (k: string) => { store.map.delete(k); },
        getAllKeys: async () => [...store.map.keys()],
        multiRemove: async (keys: string[]) => { keys.forEach((k) => store.map.delete(k)); },
    },
}));
vi.mock('@expo/vector-icons', () => ({ MaterialCommunityIcons: ({ name }: { name: string }) => createElement('i', { 'data-icon': name }) }));
vi.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ top: 24, bottom: 0, left: 0, right: 0 }) }));
vi.mock('react-native-keyboard-controller', () => ({
    useKeyboardState: (pick: (s: { height: number; isVisible: boolean }) => unknown) => pick({ height: 0, isVisible: false }),
    // The keyboard is the device's: the stand-in draws its rows and says how it was asked to keep them above it.
    KeyboardAwareScrollView: ({ children, testID, bottomOffset, keyboardShouldPersistTaps }: Record<string, any>) => createElement('div',
        { 'data-testid': testID, 'data-keyboard-aware': 'true', 'data-bottom-offset': String(bottomOffset ?? 0), 'data-persist-taps': keyboardShouldPersistTaps }, children),
}));
const picker = vi.hoisted(() => ({ file: '', refs: 0, cameraAllowed: true }));
vi.mock('expo-image-picker', () => ({
    launchImageLibraryAsync: async () => ({ canceled: false, assets: [{ uri: `file://${picker.file}` }] }),
    launchCameraAsync: async () => ({ canceled: false, assets: [{ uri: `file://${picker.file}` }] }),
    requestCameraPermissionsAsync: async () => ({ granted: picker.cameraAllowed }),
}));
const resized = vi.hoisted(() => ({ widths: [] as number[] }));
vi.mock('expo-image-manipulator', () => ({
    manipulateAsync: async (uri: string, actions: Array<{ resize?: { width: number } }>) => {
        resized.widths.push(actions[0]?.resize?.width ?? 0);
        return { uri, width: actions[0]?.resize?.width ?? 0, height: 600 };
    },
    SaveFormat: { JPEG: 'jpeg' },
}));
vi.mock('expo-crypto', () => ({ randomUUID: () => `photo-${++picker.refs}` }));
const theme = vi.hoisted(() => ({ dark: false }));
vi.mock('../../../app/ThemeContext', async () => {
    const { lightColors, darkColors } = await import('../../../constants/colors');
    const now = () => ({ theme: theme.dark ? 'dark' : 'light', colors: theme.dark ? darkColors : lightColors });
    return { useTheme: () => now(), useStyles: (make: (t: unknown) => unknown) => make(now()) };
});
const ME = { publicKey: 'me-key', callsign: 'Ana' };
vi.mock('../../../app/IdentityContext', () => ({ useIdentity: () => ({ identity: ME }) }));
const node = vi.hoisted(() => ({ profile: { profile: 'local', features: { beans: true } } as { profile: string; features: Record<string, unknown> }, needsPhoto: true, avatar: null as string | null }));
vi.mock('../../../utils/use-node-profile', () => ({ useNodeProfile: () => node.profile }));
vi.mock('../../../utils/market-global', () => ({ composerNeedsProfilePhoto: async () => node.needsPhoto }));
vi.mock('../../../utils/canonical-profile', () => ({ getCanonicalAvatar: async () => null }));

const disk = vi.hoisted(() => ({ dir: '', db: null as any }));
/**
 * The member's Offers as the phone holds them, and their deals as the community's server has them (`deals`) and as the
 * phone's own table holds them (`phoneDeals`, what the sync last brought); `down` when the server can't be reached,
 * `dealsUnread` when it refuses the deals, and `dealsGate` holds a read of the deals until it settles. The deals asked
 * of the server are in `dealReads`, every other request in `requests`. `copy` is the server's own copy of the shed (from
 * the member's other device), none when null; `copyGate` holds a read of it and `marketGate` a pause or resume (each
 * in `marketAsks` as it is asked) until each settles; `puts` are the documents sent to it. `rows` are the Offers as the
 * server has them; `phoneRows` is the phone's own row of one where it says something else (a sync not yet run), and the
 * server's reads of an Offer are in `postReads`. A shop closed for now (`closeShop`) paused what is in `shopHeld` and
 * refuses to put back up anything in `inClosedShop` (409 shop_paused); its reopen puts back what it still holds.
 */
const market = vi.hoisted(() => ({
    rows: new Map<string, Record<string, unknown>>(),
    phoneRows: new Map<string, Record<string, unknown>>(),
    postReads: [] as string[],
    shopHeld: new Set<string>(),
    inClosedShop: new Set<string>(),
    deals: [] as Array<Record<string, unknown>>,
    phoneDeals: [] as Array<Record<string, unknown>>,
    paused: [] as string[], resumed: [] as string[], down: false, dealsUnread: false,
    dealsGate: null as Promise<void> | null,
    requests: [] as string[],
    dealReads: [] as string[],
    copy: null as { doc: unknown; updatedAt: string } | null,
    copyGate: null as Promise<void> | null,
    marketGate: null as Promise<void> | null,
    marketAsks: [] as string[],
    puts: [] as unknown[],
}));
vi.mock('../../../utils/db', () => ({
    getDb: async () => disk.db,
    getMemberProfile: async () => ({ avatar_url: node.avatar }),
    getPost: async (id: string) => market.phoneRows.get(id) ?? market.rows.get(id) ?? null,
    getMyPosts: async (pubkey: string) => [...market.rows.values()].map((p) => market.phoneRows.get(p.id as string) ?? p).filter((p) => p.author_pubkey === pubkey),
    // As the phone's own copy answers (utils/db.ts): by status when asked, `limit` rows from `offset`.
    getMarketplaceTransactions: async (pubkey: string, filter?: { status?: string }, limit = 50, offset = 0) =>
        market.phoneDeals.filter((d) => (d.sellerPublicKey === pubkey || d.buyerPublicKey === pubkey) && (!filter?.status || d.status === filter.status))
            .slice(offset, offset + limit),
    // As the node has them (posts.ts): a live Offer is paused (`paused`), and the owner's pause of one already paused is
    // taken, making a shop's pause theirs; only a paused one is resumed, never one in a shop closed for now (409
    // shop_paused); anything else is a 400. The phone's signed request throws each refusal with its status and code.
    pausePost: async (id: string) => {
        if (market.down) throw new TypeError('Network request failed');
        market.marketAsks.push(`pause ${id}`);
        if (market.marketGate) await market.marketGate;
        const p = market.rows.get(id);
        if (p?.status === 'paused' && p.author_pubkey === ME.publicKey) { market.shopHeld.delete(id); return; }
        if (p?.status !== 'active') throw Object.assign(new Error('Post not found, not active, or not owned by author'), { status: 400 });
        market.paused.push(id);
        p.status = 'paused';
    },
    resumePost: async (id: string) => {
        if (market.down) throw new TypeError('Network request failed');
        market.marketAsks.push(`resume ${id}`);
        if (market.marketGate) await market.marketGate;
        const p = market.rows.get(id);
        if (market.inClosedShop.has(id)) {
            throw Object.assign(new Error('This is in a shop that is closed for now. Reopen the shop to put it back up.'), { status: 409, code: 'shop_paused' });
        }
        if (p?.status !== 'paused') throw Object.assign(new Error('Post not found, not paused, or not owned by author'), { status: 400 });
        market.resumed.push(id);
        p.status = 'active';
    },
    // The node copy (the Tool shed asks for node-copy): a server that keeps copies and has none of this one yet. And the
    // deals, as the node answers them (routes/marketplace.ts): the asker's own, newest first, by status when asked, 50
    // rows unless asked, at most 200, from `offset`.
    signedGet: async (p: string) => {
        const url = new URL(p, 'https://mullum.example');
        if (url.pathname === '/api/marketplace/transactions') {
            market.dealReads.push(p);
            if (market.dealsGate) await market.dealsGate;
            if (market.down) throw new TypeError('Network request failed');
            if (market.dealsUnread) return { ok: false, status: 503, json: async () => ({ error: 'Service unavailable' }) };
            const who = url.searchParams.get('publicKey');
            const status = url.searchParams.get('status');
            const asked = Math.floor(Number(url.searchParams.get('limit')));
            const limit = Number.isFinite(asked) && asked > 0 ? Math.min(asked, 200) : 50;
            const offset = Math.max(0, Math.floor(Number(url.searchParams.get('offset'))) || 0);
            const rows = market.deals
                .filter((d) => (d.sellerPublicKey === who || d.buyerPublicKey === who) && (!status || d.status === status))
                .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
                .slice(offset, offset + limit);
            return { ok: true, status: 200, json: async () => rows };
        }
        // One listing by its id, as the node answers its author (routes/marketplace.ts): their paused one too.
        if (url.pathname === '/api/marketplace/posts') {
            market.postReads.push(p);
            if (market.down) throw new TypeError('Network request failed');
            const row = market.rows.get(url.searchParams.get('id') ?? '');
            return { ok: true, status: 200, headers: new Headers(), json: async () => (row ? [{ ...row, authorPublicKey: row.author_pubkey }] : []) };
        }
        market.requests.push(`GET ${p}`);
        if (market.down) throw new TypeError('Network request failed');
        if (market.copyGate) await market.copyGate;
        return { status: 200, json: async () => ({ tool: 'things', doc: market.copy?.doc ?? null, updatedAt: market.copy?.updatedAt ?? null }) };
    },
    signedRequestWithMethod: async (method: string, p: string, body?: { doc?: unknown }) => {
        market.requests.push(`${method} ${p}`);
        if (method === 'PUT') market.puts.push(body?.doc);
        if (market.down) throw new TypeError('Network request failed');
        return { success: true, tool: 'things', updatedAt: '2026-10-21T08:00:00.000Z' };
    },
}));
vi.mock('expo-file-system/legacy', async () => {
    const nfs = await import('node:fs');
    const p = (uri: string) => decodeURI(uri.replace(/^file:\/\//, ''));
    return {
        get documentDirectory() { return `file://${disk.dir}/`; },
        makeDirectoryAsync: async (uri: string) => { nfs.mkdirSync(p(uri), { recursive: true }); },
        copyAsync: async ({ from, to }: { from: string; to: string }) => { nfs.copyFileSync(p(from), p(to)); },
        deleteAsync: async (uri: string) => { nfs.rmSync(p(uri), { recursive: true, force: true }); },
        readAsStringAsync: async (uri: string) => nfs.readFileSync(p(uri)).toString('base64'),
    };
});

// The phone half's screens thunk is require('./screens'): Metro bundles it, and vitest can't load a .tsx through Node's own
// require. The same module, imported (the thunk's line itself is held by the test below).
vi.mock('../index', async () => {
    const { SCREENS } = await import('../screens');
    return { default: { id: 'things', screens: () => SCREENS } };
});

import { DatabaseSync } from 'node:sqlite';
import {
    THINGS, THINGS_MAX_ITEMS, TOOL_LIMITS, backAroundIn, lendOutside, readThingsDoc, setLanguage, shedThings, thingCategory, toolDocBytes,
    toolLineText, type Thing, type ThingsDoc,
} from '@beanpool/core';
// The Tool shed's fixtures are never shipped: from core's sources, as the template's generic tests read them.
import { FIXTURES as SOURCE_FIXTURES } from '../../../../../packages/beanpool-core/src/tools/things/fixtures';

/** The same documents, typed as the app's build of core types them. */
const FIXTURES = SOURCE_FIXTURES as unknown as { docs: { empty: ThingsDoc; small: ThingsDoc; full: ThingsDoc }; now: number };
import { TOOL_APPS, phoneTool } from '../../index';
import { ToolHomeBody, homeLines, safeLine } from '../../frame';
import { TOOL_DOCS_TABLE } from '../../schema';
import { openToolCopy } from '../../node-copy';
import { ToolDocTooBigError, readToolDoc, writeToolDoc } from '../../store';
import { keep as keepThings } from '../parts';
import { OFFER_DRAFT_KEY } from '../../doors';
import { toolPhotoUri } from '../../photos';
import { communityKey } from '../../community';
import { darkColors, lightColors } from '../../../constants/colors';
import ToolRoute from '../../../app/tool/[id]';

const NATIVE = path.resolve(__dirname, '../../..');
const tmp = fs.mkdtempSync(path.join(NATIVE, '.things-screens-'));
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

function sqliteDb() {
    const d = new DatabaseSync(':memory:');
    const bind = (params?: unknown[]) => (params ?? []) as any[];
    return {
        execAsync: async (sql: string) => { d.exec(sql); },
        runAsync: async (sql: string, params?: unknown[]) => { const r = d.prepare(sql).run(...bind(params)); return { changes: Number(r.changes) }; },
        getFirstAsync: async (sql: string, params?: unknown[]) => d.prepare(sql).get(...bind(params)) ?? null,
        getAllAsync: async (sql: string, params?: unknown[]) => d.prepare(sql).all(...bind(params)),
    };
}

/** The fixtures' moment: the clock is held there, so a "back around" date never turns into "was due back" on a later run. */
const NOW = FIXTURES.now;
const DAY = 86_400_000;
const iso = (ms: number) => new Date(ms).toISOString();
const thing = (id: string, name: string, extra: Partial<Thing> = {}): Thing => ({ id, name, category: 'tools', createdAt: iso(NOW - DAY), updatedAt: iso(NOW - DAY), ...extra });
const shed = (...things: Thing[]): ThingsDoc => ({ v: 1, things });
const offer = (id: string, title: string, status = 'active', extra: Record<string, unknown> = {}) => {
    market.rows.set(id, { id, title, status, type: 'offer', author_pubkey: ME.publicKey, ...extra });
};
/** The member's shop "closed for now" on the server, holding these Offers (engine/shops.ts): the live ones are paused. */
const closeShop = (...ids: string[]) => {
    for (const id of ids) {
        const p = market.rows.get(id)!;
        if (p.status === 'active') { p.status = 'paused'; market.shopHeld.add(id); }
        market.inClosedShop.add(id);
    }
};
/** Reopened: what the shop paused and still holds is back up; the rest stays as it is. */
const reopenShop = () => {
    for (const id of market.shopHeld) { const p = market.rows.get(id); if (p?.status === 'paused') p.status = 'active'; }
    market.shopHeld.clear();
    market.inClosedShop.clear();
};

let host: HTMLDivElement;
let root: Root;
/** What members wrote: shown as written, so taken out before the words checks. */
let OTHERS: string[] = [];

beforeEach(() => {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    store.map.clear();
    store.map.set('beanpool_anchor_url', 'https://mullum.example');
    disk.dir = fs.mkdtempSync(path.join(tmp, 'disk-'));
    disk.db = sqliteDb();
    disk.db.execAsync(TOOL_DOCS_TABLE);
    picker.file = path.join(disk.dir, 'picked.jpg');
    fs.writeFileSync(picker.file, 'jpeg bytes');
    picker.refs = 0;
    picker.cameraAllowed = true;
    resized.widths.length = 0;
    nav.params = {};
    nav.pushed.length = 0;
    nav.backs = 0;
    market.rows.clear();
    market.phoneRows.clear();
    market.postReads.length = 0;
    market.shopHeld.clear();
    market.inClosedShop.clear();
    market.deals.length = 0;
    market.phoneDeals.length = 0;
    market.paused.length = 0;
    market.resumed.length = 0;
    market.requests.length = 0;
    market.dealReads.length = 0;
    market.down = false;
    market.dealsUnread = false;
    market.dealsGate = null;
    market.copy = null;
    market.copyGate = null;
    market.marketGate = null;
    market.marketAsks.length = 0;
    market.puts.length = 0;
    node.profile = { profile: 'local', features: { beans: true } };
    node.needsPhoto = true;
    node.avatar = null;
    theme.dark = false;
    OTHERS = [];
    vi.useFakeTimers({ toFake: ['Date'], now: NOW });
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ items: [] }), { status: 200 })));
});
afterEach(() => { act(() => root.unmount()); host.remove(); setLanguage('en'); vi.unstubAllGlobals(); vi.useRealTimers(); });

const settle = async (n = 10) => { for (let i = 0; i < n; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); };
async function open(screen: string, params: Record<string, string> = {}, lang: 'xx' | 'en' = 'en') {
    setLanguage(lang);
    nav.params = { id: 'things', screen, ...params };
    await act(async () => { root.render(createElement(ToolRoute) as any); });
    await settle();
}
const byTestId = (id: string) => host.querySelector(`[data-testid="${id}"]`);
const all = (sel: string) => Array.from(host.querySelectorAll(sel));
async function click(id: string) {
    const el = byTestId(id);
    expect(el, id).not.toBeNull();
    expect(el!.getAttribute('data-disabled'), `${id} is enabled`).toBeNull();
    await act(async () => { (el as HTMLElement).click(); });
    await settle(8);
}
async function type(id: string, text: string) {
    const input = byTestId(id) as HTMLInputElement | null;
    expect(input, id).not.toBeNull();
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    await act(async () => { set.call(input, text); input!.dispatchEvent(new Event('input', { bubbles: true })); });
    await settle(2);
}
const text = (id: string) => byTestId(id)?.textContent ?? null;
const keep = (doc: ThingsDoc) => writeToolDoc(ME.publicKey, THINGS, doc, NOW - DAY);
const kept = async () => (await readToolDoc(ME.publicKey, THINGS)).doc as ThingsDoc;
const keptThing = async (id: string) => (await kept()).things.find((t) => (t as Thing).id === id) as Thing | undefined;
/** The rows of the main list, top to bottom, as "name: state". */
const rows = () => all('[data-testid^="thing-row-"]').map((r) => r.getAttribute('aria-label'));

// ── The checks ───────────────────────────────────────────────────────────────────────────────────────────────────

function outsideBrackets(s: string | null | undefined): boolean {
    if (!s) return false;
    let rest = s;
    for (const o of [...OTHERS].sort((a, b) => b.length - a.length)) rest = rest.split(o).join('');
    for (let was = ''; was !== rest;) { was = rest; rest = rest.replace(/\[[^[\]]*\]/g, ''); }
    return /\p{L}/u.test(rest);
}
/** Every drawn text and label that bypassed t(). */
function bypassing(): string[] {
    const out = new Set<string>();
    const walker = document.createTreeWalker(host, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
        const whole = n.parentElement?.textContent ?? n.nodeValue;
        if (outsideBrackets(whole)) out.add(`text: ${JSON.stringify(whole)}`);
    }
    for (const e of all('[aria-label],[placeholder]')) {
        for (const v of [e.getAttribute('aria-label'), e.getAttribute('placeholder')]) if (outsideBrackets(v)) out.add(`label: ${JSON.stringify(v)}`);
    }
    return [...out];
}
function textWidth(s: string, fontSize: number): number {
    const px = fontSize * FONT_SCALE;
    return [...s].reduce((w, ch) => w + (/\p{Extended_Pictographic}/u.test(ch) ? 1.25 : 0.62) * px, 0);
}
const CARD_INNER = SCREEN - 2 * 16 - 2 * 14 - 2 * 1;
function tooWide(): string[] {
    const out: string[] = [];
    for (const span of all('span')) {
        let s = Array.from(span.childNodes).filter((c) => c.nodeType === 3).map((c) => c.nodeValue).join('');
        for (const o of OTHERS) s = s.split(o).join(' ');
        const font = Number(span.getAttribute('data-font') ?? 15);
        for (const w of s.split(/[\s\u200b]+/u).filter(Boolean)) if (textWidth(w, font) >= CARD_INNER) out.push(`${w} (${Math.round(textWidth(w, font))} dp)`);
    }
    return out;
}
function tokens(v: unknown, out = new Set<string>()): Set<string> {
    if (typeof v === 'string') out.add(v);
    else if (v && typeof v === 'object') Object.values(v).forEach((x) => tokens(x, out));
    return out;
}
/** Each colour the tool's screen draws that isn't one of the theme's tokens. */
function offTokens(screenId: string): string[] {
    const allowed = tokens(theme.dark ? darkColors : lightColors);
    const screen = byTestId(screenId);
    expect(screen, screenId).not.toBeNull();
    const out: string[] = [];
    for (const e of [screen!, ...Array.from(screen!.querySelectorAll('*'))]) {
        for (const a of ['data-color', 'data-bg', 'data-border', 'data-placeholder-color']) {
            const v = e.getAttribute(a);
            if (v && v !== 'transparent' && !allowed.has(v)) out.push(`${a}=${v}`);
        }
    }
    return out;
}

// ── The tests ────────────────────────────────────────────────────────────────────────────────────────────────────

describe('the Tool shed on the phone', () => {
    it("is registered: its phone half draws every screen its manifest names, and nothing else, loaded on first open", () => {
        expect(TOOL_APPS.things?.id).toBe('things');
        expect(Object.keys(TOOL_APPS.things.screens()).sort()).toEqual([...THINGS.screens].sort());
        // A thunk: nothing of the screens runs at app start (Metro's inlineRequires is off).
        expect(fs.readFileSync(path.join(NATIVE, 'tools/things/index.ts'), 'utf8')).toContain("screens: () => require('./screens').SCREENS,");
    });

    it('every screen in xx at 320 dp × 1.3, light and dark: every word through t(), each fits, colours from the tokens', async () => {
        offer('post-1', 'Cordless drill');
        market.deals.push({ id: 'tx1', postId: 'post-1', sellerPublicKey: ME.publicKey, buyerPublicKey: 'b', status: 'requested', createdAt: iso(NOW - DAY) });
        const names = (d: ThingsDoc) => d.things.flatMap((t) => [(t as Thing).name, (t as Thing).lentTo?.name ?? '', (t as Thing).lendTerms ?? '', (t as Thing).replacementValue ?? '', (t as Thing).ownerNote ?? '']).filter(Boolean);
        const small: ThingsDoc = { ...FIXTURES.docs.small, things: FIXTURES.docs.small.things.map((t, i) => (i === 2 ? { ...(t as Thing), ownerNote: 'Under the house', photo: 'p-1' } : t)) };
        const cases: Array<[string, Record<string, string>, ThingsDoc, string]> = [
            ['main', {}, small, 'things-main'],
            ['main', {}, FIXTURES.docs.full, 'things-main'],
            ['thing', { key: 't-1' }, small, 'thing-screen'],
            ['thing', { key: 't-2' }, small, 'thing-screen'],
            ['thing', { key: 't-3' }, small, 'thing-screen'],
            ['edit', {}, small, 'thing-edit-screen'],
            ['edit', { key: 't-3' }, small, 'thing-edit-screen'],
            ['loans', {}, small, 'things-loans-screen'],
            ['loans', {}, shed(), 'things-loans-screen'],
        ];
        for (const dark of [false, true]) {
            for (const [screen, params, doc, screenId] of cases) {
                const where = `${screen} ${JSON.stringify(params)} with ${doc.things.length} things, ${dark ? 'dark' : 'light'}`;
                theme.dark = dark;
                await keep(doc);
                OTHERS = names(doc);
                await open(screen, params, 'xx');
                expect(byTestId(screenId), where).not.toBeNull();
                expect(bypassing(), where).toEqual([]);
                expect(tooWide(), where).toEqual([]);
                expect(offTokens(screenId), where).toEqual([]);
                act(() => root.unmount());
                root = createRoot(host);
            }
        }
    });
});

// #2366 review: the frame's safeLine and homeLines pass a wordn() line through, and toolLineText draws its plural.
describe("the frame's count line and the Tool shed's Home card", () => {
    it('say "1 thing" and "3 things", each in the form its count needs', async () => {
        const one = shed(thing('t-1', 'Drill'));
        expect(toolLineText(safeLine(() => THINGS.row(one, NOW))!)).toBe('1 thing · 0 in your shop · 0 out');
        expect(homeLines(THINGS, one, NOW).map(toolLineText)).toEqual(['1 thing · in your shed']);
        expect(homeLines(THINGS, FIXTURES.docs.small, NOW).map(toolLineText)).toEqual(['3 things · 1 out']);
        expect(homeLines(THINGS, FIXTURES.docs.empty, NOW)).toEqual([]);

        await keep(FIXTURES.docs.small);
        await open('main');
        expect(text('tool-state')).toBe('3 things · 1 in your shop · 1 out');
        act(() => root.unmount());
        root = createRoot(host);
        await keep(one);
        await act(async () => {
            root.render(createElement(ToolHomeBody, { tool: phoneTool('things')!, owner: ME.publicKey, colors: lightColors, now: NOW }) as any);
        });
        await settle();
        expect(byTestId('tool-home-things')?.textContent).toContain('1 thing · in your shed');
    });
});

describe('Your things', () => {
    it('newest first, each with its state; the filters narrow it; Add and Loans open their screens', async () => {
        offer('post-1', 'Cordless drill');
        await keep(FIXTURES.docs.small);
        await open('main');
        expect(rows()).toEqual([
            'Camping tent, On your shelf',
            expect.stringMatching(/^Step ladder, Due \d{1,2} [A-Z][a-z]{2} · with Alice$/),
            'Cordless drill, In your shop',
        ]);
        await click('things-filter-out');
        expect(rows().map((r) => r!.split(',')[0])).toEqual(['Step ladder']);
        await click('things-filter-shop');
        expect(rows().map((r) => r!.split(',')[0])).toEqual(['Cordless drill']);
        await click('things-filter-shelf');
        expect(rows().map((r) => r!.split(',')[0])).toEqual(['Camping tent']);
        await click('things-filter-all');
        await click('things-add');
        expect(nav.pushed.at(-1)).toEqual({ pathname: '/tool/[id]', params: { id: 'things', screen: 'edit' } });
        await click('things-loans');
        expect(nav.pushed.at(-1)).toEqual({ pathname: '/tool/[id]', params: { id: 'things', screen: 'loans' } });
        await click('thing-row-t-3');
        expect(nav.pushed.at(-1)).toEqual({ pathname: '/tool/[id]', params: { key: 't-3', id: 'things', screen: 'thing' } });
    });

    it("a photo that isn't on this phone (one taken on another device): its row has the thing's emoji, and no screen draws an empty box", async () => {
        // Ladder's photo is on this phone; Drill's ref came with the server's copy, from the member's other device.
        await keep(shed(thing('t-1', 'Drill', { photo: 'p-elsewhere' }), thing('t-2', 'Ladder')));
        await open('edit', { key: 't-2' });
        await click('edit-photo-pick');
        await click('edit-save');
        const ladder = toolPhotoUri(communityKey('https://mullum.example'), ME.publicKey, 'things', 'photo-1');
        act(() => root.unmount());
        root = createRoot(host);
        await open('main');
        expect(byTestId('thing-row-t-2')?.querySelector('img')?.getAttribute('data-src')).toBe(ladder);
        expect(byTestId('thing-row-t-1')?.querySelector('img')).toBeNull();
        expect(byTestId('thing-row-t-1')?.textContent).toContain(thingCategory('tools').emoji);
        for (const [screen, photo] of [['thing', 'thing-photo'], ['edit', 'edit-photo']] as const) {
            act(() => root.unmount());
            root = createRoot(host);
            await open(screen, { key: 't-1' });
            expect(byTestId(screen === 'thing' ? 'thing-screen' : 'thing-edit-screen'), screen).not.toBeNull();
            expect(byTestId(photo), screen).toBeNull();
        }
        // Its own photo still draws on its screen.
        act(() => root.unmount());
        root = createRoot(host);
        await open('thing', { key: 't-2' });
        expect(byTestId('thing-photo')?.getAttribute('data-src')).toBe(ladder);
    });

    it('a thing out on a BeanPool loan says so, from the deal; a filter with nothing in it says so', async () => {
        offer('post-1', 'Cordless drill', 'pending', { lendable: 1, price_type: 'fixed', accepted_at: iso(NOW - DAY) });
        market.deals.push({ id: 'tx1', postId: 'post-1', sellerPublicKey: ME.publicKey, buyerPublicKey: 'b', status: 'pending', hours: 3, createdAt: iso(NOW - 2 * DAY) });
        await keep(shed(thing('t-1', 'Cordless drill', { postId: 'post-1' })));
        await open('main');
        expect(rows()).toEqual([expect.stringMatching(/^Cordless drill, Out · due \d{1,2} [A-Z][a-z]{2}$/)]);
        await click('things-filter-shelf');
        expect(rows()).toEqual([]);
        expect(text('things-none')).toBe('Nothing to show here.');
    });

    it(`Loans gives no count until the deals are known, and says when they couldn't be read: never "nothing out" unchecked`, async () => {
        let release!: () => void;
        market.dealsGate = new Promise<void>((r) => { release = r; });
        offer('post-1', 'Drill', 'pending', { lendable: 1, price_type: 'fixed', accepted_at: iso(NOW - DAY) });
        market.deals.push({ id: 'tx1', postId: 'post-1', sellerPublicKey: ME.publicKey, buyerPublicKey: 'b', status: 'pending', hours: 3, createdAt: iso(NOW - 2 * DAY) });
        await keep(shed(thing('t-1', 'Drill', { postId: 'post-1' })));
        await open('main');
        expect(byTestId('things-loans')?.getAttribute('aria-label')).toBe('Loans');
        release();
        await settle();
        expect(byTestId('things-loans')?.getAttribute('aria-label')).toBe('Loans, Out or asked for: 1');
        expect(byTestId('things-loans-unchecked')).toBeNull();

        act(() => root.unmount());
        root = createRoot(host);
        market.dealsGate = null;
        market.dealsUnread = true;
        await open('main');
        expect(byTestId('things-loans')?.getAttribute('aria-label')).toBe('Loans');
        expect(text('things-loans-unchecked')).toBe("Loans through BeanPool couldn't be checked just now.");
    });

    it('after "I already do this", an empty shed says what goes in it, with Add', async () => {
        await open('main');
        await click('tool-door-doing');
        expect(byTestId('things-empty')?.textContent).toContain("Add the first thing you'd lend");
        expect(byTestId('things-add')).not.toBeNull();
        expect(byTestId('things-filter')).toBeNull();
    });
});

describe('Edit', () => {
    it('a name is needed and a longest loan is 1 to 365 days; saved at the top of the list, then back', async () => {
        await keep(shed(thing('t-1', 'Ladder')));
        await open('edit');
        await click('edit-save');
        expect(text('edit-name-field')).toContain('Give it a name.');
        expect((await kept()).things).toHaveLength(1);
        await type('edit-name', '  Wheelbarrow ');
        await click('edit-condition-fair');
        await type('edit-days', '400');
        await type('edit-replacement', '$90');
        await type('edit-note', 'Behind the shed');
        await click('edit-save');
        expect(text('edit-days-field')).toContain('A number of days from 1 to 365.');
        await type('edit-days', '7');
        await click('edit-save');
        const doc = await kept();
        expect(doc.things).toHaveLength(2);
        expect(doc.things[1]).toMatchObject({ name: 'Wheelbarrow', category: 'tools', condition: 'fair', lendMaxDays: 7, replacementValue: '$90', ownerNote: 'Behind the shed' });
        expect(nav.backs).toBe(1);
    });

    it('the keyboard never covers a box or Save: every box, Save and Cancel are in the keyboard-aware scroll', async () => {
        // Edit is the tallest form a tool has (#2373's deciding review): at 320 dp × 1.3 "Your own note" and Save sit under
        // an open keyboard. ToolScreen scrolls the box tapped above it, with room for its note line, and adds the
        // keyboard's height under Save so Save can be scrolled up too (react-native-keyboard-controller, the root provider).
        await keep(shed(thing('t-1', 'Ladder')));
        await open('edit', { key: 't-1' });
        const screen = byTestId('thing-edit-screen')!;
        expect(screen.getAttribute('data-keyboard-aware')).toBe('true');
        expect(screen.getAttribute('data-persist-taps')).toBe('handled');
        expect(Number(screen.getAttribute('data-bottom-offset'))).toBeGreaterThanOrEqual(4 + 18 * FONT_SCALE);
        for (const id of ['edit-name', 'edit-replacement', 'edit-terms', 'edit-days', 'edit-note', 'edit-save', 'edit-cancel']) {
            expect(byTestId(id), id).not.toBeNull();
            expect(screen.contains(byTestId(id)), id).toBe(true);
        }
        // With the keyboard up a tap on Save still saves (keyboardShouldPersistTaps="handled").
        await type('edit-note', 'Behind the shed');
        await click('edit-save');
        expect((await keptThing('t-1'))?.ownerNote).toBe('Behind the shed');
    });

    it('the category opens to every Market category, Tools first; an edit keeps its Offer and who has it', async () => {
        await keep(shed(thing('t-1', 'Hoe', { postId: 'post-1', lentTo: { name: 'Sam', since: iso(NOW - DAY) } })));
        await open('edit', { key: 't-1' });
        expect(byTestId('edit-category-garden')).toBeNull();
        await click('edit-category-open');
        const chips = all('[data-testid^="edit-category-"][role="radio"]').map((c) => c.getAttribute('data-testid'));
        expect(chips[0]).toBe('edit-category-tools');
        expect(chips).toHaveLength(17);
        await click('edit-category-garden');
        await click('edit-save');
        expect(await keptThing('t-1')).toMatchObject({ name: 'Hoe', category: 'garden', postId: 'post-1', lentTo: { name: 'Sam' } });
    });

    it('a photo is taken at 800 px and kept on the phone; Remove takes it out, and its file goes once saved', async () => {
        await keep(shed(thing('t-1', 'Tent')));
        await open('edit', { key: 't-1' });
        await click('edit-photo-take');
        expect(resized.widths).toEqual([800]);
        const comm = communityKey('https://mullum.example');
        const file = toolPhotoUri(comm, ME.publicKey, 'things', 'photo-1').replace(/^file:\/\//, '');
        expect(byTestId('edit-photo')?.getAttribute('data-src')).toBe(`file://${file}`);
        await click('edit-save');
        expect((await keptThing('t-1'))?.photo).toBe('photo-1');
        expect(fs.existsSync(file)).toBe(true);
        act(() => root.unmount());
        root = createRoot(host);
        await open('edit', { key: 't-1' });
        await click('edit-photo-remove');
        expect(byTestId('edit-photo')).toBeNull();
        await click('edit-save');
        expect((await keptThing('t-1'))?.photo).toBeUndefined();
        expect(fs.existsSync(file)).toBe(false);
    });

    it('a photo chosen and then cancelled leaves no file behind; no camera allowed changes nothing', async () => {
        await keep(shed(thing('t-1', 'Tent')));
        await open('edit', { key: 't-1' });
        picker.cameraAllowed = false;
        await click('edit-photo-take');
        expect(byTestId('edit-photo')).toBeNull();
        await click('edit-photo-pick');
        const file = toolPhotoUri(communityKey('https://mullum.example'), ME.publicKey, 'things', 'photo-1').replace(/^file:\/\//, '');
        expect(fs.existsSync(file)).toBe(true);
        await click('edit-cancel');
        expect(nav.backs).toBe(1);
        expect(fs.existsSync(file)).toBe(false);
        expect((await keptThing('t-1'))?.photo).toBeUndefined();
    });

    it("a photo chosen and left without Cancel (the header's ←, Android's back, a swipe) leaves no file behind; a saved one stays", async () => {
        const comm = communityKey('https://mullum.example');
        const fileOf = (ref: string) => toolPhotoUri(comm, ME.publicKey, 'things', ref).replace(/^file:\/\//, '');
        await keep(shed(thing('t-1', 'Tent')));
        await open('edit', { key: 't-1' });
        await click('edit-photo-pick');
        expect(fs.existsSync(fileOf('photo-1'))).toBe(true);
        act(() => root.unmount());
        await settle();
        expect(fs.existsSync(fileOf('photo-1'))).toBe(false);
        expect((await keptThing('t-1'))?.photo).toBeUndefined();
        expect(nav.backs).toBe(0);

        // Saved, then left: the thing's photo stays. Chosen again and left: the new one goes, the thing's own stays.
        root = createRoot(host);
        await open('edit', { key: 't-1' });
        await click('edit-photo-pick');
        await click('edit-save');
        expect((await keptThing('t-1'))?.photo).toBe('photo-2');
        act(() => root.unmount());
        await settle();
        expect(fs.existsSync(fileOf('photo-2'))).toBe(true);
        root = createRoot(host);
        await open('edit', { key: 't-1' });
        await click('edit-photo-pick');
        await click('edit-photo-remove');
        act(() => root.unmount());
        await settle();
        root = createRoot(host);
        expect(fs.existsSync(fileOf('photo-3'))).toBe(false);
        expect(fs.existsSync(fileOf('photo-2'))).toBe(true);
        expect((await keptThing('t-1'))?.photo).toBe('photo-2');
    });

    it(`a ${THINGS_MAX_ITEMS + 1}st thing is refused in one sentence, and so is a save past the store's bound; nothing is written`, async () => {
        const many = Array.from({ length: THINGS_MAX_ITEMS }, (_, i) => thing(`t-${i}`, `Thing ${i}`));
        await keep(shed(...many));
        await open('edit');
        await type('edit-name', 'One more');
        await click('edit-save');
        expect(text('edit-problem')).toBe('Your Tool shed holds 100 things. Delete one first.');
        expect((await kept()).things).toHaveLength(THINGS_MAX_ITEMS);
        expect(nav.backs).toBe(0);

        act(() => root.unmount());
        root = createRoot(host);
        // Things with every field at its bound, as many as fit: one more is past 64 KB.
        const big = (i: number) => thing(`b-${i}`, 'n'.repeat(80), { lendTerms: 't'.repeat(300), ownerNote: 'o'.repeat(500), replacementValue: 'r'.repeat(40) });
        const full: Thing[] = [];
        while (toolDocBytes(shed(...full, big(full.length))) <= TOOL_LIMITS.docBytes) full.push(big(full.length));
        expect(full.length).toBeLessThan(THINGS_MAX_ITEMS);
        await keep(shed(...full));
        await open('edit');
        await type('edit-name', 'n'.repeat(80));
        await type('edit-terms', 't'.repeat(300));
        await type('edit-note', 'o'.repeat(500));
        await type('edit-replacement', 'r'.repeat(40));
        await click('edit-save');
        expect(text('edit-problem')).toBe('Your Tool shed is full: it keeps up to 64 KB. Delete something you no longer have, or shorten some notes.');
        expect((await kept()).things).toHaveLength(full.length);
    });
});

describe('A thing', () => {
    it("List opens the host's List sheet with the thing's draft; no profile photo says so; Go on writes the composer's draft, posting nothing", async () => {
        await keep(shed(thing('t-1', 'Cordless drill', { lendTerms: 'Clean it.', replacementValue: '$120', lendMaxDays: 7 })));
        await open('thing', { key: 't-1' });
        await click('thing-list');
        expect(byTestId('tool-list-sheet')).not.toBeNull();
        expect(text('tool-list-title')).toBe('Cordless drill');
        expect(byTestId('tool-list-photo')).not.toBeNull();
        expect(byTestId('tool-list-go')?.getAttribute('data-disabled')).toBe('true');
        await click('tool-list-cancel');

        node.avatar = 'https://mullum.example/a.jpg';
        await click('thing-list');
        expect(byTestId('tool-list-photo')).toBeNull();
        await click('tool-list-go');
        const draft = JSON.parse(store.map.get(OFFER_DRAFT_KEY) ?? '{}');
        expect(draft).toMatchObject({
            postType: 'offer', postTitle: 'Cordless drill', postCategory: 'tools', postCredits: '0',
            postDescription: "Clean it.\n\nIf it's lost or broken: $120. That is settled between us; BeanPool doesn't hold or collect it.\n\nLent for up to 7 days at a time.",
            source: 'tool', tool: 'things',
        });
        expect(nav.pushed.at(-1)).toBe('/(tabs)/map?newPost=offer');
        // The sheet reads the member's shop each time it opens ("Put this in your shop", slice S4′); nothing is posted.
        expect(market.requests.filter((r) => !r.endsWith('/api/tools/things'))).toEqual(['GET /api/shops/mine', 'GET /api/shops/mine']);
        // Nothing posted, so nothing is said to be in the shop.
        expect((await keptThing('t-1'))?.postId).toBeUndefined();
    });

    it("linked to the member's own Offer: one free to link; a live one puts it in the shop, a paused one takes it out", async () => {
        offer('post-1', 'Cordless drill');
        offer('post-2', 'Old saw', 'paused');
        offer('post-3', 'Ladder');
        market.rows.set('theirs', { id: 'theirs', title: 'Not mine', status: 'active', type: 'offer', author_pubkey: 'someone' });
        await keep(shed(thing('t-1', 'Cordless drill'), thing('t-2', 'Ladder', { postId: 'post-3' })));
        await open('thing', { key: 't-1' });
        await click('thing-link');
        expect(all('[data-testid^="thing-link-post"]').map((e) => e.getAttribute('data-testid'))).toEqual(['thing-link-post-1', 'thing-link-post-2']);
        await click('thing-link-post-1');
        expect(await keptThing('t-1')).toMatchObject({ postId: 'post-1' });
        expect(text('thing-state')).toContain('In your shop');

        await keep(shed(thing('t-1', 'Saw')));
        act(() => root.unmount());
        root = createRoot(host);
        await open('thing', { key: 't-1' });
        await click('thing-link');
        await click('thing-link-post-2');
        expect(await keptThing('t-1')).toMatchObject({ pausedPostId: 'post-2' });
        expect(text('thing-state')).toContain('Taken out of your shop');
    });

    it('take out of the shop pauses its Offer; put back resumes the same one; an Offer gone from the Market puts it on the shelf and says so', async () => {
        offer('post-1', 'Cordless drill');
        await keep(shed(thing('t-1', 'Cordless drill', { postId: 'post-1' })));
        await open('thing', { key: 't-1' });
        await click('thing-take-out');
        expect(market.paused).toEqual(['post-1']);
        expect(await keptThing('t-1')).toMatchObject({ pausedPostId: 'post-1' });
        await click('thing-put-back');
        expect(market.resumed).toEqual(['post-1']);
        expect(await keptThing('t-1')).toMatchObject({ postId: 'post-1' });
        expect((await keptThing('t-1'))?.pausedPostId).toBeUndefined();

        market.rows.delete('post-1');
        await keep(shed(thing('t-1', 'Cordless drill', { pausedPostId: 'post-1' })));
        act(() => root.unmount());
        root = createRoot(host);
        await open('thing', { key: 't-1' });
        await click('thing-put-back');
        expect(text('thing-gone-note')).toBe('Its Offer has gone from the Market, so it is back on your shelf. List it again to make a new one.');
        const t1 = await keptThing('t-1');
        expect([t1?.postId, t1?.pausedPostId]).toEqual([undefined, undefined]);
    });

    it("a listed thing whose Offer has gone says so, with List it again and Forget it", async () => {
        await keep(shed(thing('t-1', 'Cordless drill', { postId: 'post-9' })));
        await open('thing', { key: 't-1' });
        expect(text('thing-offer-gone')).toContain('Its Offer has gone from the Market.');
        await click('thing-forget');
        expect((await keptThing('t-1'))?.postId).toBeUndefined();
        expect(byTestId('thing-offer-gone')).toBeNull();
        expect(byTestId('thing-list')).not.toBeNull();
    });

    it('"Who has it?" and its Save are in the keyboard-aware scroll, as Edit\'s boxes are', async () => {
        await keep(shed(thing('t-1', 'Ladder')));
        await open('thing', { key: 't-1' });
        await click('thing-lend');
        const screen = byTestId('thing-screen')!;
        expect(screen.getAttribute('data-keyboard-aware')).toBe('true');
        expect(screen.getAttribute('data-persist-taps')).toBe('handled');
        expect(screen.contains(byTestId('thing-lend-name'))).toBe(true);
        expect(screen.contains(byTestId('thing-lend-save'))).toBe(true);
    });

    it("lent outside BeanPool: who and when it's back; a listed thing's Offer is paused meanwhile and resumed when it's back", async () => {
        offer('post-1', 'Ladder');
        await keep(shed(thing('t-1', 'Ladder', { postId: 'post-1' })));
        await open('thing', { key: 't-1' });
        await click('thing-lend');
        expect(byTestId('thing-lend-save')?.getAttribute('data-disabled')).toBe('true');
        await type('thing-lend-name', 'Sam');
        await click('thing-lend-back-7');
        await click('thing-lend-save');
        expect(market.paused).toEqual(['post-1']);
        const lent = await keptThing('t-1');
        expect(lent?.lentTo?.name).toBe('Sam');
        expect(Date.parse(lent!.lentTo!.backAround!) - Date.parse(lent!.lentTo!.since)).toBe(7 * DAY);
        expect(text('thing-state')).toMatch(/^With Sam · back around /);
        expect(byTestId('thing-delete')).toBeNull();
        await click('thing-back-home');
        expect(market.resumed).toEqual(['post-1']);
        const back = await keptThing('t-1');
        expect(back?.lentTo).toBeUndefined();
        expect(back?.postId).toBe('post-1');
    });

    it("It's back reads its Offer first: put back in the Market meanwhile, it stays in the shop; gone, it is on the shelf; never \"taken out\"", async () => {
        const lentThing = () => thing('t-1', 'Ladder', { postId: 'post-1', lentTo: { name: 'Sam', since: iso(NOW - DAY) } });
        // Put back in the Market (from My Posts, or another device) while it was away: the server won't resume a live Offer.
        offer('post-1', 'Ladder', 'paused');
        await keep(shed(lentThing()));
        await open('thing', { key: 't-1' });
        market.rows.get('post-1')!.status = 'active';
        await click('thing-back-home');
        expect(byTestId('thing-refused')).toBeNull();
        expect(market.resumed).toEqual([]);
        let back = await keptThing('t-1');
        expect([back?.postId, back?.pausedPostId, back?.lentTo]).toEqual(['post-1', undefined, undefined]);
        expect(text('thing-state')).toBe('In your shop');
        expect(byTestId('thing-offer-paused')).toBeNull();
        expect(byTestId('thing-take-out')).not.toBeNull();

        // Ended or deleted while it was away: it is back on the shelf, and says so.
        market.rows.delete('post-1');
        await keep(shed(lentThing()));
        act(() => root.unmount());
        root = createRoot(host);
        await open('thing', { key: 't-1' });
        await click('thing-back-home');
        expect(byTestId('thing-refused')).toBeNull();
        back = await keptThing('t-1');
        expect([back?.postId, back?.pausedPostId, back?.lentTo]).toEqual([undefined, undefined, undefined]);
        expect(text('thing-state')).toBe('On your shelf');
        expect(text('thing-gone-note')).toBe('Its Offer has gone from the Market, so it is back on your shelf. List it again to make a new one.');

        // Paused, as Lend left it: resumed, and the screen says it is in the shop, never that its Offer is paused.
        offer('post-1', 'Ladder', 'paused');
        await keep(shed(lentThing()));
        act(() => root.unmount());
        root = createRoot(host);
        await open('thing', { key: 't-1' });
        await click('thing-back-home');
        expect(market.resumed).toEqual(['post-1']);
        expect(text('thing-state')).toBe('In your shop');
        expect(byTestId('thing-offer-paused')).toBeNull();
        expect(byTestId('thing-take-out')).not.toBeNull();
    });

    it("It's back when the community's server can't be reached: it is home, and taken out of the shop, as it is", async () => {
        offer('post-1', 'Ladder', 'paused');
        await keep(shed(thing('t-1', 'Ladder', { postId: 'post-1', lentTo: { name: 'Sam', since: iso(NOW - DAY) } })));
        await open('thing', { key: 't-1' });
        market.down = true;
        await click('thing-back-home');
        const back = await keptThing('t-1');
        expect([back?.postId, back?.pausedPostId, back?.lentTo]).toEqual([undefined, 'post-1', undefined]);
        expect(text('thing-state')).toBe('Taken out of your shop');
    });

    it("when the community's server can't be reached, take out and lend change nothing and say so", async () => {
        offer('post-1', 'Ladder');
        await keep(shed(thing('t-1', 'Ladder', { postId: 'post-1' })));
        await open('thing', { key: 't-1' });
        market.down = true;
        await click('thing-take-out');
        expect(text('thing-refused')).toBe("Couldn't reach your community's server, so nothing changed. Try again when you're online.");
        await click('thing-lend');
        await type('thing-lend-name', 'Sam');
        await click('thing-lend-save');
        expect(text('thing-refused')).toBe("Couldn't reach your community's server, so nothing changed. Try again when you're online.");
        expect(await keptThing('t-1')).toEqual(thing('t-1', 'Ladder', { postId: 'post-1' }));
    });

    it("delete: asked first; its Offer is taken out of the Market and its photo file goes; then back", async () => {
        offer('post-1', 'Drill');
        await keep(shed(thing('t-1', 'Drill', { postId: 'post-1' })));
        await open('edit', { key: 't-1' });
        await click('edit-photo-pick');
        await click('edit-save');
        const file = toolPhotoUri(communityKey('https://mullum.example'), ME.publicKey, 'things', 'photo-1').replace(/^file:\/\//, '');
        expect(fs.existsSync(file)).toBe(true);
        act(() => root.unmount());
        root = createRoot(host);
        nav.backs = 0;
        await open('thing', { key: 't-1' });
        await click('thing-delete');
        expect(text('thing-delete-ask')).toBe('Delete Drill from your Tool shed? Its photo and notes go too.');
        await click('thing-delete-no');
        expect(byTestId('thing-delete-ask')).toBeNull();
        await click('thing-delete');
        await click('thing-delete-yes');
        expect(market.paused).toEqual(['post-1']);
        expect(fs.existsSync(file)).toBe(false);
        expect(shedThings(await kept())).toEqual([]);
        expect(readThingsDoc(await kept()).things[0]).toMatchObject({ id: 't-1', gone: true });
        expect(nav.backs).toBe(1);
    });

    it("a Delete that lands after the member went back goes back no further: one Back, the member's own", async () => {
        offer('post-1', 'Drill');
        await keep(shed(thing('t-1', 'Drill', { postId: 'post-1' }), thing('t-2', 'Ladder')));
        await open('thing', { key: 't-1' });
        let answer = () => {};
        market.marketGate = new Promise<void>((r) => { answer = r; });
        await click('thing-delete');
        await click('thing-delete-yes');
        expect(market.marketAsks).toEqual(['pause post-1']);
        // The header's ← while the pause is still asked: the stack takes the screen away before the Delete lands.
        await click('tool-back');
        expect(nav.backs).toBe(1);
        act(() => root.unmount());
        root = createRoot(host);
        answer();
        await settle();
        expect(readThingsDoc(await kept()).things.find((t) => (t as Thing).id === 't-1')).toMatchObject({ gone: true });
        expect(nav.backs).toBe(1);
    });

    it("an Offer already paused or gone from the Market is left as it is: lend and delete still do what they say", async () => {
        offer('post-1', 'Ladder', 'paused');
        await keep(shed(thing('t-1', 'Ladder', { postId: 'post-1' }), thing('t-2', 'Drill', { postId: 'post-9' })));
        await open('thing', { key: 't-1' });
        expect(text('thing-offer-paused')).toContain('Its Offer is paused in the Market.');
        await click('thing-lend');
        await type('thing-lend-name', 'Sam');
        await click('thing-lend-save');
        expect(byTestId('thing-refused')).toBeNull();
        expect((await keptThing('t-1'))?.lentTo?.name).toBe('Sam');
        expect(market.rows.get('post-1')?.status).toBe('paused');

        act(() => root.unmount());
        root = createRoot(host);
        await open('thing', { key: 't-2' });
        expect(text('thing-offer-gone')).toContain('Its Offer has gone from the Market.');
        await click('thing-delete');
        await click('thing-delete-yes');
        expect(byTestId('thing-refused')).toBeNull();
        expect(readThingsDoc(await kept()).things.find((t) => (t as Thing).id === 't-2')).toMatchObject({ gone: true });
        expect(nav.backs).toBe(1);
        expect(market.paused).toEqual([]);
        // The paused one's pause is still asked, as its owner's: one a shop closed for now paused would otherwise come back
        // with the reopen. The gone one asks nothing.
        expect(market.marketAsks).toEqual(['pause post-1']);
    });

    it("an Offer paused elsewhere after the screen opened: Take out reads it first, so the thing is taken out, never \"couldn't reach\"", async () => {
        offer('post-1', 'Ladder');
        await keep(shed(thing('t-1', 'Ladder', { postId: 'post-1' })));
        await open('thing', { key: 't-1' });
        market.rows.get('post-1')!.status = 'paused';
        await click('thing-take-out');
        expect(byTestId('thing-refused')).toBeNull();
        expect(market.paused).toEqual([]);
        expect(market.marketAsks).toEqual(['pause post-1']);
        expect(await keptThing('t-1')).toMatchObject({ pausedPostId: 'post-1' });
        expect(text('thing-state')).toContain('Taken out of your shop');
    });

    it("with the shop closed for now: Take out, Lend and Delete each ask the owner's pause, so the reopen leaves those Offers down and puts back the rest", async () => {
        offer('post-1', 'Drill');
        offer('post-2', 'Ladder');
        offer('post-3', 'Tent');
        offer('post-4', 'Hammer');
        await keep(shed(...['Drill', 'Ladder', 'Tent', 'Hammer'].map((name, i) => thing(`t-${i + 1}`, name, { postId: `post-${i + 1}` }))));
        // Take out on a screen opened while the shop was open; it closed meanwhile.
        await open('thing', { key: 't-3' });
        closeShop('post-1', 'post-2', 'post-3', 'post-4');
        await click('thing-take-out');
        expect(byTestId('thing-refused')).toBeNull();
        expect(await keptThing('t-3')).toMatchObject({ pausedPostId: 'post-3' });

        // Lend on a screen opened while it is closed: its Offer reads paused.
        act(() => root.unmount());
        root = createRoot(host);
        await open('thing', { key: 't-2' });
        expect(text('thing-offer-paused')).toContain('Its Offer is paused in the Market.');
        await click('thing-lend');
        await type('thing-lend-name', 'Sam');
        await click('thing-lend-save');
        expect(byTestId('thing-refused')).toBeNull();
        expect((await keptThing('t-2'))?.lentTo?.name).toBe('Sam');

        act(() => root.unmount());
        root = createRoot(host);
        nav.backs = 0;
        await open('thing', { key: 't-1' });
        await click('thing-delete');
        await click('thing-delete-yes');
        expect(byTestId('thing-refused')).toBeNull();
        expect(nav.backs).toBe(1);

        expect(market.marketAsks).toEqual(['pause post-3', 'pause post-2', 'pause post-1']);
        expect([...market.shopHeld]).toEqual(['post-4']);
        reopenShop();
        expect(['post-1', 'post-2', 'post-3', 'post-4'].map((id) => market.rows.get(id)?.status)).toEqual(['paused', 'paused', 'paused', 'active']);
    });

    it("with the shop closed for now, a thing taken out by linking it to the Offer the shop paused: Lend and Delete ask the owner's pause too, so the reopen leaves those Offers down", async () => {
        offer('post-1', 'Drill');
        offer('post-2', 'Ladder');
        offer('post-3', 'Hammer');
        await keep(shed(thing('t-1', 'Drill'), thing('t-2', 'Ladder')));
        closeShop('post-1', 'post-2', 'post-3');
        // Linked while the shop is closed: its Offer reads paused, so the thing is taken out of the shop, and only its
        // pausedPostId names the Offer.
        await open('thing', { key: 't-1' });
        await click('thing-link');
        await click('thing-link-post-1');
        expect(text('thing-state')).toContain('Taken out of your shop');
        await click('thing-lend');
        await type('thing-lend-name', 'Sam');
        await click('thing-lend-save');
        expect(byTestId('thing-refused')).toBeNull();
        expect(await keptThing('t-1')).toMatchObject({ pausedPostId: 'post-1', lentTo: { name: 'Sam' } });

        act(() => root.unmount());
        root = createRoot(host);
        nav.backs = 0;
        await open('thing', { key: 't-2' });
        await click('thing-link');
        await click('thing-link-post-2');
        expect(text('thing-state')).toContain('Taken out of your shop');
        await click('thing-delete');
        await click('thing-delete-yes');
        expect(byTestId('thing-refused')).toBeNull();
        expect(readThingsDoc(await kept()).things.find((t) => (t as Thing).id === 't-2')).toMatchObject({ gone: true });
        expect(nav.backs).toBe(1);

        expect(market.marketAsks).toEqual(['pause post-1', 'pause post-2']);
        expect([...market.shopHeld]).toEqual(['post-3']);
        reopenShop();
        expect(['post-1', 'post-2', 'post-3'].map((id) => market.rows.get(id)?.status)).toEqual(['paused', 'paused', 'active']);
    });

    it("Put back while the shop is closed for now says so in the Tool shed's words, never \"couldn't reach\", and changes nothing", async () => {
        const closed = "Your shop is closed for now, so this can't go back in it yet. Reopen your shop first.";
        offer('post-1', 'Drill');
        offer('post-2', 'Tent', 'paused');
        const drill = thing('t-1', 'Drill', { postId: 'post-1' });
        const tent = thing('t-2', 'Tent', { pausedPostId: 'post-2' });
        await keep(shed(drill, tent));
        closeShop('post-1', 'post-2');
        // In the shop, its Offer paused by the closing: the paused section's Put back.
        await open('thing', { key: 't-1' });
        await click('thing-resume');
        expect(text('thing-refused')).toBe(closed);
        expect(byTestId('thing-offer-paused')).not.toBeNull();
        // Taken out: Put back.
        act(() => root.unmount());
        root = createRoot(host);
        await open('thing', { key: 't-2' });
        await click('thing-put-back');
        expect(text('thing-refused')).toBe(closed);
        expect(text('thing-state')).toContain('Taken out of your shop');
        expect([market.resumed, market.rows.get('post-1')?.status, market.rows.get('post-2')?.status]).toEqual([[], 'paused', 'paused']);
        expect(readThingsDoc(await kept()).things).toEqual([drill, tent]);
    });

    it("the phone asks the server how its Offer stands, not its own row: a shop's pause the row doesn't know yet is read, and Delete's pause is taken", async () => {
        offer('post-1', 'Drill');
        await keep(shed(thing('t-1', 'Drill', { postId: 'post-1' })));
        closeShop('post-1');
        // The phone's row is from before the closing: the next sync would bring the pause.
        market.phoneRows.set('post-1', { ...market.rows.get('post-1'), status: 'active' });
        await open('thing', { key: 't-1' });
        expect(market.postReads).toContain('/api/marketplace/posts?id=post-1');
        expect(text('thing-offer-paused')).toContain('Its Offer is paused in the Market.');
        expect(byTestId('thing-take-out')).toBeNull();
        nav.backs = 0;
        await click('thing-delete');
        await click('thing-delete-yes');
        expect(byTestId('thing-refused')).toBeNull();
        expect(nav.backs).toBe(1);
        expect(market.marketAsks).toEqual(['pause post-1']);
        reopenShop();
        expect(market.rows.get('post-1')?.status).toBe('paused');
    });

    /**
     * The open's sync takes the server's newer copy while `press` waits for the Market's answer: the phone holds `ladder`,
     * synced; the server's copy (`copy`) is newer, by default with Drill too (added in the member's browser). Its read is
     * held until the pause or resume is asked, and that answer until the copy is taken (`meanwhile` runs before either is
     * let go). Then what the phone keeps, and what the next sync sends the server.
     */
    async function takenMeanwhile(ladder: Thing, press: () => Promise<void>, copy = shed(ladder, thing('t-2', 'Drill')), meanwhile = () => {}) {
        await keep(shed(ladder));
        await disk.db.runAsync('UPDATE tool_docs SET synced_at = updated_at');
        let copyAnswers = () => {};
        let marketAnswers = () => {};
        market.copy = { doc: copy, updatedAt: iso(NOW - DAY / 2) };
        market.copyGate = new Promise((r) => { copyAnswers = r; });
        market.marketGate = new Promise((r) => { marketAnswers = r; });
        market.marketAsks.length = 0;
        await open('thing', { key: 't-1' });
        await press();
        expect(market.marketAsks).toEqual([expect.stringMatching(/^(pause|resume) post-1$/)]);
        meanwhile();
        copyAnswers();
        await settle();
        expect(await kept()).toEqual(readThingsDoc(copy));
        marketAnswers();
        await settle();
        const here = await kept();
        const sync = await openToolCopy({ manifest: THINGS, owner: { kind: 'member', publicKey: ME.publicKey }, url: 'https://mullum.example' });
        return { here, sync, sent: market.puts.at(-1) as ThingsDoc | undefined };
    }
    /** The things in a document, in its order, by name. */
    const names = (d: ThingsDoc | undefined) => (d ? readThingsDoc(d).things.map((t) => (t as Thing).name) : null);

    it("Take out while the open's sync takes the server's newer copy: the other device's thing is kept, here and on the server", async () => {
        offer('post-1', 'Ladder');
        const after = await takenMeanwhile(thing('t-1', 'Ladder', { postId: 'post-1' }), () => click('thing-take-out'));
        expect(market.paused).toEqual(['post-1']);
        expect([names(after.here), after.sync, names(after.sent)]).toEqual([['Ladder', 'Drill'], 'put', ['Ladder', 'Drill']]);
        expect(after.here.things[0]).toMatchObject({ id: 't-1', pausedPostId: 'post-1' });
        expect(after.here.things[1]).toEqual(thing('t-2', 'Drill'));
        expect(byTestId('thing-refused')).toBeNull();
        expect(text('thing-state')).toContain('Taken out of your shop');
    });

    it("Lend while the open's sync takes the server's newer copy: the other device's thing is kept, here and on the server", async () => {
        offer('post-1', 'Ladder');
        const after = await takenMeanwhile(thing('t-1', 'Ladder', { postId: 'post-1' }), async () => {
            await click('thing-lend');
            await type('thing-lend-name', 'Sam');
            await click('thing-lend-save');
        });
        expect(market.paused).toEqual(['post-1']);
        expect([names(after.here), after.sync, names(after.sent)]).toEqual([['Ladder', 'Drill'], 'put', ['Ladder', 'Drill']]);
        expect(after.here.things[0]).toMatchObject({ id: 't-1', postId: 'post-1', lentTo: { name: 'Sam' } });
        expect(after.here.things[1]).toEqual(thing('t-2', 'Drill'));
        expect(byTestId('thing-lend-name')).toBeNull();
        expect(text('thing-state')).toMatch(/^With Sam since /);
    });

    it("It's back while the open's sync takes the server's newer copy: the other device's thing is kept, here and on the server", async () => {
        offer('post-1', 'Ladder', 'paused');
        const after = await takenMeanwhile(thing('t-1', 'Ladder', { postId: 'post-1', lentTo: { name: 'Sam', since: iso(NOW - DAY) } }), () => click('thing-back-home'));
        expect(market.resumed).toEqual(['post-1']);
        expect([names(after.here), after.sync, names(after.sent)]).toEqual([['Ladder', 'Drill'], 'put', ['Ladder', 'Drill']]);
        expect(after.here.things[0]).toMatchObject({ id: 't-1', postId: 'post-1' });
        expect((after.here.things[0] as Thing).lentTo).toBeUndefined();
        expect(after.here.things[1]).toEqual(thing('t-2', 'Drill'));
        expect(text('thing-state')).toContain('In your shop');
    });

    /** A shed with `first` in it and things to fill it, `room` bytes under the store's bound. */
    function shedWithRoom(first: Thing, room: number): ThingsDoc {
        const target = TOOL_LIMITS.docBytes - room;
        const big = (i: number) => thing(`f-${i}`, 'n'.repeat(80), { lendTerms: 't'.repeat(300), ownerNote: 'o'.repeat(500), replacementValue: 'r'.repeat(40) });
        const small = (i: number) => thing(`f-${i}`, 'n'.repeat(80));
        // The last thing's note: a letter more is a byte more, so it takes up all that is left but `room`.
        const last = (k: number) => thing('f-last', 'Odds and ends', { ownerNote: 'o'.repeat(1 + k) });
        const fill: Thing[] = [];
        while (toolDocBytes(shed(first, ...fill, big(fill.length), last(0))) <= target) fill.push(big(fill.length));
        while (toolDocBytes(shed(first, ...fill, small(fill.length), last(0))) <= target) fill.push(small(fill.length));
        const doc = shed(first, ...fill, last(target - toolDocBytes(shed(first, ...fill, last(0)))));
        expect(toolDocBytes(doc)).toBe(target);
        return doc;
    }
    const FULL = 'Your Tool shed is full: it keeps up to 64 KB. Delete something you no longer have, or shorten some notes.';

    it("at the store's bound, lend, take out and link say the shed is full before the server is asked anything; nothing changes", async () => {
        offer('post-1', 'Ladder');
        const listed = thing('t-1', 'Ladder', { postId: 'post-1' });
        // Lent to Sam, back in a week: more than the 40 bytes left.
        const full = shedWithRoom(listed, 40);
        expect(toolDocBytes(lendOutside(full, 't-1', 'Sam', backAroundIn(NOW, 7), NOW))).toBeGreaterThan(TOOL_LIMITS.docBytes);
        await keep(full);
        const before = await kept();
        expect(toolDocBytes(before)).toBe(TOOL_LIMITS.docBytes - 40);
        await open('thing', { key: 't-1' });
        const asked = market.requests.length;
        await click('thing-lend');
        await type('thing-lend-name', 'Sam');
        await click('thing-lend-back-7');
        await click('thing-lend-save');
        expect([market.paused, market.rows.get('post-1')?.status, market.requests.slice(asked)]).toEqual([[], 'active', []]);
        expect(await kept()).toEqual(before);
        expect(text('thing-refused')).toBe(FULL);
        expect(text('thing-state')).toContain('In your shop');

        // Taken out, its Offer's id is kept as pausedPostId: 6 bytes more than the 3 left.
        act(() => root.unmount());
        root = createRoot(host);
        await keep(shedWithRoom(listed, 3));
        const before2 = await kept();
        await open('thing', { key: 't-1' });
        await click('thing-take-out');
        expect([market.paused, market.rows.get('post-1')?.status]).toEqual([[], 'active']);
        expect(await kept()).toEqual(before2);
        expect(text('thing-refused')).toBe(FULL);

        // Linked (no server step): its Offer's id is more than the 10 bytes left, and the shed is said to be full.
        act(() => root.unmount());
        root = createRoot(host);
        await keep(shedWithRoom(thing('t-1', 'Ladder'), 10));
        const before3 = await kept();
        await open('thing', { key: 't-1' });
        await click('thing-link');
        await click('thing-link-post-1');
        expect(text('thing-refused')).toBe(FULL);
        expect(await kept()).toEqual(before3);
    });

    it("a change that no longer fits once the open has taken the server's fuller copy: the shed is said to be full, nothing is written, and the Offer is put back as it was", async () => {
        offer('post-1', 'Ladder');
        const ladder = thing('t-1', 'Ladder', { postId: 'post-1' });
        // Filled on the member's other device, 3 bytes under the bound: taken out, the Offer's id is kept as pausedPostId,
        // 6 bytes more. What is here fits it easily, so Take out asks the Market.
        const full = shedWithRoom(ladder, 3);
        let after = await takenMeanwhile(ladder, () => click('thing-take-out'), full);
        expect([market.paused, market.resumed, market.rows.get('post-1')?.status]).toEqual([['post-1'], ['post-1'], 'active']);
        expect(after.here).toEqual(readThingsDoc(full));
        expect([after.sync, after.sent]).toEqual(['nothing', undefined]);
        expect(text('thing-refused')).toBe(FULL);
        expect(text('thing-state')).toContain('In your shop');
        expect(byTestId('thing-offer-paused')).toBeNull();

        // The Market can't be reached to put it back: the screen says its Offer is paused, with Put back, which resumes it.
        act(() => root.unmount());
        root = createRoot(host);
        market.rows.clear();
        market.paused.length = 0;
        market.resumed.length = 0;
        offer('post-1', 'Ladder');
        after = await takenMeanwhile(ladder, () => click('thing-take-out'), full, () => { market.down = true; });
        expect([market.paused, market.resumed, market.rows.get('post-1')?.status]).toEqual([['post-1'], [], 'paused']);
        expect(after.here).toEqual(readThingsDoc(full));
        expect(text('thing-refused')).toBe(FULL);
        expect(text('thing-state')).toContain('In your shop');
        expect(text('thing-offer-paused')).toContain('Its Offer is paused in the Market.');
        market.down = false;
        await click('thing-resume');
        expect([market.resumed, market.rows.get('post-1')?.status]).toEqual([['post-1'], 'active']);
        expect(byTestId('thing-offer-paused')).toBeNull();
        expect(await kept()).toEqual(readThingsDoc(full));
    });

    it("a change the phone couldn't keep says so in its own words, never that the shed is full", async () => {
        offer('post-1', 'Ladder');
        await keep(shed(thing('t-1', 'Ladder')));
        await open('thing', { key: 't-1' });
        await click('thing-link');
        const run = disk.db.runAsync;
        disk.db.runAsync = async (sql: string, params?: unknown[]) => {
            if (sql.includes('INSERT INTO tool_docs')) throw new Error('database or disk is full');
            return run(sql, params);
        };
        await click('thing-link-post-1');
        disk.db.runAsync = run;
        expect(text('thing-refused')).toBe("Couldn't save it on this phone. Try again.");
        expect((await keptThing('t-1'))?.postId).toBeUndefined();
        // Not linked, so the Offers to link stay open to try again.
        expect(byTestId('thing-link-post-1')).not.toBeNull();
    });

    it("List it again that the phone couldn't keep says so, and opens no List sheet over a thing still linked to the gone Offer", async () => {
        await keep(shed(thing('t-1', 'Cordless drill', { postId: 'post-9' })));
        await open('thing', { key: 't-1' });
        const run = disk.db.runAsync;
        disk.db.runAsync = async (sql: string, params?: unknown[]) => {
            if (sql.includes('INSERT INTO tool_docs')) throw new Error('database or disk is full');
            return run(sql, params);
        };
        await click('thing-relist');
        disk.db.runAsync = run;
        expect(text('thing-refused')).toBe("Couldn't save it on this phone. Try again.");
        expect(byTestId('tool-list-sheet')).toBeNull();
        expect((await keptThing('t-1'))?.postId).toBe('post-9');

        await click('thing-relist');
        expect(byTestId('thing-refused')).toBeNull();
        expect(byTestId('tool-list-sheet')).not.toBeNull();
        expect((await keptThing('t-1'))?.postId).toBeUndefined();
    });

    it("keep: past the bound it never asks the host; the host's own size refusal is the shed full; anything else is not kept", async () => {
        const set = vi.fn(async (_next: ThingsDoc) => {});
        const over = shedWithRoom(thing('t-1', 'Ladder'), 0);
        const setting = (s: typeof set) => ({ doc: { get: () => over, set: s } }) as unknown as Parameters<typeof keepThings>[0];
        expect(await keepThings(setting(set), lendOutside(over, 't-1', 'Sam', null, NOW))).toBe('too-big');
        expect(set).not.toHaveBeenCalled();
        expect(await keepThings(setting(set), shed(thing('t-1', 'Ladder')))).toBeNull();
        expect(await keepThings(setting(vi.fn(async () => { throw new ToolDocTooBigError(70_000, 65_536); })), shed())).toBe('too-big');
        expect(await keepThings(setting(vi.fn(async () => { throw new Error('database or disk is full'); })), shed())).toBe('not-kept');
    });

    it("in the shop: until its deals are known, nothing that would pause its Offer or delete it; deals that can't be read say so", async () => {
        let release!: () => void;
        market.dealsGate = new Promise<void>((r) => { release = r; });
        offer('post-1', 'Drill');
        await keep(shed(thing('t-1', 'Drill', { postId: 'post-1' })));
        await open('thing', { key: 't-1' });
        expect(['thing-take-out', 'thing-lend', 'thing-delete'].map((id) => byTestId(id))).toEqual([null, null, null]);
        expect(byTestId('thing-edit')).not.toBeNull();
        release();
        await settle();
        expect(['thing-take-out', 'thing-lend', 'thing-delete'].filter((id) => byTestId(id) === null)).toEqual([]);
        expect(byTestId('thing-unchecked')).toBeNull();

        act(() => root.unmount());
        root = createRoot(host);
        market.dealsGate = null;
        market.dealsUnread = true;
        await open('thing', { key: 't-1' });
        expect(['thing-take-out', 'thing-lend', 'thing-delete'].map((id) => byTestId(id))).toEqual([null, null, null]);
        expect(text('thing-unchecked')).toBe("Loans through BeanPool couldn't be checked just now.");
        expect(byTestId('thing-edit')).not.toBeNull();
    });

    it("out on a BeanPool loan: the deal's words, and no delete", async () => {
        offer('post-1', 'Drill', 'pending', { lendable: 1, price_type: 'fixed', accepted_at: iso(NOW - DAY) });
        market.deals.push({ id: 'tx1', postId: 'post-1', sellerPublicKey: ME.publicKey, buyerPublicKey: 'b', status: 'pending', hours: 3, createdAt: iso(NOW - 2 * DAY) });
        await keep(shed(thing('t-1', 'Drill', { postId: 'post-1' })));
        await open('thing', { key: 't-1' });
        expect(text('thing-state')).toMatch(/Out on a loan · back around /);
        expect(text('thing-deal-note')).toBe('It is out on a loan through BeanPool. The borrower confirms it is back in the deal.');
        expect(byTestId('thing-delete')).toBeNull();
        expect(byTestId('thing-take-out')).toBeNull();
    });

    it('a loan still out is out, however many deals are done before it in the list', async () => {
        for (let i = 1; i <= 250; i++) market.deals.push({ id: `done-${i}`, postId: `old-${i}`, sellerPublicKey: ME.publicKey, buyerPublicKey: 'c', status: 'completed', createdAt: iso(NOW - DAY) });
        offer('post-1', 'Drill', 'pending', { lendable: 1, price_type: 'fixed', accepted_at: iso(NOW - DAY) });
        market.deals.push({ id: 'tx-out', postId: 'post-1', sellerPublicKey: ME.publicKey, buyerPublicKey: 'b', status: 'pending', hours: 3, createdAt: iso(NOW - 30 * DAY) });
        await keep(shed(thing('t-1', 'Drill', { postId: 'post-1' })));
        await open('thing', { key: 't-1' });
        expect(text('thing-state')).toMatch(/^Out on a loan · back around /);
        expect(byTestId('thing-delete')).toBeNull();
        // Past the node's first page: the loan is the 251st, newest first.
        expect(market.dealReads.some((r) => new URL(r, 'https://mullum.example').searchParams.get('offset') === '200')).toBe(true);
    });

    it("a thing's deals are the community server's, never the phone's own table: a phone just set up, a row the sync left behind", async () => {
        // A phone just set up: its table holds none of the deals, and a loan is out.
        offer('post-1', 'Drill', 'pending', { lendable: 1, price_type: 'fixed', accepted_at: iso(NOW - DAY) });
        market.deals.push({ id: 'tx-out', postId: 'post-1', sellerPublicKey: ME.publicKey, buyerPublicKey: 'b', status: 'pending', hours: 3, createdAt: iso(NOW - 30 * DAY) });
        // A loan confirmed back on the server that the phone's table still holds as out.
        offer('post-2', 'Ladder');
        market.deals.push({ id: 'tx-back', postId: 'post-2', sellerPublicKey: ME.publicKey, buyerPublicKey: 'c', status: 'completed', createdAt: iso(NOW - 40 * DAY) });
        market.phoneDeals.push({ id: 'tx-back', postId: 'post-2', sellerPublicKey: ME.publicKey, buyerPublicKey: 'c', status: 'pending', createdAt: iso(NOW - 40 * DAY) });
        await keep(shed(thing('t-1', 'Drill', { postId: 'post-1' }), thing('t-2', 'Ladder', { postId: 'post-2' })));

        await open('thing', { key: 't-1' });
        expect(text('thing-state')).toMatch(/^Out on a loan · back around /);
        expect(['thing-take-out', 'thing-lend', 'thing-delete'].map((id) => byTestId(id))).toEqual([null, null, null]);

        act(() => root.unmount());
        root = createRoot(host);
        await open('thing', { key: 't-2' });
        expect(text('thing-state')).toContain('In your shop');
        expect(['thing-take-out', 'thing-lend', 'thing-delete'].filter((id) => byTestId(id) === null)).toEqual([]);

        // Asked of the server, the member's own, a whole page at a time.
        expect(market.dealReads.length).toBeGreaterThan(0);
        for (const read of market.dealReads) {
            const url = new URL(read, 'https://mullum.example');
            expect(url.pathname).toBe('/api/marketplace/transactions');
            expect(url.searchParams.get('publicKey')).toBe(ME.publicKey);
            expect(url.searchParams.get('limit')).toBe('200');
        }
    });

    it("a phone that can't reach its community's server says its loans couldn't be checked, never that nothing is out", async () => {
        offer('post-1', 'Drill');
        market.phoneDeals.push({ id: 'tx-old', postId: 'post-1', sellerPublicKey: ME.publicKey, buyerPublicKey: 'b', status: 'completed', createdAt: iso(NOW - DAY) });
        await keep(shed(thing('t-1', 'Drill', { postId: 'post-1' })));
        market.down = true;
        await open('thing', { key: 't-1' });
        expect(['thing-take-out', 'thing-lend', 'thing-delete'].map((id) => byTestId(id))).toEqual([null, null, null]);
        expect(text('thing-unchecked')).toBe("Loans through BeanPool couldn't be checked just now.");

        act(() => root.unmount());
        root = createRoot(host);
        await open('loans');
        expect(text('loans-unchecked')).toBe("Loans through BeanPool couldn't be checked just now.");
        expect(byTestId('loans-none')).toBeNull();
    });

    it("the community's price guide: a hint where Beans are on, none where they are off; never a price set", async () => {
        const guide = { items: [{ id: 'th-002', category: 'tools', emoji: '🪜', name: 'Extension Ladder Hire (6m / Day)', description: '', priceBeans: 12, unit: 'day' }] };
        vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(guide), { status: 200 })));
        await keep(shed(thing('t-1', 'Step ladder')));
        await open('thing', { key: 't-1' });
        expect(text('thing-hint')).toBe("Your community's price guide says about 12 Beans a day for something like this. Free is fine too.");
        node.avatar = 'https://mullum.example/a.jpg';
        await click('thing-list');
        await click('tool-list-go');
        expect(JSON.parse(store.map.get(OFFER_DRAFT_KEY) ?? '{}').postCredits).toBe('0');

        act(() => root.unmount());
        root = createRoot(host);
        node.profile = { profile: 'global', features: { beans: false } };
        await open('thing', { key: 't-1' });
        expect(byTestId('thing-hint')).toBeNull();
    });

    it('a thing that is not there (an old link, a deleted thing): said, never a crash', async () => {
        await keep(shed(thing('t-1', 'Drill', { gone: true })));
        await open('thing', { key: 't-1' });
        expect(text('thing-missing')).toContain('This thing is no longer in your Tool shed.');
    });
});

describe('Loans', () => {
    it('lent outside and through BeanPool, overdue first; each opens its thing', async () => {
        offer('post-1', 'Drill', 'pending', { lendable: 1, price_type: 'fixed', accepted_at: iso(NOW - DAY) });
        market.deals.push({ id: 'tx1', postId: 'post-1', sellerPublicKey: ME.publicKey, buyerPublicKey: 'b', status: 'pending', hours: 5, createdAt: iso(NOW - 2 * DAY) });
        offer('post-2', 'Tent');
        market.deals.push({ id: 'tx2', postId: 'post-2', sellerPublicKey: ME.publicKey, buyerPublicKey: 'c', status: 'requested', createdAt: iso(NOW - DAY) });
        await keep(shed(
            thing('t-1', 'Drill', { postId: 'post-1' }),
            thing('t-2', 'Ladder', { lentTo: { name: 'Sam', since: iso(NOW - 9 * DAY), backAround: iso(NOW - 2 * DAY) } }),
            thing('t-3', 'Tent', { postId: 'post-2' }),
            thing('t-4', 'Saw'),
        ));
        await open('loans');
        expect(all('[data-testid^="loan-row-"]').map((r) => r.getAttribute('data-testid'))).toEqual(['loan-row-t-2', 'loan-row-t-1', 'loan-row-t-3']);
        expect(byTestId('loan-row-t-2')?.getAttribute('aria-label')).toBe('Ladder, Overdue · with Sam');
        expect(byTestId('loans-outside')).not.toBeNull();
        expect(byTestId('loans-beanpool')).not.toBeNull();
        expect(byTestId('loans-asked')).not.toBeNull();
        await click('loan-row-t-1');
        expect(nav.pushed.at(-1)).toEqual({ pathname: '/tool/[id]', params: { key: 't-1', id: 'things', screen: 'thing' } });
    });

    it('nothing out says so', async () => {
        await keep(shed(thing('t-1', 'Saw')));
        await open('loans');
        expect(text('loans-none')).toContain('Nothing of yours is out or asked for right now.');
    });

    it("deals that couldn't be read are said, never shown as nothing out", async () => {
        market.dealsUnread = true;
        await keep(shed(thing('t-1', 'Saw')));
        await open('loans');
        expect(text('loans-unchecked')).toBe("Loans through BeanPool couldn't be checked just now.");
        expect(byTestId('loans-none')).toBeNull();
    });
});
