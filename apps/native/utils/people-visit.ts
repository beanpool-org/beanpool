/**
 * When a visit to People ends (slice C4, the deciding review of #3096): the member leaves for another tab, or the app goes to
 * the background. A count that goes up each time, so a screen can start its next visit from nothing (Show credit is off at every
 * visit: DESIGN-credit-list-fable.md §2).
 *
 * People is a tab and stays mounted, and it is also drawn inside Talk (app/(tabs)/chats.tsx, route `/chats`), so "left" is read
 * against where THIS copy was first shown: its own tab. A profile or the names list pushed on top of it is not a leave (its
 * path is no tab's; the list is still there when the member comes back, and the Confirm re-read needs it). A copy that never
 * saw a tab's path, as on a screen drawn by a test, never counts a leave.
 */
import { useEffect, useRef, useState } from 'react';
import { AppState } from 'react-native';
import { usePathname } from 'expo-router';

/** The paths of the tabs, as `usePathname()` gives them (`index` is `/`). Pinned to app/(tabs) by people-visit.test.ts. */
export const TAB_PATHS: readonly string[] = ['/', '/market', '/map', '/chats', '/people', '/pulse', '/projects', '/ledger', '/settings'];

/** The tab a path is, or null for anything pushed on top of one (a profile, the names list, a chat). */
export function tabOf(pathname: string): string | null {
    return TAB_PATHS.includes(pathname) ? pathname : null;
}

export function usePeopleVisitEnds(): number {
    const [ends, setEnds] = useState(0);
    const tab = tabOf(usePathname());
    const home = useRef<string | null>(null);
    if (home.current === null && tab !== null) home.current = tab;
    const away = tab !== null && home.current !== null && tab !== home.current;
    const wasAway = useRef(false);
    useEffect(() => {
        if (away && !wasAway.current) setEnds((n) => n + 1);
        wasAway.current = away;
    }, [away]);
    useEffect(() => {
        const sub = AppState.addEventListener('change', (next) => { if (next === 'background') setEnds((n) => n + 1); });
        return () => sub.remove();
    }, []);
    return ends;
}
