import React, { useEffect, useRef, useState } from 'react';
import { DeviceEventEmitter } from 'react-native';
import { useFocusEffect } from 'expo-router';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useIdentity } from '../app/IdentityContext';
import { getMemberProfile } from './db';
import { onCommunitySwitched } from './community-switch';
import { UNKNOWN_OWN_PROFILE, ownCommunityRead, ownRowArrived, ownRowOf, type OwnProfile } from './own-profile-anchor';

export type { OwnProfile } from './own-profile-anchor';

/**
 * The member's own name and picture in the community the phone is on now: that community's own members row, in its copy
 * on this phone, and nothing phone-wide (scratch/fable-design/DESIGN-per-community-profile-fable.md §3, slice S1). The
 * header, My Profile, Settings and the Ledger read it, so switching community switches them all together.
 *
 * Read when the screen comes into view, after every switch (utils/community-switch.ts), and on `profile_updated` (a Save
 * here, or a sync that changed the own row: utils/db.ts). Each answer names the community it was read for, and one for
 * any other is dropped (own-profile-anchor.ts): after a switch every field is null, which draws the ready-made picture
 * the key picks, until the new community's row is read. Only the latest read lands: one that started earlier and answers
 * later never puts an older row back.
 */
export function useOwnProfile(): OwnProfile {
    const { identity } = useIdentity();
    const publicKey = identity?.publicKey ?? null;
    const [state, setState] = useState<OwnProfile>(UNKNOWN_OWN_PROFILE);
    const asked = useRef(0);

    const load = React.useCallback(async () => {
        const n = ++asked.current;
        if (!publicKey) { setState(UNKNOWN_OWN_PROFILE); return; }
        // Storage that can't be read says nothing about which community this is: what the screen has stays.
        const url = await AsyncStorage.getItem('beanpool_anchor_url').catch(() => undefined);
        if (url === undefined || n !== asked.current) return;
        setState(s => ownCommunityRead(s, url));
        if (!url) return;
        let row: unknown;
        try {
            row = await getMemberProfile(publicKey);
        } catch {
            // The copy closed under the read (a switch): the read the switch starts answers instead.
            return;
        }
        // getDb opens the copy the anchor names as it is asked: read for this community only if it is still the phone's.
        const after = await AsyncStorage.getItem('beanpool_anchor_url').catch(() => undefined);
        if (after !== url || n !== asked.current) return;
        setState(s => ownRowArrived(s, url, ownRowOf(row as any)));
    }, [publicKey]);

    useFocusEffect(React.useCallback(() => { void load(); }, [load]));

    useEffect(() => {
        const stopSwitch = onCommunitySwitched(() => { void load(); });
        const sub = DeviceEventEmitter.addListener('profile_updated', (e?: { pubkey?: string }) => {
            if (!e?.pubkey || e.pubkey === publicKey) void load();
        });
        return () => {
            stopSwitch();
            sub.remove();
        };
    }, [load, publicKey]);

    return state;
}
