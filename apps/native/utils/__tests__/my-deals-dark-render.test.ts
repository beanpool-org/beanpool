// @vitest-environment jsdom
/**
 * My Deals' held and pending cards in both schemes (memory dark-mode-readable-everywhere: readable in dark, light
 * unchanged). The sheet rendered for real, the member's own deals from a stand-in node client: a deal held in trust, one
 * waiting for the member to approve (Action Required) and one waiting for the other side (Awaiting Approval). Every text
 * on each card is measured against what it is drawn on (a see-through badge laid over its card): 4.5:1 or more in dark.
 * In light the cards keep the tints they had.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Module from 'node:module';
import { act, createElement, Fragment } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { darkColors, palette } from '../../constants/colors';

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
const at = new Date().toISOString();
const POSTS = [
    { id: 'held', title: 'Fix the garden gate', type: 'need', status: 'pending', author_pubkey: ME, accepted_by: 'n1', credits: 12, photos: '[]', created_at: at },
    { id: 'action', title: 'Sourdough loaves', type: 'offer', status: 'active', author_pubkey: ME, credits: 8, photos: '[]', created_at: at },
    { id: 'await', title: 'Help moving a couch', type: 'offer', status: 'active', author_pubkey: 'n2', credits: 20, photos: '[]', created_at: at },
];
const TXS = [
    { id: 't-action', postId: 'action', status: 'requested', buyerPublicKey: 'n3', sellerPublicKey: ME, credits: 8, createdAt: at },
    { id: 't-await', postId: 'await', status: 'requested', buyerPublicKey: ME, sellerPublicKey: 'n2', credits: 20, createdAt: at },
];
vi.mock('../db', () => ({
    getPosts: async () => POSTS, getMyPosts: async () => [], getMarketplaceTransactions: async () => TXS,
}));

import { MyDealsSheet } from '../../components/MyDealsSheet';

let host: HTMLDivElement;
let root: Root;
beforeEach(() => { host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host); });
afterEach(() => { act(() => root.unmount()); host.remove(); });

const styleOf = (el: Element | null) => JSON.parse(el?.getAttribute('data-style') || '{}');
type RGBA = [number, number, number, number];
function parse(c: string): RGBA {
    const m = c.match(/^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*([\d.]+)\s*)?\)$/);
    if (m) return [Number(m[1]), Number(m[2]), Number(m[3]), m[4] === undefined ? 1 : Number(m[4])];
    const n = c.replace('#', '');
    if (!/^[0-9a-f]{6}$/i.test(n)) throw new Error(`not a colour: ${c}`);
    return [0, 2, 4].map(i => parseInt(n.slice(i, i + 2), 16)).concat(1) as RGBA;
}
const over = (top: RGBA, under: RGBA): RGBA => [0, 1, 2].map(i => top[i] * top[3] + under[i] * (1 - top[3])).concat(1) as RGBA;
function contrast(a: RGBA, b: RGBA): number {
    const lum = (c: RGBA) => {
        const [r, g, bl] = c.slice(0, 3).map(v => v / 255).map(v => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
        return 0.2126 * r + 0.7152 * g + 0.0722 * bl;
    };
    const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
    return (x + 0.05) / (y + 0.05);
}
/** What a text is drawn on: every background from the card down to it, laid over the sheet's. */
function groundOf(text: Element, card: Element, sheet: RGBA): RGBA {
    const chain: Element[] = [];
    for (let el: Element | null = text; el; el = el.parentElement) { chain.unshift(el); if (el === card) break; }
    let ground = sheet;
    for (const el of chain) { const bg = styleOf(el).backgroundColor; if (bg) ground = over(parse(bg), ground); }
    return ground;
}

const render = async () => {
    await act(async () => { root.render(createElement(MyDealsSheet, { visible: true, identity: { publicKey: ME }, onClose() {}, initialTab: 'pending' }) as any); });
    for (let i = 0; i < 4; i++) await act(async () => {});
};
const card = (id: string) => host.querySelector(`[data-testid="deal-card-${id}"]`);

describe("My Deals' held and pending cards", () => {
    it('draws the three kinds of card on the Pending tab', async () => {
        theme.dark = false;
        await render();
        expect(card('held')?.textContent).toContain('Held in Trust');
        expect(card('action')?.textContent).toContain('Action Required');
        expect(card('await')?.textContent).toContain('Awaiting Approval');
    });

    it('in dark: every text on each card reads at 4.5:1 or more against what it is drawn on, on no light tint', async () => {
        theme.dark = true;
        await render();
        const sheet = parse(darkColors.surface.card);
        const measured: string[] = [];
        for (const id of ['held', 'action', 'await']) {
            const c = card(id)!;
            // The card itself is a dark ground: no light tint left over from the light scheme.
            expect(contrast(parse(styleOf(c).backgroundColor), parse('#ffffff')), `${id} card ground`).toBeGreaterThan(8);
            for (const span of Array.from(c.querySelectorAll('span'))) {
                const color = styleOf(span).color;
                const words = (span.textContent ?? '').replace(/\p{Extended_Pictographic}|️/gu, '').trim();
                if (!color || !words) continue;
                const ratio = contrast(parse(color), groundOf(span, c, sheet));
                measured.push(`${id} "${words}" ${ratio.toFixed(2)}`);
                expect(ratio, `${id}: "${words}" ${color}`).toBeGreaterThanOrEqual(4.5);
            }
        }
        // Each card's title and its status line were measured.
        expect(measured.join('\n')).toMatch(/held "Fix the garden gate"[\s\S]*held "Held in Trust"/);
        expect(measured.join('\n')).toMatch(/action "Action Required"/);
        expect(measured.join('\n')).toMatch(/await "Awaiting Approval"/);
    });

    it('in light: the cards keep their tints, and Action Required its amber', async () => {
        theme.dark = false;
        await render();
        expect(styleOf(card('held'))).toMatchObject({ backgroundColor: palette.green50, borderColor: palette.green200 });
        expect(styleOf(card('action'))).toMatchObject({ backgroundColor: palette.amber50, borderColor: palette.yellow300 });
        const action = Array.from(card('action')!.querySelectorAll('span')).find(s => s.textContent?.includes('Action Required'))!;
        expect(styleOf(action).color).toBe(palette.amber600);
        const held = Array.from(card('held')!.querySelectorAll('span')).find(s => s.textContent?.includes('Held in Trust'))!;
        const { lightColors } = await import('../../constants/colors');
        expect(styleOf(held).color).toBe(lightColors.text.muted);
    });
});
