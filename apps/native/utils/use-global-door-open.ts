import { useCallback, useState } from 'react';
import { useFocusEffect } from 'expo-router';
import { askGlobalDoorOffer, globalDoorOffered } from './global-door-offer';

/**
 * Whether the global community has said, this app start, that its door is open: the welcome screen's check for
 * "Explore BeanPool worldwide" (utils/global-door-offer.ts), for the screens that offer the door to an account the
 * phone already has (utils/global-join-existing.ts). Drawn from what is already known and asked after drawing, each
 * time the screen comes into view: free once there is an answer (it is kept for the session), a new ask after a
 * failure. Never holds up a render, and a failure only leaves the offer out. Once true it stays; the door asks again.
 */
export function useGlobalDoorOpen(enabled = true): boolean {
    const [open, setOpen] = useState(globalDoorOffered);
    useFocusEffect(useCallback(() => {
        if (!enabled) return;
        let cancelled = false;
        askGlobalDoorOffer().then(o => { if (!cancelled && o) setOpen(true); }).catch(() => {});
        return () => { cancelled = true; };
    }, [enabled]));
    return open;
}
