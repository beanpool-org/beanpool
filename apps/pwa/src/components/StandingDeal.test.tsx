/**
 * Standing deals on the web, paid at the start of each period (DESIGN-standing-deals-upfront-fable §3 and its amendment §1;
 * with the phone's utils/__tests__/standing-deal-render.test.ts): the take-up screen (how long, when it starts, what is paid
 * now, the choice Agree hands on), the panel for each phase and each side (paid, short with the day its grace ends, stopped),
 * Stop asked first in each side's words, no Hold back, the Your deals card (🔁 STANDING and the panel's line, a short one
 * still open), and the 320 px / 130 % / dark classes. U2 redraws these surfaces; this pins what core says through them.
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

describe('Take this up? (design §3)', () => {
    const show = (onAgree = vi.fn()) => {
        render(<StandingTakeUp unit="month" beans={50} title="Vehicle Storage" payeeName="Rob" busy={false} onCancel={vi.fn()} onAgree={onAgree} now={NOW} />);
        return onAgree;
    };
    it('says what is paid now, for which month, and how it runs; Agree hands on until-stopped from today', () => {
        const onAgree = show();
        const box = screen.getByTestId('standing-take-up');
        expect(within(box).getByText('Take this up?')).toBeTruthy();
        expect(within(box).getByText('Vehicle Storage · 50 Beans a month · from Rob')).toBeTruthy();
        expect(screen.getByTestId('standing-held-now').textContent).toBe('50 Beans go to Rob now for the first month (9 Nov – 9 Dec), then 50 at the start of each month, until one of you stops it.');
        expect(within(box).getByText('You can stop it any time. A month already paid stays paid.')).toBeTruthy();
        fireEvent.click(screen.getByTestId('standing-agree'));
        expect(onAgree).toHaveBeenCalledWith({ periods: null, startsAt: NOW });
        expect(screen.getByTestId('standing-agree').textContent).toBe('Agree and pay 50 Beans');
    });
    it("without room for the first month, Agree is disabled with a plain line; with room, or room not known, it stays (design §3)", () => {
        const onAgree = vi.fn();
        const { rerender } = render(<StandingTakeUp unit="month" beans={50} title="Vehicle Storage" payeeName="Rob" busy={false} onCancel={vi.fn()} onAgree={onAgree} now={NOW} room={30} />);
        expect(screen.getByTestId('standing-no-room').textContent).toBe('You need 50 Beans of room; you have 30');
        expect((screen.getByTestId('standing-agree') as HTMLButtonElement).disabled).toBe(true);
        fireEvent.click(screen.getByTestId('standing-agree'));
        expect(onAgree).not.toHaveBeenCalled();
        for (const room of [50, null]) {
            rerender(<StandingTakeUp unit="month" beans={50} title="Vehicle Storage" payeeName="Rob" busy={false} onCancel={vi.fn()} onAgree={onAgree} now={NOW} room={room} />);
            expect(screen.queryByTestId('standing-no-room')).toBeNull();
            expect((screen.getByTestId('standing-agree') as HTMLButtonElement).disabled).toBe(false);
        }
    });
    it('for a count of months, one more each tap; a later start moves the dates', () => {
        const onAgree = show();
        fireEvent.click(screen.getByLabelText('For 6 months'));
        fireEvent.click(screen.getByRole('button', { name: 'One more' }));
        expect(screen.getByTestId('standing-periods').textContent).toBe('For 7 months');
        fireEvent.click(screen.getByLabelText('Up to 30 days ahead'));
        fireEvent.click(screen.getByRole('button', { name: 'A day later' }));
        expect(screen.getByTestId('standing-start-on').textContent).toBe('On 11 Nov');
        expect(screen.getByTestId('standing-held-now').textContent).toBe('50 Beans go to Rob now for the first month (11 Nov – 11 Dec), then 50 at the start of each month, until one of you stops it.');
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

// Month 2 of a deal started 9 Oct, paid on 9 Nov; month 3 due 9 Dec. Every row of a standing deal is a finished deal.
const row = (o: Partial<MarketplaceTransaction> = {}): MarketplaceTransaction => ({
    id: 'tx-3', postId: 'post-1', postTitle: 'Vehicle Storage', buyerPublicKey: PAYER, buyerCallsign: 'Marty', sellerPublicKey: PAYEE, sellerCallsign: 'Rob',
    credits: 50, status: 'completed', createdAt: '2026-11-09T08:00:00.000Z', completedAt: '2026-11-09T08:00:00.000Z',
    standingId: 'sd-1', periodNo: 2, standingPhase: 'paid', standingBeans: 50, standingUnit: 'month', standingMaxPeriods: 6,
    standingNextDueAt: '2026-12-09T08:00:00.000Z', standingStartsAt: '2026-10-09T08:00:00.000Z', standingShortSince: null, standingStopped: false,
    ...o,
});
// Month 2 (9 Nov – 9 Dec, 30 days) unpaid: its grace is 15 days, to 24 Nov (the same day in every time zone at 08:00 UTC).
const SHORT = { periodNo: 1, standingPhase: 'short' as const, standingShortSince: '2026-11-09T08:00:00.000Z', standingNextDueAt: '2026-11-09T09:00:00.000Z' };

describe('the panel, each phase and each side', () => {
    // [phase, over, side, the status line, Stop's words, a warning]
    const matrix: Array<[string, Partial<MarketplaceTransaction>, string, string, string, boolean]> = [
        ['paid', {}, PAYER, "This month's 50 went to Rob on 9 Nov · the next 50 go on 9 Dec", 'Stop…', false],
        ['paid', {}, PAYEE, "Marty's standing deal · 50 Beans a month · paid for this month on 9 Nov · next on 9 Dec", 'Stop…', false],
        ['short', SHORT, PAYER, "⚠️ This month's 50 Beans couldn't be paid · 50 needed by 24 Nov or it ends", 'Stop now', true],
        ['short', SHORT, PAYEE, "This month isn't paid yet · we'll keep trying until 24 Nov", 'Stop now', false],
    ];
    for (const [phase, over, side, status, stopWords, warning] of matrix) {
        it(`${phase}, ${side === PAYER ? 'payer' : 'payee'}`, () => {
            render(<StandingPanel tx={row(over)} actingAs={side} busy={false} onStop={vi.fn()} />);
            const panel = screen.getByTestId('standing-panel-tx-3');
            expect(panel.getAttribute('data-role')).toBe(side === PAYER ? 'payer' : 'payee');
            expect(screen.getByTestId('standing-status').textContent).toBe(status);
            expect(screen.queryByTestId('standing-hold-back')).toBeNull();
            expect(screen.getByTestId('standing-stop').textContent).toBe(stopWords);
            expect(screen.getByTestId('standing-status').getAttribute('role')).toBe(warning ? 'alert' : null);
            expect(within(panel).getByText('🔁 Standing deal since 9 Oct · 50 Beans a month')).toBeTruthy();
            expect(within(panel).queryByRole('button', { name: /release|cancel|hold/i })).toBeNull();
        });
    }
    it('Stop asks first, in the payer\'s words, and stops only on yes', () => {
        const onStop = vi.fn();
        const ask = vi.spyOn(window, 'confirm').mockReturnValueOnce(false).mockReturnValueOnce(true);
        render(<StandingPanel tx={row()} actingAs={PAYER} busy={false} onStop={onStop} />);
        fireEvent.click(screen.getByTestId('standing-stop'));
        expect(ask.mock.calls[0][0]).toBe("Stop after this month?\n\nYou've paid for this month; Rob keeps it; nothing more is paid.");
        expect(onStop).not.toHaveBeenCalled();
        fireEvent.click(screen.getByTestId('standing-stop'));
        expect(onStop).toHaveBeenCalledTimes(1);
    });
    it('short: the Stop question says it ends now, in each side\'s words (amendment §1)', () => {
        const words: Array<[string, string]> = [
            [PAYER, "Stop it now?\n\nIt ends now. This month's 50 Beans aren't paid and won't be; nothing is owed through the app for the days since 9 Nov. Talk to Rob about it."],
            [PAYEE, "Stop it now?\n\nIt ends now. This month's 50 Beans won't come; nothing is owed through the app for the days since 9 Nov."],
        ];
        for (const [side, question] of words) {
            const ask = vi.spyOn(window, 'confirm').mockReturnValue(false);
            const { unmount } = render(<StandingPanel tx={row(SHORT)} actingAs={side} busy={false} onStop={vi.fn()} />);
            fireEvent.click(screen.getByTestId('standing-stop'));
            expect(ask.mock.calls[0][0]).toBe(question);
            ask.mockRestore();
            unmount();
        }
    });
    it('stopped: no Stop again, and it says when it stops', () => {
        render(<StandingPanel tx={row({ standingStopped: true })} actingAs={PAYEE} busy={false} onStop={vi.fn()} />);
        expect(screen.queryByTestId('standing-stop')).toBeNull();
        expect(screen.getByTestId('standing-status').textContent).toBe('Stops on 9 Dec · this month is paid');
    });
    it('ended, or a one-off deal: no panel', () => {
        const { container } = render(<StandingPanel tx={row({ standingPhase: 'ended' })} actingAs={PAYER} busy={false} onStop={vi.fn()} />);
        expect(container.innerHTML).toBe('');
    });
});

describe('Your deals: one card per standing deal', () => {
    it('🔁 STANDING and the panel\'s line; a short one is in progress and still opens its listing', () => {
        const onNavigateToPost = vi.fn();
        render(<MyDealsModal visible identity={{ publicKey: PAYER }} onClose={vi.fn()} posts={[]} initialTab="pending"
            transactions={[row({ id: 'tx-paid' }), row({ id: 'tx-short', ...SHORT, standingId: 'sd-2' })]} onNavigateToPost={onNavigateToPost} />);
        expect(screen.getByTestId('standing-chip-tx-paid').textContent).toBe('🔁 STANDING');
        expect(screen.getByTestId('deal-state-tx-paid').textContent).toBe("This month's 50 went to Rob on 9 Nov · the next 50 go on 9 Dec");
        expect(screen.getByTestId('deal-state-tx-short').textContent).toBe("⚠️ This month's 50 Beans couldn't be paid · 50 needed by 24 Nov or it ends");
        expect(screen.getByTestId('deal-state-tx-short').getAttribute('role')).toBe('alert');
        fireEvent.click(screen.getByTestId('deal-card-tx-short'));
        expect(onNavigateToPost).toHaveBeenCalledWith('post-1', 'tx-short');
    });
    // Every row of a standing deal is a finished deal; its card is the standing deal, still running, so it never says
    // "completed", and offers no review.
    it("a running one's card says 🔁 STANDING, never completed, and offers no review", () => {
        render(<MyDealsModal visible identity={{ publicKey: PAYEE }} onClose={vi.fn()} posts={[]} initialTab="pending"
            transactions={[row({ id: 'tx-short', ...SHORT })]} onNavigateToPost={vi.fn()} />);
        const card = screen.getByTestId('deal-card-tx-short');
        expect(within(card).getByTestId('standing-chip-tx-short').textContent).toBe('🔁 STANDING');
        expect(within(card).queryByText('completed')).toBeNull();
        expect(within(card).queryByRole('button', { name: /review/i })).toBeNull();
    });
});

describe('Your deals, My listings: a one-off listing a standing deal took is 🔁 STANDING, never Held in Trust (U2)', () => {
    // The node keeps the listing off the board ('pending') while the standing deal runs; nothing is held in trust (design §1, §3).
    const taken = { id: 'post-1', title: 'Vehicle Storage', type: 'offer', status: 'pending', authorPublicKey: PAYEE, credits: 50, createdAt: '2026-10-01T08:00:00.000Z', photos: [] } as any;
    for (const standingPhase of ['paid', 'short'] as const) {
        it(`a running standing deal (${standingPhase}) says 🔁 STANDING`, () => {
            render(<MyDealsModal visible identity={{ publicKey: PAYEE }} onClose={vi.fn()} posts={[taken]} initialTab="active"
                transactions={[row({ id: 'tx-1', standingPhase })]} onNavigateToPost={vi.fn()} />);
            const card = screen.getByTestId('deal-card-post-1');
            expect(card.textContent).toContain('🔁 STANDING');
            expect(card.textContent).not.toContain('Held in Trust');
        });
    }
    it('a one-off deal held still says Held in Trust', () => {
        render(<MyDealsModal visible identity={{ publicKey: PAYEE }} onClose={vi.fn()} posts={[taken]} initialTab="active"
            transactions={[row({ id: 'tx-1', status: 'pending', standingId: undefined, standingPhase: undefined })]} onNavigateToPost={vi.fn()} />);
        expect(screen.getByTestId('deal-card-post-1').textContent).toContain('🤝 Held in Trust');
    });
});

describe('Your deals, History: an ended standing deal says how it ended; review once (U2)', () => {
    const STOPPED = { periodNo: 1, standingPhase: 'ended' as const, standingShortSince: '2026-11-09T08:00:00.000Z', standingEndedAt: '2026-11-12T08:00:00.000Z', standingEndedReason: 'stopped', standingStoppedBy: PAYEE, standingStopped: true };
    it('stopped in the grace by the payee: each side reads its line', () => {
        render(<MyDealsModal visible identity={{ publicKey: PAYER }} onClose={vi.fn()} posts={[]} initialTab="history"
            transactions={[row({ id: 'tx-1', ...STOPPED, ratedByBuyer: true })]} onNavigateToPost={vi.fn()} />);
        expect(screen.getByTestId('deal-history-tx-1').textContent).toBe('Stopped by Rob on 12 Nov · this month unpaid · nothing owed');
        cleanup();
        render(<MyDealsModal visible identity={{ publicKey: PAYEE }} onClose={vi.fn()} posts={[]} initialTab="history"
            transactions={[row({ id: 'tx-1', ...STOPPED, ratedBySeller: true })]} onNavigateToPost={vi.fn()} />);
        expect(screen.getByTestId('deal-history-tx-1').textContent).toBe('Stopped by you on 12 Nov · this month unpaid · nothing owed');
    });
    it('a later period unrated offers no Leave Review; the first period does', () => {
        render(<MyDealsModal visible identity={{ publicKey: PAYER }} onClose={vi.fn()} posts={[]} initialTab="history" onPromptReview={vi.fn()}
            transactions={[row({ id: 'tx-m2', periodNo: 2, standingPhase: undefined }), row({ id: 'tx-m1', periodNo: 1, standingPhase: undefined })]} onNavigateToPost={vi.fn()} />);
        expect(within(screen.getByTestId('deal-card-tx-m2')).queryByRole('button', { name: 'Leave Review' })).toBeNull();
        expect(within(screen.getByTestId('deal-card-tx-m1')).getByRole('button', { name: 'Leave Review' })).toBeTruthy();
    });
});

describe('at 320 px with the text at 130 %, in light and in dark', () => {
    const classes = (el: Element) => (el.getAttribute('class') ?? '').split(/\s+/).filter(Boolean);
    const COLOUR = /^(bg|text|border)-(nature|emerald|amber|oat)-/;
    it('every colour has its dark partner, the words wrap, and every target is 44 px', () => {
        render(<>
            <StandingTakeUp unit="week" beans={12.5} title="A very long listing title for a garden plot by the creek" payeeName="Rob" busy={false} onCancel={vi.fn()} onAgree={vi.fn()} now={NOW} />
            <StandingPanel tx={row(SHORT)} actingAs={PAYER} busy={false} onStop={vi.fn()} onMessage={vi.fn()} messageLabel="Message Rob" />
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
