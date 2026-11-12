/**
 * The card on its own (slice C6; DESIGN-credit-list-fable.md test 22 with amendment 1 §5.4): when it reads again, and what it does
 * with an answer for the member before. The whole Ledger around it is pages/LedgerPage.credit-seen.test.tsx; the phone's
 * twin is apps/native utils/__tests__/credit-me-ledger-render.test.ts. Nothing here contacts a node.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import { creditMeCard, type CreditMeAnswer } from '@beanpool/core';

const node = vi.hoisted(() => ({
    reads: 0,
    pending: [] as { resolve: (r: unknown) => void; reject: (e: unknown) => void }[],
    takesCredit: true,
}));
vi.mock('../lib/credit-sight', async (orig) => ({
    ...(await orig<typeof import('../lib/credit-sight')>()),
    nodeTakesCredit: vi.fn(async () => node.takesCredit),
    getCreditMe: vi.fn(() => { node.reads++; return new Promise((resolve, reject) => { node.pending.push({ resolve, reject }); }); }),
}));

import { CreditSeenByGivers } from './CreditSeenByGivers';

const answer = (o: Partial<CreditMeAnswer> = {}): CreditMeAnswer & Record<string, unknown> => ({
    memberPubkey: 'a'.repeat(64), callsign: 'Ana', own: false, owed_c: 0, over_c: 0, paused: false,
    line_c: 130000, usable_c: 130000, liveOffers: 1, balance_c: -42000, canGive: true, status: 'active',
    risk: { level: 'low', more: true, reasons: [{ code: 'new', level: 'not_known', mark: 'open', values: {} }] }, ...o,
});
const settle = async () => { for (let i = 0; i < 4; i++) await act(async () => {}); };
const reply = async (me: unknown) => { await act(async () => { node.pending.shift()!.resolve({ told: 'x', me }); }); await settle(); };
const refuse = async (status: number) => { await act(async () => { node.pending.shift()!.reject(Object.assign(new Error('no'), { status })); }); await settle(); };
const card = () => screen.queryByTestId('credit-seen-by-givers');

beforeEach(() => { node.reads = 0; node.pending.length = 0; node.takesCredit = true; });
afterEach(cleanup);

describe('when the card is read, and what it keeps', () => {
    it('nothing until the node answers, then core\'s lines (red when it draws before the answer)', async () => {
        render(<CreditSeenByGivers memberKey="a" reread={0} />);
        await settle();
        expect(node.reads).toBe(1);
        expect(card()).toBeNull();
        await reply(answer());
        const c = creditMeCard(answer());
        expect(card()!.textContent).toContain(c.credit);
        expect(card()!.textContent).toContain(c.balance);
        expect(card()!.textContent).toContain(c.told);
        // The Offers line is under a credit line; the sentence for no line says it already.
        expect(screen.getByTestId('credit-seen-offers').textContent).toBe('1 live Offer');
    });

    it('a node with Beans off is not asked (red when the card asks and relies on the 404)', async () => {
        node.takesCredit = false;
        render(<CreditSeenByGivers memberKey="a" reread={0} />);
        await settle();
        expect(node.reads).toBe(0);
        expect(card()).toBeNull();
    });

    it('a changed balance reads again; the card on screen stays until the new answer lands (red when it flickers away or reads twice for one change)', async () => {
        const { rerender } = render(<CreditSeenByGivers memberKey="a" reread={-42000} />);
        await settle();
        await reply(answer());
        expect(screen.getByTestId('credit-seen-balance').textContent).toContain('Balance −420');
        rerender(<CreditSeenByGivers memberKey="a" reread={-50000} />);
        await settle();
        expect(node.reads).toBe(2);
        expect(screen.getByTestId('credit-seen-balance').textContent).toContain('Balance −420'); // still the old one, not blank
        await reply(answer({ balance_c: -50000 }));
        expect(screen.getByTestId('credit-seen-balance').textContent).toContain('Balance −500');
        rerender(<CreditSeenByGivers memberKey="a" reread={-50000} />); // the same balance again: no new read
        await settle();
        expect(node.reads).toBe(2);
    });

    it('a re-read the node refuses takes the card away rather than leaving a stale balance (red when a refusal leaves the old figure)', async () => {
        const { rerender } = render(<CreditSeenByGivers memberKey="a" reread={1} />);
        await settle();
        await reply(answer());
        expect(card()).not.toBeNull();
        rerender(<CreditSeenByGivers memberKey="a" reread={2} />);
        await settle();
        await refuse(404);
        expect(card()).toBeNull();
    });

    it('another member\'s card is never drawn for this one, and a late answer for the member before is dropped (red when the answer outlives its member)', async () => {
        const { rerender } = render(<CreditSeenByGivers memberKey="a" reread={0} />);
        await settle();
        rerender(<CreditSeenByGivers memberKey="b" reread={0} />); // the account changed before the first answer
        await settle();
        expect(node.reads).toBe(2);
        await reply(answer({ line_c: 999900 })); // the first member's late answer
        expect(card()).toBeNull();
        await reply(answer({ line_c: 0, liveOffers: 4, balance_c: 0 }));
        expect(card()!.textContent).toContain('No credit yet · 4 live Offers');
        expect(card()!.textContent).not.toContain('9,999');
    });

    it('Val: Spending paused is marked, and the balance is read aloud as minus (red when the sign or the mark is lost)', async () => {
        render(<CreditSeenByGivers memberKey="a" reread={0} />);
        await settle();
        await reply(answer({ line_c: 80000, usable_c: 20000, balance_c: -43713, liveOffers: 1, risk: { level: 'medium', more: false, reasons: [] } }));
        expect(screen.getByTestId('credit-seen-paused').textContent).toContain('Spending paused');
        const bal = screen.getByTestId('credit-seen-balance');
        expect(bal.textContent).toContain('Balance −437.13 · using 437.13 of 800');
        expect(bal.querySelector('.sr-only')!.textContent).toBe('Balance minus 437.13 Beans, using 437.13 of 800');
        expect(bal.querySelector('[aria-hidden="true"]')!.textContent).toBe('Balance −437.13 · using 437.13 of 800');
    });

    it('a code this build does not know draws nothing, and a card with no reasons draws no empty list (red when an empty bullet list shows)', async () => {
        render(<CreditSeenByGivers memberKey="a" reread={0} />);
        await settle();
        await reply(answer({ risk: { level: 'high', more: false, reasons: [{ code: 'from_the_future', level: 'high', mark: 'giver', values: {} } as never] } }));
        expect(card()).not.toBeNull();
        expect(screen.queryByTestId('credit-seen-reasons')).toBeNull();
    });
});
