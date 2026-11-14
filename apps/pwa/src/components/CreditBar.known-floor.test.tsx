/**
 * The known floor and the vouched part on the web card (slice R1): one live Offer opens the confirmed part, and the credit
 * line people gave, whole; the rest keeps the offer bands. The ladder itself is core's (credit-standing offerLadder), one
 * copy for both apps; this file checks the card says what it opens.
 */
import { render, screen } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import { offerLadder } from '@beanpool/core';
import { CreditBar } from './CreditBar';

describe('CreditBar: the known floor and the vouched part', () => {
    it('with no part opened whole, the ladder is the bands, as before', () => {
        const l = offerLadder(140000);
        expect(l.offersForFull).toBe(4);
        expect(l.rungs).toEqual([20000, 50000, 100000]);
        expect([0, 1, 2, 3, 4, 5].map(l.openAt)).toEqual([0, 20000, 50000, 100000, 140000, 140000]);
    });

    it('one offer opens the whole known floor; earned trust on top keeps the bands', () => {
        const known = offerLadder(100000, 100000);
        expect(known.offersForFull).toBe(1);
        expect([0, 1, 2].map(known.openAt)).toEqual([0, 100000, 100000]);
        const both = offerLadder(170000, 100000);
        expect([0, 1, 2, 3].map(both.openAt)).toEqual([0, 120000, 150000, 170000]);
        expect(both.offersForFull).toBe(3);
    });

    it('tells a confirmed member with no offer that one Offer opens all of it', () => {
        render(<CreditBar answer={{ balance_c: 0, floor_c: -100000, usableFloor_c: 0, liveOffers: 0, knownGrant_c: 100000 }} />);
        expect(screen.getByTestId('credit-note').textContent).toBe('🔒Your 1,000 credit line is asleep. Post one Offer and all of it opens.');
    });

    it('a vouched member with no offer: the same, one Offer opens all of it (main drew a rung at 200, F3)', () => {
        render(<CreditBar answer={{ balance_c: 0, floor_c: -50000, usableFloor_c: 0, liveOffers: 0, roomHeld_c: 50000 }} />);
        expect(screen.getByTestId('credit-note').textContent).toBe('🔒Your 500 credit line is asleep. Post one Offer and all of it opens.');
    });

    it('an older node (no known grant, no room held) says what one Offer opens of an earned line', () => {
        render(<CreditBar answer={{ balance_c: 0, floor_c: -100000, usableFloor_c: 0, liveOffers: 0 }} />);
        expect(screen.getByTestId('credit-note').textContent).toBe('🔒Your 1,000 credit line is asleep. Post one Offer and 200 of it opens.');
    });
});
