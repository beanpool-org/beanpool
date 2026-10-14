/**
 * Door work in the web app (the global node's two doors, design §3.4, slice S5): the small piece of work a browser
 * does before the open door makes it a member. The puzzle and its check are @beanpool/core's (door-work.ts); this is
 * the browser's half: asking the node for a challenge, solving it in a Web Worker, and keeping a solution ready.
 *
 * ## Where it runs
 *
 * In a Web Worker loaded from the node's own origin (door-work.worker.ts, bundled by Vite as a file of its own): the
 * web app's document allows scripts from `'self'` only (apps/server/src/app-document-csp.ts), so no blob worker and no
 * WebAssembly. Each try is ONE `crypto.subtle.digest('SHA-256', …)` over the same 64 KB message, the browser's native
 * hash. A browser that cannot start the worker solves on the page instead, in short slices that let the screen breathe
 * (core's solveDoorWork): slower to watch, never a dead end.
 *
 * ## When
 *
 * The 12-words door's work starts as soon as the joining key exists (the name screen), and runs while the person types
 * their name, so at ordinary levels nobody sees it. A challenge is good for ten minutes: one left unused that long is
 * replaced quietly, before it runs out ({@link WordsWork}). A sign-in asks for work only when the node says so (from the
 * 30th join an hour from one network), and then on the way back from the provider.
 *
 * From level 3 the person is told, with this browser's own estimate: it times its tries as it goes.
 */

import { doorWorkExpectedTries, type DoorWorkDoor } from '@beanpool/core/door-work';
import { solveWithWebCrypto, type DoorWorkProgress, type SolveCallbacks, type WorkerMessage } from './door-work-solve';

export { solveWithWebCrypto, type DoorWorkProgress, type SolveCallbacks };

/** A challenge as the node hands it out (`POST /api/join/work`), with when it runs out by THIS browser's clock. */
export interface DoorWorkChallenge {
    challenge: string;
    level: number;
    parts: number;
    bits: number;
    /** Date.now() past which the node will answer `work_expired`: its `expiresInSeconds` from when the answer came. */
    expiresAt: number;
}

/** What a join carries: the challenge and the smallest counter for each of its parts. */
export interface DoorWorkSolution {
    challenge: string;
    counters: number[];
}

/** The level from which the person is told joining is busy, with an estimate (design §3.5). */
export const BUSY_LEVEL = 3;

/** A solve under way: `done` answers the counters, or null once cancelled. */
export interface DoorWorkRun {
    done: Promise<number[] | null>;
    cancel(): void;
}

/** Starts solving `challenge`. The web app's is {@link solveInWorker}; tests pass their own. */
export type DoorWorkSolver = (challenge: string, callbacks?: SolveCallbacks) => DoorWorkRun;

/** Solve on the page, in short slices: for a browser that could not start the worker. */
export const solveHere: DoorWorkSolver = (challenge, callbacks) => {
    let stop = false;
    return {
        done: solveWithWebCrypto(challenge, { ...callbacks, sliceMs: 8, cancelled: () => stop }),
        cancel: () => { stop = true; },
    };
};

/**
 * Solve in a Web Worker from this origin. If the worker can't be made or fails to load (an old browser, a policy that
 * refuses it), the same solve runs on the page instead: the work is never what keeps someone out.
 */
export const solveInWorker: DoorWorkSolver = (challenge, callbacks) => {
    let worker: Worker;
    try {
        worker = new Worker(new URL('./door-work.worker.ts', import.meta.url), { type: 'module' });
    } catch (e) {
        console.warn('[DoorWork] no worker here, solving on the page:', (e as Error)?.message || e);
        return solveHere(challenge, callbacks);
    }
    let settle: (v: number[] | null) => void = () => {};
    let fail: (e: unknown) => void = () => {};
    let fallback: DoorWorkRun | null = null;
    let over = false;
    const done = new Promise<number[] | null>((resolve, reject) => { settle = resolve; fail = reject; });
    const end = () => { over = true; worker.terminate(); };
    worker.onmessage = (e: MessageEvent<WorkerMessage>) => {
        if (over) return;
        const m = e.data;
        if (m?.type === 'progress') callbacks?.onProgress?.(m.progress);
        else if (m?.type === 'done') { end(); settle(m.counters); }
        else if (m?.type === 'error') { end(); fail(new Error(m.message)); }
    };
    worker.onerror = (e) => {
        if (over) return;
        // The worker didn't load or threw: solve on the page.
        e.preventDefault?.();
        end();
        console.warn('[DoorWork] the worker failed, solving on the page:', e.message || 'no message');
        fallback = solveHere(challenge, callbacks);
        fallback.done.then(settle, fail);
    };
    worker.postMessage({ challenge });
    return {
        done,
        cancel: () => {
            if (fallback) { fallback.cancel(); return; }
            if (over) return;
            end();
            settle(null);
        },
    };
};

/** About how many seconds the rest of the work takes in this browser, from its own speed; null until it is known. */
export function secondsLeft(level: number, progress: DoorWorkProgress | null): number | null {
    if (!progress?.rate || progress.rate <= 0) return null;
    const left = Math.max(0, doorWorkExpectedTries(level) - progress.tries);
    return Math.max(1, Math.round(left / progress.rate));
}

/** "about 15 seconds", "about 2 minutes": an estimate said as one. */
export function aboutTime(seconds: number): string {
    if (seconds < 10) return seconds <= 1 ? 'about a second' : `about ${seconds} seconds`;
    if (seconds < 60) return `about ${Math.max(10, Math.round(seconds / 5) * 5)} seconds`;
    const minutes = Math.round(seconds / 60);
    return minutes === 1 ? 'about a minute' : `about ${minutes} minutes`;
}

/**
 * The busy-level sentence (design §3.5), from level 3: never a refusal, and the sign-in beside it. `seconds` is this
 * browser's own estimate, when it has one.
 */
export function busySentence(seconds: number | null): string {
    return seconds === null
        ? 'Lots of people are joining right now, so setting up a 12-words account takes a little longer in this browser. Or sign in to join now.'
        : `Lots of people are joining right now. Setting up a 12-words account will take ${aboutTime(seconds)} in this browser. Or sign in to join now.`;
}

/**
 * The busy level for a sign-in the node asked to bring work: the sign-in is already the faster door, so this says only
 * why it takes longer, never "or sign in".
 */
export function signInBusySentence(seconds: number | null): string {
    return seconds === null
        ? 'Lots of people are joining right now, so joining takes a little longer in this browser.'
        : `Lots of people are joining right now, so joining will take ${aboutTime(seconds)} more in this browser.`;
}

/** When the work can't be done here at all (design §3.4): the sign-in is still a way in. */
export const WORK_CANT_RUN = "This browser can't finish setting up a 12-words account right now. Try again, or sign in.";

/** Which door a piece of work is for, by the node's own names. */
export type { DoorWorkDoor };
