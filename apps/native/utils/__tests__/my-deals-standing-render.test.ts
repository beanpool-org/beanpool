// @vitest-environment jsdom
/**
 * Standing deals S2, Your deals on the phone, round 2 of #3000 (deciding review on e07a97d3; DESIGN-standing-deals-fable §2.2).
 * A short standing deal's row is the period last settled (`completed`), but the card under In progress is the standing deal,
 * still running: it shows 🔁 STANDING and the panel's line, as on the web (MyDealsModal), never the "Completed" badge, and no
 * review button ("Edit" changed a review nobody gave, and opened the review for that period: finding 4). A one-off deal
 * finished is reviewed from History as before. The sheet is rendered for real (react-native drawn as DOM, as
 * my-deals-history-320.test.ts does), in light and dark.
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
const nav = vi.hoisted(() => ({ to: [] as unknown[] }));
vi.mock('expo-router', () => ({ router: { push(to: unknown) { nav.to.push(to); }, navigate(to: unknown) { nav.to.push(to); } } }));
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
const PAYER = 'a'.repeat(64);
const PAYEE = 'b'.repeat(64);
const short = {
    id: 'tx-short', postId: 'post-1', postTitle: 'Vehicle Storage', status: 'completed', buyerPublicKey: PAYER, buyerCallsign: 'Marty',
    sellerPublicKey: PAYEE, sellerCallsign: 'Rob', credits: 50, createdAt: '2026-11-09T08:00:00.000Z', ratedByBuyer: false, ratedBySeller: false,
    standingId: 'sd-1', periodNo: 1, standingPhase: 'short', standingBeans: 50, standingUnit: 'month', standingMaxPeriods: null,
    standingNextDueAt: '2026-11-09T09:00:00.000Z', standingStartsAt: '2026-10-09T08:00:00.000Z', standingShortSince: '2026-11-09T08:00:00.000Z',
    standingStopped: false,
};
vi.mock('../db', () => ({ getPosts: async () => [], getMyPosts: async () => [], getMarketplaceTransactions: async () => [short] }));

import { MyDealsSheet } from '../../components/MyDealsSheet';

let host: HTMLDivElement;
let root: Root;
beforeEach(() => { host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host); nav.to.length = 0; });
afterEach(() => { act(() => root.unmount()); host.remove(); });

const render = async (me: string) => {
    await act(async () => { root.render(createElement(MyDealsSheet, { visible: true, identity: { publicKey: me }, onClose() {}, initialTab: 'pending' }) as any); });
    for (let i = 0; i < 4; i++) await act(async () => {});
};

describe('Your deals, In progress: a short standing deal (the period last settled) at 320 dp, light and dark', () => {
    for (const dark of [false, true]) {
        for (const [me, line] of [[PAYER, "⚠️ This month's 50 Beans couldn't be paid · 50 needed by 24 Nov or it ends"], [PAYEE, "This month isn't paid yet · we'll keep trying until 24 Nov"]] as const) {
            it(`${dark ? 'dark' : 'light'}, ${me === PAYER ? 'payer' : 'payee'}: 🔁 STANDING and its line; no Completed badge, no Edit or Review; it opens the listing`, async () => {
                theme.dark = dark;
                await render(me);
                const card = host.querySelector('[data-testid="deal-card-tx-short"]') as HTMLElement;
                expect(card).not.toBeNull();
                expect(host.querySelector('[data-testid="standing-chip-tx-short"]')?.textContent).toBe('🔁 STANDING');
                expect(host.querySelector('[data-testid="deal-state-tx-short"]')?.textContent).toBe(line);
                const words = Array.from(card.querySelectorAll('span')).map(s => s.textContent);
                // The phone's badge says COMPLETED (DEAL_STATUS_WORDS), the web's "completed" in capitals by its class.
                expect(words.map(w => (w ?? '').toUpperCase())).not.toContain('COMPLETED');
                const buttons = Array.from(card.querySelectorAll('button')).map(b => b.textContent);
                expect(buttons).not.toContain('Edit');
                expect(buttons).not.toContain('Review');
                (card.closest('button') as HTMLElement).click();
                expect(nav.to).toEqual([{ pathname: '/post/[id]', params: { id: 'post-1', txId: 'tx-short' } }]);
            });
        }
    }
});
