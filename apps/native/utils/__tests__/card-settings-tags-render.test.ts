// @vitest-environment jsdom
/**
 * The phone's saved-search sheet (components/home/CardSettingsSheet.tsx), drawn for real: react-dom in jsdom, React Native's
 * host components as plain tags. A saved search keeps the tag ids it resolved when it was saved, for the node to find with
 * (DESIGN-owner-seeding-tags-fable.md §4.7). The sheet has no field for them, so it must neither drop them nor leave the old
 * words' ids behind when the words change (review of #2663, the phone's half; the web's is in AddCardDialog.test.tsx).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';

(globalThis as any).__DEV__ = false;
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native', () => {
    const el = (tag: string) => (props: Record<string, any>) => {
        const { children, onPress, disabled, testID, value, onChangeText } = props;
        const attrs: Record<string, unknown> = {};
        if (onPress && !disabled) attrs.onClick = () => onPress();
        if (onChangeText) { attrs.onChange = (e: { target: { value: string } }) => onChangeText(e.target.value); attrs.value = value ?? ''; }
        if (testID) attrs['data-testid'] = testID;
        return createElement(tag, attrs, children);
    };
    return {
        Platform: { OS: 'android', select: (o: any) => o.android ?? o.default },
        View: el('div'), Text: el('span'), Pressable: el('button'), ScrollView: el('div'), TextInput: el('input'),
        Modal: ({ children, visible }: any) => (visible ? createElement('div', null, children) : null),
        StyleSheet: { create: (s: unknown) => s, hairlineWidth: 1, absoluteFill: {}, flatten: (s: unknown) => s },
    };
});
vi.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ top: 24, bottom: 0, left: 0, right: 0 }) }));
vi.mock('../../components/useModalKeyboardLift', () => ({ useModalKeyboardLift: () => ({ maxHeight: 500, lift: 0 }) }));
vi.mock('../../components/home/HomeParts', () => ({ HOME_TARGET_DP: 48, homeStyles: () => ({ chips: {}, chip: {}, chipOn: {}, chipText: {}, chipTextOn: {} }) }));
vi.mock('../../components/home/EditHomeSheet', () => ({ editHomeStyles: { backdrop: {}, sheet: {}, head: {}, title: {}, done: {}, doneText: {}, list: {} } }));
vi.mock('../../constants/categories', () => ({ POST_CATEGORIES: [{ id: 'food', emoji: '🥕' }], categoryLabel: (id: string) => id }));
vi.mock('../home-cards', () => ({ SEARCH_KIND_CHIPS: [{ kind: 'any', label: 'Both' }, { kind: 'offer', label: 'Offers' }], SKY_PLACE_CHIPS: [], cardName: () => 'A saved search' }));

import { CardSettingsSheet } from '../../components/home/CardSettingsSheet';
import { lightColors } from '../../constants/colors';

let root: Root; let host: HTMLDivElement;
beforeEach(() => { host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host); });
afterEach(() => { act(() => root.unmount()); host.remove(); });

async function open(settings?: Record<string, unknown>) {
    const onDone = vi.fn();
    await act(async () => {
        root.render(createElement(CardSettingsSheet, { visible: true, type: 'search', settings, mode: settings ? 'save' : 'add', colors: lightColors, onDone, onClose: () => {} }) as any);
    });
    return onDone;
}
const byId = (id: string) => host.querySelector(`[data-testid="${id}"]`) as HTMLElement;
async function typeWords(value: string) {
    const input = byId('card-settings-words') as HTMLInputElement;
    await act(async () => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
        input.dispatchEvent(new Event('input', { bubbles: true }));
    });
}
const press = async (id: string) => { await act(async () => { byId(id).click(); }); };

describe('a saved search\'s tags through the phone\'s settings sheet', () => {
    const held = { q: 'lemon', kind: 'any', tags: ['food.fruit.orange', 'food.fruit.lemon'] };

    it('Save with the words as they were keeps them', async () => {
        const onDone = await open(held);
        await press('card-settings-kind-offer');
        await press('card-settings-done');
        expect(onDone).toHaveBeenCalledWith({ q: 'lemon', kind: 'offer', tags: ['food.fruit.orange', 'food.fruit.lemon'] });
    });

    it('new words resolve again: the old words\' ids go, a chip\'s stays', async () => {
        const onDone = await open(held);
        await typeWords('jam');
        await press('card-settings-done');
        expect(onDone).toHaveBeenCalledWith({ q: 'jam', kind: 'any', tags: ['food.fruit.orange', 'food.preserves.jam'] });
    });

    it('a new card resolves its words', async () => {
        const onDone = await open();
        await typeWords('lemon');
        await press('card-settings-done');
        expect(onDone).toHaveBeenCalledWith({ q: 'lemon', kind: 'any', tags: ['food.fruit.lemon'] });
    });
});
