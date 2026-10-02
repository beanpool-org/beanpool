/**
 * The door work's Web Worker (lib/door-work.ts solveInWorker): solves one challenge with the browser's own SHA-256 and
 * says how it is going. Bundled by Vite as a file of its own on this origin, so the web app's `script-src 'self'` lets
 * it run; it fetches nothing and holds no key (the challenge is all it is given). Cancelled by being terminated.
 */
import { solveWithWebCrypto, type WorkerMessage } from './door-work-solve';

const post = (m: WorkerMessage) => (self as unknown as { postMessage(m: WorkerMessage): void }).postMessage(m);

self.onmessage = (e: MessageEvent<{ challenge?: unknown }>) => {
    const challenge = e.data?.challenge;
    if (typeof challenge !== 'string') {
        post({ type: 'error', message: 'no challenge' });
        return;
    }
    // No slicing needed here: nothing else runs on this thread, and the page ends it by terminating it.
    solveWithWebCrypto(challenge, { sliceMs: 60_000, onProgress: (progress) => post({ type: 'progress', progress }) })
        .then((counters) => post(counters ? { type: 'done', counters } : { type: 'error', message: 'stopped' }))
        .catch((err) => post({ type: 'error', message: (err as Error)?.message || String(err) }));
};
