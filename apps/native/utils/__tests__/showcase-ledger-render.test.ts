// @vitest-environment jsdom
/**
 * The Ledger tab in preview, the whole screen rendered for real (scratch/global-node/DESIGN-global-showcase-fable.md §1
 * row 3, §2, §6 W3): on the worldwide community (Beans off, its showcase on) the member's own Ledger reads Example
 * Valley's ledger, carries the one 🏘️ Local community marker wherever Beans would move, and asks nothing of a node.
 * In the real light and dark palettes, at 320 dp and 1.3× text, as showcase-render.test.ts.
 *
 * The mode is decided as on a phone: the phone's own copy of the node's profile (AsyncStorage, fresh, so the node isn't
 * asked again) through useNodeProfile → useReaderFeatures → showcaseMode, nothing mocked between. The reader here has no
 * key to sign with, so the mode is the node's set alone (the reader's own answer has its tests in showcase-modes).
 *
 * The net spy: fetch, XMLHttpRequest, WebSocket, every export of utils/db (net-spy-db.ts) and node-post's signed calls.
 * A local community's Ledger, the same screen, is drawn first as the control: its calls are seen.
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
const net = vi.hoisted(() => ({ calls: [] as string[], answer: null as null | ((name: string) => Promise<unknown> | undefined) }));
vi.mock('../db', async () => (await import('./net-spy-db')).dbStandIn(net.calls, name => net.answer?.(name)));
vi.mock('../node-post', () => ({
    signedGet: (_url: string, path: string) => { net.calls.push(`signedGet ${path}`); return new Promise(() => {}); },
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

describe('the control: a local community\'s Ledger, the same screen', () => {
    it('asks its node for the member\'s own ledger and shows no marker, so the spy sees this screen\'s calls', async () => {
        rememberProfile('local', { beans: true, showcase: false });
        await render(createElement(LedgerScreen));
        expect(net.calls).toEqual(expect.arrayContaining(['db.getBalance', 'db.getTransactions', 'db.getAllCommunityMembers']));
        expect(host.querySelector('[data-testid^="local-community"]')).toBeNull();
        expect(text()).toContain('RealMember');
        expect(text()).not.toContain(SAMPLE_COMMUNITY.member);
    });
});

describe('a phone that has never heard the worldwide community\'s profile', () => {
    it("starts as a local community; the member's own answers that land after the switch to preview never draw over the sample", async () => {
        theme.dark = false;
        // No copy on the phone: the screen asks for the member's own ledger, and the node is asked what it is. Both
        // answers are held, and the node's profile lands first.
        const held: Array<() => void> = [];
        const own: Record<string, unknown> = {
            getBalance: { ...sampleBalance(), balance: 4321, commons: 7 },
            getTransactions: [{ id: 'own-1', type: 'credit', amount: 777, peer: 'OwnNeighbour', memo: 'The member\'s own row', timestamp: 'now' }],
            getEscrowTotal: 999,
        };
        net.answer = name => (name in own ? new Promise(resolve => held.push(() => resolve(own[name]))) : undefined);
        let profileLands!: () => void;
        globalThis.fetch = vi.fn((url: unknown) => {
            net.calls.push(`fetch ${String(url)}`);
            return new Promise<Response>(resolve => {
                profileLands = () => resolve(new Response(JSON.stringify({ profile: 'global', features: WORLDWIDE }), { status: 200 }));
            });
        }) as typeof fetch;
        await render(createElement(LedgerScreen));
        expect(net.calls).toEqual(expect.arrayContaining(['db.getBalance', 'db.getTransactions', 'db.getEscrowTotal', `fetch ${NODE}/api/community/info`]));
        expect(host.querySelector('[data-testid="local-community-strip"]')).toBeNull();
        profileLands();
        for (let i = 0; i < 5; i++) await act(async () => {});
        expect(text()).toContain(`${SAMPLE_COMMUNITY.name} · ${SAMPLE_COMMUNITY.member}`);
        // Now the member's own answers land.
        await act(async () => { for (const land of held) land(); });
        for (let i = 0; i < 5; i++) await act(async () => {});
        expect(held).toHaveLength(3);
        expect(text()).not.toMatch(/4,?321/);
        await press(host.querySelector('[data-testid="ledger-wallet-tab"]')!);
        expect(text()).toContain(SAMPLE_COMMUNITY.transactions[0].what);
        expect(text()).not.toContain("The member's own row");
        expect(text()).not.toMatch(/999/);
    });
});

for (const scheme of ['light', 'dark'] as const) {
    const colors: AppColors = scheme === 'dark' ? (darkColors as unknown as AppColors) : lightColors;
    const tier = TIER_LEVELS[SAMPLE_COMMUNITY.level - 1];
    describe(`the Ledger in preview, ${scheme}, at 320 dp and 1.3× text`, () => {
        beforeEach(() => { theme.dark = scheme === 'dark'; rememberProfile('global', WORLDWIDE); });

        it("Levels: the strip, then Example Valley's example member at their level, never the reader's own account", async () => {
            await render(createElement(LedgerScreen));
            const strips = host.querySelectorAll('[data-testid="local-community-strip"]');
            expect(strips).toHaveLength(1);
            expect(strips[0].textContent).toContain(LOCAL_COMMUNITY_STRIP.lead.beans);
            expect(text()).toContain(`${SAMPLE_COMMUNITY.name} · ${SAMPLE_COMMUNITY.member}`);
            expect(host.querySelector('[data-avatar]')!.getAttribute('data-avatar')).toBe(SAMPLE_COMMUNITY.member);
            expect(host.querySelector('[data-avatar]')!.getAttribute('data-pubkey')).toBe('');
            expect(text()).toContain(tier.name);
            expect(text()).toContain(String(SAMPLE_COMMUNITY.balance));
            expect(text()).not.toContain('RealMember');
            expect(text()).not.toMatch(/Ʀ|🔒/);
            expect(net.calls).toEqual([]);
        });

        it("Wallet: Example Valley's recent rows, with Send Beans and Export CSV as the marker's actions", async () => {
            await render(createElement(LedgerScreen));
            await press(host.querySelector('[data-testid="ledger-wallet-tab"]')!);
            for (const t of SAMPLE_COMMUNITY.transactions) {
                expect(text()).toContain(t.what);
                expect(text()).toContain(`${t.amount < 0 ? '-' : '+'}${Math.abs(t.amount)}`);
            }
            expect(text()).toContain('a neighbour');
            expect(text()).not.toContain('No transactions yet.');
            const actions = Array.from(host.querySelectorAll('[data-testid="local-community-action"]'));
            expect(actions.map(a => a.getAttribute('aria-label'))).toEqual(expect.arrayContaining([
                `Send Beans, ${LOCAL_COMMUNITY_MARK}`, `Export CSV, ${LOCAL_COMMUNITY_MARK}`]));
            // No send form, no member picker, no export button of the member's own.
            expect(host.querySelector('[aria-label="Amount to send"]')).toBeNull();
            expect(host.querySelector('button[aria-label="Export CSV"]')).toBeNull();
            expect(text()).not.toMatch(/Ʀ|🔒/);
            expect(net.calls).toEqual([]);
        });

        it('the one marker, everywhere it shows: 🏘️ Local community in the info tone, dashed, never a lock, grey or fade', async () => {
            await render(createElement(LedgerScreen));
            const check = () => {
                const marks = Array.from(host.querySelectorAll('[data-testid="local-community-strip"], [data-testid="local-community-action"]'));
                expect(marks.length).toBeGreaterThan(0);
                for (const m of marks) {
                    expect(styleOf(m)).toMatchObject({ borderStyle: 'dashed', borderWidth: 1, borderColor: colors.feedback.info.border });
                    expect(styleOf(m).opacity).toBeUndefined();
                    // Its pill names the one marker, in the info tone of this scheme.
                    const pill = Array.from(m.querySelectorAll('span')).find(s => s.textContent === `${LOCAL_COMMUNITY_EMOJI} ${LOCAL_COMMUNITY_MARK}`)!;
                    expect(pill).toBeTruthy();
                    expect(styleOf(pill).color).toBe(colors.feedback.info.fg);
                    expect(styleOf(pill.parentElement)).toMatchObject({ backgroundColor: colors.feedback.info.bg, borderStyle: 'dashed' });
                }
                expect(host.querySelector('[data-icon="lock-outline"], [data-icon="lock"]')).toBeNull();
            };
            check();
            // Levels' quick Send is the marker's action too, not the member's own Send pill.
            expect(host.querySelector(`[aria-label="Send Beans, ${LOCAL_COMMUNITY_MARK}"]`)).not.toBeNull();
            expect(buttonNamed(/^Send (Credits|\()/)).toBeUndefined();
            await press(host.querySelector('[data-testid="ledger-wallet-tab"]')!);
            check();
        });

        it('every press that would move Beans, export or open an account opens the one sheet with the Beans line', async () => {
            await render(createElement(LedgerScreen));
            const tries: Array<[string, () => Element | undefined | null]> = [
                ['the example member', () => buttonNamed(new RegExp(SAMPLE_COMMUNITY.member))],
                ['Send on Levels', () => host.querySelector(`[aria-label="Send Beans, ${LOCAL_COMMUNITY_MARK}"]`)],
            ];
            for (const [what, find] of tries) {
                const b = find();
                expect(b, what).toBeTruthy();
                await press(b!);
                expect(sheet()?.textContent, what).toContain(LOCAL_COMMUNITY_SHEET.features.beans);
                await closeSheet();
                expect(sheet(), what).toBeNull();
            }
            await press(host.querySelector('[data-testid="ledger-wallet-tab"]')!);
            for (const label of ['Send Beans', 'Export CSV']) {
                await press(host.querySelector(`[aria-label="${label}, ${LOCAL_COMMUNITY_MARK}"]`)!);
                expect(sheet()?.textContent, label).toContain(LOCAL_COMMUNITY_SHEET.features.beans);
                await closeSheet();
            }
            expect(routes.pushed).toEqual([]);
            expect(alerts.shown).toEqual([]);
            expect(files.calls).toEqual([]);
            expect(net.calls).toEqual([]);
        });

        it('the net spy: every button in both tabs, pressed; nothing asked of a node, nothing written, nothing shared', async () => {
            await render(createElement(LedgerScreen));
            const pressed = new Set<string>();
            for (const tab of ['Levels', 'Wallet']) {
                await press(buttonNamed(new RegExp(`^${tab}$`))!);
                for (let i = 0; i < 200; i++) {
                    const next = Array.from(host.querySelectorAll('button')).find(b => {
                        const key = `${tab}:${b.getAttribute('aria-label') ?? ''}:${b.textContent}`;
                        return !pressed.has(key) && b.getAttribute('aria-label') !== 'Make this shorter';
                    });
                    if (!next) break;
                    pressed.add(`${tab}:${next.getAttribute('aria-label') ?? ''}:${next.textContent}`);
                    await press(next);
                }
                await closeSheet();
            }
            expect(pressed.size).toBeGreaterThanOrEqual(20);
            // The ways forward were taken (the sheet's and the strip's), and nothing else left the screen.
            expect(routes.pushed).toEqual(expect.arrayContaining(['/start-community', '/find-community']));
            for (const to of routes.pushed) {
                expect(['/start-community', '/find-community', '/guide/[slug]']).toContain(typeof to === 'string' ? to : (to as { pathname: string }).pathname);
            }
            expect(alerts.shown).toEqual([]);
            expect(files.calls).toEqual([]);
            expect(net.calls).toEqual([]);
        });
    });
}
