// @vitest-environment jsdom
/**
 * The global-previews audit, part (a) (scratch/global-previews-audit/REPORT.md "#2020 against the rest" 1 and 3; PHONE.md
 * §3 item 3): the phone Ledger's words stay true in preview, and its marker actions fit at 320 dp and 1.3× text.
 *  - In preview (a node that previews Beans: global) the Levels perk "Invite Members" and the note's "Anyone can invite"
 *    are not shown: inviting is off there, and the Invites screen says so. Local keeps both.
 *  - Local's send says "Send Beans" (its words and its accessibility label), not "Send Credits": Beans is the currency.
 *  - In preview "Export CSV" with its 🏘️ pill is a full-width row of its own under RECENT TRANSACTIONS, like Send Beans;
 *    beside the heading it ran off the right edge at 320 dp. Local's plain Export CSV stays in the heading row.
 * The harness is showcase-ledger-render.test.ts's: the whole screen, the mode decided as on a phone.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Module from 'node:module';
import { act, createElement, Fragment } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import {
    LOCAL_COMMUNITY_EMOJI, LOCAL_COMMUNITY_MARK, LOCAL_COMMUNITY_SHEET, LOCAL_COMMUNITY_STRIP, SAMPLE_COMMUNITY, TIER_LEVELS,
} from '@beanpool/core';
import { darkColors, lightColors, type AppColors } from '../../constants/colors';

// The Ledger draws the bean with require('…/bean.png'), which Metro resolves; here a number stands in, as on the phone.
(Module as any)._extensions['.png'] = (m: { exports: unknown }) => { m.exports = 1; };
(globalThis as any).__DEV__ = false;
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const alerts = vi.hoisted(() => ({ shown: [] as string[] }));
vi.mock('react-native', () => {
    const roles: Record<string, string> = { header: 'heading', button: 'button' };
    const el = (tag: string) => (props: Record<string, any>) => {
        const { children, onPress, accessibilityLabel, accessibilityRole, testID, numberOfLines } = props;
        const attrs: Record<string, unknown> = {};
        if (testID) attrs['data-testid'] = testID;
        if (onPress) attrs.onClick = (e: { stopPropagation(): void }) => { e.stopPropagation(); onPress({ stopPropagation() {} }); };
        if (accessibilityLabel) attrs['aria-label'] = accessibilityLabel;
        if (accessibilityRole && roles[accessibilityRole]) attrs.role = roles[accessibilityRole];
        if (numberOfLines) attrs['data-lines'] = String(numberOfLines);
        attrs['data-style'] = JSON.stringify(Object.assign({}, ...[props.style].flat(3).filter(s => s && typeof s === 'object')));
        return createElement(tag, attrs, children);
    };
    const listener = () => ({ remove() {} });
    return {
        Platform: { OS: 'android', select: (o: Record<string, unknown>) => o.android ?? o.default },
        Image: el('img'),
        Dimensions: { get: () => ({ width: 320, height: 569, scale: 1.5, fontScale: 1.3 }) },
        FlatList: ({ data, renderItem, keyExtractor, ListHeaderComponent, ListEmptyComponent }: Record<string, any>) => createElement('div', null,
            ListHeaderComponent,
            data.length
                ? data.map((item: unknown, index: number) => createElement(Fragment, { key: keyExtractor(item) }, renderItem({ item, index })))
                : ListEmptyComponent),
        View: el('div'), Text: el('span'), Pressable: el('button'), ScrollView: el('div'), TextInput: el('input'),
        TouchableOpacity: el('button'), TouchableWithoutFeedback: el('div'),
        Modal: ({ visible, children }: { visible: boolean; children?: unknown }) => (visible ? createElement('div', { 'data-modal': 'true' }, children as any) : null),
        StyleSheet: { create: (s: unknown) => s, hairlineWidth: 1, absoluteFill: {}, flatten: (s: unknown) => s },
        Alert: { alert: (...args: unknown[]) => { alerts.shown.push(String(args[0])); } },
        DeviceEventEmitter: { addListener: listener, emit() {} },
        Keyboard: { addListener: listener, dismiss() {} },
        LayoutAnimation: { configureNext() {}, create: () => ({}), Presets: { easeInEaseOut: {} } },
        useWindowDimensions: () => ({ width: 320, height: 569, scale: 1.5, fontScale: 1.3 }),
    };
});
const routes = vi.hoisted(() => ({ pushed: [] as unknown[] }));
vi.mock('expo-router', async () => {
    const { useEffect } = await import('react');
    return {
        router: { push: (to: unknown) => routes.pushed.push(to), navigate: (to: unknown) => routes.pushed.push(to) },
        // A tab in view: the callback runs once it changes, as expo-router's does while the screen has focus.
        useFocusEffect: (cb: () => void | (() => void)) => useEffect(() => cb(), [cb]),
        useNavigation: () => ({ addListener: () => () => {}, isFocused: () => true }),
    };
});
const store = vi.hoisted(() => ({ map: new Map<string, string>() }));
vi.mock('@react-native-async-storage/async-storage', () => ({
    default: {
        getItem: vi.fn(async (k: string) => store.map.get(k) ?? null),
        setItem: vi.fn(async (k: string, v: string) => { store.map.set(k, v); }),
        removeItem: vi.fn(async (k: string) => { store.map.delete(k); }),
    },
}));
vi.mock('@expo/vector-icons', () => ({ MaterialCommunityIcons: ({ name }: { name: string }) => createElement('span', { 'data-icon': name }) }));
vi.mock('react-native-keyboard-controller', () => ({ KeyboardAvoidingView: ({ children }: { children?: unknown }) => createElement('div', null, children as any) }));
vi.mock('expo-linear-gradient', () => ({ LinearGradient: ({ children }: { children?: unknown }) => createElement('div', null, children as any) }));
// Export writes a file and shares it: in preview neither may happen.
const files = vi.hoisted(() => ({ calls: [] as string[] }));
vi.mock('expo-file-system/legacy', () => ({
    cacheDirectory: 'file:///cache/', EncodingType: { UTF8: 'utf8' },
    writeAsStringAsync: async () => { files.calls.push('write'); },
}));
vi.mock('expo-sharing', () => ({ shareAsync: async () => { files.calls.push('share'); } }));
vi.mock('../haptics', () => ({ hapticSuccess() {}, hapticWarning() {} }));
vi.mock('../blocklist', () => ({ getBlockedUsers: async () => [], BLOCKLIST_UPDATED_EVENT: 'blocklist_updated' }));
vi.mock('../../components/MemberAvatar', () => ({
    MemberAvatar: ({ callsign, pubkey }: { callsign: string; pubkey: string }) => createElement('span', { 'data-avatar': callsign, 'data-pubkey': pubkey }),
}));
vi.mock('../../components/TrustBadge', () => ({ TrustBadge: ({ level }: { level: string }) => createElement('span', { 'data-badge': level }) }));
const theme = vi.hoisted(() => ({ dark: false }));
vi.mock('../../app/ThemeContext', async () => {
    const { lightColors: light, darkColors: dark } = await import('../../constants/colors');
    const colors = () => (theme.dark ? dark : light);
    return {
        useTheme: () => ({ theme: theme.dark ? 'dark' : 'light', colors: colors() }),
        useStyles: (make: (t: { theme: string; colors: unknown }) => unknown) => make({ theme: theme.dark ? 'dark' : 'light', colors: colors() }),
    };
});
// A real member's own account on this phone: in preview none of it is shown or asked about.
const me = vi.hoisted(() => ({ identity: { publicKey: 'a-real-member-key', callsign: 'RealMember' } as Record<string, string> | null }));
vi.mock('../../app/IdentityContext', () => ({ useIdentity: () => ({ identity: me.identity }) }));
// The net spy: every call into the node client, and node-post's signed requests (the reader's own features, the
// repayment card), are recorded.
const net = vi.hoisted(() => ({
    calls: [] as string[],
    answer: null as null | ((name: string) => Promise<unknown> | undefined),
    signedAnswer: null as null | ((path: string) => Promise<Response> | undefined),
}));
vi.mock('../db', async () => (await import('./net-spy-db')).dbStandIn(net.calls, name => net.answer?.(name)));
vi.mock('../node-post', () => ({
    signedGet: (_url: string, path: string) => { net.calls.push(`signedGet ${path}`); return net.signedAnswer?.(path) ?? new Promise(() => {}); },
    signedPost: (_url: string, path: string) => { net.calls.push(`signedPost ${path}`); return new Promise(() => {}); },
    anchorUrl: async () => store.map.get('beanpool_anchor_url') ?? null,
}));
// The repayment card asks the node what the member owes (#1597): drawn at all, it counts as asking.
vi.mock('../../components/RepaymentCard', () => ({ RepaymentCard: () => { net.calls.push('RepaymentCard'); return null; } }));

import LedgerScreen from '../../app/(tabs)/ledger';
import { sampleBalance } from '../../components/showcase/sample-screens';

const NODE = 'https://global.example';
/** The phone's copy of a node's profile, heard just now, so no screen asks the node again (nodeProfileIsFresh). */
function rememberProfile(profile: 'global' | 'local', features: Record<string, boolean>) {
    store.map.set('beanpool_node_profiles', JSON.stringify({ [NODE]: { profile, features, checkedAt: new Date().toISOString() } }));
}
const WORLDWIDE = { beans: false, escrow: false, enterprises: false, decisions: false, invites: false, showcase: true };

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    routes.pushed.length = 0;
    net.calls.length = 0;
    net.answer = null;
    net.signedAnswer = null;
    files.calls.length = 0;
    alerts.shown.length = 0;
    store.map.clear();
    store.map.set('beanpool_anchor_url', NODE);
    me.identity = { publicKey: 'a-real-member-key', callsign: 'RealMember' };
    globalThis.fetch = vi.fn(async (url: unknown) => { net.calls.push(`fetch ${String(url)}`); return new Response('{}'); }) as typeof fetch;
    (globalThis as any).XMLHttpRequest = class { open() { net.calls.push('xhr'); } send() { net.calls.push('xhr'); } setRequestHeader() {} };
    (globalThis as any).WebSocket = class { constructor() { net.calls.push('ws'); } };
});
afterEach(() => { act(() => root.unmount()); host.remove(); });

