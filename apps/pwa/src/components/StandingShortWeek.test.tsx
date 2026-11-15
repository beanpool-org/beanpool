/**
 * A short week on the web (scratch/fable-design/DESIGN-getting-paid-fable.md §3.2, §8 row L2; with the phone's
 * utils/__tests__/standing-short-week-render.test.ts): the take-up screen's line, the card's quiet link, the open ask's line
 * with Take it back or Answer, the three sheets (the payer's ask, the payee's answer, the payee lowering alone), what each
 * sends, a refusal shown on the sheet with nothing said to have happened, the Your deals card's ask line and a lowered
 * week's History line, and the 320 px / 130 % / dark classes. Every word is core's (standingSheet), so the two apps agree.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { StandingPanel, StandingTakeUp, type StandingLowerStep } from './StandingDeal';
import { MyDealsModal } from './MyDealsModal';
import type { MarketplaceTransaction } from '../lib/api';
import { formatDate } from '@beanpool/core';

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

const PAYER = 'a'.repeat(64);
const PAYEE = 'b'.repeat(64);
const START = '2026-11-11T08:00:00.000Z';
// Room at Rob's: 200 Beans a week from 11 Nov; week 1 paid; week 2 is due on 18 Nov, its grace ends 21 Nov.
const row = (o: Partial<MarketplaceTransaction> = {}): MarketplaceTransaction => ({
    id: 'tx-1', postId: 'post-1', postTitle: "Room at Rob's", buyerPublicKey: PAYER, buyerCallsign: 'Kim', sellerPublicKey: PAYEE, sellerCallsign: 'Rob',
    amount_c: 20000, status: 'completed', createdAt: START, completedAt: START,
    standingId: 'sd-1', periodNo: 1, standingPhase: 'paid', standingBeans_c: 20000, standingUnit: 'week', standingMaxPeriods: null,
    standingNextDueAt: '2026-11-18T08:00:00.000Z', standingStartsAt: START, standingShortSince: null, standingStopped: false,
    standingAsksLeft: 3, standingAsk: null, ...o,
});
const GRACE = { standingPhase: 'short' as const, standingShortSince: '2026-11-18T08:00:00.000Z', standingNextDueAt: '2026-11-18T09:00:00.000Z' };
const ASK = { standingAsk: { id: 'chg-1', beans_c: 10000, periodNo: 2, askedAt: '2026-11-14T08:00:00.000Z' }, standingAsksLeft: 2 };

const panel = (tx: MarketplaceTransaction, side: string, onLower?: (s: StandingLowerStep) => Promise<void>) =>
    render(<StandingPanel tx={tx} actingAs={side} busy={false} onStop={vi.fn()} onMessage={vi.fn()} messageLabel="Message Kim" onLower={onLower} />);
const click = async (el: Element) => { await act(async () => { fireEvent.click(el); }); };

describe('the take-up screen (design §3.2)', () => {
    it('says under "If you\'re short…" that a short week can be asked down', () => {
        render(<StandingTakeUp unit="week" beans={20000} title="Room at Rob's" payeeName="Rob" busy={false} onCancel={vi.fn()} onAgree={vi.fn()} now={Date.parse(START)} />);
        expect(screen.getByTestId('standing-ask-lower-hint').textContent).toBe('Short one week? You can ask Rob to lower it.');
    });
});

describe("the card's link and the ask's line, each side", () => {
    it('the payer reads "Ask to pay less next week…", the payee "Lower next week…"; in the grace, "this week"', () => {
        const cases: Array<[Partial<MarketplaceTransaction>, string, string]> = [
            [{}, PAYER, 'Ask to pay less next week…'], [{}, PAYEE, 'Lower next week…'],
            [GRACE, PAYER, 'Ask to pay less this week…'], [GRACE, PAYEE, 'Lower this week…'],
        ];
        for (const [over, side, link] of cases) {
            panel(row(over), side, vi.fn());
            expect(screen.getByTestId('standing-lower-link').textContent).toBe(link);
            cleanup();
        }
    });
    it('no link and no ask line without onLower, on a node with no lowering, when stopped, or with asks used up (payer)', () => {
        const none: Array<[Partial<MarketplaceTransaction>, string, boolean]> = [
            [{}, PAYER, false], [{ standingAsksLeft: undefined }, PAYEE, true], [{ standingStopped: true }, PAYEE, true], [{ standingAsksLeft: 0 }, PAYER, true],
        ];
        for (const [over, side, give] of none) {
            panel(row(over), side, give ? vi.fn() : undefined);
            expect(screen.queryByTestId('standing-lower-link')).toBeNull();
            expect(screen.queryByTestId('standing-ask-line')).toBeNull();
            cleanup();
        }
    });
    it('an open ask: the payer reads it with Take it back, the payee with Answer; neither has the link', () => {
        panel(row(ASK), PAYER, vi.fn());
        expect(screen.getByTestId('standing-ask-line').textContent).toBe('You asked to pay 100 Beans for the week from 18 Nov · waiting for Rob');
        expect(screen.getByTestId('standing-ask-takeBack').textContent).toBe('Take it back');
        expect(screen.queryByTestId('standing-lower-link')).toBeNull();
        cleanup();
        panel(row(ASK), PAYEE, vi.fn());
        expect(screen.getByTestId('standing-ask-line').textContent).toBe('⚠️ Kim asks to pay 100 Beans for the week from 18 Nov');
        expect(screen.getByTestId('standing-ask-answer').textContent).toBe('Answer');
    });
    it('Take it back sends the withdrawal of that ask', async () => {
        const onLower = vi.fn(async () => {});
        panel(row(ASK), PAYER, onLower);
        await click(screen.getByTestId('standing-ask-takeBack'));
        expect(onLower).toHaveBeenCalledWith({ move: 'withdraw', standingId: 'sd-1', changeId: 'chg-1' });
    });
    it('a refused take-back says why under the line, and nothing is said to have happened', async () => {
        panel(row(ASK), PAYER, vi.fn(async () => { throw new Error('That ask has already been answered, taken back or closed.'); }));
        await click(screen.getByTestId('standing-ask-takeBack'));
        expect(screen.getByTestId('standing-step-refusal').textContent).toBe('That ask has already been answered, taken back or closed.');
        expect(screen.getByTestId('standing-ask-line')).toBeTruthy();
    });
});

describe("the payer's sheet: Ask to pay less?", () => {
    it('its words, half picked first, and Ask Rob sends the half for week 2 with one change id', async () => {
        const onLower = vi.fn(async (_s: StandingLowerStep) => {});
        panel(row(), PAYER, onLower);
        await click(screen.getByTestId('standing-lower-link'));
        const sheet = screen.getByTestId('standing-sheet-ask');
        expect(within(sheet).getAllByText('Ask to pay less?')[0].tagName).toBe('P');
        expect(within(sheet).getByText("Room at Rob's · the week from 18 Nov · 200 Beans")).toBeTruthy();
        expect(within(sheet).getByText('Rob has to say yes. Until then nothing changes: the full 200 Beans go on 18 Nov if you have them.')).toBeTruthy();
        expect(within(sheet).getByText('If Rob says yes, that week counts as paid in full here. Anything else you two agree is between you; BeanPool keeps no record of it.')).toBeTruthy();
        expect((screen.getByTestId('standing-choice-10000') as HTMLInputElement).checked).toBe(true);
        expect(screen.getByTestId('standing-sheet-go').textContent).toBe('Ask Rob');
        // The sheet hides Stop while it is open: one thing at a time.
        expect(screen.queryByTestId('standing-stop')).toBeNull();
        await click(screen.getByTestId('standing-sheet-go'));
        const step = onLower.mock.calls[0][0] as Extract<StandingLowerStep, { move: 'lower' }>;
        expect({ ...step, changeId: 'x' }).toEqual({ move: 'lower', standingId: 'sd-1', changeId: 'x', periodNo: 2, beans_c: 10000 });
        expect(step.changeId).toMatch(/^[0-9a-f-]{36}$/);
        expect(screen.queryByTestId('standing-sheet-ask')).toBeNull();
    });
    it('0 Beans and Another amount: a typed figure over the price is refused in words and Ask is off', async () => {
        const onLower = vi.fn(async (_s: StandingLowerStep) => {});
        panel(row(), PAYER, onLower);
        await click(screen.getByTestId('standing-lower-link'));
        await click(screen.getByTestId('standing-choice-other'));
        expect((screen.getByTestId('standing-sheet-go') as HTMLButtonElement).disabled).toBe(true);
        fireEvent.change(screen.getByTestId('standing-other-amount'), { target: { value: '250' } });
        expect(screen.getByTestId('standing-other-refusal').textContent).toBe('Choose fewer Beans than 200: a week can be lowered, never raised.');
        expect((screen.getByTestId('standing-sheet-go') as HTMLButtonElement).disabled).toBe(true);
        fireEvent.change(screen.getByTestId('standing-other-amount'), { target: { value: '75.5' } });
        expect(screen.queryByTestId('standing-other-refusal')).toBeNull();
        await click(screen.getByTestId('standing-sheet-go'));
        expect((onLower.mock.calls[0][0] as { beans_c: number }).beans_c).toBe(7550);
    });
    it('in the grace it says we keep trying for the full price until the grace ends', async () => {
        panel(row(GRACE), PAYER, vi.fn());
        await click(screen.getByTestId('standing-lower-link'));
        // The grace ends 21 Nov 20:00 UTC: the day as this app writes it where the test runs.
        const until = formatDate(new Date('2026-11-21T20:00:00.000Z'), 'day-month');
        expect(screen.getByText(`Rob has to say yes. Until then nothing changes: we keep trying for the full 200 Beans until ${until}.`)).toBeTruthy();
    });
    it('a refused ask stays on the sheet with the node\'s words; a retry sends the same change id', async () => {
        const onLower = vi.fn(async (_s: StandingLowerStep) => { throw new Error("You've asked about this week three times, which is the most."); });
        panel(row(), PAYER, onLower);
        await click(screen.getByTestId('standing-lower-link'));
        await click(screen.getByTestId('standing-sheet-go'));
        expect(screen.getByTestId('standing-sheet-refusal').textContent).toBe("You've asked about this week three times, which is the most.");
        expect(screen.getByTestId('standing-sheet-ask')).toBeTruthy();
        expect(screen.queryByTestId('standing-ask-line')).toBeNull();
        await click(screen.getByTestId('standing-sheet-go'));
        const [a, b] = onLower.mock.calls.map(c => (c[0] as { changeId: string }).changeId);
        expect(a).toBe(b);
    });
    it('Cancel closes it and sends nothing', async () => {
        const onLower = vi.fn(async () => {});
        panel(row(), PAYER, onLower);
        await click(screen.getByTestId('standing-lower-link'));
        await click(screen.getByTestId('standing-sheet-cancel'));
        expect(screen.queryByTestId('standing-sheet-ask')).toBeNull();
        expect(onLower).not.toHaveBeenCalled();
    });
});

describe('the payee answering, and lowering alone', () => {
    it('Answer: instead, counts as paid, Yes sends yes and No sends no for that ask', async () => {
        const onLower = vi.fn(async (_s: StandingLowerStep) => {});
        panel(row(ASK), PAYEE, onLower);
        await click(screen.getByTestId('standing-ask-answer'));
        const sheet = screen.getByTestId('standing-sheet-answer');
        expect(within(sheet).getByText('Kim asks to pay less')).toBeTruthy();
        expect(within(sheet).getByText("Room at Rob's · the week from 18 Nov")).toBeTruthy();
        expect(screen.getByTestId('standing-sheet-instead').textContent).toBe('100 Beans instead of 200');
        expect(within(sheet).getByText('If you say yes, that week counts as paid in full here: nothing more is owed through the app for it. The week after is 200 Beans again.')).toBeTruthy();
        expect(screen.getByTestId('standing-sheet-go').textContent).toBe('Yes, 100 Beans');
        expect(screen.getByTestId('standing-sheet-no').textContent).toBe('No, keep 200');
        expect(within(sheet).getByRole('button', { name: 'Message Kim' })).toBeTruthy();
        await click(screen.getByTestId('standing-sheet-go'));
        expect(onLower).toHaveBeenLastCalledWith({ move: 'answer', standingId: 'sd-1', changeId: 'chg-1', yes: true });
        cleanup();
        panel(row(ASK), PAYEE, onLower);
        await click(screen.getByTestId('standing-ask-answer'));
        await click(screen.getByTestId('standing-sheet-no'));
        expect(onLower).toHaveBeenLastCalledWith({ move: 'answer', standingId: 'sd-1', changeId: 'chg-1', yes: false });
    });
    it('Lower next week?: its words, Lower to 100 Beans, then 0', async () => {
        const onLower = vi.fn(async (_s: StandingLowerStep) => {});
        panel(row(), PAYEE, onLower);
        await click(screen.getByTestId('standing-lower-link'));
        const sheet = screen.getByTestId('standing-sheet-lower');
        expect(within(sheet).getAllByText('Lower next week?')[0].tagName).toBe('P');
        expect(within(sheet).getByText('Kim pays this instead of 200 Beans for the week from 18 Nov, and that week counts as paid in full here. You can lower it again, not raise it back. The week after is 200 Beans again.')).toBeTruthy();
        expect(screen.getByTestId('standing-sheet-go').textContent).toBe('Lower to 100 Beans');
        // A refused "Another amount": the button is off and names no figure nobody chose (seen in the 320 px shots).
        await click(screen.getByTestId('standing-choice-other'));
        fireEvent.change(screen.getByTestId('standing-other-amount'), { target: { value: '250' } });
        expect(screen.getByTestId('standing-sheet-go').textContent).toBe('Lower to … Beans');
        expect((screen.getByTestId('standing-sheet-go') as HTMLButtonElement).disabled).toBe(true);
        await click(screen.getByTestId('standing-choice-0'));
        expect(screen.getByTestId('standing-sheet-go').textContent).toBe('Lower to 0 Beans');
        await click(screen.getByTestId('standing-sheet-go'));
        expect((onLower.mock.calls[0][0] as { beans_c: number; periodNo: number })).toMatchObject({ move: 'lower', beans_c: 0, periodNo: 2 });
    });
    it('the lowered card reads by agreement for both sides (status lines from core)', () => {
        panel(row({ standingDueBeans_c: 10000 }), PAYER, vi.fn());
        expect(screen.getByTestId('standing-status').textContent).toBe("This week's 200 went to Rob on 11 Nov · next week is 100 Beans by agreement, on 18 Nov");
        cleanup();
        panel(row({ amount_c: 0, periodNo: 2, completedAt: '2026-11-18T08:00:00.000Z', standingNextDueAt: '2026-11-25T08:00:00.000Z' }), PAYEE, vi.fn());
        expect(screen.getByTestId('standing-status').textContent).toBe('This week is 0 Beans by agreement · the next 200 go on 25 Nov');
    });
});

describe('Your deals', () => {
    it('the card of a running deal with an open ask carries its line for each side; tapping the card opens the listing', () => {
        const onNavigateToPost = vi.fn();
        render(<MyDealsModal visible identity={{ publicKey: PAYEE }} onClose={vi.fn()} posts={[]} initialTab="pending" transactions={[row(ASK)]} onNavigateToPost={onNavigateToPost} />);
        expect(screen.getByTestId('deal-ask-tx-1').textContent).toBe('⚠️ Kim asks to pay 100 Beans for the week from 18 Nov');
        // No Answer button on the small card: it opens the item (small cards open the item).
        expect(within(screen.getByTestId('deal-card-tx-1')).queryByRole('button', { name: 'Answer' })).toBeNull();
    });
    it("History: an older week paid at 100 reads in the Ledger memo's words", () => {
        render(<MyDealsModal visible identity={{ publicKey: PAYER }} onClose={vi.fn()} posts={[]} initialTab="history"
            transactions={[row({ id: 'tx-2', periodNo: 2 }), row({ id: 'tx-old', periodNo: 1, amount_c: 10000, standingPhase: undefined, standingBeans_c: undefined, standingUnit: undefined })]}
            onNavigateToPost={vi.fn()} />);
        expect(screen.getByTestId('deal-history-tx-old').textContent).toBe("Standing deal · Room at Rob's · week 1 · 100 of 200 Beans by agreement");
        expect(screen.queryByTestId('deal-history-tx-2')).toBeNull();
    });
});

describe('at 320 px with the text at 130 %, in light and in dark', () => {
    const classes = (el: Element) => (el.getAttribute('class') ?? '').split(/\s+/).filter(Boolean);
    const COLOUR = /^(bg|text|border)-(nature|emerald|amber|oat)-/;
    it('each sheet: every colour has its dark partner, words wrap, nothing fixed-width, 44 px targets and the 48 px link', async () => {
        for (const [tx, side, open] of [[row(), PAYER, 'standing-lower-link'], [row(), PAYEE, 'standing-lower-link'], [row(ASK), PAYEE, 'standing-ask-answer']] as const) {
            panel(tx, side, vi.fn());
            expect(classes(screen.getByTestId(open))).toContain(open === 'standing-lower-link' ? 'min-h-[48px]' : 'min-h-[44px]');
            await click(screen.getByTestId(open));
            await click(screen.queryByTestId('standing-choice-other') ?? screen.getByTestId('standing-sheet-go').parentElement!);
            const root = screen.getByTestId('standing-panel-tx-1');
            const all = [root, ...Array.from(root.querySelectorAll('*'))];
            for (const el of all) {
                const c = classes(el);
                for (const light of c.filter(k => COLOUR.test(k) && !k.startsWith('dark:'))) {
                    const kind = light.split('-')[0];
                    expect(c.some(k => k.startsWith(`dark:${kind}-`)), `${light} has a dark partner on <${el.tagName.toLowerCase()} class="${c.join(' ')}">`).toBe(true);
                }
                expect(c.filter(k => /^w-\[|^w-\d/.test(k))).toEqual([]);
            }
            for (const b of all.filter(el => el.tagName === 'BUTTON')) {
                expect(classes(b).some(k => k === 'min-h-[44px]' || k === 'min-h-[48px]'), `${b.textContent} is 44 px tall`).toBe(true);
                expect(classes(b)).toContain('break-words');
            }
            cleanup();
        }
    });
});
