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
    { id: 'paused', title: 'Old bicycle pump', type: 'offer', status: 'paused', author_pubkey: ME, credits: 5, photos: '[]', created_at: at },
];
const TXS = [
    { id: 't-held', postId: 'held', postTitle: 'Fix the garden gate', status: 'pending', buyerPublicKey: ME, buyerCallsign: 'Me', sellerPublicKey: 'n1', sellerCallsign: 'Robin', postAuthorPublicKey: ME, postType: 'need', credits: 12, createdAt: at },
    { id: 't-action', postId: 'action', postTitle: 'Sourdough loaves', status: 'requested', buyerPublicKey: 'n3', buyerCallsign: 'Alex', sellerPublicKey: ME, sellerCallsign: 'Me', postAuthorPublicKey: ME, postType: 'offer', credits: 8, createdAt: at },
    { id: 't-await', postId: 'await', postTitle: 'Help moving a couch', status: 'requested', buyerPublicKey: ME, buyerCallsign: 'Me', sellerPublicKey: 'n2', sellerCallsign: 'Sam', postAuthorPublicKey: 'n2', postType: 'offer', credits: 20, createdAt: at },
];
vi.mock('../db', () => ({
    getPosts: async () => POSTS, getMyPosts: async () => POSTS.filter(p => p.author_pubkey === ME), getMarketplaceTransactions: async () => TXS,
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

const render = async (initialTab: 'pending' | 'active' | 'history' = 'pending') => {
    await act(async () => { root.render(createElement(MyDealsSheet, { visible: true, identity: { publicKey: ME }, onClose() {}, initialTab }) as any); });
    for (let i = 0; i < 4; i++) await act(async () => {});
};
const card = (id: string) => host.querySelector(`[data-testid="deal-card-${id}"]`);

describe("My Deals' held and pending cards", () => {
    it('In Progress lists DEALS (transactions) with title row and one-line states', async () => {
        theme.dark = false;
        await render('pending');
        // Sheet title row: 3 under way · 2 need you
        expect(host.textContent).toContain('3 under way · 2 need you');
        // In Progress renders transactions, not listings
        expect(card('t-held')?.textContent).toContain('Fix the garden gate');
        expect(card('t-held')?.textContent).toContain('Waiting on you: release');
        expect(card('t-action')?.textContent).toContain('Sourdough loaves');
        expect(card('t-action')?.textContent).toContain('Waiting on you: answer');
        expect(card('t-await')?.textContent).toContain('Help moving a couch');
        expect(card('t-await')?.textContent).toContain('You asked · waiting on Sam');
    });

    it('My Posts lists listings with status chips (Held in Trust, Action Required, PAUSED)', async () => {
        theme.dark = false;
        await render('active');
        expect(card('held')?.textContent).toContain('Held in Trust');
        expect(card('action')?.textContent).toContain('Action Required');
        expect(card('paused')?.textContent).toContain('PAUSED');
    });

    it('in dark: every text on each deal card reads at 4.5:1 or more against what it is drawn on', async () => {
        theme.dark = true;
        await render('pending');
        const sheet = parse(darkColors.surface.card);
        const measured: string[] = [];
        for (const id of ['t-held', 't-action', 't-await']) {
            const c = card(id)!;
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
        expect(measured.join('\n')).toMatch(/t-held "Fix the garden gate"/);
        expect(measured.join('\n')).toMatch(/t-action "Waiting on you: answer"/);
    });

    it('in light: My Posts cards keep their tints, and Action Required its amber', async () => {
        theme.dark = false;
        await render('active');
        expect(styleOf(card('held'))).toMatchObject({ backgroundColor: palette.green50, borderColor: palette.green200 });
        expect(styleOf(card('action'))).toMatchObject({ backgroundColor: palette.amber50, borderColor: palette.yellow300 });
        const action = Array.from(card('action')!.querySelectorAll('span')).find(s => s.textContent?.includes('Action Required'))!;
        const { lightColors } = await import('../../constants/colors');
        expect(styleOf(action).color).toBe(lightColors.feedback.warning.fg);
        expect(styleOf(action).color).toBe(palette.amber800);
        const held = Array.from(card('held')!.querySelectorAll('span')).find(s => s.textContent?.includes('Held in Trust'))!;
        expect(styleOf(held).color).toBe(lightColors.text.muted);
    });
});
