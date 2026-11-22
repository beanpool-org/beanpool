/**
 * The app's one "Your groups" list (utils/your-groups-store), for Talk → Groups and Commons → Groups.
 * Screens call `refresh()` when they want fresher data; overlapping asks share one request.
 */

import { useEffect, useSyncExternalStore } from 'react';
import { fetchYourGroups } from '../utils/db';
import { createYourGroupsStore, TALK_GROUPS } from '../utils/your-groups-store';

// Read at each ask, not when this file loads: a screen that only reads the list (EventDetail's chat count) imports it too.
export const yourGroupsStore = createYourGroupsStore(() => fetchYourGroups(), undefined, TALK_GROUPS);

let ownerKey: string | null = null;

export function useYourGroups(myPubkey?: string | null) {
    // A different identity on this phone must never see the last one's list, not even for a frame.
    if (myPubkey && ownerKey !== myPubkey) {
        if (ownerKey !== null) yourGroupsStore.reset();
        ownerKey = myPubkey;
    }
    const state = useSyncExternalStore(yourGroupsStore.subscribe, yourGroupsStore.getState);
    useEffect(() => {
        if (myPubkey) yourGroupsStore.refresh();
    }, [myPubkey]);
    return { ...state, refresh: yourGroupsStore.refresh, movedAt: yourGroupsStore.movedAt };
}
