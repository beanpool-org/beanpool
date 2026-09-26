import React, { useState } from 'react';
import { useFocusEffect } from 'expo-router';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { getCachedNodeProfile, fetchNodeProfile, nodeProfileIsFresh, type NodeProfile } from './node-profile';

/**
 * What kind of community the phone is on (utils/node-profile.ts): the phone's copy, read each time the screen
 * comes into view, and the node's own answer only when that copy is missing or stale (`nodeProfileIsFresh`). Null
 * until either is known, which every reader treats as a local community (Beans on, as every node before profiles).
 */
export function useNodeProfile(): NodeProfile | null {
    const [profile, setProfile] = useState<NodeProfile | null>(null);
    useFocusEffect(
        React.useCallback(() => {
            let cancelled = false;
            (async () => {
                const url = await AsyncStorage.getItem('beanpool_anchor_url').catch(() => null);
                if (!url) return;
                const cached = await getCachedNodeProfile(url);
                if (!cancelled && cached) setProfile(cached);
                if (nodeProfileIsFresh(cached)) return;
                const fresh = await fetchNodeProfile(url);
                if (!cancelled && fresh) setProfile(fresh);
            })();
            return () => { cancelled = true; };
        }, []),
    );
    return profile;
}
