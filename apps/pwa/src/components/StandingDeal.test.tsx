/**
 * Standing deals S2 on the web (DESIGN-standing-deals-fable §2.2, §3; with the phone's utils/__tests__/standing-deal-render
 * .test.ts): the take-up screen (how long, when it starts, what is held now, the choice Agree hands on), the panel for each
 * phase and each side (held, short with the end of its week, held back), Stop asked first, Hold back the payer's only, the
 * Your deals card (🔁 STANDING and the panel's line, a short one still open), and the 320 px / 130 % / dark classes.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { StandingPanel, StandingTakeUp } from './StandingDeal';
import { MyDealsModal } from './MyDealsModal';
import type { MarketplaceTransaction } from '../lib/api';

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

const PAYER = 'a'.repeat(64);
const PAYEE = 'b'.repeat(64);
const NOW = Date.parse('2026-11-09T08:00:00.000Z');

describe('Take this up? (§2.2)', () => {
    const show = (onAgree = vi.fn()) => {
        render(<StandingTakeUp unit="month" beans={50} title="Vehicle Storage" payeeName="Rob" busy={false} onCancel={vi.fn()} onAgree={onAgree} now={NOW} />);
        return onAgree;
    };
    it('says what is held now, for which month, and how it runs; Agree hands on until-stopped from today', () => {
        const onAgree = show();
        const box = screen.getByTestId('standing-take-up');
        expect(within(box).getByText('Take this up?')).toBeTruthy();
        expect(within(box).getByText('Vehicle Storage · 50 Beans a month · from Rob')).toBeTruthy();
        expect(screen.getByTestId('standing-held-now').textContent).toBe('50 Beans are held now for the first month (9 Nov – 9 Dec).');
        expect(within(box).getByText(/At the end of each month they go to Rob/)).toBeTruthy();
        fireEvent.click(screen.getByTestId('standing-agree'));
        expect(onAgree).toHaveBeenCalledWith({ periods: null, startsAt: NOW });
        expect(screen.getByTestId('standing-agree').textContent).toBe('Agree and hold 50 Beans');
    });
    it('for a count of months, one more each tap; a later start moves the dates', () => {
        const onAgree = show();
        fireEvent.click(screen.getByLabelText('For 6 months'));
        fireEvent.click(screen.getByRole('button', { name: 'One more' }));
        expect(screen.getByTestId('standing-periods').textContent).toBe('For 7 months');
        fireEvent.click(screen.getByLabelText('Up to 30 days ahead'));
        fireEvent.click(screen.getByRole('button', { name: 'A day later' }));
        expect(screen.getByTestId('standing-start-on').textContent).toBe('On 11 Nov');
        expect(screen.getByTestId('standing-held-now').textContent).toBe('50 Beans are held now for the first month (11 Nov – 11 Dec).');
        fireEvent.click(screen.getByTestId('standing-agree'));
        expect(onAgree).toHaveBeenCalledWith({ periods: 7, startsAt: NOW + 2 * 86_400_000 });
    });
    // Round 2 of #3000, finding 2: the node refuses a start more than 10 minutes old (checkStandingStart), so the start is the
    // moment Agree is tapped, never the moment the screen opened.
    it('Agree tapped 11 minutes after the screen opened: the start is the tap, today or a day later', () => {
        const clock = vi.spyOn(Date, 'now').mockReturnValue(NOW);
        const onAgree = vi.fn();
        render(<StandingTakeUp unit="month" beans={50} title="Vehicle Storage" payeeName="Rob" busy={false} onCancel={vi.fn()} onAgree={onAgree} />);
        clock.mockReturnValue(NOW + 11 * 60_000);
        fireEvent.click(screen.getByTestId('standing-agree'));
        expect(onAgree).toHaveBeenLastCalledWith({ periods: null, startsAt: NOW + 11 * 60_000 });
        fireEvent.click(screen.getByLabelText('Up to 30 days ahead'));
        clock.mockReturnValue(NOW + 40 * 60_000);
        fireEvent.click(screen.getByTestId('standing-agree'));
        expect(onAgree).toHaveBeenLastCalledWith({ periods: null, startsAt: NOW + 40 * 60_000 + 86_400_000 });
    });
});

const row = (o: Partial<MarketplaceTransaction> = {}): MarketplaceTransaction => ({
    id: 'tx-3', postId: 'post-1', postTitle: 'Vehicle Storage', buyerPublicKey: PAYER, buyerCallsign: 'Marty', sellerPublicKey: PAYEE, sellerCallsign: 'Rob',
    credits: 50, status: 'pending', createdAt: '2026-11-09T08:00:00.000Z',
    standingId: 'sd-1', periodNo: 3, standingPhase: 'held', standingBeans: 50, standingUnit: 'month', standingMaxPeriods: 6,
    standingNextDueAt: '2026-12-09T08:00:00.000Z', standingStartsAt: '2026-10-09T08:00:00.000Z', standingShortSince: null, standingStopped: false,
    ...o,
});
const SHORT = { status: 'completed' as const, standingPhase: 'short' as const, standingShortSince: '2026-12-09T08:00:00.000Z' };

describe('the panel, each phase and each side', () => {
    // [phase, side, the status line, Hold back shown, Stop's words, a warning]
    const matrix: Array<[string, Partial<MarketplaceTransaction>, string, string, boolean, string, boolean]> = [
        ['held', {}, PAYER, "This month's 50 Beans are held · they go to Rob 9 Dec", true, 'Stop…', false],
        ['held', {}, PAYEE, "Marty's standing deal · 50 Beans a month · this month held for you · paid 9 Dec", false, 'Stop…', false],
        ['short', SHORT, PAYER, "⚠️ Next month isn't covered · 50 Beans needed by 16 Dec or this ends", false, 'Stop…', true],
        ['short', SHORT, PAYEE, "Next month isn't covered yet · we'll keep trying until 16 Dec", false, 'Stop now', true],
        ['held back', { standingPhase: 'held_back' }, PAYER, 'Held back · the schedule is paused', false, 'Stop…', false],
        ['held back', { standingPhase: 'held_back' }, PAYEE, 'Held back · the schedule is paused', false, 'Stop…', false],
    ];
    for (const [phase, over, side, status, holdBack, stopWords, warning] of matrix) {
        it(`${phase}, ${side === PAYER ? 'payer' : 'payee'}`, () => {
            render(<StandingPanel tx={row(over)} actingAs={side} busy={false} onStop={vi.fn()} onHoldBack={vi.fn()} />);
            const panel = screen.getByTestId('standing-panel-tx-3');
            expect(panel.getAttribute('data-role')).toBe(side === PAYER ? 'payer' : 'payee');
            expect(screen.getByTestId('standing-status').textContent).toBe(status);
            expect(!!screen.queryByTestId('standing-hold-back')).toBe(holdBack);
            expect(screen.getByTestId('standing-stop').textContent).toBe(stopWords);
            expect(screen.getByTestId('standing-status').getAttribute('role')).toBe(warning ? 'alert' : null);
            expect(within(panel).getByText('🔁 Standing deal since 9 Oct · 50 Beans a month')).toBeTruthy();
        });
    }
    it('Stop asks first, and stops only on yes; Hold back is the payer\'s tap', () => {
        const onStop = vi.fn();
        const onHoldBack = vi.fn();
        const ask = vi.spyOn(window, 'confirm').mockReturnValueOnce(false).mockReturnValueOnce(true);
        render(<StandingPanel tx={row()} actingAs={PAYER} busy={false} onStop={onStop} onHoldBack={onHoldBack} />);
        fireEvent.click(screen.getByTestId('standing-stop'));
        expect(ask.mock.calls[0][0]).toContain('Stop after this month?');
        expect(ask.mock.calls[0][0]).toContain('The month under way is still paid.');
        expect(onStop).not.toHaveBeenCalled();
        fireEvent.click(screen.getByTestId('standing-stop'));
        expect(onStop).toHaveBeenCalledTimes(1);
        fireEvent.click(screen.getByTestId('standing-hold-back'));
        expect(onHoldBack).toHaveBeenCalledTimes(1);
    });
    // Round 2 of #3000 (non-blocking note): short, nothing is held and Stop ends it at once (the node's endStanding), as the
    // payee's "Stop now" says; the question says so too, to either side.
    it('short: the Stop question says it stops now, to the payer and to the payee', () => {
        for (const side of [PAYER, PAYEE]) {
            const ask = vi.spyOn(window, 'confirm').mockReturnValue(false);
            const { unmount } = render(<StandingPanel tx={row(SHORT)} actingAs={side} busy={false} onStop={vi.fn()} onHoldBack={vi.fn()} />);
            fireEvent.click(screen.getByTestId('standing-stop'));
            expect(ask.mock.calls[0][0]).toBe('Stop it now?\n\nIt ends now. Nothing is held for it, and nothing more will be.');
            ask.mockRestore();
            unmount();
        }
    });
    it('stopped: no Stop again, and the last month says when it ends', () => {
        render(<StandingPanel tx={row({ standingStopped: true })} actingAs={PAYEE} busy={false} onStop={vi.fn()} onHoldBack={vi.fn()} />);
        expect(screen.queryByTestId('standing-stop')).toBeNull();
        expect(screen.getByText('Vehicle Storage: the last month of this standing deal is under way. It ends on 9 Dec.')).toBeTruthy();
    });
    it('ended, or a one-off deal: no panel', () => {
        const { container } = render(<StandingPanel tx={row({ standingPhase: 'ended' })} actingAs={PAYER} busy={false} onStop={vi.fn()} onHoldBack={vi.fn()} />);
        expect(container.innerHTML).toBe('');
    });
});

describe('Your deals: one card per standing deal', () => {
    it('🔁 STANDING and the panel\'s line; a short one is in progress and still opens its listing', () => {
        const onNavigateToPost = vi.fn();
        render(<MyDealsModal visible identity={{ publicKey: PAYER }} onClose={vi.fn()} posts={[]} initialTab="pending"
            transactions={[row({ id: 'tx-held' }), row({ id: 'tx-short', ...SHORT, standingId: 'sd-2' })]} onNavigateToPost={onNavigateToPost} />);
        expect(screen.getByTestId('standing-chip-tx-held').textContent).toBe('🔁 STANDING');
        expect(screen.getByTestId('deal-state-tx-held').textContent).toBe("This month's 50 Beans are held · they go to Rob 9 Dec");
        expect(screen.getByTestId('deal-state-tx-short').textContent).toBe("⚠️ Next month isn't covered · 50 Beans needed by 16 Dec or this ends");
        expect(screen.getByTestId('deal-state-tx-short').getAttribute('role')).toBe('alert');
        fireEvent.click(screen.getByTestId('deal-card-tx-short'));
        expect(onNavigateToPost).toHaveBeenCalledWith('post-1', 'tx-short');
    });
    // Round 2 of #3000 (non-blocking note): a short deal's row is the period last settled; its card is the standing deal,
    // still running, so it never says "completed", and offers no review.
    it("a short one's card says 🔁 STANDING, never completed, and offers no review", () => {
        render(<MyDealsModal visible identity={{ publicKey: PAYEE }} onClose={vi.fn()} posts={[]} initialTab="pending"
            transactions={[row({ id: 'tx-short', ...SHORT })]} onNavigateToPost={vi.fn()} />);
        const card = screen.getByTestId('deal-card-tx-short');
        expect(within(card).getByTestId('standing-chip-tx-short').textContent).toBe('🔁 STANDING');
        expect(within(card).queryByText('completed')).toBeNull();
        expect(within(card).queryByRole('button', { name: /review/i })).toBeNull();
    });
});

describe('at 320 px with the text at 130 %, in light and in dark', () => {
    const classes = (el: Element) => (el.getAttribute('class') ?? '').split(/\s+/).filter(Boolean);
    const COLOUR = /^(bg|text|border)-(nature|emerald|amber|oat)-/;
    it('every colour has its dark partner, the words wrap, and every target is 44 px', () => {
        render(<>
            <StandingTakeUp unit="week" beans={12.5} title="A very long listing title for a garden plot by the creek" payeeName="Rob" busy={false} onCancel={vi.fn()} onAgree={vi.fn()} now={NOW} />
            <StandingPanel tx={row(SHORT)} actingAs={PAYER} busy={false} onStop={vi.fn()} onHoldBack={vi.fn()} onMessage={vi.fn()} messageLabel="Message Rob" />
        </>);
        const all = [screen.getByTestId('standing-take-up'), screen.getByTestId('standing-panel-tx-3')]
            .flatMap(root => [root, ...Array.from(root.querySelectorAll('*'))]);
        for (const el of all) {
            const c = classes(el);
            for (const light of c.filter(k => COLOUR.test(k) && !k.startsWith('dark:'))) {
                const kind = light.split('-')[0];
                expect(c.some(k => k.startsWith(`dark:${kind}-`)), `${light} has a dark partner on <${el.tagName.toLowerCase()} class="${c.join(' ')}">`).toBe(true);
            }
            // Nothing a fixed width (the steppers are 44 px squares by design).
            expect(c.filter(k => /^w-\[|^w-\d/.test(k) && k !== 'w-11')).toEqual([]);
        }
        for (const b of all.filter(el => el.tagName === 'BUTTON')) {
            expect(classes(b).some(k => k === 'min-h-[44px]' || k === 'h-11'), `${b.textContent} is 44 px tall`).toBe(true);
        }
        expect(classes(screen.getByTestId('standing-status'))).toContain('break-words');
        expect(classes(screen.getByTestId('standing-agree'))).toContain('break-words');
    });
});
