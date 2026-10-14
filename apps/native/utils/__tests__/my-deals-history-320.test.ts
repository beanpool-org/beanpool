// @vitest-environment jsdom
/**
 * My Deals' History at the floor: 320 dp wide with the phone's text at 1.3x (memory product-audience-small-screens).
 * The Beans amount ("- 12") was cut off at the right edge: the badge and the date sat in a group that couldn't shrink,
 * beside it on one line (#1834 emulator note). The row now wraps, and the amount keeps the right edge and never shrinks,
 * so it drops to its own line whole where the three do not fit. The sheet is rendered for real (react-native drawn as
 * DOM, its styles kept as data, as my-deals-dark-render.test.ts does), in light and dark; the widths are a model of the
 * components' own numbers.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Module from 'node:module';
import { act, createElement, Fragment } from 'react';
import { createRoot, type Root } from 'react-dom/client';

(Module as any)._extensions['.png'] = (m: { exports: unknown }) => { m.exports = 1; };
(globalThis as any).__DEV__ = false;
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native', () => {
    const roles: Record<string, string> = { header: 'heading', button: 'button' };
    const el = (tag: string) => (props: Record<string, any>) => {
        const { children, onPress, accessibilityLabel, accessibilityRole, testID } = props;
        const attrs: Record<string, unknown> = {};
        if (testID) attrs['data-testid'] = testID;
        if (onPress) attrs.onClick = (e: { stopPropagation(): void }) => { e.stopPropagation(); onPress({ stopPropagation() {} }); };
        if (accessibilityLabel) attrs['aria-label'] = accessibilityLabel;
        if (accessibilityRole && roles[accessibilityRole]) attrs.role = roles[accessibilityRole];
        attrs['data-style'] = JSON.stringify(Object.assign({}, ...[props.style].flat(3).filter(s => s && typeof s === 'object')));
        return createElement(tag, attrs, children);
    };
    return {
        Platform: { OS: 'android' },
        Image: el('img'),
        Dimensions: { get: () => ({ width: 320, height: 569, scale: 1.5, fontScale: 1.3 }) },
        FlatList: ({ data, renderItem, keyExtractor, ListEmptyComponent }: Record<string, any>) => (data.length
            ? createElement('div', null, data.map((item: unknown, index: number) => createElement(Fragment, { key: keyExtractor(item) }, renderItem({ item, index }))))
            : ListEmptyComponent),
        View: el('div'), Text: el('span'), Pressable: el('button'), ScrollView: el('div'), TextInput: el('input'),
        Modal: ({ visible, children }: { visible: boolean; children?: unknown }) => (visible ? createElement('div', { 'data-modal': 'true' }, children as any) : null),
        StyleSheet: { create: (s: unknown) => s, hairlineWidth: 1, absoluteFill: {} },
        Alert: { alert: vi.fn() },
        useWindowDimensions: () => ({ width: 320, height: 569, scale: 1.5, fontScale: 1.3 }),
    };
});
vi.mock('expo-router', () => ({ router: { push() {}, navigate() {} } }));
vi.mock('@react-native-async-storage/async-storage', () => ({ default: { getItem: async () => null, setItem: async () => {}, removeItem: async () => {} } }));
vi.mock('@expo/vector-icons', () => ({ MaterialCommunityIcons: () => createElement('span', { 'data-icon': 'true' }) }));
vi.mock('expo-image', () => ({ Image: () => createElement('img') }));
vi.mock('../../components/MemberAvatar', () => ({ MemberAvatar: () => createElement('span', { 'data-avatar': 'true' }) }));
vi.mock('../../components/ReviewModal', () => ({ ReviewModal: () => null }));
const theme = vi.hoisted(() => ({ dark: false }));
vi.mock('../../app/ThemeContext', async () => {
    const { lightColors: light, darkColors: dark } = await import('../../constants/colors');
    const colors = () => (theme.dark ? dark : light);
    return {
        useTheme: () => ({ theme: theme.dark ? 'dark' : 'light', colors: colors() }),
        useStyles: (make: (t: { theme: string; colors: unknown }) => unknown) => make({ theme: theme.dark ? 'dark' : 'light', colors: colors() }),
    };
});
const ME = 'a-real-member-key';
const at = new Date('2026-10-14T09:00:00Z').toISOString();
// Bought (a minus) and sold (a plus), both completed, so the History tab draws them with the longest badge.
const TXS = [
    { id: 't-bought', postId: 'p1', postTitle: 'Fix the garden gate', status: 'completed', buyerPublicKey: ME, sellerPublicKey: 'n1', sellerCallsign: 'Robin', credits: 12, createdAt: at, ratedByBuyer: true },
    { id: 't-sold', postId: 'p2', postTitle: 'Sourdough loaves', status: 'completed', buyerPublicKey: 'n2', buyerCallsign: 'Kim', sellerPublicKey: ME, credits: 480, createdAt: at, ratedBySeller: false },
];
vi.mock('../db', () => ({
    getPosts: async () => [], getMyPosts: async () => [], getMarketplaceTransactions: async () => TXS,
}));

import { MyDealsSheet } from '../../components/MyDealsSheet';

let host: HTMLDivElement;
let root: Root;
beforeEach(() => { host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host); });
afterEach(() => { act(() => root.unmount()); host.remove(); });

const styleOf = (el: Element | null) => JSON.parse(el?.getAttribute('data-style') || '{}');
const num = (v: unknown) => (typeof v === 'number' ? v : 0);

// The floor: 320 dp wide, the phone's text at 1.3x (the app caps it at 1.2, constants/responsive.ts: 1.3 is the harder
// case), with a generous glyph width (0.62em, a bold Latin face), as sso-button-layout.test.ts and key-changed-320 do.
const WIDTH = 320;
const SCALE = 1.3;
const GLYPH = 0.62;

/** A model of a drawn element's width from the component's own numbers: text by its characters, a row by its children and gaps. */
function widthOf(el: Element): number {
    const st = styleOf(el);
    const padX = num(st.paddingHorizontal ?? st.padding) * 2 + num(st.paddingLeft) + num(st.paddingRight);
    const marginX = num(st.marginLeft) + num(st.marginRight);
    if (el.tagName === 'IMG') return num(st.width) + marginX;
    if (el.tagName === 'SPAN') return (el.textContent ?? '').length * GLYPH * num(st.fontSize ?? 14) * SCALE + padX + marginX;
    const kids = Array.from(el.children);
    const ws = kids.map(widthOf);
    const gap = num(st.columnGap ?? st.gap);
    const inner = st.flexDirection === 'row' ? ws.reduce((a, b) => a + b, 0) + gap * Math.max(0, kids.length - 1) : Math.max(0, ...ws);
    return inner + padX + marginX;
}

