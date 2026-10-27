// @vitest-environment jsdom
/**
 * The Commons tab's enterprises, one list for the screen and the propose-a-Decision form (#2200): app/(tabs)/projects.tsx
 * rendered for real, with the real Decide, propose form and enterprise cards, the node answering two enterprises (or
 * none). The screen reads them once (getTreasuries) and hands that list to both: Groups draws each as its own row
 * (EnterpriseCard), as the web's Commons does, and the form's project picker (remove a lead keeper, pay off a debt)
 * offers each. Before, the form was handed a `treasuries` state nothing set: its picker was always empty, and a panel
 * drawn from the same state never showed.
 *
 * The enterprises' names are what members wrote: shown as written in any language (the pseudo-locale checks it).
 * React Native's host components are plain tags carrying their accessibility props and placeholders (the harness of
 * commons-words-render.test.ts).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Module from 'node:module';
import { act, createElement, forwardRef, Fragment } from 'react';
import { createRoot, type Root } from 'react-dom/client';

(Module as any)._extensions['.png'] = (m: { exports: unknown }) => { m.exports = 1; };
(globalThis as any).__DEV__ = false;
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const alerts = vi.hoisted(() => ({ said: [] as string[] }));

vi.mock('react-native', () => {
    const roles: Record<string, string> = { header: 'heading', button: 'button', link: 'link', radio: 'radio', alert: 'alert', radiogroup: 'radiogroup' };
    const el = (tag: string) => function Host(props: Record<string, any>) {
        const { children, onPress, accessibilityLabel, accessibilityRole, testID, placeholder, value, onChangeText, disabled } = props;
        const attrs: Record<string, unknown> = {};
        if (testID) attrs['data-testid'] = testID;
        if (onPress && !disabled) attrs.onClick = (e: { stopPropagation(): void }) => { e.stopPropagation(); onPress({ stopPropagation() {}, nativeEvent: {} }); };
        if (onChangeText) { attrs.onChange = (e: { target: { value: string } }) => onChangeText(e.target.value); attrs.value = value ?? ''; }
        if (accessibilityLabel) attrs['aria-label'] = accessibilityLabel;
        if (accessibilityRole && roles[accessibilityRole]) attrs.role = roles[accessibilityRole];
        if (placeholder) attrs.placeholder = placeholder;
        return createElement(tag, attrs, children);
    };
    const listener = () => ({ remove() {} });
    const FlatList = forwardRef(function FlatList(props: Record<string, any>, _ref) {
        const { data = [], renderItem, keyExtractor, ListHeaderComponent, ListEmptyComponent } = props;
        return createElement('div', null,
            ListHeaderComponent ?? null,
            data.length
                ? data.map((item: unknown, index: number) => createElement(Fragment, { key: keyExtractor ? keyExtractor(item, index) : index }, renderItem({ item, index })))
                : (ListEmptyComponent ?? null));
    });
    return {
        Platform: { OS: 'android', select: (o: Record<string, unknown>) => o.android ?? o.default },
        Image: el('img'),
        Dimensions: { get: () => ({ width: 320, height: 569, scale: 1.5, fontScale: 1.3 }) },
        View: el('div'), Text: el('span'), Pressable: el('button'), ScrollView: el('div'), TextInput: el('input'),
        TouchableOpacity: el('button'), TouchableWithoutFeedback: el('div'), SafeAreaView: el('div'), KeyboardAvoidingView: el('div'),
        ActivityIndicator: () => createElement('span', { 'data-spinner': 'true' }),
        FlatList, RefreshControl: () => null,
        Modal: ({ visible, children }: { visible: boolean; children?: unknown }) => (visible ? createElement('div', { 'data-modal': 'true' }, children as any) : null),
        StyleSheet: { create: (s: unknown) => s, hairlineWidth: 1, absoluteFill: {}, absoluteFillObject: {}, flatten: (s: unknown) => s },
        Alert: { alert: (title: string, body?: string) => { alerts.said.push(title); if (body) alerts.said.push(body); } },
        Share: { share: async () => ({}) },
        Linking: { openURL: async () => {}, openSettings: async () => {} },
        DeviceEventEmitter: { addListener: listener, emit() {} },
        AppState: { currentState: 'active', addEventListener: () => ({ remove() {} }) },
        AccessibilityInfo: { announceForAccessibility: () => {}, isScreenReaderEnabled: async () => false, addEventListener: () => ({ remove() {} }) },
        Keyboard: { addListener: listener, dismiss() {} },
        LayoutAnimation: { configureNext() {}, Presets: {}, create: () => ({}) },
        I18nManager: { getConstants: () => ({ localeIdentifier: 'en_US' }), allowRTL: () => {}, forceRTL: () => {} },
        NativeModules: {},
        useWindowDimensions: () => ({ width: 320, height: 569, scale: 1.5, fontScale: 1.3 }),
    };
});
vi.mock('expo-router', async () => {
    const { useEffect } = await import('react');
    return {
        router: { push() {}, navigate() {}, replace() {}, back() {}, setParams() {}, canGoBack: () => true },
        useFocusEffect: (cb: () => void | (() => void)) => useEffect(() => cb(), [cb]),
        useLocalSearchParams: () => ({}),
        useNavigation: () => ({ addListener: () => () => {}, isFocused: () => true }),
        ErrorBoundary: () => null,
    };
});
const store = vi.hoisted(() => ({ map: new Map<string, string>() }));
vi.mock('@react-native-async-storage/async-storage', () => ({
    default: {
        getItem: vi.fn(async (k: string) => store.map.get(k) ?? null),
        setItem: vi.fn(async (k: string, v: string) => { store.map.set(k, v); }),
        removeItem: vi.fn(async (k: string) => { store.map.delete(k); }),
        getAllKeys: vi.fn(async () => [...store.map.keys()]),
        multiRemove: vi.fn(async (keys: string[]) => { keys.forEach((k) => store.map.delete(k)); }),
    },
}));
vi.mock('@expo/vector-icons', () => ({ MaterialCommunityIcons: ({ name }: { name: string }) => createElement('i', { 'data-icon': name }) }));
vi.mock('expo-status-bar', () => ({ StatusBar: () => null }));
vi.mock('expo-image-picker', () => ({ launchImageLibraryAsync: async () => ({ canceled: true, assets: [] }) }));
vi.mock('expo-image-manipulator', () => ({ manipulateAsync: async () => ({}), SaveFormat: { JPEG: 'jpeg' } }));
vi.mock('react-native-safe-area-context', () => ({
    useSafeAreaInsets: () => ({ top: 24, bottom: 0, left: 0, right: 0 }),
    SafeAreaView: ({ children }: { children?: unknown }) => createElement('div', null, children as any),
}));
vi.mock('react-native-keyboard-controller', () => {
    const pass = ({ children }: { children?: unknown }) => createElement('div', null, children as any);
    return { KeyboardAvoidingView: pass, KeyboardAwareScrollView: pass, KeyboardController: { dismiss: async () => {} }, useKeyboardState: () => false };
});
vi.mock('expo-crypto', () => ({ randomUUID: () => 'a-uuid', getRandomBytes: (n: number) => new Uint8Array(n) }));
vi.mock('../../app/ThemeContext', async () => {
    const { lightColors } = await import('../../constants/colors');
    return {
        useTheme: () => ({ theme: 'light', colors: lightColors, themePreference: 'light', setThemePreference() {}, patternEnabled: false, setPatternEnabled() {} }),
        useStyles: (make: (t: { theme: string; colors: unknown; patternEnabled: boolean }) => unknown) => make({ theme: 'light', colors: lightColors, patternEnabled: false }),
    };
});
const KEY = 'ab12cd34ef56ab12cd34ef56ab12cd34ef56ab12cd34ef56ab12cd34ef56ab12';
const who = vi.hoisted(() => ({ identity: null as any }));
vi.mock('../../app/IdentityContext', () => ({ useIdentity: () => ({ identity: who.identity, setIdentity() {} }) }));
vi.mock('../identity', () => ({ loadIdentity: async () => who.identity }));
vi.mock('../nodes', () => ({ getSavedNodes: async () => [] }));

// What the node says, as the cases set it: a local community with enterprises and Decisions on.
const LOCAL = { beans: true, escrow: true, enterprises: true, decisions: true };
const node = vi.hoisted(() => ({
    treasuries: [] as any[],
    getTreasuries: null as any,
    createDecision: null as any,
}));
vi.mock('../use-reader-features', () => ({
    useReaderFeatures: () => ({ node: LOCAL, reader: null, effective: LOCAL, known: true }),
}));
vi.mock('../use-node-profile', () => ({ useNodeProfile: () => ({ profile: 'local', features: LOCAL }) }));
vi.mock('../db', () => ({
    getBalance: async () => ({ earnedCredit: 5, commons: 800 }),
    getTreasuries: (...args: unknown[]) => node.getTreasuries(...args),
    getDecisions: async () => ({ decisions: [], myPoolVoting: { voiceCredits: 4, hasCompletedTrade: true }, canPropose: true }),
    getAllCommunityMembers: async () => [{ publicKey: 'd'.repeat(64), callsign: 'Dave' }],
    fetchGroups: async () => [],
    fetchYourGroups: async () => [],
    castDecisionVote: async () => ({ success: true }),
    createDecision: (...args: unknown[]) => node.createDecision(...args),
}));

// Shared with other screens, and not what this checks: stand-ins.
vi.mock('../../components/YourGroupsPane', () => ({
    YourGroupsRows: () => null, YourGroupsLoading: () => null, YourGroupsError: () => null,
    useCreateGroupFlow: () => ({ open() {}, modal: null }),
}));
vi.mock('../../components/useYourGroups', () => ({
    useYourGroups: () => ({ items: [], error: null, refresh() {} }),
    yourGroupsStore: { refresh() {} },
}));
vi.mock('../../components/GroupDetailModal', () => ({ GroupDetailModal: () => null }));
vi.mock('../../components/MemberAvatar', () => ({
    MemberAvatar: ({ pubkey, avatarUrl }: { pubkey: string; avatarUrl?: string | null }) =>
        createElement('span', { 'data-avatar': 'true', 'data-pubkey': pubkey, 'data-avatar-url': avatarUrl ?? '' }),
}));
vi.mock('../../components/showcase/LocalCommunityMark', () => ({
    LocalCommunityMark: () => null,
    ExampleHeader: () => null,
    LocalCommunitySheet: () => null,
}));

import { pseudoLocalise, setLanguage, type UiLang } from '@beanpool/core';
import { LanguageProvider } from '../../components/LanguageProvider';
import ProjectsScreen from '../../app/(tabs)/projects';

const NODE = 'https://mullum.example';
const EGGS = { publicKey: 'e'.repeat(64), name: 'Égg flock of Mullum', purpose: 'Eggs for the street', balance: 25, creditLine: 0, liveOffers: 2, goalAmount: null, currentAmount: null, lifecycle: 'ongoing', status: 'active', paused: false, keepers: [], deadlineAt: null };
const BAKERY = { publicKey: 'b'.repeat(64), name: 'Bakery co-op', purpose: 'Bread on Fridays', balance: -10, creditLine: 0, liveOffers: 1, goalAmount: null, currentAmount: null, lifecycle: 'ongoing', status: 'active', paused: false, keepers: [], deadlineAt: null };

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    alerts.said.length = 0;
    store.map.clear();
    store.map.set('beanpool_anchor_url', NODE);
    who.identity = { publicKey: KEY, privateKey: 'me-priv', callsign: 'Me' };
    node.treasuries = [EGGS, BAKERY];
    node.getTreasuries = vi.fn(async () => node.treasuries);
    node.createDecision = vi.fn(async () => ({ success: true }));
});
afterEach(() => { act(() => root.unmount()); host.remove(); setLanguage('en'); });

const settle = async (n = 10) => { for (let i = 0; i < n; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); };
async function renderIn(lang: UiLang = 'en') {
    await act(async () => { root.render(createElement(LanguageProvider as any, { deviceTags: ['en-US'], initial: lang }, createElement(ProjectsScreen)) as any); });
    await settle();
}
const shown = (english: string, lang: UiLang) => (lang === 'xx' ? pseudoLocalise(english) : english);
const click = async (el: Element | null | undefined, what: string) => {
    expect(el, what).toBeTruthy();
    await act(async () => { (el as HTMLElement).click(); });
    await settle(6);
};
const type = async (el: Element | null | undefined, text: string) => {
    expect(el).toBeTruthy();
    const input = el as HTMLInputElement;
    await act(async () => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, text);
        input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await settle(2);
};
/** The button whose own words hold `english` as drawn now, within `scope`. */
const button = (english: string, lang: UiLang = 'en', scope: ParentNode = host) =>
    Array.from(scope.querySelectorAll('button')).find((b) => (b.textContent ?? '').includes(shown(english, lang))) ?? null;
