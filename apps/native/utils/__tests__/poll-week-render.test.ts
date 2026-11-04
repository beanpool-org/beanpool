// @vitest-environment jsdom
/**
 * A member starts one community poll a week (Marty, 4 Nov 2026; the node's half is apps/server engine/poll-week.ts). The phone's poll
 * form says it BEFORE the member types: when the node says their next poll can't start yet (GET /api/marketplace/polls/next-start),
 * the form opens as a notice with the day, in place of its fields and its Create. Drawn for real (NewPollModal, as
 * place-shown-roughly-render.test.ts draws a screen), in the light and the dark theme, at the floor's 320 dp window:
 *   - the node says wait: the sentence with the day in the member's calendar, no question box, no Create, a Close that closes;
 *   - the node says nothing to wait for, is an older node, or can't be reached: the form opens as it always did;
 *   - asked each time the form opens, and not at all while it is shut or for a phone with no account;
 *   - the sentence reads in the notice's colours at 4.5:1 or more, light and dark;
 *   - in French the sentence and the day are French.
 * Nothing here contacts a node.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { formatDate, setLanguage } from '@beanpool/core';

(globalThis as any).__DEV__ = false;
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native', () => {
    const el = (tag: string) => (props: Record<string, any>) => {
        const { children, onPress, accessibilityLabel, accessibilityRole, disabled, value, onChangeText, testID, style, numberOfLines } = props;
        const attrs: Record<string, unknown> = {};
        if (onPress && !disabled) attrs.onClick = () => onPress();
        if (onChangeText) { attrs.onChange = (e: { target: { value: string } }) => onChangeText(e.target.value); attrs.value = value ?? ''; }
        if (accessibilityLabel) attrs['aria-label'] = accessibilityLabel;
        if (accessibilityRole === 'button') attrs.role = 'button';
        if (testID) attrs['data-testid'] = testID;
        if (numberOfLines) attrs['data-lines'] = String(numberOfLines);
        const flat = Object.assign({}, ...[style].flat(3).filter((x) => x && typeof x === 'object'));
        if (flat.color) attrs['data-color'] = String(flat.color);
        if (typeof flat.fontSize === 'number') attrs['data-font'] = String(flat.fontSize);
        if (flat.backgroundColor) attrs['data-bg'] = String(flat.backgroundColor);
        if (props.placeholder) attrs.placeholder = props.placeholder;
        return createElement(tag, attrs, children);
    };
    return {
        Platform: { OS: 'android', select: (o: any) => o.android ?? o.default },
        View: el('div'), Text: el('span'), Pressable: el('button'), ScrollView: el('div'), TextInput: el('input'),
        ActivityIndicator: () => createElement('span', null, '…'),
        Modal: ({ visible, children }: { visible: boolean; children?: unknown }) => (visible ? createElement('div', { 'data-modal': 'true' }, children as any) : null),
        StyleSheet: { create: (s: unknown) => s, hairlineWidth: 1, absoluteFill: {}, flatten: (s: unknown) => s },
    };
});
vi.mock('react-native-keyboard-controller', () => ({ KeyboardAvoidingView: ({ children }: { children?: unknown }) => createElement('div', null, children as any) }));
vi.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ top: 24, bottom: 0, left: 0, right: 0 }) }));
vi.mock('expo-crypto', () => ({ randomUUID: () => 'poll-1' }));
const theme = vi.hoisted(() => ({ dark: false }));
vi.mock('../../app/ThemeContext', async () => {
    const m: any = await import('../../constants/colors');
    const pick = () => (theme.dark ? m.darkColors ?? m.default?.darkColors : m.lightColors ?? m.default?.lightColors);
    return {
        useTheme: () => ({ theme: theme.dark ? 'dark' : 'light', colors: pick() }),
        useStyles: (f: any) => f({ theme: theme.dark ? 'dark' : 'light', colors: pick() }),
    };
});
const who = vi.hoisted(() => ({ identity: { publicKey: 'me'.repeat(32) } as { publicKey: string } | null }));
vi.mock('../../app/IdentityContext', () => ({ useIdentity: () => ({ identity: who.identity }) }));
const node = vi.hoisted(() => ({ next: null as number | null, asked: 0 }));
vi.mock('../db', () => ({
    createPost: vi.fn(async () => ({})),
    getPollNextStart: async () => { node.asked++; return node.next; },
}));
vi.mock('../../utils/keyboard-alert', () => ({ Alert: { alert: vi.fn() } }));
vi.mock('../keyboard-alert', () => ({ Alert: { alert: vi.fn() } }));
vi.mock('../use-node-profile', () => ({ useNodeProfile: () => null }));
vi.mock('../member-area', () => ({ nearbyListingsOn: () => false, useMyArea: () => undefined }));
vi.mock('../../components/signed-request-lines', () => ({ signedRequestWords: (m: string) => m }));
vi.mock('../../components/useKeepCaretVisible', () => ({ useKeepCaretVisible: () => ({ scrollRef: { current: null }, scrollProps: {} }) }));

import { NewPollModal } from '../../components/NewPollModal';

let root: Root; let host: HTMLDivElement;
beforeEach(() => { host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host); node.next = null; node.asked = 0; who.identity = { publicKey: 'me'.repeat(32) }; setLanguage('en'); });
afterEach(() => { act(() => root.unmount()); host.remove(); setLanguage('en'); });

const DAY = 86_400_000;
const draw = async (visible = true, onClose: () => void = () => {}) => {
    await act(async () => { root.render(createElement(NewPollModal, { visible, onClose }) as unknown as Parameters<Root['render']>[0]); await new Promise((r) => setTimeout(r, 0)); });
};
const button = (name: string) => Array.from(host.querySelectorAll('[role=button]')).find((b) => (b.getAttribute('aria-label') ?? b.textContent?.trim()) === name) as HTMLElement | undefined;
const notice = () => host.querySelector('[data-testid=poll-week-notice]');
const questionBox = () => Array.from(host.querySelectorAll('input')).find((i) => i.getAttribute('placeholder') === 'e.g. Should the market move to Sunday?');

/** WCAG contrast of two #rrggbb colours. */
function contrast(a: string, b: string): number {
    const lum = (hex: string) => {
        const [r, g, bl] = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255).map(c => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
        return 0.2126 * r + 0.7152 * g + 0.0722 * bl;
    };
    const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
    return (x + 0.05) / (y + 0.05);
}

