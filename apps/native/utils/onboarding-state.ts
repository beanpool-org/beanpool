import AsyncStorage from '@react-native-async-storage/async-storage';
import type { BeanPoolIdentity } from './identity';
import type { KeeperEnrolmentResult } from './keeper-enrolment';

/**
 * Mid-wizard onboarding state.
 *
 * The keypair is created (and saved to SecureStore) at Step 1 of the join wizard, and the
 * invite is redeemed there too — so the member exists on the node from Step 1 onwards,
 * before the avatar, the words or the guide. If the app dies mid-wizard, the next launch
 * loads a valid identity whose wizard is unfinished; without this record the root
 * gatekeeper would read that as a wrong-node problem and strand a brand-new user on the
 * node-mismatch screen. While a record exists the gatekeeper routes back into the wizard
 * and the welcome screen restores the saved step.
 *
 * (This used to say the member was only created at the final step. That stopped being true
 * when redemption moved to Step 1, and the stale comment is most of why a redundant second
 * redeem survived at the end of the wizard for so long — see `redeemed` below.)
 */
export type OnboardingStep = 'create' | 'globalJoin' | 'profileSetup' | 'seedBackup' | 'onboardingGuide';

/**
 * Which door the wizard came in by. Absent is `invite`: every record written before the global
 * community existed.
 *
 * - `invite`: an invite to a community (step `create`).
 * - `global`: the global community's open door (step `globalJoin`, utils/global-join.ts). Its
 *   `inviteCode` is '' and its `anchorUrl` is the global community.
 */
export type OnboardingFlow = 'invite' | 'global';

export interface PendingOnboarding {
    step: OnboardingStep;
    inviteCode: string;
    anchorUrl: string;
    callsign: string;
    avatar?: string | null;
    flow?: OnboardingFlow;
    /**
     * Global flow only: the public key this join made, which no community has accepted yet. Survives a
     * restart so a door that then refuses for good can take that key off the phone again (identity.ts
     * `discardUnjoinedIdentity`). A key, not a flag: only that exact key is ever taken, never one the
     * phone already had or holds instead.
     */
    freshKey?: string;
    /**
     * Global flow only: what the join's sign-in left protecting the account (the recovery copy the join
     * carried), so Safety Backup shows it after a restart too. Provider names and counts, nothing secret.
     */
    joinEnrolment?: KeeperEnrolmentResult | null;
    /**
     * Global flow only, at the door: the record this phone had before it (an invite join part-way through,
     * with the key the global join now uses), given back if the door refuses for good (global-join.ts
     * `releaseJoinKey`).
     */
    before?: PendingOnboarding | null;
    /**
     * Whether the invite has been redeemed on the node for this identity.
     *
     * Persisted rather than kept in memory because it has to survive the app being killed
     * mid-wizard, which is the one case where the final step genuinely cannot assume the
     * member already exists.
     *
     * Optional, and absent means "not known to be redeemed" — so a record written by the
     * previous build simply gets the old behaviour of attempting again, which the server
     * answers with `alreadyMember`. Erring that way round is deliberate: a redundant
     * redeem is a wasted round trip, while a skipped one would leave somebody mid-wizard
     * unregistered on the node with no second chance.
     */
    redeemed?: boolean;
}

const KEY = 'beanpool_pending_onboarding';
const listeners = new Set<() => void>();

export async function getPendingOnboarding(): Promise<PendingOnboarding | null> {
    try {
        const raw = await AsyncStorage.getItem(KEY);
        if (!raw) return null;
        return JSON.parse(raw);
    } catch {
        return null;
    }
}

export async function setPendingOnboarding(state: PendingOnboarding): Promise<void> {
    try {
        await AsyncStorage.setItem(KEY, JSON.stringify(state));
    } catch (e) {
        console.warn('[Onboarding] Failed to persist wizard state', e);
    }
    notify();
}

/** Merge a patch into the existing record; no-op when no wizard is pending. */
export async function updatePendingOnboarding(patch: Partial<PendingOnboarding>): Promise<void> {
    const current = await getPendingOnboarding();
    if (!current) return;
    await setPendingOnboarding({ ...current, ...patch });
}

export async function clearPendingOnboarding(): Promise<void> {
    try {
        await AsyncStorage.removeItem(KEY);
    } catch {}
    notify();
}

/** What the welcome screen does with a record it finds on arrival. */
export type ResumePlan =
    /** Nothing to resume, or a fresh invite outranks the record: leave the record alone. */
    | { action: 'none' }
    /** The keypair never made it to storage: nothing to resume, drop the record. */
    | { action: 'clear' }
    | {
        action: 'resume';
        mode: OnboardingStep;
        flow: OnboardingFlow;
        callsign: string;
        inviteCode: string;
        redeemed: boolean;
        anchorUrl: string;
        avatar: string | null;
        /** The stored key the wizard carries on with. Null only for an invite join still at `create`. */
        identity: BeanPoolIdentity | null;
        /** Global flow: the stored key was made by that join and no community has accepted it (see `freshKey`). */
        freshKey: boolean;
        joinEnrolment: KeeperEnrolmentResult | null;
    };

/**
 * Decide the welcome screen's resume, apart from the screen so it can be tested.
 *
 * `incomingInvite` is any invite that arrived with the screen (a param or a link); `paramsInvite` is the
 * param alone. A fresh invite outranks a half-done wizard unless it is that wizard's own invite, so a
 * global record (no invite of its own) always gives way to one.
 */
export function resumePlan(
    pending: PendingOnboarding | null,
    stored: BeanPoolIdentity | null,
    arrival: { incomingInvite?: string | null; paramsInvite?: string | null } = {},
): ResumePlan {
    if (!pending) return { action: 'none' };
    if (arrival.incomingInvite && pending.inviteCode !== arrival.paramsInvite) return { action: 'none' };
    if (!stored) return { action: 'clear' };
    const flow: OnboardingFlow = pending.flow === 'global' ? 'global' : 'invite';
    return {
        action: 'resume',
        mode: pending.step,
        flow,
        callsign: pending.callsign || stored.callsign,
        inviteCode: pending.inviteCode || '',
        redeemed: pending.redeemed === true,
        anchorUrl: pending.anchorUrl || '',
        avatar: pending.avatar ?? null,
        // An invite join at `create` has not committed to the key yet (handleCreate reuses it on Next);
        // every later step, and the global door, carries on with the stored one.
        identity: pending.step === 'create' ? null : stored,
        freshKey: flow === 'global' && typeof pending.freshKey === 'string' && pending.freshKey === stored.publicKey,
        joinEnrolment: flow === 'global' ? pending.joinEnrolment ?? null : null,
    };
}

/** Subscribe to changes made through this module (used by the root gatekeeper). */
export function subscribePendingOnboarding(fn: () => void): () => void {
    listeners.add(fn);
    return () => { listeners.delete(fn); };
}

function notify() {
    listeners.forEach(fn => {
        try { fn(); } catch {}
    });
}
