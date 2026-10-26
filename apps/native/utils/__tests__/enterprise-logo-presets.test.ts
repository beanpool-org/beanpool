// @vitest-environment jsdom
/**
 * enterprise-logo-presets — an enterprise's logo can be one of the ready-made pictures (presets)
 * on the phone, in both the propose form (app/propose-project.tsx) and the Manage logo row
 * (components/shopfront/Manage.tsx).
 *
 * Tests first:
 * - Phone propose form opens AvatarPickerSheet with presets.
 * - Picking a preset sets the logo to that value (bundled://<id>) and creates enterprise with it.
 * - Picking a photo still works, through the crop step (512 px square; components/PictureCrop.tsx).
 * - Manage logo row opens AvatarPickerSheet with presets.
 * - Picking a preset sets draft.logo to bundled://<id> and saves it.
 * - Picking a photo still works.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Module from 'node:module';
import { act, createElement, useEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';

(Module as any)._extensions['.png'] = (m: { exports: unknown }) => { m.exports = 1; };
vi.hoisted(() => {
    const Loader = (process as any).getBuiltinModule('node:module');
    Loader._extensions['.jpg'] = (m: { exports: unknown }) => { m.exports = 1; };
});
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

vi.mock('expo-crypto', () => ({ randomUUID: () => 'uuid', getRandomBytes: (n: number) => new Uint8Array(n) }));
vi.mock('expo-constants', () => ({ default: { expoConfig: { version: '1.0.0' } } }));

const alerts = vi.hoisted(() => ({ said: [] as string[] }));
vi.mock('react-native', () => {
    const roles: Record<string, string> = { header: 'heading', button: 'button', radio: 'radio', checkbox: 'checkbox' };
    const flat = (style: unknown): Record<string, any> => Object.assign({}, ...[style].flat(4).filter((x) => x && typeof x === 'object'));
    const el = (tag: string) => function Host(props: Record<string, any>) {
        const { children, onPress, accessibilityLabel, accessibilityRole, accessibilityState, testID, placeholder, onLayout, value, onChangeText, disabled, numberOfLines } = props;
        useEffect(() => { onLayout?.({ nativeEvent: { layout: { x: 0, y: 0, width: 288, height: 40 } } }); }, []);
        const attrs: Record<string, unknown> = {};
        if (testID) attrs['data-testid'] = testID;
        if (onPress && !disabled) attrs.onClick = (e: { stopPropagation(): void }) => { e.stopPropagation(); onPress({ stopPropagation() {}, nativeEvent: {} }); };
        if (onChangeText) {
            attrs.onChange = (e: { target: { value: string } }) => onChangeText(e.target.value);
            attrs.onInput = (e: { target: { value: string } }) => onChangeText(e.target.value);
            attrs.value = value ?? '';
        }
        if (accessibilityLabel) attrs['aria-label'] = accessibilityLabel;
        if (accessibilityRole && roles[accessibilityRole]) attrs.role = roles[accessibilityRole];
        if (accessibilityState?.selected !== undefined) attrs['aria-selected'] = String(accessibilityState.selected);
        if (accessibilityState?.disabled || disabled) attrs['aria-disabled'] = 'true';
        if (placeholder) attrs.placeholder = placeholder;
        attrs['data-style'] = JSON.stringify(flat(typeof props.style === 'function' ? props.style({ pressed: false }) : props.style));
        return createElement(tag, attrs, children);
    };
    return {
        Platform: { OS: 'android', select: (o: Record<string, unknown>) => o.android ?? o.default },
        Image: el('img'),
        Dimensions: { get: () => ({ width: 320, height: 569, scale: 1.5, fontScale: 1.3 }) },
        View: el('div'), Text: el('span'), Pressable: el('div'), ScrollView: el('div'), TextInput: el('input'),
        TouchableOpacity: el('div'), SafeAreaView: el('div'), ActivityIndicator: () => createElement('span', { 'data-spinner': 'true' }),
        Modal: ({ visible, children }: { visible: boolean; children?: unknown }) => (visible ? createElement('div', { 'data-modal': 'true' }, children as any) : null),
        StyleSheet: { create: (s: unknown) => s, hairlineWidth: 1, absoluteFill: {}, absoluteFillObject: {}, flatten: (s: unknown) => flat(s) },
        PanResponder: { create: () => ({ panHandlers: {} }) },
        Alert: { alert: (title: string, body?: string) => { alerts.said.push(title); if (body) alerts.said.push(body); } },
        Keyboard: { dismiss: vi.fn() },
        AppState: { currentState: 'active', addEventListener: () => ({ remove() {} }) },
        useWindowDimensions: () => ({ width: 320, height: 569, scale: 1.5, fontScale: 1.3 }),
    };
});

vi.mock('expo-router', () => ({
    router: { push: vi.fn(), navigate: vi.fn(), replace: vi.fn(), back: vi.fn() },
    useLocalSearchParams: () => ({ kind: 'bounded' }),
    ErrorBoundary: () => null,
}));
vi.mock('react-native-keyboard-controller', () => ({
    KeyboardAvoidingView: ({ children }: any) => createElement('div', null, children),
    KeyboardController: { dismiss: vi.fn() },
    useKeyboardState: (cb: any) => cb({ isVisible: false }),
}));
vi.mock('@react-native-async-storage/async-storage', () => ({
    default: {
        getItem: vi.fn(async () => null),
        setItem: vi.fn(async () => {}),
        removeItem: vi.fn(async () => {}),
    },
}));
vi.mock('@expo/vector-icons', () => ({
    MaterialCommunityIcons: ({ name }: { name: string }) => createElement('i', { 'data-icon': name }),
}));
vi.mock('expo-image', () => ({
    Image: ({ source, accessibilityLabel }: any) => createElement('img', { src: source?.uri || 'bundled-src', 'aria-label': accessibilityLabel }),
}));
vi.mock('expo-status-bar', () => ({ StatusBar: () => null }));
vi.mock('@react-native-community/datetimepicker', () => ({ default: () => null }));
vi.mock('react-native-safe-area-context', () => ({
    SafeAreaView: ({ children }: any) => createElement('div', null, children),
    useSafeAreaInsets: () => ({ top: 24, bottom: 0, left: 0, right: 0 }),
}));

const imagePickerMock = vi.hoisted(() => ({
    result: null as any,
    permGranted: true,
}));
vi.mock('expo-image-picker', () => ({
    requestCameraPermissionsAsync: vi.fn(async () => ({ granted: imagePickerMock.permGranted })),
    launchCameraAsync: vi.fn(async () => imagePickerMock.result ?? { canceled: true }),
    launchImageLibraryAsync: vi.fn(async () => imagePickerMock.result ?? { canceled: true }),
}));

vi.mock('expo-image-manipulator', () => ({
    manipulateAsync: vi.fn(async (_uri: string, actions: any[]) => ({
        uri: 'file:///resized.jpg',
        base64: ' UkVTSVpFRF9QSFRPTw==',
        width: actions?.[0]?.resize?.width ?? 800,
        height: actions?.[0]?.resize?.width ? actions[0].resize.width * 0.75 : 600,
    })),
    SaveFormat: { JPEG: 'jpeg', PNG: 'png' },
}));

vi.mock('../../app/ThemeContext', async () => {
    const { lightColors } = await import('../../constants/colors');
    const ctx = { colors: lightColors, theme: 'light' };
    return { useTheme: () => ctx, useStyles: (make: (t: unknown) => unknown) => make(ctx) };
});

const createdEnterprises = vi.hoisted(() => ({ calls: [] as any[] }));
vi.mock('../../utils/db', () => ({
    createEnterpriseApi: vi.fn(async (params: any) => {
        createdEnterprises.calls.push(params);
        return { success: true };
    }),
}));

const faceChanges = vi.hoisted(() => ({ calls: [] as any[] }));
vi.mock('../../utils/shop', async (importOriginal) => {
    const actual = await importOriginal<any>();
    return {
        ...actual,
        changeEnterpriseFace: vi.fn(async (treasury: string, face: any) => {
            faceChanges.calls.push({ treasury, face });
        }),
    };
});

import ProposeProjectModal from '../../app/propose-project';
import { ManageFace } from '../../components/shopfront/Manage';
import { resolveBundledAvatar } from '../bundled-avatars';

describe('enterprise logo presets (phone)', () => {
    let host: HTMLDivElement;
    let root: Root;

    beforeEach(() => {
        host = document.createElement('div');
        document.body.appendChild(host);
        root = createRoot(host);
        alerts.said = [];
        createdEnterprises.calls = [];
        faceChanges.calls = [];
    });

    afterEach(async () => {
        await act(async () => { root.unmount(); });
        host.remove();
    });

    const click = async (el: Element | null, name = 'element') => {
        expect(el, `cannot click missing ${name}`).toBeTruthy();
        await act(async () => { (el as HTMLElement).click(); });
    };

    const type = async (el: Element | null, val: string) => {
        expect(el).toBeTruthy();
        await act(async () => {
            const input = el as HTMLInputElement;
            const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
            if (set) {
                set.call(input, val);
            } else {
                input.value = val;
            }
            input.dispatchEvent(new Event('input', { bubbles: true }));
            input.dispatchEvent(new Event('change', { bubbles: true }));
        });
    };

    it('propose form opens AvatarPickerSheet with presets; picking a preset sets the logo to bundled://<id>', async () => {
        await act(async () => {
            root.render(createElement(ProposeProjectModal) as any);
        });

        // Pictures S4: Label is LOGO (not LOGO (OPTIONAL))
        expect(host.textContent).toContain('LOGO');
        expect(host.textContent).not.toContain('LOGO (OPTIONAL)');

        // Pictures S4: Start button reads "Choose a logo" and is disabled while no logo is chosen
        const submitBtns = Array.from(host.querySelectorAll('[role="button"]')).filter((b) =>
            b.getAttribute('aria-label') === 'Choose a logo'
        );
        // There should be the logo picker slot and the footer submit button
        expect(submitBtns.length).toBeGreaterThanOrEqual(1);

        // Tapping the logo button opens the picker
        const chooseLogoBtn = host.querySelector('[aria-label="Choose a logo"]');
        expect(chooseLogoBtn).toBeTruthy();
        await click(chooseLogoBtn, 'Choose a logo');

        // Preset avatars should be offered in the picker sheet
        const leafAvatarBtn = host.querySelector('[aria-label="Select Leaf avatar"]');
        expect(leafAvatarBtn, 'Avatar picker sheet with preset avatars should be open').toBeTruthy();

        // Select leaf avatar
        await click(leafAvatarBtn, 'Select Leaf avatar');

        // Confirm button
        const confirmBtn = Array.from(host.querySelectorAll('[role="button"]')).find((b) => b.textContent?.trim() === 'Use Selected Avatar');
        expect(confirmBtn).toBeTruthy();
        await click(confirmBtn!, 'Use Selected Avatar');

        // Fill required fields
        const nameInput = host.querySelector('input[placeholder="e.g. Community Tool Shed"]');
        await type(nameInput, 'Organic Seed Library');
        const purposeInput = host.querySelector('input[aria-label="Purpose statement"]');
        await type(purposeInput, 'We preserve and share heritage vegetable seeds');
        const goalInput = host.querySelector('input[placeholder="0"]');
        await type(goalInput, '200');

        // Submit initiative
        const submitBtn = Array.from(host.querySelectorAll('[aria-label]')).find((el) => el.getAttribute('aria-label') === 'Start the project 🌱') as HTMLElement | null;
        await click(submitBtn, 'Start the project');

        expect(createdEnterprises.calls).toHaveLength(1);
        expect(createdEnterprises.calls[0].avatar).toBe('bundled://leaf');
        expect(createdEnterprises.calls[0].photos).toEqual(['bundled://leaf']);
    });

    it('propose form picking a photo still works via the picker sheet', async () => {
        imagePickerMock.result = {
            canceled: false,
            assets: [{ uri: 'file:///photo.jpg', width: 4000, height: 3000 }],
        };

        await act(async () => {
            root.render(createElement(ProposeProjectModal) as any);
        });

        const chooseLogoBtn = host.querySelector('[aria-label="Choose a logo"]');
        await click(chooseLogoBtn, 'Choose a logo');

        // Gallery button in sheet
        const galleryBtn = host.querySelector('[aria-label="Choose photo from gallery"]');
        expect(galleryBtn).toBeTruthy();
        await click(galleryBtn, 'Choose photo from gallery');

        // The crop step: the part of the photo that shows in the circle (components/PictureCrop.tsx), then Done.
        await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
        expect(host.querySelector('[data-testid="picture-crop"]'), 'the crop step opens on the photo').toBeTruthy();
        await click(host.querySelector('[data-testid="picture-crop-done"]'), 'Done');
        await act(async () => { await new Promise((r) => setTimeout(r, 0)); });

        // Fill required fields
        const nameInput = host.querySelector('input[placeholder="e.g. Community Tool Shed"]');
        await type(nameInput, 'Tool Shed Project');
        const purposeInput = host.querySelector('input[aria-label="Purpose statement"]');
        await type(purposeInput, 'We share power tools');
        const goalInput = host.querySelector('input[placeholder="0"]');
        await type(goalInput, '150');

        const submitBtn = Array.from(host.querySelectorAll('[aria-label]')).find((el) => el.getAttribute('aria-label') === 'Start the project 🌱') as HTMLElement | null;
        await click(submitBtn, 'Start the project');

        expect(createdEnterprises.calls).toHaveLength(1);
        expect(createdEnterprises.calls[0].avatar).toMatch(/^data:image\/jpeg;base64,/);
    });

    it('manage logo row opens AvatarPickerSheet with presets; picking a preset sets the logo to bundled://<id>', async () => {
        await act(async () => {
            root.render(createElement(ManageFace, {
                treasury: 'ent-key-1',
                detail: { name: 'Hill Bakery', purpose: 'Bread', about: 'Baking' } as any,
                lead: true,
                keeper: true,
                project: false,
                logoUrl: null,
                onSaved: () => {},
            }) as any);
        });

        const changeLogoBtn = host.querySelector('[data-testid="manage-face-logo"]');
        expect(changeLogoBtn).toBeTruthy();
        await click(changeLogoBtn, 'Change the logo');

        // Picker sheet opens with preset avatars
        const sunAvatarBtn = host.querySelector('[aria-label="Select Sun avatar"]');
        expect(sunAvatarBtn, 'Avatar picker sheet with preset avatars should be open').toBeTruthy();

        // Select sun avatar
        await click(sunAvatarBtn, 'Select Sun avatar');

        const confirmBtn = Array.from(host.querySelectorAll('[role="button"]')).find((b) => b.textContent?.trim() === 'Use Selected Avatar');
        expect(confirmBtn).toBeTruthy();
        await click(confirmBtn!, 'Use Selected Avatar');

        // Save face
        const saveBtn = host.querySelector('[data-testid="manage-face-save"]');
        await click(saveBtn, 'Save');
        await act(async () => { await new Promise((r) => setTimeout(r, 20)); });

        expect(faceChanges.calls).toHaveLength(1);
        expect(faceChanges.calls[0].face.avatar).toBe('bundled://sun');
    });

    it('resolveBundledAvatar safely handles null, undefined, non-strings, and prototype properties', () => {
        expect(resolveBundledAvatar(null)).toBeNull();
        expect(resolveBundledAvatar(undefined)).toBeNull();
        expect(resolveBundledAvatar('' as any)).toBeNull();
        expect(resolveBundledAvatar(123 as any)).toBeNull();
        expect(resolveBundledAvatar('bundled://toString')).toBeNull();
        expect(resolveBundledAvatar('bundled://valueOf')).toBeNull();
        expect(resolveBundledAvatar('bundled://constructor')).toBeNull();
        expect(resolveBundledAvatar('bundled://sun')).toBeTruthy();
    });
});
