// @vitest-environment jsdom
/**
 * Your garden's Change on the phone (grow-food slice G0: the planting guide), drawn for real through the one host route
 * (app/tool/[id].tsx) with the tool as the registry ships it, its document in a real SQLite table, at 320 dp with 1.3×
 * text. Change keeps the member's own choice of climate and goes back to the guide, once:
 *
 * - a choice is kept and goes back once;
 * - a member who has left Change while the write is still out (the header's ←, Android's back, a swipe) has the choice
 *   kept all the same, but is not sent back a second time, which would pop the guide too (review of #2618);
 * - a write refused after the member has left says nothing to a screen that isn't there, and goes nowhere.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';

(globalThis as any).__DEV__ = false;
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const SCREEN = 320;
const FONT_SCALE = 1.3;

vi.mock('react-native', () => {
    const roles: Record<string, string> = { header: 'heading', button: 'button', link: 'link', radio: 'radio', radiogroup: 'radiogroup' };
    const flat = (style: unknown): Record<string, any> => Object.assign({}, ...[style].flat(4).filter((x) => x && typeof x === 'object'));
    const el = (tag: string) => function Host(props: Record<string, any>) {
        const { children, onPress, accessibilityLabel, accessibilityRole, testID, numberOfLines, disabled, source } = props;
        const attrs: Record<string, unknown> = {};
        if (testID) attrs['data-testid'] = testID;
        if (onPress && !disabled) attrs.onClick = (e: { stopPropagation(): void }) => { e.stopPropagation(); onPress({ stopPropagation() {} }); };
        if ((onPress && disabled) || props.accessibilityState?.disabled) attrs['data-disabled'] = 'true';
        if (accessibilityLabel) attrs['aria-label'] = accessibilityLabel;
        if (accessibilityRole && roles[accessibilityRole]) attrs.role = roles[accessibilityRole];
        if (numberOfLines) attrs['data-lines'] = String(numberOfLines);
        if (source?.uri) attrs['data-src'] = source.uri;
        return createElement(tag, attrs, typeof children === 'function' ? children({ pressed: false }) : children);
    };
    return {
        Platform: { OS: 'android', select: (o: Record<string, unknown>) => o.android ?? o.default },
        View: el('div'), Text: el('span'), Pressable: el('button'), ScrollView: el('div'), TextInput: el('input'), Switch: el('button'), ActivityIndicator: el('div'), Image: el('img'),
        Modal: ({ visible, children }: { visible: boolean; children?: unknown }) => (visible ? createElement('div', { 'data-modal': 'true' }, children as any) : null),
        StyleSheet: { create: (s: unknown) => s, hairlineWidth: 1, absoluteFill: {}, absoluteFillObject: {}, flatten: (s: unknown) => flat(s) },
        Alert: { alert: () => {} },
        Linking: { openURL: async () => {} },
        AccessibilityInfo: { announceForAccessibility: () => {} },
        useWindowDimensions: () => ({ width: SCREEN, height: 569, scale: 1.5, fontScale: FONT_SCALE }),
        Dimensions: { get: () => ({ width: SCREEN, height: 569, scale: 1.5, fontScale: FONT_SCALE }) },
    };
});
const nav = vi.hoisted(() => ({ params: {} as Record<string, string>, pushed: [] as unknown[], backs: 0 }));
vi.mock('expo-router', async () => {
    const { useEffect: effect, useState: state } = await import('react');
    return {
        router: {
            push: (r: unknown) => { nav.pushed.push(r); }, navigate: (r: unknown) => { nav.pushed.push(r); }, replace: () => {},
            back: () => { nav.backs++; }, canGoBack: () => true, setParams: () => {},
        },
        useFocusEffect: (cb: () => void | (() => void)) => effect(() => cb(), [cb]),
        useNavigation: () => ({ getState: () => ({ routes: [], index: 0 }) }),
        useLocalSearchParams: () => state(() => ({ ...nav.params }))[0],
    };
});
const store = vi.hoisted(() => ({ map: new Map<string, string>() }));
vi.mock('@react-native-async-storage/async-storage', () => ({
    default: {
        getItem: async (k: string) => store.map.get(k) ?? null,
        setItem: async (k: string, v: string) => { store.map.set(k, v); },
        removeItem: async (k: string) => { store.map.delete(k); },
        getAllKeys: async () => [...store.map.keys()],
        multiRemove: async (keys: string[]) => { keys.forEach((k) => store.map.delete(k)); },
    },
}));
vi.mock('@expo/vector-icons', () => ({ MaterialCommunityIcons: ({ name }: { name: string }) => createElement('i', { 'data-icon': name }) }));
vi.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ top: 24, bottom: 0, left: 0, right: 0 }) }));
vi.mock('react-native-keyboard-controller', () => ({
    useKeyboardState: (pick: (s: { height: number; isVisible: boolean }) => unknown) => pick({ height: 0, isVisible: false }),
    KeyboardAwareScrollView: ({ children, testID }: Record<string, any>) => createElement('div', { 'data-testid': testID }, children),
}));
// The host route loads the Tool shed's photo modules whether or not a tool asks for a photo; none is used here.
vi.mock('expo-file-system/legacy', () => ({ documentDirectory: 'file:///none/', makeDirectoryAsync: async () => {}, copyAsync: async () => {}, deleteAsync: async () => {}, readAsStringAsync: async () => '' }));
vi.mock('expo-image-picker', () => ({ launchImageLibraryAsync: async () => ({ canceled: true }), launchCameraAsync: async () => ({ canceled: true }), requestCameraPermissionsAsync: async () => ({ granted: false }) }));
vi.mock('expo-image-manipulator', () => ({ manipulateAsync: async (uri: string) => ({ uri, width: 0, height: 0 }), SaveFormat: { JPEG: 'jpeg' } }));
vi.mock('expo-crypto', () => ({ randomUUID: () => 'id' }));
// The phone's location is never asked for: no permission, so no last known place.
vi.mock('expo-location', () => ({ getForegroundPermissionsAsync: async () => ({ status: 'denied' }), getLastKnownPositionAsync: async () => null }));
vi.mock('../../../app/ThemeContext', async () => {
    const { lightColors } = await import('../../../constants/colors');
    const now = () => ({ theme: 'light', colors: lightColors });
    return { useTheme: () => now(), useStyles: (make: (t: unknown) => unknown) => make(now()) };
});
const ME = { publicKey: 'me-key', callsign: 'Ana' };
vi.mock('../../../app/IdentityContext', () => ({ useIdentity: () => ({ identity: ME }) }));
vi.mock('../../../utils/use-node-profile', () => ({ useNodeProfile: () => ({ profile: 'local', features: { beans: true } }) }));
vi.mock('../../../utils/market-global', () => ({ composerNeedsProfilePhoto: async () => false }));
vi.mock('../../../utils/canonical-profile', () => ({ getCanonicalAvatar: async () => null }));

/**
 * The phone's SQLite and what holds its writes: `gate` holds the next write to the tool's document until it settles (a
 * slow, nearly full phone), and `refuse` makes that write fail as a full disk does.
 */
