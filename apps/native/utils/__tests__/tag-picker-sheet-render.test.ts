// @vitest-environment jsdom
/**
 * The phone's tag sheet (components/TagPicker.tsx, DESIGN-owner-seeding-tags-fable.md §4.4), rendered for real at 320 dp and
 * 1.3× text, in both themes: the review of #2663's points on the sheet. It shuts on its own (Android's back, Escape where a
 * keyboard has one) without reaching the screen under it; nothing in it submits anything; the button reads "+ Add" once;
 * every target is 44 dp; and the keyboard is down before the sheet opens and the search stays above it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';

(globalThis as any).__DEV__ = false;
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const device = vi.hoisted(() => ({
    backHandlers: [] as Array<() => boolean>,
    keyboardDown: 0,
    /** Each Pressable drawn, what it says and the box it asks for. */
    theme: 'light' as 'light' | 'dark',
}));

vi.mock('react-native', () => {
    const flat = (style: unknown): Record<string, any> => Object.assign({}, ...[style].flat(4).filter((x) => x && typeof x === 'object'));
    const el = (tag: string) => function Host(props: Record<string, any>) {
        const { children, onPress, accessibilityLabel, accessibilityRole, testID, placeholder, value, onChangeText, onSubmitEditing, style, hitSlop } = props;
        const attrs: Record<string, unknown> = {};
        if (testID) attrs['data-testid'] = testID;
        if (onPress) {
            attrs.onClick = (e: { stopPropagation(): void }) => { e.stopPropagation(); onPress({ stopPropagation() {} }); };
            const box = flat(style);
            attrs['data-press'] = 'true';
            attrs['data-min-h'] = box.minHeight ?? '';
            attrs['data-min-w'] = box.minWidth ?? '';
            attrs['data-slop'] = typeof hitSlop === 'number' ? hitSlop : '';
        }
        if (onChangeText) { attrs.onChange = (e: { target: { value: string } }) => onChangeText(e.target.value); attrs.value = value ?? ''; }
        if (onSubmitEditing) attrs['data-submits'] = 'true';
        if (accessibilityLabel) attrs['aria-label'] = accessibilityLabel;
        if (accessibilityRole === 'button') attrs.role = 'button';
        if (placeholder) attrs.placeholder = placeholder;
        return createElement(tag, attrs, children);
    };
    return {
        Platform: { OS: 'android', select: (o: Record<string, unknown>) => o.android ?? o.default },
        View: el('div'), Text: el('span'), Pressable: el('button'), ScrollView: el('div'), TextInput: el('input'),
        Modal: ({ visible, children }: { visible: boolean; children?: unknown }) => (visible ? createElement('div', { 'data-modal': 'true' }, children as any) : null),
        StyleSheet: { create: (s: unknown) => s, hairlineWidth: 1, absoluteFill: {}, absoluteFillObject: {}, flatten: flat },
        BackHandler: {
            addEventListener: (_name: string, cb: () => boolean) => {
                device.backHandlers.push(cb);
                return { remove() { device.backHandlers.splice(device.backHandlers.indexOf(cb), 1); } };
            },
        },
    };
});
vi.mock('react-native-keyboard-controller', () => ({
    KeyboardAvoidingView: ({ children, behavior }: { children?: unknown; behavior?: string }) => createElement('div', { 'data-keyboard-lift': behavior }, children as any),
    KeyboardController: { dismiss: async () => { device.keyboardDown++; } },
}));
vi.mock('@expo/vector-icons', () => ({ MaterialCommunityIcons: ({ name }: { name: string }) => createElement('i', { 'data-icon': name }) }));
vi.mock('expo-haptics', () => ({ impactAsync: async () => {}, notificationAsync: async () => {}, selectionAsync: async () => {}, ImpactFeedbackStyle: {}, NotificationFeedbackType: {} }));
vi.mock('../../app/ThemeContext', async () => {
    const { lightColors, darkColors } = await import('../../constants/colors');
    const palette = () => (device.theme === 'dark' ? darkColors : lightColors);
    return {
        useTheme: () => ({ theme: device.theme, colors: palette() }),
        useStyles: (make: (t: { theme: string; colors: unknown }) => unknown) => make({ theme: device.theme, colors: palette() }),
    };
});

