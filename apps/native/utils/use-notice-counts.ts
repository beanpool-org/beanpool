import { useEffect, useState } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { onNoticeCounts, readNoticeCounts } from './notice-counts';
import { getSavedNodes } from './nodes';
import { sameCommunity } from './push-pins';
import { communityName } from './community-name';

/**
 * What waits at each community this phone keeps, by address (utils/notice-counts.ts), for the BeanPool sheet's rows: read
 * as the screen opens and again at each change. Empty until read.
 */
export function useNoticeCounts(): Record<string, number> {
    const [counts, setCounts] = useState<Record<string, number>>({});
    useEffect(() => {
        let alive = true;
        const read = () => {
            readNoticeCounts(AsyncStorage).then((c) => { if (alive) setCounts(c); }).catch(() => {});
        };
        read();
        const stop = onNoticeCounts(read);
        return () => { alive = false; stop(); };
    }, []);
    return counts;
}

export interface OtherCommunityNotice {
    url: string;
    name: string;
    count: number;
}

/**
 * Other communities where unread messages wait, with their display name and count (design R6): for Talk's row at the top
 * of ChatsScreen. Empty until read or when none wait.
 */
export function useOtherCommunitiesNotices(): OtherCommunityNotice[] {
    const [notices, setNotices] = useState<OtherCommunityNotice[]>([]);
    useEffect(() => {
        let alive = true;
        const read = async () => {
            try {
                const [counts, saved] = await Promise.all([
                    readNoticeCounts(AsyncStorage),
                    getSavedNodes().catch(() => []),
                ]);
                if (!alive) return;
                const entries = Object.entries(counts).filter(([, count]) => typeof count === 'number' && count > 0);
                if (entries.length === 0) {
                    setNotices([]);
                    return;
                }
                const result: OtherCommunityNotice[] = entries.map(([url, count]) => {
                    const hit = saved.find((n) => sameCommunity(n.url, url));
                    const hitName = (hit as any)?.name;
                    return {
                        url: hit?.url ?? url,
                        name: (typeof hitName === 'string' && hitName.trim() ? hitName.trim() : communityName(hit ?? { url })),
                        count,
                    };
                });
                setNotices(result);
            } catch {
                if (alive) setNotices([]);
            }
        };
        void read();
        const stop = onNoticeCounts(() => { void read(); });
        return () => { alive = false; stop(); };
    }, []);
    return notices;
}

