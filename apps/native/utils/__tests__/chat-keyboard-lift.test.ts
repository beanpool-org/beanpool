/**
 * The chat composer's lift, as a pure function of three measurements.
 *
 * These cases replace utils/__tests__/chat-window-mode.test.ts, which guarded the old design by forbidding any
 * app file from SPELLING `setInputMode(` — a rule that guaranteed less than its name said, because the library
 * spells it for every KeyboardAvoidingView, KeyboardStickyView and KeyboardAwareScrollView imported anywhere in
 * the app (about twenty files), ReviewModal inside the DM among them. The lift no longer depends on the window's
 * mode at all, so the rule is gone and what replaces it is stronger: the mode's two outcomes are both pinned
 * here as arithmetic, including the one the old design got wrong.
 *
 * Reference numbers: a 640dp window, a 300dp keyboard, a 24dp bottom inset where one is in play.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
    chatKeyboardLift,
    initialChatKeyboardLift,
    restingWindowHeight,
} from '../chat-keyboard-lift';

const WINDOW = 640;
const KEYBOARD = 300;

describe('the lift under SOFT_INPUT_ADJUST_NOTHING', () => {
    it('is the keyboard height when the view reaches the window bottom', () => {
        // The OS left the window alone: the view's bottom is still at the window's bottom, under the keyboard.
        expect(chatKeyboardLift({ viewBottom: WINDOW, windowHeight: WINDOW, keyboardHeight: KEYBOARD }))
            .toBe(KEYBOARD);
    });

    it('is the keyboard height LESS a bottom inset the view already sits above', () => {
        // A nav-bar inset below the composer is lift the OS has already given us; adding it again is a dead gap.
        expect(chatKeyboardLift({ viewBottom: WINDOW - 24, windowHeight: WINDOW, keyboardHeight: KEYBOARD }))
            .toBe(KEYBOARD - 24);
    });
});

describe('the lift under adjustResize', () => {
    it('is zero: the window has already shrunk by the keyboard', () => {
        // The OS resized the window, so the view was laid out 300dp higher and is already clear of the keyboard.
        expect(chatKeyboardLift({
            viewBottom: WINDOW - KEYBOARD,
            windowHeight: WINDOW,
            keyboardHeight: KEYBOARD,
        })).toBe(0);
    });

    it('stays at zero with a bottom inset as well', () => {
        expect(chatKeyboardLift({
            viewBottom: WINDOW - KEYBOARD - 24,
            windowHeight: WINDOW,
            keyboardHeight: KEYBOARD,
        })).toBe(0);
    });

    /**
     * The defect this design replaces. Round 2 padded by the ABSOLUTE keyboard height, which is only ever the
     * right answer under ADJUST_NOTHING. The window's mode is global and the library hands it back to the
     * manifest's adjustResize from about twenty components, so this case is reachable inside a chat — and there
     * the absolute lift strands the composer a whole keyboard above the keyboard.
     */
    it('is what the round-2 absolute lift got wrong', () => {
        const frame = { viewBottom: WINDOW - KEYBOARD, windowHeight: WINDOW, keyboardHeight: KEYBOARD };
        const absoluteLift = Math.max(frame.keyboardHeight, 0); // what round 2 computed
        expect(absoluteLift).toBe(KEYBOARD);
        expect(chatKeyboardLift(frame)).toBe(0);
        expect(chatKeyboardLift(frame)).not.toBe(absoluteLift);
    });
});

describe('the lift when the keyboard only partly overlaps the view', () => {
    it('is the overlap, when the window shrank by less than the keyboard', () => {
        // The window gave back 100dp of the keyboard's 300dp; the other 200dp is still over the view.
        expect(chatKeyboardLift({
            viewBottom: WINDOW - 100,
            windowHeight: WINDOW,
            keyboardHeight: KEYBOARD,
        })).toBe(200);
    });

    it('is zero for a view that does not reach the keyboard at all', () => {
        // A view ending halfway up the window — the keyboard never touches it, whatever the mode.
        expect(chatKeyboardLift({ viewBottom: 320, windowHeight: WINDOW, keyboardHeight: KEYBOARD })).toBe(0);
    });

    it('never returns a negative padding', () => {
        expect(chatKeyboardLift({ viewBottom: 0, windowHeight: WINDOW, keyboardHeight: KEYBOARD })).toBe(0);
    });
});

