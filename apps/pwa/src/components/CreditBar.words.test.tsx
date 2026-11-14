/**
 * The credit card in the member's language (slice R1): the headline, the sentence, the note, the label on the dot, the
 * words under the marks, the parts line and the button's label all come through core's t()/tn(); the figures in the
 * language's digits. Main's words for the old bar ("sweet spot", "fee-free", "← carry credit", "hold credit →", "fee/mo",
 * "{n} B", the 🎣 captions) are gone from it.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { CreditBar } from './CreditBar';
import { backToEnglish, bracketed, bypassing, showIn, xx } from '../words-w2.test-support';

afterEach(() => { cleanup(); backToEnglish(); });

const PART_CLOSED = { balance_c: -12000, floor_c: -90000, usableFloor_c: -50000, liveOffers: 1, roomHeld_c: 30000, earnedCredit_c: 60000, vouchedBy: [{ callsign: 'Damo', amount_c: 30000 }] };

describe('the credit card in the pseudo-locale', () => {
    it('with live Offers opening part of the line: every word through the words layer', async () => {
        await showIn('xx');
        render(<CreditBar answer={PART_CLOSED} />);
        expect(screen.getByText(xx('your limit'))).toBeInTheDocument();
        expect(screen.getByText(xx('balanced'))).toBeInTheDocument();
        expect(screen.getByText(xx('monthly fee starts'))).toBeInTheDocument();
        expect(bracketed()).toBeGreaterThan(5);
        expect(bypassing(document.body, { others: ['Damo'] })).toEqual([]);
    });

    it('with no line yet, and above 200: the same', async () => {
        await showIn('xx');
        render(<CreditBar answer={{ balance_c: 0, floor_c: 0 }} />);
        expect(screen.getByText(xx('no credit line yet'))).toBeInTheDocument();
        expect(bypassing()).toEqual([]);
        cleanup();
        render(<CreditBar answer={{ balance_c: 60000, floor_c: -50000, usableFloor_c: -50000, liveOffers: 1, roomHeld_c: 50000 }} />);
        expect(bypassing()).toEqual([]);
    });
});

describe('the credit card in English', () => {
    it('every word as core writes it, and none of the old bar\'s', () => {
        render(<CreditBar answer={PART_CLOSED} />);
        expect(bracketed()).toBe(0);
        expect(screen.getByTestId('credit-headline').textContent).toBe('You owe 120 Beans');
        expect(screen.getByTestId('credit-sentence').textContent).toBe('You can spend 380 more: your live Offer opens 500 of your 900 credit line.');
        expect(screen.getByTestId('credit-note').textContent).toBe('🔒400 is closed for now. One more live Offer opens 800 of your 900, and 3 live Offers open all of it.');
        for (const w of ['your limit', 'balanced', 'monthly fee starts']) expect(screen.getByText(w)).toBeInTheDocument();
        const all = document.body.textContent ?? '';
        for (const old of ['sweet spot', 'fee-free', 'carry credit', 'hold credit', 'fee/mo', '🎣', 'unlocks']) expect(all).not.toContain(old);
        cleanup();

        render(<CreditBar answer={{ balance_c: 60000, floor_c: -50000, usableFloor_c: -50000, liveOffers: 1, roomHeld_c: 50000 }} />);
        expect(screen.getByTestId('credit-label').textContent).toBe('+600 Beans');
        expect(screen.getByTestId('credit-note').textContent).toBe('!400 of your Beans are above 200. A small monthly fee on them goes to the Commons: about 4.50 this month.');
    });
});
