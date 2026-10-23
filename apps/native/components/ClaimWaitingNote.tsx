import { useEffect, useState } from 'react';
import { Text } from 'react-native';
import { useWords } from './LanguageProvider';
import { getPendingClaim, subscribePendingOnboarding, type PendingClaim } from '../utils/onboarding-state';

/**
 * The first screen's line for a claim waiting for this phone's account (app/claim-community.tsx "Make my account",
 * utils/onboarding-state.ts PendingClaim): make the account here, and BeanPool goes back to the claim once it is made.
 * It names the door that needs no invite (Dax, 23 Oct 2026: he found where to make his account only after a quarter of an
 * hour). Right under the doors, not above them: nothing comes between the title and the doors, which stay above the fold
 * at 320 dp and 1.3× (utils/__tests__/welcome-doors-render.test.ts). Nothing while no claim waits.
 */
export function ClaimWaitingNote({ style }: { style: object }) {
    const { t } = useWords();
    const [claim, setClaim] = useState<PendingClaim | null>(null);
    useEffect(() => {
        let alive = true;
        const read = () => { getPendingClaim().then(c => { if (alive) setClaim(c); }); };
        read();
        const off = subscribePendingOnboarding(read);
        return () => { alive = false; off(); };
    }, []);
    if (!claim) return null;
    // The server as the operator typed or scanned it, without its scheme: `cairns.beanpool.org`, `192.168.1.20:8080`.
    const address = claim.node ? claim.node.replace(/^https?:\/\//i, '') : null;
    return (
        <Text style={style} accessibilityLiveRegion="polite" testID="claim-waiting-note">
            {address
                ? t('Make your account first, then BeanPool takes you back to claim {address}. No invite? Tap Explore BeanPool worldwide.', { address })
                : t('Make your account first, then BeanPool takes you back to your claim. No invite? Tap Explore BeanPool worldwide.')}
        </Text>
    );
}
