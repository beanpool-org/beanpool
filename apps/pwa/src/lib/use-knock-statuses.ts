/**
 * What each community this browser asked says now, kept fresh while the page is on screen (Home's Find card; Damo,
 * 9 Nov 2026: a yes showed only after a reload). Each request is read when it first appears, then by the watcher's
 * schedule (@beanpool/core knock-status-watch.ts, through lib/use-knock-status-watch.ts): about every 20 s for 10 minutes,
 * every 60 s to the hour, every 5 minutes after; never while the tab is hidden; at once when it comes back. A request
 * that has its answer (a yes, or nothing open there) is not asked again; the others are, one round at a time.
 *
 * Returns the answers by community address, and the setter, for a card that reads one again by hand (Cancel finding
 * nothing open).
 */
import { useEffect, useRef, useState, type Dispatch, type SetStateAction } from 'react';
import { combineKnockTicks, knockTickOf, type KnockWatchTick } from '@beanpool/core';
import { readKnockStatus, type KnockStatusResult, type RememberedKnock } from './knock';
import type { BeanPoolIdentity } from './identity';
import { useKnockStatusWatch } from './use-knock-status-watch';

/** A yes, or nothing open there: nothing more will come of asking. */
const answered = (r: KnockStatusResult | null | undefined): boolean => !!r && knockTickOf(r).kind === 'settled';

export function useKnockStatuses(
    knocks: readonly RememberedKnock[],
    identity: BeanPoolIdentity | null | undefined,
): [Record<string, KnockStatusResult | null>, Dispatch<SetStateAction<Record<string, KnockStatusResult | null>>>] {
    const [statuses, setStatuses] = useState<Record<string, KnockStatusResult | null>>({});
    const statusesRef = useRef(statuses);
    statusesRef.current = statuses;
    const knocksRef = useRef(knocks);
    knocksRef.current = knocks;
    const key = knocks.map(k => k.url).join(' ');

    // A request that has gone from the list takes its answer with it.
    useEffect(() => {
        const urls = new Set(key ? key.split(' ') : []);
        setStatuses(was => (Object.keys(was).every(u => urls.has(u)) ? was : Object.fromEntries(Object.entries(was).filter(([u]) => urls.has(u)))));
    }, [key]);

    const read = async (): Promise<KnockWatchTick> => {
        if (!identity) return { kind: 'settled' };
        const ticks = await Promise.all(knocksRef.current.map(async (k): Promise<KnockWatchTick> => {
            const held = statusesRef.current[k.url];
            if (answered(held)) return { kind: 'settled' };
            const r = await readKnockStatus(k.url, identity);
            setStatuses(was => ({ ...was, [k.url]: r }));
            return knockTickOf(r);
        }));
        return combineKnockTicks(ticks);
    };

    useKnockStatusWatch(read, !!identity && knocks.length > 0, `${identity?.publicKey ?? ''}|${key}`);
    return [statuses, setStatuses];
}
