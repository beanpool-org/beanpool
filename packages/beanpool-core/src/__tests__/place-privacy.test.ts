import { describe, expect, it } from 'vitest';
import { looksLikeStreetAddress, placeShownRoughly, roundToNeighbourhood } from '../index';

// What a member sees of other people's places where anyone can join (DESIGN-global-member-privacy-fable.md §4).
const ME = 'a'.repeat(64);
const THEM = 'b'.repeat(64);
const at = { lat: -28.65, lng: 153.55 };

describe('placeShownRoughly: when a listing says its place is to about 1 km', () => {
    it('only where anyone can join, only with a place, never on your own', () => {
        expect(placeShownRoughly({ authorPublicKey: THEM, type: 'offer', ...at }, ME, true)).toBe(true);
        expect(placeShownRoughly({ authorPublicKey: THEM, type: 'offer', ...at }, ME, false)).toBe(false);
        expect(placeShownRoughly({ authorPublicKey: THEM, type: 'offer', lat: null, lng: null }, ME, true)).toBe(false);
        expect(placeShownRoughly({ authorPublicKey: ME, type: 'offer', ...at }, ME, true)).toBe(false);
    });
    it('an event: not to its host nor to someone Going who has the spot; yes while waiting or not going', () => {
        const ev = { authorPublicKey: THEM, type: 'event', ...at };
        expect(placeShownRoughly({ ...ev, eventRsvps: [] }, ME, true)).toBe(false);
        expect(placeShownRoughly({ ...ev, myRsvp: 'going', myLetIn: true }, ME, true)).toBe(false);
        expect(placeShownRoughly({ ...ev, myRsvp: 'going' }, ME, true)).toBe(false);
        expect(placeShownRoughly({ ...ev, myRsvp: 'going', myLetIn: false }, ME, true)).toBe(true);
        expect(placeShownRoughly({ ...ev, myRsvp: 'interested', myLetIn: null }, ME, true)).toBe(true);
        expect(placeShownRoughly(ev, ME, true)).toBe(true);
    });
});

describe('looksLikeStreetAddress: the gentle nudge under an event\'s place name', () => {
    it('catches a house number and a street', () => {
        for (const s of ['12 Example St', 'Alice back garden, 12 Example St', '4/21 Station Road', 'Unit 3, 9 Hill Cres', '7a Byron Bay Rd.', '100 Main Street']) {
            expect(looksLikeStreetAddress(s), s).toBe(true);
        }
    });
    it('leaves a hall, a club and a numbered shed alone', () => {
        for (const s of ['Bangalow Hall', 'The old bowls club', 'Shed 2', 'Lot 12', 'Park, near the 3 big trees', '']) {
            expect(looksLikeStreetAddress(s), s).toBe(false);
        }
    });
});

describe('roundToNeighbourhood', () => {
    it('rounds to 0.01°, halves up, never -0', () => {
        expect(roundToNeighbourhood(-28.654312)).toBe(-28.65);
        expect(roundToNeighbourhood(153.555)).toBe(153.56);
        expect(Object.is(roundToNeighbourhood(-0.001), -0)).toBe(false);
    });
});
