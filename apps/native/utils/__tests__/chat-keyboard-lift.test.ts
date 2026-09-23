import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { initialChatKeyboardLift } from '../chat-keyboard-lift';

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
 * The view is not rendered here (see vitest.config.ts), so this reads its source: the seed has to reach the
 * shared value the padding is driven by, or the logic above protects nothing.
 */
describe('ChatKeyboardAvoidingView seeds its lift from that helper', () => {
    it('the shared value starts at the provider height, not at zero', () => {
        const src = readFileSync(
            join(__dirname, '..', '..', 'components', 'chat', 'ChatKeyboardAvoidingView.tsx'), 'utf8');
        expect(src).toMatch(/useSharedValue\(initialChatKeyboardLift\(\{[\s\S]{0,200}?useKeyboardState\(s => s\.height\)/);
        expect(src).toMatch(/isVisible: useKeyboardState\(s => s\.isVisible\)/);
    });
});
