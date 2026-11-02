import { useEffect, useState } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { onNoticeCounts, readNoticeCounts } from './notice-counts';

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