const disk = vi.hoisted(() => ({ db: null as any, gate: null as Promise<void> | null, refuse: false }));
vi.mock('../../../utils/db', () => ({
    getDb: async () => disk.db,
    getMemberProfile: async () => ({ avatar_url: null }),
}));

// The phone half's screens thunk is require('./screens'): Metro bundles it, and vitest can't load a .tsx through Node's own
// require. The same module, imported.
vi.mock('../index', async () => {
    const { SCREENS } = await import('../screens');
    return { default: { id: 'garden', screens: () => SCREENS } };
});

import { DatabaseSync } from 'node:sqlite';
import { GARDEN, setLanguage, type GardenDoc } from '@beanpool/core';
import { TOOL_DOCS_TABLE } from '../../schema';
import { readToolDoc } from '../../store';
import ToolRoute from '../../../app/tool/[id]';

function sqliteDb() {
    const d = new DatabaseSync(':memory:');
    const bind = (params?: unknown[]) => (params ?? []) as any[];
    return {
        execAsync: async (sql: string) => { d.exec(sql); },
        runAsync: async (sql: string, params?: unknown[]) => {
            if (/^\s*INSERT/i.test(sql)) {
                const gate = disk.gate;
                disk.gate = null;
                if (gate) await gate;
                if (disk.refuse) { disk.refuse = false; throw new Error('database or disk is full'); }
            }
            const r = d.prepare(sql).run(...bind(params));
            return { changes: Number(r.changes) };
        },
        getFirstAsync: async (sql: string, params?: unknown[]) => d.prepare(sql).get(...bind(params)) ?? null,
        getAllAsync: async (sql: string, params?: unknown[]) => d.prepare(sql).all(...bind(params)),
    };
}

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    store.map.clear();
    store.map.set('beanpool_anchor_url', 'https://mullum.example');
    disk.db = sqliteDb();
    disk.db.execAsync(TOOL_DOCS_TABLE);
    disk.gate = null;
    disk.refuse = false;
    nav.params = {};
    nav.pushed.length = 0;
    nav.backs = 0;
});
afterEach(() => { act(() => root.unmount()); host.remove(); setLanguage('en'); });

const settle = async (n = 10) => { for (let i = 0; i < n; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); };
async function openChange() {
    nav.params = { id: 'garden', screen: 'zone' };
    await act(async () => { root.render(createElement(ToolRoute) as any); });
    await settle();
}
const byTestId = (id: string) => host.querySelector(`[data-testid="${id}"]`);
async function click(id: string) {
    const el = byTestId(id);
    expect(el, id).not.toBeNull();
    await act(async () => { (el as HTMLElement).click(); });
    await settle(8);
}
/** A write held on the phone, and the way to let it land. */
function holdWrite() {
    let release: () => void = () => {};
    disk.gate = new Promise<void>((resolve) => { release = resolve; });
    return release;
}
const kept = async () => (await readToolDoc(ME.publicKey, GARDEN)).doc as GardenDoc;

describe('Your garden on the phone: Change goes back once (review of #2618)', () => {
    it('a choice is kept and goes back once, to the guide', async () => {
        await openChange();
        await click('garden-zone-mild');
        expect(nav.backs).toBe(1);
        expect((await kept()).settings).toEqual({ zone: 'mild', hemisphere: 'north' });
    });

    it("leaving Change while its write is still out (the header's ←, Android's back, a swipe) keeps the choice and doesn't go back a second time", async () => {
        await openChange();
        const release = holdWrite();
        await click('garden-zone-mild');
        // Nothing is kept yet and nothing has gone back: the write is out.
        expect(nav.backs).toBe(0);
        // The member leaves: the screen is gone before the write lands.
        act(() => root.unmount());
        release();
        await settle(8);
        // The choice is kept all the same, and the guide below is still the screen they are on.
        expect((await kept()).settings).toEqual({ zone: 'mild', hemisphere: 'north' });
        expect(nav.backs).toBe(0);
    });

    it('a write refused after the member has left goes nowhere, and keeps nothing', async () => {
        await openChange();
        const release = holdWrite();
        disk.refuse = true;
        await click('garden-zone-mild');
        act(() => root.unmount());
        release();
        await settle(8);
        expect(nav.backs).toBe(0);
        expect((await kept()).settings).toEqual({});
    });
});
