import { describe, it, expect } from 'vitest';
import { TWO_LAYER_THRESHOLD } from '@beanpool/core';
import { KEEPER_LABELS, protectionFrom } from '../protection-state';
import type { KeeperEnrolmentResult } from '../keeper-enrolment';

const result = (over: Partial<KeeperEnrolmentResult> = {}): KeeperEnrolmentResult => ({
    enrolled: [], generation: null, skipped: [], available: 0, ...over,
});

// ---------------------------------------------------------------------------
// SSO tier — hub + sso = covered at TWO_LAYER_THRESHOLD (2)
// ---------------------------------------------------------------------------

describe('SSO-tier member (hub + sso)', () => {
    it('is covered with hub + sso', () => {
        const p = protectionFrom(result({ enrolled: ['hub', 'sso'], generation: 1, available: 2 }));
        expect(p.state).toBe('covered');
        expect(p.tier).toBe('sso');
        expect(p.stillNeeded).toBe(0);
        expect(p.holding).toEqual([KEEPER_LABELS.hub, KEEPER_LABELS.sso]);
    });

    it('tucks words behind a tap for SSO-covered members', () => {
        // SSO-covered members do not need words shown by default — they can recover
        // by signing in with Apple. Offer the add-a-friend upgrade instead.
        const p = protectionFrom(result({ enrolled: ['hub', 'sso'], generation: 1, available: 2 }));
        expect(p.showWords).toBe(false);
    });

    it('gains a spare when a friend is added on top of SSO', () => {
        // SSO + friend: threshold stays at 2 (SSO tier), so 3 enrolled = 1 spare.
        const p = protectionFrom(result({ enrolled: ['hub', 'sso', 'member'], generation: 1, available: 3 }));
        expect(p.state).toBe('covered');
        expect(p.tier).toBe('sso');
        expect(p.spare).toBe(1);
        expect(p.showWords).toBe(false);
    });
});

// ---------------------------------------------------------------------------
// Friend tier — hub + 2 friends = covered at TWO_LAYER_THRESHOLD + 1 (3)
// ---------------------------------------------------------------------------

describe('friend-tier member (hub + friends)', () => {
    it('is covered with hub + 2 friends', () => {
        const p = protectionFrom(result({ enrolled: ['hub', 'member', 'member'], generation: 1, available: 3 }));
        expect(p.state).toBe('covered');
        expect(p.tier).toBe('friends');
        expect(p.stillNeeded).toBe(0);
        expect(p.holding).toEqual([KEEPER_LABELS.hub, KEEPER_LABELS.member, KEEPER_LABELS.member]);
    });

    it('shows words when covered with no spare (exactly at threshold)', () => {
        const p = protectionFrom(result({ enrolled: ['hub', 'member', 'member'], generation: 1, available: 3 }));
        expect(p.spare).toBe(0);
        expect(p.showWords).toBe(true);
    });

    it('tucks words behind a tap once there is a spare friend', () => {
        const p = protectionFrom(result({ enrolled: ['hub', 'member', 'member', 'member'], generation: 1, available: 4 }));
        expect(p.spare).toBe(1);
        expect(p.showWords).toBe(false);
    });

    it('is "almost" with hub + 1 friend (one short)', () => {
        // One friend is not enough for a 2-of-N Shamir split. Partial enrolment
        // that somehow has only hub + 1 member means the threshold was not met.
        const p = protectionFrom(result({ enrolled: ['hub', 'member'], generation: 1, available: 2 }));
        expect(p.state).toBe('almost');
        expect(p.tier).toBe('friends');
        expect(p.stillNeeded).toBe(1);
        expect(p.showWords).toBe(true);
    });
});

// ---------------------------------------------------------------------------
// Sovereign — no enrolled keepers
// ---------------------------------------------------------------------------

