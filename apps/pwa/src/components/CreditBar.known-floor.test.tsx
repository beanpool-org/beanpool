import { render, screen } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import { CreditBar, offerLadder } from './CreditBar';

/** The offer ladder for a confirmed member in a known community (slice 4): one live offer unlocks the whole known floor. */
describe('CreditBar: the known floor', () => {
    it('with no known floor the ladder is the bands, as before', () => {
        const l = offerLadder(-1400);
        expect(l.offersForFull).toBe(4);
        expect(l.rungs).toEqual([200, 500, 1000]);
        expect([0, 1, 2, 3, 4, 5].map(l.usableAt)).toEqual([0, 200, 500, 1000, 1400, 1400]);
    });

    it('one offer unlocks the whole known floor; earned trust on top keeps the bands', () => {
        const known = offerLadder(-1000, 1000);
        expect(known.offersForFull).toBe(1);
        expect([0, 1, 2].map(known.usableAt)).toEqual([0, 1000, 1000]);
        const both = offerLadder(-1700, 1000);
        expect([0, 1, 2, 3].map(both.usableAt)).toEqual([0, 1200, 1500, 1700]);
        expect(both.offersForFull).toBe(3);
    });

    it('tells a known member with no offer that one offer unlocks it all', () => {
        render(<CreditBar balance={0} floor={-1000} usableFloor={0} liveOffers={0} knownGrant={1000} />);
        expect(screen.getByText(/to open your credit line/).textContent).toMatch(/1 offer unlocks your\s*full\s*−1000/);
    });

    it('an older node (no knownGrant) still gets the band count', () => {
        render(<CreditBar balance={0} floor={-1000} usableFloor={0} liveOffers={0} />);
        expect(screen.getByText(/to open your credit line/).textContent).toMatch(/3 offers unlock your\s*full\s*−1000/);
    });
});
