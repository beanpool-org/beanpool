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
import { act, createElement } from 'react';
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
    return {
        Platform: { OS: 'android', select: (o: Record<string, unknown>) => o.android ?? o.default },
        View: el('div'), Text: el('span'), Pressable: el('button'), ScrollView: el('div'), TextInput: el('input'), Switch: el('button'), ActivityIndicator: el('div'), Image: el('img'),
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
vi.mock('react-native-keyboard-controller', () => ({ useKeyboardState: (pick: (s: { height: number; isVisible: boolean }) => unknown) => pick({ height: 0, isVisible: false }) }));
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
/** The member's Offers and deals as the phone holds them; `down` when the community's server can't be reached. */
const market = vi.hoisted(() => ({
    rows: new Map<string, Record<string, unknown>>(),
    deals: [] as Array<Record<string, unknown>>,
    paused: [] as string[], resumed: [] as string[], down: false,
    requests: [] as string[],
}));
vi.mock('../../../utils/db', () => ({
    getDb: async () => disk.db,
    getMemberProfile: async () => ({ avatar_url: node.avatar }),
    getPost: async (id: string) => market.rows.get(id) ?? null,
    getMyPosts: async (pubkey: string) => [...market.rows.values()].filter((p) => p.author_pubkey === pubkey),
    getMarketplaceTransactions: async (pubkey: string) => market.deals.filter((d) => d.sellerPublicKey === pubkey || d.buyerPublicKey === pubkey),
    pausePost: async (id: string) => {
        if (market.down) throw new TypeError('Network request failed');
        market.paused.push(id);
        const p = market.rows.get(id);
        if (p) p.status = 'paused';
    },
    resumePost: async (id: string) => {
        if (market.down) throw new TypeError('Network request failed');
        market.resumed.push(id);
        const p = market.rows.get(id);
        if (p) p.status = 'active';
    },
    // The node copy (the Tool shed asks for node-copy): a server that keeps copies and has none of this one yet.
    signedGet: async (p: string) => {
        market.requests.push(`GET ${p}`);
        if (market.down) throw new TypeError('Network request failed');
        return { status: 200, json: async () => ({ tool: 'things', doc: null, updatedAt: null }) };
    },
    signedRequestWithMethod: async (method: string, p: string) => {
        market.requests.push(`${method} ${p}`);
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
    THINGS, THINGS_MAX_ITEMS, TOOL_LIMITS, readThingsDoc, setLanguage, shedThings, toolDocBytes, type Thing, type ThingsDoc,
} from '@beanpool/core';
// The Tool shed's fixtures are never shipped: from core's sources, as the template's generic tests read them.
import { FIXTURES as SOURCE_FIXTURES } from '../../../../../packages/beanpool-core/src/tools/things/fixtures';

/** The same documents, typed as the app's build of core types them. */
const FIXTURES = SOURCE_FIXTURES as unknown as { docs: { empty: ThingsDoc; small: ThingsDoc; full: ThingsDoc }; now: number };
import { TOOL_APPS } from '../../index';
import { TOOL_DOCS_TABLE } from '../../schema';
import { readToolDoc, writeToolDoc } from '../../store';
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
    market.deals.length = 0;
    market.paused.length = 0;
    market.resumed.length = 0;
    market.requests.length = 0;
    market.down = false;
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

    it(`a ${THINGS_MAX_ITEMS + 1}st thing is refused in one sentence, and so is a save past the store's bound; nothing is written`, async () => {
        const many = Array.from({ length: THINGS_MAX_ITEMS }, (_, i) => thing(`t-${i}`, `Thing ${i}`));
        await keep(shed(...many));
        await open('edit');
        await type('edit-name', 'One more');
        await click('edit-save');
        expect(text('edit-problem')).toBe('Your Tool shed holds 100 things. Take one out first.');
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
        expect(text('edit-problem')).toBe('Your Tool shed is full: it keeps up to 64 KB. Take out something you no longer have, or shorten some notes.');
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
        expect(market.requests.filter((r) => !r.endsWith('/api/tools/things'))).toEqual([]);
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
});
