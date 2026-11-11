// @vitest-environment jsdom
/**
 * The two "Beans accepted here" buttons on the phone (components/BeansSignButtons.tsx), on the community's Settings and on an enterprise's
 * Manage console: one heading and two buttons, A4 and A6, each handing the community the phone holds to the sign maker; a sign that could not
 * be made says so. Drawn at 320 dp with 1.3x text, light and dark: each label is readable on its button (4.5:1) and each target is 48 dp.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

(globalThis as any).__DEV__ = false;
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

type Button = { text: string; style?: string; onPress?: () => unknown };
const alerts = vi.hoisted(() => ({ said: [] as Array<{ title: string; text?: string; buttons: Button[] }> }));

vi.mock('react-native', () => {
    const el = (tag: string) => (props: Record<string, any>) => {
        const { children, onPress, accessibilityRole, accessibilityLabel, testID, disabled, style } = props;
        const attrs: Record<string, unknown> = {};
        if (testID) attrs['data-testid'] = testID;
        if (onPress) attrs.onClick = () => { if (!disabled) onPress(); };
        if (accessibilityRole) attrs['data-role'] = accessibilityRole;
        if (accessibilityLabel) attrs['aria-label'] = accessibilityLabel;
        if (disabled) attrs.disabled = true;
        const flat = Array.isArray(style) ? Object.assign({}, ...style.filter(Boolean)) : style;
        if (flat?.minHeight) attrs['data-min-height'] = String(flat.minHeight);
        if (flat?.color) attrs['data-color'] = String(flat.color);
        if (flat?.backgroundColor) attrs['data-bg'] = String(flat.backgroundColor);
        return createElement(tag, attrs, children);
    };
    return {
        Platform: { OS: 'android', select: (o: Record<string, unknown>) => o.android ?? o.default },
        View: el('div'), Text: el('span'), Pressable: el('button'),
        StyleSheet: { create: (s: unknown) => s, absoluteFill: {}, flatten: (s: unknown) => s },
        Alert: { alert: (title: string, text?: string, buttons?: Button[]) => { alerts.said.push({ title, text, buttons: buttons ?? [] }); } },
        useWindowDimensions: () => ({ width: 320, height: 569, scale: 1.5, fontScale: 1.3 }),
    };
});
vi.mock('../node-post', () => ({ anchorUrl: async () => 'https://mullum.example.org' }));
vi.mock('../nodes', () => ({ getSavedNodes: async () => [{ url: 'https://mullum.example.org', alias: 'Mullum' }] }));

import { contrastRatio } from '@beanpool/core';
import { BeansSignButtons } from '../../components/BeansSignButtons';
import { lightColors, darkColors } from '../../constants/colors';

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    alerts.said.length = 0;
});
afterEach(() => {
    act(() => root.unmount());
    host.remove();
});

const q = (id: string) => host.querySelector(`[data-testid="${id}"]`) as HTMLElement | null;
const click = async (elm: Element | null) => { await act(async () => { (elm as HTMLElement).click(); }); };

type Palette = typeof lightColors;
function render(make: (...a: any[]) => Promise<'done' | 'failed'>, colors: Palette = lightColors) {
    act(() => root.render(createElement(BeansSignButtons, { colors, make: make as any }) as any));
}

describe('BeansSignButtons', () => {
    it('is a heading and two buttons, A4 for a window and A6 for a stall, said in the app\'s words', () => {
        render(async () => 'done');
        expect(host.textContent).toContain('A sign for your window or stall');
        expect(q('beans-sign-a4')?.getAttribute('aria-label')).toBe('Make a window sign (A4)');
        expect(q('beans-sign-a6')?.getAttribute('aria-label')).toBe('Make a stall card (A6)');
        expect(host.querySelector('[data-role="header"]')?.textContent).toBe('A sign for your window or stall');
    });

    it.each([['beans-sign-a4', 'a4'], ['beans-sign-a6', 'a6']] as const)('%s hands the community the phone holds to the sign maker as %s', async (id, size) => {
        const make = vi.fn(async () => 'done' as const);
        render(make);
        await click(q(id));
        expect(make).toHaveBeenCalledWith(size, { communityName: 'Mullum', communityAddress: 'https://mullum.example.org' });
        expect(alerts.said).toHaveLength(0);
    });

    it('says so when the sign could not be made, and never a success of its own', async () => {
        render(async () => 'failed');
        await click(q('beans-sign-a4'));
        expect(alerts.said).toEqual([{ title: 'Beans accepted here', text: 'The sign couldn’t be made. Try again.', buttons: [] }]);
    });

    it('waits for one sign to finish before it makes another', async () => {
        let finish: (r: 'done') => void = () => {};
        const make = vi.fn(() => new Promise<'done'>((resolve) => { finish = resolve; }));
        render(make);
        await click(q('beans-sign-a4'));
        expect(q('beans-sign-a6')?.hasAttribute('disabled')).toBe(true);
        await click(q('beans-sign-a6'));
        expect(make).toHaveBeenCalledTimes(1);
        await act(async () => { finish('done'); });
        expect(q('beans-sign-a6')?.hasAttribute('disabled')).toBe(false);
    });

    it.each([['light', lightColors], ['dark', darkColors as unknown as Palette]] as const)('%s, at 320 dp with 1.3x text: 48 dp targets and every label readable on its button', (_name, colors) => {
        render(async () => 'done', colors);
        for (const id of ['beans-sign-a4', 'beans-sign-a6']) {
            const button = q(id)!;
            expect(Number(button.getAttribute('data-min-height'))).toBeGreaterThanOrEqual(48);
            const label = button.querySelector('span')!;
            expect(contrastRatio(label.getAttribute('data-color')!, button.getAttribute('data-bg')!)).toBeGreaterThanOrEqual(4.5);
        }
        // The heading sits on the card or the page it is drawn on (Settings' card, the Manage console's page).
        const heading = host.querySelector('[data-role="header"]')!;
        expect(contrastRatio(heading.getAttribute('data-color')!, colors.surface.card)).toBeGreaterThanOrEqual(4.5);
        expect(contrastRatio(heading.getAttribute('data-color')!, colors.surface.page)).toBeGreaterThanOrEqual(4.5);
    });
});

describe('where the buttons are', () => {
    const src = (file: string) => readFileSync(join(__dirname, '..', '..', file), 'utf8');

    it('Settings (anyone) and the Manage console (its keepers) draw them, with their own colours', () => {
        expect(src('app/(tabs)/settings.tsx')).toMatch(/<BeansSignButtons colors=\{colors\} \/>/);
        const manage = src('app/treasury-manage.tsx');
        expect(manage).toMatch(/\{isKeeperOfThis && \(\s*<View style=\{styles\.pad\}>\s*<BeansSignButtons colors=\{colors\} \/>/);
    });
});
