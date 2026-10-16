// @vitest-environment jsdom
/**
 * The CreditBar's balance bubble reads in both themes (scratch/global-previews-audit/PHONE.md §2 "Blank balance bubble,
 * both nodes", §3 item 1). The calm bubble is drawn in text.heading, near-white in dark, and its label was a hard-coded
 * white: "85 B" was white on white for every dark-mode member, on every node. The label now comes from the token that
 * pairs with the heading colour (surface.card), so light is unchanged and dark reads.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { contrastRatio } from '@beanpool/core';
import { darkColors, lightColors } from '../../constants/colors';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
vi.mock('react-native', () => {
    const el = (tag: string) => (props: Record<string, any>) => createElement(tag, {
        'data-testid': props.testID,
        'data-style': JSON.stringify(Object.assign({}, ...[props.style].flat(3).filter(s => s && typeof s === 'object'))),
    }, props.children);
    return { View: el('div'), Text: el('span'), StyleSheet: { create: (s: unknown) => s, hairlineWidth: 1, absoluteFill: {} } };
});
vi.mock('expo-linear-gradient', () => ({ LinearGradient: ({ children }: { children?: unknown }) => createElement('div', null, children as any) }));

import { CreditBar } from '../../components/CreditBar';

let host: HTMLDivElement;
let root: Root;
beforeEach(() => { host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host); });
afterEach(() => { act(() => root.unmount()); host.remove(); });

const hex6 = (c: string) => (/^#[0-9a-f]{3}$/i.test(c) ? `#${[...c.slice(1)].map(x => x + x).join('')}` : c).toLowerCase();
function bubble(colors: unknown, balance: number, floor = -200) {
    act(() => root.render(createElement(CreditBar, { balance, floor, colors }) as any));
    const style = (id: string) => JSON.parse(host.querySelector(`[data-testid="${id}"]`)!.getAttribute('data-style')!);
    return { bg: hex6(style('credit-bar-bubble').backgroundColor), fg: hex6(style('credit-bar-label').color), text: host.querySelector('[data-testid="credit-bar-label"]')!.textContent };
}

describe('the CreditBar balance bubble', () => {
    it('light is unchanged: the calm bubble is charcoal (text.heading) under white words, as on main', () => {
        const b = bubble(lightColors, 85);
        expect(b.text).toBe('+85 B');
        expect(b).toMatchObject({ bg: '#1c1d1a', fg: '#ffffff' });
    });

    it('light is unchanged on the fee and near-limit bubbles too: white words', () => {
        expect(bubble(lightColors, 450).fg).toBe('#ffffff');
        expect(bubble(lightColors, -190).fg).toBe('#ffffff');
    });

    it('dark: the calm bubble\'s words read on it (4.5:1 or more), never white on white', () => {
        const b = bubble(darkColors, 85);
        expect(b.bg).toBe(hex6(darkColors.text.heading));
        expect(b.fg).not.toBe(b.bg);
        expect(contrastRatio(b.fg, b.bg)).toBeGreaterThanOrEqual(4.5);
    });

    it('dark: the fee and near-limit bubbles keep their white words', () => {
        expect(bubble(darkColors, 450).fg).toBe('#ffffff');
        expect(bubble(darkColors, -190).fg).toBe('#ffffff');
    });
});