describe('the lift while the keyboard is animating', () => {
    const opening = [0, 60, 150, 240, KEYBOARD];

    it('follows every intermediate height, non-negative and monotonic, opening', () => {
        const lifts = opening.map(h =>
            chatKeyboardLift({ viewBottom: WINDOW, windowHeight: WINDOW, keyboardHeight: h }));
        expect(lifts).toEqual([0, 60, 150, 240, KEYBOARD]);
        for (let i = 1; i < lifts.length; i++) {
            expect(lifts[i]).toBeGreaterThanOrEqual(lifts[i - 1]);
            expect(lifts[i]).toBeGreaterThanOrEqual(0);
        }
    });

    it('and closing', () => {
        const lifts = [...opening].reverse().map(h =>
            chatKeyboardLift({ viewBottom: WINDOW, windowHeight: WINDOW, keyboardHeight: h }));
        expect(lifts).toEqual([KEYBOARD, 240, 150, 60, 0]);
        for (let i = 1; i < lifts.length; i++) {
            expect(lifts[i]).toBeLessThanOrEqual(lifts[i - 1]);
            expect(lifts[i]).toBeGreaterThanOrEqual(0);
        }
    });

    it('follows a keyboard that changes height while it STAYS open', () => {
        // Gboard growing from its hardware-keyboard bar into the full keyboard — the case a latched height
        // (the library's `heightWhenOpened`) never sees, and the 320dp/1.3x walkthrough bug.
        const at = (h: number) => chatKeyboardLift({ viewBottom: WINDOW, windowHeight: WINDOW, keyboardHeight: h });
        expect(at(120)).toBe(120);
        expect(at(480)).toBe(480);
        expect(at(120)).toBe(120);
    });

    it('is nothing at all when the keyboard is down', () => {
        expect(chatKeyboardLift({ viewBottom: WINDOW, windowHeight: WINDOW, keyboardHeight: 0 })).toBe(0);
        expect(chatKeyboardLift({ viewBottom: WINDOW, windowHeight: WINDOW, keyboardHeight: -300 })).toBe(0);
    });
});

describe('the lift refuses measurements it cannot trust', () => {
    it('is zero without a usable window height', () => {
        expect(chatKeyboardLift({ viewBottom: WINDOW, windowHeight: 0, keyboardHeight: KEYBOARD })).toBe(0);
        expect(chatKeyboardLift({ viewBottom: WINDOW, windowHeight: NaN, keyboardHeight: KEYBOARD })).toBe(0);
    });

    it('is zero before the view has been laid out or if a height arrives unusable', () => {
        expect(chatKeyboardLift({ viewBottom: NaN, windowHeight: WINDOW, keyboardHeight: KEYBOARD })).toBe(0);
        expect(chatKeyboardLift({ viewBottom: WINDOW, windowHeight: WINDOW, keyboardHeight: NaN })).toBe(0);
    });
});

