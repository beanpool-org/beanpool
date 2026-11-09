// @vitest-environment jsdom
/**
 * Standing deals S2 on the phone (components/StandingDeal.tsx; DESIGN-standing-deals-fable §2.2, §3; with the web's
 * src/components/StandingDeal.test.tsx), rendered for real at the floor's window (320 x 569 dp, text at 1.3x): react-dom in
 * jsdom, React Native's host components as plain tags carrying their accessibility props and styles, as
 * address-follow-card-render.test.ts does. Checked: the take-up screen's lines and the choice Agree hands on, the panel for
 * each phase and each side, Stop asked first, Hold back the payer's only, light and dark both drawn from the central tokens,
 * and nothing fixed-width or cut to a line count, so the words wrap at 320 dp.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';

(globalThis as any).__DEV__ = false;
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native', () => {
    const flat = (s: unknown): Record<string, unknown> => Object.assign({}, ...[s].flat(3).filter(Boolean));
    const el = (tag: string) => (props: Record<string, any>) => {
        const { children, onPress, accessibilityLabel, accessibilityRole, accessibilityState, testID, numberOfLines, disabled, style } = props;
        const attrs: Record<string, unknown> = { 'data-style': JSON.stringify(flat(style)) };
        if (onPress && !disabled) attrs.onClick = () => onPress();
        if (accessibilityLabel) attrs['aria-label'] = accessibilityLabel;
        if (accessibilityRole) attrs['data-role'] = accessibilityRole;
        if (accessibilityState?.checked !== undefined) attrs['aria-checked'] = String(accessibilityState.checked);
        if (testID) attrs['data-testid'] = testID;
        if (numberOfLines) attrs['data-lines'] = numberOfLines;
        if (disabled) attrs['aria-disabled'] = 'true';
        return createElement(tag, attrs, children);
    };
    return {
        Platform: { OS: 'android' },
        View: el('div'), Text: el('span'), Pressable: el('button'),
        StyleSheet: { create: (s: unknown) => s, hairlineWidth: 1 },
        Alert: { alert: vi.fn() },
        useWindowDimensions: () => ({ width: 320, height: 569, scale: 1.5, fontScale: 1.3 }),
    };
});
const theme = vi.hoisted(() => ({ dark: false }));
vi.mock('../../app/ThemeContext', async () => {
    const { lightColors, darkColors } = await import('../../constants/colors');
    return { useTheme: () => (theme.dark ? { theme: 'dark', colors: darkColors } : { theme: 'light', colors: lightColors }) };
});

import { Alert } from 'react-native';
import { StandingPanel, StandingTakeUp } from '../../components/StandingDeal';
import { lightColors, darkColors } from '../../constants/colors';

const PAYER = 'a'.repeat(64);
const PAYEE = 'b'.repeat(64);
const NOW = Date.parse('2026-11-09T08:00:00.000Z');

let host: HTMLElement;
async function show(node: unknown): Promise<HTMLElement> {
    host = document.createElement('div');
    document.body.appendChild(host);
    await act(async () => { createRoot(host).render(node as Parameters<Root['render']>[0]); });
    return host;
}
const byId = (id: string) => host.querySelector(`[data-testid="${id}"]`) as HTMLElement | null;
const tap = async (el: Element | null) => { await act(async () => { (el as HTMLElement).click(); }); };
const button = (name: string) => Array.from(host.querySelectorAll('button')).find(b => b.getAttribute('aria-label') === name || b.textContent === name) ?? null;
const style = (el: Element) => JSON.parse(el.getAttribute('data-style') || '{}');

beforeEach(() => { theme.dark = false; vi.mocked(Alert.alert).mockClear(); });
afterEach(() => { host?.remove(); });

describe('Take this up? (§2.2)', () => {
    it('what is held now and for which month; Agree hands on until-stopped from today', async () => {
        const onAgree = vi.fn();
        await show(createElement(StandingTakeUp, { unit: 'month', beans: 50, title: 'Vehicle Storage', payeeName: 'Rob', busy: false, onCancel: vi.fn(), onAgree, now: NOW }));
        expect(host.textContent).toContain('Take this up?');
        expect(host.textContent).toContain('Vehicle Storage · 50 Beans a month · from Rob');
        expect(byId('standing-held-now')!.textContent).toBe('50 Beans are held now for the first month (9 Nov – 9 Dec).');
        expect(byId('standing-agree')!.textContent).toBe('Agree and hold 50 Beans');
        await tap(byId('standing-agree'));
        expect(onAgree).toHaveBeenCalledWith({ periods: null, startsAt: NOW });
    });
    it('for a count of weeks and a later start', async () => {
        const onAgree = vi.fn();
        await show(createElement(StandingTakeUp, { unit: 'week', beans: 12.5, title: 'Eggs', payeeName: 'Ann', busy: false, onCancel: vi.fn(), onAgree, now: NOW }));
        await tap(byId('standing-periods'));
        await tap(button('One fewer'));
        expect(byId('standing-periods')!.textContent).toBe('For 5 weeks');
        await tap(byId('standing-start-on'));
        await tap(button('A day later'));
        expect(byId('standing-start-on')!.textContent).toBe('On 11 Nov');
        expect(byId('standing-held-now')!.textContent).toBe('12.5 Beans are held now for the first week (11 Nov – 18 Nov).');
        await tap(byId('standing-agree'));
        expect(onAgree).toHaveBeenCalledWith({ periods: 5, startsAt: NOW + 2 * 86_400_000 });
    });
});

const row = (o: Record<string, unknown> = {}) => ({
    id: 'tx-3', postTitle: 'Vehicle Storage', status: 'pending', buyerPublicKey: PAYER, buyerCallsign: 'Marty', sellerPublicKey: PAYEE, sellerCallsign: 'Rob',
    standingId: 'sd-1', periodNo: 3, standingPhase: 'held', standingBeans: 50, standingUnit: 'month', standingMaxPeriods: 6,
    standingNextDueAt: '2026-12-09T08:00:00.000Z', standingStartsAt: '2026-10-09T08:00:00.000Z', standingShortSince: null, standingStopped: false,
    ...o,
}) as any;
const SHORT = { status: 'completed', standingPhase: 'short', standingShortSince: '2026-12-09T08:00:00.000Z' };

describe('the panel, each phase and each side', () => {
    const matrix: Array<[string, Record<string, unknown>, string, string, boolean, string]> = [
        ['held', {}, PAYER, "This month's 50 Beans are held · they go to Rob 9 Dec", true, 'Stop…'],
        ['held', {}, PAYEE, "Marty's standing deal · 50 Beans a month · this month held for you · paid 9 Dec", false, 'Stop…'],
        ['short', SHORT, PAYER, "⚠️ Next month isn't covered · 50 Beans needed by 16 Dec or this ends", false, 'Stop…'],
        ['short', SHORT, PAYEE, "Next month isn't covered yet · we'll keep trying until 16 Dec", false, 'Stop now'],
        ['held back', { standingPhase: 'held_back' }, PAYER, 'Held back · the schedule is paused', false, 'Stop…'],
        ['held back', { standingPhase: 'held_back' }, PAYEE, 'Held back · the schedule is paused', false, 'Stop…'],
    ];
    for (const [phase, over, side, status, holdBack, stopWords] of matrix) {
        it(`${phase}, ${side === PAYER ? 'payer' : 'payee'}`, async () => {
            await show(createElement(StandingPanel, { tx: row(over), actingAs: side, busy: false, onStop: vi.fn(), onHoldBack: vi.fn() }));
            expect(byId('standing-status')!.textContent).toBe(status);
            expect(!!byId('standing-hold-back')).toBe(holdBack);
            expect(byId('standing-stop')!.textContent).toBe(stopWords);
            expect(host.textContent).toContain('🔁 Standing deal since 9 Oct · 50 Beans a month');
            // The short-funds banner is the warning tone from the tokens; every other phase the calm one.
            const panel = byId('standing-panel-tx-3')!;
            expect(style(panel).backgroundColor).toBe(phase === 'short' ? lightColors.feedback.warning.bg : lightColors.feedback.success.bg);
            expect(byId('standing-status')!.getAttribute('data-role')).toBe(phase === 'short' ? 'alert' : null);
        });
    }
    it('Stop asks first (Keep it / Stop it), and stops only from the alert; Hold back is a tap', async () => {
        const onStop = vi.fn();
        const onHoldBack = vi.fn();
        await show(createElement(StandingPanel, { tx: row(), actingAs: PAYER, busy: false, onStop, onHoldBack }));
        await tap(byId('standing-stop'));
        expect(onStop).not.toHaveBeenCalled();
        const [title, body, buttons] = vi.mocked(Alert.alert).mock.calls[0] as [string, string, Array<{ text: string; onPress?: () => void }>];
        expect([title, body]).toEqual(['Stop after this month?', 'The month under way is still paid. Nothing more is held after it.']);
        expect(buttons.map(b => b.text)).toEqual(['Keep it', 'Stop it']);
        buttons[1].onPress!();
        expect(onStop).toHaveBeenCalledTimes(1);
        await tap(byId('standing-hold-back'));
        expect(onHoldBack).toHaveBeenCalledTimes(1);
    });
});

describe('at 320 dp with the text at 1.3x, light and dark from the tokens', () => {
    for (const dark of [false, true]) {
        it(`${dark ? 'dark' : 'light'}: every colour is a token, nothing fixed-width, no text cut to a line count, 44 dp targets`, async () => {
            theme.dark = dark;
            const colors = dark ? darkColors : lightColors;
            await show(createElement('div', null,
                createElement(StandingTakeUp, { unit: 'month', beans: 50, title: 'A very long listing title for a garden plot down by the creek', payeeName: 'Bartholomew', busy: false, onCancel: vi.fn(), onAgree: vi.fn(), now: NOW }),
                createElement(StandingPanel, { tx: row(SHORT), actingAs: PAYER, busy: false, onStop: vi.fn(), onHoldBack: vi.fn(), onMessage: vi.fn(), messageLabel: 'Message Rob' })));
            const tokens = new Set<string>();
            const walk = (o: unknown) => { if (o && typeof o === 'object') Object.values(o).forEach(walk); else if (typeof o === 'string') tokens.add(o); };
            walk(colors);
            for (const el of Array.from(host.querySelectorAll('[data-style]'))) {
                const st = style(el);
                for (const key of ['color', 'backgroundColor', 'borderColor']) {
                    if (st[key] !== undefined) expect(tokens.has(st[key]), `${key} ${st[key]} is a token`).toBe(true);
                }
                if (el.tagName === 'SPAN') {
                    expect(el.getAttribute('data-lines')).toBeNull();
                    expect(st.width).toBeUndefined();
                }
            }
            for (const b of Array.from(host.querySelectorAll('button'))) {
                const st = style(b);
                expect((st.minHeight ?? st.height) >= 44, `${b.textContent || b.getAttribute('aria-label')} is 44 dp`).toBe(true);
            }
        });
    }
});
