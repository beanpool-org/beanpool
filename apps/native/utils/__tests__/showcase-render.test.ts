// @vitest-environment jsdom
/**
 * The showcase on the phone rendered for real (scratch/global-node/DESIGN-global-showcase-fable.md §2, §6 W3): the marker
 * (strip expanded and collapsed, pill, action, line), its sheet, the Commons preview, the member's own My Deals sheet fed
 * Example Valley, and Home's Your Beans
 * card, in the real light and dark palettes, at 320 dp and 1.3× text. React Native's host components are plain tags
 * carrying their accessibility props and flattened style (as enterprise-decisions-render.test.ts).
 *
 * The net spy: fetch, XMLHttpRequest, WebSocket and every export of utils/db are spied (net-spy-db.ts); every button on
 * every preview is pressed; nothing may be asked of a node, let alone written.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Module from 'node:module';
import { act, createElement, Fragment } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { LOCAL_COMMUNITY_EMOJI, LOCAL_COMMUNITY_MARK, LOCAL_COMMUNITY_SHEET, LOCAL_COMMUNITY_STRIP, LOCAL_COMMUNITY_LINES, SAMPLE_COMMUNITY } from '@beanpool/core';
import { darkColors, lightColors, type AppColors } from '../../constants/colors';

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
        if (onPress) attrs.onClick = () => onPress({ stopPropagation() {} });
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
import { DecideSection } from '../../components/DecideSection';
import { sampleDecisions, samplePoolVoting } from '../../components/showcase/sample-screens';
import { MyDealsSheet } from '../../components/MyDealsSheet';
import { YourBeansPreviewCard } from '../../components/showcase/YourBeansPreviewCard';
import * as db from '../db';
import { pressEverything } from './press-everything';

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

describe('the net spy\'s utils/db arm', () => {
    it('records a call through a named import, as the screens import it, and never reads as a promise', async () => {
        const { getMarketplaceTransactions, getPosts, getBalance, sendTransfer } = db;
        void getMarketplaceTransactions('k'); void getPosts(); void getBalance('k'); void sendTransfer('k', 'j', 1, '');
        expect(net.calls).toEqual(['db.getMarketplaceTransactions', 'db.getPosts', 'db.getBalance', 'db.sendTransfer']);
        expect('then' in db).toBe(false);
        expect(new db.RouteMissingError('/api/x')).toBeInstanceOf(Error);
        expect(db.REDEEM_NO_ANSWER).toMatch(/No answer/);
    });
});

/** The hue of a #rrggbb colour, in degrees. */
function hue(hex: string): number {
    const [r, g, b] = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255);
    const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
    if (d === 0) return 0;
    const h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
    return (h * 60 + 360) % 360;
}

