/**
 * Shared Home answer store for the web app.
 *
 * Like the phone's utils/home-store.ts (§5.2):
 * - The header reads Home's answer: while one is fresher than 2 minutes,
 *   HeaderControls draws the node's needs lines from it rather than asking the node itself;
 *   on Home it waits a moment for the read Home has under way (one fetch shared with Home).
 * - When not on Home and no fresh answer exists, the header asks the node for cards=needs.
 * - Sockets or user actions can clear the store via forgetHomeForHeader().
 */

import type { HomeAnswer } from './home-cards';

export const HOME_FRESH_FOR_HEADER_MS = 120_000;
export const HOME_HEADER_WAIT_MS = 3_000;

interface StoredHomeAnswer {
    answer: HomeAnswer;
    at: number;
    publicKey: string | null;
}

let latest: StoredHomeAnswer | null = null;
let inflight: Promise<unknown> | null = null;
const settledListeners = new Set<(answer: HomeAnswer, publicKey: string | null) => void>();

/** Register listener for when a Home answer settles. Returns unsubscribe function. */
export function onHomeRead(listener: (answer: HomeAnswer, publicKey: string | null) => void): () => void {
    settledListeners.add(listener);
    return () => {
        settledListeners.delete(listener);
    };
}

/** Record a new Home answer into the store and notify listeners. */
export function recordHomeAnswer(answer: HomeAnswer, publicKey?: string | null): void {
    if (!answer || typeof answer !== 'object') return;
    const pk = publicKey ?? null;
    latest = { answer, at: Date.now(), publicKey: pk };
    settledListeners.forEach(fn => {
        try {
            fn(answer, pk);
        } catch {
            // Listener errors do not prevent store update
        }
    });
}

/** Mark a Home fetch as currently inflight. */
export function markHomeInflight(promise: Promise<unknown>): void {
    inflight = promise;
    promise.catch(() => {}).finally(() => {
        if (inflight === promise) inflight = null;
    });
}

/** Whether a Home read is currently inflight. */
export function isHomeInflight(): boolean {
    return inflight !== null;
}

/** Fresh Home answer for the header if fresher than HOME_FRESH_FOR_HEADER_MS. */
export function freshHomeForHeader(publicKey?: string | null, now: number = Date.now()): HomeAnswer | null {
    if (!latest) return null;
    if ((publicKey ?? null) !== latest.publicKey) return null;
    return (now - latest.at >= 0 && now - latest.at < HOME_FRESH_FOR_HEADER_MS) ? latest.answer : null;
}

/**
 * Home's answer for the header:
 * - Returns a fresh copy immediately if available (< 2 minutes old).
 * - When waitMs is given (e.g. on Home screen), waits for the read under way or starting up to waitMs.
 * - Otherwise returns null, allowing the header to trigger its own needs read.
 */
export function homeForHeader(publicKey: string | null | undefined, waitMs: number): Promise<HomeAnswer | null> {
    const fresh = freshHomeForHeader(publicKey);
    if (fresh || !publicKey) return Promise.resolve(fresh);
    const waiting = isHomeInflight();
    if (!waiting && waitMs <= 0) return Promise.resolve(null);

    return new Promise(resolve => {
        let done = false;
        let timer: ReturnType<typeof setTimeout> | null = null;
        let unsubscribe: (() => void) | null = null;

        const finish = (ans: HomeAnswer | null) => {
            if (done) return;
            done = true;
            if (timer) clearTimeout(timer);
            if (unsubscribe) unsubscribe();
            resolve(ans ?? freshHomeForHeader(publicKey));
        };

        unsubscribe = onHomeRead((ans, pk) => {
            if (pk === publicKey) finish(ans);
        });

        const timeout = Math.max(waitMs, waiting ? HOME_HEADER_WAIT_MS : 0);
        timer = setTimeout(() => {
            finish(null);
        }, timeout);
    });
}

/** Clear the latest cached Home answer (e.g. on socket invite changes or sign out). */
export function forgetHomeForHeader(): void {
    latest = null;
}

/** Reset store state for testing. */
export function resetHomeStoreForTests(): void {
    latest = null;
    inflight = null;
    settledListeners.clear();
}