/** The row's lines as flexbox lays them out: one line unless it wraps, then as many children as fit on each. */
function linesOf(row: Element, room: number): { kids: Element[]; width: number }[] {
    const st = styleOf(row);
    const gap = num(st.columnGap ?? st.gap);
    const kids = Array.from(row.children);
    if (st.flexWrap !== 'wrap') return [{ kids, width: kids.map(widthOf).reduce((a, b) => a + b, 0) + gap * Math.max(0, kids.length - 1) }];
    const lines: { kids: Element[]; width: number }[] = [];
    for (const kid of kids) {
        const w = widthOf(kid);
        const line = lines[lines.length - 1];
        if (line && line.width + gap + w <= room) { line.kids.push(kid); line.width += gap + w; } else lines.push({ kids: [kid], width: w });
    }
    return lines;
}

/** The room the top row has: the screen less the sheet's padding, the card's border, its photo and its own padding. */
function roomOf(card: Element): number {
    let sheet: Element | null = card;
    while (sheet && styleOf(sheet).borderTopLeftRadius !== 24) sheet = sheet.parentElement;
    const [thumb, body] = Array.from(card.children);
    return WIDTH - num(styleOf(sheet).padding) * 2 - num(styleOf(card).borderWidth) * 2 - num(styleOf(thumb).width) - num(styleOf(body).padding) * 2;
}

const render = async () => {
    await act(async () => { root.render(createElement(MyDealsSheet, { visible: true, identity: { publicKey: ME }, onClose() {}, initialTab: 'history' }) as any); });
    for (let i = 0; i < 4; i++) await act(async () => {});
};

describe('My Deals History at 320 dp with the text at 1.3x, light and dark', () => {
    for (const dark of [false, true]) {
        it(`${dark ? 'dark' : 'light'}: the Beans amount is always whole, at the right, and the badge and date too`, async () => {
            theme.dark = dark;
            await render();
            for (const [id, words] of [['t-bought', '- 12'], ['t-sold', '+ 480']] as const) {
                const card = host.querySelector(`[data-testid="deal-card-${id}"]`)!;
                expect(card, id).not.toBeNull();
                const room = roomOf(card);
                expect(room, 'the room is the card less its photo and padding').toBe(158);
                const amount = host.querySelector(`[data-testid="deal-amount-${id}"]`)!;
                expect(amount.textContent).toBe(words);
                // It keeps the right edge and never gives up width to the date.
                expect(styleOf(amount)).toMatchObject({ marginLeft: 'auto', flexShrink: 0 });
                const lines = linesOf(host.querySelector(`[data-testid="deal-top-${id}"]`)!, room);
                const line = lines.find(l => l.kids.some(k => k === amount || k.contains(amount)))!;
                expect(line, `${id}: the amount is on a line of its row`).toBeTruthy();
                for (const l of lines) expect(l.width, `${id}: a line of ${l.kids.map(k => k.textContent).join(' | ')}`).toBeLessThanOrEqual(room);
            }
        });
    }
});