// Review of #1852, finding 6: earth's info tone is terra (4.17:1 on its own box, 4.42:1 on the card), and slate's dashed
// border faded into the card (1.49:1). Light and dark (Earth and Slate are gone).
describe('the marker in every palette', () => {
    const palettes: Array<[string, AppColors, () => void]> = [
        ['light', lightColors, () => { theme.dark = false; }],
        ['dark', darkColors as unknown as AppColors, () => { theme.dark = true; }],
    ];
    afterEach(() => { theme.dark = false; });
    for (const [name, colors, use] of palettes) {
        it(`${name}: its words read at 4.5:1 or more on its own box, the card and the page, in a blue, never amber or red; its dashed edge at 3:1 on the card`, async () => {
            use();
            const tone = markTone(colors);
            for (const behind of [tone.bg, colors.surface.card, colors.surface.page]) expect(contrast(tone.fg, behind), behind).toBeGreaterThanOrEqual(4.5);
            expect(contrast(colors.text.body, tone.bg)).toBeGreaterThanOrEqual(4.5);
            expect(contrast(tone.border, colors.surface.card)).toBeGreaterThanOrEqual(3);
            expect(hue(tone.fg)).toBeGreaterThanOrEqual(200);
            expect(hue(tone.fg)).toBeLessThanOrEqual(260);
            // Drawn in that tone: the strip's pill and second button, the action's words, the line, the sheet's Start.
            await render(createElement('div', null,
                createElement(LocalCommunityMark, { variant: 'strip', feature: 'beans' }),
                createElement(LocalCommunityMark, { variant: 'action', feature: 'beans', label: 'Send Beans' }),
                createElement(LocalCommunityMark, { variant: 'line', feature: 'beans', text: LOCAL_COMMUNITY_LINES.poll })));
            const strip = host.querySelector('[data-testid="local-community-strip"]')!;
            expect(styleOf(strip)).toMatchObject({ borderColor: tone.border, backgroundColor: tone.bg });
            const pills = Array.from(host.querySelectorAll('span')).filter(x => x.textContent === `${LOCAL_COMMUNITY_EMOJI} ${LOCAL_COMMUNITY_MARK}`);
            expect(pills.length).toBe(2);
            for (const pill of pills) expect(styleOf(pill).color).toBe(tone.fg);
            const action = host.querySelector('[data-testid="local-community-action"]')!;
            expect(styleOf(action).borderColor).toBe(tone.border);
            expect(styleOf(Array.from(action.querySelectorAll('span')).find(x => x.textContent === 'Send Beans')!).color).toBe(tone.fg);
            expect(styleOf(Array.from(host.querySelectorAll('span')).find(x => x.textContent === LOCAL_COMMUNITY_LINES.poll)!).color).toBe(tone.fg);
            await press(Array.from(host.querySelectorAll('button')).find(b => b.textContent === LOCAL_COMMUNITY_LINES.poll)!);
            const start = Array.from(host.querySelectorAll('[data-testid="local-community-sheet"] button')).find(b => b.textContent === LOCAL_COMMUNITY_SHEET.start)!;
            expect(styleOf(start).backgroundColor).toBe(tone.fg);
            expect(contrast(styleOf(start.querySelector('span')).color, tone.fg)).toBeGreaterThanOrEqual(4.5);
        });
    }
});

