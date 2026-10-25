/**
 * Shared Home answer store for the web app.
 *
 * Like the phone's utils/home-store.ts (§5.2):
 * - The header reads Home's answer: on Home, while one is fresher than 2 minutes, the needs-you icons draw from it
 *   rather than asking the node themselves, and wait a moment for the read Home has under way (one fetch shared with Home).
 * - Away from Home it stands in only while it is younger than the header's own 15 s between reads: the phone reads its
 *   deals and unread messages again on every page change (its own database), and the web's come from the node, so a need
 *   dealt with goes at the next tab change. Older than that, the header asks the node for cards=needs.
 * - Only Home's own reads are recorded here (HomePage); the header's own read is never taken for Home's answer.
 * - Sockets or user actions (a tap on a need) clear it via forgetHomeForHeader().
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

/** Home's answer for the header if younger than `maxAgeMs` (HOME_FRESH_FOR_HEADER_MS unless said). */
export function freshHomeForHeader(publicKey?: string | null, now: number = Date.now(), maxAgeMs: number = HOME_FRESH_FOR_HEADER_MS): HomeAnswer | null {
    if (!latest) return null;
    if ((publicKey ?? null) !== latest.publicKey) return null;
    return (now - latest.at >= 0 && now - latest.at < maxAgeMs) ? latest.answer : null;
}

/**
 * Home's answer for the header:
 * - Returns a fresh copy immediately if available (younger than `maxAgeMs`: 2 minutes unless said).
 * - When waitMs is given (e.g. on Home screen), waits for the read under way or starting up to waitMs.
 * - Otherwise returns null, allowing the header to trigger its own needs read.
 */
export function homeForHeader(publicKey: string | null | undefined, waitMs: number, maxAgeMs: number = HOME_FRESH_FOR_HEADER_MS): Promise<HomeAnswer | null> {
    const fresh = freshHomeForHeader(publicKey, Date.now(), maxAgeMs);
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
            resolve(ans ?? freshHomeForHeader(publicKey, Date.now(), maxAgeMs));
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
