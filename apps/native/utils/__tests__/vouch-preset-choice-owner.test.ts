// @vitest-environment jsdom
/**
 * The phone's vouch presets per role (Marty, 9 Nov): an owner (the node's `noLimit`) sees 25 · 50 · 75 · 100 · 200 · 500, none
 * disabled for budget, and "From your vouching budget: no limit"; an admin or any other voucher sees the four, disabled past what is
 * left, and their budget. The row wraps (flexWrap) at 320 dp × 1.3; each chip is 44 dp tall at least. Every figure is whole
 * hundredths of a Bean, as the node sends them (core VOUCH_PRESETS 2500 … 10000); a chip's test id names its whole Beans.
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

import { formatHundredths } from '@beanpool/core';
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
        expect(h.textContent).toContain('From your vouching budget: no limit');
        expect(h.textContent).not.toContain('No budget left');
    });

    it('shows an admin the four, disabled past what is left, with their budget', () => {
        const h = draw({ budgetLeft: 6000, budgetTotal: 100000 });
        expect(ids(h)).toEqual(['none', '25', '50', '75', '100']);
        expect(off(h, '75')).toBe(true);
        expect(off(h, '50')).toBe(false);
        expect(h.textContent).toContain(`From your vouching budget: 60 of ${formatHundredths(100000)} left`);
        // The chips say whole Beans, from the presets in hundredths.
        expect(chips(h).map((e) => e.textContent)).toEqual(['None', '25', '50', '75', '100']);
    });

    it("offers an owner's raise as the totals above what they vouched, with a Raise to heading and no None (slice I6)", () => {
        const h = draw({ noLimit: true, raiseFrom: 10000 });
        expect(ids(h)).toEqual(['200', '500']);
        expect(chips(h).some((e) => e.getAttribute('data-disabled') === 'true')).toBe(false);
        expect(h.textContent).toContain('Raise to');
        expect(h.textContent).not.toContain('Vouch for them');
        expect(h.textContent).not.toContain('None');
        expect(h.textContent).toContain('From your vouching budget: no limit');
    });

    it("offers an owner at 200 only 500, and an owner at 500 nothing to raise to", () => {
        expect(ids(draw({ noLimit: true, raiseFrom: 20000 }))).toEqual(['500']);
        act(() => root?.unmount());
        host?.remove();
        expect(ids(draw({ noLimit: true, raiseFrom: 50000 }))).toEqual([]);
    });

    it("offers a voucher the totals up to 100, greyed only where the difference is more than the budget has left", () => {
        const h = draw({ raiseFrom: 2500, budgetLeft: 3000, budgetTotal: 100000 });
        expect(ids(h)).toEqual(['50', '75', '100']);
        // 50 draws 25 (30 left): open. 75 draws 50 and 100 draws 75: greyed, on the difference and not on their totals.
        expect(off(h, '50')).toBe(false);
        expect(off(h, '75')).toBe(true);
        expect(off(h, '100')).toBe(true);
        expect(h.textContent).toContain('Raise to');
        expect(h.textContent).toContain(`From your vouching budget: 30 of ${formatHundredths(100000)} left`);
    });

    it("never offers a voucher an owner's 200 or 500 when raising", () => {
        expect(ids(draw({ raiseFrom: 7500, budgetLeft: 100000, budgetTotal: 100000 }))).toEqual(['100']);
    });

    it('a first vouch still offers None and the presets, headed Vouch for them', () => {
        const h = draw({ budgetLeft: 100000, budgetTotal: 100000 });
        expect(ids(h)).toEqual(['none', '25', '50', '75', '100']);
        expect(h.textContent).toContain('Vouch for them');
        expect(h.textContent).not.toContain('Raise to');
    });

    it('wraps its row and keeps each chip 44 dp tall (320 dp × 1.3)', () => {
        const h = draw({ noLimit: true });
        const row = chips(h)[0].parentElement!;
        expect(JSON.parse(row.getAttribute('data-style')!)).toMatchObject({ flexWrap: 'wrap' });
        expect(JSON.parse(chips(h)[0].getAttribute('data-style')!)[0]).toMatchObject({ minHeight: 44 });
    });
});
