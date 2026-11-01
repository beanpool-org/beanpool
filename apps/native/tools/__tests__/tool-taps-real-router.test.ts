// @vitest-environment jsdom
/**
 * Tapping through a tool on the phone, with expo-router's own push, back and setParams and React Navigation's own StackRouter
 * (real-router.ts) under the app's real host route (app/tool/[id].tsx) and the tools' real screens. Damo, 1 Nov: "this button
 * (and every other item when I click on them on this page does nothing), this tool is broken?"
 *
 * expo-router takes a param called `screen` out of every push: React Navigation keeps that word for a navigator's child
 * (global-state/routing.js getPayloadFromStateRoute). So a tap that said which screen to open pushed the tool again with
 * no screen, and its first screen came up over itself. The suites that mock `router` only saw what was handed to it, and
 * the emulator lanes opened screens by link (`beanpool://tool/<id>?screen=…`), which a push doesn't touch.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement, useSyncExternalStore } from 'react';
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
        // The button a person would press: "Remove my data" asks first.
        Alert: { alert: (_title: string, _body: string, buttons?: Array<{ style?: string; onPress?: () => void }>) => { buttons?.find((b) => b.style === 'destructive')?.onPress?.(); } },
        Linking: { openURL: async () => {} },
        AccessibilityInfo: { announceForAccessibility: () => {} },
        useWindowDimensions: () => ({ width: SCREEN, height: 569, scale: 1.5, fontScale: FONT_SCALE }),
        Dimensions: { get: () => ({ width: SCREEN, height: 569, scale: 1.5, fontScale: FONT_SCALE }) },
    };
});
const nav = vi.hoisted(() => ({ real: null as any }));
vi.mock('expo-router', async () => {
    const { useContext, useEffect: effect } = await import('react');
    const { RouteCtx } = await import('./real-router');
    return {
        // The real functions (createRealRouter); only the instance is the test's own.
        router: {
            push: (...a: unknown[]) => nav.real.router.push(...a), navigate: (...a: unknown[]) => nav.real.router.navigate(...a), replace: (...a: unknown[]) => nav.real.router.replace(...a),
            back: () => nav.real.router.back(), dismiss: (n?: number) => nav.real.router.dismiss(n), canGoBack: () => nav.real.router.canGoBack(), setParams: (p: object) => nav.real.router.setParams(p),
        },
        useFocusEffect: (cb: () => void | (() => void)) => effect(() => cb(), [cb]),
        useLocalSearchParams: () => useContext(RouteCtx)?.params ?? {},
        useNavigation: () => ({ getState: () => nav.real.snapshot() }),
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
vi.mock('expo-file-system/legacy', () => ({ documentDirectory: 'file:///none/', makeDirectoryAsync: async () => {}, copyAsync: async () => {}, deleteAsync: async () => {}, readAsStringAsync: async () => '' }));
vi.mock('expo-image-picker', () => ({ launchImageLibraryAsync: async () => ({ canceled: true }), launchCameraAsync: async () => ({ canceled: true }), requestCameraPermissionsAsync: async () => ({ granted: false }) }));
vi.mock('expo-image-manipulator', () => ({ manipulateAsync: async (uri: string) => ({ uri, width: 0, height: 0 }), SaveFormat: { JPEG: 'jpeg' } }));
vi.mock('expo-crypto', () => ({ randomUUID: () => 'id' }));
vi.mock('expo-location', () => ({ getForegroundPermissionsAsync: async () => ({ status: 'denied' }), getLastKnownPositionAsync: async () => null }));
vi.mock('../../app/ThemeContext', async () => {
    const { lightColors } = await import('../../constants/colors');
    const now = () => ({ theme: 'light', colors: lightColors });
    return { useTheme: () => now(), useStyles: (make: (t: unknown) => unknown) => make(now()) };
});
const ME = { publicKey: 'me-key', callsign: 'Ana' };
vi.mock('../../app/IdentityContext', () => ({ useIdentity: () => ({ identity: ME }) }));
vi.mock('../../utils/use-node-profile', () => ({ useNodeProfile: () => ({ profile: 'local', features: { beans: true } }) }));
vi.mock('../../utils/market-global', () => ({ composerNeedsProfilePhoto: async () => false }));
vi.mock('../../utils/canonical-profile', () => ({ getCanonicalAvatar: async () => null }));

const disk = vi.hoisted(() => ({ db: null as any }));
vi.mock('../../utils/db', () => ({
    getDb: async () => disk.db,
    getMemberProfile: async () => ({ avatar_url: null }),
    getMyPosts: async () => [],
    getPost: async () => null,
    pausePost: async () => {},
    resumePost: async () => {},
    signedGet: async () => { throw new Error('no node here'); },
}));

// A phone half's screens thunk is require('./screens'): Metro bundles it, and vitest can't load a .tsx through Node's own
// require. The same modules, imported.
vi.mock('../garden/index', async () => {
    const { SCREENS } = await import('../garden/screens');
    return { default: { id: 'garden', screens: () => SCREENS } };
});
vi.mock('../things/index', async () => {
    const { SCREENS } = await import('../things/screens');
    return { default: { id: 'things', screens: () => SCREENS } };
});

import { DatabaseSync } from 'node:sqlite';
import { guideView, setLanguage } from '@beanpool/core';
import { TOOL_DOCS_TABLE } from '../schema';
import { openTool } from '../frame';
import { toolReminderRoute } from '../reminders';
import { toolHref, toolParams, toolPath, toolScreenOf } from '../route-params';
import { RouteCtx, createRealRouter, type RealRoute } from './real-router';
import ToolRoute from '../../app/tool/[id]';

function sqliteDb() {
    const d = new DatabaseSync(':memory:');
    const bind = (params?: unknown[]) => (params ?? []) as any[];
    return {
        execAsync: async (sql: string) => { d.exec(sql); },
        runAsync: async (sql: string, params?: unknown[]) => { const r = d.prepare(sql).run(...bind(params)); return { changes: Number(r.changes) }; },
        getFirstAsync: async (sql: string, params?: unknown[]) => d.prepare(sql).get(...bind(params)) ?? null,
        getAllAsync: async (sql: string, params?: unknown[]) => d.prepare(sql).all(...bind(params)),
    };
}

/** Every route of the real stack drawn, as native-stack keeps them mounted; the last is the one the member sees. */
function Stack() {
    const now = useSyncExternalStore(nav.real.subscribe, nav.real.snapshot) as { index: number; routes: RealRoute[] };
    return createElement('div', null, ...now.routes.map((route, i) => createElement(
        RouteCtx.Provider, { key: route.key, value: route },
        createElement('div', { 'data-top': i === now.index ? 'true' : 'false' }, route.name === 'tool/[id]' ? createElement(ToolRoute as any) : null),
    )));
}

