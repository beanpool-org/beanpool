/**
 * Test suite for engine/open-copies.ts.
 *
 * Verifies:
 * 1. Registering open copy callbacks via noteCopyOpen.
 * 2. Deregistering specific copies via noteCopyClosed.
 * 3. Invoking all open copy callbacks with reason string via closeOpenCopies(why) and returning exact count.
 * 4. Error isolation in closeOpenCopies: callbacks that throw exceptions do not prevent other copy callbacks from running.
 *
 * Run: BEANPOOL_DATA_DIR=$(mktemp -d) pnpm exec tsx src/test-open-copies.ts
 */

import { noteCopyOpen, noteCopyClosed, closeOpenCopies } from './engine/open-copies.js';

let run = 0;
let passed = 0;

function assert(cond: boolean, msg: string): void {
    run++;
    if (cond) {
        passed++;
        console.log(`✓ ${msg}`);
    } else {
        console.error(`✗ ${msg}`);
    }
}

function main(): void {
    console.log('Running open-copies engine tests...\n');

    // ── 1. Empty state initial check ──────────────────────────────────────────
    const initialClosed = closeOpenCopies('initial clean check');
    assert(initialClosed === 0, 'closeOpenCopies returns 0 when no copies are open');

    // ── 2. Registering and closing open copies ────────────────────────────────
    const reasons: Record<string, string> = {};
    noteCopyOpen('copy-1', (why) => { reasons['copy-1'] = why; });
    noteCopyOpen('copy-2', (why) => { reasons['copy-2'] = why; });
    noteCopyOpen('copy-3', (why) => { reasons['copy-3'] = why; });

    // Explicitly close copy-2 before closeOpenCopies is called
    noteCopyClosed('copy-2');

    const closedCount = closeOpenCopies('VACUUM state.db');
    assert(closedCount === 2, 'closeOpenCopies returns 2 for remaining open copies after copy-2 was closed');
    assert(reasons['copy-1'] === 'VACUUM state.db', 'copy-1 close callback received reason string');
    assert(reasons['copy-2'] === undefined, 'copy-2 close callback was not called because it was deregistered');
    assert(reasons['copy-3'] === 'VACUUM state.db', 'copy-3 close callback received reason string');

    // Subsequent closeOpenCopies call should return 0 since map was cleared
    const secondCloseCount = closeOpenCopies('second sweep');
    assert(secondCloseCount === 0, 'closeOpenCopies clears open map after closing copies');

    // ── 3. Exception handling isolation in closeOpenCopies ────────────────────
    const called: string[] = [];
    noteCopyOpen('copy-err', () => {
        called.push('copy-err');
        throw new Error('Injected close failure');
    });
    noteCopyOpen('copy-ok', (why) => {
        called.push('copy-ok:' + why);
    });

    const countWithErr = closeOpenCopies('restore state.db');
    assert(countWithErr === 2, 'closeOpenCopies returns total count of copies even if one callback throws');
    assert(called.includes('copy-err') && called.includes('copy-ok:restore state.db'), 'closeOpenCopies executes all callbacks despite earlier callback error');

    // Map should be cleared after exception
    assert(closeOpenCopies('verify empty') === 0, 'open map is cleared even after callback error');

    console.log(`\n${passed}/${run} checks passed.`);
    process.exit(passed === run ? 0 : 1);
}

main();
