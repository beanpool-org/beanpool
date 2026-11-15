// @vitest-environment jsdom
/**
 * A short week on the phone (components/StandingDeal.tsx; scratch/fable-design/DESIGN-getting-paid-fable.md §3.2, §8 row
 * L2; with the web's src/components/StandingShortWeek.test.tsx), rendered for real at the floor's window (320 x 569 dp, text
 * at 1.3x) as standing-deal-render.test.ts does: the take-up screen's line, the card's quiet link (48 dp), the open ask's line
 * with Take it back or Answer, the three sheets and what each sends, a refusal kept on the sheet with nothing said to have
 * happened, light and dark from the central tokens; and the phone's copy of a deal row keeping the ask (utils/standing-row.ts),
 * without which the phone could show none of it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';

(globalThis as any).__DEV__ = false;
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native', () => {
    const flat = (s: unknown): Record<string, unknown> => Object.assign({}, ...[s].flat(3).filter(Boolean));
    const el = (tag: string) => (props: Record<string, any>) => {
        const { children, onPress, accessibilityLabel, accessibilityRole, accessibilityState, testID, numberOfLines, disabled, style, value, onChangeText } = props;
        const attrs: Record<string, unknown> = { 'data-style': JSON.stringify(flat(style)) };
        if (onPress && !disabled) attrs.onClick = () => onPress();
        if (accessibilityLabel) attrs['aria-label'] = accessibilityLabel;
        if (accessibilityRole) attrs['data-role'] = accessibilityRole;
        if (accessibilityState?.checked !== undefined) attrs['aria-checked'] = String(accessibilityState.checked);
        if (testID) attrs['data-testid'] = testID;
        if (numberOfLines) attrs['data-lines'] = numberOfLines;
        if (disabled) attrs['aria-disabled'] = 'true';
        if (tag === 'input') { attrs.value = value ?? ''; attrs.onChange = (e: any) => onChangeText?.(e.target.value); }
        return createElement(tag, attrs, tag === 'input' ? undefined : children);
    };
    return {
        Platform: { OS: 'android' },
        View: el('div'), Text: el('span'), Pressable: el('button'), TextInput: el('input'),
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

import { formatDate, type StandingDealRow } from '@beanpool/core';
import { StandingPanel, StandingTakeUp, type StandingLowerStep } from '../../components/StandingDeal';
import { standingJsonOf, standingOfRow } from '../standing-row';
import { buildNeedsYou } from '../needs-you';
import { lightColors, darkColors } from '../../constants/colors';

const PAYER = 'a'.repeat(64);
const PAYEE = 'b'.repeat(64);
const START = '2026-11-11T08:00:00.000Z';
// Room at Rob's: 200 Beans a week from 11 Nov; week 1 paid; week 2 is due on 18 Nov, its grace ends 21 Nov 20:00 UTC.
const row = (o: Partial<StandingDealRow> = {}): StandingDealRow => ({
    id: 'tx-1', postId: 'post-1', postTitle: "Room at Rob's", buyerPublicKey: PAYER, buyerCallsign: 'Kim', sellerPublicKey: PAYEE, sellerCallsign: 'Rob',
    amount_c: 20000, status: 'completed', createdAt: START, completedAt: START,
    standingId: 'sd-1', periodNo: 1, standingPhase: 'paid', standingBeans_c: 20000, standingUnit: 'week', standingMaxPeriods: null,
    standingNextDueAt: '2026-11-18T08:00:00.000Z', standingStartsAt: START, standingShortSince: null, standingStopped: false,
    standingAsksLeft: 3, standingAsk: null, ...o,
});
const GRACE = { standingPhase: 'short' as const, standingShortSince: '2026-11-18T08:00:00.000Z', standingNextDueAt: '2026-11-18T09:00:00.000Z' };
const ASK = { standingAsk: { id: 'chg-1', beans_c: 10000, periodNo: 2, askedAt: '2026-11-14T08:00:00.000Z' }, standingAsksLeft: 2 };

let host: HTMLElement;
async function show(node: unknown): Promise<HTMLElement> {
    host?.remove();
    host = document.createElement('div');
    document.body.appendChild(host);
    await act(async () => { createRoot(host).render(node as Parameters<Root['render']>[0]); });
    return host;
}
const byId = (id: string) => host.querySelector(`[data-testid="${id}"]`) as HTMLElement | null;
const tap = async (el: Element | null) => { await act(async () => { (el as HTMLElement).click(); }); };
const type = async (el: Element | null, value: string) => {
    await act(async () => {
        const input = el as HTMLInputElement;
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
        input.dispatchEvent(new Event('input', { bubbles: true }));
    });
};
const style = (el: Element) => JSON.parse(el.getAttribute('data-style') || '{}');
const panel = (tx: StandingDealRow, side: string, onLower?: (s: StandingLowerStep) => Promise<void>) =>
    show(createElement(StandingPanel, { tx, actingAs: side, busy: false, onStop: vi.fn(), onMessage: vi.fn(), messageLabel: 'Message Kim', onLower }));

beforeEach(() => { theme.dark = false; });
afterEach(() => { host?.remove(); });

describe("the phone's copy of a deal row keeps the ask (design §5)", () => {
    it('the lowered amount, the open ask and the asks left go through the standing JSON and back', () => {
        const node = { standingId: 'sd-1', periodNo: 1, standingPhase: 'paid', standingBeans_c: 20000, standingUnit: 'week', standingDueBeans_c: 10000, ...ASK };
        const back = standingOfRow({ standing_id: 'sd-1', period_no: 1, standing: standingJsonOf(node) });
        expect(back.standingDueBeans_c).toBe(10000);
        expect(back.standingAsk).toEqual(ASK.standingAsk);
        expect(back.standingAsksLeft).toBe(2);
    });
    it('a node with no lowering (no asksLeft) reads as none, so the phone offers no lowering to it; a bad ask is dropped', () => {
        const back = standingOfRow({ standing_id: 'sd-1', period_no: 1, standing: standingJsonOf({ standingId: 'sd-1', standingPhase: 'paid', standingAsk: { id: 3 } }) });
        expect(back.standingAsksLeft).toBeNull();
        expect(back.standingAsk).toBeNull();
        expect(back.standingDueBeans_c).toBeNull();
        // A row stored before this build (no such keys) reads the same way: nothing offered, nothing broken.
        const before = standingOfRow({ standing_id: 'sd-1', period_no: 1, standing: JSON.stringify({ phase: 'paid', beans_c: 20000, unit: 'week' }) });
        expect([before.standingAsksLeft, before.standingAsk, before.standingDueBeans_c]).toEqual([null, null, null]);
    });
    it("so the provider's bell has the ask's row, amber and counted, from the phone's own copy (§3.3); the payer has none", () => {
        const node = { ...row(), ...ASK };
        const stored = { ...row(), standingAsk: undefined, standingAsksLeft: undefined, ...standingOfRow({ standing_id: 'sd-1', period_no: 1, standing: standingJsonOf(node) }) };
        const quiet = (me: string) => buildNeedsYou({ me, now: Date.parse('2026-11-14T09:00:00.000Z'), transactions: [stored], decisions: null, conversations: null, groupChats: null, admin: null });
        const rows = quiet(PAYEE);
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({
            kind: 'deal', accent: true, standingId: 'sd-1', target: { to: 'deal', postId: 'post-1', txId: 'tx-1' },
            label: "Kim asks to pay 100 Beans, not 200, for the week from 18 Nov of Room at Rob's.",
        });
        expect(quiet(PAYER)).toEqual([]);
    });
});

describe('the take-up screen (design §3.2)', () => {
    it('says under "If you\'re short…" that a short week can be asked down', async () => {
        await show(createElement(StandingTakeUp, { unit: 'week', beans_c: 20000, title: "Room at Rob's", payeeName: 'Rob', busy: false, onCancel: vi.fn(), onAgree: vi.fn(), now: Date.parse(START) }));
        expect(byId('standing-ask-lower-hint')!.textContent).toBe('Short one week? You can ask Rob to lower it.');
    });
});

describe("the card's link and the ask's line, each side", () => {
    it('payer "Ask to pay less next week…", payee "Lower next week…"; in the grace "this week"; 48 dp', async () => {
        const cases: Array<[Partial<StandingDealRow>, string, string]> = [
            [{}, PAYER, 'Ask to pay less next week…'], [{}, PAYEE, 'Lower next week…'],
            [GRACE, PAYER, 'Ask to pay less this week…'], [GRACE, PAYEE, 'Lower this week…'],
        ];
        for (const [over, side, link] of cases) {
            await panel(row(over), side, vi.fn());
            expect(byId('standing-lower-link')!.textContent).toBe(link);
            expect(style(byId('standing-lower-link')!).minHeight).toBe(48);
        }
    });
    it('no link and no ask line without onLower, on a node with no lowering, when stopped, or with asks used up (payer)', async () => {
        const none: Array<[Partial<StandingDealRow>, string, boolean]> = [
            [{}, PAYER, false], [{ standingAsksLeft: undefined }, PAYEE, true], [{ standingStopped: true }, PAYEE, true], [{ standingAsksLeft: 0 }, PAYER, true],
        ];
        for (const [over, side, give] of none) {
            await panel(row(over), side, give ? vi.fn() : undefined);
            expect(byId('standing-lower-link')).toBeNull();
            expect(byId('standing-ask-line')).toBeNull();
        }
    });
    it('an open ask: the payer reads it with Take it back (which sends the withdrawal), the payee with Answer', async () => {
        const onLower = vi.fn(async (_s: StandingLowerStep) => {});
        await panel(row(ASK), PAYER, onLower);
        expect(byId('standing-ask-line')!.textContent).toBe('You asked to pay 100 Beans for the week from 18 Nov · waiting for Rob');
        expect(byId('standing-lower-link')).toBeNull();
        await tap(byId('standing-ask-takeBack'));
        expect(onLower).toHaveBeenCalledWith({ move: 'withdraw', standingId: 'sd-1', changeId: 'chg-1' });
        await panel(row(ASK), PAYEE, vi.fn());
        expect(byId('standing-ask-line')!.textContent).toBe('⚠️ Kim asks to pay 100 Beans for the week from 18 Nov');
        expect(byId('standing-ask-answer')!.textContent).toBe('Answer');
    });
    it('a refused take-back says why, and the ask is still there', async () => {
        await panel(row(ASK), PAYER, vi.fn(async () => { throw new Error('That ask has already been answered, taken back or closed.'); }));
        await tap(byId('standing-ask-takeBack'));
        expect(byId('standing-step-refusal')!.textContent).toBe('That ask has already been answered, taken back or closed.');
        expect(byId('standing-step-refusal')!.getAttribute('data-role')).toBe('alert');
        expect(byId('standing-ask-line')).not.toBeNull();
    });
});

describe('the three sheets', () => {
    it("the payer's: words, half first, Ask Rob sends the half for week 2; Another amount refuses over the price", async () => {
        const onLower = vi.fn(async (_s: StandingLowerStep) => {});
        await panel(row(), PAYER, onLower);
        await tap(byId('standing-lower-link'));
        const sheet = byId('standing-sheet-ask')!;
        expect(sheet.textContent).toContain('Ask to pay less?');
        expect(sheet.textContent).toContain("Room at Rob's · the week from 18 Nov · 200 Beans");
        expect(sheet.textContent).toContain('Rob has to say yes. Until then nothing changes: the full 200 Beans go on 18 Nov if you have them.');
        expect(sheet.textContent).toContain('If Rob says yes, that week counts as paid in full here. Anything else you two agree is between you; BeanPool keeps no record of it.');
        expect(byId('standing-choice-10000')!.getAttribute('aria-checked')).toBe('true');
        expect(byId('standing-sheet-go')!.textContent).toBe('Ask Rob');
        expect(byId('standing-stop')).toBeNull();
        await tap(byId('standing-choice-other'));
        expect(byId('standing-sheet-go')!.getAttribute('aria-disabled')).toBe('true');
        await type(byId('standing-other-amount'), '200');
        expect(byId('standing-other-refusal')!.textContent).toBe('Choose fewer Beans than 200: a week can be lowered, never raised.');
        await type(byId('standing-other-amount'), '60');
        expect(byId('standing-other-refusal')).toBeNull();
        await tap(byId('standing-sheet-go'));
        const step = onLower.mock.calls[0][0] as Extract<StandingLowerStep, { move: 'lower' }>;
        expect({ ...step, changeId: 'x' }).toEqual({ move: 'lower', standingId: 'sd-1', changeId: 'x', periodNo: 2, beans_c: 6000 });
        expect(byId('standing-sheet-ask')).toBeNull();
    });
    it("the payer's in the grace: we keep trying until the grace ends", async () => {
        await panel(row(GRACE), PAYER, vi.fn());
        await tap(byId('standing-lower-link'));
        const until = formatDate(new Date('2026-11-21T20:00:00.000Z'), 'day-month');
        expect(byId('standing-sheet-ask')!.textContent).toContain(`Rob has to say yes. Until then nothing changes: we keep trying for the full 200 Beans until ${until}.`);
    });
    it('a refused ask stays on the sheet in the node\'s words; a retry sends the same change id', async () => {
        const onLower = vi.fn(async (_s: StandingLowerStep) => { throw new Error("There's already an ask about this week. Answer it, or take it back, first."); });
        await panel(row(), PAYER, onLower);
        await tap(byId('standing-lower-link'));
        await tap(byId('standing-sheet-go'));
        expect(byId('standing-sheet-refusal')!.textContent).toBe("There's already an ask about this week. Answer it, or take it back, first.");
        expect(byId('standing-sheet-ask')).not.toBeNull();
        await tap(byId('standing-sheet-go'));
        const [a, b] = onLower.mock.calls.map(c => (c[0] as { changeId: string }).changeId);
        expect(a).toBe(b);
    });
    it("the payee's answer: instead, counts as paid, Yes and No send their answer for that ask", async () => {
        const onLower = vi.fn(async (_s: StandingLowerStep) => {});
        await panel(row(ASK), PAYEE, onLower);
        await tap(byId('standing-ask-answer'));
        const sheet = byId('standing-sheet-answer')!;
        expect(sheet.textContent).toContain('Kim asks to pay less');
        expect(byId('standing-sheet-instead')!.textContent).toBe('100 Beans instead of 200');
        expect(sheet.textContent).toContain('If you say yes, that week counts as paid in full here: nothing more is owed through the app for it. The week after is 200 Beans again.');
        expect(byId('standing-sheet-go')!.textContent).toBe('Yes, 100 Beans');
        expect(byId('standing-sheet-no')!.textContent).toBe('No, keep 200');
        expect(sheet.textContent).toContain('Message Kim');
        await tap(byId('standing-sheet-no'));
        expect(onLower).toHaveBeenLastCalledWith({ move: 'answer', standingId: 'sd-1', changeId: 'chg-1', yes: false });
        await panel(row(ASK), PAYEE, onLower);
        await tap(byId('standing-ask-answer'));
        await tap(byId('standing-sheet-go'));
        expect(onLower).toHaveBeenLastCalledWith({ move: 'answer', standingId: 'sd-1', changeId: 'chg-1', yes: true });
    });
    it("the payee's lowering: Lower next week?, its line, Lower to 100 then to 0", async () => {
        const onLower = vi.fn(async (_s: StandingLowerStep) => {});
        await panel(row(), PAYEE, onLower);
        await tap(byId('standing-lower-link'));
        const sheet = byId('standing-sheet-lower')!;
        expect(sheet.textContent).toContain('Lower next week?');
        expect(sheet.textContent).toContain('Kim pays this instead of 200 Beans for the week from 18 Nov, and that week counts as paid in full here. You can lower it again, not raise it back. The week after is 200 Beans again.');
        expect(byId('standing-sheet-go')!.textContent).toBe('Lower to 100 Beans');
        // A refused "Another amount": the button is off and names no figure nobody chose (seen in the 320 px shots).
        await tap(byId('standing-choice-other'));
        await type(byId('standing-other-amount'), '250');
        expect(byId('standing-sheet-go')!.textContent).toBe('Lower to … Beans');
        expect(byId('standing-sheet-go')!.getAttribute('aria-disabled')).toBe('true');
        await tap(byId('standing-choice-0'));
        expect(byId('standing-sheet-go')!.textContent).toBe('Lower to 0 Beans');
        await tap(byId('standing-sheet-go'));
        expect(onLower.mock.calls[0][0]).toMatchObject({ move: 'lower', beans_c: 0, periodNo: 2 });
    });
});

describe('at 320 dp with the text at 1.3x, light and dark from the tokens', () => {
    for (const dark of [false, true]) {
        it(`${dark ? 'dark' : 'light'}: each sheet, every colour a token, nothing fixed-width or cut to a line count, 44 dp targets`, async () => {
            theme.dark = dark;
            const colors = dark ? darkColors : lightColors;
            const tokens = new Set<string>();
            const walk = (o: unknown) => { if (o && typeof o === 'object') Object.values(o).forEach(walk); else if (typeof o === 'string') tokens.add(o); };
            walk(colors);
            for (const [tx, side, open] of [[row(), PAYER, 'standing-lower-link'], [row(GRACE), PAYEE, 'standing-lower-link'], [row(ASK), PAYEE, 'standing-ask-answer']] as const) {
                await panel(tx, side, vi.fn());
                await tap(byId(open));
                if (byId('standing-choice-other')) await tap(byId('standing-choice-other'));
                for (const el of Array.from(host.querySelectorAll('[data-style]'))) {
                    const st = style(el);
                    for (const k of ['color', 'backgroundColor', 'borderColor']) {
                        if (st[k]) expect(tokens.has(st[k]), `${k} ${st[k]} is a token`).toBe(true);
                    }
                    // Words (text) are never a fixed width or cut to a line count; the radio's 20 dp dot is a shape, as in the take-up.
                    if (el.tagName === 'SPAN') {
                        expect(st.width, 'no fixed width').toBeUndefined();
                        expect(el.getAttribute('data-lines')).toBeNull();
                    }
                }
                for (const b of Array.from(host.querySelectorAll('button'))) {
                    const st = style(b);
                    expect((st.minHeight ?? st.height ?? 0) >= 44, `${b.textContent} is 44 dp`).toBe(true);
                }
            }
        });
    }
});