let host: HTMLDivElement;
let root: Root;

beforeEach(async () => {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    store.map.clear();
    store.map.set('beanpool_anchor_url', 'https://mullum.example');
    disk.db = sqliteDb();
    await disk.db.execAsync(TOOL_DOCS_TABLE);
    nav.real = createRealRouter({ name: 'tools' });
    await act(async () => { root.render(createElement(Stack) as any); });
});
afterEach(() => { act(() => root.unmount()); host.remove(); setLanguage('en'); vi.useRealTimers(); });

const settle = async (n = 10) => { for (let i = 0; i < n; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); };
/** What the member sees: the top route's, never one covered by it. */
const onTop = (id: string) => host.querySelector(`[data-top="true"] [data-testid="${id}"]`);
const allOnTop = (prefix: string) => Array.from(host.querySelectorAll(`[data-top="true"] [data-testid^="${prefix}"]`));
async function tap(id: string) {
    const el = onTop(id);
    expect(el, `${id} on the screen the member sees`).not.toBeNull();
    await act(async () => { (el as HTMLElement).click(); });
    await settle(8);
}
async function go(open: () => void) {
    await act(async () => { open(); });
    await settle();
}
const openedGarden = () => go(() => openTool('garden'));
const depth = () => nav.real.routes().length;
/** A climate chosen, through the screens, back on the guide. */
async function chooseClimate() {
    await openedGarden();
    await tap('garden-choose');
    await tap('garden-zone-mild');
    expect(onTop('garden-zone-line')).not.toBeNull();
}

