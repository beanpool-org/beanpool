// @vitest-environment jsdom
/**
 * Slice N2a (DESIGN-notify-and-backup-asks-fable-amend2.md §12.3): after a first listing, the named line "Hear when someone
 * answers." [Tell me] over My Posts in Your deals, where app/new-listing.tsx lands the member. The listing hands the moment
 * over (components/NotifyLine.tsx noteNotifyMoment); whether it shows is core's rule (utils/notification-permission.ts
 * offerNamedLine, answered here). The sheet is rendered for real (react-native drawn as DOM), in light and dark, as
 * my-deals-not-seen-render.test.ts does.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Module from 'node:module';
import { act, createElement, Fragment } from 'react';
import { createRoot, type Root } from 'react-dom/client';

(Module as any)._extensions['.png'] = (m: { exports: unknown }) => { m.exports = 1; };
(globalThis as any).__DEV__ = false;
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native', () => {
    const el = (tag: string) => (props: Record<string, any>) => {
        const { children, onPress, accessibilityLabel, testID } = props;
        const attrs: Record<string, unknown> = {};
        if (testID) attrs['data-testid'] = testID;
        if (onPress) attrs.onClick = (e: { stopPropagation(): void }) => { e.stopPropagation(); onPress({ stopPropagation() {} }); };
        if (accessibilityLabel) attrs['aria-label'] = accessibilityLabel;
        return createElement(tag, attrs, children);
    };
    return {
        Platform: { OS: 'android' },
        Image: el('img'),
        Dimensions: { get: () => ({ width: 320, height: 569, scale: 1.5, fontScale: 1.3 }) },
        FlatList: ({ data, renderItem, keyExtractor, ListHeaderComponent, ListEmptyComponent }: Record<string, any>) => createElement('div', null,
            ListHeaderComponent,
            data.length ? data.map((item: unknown, index: number) => createElement(Fragment, { key: keyExtractor(item) }, renderItem({ item, index }))) : ListEmptyComponent),
        View: el('div'), Text: el('span'), Pressable: el('button'), ScrollView: el('div'), TextInput: el('input'),
        Modal: ({ visible, children }: { visible: boolean; children?: unknown }) => (visible ? createElement('div', { 'data-modal': 'true' }, children as any) : null),
        StyleSheet: { create: (s: unknown) => s, hairlineWidth: 1, absoluteFill: {} },
        Alert: { alert: vi.fn() },
        useWindowDimensions: () => ({ width: 320, height: 569, scale: 1.5, fontScale: 1.3 }),
    };
});
vi.mock('expo-router', () => ({ router: { push() {}, navigate() {} } }));
vi.mock('@react-native-async-storage/async-storage', () => ({ default: { getItem: async () => null, setItem: async () => {}, removeItem: async () => {} } }));
vi.mock('@expo/vector-icons', () => ({ MaterialCommunityIcons: ({ name }: { name: string }) => createElement('span', { 'data-icon': name }) }));
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
const ME = 'a'.repeat(64);
const POST = { id: 'post-1', title: 'Ladder to lend', type: 'offer', status: 'active', author_pubkey: ME, price_c: 500, created_at: new Date().toISOString() };
vi.mock('../db', () => ({
    getPosts: async () => [],
    getMyPosts: async () => [POST],
    getMarketplaceTransactions: async () => [],
    peerReadCursors: async () => new Map(),
}));
const notifyAsk = vi.hoisted(() => ({ offer: true, offered: [] as string[], turnOns: 0 }));
vi.mock('../notification-permission', () => ({
    offerNamedLine: vi.fn(async (kind: string) => { notifyAsk.offered.push(kind); return notifyAsk.offer; }),
    turnOnNotifications: vi.fn(async () => { notifyAsk.turnOns++; return 'granted'; }),
}));

import { MyDealsSheet } from '../../components/MyDealsSheet';
import { LISTING_MOMENT, noteNotifyMoment } from '../../components/NotifyLine';

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    notifyAsk.offer = true; notifyAsk.offered = []; notifyAsk.turnOns = 0;
});
afterEach(() => { act(() => root.unmount()); host.remove(); theme.dark = false; });

const settle = async () => { for (let i = 0; i < 6; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); };
const render = async (props: Record<string, unknown> = {}) => {
    await act(async () => { root.render(createElement(MyDealsSheet, { visible: true, identity: { publicKey: ME }, onClose() {}, initialTab: 'active', ...props }) as any); });
    await settle();
};
const byTestId = (id: string) => host.querySelector(`[data-testid="${id}"]`) as HTMLElement | null;

describe('Your deals after a first listing (slice N2a)', () => {
    for (const dark of [false, true]) {
        it(`${dark ? 'dark' : 'light'}: "Hear when someone answers." over My Posts; Tell me turns them on and says so`, async () => {
            theme.dark = dark;
            noteNotifyMoment(LISTING_MOMENT, { kind: 'listing' });
            await render();
            expect(notifyAsk.offered).toEqual(['listing']);
            const shown = byTestId('notify-line');
            expect(shown?.textContent).toContain('Hear when someone answers.');
            expect(host.textContent).toContain('Ladder to lend');
            expect(host.textContent!.indexOf('Hear when someone answers.')).toBeLessThan(host.textContent!.indexOf('Ladder to lend'));
            await act(async () => { byTestId('notify-line-tell-me')!.click(); });
            await settle();
            expect(notifyAsk.turnOns).toBe(1);
            expect(byTestId('notify-line-done')?.textContent).toContain("You'll hear when someone answers.");
        });
    }

    it('opened with no listing just posted: no line, and the rule is not asked', async () => {
        await render();
        expect(notifyAsk.offered).toEqual([]);
        expect(byTestId('notify-line')).toBeNull();
    });

    it('the rule says no (the phone said no, or the day is taken): no line', async () => {
        notifyAsk.offer = false;
        noteNotifyMoment(LISTING_MOMENT, { kind: 'listing' });
        await render();
        expect(notifyAsk.offered).toEqual(['listing']);
        expect(byTestId('notify-line')).toBeNull();
    });

    it('the moment is taken once: Your deals opened again shows no second line', async () => {
        noteNotifyMoment(LISTING_MOMENT, { kind: 'listing' });
        await render();
        expect(byTestId('notify-line')).not.toBeNull();
        act(() => root.unmount());
        root = createRoot(host);
        await render();
        expect(notifyAsk.offered).toEqual(['listing']);
        expect(byTestId('notify-line')).toBeNull();
    });

    it('in the preview (a guest looking around): never', async () => {
        noteNotifyMoment(LISTING_MOMENT, { kind: 'listing' });
        await render({ preview: true });
        expect(notifyAsk.offered).toEqual([]);
        expect(byTestId('notify-line')).toBeNull();
    });
});