describe('sovereign member (no keepers)', () => {
    it('says so plainly when nobody could hold a piece', () => {
        const p = protectionFrom(result({ available: 0 }));
        expect(p.state).toBe('words-only');
        expect(p.tier).toBe('sovereign');
        expect(p.showWords).toBe(true);
    });

    it('is "almost" when one keeper short of the lowest tier', () => {
        // TWO_LAYER_THRESHOLD = 2, so available = 1 means 1 short of SSO-level coverage.
        const p = protectionFrom(result({ available: 1 }));
        expect(p.state).toBe('almost');
        expect(p.tier).toBe('sovereign');
        expect(p.stillNeeded).toBe(1);
        expect(p.showWords).toBe(true);
    });

    it('shows the words while enrolment has not answered yet', () => {
        // Not a spinner state. If the result never arrives, the words are true in every case.
        const p = protectionFrom(null);
        expect(p.state).toBe('words-only');
        expect(p.tier).toBe('sovereign');
        expect(p.showWords).toBe(true);
    });
});

// ---------------------------------------------------------------------------
// The rule that outranks the others: never overstate protection
// ---------------------------------------------------------------------------

describe('the rule that outranks the others', () => {
    it.each([
        ['nothing enrolled', result({ available: 0 })],
        ['no result at all', null],
        ['an outright failure', result({ available: 0, error: 'no node configured yet' })],
    ])('never claims cover from %s', (_label, input) => {
        // One rule, checked from every direction: the screen may understate what a member has,
        // and may never overstate it.
        const p = protectionFrom(input);
        expect(p.state).not.toBe('covered');
        expect(p.holding).toEqual([]);
        expect(p.showWords).toBe(true);
        expect(p.spare).toBe(0);
    });
});

// ---------------------------------------------------------------------------
// Keeper labels
// ---------------------------------------------------------------------------

describe('KEEPER_LABELS', () => {
    it('does not include device — retired with the two-layer model', () => {
        expect(KEEPER_LABELS).not.toHaveProperty('device');
    });

    it('includes hub, member, and sso', () => {
        expect(KEEPER_LABELS).toHaveProperty('hub');
        expect(KEEPER_LABELS).toHaveProperty('member');
        expect(KEEPER_LABELS).toHaveProperty('sso');
    });

    it('never says raw keeper types to a person', () => {
        const p = protectionFrom(result({ enrolled: ['hub', 'sso', 'member', 'member'], generation: 1, available: 4 }));
        for (const label of p.holding) {
            expect(label).not.toMatch(/^(hub|member|sso)$/);
            expect(label).not.toMatch(/K[1-5]/);
        }
    });
});

// ---------------------------------------------------------------------------
// Threshold semantics — the hub is never counted
// ---------------------------------------------------------------------------

describe('threshold semantics', () => {
    it('uses TWO_LAYER_THRESHOLD from core, not a hardcoded number', () => {
        // The threshold constant must come from @beanpool/core, not be reimplemented.
        expect(TWO_LAYER_THRESHOLD).toBe(2);
    });

    it('SSO threshold is TWO_LAYER_THRESHOLD (2)', () => {
        // hub + sso = 2 = TWO_LAYER_THRESHOLD → covered
        const p = protectionFrom(result({ enrolled: ['hub', 'sso'], generation: 1, available: 2 }));
        expect(p.state).toBe('covered');
    });

    it('friend threshold is TWO_LAYER_THRESHOLD + 1 (3)', () => {
        // hub + 2 friends = 3 = TWO_LAYER_THRESHOLD + 1 → covered
        const p = protectionFrom(result({ enrolled: ['hub', 'member', 'member'], generation: 1, available: 3 }));
        expect(p.state).toBe('covered');
    });

    it('hub + 1 friend is NOT covered (below friend threshold)', () => {
        const p = protectionFrom(result({ enrolled: ['hub', 'member'], generation: 1, available: 2 }));
        expect(p.state).not.toBe('covered');
    });
});
