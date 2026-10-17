import { useCallback, useRef, useState } from 'react';
import { useFocusEffect } from 'expo-router';
import { askGlobalDoorOffer, globalDoorOffer, type GlobalDoorOffer } from './global-door-offer';

/**
 * What the global community's door said, this app start (utils/global-door-offer.ts), for a screen that draws the door's
 * state: the BeanPool sheet's global row, and (through use-global-entry.ts) Settings → Advanced and People. Drawn from
 * what is already known and asked after drawing, each time the screen comes into view: free once there is an answer (it
 * is kept for the session), a new ask after no answer. Never holds up a render; no answer reads `unreachable`, never
 * nothing. `retry` asks again now (the row's "Tap to try again"), showing `unknown` until the answer.
 */
export function useGlobalDoor(enabled = true): GlobalDoorOffer & { retry(): void } {
    const [offer, setOffer] = useState<GlobalDoorOffer>(globalDoorOffer);
    // Each ask's answer is drawn only if no later ask has started (a retry while one is out).
    const latest = useRef(0);
    const ask = useCallback(() => {
        const mine = ++latest.current;
        askGlobalDoorOffer().then(o => { if (mine === latest.current) setOffer(o); }).catch(() => {});
    }, []);
    useFocusEffect(useCallback(() => {
        if (!enabled) return;
        ask();
        return () => { latest.current++; };
    }, [enabled, ask]));
    const retry = useCallback(() => {
        setOffer(o => (o.state === 'unreachable' ? { state: 'unknown', wordsDoor: false } : o));
        ask();
    }, [ask]);
    return { ...offer, retry };
}
