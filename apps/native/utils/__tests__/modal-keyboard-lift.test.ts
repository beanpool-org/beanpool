import { describe, it, expect } from 'vitest';
import { modalKeyboardLift } from '../modal-keyboard-lift';

// Measured on the emulator at 320dp x 569dp (854px tall at 240dpi): the keyboard is 425px (283dp).
describe('a sheet in a Modal stays above the keyboard', () => {
    it('no keyboard: 90% of the screen, below the top gap', () => {
        expect(modalKeyboardLift({ windowHeight: 569, backdropHeight: 569, keyboardHeight: 0, keyboardVisible: false, topGap: 32 }))
            .toEqual({ lift: 0, maxHeight: 569 * 0.9 });
    });

    it('the window did not shrink: lift by the keyboard and fit what is left (the 320dp case that lost the form)', () => {
        const r = modalKeyboardLift({ windowHeight: 569, backdropHeight: 569, keyboardHeight: 283, keyboardVisible: true, topGap: 32 });
        expect(r.lift).toBe(283);
        expect(r.maxHeight).toBe(569 - 283 - 32);
    });

    it('the window already shrank: never lift twice', () => {
        const r = modalKeyboardLift({ windowHeight: 569, backdropHeight: 286, keyboardHeight: 283, keyboardVisible: true, topGap: 32 });
        expect(r.lift).toBe(0);
        expect(r.maxHeight).toBe(286 - 32);
    });

    it('before the first layout it assumes the full window, and never returns a negative height', () => {
        expect(modalKeyboardLift({ windowHeight: 569, backdropHeight: 0, keyboardHeight: 0, keyboardVisible: false, topGap: 32 }).maxHeight).toBeCloseTo(512.1);
        expect(modalKeyboardLift({ windowHeight: 300, backdropHeight: 300, keyboardHeight: 290, keyboardVisible: true, topGap: 32 }).maxHeight).toBe(0);
    });
});
