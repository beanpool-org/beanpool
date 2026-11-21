// @vitest-environment jsdom
/**
 * The join's step bar drawn (components/welcome/StepDots.tsx, slice S3 of DESIGN-onboarding-home-landing-fable.md): in every
 * colour set (light, Classic dark, Dark), at 320 dp with 1.3× text. Dots, no words; "Step n of total" for a screen reader;
 * ‹ a 48 dp target where the step has a way back, disabled and faded while the step's request is out; the dots readable on
 * the page and the card in every set (3:1, a part of the screen that is not text), ‹ as words (4.5:1).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, createElement, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { COLOUR_SETS, type AppColors } from '../../constants/colors';

(globalThis as any).__DEV__ = false;
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native', () => {
    const roles: Record<string, string> = { button: 'button' };
    const flat = (style: unknown): Record<string, unknown> => Object.assign({}, ...[style].flat(4).filter(Boolean));
    const el = (tag: string) => (props: Record<string, any>) => {
        const { children, onPress, accessibilityLabel, accessibilityRole, testID, disabled } = props;
        const attrs: Record<string, unknown> = {};
        if (onPress && !disabled) attrs.onClick = () => onPress();
        if (accessibilityLabel) attrs['aria-label'] = accessibilityLabel;
        if (accessibilityRole && roles[accessibilityRole]) attrs.role = roles[accessibilityRole];
        if (testID) attrs['data-testid'] = testID;
        if (disabled) attrs['aria-disabled'] = 'true';
        attrs['data-style'] = JSON.stringify(flat(props.style));
        return createElement(tag, attrs, children);
    };
    return { View: el('div'), Text: el('span'), Pressable: el('button'), StyleSheet: { create: (s: unknown) => s } };
});
vi.mock('@expo/vector-icons', () => ({
    MaterialCommunityIcons: ({ name, color, size }: { name: string; color: string; size: number }) => createElement('i', { 'data-icon': name, 'data-color': color, 'data-size': size }),
}));
const theme = { colors: COLOUR_SETS.light as AppColors };
vi.mock('../../app/ThemeContext', () => ({ useTheme: () => theme }));
vi.mock('../../components/LanguageProvider', async () => {
    const { t } = await import('@beanpool/core');
    return { useWords: () => ({ t }) };
});

const { StepBar, StepDots } = await import('../../components/welcome/StepDots');

let root: Root | null = null;
let host: HTMLElement | null = null;
afterEach(() => {
    act(() => root?.unmount());
    host?.remove();
    root = null;
    host = null;
});
function draw(node: ReactNode) {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    act(() => { root!.render(node as Parameters<Root['render']>[0]); });
}
const all = (sel: string) => Array.from(host!.querySelectorAll(sel)) as HTMLElement[];
const styleOf = (e: Element | null) => JSON.parse(e?.getAttribute('data-style') ?? '{}') as Record<string, any>;

/** WCAG contrast of two #rrggbb colours. */
function contrast(fg: string, bg: string): number {
    const lum = (hex: string) => {
        const [r, g, b] = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255)
            .map(x => (x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4));
        return 0.2126 * r + 0.7152 * g + 0.0722 * b;
    };
    const [a, b] = [lum(fg), lum(bg)];
    return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}
const hex = (c: string) => /^#[0-9a-f]{6}$/i.test(c);

