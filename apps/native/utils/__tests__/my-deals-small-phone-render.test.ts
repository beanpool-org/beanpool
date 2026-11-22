// @vitest-environment jsdom
/**
 * Your deals on an old small phone: 320 × 569 dp, the text at 1.3x, the navigation bar drawn over the sheet (walk 148, the
 * 1.4.8 build on API 26). "In Progress" was broken inside the word ("In Pro / gress"), "You asked · waiting on …" lost the
 * other person's name, and the list under the tabs was 148 dp tall, less than one card.
 *
 * The sheet is rendered for real (react-native drawn as DOM, its styles kept as data) and laid out with Yoga
 * (yoga-dom-layout.ts), in light and dark: each tab's name in whole words, in every language; the state line never cut;
 * one whole card between the tabs and the navigation bar.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Module from 'node:module';
import { act, createElement, Fragment } from 'react';
import { createRoot, type Root } from 'react-dom/client';

(Module as any)._extensions['.png'] = (m: { exports: unknown }) => { m.exports = 1; };
(globalThis as any).__DEV__ = false;
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

/** Android's window leaves the 48 dp navigation bar out; the edge-to-edge Modal does not. */
const WINDOW = 521;
const laid = vi.hoisted(() => ({ overlay: null as null | ((e: unknown) => void) }));
vi.mock('react-native', () => {
    const flat = (style: unknown): Record<string, any> => Object.assign({}, ...[style].flat(4).filter((s) => s && typeof s === 'object'));
    const el = (tag: string) => (props: Record<string, any>) => {
        const { children, onPress, accessibilityLabel, testID, numberOfLines, onLayout } = props;
        const attrs: Record<string, unknown> = { 'data-style': JSON.stringify(flat(props.style)) };
        if (testID) attrs['data-testid'] = testID;
        if (numberOfLines) attrs['data-lines'] = String(numberOfLines);
        if (onPress) attrs.onClick = (e: { stopPropagation(): void }) => { e.stopPropagation(); onPress({ stopPropagation() {} }); };
        if (accessibilityLabel) attrs['aria-label'] = accessibilityLabel;
        // The sheet's overlay is the one part that measures itself.
        if (onLayout) laid.overlay = onLayout;
        return createElement(tag, attrs, children);
    };
    // A list as React Native lays one out: its frame, and its content inside it.
    const list = (content: unknown, style: unknown) => createElement('div', { 'data-testid': 'deals-list', 'data-style': JSON.stringify({ flexGrow: 1, flexShrink: 1, overflow: 'scroll' }) },
        createElement('div', { 'data-testid': 'deals-list-content', 'data-style': JSON.stringify(flat(style)) }, content as any));
    return {
        Platform: { OS: 'android' },
        Image: el('img'),
        Dimensions: { get: () => ({ width: 320, height: 521, scale: 1.5, fontScale: 1.3 }) },
        FlatList: ({ data, renderItem, keyExtractor, ListEmptyComponent, contentContainerStyle }: Record<string, any>) => list(data.length
            ? data.map((item: unknown, index: number) => createElement(Fragment, { key: keyExtractor(item) }, renderItem({ item, index })))
            : ListEmptyComponent, contentContainerStyle),
        ScrollView: ({ children, contentContainerStyle }: Record<string, any>) => list(children, contentContainerStyle),
        View: el('div'), Text: el('span'), Pressable: el('button'), TextInput: el('input'),
        Modal: ({ visible, children }: { visible: boolean; children?: unknown }) => (visible ? createElement('div', { 'data-modal': 'true', 'data-style': JSON.stringify({ flex: 1 }) }, children as any) : null),
        StyleSheet: { create: (s: unknown) => s, hairlineWidth: 1, absoluteFill: {} },
        Alert: { alert: vi.fn() },
        useWindowDimensions: () => ({ width: 320, height: 521, scale: 1.5, fontScale: 1.3 }),
    };
});
vi.mock('expo-router', () => ({ router: { push() {}, navigate() {} } }));
vi.mock('@react-native-async-storage/async-storage', () => ({ default: { getItem: async () => null, setItem: async () => {}, removeItem: async () => {} } }));
vi.mock('@expo/vector-icons', () => ({ MaterialCommunityIcons: () => createElement('i') }));
vi.mock('expo-image', () => ({ Image: () => createElement('img') }));
vi.mock('../../components/MemberAvatar', () => ({ MemberAvatar: ({ size }: { size: number }) => createElement('div', { 'data-style': JSON.stringify({ width: size, height: size }) }) }));
vi.mock('../../components/ReviewModal', () => ({ ReviewModal: () => null }));
vi.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ top: 24, bottom: 48, left: 0, right: 0 }) }));
const theme = vi.hoisted(() => ({ dark: false }));
vi.mock('../../app/ThemeContext', async () => {
    const { COLOUR_SETS } = await import('../../constants/colors');
    const ctx = () => ({ theme: theme.dark ? 'dark' : 'light', colors: theme.dark ? COLOUR_SETS.night : COLOUR_SETS.light });
    return { useTheme: ctx, useStyles: (make: (t: unknown) => unknown) => make(ctx()) };
});

