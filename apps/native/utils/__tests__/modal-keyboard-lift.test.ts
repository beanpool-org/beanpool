import { describe, it, expect } from 'vitest';
import { modalKeyboardLift } from '../modal-keyboard-lift';

// Measured on the emulator at 320dp x 569dp (854px tall at 240dpi): the keyboard is 425px (283dp), and the Modal's
// window does not shrink for it.
describe('a sheet in a Modal stays above the keyboard', () => {
    it('no keyboard: 90% of the screen, not lifted', () => {
        expect(modalKeyboardLift({ windowHeight: 569, keyboardHeight: 0, keyboardVisible: false, topGap: 32 }))
            .toEqual({ lift: 0, maxHeight: 569 * 0.9 });
    });

    it('keyboard up: lifted by its height and fitted between the top gap and the keyboard (the 320dp case)', () => {
        expect(modalKeyboardLift({ windowHeight: 569, keyboardHeight: 283, keyboardVisible: true, topGap: 32 }))
            .toEqual({ lift: 283, maxHeight: 569 - 283 - 32 });
    });

    it('a height left over from a hidden keyboard is not a lift, and the height is never negative', () => {
        expect(modalKeyboardLift({ windowHeight: 569, keyboardHeight: 283, keyboardVisible: false, topGap: 32 }).lift).toBe(0);
        expect(modalKeyboardLift({ windowHeight: 300, keyboardHeight: 290, keyboardVisible: true, topGap: 32 }).maxHeight).toBe(0);
    });
});
