import React, { useState } from 'react';
import { useFocusEffect } from 'expo-router';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { getCachedNodeProfile, fetchNodeProfile, nodeProfileIsFresh, type NodeProfile } from './node-profile';
import { UNKNOWN_NODE_PROFILE, anchorRead, profileArrived, type AnchoredNodeProfile } from './node-profile-anchor';

/**
 * What kind of community the phone is on (utils/node-profile.ts): the phone's copy, read each time the screen
 * comes into view, and the node's own answer only when that copy is missing or stale (`nodeProfileIsFresh`). Null
 * until either is known, which every reader treats as a local community (Beans on, as every node before profiles).
 * Only ever the profile of the community the phone is on now: after a switch it is null until the new one's is
 * known, and an answer from the one before is dropped (node-profile-anchor.ts).
 */
export function useNodeProfile(): NodeProfile | null {
    return useNodeProfileState().profile;
}

/**
 * useNodeProfile, and whether this phone's own copy has been read yet for the community it is on (`copyRead`). Before
 * then the profile is null only because the read hasn't finished, a moment with no network: a screen that would ask
 * the node for a feature's data waits it out, so a feature in preview never asks (the showcase's Ledger). After it the
 * profile is what the phone knows, null included. Storage that can't be read counts as read: nothing more will be known.
 */
export function useNodeProfileState(): { profile: NodeProfile | null; copyRead: boolean } {
    const [state, setState] = useState<AnchoredNodeProfile>(UNKNOWN_NODE_PROFILE);
    // The community whose copy was read: `undefined` before the first read finishes.
    const [copyReadFor, setCopyReadFor] = useState<string | null | undefined>(undefined);
    useFocusEffect(
        React.useCallback(() => {
            let cancelled = false;
            (async () => {
                // Storage that can't be read says nothing about which community this is: keep what the screen has.
                const url = await AsyncStorage.getItem('beanpool_anchor_url').catch(() => undefined);
                if (cancelled) return;
                if (url === undefined) { setCopyReadFor(r => (r === undefined ? null : r)); return; }
                setState(s => anchorRead(s, url));
                if (!url) { setCopyReadFor(url); return; }
                const cached = await getCachedNodeProfile(url);
                if (!cancelled) { setState(s => profileArrived(s, url, cached)); setCopyReadFor(url); }
                if (nodeProfileIsFresh(cached)) return;
                const fresh = await fetchNodeProfile(url);
                if (!cancelled) setState(s => profileArrived(s, url, fresh));
            })();
            return () => { cancelled = true; };
        }, []),
    );
    return { profile: state.profile, copyRead: copyReadFor !== undefined && copyReadFor === state.url };
}