const ME = 'a'.repeat(64);
const SAM = 'b'.repeat(64);
const NAME = 'Wilhelmina Fairweath'; // MAX_JOIN_NAME, 20
const D = 86_400_000;
const ago = (ms: number) => new Date(Date.now() - ms).toISOString();
const asked = (id: string, over: Record<string, unknown> = {}) => ({
    id, postId: `post-${id}`, postTitle: 'Tomato seedlings, six of them', buyerPublicKey: ME, buyerCallsign: 'Me', sellerPublicKey: SAM, sellerCallsign: NAME,
    postAuthorPublicKey: SAM, postType: 'offer', amount_c: 500, status: 'requested', createdAt: ago(4 * D), ...over,
});
const db = vi.hoisted(() => ({ rows: [] as unknown[] }));
vi.mock('../db', () => ({
    getPosts: async () => [],
    getMyPosts: async () => [],
    getMarketplaceTransactions: async () => db.rows,
    peerReadCursors: async () => new Map([['b'.repeat(64), new Date(Date.now() - 6 * 86_400_000).toISOString()]]),
}));

import { LANGS, setLanguage, type UiLang } from '@beanpool/core';
import { MyDealsSheet } from '../../components/MyDealsSheet';
import { LIST_SHEET_MIN, listSheetLayout } from '../bottom-sheet-layout';
import { catalogsFor } from '../words-catalogs';
import { layOut } from './yoga-dom-layout';

const SCREEN = { width: 320, height: 569 };
const NAV = 48;
const SCALE = 1.3;
/** The harness's own glyph width (yoga-dom-layout.ts), so a word measured here is a word measured there. */
const GLYPH = 0.56;

let host: HTMLDivElement;
let root: Root;
beforeEach(() => { host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host); db.rows = [asked('t-1'), asked('t-2')]; });
afterEach(() => { act(() => root.unmount()); host.remove(); theme.dark = false; laid.overlay = null; setLanguage('en'); });

async function render(bills = true) {
    await act(async () => {
        root.render(createElement(MyDealsSheet, { visible: true, identity: { publicKey: ME }, onClose() {}, initialTab: 'pending', bills: bills ? () => createElement('div') : null }) as any);
    });
    for (let i = 0; i < 4; i++) await act(async () => {});
    // The Modal is laid out over the whole screen, the navigation bar too.
    if (laid.overlay) await act(async () => { laid.overlay!({ nativeEvent: { layout: { height: SCREEN.height } } }); });
}
const byId = (id: string) => { const el = host.querySelector(`[data-testid="${id}"]`); expect(el, id).toBeTruthy(); return el!; };
const styleOf = (el: Element) => JSON.parse(el.getAttribute('data-style') || '{}');
function lay() {
    const screen = host.querySelector('[data-modal]')!;
    const layout = layOut(screen, SCREEN, { fontScale: SCALE });
    const at = (el: Element) => {
        let top = 0;
        for (let e: Element | null = el; e; e = e === screen ? null : e.parentElement) top += layout.box(e).top;
        return { top, bottom: top + layout.box(el).height };
    };
    return { ...layout, at };
}
/** The tab strip: the row that holds the four names. */
const tabs = () => {
    const progress = Array.from(host.querySelectorAll('button')).filter((b) => b.parentElement?.getAttribute('data-style')?.includes('"flexDirection":"row"') && b.parentElement.querySelectorAll(':scope > button').length >= 3);
    expect(progress.length).toBeGreaterThanOrEqual(3);
    return progress;
};

