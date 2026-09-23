import '@testing-library/jest-dom';
import { configure } from '@testing-library/react';

/**
 * The budget every `findBy*` and `waitFor` in this suite gets before it gives up.
 *
 * React Testing Library defaults it to 1000 ms, and #1072 showed that this — not Vitest's 5 s
 * testTimeout — is the limit a loaded CI runner actually loses to; see that PR for the full
 * reasoning. This suite had never configured it either, and the RTL messages on #1063's CI runs
 * ("Unable to find an accessible element …") are the same class of failure.
 *
 * Measured here on 2026-09-24 by instrumenting all 437 waits the suite performs, twice under 24
 * busy loops: none failed. Shrinking the budget to 50 ms under the same load fails exactly four
 * tests — in TakeoverPanel, PruneBranchModal and RestoreLockedBackup — and those are the waits
 * that genuinely poll rather than passing on waitFor's first check. Their slowest measured wait
 * was 226 ms: a 4.4x margin against the 1000 ms default, where #1063 measured a 17x slowdown
 * under CI-like contention. 15 s is fifteen times the default, chosen for headroom on a two-core
 * runner rather than fitted to the worst time seen.
 *
 * This is a deadline for waiting, not for polling: a wait that resolves still resolves as fast
 * as it ever did, so passing runs are no slower. Only a genuine failure now takes longer to
 * report, which is the trade worth making.
 */
configure({ asyncUtilTimeout: 15_000 });

// In Node >=22, Node provides an uninitialized native globalThis.localStorage accessor
// that throws/warns when accessed without --localstorage-file. Vitest 3.x's populateGlobal
// iterates dom.window properties but skips any property k already present in globalThis
// unless k is explicitly listed in Vitest's static KEYS list (if (k in global) return
// keysArray.includes(k)). Because 'localStorage' and 'sessionStorage' were omitted from
// Vitest's KEYS list, Vitest leaves Node's native uninitialized storage on globalThis
// instead of forwarding JSDOM's real storage instances.
// We forward JSDOM's real storage instances from globalThis.jsdom.window onto globalThis.
const dom = (globalThis as any).jsdom;
if (dom && dom.window) {
    Object.defineProperty(globalThis, 'localStorage', {
        value: dom.window.localStorage,
        writable: true,
        configurable: true,
    });
    Object.defineProperty(globalThis, 'sessionStorage', {
        value: dom.window.sessionStorage,
        writable: true,
        configurable: true,
    });
}



