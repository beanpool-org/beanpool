import React, { useState } from 'react';
import { useFocusEffect } from 'expo-router';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { getCachedNodeProfile, fetchNodeProfile, type NodeProfile } from './node-profile';

/**
 * What kind of community the phone is on (utils/node-profile.ts): the phone's copy at once, then the node's own
 * answer, asked each time the screen comes into view. Null until either is known, which every reader treats as a
 * local community (Beans on, as every node before the profile).
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
                const fresh = await fetchNodeProfile(url);
                if (!cancelled && fresh) setProfile(fresh);
            })();
            return () => { cancelled = true; };
        }, []),
    );
    return profile;
}