describe.each([false, true])('Your deals at 320 × 569 dp and 1.3x, dark: %s', (dark) => {
    beforeEach(() => { theme.dark = dark; });

    it.each(['xx', ...LANGS] as UiLang[])('%s: every tab keeps its words whole, with its count, inside the bar', async (lang) => {
        setLanguage(lang, catalogsFor(lang));
        await render();
        const layout = lay();
        const bar = tabs()[0].parentElement!;
        expect(tabs()).toHaveLength(4);
        for (const tab of tabs()) {
            const label = tab.querySelector('span')!;
            const longest = Math.max(...(label.textContent ?? '').split(/\s+/).map((w) => w.length * styleOf(label).fontSize * SCALE * GLYPH));
            expect(layout.width(label), `${lang}: "${label.textContent}"`).toBeGreaterThanOrEqual(longest - 0.01);
            expect(layout.box(tab).left + layout.width(tab), `${lang}: "${label.textContent}" inside the bar`).toBeLessThanOrEqual(layout.width(bar) + 0.01);
            // Nothing in a tab is pushed past its edge (the count badge sat on it).
            for (const kid of Array.from(tab.children)) expect(layout.box(kid).left + layout.width(kid)).toBeLessThanOrEqual(layout.width(tab) + 0.01);
        }
    });

    it('"You asked · waiting on …" says the whole name, in every language', async () => {
        for (const lang of ['en', ...LANGS.filter((l) => l !== 'en')] as UiLang[]) {
            setLanguage(lang, catalogsFor(lang));
            await render();
            const line = byId('deal-state-t-1');
            expect(line.textContent, lang).toContain(NAME);
            expect(line.getAttribute('data-lines'), `${lang}: never cut to a number of lines`).toBeNull();
        }
    });

    it('one whole card shows between the tabs and the navigation bar, with its not-seen line', async () => {
        await render();
        const layout = lay();
        expect(host.querySelector('[data-testid="deal-not-seen-t-1"]')?.textContent).toContain('Not seen in 4 days');
        const list = layout.at(byId('deals-list'));
        const card = layout.at(byId('deal-card-t-1'));
        expect(card.top).toBeGreaterThanOrEqual(list.top);
        expect(card.bottom, `the list ${list.top} to ${list.bottom}`).toBeLessThanOrEqual(list.bottom);
        // And the list's own end is above the navigation bar, its sheet below the status bar.
        expect(list.bottom).toBeLessThanOrEqual(SCREEN.height - NAV);
        expect(layout.at(tabs()[0]).top).toBeGreaterThan(24);
    });
});

describe('the sheet\'s height (utils/bottom-sheet-layout.ts listSheetLayout)', () => {
    it('a small phone gives the list its room; a bigger one keeps three quarters, as it was', () => {
        expect(listSheetLayout(569, { top: 24, bottom: 48 })).toEqual({ maxHeight: 569 - 24 - 16, paddingBottom: 48 });
        expect(listSheetLayout(667, { top: 20, bottom: 0 })).toEqual({ maxHeight: LIST_SHEET_MIN, paddingBottom: 40 });
        expect(listSheetLayout(800, { top: 24, bottom: 24 })).toEqual({ maxHeight: 600, paddingBottom: 40 });
        expect(listSheetLayout(932, { top: 59, bottom: 34 })).toEqual({ maxHeight: 699, paddingBottom: 40 });
    });
    it('odd numbers from the platform never give a negative size, and the window is enough before the Modal is measured', () => {
        expect(listSheetLayout(0, { top: 24, bottom: 0 }).maxHeight).toBe(0);
        expect(listSheetLayout(Number.NaN, { top: Number.NaN, bottom: Number.NaN })).toEqual({ maxHeight: 0, paddingBottom: 40 });
        expect(listSheetLayout(WINDOW, { top: 24, bottom: 48 }).maxHeight).toBe(WINDOW - 24 - 16);
    });
});
