import AsyncStorage from '@react-native-async-storage/async-storage';

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
export type OnboardingStep = 'create' | 'profileSetup' | 'seedBackup' | 'onboardingGuide';

export interface PendingOnboarding {
    step: OnboardingStep;
    inviteCode: string;
    anchorUrl: string;
    callsign: string;
    avatar?: string | null;
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
