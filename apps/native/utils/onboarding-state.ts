import AsyncStorage from '@react-native-async-storage/async-storage';

/**
 * Mid-wizard onboarding state.
 *
 * The keypair is created (and saved to SecureStore) at Step 1 of the join
 * wizard, but the member only exists on the node after the invite is redeemed
 * at the final step. If the app dies in between, the next launch loads a valid
 * identity that no node recognises — without this record the root gatekeeper
 * would treat that as a wrong-node problem and strand a brand-new user on the
 * node-mismatch screen. While a record exists, the gatekeeper routes back into
 * the wizard instead, and the welcome screen restores the saved step.
 */
export type OnboardingStep = 'create' | 'profileSetup' | 'seedBackup' | 'onboardingGuide';

export interface PendingOnboarding {
    step: OnboardingStep;
    inviteCode: string;
    anchorUrl: string;
    callsign: string;
    avatar?: string | null;
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
