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
    const [state, setState] = useState<AnchoredNodeProfile>(UNKNOWN_NODE_PROFILE);
    useFocusEffect(
        React.useCallback(() => {
            let cancelled = false;
            (async () => {
                // Storage that can't be read says nothing about which community this is: keep what the screen has.
                const url = await AsyncStorage.getItem('beanpool_anchor_url').catch(() => undefined);
                if (url === undefined || cancelled) return;
                setState(s => anchorRead(s, url));
                if (!url) return;
                const cached = await getCachedNodeProfile(url);
                if (!cancelled) setState(s => profileArrived(s, url, cached));
                if (nodeProfileIsFresh(cached)) return;
                const fresh = await fetchNodeProfile(url);
                if (!cancelled) setState(s => profileArrived(s, url, fresh));
            })();
            return () => { cancelled = true; };
        }, []),
    );
    return state.profile;
}
