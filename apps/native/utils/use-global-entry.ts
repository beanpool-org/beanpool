import { useCallback, useEffect, useRef, useState } from 'react';
import { useFocusEffect } from 'expo-router';
import { useIdentity } from '../app/IdentityContext';
import { useGlobalDoor } from './use-global-door-open';
import { accountClosedAtGlobal } from './global-join-existing';
import {
    askGlobalStanding, globalEntryState, readGlobalStanding, GLOBAL_STANDING_TTL_MS,
    type GlobalDoorState, type GlobalEntryState, type GlobalStanding,
} from './global-entry';

/** What a screen read or was told about a key: the kept answer and the closed mark, or the probe's answer since. */
interface Known { key: string; standing: GlobalStanding; closedHere: boolean }

/**
 * What this app start last settled on for each key, on any screen (Settings, People, the sheet, the not-recognised
 * screen): the next screen's first draw, before its own read of the phone's store answers. Under a day old, as a kept
 * answer is.
 */
const settled = new Map<string, Known & { at: number }>();
function settledFor(publicKey: string | null): Known | null {
    const s = publicKey ? settled.get(publicKey) : undefined;
    return s && Date.now() - s.at < GLOBAL_STANDING_TTL_MS ? s : null;
}

/** Forget what this app start settled on, as a new app start would. For tests. */
export function forgetSettledGlobalEntry(): void {
    settled.clear();
}

/**
 * The global community's state for the account on this phone (utils/global-entry.ts), for a screen: Settings → Advanced,
 * People's guest banner, the BeanPool sheet, the not-recognised screen.
 *
 * Drawn at once from what this app start last settled on for this key, else `checking` until the phone's kept answer
 * (the last answer about this key, under a day old) and closed mark are read, and, where the probe is sent, until it has
 * settled once: a first draw never reads a state the phone hasn't, a stranger's door on a member's row least of all. Then
 * asked each time the screen comes into view: the door first (use-global-door-open.ts, free once answered; no answer
 * reads `unreachable`, a shut door `closed`, a preview `preview`), and, once the door is open, the key's standing (the
 * membership probe, signed by the key). The probe goes to the global community only then: a phone whose global door is
 * shut or unreachable never tells it which screen it opened.
 *
 * The last definite answer wins: one from the probe this time replaces what was kept, a kept `account_closed` included
 * (a vote can bring a removed member back), and a kept answer read after it never overrides it.
 *
 * `door` overrides the door's answer where a screen has asked it itself: the not-recognised screen's fresh checkGlobalDoor,
 * and the BeanPool sheet, which draws the door's own answer (its 12-words way, Try again) beside the state.
 *
 * `saved`: the screen already sends the global community the probe whatever its door says (the BeanPool sheet asks every
 * saved community, use-communities.ts), so asking here too tells it nothing new, and a member's own row says member with
 * the door shut or in a preview, not the strangers' words. It decides only whether to ask, never the answer.
 */
export function useGlobalEntry(enabled: boolean, door?: GlobalDoorState, saved = false): GlobalEntryState {
    const { identity } = useIdentity();
    const publicKey = identity?.publicKey ?? null;
    const on = enabled && !!identity;
    const session = useGlobalDoor(on && door === undefined);
    const doorState: GlobalDoorState = door ?? session.state;
    const ask = doorState === 'open' || saved;
    const probes = on && ask && !!identity?.privateKey;
    const [known, setKnown] = useState<Known | null>(null);
    const [asking, setAsking] = useState(false);
    // The key whose probe has settled at least once on this screen: until then a probe that will be sent counts as out.
    const [probedFor, setProbedFor] = useState<string | null>(null);
    // The probe answered this key this time: what was kept is older and no longer drawn.
    const answeredRef = useRef(false);
    // Whatever this screen settles on is the next screen's first draw.
    useEffect(() => { if (known) settled.set(known.key, { ...known, at: Date.now() }); }, [known]);

    // What the phone kept for this key, no network.
    useEffect(() => {
        let cancelled = false;
        answeredRef.current = false;
        if (!publicKey) return;
        Promise.all([readGlobalStanding(publicKey), accountClosedAtGlobal(publicKey).catch(() => false)])
            .then(([standing, closedHere]) => { if (!cancelled && !answeredRef.current) setKnown({ key: publicKey, standing, closedHere }); })
            .catch(() => {});
        return () => { cancelled = true; };
    }, [publicKey]);

    // Asked each time the screen comes into view, once the door is open (or at once, for a saved row).
    useFocusEffect(useCallback(() => {
        if (!probes || !identity?.privateKey) return;
        const key = identity.publicKey;
        let cancelled = false;
        setAsking(true);
        askGlobalStanding({ publicKey: key, privateKey: identity.privateKey })
            .then(r => {
                if (cancelled) return;
                if (r.answered) {
                    answeredRef.current = true;
                    setKnown({ key, standing: r.standing, closedHere: r.closed });
                } else {
                    // No answer: `standing` is the kept one, which the read above draws too (or already drew).
                    setKnown(k => (k && k.key === key ? { ...k, standing: r.standing } : k));
                }
            })
            .catch(() => {})
            .finally(() => { if (!cancelled) { setAsking(false); setProbedFor(key); } });
        return () => { cancelled = true; setAsking(false); };
    }, [probes, identity?.publicKey, identity?.privateKey]));

    // This screen's own view once it has one; until then what this app start settled on, else nothing (Checking…).
    const mine = known && known.key === publicKey ? known : null;
    const view = mine ?? settledFor(publicKey);
    const waiting = asking || !mine || (probes && probedFor !== publicKey);
    return globalEntryState({
        account: !!identity, standing: view?.standing ?? 'unknown', door: doorState, closedHere: view?.closedHere ?? false, saved,
        asking: waiting,
    });
}