describe('the resting window height the lift is measured against', () => {
    it('is the live height the first time it is seen', () => {
        expect(restingWindowHeight(null, WINDOW)).toBe(WINDOW);
    });

    it('stays put under ADJUST_NOTHING, where the live height never moves', () => {
        expect(restingWindowHeight(WINDOW, WINDOW)).toBe(WINDOW);
    });

    it('keeps the unshrunken height while adjustResize has the window short', () => {
        expect(restingWindowHeight(WINDOW, WINDOW - KEYBOARD)).toBe(WINDOW);
    });

    it('does not record a shrunken height even if the resize is the first thing it sees', () => {
        // The resize and the keyboard's visibility arrive as two separate events. A rule gated on "the keyboard
        // is not visible" would record 340 here and then lift twice; a maximum cannot.
        expect(restingWindowHeight(WINDOW, WINDOW - KEYBOARD)).toBe(WINDOW);
        expect(restingWindowHeight(WINDOW, WINDOW)).toBe(WINDOW);
    });

    it('ignores heights that are not real measurements', () => {
        expect(restingWindowHeight(WINDOW, 0)).toBe(WINDOW);
        expect(restingWindowHeight(WINDOW, NaN)).toBe(WINDOW);
        expect(restingWindowHeight(null, 0)).toBe(0);
    });

    it('relearns from scratch once it is thrown away (a rotation into a shorter window)', () => {
        expect(restingWindowHeight(null, 360)).toBe(360);
    });
});

describe('a chat that mounts with the keyboard already up starts lifted', () => {
    it('takes the height the provider is holding', () => {
        expect(initialChatKeyboardLift({ height: 425, isVisible: true })).toBe(425);
    });

    it('starts flat when there is no keyboard', () => {
        expect(initialChatKeyboardLift({ height: 0, isVisible: false })).toBe(0);
    });

    it('a height left over from a keyboard that has closed is not a lift', () => {
        // The module keeps the last height it saw; only `isVisible` says whether it is still there.
        expect(initialChatKeyboardLift({ height: 425, isVisible: false })).toBe(0);
    });

    it('never lifts by a negative or unusable height', () => {
        expect(initialChatKeyboardLift({ height: -425, isVisible: true })).toBe(0);
        expect(initialChatKeyboardLift({ height: NaN, isVisible: true })).toBe(0);
    });
});

/**
 * The view is not rendered here (see vitest.config.ts), so this reads its source: the helper has to be what
 * actually drives the padding, and it has to be fed the LIVE keyboard height and the view's OWN bottom edge,
 * or everything above protects nothing.
 */
describe('ChatKeyboardAvoidingView is driven by these helpers', () => {
    const src = readFileSync(
        join(__dirname, '..', '..', 'components', 'chat', 'ChatKeyboardAvoidingView.tsx'), 'utf8');

    it('pads by chatKeyboardLift and by nothing else', () => {
        expect(src).toMatch(/paddingBottom:\s*chatKeyboardLift\(\{/);
        // Not the absolute keyboard height that round 2 shipped.
        expect(src).not.toMatch(/paddingBottom:\s*Math\.max\(keyboardHeight\.value/);
    });

    it('feeds it the view\'s own measured bottom edge', () => {
        expect(src).toMatch(/onLayout/);
        expect(src).toMatch(/viewBottom\.value = y \+ height/);
        expect(src).toMatch(/viewBottom:\s*viewBottom\.value/);
    });

    it('feeds it the live keyboard height, from every frame', () => {
        expect(src).toMatch(/onMove: e => \{ 'worklet'; keyboardHeight\.value = e\.height; \}/);
        expect(src).toMatch(/onInteractive: e => \{ 'worklet'; keyboardHeight\.value = e\.height; \}/);
        expect(src).toMatch(/onEnd: e => \{ 'worklet'; keyboardHeight\.value = e\.height; \}/);
    });

    it('seeds that height for a chat that mounts with the keyboard already up', () => {
        expect(src).toMatch(/useSharedValue\(initialChatKeyboardLift\(\{[\s\S]{0,200}?useKeyboardState\(s => s\.height\)/);
        expect(src).toMatch(/isVisible: useKeyboardState\(s => s\.isVisible\)/);
    });

    it('sets no window mode, so its correctness cannot depend on one', () => {
        expect(src).not.toMatch(/setInputMode/);
        expect(src).not.toMatch(/setDefaultMode/);
        expect(src).not.toMatch(/AndroidSoftInputModes/);
        // The generic handler is the one that leaves the window's mode alone.
        expect(src).toMatch(/useGenericKeyboardHandler/);
        expect(src).not.toMatch(/\buseKeyboardHandler\b/);
    });
});
