// @vitest-environment jsdom
/**
 * Standing deals on the phone, paid at the start of each period (components/StandingDeal.tsx; DESIGN-standing-deals-upfront-fable
 * §3 and its amendment §1; with the web's
 * src/components/StandingDeal.test.tsx), rendered for real at the floor's window (320 x 569 dp, text at 1.3x): react-dom in
 * jsdom, React Native's host components as plain tags carrying their accessibility props and styles, as
 * address-follow-card-render.test.ts does. Checked: the take-up screen's lines and the choice Agree hands on, the panel for
 * each phase and each side, Stop asked first in each side's words, no Hold back, light and dark both drawn from the central tokens,
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
    it('what is paid now and for which month; Agree hands on until-stopped from today', async () => {
        const onAgree = vi.fn();
        await show(createElement(StandingTakeUp, { unit: 'month', beans_c: 5000, title: 'Vehicle Storage', payeeName: 'Rob', busy: false, onCancel: vi.fn(), onAgree, now: NOW }));
        expect(host.textContent).toContain('Take this up?');
        expect(host.textContent).toContain('Vehicle Storage · 50 Beans a month · from Rob');
        expect(byId('standing-held-now')!.textContent).toBe('50 Beans go to Rob now for the first month (9 Nov – 9 Dec), then 50 at the start of each month, until one of you stops it.');
        expect(byId('standing-agree')!.textContent).toBe('Agree and pay 50 Beans');
        await tap(byId('standing-agree'));
        expect(onAgree).toHaveBeenCalledWith({ periods: null, startsAt: NOW });
    });
    it('without room for the first month, Agree is disabled with a plain line; with room it stays (design §3)', async () => {
        const onAgree = vi.fn();
        await show(createElement(StandingTakeUp, { unit: 'month', beans_c: 5000, title: 'Vehicle Storage', payeeName: 'Rob', busy: false, onCancel: vi.fn(), onAgree, now: NOW, room: 3000 }));
        expect(byId('standing-no-room')!.textContent).toBe('You need 50 Beans of room; you have 30');
        expect(byId('standing-agree')!.getAttribute('aria-disabled')).toBe('true');
        await tap(byId('standing-agree'));
        expect(onAgree).not.toHaveBeenCalled();
        host.remove();
        await show(createElement(StandingTakeUp, { unit: 'month', beans_c: 5000, title: 'Vehicle Storage', payeeName: 'Rob', busy: false, onCancel: vi.fn(), onAgree, now: NOW, room: 8000 }));
        expect(byId('standing-no-room')).toBeNull();
        await tap(byId('standing-agree'));
        expect(onAgree).toHaveBeenCalledTimes(1);
    });
    it('for a count of weeks and a later start', async () => {
        const onAgree = vi.fn();
        await show(createElement(StandingTakeUp, { unit: 'week', beans_c: 1250, title: 'Eggs', payeeName: 'Ann', busy: false, onCancel: vi.fn(), onAgree, now: NOW }));
        await tap(byId('standing-periods'));
        await tap(button('One fewer'));
        expect(byId('standing-periods')!.textContent).toBe('For 5 weeks');
        await tap(byId('standing-start-on'));
        await tap(button('A day later'));
        expect(byId('standing-start-on')!.textContent).toBe('On 11 Nov');
        // 12.50 Beans a week (1250 hundredths), written as every figure is: two decimals when not whole ("12.5" before).
        expect(byId('standing-held-now')!.textContent).toBe('12.50 Beans go to Ann now for the first week (11 Nov – 18 Nov), then 12.50 at the start of each week, until one of you stops it.');
        await tap(byId('standing-agree'));
        expect(onAgree).toHaveBeenCalledWith({ periods: 5, startsAt: NOW + 2 * 86_400_000 });
    });
    // Round 2 of #3000, finding 2: the node refuses a start more than 10 minutes old (checkStandingStart), so the start is the
    // moment Agree is tapped (the app back from the background), never the moment the screen opened.
    it('Agree tapped 11 minutes after the screen opened: the start is the tap, today or a day later', async () => {
        const clock = vi.spyOn(Date, 'now').mockReturnValue(NOW);
        try {
            const onAgree = vi.fn();
            await show(createElement(StandingTakeUp, { unit: 'month', beans_c: 5000, title: 'Vehicle Storage', payeeName: 'Rob', busy: false, onCancel: vi.fn(), onAgree }));
            clock.mockReturnValue(NOW + 11 * 60_000);
            await tap(byId('standing-agree'));
            expect(onAgree).toHaveBeenLastCalledWith({ periods: null, startsAt: NOW + 11 * 60_000 });
            await tap(byId('standing-start-on'));
            clock.mockReturnValue(NOW + 40 * 60_000);
            await tap(byId('standing-agree'));
            expect(onAgree).toHaveBeenLastCalledWith({ periods: null, startsAt: NOW + 40 * 60_000 + 86_400_000 });
        } finally {
            clock.mockRestore();
        }
    });
});

// Month 2 of a deal started 9 Oct, paid on 9 Nov; month 3 due 9 Dec. Every row of a standing deal is a finished deal. Its
// figure per period is whole hundredths of a Bean, as the node reads it (standingBeans_c).
const row = (o: Record<string, unknown> = {}) => ({
    id: 'tx-3', postTitle: 'Vehicle Storage', status: 'completed', buyerPublicKey: PAYER, buyerCallsign: 'Marty', sellerPublicKey: PAYEE, sellerCallsign: 'Rob',
    createdAt: '2026-11-09T08:00:00.000Z', completedAt: '2026-11-09T08:00:00.000Z',
    standingId: 'sd-1', periodNo: 2, standingPhase: 'paid', standingBeans_c: 5000, standingUnit: 'month', standingMaxPeriods: 6,
    standingNextDueAt: '2026-12-09T08:00:00.000Z', standingStartsAt: '2026-10-09T08:00:00.000Z', standingShortSince: null, standingStopped: false,
    ...o,
}) as any;
// Month 2 (9 Nov – 9 Dec, 30 days) unpaid: its grace is 15 days, to 24 Nov (the same day in every time zone at 08:00 UTC).
const SHORT = { periodNo: 1, standingPhase: 'short', standingShortSince: '2026-11-09T08:00:00.000Z', standingNextDueAt: '2026-11-09T09:00:00.000Z' };

describe('the panel, each phase and each side', () => {
    // [phase, over, side, the status line, Stop's words, the payer's warning]
    const matrix: Array<[string, Record<string, unknown>, string, string, string, boolean]> = [
        ['paid', {}, PAYER, "This month's 50 went to Rob on 9 Nov · the next 50 go on 9 Dec", 'Stop…', false],
        ['paid', {}, PAYEE, "Marty's standing deal · 50 Beans a month · paid for this month on 9 Nov · next on 9 Dec", 'Stop…', false],
        ['short', SHORT, PAYER, "⚠️ This month's 50 Beans couldn't be paid · 50 needed by 24 Nov or it ends", 'Stop now', true],
        ['short', SHORT, PAYEE, "This month isn't paid yet · we'll keep trying until 24 Nov", 'Stop now', false],
    ];
    for (const [phase, over, side, status, stopWords, warning] of matrix) {
        it(`${phase}, ${side === PAYER ? 'payer' : 'payee'}`, async () => {
            await show(createElement(StandingPanel, { tx: row(over), actingAs: side, busy: false, onStop: vi.fn() }));
            expect(byId('standing-status')!.textContent).toBe(status);
            expect(byId('standing-hold-back')).toBeNull();
            expect(byId('standing-stop')!.textContent).toBe(stopWords);
            expect(host.textContent).toContain('🔁 Standing deal since 9 Oct · 50 Beans a month');
            expect(host.textContent).not.toMatch(/Release|Cancel|Hold back/);
            // The payer's short-funds banner is the warning tone from the tokens; the payee's, and every other phase, the calm one.
            const panel = byId('standing-panel-tx-3')!;
            expect(style(panel).backgroundColor).toBe(warning ? lightColors.feedback.warning.bg : lightColors.feedback.success.bg);
            expect(byId('standing-status')!.getAttribute('data-role')).toBe(warning ? 'alert' : null);
        });
    }
    it('Stop asks first (Keep it / Stop it), in the payer\'s words, and stops only from the alert', async () => {
        const onStop = vi.fn();
        await show(createElement(StandingPanel, { tx: row(), actingAs: PAYER, busy: false, onStop }));
        await tap(byId('standing-stop'));
        expect(onStop).not.toHaveBeenCalled();
        const [title, body, buttons] = vi.mocked(Alert.alert).mock.calls[0] as [string, string, Array<{ text: string; onPress?: () => void }>];
        expect([title, body]).toEqual(['Stop after this month?', "You've paid for this month; Rob keeps it; nothing more is paid."]);
        expect(buttons.map(b => b.text)).toEqual(['Keep it', 'Stop it']);
        buttons[1].onPress!();
        expect(onStop).toHaveBeenCalledTimes(1);
    });
    it('short: the Stop question says it ends now, in each side\'s words (amendment §1)', async () => {
        const words: Array<[string, string]> = [
            [PAYER, "It ends now. This month's 50 Beans aren't paid and won't be; nothing is owed through the app for the days since 9 Nov. Talk to Rob about it."],
            [PAYEE, "It ends now. This month's 50 Beans won't come; nothing is owed through the app for the days since 9 Nov."],
        ];
        for (const [side, said] of words) {
            vi.mocked(Alert.alert).mockClear();
            await show(createElement(StandingPanel, { tx: row(SHORT), actingAs: side, busy: false, onStop: vi.fn() }));
            await tap(byId('standing-stop'));
            const [title, body] = vi.mocked(Alert.alert).mock.calls[0] as [string, string];
            expect([title, body]).toEqual(['Stop it now?', said]);
            host.remove();
        }
    });
});

describe('at 320 dp with the text at 1.3x, light and dark from the tokens', () => {
    for (const dark of [false, true]) {
        it(`${dark ? 'dark' : 'light'}: every colour is a token, nothing fixed-width, no text cut to a line count, 44 dp targets`, async () => {
            theme.dark = dark;
            const colors = dark ? darkColors : lightColors;
            await show(createElement('div', null,
                createElement(StandingTakeUp, { unit: 'month', beans_c: 5000, title: 'A very long listing title for a garden plot down by the creek', payeeName: 'Bartholomew', busy: false, onCancel: vi.fn(), onAgree: vi.fn(), now: NOW, room: 1250 }),
                createElement(StandingPanel, { tx: row(SHORT), actingAs: PAYER, busy: false, onStop: vi.fn(), onMessage: vi.fn(), messageLabel: 'Message Rob' })));
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
