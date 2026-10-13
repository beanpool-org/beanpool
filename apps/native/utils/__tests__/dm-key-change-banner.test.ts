// @vitest-environment jsdom
/**
 * P10 and P12 of DESIGN-dm-peer-key-pin, on the screen: the DM screen's "key changed" banner
 * (components/chat/DmKeyChangedBanner.tsx) and Settings → "My key code" (components/MyKeyCodeCard.tsx), rendered for real
 * with react-dom in jsdom and React Native's host components as plain tags (as group-chat-refused-render.test.ts does),
 * in light and in dark; and their styles (utils/dm-key-change.ts) held to 320 dp at 1.3× text: no fixed width or
 * height, buttons stacked, touch targets 48 dp, text at 4.5:1 on its background.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { randomBytes } from 'node:crypto';

(globalThis as any).__DEV__ = false;
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native', () => {
    const roles: Record<string, string> = { header: 'heading', button: 'button', alert: 'alert', checkbox: 'checkbox' };
    const el = (tag: string) => (props: Record<string, any>) => {
        const { children, onPress, accessibilityLabel, accessibilityRole, accessibilityState, disabled } = props;
        const attrs: Record<string, unknown> = {};
        if (onPress && !disabled) attrs.onClick = () => onPress();
        if (accessibilityLabel) attrs['aria-label'] = accessibilityLabel;
        if (accessibilityRole && roles[accessibilityRole]) attrs.role = roles[accessibilityRole];
        if (accessibilityState?.checked !== undefined) attrs['aria-checked'] = String(!!accessibilityState.checked);
        if (accessibilityState?.disabled !== undefined || disabled !== undefined) attrs['aria-disabled'] = String(!!(accessibilityState?.disabled ?? disabled));
        return createElement(tag, attrs, children);
    };
    return {
        View: el('div'), Text: el('span'), Pressable: el('button'),
        StyleSheet: { create: (s: unknown) => s },
        useWindowDimensions: () => ({ width: 320, height: 569, scale: 1.5, fontScale: 1.3 }),
    };
});
const theme = vi.hoisted(() => ({ colors: null as any }));
vi.mock('../../app/ThemeContext', () => ({
    useTheme: () => ({ colors: theme.colors }),
    useStyles: (make: (c: { colors: unknown }) => unknown) => make({ colors: theme.colors }),
}));
vi.mock('../db', () => ({}));

import { lightColors, darkColors } from '../../constants/colors';
import { DmKeyChangedBanner } from '../../components/chat/DmKeyChangedBanner';
import { MyKeyCodeCard } from '../../components/MyKeyCodeCard';
import { dmKeyChangeStyleSpec, DM_KEY_CHANGE_TEXT_ON, DM_KEY_CHANGE_TOUCH_TARGETS, dmKeyChangeCopy, rekeyedOnText } from '../dm-key-change';
import { keyCodeOf } from '../key-code';

const CODE = /^\d{4} \d{4} \d{4} \d{4} \d{4}$/;

let host: HTMLDivElement;
let root: Root;
beforeEach(() => { host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host); });
afterEach(() => { act(() => root.unmount()); host.remove(); });

const render = (node: ReturnType<typeof createElement>) => act(() => { root.render(node); });
const button = (name: string) => host.querySelector(`[role="button"][aria-label="${name}"]`) as HTMLElement | null;
const click = async (el: Element | null) => { await act(async () => { (el as HTMLElement)?.click(); }); };

function luminance(hex: string): number {
    const m = hex.replace('#', '');
    const full = m.length === 3 ? m.split('').map((c) => c + c).join('') : m.slice(0, 6);
    const [r, g, b] = [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16) / 255)
        .map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
function contrast(a: string, b: string): number {
    const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p);
    return (x + 0.05) / (y + 0.05);
}

describe.each([['light', lightColors], ['dark', darkColors]] as const)('the key-changed banner and My key code in %s (320 dp at 1.3× text)', (_name, colors) => {
    beforeEach(() => { theme.colors = colors; });
    const newKey = randomBytes(32).toString('hex');

    it('says what changed in plain words, with the new key\'s code in five groups of four', () => {
        render(createElement(DmKeyChangedBanner, { peerName: 'Ben', change: { offeredPeer: newKey, firstSight: false }, onContinue: vi.fn(), onNotNow: vi.fn() }));
        const text = host.textContent!;
        expect(text).toContain('The key behind "Ben" changed.');
        expect(text).toContain('Anything you send now would go to the new key. If Ben got a new phone and re-keyed, check with them first');
        const code = host.querySelector('[aria-label^="Key code "]')!.textContent!;
        expect(code).toMatch(CODE);
        expect(code).toBe(keyCodeOf(newKey));
        expect(text).not.toContain('This community says');   // no date unless the node gives one (slice 3)
    });

    it('P12: "Continue with the new key" does nothing until Ana ticks that she checked the code with Ben; "Not now" only goes back', async () => {
        const onContinue = vi.fn();
        const onNotNow = vi.fn();
        render(createElement(DmKeyChangedBanner, { peerName: 'Ben', change: { offeredPeer: newKey, firstSight: false }, onContinue, onNotNow }));
        const go = button('Continue with the new key')!;
        expect(go.getAttribute('aria-disabled')).toBe('true');
        await click(go);
        expect(onContinue).not.toHaveBeenCalled();

        await click(button('Not now'));
        expect(onNotNow).toHaveBeenCalledTimes(1);
        expect(onContinue).not.toHaveBeenCalled();

        const tick = host.querySelector('[role="checkbox"]')!;
        expect(tick.getAttribute('aria-label')).toBe('I checked with Ben: the key code in their Settings matches this one.');
        await click(tick);
        expect(tick.getAttribute('aria-checked')).toBe('true');
        expect(button('Continue with the new key')!.getAttribute('aria-disabled')).toBe('false');
        await click(button('Continue with the new key'));
        expect(onContinue).toHaveBeenCalledWith(newKey);   // exactly the key whose code was shown
    });

    it('several keys listed: no code, no tick, no Continue; only "Not now"', () => {
        render(createElement(DmKeyChangedBanner, { peerName: 'Ben', change: { offeredPeer: null, firstSight: false }, onContinue: vi.fn(), onNotNow: vi.fn() }));
        expect(host.querySelector('[aria-label^="Key code "]')).toBeNull();
        expect(host.querySelector('[role="checkbox"]')).toBeNull();
        expect(button('Continue with the new key')).toBeNull();
        expect(button('Not now')).not.toBeNull();
        expect(host.textContent).toContain('there is no one key to continue with');
    });

    it('the node\'s re-key date is a line of words only when it gives one; the first-sight case says none of the earlier lines open', () => {
        render(createElement(DmKeyChangedBanner, { peerName: 'Ben', change: { offeredPeer: newKey, firstSight: true, rekeyedAt: '2026-10-03T09:00:00.000Z' }, onContinue: vi.fn(), onNotNow: vi.fn() }));
        expect(host.textContent).toContain('This community says the account was re-keyed on 3 Oct 2026.');
        expect(host.textContent).toContain('None of the earlier messages here open with the key this community now gives for Ben.');
        expect(rekeyedOnText('not a date')).toBeNull();
    });

    it('Settings → My key code shows the same code Ben\'s banner shows on Ana\'s phone', () => {
        render(createElement(MyKeyCodeCard, { publicKey: newKey }));
        expect(host.textContent).toContain('My key code');
        expect(host.querySelector('[aria-label^="My key code "]')!.textContent).toBe(keyCodeOf(newKey));
        render(createElement(MyKeyCodeCard, { publicKey: null }));
        expect(host.textContent).toContain('Your key code shows here once this phone has your key.');
    });

    const spec = dmKeyChangeStyleSpec(colors as typeof lightColors) as unknown as Record<string, Record<string, unknown>>;

    it('P10: nothing has a fixed width or height, and no text is cut to a number of lines', () => {
        for (const [k, v] of Object.entries(spec)) {
            for (const prop of ['width', 'height', 'maxHeight', 'maxWidth', 'numberOfLines']) expect(v[prop], `${k}.${prop}`).toBeUndefined();
        }
    });
    it('P10: the buttons are stacked, every touch target is at least 48 dp tall', () => {
        expect(spec.buttons.flexDirection).toBe('column');
        for (const k of DM_KEY_CHANGE_TOUCH_TARGETS) expect(Number(spec[k].minHeight), k).toBeGreaterThanOrEqual(48);
    });
    it('P10: the code fits at 320 dp with 1.3× text, as one line or wrapping between whole groups', () => {
        // 18 sp × 1.3 ≈ 23.4 dp per digit at most (tabular, bold): one group of four plus its letter spacing.
        const room = 320 - 2 * Number(spec.banner.marginHorizontal) - 2 * Number(spec.banner.padding) - 2 * Number(spec.codeBox.paddingHorizontal) - 2;
        const group = 4 * (Number(spec.code.fontSize) * 1.3 * 0.62 + Number(spec.code.letterSpacing));
        expect(group).toBeLessThan(room);
        expect(keyCodeOf('ab'.repeat(32))!.split(' ')).toHaveLength(5);   // spaces between groups: the only places it wraps
    });
    it('text is readable on its background (WCAG AA, 4.5:1)', () => {
        for (const [text, bg] of Object.entries(DM_KEY_CHANGE_TEXT_ON)) {
            const fg = String(spec[text].color);
            const back = String((spec[bg] as Record<string, unknown>).backgroundColor);
            expect(fg.startsWith('#') && back.startsWith('#'), `${text} on ${bg}: ${fg} / ${back}`).toBe(true);
            expect(contrast(fg, back), `${text} (${fg}) on ${bg} (${back})`).toBeGreaterThanOrEqual(4.5);
        }
    });
});

describe('the banner\'s words', () => {
    it('never name the node\'s "Loading..." placeholder', () => {
        expect(dmKeyChangeCopy({ peerName: 'Loading...', code: '1111 2222 3333 4444 5555', firstSight: false }).title).toBe('The key behind "this person" changed.');
    });
});