import { TagPicker } from '../../components/TagPicker';

let host: HTMLDivElement;
let root: Root;
let picked: string[][];
beforeEach(() => {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    picked = [];
    device.backHandlers.length = 0;
    device.keyboardDown = 0;
    device.theme = 'light';
});
afterEach(() => { act(() => root.unmount()); host.remove(); });

async function show(tags: string[] = []) {
    await act(async () => {
        root.render(createElement(TagPicker, {
            value: tags, onChange: (next: string[]) => { picked.push(next); }, category: 'food', title: 'Spare lemons', description: 'A bag of lemons',
        }) as any);
    });
}
async function press(el: Element | null, what: string) {
    expect(el, what).toBeTruthy();
    await act(async () => { (el as HTMLElement).click(); await new Promise((r) => setTimeout(r, 0)); });
}
const addButton = () => host.querySelector('[aria-label="+ Add tag"]');
const sheet = () => host.querySelector('[data-testid="tag-picker-sheet"]');
const search = () => host.querySelector('input[aria-label="Search tags"]') as HTMLInputElement | null;
async function typeInSearch(value: string) {
    await act(async () => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(search(), value);
        search()!.dispatchEvent(new Event('input', { bubbles: true }));
    });
}

describe('the tag sheet on the phone', () => {
    it('the button reads "+ Add", once', async () => {
        await show();
        expect(addButton()?.textContent).toBe('+ Add');
    });

    it("Android's back shuts the sheet and is spent there: the form under it stays", async () => {
        await show();
        await press(addButton(), '+ Add');
        expect(sheet()).toBeTruthy();
        expect(device.backHandlers).toHaveLength(1);
        let spent = false;
        await act(async () => { spent = device.backHandlers[device.backHandlers.length - 1](); });
        expect(spent).toBe(true);
        expect(sheet()).toBeNull();
        // Shut, it holds the back button no longer: back is the screen's again.
        expect(device.backHandlers).toHaveLength(0);
    });

    it('Escape (a keyboard on the web build) shuts the sheet and reaches nothing under it', async () => {
        const page = vi.fn();
        window.addEventListener('keydown', page);
        try {
            await show();
            await press(addButton(), '+ Add');
            await act(async () => { search()!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })); });
            expect(sheet()).toBeNull();
            expect(page).not.toHaveBeenCalled();
        } finally {
            window.removeEventListener('keydown', page);
        }
    });

    it('the search submits nothing: no return key on it reaches the composer', async () => {
        await show();
        await press(addButton(), '+ Add');
        expect(search()?.getAttribute('data-submits')).toBeNull();
    });

    it('a search in the words a tag is known by offers it, and a tap on it picks it', async () => {
        await show();
        await press(addButton(), '+ Add');
        await typeInSearch('lemon');
        await press(Array.from(sheet()!.querySelectorAll('[data-press]')).find((b) => b.textContent === 'Lemon') ?? null, 'Lemon');
        expect(picked).toEqual([['food.fruit.lemon']]);
    });

    it('the keyboard goes down before the sheet opens, and the sheet lifts with the root provider: no provider of its own', async () => {
        await show();
        await press(addButton(), '+ Add');
        expect(device.keyboardDown).toBe(1);
        expect(host.querySelector('[data-modal] [data-keyboard-lift="padding"]')).toBeTruthy();
    });

    for (const theme of ['light', 'dark'] as const) {
        it(`every target is at least 44 dp, in the ${theme} theme`, async () => {
            device.theme = theme;
            await show(['food.fruit.lemon']);
            await press(addButton(), '+ Add');
            await typeInSearch('lem');
            const targets = Array.from(host.querySelectorAll('[data-press]')).filter((b) => b.getAttribute('data-testid') !== 'tag-picker-sheet' && b.getAttribute('role') === 'button');
            expect(targets.length).toBeGreaterThan(3);
            for (const b of targets) {
                expect(Number(b.getAttribute('data-min-h')), `${b.textContent} height`).toBeGreaterThanOrEqual(44);
            }
        });
    }
});
