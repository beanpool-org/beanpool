import { useCallback, useEffect, useRef, useState } from 'react';
import { useFocusEffect } from 'expo-router';
import { useIdentity } from '../app/IdentityContext';
import { useGlobalDoor } from './use-global-door-open';
import { accountClosedAtGlobal } from './global-join-existing';
import {
    askGlobalStanding, globalEntryState, readGlobalStanding, type GlobalDoorState, type GlobalEntryState, type GlobalStanding,
} from './global-entry';

/**
 * The global community's state for the account on this phone (utils/global-entry.ts), for a screen: Settings → Advanced,
 * People's guest banner, the BeanPool sheet, the not-recognised screen.
 *
 * Drawn at once from what the phone kept (the last answer about this key, under a day old; the door's answer this app
 * start), then asked each time the screen comes into view: the door first (use-global-door-open.ts, free once answered;
 * no answer reads `unreachable`, a shut door `closed`, a preview `preview`), and, once the door is open, the key's standing
 * (the membership probe, signed by the key). The probe goes to the global community only then: a phone whose global door
 * is shut or unreachable never tells it which screen it opened.
 *
 * The last definite answer wins: one from the probe this time replaces what was kept, a kept `account_closed` included
 * (a vote can bring a removed member back), and a kept answer read after it never overrides it.
 *
 * `door` overrides the door's answer where a screen has asked it itself: the not-recognised screen's fresh checkGlobalDoor,
 * and the BeanPool sheet, which draws the door's own answer (its 12-words way, Try again) beside the state.
 */
export function useGlobalEntry(enabled: boolean, door?: GlobalDoorState): GlobalEntryState {
    const { identity } = useIdentity();
    const publicKey = identity?.publicKey ?? null;
    const on = enabled && !!identity;
    const session = useGlobalDoor(on && door === undefined);
    const doorState: GlobalDoorState = door ?? session.state;
    const [standing, setStanding] = useState<GlobalStanding>('unknown');
    const [closedHere, setClosedHere] = useState(false);
    const [asking, setAsking] = useState(false);
    // The probe answered this key this time: what was kept is older and no longer drawn.
    const answeredRef = useRef(false);

    // What the phone kept for this key, no network.
    useEffect(() => {
        let cancelled = false;
        answeredRef.current = false;
        setStanding('unknown');
        setClosedHere(false);
        if (!publicKey) return;
        readGlobalStanding(publicKey).then(s => { if (!cancelled && !answeredRef.current) setStanding(s); }).catch(() => {});
        accountClosedAtGlobal(publicKey).then(c => { if (!cancelled && c && !answeredRef.current) setClosedHere(true); }).catch(() => {});
        return () => { cancelled = true; };
    }, [publicKey]);

    // Asked each time the screen comes into view, once the door is open.
    useFocusEffect(useCallback(() => {
        if (!on || doorState !== 'open' || !identity?.privateKey) return;
        let cancelled = false;
        setAsking(true);
        askGlobalStanding({ publicKey: identity.publicKey, privateKey: identity.privateKey })
            .then(r => {
                if (cancelled) return;
                setStanding(r.standing);
                if (r.answered) {
                    answeredRef.current = true;
                    setClosedHere(r.closed);
                }
            })
            .catch(() => {})
            .finally(() => { if (!cancelled) setAsking(false); });
        return () => { cancelled = true; setAsking(false); };
    }, [on, doorState, identity?.publicKey, identity?.privateKey]));

    return globalEntryState({ account: !!identity, standing, door: doorState, closedHere, saved: false, asking });
}
