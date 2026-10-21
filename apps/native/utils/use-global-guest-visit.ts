import { useCallback, useRef, useState } from 'react';
import { Alert } from 'react-native';
import { router } from 'expo-router';
import { t } from '@beanpool/core';
import { useIdentity } from '../app/IdentityContext';
import { GLOBAL_NODE_URL } from './global-node-url';
import { visitGlobalAsGuest, type GuestVisit } from './global-guest-visit';

/** The global community's door (utils/open-door.ts GLOBAL_DOOR_PATH), named as every screen that opens it names it. */
const GLOBAL_DOOR = '/join-global';

/**
 * Open the global community as a guest, for a screen (utils/global-guest-visit.ts): the BeanPool sheet's global row,
 * Settings → Saved communities, the Market's members-only page. Guest view first, as on the web; the header's Join pill
 * then leads to the door.
 *
 * Where the phone moved (a guest, or a member it didn't know of), the app goes where every switch goes
 * (use-communities.ts): back to the bottom of the stack, then through Welcome for the community now in use, which lands on
 * the tabs. Where nothing moved: the door screen for a door that can't be used from here right now (its page says why,
 * with Try again; app/join-open-door.tsx), and for a key the global community closed, that sentence, as the sheet's row
 * says it.
 *
 * `visiting` is true while it asks: the screen's button waits rather than start a second visit. A tap never does nothing:
 * with no key to sign with yet, it opens the door, as before.
 */
export function useGlobalGuestVisit(): { visit: (url?: string) => Promise<GuestVisit | null>; visiting: boolean } {
    const { identity } = useIdentity();
    const [visiting, setVisiting] = useState(false);
    const busy = useRef(false);
    const visit = useCallback(async (url: string = GLOBAL_NODE_URL): Promise<GuestVisit | null> => {
        if (busy.current) return null;
        // No key to sign the probe with here (the phone's keys not unlocked yet): the door, which says what it needs.
        if (!identity?.privateKey) {
            router.push(GLOBAL_DOOR);
            return { kind: 'door' };
        }
        busy.current = true;
        setVisiting(true);
        try {
            const answer = await visitGlobalAsGuest({ publicKey: identity.publicKey, privateKey: identity.privateKey }, url);
            if (answer.kind === 'member' || answer.kind === 'guest') {
                import('../services/pillar-sync').then(({ requestSync }) => requestSync()).catch(() => {});
                if (router.canDismiss()) router.dismissAll();
                router.replace('/welcome');
            } else if (answer.kind === 'closed') {
                Alert.alert(t('Global community'), t('Your account there was closed.'));
            } else {
                router.push(GLOBAL_DOOR);
            }
            return answer;
        } catch (e: any) {
            Alert.alert(t("Couldn't switch community"), e?.message || t('Please try again.'));
            return null;
        } finally {
            busy.current = false;
            setVisiting(false);
        }
    }, [identity?.publicKey, identity?.privateKey]);
    return { visit, visiting };
}