const byLabel = (english: string, lang: UiLang = 'en') => host.querySelector(`[aria-label="${shown(english, lang)}"]`);
const byPlaceholder = (english: string, lang: UiLang = 'en') => host.querySelector(`input[placeholder="${shown(english, lang).replace(/"/g, '\\"')}"]`);
const form = () => host.querySelector('[data-modal="true"]');
/** The propose form's project picker: the buttons whose words are exactly an enterprise's name. */
const picker = (names: string[]) => Array.from(form()?.querySelectorAll('button') ?? []).map((b) => b.textContent ?? '').filter((w) => names.includes(w));
const times = (text: string, part: string) => text.split(part).length - 1;

async function openProposeForm(lang: UiLang = 'en') {
    await click(byLabel('Decide Section', lang), 'Decide');
    await click(button('+ Propose a Decision', lang), 'Propose a Decision');
    expect(form(), 'the propose form').not.toBeNull();
}

describe("the Commons tab's enterprises (#2200)", () => {
    it('reads them once, and Groups lists both, each once, on All and on the Enterprises chip', async () => {
        await renderIn();
        expect(node.getTreasuries).toHaveBeenCalledTimes(1);
        await click(byLabel('Groups Section'), 'Groups');
        for (const name of [EGGS.name, BAKERY.name]) expect(times(host.textContent ?? '', name), name).toBe(1);
        await click(button('🏛️ Enterprises'), 'Enterprises chip');
        for (const name of [EGGS.name, BAKERY.name]) expect(times(host.textContent ?? '', name), name).toBe(1);
        // Pictures S4 (Marty: no picture yet → the ready-made picture its key picks): an enterprise with no logo draws
        // MemberAvatar for its key with no picture, which draws that preset, as the web card does; never the category tile.
        for (const e of [EGGS, BAKERY]) {
            const face = host.querySelector(`[data-avatar][data-pubkey="${e.publicKey}"]`);
            expect(face, e.name).not.toBeNull();
            expect(face!.getAttribute('data-avatar-url'), e.name).toBe('');
        }
        expect(host.querySelectorAll('[data-testid="category-tile"]').length).toBe(0);
        // One list, as on the web: no second panel of the same enterprises over it.
        expect(host.textContent).not.toContain("THE COMMONS' ENTERPRISES");
        expect(node.getTreasuries).toHaveBeenCalledTimes(1);
    });

    it('the propose form: removing a lead keeper offers both in its picker, and a pick names the enterprise and its lead keeper', async () => {
        await renderIn();
        await openProposeForm();
        await click(button('Remove a lead keeper or project leader', 'en', form()!), 'Remove a lead');
        expect(picker([EGGS.name, BAKERY.name])).toEqual([EGGS.name, BAKERY.name]);
        await click(button(BAKERY.name, 'en', form()!), BAKERY.name);
        expect((byPlaceholder('Or enter its public key...') as HTMLInputElement).value).toBe(BAKERY.publicKey);
        // An enterprise's lead is its lead keeper (§3.1): the form knows it from the list it was handed.
        expect(byPlaceholder("Enter the lead keeper's callsign or pubkey...")).not.toBeNull();
        expect(byPlaceholder("Enter the lead keeper or leader's callsign or pubkey...")).toBeNull();
    });

    it("the propose form: paying off a debt offers both, and the Decision proposed is about the one picked", async () => {
        await renderIn();
        await openProposeForm();
        await click(button('Commons Pool', 'en', form()!), 'Commons Pool');
        await click(button("Pay off a project's or enterprise's debt", 'en', form()!), 'Pay off a debt');
        expect(picker([EGGS.name, BAKERY.name])).toEqual([EGGS.name, BAKERY.name]);
        await click(button(EGGS.name, 'en', form()!), EGGS.name);
        await type(byPlaceholder('e.g. Grant 200 beans to the Tool Library'), 'Clear the flock\'s debt');
        await type(byPlaceholder('Explain why this decision is needed, what will be done, and who is responsible.'), 'A hard winter');
        await click(byLabel('Submit Community Decision'), 'Submit');
        expect(node.createDecision).toHaveBeenCalledTimes(1);
        expect(node.createDecision.mock.calls[0][0]).toMatchObject({ touches: 'pool', effect: 'write_off_deficit', subject: EGGS.publicKey });
    });

    it("in another language the names are drawn as members wrote them, in the list and in the picker", async () => {
        await renderIn('xx');
        await click(byLabel('Groups Section', 'xx'), 'Groups');
        for (const name of [EGGS.name, BAKERY.name]) {
            expect(host.textContent, name).toContain(name);
            expect(host.textContent, name).not.toContain(pseudoLocalise(name));
        }
        await openProposeForm('xx');
        await click(button('Remove a lead keeper or project leader', 'xx', form()!), 'Remove a lead');
        expect(picker([EGGS.name, BAKERY.name])).toEqual([EGGS.name, BAKERY.name]);
    });

    it('with none: Groups says so, and the form has no picker but still takes a key typed in', async () => {
        node.treasuries = [];
        await renderIn();
        expect(node.getTreasuries).toHaveBeenCalledTimes(1);
        await click(byLabel('Groups Section'), 'Groups');
        await click(button('🏛️ Enterprises'), 'Enterprises chip');
        expect(host.textContent).toContain('No enterprises yet');
        expect(host.textContent).toContain('Start an enterprise');
        await openProposeForm();
        await click(button('Commons Pool', 'en', form()!), 'Commons Pool');
        await click(button("Pay off a project's or enterprise's debt", 'en', form()!), 'Pay off a debt');
        expect(picker([EGGS.name, BAKERY.name])).toEqual([]);
        await type(byPlaceholder('e.g. Grant 200 beans to the Tool Library'), 'Clear a debt');
        await type(byPlaceholder('Explain why this decision is needed, what will be done, and who is responsible.'), 'A hard winter');
        await click(byLabel('Submit Community Decision'), 'Submit');
        expect(alerts.said).toContain('Please pick the project or enterprise, or enter its public key.');
        expect(node.createDecision).not.toHaveBeenCalled();
        await type(byPlaceholder('Or enter its public key...'), 'c'.repeat(64));
        await click(byLabel('Submit Community Decision'), 'Submit');
        expect(node.createDecision.mock.calls[0][0]).toMatchObject({ effect: 'write_off_deficit', subject: 'c'.repeat(64) });
    });
});