/** Draw, then let the phone's storage reads and the effects they set off finish. */
const render = async (node: unknown) => {
    await act(async () => { root.render(node as any); });
    for (let i = 0; i < 5; i++) await act(async () => {});
};
const styleOf = (el: Element | null) => JSON.parse(el?.getAttribute('data-style') || '{}');
const text = () => host.textContent ?? '';
const press = async (el: Element) => { await act(async () => { (el as HTMLElement).click(); }); await act(async () => {}); };
const buttonNamed = (re: RegExp) => Array.from(host.querySelectorAll('button')).find(b => re.test(b.textContent ?? ''));
const sheet = () => host.querySelector('[data-testid="local-community-sheet"]');
const closeSheet = async () => { const close = host.querySelector('[data-modal] [aria-label="Close"]'); if (close) await press(close); };

const perkPills = () => Array.from(host.querySelectorAll('span')).filter(s => s.textContent === 'Invite Members');
/** The element carrying a testID, or the nearest one that does, from el up. */
const withTestId = (el: Element | null, id: string): Element | null => (el ? (el.getAttribute('data-testid') === id ? el : withTestId(el.parentElement, id)) : null);

for (const scheme of ['light', 'dark'] as const) {
    describe(`the Ledger's words, ${scheme}`, () => {
        beforeEach(() => { theme.dark = scheme === 'dark'; });

        it('in preview, Levels promises no inviting: no "Invite Members" perk, no "Anyone can invite"; the rest of the note stays', async () => {
            rememberProfile('global', WORLDWIDE);
            await render(createElement(LedgerScreen));
            expect(text()).toContain(SAMPLE_COMMUNITY.member);
            expect(perkPills()).toEqual([]);
            expect(text()).not.toMatch(/Anyone can invite/);
            expect(text()).toMatch(/Levels are merit badges — they don't gate any action\. Direct sends require a positive balance/);
            expect(net.calls).toEqual([]);
        });

        it('local: the perk and "Anyone can invite" stay, and the send says Send Beans in its words and its label', async () => {
            rememberProfile('local', { beans: true, showcase: false });
            net.answer = name => (name === 'getBalance' ? Promise.resolve({ ...sampleBalance(), balance: 20, earnedCredit: 9 }) : undefined);
            await render(createElement(LedgerScreen));
            expect(text()).toContain('RealMember');
            expect(perkPills()).toHaveLength(1);
            expect(text()).toMatch(/Anyone can invite\./);
            expect(text()).toContain('Send Beans');
            await press(host.querySelector('[data-testid="ledger-wallet-tab"]')!);
            const send = host.querySelector('button[aria-label="Send Beans"]');
            expect(send?.textContent).toBe('Send Beans');
            expect(text()).not.toMatch(/Send Credits/);
        });
    });

    describe(`the Wallet's Export CSV at 320 dp and 1.3× text, ${scheme}`, () => {
        beforeEach(() => { theme.dark = scheme === 'dark'; });

        it("in preview: the marker's Export CSV sits on its own full-width row under RECENT TRANSACTIONS, not in the heading's row", async () => {
            rememberProfile('global', WORLDWIDE);
            await render(createElement(LedgerScreen));
            await press(host.querySelector('[data-testid="ledger-wallet-tab"]')!);
            const exportAction = Array.from(host.querySelectorAll('[data-testid="local-community-action"]'))
                .find(a => a.getAttribute('aria-label') === `Export CSV, ${LOCAL_COMMUNITY_MARK}`)!;
            expect(exportAction).toBeTruthy();
            // Its pill rides with it: it never reads as a live export.
            expect(exportAction.textContent).toContain(`${LOCAL_COMMUNITY_EMOJI} ${LOCAL_COMMUNITY_MARK}`);
            const row = withTestId(exportAction, 'ledger-export-row')!;
            expect(row).toBeTruthy();
            expect(row.children).toHaveLength(1);
            expect(styleOf(row).flexDirection ?? 'column').toBe('column');
            // The heading's row holds the heading alone; the export row comes straight after it.
            const heading = Array.from(host.querySelectorAll('span')).find(s => s.textContent === 'RECENT TRANSACTIONS')!;
            expect(heading.parentElement!.children).toHaveLength(1);
            expect(heading.parentElement!.nextElementSibling).toBe(row);
            // The action stretches the width it is given and wraps its label and pill rather than running off the edge.
            expect(styleOf(exportAction).flexWrap).toBe('wrap');
            expect(styleOf(exportAction).alignSelf).toBeUndefined();
        });

        it("local: the member's own plain Export CSV stays beside the heading", async () => {
            rememberProfile('local', { beans: true, showcase: false });
            await render(createElement(LedgerScreen));
            await press(host.querySelector('[data-testid="ledger-wallet-tab"]')!);
            const own = host.querySelector('button[aria-label="Export CSV"]')!;
            expect(own).toBeTruthy();
            const heading = Array.from(host.querySelectorAll('span')).find(s => s.textContent === 'RECENT TRANSACTIONS')!;
            expect(own.parentElement).toBe(heading.parentElement);
            expect(host.querySelector('[data-testid="ledger-export-row"]')).toBeNull();
        });
    });
}
