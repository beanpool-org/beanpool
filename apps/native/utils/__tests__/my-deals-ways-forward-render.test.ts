// @vitest-environment jsdom
/**
 * My Deals' ways forward on the worldwide community (global previews audit, item 4; PHONE.md §1 c): My Deals is a
 * Modal, and the strip's Start a community / Communities near you, and the sheet's three ways forward, pushed the next
 * screen with My Deals still open, so it opened UNDER it. Each now closes My Deals first: when the route is pushed, My
 * Deals has already been told to close (and the marker's own sheet with it). The harness of showcase-render.test.ts.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Module from 'node:module';
import { act, createElement, Fragment } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { LOCAL_COMMUNITY_SHEET, SAMPLE_COMMUNITY } from '@beanpool/core';

// MyDealsSheet draws the bean with require('…/bean.png'), which Metro resolves; here a number stands in, as on the phone.
(Module as any)._extensions['.png'] = (m: { exports: unknown }) => { m.exports = 1; };
(globalThis as any).__DEV__ = false;
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native', () => {
    const roles: Record<string, string> = { header: 'heading', button: 'button' };
    const el = (tag: string) => (props: Record<string, any>) => {
        const { children, onPress, accessibilityLabel, accessibilityRole, testID, numberOfLines } = props;
        const attrs: Record<string, unknown> = {};
        if (testID) attrs['data-testid'] = testID;
        // The press goes to the Pressable pressed, not to the ones around it, as RN's responder grants it.
        if (onPress) attrs.onClick = (e: { stopPropagation(): void }) => { e.stopPropagation(); onPress({ stopPropagation() {} }); };
        if (accessibilityLabel) attrs['aria-label'] = accessibilityLabel;
        if (accessibilityRole && roles[accessibilityRole]) attrs.role = roles[accessibilityRole];
        if (numberOfLines) attrs['data-lines'] = String(numberOfLines);
        attrs['data-style'] = JSON.stringify(Object.assign({}, ...[props.style].flat(3).filter(s => s && typeof s === 'object')));
        return createElement(tag, attrs, children);
    };
    return {
        Platform: { OS: 'android' },
        Image: el('img'),
        Dimensions: { get: () => ({ width: 320, height: 569, scale: 1.5, fontScale: 1.3 }) },
        // The list, its header first (what scrolls with it), as on the phone.
        FlatList: ({ data, renderItem, keyExtractor, ListHeaderComponent, ListEmptyComponent }: Record<string, any>) => createElement('div', { 'data-list': 'true' },
            ListHeaderComponent ?? null,
            data.length
                ? createElement('div', null, data.map((item: unknown, index: number) => createElement(Fragment, { key: keyExtractor(item) }, renderItem({ item, index }))))
                : ListEmptyComponent),
        View: el('div'), Text: el('span'), Pressable: el('button'), ScrollView: el('div'), TextInput: el('input'),
        Modal: ({ visible, children }: { visible: boolean; children?: unknown }) => (visible ? createElement('div', { 'data-modal': 'true' }, children as any) : null),
        StyleSheet: { create: (s: unknown) => s, hairlineWidth: 1, absoluteFill: {} },
        Alert: { alert: vi.fn() },
        useWindowDimensions: () => ({ width: 320, height: 569, scale: 1.5, fontScale: 1.3 }),
    };
});
const routes = vi.hoisted(() => ({ pushed: [] as unknown[] }));
vi.mock('expo-router', () => ({
    router: { push: (to: unknown) => routes.pushed.push(to), navigate: (to: unknown) => routes.pushed.push(to) },
}));
const store = vi.hoisted(() => ({ map: new Map<string, string>() }));
vi.mock('@react-native-async-storage/async-storage', () => ({
    default: {
        getItem: vi.fn(async (k: string) => store.map.get(k) ?? null),
        setItem: vi.fn(async (k: string, v: string) => { store.map.set(k, v); }),
        removeItem: vi.fn(async (k: string) => { store.map.delete(k); }),
    },
}));
vi.mock('@expo/vector-icons', () => ({ MaterialCommunityIcons: () => createElement('span', { 'data-icon': 'true' }) }));
vi.mock('expo-image', () => ({ Image: () => createElement('img') }));
vi.mock('../../components/MemberAvatar', () => ({ MemberAvatar: () => createElement('span', { 'data-avatar': 'true' }) }));
// The review form writes; in preview it must never open.
const review = vi.hoisted(() => ({ opened: 0, txIds: [] as string[] }));
vi.mock('../../components/ReviewModal', () => ({ ReviewModal: ({ txId }: { txId: string }) => { review.opened++; review.txIds.push(txId); return createElement('div', { 'data-testid': 'review-modal' }); } }));
// Light or dark: the two sets the phone has (docs/brand-colours.md).
const theme = vi.hoisted(() => ({ dark: false }));
vi.mock('../../app/ThemeContext', async () => {
    const { lightColors: light, darkColors: dark } = await import('../../constants/colors');
    const colors = () => (theme.dark ? dark : light);
    return {
        useTheme: () => ({ theme: theme.dark ? 'dark' : 'light', colors: colors() }),
        useStyles: (make: (t: { theme: string; colors: unknown }) => unknown) => make({ theme: theme.dark ? 'dark' : 'light', colors: colors() }),
    };
});
// The explainers are the member's own; here only that one opens.
vi.mock('../../components/CommonsInfoModal', () => ({
    CommonsInfoModal: ({ isOpen }: { isOpen: boolean }) => (isOpen ? createElement('div', { 'data-testid': 'commons-info' }, 'About the Commons') : null),
}));
// The net spy's third arm: every call into the node client is recorded (My Deals imports it; its preview must call
// nothing). Every export by name, each a function that records its call (net-spy-db.ts).
const net = vi.hoisted(() => ({ calls: [] as string[] }));
vi.mock('../db', async () => (await import('./net-spy-db')).dbStandIn(net.calls));

import { LocalCommunityMark, LocalCommunitySheet, markTone } from '../../components/showcase/LocalCommunityMark';
import { CommonsPreview } from '../../components/showcase/Previews';
import { MyDealsSheet } from '../../components/MyDealsSheet';
import { YourBeansPreviewCard } from '../../components/showcase/YourBeansPreviewCard';
import * as db from '../db';
import { pressEverything } from './press-everything';

import { LocalCommunityMark, SHEET_ROUTES } from '../../components/showcase/LocalCommunityMark';
import { MyDealsSheet } from '../../components/MyDealsSheet';

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    routes.pushed.length = 0;
    net.calls.length = 0;
    store.map.clear();
    store.map.set('beanpool_anchor_url', 'https://global.example');
    globalThis.fetch = vi.fn(async () => { net.calls.push('fetch'); return new Response('{}'); }) as typeof fetch;
    (globalThis as any).XMLHttpRequest = class { open() { net.calls.push('xhr'); } send() { net.calls.push('xhr'); } setRequestHeader() {} };
    (globalThis as any).WebSocket = class { constructor() { net.calls.push('ws'); } };
});
afterEach(() => { act(() => root.unmount()); host.remove(); });

const render = async (node: unknown) => { await act(async () => { root.render(node as any); }); await act(async () => {}); };
const styleOf = (el: Element | null) => JSON.parse(el?.getAttribute('data-style') || '{}');
const text = () => host.textContent ?? '';
const press = async (el: Element) => { await act(async () => { (el as HTMLElement).click(); }); await act(async () => {}); };


describe('My Deals in preview: every way forward closes My Deals before it routes', () => {
    const waysOut = [LOCAL_COMMUNITY_SHEET.start, LOCAL_COMMUNITY_SHEET.nearYou, LOCAL_COMMUNITY_SHEET.howItWorks];
    let closedWhenPushed: number[];
    const openDeals = async () => {
        closedWhenPushed = [];
        await render(createElement(MyDealsSheet, {
            visible: true, identity: { publicKey: 'a-real-member' }, preview: true,
            onClose: () => { closedWhenPushed.push(routes.pushed.length); },
        }));
    };
    const buttonIn = (scope: string, label: string) =>
        Array.from(host.querySelectorAll(`${scope} button`)).find(b => b.textContent === label)!;
    const expectClosedThenRouted = () => {
        // Told to close once, before the one route was pushed.
        expect(closedWhenPushed).toEqual([0]);
        expect(routes.pushed).toHaveLength(1);
    };

    for (const label of [LOCAL_COMMUNITY_SHEET.start, LOCAL_COMMUNITY_SHEET.nearYou]) {
        it(`the strip's "${label}"`, async () => {
            await openDeals();
            await press(buttonIn('[data-testid="local-community-strip"]', label));
            expectClosedThenRouted();
        });
    }

    for (const label of waysOut) {
        it(`the strip's pill, then the sheet's "${label}": the sheet and My Deals both close`, async () => {
            await openDeals();
            await press(host.querySelector('[data-testid="local-community-strip"] [aria-label$="why?"]')!);
            await press(buttonIn('[data-testid="local-community-sheet"]', label));
            expectClosedThenRouted();
            expect(host.querySelector('[data-testid="local-community-sheet"]')).toBeNull();
        });

        it(`an example deal, then the sheet's "${label}": the sheet and My Deals both close`, async () => {
            await openDeals();
            const waiting = SAMPLE_COMMUNITY.deals.find(d => d.status === 'waiting-on-you')!;
            await press(Array.from(host.querySelectorAll('button')).filter(b => b.textContent?.includes(waiting.what)).pop()!);
            await press(buttonIn('[data-testid="local-community-sheet"]', label));
            expectClosedThenRouted();
            expect(host.querySelector('[data-testid="local-community-sheet"]')).toBeNull();
        });
    }

    it('a marker outside a Modal routes as before, with nothing to close', async () => {
        await render(createElement(LocalCommunityMark, { variant: 'strip', feature: 'escrow' }));
        await press(buttonIn('[data-testid="local-community-strip"]', LOCAL_COMMUNITY_SHEET.start));
        expect(routes.pushed).toEqual([SHEET_ROUTES.start]);
    });
});