for (const dark of [false, true]) {
    describe(`the poll form when the node says the next poll can't start yet (drawn, ${dark ? 'dark' : 'light'})`, () => {
        beforeEach(() => { theme.dark = dark; });

        it('opens as the notice with the day, with no question box and no Create', async () => {
            const at = Date.now() + 5 * DAY;
            node.next = at;
            await draw();
            expect(notice()).toBeTruthy();
            expect(host.textContent).toContain(`You can start one community poll a week. Your next one can start on ${formatDate(new Date(at), 'weekday-day-month')}.`);
            expect(questionBox()).toBeFalsy();
            expect(host.querySelectorAll('input').length).toBe(0);
            expect(button('Create poll')).toBeFalsy();
            expect(button('Create')).toBeFalsy();
            // The phone's poll form is the community's alone (no group choice), so it says nothing of a group poll it could not offer.
            expect(host.textContent).not.toContain('one of your groups');
        });

        it('has a Close that closes it, and the header\'s Cancel still does', async () => {
            node.next = Date.now() + 2 * DAY;
            const closed = vi.fn();
            await draw(true, closed);
            await act(async () => { button('Close')!.click(); });
            expect(closed).toHaveBeenCalledTimes(1);
            await act(async () => { button('Cancel')!.click(); });
            expect(closed).toHaveBeenCalledTimes(2);
        });

        it('reads in the notice\'s own colours at 4.5:1 or more, and at a size that holds at 1.3x text', async () => {
            node.next = Date.now() + 3 * DAY;
            await draw();
            const text = Array.from(host.querySelectorAll('span')).find((s) => s.textContent?.startsWith('You can start one community poll a week'))!;
            const banner = text.closest('[data-bg]')!;
            expect(contrast(text.getAttribute('data-color')!, banner.getAttribute('data-bg')!)).toBeGreaterThanOrEqual(4.5);
            expect(Number(text.getAttribute('data-font'))).toBeGreaterThanOrEqual(14);
            expect(text.getAttribute('data-lines')).toBeNull();
        });

        it('opens as the form it always was when the node has nothing to wait for, is an older one, or can\'t be asked', async () => {
            node.next = null;
            await draw();
            expect(notice()).toBeFalsy();
            expect(questionBox()).toBeTruthy();
            expect(button('Create poll')).toBeTruthy();
            expect(host.textContent).not.toContain('You can start one community poll a week');
        });

        it('is asked each time the form opens, and not while it is shut or for a phone with no account', async () => {
            node.next = Date.now() + DAY;
            await draw(false);
            expect(node.asked).toBe(0);
            await draw(true);
            expect(node.asked).toBe(1);
            expect(notice()).toBeTruthy();
            await draw(false);
            node.next = null;
            await draw(true);
            expect(node.asked).toBe(2);
            expect(notice()).toBeFalsy();
            expect(questionBox()).toBeTruthy();
            who.identity = null;
            await draw(false);
            await draw(true);
            expect(node.asked).toBe(2);
        });
    });
}

describe('in French', () => {
    it('the sentence and the day are French', async () => {
        const fr = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../../../packages/beanpool-core/words/fr.json'), 'utf8'));
        setLanguage('fr', [fr]);
        const at = Date.now() + 4 * DAY;
        node.next = at;
        await draw();
        const day = formatDate(new Date(at), 'weekday-day-month');
        expect(day).not.toBe(formatDate(new Date(at), 'weekday-day-month', { lang: 'en' }));
        expect(host.textContent).toContain(day);
        expect(host.textContent).not.toContain('You can start one community poll a week');
    });
});
