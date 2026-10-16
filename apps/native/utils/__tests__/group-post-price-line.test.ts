// @vitest-environment jsdom
/**
 * The group composer's price on a node that previews Beans (scratch/global-previews-audit/PHONE.md §3 item 2; REPORT.md
 * "Listing price slot … and composer"): under the note that a post has no price here, the marker's price line, as the
 * listing's edit form draws it (app/post/[id].tsx, "Credits + Price Type"). Beans off without a showcase: the note
 * alone. Local: the price field, no note, no line. The composer in map.tsx is protected and is not changed here.
 * The screen is drawn for real; the mode comes from the phone's own copy of the node's profile, as on a phone.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { LOCAL_COMMUNITY_LINES, LOCAL_COMMUNITY_SHEET } from '@beanpool/core';
import { NO_BEANS_EDIT_NOTE } from '../market-global';

(globalThis as any).__DEV__ = false;
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native', () => {
    const roles: Record<string, string> = { header: 'heading', button: 'button' };
    const el = (tag: string) => (props: Record<string, any>) => {
        const { children, onPress, accessibilityLabel, accessibilityRole, testID } = props;
        const attrs: Record<string, unknown> = {};
        if (testID) attrs['data-testid'] = testID;
        if (props.placeholder) attrs.placeholder = props.placeholder;
        if (onPress) attrs.onClick = () => onPress({ stopPropagation() {} });
        if (accessibilityLabel) attrs['aria-label'] = accessibilityLabel;
        if (accessibilityRole && roles[accessibilityRole]) attrs.role = roles[accessibilityRole];
        return createElement(tag, attrs, children);
    };
    return {
        Platform: { OS: 'android', select: (o: Record<string, unknown>) => o.android ?? o.default },
        View: el('div'), Text: el('span'), Pressable: el('button'), ScrollView: el('div'), TextInput: el('input'),
        ActivityIndicator: el('span'),
        Modal: ({ visible, children }: { visible: boolean; children?: unknown }) => (visible ? createElement('div', { 'data-modal': 'true' }, children as any) : null),
        StyleSheet: { create: (s: unknown) => s, hairlineWidth: 1, absoluteFill: {}, flatten: (s: unknown) => s },
        Alert: { alert() {} },
        Dimensions: { get: () => ({ width: 320, height: 569, scale: 1.5, fontScale: 1.3 }) },
        useWindowDimensions: () => ({ width: 320, height: 569, scale: 1.5, fontScale: 1.3 }),
    };
});
vi.mock('react-native-keyboard-controller', () => ({ KeyboardAvoidingView: ({ children }: { children?: unknown }) => createElement('div', null, children as any) }));
vi.mock('react-native-safe-area-context', () => ({ SafeAreaView: ({ children }: { children?: unknown }) => createElement('div', null, children as any) }));
vi.mock('expo-router', async () => {
    const { useEffect } = await import('react');
    return {
        router: { push() {}, back() {}, navigate() {} },
        useLocalSearchParams: () => ({ groupId: 'g1', groupName: 'Garden' }),
        ErrorBoundary: () => null,
        useFocusEffect: (cb: () => void | (() => void)) => useEffect(() => cb(), [cb]),
    };
});
vi.mock('expo-crypto', () => ({ randomUUID: () => 'uuid', getRandomBytes: (n: number) => new Uint8Array(n) }));
vi.mock('@expo/vector-icons', () => ({ MaterialCommunityIcons: ({ name }: { name: string }) => createElement('span', { 'data-icon': name }) }));
const store = vi.hoisted(() => ({ map: new Map<string, string>() }));
vi.mock('@react-native-async-storage/async-storage', () => ({
    default: {
        getItem: vi.fn(async (k: string) => store.map.get(k) ?? null),
        setItem: vi.fn(async (k: string, v: string) => { store.map.set(k, v); }),
        removeItem: vi.fn(async (k: string) => { store.map.delete(k); }),
    },
}));
vi.mock('../db', () => ({ createPost: vi.fn(async () => ({})) }));
vi.mock('../haptics', () => ({ hapticSuccess() {}, hapticWarning() {} }));
vi.mock('../../app/IdentityContext', () => ({ useIdentity: () => ({ identity: { publicKey: 'me', callsign: 'Me' } }) }));
vi.mock('../../components/CategoryPickerSheet', () => ({ CategoryPickerSheet: () => null }));
const theme = vi.hoisted(() => ({ dark: false }));
vi.mock('../../app/ThemeContext', async () => {
    const { lightColors: light, darkColors: dark } = await import('../../constants/colors');
    const colors = () => (theme.dark ? dark : light);
    return {
        useTheme: () => ({ theme: theme.dark ? 'dark' : 'light', colors: colors() }),
        useStyles: (make: (t: { theme: string; colors: unknown }) => unknown) => make({ theme: theme.dark ? 'dark' : 'light', colors: colors() }),
    };
});

import GroupPostScreen from '../../app/group-post';

const NODE = 'https://node.example';
function rememberProfile(profile: 'global' | 'local', features: Record<string, boolean>) {
    store.map.set('beanpool_node_profiles', JSON.stringify({ [NODE]: { profile, features, checkedAt: new Date().toISOString() } }));
}

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    store.map.clear();
    store.map.set('beanpool_anchor_url', NODE);
    globalThis.fetch = vi.fn(async () => new Response('{}')) as typeof fetch;
});
afterEach(() => { act(() => root.unmount()); host.remove(); });

const render = async () => {
    await act(async () => { root.render(createElement(GroupPostScreen)); });
    for (let i = 0; i < 5; i++) await act(async () => {});
};
const text = () => host.textContent ?? '';
const noteBox = () => Array.from(host.querySelectorAll('span')).find(s => s.textContent === NO_BEANS_EDIT_NOTE)?.parentElement ?? null;

for (const scheme of ['light', 'dark'] as const) {
    describe(`the group composer's price, ${scheme}`, () => {
        beforeEach(() => { theme.dark = scheme === 'dark'; });

        it('Beans a preview (global, showcase on): the note, then the marker\'s price line beside it; it opens the sheet', async () => {
            rememberProfile('global', { beans: false, escrow: false, showcase: true });
            await render();
            const box = noteBox()!;
            expect(box).not.toBeNull();
            expect(box.textContent).toContain(LOCAL_COMMUNITY_LINES.price);
            expect(host.querySelector('input[placeholder="0"]')).toBeNull();
            const line = Array.from(box.querySelectorAll('button')).find(b => b.textContent === LOCAL_COMMUNITY_LINES.price)!;
            await act(async () => { line.click(); });
            expect(host.querySelector('[data-testid="local-community-sheet"]')?.textContent).toContain(LOCAL_COMMUNITY_SHEET.features.beans);
        });

        it('Beans off with no showcase: the note alone, no marker', async () => {
            rememberProfile('global', { beans: false, escrow: false, showcase: false });
            await render();
            expect(noteBox()).not.toBeNull();
            expect(text()).not.toContain(LOCAL_COMMUNITY_LINES.price);
        });

        it('local: the price field, as before; no note and no line', async () => {
            rememberProfile('local', { beans: true, escrow: true });
            await render();
            expect(host.querySelector('input[placeholder="0"]')).not.toBeNull();
            expect(noteBox()).toBeNull();
            expect(text()).not.toContain(LOCAL_COMMUNITY_LINES.price);
        });
    });
}
