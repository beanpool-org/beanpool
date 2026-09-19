/**
 * Bounds how often the header asks the node. Anything may ask for a refresh (a page change, the app coming
 * back, a ws nudge, the slow safety poll); the node is asked at most once per `minGapMs`. An ask inside the
 * gap is not dropped: one trailing ask runs when the gap ends, so the last nudge of a burst is still seen.
 */
export function createRefreshGate(minGapMs: number, run: () => void) {
    let lastAt = -Infinity;
    let trailing: ReturnType<typeof setTimeout> | null = null;

    const fire = () => {
        trailing = null;
        lastAt = Date.now();
        run();
    };

    return {
        request() {
            const wait = lastAt + minGapMs - Date.now();
            if (wait <= 0) { fire(); return; }
            if (!trailing) trailing = setTimeout(fire, wait);
        },
        cancel() {
            if (trailing) clearTimeout(trailing);
            trailing = null;
        },
    };
}
