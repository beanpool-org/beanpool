// @vitest-environment jsdom
/**
 * The showcase on the phone rendered for real (scratch/global-node/DESIGN-global-showcase-fable.md §2, §6 W3): the marker
 * (strip expanded and collapsed, pill, action, line), its sheet, the Commons and My Deals previews and Home's Your Beans
 * card, in the real light and dark palettes, at 320 dp and 1.3× text. React Native's host components are plain tags
 * carrying their accessibility props and flattened style (as enterprise-decisions-render.test.ts).
 *
 * The net spy: fetch, XMLHttpRequest, WebSocket and every export of utils/db are spied; every button on every preview
 * is pressed; nothing may be asked of a node, let alone written.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { LOCAL_COMMUNITY_SHEET, LOCAL_COMMUNITY_STRIP, LOCAL_COMMUNITY_LINES, SAMPLE_COMMUNITY } from '@beanpool/core';
import { darkColors, lightColors } from '../../constants/colors';

(globalThis as any).__DEV__ = false;
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native', () => {
    const roles: Record<string, string> = { header: 'heading', button: 'button' };
    const el = (tag: string) => (props: Record<string, any>) => {
        const { children, onPress, accessibilityLabel, accessibilityRole, testID, numberOfLines } = props;
        const attrs: Record<string, unknown> = {};
        if (testID) attrs['data-testid'] = testID;
        if (onPress) attrs.onClick = () => onPress({ stopPropagation() {} });
        if (accessibilityLabel) attrs['aria-label'] = accessibilityLabel;
        if (accessibilityRole && roles[accessibilityRole]) attrs.role = roles[accessibilityRole];
        if (numberOfLines) attrs['data-lines'] = String(numberOfLines);
        attrs['data-style'] = JSON.stringify(Object.assign({}, ...[props.style].flat(3).filter(s => s && typeof s === 'object')));
        return createElement(tag, attrs, children);
    };
    return {
        Platform: { OS: 'android' },
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
// The net spy's third arm: any use of the node client is recorded.
const net = vi.hoisted(() => ({ calls: [] as string[] }));
vi.mock('../db', () => new Proxy({}, { get: (_t, k) => { if (typeof k === 'string' && k !== 'then') net.calls.push(`db.${k}`); return vi.fn(); } }));

import { LocalCommunityMark, LocalCommunitySheet, markTone } from '../../components/showcase/LocalCommunityMark';
import { CommonsPreview, DealsPreview } from '../../components/showcase/Previews';
import { YourBeansPreviewCard } from '../../components/showcase/YourBeansPreviewCard';

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

/** WCAG contrast of two #rrggbb colours. */
function contrast(a: string, b: string): number {
    const lum = (hex: string) => {
        const n = hex.replace('#', '');
        const [r, g, bl] = [0, 2, 4].map(i => parseInt(n.slice(i, i + 2), 16) / 255).map(c => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
        return 0.2126 * r + 0.7152 * g + 0.0722 * bl;
    };
    const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
    return (x + 0.05) / (y + 0.05);
}

for (const scheme of ['light', 'dark'] as const) {
    const colors = scheme === 'dark' ? darkColors : lightColors;
    describe(`the showcase in ${scheme} at 320 dp and 1.3× text`, () => {
        beforeEach(() => { theme.dark = scheme === 'dark'; });

        it('the marker reads in the info tone on its own background, and is never greyed, faded or locked', () => {
            const tone = markTone(colors);
            expect(tone).toEqual({ fg: colors.feedback.info.fg, bg: colors.feedback.info.bg, border: colors.feedback.info.border });
            expect(contrast(tone.fg, tone.bg)).toBeGreaterThanOrEqual(4.5);
            expect(contrast(colors.text.body, tone.bg)).toBeGreaterThanOrEqual(4.5);
            expect(contrast(colors.surface.card, tone.fg)).toBeGreaterThanOrEqual(4.5);
        });

        it('the strip: words, a dashed info border, buttons that stack full width; ✕ collapses it and remembers', async () => {
            await render(createElement(LocalCommunityMark, { variant: 'strip', feature: 'beans' }));
            const strip = host.querySelector('[data-testid="local-community-strip"]')!;
            expect(text()).toContain(LOCAL_COMMUNITY_STRIP.lead.beans);
            expect(text()).toContain(LOCAL_COMMUNITY_STRIP.body);
            expect(styleOf(strip)).toMatchObject({ borderStyle: 'dashed', borderWidth: 1, backgroundColor: colors.feedback.info.bg, borderColor: colors.feedback.info.border });
            expect(styleOf(strip).opacity).toBeUndefined();
            const buttons = [...strip.querySelectorAll('button')].filter(b => /Start a community|Communities near you/.test(b.textContent ?? ''));
            expect(buttons).toHaveLength(2);
            for (const b of buttons) expect(styleOf(b)).toMatchObject({ alignSelf: 'stretch', minHeight: 48 });
            const pillText = [...strip.querySelectorAll('span')].find(s => /Local community/.test(s.textContent ?? ''))!;
            expect(pillText.getAttribute('data-lines')).toBe('1');
            await press(host.querySelector('[aria-label="Make this shorter"]')!);
            expect(text()).toContain(LOCAL_COMMUNITY_STRIP.collapsed);
            expect(text()).not.toContain(LOCAL_COMMUNITY_STRIP.body);
            expect(store.map.get('beanpool_showcase_strip:https://global.example:beans')).toBe('1');
        });

        it('every variant opens the one sheet: the feature line, the common line, and the three ways forward', async () => {
            await render(createElement('div', null,
                createElement(LocalCommunityMark, { variant: 'pill', feature: 'decisions' }),
                createElement(LocalCommunityMark, { variant: 'action', feature: 'escrow', label: 'Request · Beans held safely' }),
                createElement(LocalCommunityMark, { variant: 'line', feature: 'invites', text: LOCAL_COMMUNITY_LINES.invites })));
            const action = host.querySelector('[data-testid="local-community-action"]')!;
            expect(styleOf(action)).toMatchObject({ borderStyle: 'dashed', minHeight: 48 });
            await press(action);
            const sheet = host.querySelector('[data-testid="local-community-sheet"]')!;
            expect(sheet.textContent).toContain(LOCAL_COMMUNITY_SHEET.features.escrow);
            expect(sheet.textContent).toContain(LOCAL_COMMUNITY_SHEET.common);
            expect(styleOf(sheet).backgroundColor).toBe(colors.surface.card);
            for (const w of [LOCAL_COMMUNITY_SHEET.start, LOCAL_COMMUNITY_SHEET.nearYou, LOCAL_COMMUNITY_SHEET.howItWorks]) expect(sheet.textContent).toContain(w);
            const how = [...sheet.querySelectorAll('button')].find(b => b.textContent === LOCAL_COMMUNITY_SHEET.howItWorks)!;
            await press(how);
            expect(routes.pushed).toEqual([{ pathname: '/guide/[slug]', params: { slug: LOCAL_COMMUNITY_SHEET.guide.escrow } }]);
        });

        it('the sheet on its own: Start a community and Communities near you go to their screens', async () => {
            const onClose = vi.fn();
            await render(createElement(LocalCommunitySheet, { feature: 'beans', visible: true, onClose }));
            const buttons = [...host.querySelectorAll('[data-testid="local-community-sheet"] button')];
            await press(buttons.find(b => b.textContent === LOCAL_COMMUNITY_SHEET.start)!);
            await press(buttons.find(b => b.textContent === LOCAL_COMMUNITY_SHEET.nearYou)!);
            expect(routes.pushed).toEqual(['/start-community', '/find-community']);
            expect(onClose).toHaveBeenCalledTimes(2);
        });

        it('Commons in preview: the pool, the Bakery, the Decision; Pledge, Pause and Vote open the sheet', async () => {
            await render(createElement(CommonsPreview));
            expect(text()).toContain('Example Valley');
            expect(text()).toContain(SAMPLE_COMMUNITY.enterprises[0].name);
            expect(text()).toContain(SAMPLE_COMMUNITY.decisions[0].question);
            expect(text()).toContain('640 Beans');
            expect(text()).not.toMatch(/Ʀ|🔒/);
            for (const label of ['Pledge', 'Pause', 'Vote']) {
                const b = [...host.querySelectorAll('[data-testid="local-community-action"]')].find(x => x.textContent?.startsWith(label))!;
                await press(b);
                expect(host.querySelector('[data-testid="local-community-sheet"]')).not.toBeNull();
            }
            await press(host.querySelector('[aria-label="About the Commons"]')!);
            expect(host.querySelector('[data-testid="commons-info"]')).not.toBeNull();
        });

        it('My Deals in preview: one deal waiting on you, one done; approving opens the sheet', async () => {
            await render(createElement(DealsPreview));
            for (const d of SAMPLE_COMMUNITY.deals) expect(text()).toContain(d.what);
            expect(text()).toContain('40 Beans held safely');
            await press(host.querySelector('[data-testid="local-community-action"]')!);
            expect(host.querySelector('[data-testid="local-community-sheet"]')?.textContent).toContain(LOCAL_COMMUNITY_SHEET.features.escrow);
        });

        it("Home's Your Beans card: the pill, the sentence, and the link to the example ledger", async () => {
            await render(createElement(YourBeansPreviewCard, { colors }));
            expect(text()).toContain(LOCAL_COMMUNITY_LINES.yourBeansCard);
            await press(host.querySelector('[data-testid="home-beans-preview-ledger"]') ?? [...host.querySelectorAll('button')].find(b => b.textContent?.includes('See an example ledger'))!);
            expect(routes.pushed).toContain('/(tabs)/ledger');
        });

        it('the net spy: every press on every preview asks nothing of a node and writes nothing', async () => {
            await render(createElement('div', null,
                createElement(LocalCommunityMark, { variant: 'strip', feature: 'beans' }),
                createElement(CommonsPreview), createElement(DealsPreview), createElement(YourBeansPreviewCard, { colors })));
            // Every button, twice over (the sheet's own buttons appear once a marker is pressed).
            for (let round = 0; round < 2; round++) for (const b of [...host.querySelectorAll('button')]) if (b.isConnected) await press(b);
            // The presses ran (each of the ways forward was taken), and none of them reached a node.
            expect(routes.pushed).toEqual(expect.arrayContaining(['/start-community', '/find-community', '/(tabs)/ledger']));
            expect(net.calls).toEqual([]);
        });
    });
}
