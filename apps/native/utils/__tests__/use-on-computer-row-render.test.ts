// @vitest-environment jsdom
/**
 * Settings' "Use BeanPool on a computer: open <address>" row (components/UseOnComputerRow.tsx; computer-line), rendered for
 * real in each of the phone's three looks (Classic is the code's `dark`, Light is `light`, Dark is `night`) at the floor's
 * window (320 x 569 dp, text at 1.3x): react-dom in jsdom, React Native's host components as plain tags carrying their
 * styles, as address-follow-card-render.test.ts does. settings-words-render.test.ts renders the whole Settings screen (who
 * sees the row, where it sits, what Copy and Share do, the pseudo-locale); this one is about how the row looks: the words
 * and the buttons in readable ink in every look, nothing fixed-width, and the long address allowed to wrap.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement, useEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { BRAND_SETS, contrastRatio } from '@beanpool/core';

(globalThis as any).__DEV__ = false;
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native', () => {
    const flat = (s: unknown): Record<string, unknown> => Object.assign({}, ...[s].flat(3).filter(Boolean));
    const el = (tag: string) => (props: Record<string, any>) => {
        const { children, onPress, accessibilityLabel, accessibilityRole, testID, numberOfLines, selectable, style } = props;
        const attrs: Record<string, unknown> = { 'data-style': JSON.stringify(flat(style)) };
        if (onPress) attrs.onClick = () => onPress();
        if (accessibilityLabel) attrs['aria-label'] = accessibilityLabel;
        if (accessibilityRole) attrs['data-role'] = accessibilityRole;
        if (testID) attrs['data-testid'] = testID;
        if (numberOfLines) attrs['data-lines'] = numberOfLines;
        if (selectable) attrs['data-selectable'] = 'true';
        return createElement(tag, attrs, children);
    };
    return {
        Platform: { OS: 'android' },
        View: el('div'), Text: el('span'), Pressable: el('button'),
        Share: { share: vi.fn(async () => ({})) },
        AccessibilityInfo: { announceForAccessibility: vi.fn() },
        useWindowDimensions: () => ({ width: 320, height: 569, scale: 1.5, fontScale: 1.3 }),
    };
});
vi.mock('expo-router', () => ({
    useFocusEffect: (effect: () => void | (() => void)) => { useEffect(() => effect(), [effect]); },
}));
const look = vi.hoisted(() => ({ colors: null as any }));
vi.mock('../../app/ThemeContext', () => ({ useTheme: () => ({ colors: look.colors }) }));
vi.mock('../node-post', () => ({ anchorUrl: async () => 'https://mullum.example/' }));
vi.mock('expo-clipboard', () => ({ setStringAsync: vi.fn(async () => true) }));

import { UseOnComputerRow } from '../../components/UseOnComputerRow';
import { COLOUR_SETS } from '../../constants/colors';

const LOOKS = [['Classic', 'dark'], ['Light', 'light'], ['Dark', 'night']] as const;

/** Settings' own row styles (app/(tabs)/settings.tsx), in the look being drawn. */
const menuStyles = (c: any) => ({
    menuBtn: { flexDirection: 'row', alignItems: 'center', padding: 14, paddingVertical: 13, borderBottomWidth: 1, borderBottomColor: c.surface.subtle },
    menuIconWrap: { width: 36, height: 36, borderRadius: 12, justifyContent: 'center', alignItems: 'center', marginRight: 12 },
    menuIcon: { fontSize: 18 },
    menuText: { fontSize: 15, fontWeight: '600', color: c.text.body },
});

async function render(set: (typeof BRAND_SETS)[number]): Promise<HTMLElement> {
    look.colors = COLOUR_SETS[set];
    const host = document.createElement('div');
    document.body.appendChild(host);
    await act(async () => { createRoot(host).render(createElement(UseOnComputerRow, { styles: menuStyles(look.colors) }) as unknown as Parameters<Root['render']>[0]); });
    await act(async () => {});
    return host;
}
const byId = (host: HTMLElement, id: string) => host.querySelector(`[data-testid="${id}"]`) as HTMLElement;
const styleOf = (node: Element) => JSON.parse(node.getAttribute('data-style') ?? '{}');

beforeEach(() => { document.body.innerHTML = ''; });

describe.each(LOOKS)('the row in %s (%s)', (_name, set) => {
    it('says the line with the address, in ink that reads on the card: the words, the address and both buttons', async () => {
        const host = await render(set);
        const c = COLOUR_SETS[set];
        const texts = Array.from(byId(host, 'settings-use-on-computer').querySelectorAll('span'));
        expect(texts.map((e) => e.textContent)).toEqual(['💻', 'Use BeanPool on a computer: open', 'https://mullum.example', 'Copy', 'Share']);
        // The sentence and the address, on the card (Settings' menu group): body ink.
        for (const e of texts.slice(1, 3)) {
            expect(styleOf(e).color, e.textContent!).toBe(c.text.body);
            expect(contrastRatio(styleOf(e).color, c.surface.card), e.textContent!).toBeGreaterThanOrEqual(4.5);
        }
        // Each button: its words on its own ground, and a border that is not the ground itself.
        for (const id of ['settings-use-on-computer-copy', 'settings-use-on-computer-share']) {
            const b = byId(host, id);
            const ground = styleOf(b).backgroundColor;
            expect(contrastRatio(styleOf(b.querySelector('span')!).color, ground), id).toBeGreaterThanOrEqual(4.5);
            expect(styleOf(b).borderColor, id).not.toBe(ground);
            expect(styleOf(b).borderWidth, id).toBeGreaterThanOrEqual(1);
        }
    });

    it('holds at 320 dp and 1.3x text: nothing fixed-width or cut to a line count, the address wraps and can be picked up by hand, two 48 dp buttons that wrap', async () => {
        const host = await render(set);
        const row = byId(host, 'settings-use-on-computer');
        // The text column: everything but the icon tile, whose 36 dp is Settings' own for every row.
        for (const node of [row.children[1], ...Array.from(row.children[1].querySelectorAll('*'))]) {
            const style = styleOf(node);
            expect(style.width, node.outerHTML.slice(0, 80)).toBeUndefined();
            expect(node.getAttribute('data-lines')).toBeNull();
        }
        expect((Array.from(row.querySelectorAll('span')).find((e) => e.textContent === 'https://mullum.example') as HTMLElement).getAttribute('data-selectable')).toBe('true');
        for (const id of ['settings-use-on-computer-copy', 'settings-use-on-computer-share']) {
            expect(byId(host, id).getAttribute('data-role')).toBe('button');
            expect(styleOf(byId(host, id)).minHeight).toBeGreaterThanOrEqual(48);
        }
        expect(styleOf(byId(host, 'settings-use-on-computer-copy').parentElement!).flexWrap).toBe('wrap');
    });
});
