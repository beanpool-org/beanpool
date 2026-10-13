/**
 * A request's time limit: fetch has none, and on a slow network a request could otherwise wait for good (deciding review
 * of #1766, B2). Used by the area read and write (lib/member-area) and the directory's small forms (lib/members-on-demand).
 */

/**
 * Runs `work` with a signal that stops at `ms` or when `outer` does (Skip, Back, leaving the screen), and rejects the
 * moment it stops, even if the work ignores its signal. Rejects with `stopped` set, so a caller can tell it apart.
 */
export async function bounded<T>(work: (signal: AbortSignal) => Promise<T>, ms: number, outer?: AbortSignal): Promise<T> {
    const stop = new AbortController();
    const onOuter = () => stop.abort();
    if (outer?.aborted) stop.abort();
    else outer?.addEventListener('abort', onOuter);
    const timer = setTimeout(() => stop.abort(), ms);
    const stopped = () => Object.assign(new Error('stopped'), { stopped: true });
    try {
        return await new Promise<T>((resolve, reject) => {
            if (stop.signal.aborted) { reject(stopped()); return; }
            stop.signal.addEventListener('abort', () => reject(stopped()));
            work(stop.signal).then(resolve, reject);
        });
    } finally {
        clearTimeout(timer);
        outer?.removeEventListener('abort', onOuter);
    }
}
