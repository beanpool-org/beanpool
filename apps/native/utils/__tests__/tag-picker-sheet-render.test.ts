// @vitest-environment jsdom
/**
 * The phone's tag sheet (components/TagPicker.tsx, DESIGN-owner-seeding-tags-fable.md §4.4), rendered for real at 320 dp and
 * 1.3× text, in both themes: the review of #2663's points on the sheet. It shuts on its own (Android's back, Escape where a
 * keyboard has one) without reaching the screen under it; nothing in it submits anything; the button reads "+ Add" once;
 * every target is 44 dp; and the keyboard is down before the sheet opens and the search stays above it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement, useState } from 'react';
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
        const { children, onPress, accessibilityLabel, accessibilityRole, testID, placeholder, value, onChangeText, onSubmitEditing, onKeyPress, style, hitSlop } = props;
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
        if (onKeyPress || onSubmitEditing) {
            attrs.onKeyDown = (e: { key: string }) => {
                onKeyPress?.({ nativeEvent: { key: e.key } });
                if (e.key === 'Enter') onSubmitEditing?.();
            };
        }
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

describe('a tag the member types (DESIGN-tags-free-entry-fable.md §3, slice F2)', () => {
    const held = { tags: [] as string[], freeTags: [] as string[] };
    function Composer({ tags, freeTags, title }: { tags: string[]; freeTags: string[]; title?: string }) {
        const [nowTags, setTags] = useState(tags);
        const [nowFree, setFree] = useState(freeTags);
        held.tags = nowTags;
        held.freeTags = nowFree;
        return createElement(TagPicker, { value: nowTags, onChange: setTags, freeTags: nowFree, onFreeTagsChange: setFree, category: 'food', title });
    }
    async function compose(tags: string[] = [], freeTags: string[] = [], title?: string) {
        await act(async () => { root.render(createElement(Composer, { tags, freeTags, title }) as any); });
        await press(addButton(), '+ Add');
    }
    const key = (name: string) => act(async () => { search()!.dispatchEvent(new KeyboardEvent('keydown', { key: name, bubbles: true, cancelable: true })); });
    const done = () => press(host.querySelector('[aria-label="Done"]'), 'Done');
    const addRow = () => host.querySelector('[data-testid="tag-picker-add-typed"]');

    it('Enter makes the typed words a tag, the # shown and not stored; the sheet and the keyboard stay for the next', async () => {
        await compose();
        await typeInSearch('#2nd  Hand');
        await key('Enter');
        expect(held.freeTags).toEqual(['2nd hand']);
        expect(held.tags).toEqual([]);
        expect(search()!.value).toBe('');
        expect(sheet()).toBeTruthy();
        expect(host.querySelector('[aria-label="Remove #2nd hand"]')?.textContent).toContain('#2nd hand');
    });

    it('Enter on a library label picks the library tag, never a free twin', async () => {
        await compose();
        await typeInSearch('Lemons');
        await key('Enter');
        expect(held.tags).toEqual(['food.fruit.lemon']);
        expect(held.freeTags).toEqual([]);
    });

    it('a comma commits what is before it and leaves what follows', async () => {
        await compose();
        await typeInSearch('vintage, re');
        expect(held.freeTags).toEqual(['vintage']);
        expect(search()!.value).toBe(' re');
    });

    it('Done commits what is in the field and shuts the sheet', async () => {
        await compose();
        await typeInSearch('vintage');
        await done();
        expect(held.freeTags).toEqual(['vintage']);
        expect(sheet()).toBeNull();
    });

    it('a refused tag shows its words before anything is sent, and Done keeps the sheet open on them', async () => {
        await compose();
        await typeInSearch('me@example.org');
        expect(sheet()!.textContent).toContain('A tag is a word to find your listing by, not a contact');
        expect(addRow()).toBeNull();
        await done();
        expect(held.freeTags).toEqual([]);
        expect(sheet()).toBeTruthy();
        expect(search()!.value).toBe('me@example.org');
    });

    it('a word still being typed is not called too short until it is committed', async () => {
        await compose();
        await typeInSearch('a');
        expect(sheet()!.textContent).not.toContain('at least two letters');
        await key('Enter');
        expect(sheet()!.textContent).toContain('A tag needs at least two letters or numbers');
        await typeInSearch('ab');
        expect(sheet()!.textContent).not.toContain('at least two letters');
    });

    it('the cap, in words, on the kind that is full', async () => {
        await compose([], ['aa', 'bb', 'cc', 'dd', 'ee']);
        await typeInSearch('ff');
        expect(sheet()!.textContent).toContain('Five tags at most');
        await key('Enter');
        expect(held.freeTags).toHaveLength(5);
    });

    it('a tag taken off ends the words that stopped the last one: the sheet never says "at most" beside an Add row', async () => {
        await compose([], ['aa', 'bb', 'cc', 'dd', 'ee']);
        await typeInSearch('ff');
        await key('Enter');
        expect(sheet()!.textContent).toContain('Five tags at most');
        await press(host.querySelector('[aria-label="Remove #aa"]'), 'Remove #aa');
        expect(sheet()!.textContent).not.toContain('Five tags at most');
        expect(addRow()!.textContent).toContain('#ff');
    });

    const fiveFromTheLibrary = ['food.fruit.lemon', 'food.fruit.apple', 'food.fruit.orange', 'food.produce.herbs', 'food.preserve.jam'];
    const tapLime = () => press(Array.from(sheet()!.querySelectorAll('[role=button]')).find((b) => b.textContent === 'Lime') ?? null, 'Lime');

    it('a library tag taken off ends them too', async () => {
        await compose(fiveFromTheLibrary, [], 'Fresh limes');
        await tapLime();
        expect(sheet()!.textContent).toContain('Five tags at most');
        await press(host.querySelector('[aria-label="Remove Lemon"]'), 'Remove Lemon');
        expect(sheet()!.textContent).not.toContain('Five tags at most');
    });

    it('backspace on an empty field ends them too', async () => {
        await compose(fiveFromTheLibrary, [], 'Fresh limes');
        await tapLime();
        expect(sheet()!.textContent).toContain('Five tags at most');
        await key('Backspace');
        expect(held.tags).toHaveLength(4);
        expect(sheet()!.textContent).not.toContain('Five tags at most');
    });

    it('five of a kind leave the + Add for the other kind; ten leave none', async () => {
        const library = ['food.fruit.apple', 'food.fruit.orange', 'food.produce.herbs', 'food.preserve.jam', 'food.bakery.bread'];
        await compose(library);
        await typeInSearch('vintage');
        await key('Enter');
        expect(held.freeTags).toEqual(['vintage']);
        await act(async () => { root.render(null as any); });
        await act(async () => { root.render(createElement(Composer, { tags: library, freeTags: ['aa', 'bb', 'cc', 'dd', 'ee'] }) as any); });
        expect(addButton()).toBeNull();
    });

    it('the last row adds what is typed; a word the library has, or nothing typed, has no such row', async () => {
        await compose();
        expect(addRow()).toBeNull();
        await typeInSearch('2nd hand');
        expect(addRow()?.textContent).toContain('Add “#2nd hand”');
        await press(addRow(), 'the Add row');
        expect(held.freeTags).toEqual(['2nd hand']);
        await typeInSearch('lemon');
        expect(addRow()).toBeNull();
    });

    it('a plural has its label\'s row, and a tap on a result ends what was typed: Done does not put back one just taken off', async () => {
        await compose();
        await typeInSearch('lemons');
        const row = () => Array.from(sheet()!.querySelectorAll('[data-press]')).find((b) => b.textContent === 'Lemon') ?? null;
        await press(row(), 'Lemon');
        expect(held.tags).toEqual(['food.fruit.lemon']);
        expect(search()!.value).toBe('');
        await press(host.querySelector('[aria-label="Remove Lemon"]'), 'Remove Lemon');
        await done();
        expect(held.tags).toEqual([]);
    });

    it('backspace on an empty field takes the last chip off, the typed ones first; with words in the field it does not', async () => {
        await compose(['food.fruit.lemon'], ['aa']);
        await typeInSearch('b');
        await key('Backspace');
        expect(held.freeTags).toEqual(['aa']);
        await typeInSearch('');
        await key('Backspace');
        expect(held.freeTags).toEqual([]);
        await key('Backspace');
        expect(held.tags).toEqual([]);
    });

    it('its chip takes it off', async () => {
        await compose([], ['aa', 'bb']);
        await press(host.querySelector('[aria-label="Remove #aa"]'), 'Remove #aa');
        expect(held.freeTags).toEqual(['bb']);
    });

    it('the two hints are under the field', async () => {
        await compose();
        expect(sheet()!.textContent).toContain('Tags are public with your listing');
        expect(sheet()!.textContent).toContain('A tag you type is in your own words. Pick a library tag to be found in every language.');
    });

    it('a typed return reaches no composer: the sheet is its own Modal, and Return is spent on the tag', async () => {
        await compose();
        expect(search()?.getAttribute('data-submits')).toBe('true');
    });

    for (const theme of ['light', 'dark'] as const) {
        it(`every target is at least 44 dp with typed tags and the Add row, in the ${theme} theme`, async () => {
            device.theme = theme;
            await compose(['food.fruit.lemon'], ['2nd hand']);
            await typeInSearch('vintage');
            expect(addRow()).toBeTruthy();
            const targets = Array.from(host.querySelectorAll('[data-press]')).filter((b) => b.getAttribute('data-testid') !== 'tag-picker-sheet' && b.getAttribute('role') === 'button');
            expect(targets.length).toBeGreaterThan(3);
            for (const b of targets) expect(Number(b.getAttribute('data-min-h')), `${b.textContent} height`).toBeGreaterThanOrEqual(44);
        });
    }
});