describe('the step bar in every colour set, at 320 dp with 1.3× text', () => {
    for (const [set, colors] of Object.entries(COLOUR_SETS) as Array<[string, AppColors]>) {
        it(`${set}: step 2 of 3, ‹ to go back; the dots and ‹ readable on the page and the card`, () => {
            theme.colors = colors;
            const back = vi.fn();
            draw(createElement(StepDots, { dot: { at: 2, of: 3 }, onBack: back, backLabel: 'Back' }));
            // Dots, no words: nothing drawn as text; the step said once, to a screen reader.
            expect(host!.querySelectorAll('span')).toHaveLength(0);
            expect(host!.textContent).toBe('');
            const bar = host!.querySelector('[data-testid="step-dots-steps"]');
            expect(bar?.getAttribute('aria-label')).toBe('Step 2 of 3');
            expect(all('[data-testid="step-dots-on"]')).toHaveLength(2);
            expect(all('[data-testid="step-dots-off"]')).toHaveLength(1);
            // Filled up to this step, rings after it: both in the brand ink, readable on the page and the card (3:1).
            const ink = colors.brand.primary;
            for (const dot of all('[data-testid^="step-dots-o"]')) expect(styleOf(dot).borderColor).toBe(ink);
            for (const dot of all('[data-testid="step-dots-on"]')) expect(styleOf(dot).backgroundColor).toBe(ink);
            for (const dot of all('[data-testid="step-dots-off"]')) expect(styleOf(dot).backgroundColor).toBeUndefined();
            for (const ground of [colors.surface.page, colors.surface.card].filter(hex)) {
                expect(contrast(ink, ground), `${set}: dot on ${ground}`).toBeGreaterThanOrEqual(3);
            }
            // ‹: a 48 dp target in the heading ink (as words, 4.5:1), and it goes back.
            const chevron = host!.querySelector('[data-testid="step-dots-back"]') as HTMLElement;
            expect(chevron.getAttribute('aria-label')).toBe('Back');
            expect(styleOf(chevron)).toMatchObject({ width: 48, height: 48 });
            const icon = chevron.querySelector('i')!;
            expect(icon.getAttribute('data-icon')).toBe('chevron-left');
            for (const ground of [colors.surface.page, colors.surface.card].filter(hex)) {
                expect(contrast(icon.getAttribute('data-color')!, ground), `${set}: ‹ on ${ground}`).toBeGreaterThanOrEqual(4.5);
            }
            act(() => { chevron.click(); });
            expect(back).toHaveBeenCalledTimes(1);
        });
    }

    it('320 dp, 1.3× text: ‹, four dots (with the notifications screen, N1j) and the spacer fit the row inside the screen\'s 24 dp sides', () => {
        theme.colors = COLOUR_SETS.light;
        draw(createElement(StepDots, { dot: { at: 4, of: 4 }, onBack: () => {} }));
        const dots = all('[data-testid^="step-dots-o"]');
        expect(dots).toHaveLength(4);
        const { width, borderWidth } = styleOf(dots[0]);
        const gap = styleOf(host!.querySelector('[data-testid="step-dots-steps"]')).gap as number;
        // Dots don't scale with text: the row is the same at 1.3×.
        expect(48 + 4 * width + 3 * gap + 48).toBeLessThanOrEqual(320 - 2 * 24);
        expect(borderWidth).toBe(2);
    });

    it('no way back (a join already in at the node): no ‹, the dots still centred by the same-width sides', () => {
        theme.colors = COLOUR_SETS.dark as AppColors;
        draw(createElement(StepDots, { dot: { at: 1, of: 2 } }));
        expect(host!.querySelector('[data-testid="step-dots-back"]')).toBeNull();
        expect(host!.querySelector('[data-testid="step-dots-steps"]')?.getAttribute('aria-label')).toBe('Step 1 of 2');
    });

    it('while the step\'s request is out, ‹ is disabled and faded, and a tap does nothing', () => {
        theme.colors = COLOUR_SETS.light;
        const back = vi.fn();
        draw(createElement(StepDots, { dot: { at: 1, of: 3 }, onBack: back, backDisabled: true }));
        const chevron = host!.querySelector('[data-testid="step-dots-back"]') as HTMLElement;
        expect(chevron.getAttribute('aria-disabled')).toBe('true');
        expect(styleOf(chevron).opacity).toBe(0.4);
        act(() => { chevron.click(); });
        expect(back).not.toHaveBeenCalled();
    });

    it('StepBar: the dot from the join\'s own steps (an invite 3, a claim 2); a step the join lacks and no ‹ draws nothing', () => {
        theme.colors = COLOUR_SETS.light;
        draw(createElement(StepBar, { step: 'photo', flow: 'invite', busy: false }));
        expect(host!.querySelector('[data-testid="step-dots-steps"]')?.getAttribute('aria-label')).toBe('Step 2 of 3');
        act(() => root?.unmount()); host?.remove();
        draw(createElement(StepBar, { step: 'photo', flow: 'claim', busy: true, onBack: () => {} }));
        expect(host!.querySelector('[data-testid="step-dots-steps"]')?.getAttribute('aria-label')).toBe('Step 1 of 2');
        expect(host!.querySelector('[data-testid="step-dots-back"]')?.getAttribute('aria-disabled')).toBe('true');
        act(() => root?.unmount()); host?.remove();
        draw(createElement(StepBar, { step: 'name', flow: 'claim', busy: false }));
        expect(host!.innerHTML).toBe('');
    });

    it('‹ alone, with no dots (a single step): the way back stays', () => {
        theme.colors = COLOUR_SETS.light;
        draw(createElement(StepDots, { dot: null, onBack: () => {} }));
        expect(host!.querySelector('[data-testid="step-dots-back"]')).toBeTruthy();
        expect(host!.querySelector('[data-testid="step-dots-steps"]')).toBeNull();
    });
});
