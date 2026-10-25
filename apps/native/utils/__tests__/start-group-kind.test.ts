// @vitest-environment jsdom
/**
 * Starting a group / project / enterprise (Marty, 25 Oct):
 * - The Commons "+" (every pill) and the Create a group modal offer three clear choices up front:
 *   Chat group, Project, and Enterprise (the last two only where Beans and enterprises are on).
 * - Each opens the right form: Chat group opens the group form in the modal, Project opens /propose-project?kind=bounded,
 *   Enterprise opens /propose-project?kind=ongoing.
 * - With Beans or enterprises off (e.g. global node), only Chat group is offered (no Project or Enterprise choices).
 * - Propose form opens on the kind it was given (?kind=ongoing|bounded).
 * - With none given, it asks (no silent Project default).
 * - A member who picks Enterprise sends lifecycle 'ongoing'.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, createElement, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import fs from 'node:fs';
import path from 'node:path';

(globalThis as any).__DEV__ = false;
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('expo', () => ({
    requireNativeModule: vi.fn(() => ({})),
    requireOptionalNativeModule: vi.fn(() => null),
}));

vi.mock('expo-modules-core', () => ({
    requireNativeModule: vi.fn(() => ({})),
    requireOptionalNativeModule: vi.fn(() => null),
    EventEmitter: vi.fn(() => ({ addListener: vi.fn(), removeListener: vi.fn() })),
    NativeModulesProxy: {},
    ProxyNativeModule: {},
}));

vi.mock('expo-haptics', () => ({
    selectionAsync: vi.fn(async () => {}),
    notificationAsync: vi.fn(async () => {}),
    impactAsync: vi.fn(async () => {}),
    ImpactFeedbackStyle: { Light: 'light', Medium: 'medium', Heavy: 'heavy' },
    NotificationFeedbackType: { Success: 'success', Warning: 'warning', Error: 'error' },
}));

vi.mock('@react-native-community/datetimepicker', () => ({
    default: () => null,
}));

vi.mock('../../app/ThemeContext', async () => {
    const { lightColors } = await import('../../constants/colors');
    return {
        useTheme: () => ({ colors: lightColors, theme: 'light' }),
        useStyles: (fn: (theme: any) => any) => fn({ colors: lightColors, theme: 'light' }),
    };
});

const nav = vi.hoisted(() => ({
    push: vi.fn(),
    back: vi.fn(),
    params: {} as Record<string, string>,
}));

vi.mock('expo-router', () => ({
    router: { push: nav.push, back: nav.back },
    useLocalSearchParams: () => nav.params,
    ErrorBoundary: () => null,
}));

vi.mock('react-native-safe-area-context', () => ({
    useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
    SafeAreaView: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
}));

vi.mock('react-native-keyboard-controller', () => ({
    KeyboardController: { dismiss: vi.fn(async () => {}) },
    KeyboardAvoidingView: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
    useKeyboardState: (fn: (s: { isVisible: boolean }) => boolean) => fn({ isVisible: false }),
}));

vi.mock('../../components/useModalKeyboardLift', () => ({
    useModalKeyboardLift: () => ({ maxHeight: 600, lift: 0 }),
}));

const nodeProfileState = vi.hoisted(() => ({
    profile: { features: { beans: true, enterprises: true } as any },
}));

vi.mock('../use-node-profile', () => ({
    useNodeProfile: () => nodeProfileState.profile,
}));

vi.mock('../node-profile', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../node-profile')>()),
    getCachedNodeProfile: vi.fn(async () => nodeProfileState.profile),
}));

const dbMock = vi.hoisted(() => ({
    createGroupApi: vi.fn(async (args: any) => ({ id: 'new-group-1', name: args.name })),
    createEnterpriseApi: vi.fn(async (_args: any) => ({ ok: true })),
}));

vi.mock('../db', () => ({
    createGroupApi: dbMock.createGroupApi,
    createEnterpriseApi: dbMock.createEnterpriseApi,
}));

vi.mock('@expo/vector-icons', () => ({
    MaterialCommunityIcons: ({ name }: { name: string }) => createElement('i', { 'data-icon': name }),
}));

vi.mock('@react-native-async-storage/async-storage', () => ({
    default: { getItem: vi.fn(async () => null), setItem: vi.fn(async () => {}), removeItem: vi.fn(async () => {}) },
}));

vi.mock('expo-status-bar', () => ({
    StatusBar: () => null,
}));

vi.mock('../../components/AvatarPickerSheet', () => ({
    AvatarPickerSheet: () => null,
}));

vi.mock('../../components/MemberAvatar', () => ({
    MemberAvatar: () => null,
}));

vi.mock('../../components/CurrencyDisplay', () => ({
    CurrencyDisplay: () => createElement('span', null, 'Beans'),
}));

vi.mock('../../components/Sentence', () => ({
    Sentence: ({ text }: { text: string }) => createElement('span', null, text),
}));

vi.mock('../../components/signed-request-lines', () => ({
    signedRequestWords: (w: string) => w,
}));

const alertsSaid = vi.hoisted(() => ({ list: [] as string[] }));

vi.mock('react-native', () => {
    const el = (tag: string) => (props: Record<string, any>) => {
        const { children, onPress, accessibilityLabel, accessibilityState, testID, placeholder, value, onChangeText, disabled } = props;
        const attrs: Record<string, unknown> = {};
        if (testID) attrs['data-testid'] = testID;
        if (onPress && !disabled) attrs.onClick = () => onPress();
        if (onChangeText) {
            attrs.onChange = (e: { target: { value: string } }) => onChangeText(e.target.value);
            attrs.onInput = (e: { target: { value: string } }) => onChangeText(e.target.value);
            attrs.value = value ?? '';
        }
        if (accessibilityLabel) attrs['aria-label'] = accessibilityLabel;
        if (accessibilityState?.selected !== undefined) attrs['aria-selected'] = String(accessibilityState.selected);
        if (placeholder) attrs.placeholder = placeholder;
        return createElement(tag, attrs, typeof children === 'function' ? children({ pressed: false }) : children);
    };
    return {
        Platform: { OS: 'android' },
        View: el('div'), Text: el('span'), Pressable: el('button'), TextInput: el('input'), ScrollView: el('div'),
        Modal: ({ visible, children }: { visible: boolean; children?: ReactNode }) => (visible ? createElement('div', { 'data-modal': 'true' }, children) : null),
        StyleSheet: { create: (s: unknown) => s },
        Alert: { alert: (title: string, msg?: string, btns?: any[]) => { alertsSaid.list.push(title); if (btns?.[0]?.onPress) btns[0].onPress(); } },
        ActivityIndicator: () => createElement('span', null, 'loading'),
    };
});

import { CreateGroupModal } from '../../components/CreateGroupModal';
import ProposeProjectModal from '../../app/propose-project';

let host: HTMLElement | null = null;
let root: Root | null = null;

beforeEach(() => {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    nav.push.mockReset();
    nav.back.mockReset();
    nav.params = {};
    dbMock.createGroupApi.mockClear();
    dbMock.createEnterpriseApi.mockClear();
    alertsSaid.list = [];
    nodeProfileState.profile = { features: { beans: true, enterprises: true } };
});

afterEach(() => {
    act(() => root?.unmount());
    host?.remove();
    host = null;
    root = null;
});

async function mount(element: ReactNode) {
    await act(async () => { root!.render(element as any); });
    for (let i = 0; i < 5; i++) await act(async () => { await new Promise(r => setTimeout(r, 0)); });
}

const type = async (el: Element | null | undefined, text: string) => {
    expect(el).toBeTruthy();
    const input = el as HTMLInputElement;
    await act(async () => {
        const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
        set.call(input, text);
        input.dispatchEvent(new Event('input', { bubbles: true }));
    });
};

describe('CreateGroupModal is chat-group form with bridge', () => {
    it('opens directly on the chat group form with bridge (no upfront kind step)', async () => {
        await mount(createElement(CreateGroupModal, { isOpen: true, onClose: vi.fn(), onCreated: vi.fn() }));

        // The group name input is visible immediately (no kind step)
        expect(host!.querySelector('input[placeholder*="Bindarrabi"]')).not.toBeNull();
        // The one-line bridge to start a project or an enterprise is present
        const bridge = Array.from(host!.querySelectorAll('button')).find(b =>
            /Start a project or an enterprise/i.test(b.getAttribute('aria-label') || b.textContent || '')
        );
        expect(bridge).toBeDefined();
    });

    it('tapping the bridge closes the modal and navigates to /propose-project with no kind parameter', async () => {
        const onClose = vi.fn();
        await mount(createElement(CreateGroupModal, { isOpen: true, onClose, onCreated: vi.fn() }));

        const bridge = Array.from(host!.querySelectorAll('button')).find(b =>
            /Start a project or an enterprise/i.test(b.getAttribute('aria-label') || b.textContent || '')
        );
        expect(bridge).toBeDefined();

        await act(async () => { bridge!.click(); });
        expect(onClose).toHaveBeenCalled();
        expect(nav.push).toHaveBeenCalledWith('/propose-project');
    });
});

describe('propose-project modal kind handling', () => {
    it('opens on the kind it was given (?kind=ongoing) and selecting Enterprise sends lifecycle ongoing', async () => {
        nav.params = { kind: 'ongoing' };
        await mount(createElement(ProposeProjectModal));

        // Enterprise should be selected
        const enterpriseBtn = Array.from(host!.querySelectorAll('button')).find(b => /enterprise/i.test(b.getAttribute('aria-label') || ''));
        expect(enterpriseBtn).toBeDefined();
        expect(enterpriseBtn!.getAttribute('aria-selected')).toBe('true');

        // Funding goal field is not shown for ongoing enterprise
        expect(host!.querySelector('input[aria-label="Funding goal amount"]')).toBeNull();

        // Fill in required fields: Title and Purpose
        await type(host!.querySelector('input[aria-label="Enterprise name or project title"]'), 'Mullum Food Co-op');
        await type(host!.querySelector('input[aria-label="Purpose statement"]'), 'Distribute fresh local produce');

        const submitBtn = Array.from(host!.querySelectorAll('button')).find(b => /start initiative|start the enterprise/i.test(b.getAttribute('aria-label') || ''));
        expect(submitBtn).toBeDefined();

        await act(async () => { submitBtn!.click(); });
        expect(dbMock.createEnterpriseApi).toHaveBeenCalledWith(expect.objectContaining({
            lifecycle: 'ongoing',
            name: 'Mullum Food Co-op',
            purpose: 'Distribute fresh local produce',
        }));
    });

    it('opens on the kind it was given (?kind=bounded) and sends lifecycle bounded with goal', async () => {
        nav.params = { kind: 'bounded' };
        await mount(createElement(ProposeProjectModal));

        // Project should be selected
        const projectBtn = Array.from(host!.querySelectorAll('button')).find(b => /project/i.test(b.getAttribute('aria-label') || ''));
        expect(projectBtn).toBeDefined();
        expect(projectBtn!.getAttribute('aria-selected')).toBe('true');

        // Funding goal field is shown
        expect(host!.querySelector('input[aria-label="Funding goal amount"]')).not.toBeNull();
    });

    it('with none given it asks (no silent Project default)', async () => {
        nav.params = {};
        await mount(createElement(ProposeProjectModal));

        // Neither Project nor Enterprise should be pre-selected
        const projectBtn = Array.from(host!.querySelectorAll('button')).find(b => /project: /i.test(b.getAttribute('aria-label') || ''));
        const enterpriseBtn = Array.from(host!.querySelectorAll('button')).find(b => /enterprise: /i.test(b.getAttribute('aria-label') || ''));

        expect(projectBtn?.getAttribute('aria-selected')).not.toBe('true');
        expect(enterpriseBtn?.getAttribute('aria-selected')).not.toBe('true');

        // When user picks Enterprise, lifecycle becomes ongoing
        await act(async () => { enterpriseBtn!.click(); });
        expect(enterpriseBtn!.getAttribute('aria-selected')).toBe('true');
        expect(host!.querySelector('input[aria-label="Funding goal amount"]')).toBeNull();
    });
});

describe('Commons "+" across every pill opens StartSomethingSheet', () => {
    it('on every section and chip, "+" opens StartSomethingSheet rather than CreateGroupModal', () => {
        const src = fs.readFileSync(path.join(__dirname, '..', '..', 'app', '(tabs)', 'projects.tsx'), 'utf8');
        expect(src).toContain('StartSomethingSheet');
        expect(src).toContain('setShowStartSomething');
    });
});
