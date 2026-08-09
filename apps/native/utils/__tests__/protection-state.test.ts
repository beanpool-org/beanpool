import { describe, it, expect } from 'vitest';
import { RECOVERY_THRESHOLD } from '@beanpool/core';
import { KEEPER_LABELS, protectionFrom } from '../protection-state';
import type { KeeperEnrolmentResult } from '../keeper-enrolment';

const result = (over: Partial<KeeperEnrolmentResult> = {}): KeeperEnrolmentResult => ({
    enrolled: [], generation: null, skipped: [], available: 0, ...over,
});

describe('a member who is covered', () => {
    it('reports the state and who is holding a piece', () => {
        const p = protectionFrom(result({ enrolled: ['device', 'hub', 'member'], generation: 1, available: 3 }));
        expect(p.state).toBe('covered');
        expect(p.stillNeeded).toBe(0);
        expect(p.holding).toEqual([
            KEEPER_LABELS.device, KEEPER_LABELS.hub, KEEPER_LABELS.member,
        ]);
    });

    it('offers the words behind a tap rather than filling the screen with them', () => {
        // The words stay the floor under all of this, but a member who is genuinely covered
        // should not be met with twelve words to copy down.
        expect(protectionFrom(result({ enrolled: ['device', 'hub', 'member'], available: 3 })).showWords).toBe(false);
    });

    it('never says "K2" or "device" to a person', () => {
        const p = protectionFrom(result({ enrolled: ['device', 'hub', 'member'], available: 3 }));
        for (const label of p.holding) {
            expect(label).not.toMatch(/^(device|hub|member|sso)$/);
            expect(label).not.toMatch(/K[1-5]/);
        }
    });
});

describe('a member who is one keeper short', () => {
    it('is "almost", and is NOT shown anyone as holding a piece', () => {
        // The doc's State B mock ticks two keepers ✅. Nothing is holding anything — below the
        // threshold nothing is split at all — so ticking them would claim a protection that does
        // not exist, which is the one thing this screen must never do.
        const p = protectionFrom(result({ available: RECOVERY_THRESHOLD - 1 }));
        expect(p.state).toBe('almost');
        expect(p.holding).toEqual([]);
        expect(p.stillNeeded).toBe(1);
        expect(p.showWords).toBe(true);
    });
});

describe('a member whose words are the way back', () => {
    it('says so plainly when nobody could hold a piece', () => {
        const p = protectionFrom(result({ available: 0 }));
        expect(p.state).toBe('words-only');
        expect(p.showWords).toBe(true);
    });

    it('does not call two-short "almost"', () => {
        // Two short is not "almost" in any sense a member would recognise. Calling it that
        // would be the same overclaiming in a quieter voice.
        expect(protectionFrom(result({ available: 1 })).state).toBe('words-only');
    });

    it('shows the words while enrolment has not answered yet', () => {
        // Not a spinner state. If the result never arrives — dead node, hung request — the
        // screen still has to say something true, and the words are true in every case. Nobody
        // should sit in front of a screen waiting to learn whether they are safe.
        const p = protectionFrom(null);
        expect(p.state).toBe('words-only');
        expect(p.showWords).toBe(true);
    });

    it('degrades a partial enrolment to honest rather than trusting it', () => {
        // Unreachable today — enrolment writes nothing below the threshold — but a partial
        // result reported as "covered" is the precise failure this whole model exists to
        // prevent, so it is not left resting on an invariant held in another file.
        const p = protectionFrom(result({ enrolled: ['device', 'hub'], generation: 1, available: 3 }));
        expect(p.state).not.toBe('covered');
        expect(p.state).toBe('words-only');
        expect(p.stillNeeded).toBe(1);
    });
});

describe('the rule that outranks the others', () => {
    it.each([
        ['nothing enrolled', result({ available: 2 })],
        ['a partial enrolment', result({ enrolled: ['device', 'hub'], available: 3 })],
        ['no result at all', null],
        ['an outright failure', result({ available: 0, error: 'no node configured yet' })],
    ])('never claims cover from %s', (_label, input) => {
        // One rule, checked from every direction: the screen may understate what a member has,
        // and may never overstate it.
        const p = protectionFrom(input);
        expect(p.state).not.toBe('covered');
        expect(p.holding.length).toBeLessThan(RECOVERY_THRESHOLD);
        expect(p.showWords).toBe(true);
    });
});
