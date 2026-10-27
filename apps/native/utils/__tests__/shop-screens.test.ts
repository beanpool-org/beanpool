// @vitest-environment jsdom
/**
 * The phone's shop screens (slice S4′ of scratch/tools/DESIGN-tool-template-fable.md §6; DESIGN-shops-and-tools-fable.md
 * §8 and §12 row S4's checks minus the tool's; Marty's additions of 19 Oct 2026), drawn for real at the floor: 320 dp
 * with 1.3× text, in the pseudo-locale (`xx`: every sentence bracketed, padded ~35 %), in light and in dark, against a
 * node that keeps one member's shop as the real routes do (apps/server routes/shops.ts, their real shapes).
 *
 *   - Your shop (app/shop/mine.tsx): none yet, and Open my shop; open, its name (the member's own words, as written, or
 *     "<their name>'s shop"), kind, counts and the four fields, each one edited on its own; what is in it, and "Add my
 *     live Offers"; Close for now (with a back-on day, or none) and Reopen; Close my shop, its Offers kept on their own
 *     by default or ended when asked; a refusal (open deals) in the node's words with the way to the deals; no answer,
 *     and a node from before shops, each said
 *   - the List sheet's "Put this in your shop": on by default where the member has a shop or none yet (it opens with
 *     the Offer), never offered while the shop is closed for now or can't be read; its choice is what the composer gets
 *   - the Offer edit screen's toggle (components/shop/ShopToggle.tsx, the same component): its start from the node, and
 *     what an edit sends (an id in, null out, nothing when unchanged; a shop opened first when there was none)
 *   - Home's "Your shop and tools" body: none yet, open, closed for now; each line one target into its screen
 *
 * Every fixed word goes through t() (no letters outside a bracket but what members and the node wrote), every word fits
 * a card's inside at 320 dp × 1.3, every target is at least 44 dp, and no colour is written outside the central tokens.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
vi.hoisted(() => {
    const Loader = (process as any).getBuiltinModule('node:module');
    Loader._extensions['.jpg'] = (m: { exports: unknown }) => { m.exports = 1; };
    Loader._extensions['.png'] = (m: { exports: unknown }) => { m.exports = 1; };
});
import * as fs from 'node:fs';
import * as path from 'node:path';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';

(globalThis as any).__DEV__ = false;
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const SCREEN = 320;
const FONT_SCALE = 1.3;
const alerts = vi.hoisted(() => ({ said: [] as string[], buttons: [] as Array<{ text?: string; onPress?: () => void }> }));

vi.mock('expo', () => ({
    requireNativeModule: vi.fn(() => ({})),
    requireOptionalNativeModule: vi.fn(() => null),
}));

vi.mock('expo-modules-core', () => ({
    requireNativeModule: vi.fn(() => ({})),
    requireOptionalNativeModule: vi.fn(() => null),
    EventEmitter: vi.fn(() => ({ addListener: vi.fn(), removeListener: vi.fn() })),
    NativeModulesProxy: {},
    ProxyNativeModule: {},
}));

vi.mock('expo-image', () => ({
    Image: ({ source, testID, ...rest }: any) => createElement('img', { src: source?.uri ?? source, 'data-testid': testID, ...rest }),
}));

vi.mock('react-native', () => {
    const roles: Record<string, string> = { header: 'heading', button: 'button', link: 'link', radio: 'radio', radiogroup: 'radiogroup', checkbox: 'checkbox' };
    const flat = (style: unknown): Record<string, any> => Object.assign({}, ...[style].flat(4).filter((x) => x && typeof x === 'object'));
    const el = (tag: string) => function Host(props: Record<string, any>) {
        const { children, onPress, accessibilityLabel, accessibilityRole, accessibilityState, testID, placeholder, numberOfLines, value, onChangeText, disabled, maxLength } = props;
        const attrs: Record<string, unknown> = {};
        if (testID) attrs['data-testid'] = testID;
        if (onPress && !disabled) attrs.onClick = (e: { stopPropagation(): void }) => { e.stopPropagation(); onPress({ stopPropagation() {} }); };
        if (onChangeText) { attrs.onChange = (e: { target: { value: string } }) => onChangeText(e.target.value); attrs.value = value ?? ''; }
        if (accessibilityLabel) attrs['aria-label'] = accessibilityLabel;
        if (accessibilityRole && roles[accessibilityRole]) attrs.role = roles[accessibilityRole];
        if (accessibilityState?.checked !== undefined) attrs['aria-checked'] = String(!!accessibilityState.checked);
        if (accessibilityState?.selected !== undefined) attrs['aria-selected'] = String(!!accessibilityState.selected);
        if (disabled || accessibilityState?.disabled) attrs['aria-disabled'] = 'true';
        if (placeholder) attrs.placeholder = placeholder;
        if (maxLength) attrs['data-max'] = String(maxLength);
        if (numberOfLines) attrs['data-lines'] = String(numberOfLines);
        const s = flat(typeof props.style === 'function' ? props.style({ pressed: false }) : props.style);
        if (typeof s.fontSize === 'number') attrs['data-font'] = String(s.fontSize);
        if (typeof s.minHeight === 'number') attrs['data-min-height'] = String(s.minHeight);
        if (typeof s.height === 'number') attrs['data-height'] = String(s.height);
        for (const k of ['color', 'backgroundColor', 'borderColor']) if (typeof s[k] === 'string') attrs[`data-${k.toLowerCase()}`] = s[k];
        return createElement(tag, attrs, typeof children === 'function' ? children({ pressed: false }) : children);
    };
    return {
        Platform: { OS: 'android', select: (o: Record<string, unknown>) => o.android ?? o.default },
        View: el('div'), Text: el('span'), Pressable: el('button'), ScrollView: el('div'), TextInput: el('input'), ActivityIndicator: el('div'), Image: el('img'),
        PanResponder: { create: () => ({ panHandlers: {} }) },
        Modal: ({ visible, children }: { visible: boolean; children?: unknown }) => (visible ? createElement('div', { 'data-modal': 'true' }, children as any) : null),
        StyleSheet: { create: (s: unknown) => s, hairlineWidth: 1, absoluteFill: {}, absoluteFillObject: {}, flatten: (s: unknown) => flat(s) },
        Alert: { alert: (title: string, body?: string, buttons?: Array<{ text?: string; onPress?: () => void }>) => { alerts.said.push(title); if (body) alerts.said.push(body); alerts.buttons = buttons ?? []; } },
        AccessibilityInfo: { announceForAccessibility: () => {} },
        useWindowDimensions: () => ({ width: SCREEN, height: 569, scale: 1.5, fontScale: FONT_SCALE }),
        Dimensions: { get: () => ({ width: SCREEN, height: 569, scale: 1.5, fontScale: FONT_SCALE }) },
        I18nManager: { isRTL: false, allowRTL: () => {}, forceRTL: () => {} },
    };
});
const nav = vi.hoisted(() => ({ pushed: [] as unknown[], navigated: [] as unknown[], backs: 0 }));
vi.mock('expo-router', async () => {
    const { useEffect: effect } = await import('react');
    return {
        router: {
            push: (r: unknown) => { nav.pushed.push(r); }, navigate: (r: unknown) => { nav.navigated.push(r); }, replace: () => {},
            back: () => { nav.backs++; }, canGoBack: () => true,
        },
        useFocusEffect: (cb: () => void | (() => void)) => effect(() => cb(), [cb]),
        useLocalSearchParams: () => ({}),
    };
});
const store = vi.hoisted(() => ({ map: new Map<string, string>() }));
vi.mock('@react-native-async-storage/async-storage', () => ({
    default: {
        getItem: async (k: string) => store.map.get(k) ?? null,
        setItem: async (k: string, v: string) => { store.map.set(k, v); },
        removeItem: async (k: string) => { store.map.delete(k); },
    },
}));
vi.mock('@expo/vector-icons', () => ({ MaterialCommunityIcons: ({ name }: { name: string }) => createElement('i', { 'data-icon': name }) }));
vi.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ top: 24, bottom: 0, left: 0, right: 0 }) }));
vi.mock('react-native-keyboard-controller', () => ({ useKeyboardState: (pick: (s: { height: number; isVisible: boolean }) => unknown) => pick({ height: 0, isVisible: false }) }));
vi.mock('expo-image-picker', () => ({ launchImageLibraryAsync: vi.fn(), launchCameraAsync: vi.fn(), requestCameraPermissionsAsync: vi.fn() }));
vi.mock('expo-image-manipulator', () => ({ manipulateAsync: vi.fn(), SaveFormat: { JPEG: 'jpeg' } }));
vi.mock('expo-crypto', () => ({ randomUUID: () => 'photo-ref' }));
// The banner's picker: the photo the member chose, already the phone's 800 px copy; or none; or one it can't read. `real`:
// its own code, from the picker through the crop step (components/PictureCrop.tsx) to the image tools.
const bannerPick = vi.hoisted(() => ({ next: 'data:image/jpeg;base64,/9j/BBBB' as string | null | Error, real: false }));
vi.mock('../banner-photo', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../banner-photo')>();
    return {
        ...actual,
        pickBannerPhoto: async (...args: Parameters<typeof actual.pickBannerPhoto>) => {
            if (bannerPick.real) return actual.pickBannerPhoto(...args);
            if (bannerPick.next instanceof Error) throw bannerPick.next;
            return bannerPick.next;
        },
    };
});
vi.mock('expo-file-system/legacy', () => ({ documentDirectory: '/tmp/doc/', getInfoAsync: vi.fn(async () => ({ exists: false })), readAsStringAsync: vi.fn(), deleteAsync: vi.fn(), makeDirectoryAsync: vi.fn(), copyAsync: vi.fn(), moveAsync: vi.fn() }));
const theme = vi.hoisted(() => ({ dark: false }));
vi.mock('../../app/ThemeContext', async () => {
    const { lightColors, darkColors } = await import('../../constants/colors');
    const pick = () => (theme.dark ? { theme: 'dark', colors: darkColors } : { theme: 'light', colors: lightColors });
    return { useTheme: () => pick(), useStyles: (make: (t: unknown) => unknown) => make(pick()) };
});
const ME = { publicKey: 'me-key', callsign: 'Ana' };
vi.mock('../../app/IdentityContext', () => ({ useIdentity: () => ({ identity: ME }) }));

// ── the node: one member's shop, as routes/shops.ts keeps and answers it ─────────────────────────
type Listing = { id: string; title: string; type: string; status: string; shopId?: string; lendable?: boolean; audienceScope?: string; originNode?: string };
const node = vi.hoisted(() => ({
    /** `stall`: a write is taken and never answered (a captive portal, a stalled 2G line); only its signal lets it go. */
    mode: 'up' as 'up' | 'down' | 'older' | 'stall',
    shop: null as null | Record<string, any>,
    listings: [] as Listing[],
    log: [] as Array<{ method: string; path: string; body?: any }>,
    refuse: null as null | { status: number; code?: string; error: string; unsaid?: boolean },
}));
const COUNTS0 = { things: 0, available: 0, toBorrow: 0, toBuy: 0, out: 0, newThisWeek: 0 };
function shopAnswer() {
    const s = node.shop!;
    const live = node.listings.filter((l) => l.shopId === s.id && (l.status === 'active' || l.status === 'pending'));
    return { ...s, counts: { ...COUNTS0, things: live.length, available: live.filter((l) => l.status === 'active').length, out: live.filter((l) => l.status === 'pending' && l.lendable).length } };
}
vi.mock('../db', () => ({
    getMemberProfile: async () => null,
    signedGet: async (p: string) => {
        node.log.push({ method: 'GET', path: p });
        if (node.mode === 'down') throw new TypeError('Network request failed');
        if (node.mode === 'older') return { ok: false, status: 404, json: async () => null };
        const ok = (json: unknown) => ({ ok: true, status: 200, json: async () => json });
        if (p === '/api/shops/mine') return ok({ shop: node.shop ? shopAnswer() : null });
        const q = new URLSearchParams(p.split('?')[1] ?? '');
        if (p.startsWith('/api/marketplace/posts')) {
            if (q.get('id')) return ok(node.listings.filter((l) => l.id === q.get('id')));
            if (q.get('shop')) return ok(node.listings.filter((l) => l.shopId === q.get('shop')));
            return ok(node.listings.filter((l) => l.type === 'offer'));
        }
        return { ok: false, status: 404, json: async () => null };
    },
    signedRequestWithMethod: async (method: string, p: string, body: any, opts?: { signal?: AbortSignal }) => {
        node.log.push({ method, path: p, body });
        if (node.mode === 'down') throw new TypeError('Network request failed');
        if (node.mode === 'stall') return new Promise<never>((_, reject) => opts?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError'))));
        if (node.refuse) { const r = node.refuse; node.refuse = null; throw Object.assign(new Error(r.error), { status: r.status }, r.code ? { code: r.code } : {}, r.unsaid ? { unsaid: true } : {}); }
        if (method === 'PUT' && p === '/api/shops/mine') {
            if (!node.shop) node.shop = { id: 'shop-1', name: null, ownerName: ME.callsign, kind: null, blurb: null, howToDeal: null, paused: false, backOn: null };
            const s = node.shop;
            for (const k of ['name', 'kind', 'blurb', 'howToDeal'] as const) if (body[k] !== undefined) s[k] = typeof body[k] === 'string' && !body[k].trim() ? null : body[k];
            // Its banner: the node keeps the photo and answers its keyed address (engine/shops.ts memberShop photoUrl).
            if (body.photo !== undefined) (s as Record<string, unknown>).photoUrl = body.photo ? `/api/shops/${s.id}/photo?v=ab12cd34&k=KEY` : null;
            const moved: string[] = [];
            if (body.paused === true && !s.paused) { s.paused = true; for (const l of node.listings) if (l.shopId === s.id && l.status === 'active') { l.status = 'paused'; moved.push(l.id); } }
            if (body.paused === false && s.paused) { s.paused = false; s.backOn = null; for (const l of node.listings) if (l.shopId === s.id && l.status === 'paused') { l.status = 'active'; moved.push(l.id); } }
            if (body.backOn !== undefined) s.backOn = body.backOn;
            return { success: true, shop: shopAnswer(), paused: body.paused === true ? moved : [], resumed: body.paused === false ? moved : [] };
        }
        if (method === 'POST' && p === '/api/shops/mine/close') {
            const named = node.listings.filter((l) => l.shopId === node.shop?.id);
            const ended = body.endOffers ? named.filter((l) => l.status === 'active' || l.status === 'paused') : [];
            for (const l of ended) l.status = 'cancelled';
            for (const l of named) { delete l.shopId; if (l.status === 'paused') l.status = 'active'; }
            node.shop = null;
            return { success: true, shopId: 'shop-1', cleared: named.length, ended: ended.length, resumed: 0 };
        }
        if (method === 'POST' && p === '/api/shops/mine/offers') {
            for (const l of node.listings) if (body.postIds.includes(l.id)) l.shopId = node.shop!.id;
            return { success: true, added: body.postIds };
        }
        throw Object.assign(new Error('Not found'), { status: 404 });
    },
}));

import { setLanguage, t, type ToolOfferDraft } from '@beanpool/core';
import { lightColors, darkColors, type AppColors } from '../../constants/colors';
import YourShopScreen from '../../app/shop/mine';
import { ShopToggle, shopToggleState, shopIdForEdit } from '../../components/shop/ShopToggle';
import { ShopHomeBody } from '../../components/shop/ShopHomeBody';
import { ToolListSheet } from '../../tools/list-sheet';
import { readMyShop } from '../shop';
import { SHOP_CHOICE_KEY, SHOP_COMPOSER_WAIT_MS, shopChoiceFor } from '../shop-choice';
import { openNeedComposer, openOfferComposer } from '../../tools/doors';
import * as FileSystem from 'expo-file-system/legacy';

// ── drawing and what it checks ───────────────────────────────────────────────────────────────────
let host: HTMLDivElement;
let root: Root;
/** What members and the node wrote (shop names, titles, the node's refusals): shown as written, so taken out of the checks. */
let OTHERS: string[] = [];

beforeEach(() => {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    store.map.clear();
    store.map.set('beanpool_anchor_url', 'https://mullum.example');
    nav.pushed.length = 0; nav.navigated.length = 0; nav.backs = 0;
    alerts.said.length = 0;
    alerts.buttons = [];
    theme.dark = false;
    node.mode = 'up';
    node.shop = null;
    node.listings = [];
    node.log.length = 0;
    node.refuse = null;
    OTHERS = [ME.callsign];
});
afterEach(() => { act(() => root.unmount()); host.remove(); setLanguage('en'); });

const settle = async (n = 10) => { for (let i = 0; i < n; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); };
async function draw(el: unknown, lang: 'xx' | 'en' = 'xx') {
    setLanguage(lang);
    await act(async () => { root.render(el as any); });
    await settle();
}
const byTestId = (id: string) => host.querySelector(`[data-testid="${id}"]`) as HTMLElement | null;
const click = async (id: string) => {
    const el = byTestId(id);
    expect(el, id).not.toBeNull();
    expect(el!.getAttribute('aria-disabled'), `${id} is not disabled`).not.toBe('true');
    await act(async () => { el!.click(); });
    await settle(6);
};
async function type(id: string, value: string) {
    const el = byTestId(id) as HTMLInputElement | null;
    expect(el, id).not.toBeNull();
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    await act(async () => { setter.call(el, value); el!.dispatchEvent(new Event('input', { bubbles: true })); });
    await settle(2);
}

function outsideBrackets(text: string | null | undefined): boolean {
    if (!text) return false;
    let rest = text;
    for (const o of [...OTHERS].sort((a, b) => b.length - a.length)) rest = rest.split(o).join('');
    for (let was = ''; was !== rest;) { was = rest; rest = rest.replace(/\[[^[\]]*\]/g, ''); }
    return /\p{L}/u.test(rest);
}
/** Every drawn text, label, placeholder and alert that bypassed t(). */
function bypassing(): string[] {
    const out = new Set<string>();
    const walker = document.createTreeWalker(host, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
        const whole = n.parentElement?.textContent ?? n.nodeValue;
        if (outsideBrackets(whole)) out.add(`text: ${JSON.stringify(whole)}`);
    }
    for (const e of Array.from(host.querySelectorAll('[aria-label],[placeholder]'))) {
        for (const v of [e.getAttribute('aria-label'), e.getAttribute('placeholder')]) if (outsideBrackets(v)) out.add(`label: ${JSON.stringify(v)}`);
    }
    for (const said of alerts.said) if (outsideBrackets(said)) out.add(`alert: ${JSON.stringify(said)}`);
    return [...out];
}
/** home-layout-320.test.ts's width model: 0.62 em a letter, 1.25 em an emoji, at 1.3× text. */
function textWidth(text: string, fontSize: number): number {
    const px = fontSize * FONT_SCALE;
    return [...text].reduce((w, ch) => w + (/\p{Extended_Pictographic}/u.test(ch) ? 1.25 : 0.62) * px, 0);
}
const CARD_INNER = SCREEN - 2 * 16 - 2 * 14 - 2 * 1;
function tooWide(): string[] {
    const out: string[] = [];
    for (const span of Array.from(host.querySelectorAll('span'))) {
        let text = Array.from(span.childNodes).filter((c) => c.nodeType === 3).map((c) => c.nodeValue).join('');
        for (const o of OTHERS) text = text.split(o).join(' ');
        const font = Number(span.getAttribute('data-font') ?? 15);
        for (const w of text.split(/[\s\u200b]+/u).filter(Boolean)) if (textWidth(w, font) >= CARD_INNER) out.push(`${w} (${Math.round(textWidth(w, font))} dp)`);
    }
    return out;
}
/** Every target (a button, a radio, a checkbox) shorter than 44 dp. */
function smallTargets(): string[] {
    return Array.from(host.querySelectorAll('button')).filter((b) => {
        const h = Number(b.getAttribute('data-min-height') ?? b.getAttribute('data-height') ?? 0);
        return h < 44;
    }).map((b) => b.getAttribute('data-testid') ?? b.getAttribute('aria-label') ?? b.textContent ?? '?');
}
/** Every colour drawn: each must be one of the theme's tokens. */
function coloursOutsideTokens(colors: Record<string, unknown>): string[] {
    const tokens = new Set<string>();
    const walk = (o: unknown) => { if (typeof o === 'string') tokens.add(o); else if (o && typeof o === 'object') Object.values(o).forEach(walk); };
    walk(colors);
    const out = new Set<string>();
    for (const e of Array.from(host.querySelectorAll('[data-color],[data-backgroundcolor],[data-bordercolor]'))) {
        for (const k of ['data-color', 'data-backgroundcolor', 'data-bordercolor']) {
            const v = e.getAttribute(k);
            if (v && !tokens.has(v) && v !== 'transparent' && !/^rgba\(0,\s*0,\s*0,/.test(v)) out.add(`${e.getAttribute('data-testid') ?? e.tagName}: ${v}`);
        }
    }
    return [...out];
}
/** The floor's checks, all at once: words through t(), nothing too wide, every target 44 dp, colours from the tokens. */
function atTheFloor(colors: Record<string, unknown> = lightColors) {
    expect(bypassing()).toEqual([]);
    expect(tooWide()).toEqual([]);
    expect(smallTargets()).toEqual([]);
    expect(coloursOutsideTokens(colors)).toEqual([]);
}
const text = () => host.textContent ?? '';

const DAVE_SHOP = { id: 'shop-1', name: "Ana's Tool Shed", ownerName: ME.callsign, category: 'tools', blurb: 'Drills and ladders.', howToDeal: 'Front gate, back in a week.', paused: false, backOn: null };
function aShopWithThings() {
    node.shop = { ...DAVE_SHOP };
    node.listings = [
        { id: 'p-drill', title: 'Cordless drill', type: 'offer', status: 'active', shopId: 'shop-1', lendable: true },
        { id: 'p-ladder', title: 'Ladder', type: 'offer', status: 'pending', shopId: 'shop-1', lendable: true },
        { id: 'p-couch', title: 'Old couch', type: 'offer', status: 'active' },
        { id: 'p-saw', title: 'Hand saw', type: 'offer', status: 'active' },
        { id: 'p-group', title: 'For the garden group', type: 'offer', status: 'active', audienceScope: 'group' },
    ];
    OTHERS = [ME.callsign, DAVE_SHOP.name, DAVE_SHOP.blurb, DAVE_SHOP.howToDeal, 'Cordless drill', 'Ladder', 'Old couch', 'Hand saw', 'For the garden group'];
}

// ── Your shop ────────────────────────────────────────────────────────────────────────────────────

describe('Your shop (app/shop/mine.tsx)', () => {
    it('none yet: what a shop is, and Open my shop; a tap opens it, named for its owner until they name it', async () => {
        await draw(createElement(YourShopScreen));
        expect(byTestId('shop-none')).not.toBeNull();
        atTheFloor();
        await click('shop-open');
        expect(node.log.filter((r) => r.method === 'PUT')).toEqual([{ method: 'PUT', path: '/api/shops/mine', body: {} }]);
        expect(byTestId('shop-title')?.textContent).toMatch(/Ana/);
        expect(byTestId('shop-none')).toBeNull();
        atTheFloor();
    });

    it('open, in light and in dark: its name as written, kind, counts, the four fields, what is in it, and the way to the tools', async () => {
        for (const dark of [false, true]) {
            aShopWithThings();
            theme.dark = dark;
            await draw(createElement(YourShopScreen));
            expect(byTestId('shop-title')?.textContent).toBe("Ana's Tool Shed");
            expect(byTestId('shop-category-line')?.textContent).toContain('🛠️');
            expect(byTestId('shop-state')).not.toBeNull();
            for (const f of ['name', 'category', 'blurb', 'howToDeal']) expect(byTestId(`shop-field-${f}`), f).not.toBeNull();
            expect(byTestId('shop-listing-p-drill')).not.toBeNull();
            expect(byTestId('shop-listing-p-ladder')).not.toBeNull();
            expect(byTestId('shop-listing-p-couch')).toBeNull();
            expect(byTestId('shop-tools')).not.toBeNull();
            atTheFloor(dark ? darkColors : lightColors);
            await click('shop-tools');
            expect(nav.pushed.at(-1)).toBe('/tools');
            // Its shopfront as members see it (S5).
            await click('shop-see-front');
            expect(nav.pushed.at(-1)).toEqual({ pathname: '/shop/[id]', params: { id: 'shop-1' } });
            act(() => root.unmount());
            root = createRoot(host);
        }
    });

    it('its banner photo: chosen, it goes on its own as the 800 px copy; Remove takes it down; one unread says so', async () => {
        aShopWithThings();
        bannerPick.next = 'data:image/jpeg;base64,/9j/BBBB';
        await draw(createElement(YourShopScreen));
        expect(byTestId('shop-field-banner')).not.toBeNull();
        expect(byTestId('shop-banner-remove')).toBeNull();
        await click('shop-field-banner');
        expect(node.log.filter((r) => r.method === 'PUT')).toEqual([{ method: 'PUT', path: '/api/shops/mine', body: { photo: 'data:image/jpeg;base64,/9j/BBBB' } }]);
        expect(byTestId('shop-banner-remove')).not.toBeNull();
        atTheFloor();
        await click('shop-banner-remove');
        expect(node.log.filter((r) => r.method === 'PUT').at(-1)).toEqual({ method: 'PUT', path: '/api/shops/mine', body: { photo: null } });
        expect(byTestId('shop-banner-remove')).toBeNull();
        const puts = node.log.filter((r) => r.method === 'PUT').length;
        bannerPick.next = null;
        await click('shop-field-banner');
        bannerPick.next = new Error('could not decode');
        await click('shop-field-banner');
        expect(node.log.filter((r) => r.method === 'PUT').length).toBe(puts);
        expect(byTestId('shop-banner-error')).not.toBeNull();
        bannerPick.next = 'data:image/jpeg;base64,/9j/BBBB';
    });

    it('its banner photo goes through the crop step at 3:1, at the floor in light and dark; the strip chosen is what goes; Cancel sends nothing', async () => {
        const ImagePicker = await import('expo-image-picker');
        const ImageManipulator = await import('expo-image-manipulator');
        vi.mocked(ImagePicker.launchImageLibraryAsync).mockResolvedValue({ canceled: false, assets: [{ uri: 'file:///DCIM/IMG_0001.jpg', width: 4000, height: 3000 }] } as any);
        vi.mocked(ImageManipulator.manipulateAsync).mockImplementation(async (_uri: string, actions: any[] = []) => (actions.some((a) => a.crop)
            ? { uri: 'file:///cut.jpg', width: 800, height: 267, base64: 'Q1VU' }
            : { uri: 'file:///working.jpg', width: 1600, height: 1200 }) as any);
        bannerPick.real = true;
        try {
            for (const dark of [false, true]) {
                aShopWithThings();
                theme.dark = dark;
                node.log.length = 0;
                await draw(createElement(YourShopScreen));
                await click('shop-field-banner');
                expect(alerts.buttons.map(b => b.text)).toEqual([t('Gallery'), t('Browse files'), t('Cancel')]);
                const gallery = alerts.buttons.find(b => b.text === t('Gallery'));
                await act(async () => { await gallery?.onPress?.(); });
                await settle(6);
                expect(vi.mocked(ImagePicker.launchImageLibraryAsync).mock.calls.at(-1)?.[0]).toMatchObject({ defaultTab: 'albums' });
                expect(vi.mocked(ImagePicker.launchImageLibraryAsync).mock.calls.at(-1)?.[0]).not.toMatchObject({ allowsEditing: true });
                expect(byTestId('picture-crop')).not.toBeNull();
                // The crop screen at 320 dp and 1.3× text, in the pseudo-locale: every word through t(), none too wide, every
                // target 44 dp, every colour a token of the theme it is drawn in.
                atTheFloor(dark ? darkColors : lightColors);
                expect(node.log.filter((r) => r.method === 'PUT')).toEqual([]);
                await click('picture-crop-cancel');
                expect(byTestId('picture-crop')).toBeNull();
                expect(node.log.filter((r) => r.method === 'PUT')).toEqual([]);
                await click('shop-field-banner');
                const gallery2 = alerts.buttons.find(b => b.text === t('Gallery'));
                await act(async () => { await gallery2?.onPress?.(); });
                await settle(6);
                await click('picture-crop-done');
                expect(vi.mocked(ImageManipulator.manipulateAsync).mock.calls.at(-1)).toEqual([
                    'file:///working.jpg',
                    [{ crop: { originX: 0, originY: 333, width: 1600, height: 533 } }, { resize: { width: 800, height: 267 } }],
                    { compress: 0.7, format: 'jpeg', base64: true },
                ]);
                expect(node.log.filter((r) => r.method === 'PUT')).toEqual([{ method: 'PUT', path: '/api/shops/mine', body: { photo: 'data:image/jpeg;base64,Q1VU' } }]);
                act(() => root.unmount());
                root = createRoot(host);
            }
        } finally {
            bannerPick.real = false;
        }
    });

    it('in English: "<name>\'s shop" for a shop with no name of its own, and the counts in words', async () => {
        aShopWithThings();
        node.shop!.name = null;
        await draw(createElement(YourShopScreen), 'en');
        expect(byTestId('shop-title')?.textContent).toBe("Ana's shop");
        expect(byTestId('shop-state')?.textContent).toBe('2 things · 1 out');
        expect(byTestId('shop-category-line')?.textContent).toBe('🛠️ Tools');
    });

    it("each field on its own: the name, emptied to clear it; a category picked from the Market's, or none", async () => {
        aShopWithThings();
        await draw(createElement(YourShopScreen));
        await click('shop-field-name');
        expect(byTestId('shop-text-sheet')).not.toBeNull();
        expect(byTestId('shop-text-input')?.getAttribute('data-max')).toBe('60');
        atTheFloor();
        OTHERS.push('Ana Fixes Things');
        await type('shop-text-input', 'Ana Fixes Things');
        await click('shop-text-save');
        expect(node.log.filter((r) => r.method === 'PUT').at(-1)?.body).toEqual({ name: 'Ana Fixes Things' });
        expect(byTestId('shop-text-sheet')).toBeNull();
        expect(byTestId('shop-title')?.textContent).toBe('Ana Fixes Things');
        await click('shop-field-name');
        await type('shop-text-input', '   ');
        await click('shop-text-save');
        expect(node.log.filter((r) => r.method === 'PUT').at(-1)?.body).toEqual({ name: null });
        await click('shop-field-howToDeal');
        expect(byTestId('shop-text-input')?.getAttribute('data-max')).toBe('300');
        await click('shop-text-cancel');
        await click('shop-field-category');
        expect(byTestId('shop-category-sheet')).not.toBeNull();
        // The Market's seventeen, as its listings show them, and None.
        expect(host.querySelectorAll('[data-testid^="shop-category-pick-"]').length).toBe(18);
        expect(byTestId('shop-category-pick-tech')?.textContent).toContain('💻');
        atTheFloor();
        await click('shop-category-pick-tech');
        expect(node.log.filter((r) => r.method === 'PUT').at(-1)?.body).toEqual({ category: 'tech' });
        await click('shop-field-category');
        await click('shop-category-pick-none');
        expect(node.log.filter((r) => r.method === 'PUT').at(-1)?.body).toEqual({ category: null });
    });

    it('a field the node refuses: its sentence in the sheet, and the sheet stays', async () => {
        aShopWithThings();
        await draw(createElement(YourShopScreen));
        await click('shop-field-blurb');
        const said = "What a shop is can be at most 300 characters.";
        OTHERS.push(said);
        node.refuse = { status: 400, code: 'shop_text_refused', error: said };
        await type('shop-text-input', 'Something');
        await click('shop-text-save');
        expect(byTestId('shop-text-sheet')).not.toBeNull();
        expect(byTestId('shop-text-error')?.textContent).toBe(said);
    });

    it("an answer with no words of the node's own (a proxy's 502 page): our sentence, never \"Request failed: 502\"", async () => {
        aShopWithThings();
        await draw(createElement(YourShopScreen));
        await click('shop-field-blurb');
        // utils/db.ts signedRequestWithMethod's error for a body without the node's words, withStatus.
        node.refuse = { status: 502, error: 'Request failed: 502', unsaid: true };
        await type('shop-text-input', 'Something');
        await click('shop-text-save');
        expect(byTestId('shop-text-sheet')).not.toBeNull();
        expect(byTestId('shop-text-error')?.textContent).toBe(t("Your community couldn't be reached. Try again."));
        expect(text()).not.toContain('Request failed');
        atTheFloor();
    });

    it('"Add my live Offers": the member\'s own live Offers for everyone that are not in it yet, ticked and put in together', async () => {
        aShopWithThings();
        await draw(createElement(YourShopScreen));
        await click('shop-add-offers');
        expect(byTestId('shop-add-sheet')).not.toBeNull();
        expect(byTestId('shop-add-p-couch')).not.toBeNull();
        expect(byTestId('shop-add-p-saw')).not.toBeNull();
        expect(byTestId('shop-add-p-group')).toBeNull();
        expect(byTestId('shop-add-p-drill')).toBeNull();
        expect(byTestId('shop-add-go')?.getAttribute('aria-disabled')).toBe('true');
        atTheFloor();
        await click('shop-add-p-couch');
        await click('shop-add-p-saw');
        await click('shop-add-go');
        expect(node.log.filter((r) => r.path === '/api/shops/mine/offers').map((r) => r.body)).toEqual([{ postIds: ['p-couch', 'p-saw'] }]);
        expect(byTestId('shop-add-sheet')).toBeNull();
        expect(byTestId('shop-listing-p-couch')).not.toBeNull();
    });

    it('Close for now, back on a day: its Offers come off; it says so, and one tap reopens it', async () => {
        aShopWithThings();
        await draw(createElement(YourShopScreen));
        await click('shop-pause');
        expect(byTestId('shop-pause-sheet')).not.toBeNull();
        atTheFloor();
        await click('shop-back-week');
        await click('shop-pause-go');
        const put = node.log.filter((r) => r.method === 'PUT').at(-1);
        expect(put?.body.paused).toBe(true);
        expect(put?.body.backOn).toMatch(/^\d{4}-\d{2}-\d{2}$/);
        expect(byTestId('shop-paused')).not.toBeNull();
        expect(byTestId('shop-pause')).toBeNull();
        expect(byTestId('shop-add-offers')?.getAttribute('aria-disabled')).toBe('true');
        atTheFloor();
        await click('shop-reopen');
        expect(node.log.filter((r) => r.method === 'PUT').at(-1)?.body).toEqual({ paused: false });
        expect(byTestId('shop-paused')).toBeNull();
    });

    it('Close for now with no day said sends none', async () => {
        aShopWithThings();
        await draw(createElement(YourShopScreen));
        await click('shop-pause');
        await click('shop-pause-go');
        expect(node.log.filter((r) => r.method === 'PUT').at(-1)?.body).toEqual({ paused: true });
    });

    it("refused while a deal is open: the node's sentence, the way to the deals, and nothing changed", async () => {
        aShopWithThings();
        await draw(createElement(YourShopScreen));
        const said = "Finish or cancel the 1 open deal on this shop's things first.";
        OTHERS.push(said);
        await click('shop-pause');
        node.refuse = { status: 409, code: 'shop_deals_open', error: said };
        await click('shop-pause-go');
        expect(byTestId('shop-pause-error')?.textContent).toBe(said);
        atTheFloor();
        await click('shop-pause-deals');
        expect(nav.pushed.at(-1)).toEqual({ pathname: '/(tabs)/market', params: { tab: 'deals' } });
        expect(node.shop?.paused).toBe(false);
    });

    it('Close my shop: its Offers stay on their own by default; asked, they end; then it is gone and says so', async () => {
        for (const end of [false, true]) {
            aShopWithThings();
            await draw(createElement(YourShopScreen));
            await click('shop-close');
            expect(byTestId('shop-close-sheet')).not.toBeNull();
            expect(byTestId('shop-close-keep')?.getAttribute('aria-checked')).toBe('true');
            atTheFloor();
            if (end) await click('shop-close-end');
            await click('shop-close-go');
            expect(node.log.filter((r) => r.path === '/api/shops/mine/close').at(-1)?.body).toEqual({ endOffers: end });
            expect(byTestId('shop-none')).not.toBeNull();
            expect(byTestId(end ? 'shop-closed-ended' : 'shop-closed-kept')).not.toBeNull();
            atTheFloor();
            act(() => root.unmount());
            root = createRoot(host);
            node.log.length = 0;
        }
    });

    it('no answer, and a node from before shops: each said, and nothing is offered that would fail', async () => {
        node.mode = 'down';
        await draw(createElement(YourShopScreen));
        expect(byTestId('shop-offline')).not.toBeNull();
        expect(byTestId('shop-open')).toBeNull();
        atTheFloor();
        node.mode = 'up';
        await click('shop-retry');
        expect(byTestId('shop-none')).not.toBeNull();
        act(() => root.unmount());
        root = createRoot(host);
        node.mode = 'older';
        await draw(createElement(YourShopScreen));
        expect(byTestId('shop-older')).not.toBeNull();
        expect(byTestId('shop-open')).toBeNull();
        atTheFloor();
    });
});

// ── the List sheet and the edit toggle ───────────────────────────────────────────────────────────

describe('"Put this in your shop"', () => {
    const DRAFT: ToolOfferDraft = { title: 'Cordless drill', description: 'Barely used.' };
    const sheet = (shop: ReturnType<typeof shopToggleState>, onList = vi.fn(), draft: ToolOfferDraft = DRAFT) => createElement(ToolListSheet, {
        draft, beans: true, needsProfilePhoto: false, unfinishedPost: false, colors: lightColors, shop, onList, onClose: () => {},
    } as any);

    it('the state from the member\'s shop: open, none yet, closed for now, or nothing to offer', async () => {
        node.shop = { ...DAVE_SHOP };
        expect(shopToggleState(await readMyShop())).toEqual({ kind: 'open', shopId: 'shop-1', title: "Ana's Tool Shed", inShop: false, category: 'tools' });
        expect(shopToggleState(await readMyShop(), { inShop: true })).toMatchObject({ kind: 'open', inShop: true });
        node.shop.paused = true;
        expect(shopToggleState(await readMyShop())).toMatchObject({ kind: 'paused', shopId: 'shop-1', inShop: false });
        node.shop = null;
        expect(shopToggleState(await readMyShop())).toEqual({ kind: 'none' });
        node.mode = 'older';
        expect(shopToggleState(await readMyShop())).toEqual({ kind: 'hidden' });
        node.mode = 'down';
        expect(shopToggleState(await readMyShop())).toEqual({ kind: 'hidden' });
        expect(shopToggleState(null)).toEqual({ kind: 'hidden' });
    });

    it('the List sheet: on by default with a shop, and with none yet (it opens with the Offer); off when the member turns it off', async () => {
        OTHERS = ['Cordless drill', "Ana's Tool Shed"];
        const onList = vi.fn();
        await draw(sheet({ kind: 'open', shopId: 'shop-1', title: "Ana's Tool Shed", inShop: false }, onList));
        expect(byTestId('tool-list-shop')?.getAttribute('aria-checked')).toBe('true');
        expect(byTestId('tool-list-shop')?.textContent).toContain("Ana's Tool Shed");
        atTheFloor();
        await click('tool-list-go');
        expect(onList).toHaveBeenLastCalledWith({ kind: 'free', beans: 0 }, true);
        await click('tool-list-shop');
        expect(byTestId('tool-list-shop')?.getAttribute('aria-checked')).toBe('false');
        await click('tool-list-go');
        expect(onList).toHaveBeenLastCalledWith({ kind: 'free', beans: 0 }, false);
        act(() => root.unmount());
        root = createRoot(host);
        await draw(sheet({ kind: 'none' }, onList));
        expect(byTestId('tool-list-shop')?.getAttribute('aria-checked')).toBe('true');
        expect(byTestId('tool-list-shop-opens')).not.toBeNull();
        atTheFloor();
    });

    it('a tool can start it off; closed for now it is not offered and says why; with no shop to read, nothing is said', async () => {
        OTHERS = ['Cordless drill', "Ana's Tool Shed"];
        const onList = vi.fn();
        await draw(sheet({ kind: 'open', shopId: 'shop-1', title: "Ana's Tool Shed", inShop: false }, onList, { ...DRAFT, shop: false }));
        expect(byTestId('tool-list-shop')?.getAttribute('aria-checked')).toBe('false');
        act(() => root.unmount());
        root = createRoot(host);
        await draw(sheet({ kind: 'paused', shopId: 'shop-1', title: "Ana's Tool Shed", inShop: false }, onList));
        expect(byTestId('tool-list-shop')).toBeNull();
        expect(byTestId('tool-list-shop-paused')).not.toBeNull();
        atTheFloor();
        await click('tool-list-go');
        expect(onList).toHaveBeenLastCalledWith({ kind: 'free', beans: 0 }, false);
        act(() => root.unmount());
        root = createRoot(host);
        await draw(sheet({ kind: 'hidden' }, onList));
        expect(byTestId('tool-list-shop')).toBeNull();
        expect(byTestId('tool-list-shop-paused')).toBeNull();
        await click('tool-list-go');
        expect(onList).toHaveBeenLastCalledWith({ kind: 'free', beans: 0 }, false);
    });

    it("the sheet's button keeps the choice beside the composer's draft, for that Offer's title; off forgets it", async () => {
        await openOfferComposer('me-key', 'fixture-kit', DRAFT, { kind: 'free', beans: 0 }, true);
        expect(JSON.parse(store.map.get(SHOP_CHOICE_KEY)!)).toMatchObject({ anchorUrl: 'https://mullum.example', title: 'Cordless drill' });
        expect(store.map.has('beanpool_offer_draft')).toBe(true);
        expect(nav.pushed.at(-1)).toBe('/(tabs)/map?newPost=offer');
        await openOfferComposer('me-key', 'fixture-kit', DRAFT, { kind: 'free', beans: 0 }, false);
        expect(store.map.has(SHOP_CHOICE_KEY)).toBe(false);
    });

    it("in the shop, a draft with no category of its own starts in the shop's; one with its own keeps it; outside the shop, none is added", async () => {
        await openOfferComposer('me-key', 'fixture-kit', DRAFT, { kind: 'free', beans: 0 }, true, 'tech');
        expect(JSON.parse(store.map.get('beanpool_offer_draft')!).postCategory).toBe('tech');
        await openOfferComposer('me-key', 'fixture-kit', { ...DRAFT, category: 'tools' }, { kind: 'free', beans: 0 }, true, 'tech');
        expect(JSON.parse(store.map.get('beanpool_offer_draft')!).postCategory).toBe('tools');
        await openOfferComposer('me-key', 'fixture-kit', DRAFT, { kind: 'free', beans: 0 }, false, 'tech');
        expect(JSON.parse(store.map.get('beanpool_offer_draft')!).postCategory).toBe('');
    });

    it("the choice knows its Offer by the tool's words and the photos the composer was handed, so a changed title keeps it", async () => {
        vi.mocked(FileSystem.readAsStringAsync).mockResolvedValueOnce('QUJDREVG');
        await openOfferComposer('me-key', 'fixture-kit', { ...DRAFT, photos: ['ref-1'] }, { kind: 'free', beans: 0 }, true);
        const choice = JSON.parse(store.map.get(SHOP_CHOICE_KEY)!);
        expect(choice).toMatchObject({ anchorUrl: 'https://mullum.example', title: 'Cordless drill', words: 'Barely used.' });
        const draft = JSON.parse(store.map.get('beanpool_offer_draft')!);
        expect(draft.postPhotos).toEqual(['data:image/jpeg;base64,QUJDREVG']);
        // What the composer posts (map.tsx handleSubmit) with its title and words changed: still the sheet's Offer, by its photo.
        const posted = { type: 'offer', title: 'Cordless drill (Makita)', description: 'Lent by the day.', photos: JSON.stringify(draft.postPhotos) };
        expect(shopChoiceFor(choice, posted, 'https://mullum.example', Date.now())).toBe('shop');
    });

    it("the Need door replaces the composer's one draft, and the choice that waited for its Offer goes with it", async () => {
        await openOfferComposer('me-key', 'fixture-kit', DRAFT, { kind: 'free', beans: 0 }, true);
        expect(store.map.has(SHOP_CHOICE_KEY)).toBe(true);
        const opening = openNeedComposer('me-key', 'fixture-kit', { title: 'A ladder for the weekend' });
        // The tool's Offer is an unfinished post on the map: replacing it is asked first.
        await vi.waitFor(() => expect(alerts.buttons.length).toBeGreaterThan(0));
        alerts.buttons.find((b) => b.text === t('Go on'))?.onPress?.();
        await opening;
        expect(JSON.parse(store.map.get('beanpool_offer_draft')!).postType).toBe('need');
        expect(store.map.has(SHOP_CHOICE_KEY)).toBe(false);
        expect(nav.pushed.at(-1)).toBe('/(tabs)/map?newPost=need');
    });

    it('the edit toggle starts where the listing is, and an edit sends an id in, null out, nothing when unchanged', async () => {
        OTHERS = ["Ana's Tool Shed"];
        const onChange = vi.fn();
        await draw(createElement(ShopToggle, { state: { kind: 'open', shopId: 'shop-1', title: "Ana's Tool Shed", inShop: true }, on: true, onChange, colors: lightColors, testID: 'edit-shop' }));
        expect(byTestId('edit-shop')?.getAttribute('aria-checked')).toBe('true');
        atTheFloor();
        await click('edit-shop');
        expect(onChange).toHaveBeenLastCalledWith(false);
        const open = { kind: 'open' as const, shopId: 'shop-1', title: "Ana's Tool Shed", inShop: false };
        expect(await shopIdForEdit(open, false, false)).toBeUndefined();
        expect(await shopIdForEdit(open, false, true)).toBe('shop-1');
        expect(await shopIdForEdit({ ...open, inShop: true }, true, false)).toBeNull();
        expect(await shopIdForEdit({ ...open, inShop: true }, true, true)).toBeUndefined();
        // None yet: turned on, the shop is opened first, as the toggle said it would be.
        expect(await shopIdForEdit({ kind: 'none' }, false, true)).toBe('shop-1');
        expect(node.log.filter((r) => r.method === 'PUT')).toEqual([{ method: 'PUT', path: '/api/shops/mine', body: {} }]);
        // Closed for now: one already in can be taken out; nothing goes in.
        const paused = { kind: 'paused' as const, shopId: 'shop-1', title: "Ana's Tool Shed", inShop: true };
        expect(await shopIdForEdit(paused, true, false)).toBeNull();
        expect(await shopIdForEdit({ ...paused, inShop: false }, false, true)).toBeUndefined();
        expect(await shopIdForEdit({ kind: 'hidden' }, false, true)).toBeUndefined();
    });

    it("the edit toggle opening a first shop through a proxy's 502 page: the edit screen's alert says the community couldn't be reached", async () => {
        node.shop = null;
        node.refuse = { status: 502, error: 'Request failed: 502', unsaid: true };
        // The edit screen's handleSave alerts this error's message as it is (app/post/[id].tsx).
        const err = await shopIdForEdit({ kind: 'none' }, false, true).catch((e) => e);
        expect(err).toBeInstanceOf(Error);
        expect(err.message).toBe("Your community couldn't be reached. Try again.");
        expect(err.message).not.toContain('Request failed');
        expect(node.log.filter((r) => r.method === 'PUT')).toEqual([{ method: 'PUT', path: '/api/shops/mine', body: {} }]);
    });

    it("the edit toggle opening a first shop on a line that never answers: Save is let go at the composer's limit, and says the community couldn't be reached", async () => {
        // Before this round the PUT had no signal and no limit, so Save stayed on "Saving…" (still waiting at 120 s); the edit
        // screen's own updatePost gives up at 12 s, but only starts once this settles. Its alert keeps the edit form open.
        node.shop = null;
        node.mode = 'stall';
        vi.useFakeTimers();
        try {
            let settled: unknown = 'waiting';
            const saving = shopIdForEdit({ kind: 'none' }, false, true).then((id) => { settled = id; }, (e) => { settled = e; });
            await vi.advanceTimersByTimeAsync(SHOP_COMPOSER_WAIT_MS - 1);
            expect(settled).toBe('waiting');
            await vi.advanceTimersByTimeAsync(1);
            await vi.waitFor(() => expect(settled).toBeInstanceOf(Error));
            await saving;
            expect((settled as Error).message).toBe("Your community couldn't be reached. Try again.");
            expect(node.log.filter((r) => r.method === 'PUT')).toEqual([{ method: 'PUT', path: '/api/shops/mine', body: {} }]);
            expect(vi.getTimerCount()).toBe(0);
            expect(SHOP_COMPOSER_WAIT_MS).toBeLessThanOrEqual(12_000);
        } finally {
            vi.useRealTimers();
        }
    });

    it('closed for now, a listing in it can still be taken out; one not in it is told why it stays out', async () => {
        OTHERS = ["Ana's Tool Shed"];
        await draw(createElement(ShopToggle, { state: { kind: 'paused', shopId: 'shop-1', title: "Ana's Tool Shed", inShop: true }, on: true, onChange: () => {}, colors: lightColors, testID: 'edit-shop' }));
        expect(byTestId('edit-shop')).not.toBeNull();
        expect(byTestId('edit-shop-closed')).not.toBeNull();
        atTheFloor();
        act(() => root.unmount());
        root = createRoot(host);
        await draw(createElement(ShopToggle, { state: { kind: 'paused', shopId: 'shop-1', title: "Ana's Tool Shed", inShop: false }, on: false, onChange: () => {}, colors: lightColors, testID: 'edit-shop' }));
        expect(byTestId('edit-shop')).toBeNull();
        expect(byTestId('edit-shop-paused')).not.toBeNull();
        atTheFloor();
    });
});

// ── Home ─────────────────────────────────────────────────────────────────────────────────────────

describe('Home\'s "Your shop and tools" body', () => {
    const COUNTS = { things: 3, available: 2, toBorrow: 1, toBuy: 2, out: 1, newThisWeek: 1 };

    it('none yet: Open your shop, and the tools; each a target into its screen', async () => {
        await draw(createElement(ShopHomeBody, { card: { shop: null }, colors: lightColors }));
        expect(byTestId('home-shop-open')).not.toBeNull();
        expect(byTestId('home-shop-tools')).not.toBeNull();
        atTheFloor();
        await click('home-shop-open');
        expect(nav.pushed.at(-1)).toBe('/shop/mine');
        await click('home-shop-tools');
        expect(nav.pushed.at(-1)).toBe('/tools');
    });

    it('open and closed for now, in light and dark: its title as written and its state', async () => {
        OTHERS = [ME.callsign, "Ana's Tool Shed"];
        for (const [dark, paused] of [[false, false], [true, true]] as const) {
            theme.dark = dark;
            // The theme hands either set as the app's one colour type (ThemeContext); so does this.
            const colors = (dark ? darkColors : lightColors) as unknown as AppColors;
            await draw(createElement(ShopHomeBody, { card: { shop: { id: 'shop-1', name: "Ana's Tool Shed", ownerName: 'Ana', category: 'tools', counts: COUNTS, paused, backOn: paused ? '2026-11-03' : null } }, colors }));
            expect(byTestId('home-shop-line')?.textContent).toContain("Ana's Tool Shed");
            atTheFloor(colors);
            await click('home-shop-line');
            expect(nav.pushed.at(-1)).toBe('/shop/mine');
            act(() => root.unmount());
            root = createRoot(host);
        }
        await draw(createElement(ShopHomeBody, { card: { shop: { id: 'shop-1', name: null, ownerName: 'Ana', category: null, counts: COUNTS, paused: true, backOn: '2026-11-03' } }, colors: lightColors }), 'en');
        expect(byTestId('home-shop-line')?.textContent).toBe("Ana's shopClosed for now · back Tue 3 Nov");
    });
});

// ── what the files are made of ───────────────────────────────────────────────────────────────────

describe('the shop screens take every colour from the central tokens', () => {
    it('no colour is written in them: no hex, rgb, or named colour', () => {
        const files = ['app/shop/mine.tsx', 'app/shop/[id].tsx', 'components/shop/ShopToggle.tsx', 'components/shop/ShopSheets.tsx', 'components/shop/ShopHomeBody.tsx', 'components/shopfront/Shopfront.tsx'];
        for (const f of files) {
            const src = fs.readFileSync(path.join(__dirname, '../..', f), 'utf8');
            expect(src, f).not.toMatch(/#[0-9a-fA-F]{3,8}\b|rgba?\(|'(white|black|red|green|blue|grey|gray)'/);
        }
    });
});
