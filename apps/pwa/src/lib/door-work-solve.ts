/**
 * The door work's solve, on its own (lib/door-work.ts says what it is for): what the Web Worker runs
 * (door-work.worker.ts), and the page when there is no worker. Kept apart from door-work.ts so the worker's bundle
 * holds this and core's puzzle, and nothing that starts another worker.
 */

import { DOOR_WORK_PARTS, solveDoorWork } from '@beanpool/core/door-work';

/** How it is going: parts done of {@link DOOR_WORK_PARTS}, and this browser's speed once it has been measured. */
export interface DoorWorkProgress {
    done: number;
    of: number;
    /** Tries so far. */
    tries: number;
    /** Tries a second, measured on this browser; null until enough tries have been timed. */
    rate: number | null;
}

export interface SolveCallbacks {
    onProgress?: (p: DoorWorkProgress) => void;
}

/** Timing starts to count after this long, so the first tries (a worker warming up) don't skew the estimate. */
const RATE_AFTER_MS = 250;

/**
 * Solve with WebCrypto, reporting progress: the worker's body, and the page's when there is no worker. The counters
 * are core's (the smallest for each part), so they are the shared vectors' exactly.
 */
export async function solveWithWebCrypto(
    challenge: string,
    o: SolveCallbacks & { subtle?: SubtleCrypto; sliceMs?: number; cancelled?: () => boolean } = {},
): Promise<number[] | null> {
    const subtle = o.subtle ?? globalThis.crypto.subtle;
    const clock = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());
    const start = clock();
    let tries = 0;
    let rate: number | null = null;
    let done = 0;
    const report = () => o.onProgress?.({ done, of: DOOR_WORK_PARTS, tries, rate });
    return solveDoorWork(challenge, {
        digest: (bytes) => {
            tries++;
            if (tries % 64 === 0) {
                const ms = clock() - start;
                if (ms >= RATE_AFTER_MS) {
                    const first = rate === null;
                    rate = tries / (ms / 1000);
                    if (first) report();
                }
            }
            // WebCrypto copies the bytes when it is called, and the solver awaits each answer before the next try.
            return subtle.digest('SHA-256', bytes as Uint8Array<ArrayBuffer>);
        },
        sliceMs: o.sliceMs,
        cancelled: o.cancelled,
        onPart: (d) => {
            done = d;
            report();
        },
    });
}

/** What the worker says (door-work.worker.ts). */
export type WorkerMessage =
    | { type: 'progress'; progress: DoorWorkProgress }
    | { type: 'done'; counters: number[] }
    | { type: 'error'; message: string };

