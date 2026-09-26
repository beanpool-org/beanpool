/**
 * When a visitor's lobby reads the guest list again after a doorbell (the global lobby, G9b).
 *
 * A socket opened with no key gets only bare `{ type }` doorbells for the node's public events (the server's
 * PUBLIC_WS_EVENTS), never the listing itself, so every one of them means "read the whole list again". A member's
 * socket gets whole public posts instead (lib/live-posts) and never comes here. Rung straight into the coordinator, a
 * doorbell had every visitor's tab read the list within the same ~150 ms: on a busy global node that is visitors ×
 * changes list reads, all landing at once. Paced here instead:
 *
 * - Doorbells inside a window are one read at its end: the first opens a window of VISITOR_READ_WINDOW_MS plus a random
 *   0–VISITOR_READ_JITTER_MS of this tab's own, and the ones after it ride along. A tab reads at most once per 5 s,
 *   and a thousand tabs that heard the same doorbell spread their reads over ten seconds instead of one moment.
 * - A hidden tab reads nothing: its doorbells only mark the list stale. Back in front, one read after a short
 *   0–VISITOR_RETURN_JITTER_MS (the pages read the list themselves on return, and their own "read under 2 s ago" guard
 *   takes this one into theirs).
 * - One read at a time: a doorbell while this tab reads marks the list stale, and it is read once more after, paced
 *   again, never alongside.
 *
 * The worst case for a visitor: a new listing shows up to 15 s after it was posted, plus the read itself; up to one
 * read longer if a read was already under way when it rang.
 */

/** Doorbells in this long after the first one are the same read. Also the shortest gap between two reads. */
export const VISITOR_READ_WINDOW_MS = 5_000;
/** Each tab adds a random part of this to the window, so tabs that heard the same doorbell don't read together. */
export const VISITOR_READ_JITTER_MS = 10_000;
/** A tab back in front reads within this, if a doorbell rang while it was hidden. */
export const VISITOR_RETURN_JITTER_MS = 1_500;

export interface VisitorDoorbells {
    /** A bare doorbell arrived: something public changed. */
    ring(): void;
    /** The tab went into the background. */
    hidden(): void;
    /** The tab came back to the front. */
    visible(): void;
    /** Forget any read waiting and any stale mark; a read under way finishes without asking for another. */
    reset(): void;
}

interface Options {
    /** The list read. Its promise settling is the read ending, whether it worked or not. */
    read: () => unknown;
    isHidden?: () => boolean;
    /** In [0, 1), as Math.random. */
    random?: () => number;
}

function tabHidden(): boolean {
    return typeof document !== 'undefined' && (document.hidden || document.visibilityState === 'hidden');
}

export function createVisitorDoorbells({ read, isHidden = tabHidden, random = () => Math.random() }: Options): VisitorDoorbells {
    let timer: ReturnType<typeof setTimeout> | null = null;
    let reading = false;
    let stale = false;
    // Bumped by reset: a read that was under way then asks for nothing when it ends.
    let generation = 0;

    const share = (): number => {
        const r = random();
        return Number.isFinite(r) ? Math.min(Math.max(r, 0), 1) : 0;
    };

    function arm(delayMs: number): void {
        timer = setTimeout(fire, delayMs);
    }

    function fire(): void {
        timer = null;
        if (isHidden()) {
            stale = true;
            return;
        }
        stale = false;
        reading = true;
        const mine = generation;
        let done: Promise<unknown>;
        try {
            done = Promise.resolve(read());
        } catch (err) {
            done = Promise.reject(err);
        }
        done.catch(() => { /* a failed read is the page's to show; the next doorbell or poll tries again */ }).finally(() => {
            if (mine !== generation) return;
            reading = false;
            if (stale) {
                stale = false;
                ring();
            }
        });
    }

    function ring(): void {
        if (reading || isHidden()) {
            stale = true;
            return;
        }
        if (timer) return;
        arm(VISITOR_READ_WINDOW_MS + Math.floor(share() * VISITOR_READ_JITTER_MS));
    }

    function hidden(): void {
        if (!timer) return;
        clearTimeout(timer);
        timer = null;
        stale = true;
    }

    function visible(): void {
        if (!stale || reading || timer) return;
        stale = false;
        arm(Math.floor(share() * VISITOR_RETURN_JITTER_MS));
    }

    function reset(): void {
        if (timer) clearTimeout(timer);
        timer = null;
        reading = false;
        stale = false;
        generation++;
    }

    return { ring, hidden, visible, reset };
}
