import '@testing-library/jest-dom';
import { configure } from '@testing-library/react';

/**
 * The budget every `findBy*` and `waitFor` in this suite gets before it gives up.
 *
 * React Testing Library defaults it to 1000 ms, and that — not Vitest's 5 s testTimeout — is
 * the limit the PWA suite actually loses to on CI. Measured on 2026-09-23: under contention,
 * `MessagesPage > a dropped picture prevents the browser default too` failed at 1023 ms with
 * "Unable to find an element by: [data-testid='chat-image-preview']", while the same drop in
 * the test two above it passed in 63 ms and every test after it passed normally. Nothing in
 * the suite came within 5 s, so raising testTimeout alone would have fixed nothing.
 *
 * What runs out is wall-clock, not work: a picked picture crosses a `setTimeout(…, 0)`, an
 * <img> onload and a canvas before the preview mounts, and on a loaded core that chain of
 * macrotasks can simply be scheduled late. 15 s is fifteen times the default and roughly
 * thirty-five times the slowest passing test measured under load — chosen for headroom on a
 * two-core runner, not fitted to the 1023 ms that failed.
 *
 * This is a deadline for waiting, not for polling: a wait that resolves still resolves as
 * fast as it ever did, so passing runs are no slower. Only a genuine failure now takes
 * longer to report, which is the trade worth making.
 */
configure({ asyncUtilTimeout: 15_000 });

const createStorageMock = () => {
    let store: Record<string, string> = {};
    return {
        getItem: (key: string) => store[key] ?? null,
        setItem: (key: string, value: string) => { store[key] = String(value); },
        removeItem: (key: string) => { delete store[key]; },
        clear: () => { store = {}; },
        get length() { return Object.keys(store).length; },
        key: (i: number) => Object.keys(store)[i] ?? null,
    };
};

const storageMock = createStorageMock();

Object.defineProperty(globalThis, 'localStorage', {
    value: storageMock,
    configurable: true,
    writable: true,
});

if (typeof window !== 'undefined') {
    Object.defineProperty(window, 'localStorage', {
        value: storageMock,
        configurable: true,
        writable: true,
    });
}