describe('Your garden on the phone: each tap opens what it says (Damo, 1 Nov)', () => {
    it('with no climate: Choose your climate opens Change, and a choice comes back to the guide', async () => {
        await openedGarden();
        expect(onTop('garden-no-zone')).not.toBeNull();
        await tap('garden-choose');
        expect(onTop('garden-zone')).not.toBeNull();
        expect(onTop('garden-no-zone')).toBeNull();
        await tap('garden-zone-mild');
        expect(onTop('garden-zone-line')).not.toBeNull();
        expect(depth()).toBe(2);
    });

    it('with a climate: Change opens Change, and ← comes straight back', async () => {
        await chooseClimate();
        await tap('garden-change');
        expect(onTop('garden-zone')).not.toBeNull();
        expect(depth()).toBe(3);
        await tap('tool-back');
        expect(onTop('garden-zone-line')).not.toBeNull();
        expect(depth()).toBe(2);
    });

    it("a crop's row opens that crop's page, from each list on the guide", async () => {
        // A month with a crop on every list, whenever this runs: Soon is empty in some months.
        const month = Array.from({ length: 12 }, (_, m) => m).find((m) => {
            const view = guideView('mild', 'north', m);
            return view.now.length > 0 && view.soon.length > 0;
        });
        expect(month).toBeDefined();
        vi.useFakeTimers({ toFake: ['Date'], now: new Date(2026, month as number, 15) });
        await chooseClimate();
        for (const list of ['garden-now-', 'garden-soon-', 'garden-all-']) {
            const rows = allOnTop(list).filter((r) => r.getAttribute('role') === 'button');
            expect(rows.length, list).toBeGreaterThan(0);
            await tap(rows[0].getAttribute('data-testid')!);
            expect(onTop('garden-crop-name'), list).not.toBeNull();
            expect(onTop('garden-crop-missing'), list).toBeNull();
            await tap('tool-back');
            expect(onTop('garden-zone-line'), list).not.toBeNull();
        }
    });

    it("Home's line opens the tool at the screen it names", async () => {
        await go(() => openTool('garden', 'zone'));
        expect(onTop('garden-zone')).not.toBeNull();
    });

    it('Remove my data on a later screen goes back to the first screen, with no second copy of it to back through', async () => {
        await chooseClimate();
        await tap('garden-change');
        await tap('tool-menu');
        await tap('tool-menu-remove');
        await settle();
        expect(onTop('garden-zone')).toBeNull();
        expect(onTop('garden-no-zone')).not.toBeNull();
        expect(nav.real.routes().map((r: RealRoute) => r.name)).toEqual(['tools', 'tool/[id]']);
    });

    it('Remove my data with a Home between it and the tool (Add to Home leaves the tool under it): that screen becomes the first', async () => {
        await chooseClimate();
        await go(() => nav.real.router.navigate('/tools'));
        await go(() => openTool('garden', 'zone'));
        const before = nav.real.routes().map((r: RealRoute) => r.name);
        expect(before).toEqual(['tools', 'tool/[id]', 'tools', 'tool/[id]']);
        await tap('tool-menu');
        await tap('tool-menu-remove');
        await settle();
        expect(onTop('garden-no-zone')).not.toBeNull();
        expect(nav.real.routes().map((r: RealRoute) => r.name)).toEqual(before);
    });

    it('Remove my data on a screen a link opened straight: that screen becomes the first, whichever name the link used', async () => {
        for (const param of ['screen', 'toolScreen']) {
            await go(() => nav.real.openLink(`/tool/garden?${param}=crop&key=tomato`));
            expect(onTop('garden-crop-name'), param).not.toBeNull();
            await tap('tool-menu');
            await tap('tool-menu-remove');
            await settle();
            expect(onTop('garden-no-zone'), param).not.toBeNull();
            expect(depth(), param).toBe(1);
            expect(nav.real.top().params.key, param).toBeUndefined();
        }
    });
});

describe('every tool, not only the garden: a screen named by a push is the screen drawn', () => {
    it("the Tool shed: I already do this, then Add a thing opens the form", async () => {
        await go(() => openTool('things'));
        await tap('tool-door-doing');
        await tap('things-add');
        expect(onTop('things-add')).toBeNull();
        expect(onTop('edit-save')).not.toBeNull();
    });

    it('a tapped reminder opens the screen it names', async () => {
        const href = toolReminderRoute({ remote: false, data: { bpLocal: 1, bpTool: 'things', screen: 'loans' } });
        await go(() => nav.real.router.push(href));
        expect(nav.real.top().params.id).toBe('things');
        expect(onTop('things-add')).toBeNull();
        expect(allOnTop('loans-').length).toBeGreaterThan(0);
    });
});

describe('a link from outside', () => {
    it('beanpool://tool/<id>?screen=… still opens that screen', async () => {
        await go(() => nav.real.openLink('/tool/garden?screen=zone'));
        expect(onTop('garden-zone')).not.toBeNull();
    });

    it('a crop by link is that crop', async () => {
        await go(() => nav.real.openLink('/tool/garden?screen=crop&key=tomato'));
        expect(onTop('garden-crop-name')).not.toBeNull();
        expect(onTop('garden-crop-missing')).toBeNull();
    });
});

describe("the route's own params", () => {
    it('a push never carries the word expo-router removes, and the host decides the tool and the screen', () => {
        expect(toolHref('garden', 'crop', { key: 'tomato' }).params).toEqual({ key: 'tomato', id: 'garden', toolScreen: 'crop' });
        expect(toolHref('garden').params).toEqual({ id: 'garden' });
        // A tool's own params can't point the route somewhere else.
        expect(toolHref('garden', 'crop', { id: 'things', toolScreen: 'zone' }).params).toEqual({ id: 'garden', toolScreen: 'crop' });
        expect(toolPath('garden', 'zone')).toBe('/tool/garden?toolScreen=zone');
        expect(toolPath('a b')).toBe('/tool/a%20b');
    });

    it("either name opens a screen, the app's own first; none means the first screen", () => {
        expect(toolScreenOf({ toolScreen: 'zone', screen: 'crop' })).toBe('zone');
        expect(toolScreenOf({ screen: 'crop' })).toBe('crop');
        expect(toolScreenOf({ id: 'garden' })).toBe('');
        expect(toolScreenOf({ toolScreen: ['zone', 'crop'] })).toBe('');
    });

    it("the tool sees only its own params, never the route's", () => {
        expect(toolParams({ id: 'garden', screen: 'crop', toolScreen: 'crop', key: 'tomato' })).toEqual({ key: 'tomato' });
        expect(toolParams({ id: 'garden', key: ['a', 'b'] })).toEqual({});
    });
});
