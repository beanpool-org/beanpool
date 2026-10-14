/**
 * Screens and forms that fill the phone's screen (Start a community, a report form), counted while they are open, so
 * the install banner (components/InstallPrompt.tsx) never sits on top of them. Rehearsal 14 Oct 2026, B1: at 320 px
 * the banner covered the lower third of Start a community and a listing's report form.
 *
 * A count rather than a DOM watch: the app redraws often (the map, chat), and a page-wide query on every change would
 * cost old phones for a banner.
 */
import { useEffect, useSyncExternalStore } from 'react';

let open = 0;
const listeners = new Set<() => void>();
const publish = () => listeners.forEach((l) => l());

const subscribe = (l: () => void) => {
    listeners.add(l);
    return () => { listeners.delete(l); };
};
const covered = () => open > 0;

/** Counts this screen as covering the page while it is drawn and `on`. */
export function useCoversScreen(on = true): void {
    useEffect(() => {
        if (!on) return;
        open += 1;
        publish();
        return () => {
            open -= 1;
            publish();
        };
    }, [on]);
}

/** True while any screen counted by useCoversScreen is open. */
export function useScreenCovered(): boolean {
    return useSyncExternalStore(subscribe, covered, covered);
}
