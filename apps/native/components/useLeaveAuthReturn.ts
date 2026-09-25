/**
 * Moves a sign-in return screen (app/auth/google.tsx, app/auth/facebook.tsx) out of the way 300 ms after it opens,
 * or after its link changes: back to the screen waiting for the sign-in, or, when there is nothing to go back to,
 * to where the root guard would have sent it (utils/auth-return.ts). While the member is still setting up the root
 * guard leaves an `auth` root alone, so then this is the only thing that moves it.
 */

import { useEffect, useRef } from 'react';
import { useRouter } from 'expo-router';
import { useIdentity } from '../app/IdentityContext';
import { getPendingOnboarding } from '../utils/onboarding-state';
import { authReturnDestination } from '../utils/auth-return';

export function useLeaveAuthReturn(url: string | null) {
    const router = useRouter();
    const { identity } = useIdentity();
    // Read when the timer fires rather than when it is set.
    const hasIdentity = useRef(!!identity);
    hasIdentity.current = !!identity;

    useEffect(() => {
        let cancelled = false;
        const timer = setTimeout(async () => {
            const canGoBack = router.canGoBack();
            // Only a cold start needs to know whether a join wizard is waiting to be resumed.
            const pendingOnboarding = !canGoBack && hasIdentity.current && !!(await getPendingOnboarding());
            if (cancelled) return;
            const to = authReturnDestination({ canGoBack, hasIdentity: hasIdentity.current, pendingOnboarding });
            if (to === 'back') {
                router.back();
            } else {
                router.replace(to);
            }
        }, 300);
        return () => {
            cancelled = true;
            clearTimeout(timer);
        };
    }, [router, url]);
}
