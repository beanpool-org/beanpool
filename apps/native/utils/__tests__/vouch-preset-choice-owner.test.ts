// @vitest-environment jsdom
/**
 * The phone's vouch presets per role (Marty, 9 Nov): an owner (the node's `noLimit`) sees 25 · 50 · 75 · 100 · 200 · 500, none
 * disabled for budget, and "From your budget: No limit"; an admin or any other voucher sees the four, disabled past what is
 * left, and their budget. The row wraps (flexWrap) at 320 dp × 1.3; each chip is 44 dp tall at least.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native', () => {
    const el = (tag: string) => (props: Record<string, any>) => {
        const { children, onPress, accessibilityLabel, accessibilityState, testID, disabled, style } = props;
        const attrs: Record<string, unknown> = {};
        if (testID) attrs['data-testid'] = testID;
        if (onPress) attrs.onClick = () => onPress();
        if (accessibilityLabel) attrs['aria-label'] = accessibilityLabel;
        if (disabled || accessibilityState?.disabled) attrs['data-disabled'] = 'true';
        if (style) attrs['data-style'] = JSON.stringify(style);
        return createElement(tag, attrs, children);
    };
    return { View: el('div'), Text: el('span'), Pressable: el('button'), StyleSheet: { create: (s: unknown) => s } };
});
vi.mock('../../app/ThemeContext', async () => {
    const { lightColors } = await import('../../constants/colors');
    return {
        useTheme: () => ({ theme: 'light', colors: lightColors }),
        useStyles: (make: (t: { theme: string; colors: unknown }) => unknown) => make({ theme: 'light', colors: lightColors }),
    };
});

import { formatNumber } from '@beanpool/core';
import { VouchPresetChoice } from '../../components/VouchPresetChoice';

let root: Root | null = null;
let host: HTMLDivElement | null = null;
function draw(props: Record<string, unknown>): HTMLDivElement {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    act(() => root!.render(createElement(VouchPresetChoice as any, { value: null, onChange: () => {}, budgetLeft: 0, budgetTotal: 0, ...props }) as any));
    return host;
}
afterEach(() => {
    act(() => root?.unmount());
    host?.remove();
    root = null;
    host = null;
});

const chips = (h: HTMLElement) => Array.from(h.querySelectorAll('[data-testid^="invite-vouch-"]')).filter((e) => e.tagName === 'BUTTON');
const ids = (h: HTMLElement) => chips(h).map((e) => e.getAttribute('data-testid')!.replace('invite-vouch-', ''));
const off = (h: HTMLElement, id: string) => h.querySelector(`[data-testid="invite-vouch-${id}"]`)?.getAttribute('data-disabled') === 'true';

describe('the phone vouch presets per role', () => {
    it('shows an owner 200 and 500 too, none disabled for budget, and No limit', () => {
        const h = draw({ noLimit: true });
        expect(ids(h)).toEqual(['none', '25', '50', '75', '100', '200', '500']);
        expect(chips(h).some((e) => e.getAttribute('data-disabled') === 'true')).toBe(false);
        expect(h.textContent).toContain('From your budget: No limit');
        expect(h.textContent).not.toContain('No budget left');
    });

    it('shows an admin the four, disabled past what is left, with their budget', () => {
        const h = draw({ budgetLeft: 60, budgetTotal: 1000 });
        expect(ids(h)).toEqual(['none', '25', '50', '75', '100']);
        expect(off(h, '75')).toBe(true);
        expect(off(h, '50')).toBe(false);
        expect(h.textContent).toContain(`From your budget: 60 of ${formatNumber(1000)} left`);
    });

    it("disables an owner's raise past 500 for one person, never past 100", () => {
        const h = draw({ noLimit: true, priorVouch: 200, personName: 'sam' });
        expect(off(h, '200')).toBe(false);
        expect(off(h, '500')).toBe(true);
    });

    it('wraps its row and keeps each chip 44 dp tall (320 dp × 1.3)', () => {
        const h = draw({ noLimit: true });
        const row = chips(h)[0].parentElement!;
        expect(JSON.parse(row.getAttribute('data-style')!)).toMatchObject({ flexWrap: 'wrap' });
        expect(JSON.parse(chips(h)[0].getAttribute('data-style')!)[0]).toMatchObject({ minHeight: 44 });
    });
});
