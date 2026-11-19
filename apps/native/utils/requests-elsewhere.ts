/**
 * Message requests waiting in the phone's other communities, for Chat's one Message requests row and its "In {community}"
 * cards (Marty, 19 Nov 2026, "yes to all 5", decision 4 of scratch/fable-design/DESIGN-no-switch-messaging-fable.md, slice
 * S0): the row's count covers every community the phone holds, still with no push, and a community whose "Alerts from this
 * community" is off stays out.
 *
 * - **Nothing new is asked.** Each other community's count is the `requests` its own answer to the phone's rounds already
 *   carries (other-communities-unread.ts, kept by notice-counts.ts `readNoticeRequests`). The rounds ask only communities the
 *   phone may send alerts from, so never one with its alerts off, a guest's look, or one that said the account isn't theirs.
 * - **The door count on global** (global-requests.ts `requestsWaitingOnGlobal`, for a phone that ticked a door) is one more
 *   such count, for global's address: the larger of the two where the rounds know global too, as both are global's own
 *   answer for this key at two moments. Any count it knows is taken, 0 included: its 0 is global's own "none waiting", so the
 *   row's mark follows that fall and the next request there lights the dot (PR #3301 review). Where it isn't known (no door
 *   ticked on this phone, no key, or no answer with nothing heard before) it is null, and nothing is taken. Left out where
 *   global's alerts are off, and where global is the community in use, whose own list has them.
 * - **No push, no badge, no unread count** (Marty, 1 Nov 2026, kept on 19 Nov): these counts are the row's alone.
 * - **A tap on a card** moves the phone there through the one switch and opens that community's Message requests
 *   (app/(tabs)/chats.tsx `openOtherCommunity`), as a tapped notice does. No community is named here but global's one
 *   default address.
 */
import { useCallback, useEffect, useState } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { t } from '@beanpool/core';
import { GLOBAL_NODE_URL } from './global-node-url';
import { communityName } from './community-name';
import { onNoticeCounts, readNoticeRequests } from './notice-counts';
import { communityAddress, sameCommunity } from './push-pins';
import { communitiesWithAlertsOff } from './push-alerts-off';
import { SAVED_NODES_STORE_KEY } from './storage-keys';

const ANCHOR_STORE_KEY = 'beanpool_anchor_url';

/** One other community with its requests count, as a card shows it. */
export interface RequestsPlace {
    /** The address the counts are kept by (push-pins.ts `communityAddress`): the key of the row's mark. */
    address: string;
    /** The address the phone saved it under, which the switch moves to. */
    url: string;
    name: string;
    count: number;
}

/** What the phone holds for it: the rounds' counts by address, its saved list, the community in use, and alerts off. */
export interface HeldRequestsRead {
    counts: Record<string, number>;
    saved: ReadonlyArray<{ url?: unknown; alias?: unknown; name?: unknown; nodeName?: unknown }>;
    anchor: string | null;
    off: readonly string[];
}

interface Storage {
    getItem(key: string): Promise<string | null>;
}

function savedRows(raw: string | null): HeldRequestsRead['saved'] {
    try {
        const saved = JSON.parse(raw ?? '[]');
        return Array.isArray(saved) ? saved.filter((n) => n && typeof n === 'object') : [];
    } catch {
        return [];
    }
}

/** Reads what {@link requestsElsewhere} needs. Never throws: what can't be read is none. */
export async function readHeldRequests(storage: Storage): Promise<HeldRequestsRead> {
    const [counts, saved, anchor, off] = await Promise.all([
        readNoticeRequests(storage),
        storage.getItem(SAVED_NODES_STORE_KEY).then(savedRows, () => []),
        storage.getItem(ANCHOR_STORE_KEY).then(communityAddress, () => null),
        communitiesWithAlertsOff(storage),
    ]);
    return { counts, saved, anchor, off };
}

/** The name the phone shows for `address`: the one it saved, else global's own word for global, else its host. */
function placeName(saved: HeldRequestsRead['saved'], address: string, global: string): string {
    const hit = saved.find((n) => sameCommunity(n.url, address));
    if (typeof hit?.name === 'string' && hit.name.trim()) return hit.name.trim();
    if (!hit && sameCommunity(address, global)) return t('Global community');
    return communityName({ url: typeof hit?.url === 'string' ? hit.url : address, alias: typeof hit?.alias === 'string' ? hit.alias : null, nodeName: hit?.nodeName });
}

/**
 * Every other community whose requests count the phone knows, 0 included (a known 0 lets the row's mark follow a fall), with
 * global's door count folded in (see the header); null until the phone has read them.
 */
export function requestsElsewhere(read: HeldRequestsRead | null, onGlobal: number | null | undefined, global: string = GLOBAL_NODE_URL): RequestsPlace[] | null {
    if (!read) return null;
    const counts: Record<string, number> = { ...read.counts };
    const g = communityAddress(global);
    if (g && typeof onGlobal === 'number' && Number.isSafeInteger(onGlobal) && onGlobal >= 0
        && !sameCommunity(g, read.anchor) && !read.off.some((c) => sameCommunity(c, g))) {
        const key = Object.keys(counts).find((c) => sameCommunity(c, g)) ?? g;
        counts[key] = Math.max(counts[key] ?? 0, onGlobal);
    }
    return Object.entries(counts).map(([address, count]) => {
        const hit = read.saved.find((n) => sameCommunity(n.url, address));
        return { address, url: typeof hit?.url === 'string' ? hit.url : address, name: placeName(read.saved, address, global), count };
    });
}

/** The places' counts by address, as the row's count and red dot read them (core dm-requests.ts `RequestsWaiting.elsewhere`). */
export function elsewhereCounts(places: readonly RequestsPlace[] | null): Record<string, number> | null {
    return places ? Object.fromEntries(places.map((p) => [p.address, p.count])) : null;
}

/**
 * What the phone holds for the row ({@link readHeldRequests}): null until first read, read again at each change of the counts
 * and whenever `refresh` is called (Chat's own loads, as it opens and at each sync).
 */
export function useHeldRequests(): [HeldRequestsRead | null, () => void] {
    const [read, setRead] = useState<HeldRequestsRead | null>(null);
    const [alive] = useState(() => ({ on: true }));
    const refresh = useCallback(() => {
        // The same read again keeps the same object, so Chat's sync ticks don't redraw the row for nothing.
        void readHeldRequests(AsyncStorage).then((r) => {
            if (alive.on) setRead((prev) => (prev && JSON.stringify(prev) === JSON.stringify(r) ? prev : r));
        }, () => {});
    }, [alive]);
    useEffect(() => {
        alive.on = true;
        refresh();
        const stop = onNoticeCounts(refresh);
        return () => { alive.on = false; stop(); };
    }, [refresh, alive]);
    return [read, refresh];
}