for (const scheme of ['light', 'dark'] as const) {
    const colors: AppColors = scheme === 'dark' ? (darkColors as unknown as AppColors) : lightColors;
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
            expect(text()).toContain(LOCAL_COMMUNITY_STRIP.body.beans);
            expect(styleOf(strip)).toMatchObject({ borderStyle: 'dashed', borderWidth: 1, backgroundColor: colors.feedback.info.bg, borderColor: colors.feedback.info.border });
            expect(styleOf(strip).opacity).toBeUndefined();
            const buttons = Array.from(strip.querySelectorAll('button')).filter(b => /Start a community|Communities near you/.test(b.textContent ?? ''));
            expect(buttons).toHaveLength(2);
            for (const b of buttons) expect(styleOf(b)).toMatchObject({ alignSelf: 'stretch', minHeight: 48 });
            const pillText = Array.from(strip.querySelectorAll('span')).find(s => /Local community/.test(s.textContent ?? ''))!;
            expect(pillText.getAttribute('data-lines')).toBe('1');
            await press(host.querySelector('[aria-label="Make this shorter"]')!);
            expect(text()).toContain(LOCAL_COMMUNITY_STRIP.collapsed);
            expect(text()).not.toContain(LOCAL_COMMUNITY_STRIP.body.beans);
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
            const how = Array.from(sheet.querySelectorAll('button')).find(b => b.textContent === LOCAL_COMMUNITY_SHEET.howItWorks)!;
            await press(how);
            expect(routes.pushed).toEqual([{ pathname: '/guide/[slug]', params: { slug: LOCAL_COMMUNITY_SHEET.guide.escrow } }]);
        });

        it("the strip's pill opens the sheet too: tapping any variant does (design §2)", async () => {
            await render(createElement(LocalCommunityMark, { variant: 'strip', feature: 'beans' }));
            const pill = host.querySelector(`[data-testid="local-community-strip"] [aria-label="${LOCAL_COMMUNITY_MARK}: why?"]`)!;
            expect(pill).not.toBeNull();
            await press(pill);
            expect(host.querySelector('[data-testid="local-community-sheet"]')?.textContent).toContain(LOCAL_COMMUNITY_SHEET.features.beans);
        });

        it('the sheet on its own: Start a community and Communities near you go to their screens', async () => {
            const onClose = vi.fn();
            await render(createElement(LocalCommunitySheet, { feature: 'beans', visible: true, onClose }));
            const buttons = Array.from(host.querySelectorAll('[data-testid="local-community-sheet"] button'));
            await press(buttons.find(b => b.textContent === LOCAL_COMMUNITY_SHEET.start)!);
            await press(buttons.find(b => b.textContent === LOCAL_COMMUNITY_SHEET.nearYou)!);
            expect(routes.pushed).toEqual(['/start-community', '/find-community']);
            expect(onClose).toHaveBeenCalledTimes(2);
        });

        it('Commons in preview: the pool and the Bakery; Pledge and Pause open the sheet', async () => {
            await render(createElement(CommonsPreview));
            expect(text()).toContain('Example Valley');
            expect(text()).toContain(SAMPLE_COMMUNITY.enterprises[0].name);
            expect(text()).not.toContain(SAMPLE_COMMUNITY.decisions[0].question);
            expect(text()).toContain('640 Beans');
            expect(text()).not.toMatch(/Ʀ|🔒/);
            for (const label of ['Pledge', 'Pause']) {
                const b = Array.from(host.querySelectorAll('[data-testid="local-community-action"]')).find(x => x.textContent?.startsWith(label))!;
                await press(b);
                expect(host.querySelector('[data-testid="local-community-sheet"]')).not.toBeNull();
            }
            await press(host.querySelector('[aria-label="About the Commons"]')!);
            expect(host.querySelector('[data-testid="commons-info"]')).not.toBeNull();
        });

        it('DecideSection in preview: the sample Decision, tags, turnout, tally, Vote YES/NO and Propose open the sheet, no lock icon', async () => {
            await render(createElement(DecideSection, {
                preview: true,
                decisions: sampleDecisions(),
                myPoolVoting: samplePoolVoting(),
                identity: { publicKey: 'a-real-member' } as any,
                balanceState: { earnedCredit: 0, commons: 640 },
                activeView: 'open',
                onChangeView: () => {},
                onRefresh: async () => {},
                onOpenPropose: () => {},
                canPropose: true,
                hasOpenDecision: true,
            }));

            expect(text()).toContain('Example Valley');
            expect(text()).toContain(SAMPLE_COMMUNITY.decisions[0].question);
            expect(text()).toContain('Touches: pool');
            expect(text()).toContain('Grant Enterprise');
            expect(text()).toContain('Quadratic');
            expect(text()).toContain('9 of 6 votes needed');
            expect(text()).toContain('Met ✅');
            expect(text()).toContain('Yes 12 (86%) · No 2');
            expect(text()).toContain('Needs 60%');
            expect(text()).toContain('582 voice credits');
            expect(text()).not.toMatch(/Ʀ|🔒/);

            for (const label of ['+ Propose a Decision', '👍 Vote YES', '👎 Vote NO']) {
                const b = Array.from(host.querySelectorAll('[data-testid="local-community-action"]')).find(x => x.textContent?.includes(label))!;
                expect(b).toBeDefined();
                await press(b);
                expect(host.querySelector('[data-testid="local-community-sheet"]')).not.toBeNull();
            }
            expect(host.querySelector('[data-testid="voice-credits-card"]')?.textContent).toContain('582');
            expect(net.calls).toEqual([]);
        });

        it("My Deals in preview is the member's own sheet fed Example Valley: the deal waiting on you, the one held safely, the one sold; every press opens the sheet", async () => {
            review.opened = 0;
            await render(createElement(MyDealsSheet, { visible: true, identity: { publicKey: 'a-real-member' }, onClose: () => {}, preview: true }));
            const sheetText = () => host.querySelector('[data-testid="local-community-sheet"]')?.textContent ?? '';
            expect(host.querySelector('[data-testid="local-community-strip"]')).not.toBeNull();
            expect(text()).toContain('Example Valley · an example member');
            const waiting = SAMPLE_COMMUNITY.deals.find(d => d.status === 'waiting-on-you')!;
            const held = SAMPLE_COMMUNITY.deals.find(d => d.status === 'held')!;
            const done = SAMPLE_COMMUNITY.deals.find(d => d.status === 'done')!;
            // In Progress: the deal waiting on you (requested: Action Required) and the one whose Beans are held, amounts drawn.
            expect(text()).toContain(waiting.what);
            expect(text()).toContain('Action Required');
            expect(text()).toContain(String(waiting.amount));
            expect(text()).toContain(held.what);
            expect(text()).toContain('Held in Trust');
            expect(text()).toContain(String(held.amount));
            const cardText = (id: string) => host.querySelector(`[data-testid="deal-card-${id}-post"]`)?.textContent ?? '';
            expect(cardText(waiting.id)).toContain('Action Required');
            expect(cardText(held.id)).toContain('Held in Trust');
            expect(text()).not.toMatch(/Ʀ|🔒/);
            const card = Array.from(host.querySelectorAll('button')).filter(b => b.textContent?.includes(waiting.what)).pop()!;
            await press(card);
            expect(sheetText()).toContain(LOCAL_COMMUNITY_SHEET.features.escrow);
            expect(routes.pushed).toEqual([]);
            // History: the one done, which the member SOLD, so + 30 as on the Ledger's row; Review opens the sheet, never the review form.
            await press(Array.from(host.querySelectorAll('button')).find(b => b.textContent === 'History')!);
            expect(text()).toContain(done.what);
            expect(text()).toContain(`+ ${done.amount}`);
            expect(text()).not.toContain(`- ${done.amount}`);
            expect(SAMPLE_COMMUNITY.transactions.find(t => t.what === done.what)?.amount).toBe(done.amount);
            await press(Array.from(host.querySelectorAll('button')).find(b => b.textContent === 'Review')!);
            expect(sheetText()).toContain(LOCAL_COMMUNITY_SHEET.features.escrow);
            expect(review.opened).toBe(0);
            expect(routes.pushed).toEqual([]);
            expect(net.calls).toEqual([]);
        });

        it('My Deals in preview at 320 dp: the strip and Example head the scrolling list, so the tabs and a deal show on open', async () => {
            await render(createElement(MyDealsSheet, { visible: true, identity: { publicKey: 'a-real-member' }, onClose: () => {}, preview: true }));
            const head = host.querySelector('[data-testid="deals-preview-head"]')!;
            expect(head.querySelector('[data-testid="local-community-strip"]')).not.toBeNull();
            expect(head.textContent).toContain('Example Valley · an example member');
            // The head is the list's header: inside the list, before its first deal, so it scrolls away with the deals.
            const list = head.closest('[data-list]')!;
            expect(list).not.toBeNull();
            expect(list.firstElementChild).toBe(head);
            const waiting = SAMPLE_COMMUNITY.deals.find(d => d.status === 'waiting-on-you')!;
            expect(list.textContent).toContain(waiting.what);
            // The tabs stay in the fixed head above the list, outside what scrolls.
            const inProgress = Array.from(host.querySelectorAll('button')).find(b => b.textContent?.startsWith('In Progress'))!;
            expect(list.contains(inProgress)).toBe(false);
            expect(inProgress.compareDocumentPosition(list) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
            // Nothing else holds the strip: one strip on the sheet.
            expect(host.querySelectorAll('[data-testid="local-community-strip"]')).toHaveLength(1);
        });

        it('My Deals live: no preview head in the list', async () => {
            await render(createElement(MyDealsSheet, { visible: true, identity: { publicKey: 'a-real-member' }, onClose: () => {}, preview: false }));
            expect(host.querySelector('[data-testid="deals-preview-head"]')).toBeNull();
            expect(host.querySelector('[data-testid="local-community-strip"]')).toBeNull();
        });

        it('My Deals in preview, then live while open (the node\'s switch, or the reader\'s own set): Example Valley is gone at once, and no press reaches a sample id', async () => {
            review.opened = 0;
            review.txIds.length = 0;
            const props = { visible: true, identity: { publicKey: 'a-real-member' }, onClose: () => {} };
            await render(createElement(MyDealsSheet, { ...props, preview: true }));
            const waiting = SAMPLE_COMMUNITY.deals.find(d => d.status === 'waiting-on-you')!;
            const done = SAMPLE_COMMUNITY.deals.find(d => d.status === 'done')!;
            expect(text()).toContain(waiting.what);
            // Live now; the member's own deals haven't landed (the node client answers nothing yet).
            await render(createElement(MyDealsSheet, { ...props, preview: false }));
            await act(async () => {});
            expect(host.querySelector('[data-testid="local-community-strip"]')).toBeNull();
            expect(net.calls).toEqual(expect.arrayContaining(['db.getPosts']));
            expect(text()).not.toContain(waiting.what);
            expect(text()).not.toContain('Example Valley');
            await press(Array.from(host.querySelectorAll('button')).find(b => b.textContent === 'History')!);
            expect(text()).not.toContain(done.what);
            expect(Array.from(host.querySelectorAll('button')).find(b => b.textContent === 'Review')).toBeUndefined();
            // Every button left, pressed: nothing routes to, or opens a form on, an id from the sample.
            const pressed = new Set<Element>();
            for (let i = 0; i < 60; i++) {
                const next = Array.from(host.querySelectorAll('button')).find(b => !pressed.has(b));
                if (!next) break;
                pressed.add(next);
                await press(next);
            }
            expect(JSON.stringify(routes.pushed)).not.toMatch(/sample-/);
            expect(review.txIds.join(' ')).not.toMatch(/sample-/);
        });

        it("Home's Your Beans card: the pill, the sentence, and the link to the example ledger", async () => {
            await render(createElement(YourBeansPreviewCard, { colors }));
            expect(text()).toContain(LOCAL_COMMUNITY_LINES.yourBeansCard);
            await press(host.querySelector('[data-testid="home-beans-preview-ledger"]') ?? Array.from(host.querySelectorAll('button')).find(b => b.textContent?.includes('See an example ledger'))!);
            expect(routes.pushed).toContain('/(tabs)/ledger');
        });

        it("Home's Your Beans card hides on its own, remembered for this community, and stays hidden when Home draws again", async () => {
            await render(createElement('div', null,
                createElement('div', { 'data-testid': 'steps-stand-in' }, 'First steps'), createElement(YourBeansPreviewCard, { colors })));
            const hide = host.querySelector('[data-testid="home-beans-preview-hide"]')!;
            // The name holds the words on the button (WCAG 2.5.3, label in name: review of #1852, finding 8).
            expect(hide.getAttribute('aria-label')).toBe('Hide this card: Your Beans');
            expect(hide.getAttribute('aria-label')).toContain(hide.textContent);
            await press(hide);
            expect(host.querySelector('[data-testid="home-card-beans-preview"]')).toBeNull();
            expect(text()).toContain('First steps');
            expect(store.map.get('beanpool_showcase_card:https://global.example:beans')).toBe('1');
            await render(createElement('div', null));
            await render(createElement(YourBeansPreviewCard, { colors }));
            expect(host.querySelector('[data-testid="home-card-beans-preview"]')).toBeNull();
            // Another community on this phone still shows it.
            store.map.set('beanpool_anchor_url', 'https://other.example');
            await render(createElement('div', null));
            await render(createElement(YourBeansPreviewCard, { colors }));
            expect(host.querySelector('[data-testid="home-card-beans-preview"]')).not.toBeNull();
            expect(net.calls).toEqual([]);
        });

        it('the net spy: every press on every preview asks nothing of a node and writes nothing', async () => {
            await render(createElement('div', null,
                createElement(LocalCommunityMark, { variant: 'strip', feature: 'beans' }),
                createElement(CommonsPreview), createElement(YourBeansPreviewCard, { colors }),
                createElement(MyDealsSheet, { visible: true, identity: null, onClose: () => {}, preview: true })));
            // Every button, asked afresh after each press; each one that opens the sheet, then every button in the sheet,
            // reopened for each (press-everything.ts); and the strip's ✕ last, since it folds the strip's buttons away.
            const { pressed, sheetPresses } = await pressEverything(host, press, { key: b => b, skip: b => b.getAttribute('aria-label') === 'Make this shorter' });
            expect(pressed.size).toBeGreaterThanOrEqual(15);
            // The sheet's own ways forward were pressed, from more than one marker.
            for (const way of [LOCAL_COMMUNITY_SHEET.start, LOCAL_COMMUNITY_SHEET.nearYou, LOCAL_COMMUNITY_SHEET.howItWorks]) {
                expect(sheetPresses.filter(x => x.endsWith(`→ ${way}`)).length, way).toBeGreaterThanOrEqual(5);
            }
            await press(host.querySelector('[aria-label="Make this shorter"]')!);
            // The presses ran (each of the ways forward was taken), and none of them reached a node.
            expect(routes.pushed).toEqual(expect.arrayContaining(['/start-community', '/find-community', '/(tabs)/ledger']));
            expect(net.calls).toEqual([]);
        });
    });
}
