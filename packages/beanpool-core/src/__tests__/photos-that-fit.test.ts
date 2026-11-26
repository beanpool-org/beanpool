/**
 * Several photos picked in one go keep the first that fit, in the order picked, and say how many were left out
 * (photos-that-fit.ts; Marty, 26 Nov 2026). The table walks every pick of 0 to 7 photos against every room of 0 to 5.
 */
import { describe, expect, it } from 'vitest';
import { photosThatFit, photosLeftOutLine } from '../photos-that-fit.js';

const PICK = ['a', 'b', 'c', 'd', 'e', 'f', 'g'];

describe('photosThatFit', () => {
    for (let room = 0; room <= 5; room++) {
        for (let picked = 0; picked <= PICK.length; picked++) {
            const want = Math.min(room, picked);
            it(`${picked} picked, room for ${room}: keeps the first ${want} in order, ${picked - want} left out`, () => {
                const fit = photosThatFit(PICK.slice(0, picked), room);
                expect(fit.kept).toEqual(PICK.slice(0, want));
                expect(fit.leftOut).toBe(picked - want);
                expect(fit.kept.length + fit.leftOut).toBe(picked);
            });
        }
    }

    it('a room that is no finite number, or below nothing, keeps none; a fraction keeps the whole photos below it', () => {
        expect(photosThatFit(['a', 'b'], Number.NaN)).toEqual({ kept: [], leftOut: 2 });
        expect(photosThatFit(['a', 'b'], -3)).toEqual({ kept: [], leftOut: 2 });
        expect(photosThatFit(['a', 'b', 'c'], 1.9)).toEqual({ kept: ['a'], leftOut: 2 });
        expect(photosThatFit(['a', 'b'], Number.POSITIVE_INFINITY)).toEqual({ kept: [], leftOut: 2 });
    });

    it('never changes the pick it was handed', () => {
        const pick = ['a', 'b', 'c'];
        photosThatFit(pick, 1);
        expect(pick).toEqual(['a', 'b', 'c']);
    });
});

describe('photosLeftOutLine', () => {
    it('says nothing when nothing was left out', () => {
        expect(photosLeftOutLine(0)).toBe('');
        expect(photosLeftOutLine(-1)).toBe('');
        expect(photosLeftOutLine(Number.NaN)).toBe('');
    });

    it('says plainly how many were left out, one and several', () => {
        expect(photosLeftOutLine(1)).toBe('1 photo was left out: there was no room for more.');
        expect(photosLeftOutLine(2)).toBe('2 photos were left out: there was no room for more.');
        expect(photosLeftOutLine(6)).toBe('6 photos were left out: there was no room for more.');
    });
});
