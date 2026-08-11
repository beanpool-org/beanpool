/**
 * Which of the protection states a member is actually in, and which tier they are on.
 *
 * The screen this feeds is the one place a member is told how they get back into their
 * account, so the rule it follows is narrow and worth stating: **it never claims a keeper the
 * member does not have.** Revision 3's first draft of that screen said "you're covered by
 * 3" unconditionally, which was false for every PWA user — told, precisely, to the people who
 * most needed the truth.
 *
 * Kept apart from the component because it is a decision, not a rendering. Inside a screen it
 * would only be checkable by running one, and the failure it guards against — a wrong state
 * shown to a frightened person — is not a visual bug.
 *
 * ## Two-layer model (docs/recovery-model.md)
 *
 * ```
 * seed  =  A  ⊕  B
 *   A  →  hub share. Plaintext on the node. Released under D7.
 *   B  →  members' half. SSO: sealed whole. Non-SSO: Shamir 2-of-N across friends.
 * ```
 *
 * The hub fragment A is XOR-mandatory and is NEVER counted in a threshold.
 *
 * - SSO tier: threshold = TWO_LAYER_THRESHOLD (= 2). Covered with hub + sso.
 * - Friend tier: threshold = TWO_LAYER_THRESHOLD + 1 (= 3). Covered with hub + 2 friends.
 * - Sovereign: no fragments. Words only.
 */

import { TWO_LAYER_THRESHOLD } from '@beanpool/core';
import type { KeeperEnrolmentResult } from './keeper-enrolment';

export type ProtectionState =
    /** Covered: the split happened and enough keepers hold a piece. */
    | 'covered'
    /** One keeper short. The pieces do not exist yet, and one more starts it off. */
    | 'almost'
    /** The twelve words are genuinely the way back, said plainly. */
    | 'words-only';

/** Which recovery tier this member is on. */
export type ProtectionTier =
    /** SSO: hub + sign-in account. Custodial by choice. */
    | 'sso'
    /** Friends: hub + Shamir 2-of-N across friends. Sovereign and recoverable. */
    | 'friends'
    /** Sovereign: 12 words only. No fragments on node. */
    | 'sovereign';

export interface Protection {
    state: ProtectionState;
    /** Which recovery tier this member is on. */
    tier: ProtectionTier;
    /** Keepers actually holding a piece. Empty in every state but \`covered\`. */
    holding: string[];
    /** How many more keepers are needed before a split can happen at all. */
    stillNeeded: number;
    /**
     * How many keepers this member could lose and still get back in.
     *
     * ZERO for sovereign members and for anyone at exactly the threshold. A member with
     * hub + 2 friends against threshold 3 is covered with zero slack.
     */
    spare: number;
    /** True when the twelve words should be shown expanded rather than offered behind a tap. */
    showWords: boolean;
}

/**
 * Human-readable keeper names, for a screen that must not say "K2" to anybody.
 *
 * \`device\` was retired with the two-layer model (docs/recovery-model.md). The hub is always
 * present in any split but is XOR-mandatory, not a counted keeper — it shows up as "Your
 * community hub" only when a split exists.
 */
export const KEEPER_LABELS: Record<string, string> = {
    hub: 'Your community hub',
    member: 'A trusted friend',
    sso: 'Your sign-in account',
};

/**
 * Derive the threshold from what was enrolled.
 *
 * The hub is XOR-mandatory and NEVER counted. "Threshold 2" means TWO friends (plus the hub
 * which is separate), not "hub + 1 friend". SSO tier needs only hub + sso = 2 total.
 *
 * Uses TWO_LAYER_THRESHOLD from @beanpool/core — never a hardcoded number.
 */
function thresholdFor(enrolled: readonly string[]): number {
    if (enrolled.includes('sso')) return TWO_LAYER_THRESHOLD;
    return TWO_LAYER_THRESHOLD + 1;
}

/** Derive the tier from what was enrolled. */
function tierFrom(enrolled: readonly string[]): ProtectionTier {
    if (enrolled.length === 0) return 'sovereign';
    if (enrolled.includes('sso')) return 'sso';
    return 'friends';
}

/**
 * Read an enrolment result as a screen state.
 *
 * \`null\` means enrolment has not finished. Treated as \`words-only\` rather than as a spinner
 * state on purpose: if the result never arrives — a dead node, a request that hangs — the screen
 * still has to say something true, and "here are your words" is true in every case. A member
 * must never sit in front of a screen that is waiting to find out whether they are safe.
 */
export function protectionFrom(result: KeeperEnrolmentResult | null): Protection {
    if (!result || result.enrolled.length === 0) {
        const available = result?.available ?? 0;
        // Under the two-layer model, a member with no enrolled keepers is sovereign.
        // "almost" only applies if they have available keepers and are one short of the
        // minimum tier threshold (friend tier: 3, so available >= 2).
        const threshold = TWO_LAYER_THRESHOLD; // SSO tier is the lowest bar
        const stillNeeded = Math.max(0, threshold - available);

        if (available > 0 && stillNeeded === 1) {
            return { state: 'almost', tier: 'sovereign', holding: [], stillNeeded, spare: 0, showWords: true };
        }
        return { state: 'words-only', tier: 'sovereign', holding: [], stillNeeded, spare: 0, showWords: true };
    }

    const threshold = thresholdFor(result.enrolled);
    const tier = tierFrom(result.enrolled);

    if (result.enrolled.length < threshold) {
        // Should be unreachable — enrolment writes nothing below the threshold — but a partial
        // enrolment reported as "covered" is the exact failure this model exists to prevent, so
        // it degrades to the honest state rather than trusting an invariant held elsewhere.
        const stillNeeded = threshold - result.enrolled.length;
        if (stillNeeded === 1) {
            return {
                state: 'almost',
                tier,
                holding: result.enrolled.map(k => KEEPER_LABELS[k] ?? k),
                stillNeeded,
                spare: 0,
                showWords: true,
            };
        }
        return {
            state: 'words-only',
            tier,
            holding: result.enrolled.map(k => KEEPER_LABELS[k] ?? k),
            stillNeeded,
            spare: 0,
            showWords: true,
        };
    }

    const spare = result.enrolled.length - threshold;
    return {
        state: 'covered',
        tier,
        holding: result.enrolled.map(k => KEEPER_LABELS[k] ?? k),
        stillNeeded: 0,
        spare,
        /*
         * SSO-covered members: tuck words behind a tap and offer the add-a-friend upgrade
         * instead. An SSO member who adds one friend becomes sovereign AND recoverable
         * (2 friends + hub, no Apple needed).
         *
         * Friend-covered with no spare: show words (same reasoning as before — when a member
         * can actually add a fourth keeper, flip this to offering that instead).
         *
         * Friend-covered with spare: tuck words behind a tap.
         */
        showWords: tier === 'sso' ? false : spare === 0,
    };
}
