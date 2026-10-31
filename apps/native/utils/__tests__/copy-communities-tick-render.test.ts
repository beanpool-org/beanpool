// @vitest-environment jsdom
/**
 * The tick beside Protect with (components/CopyCommunitiesTick.tsx, vault rethink VR5), rendered for real: a checkbox
 * TalkBack reads with its whole sentence, on until the member unticks it, the choice kept per account; the words wrap
 * beside the box on a row a thumb can hit at 320 dp with text at 1.3×; the box drawn from the theme's tokens in light
 * and dark (never a fixed colour), its tick in the colour made for words on that fill.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import * as ReactAll from 'react';
import { createRoot, type Root } from 'react-dom/client';

(globalThis as any).__DEV__ = false;
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
(globalThis as any).React = ReactAll;

vi.mock('react-native', () => {
    const el = (tag: string) => (props: Record<string, any>) => {
        const { children, onPress, accessibilityLabel, accessibilityRole, accessibilityState, numberOfLines, testID } = props;
        const attrs: Record<string, unknown> = {};
        if (onPress) attrs.onClick = () => onPress();
        if (accessibilityLabel) attrs['aria-label'] = accessibilityLabel;
        if (accessibilityRole) attrs['data-role'] = accessibilityRole;
        if (accessibilityState && 'checked' in accessibilityState) attrs['aria-checked'] = String(accessibilityState.checked);
        if (numberOfLines) attrs['data-lines'] = String(numberOfLines);
        if (testID) attrs['data-testid'] = testID;
        const flat = Object.assign({}, ...[props.style].flat(3).filter((x) => x && typeof x === 'object'));
        attrs['data-style'] = JSON.stringify(flat);
        return createElement(tag, attrs, children);
    };
    return {
        Platform: { OS: 'android' },
        View: el('div'), Text: el('span'), Pressable: el('button'),
        StyleSheet: { create: (s: unknown) => s },
        I18nManager: { getConstants: () => ({ localeIdentifier: 'en_US' }), allowRTL: vi.fn(), forceRTL: vi.fn() },
        NativeModules: {},
    };
});
const mem = vi.hoisted(() => new Map<string, string>());
vi.mock('@react-native-async-storage/async-storage', () => ({
    default: {
        getItem: vi.fn(async (k: string) => mem.get(k) ?? null),
        setItem: vi.fn(async (k: string, v: string) => { mem.set(k, v); }),
        removeItem: vi.fn(async (k: string) => { mem.delete(k); }),
    },
}));

import { CopyCommunitiesTick } from '../../components/CopyCommunitiesTick';
const SENTENCE = 'Also keep my list of communities in the copy, locked the same way, so a new phone knows where to go.';
import { colors as light, darkColors } from '../../constants/colors';
import { copyListsCommunitiesStoreKey } from '../storage-keys';

const KEY = 'ab'.repeat(32);
let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
    mem.clear();
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); });

async function draw(colors: any = light): Promise<HTMLElement> {
    await act(async () => { root.render(createElement(CopyCommunitiesTick, { publicKey: KEY, colors }) as any); });
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    return host.querySelector('[data-testid="copy-communities-tick"]') as HTMLElement;
}
const style = (el: Element) => JSON.parse(el.getAttribute('data-style') || '{}');

describe('the tick beside Protect with', () => {
    it('is a checkbox read with its whole sentence, on for an account that never chose', async () => {
        const tick = await draw();
        expect(tick.getAttribute('data-role')).toBe('checkbox');
        expect(tick.getAttribute('aria-label')).toBe(SENTENCE);
        expect(tick.getAttribute('aria-checked')).toBe('true');
        expect(tick.textContent).toContain('so a new phone knows where to go.');
    });

    it("unticking keeps the member's choice for this account, and ticking again turns it back on", async () => {
        const tick = await draw();
        await act(async () => { tick.click(); });
        expect(tick.getAttribute('aria-checked')).toBe('false');
        expect(mem.get(copyListsCommunitiesStoreKey(KEY))).toBe('0');
        await act(async () => { root.unmount(); });
        root = createRoot(host);
        const again = await draw();
        expect(again.getAttribute('aria-checked')).toBe('false');
        await act(async () => { again.click(); });
        expect(mem.get(copyListsCommunitiesStoreKey(KEY))).toBe('1');
    });

    it('at 320 dp with text at 1.3×: a 44 dp row whose words wrap beside the box, never cut', async () => {
        const tick = await draw();
        expect(style(tick).minHeight).toBeGreaterThanOrEqual(44);
        const words = Array.from(tick.querySelectorAll('span')).find((s) => s.textContent === SENTENCE)!;
        expect(words.getAttribute('data-lines')).toBeNull();
        expect(style(words).flex).toBe(1);
    });

    it.each([['light', light], ['dark', darkColors]] as const)('in %s, drawn from the theme\'s tokens', async (_name, theme) => {
        const tick = await draw(theme);
        const box = tick.querySelector('div') as HTMLElement;
        expect(style(box).backgroundColor).toBe(theme.brand.fill);
        expect(style(box).borderColor).toBe(theme.brand.fill);
        expect(style(tick.querySelector('div span')!).color).toBe(theme.text.onBrand);
        const words = Array.from(tick.querySelectorAll('span')).find((s) => s.textContent === SENTENCE)!;
        expect(style(words).color).toBe(theme.text.body);
        await act(async () => { tick.click(); });
        expect(style(tick.querySelector('div')!).borderColor).toBe(theme.text.secondary);
    });
});
